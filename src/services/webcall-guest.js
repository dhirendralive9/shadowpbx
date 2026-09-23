const crypto = require('crypto');
const logger = require('../utils/logger');
const { WebCallWidget } = require('../models');

// ============================================================
// Web-call guest identities (Web Dialer — Phase 2)
//
// A website visitor has no extension. Each web call gets a
// short-lived guest identity that exists only for that call:
//
//   1. Widget calls POST /api/webcall/token (public, rate-limited)
//   2. We mint  username = web-8f3a2c  +  secret (the SIP password)
//      bound to one widget, one origin and one IP
//   3. The browser authenticates its REGISTER/INVITE with those
//      credentials over WSS — digest auth, exactly like a phone
//   4. The token is single-use: once a call is placed it can't start
//      another. Unused tokens expire after WEBCALL_TOKEN_TTL seconds
//   5. On hangup (or when the call cap is hit) the identity is destroyed
//
// Guests are NEVER written to the Extension collection, so they add no
// registrations, no BLF/presence noise and no cleanup work. They are
// also structurally incapable of dialling anything except their own
// widget's destination — see authorizeDestination() — which is what
// keeps toll fraud off the table.
//
// All state is in memory: these identities live for one call and must
// not survive a restart.
// ============================================================

const GUEST_PREFIX = 'web-';
const ENABLED = String(process.env.WEBCALL_ENABLED || 'true').toLowerCase() !== 'false';
const TOKEN_TTL = parseInt(process.env.WEBCALL_TOKEN_TTL) || 60;                 // seconds before an unused token dies
const MAX_CALL_MIN = parseInt(process.env.WEBCALL_MAX_CALL_MINUTES) || 60;       // hard cap on one web call
const RATE_PER_IP = parseInt(process.env.WEBCALL_TOKENS_PER_IP) || 10;           // token requests per window
const RATE_WINDOW = parseInt(process.env.WEBCALL_RATE_WINDOW) || 600;            // seconds
const DEFAULT_MAX_CONCURRENT = parseInt(process.env.WEBCALL_MAX_CONCURRENT) || 10;

class WebCallGuestManager {
  constructor() {
    this.guests = new Map();        // username -> guest record
    this.byCallId = new Map();      // SIP Call-ID -> username
    this.rate = new Map();          // ip -> { count, windowStart }
    this.realm = process.env.SIP_DOMAIN || 'shadowpbx';
    this.nonces = new Map();        // nonce -> { created, username }
    this.securityTracker = null;    // set after construction
    // Optional async (callId) => boolean, wired in app.js. IVR, queue and
    // voicemail own their own dialogs, so for those we ask whether the call
    // has finished instead of waiting for a destroy handler (Phase 3).
    this.callEndedCheck = null;
    this.stats = { issued: 0, registered: 0, calls: 0, rejected: 0, expired: 0 };

    const t1 = setInterval(() => { this._sweep().catch(() => {}); }, 15000);
    const t2 = setInterval(() => this._sweepNonces(), 300000);
    if (t1.unref) t1.unref();
    if (t2.unref) t2.unref();
  }

  get enabled() { return ENABLED; }

  isGuestUser(user) {
    return typeof user === 'string' && user.startsWith(GUEST_PREFIX);
  }

  get(username) {
    const g = this.guests.get(username);
    if (!g) return null;
    if (this._isDead(g)) { this._destroy(username, 'expired'); return null; }
    return g;
  }

  // ============================================================
  // Token issuing
  // ============================================================

