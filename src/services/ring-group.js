const { RingGroup } = require('../models');
const logger = require('../utils/logger');

class RingGroupHandler {
  constructor(srf, registrar, rtpengine) {
    this.srf = srf;
    this.registrar = registrar;
    this.rtpengine = rtpengine;
  }

  async isRingGroup(number) {
    return RingGroup.findOne({ number, enabled: true });
  }

  async ringGroup(req, res, ringGroup, cdr) {
    const { strategy, members, ringTime, name, number } = ringGroup;

    logger.info(`RINGGROUP ${number} (${name}): strategy=${strategy} members=${members.join(',')}`);

    const availableMembers = [];
    for (const ext of members) {
      const contacts = await this.registrar.getContacts(ext);
      if (contacts.length > 0) {
        availableMembers.push({ extension: ext, contacts });
      }
    }

    if (availableMembers.length === 0) {
      logger.warn(`RINGGROUP ${number}: no members registered`);
      cdr.status = 'missed';
      await cdr.save();
      if (!res.finalResponseSent) res.send(480);
      return null;
    }

    logger.info(`RINGGROUP ${number}: ${availableMembers.length}/${members.length} members available`);

    switch (strategy) {
      case 'simultaneously':
      case 'ringall':
        return this._ringSimultaneously(req, res, availableMembers, ringTime, cdr);
      case 'orderby':
      case 'sequential':
        return this._ringSequential(req, res, availableMembers, ringTime, cdr);
      case 'random':
        const shuffled = [...availableMembers].sort(() => Math.random() - 0.5);
        return this._ringSequential(req, res, shuffled, ringTime, cdr);
      case 'roundrobin':
        return this._ringRoundRobin(req, res, availableMembers, ringTime, cdr, ringGroup);
      default:
        return this._ringSimultaneously(req, res, availableMembers, ringTime, cdr);
    }
  }

  // ============================================================
  // SIMULTANEOUSLY - B2BUA parallel forking
  //
  // How it works:
  //   1. Send 180 Ringing to the caller (via the inbound SIP leg)
  //   2. Fire off parallel createUAC() INVITEs to every member
  //   3. First member to answer (200 OK) wins
  //   4. CANCEL all other pending legs
  //   5. Bridge caller <-> winner using createUAS on the
  //      original req/res with the winner's SDP
  // ============================================================
  async _ringSimultaneously(req, res, members, ringTime, cdr) {
    const targets = members.map(m => {
      const c = m.contacts[0];
      return { extension: m.extension, uri: `sip:${m.extension}@${c.ip}:${c.port}` };
    });

    logger.info(`SIMRING: forking to ${targets.length} targets: ${targets.map(t => t.uri).join(', ')}`);

    return new Promise((resolve) => {
      let answered = false;
      let sentFinal = false;
      const pendingLegs = [];
      let ringTimer = null;
      let resolvedAlready = false;

      const _resolve = (val) => {
        if (resolvedAlready) return;
        resolvedAlready = true;
        resolve(val);
      };

      // Ring timeout — if nobody answers within ringTime seconds
      ringTimer = setTimeout(() => {
        if (!answered) {
          logger.info(`SIMRING: ring timeout after ${ringTime}s`);
          _cancelAll();
          if (!sentFinal) {
            sentFinal = true;
            cdr.status = 'missed';
            cdr.save().catch(() => {});
            if (!res.finalResponseSent) {
              try { res.send(408); } catch (e) {}
            }
          }
          _resolve(null);
        }
      }, (ringTime || 30) * 1000);

      // Cancel all outbound legs except the winner
      const _cancelAll = (winnerLeg) => {
        for (const leg of pendingLegs) {
          if (leg === winnerLeg) continue;
          // Cancel pending INVITE (not yet answered)
          if (leg.cancelFn) {
            try { leg.cancelFn(); } catch (e) {}
          }
          // Destroy answered dialog if somehow another answered too
          if (leg.uac) {
            try { leg.uac.destroy(); } catch (e) {}
          }
        }
      };

      // Send 180 Ringing to the inbound caller immediately
      if (!res.finalResponseSent) {
        try { res.send(180); } catch (e) {}
      }

      // Track how many legs have finished (answered or failed)
      let completedLegs = 0;
      const totalLegs = targets.length;

      const _checkAllFailed = () => {
        completedLegs++;
        if (completedLegs >= totalLegs && !answered) {
          // All legs failed/rejected — nobody answered
          clearTimeout(ringTimer);
          logger.info(`SIMRING: all ${totalLegs} legs failed, nobody answered`);
          if (!sentFinal) {
            sentFinal = true;
            cdr.status = 'missed';
            cdr.save().catch(() => {});
            if (!res.finalResponseSent) {
              try { res.send(480); } catch (e) {}
            }
          }
          _resolve(null);
        }
      };

      // Fire parallel INVITEs to all members
      for (const target of targets) {
        const leg = { extension: target.extension, uac: null, cancelFn: null };
        pendingLegs.push(leg);

        this.srf.createUAC(target.uri, {
          localSdp: req.body,
          headers: {
            'To': `<${target.uri}>`
          }
        }, {
          cbProvisional: (provisionalRes) => {
            logger.debug(`SIMRING: ${target.extension} provisional ${provisionalRes.status}`);
          },
          cbRequest: (err, reqSent) => {
            // reqSent is the ClientRequest — we can cancel it
            if (reqSent && typeof reqSent.cancel === 'function') {
              leg.cancelFn = () => {
                try { reqSent.cancel(); } catch (e) {}
              };
            }
          }
        })
        .then((uac) => {
          // This member answered (200 OK received)
          leg.uac = uac;

          if (answered) {
            // Someone else already won — BYE this one
            logger.debug(`SIMRING: ${target.extension} answered but too late, destroying`);
            try { uac.destroy(); } catch (e) {}
            _checkAllFailed();
            return;
          }

          // *** WINNER ***
          answered = true;
          clearTimeout(ringTimer);
          logger.info(`SIMRING: ${target.extension} answered FIRST!`);

          // Cancel all other pending/ringing legs
          _cancelAll(leg);

          // Bridge: send 200 OK to the inbound caller with winner's SDP
          const winnerSdp = uac.remote.sdp;

          this.srf.createUAS(req, res, {
            localSdp: winnerSdp
          })
          .then((uas) => {
            sentFinal = true;
            logger.info(`SIMRING: call bridged, caller <-> ${target.extension}`);
            _resolve({ uas, uac, answeredBy: target.extension });
          })
          .catch((err) => {
            logger.error(`SIMRING: failed to send 200 to caller: ${err.message}`);
            try { uac.destroy(); } catch (e) {}
            if (!sentFinal) {
              sentFinal = true;
              cdr.status = 'failed';
              cdr.save().catch(() => {});
            }
            _resolve(null);
          });
        })
        .catch((err) => {
          // This leg failed — busy, rejected, network error, etc.
          const status = err.status || 'error';
          logger.debug(`SIMRING: ${target.extension} failed (${status}): ${err.message}`);
          _checkAllFailed();
        });
      }
    });
  }

