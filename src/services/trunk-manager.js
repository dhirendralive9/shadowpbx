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

  async isFromTrunk(req) {
    const fromUri = req.getParsedHeader('From').uri;
    const toUri = req.getParsedHeader('To').uri;
    const userAgent = req.get('User-Agent') || '';
    const sourceIp = req.source_address || '';
    const logger = require('../utils/logger');

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

    // Check 2: The To-URI contains a DID that matches a configured inbound route
    // This is the most reliable check — if someone calls a DID we own, it's inbound
    const { InboundRoute } = require('../models');
    const toMatch = toUri.match(/sip:\+?(\d+)@/);
    if (toMatch) {
      const calledNumber = toMatch[1];
      // Check against all configured inbound route DIDs
      const routes = await InboundRoute.find({ enabled: true }).lean();
      for (const route of routes) {
        if (!route.did) continue; // skip catch-all
        // Match exact or with/without leading 1 or +
        const did = route.did.replace(/^\+/, '');
        if (calledNumber === did || calledNumber === '1' + did || calledNumber === did.replace(/^1/, '')) {
          const firstTrunk = this.trunkEndpoints.entries().next().value;
          const trunkName = firstTrunk ? firstTrunk[0] : 'unknown';
          const trunk = firstTrunk ? firstTrunk[1] : null;
          logger.debug(`Trunk detected via DID match: To=${calledNumber} matched route DID=${route.did} -> trunk=${trunkName}`);
          return { isTrunk: true, trunkName, trunk };
        }
      }

      // Check 3: Catch-all route exists AND caller has long number (not a local extension)
      const catchAll = routes.find(r => !r.did || r.did === '');
      if (catchAll) {
        const fromMatch = fromUri.match(/sip:\+?(\d+)@/);
        if (fromMatch && fromMatch[1].length > 6) {
          const firstTrunk = this.trunkEndpoints.entries().next().value;
          const trunkName = firstTrunk ? firstTrunk[0] : 'unknown';
          const trunk = firstTrunk ? firstTrunk[1] : null;
          logger.debug(`Trunk detected via catch-all + long caller: caller=${fromMatch[1]} -> trunk=${trunkName}`);
          return { isTrunk: true, trunkName, trunk };
        }
      }
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
