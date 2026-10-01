const { RingGroup } = require('../models');
const logger = require('../utils/logger');

let doSimring = null;
let Simring = null;

try {
  const sugar = require('drachtio-fn-b2b-sugar');
  
  // simring can be used two ways:
  // 1. Direct: simring(req, res, uris, opts)
  // 2. Factory: simring(logger) returns a function
  // We try the factory pattern with our logger for debug output
  const logAdapter = {
    debug: (...args) => logger.debug(`[simring] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`),
    info: (...args) => logger.info(`[simring] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`),
    error: (...args) => logger.error(`[simring] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}`)
  };

  try {
    const factoryResult = sugar.simring(logAdapter);
    if (typeof factoryResult === 'function') {
      doSimring = factoryResult;
      logger.info('drachtio-fn-b2b-sugar: simring loaded (factory mode with logger)');
    } else {
      // Factory didn't return a function — use simring directly
      doSimring = sugar.simring;
      logger.info('drachtio-fn-b2b-sugar: simring loaded (direct mode)');
    }
  } catch (e) {
    // Factory failed — use simring directly
    doSimring = sugar.simring;
    logger.info('drachtio-fn-b2b-sugar: simring loaded (direct mode, factory failed)');
  }

  Simring = sugar.Simring;
} catch (err) {
  logger.warn(`drachtio-fn-b2b-sugar not available: ${err.message}`);
}

class RingGroupHandler {
  constructor(srf, registrar, rtpengine) {
    this.srf = srf;
    this.registrar = registrar;
    this.rtpengine = rtpengine;
  }

  async isRingGroup(number) {
    return RingGroup.findOne({ number, enabled: true });
  }

  // Get the MOST RECENT active contact for an extension
  // (avoids stale NAT ports from older registrations)
  _getLatestContact(contacts) {
    if (contacts.length === 0) return null;
    if (contacts.length === 1) return contacts[0];
    // Sort by registeredAt descending, pick newest
    return contacts.sort((a, b) => {
      const ta = a.registeredAt ? new Date(a.registeredAt).getTime() : 0;
      const tb = b.registeredAt ? new Date(b.registeredAt).getTime() : 0;
      return tb - ta;
    })[0];
  }

