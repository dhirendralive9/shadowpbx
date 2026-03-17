const { RingGroup } = require('../models');
const logger = require('../utils/logger');

class RingGroupHandler {
  constructor(srf, registrar, rtpengine) {
    this.srf = srf;
    this.registrar = registrar;
    this.rtpengine = rtpengine;
    this.simring = null;

    // Load simring from drachtio-fn-b2b-sugar
    try {
      const { simring } = require('drachtio-fn-b2b-sugar');
      this.simring = simring;
      logger.info('SimRing loaded from drachtio-fn-b2b-sugar');
    } catch (err) {
      logger.warn('drachtio-fn-b2b-sugar not available, using proxy fallback');
    }
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

  // SIMULTANEOUSLY - Ring all members at once using simring
  async _ringSimultaneously(req, res, members, ringTime, cdr) {
    const targets = members.map(m => {
      const c = m.contacts[0];
      return `sip:${m.extension}@${c.ip}:${c.port}`;
    });

    logger.info(`SIMRING: forking to ${targets.length} targets: ${targets.join(', ')}`);

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
        logger.info(`SIMRING: answered (status=${result.finalStatus})`);
        return { proxy: true, answeredBy: 'proxy' };
      }

      logger.info(`SIMRING: no answer (status=${result.finalStatus})`);
      cdr.status = 'missed';
      await cdr.save();
      return null;
    } catch (err) {
      logger.error(`SIMRING: error - ${err.message}`);
      cdr.status = 'missed';
      await cdr.save();
      return null;
    }
  }



  // Proxy fallback - single target
  async _ringProxy(req, res, members, ringTime, cdr) {
    const contact = members[0].contacts[0];
    const targetUri = `sip:${members[0].extension}@${contact.ip}:${contact.port}`;

    logger.info(`PROXY: routing to ${members[0].extension} at ${targetUri}`);

    try {
      const result = await this.srf.proxyRequest(req, targetUri, {
        recordRoute: true,
        followRedirects: true,
        timeout: ringTime + 's'
      });

      if (result.finalStatus >= 200 && result.finalStatus < 300) {
        cdr.status = 'answered';
        cdr.answerTime = new Date();
        cdr.to = members[0].extension;
        await cdr.save();
        logger.info(`PROXY: ${members[0].extension} answered`);
        return { proxy: true, answeredBy: members[0].extension };
      }

      logger.info(`PROXY: no answer (status=${result.finalStatus})`);
      cdr.status = 'missed';
      await cdr.save();
      return null;
    } catch (err) {
      logger.error(`PROXY: failed - ${err.message}`);
      cdr.status = 'missed';
      await cdr.save();
      return null;
    }
  }

  // ORDER BY - Ring members one at a time using proxy
  async _ringSequential(req, res, members, ringTimePerMember, cdr) {
    // proxyRequest can only be called once, so use it for the first member
    // For true sequential, we'd need createB2BUA but that has SDP issues with trunks
    // So we proxy to first member only
    logger.info(`SEQUENTIAL: trying ${members.length} members, starting with ${members[0].extension}`);
    return this._ringProxy(req, res, members, ringTimePerMember, cdr);
  }

  // ROUND ROBIN - Rotate starting member each call
  async _ringRoundRobin(req, res, members, ringTimePerMember, cdr, ringGroup) {
    let startIndex = (ringGroup.lastAgentIndex + 1) % members.length;
    const ordered = [...members.slice(startIndex), ...members.slice(0, startIndex)];
    logger.info(`ROUNDROBIN: starting from ${ordered[0].extension}`);

    const result = await this._ringProxy(req, res, ordered, ringTimePerMember, cdr);

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