const { Trunk } = require('../models');
const logger = require('../utils/logger');

class TrunkManager {
  constructor(srf) {
    this.srf = srf;
    this.registrations = new Map();
    this.trunkEndpoints = new Map();
  }

  async initialize() {
    const trunks = await Trunk.find({ enabled: true });
    for (const trunk of trunks) {
      await this.registerTrunk(trunk);
    }
    logger.info(`TrunkManager: ${trunks.length} trunk(s) initialized`);

    setInterval(() => this._refreshRegistrations(), 300000);
  }

  async registerTrunk(trunk) {
    if (!trunk.register) {
      this.trunkEndpoints.set(trunk.name, trunk);
      logger.info(`Trunk ${trunk.name}: configured (no registration)`);
      return;
    }

    try {
      const uri = `sip:${trunk.username}@${trunk.host}`;

      const result = await this.srf.request(uri, {
        method: 'REGISTER',
        headers: {
          'To': `<${uri}>`,
          'From': `<${uri}>`,
          'Contact': '<sip:placeholder>',
          'Expires': '3600'
        },
        auth: {
          username: trunk.username,
          password: trunk.password
        }
      });

      this.trunkEndpoints.set(trunk.name, trunk);
      trunk.registered = true;
      trunk.registeredAt = new Date();
      await trunk.save();

      logger.info(`Trunk ${trunk.name}: registered with ${trunk.host}`);
    } catch (err) {
      // Even if registration fails, still add to endpoints for outbound
      this.trunkEndpoints.set(trunk.name, trunk);
      logger.error(`Trunk ${trunk.name}: registration failed - ${err.message}`);
      trunk.registered = false;
      await trunk.save();
    }
  }

  // Send outbound call through a trunk with auth
  async sendOutbound(req, res, trunk, dialedNumber, callerId) {
    const trunkConfig = typeof trunk === 'string' ? this.trunkEndpoints.get(trunk) : trunk;
    if (!trunkConfig) {
      throw new Error('Trunk not configured');
    }

    const host = trunkConfig.host || trunk.host;
    const port = trunkConfig.port || 5060;
    const username = trunkConfig.username || trunk.username;
    const password = trunkConfig.password || trunk.password;

    const targetUri = `sip:${dialedNumber}@${host}:${port}`;

    logger.info(`Outbound via ${trunkConfig.name || 'trunk'}: ${callerId} -> ${dialedNumber} @ ${host}`);

    return this.srf.createB2BUA(req, res, targetUri, {
      localSdpB: req.body,
      headers: {
        'From': `<sip:${username}@${host}>`,
        'P-Asserted-Identity': `<sip:${callerId}@${host}>`
      },
      auth: {
        username: username,
        password: password
      }
    });
  }

  isFromTrunk(req) {
    const fromUri = req.getParsedHeader('From').uri;
    const toUri = req.getParsedHeader('To').uri;
    const userAgent = req.get('User-Agent') || '';
    const sourceIp = req.source_address || '';

    // Check 1: From-URI or User-Agent matches known trunk providers
    for (const [name, trunk] of this.trunkEndpoints) {
      if (fromUri.includes(trunk.host) ||
          fromUri.includes('signalwire.com') ||
          fromUri.includes('twilio.com') ||
          userAgent.includes('SignalWire') ||
          userAgent.includes('Twilio')) {
        return { isTrunk: true, trunkName: name, trunk };
      }
    }

    // Check 2: Source IP is Docker bridge, private network, or localhost
    // Trunk calls arrive through Drachtio container which has Docker IPs
    const isPrivateNetwork = /^172\.(1[6-9]|2\d|3[01])\./.test(sourceIp) ||
                             sourceIp === '127.0.0.1' ||
                             sourceIp === '::1' ||
                             sourceIp.startsWith('10.') ||
                             sourceIp.startsWith('192.168.');

    if (isPrivateNetwork) {
      const fromUser = fromUri.match(/sip:\+?(\d+)@/);
      if (fromUser && fromUser[1].length > 6) {
        // Long number from Docker/private network = trunk call
        const firstTrunk = this.trunkEndpoints.entries().next().value;
        if (firstTrunk) {
          logger.debug(`Trunk detected via private network: src=${sourceIp} caller=${fromUser[1]} -> trunk=${firstTrunk[0]}`);
          return { isTrunk: true, trunkName: firstTrunk[0], trunk: firstTrunk[1] };
        }
      }
    }

    // Check 3: The caller number is longer than typical extensions (>6 digits)
    // and there are trunks configured — likely an inbound trunk call
    // regardless of source IP (Drachtio may rewrite source)
    const fromMatch = fromUri.match(/sip:\+?(\d+)@/);
    if (fromMatch && fromMatch[1].length > 6 && this.trunkEndpoints.size > 0) {
      // Verify it's NOT a registered extension
      const firstTrunk = this.trunkEndpoints.entries().next().value;
      logger.debug(`Trunk detected via long caller ID: caller=${fromMatch[1]} -> trunk=${firstTrunk[0]}`);
      return { isTrunk: true, trunkName: firstTrunk[0], trunk: firstTrunk[1] };
    }

    return { isTrunk: false };
  }

  getTrunk(name) {
    return this.trunkEndpoints.get(name);
  }

  async getStatus() {
    const trunks = await Trunk.find({});
    return trunks.map(t => ({
      name: t.name,
      provider: t.provider,
      host: t.host,
      registered: t.registered,
      enabled: t.enabled,
      registeredAt: t.registeredAt
    }));
  }

  async _refreshRegistrations() {
    const trunks = await Trunk.find({ enabled: true, register: true });
    for (const trunk of trunks) {
      await this.registerTrunk(trunk);
    }
  }
}

module.exports = TrunkManager;
