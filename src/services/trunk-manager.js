const { Trunk } = require('../models');
const logger = require('../utils/logger');
const dns = require('dns').promises;

class TrunkManager {
  constructor(srf) {
    this.srf = srf;
    this.registrations = new Map();
    this.trunkEndpoints = new Map();
    // Source IPs that count as "genuinely this trunk". Resolved from each
    // trunk host, plus any explicit TRUNK_TRUSTED_IPS. Trust is decided on
    // this, NOT on From/User-Agent headers, which any endpoint can forge.
    this.trustedIps = new Map();        // ip -> trunkName
    this._envTrusted = (process.env.TRUNK_TRUSTED_IPS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
  }

  async initialize() {
    const trunks = await Trunk.find({ enabled: true });
    for (const trunk of trunks) {
      await this.registerTrunk(trunk);
    }
    await this._resolveTrustedIps();
    logger.info(`TrunkManager: ${trunks.length} trunk(s) initialized, ${this.trustedIps.size} trusted source IP(s)`);

    setInterval(() => this._refreshRegistrations(), 300000);
    // Provider IPs can change; re-resolve periodically.
    setInterval(() => this._resolveTrustedIps().catch(() => {}), 3600000);
  }

  // Resolve every trunk host to its IP addresses and remember them as the
  // trusted sources for that trunk. Explicit TRUNK_TRUSTED_IPS (an SBC or a
  // provider's published range) are added verbatim — use these when a provider
  // sends from IPs that don't match the host's DNS.
  async _resolveTrustedIps() {
    const next = new Map();
    for (const ip of this._envTrusted) next.set(ip, 'env');
    for (const [name, trunk] of this.trunkEndpoints) {
      const host = trunk.host;
      if (!host) continue;
      // A host that is already an IP literal is trusted as-is.
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) { next.set(host, name); continue; }
      // Also allow per-trunk trustedIps in the DB (array of IPs/CIDRs).
      if (Array.isArray(trunk.trustedIps)) for (const ip of trunk.trustedIps) if (ip) next.set(String(ip).trim(), name);
      try {
        const addrs = await dns.resolve4(host);
        for (const ip of addrs) next.set(ip, name);
      } catch (e) {
        logger.warn(`TrunkManager: could not resolve ${host} for ${name}: ${e.message}`);
      }
    }
    this.trustedIps = next;
    logger.debug(`TrunkManager: trusted source IPs: ${[...next.keys()].join(', ') || '(none)'}`);
  }

  // Is this source IP a known trunk endpoint?
  trunkForSourceIp(ip) {
    if (!ip) return null;
    const bare = ip.replace(/^::ffff:/, '');
    return this.trustedIps.get(bare) || this.trustedIps.get(ip) || null;
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
  async sendOutbound(req, res, trunk, dialedNumber, callerId, rtpSdp) {
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
      localSdpB: rtpSdp || req.body,
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

  // Outbound with full RTPEngine SDP control (offer + answer callbacks)
  async sendOutboundWithRtp(req, res, trunk, dialedNumber, callerId, sdpOpts, ringTimeout) {
    const trunkConfig = typeof trunk === 'string' ? this.trunkEndpoints.get(trunk) : trunk;
    if (!trunkConfig) {
      throw new Error('Trunk not configured');
    }

    const host = trunkConfig.host || trunk.host;
    const port = trunkConfig.port || 5060;
    const username = trunkConfig.username || trunk.username;
    const password = trunkConfig.password || trunk.password;

    const targetUri = `sip:${dialedNumber}@${host}:${port}`;
    const timeout = (ringTimeout || 60) * 1000;

    logger.info(`Outbound via ${trunkConfig.name || 'trunk'}: ${callerId} -> ${dialedNumber} @ ${host} [RTP-bridged, ring=${ringTimeout || 60}s]`);

    return this.srf.createB2BUA(req, res, targetUri, {
      localSdpB: sdpOpts.localSdpB,
      localSdpA: sdpOpts.localSdpA,
      headers: {
        'From': `<sip:${username}@${host}>`,
        'P-Asserted-Identity': `<sip:${callerId}@${host}>`
      },
      auth: {
        username: username,
        password: password
      },
      timeout
    });
  }

  async isFromTrunk(req) {
    const fromUri = req.getParsedHeader('From').uri;
    const toUri = req.getParsedHeader('To').uri;
    const userAgent = req.get('User-Agent') || '';
    const sourceIp = req.source_address || '';
    const logger = require('../utils/logger');

    // ── Trust hierarchy (strongest first) ──
    //
    // Check 1: SOURCE IP. This is the only strong signal. If the INVITE
    // arrives from an IP the trunk actually resolves to (or an explicitly
    // trusted SBC), it is genuinely trunk traffic. From/User-Agent headers are
    // NOT used to grant trust — any endpoint can forge "From: user@twilio.com"
    // or "User-Agent: Twilio", and doing so previously let an attacker be
    // classified as an inbound carrier call.
    const ipTrunk = this.trunkForSourceIp(sourceIp);
    if (ipTrunk && ipTrunk !== 'env') {
      const trunk = this.trunkEndpoints.get(ipTrunk) || null;
      return { isTrunk: true, trunkName: ipTrunk, trunk, via: 'source-ip' };
    }
    if (ipTrunk === 'env') {
      // Trusted SBC/range with no single owning trunk — attribute to the first.
      const first = this.trunkEndpoints.entries().next().value;
      return { isTrunk: true, trunkName: first ? first[0] : 'trusted', trunk: first ? first[1] : null, via: 'trusted-ip' };
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
          // DID match is a WEAK signal (the To header is attacker-controllable),
          // so only honour it when IP-based trust isn't configured — otherwise
          // an unknown source IP that guesses one of our DIDs would be treated
          // as a carrier. With trusted IPs set, an unknown IP is never a trunk.
          if (this.trustedIps.size > 0) {
            logger.warn(`TrunkManager: INVITE from untrusted IP ${sourceIp} matched DID ${route.did} but source is not a known trunk — NOT trusting`);
            break;
          }
          const firstTrunk = this.trunkEndpoints.entries().next().value;
          const trunkName = firstTrunk ? firstTrunk[0] : 'unknown';
          const trunk = firstTrunk ? firstTrunk[1] : null;
          logger.debug(`Trunk detected via DID match (no IP trust configured): To=${calledNumber} -> trunk=${trunkName}`);
          return { isTrunk: true, trunkName, trunk, via: 'did-match' };
        }
      }

      // Check 3: Catch-all route exists AND caller has long number (not a local extension)
      const catchAll = routes.find(r => !r.did || r.did === '');
      if (catchAll && this.trustedIps.size === 0) {
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
