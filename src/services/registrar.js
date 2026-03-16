const crypto = require('crypto');
const { Extension } = require('../models');
const logger = require('../utils/logger');

class Registrar {
  constructor(srf) {
    this.srf = srf;
    this.realm = process.env.SIP_DOMAIN || 'shadowpbx';
    this.nonceMap = new Map();      // nonce -> { created, extension }
    this.failedAttempts = new Map(); // ip -> { count, firstAttempt, banned }
    this.maxAttempts = parseInt(process.env.MAX_REGISTER_ATTEMPTS) || 5;
    this.banDuration = parseInt(process.env.REGISTER_BAN_DURATION) || 300; // seconds

    // Clean expired nonces every 5 min
    setInterval(() => this._cleanNonces(), 300000);
    // Clean expired registrations every 30 sec
    setInterval(() => this._cleanExpiredRegistrations(), 30000);
    // Clean expired bans every 60 sec
    setInterval(() => this._cleanBans(), 60000);
  }

  // Handle incoming REGISTER requests
  async handleRegister(req, res) {
    const from = req.getParsedHeader('From');
    const uri = from.uri;
    const ext = uri.match(/sip:(\d+)@/)?.[1];

    if (!ext) {
      logger.warn(`REGISTER rejected: no extension in From header: ${uri}`);
      return res.send(400);
    }

    // Check if IP is banned
    const clientIp = req.source_address;
    if (this._isBanned(clientIp)) {
      logger.warn(`REGISTER blocked: IP ${clientIp} is banned (brute force protection)`);
      return res.send(403);
    }

    // Check if authorization header exists
    const authHeader = req.get('Authorization');

    if (!authHeader) {
      // Send 401 challenge
      return this._challenge(res, ext);
    }

    // Parse and verify auth
    const authParams = this._parseAuthHeader(authHeader);
    if (!authParams) {
      logger.warn(`REGISTER rejected: malformed auth header from ${ext}`);
      return this._challenge(res, ext);
    }

    // Verify nonce is valid
    if (!this.nonceMap.has(authParams.nonce)) {
      logger.warn(`REGISTER rejected: invalid/expired nonce from ${ext}`);
      return this._challenge(res, ext);
    }

    // Look up extension in MongoDB
    const extension = await Extension.findOne({ extension: ext, enabled: true });
    if (!extension) {
      logger.warn(`REGISTER rejected: unknown extension ${ext}`);
      return res.send(403);
    }

    // Verify credentials (digest auth)
    const valid = this._verifyDigest(authParams, extension.password, req.method);
    if (!valid) {
      this._recordFailure(req.source_address);
      logger.warn(`REGISTER rejected: bad credentials for ${ext} from ${req.source_address}`);
      return this._challenge(res, ext);
    }

    // Successful auth - clear any failure tracking
    this.failedAttempts.delete(req.source_address);

    // Clean up used nonce
    this.nonceMap.delete(authParams.nonce);

    // Get contact and expires
    const contact = req.get('Contact');
    const expiresHeader = req.get('Expires');
    const expires = parseInt(expiresHeader) || 3600;

    // Unregister (expires = 0)
    if (expires === 0 || contact === '*') {
      extension.registrations = [];
      await extension.save();
      logger.info(`Extension ${ext} (${extension.name}) unregistered`);
      return res.send(200, { headers: { 'Expires': '0' } });
    }

    // Extract contact URI and source IP
    const source = `${req.source_address}:${req.source_port}`;
    const ua = req.get('User-Agent') || 'unknown';

    // Add/update registration
    const regData = {
      contact: contact,
      ip: req.source_address,
      port: req.source_port,
      userAgent: ua,
      expires: new Date(Date.now() + expires * 1000),
      registeredAt: new Date()
    };

    // Remove existing registration from same IP:port
    extension.registrations = extension.registrations.filter(
      r => !(r.ip === req.source_address && r.port === req.source_port)
    );

    // Enforce max contacts
    if (extension.registrations.length >= extension.maxContacts) {
      extension.registrations.shift(); // remove oldest
    }

    extension.registrations.push(regData);
    extension.updatedAt = new Date();
    await extension.save();

    logger.info(`Extension ${ext} (${extension.name}) registered from ${source} [${ua}] expires=${expires}s`);

    res.send(200, {
      headers: {
        'Contact': contact,
        'Expires': String(expires)
      }
    });
  }

