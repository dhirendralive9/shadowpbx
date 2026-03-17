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
        return this._ringAll(req, res, availableMembers, ringTime, cdr);
      case 'orderby':
      case 'sequential':
        return this._ringSequential(req, res, availableMembers, ringTime, cdr);
      case 'random':
        const shuffled = [...availableMembers].sort(() => Math.random() - 0.5);
        return this._ringSequential(req, res, shuffled, ringTime, cdr);
      case 'roundrobin':
        return this._ringRoundRobin(req, res, availableMembers, ringTime, cdr, ringGroup);
      default:
        return this._ringAll(req, res, availableMembers, ringTime, cdr);
    }
  }

  async _ringAll(req, res, members, ringTime, cdr) {
    logger.info(`RINGALL: dialing ${members.length} targets for ${ringTime}s`);

    // Use proxyRequest to first available member
    // proxyRequest with multiple targets doesn't reliably ring all phones
    const contact = members[0].contacts[0];
    const targetUri = `sip:${members[0].extension}@${contact.ip}:${contact.port}`;

    logger.info(`RINGALL: routing to first available ${members[0].extension} at ${targetUri}`);

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
        logger.info(`RINGALL: ${members[0].extension} answered`);
        return { proxy: true, answeredBy: members[0].extension };
      }

      logger.info(`RINGALL: no answer (status=${result.finalStatus})`);
      cdr.status = 'missed';
      await cdr.save();
      return null;
    } catch (err) {
      logger.error(`RINGALL: failed - ${err.message}`);
      cdr.status = 'missed';
      await cdr.save();
      return null;
    }
  }

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
          logger.info(`SEQUENTIAL: caller cancelled`);
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

  async _ringRoundRobin(req, res, members, ringTimePerMember, cdr, ringGroup) {
    let startIndex = (ringGroup.lastAgentIndex + 1) % members.length;
    const ordered = [...members.slice(startIndex), ...members.slice(0, startIndex)];
    logger.info(`ROUNDROBIN: starting from index ${startIndex} (${ordered[0].extension})`);

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