  // ============================================================
  // SEQUENTIAL - Ring members one at a time using B2BUA
  //
  // Sends 180 to caller, then tries each member with a per-member
  // timeout. First to answer gets bridged.
  // ============================================================
  async _ringSequential(req, res, members, ringTimePerMember, cdr) {
    logger.info(`SEQUENTIAL: trying ${members.length} members in order`);

    // Send 180 Ringing to caller
    if (!res.finalResponseSent) {
      try { res.send(180); } catch (e) {}
    }

    for (const member of members) {
      const contact = member.contacts[0];
      const targetUri = `sip:${member.extension}@${contact.ip}:${contact.port}`;

      logger.info(`SEQUENTIAL: trying ${member.extension} at ${targetUri}`);

      try {
        const result = await this._tryMember(req, res, targetUri, member.extension, ringTimePerMember);
        if (result) {
          logger.info(`SEQUENTIAL: ${member.extension} answered`);
          return { ...result, answeredBy: member.extension };
        }
        logger.info(`SEQUENTIAL: ${member.extension} no answer, trying next`);
      } catch (err) {
        logger.debug(`SEQUENTIAL: ${member.extension} error: ${err.message}`);
      }
    }

    // Nobody answered
    logger.info(`SEQUENTIAL: no members answered`);
    cdr.status = 'missed';
    await cdr.save();
    if (!res.finalResponseSent) {
      try { res.send(480); } catch (e) {}
    }
    return null;
  }

  // Try ringing a single member with a timeout
  _tryMember(req, res, targetUri, extension, timeout) {
    return new Promise((resolve) => {
      let done = false;
      let uacDialog = null;
      let cancelFn = null;

      const perMemberTimeout = Math.min(timeout || 15, 30);

      const timer = setTimeout(() => {
        if (!done) {
          done = true;
          logger.debug(`SEQUENTIAL: ${extension} timeout after ${perMemberTimeout}s`);
          if (cancelFn) { try { cancelFn(); } catch (e) {} }
          if (uacDialog) { try { uacDialog.destroy(); } catch (e) {} }
          resolve(null);
        }
      }, perMemberTimeout * 1000);

      this.srf.createUAC(targetUri, {
        localSdp: req.body,
        headers: {
          'To': `<${targetUri}>`
        }
      }, {
        cbRequest: (err, reqSent) => {
          if (reqSent && typeof reqSent.cancel === 'function') {
            cancelFn = () => {
              try { reqSent.cancel(); } catch (e) {}
            };
          }
        }
      })
      .then((uac) => {
        if (done) {
          // Timed out already
          try { uac.destroy(); } catch (e) {}
          return;
        }
        done = true;
        clearTimeout(timer);
        uacDialog = uac;

        // Member answered — bridge to caller
        const winnerSdp = uac.remote.sdp;
        this.srf.createUAS(req, res, { localSdp: winnerSdp })
          .then((uas) => {
            resolve({ uas, uac });
          })
          .catch((err) => {
            logger.error(`SEQUENTIAL: failed to bridge ${extension}: ${err.message}`);
            try { uac.destroy(); } catch (e) {}
            resolve(null);
          });
      })
      .catch((err) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
    });
  }

  // ============================================================
  // ROUND ROBIN - Rotate starting member each call
  // ============================================================
  async _ringRoundRobin(req, res, members, ringTimePerMember, cdr, ringGroup) {
    let startIndex = (ringGroup.lastAgentIndex + 1) % members.length;
    const ordered = [...members.slice(startIndex), ...members.slice(0, startIndex)];
    logger.info(`ROUNDROBIN: starting from ${ordered[0].extension}`);

    const result = await this._ringSequential(req, res, ordered, ringTimePerMember, cdr);

    if (result && result.answeredBy) {
      const answeredIndex = members.findIndex(m => m.extension === result.answeredBy);
      if (answeredIndex >= 0) {
        ringGroup.lastAgentIndex = answeredIndex;
        await ringGroup.save();
      }
    }
    return result;
  }
}

module.exports = RingGroupHandler;
