const crypto = require('crypto');
const { Extension } = require('../models');
const logger = require('../utils/logger');
const sdpUtil = require('../utils/webrtc-sdp');

class Registrar {
  constructor(srf) {
    this.srf = srf;
    this.realm = process.env.SIP_DOMAIN || 'shadowpbx';
    this.nonceMap = new Map();      // nonce -> { created, extension }
    this.failedAttempts = new Map(); // ip (or ws:<ext> for WebSocket clients) -> { count, firstAttempt, banned }
    this.maxAttempts = parseInt(process.env.MAX_REGISTER_ATTEMPTS) || 5;
    this.banDuration = parseInt(process.env.REGISTER_BAN_DURATION) || 300; // seconds

    // In-memory contact cache: extension -> [{ ip, port, userAgent, expires, registeredAt }]
    // This avoids hitting MongoDB on every INVITE for contact lookups
    this.contactCache = new Map();
    this.securityTracker = null;  // set after construction
    this.guestManager = null;     // WebCallGuestManager — set after construction (Phase 2)

    // Clean expired nonces every 5 min
    setInterval(() => this._cleanNonces(), 300000);
    // Clean expired registrations every 10 sec (fast detection of offline devices)
    setInterval(() => this._cleanExpiredRegistrations(), 10000);
    // Clean expired bans every 60 sec
    setInterval(() => this._cleanBans(), 60000);
    // Rebuild cache from MongoDB on startup (after 2 sec delay for DB connect)
    setTimeout(() => this._rebuildCache(), 2000);
  }

