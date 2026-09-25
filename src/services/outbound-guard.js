const logger = require('../utils/logger');

// ============================================================
// Outbound destination guard (toll-fraud defence)
//
// A dial plan that matches "any international number" is the second half of
// every toll-fraud incident: once an attacker gets a call accepted, an
// open plan lets them reach the expensive destinations they profit from
// (Central African Republic, satellite/premium 88x ranges, and so on).
//
// This is a hard gate applied to EVERY outbound call — dialled, click-to-call
// and dialer alike — independent of the route patterns. It fails safe: if
// nothing is configured it does nothing (preserving current behaviour), but
// once an allow-list is set, only those country codes can be dialled.
//
// Config (env, or SystemSettings.outboundPolicy overriding it):
//   OUTBOUND_ALLOWED_PREFIXES  comma-separated dial prefixes that ARE allowed
//                              e.g. "1,44,49"  (US/Canada, UK, Germany)
//                              empty = allow all (subject to the block-list)
//   OUTBOUND_BLOCKED_PREFIXES  always-blocked prefixes, applied even when the
//                              allow-list is empty. Defaults to the highest-risk
//                              premium/satellite ranges below.
//   OUTBOUND_MAX_LENGTH        reject absurdly long numbers (default 15, E.164 max)
//
// Prefixes are matched against the number AFTER any leading + is stripped,
// longest-match-wins, so "1809" (Dominican Republic, a common fraud target)
// can be blocked without blocking "1" (US/Canada).
// ============================================================

// High-risk ranges blocked by default even with no allow-list configured.
// These are almost never legitimate business destinations and are the ranges
// that showed up in the incident.
const DEFAULT_BLOCKED = [
  '870',   // Inmarsat satellite
  '871', '872', '873', '874',  // retired Inmarsat, still routable on some carriers
  '881',   // Global Mobile Satellite (Iridium, etc.)
  '882', '883',  // International Networks (premium)
  '979',   // International Premium Rate Service
  '236',   // Central African Republic (the incident's top target)
  '239',   // São Tomé
  '247',   // Ascension
  '252',   // Somalia
  '253',   // Djibouti
  '257',   // Burundi
  '290',   // Saint Helena
  '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '690',  // Pacific island premium
  '1809', '1829', '1849',  // Dominican Republic (frequent fraud target)
  '1900',  // US premium rate
  '900'    // premium rate (various)
];

function parseList(envVal, fallback) {
  const raw = (envVal || '').split(',').map(s => s.trim()).filter(Boolean);
  return raw.length ? raw : (fallback || []);
}

class OutboundGuard {
  constructor(settings) {
    this.settings = settings || null;   // optional SystemSettings model for live overrides
    this._reload();
  }

  _reload() {
    this.allowed = parseList(process.env.OUTBOUND_ALLOWED_PREFIXES, []);
    this.blocked = parseList(process.env.OUTBOUND_BLOCKED_PREFIXES, DEFAULT_BLOCKED);
    this.maxLength = parseInt(process.env.OUTBOUND_MAX_LENGTH) || 15;
  }

  // Live overrides from SystemSettings.outboundPolicy, if present. Falls back
  // to env. Cheap enough to call per-decision; the settings doc is cached by
  // Mongoose, and any read failure leaves the env config in place.
  async _policy() {
    if (!this.settings) return { allowed: this.allowed, blocked: this.blocked, maxLength: this.maxLength };
    try {
      const doc = await this.settings.findOne({}, 'outboundPolicy').lean();
      const p = doc && doc.outboundPolicy;
      if (p) {
        return {
          allowed: (p.allowedPrefixes && p.allowedPrefixes.length) ? p.allowedPrefixes : this.allowed,
          blocked: (p.blockedPrefixes && p.blockedPrefixes.length) ? p.blockedPrefixes : this.blocked,
          maxLength: p.maxLength || this.maxLength
        };
      }
    } catch (e) { /* fall back to env */ }
    return { allowed: this.allowed, blocked: this.blocked, maxLength: this.maxLength };
  }

  _normalize(number) {
    return String(number || '').replace(/^\+/, '').replace(/\D/g, '');
  }

  // Longest matching prefix from a list, or null.
  _longestMatch(number, list) {
    let best = null;
    for (const p of list) {
      const pfx = String(p).replace(/^\+/, '');
      if (number.startsWith(pfx) && (!best || pfx.length > best.length)) best = pfx;
    }
    return best;
  }

  /**
   * Decide whether an outbound number may be dialled.
   * @returns {Promise<{allowed:boolean, reason?:string, matched?:string}>}
   */
  async check(number) {
    const n = this._normalize(number);
    const { allowed, blocked, maxLength } = await this._policy();

    if (!n) return { allowed: false, reason: 'empty number' };
    if (n.length > maxLength) return { allowed: false, reason: `number too long (${n.length} digits)` };
    if (n.length < 3) return { allowed: false, reason: 'number too short' };

    // Block-list wins, and a more specific block beats a more general allow.
    const blockedMatch = this._longestMatch(n, blocked);
    const allowedMatch = allowed.length ? this._longestMatch(n, allowed) : null;

    if (blockedMatch && (!allowedMatch || blockedMatch.length >= allowedMatch.length)) {
      return { allowed: false, reason: `destination prefix ${blockedMatch} is blocked`, matched: blockedMatch };
    }

    // With an allow-list configured, only listed prefixes pass.
    if (allowed.length && !allowedMatch) {
      return { allowed: false, reason: `destination not in the allowed country list`, matched: null };
    }

    return { allowed: true, matched: allowedMatch || null };
  }

  /**
   * Convenience: throws a 403-style error when blocked. Used at call sites
   * that prefer to let it bubble.
   */
  async assert(number, context) {
    const r = await this.check(number);
    if (!r.allowed) {
      logger.warn(`OUTBOUND BLOCKED: ${number} — ${r.reason}${context ? ` (${context})` : ''}`);
      const err = new Error(`Outbound call to ${number} is not permitted: ${r.reason}`);
      err.status = 403;
      err.blocked = true;
      throw err;
    }
    return r;
  }

  summary() {
    return {
      allowedPrefixes: this.allowed.length ? this.allowed : '(all)',
      blockedPrefixes: this.blocked,
      maxLength: this.maxLength,
      mode: this.allowed.length ? 'allow-list (only listed countries)' : 'block-list only'
    };
  }
}

module.exports = OutboundGuard;
module.exports.DEFAULT_BLOCKED = DEFAULT_BLOCKED;
