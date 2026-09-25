const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { User } = require('../models');
const logger = require('../utils/logger');

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';

// Session store (in-memory, clears on restart)
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// ── Login rate limiting ──
// Always on, independent of Turnstile (which is optional): a deployment
// without a CAPTCHA still needs brute-force protection at the login endpoint.
// Per-IP: after LOGIN_MAX_FAILS failures within the window, lock out for
// LOGIN_LOCKOUT seconds. Successful login clears the counter.
const LOGIN_MAX_FAILS = parseInt(process.env.LOGIN_MAX_FAILS) || 5;
const LOGIN_WINDOW = (parseInt(process.env.LOGIN_WINDOW_SECONDS) || 300) * 1000;
const LOGIN_LOCKOUT = (parseInt(process.env.LOGIN_LOCKOUT_SECONDS) || 900) * 1000;
const loginAttempts = new Map(); // ip -> { fails, first, lockedUntil }

function loginLockRemaining(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return 0;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  return 0;
}
function recordLoginFail(ip) {
  const now = Date.now();
  let rec = loginAttempts.get(ip);
  if (!rec || now - rec.first > LOGIN_WINDOW) rec = { fails: 0, first: now, lockedUntil: 0 };
  rec.fails++;
  if (rec.fails >= LOGIN_MAX_FAILS) rec.lockedUntil = now + LOGIN_LOCKOUT;
  loginAttempts.set(ip, rec);
}
function clearLoginFails(ip) { loginAttempts.delete(ip); }

// Session cookie options. Secure is set when the request arrived over HTTPS
// (directly or via the proxy's X-Forwarded-Proto), so the cookie is never
// sent in the clear.
function cookieOpts(req) {
  const proto = (req.get('x-forwarded-proto') || req.protocol || '').split(',')[0].trim();
  return { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL, secure: proto === 'https' };
}

const _loginSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of loginAttempts) if ((!r.lockedUntil || now > r.lockedUntil) && now - r.first > LOGIN_WINDOW) loginAttempts.delete(ip);
}, 5 * 60 * 1000);
if (_loginSweep.unref) _loginSweep.unref();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── Auth middleware: must be logged in ───
function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies.sid;
  if (!token || !sessions.has(token)) return res.redirect('/login');
  const session = sessions.get(token);
  if (Date.now() - session.created > SESSION_TTL) {
    sessions.delete(token);
    return res.redirect('/login');
  }
  req.session = session;
  next();
}

// ─── Role middleware factories ───
function requireRole(...roles) {
  return function(req, res, next) {
    if (!req.session || !roles.includes(req.session.role)) {
      return res.status(403).render('pages/forbidden', {
        apiKey: '', role: req.session ? req.session.role : '', user: req.session ? req.session.user : ''
      });
    }
    next();
  };
}

function adminOnly(req, res, next) { return requireRole('admin')(req, res, next); }
function supervisorUp(req, res, next) { return requireRole('admin', 'supervisor')(req, res, next); }

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `secret=${TURNSTILE_SECRET}&response=${token}`
    });
    const d = await r.json();
    return d.success === true;
  } catch (e) {
    logger.warn(`Turnstile verify failed: ${e.message}`);
    return false;
  }
}

