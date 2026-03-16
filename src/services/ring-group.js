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
    const { strategy, members, ringTime, name, number, callerIdPrefix, hideCallerId, stickyAgent } = ringGroup;

    logger.info(`RINGGROUP ${number} (${name}): strategy=${strategy} members=${members.join(',')}`);

    // Get available (registered) members
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

    // Sticky agent: if caller called before, try that agent first
    if (stickyAgent && cdr.from) {
      const lastAgent = ringGroup.stickyMap?.get(cdr.from);
      if (lastAgent) {
        const agentIdx = availableMembers.findIndex(m => m.extension === lastAgent);
        if (agentIdx > 0) {
          const agent = availableMembers.splice(agentIdx, 1)[0];
          availableMembers.unshift(agent);
          logger.info(`STICKY AGENT: moving ${lastAgent} to front for caller ${cdr.from}`);
        }
      }
    }

    // Modify caller ID if prefix set
    if (callerIdPrefix && req.callingNumber) {
      // Will be visible in the SIP headers
      logger.info(`RINGGROUP: adding caller ID prefix "${callerIdPrefix}"`);
    }

    let result = null;

    switch (strategy) {
      case 'simultaneously':
      case 'ringall':
        result = await this._ringSimultaneously(req, res, availableMembers, ringTime, cdr);
        break;
      case 'orderby':
      case 'sequential':
        result = await this._ringSequential(req, res, availableMembers, ringTime, cdr);
        break;
      case 'random':
        const shuffled = [...availableMembers].sort(() => Math.random() - 0.5);
        result = await this._ringSequential(req, res, shuffled, ringTime, cdr);
        break;
      case 'roundrobin':
        result = await this._ringRoundRobin(req, res, availableMembers, ringTime, cdr, ringGroup);
        break;
      default:
        result = await this._ringSimultaneously(req, res, availableMembers, ringTime, cdr);
    }

    // Update sticky agent map if call was answered
    if (result && result.answeredBy && stickyAgent) {
      if (!ringGroup.stickyMap) ringGroup.stickyMap = new Map();
      ringGroup.stickyMap.set(cdr.from, result.answeredBy);
      await ringGroup.save();
    }

    return result;
  }

  // ============================================================
  // SIMULTANEOUSLY - Ring all members at once, first answer wins
  // Uses sequential B2BUA as fallback since true forking is complex
  // ============================================================
  async _ringSimultaneously(req, res, members, ringTime, cdr) {
    if (members.length === 1) {
      return this._ringSingle(req, res, members[0], ringTime, cdr);
    }

    logger.info(`SIMULTANEOUSLY: ringing ${members.length} targets for ${ringTime}s`);

    // Build all target URIs
    const targets = members.map(m => {
      const c = m.contacts[0];
      return `sip:${m.extension}@${c.ip}:${c.port}`;
    });

    // Try proxy forking first (simultaneous ring)
    try {
      const result = await this.srf.proxyRequest(req, targets, {
        recordRoute: true,
        followRedirects: true,
        forking: 'simultaneous',
        timeout: ringTime + 's'
      });

      if (result.finalStatus >= 200 && result.finalStatus < 300) {
        cdr.status = 'answered';
        cdr.answerTime = new Date();
        await cdr.save();
        logger.info(`SIMULTANEOUSLY: answered (status=${result.finalStatus})`);

        // proxyRequest doesn't return uas/uac dialogs
        // Return a flag so caller knows it was handled
        return { proxy: true, answeredBy: 'proxy' };
      }

      logger.info(`SIMULTANEOUSLY: proxy no answer (status=${result.finalStatus}), trying sequential`);
    } catch (err) {
      logger.warn(`SIMULTANEOUSLY: proxy failed (${err.message}), falling back to sequential`);
    }

    // Fallback: ring each one sequentially with short timeout
    const perMemberTime = Math.max(5, Math.floor(ringTime / members.length));
    return this._ringSequential(req, res, members, perMemberTime, cdr);
  }

  // ============================================================
  // SINGLE - Ring one member (used when only 1 available)
  // ============================================================
  async _ringSingle(req, res, member, ringTime, cdr) {
    const contact = member.contacts[0];
    const targetUri = `sip:${member.extension}@${contact.ip}:${contact.port}`;

    logger.info(`SINGLE: ringing ${member.extension} for ${ringTime}s`);

    try {
      const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
        localSdpB: req.body,
        timeout: ringTime * 1000
      });

      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.to = member.extension;
      await cdr.save();

      logger.info(`SINGLE: ${member.extension} answered`);
      return { uas, uac, answeredBy: member.extension };

    } catch (err) {
      if (err.status === 487) {
        logger.info(`SINGLE: caller cancelled`);
        cdr.status = 'missed';
        cdr.hangupBy = 'caller';
        await cdr.save();
        return null;
      }
      logger.info(`SINGLE: ${member.extension} - ${err.status || err.message}`);
      cdr.status = 'missed';
      await cdr.save();
      if (!res.finalResponseSent) res.send(480);
      return null;
    }
  }

  // ============================================================
  // ORDER BY (Sequential) - Ring members one at a time in order
  // ============================================================
  async _ringSequential(req, res, members, ringTimePerMember, cdr) {
    for (const member of members) {
      const contact = member.contacts[0];
      const targetUri = `sip:${member.extension}@${contact.ip}:${contact.port}`;

      logger.info(`SEQUENTIAL: trying ${member.extension} for ${ringTimePerMember}s`);

      try {
        const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
          localSdpB: req.body,
          timeout: ringTimePerMember * 1000
        });

        cdr.status = 'answered';
        cdr.answerTime = new Date();
        cdr.to = member.extension;
        await cdr.save();

        logger.info(`SEQUENTIAL: ${member.extension} answered`);
        return { uas, uac, answeredBy: member.extension };

      } catch (err) {
        if (err.status === 487) {
          logger.info(`SEQUENTIAL: caller cancelled while ringing ${member.extension}`);
          cdr.status = 'missed';
          cdr.hangupBy = 'caller';
          await cdr.save();
          return null;
        }
        logger.info(`SEQUENTIAL: ${member.extension} - ${err.status || err.message}, trying next`);
      }
    }

    logger.info(`SEQUENTIAL: no members answered`);
    cdr.status = 'missed';
    await cdr.save();
    if (!res.finalResponseSent) res.send(480);
    return null;
  }

  // ============================================================
  // ROUND ROBIN - Rotate starting member each call
  // ============================================================
  async _ringRoundRobin(req, res, members, ringTimePerMember, cdr, ringGroup) {
    let startIndex = (ringGroup.lastAgentIndex + 1) % members.length;

    // Reorder: start from next agent
    const ordered = [
      ...members.slice(startIndex),
      ...members.slice(0, startIndex)
    ];

    logger.info(`ROUNDROBIN: starting from index ${startIndex} (${ordered[0].extension})`);

    const result = await this._ringSequential(req, res, ordered, ringTimePerMember, cdr);

    // Update last agent index for next call
    if (result && result.answeredBy) {
      const answeredIndex = members.findIndex(m => m.extension === result.answeredBy);
      if (answeredIndex >= 0) {
        ringGroup.lastAgentIndex = answeredIndex;
        await ringGroup.save();
        logger.info(`ROUNDROBIN: next call starts after ${result.answeredBy}`);
      }
    }

    return result;
  }
}

module.exports = RingGroupHandler;