  // ============================================================
  // REGISTER handler
  // ============================================================
  async handleRegister(req, res) {
    const from = req.getParsedHeader('From');
    const uri = from.uri;

    // Web-call guests (Phase 2) register as web-xxxxxx with a one-shot
    // token as their password. They are never stored in the Extension
    // collection, so they get their own short path here.
    const user = (uri.match(/sip:([^@;>]+)@/) || [])[1];
    if (this.guestManager && this.guestManager.isGuestUser(user)) {
      return this._handleGuestRegister(req, res, user);
    }

    const ext = uri.match(/sip:(\d+)@/)?.[1];

    if (!ext) {
      logger.warn(`REGISTER rejected: no extension in From header: ${uri}`);
      return res.send(400);
    }

    // Check if IP is banned
    // WebSocket (WebRTC) clients arrive through the nginx /ws proxy, so their
    // source address is 127.0.0.1 for EVERY browser. Banning that address
    // would lock out all web clients, so for proxied WS clients we track
    // failures per extension instead (see _banKey).
    const transport = sdpUtil.requestTransport(req);
    const banKey = this._banKey(req, ext, transport);
    if (this._isBanned(banKey)) {
      // Keep the "IP <addr>" wording — fail2ban's shadowpbx filter matches it
      if (banKey.startsWith('ws:')) logger.warn(`REGISTER blocked: WebSocket client for extension ${ext} is banned (brute force protection)`);
      else logger.warn(`REGISTER blocked: IP ${banKey} is banned (brute force protection)`);
      return res.send(403);
    }

    // Check if authorization header exists
    const authHeader = req.get('Authorization');

    if (!authHeader) {
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
      if (this.securityTracker) this.securityTracker.record(req.source_address, 'REGISTER unknown extension', req.get('User-Agent'), ext);
      return res.send(403);
    }

    // Verify credentials (digest auth)
    const valid = this._verifyDigest(authParams, extension.password, req.method);
    if (!valid) {
      this._recordFailure(banKey);
      logger.warn(`REGISTER rejected: bad credentials for ${ext} from ${req.source_address}${transport ? ' via ' + transport : ''}`);
      return this._challenge(res, ext);
    }

    // Successful auth - clear any failure tracking
    this.failedAttempts.delete(banKey);

    // Clean up used nonce
    this.nonceMap.delete(authParams.nonce);

    // Get contact and expires
    const contact = req.get('Contact');
    const expiresHeader = req.get('Expires');
    let expires = parseInt(expiresHeader) || 3600;

    // Cap max expires to 300s — forces frequent re-registration
    // so offline devices are detected within 5 minutes
    const maxExpires = parseInt(process.env.MAX_REGISTRATION_EXPIRES) || 300;
    if (expires > maxExpires) expires = maxExpires;

    // Unregister (expires = 0)
    if (expires === 0 || contact === '*') {
      extension.registrations = [];
      await extension.save();
      this.contactCache.delete(ext);
      logger.info(`Extension ${ext} (${extension.name}) unregistered`);
      return res.send(200, { headers: { 'Expires': '0' } });
    }

    // Extract source info
    const sourceIp = req.source_address;
    const sourcePort = req.source_port;
    const ua = req.get('User-Agent') || 'unknown';
    const source = `${sourceIp}:${sourcePort}`;

    // Extract the Contact URI — this is the device's unique identity
    // Contact header looks like: <sip:2002@192.168.1.5:8255;transport=udp>
    // The local IP:port inside is unique per device, even behind shared NAT
    const contactUri = this._extractContactUri(contact);

    // Build new registration
    // Transport + WebRTC detection (Phase 1 — WebRTC)
    // Browsers (SIP.js / JsSIP) register over WS/WSS; their media is
    // DTLS-SRTP + ICE and must be bridged by RTPEngine.
    const regTransport = transport || sdpUtil.contactTransport(contact) || 'udp';
    const isWebRTC = sdpUtil.isWebSocketTransport(regTransport) ||
      sdpUtil.isWebSocketTransport(sdpUtil.contactTransport(contact));

    const regData = {
      contact: contact,
      contactUri: contactUri,  // stored for dedup matching
      ip: sourceIp,
      port: sourcePort,
      transport: regTransport,
      webrtc: isWebRTC,
      userAgent: ua,
      expires: new Date(Date.now() + expires * 1000),
      registeredAt: new Date()
    };

    // ============================================================
    // NAT-AWARE DEDUPLICATION using Contact URI
    //
    // The Contact header contains the device's LOCAL address, e.g.:
    //   <sip:2002@192.168.1.5:8255>
    //
    // This local address is UNIQUE PER DEVICE:
    //   - Same device, new NAT port → same Contact URI → REPLACE
    //   - Device A (192.168.1.5) + Device B (192.168.1.100) on
    //     same public IP → different Contact URIs → KEEP BOTH
    //   - Same device, same softphone → same Contact URI → REPLACE
    //
    // This correctly handles:
    //   ✓ Same device re-registering (NAT port change) — replaced
    //   ✓ Two different PCs behind same NAT — kept separate
    //   ✓ Same PC, two different softphones — kept separate
    //     (different local ports in Contact URI)
    // ============================================================

    extension.registrations = extension.registrations.filter(r => {
      // Remove registration with same Contact URI (same device re-registering)
      if (r.contactUri && contactUri && r.contactUri === contactUri) {
        return false;
      }
      // Fallback: if no contactUri stored (old data), match by IP + UA
      if (!r.contactUri && r.ip === sourceIp && this._normalizeUA(r.userAgent) === this._normalizeUA(ua)) {
        return false;
      }
      // Remove expired ones while we're at it
      if (r.expires <= new Date()) {
        return false;
      }
      return true;
    });

    // Enforce max contacts (for genuinely different devices)
    if (extension.registrations.length >= extension.maxContacts) {
      // Remove the oldest registration
      extension.registrations.sort((a, b) => new Date(a.registeredAt) - new Date(b.registeredAt));
      extension.registrations.shift();
    }

    extension.registrations.push(regData);
    extension.updatedAt = new Date();
    await extension.save();

    // Update in-memory cache
    this._updateCache(ext, extension.registrations);

    logger.info(`Extension ${ext} (${extension.name}) registered from ${source}${isWebRTC ? ' (WebRTC/' + regTransport + ')' : ''} [${ua}] expires=${expires}s contacts=${extension.registrations.length}`);

    res.send(200, {
      headers: {
        'Contact': contact,
        'Expires': String(expires)
      }
    });
  }

