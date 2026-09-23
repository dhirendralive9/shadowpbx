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
// Phase 7 — abuse prevention
const RATE_PER_WIDGET = parseInt(process.env.WEBCALL_TOKENS_PER_WIDGET) || 60;   // per widget, per window
const ABUSE_BLOCK_AFTER = parseInt(process.env.WEBCALL_ABUSE_BLOCK_AFTER) || 0;  // 0 = report only, never block
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';

class WebCallGuestManager {
  constructor() {
    this.guests = new Map();        // username -> guest record
    this.byCallId = new Map();      // SIP Call-ID -> username
    this.rate = new Map();          // ip -> { count, windowStart }
    this.widgetRate = new Map();    // widgetId -> { count, windowStart }
    this.abuse = new Map();         // ip -> consecutive refusals (Phase 7)
    this.blockedIps = new Set();    // already handed to the firewall — don't repeat
    this.timeConditionService = null;  // set in app.js — widget business hours
    this.realm = process.env.SIP_DOMAIN || 'shadowpbx';
    this.nonces = new Map();        // nonce -> { created, username }
    this.securityTracker = null;    // set after construction
    // Optional async (callId) => boolean, wired in app.js. IVR, queue and
    // voicemail own their own dialogs, so for those we ask whether the call
    // has finished instead of waiting for a destroy handler (Phase 3).
    this.callEndedCheck = null;
    this.stats = { issued: 0, registered: 0, calls: 0, rejected: 0, expired: 0, captchaFailures: 0, closedHours: 0, blocked: 0 };

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
  async issueToken({ widgetId, ip, origin, userAgent, pageUrl, name, number, captchaToken }) {
    if (!ENABLED) return { ok: false, status: 503, error: 'Web calling is disabled' };
    if (!widgetId) return { ok: false, status: 400, error: 'widgetId required' };

    if (!this._rateOk(ip)) {
      this._refused(ip, userAgent, 'Web-call token flood', widgetId);
      return { ok: false, status: 429, error: 'Too many requests' };
    }
    if (!this._widgetRateOk(widgetId)) {
      this._refused(ip, userAgent, 'Web-call widget flood', widgetId);
      logger.warn(`WEBCALL: widget ${widgetId} is over its request rate`);
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

    // Optional CAPTCHA (Phase 7). Off unless the widget asks for it AND a
    // Turnstile secret is configured — it is never required by default.
    if (this.captchaRequired(widget)) {
      const passed = await this.verifyCaptcha(captchaToken, ip);
      if (!passed) {
        this.stats.captchaFailures++;
        this._refused(ip, userAgent, 'Web-call CAPTCHA failed', widgetId);
        return { ok: false, status: 403, error: 'Please complete the challenge and try again', captcha: true };
      }
    }

    // Business hours — only refuse when the widget is set to turn callers away;
    // the default routes closed-hours calls to the time condition's own
    // no-match destination (voicemail, an after-hours group, and so on).
    const hours = widget.businessHours || {};
    if (hours.enabled && hours.closedAction === 'message' && hours.timeConditionNumber) {
      const open = await this.isOpen(hours.timeConditionNumber);
      if (open === false) {
        this.stats.closedHours++;
        logger.info(`WEBCALL: widget ${widgetId} is outside business hours`);
        return {
          ok: false, status: 503, closed: true,
          error: hours.closedMessage || 'We are closed right now. Please try again during business hours.'
        };
      }
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
      captcha: !!widget.captcha,
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

  // ============================================================
  // Abuse prevention (Phase 7)
  // ============================================================

  captchaRequired(widget) {
    return !!(widget && widget.captcha && TURNSTILE_SECRET);
  }

  /** Site key a widget should render, or '' when no challenge is needed. */
  captchaSiteKey(widget) {
    return this.captchaRequired(widget) ? TURNSTILE_SITE_KEY : '';
  }

  /** Verify a Cloudflare Turnstile response token. */
  async verifyCaptcha(token, ip) {
    if (!TURNSTILE_SECRET) return true;      // not configured — nothing to check
    if (!token) return false;
    try {
      const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
      if (ip) body.append('remoteip', ip);
      const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const d = await r.json();
      return d.success === true;
    } catch (e) {
      logger.warn(`WEBCALL: CAPTCHA verification failed to reach Cloudflare: ${e.message}`);
      return false;   // fail closed: a widget that asked for a challenge keeps it
    }
  }

  /** Is this time condition currently matching? null when it can't be evaluated. */
  async isOpen(timeConditionNumber) {
    if (!this.timeConditionService || !timeConditionNumber) return null;
    try {
      const result = await this.timeConditionService.evaluate(timeConditionNumber);
      return result ? !!result.matched : null;
    } catch (e) {
      logger.warn(`WEBCALL: business-hours check failed: ${e.message}`);
      return null;
    }
  }

  /**
   * One refused request. Repeat offenders are reported to the security
   * tracker and, if WEBCALL_ABUSE_BLOCK_AFTER is set, blocked at the firewall
   * — the same mechanism the SIP attack monitor uses.
   */
  _refused(ip, userAgent, reason, widgetId) {
    this.stats.rejected++;
    if (!ip) return;
    const n = (this.abuse.get(ip) || 0) + 1;
    this.abuse.set(ip, n);
    logger.warn(`WEBCALL: ${reason} from ${ip} (widget ${widgetId}, ${n} refusals)`);
    if (this.securityTracker) {
      try { this.securityTracker.record(ip, reason, userAgent, widgetId); } catch (e) {}
      if (ABUSE_BLOCK_AFTER > 0 && n >= ABUSE_BLOCK_AFTER && this.securityTracker.blockIp && !this.blockedIps.has(ip)) {
        this.blockedIps.add(ip);
        this.stats.blocked++;
        logger.warn(`WEBCALL: blocking ${ip} after ${n} refused web-call requests`);
        Promise.resolve(this.securityTracker.blockIp(ip)).catch(() => {});
        this.abuse.delete(ip);
      }
    }
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
      tokensPerWidget: `${RATE_PER_WIDGET} / ${RATE_WINDOW}s`,
      captchaAvailable: !!TURNSTILE_SECRET,
      autoBlockAfter: ABUSE_BLOCK_AFTER || 'off',
      watchedIps: this.abuse.size,
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
    // Forget quiet offenders and stale rate windows
    const stale = Date.now() - RATE_WINDOW * 1000 * 2;
    for (const [ip, rec] of this.rate) if (rec.windowStart < stale) { this.rate.delete(ip); this.abuse.delete(ip); }
    for (const [id, rec] of this.widgetRate) if (rec.windowStart < stale) this.widgetRate.delete(id);
  }

  _rateOk(ip) {
    return this._windowOk(this.rate, ip, RATE_PER_IP);
  }

  _widgetRateOk(widgetId) {
    return this._windowOk(this.widgetRate, widgetId, RATE_PER_WIDGET);
  }

  _windowOk(map, key, limit) {
    if (!key) return true;
    const now = Date.now();
    const rec = map.get(key);
    if (!rec || now - rec.windowStart > RATE_WINDOW * 1000) {
      map.set(key, { count: 1, windowStart: now });
      return true;
    }
    rec.count++;
    return rec.count <= limit;
  }
}

module.exports = WebCallGuestManager;
module.exports.GUEST_PREFIX = GUEST_PREFIX;