  async ringGroup(req, res, ringGroup, cdr) {
    const { strategy, members, ringTime, name, number } = ringGroup;

    logger.info(`RINGGROUP ${number} (${name}): strategy=${strategy} members=${members.join(',')}`);

    const availableMembers = [];
    for (const ext of members) {
      const contacts = await this.registrar.getContacts(ext);
      if (!contacts.length) continue;

      // Ring EVERY device the agent is logged in on, not just the newest
      // registration. An agent may be on a desk phone and the browser softphone
      // at the same time; picking only the latest meant whichever registered
      // last silently swallowed the call. Each contact is forked separately so
      // a browser leg gets WebRTC media and a SIP phone gets plain RTP.
      //
      // Parallel strategies fork them all; the sequential/round-robin
      // strategies still take one device per member (the newest), since they
      // ring members one at a time by design.
      const fanOut = (strategy === 'ringall' || strategy === 'simultaneous' || !strategy);
      const chosen = fanOut ? contacts : [this._getLatestContact(contacts)];

      for (const c of chosen) {
        if (c) availableMembers.push({ extension: ext, contact: c });
      }
      logger.debug(`RINGGROUP: ${ext} -> ${chosen.length}/${contacts.length} contact(s) ` +
        `[${chosen.filter(Boolean).map(c => `${c.ip}:${c.port}${this._isWebRTCMember({ contact: c }) ? '/webrtc' : ''}`).join(', ')}]`);
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
  // SIMULTANEOUSLY - using drachtio-fn-b2b-sugar simring
  //
  // simring sends parallel INVITEs to all URIs, connects the
  // first answerer, and CANCELs the rest. It returns {uas, uac}
  // just like createB2BUA.
  // ============================================================
  async _ringSimultaneously(req, res, members, ringTime, cdr) {
    // A browser (WebRTC) leg needs DTLS-SRTP/ICE media while a SIP phone needs
    // plain RTP/AVP — and drachtio's simring offers ONE SDP to every fork, so it
    // cannot serve both. When any member is a browser, fork them ourselves with
    // a per-leg RTPEngine session. Pure-SIP groups keep the original simring
    // path untouched.
    if (members.some(m => this._isWebRTCMember(m))) {
      return this._ringParallelPerLeg(req, res, members, ringTime, cdr);
    }

    const uris = members.map(m => `sip:${m.extension}@${m.contact.ip}:${m.contact.port}`);

    logger.info(`SIMRING: forking to ${uris.length} targets: ${uris.join(', ')}`);

    if (!doSimring) {
      logger.warn('SIMRING: drachtio-fn-b2b-sugar not available, falling back to B2BUA with first member');
      return this._ringB2BUA(req, res, members[0], ringTime, cdr);
    }

    try {
      // Route media through RTPEngine for recording + monitoring support
      // Generate a unique call-id for this RTPEngine session
      const rtpCallId = require('uuid').v4();
      const fromTag = req.getParsedHeader('From').params.tag;
      const rtpConfig = {
        host: process.env.RTPENGINE_HOST || '127.0.0.1',
        port: parseInt(process.env.RTPENGINE_PORT) || 22222
      };

      let rtpOfferSdp = null;

      // Step 1: Send caller's SDP to RTPEngine (offer)
      if (this.rtpengine) {
        try {
          const rtpHelper = require('../utils/rtp-helper');
          const offerResp = await rtpHelper.offer(this.rtpengine, rtpCallId, fromTag, req.body, { 'record call': 'yes' });
          if (offerResp) {
            rtpOfferSdp = offerResp.sdp;
            logger.info(`SIMRING: RTPEngine offer OK (call-id=${rtpCallId})`);
          }
        } catch (e) {
          logger.warn(`SIMRING: RTPEngine offer failed: ${e.message}, using direct media`);
        }
      }

      // Build opts for simring
      const opts = {
        // localSdpB: SDP to send to the B leg (softphones)
        // If RTPEngine is available, use its SDP; otherwise pass through
        localSdpB: rtpOfferSdp || req.body,
        passFailure: false
      };

      // localSdpA: function that takes the B leg's answer SDP and returns
      // the SDP to send back to the A leg (caller/trunk)
      if (rtpOfferSdp && this.rtpengine) {
        const rtpEngine = this.rtpengine;
        opts.localSdpA = async (sdpB, res) => {
          try {
            const rtpHelper = require('../utils/rtp-helper');
            const toTag = res.getParsedHeader('To').params.tag;
            const answerResp = await rtpHelper.answer(rtpEngine, rtpCallId, fromTag, toTag, sdpB, { 'record call': 'yes' });
            if (answerResp) {
              logger.info(`SIMRING: RTPEngine answer OK (to-tag=${toTag})`);
              return answerResp.sdp;
            }
          } catch (e) {
            logger.warn(`SIMRING: RTPEngine answer failed: ${e.message}`);
          }
          return sdpB; // fallback: pass through
        };
      }

      const { uas, uac } = await doSimring(req, res, uris, opts);

      logger.info(`SIMRING: answered! Connected to ${uac.remote.uri || 'unknown'}`);

      // Store the RTPEngine call-id on the dialog for monitor lookup
      if (rtpOfferSdp) {
        uas._rtpCallId = rtpCallId;
        uac._rtpCallId = rtpCallId;
        uas._rtpFromTag = fromTag;
        uac._rtpFromTag = fromTag;
        logger.info(`SIMRING: stored RTPEngine call-id=${rtpCallId} on dialogs`);
      }

      // Try to determine which member answered
      // Check the UAC dialog's remote contact or URI to find the matching extension
      let answeredBy = null;
      const remoteUri = uac.remote ? uac.remote.uri : '';
      const remoteContact = uac.remote ? (uac.remote.contact || '') : '';

      // First try: match by contact or URI which includes the extension
      for (const m of members) {
        const extPattern = `sip:${m.extension}@`;
        if (remoteUri.includes(extPattern) || remoteContact.includes(extPattern)) {
          answeredBy = m.extension;
          break;
        }
      }

      // Second try: match by port (each softphone has a unique port)
      if (!answeredBy) {
        for (const m of members) {
          const portStr = `:${m.contact.port}`;
          if (remoteUri.includes(portStr) || remoteContact.includes(portStr)) {
            answeredBy = m.extension;
            break;
          }
        }
      }

      // Third try: match by just the extension number anywhere in the URI
      if (!answeredBy) {
        for (const m of members) {
          if (remoteUri.includes(m.extension)) {
            answeredBy = m.extension;
            break;
          }
        }
      }

      logger.info(`SIMRING: answeredBy=${answeredBy} (remoteUri=${remoteUri})`);

      cdr.status = 'answered';
      cdr.answerTime = new Date();
      if (answeredBy) cdr.to = answeredBy;
      cdr.rtpCallId = rtpCallId; // Store for CDR/monitor reference
      await cdr.save();

      return { uas, uac, answeredBy };
    } catch (err) {
      logger.info(`SIMRING: no answer - ${err.message || 'timeout'} (status=${err.status || 'N/A'})`);
      cdr.status = 'missed';
      await cdr.save();
      // Do NOT send a response here — return null so call-handler
      // can try voicemail before giving up
      return null;
    }
  }

  // ============================================================
  // ============================================================
  // WebRTC-aware helpers
  // ============================================================

  // True when this member registered from a browser (SIP over WS/WSS).
  _isWebRTCMember(m) {
    const c = m && m.contact;
    if (!c) return false;
    if (c.webrtc) return true;
    const t = String(c.transport || '').toLowerCase();
    return t === 'ws' || t === 'wss';
  }

  // Request-URI + media type for one member. Browsers must carry
  // ;transport=ws so drachtio re-uses their existing WebSocket; their media
  // leg has to be built as WebRTC (DTLS-SRTP + ICE), not plain RTP.
  _memberTarget(m) {
    const webrtc = this._isWebRTCMember(m);
    let uri = `sip:${m.extension}@${m.contact.ip}:${m.contact.port}`;
    if (webrtc) {
      // A browser's Contact host is an unroutable "*.invalid" name (a JS stack
      // cannot know its own address), so we must target the source address the
      // REGISTER arrived on and name the transport explicitly.
      //
      // Behind nginx the browser's WebSocket is terminated as TLS and proxied
      // to drachtio's *wss* listener (5062), so the registration is recorded
      // with transport "tcp" — asking for ";transport=ws" makes drachtio look
      // for a plain-ws connection that does not exist and answer 503. Default
      // to wss; set WEBRTC_CONTACT_TRANSPORT=ws if nginx proxies to the plain
      // ws listener instead.
      const want = String(process.env.WEBRTC_CONTACT_TRANSPORT || '').toLowerCase();
      const t = want === 'ws' ? 'ws'
        : (String(m.contact.transport || '').toLowerCase() === 'ws' ? 'ws' : 'wss');
      uri += `;transport=${t}`;
    }
    return { uri, media: webrtc ? 'webrtc' : 'sip', webrtc };
  }

  // ============================================================
  // PARALLEL with PER-LEG MEDIA (mixed WebRTC + SIP ring groups)
  //
  // Each member gets its OWN RTPEngine session, so a browser can be offered
  // DTLS-SRTP/ICE while a desk phone is offered plain RTP in the same ring.
  // All forks are INVITEd at once; the first to answer is bridged to the
  // caller and the rest are cancelled.
  // ============================================================
  async _ringParallelPerLeg(req, res, members, ringTime, cdr) {
    const rtpHelper = require('../utils/rtp-helper');
    const { v4: uuidv4 } = require('uuid');
    const fromTag = req.getParsedHeader('From').params.tag;

    const targets = members.map(m => ({ m, t: this._memberTarget(m) }));
    logger.info(`SIMRING(per-leg): forking to ${targets.length} targets: ` +
      targets.map(x => `${x.t.uri}${x.t.webrtc ? ' [webrtc]' : ''}`).join(', '));

    let settled = false;
    const uacs = [];
    const pendingInvites = new Map(); // uri -> in-flight INVITE (for CANCEL)

    // CANCEL every fork that is still ringing, and tear down any that answered
    // after the race was already won.
    const cancelOthers = (winnerUri) => {
      for (const [uri, inviteReq] of pendingInvites) {
        if (uri === winnerUri) continue;
        try { inviteReq.cancel(); } catch (e) {}
      }
      pendingInvites.clear();
    };

    const dialOne = async ({ m, t }) => {
      // One RTPEngine session per fork so each leg gets its own media type.
      const legCallId = `${uuidv4()}`;
      let legSdp = req.body;
      if (this.rtpengine) {
        try {
          const o = await rtpHelper.offer(this.rtpengine, legCallId, fromTag, req.body,
            { 'record call': 'yes' }, { target: t.media });
          if (o && o.sdp) legSdp = o.sdp;
        } catch (e) {
          logger.warn(`SIMRING(per-leg): RTPEngine offer failed for ${m.extension}: ${e.message}`);
          if (t.webrtc) throw new Error('webrtc media bridge unavailable'); // browser can't take raw SDP
        }
      } else if (t.webrtc) {
        throw new Error('webrtc member requires RTPEngine');
      }

      // cbRequest hands us the outgoing INVITE while it is still ringing, so a
      // fork that loses the race can be CANCELled (otherwise that device keeps
      // ringing after someone else answers).
      const uac = await this.srf.createUAC(t.uri, {
        localSdp: legSdp,
        headers: {}
      }, {
        cbRequest: (err, inviteReq) => { if (!err && inviteReq) pendingInvites.set(t.uri, inviteReq); }
      });
      pendingInvites.delete(t.uri);
      return { uac, m, t, legCallId };
    };

    try {
      const winner = await new Promise((resolve, reject) => {
        let pending = targets.length;
        let lastErr = null;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            cancelOthers(null); // stop every device ringing
            reject(Object.assign(new Error('timeout'), { status: 408 }));
          }
        }, (parseInt(ringTime) || 30) * 1000);

        targets.forEach((x) => {
          dialOne(x).then((win) => {
            if (settled) { try { win.uac.destroy(); } catch (e) {} return; }
            settled = true;
            clearTimeout(timer);
            // Someone answered — stop the other devices ringing immediately.
            cancelOthers(win.t.uri);
            resolve(win);
          }).catch((err) => {
            lastErr = err;
            logger.info(`SIMRING(per-leg): ${x.m.extension} failed (${err.status || err.message})`);
            if (--pending === 0 && !settled) {
              settled = true;
              clearTimeout(timer);
              reject(lastErr || new Error('no answer'));
            }
          });
          uacs.push(x);
        });
      });

      // Cancel the losing forks.
      // (Each dialOne's own promise cleans itself up via the settled check.)

      // Bridge the winner back to the caller: run its answer through the same
      // RTPEngine session so the caller gets plain RTP regardless of leg type.
      let answerSdp = winner.uac.remote && winner.uac.remote.sdp ? winner.uac.remote.sdp : '';
      if (this.rtpengine && answerSdp) {
        try {
          const toTag = (winner.uac.sip && winner.uac.sip.remote && winner.uac.sip.remote.tag) || '';
          const a = await rtpHelper.answer(this.rtpengine, winner.legCallId, fromTag, toTag, answerSdp,
            { 'record call': 'yes' });
          if (a && a.sdp) answerSdp = a.sdp;
        } catch (e) {
          logger.warn(`SIMRING(per-leg): RTPEngine answer failed: ${e.message}`);
        }
      }

      const uas = await this.srf.createUAS(req, res, { localSdp: answerSdp });
      uas._rtpCallId = winner.legCallId;
      uas._rtpFromTag = fromTag;
      winner.uac._rtpCallId = winner.legCallId;
      winner.uac._rtpFromTag = fromTag;

      uas.on('destroy', () => { try { winner.uac.destroy(); } catch (e) {} });
      winner.uac.on('destroy', () => { try { uas.destroy(); } catch (e) {} });

      logger.info(`SIMRING(per-leg): answered by ${winner.m.extension}${winner.t.webrtc ? ' [webrtc]' : ''}`);
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.to = winner.m.extension;
      cdr.rtpCallId = winner.legCallId;
      await cdr.save();
      return { uas, uac: winner.uac, answeredBy: winner.m.extension };
    } catch (err) {
      logger.info(`SIMRING(per-leg): no answer - ${err.message || 'timeout'}`);
      cdr.status = 'missed';
      await cdr.save();
      return null; // let call-handler try voicemail
    }
  }

  // SEQUENTIAL - Ring members one at a time using createB2BUA
  // Uses passFailure:false to try the next member on failure
  // ============================================================
  async _ringSequential(req, res, members, ringTimePerMember, cdr) {
    logger.info(`SEQUENTIAL: trying ${members.length} members in order`);

    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      const targetUri = `sip:${member.extension}@${member.contact.ip}:${member.contact.port}`;
      const isLast = (i === members.length - 1);

      logger.info(`SEQUENTIAL: trying ${member.extension} at ${targetUri} (${i + 1}/${members.length})`);

      try {
        const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
          localSdpB: req.body,
          passFailure: false,  // Never pass failure — voicemail needs the req/res
          headers: {},
          finalTimeout: `${ringTimePerMember || 15}s`
        });

        logger.info(`SEQUENTIAL: ${member.extension} answered`);
        cdr.status = 'answered';
        cdr.answerTime = new Date();
        cdr.to = member.extension;
        await cdr.save();
        return { uas, uac, answeredBy: member.extension };
      } catch (err) {
        logger.info(`SEQUENTIAL: ${member.extension} failed (${err.status || err.message})`);
        // If caller hung up (487), stop trying
        if (err.status === 487) {
          logger.info('SEQUENTIAL: caller canceled');
          cdr.status = 'missed';
          cdr.hangupCause = 'caller_cancel';
          await cdr.save();
          return null;
        }
        // Continue to next member
      }
    }

    // Nobody answered
    logger.info('SEQUENTIAL: no members answered');
    cdr.status = 'missed';
    await cdr.save();
    return null;
  }

  // ============================================================
  // Single B2BUA call - fallback when simring is not available
  // ============================================================
  async _ringB2BUA(req, res, member, ringTime, cdr) {
    const targetUri = `sip:${member.extension}@${member.contact.ip}:${member.contact.port}`;
    logger.info(`B2BUA: dialing ${member.extension} at ${targetUri}`);

    try {
      const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
        localSdpB: req.body,
        passFailure: false,
        headers: {},
        finalTimeout: `${ringTime || 30}s`
      });

      logger.info(`B2BUA: ${member.extension} answered`);
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.to = member.extension;
      await cdr.save();
      return { uas, uac, answeredBy: member.extension };
    } catch (err) {
      logger.error(`B2BUA: ${member.extension} failed - ${err.message}`);
      cdr.status = 'missed';
      await cdr.save();
      return null;
    }
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
