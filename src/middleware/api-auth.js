const logger = require('../utils/logger');

// ============================================================
// API authentication and authorization
//
// Before: every /api request was authorised by comparing a single
// ADMIN_SECRET, and that same secret was injected into every page's
// HTML as `apiKey`. Any logged-in user — including an agent — could
// read it from DevTools and then call any administrative endpoint:
// trunks, users, routes, recordings, security controls. The GUI's
// role checks were decoration.
//
// Now:
//
//   Browser  → session cookie → role from the session → per-route policy
//   Machine  → X-API-Key      → role "service"        → full access
//
// The browser never receives a service credential. The API key remains
// for machine-to-machine callers only, and is accepted solely from the
// X-API-Key header — never from the query string, where it would end up
// in access logs, browser history and proxies.
// ============================================================

const ROLES = ['admin', 'supervisor', 'agent'];

// ------------------------------------------------------------
// Route policy
//
// Evaluated in order; first match wins. Anything unmatched is
// admin-only, so a newly added endpoint is closed by default rather
// than silently world-readable.
//
//   own: true  → every :ext / :username in the path must be the caller's own
//                identity; own: 'any' → at least one must be (two-party chat
//                paths). Admins and supervisors are exempt.
// ------------------------------------------------------------
const POLICY = [
  // ── Everyone logged in ──
  { m: 'GET', p: '/health', roles: ROLES },
  { m: 'GET', p: '/presence', roles: ROLES },
  { m: 'GET', p: '/presence/:ext', roles: ROLES },
  { m: 'GET', p: '/extensions', roles: ROLES },          // directory: names + numbers
  { m: 'GET', p: '/stats', roles: ROLES },
  { m: 'GET', p: '/calls/active', roles: ROLES },
  { m: 'GET', p: '/calls/parked', roles: ROLES },
  { m: 'GET', p: '/ringgroups', roles: ROLES },
  { m: 'GET', p: '/queues', roles: ROLES },
  { m: 'GET', p: '/queues/:number', roles: ROLES },
  { m: 'GET', p: '/queues/:number/stats', roles: ROLES },
  { m: 'GET', p: '/audio/list', roles: ROLES },
  { m: 'GET', p: '/audio/play/:filename', roles: ROLES },

  // ── Chat: your own conversations only ──
  { m: 'GET', p: '/chat/contacts/:username', roles: ROLES, own: true },
  { m: 'GET', p: '/chat/conversations/:username', roles: ROLES, own: true },
  { m: 'GET', p: '/chat/messages/:user1/:user2', roles: ROLES, own: 'any' },
  { m: 'GET', p: '/chat/unread/:username', roles: ROLES, own: true },
  { m: 'POST', p: '/chat/read/:from/:to', roles: ROLES, own: 'any' },
  { m: 'POST', p: '/chat/send', roles: ROLES },

  // ── Voicemail: your own mailbox only ──
  { m: 'GET', p: '/voicemail/:ext', roles: ROLES, own: true },
  { m: 'GET', p: '/voicemail/:ext/summary', roles: ROLES, own: true },
  { m: 'GET', p: '/voicemail/:ext/:messageId/audio', roles: ROLES, own: true },
  { m: 'POST', p: '/voicemail/:ext/:messageId/read', roles: ROLES, own: true },
  { m: 'DELETE', p: '/voicemail/:ext/:messageId', roles: ROLES, own: true },

  // ── Call control ──
  // Role lets an agent reach these; the HANDLER then enforces object-level
  // ownership (an agent may only control a call they are a participant in —
  // see agentMayControlCall in routes/api.js). Route RBAC alone is not enough
  // here because the object identity (the call) is in the path, not the role.
  { m: 'POST', p: '/calls/:callId/hold', roles: ROLES },
  { m: 'POST', p: '/calls/:callId/resume', roles: ROLES },
  { m: 'POST', p: '/calls/:callId/transfer', roles: ROLES },
  { m: 'POST', p: '/calls/:callId/park', roles: ROLES },
  { m: 'POST', p: '/calls/pickup/:slot', roles: ROLES },     // pickup extension derived from session for agents

  // ── Agent participation: your own extension only ──
  { m: 'POST', p: '/queues/:number/agents/login', roles: ROLES },
  { m: 'POST', p: '/queues/:number/agents/logout', roles: ROLES },
  { m: 'POST', p: '/campaigns/:id/agents/:ext/login', roles: ROLES, own: true },
  { m: 'POST', p: '/campaigns/:id/agents/:ext/logout', roles: ROLES, own: true },
  { m: 'POST', p: '/campaigns/:id/agents/:ext/pause', roles: ROLES, own: true },
  { m: 'POST', p: '/campaigns/:id/agents/:ext/unpause', roles: ROLES, own: true },

  // ── CDR and CRM lookups agents need while on a call ──
  { m: 'GET', p: '/cdr', roles: ROLES },
  { m: 'GET', p: '/cdr/:callId/notes', roles: ROLES },
  { m: 'POST', p: '/cdr/:callId/notes', roles: ROLES },
  { m: 'POST', p: '/cdr/:callId/disposition', roles: ROLES },
  { m: 'GET', p: '/crm/search/:phone', roles: ROLES },
  { m: 'GET', p: '/crm/screenpops', roles: ROLES },
  { m: 'GET', p: '/dnc/check/:phone', roles: ROLES },
  { m: 'POST', p: '/dnc', roles: ROLES },                 // agents mark a number do-not-call
  { m: 'GET', p: '/blocklist/check/:number', roles: ROLES },

  // ── Supervisors (plus admins) ──
  { m: '*', p: '/monitors', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/monitors/:monitorId', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/monitors/:monitorId/mode', roles: ['admin', 'supervisor'] },
  { m: 'POST', p: '/calls/:callId/monitor', roles: ['admin', 'supervisor'] },
  { m: 'GET', p: '/cdr/:callId/recording', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/campaigns', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/campaigns/:id', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/campaigns/:id/leads', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/campaigns/:id/live', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/campaigns/:id/start', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/campaigns/:id/stop', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/campaigns/:id/pause', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/campaigns/:id/import', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/campaigns/:campaignId/leads/:leadId', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/dialer/running', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/appointments', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/appointments/:number', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/appointments/:number/messages', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/appointments/queue/status', roles: ['admin', 'supervisor'] },
  { m: '*', p: '/appointments/messages/:messageId/audio', roles: ['admin', 'supervisor'] },
  { m: 'GET', p: '/dnc', roles: ['admin', 'supervisor'] },
  { m: 'GET', p: '/blocklist', roles: ['admin', 'supervisor'] },
  { m: 'POST', p: '/blocklist', roles: ['admin', 'supervisor'] },
  { m: 'GET', p: '/queues/:number/agents', roles: ['admin', 'supervisor'] },
  { m: 'GET', p: '/extensions/:ext', roles: ['admin', 'supervisor'] }
];

