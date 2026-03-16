const { Trunk } = require('../models');
const logger = require('../utils/logger');

class TrunkManager {
  constructor(srf) {
    this.srf = srf;
    this.registrations = new Map(); // trunkName -> registration dialog
    this.trunkEndpoints = new Map(); // trunkName -> trunk config
  }

  // Initialize all enabled trunks on startup
  async initialize() {
    const trunks = await Trunk.find({ enabled: true });
    for (const trunk of trunks) {
      await this.registerTrunk(trunk);
    }
    logger.info(`TrunkManager: ${trunks.length} trunk(s) initialized`);

    // Re-register every 5 minutes
    setInterval(() => this._refreshRegistrations(), 300000);
  }

  // Register a trunk with the provider
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

      // Update DB
      trunk.registered = true;
      trunk.registeredAt = new Date();
      await trunk.save();

      logger.info(`Trunk ${trunk.name}: registered with ${trunk.host}`);
    } catch (err) {
      logger.error(`Trunk ${trunk.name}: registration failed - ${err.message}`);
      trunk.registered = false;
      await trunk.save();
    }
  }

  // Send outbound call through a trunk
  // Send outbound call through a trunk
  async sendOutbound(req, res, trunk, dialedNumber, callerId) {
    const trunkConfig = typeof trunk === 'string' ? this.trunkEndpoints.get(trunk) : trunk;
    if (!trunkConfig) {
      throw new Error(`Trunk not configured`);
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

  // Check if a SIP INVITE is from a known trunk (inbound)
  isFromTrunk(req) {
    const sourceIp = req.source_address;
    const fromUri = req.getParsedHeader('From').uri;

    for (const [name, trunk] of this.trunkEndpoints) {
      // Match by source IP or From URI domain
      if (fromUri.includes(trunk.host)) {
        return { isTrunk: true, trunkName: name, trunk };
      }
    }
    return { isTrunk: false };
  }

  // Get trunk by name
  getTrunk(name) {
    return this.trunkEndpoints.get(name);
  }

  // Get all trunk statuses
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

  // Refresh registrations for active trunks
  async _refreshRegistrations() {
    const trunks = await Trunk.find({ enabled: true, register: true });
    for (const trunk of trunks) {
      await this.registerTrunk(trunk);
    }
  }
}

module.exports = TrunkManager;