  // Send 401 challenge
  _challenge(res, ext) {
    const nonce = crypto.randomBytes(16).toString('hex');
    this.nonceMap.set(nonce, { created: Date.now(), extension: ext });

    res.send(401, {
      headers: {
        'WWW-Authenticate': `Digest realm="${this.realm}", nonce="${nonce}", algorithm=MD5, qop="auth"`
      }
    });
  }

  // Parse Authorization header
  _parseAuthHeader(header) {
    if (!header || !header.startsWith('Digest ')) return null;

    const params = {};
    const parts = header.substring(7).split(',');

    for (const part of parts) {
      const [key, ...valueParts] = part.trim().split('=');
      let value = valueParts.join('=').trim();
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      params[key.trim()] = value;
    }

    return params;
  }

  // Verify digest authentication
  _verifyDigest(params, password, method) {
    const { username, realm, nonce, uri, response, qop, nc, cnonce } = params;

    const ha1 = crypto.createHash('md5')
      .update(`${username}:${realm}:${password}`)
      .digest('hex');

    const ha2 = crypto.createHash('md5')
      .update(`${method}:${uri}`)
      .digest('hex');

    let expected;
    if (qop === 'auth') {
      expected = crypto.createHash('md5')
        .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        .digest('hex');
    } else {
      expected = crypto.createHash('md5')
        .update(`${ha1}:${nonce}:${ha2}`)
        .digest('hex');
    }

    return expected === response;
  }

  // Get SIP contact URIs for an extension
  async getContacts(ext) {
    const extension = await Extension.findOne({ extension: ext, enabled: true });
    if (!extension) return [];
    return extension.getActiveContacts();
  }

  // Check if extension is registered
  async isRegistered(ext) {
    const contacts = await this.getContacts(ext);
    return contacts.length > 0;
  }

  // Clean expired nonces (older than 5 min)
  _cleanNonces() {
    const cutoff = Date.now() - 300000;
    for (const [nonce, data] of this.nonceMap) {
      if (data.created < cutoff) this.nonceMap.delete(nonce);
    }
  }

  // Brute force protection
  _isBanned(ip) {
    const record = this.failedAttempts.get(ip);
    if (!record) return false;
    if (record.banned && record.bannedUntil > Date.now()) return true;
    if (record.banned && record.bannedUntil <= Date.now()) {
      this.failedAttempts.delete(ip);
      return false;
    }
    return false;
  }

  _recordFailure(ip) {
    const record = this.failedAttempts.get(ip) || { count: 0, firstAttempt: Date.now() };
    record.count++;

    if (record.count >= this.maxAttempts) {
      record.banned = true;
      record.bannedUntil = Date.now() + (this.banDuration * 1000);
      logger.warn(`IP ${ip} BANNED for ${this.banDuration}s after ${record.count} failed auth attempts`);
    }

    this.failedAttempts.set(ip, record);
  }

  _cleanBans() {
    const now = Date.now();
    for (const [ip, record] of this.failedAttempts) {
      if (record.banned && record.bannedUntil <= now) {
        this.failedAttempts.delete(ip);
      } else if (!record.banned && (now - record.firstAttempt) > 600000) {
        // Clear non-banned records older than 10 min
        this.failedAttempts.delete(ip);
      }
    }
  }

  // Clean expired registrations from MongoDB
  async _cleanExpiredRegistrations() {
    try {
      const extensions = await Extension.find({
        'registrations.0': { $exists: true }
      });

      for (const ext of extensions) {
        const before = ext.registrations.length;
        ext.registrations = ext.registrations.filter(r => r.expires > new Date());
        if (ext.registrations.length !== before) {
          await ext.save();
          if (ext.registrations.length === 0) {
            logger.debug(`Extension ${ext.extension} all registrations expired`);
          }
        }
      }
    } catch (err) {
      logger.error(`Error cleaning registrations: ${err.message}`);
    }
  }
}

module.exports = Registrar;