  /**
   * Issue a single-use guest credential for a widget.
   * @returns {Promise<{ok:boolean, status?:number, error?:string, guest?:object}>}
   */
  async issueToken({ widgetId, ip, origin, userAgent, pageUrl, name, number }) {
    if (!ENABLED) return { ok: false, status: 503, error: 'Web calling is disabled' };
    if (!widgetId) return { ok: false, status: 400, error: 'widgetId required' };

    if (!this._rateOk(ip)) {
      this.stats.rejected++;
      logger.warn(`WEBCALL: token rate limit hit by ${ip} for widget ${widgetId}`);
      if (this.securityTracker) this.securityTracker.record(ip, 'Web-call token flood', userAgent, widgetId);
      return { ok: false, status: 429, error: 'Too many requests' };
    }

    let widget;
    try {
      widget = await WebCallWidget.findOne({ widgetId, enabled: true }).lean();
    } catch (e) {
      return { ok: false, status: 500, error: 'Widget lookup failed' };
    }
    if (!widget) {
      this.stats.rejected++;
      return { ok: false, status: 404, error: 'Unknown or disabled widget' };
    }

    if (!this.originAllowed(widget, origin)) {
      this.stats.rejected++;
      logger.warn(`WEBCALL: origin ${origin || '(none)'} not allowed for widget ${widgetId}`);
      return { ok: false, status: 403, error: 'This site is not allowed to use this widget' };
    }

    const max = widget.maxConcurrent || DEFAULT_MAX_CONCURRENT;
    if (this.activeCount(widgetId) >= max) {
      this.stats.rejected++;
      logger.warn(`WEBCALL: widget ${widgetId} at capacity (${max} concurrent)`);
      return { ok: false, status: 503, error: 'All lines are busy, please try again shortly' };
    }

    const username = GUEST_PREFIX + crypto.randomBytes(3).toString('hex');
    const secret = crypto.randomBytes(24).toString('hex');
    const now = Date.now();
    const guest = {
      username,
      secret,
      widgetId,
      widgetName: widget.name || widgetId,
      destination: widget.destination || {},
      businessHours: widget.businessHours || { enabled: false },
      collectInfo: widget.collectInfo || 'none',
      crmCreateLead: !!widget.crmCreateLead,
      state: 'issued',                       // issued -> registered -> in-call -> ended
      createdAt: now,
      expiresAt: now + TOKEN_TTL * 1000,     // only until a call starts
      callId: null,
      callStartedAt: null,
      ip,
      origin: origin || '',
      pageUrl: pageUrl || '',
      userAgent: userAgent || '',
      // Pre-call form data — used by Phase 6 (screen pop / CDR / CRM)
      callerName: (name || '').toString().slice(0, 80),
      callerNumber: (number || '').toString().slice(0, 40)
    };

    this.guests.set(username, guest);
    this.stats.issued++;
    logger.info(`WEBCALL: issued guest ${username} for widget ${widgetId} (${guest.widgetName}) from ${ip} origin=${origin || 'n/a'} ttl=${TOKEN_TTL}s`);
    return { ok: true, guest, ttl: TOKEN_TTL };
  }

  /** Origin/Referer check against the widget's allowedDomains. */
  originAllowed(widget, origin) {
    const list = (widget.allowedDomains || []).map(d => String(d).trim().toLowerCase()).filter(Boolean);
    if (list.length === 0) return true;          // not restricted yet (Phase 5/7 tighten this)
    if (!origin) return false;
    let host;
    try { host = new URL(origin).hostname.toLowerCase(); } catch (e) { host = String(origin).toLowerCase(); }
    return list.some(d => {
      const dom = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (dom === '*') return true;
      if (dom.startsWith('*.')) return host === dom.slice(2) || host.endsWith(dom.slice(1));
      return host === dom;
    });
  }

  // ============================================================
  // SIP authentication (digest, with the token as the password)
  // ============================================================

  challenge(res, username, status) {
    const nonce = crypto.randomBytes(16).toString('hex');
    this.nonces.set(nonce, { created: Date.now(), username });
    const header = status === 407 ? 'Proxy-Authenticate' : 'WWW-Authenticate';
    res.send(status || 401, {
      headers: { [header]: `Digest realm="${this.realm}", nonce="${nonce}", algorithm=MD5, qop="auth"` }
    });
  }