// Everything else — extensions (write), trunks, routes, IVR, time
// conditions, users, SIP domains, CRM config, security, audio upload
// and delete, DNC import, WebRTC and web-call admin — is admin only.

function compile(pattern) {
  const names = [];
  const rx = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, n) => { names.push(n); return '([^/]+)'; });
  return { rx: new RegExp(`^${rx}$`), names };
}

const COMPILED = POLICY.map(r => ({ ...r, ...compile(r.p) }));

function findPolicy(method, pathname) {
  for (const r of COMPILED) {
    if (r.m !== '*' && r.m !== method) continue;
    const m = r.rx.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { rule: r, params };
  }
  return null;
}

/**
 * Does this request concern the caller's own extension?
 * Admins and supervisors are exempt; agents are held to their own.
 */
function ownershipOk(session, params, mode) {
  // Chat is addressed by username, voicemail and campaigns by extension, so
  // either identifier counts as "mine".
  const mine = [session.extension, session.user].filter(Boolean).map(String);
  const candidates = [params.ext, params.username, params.user1, params.user2, params.from, params.to]
    .filter(v => v !== undefined);
  if (candidates.length === 0) return true;
  // 'any' suits a two-party path such as /chat/messages/:user1/:user2, where
  // the caller must be one side of the conversation but not both.
  return mode === 'any'
    ? candidates.some(v => mine.includes(String(v)))
    : candidates.every(v => mine.includes(String(v)));
}

/**
 * Authentication: session cookie for browsers, X-API-Key for services.
 * @param {object} deps - { getSession(token), adminSecret }
 */
function createApiAuth(deps) {
  const { getSession, adminSecret } = deps;

  return function apiAuth(req, res, next) {
    // Machine-to-machine. Header only: a secret in the query string ends up
    // in nginx access logs, browser history and any proxy in between.
    const key = req.headers['x-api-key'];
    if (key && adminSecret && key === adminSecret) {
      req.apiCaller = { kind: 'service', role: 'service' };
      return next();
    }
    if (key) {
      logger.warn(`API: bad X-API-Key from ${req.ip} for ${req.method} ${req.path}`);
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (req.query.apikey) {
      return res.status(401).json({
        success: false,
        error: 'API keys must be sent in the X-API-Key header, not the query string'
      });
    }

    // Browser session
    const token = req.cookies && req.cookies.sid;
    const session = token && getSession ? getSession(token) : null;
    if (!session) return res.status(401).json({ success: false, error: 'Unauthorized' });

    req.session = session;
    req.apiCaller = { kind: 'session', role: session.role, user: session.user, extension: session.extension };
    next();
  };
}

/**
 * Authorization: per-route roles, default admin-only.
 */
function createApiRbac() {
  return function apiRbac(req, res, next) {
    const caller = req.apiCaller;
    if (!caller) return res.status(401).json({ success: false, error: 'Unauthorized' });
    if (caller.role === 'service' || caller.role === 'admin') return next();

    const hit = findPolicy(req.method, req.path);
    if (!hit) {
      logger.warn(`API: ${caller.role} ${caller.user} denied ${req.method} ${req.path} (admin only)`);
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    if (!hit.rule.roles.includes(caller.role)) {
      logger.warn(`API: ${caller.role} ${caller.user} denied ${req.method} ${req.path}`);
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    if (hit.rule.own && caller.role === 'agent' && !ownershipOk(req.session, hit.params, hit.rule.own)) {
      logger.warn(`API: agent ${caller.user} (ext ${caller.extension}) denied ${req.method} ${req.path} — not their own extension`);
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    next();
  };
}

module.exports = { createApiAuth, createApiRbac, findPolicy, ownershipOk, POLICY };