  // ============================================================
  // Guest REGISTER (Web Dialer Phase 2)
  //
  // Registration is optional for web callers — SIP.js can send an
  // INVITE straight away — but accepting it keeps the widget simple
  // and lets the browser learn early that its token is valid.
  // Nothing is written to MongoDB and no contact is cached: the guest
  // is reachable only on the WebSocket it dialled in on.
  // ============================================================
  async _handleGuestRegister(req, res, username) {
    const gm = this.guestManager;
    const transport = sdpUtil.requestTransport(req);

    if (!sdpUtil.isWebSocketTransport(transport)) {
      logger.warn(`WEBCALL: REGISTER for guest ${username} over ${transport || 'unknown'} — only WS/WSS is allowed`);
      return res.send(403);
    }

    const guest = gm.get(username);
    if (!guest) {
      logger.warn(`WEBCALL: REGISTER rejected: unknown or expired guest ${username} from ${req.source_address}`);
      return res.send(403);
    }

    const authHeader = req.get('Authorization');
    if (!authHeader) return gm.challenge(res, username);

    const authParams = this._parseAuthHeader(authHeader);
    const check = gm.verify(username, authParams, req.method);
    if (!check.ok) {
      logger.warn(`WEBCALL: REGISTER rejected for guest ${username}: ${check.reason}`);
      if (check.reason === 'bad credentials' && this.securityTracker) {
        this.securityTracker.record(req.source_address, 'Web-call guest bad credentials', req.get('User-Agent'), username);
      }
      return gm.challenge(res, username);
    }

    const contact = req.get('Contact');
    let expires = parseInt(req.get('Expires'));
    if (isNaN(expires)) expires = 300;

    if (expires === 0 || contact === '*') {
      gm.destroy(username, 'unregistered');
      return res.send(200, { headers: { 'Expires': '0' } });
    }

    // Never outlive the token / call cap
    const left = Math.max(30, Math.round((guest.expiresAt - Date.now()) / 1000));
    expires = Math.min(expires, 300, left);

    gm.markRegistered(username, { contact, transport });
    logger.info(`WEBCALL: guest ${username} registered (widget ${guest.widgetId}) via ${transport} expires=${expires}s`);

    res.send(200, { headers: { 'Contact': contact, 'Expires': String(expires) } });
  }

  // ============================================================
  // Contact lookup (used by call-handler and ring-group)
  // ============================================================

  // Get active contacts for an extension, sorted newest-first
  async getContacts(ext) {
    // Try in-memory cache first
    const cached = this.contactCache.get(ext);
    if (cached && cached.length > 0) {
      // Filter expired and return
      const now = new Date();
      const active = cached.filter(c => c.expires > now);
      if (active.length > 0) {
        return active;
      }
      // All cached contacts expired — fall through to DB
    }

    // Cache miss or all expired — fetch from MongoDB
    const extension = await Extension.findOne({ extension: ext, enabled: true });
    if (!extension) return [];

    const active = extension.getActiveContacts();

    // Update cache
    this._updateCache(ext, active);

    return active;
  }

  // Check if extension is registered
  async isRegistered(ext) {
    const contacts = await this.getContacts(ext);
    return contacts.length > 0;
  }

  // Anti-spoofing (toll-fraud defence): is this extension registered from the
  // given source IP? An INVITE claiming From: <ext> must actually originate
  // from where that extension registered. Without this, an attacker can send
  // INVITEs with a spoofed From header and place outbound calls as any valid
  // extension number — exactly the International Revenue Share Fraud pattern.
  //
  // Loopback is always trusted (internally-generated calls: IVR, dialer,
  // click-to-call). WebRTC contacts all share the proxy's loopback address, so
  // a browser-registered extension is matched on being a WebRTC contact rather
  // than on IP.
  async isRegisteredFrom(ext, sourceIp) {
    if (!sourceIp) return false;
    if (sourceIp === '127.0.0.1' || sourceIp === '::1' || sourceIp === '::ffff:127.0.0.1') return true;
    const contacts = await this.getContacts(ext);
    if (contacts.length === 0) return false;
    return contacts.some(c => c.ip === sourceIp || c.webrtc === true ||
      c.ip === '127.0.0.1' || c.ip === '::ffff:127.0.0.1');
  }

  // Synchronous contact lookup from in-memory cache only (for dashboard)
  getContactsSync(ext) {
    const cached = this.contactCache.get(ext);
    if (!cached || cached.length === 0) return [];
    const now = new Date();
    return cached.filter(c => c.expires > now);
  }

  // ============================================================
  // User-Agent normalization
  //
  // Different registrations from the same softphone may have
  // slightly different UA strings (version changes, etc).
  // We normalize to a fingerprint for dedup purposes.
  // ============================================================
  _normalizeUA(ua) {
    if (!ua) return 'unknown';
    const base = ua.split(/[\s\/]/)[0].toLowerCase().trim();
    return base || 'unknown';
  }

  // ============================================================
  // Contact URI extraction
  //
  // The Contact header contains the device's local SIP URI:
  //   <sip:2002@192.168.1.5:8255;transport=udp>
  //
  // We extract the URI inside the angle brackets. This is the
  // unique device identity — it stays the same across NAT port
  // changes, but is different for each physical device.
  //
  // Scenarios:
  //   Same PC, MicroSIP re-registers:
  //     Contact: <sip:2002@192.168.1.5:8255> (same each time)
  //     → replaces old entry
  //
  //   PC-A and PC-B behind same router:
  //     PC-A: <sip:2002@192.168.1.5:8255>
  //     PC-B: <sip:2002@192.168.1.100:6500>
  //     → two separate entries, both ring
  //
  //   Same PC, MicroSIP + X-Lite:
  //     MicroSIP: <sip:2002@192.168.1.5:8255>
  //     X-Lite:   <sip:2002@192.168.1.5:5060>
  //     → two separate entries (different local ports)
  // ============================================================
  _extractContactUri(contactHeader) {
    if (!contactHeader) return null;
    // Extract URI from angle brackets: <sip:user@host:port;params>
    const match = contactHeader.match(/<([^>]+)>/);
    if (match) return match[1];
    // No angle brackets — try the raw value (strip params after ;)
    const clean = contactHeader.split(';')[0].trim();
    return clean || null;
  }

