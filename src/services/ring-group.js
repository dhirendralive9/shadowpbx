const { RingGroup } = require('../models');
const logger = require('../utils/logger');

class RingGroupHandler {
  constructor(srf, registrar, rtpengine) {
    this.srf = srf;
    this.registrar = registrar;
    this.rtpengine = rtpengine;
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };
  }

  // Check if a dialed number is a ring group
  async isRingGroup(number) {
    const rg = await RingGroup.findOne({ number, enabled: true });
    return rg;
  }

  // Ring a group based on strategy
  async ringGroup(req, res, ringGroup, cdr) {
    const { strategy, members, ringTime, name, number } = ringGroup;

    logger.info(`RINGGROUP ${number} (${name}): strategy=${strategy} members=${members.join(',')}`);

    // Get registered contacts for all members
    const availableMembers = [];
    for (const ext of members) {
      const contacts = await this.registrar.getContacts(ext);
      if (contacts.length > 0) {
        availableMembers.push({ extension: ext, contacts });
      }
    }

    if (availableMembers.length === 0) {
      logger.warn(`RINGGROUP ${number}: no members registered`);
      return res.send(480); // Temporarily Unavailable
    }

    logger.info(`RINGGROUP ${number}: ${availableMembers.length}/${members.length} members available`);

    switch (strategy) {
      case 'ringall':
        return this._ringAll(req, res, availableMembers, ringTime, cdr);
      case 'sequential':
        return this._ringSequential(req, res, availableMembers, ringTime, cdr);
      case 'random':
        // Shuffle and ring sequentially
        const shuffled = availableMembers.sort(() => Math.random() - 0.5);
        return this._ringSequential(req, res, shuffled, ringTime, cdr);
      default:
        return this._ringAll(req, res, availableMembers, ringTime, cdr);
    }
  }

  // Ring all members simultaneously
  async _ringAll(req, res, members, ringTime, cdr) {
    // Build SIP URIs for all available members
    const targets = members.map(m => {
      const c = m.contacts[0];
      return `sip:${m.extension}@${c.ip}:${c.port}`;
    });

    logger.info(`RINGALL: dialing ${targets.length} targets for ${ringTime}s`);

    // Try to reach any of them using forking
    // Drachtio's proxyRequest supports forking to multiple targets
    try {
      // Use first target with B2BUA, fork others via headers
      // For true simultaneous ring, we use proxyRequest
      const result = await this.srf.proxyRequest(req, targets, {
        recordRoute: true,
        followRedirects: true,
        forking: 'simultaneous',
        timeout: ringTime + 's'
      });

      if (result.finalStatus === 200) {
        cdr.status = 'answered';
        cdr.answerTime = new Date();
        await cdr.save();
        logger.info(`RINGALL: answered by one of the targets`);
        return result;
      } else {
        logger.info(`RINGALL: no answer (status=${result.finalStatus})`);
        cdr.status = 'missed';
        await cdr.save();
        return null;
      }
    } catch (err) {
      // Fallback: try each member one at a time with short timeout
      logger.warn(`RINGALL proxy failed, falling back to sequential: ${err.message}`);
      return this._ringSequential(req, res, members, ringTime, cdr);
    }
  }

  // Ring members one at a time
  async _ringSequential(req, res, members, ringTimePerMember, cdr) {
    for (const member of members) {
      const contact = member.contacts[0];
      const targetUri = `sip:${member.extension}@${contact.ip}:${contact.port}`;

      logger.info(`SEQUENTIAL: trying ${member.extension} for ${ringTimePerMember}s`);

      try {
        const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
          localSdpB: req.body,
          headers: {
            'Alert-Info': '<http://www.notused.com>;info=alert-group'
          },
          timeout: ringTimePerMember * 1000
        });

        // Answered!
        cdr.status = 'answered';
        cdr.answerTime = new Date();
        cdr.to = member.extension;
        await cdr.save();

        logger.info(`SEQUENTIAL: ${member.extension} answered`);
        return { uas, uac, answeredBy: member.extension };

      } catch (err) {
        if (err.status === 487) {
          // Caller cancelled
          logger.info(`SEQUENTIAL: caller cancelled while ringing ${member.extension}`);
          cdr.status = 'missed';
          cdr.hangupBy = 'caller';
          await cdr.save();
          return null;
        }
        // No answer or busy, try next
        logger.info(`SEQUENTIAL: ${member.extension} - ${err.status || err.message}, trying next`);
      }
    }

    // No one answered
    logger.info(`SEQUENTIAL: no members answered`);
    cdr.status = 'missed';
    await cdr.save();

    if (!res.finalResponseSent) {
      res.send(480);
    }
    return null;
  }
}

module.exports = RingGroupHandler;