function createWebRouter(apiKey) {
  const router = express.Router();

  // Helper: build template locals with session data
  //
  // `apiKey` is deliberately empty. It used to carry ADMIN_SECRET into every
  // page, which meant any logged-in user could read the master API credential
  // out of the HTML and call administrative endpoints directly, bypassing the
  // role checks in the UI. Browser calls to /api now authenticate with the
  // session cookie instead (see src/middleware/api-auth.js), and the template
  // local is kept only so existing views keep rendering.
  function locals(req, extra) {
    return {
      apiKey: '',
      role: req.session ? req.session.role : '',
      user: req.session ? req.session.user : '',
      userName: req.session ? req.session.name : '',
      userExt: req.session ? req.session.extension : '',
      userId: req.session ? req.session.userId : '',
      ...extra
    };
  }

  // ─── Login ───
  router.get('/login', (req, res) => {
    const token = req.cookies && req.cookies.sid;
    if (token && sessions.has(token)) return res.redirect('/');
    res.render('pages/login', { error: null, turnstileSiteKey: TURNSTILE_SITE_KEY });
  });

  router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const turnstileToken = req.body['cf-turnstile-response'];

    // Rate limit first — before any DB or bcrypt work — so a locked-out IP
    // can't be used to hammer the endpoint.
    const lockLeft = loginLockRemaining(req.ip);
    if (lockLeft > 0) {
      logger.warn(`GUI: login blocked (rate limited) from ${req.ip}, ${lockLeft}s remaining`);
      return res.status(429).render('pages/login', { error: `Too many attempts. Try again in ${Math.ceil(lockLeft / 60)} minute(s).`, turnstileSiteKey: TURNSTILE_SITE_KEY });
    }

    if (TURNSTILE_SECRET) {
      const valid = await verifyTurnstile(turnstileToken);
      if (!valid) {
        return res.render('pages/login', { error: 'Captcha verification failed.', turnstileSiteKey: TURNSTILE_SITE_KEY });
      }
    }

    if (!username || !password) {
      return res.render('pages/login', { error: 'Username and password required.', turnstileSiteKey: TURNSTILE_SITE_KEY });
    }

    try {
      // Look up user in DB
      const user = await User.findOne({ username, enabled: true });

      if (!user) {
        // Fallback: check .env admin credentials (for first-time setup before seed runs)
        const envUser = process.env.ADMIN_USER || 'admin';
        const envPass = process.env.ADMIN_PASSWORD || '';
        if (username === envUser && envPass && password === envPass) {
          // First-install bootstrap only. Once a real admin user exists in the
          // DB this path should never be used; warn loudly if it is, so a
          // forgotten ADMIN_PASSWORD in production is visible.
          const realAdmins = await User.countDocuments({ role: 'admin', enabled: true }).catch(() => 0);
          if (realAdmins > 0) {
            logger.warn(`SECURITY: env-fallback admin login used from ${req.ip} even though ${realAdmins} DB admin(s) exist — remove ADMIN_PASSWORD from .env`);
          }
          clearLoginFails(req.ip);
          const sid = generateToken();
          sessions.set(sid, { user: username, role: 'admin', name: 'Administrator', extension: '', userId: '', created: Date.now() });
          res.cookie('sid', sid, cookieOpts(req));
          logger.info(`GUI: admin (env fallback) logged in from ${req.ip}`);
          return res.redirect('/');
        }

        recordLoginFail(req.ip);
        logger.warn(`GUI: failed login for '${username}' from ${req.ip}`);
        return res.render('pages/login', { error: 'Invalid username or password.', turnstileSiteKey: TURNSTILE_SITE_KEY });
      }

      // Verify bcrypt password
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        recordLoginFail(req.ip);
        logger.warn(`GUI: failed login for '${username}' from ${req.ip}`);
        return res.render('pages/login', { error: 'Invalid username or password.', turnstileSiteKey: TURNSTILE_SITE_KEY });
      }
      clearLoginFails(req.ip);

      // Create session with role data
      const sid = generateToken();
      sessions.set(sid, {
        user: user.username,
        role: user.role,
        name: user.name || user.username,
        extension: user.extension || '',
        userId: user._id.toString(),
        created: Date.now()
      });
      res.cookie('sid', sid, cookieOpts(req));

      // Update last login
      user.lastLogin = new Date();
      await user.save();

      logger.info(`GUI: ${user.role} '${user.username}' logged in from ${req.ip}`);
      res.redirect('/');

    } catch (err) {
      logger.error(`Login error: ${err.message}`);
      res.render('pages/login', { error: 'Login failed. Please try again.', turnstileSiteKey: TURNSTILE_SITE_KEY });
    }
  });

  // Logout is state-changing, so POST is primary. A GET is kept for the
  // browser's convenience (a link/bookmark) but both invalidate the session
  // server-side, so there is no CSRF-logout risk beyond a harmless redirect.
  function doLogout(req, res) {
    const token = req.cookies && req.cookies.sid;
    if (token) sessions.delete(token);
    res.clearCookie('sid');
    res.redirect('/login');
  }
  router.post('/logout', doLogout);
  router.get('/logout', doLogout);

  // ─── All roles ───
  router.get('/', authMiddleware, (req, res) => {
    res.render('pages/dashboard', locals(req));
  });

  router.get('/cdr', authMiddleware, (req, res) => {
    res.render('pages/cdr', locals(req));
  });

  router.get('/voicemail', authMiddleware, (req, res) => {
    res.render('pages/voicemail', locals(req));
  });

  router.get('/chat', authMiddleware, (req, res) => {
    res.render('pages/chat', locals(req));
  });

  // ─── Supervisor + Admin ───
  router.get('/extensions', authMiddleware, supervisorUp, (req, res) => {
    res.render('pages/extensions', locals(req));
  });

  router.get('/calls', authMiddleware, supervisorUp, (req, res) => {
    res.render('pages/calls', locals(req));
  });

  router.get('/ringgroups', authMiddleware, supervisorUp, (req, res) => {
    res.render('pages/ringgroups', locals(req));
  });

  router.get('/queues', authMiddleware, supervisorUp, (req, res) => {
    res.render('pages/queues', locals(req));
  });

  router.get('/campaigns', authMiddleware, supervisorUp, (req, res) => {
    res.render('pages/campaigns', locals(req));
  });

  // ─── Admin only ───
  router.get('/trunks', authMiddleware, adminOnly, (req, res) => {
    res.render('pages/trunks', locals(req));
  });

  router.get('/routes', authMiddleware, adminOnly, (req, res) => {
    res.render('pages/routes', locals(req));
  });

  router.get('/ivr', authMiddleware, adminOnly, (req, res) => {
    res.render('pages/ivr', locals(req));
  });

  router.get('/appointments', authMiddleware, supervisorUp, (req, res) => {
    res.render('pages/appointments', locals(req));
  });

  router.get('/time-conditions', authMiddleware, adminOnly, (req, res) => {
    res.render('pages/timeconditions', locals(req));
  });

  router.get('/settings', authMiddleware, adminOnly, (req, res) => {
    res.render('pages/settings', locals(req));
  });

  router.get('/users', authMiddleware, adminOnly, (req, res) => {
    res.redirect('/settings#users');
  });

  // ─── OAuth 2.0 Callback (CRM Integration) ───
  // CRM redirects here after admin grants access.
  // No API key auth — this is a browser redirect, session-based.
  router.get('/settings/crm/oauth/callback', authMiddleware, adminOnly, async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      logger.warn(`OAuth callback error: ${error} — ${error_description || ''}`);
      return res.redirect(`/settings?tab=crm&oauth=error&message=${encodeURIComponent(error_description || error)}`);
    }

    if (!code || !state) {
      return res.redirect('/settings?tab=crm&oauth=error&message=Missing+code+or+state');
    }

    try {
      const oauthManager = require('../services/crm/oauth');
      const result = await oauthManager.handleCallback(code, state);

      if (result.success) {
        logger.info(`OAuth: ${result.provider} connected for config ${result.configId}`);

        // Reload the CRM adapter with fresh tokens
        const crmManager = require('../services/crm-manager');
        try {
          await crmManager.reloadConnection(result.configId);
        } catch (e) {
          logger.warn(`OAuth: adapter reload after connect: ${e.message}`);
        }

        return res.redirect(`/settings?tab=crm&oauth=success&provider=${result.provider}`);
      } else {
        return res.redirect(`/settings?tab=crm&oauth=error&message=${encodeURIComponent(result.error || 'Unknown error')}`);
      }
    } catch (err) {
      logger.error(`OAuth callback exception: ${err.message}`);
      return res.redirect(`/settings?tab=crm&oauth=error&message=${encodeURIComponent(err.message)}`);
    }
  });

  return router;
}

module.exports = createWebRouter;
// Exposed so other session-authenticated routers (e.g. routes/webrtc.js)
// share the same login sessions and role checks.
module.exports.authMiddleware = authMiddleware;
module.exports.requireRole = requireRole;
module.exports.adminOnly = adminOnly;
module.exports.supervisorUp = supervisorUp;

// Lets the API layer resolve a browser session from the same store, so
// /api can be authenticated by cookie instead of a shared secret.
module.exports.getSession = function getSession(token) {
  if (!token || !sessions.has(token)) return null;
  const session = sessions.get(token);
  if (Date.now() - session.created > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return session;
};