  // ============================================================
  // In-memory cache management
  // ============================================================
  _updateCache(ext, registrations) {
    if (!registrations || registrations.length === 0) {
      this.contactCache.delete(ext);
      return;
    }

    // Store sorted newest-first so contacts[0] is always the best
    const contacts = registrations
      .map(r => ({
        ip: r.ip,
        port: r.port,
        transport: r.transport || 'udp',
        webrtc: !!r.webrtc,
        userAgent: r.userAgent,
        expires: r.expires instanceof Date ? r.expires : new Date(r.expires),
        registeredAt: r.registeredAt instanceof Date ? r.registeredAt : new Date(r.registeredAt)
      }))
      .filter(c => c.expires > new Date())
      .sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime());

    if (contacts.length > 0) {
      this.contactCache.set(ext, contacts);
    } else {
      this.contactCache.delete(ext);
    }
  }

  async _rebuildCache() {
    try {
      const extensions = await Extension.find({
        'registrations.0': { $exists: true },
        enabled: true
      });
      let count = 0;
      for (const ext of extensions) {
        const active = ext.getActiveContacts();
        if (active.length > 0) {
          this._updateCache(ext.extension, active);
          count++;
        }
      }
      if (count > 0) {
        logger.info(`Contact cache rebuilt: ${count} extension(s) with active registrations`);
      }
    } catch (err) {
      logger.error(`Cache rebuild error: ${err.message}`);
    }
  }

  // ============================================================
  // Auth helpers
  // ============================================================

  _challenge(res, ext) {
    const nonce = crypto.randomBytes(16).toString('hex');
    this.nonceMap.set(nonce, { created: Date.now(), extension: ext });

    res.send(401, {
      headers: {
        'WWW-Authenticate': `Digest realm="${this.realm}", nonce="${nonce}", algorithm=MD5, qop="auth"`
      }
    });
  }

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

  // ============================================================
  // Cleanup tasks
  // ============================================================

  _cleanNonces() {
    const cutoff = Date.now() - 300000;
    for (const [nonce, data] of this.nonceMap) {
      if (data.created < cutoff) this.nonceMap.delete(nonce);
    }
  }

  // ============================================================
  // WebRTC helpers (Phase 1)
  // ============================================================

  // Key used for brute-force tracking. Proxied WebSocket clients all share
  // the proxy's loopback address, so they are tracked per extension.
  _banKey(req, ext, transport) {
    const ip = req.source_address;
    const t = transport || sdpUtil.requestTransport(req);
    if (sdpUtil.isLoopback(ip) && sdpUtil.isWebSocketTransport(t)) return `ws:${ext}`;
    return ip;
  }

  // True if this registration/contact is a browser (WebRTC) endpoint.
  isWebRTCContact(contact) {
    if (!contact) return false;
    if (contact.webrtc) return true;
    return sdpUtil.isWebSocketTransport(contact.transport) ||
      sdpUtil.isWebSocketTransport(sdpUtil.contactTransport(contact.contact));
  }

  // Build the request-URI used to reach a contact, plus its media type.
  //   SIP phone : sip:1001@1.2.3.4:5060                 media=sip
  //   Browser   : sip:1001@127.0.0.1:41822;transport=ws  media=webrtc
  // For browsers, drachtio re-uses the existing WebSocket connection
  // (via the nginx /ws proxy) that the REGISTER arrived on.
  contactTarget(ext, contact) {
    if (!contact) return null;
    const webrtc = this.isWebRTCContact(contact);
    let uri = `sip:${ext}@${contact.ip}:${contact.port}`;
    if (webrtc) {
      const t = sdpUtil.normalizeTransport(contact.transport);
      uri += `;transport=${t === 'wss' ? 'wss' : 'ws'}`;
    }
    return { uri, media: webrtc ? 'webrtc' : 'sip', webrtc };
  }

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
        this.failedAttempts.delete(ip);
      }
    }
  }

  // Clean expired registrations from MongoDB and update cache
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
          // Update cache
          this._updateCache(ext.extension, ext.registrations);
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