  /**
   * Verify a digest Authorization header for a guest.
   * @returns {{ok:boolean, guest?:object, reason?:string}}
   */
  verify(username, authParams, method) {
    const guest = this.get(username);
    if (!guest) return { ok: false, reason: 'unknown or expired guest' };
    if (!authParams) return { ok: false, reason: 'no credentials' };
    if (!this.nonces.has(authParams.nonce)) return { ok: false, reason: 'stale nonce' };
    if (authParams.username !== username) return { ok: false, reason: 'username mismatch' };

    const { realm, nonce, uri, response, qop, nc, cnonce } = authParams;
    const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${guest.secret}`).digest('hex');
    const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
    const expected = qop === 'auth'
      ? crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex')
      : crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');

    if (expected !== response) return { ok: false, reason: 'bad credentials' };
    this.nonces.delete(nonce);
    return { ok: true, guest };
  }

  /** A guest REGISTER succeeded — note it, but store nothing in MongoDB. */
  markRegistered(username, info) {
    const g = this.get(username);
    if (!g) return null;
    if (g.state === 'issued') g.state = 'registered';
    g.registeredAt = Date.now();
    g.contact = info && info.contact;
    g.transport = info && info.transport;
    this.stats.registered++;
    return g;
  }

  // ============================================================
  // Destination lockdown
  //
  // A guest may ONLY reach the destination configured on its widget.
  // Never a trunk, never another extension, never a feature code.
  // ============================================================

  authorizeDestination(guest, requestedUser) {
    const dest = guest.destination || {};
    if (!dest.type || !dest.target) return { allowed: false, reason: 'widget has no destination configured' };

    // The widget dials its own destination, so the request-URI user should
    // equal the target. Accept the widget id too — the browser may address
    // the widget rather than the internal target it maps to.
    const asked = String(requestedUser || '');
    if (asked !== String(dest.target) && asked !== guest.widgetId) {
      return { allowed: false, reason: `guest may only reach ${dest.type}:${dest.target}, tried ${asked}` };
    }
    return { allowed: true, destination: dest };
  }

  // ============================================================
  // Call lifecycle
  // ============================================================

  /** Bind a guest to one call. Single-use: a second call is refused. */
  bindCall(username, callId) {
    const g = this.get(username);
    if (!g) return { ok: false, reason: 'unknown or expired guest' };
    if (g.callId && g.callId !== callId) return { ok: false, reason: 'token already used for another call' };

    g.callId = callId;
    g.state = 'in-call';
    g.callStartedAt = g.callStartedAt || Date.now();
    g.expiresAt = Date.now() + MAX_CALL_MIN * 60 * 1000;   // now bounded by the call cap, not the token TTL
    this.byCallId.set(callId, username);
    this.stats.calls++;
    logger.info(`WEBCALL: guest ${username} bound to call ${callId} (widget ${g.widgetId})`);
    return { ok: true, guest: g };
  }

  byCall(callId) {
    const username = this.byCallId.get(callId);
    return username ? this.get(username) : null;
  }

  /** Call ended — destroy the identity. */
  endCall(callId, reason) {
    const username = this.byCallId.get(callId);
    if (!username) return;
    this._destroy(username, reason || 'call ended');
  }

  destroy(username, reason) { this._destroy(username, reason || 'destroyed'); }

  activeCount(widgetId) {
    let n = 0;
    for (const [, g] of this.guests) {
      if ((!widgetId || g.widgetId === widgetId) && !this._isDead(g)) n++;
    }
    return n;
  }

  list() {
    const now = Date.now();
    const out = [];
    for (const [, g] of this.guests) {
      out.push({
        username: g.username,
        widgetId: g.widgetId,
        widgetName: g.widgetName,
        state: g.state,
        destination: g.destination,
        ip: g.ip,
        origin: g.origin,
        callId: g.callId,
        ageSeconds: Math.round((now - g.createdAt) / 1000),
        expiresInSeconds: Math.max(0, Math.round((g.expiresAt - now) / 1000))
      });
    }
    return out.sort((a, b) => a.ageSeconds - b.ageSeconds);
  }

  summary() {
    return {
      enabled: ENABLED,
      tokenTtlSeconds: TOKEN_TTL,
      maxCallMinutes: MAX_CALL_MIN,
      tokensPerIp: `${RATE_PER_IP} / ${RATE_WINDOW}s`,
      active: this.activeCount(),
      inCall: this.list().filter(g => g.state === 'in-call').length,
      ...this.stats
    };
  }

  // ============================================================
  // Internals
  // ============================================================

  _isDead(g) {
    return g.state === 'ended' || Date.now() > g.expiresAt;
  }

  _destroy(username, reason) {
    const g = this.guests.get(username);
    if (!g) return;
    g.state = 'ended';
    if (g.callId) this.byCallId.delete(g.callId);
    this.guests.delete(username);
    logger.info(`WEBCALL: guest ${username} destroyed (${reason})`);
  }

  async _sweep() {
    const now = Date.now();

    // Reclaim identities whose call has ended inside another handler
    if (this.callEndedCheck) {
      for (const [username, g] of this.guests) {
        if (g.state !== 'in-call' || !g.callId) continue;
        if (now - g.callStartedAt < 30000) continue;   // give the call time to appear
        try {
          if (await this.callEndedCheck(g.callId)) this._destroy(username, 'call ended');
        } catch (e) { /* checked again on the next sweep */ }
      }
    }

    for (const [username, g] of this.guests) {
      if (now > g.expiresAt) {
        if (g.state === 'in-call') logger.warn(`WEBCALL: guest ${username} hit the ${MAX_CALL_MIN} minute call cap`);
        else this.stats.expired++;
        this._destroy(username, g.state === 'in-call' ? 'call cap reached' : 'token expired unused');
      }
    }
  }

  _sweepNonces() {
    const cutoff = Date.now() - 600000;
    for (const [n, rec] of this.nonces) if (rec.created < cutoff) this.nonces.delete(n);
  }

  _rateOk(ip) {
    if (!ip) return true;
    const now = Date.now();
    const rec = this.rate.get(ip);
    if (!rec || now - rec.windowStart > RATE_WINDOW * 1000) {
      this.rate.set(ip, { count: 1, windowStart: now });
      return true;
    }
    rec.count++;
    return rec.count <= RATE_PER_IP;
  }
}

module.exports = WebCallGuestManager;
module.exports.GUEST_PREFIX = GUEST_PREFIX;
