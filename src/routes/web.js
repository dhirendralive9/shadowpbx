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
  function locals(req, extra) {
    return {
      apiKey,
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
          const sid = generateToken();
          sessions.set(sid, { user: username, role: 'admin', name: 'Administrator', extension: '', userId: '', created: Date.now() });
          res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL });
          logger.info(`GUI: admin (env fallback) logged in from ${req.ip}`);
          return res.redirect('/');
        }

        logger.warn(`GUI: failed login for '${username}' from ${req.ip}`);
        return res.render('pages/login', { error: 'Invalid username or password.', turnstileSiteKey: TURNSTILE_SITE_KEY });
      }

      // Verify bcrypt password
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        logger.warn(`GUI: failed login for '${username}' from ${req.ip}`);
        return res.render('pages/login', { error: 'Invalid username or password.', turnstileSiteKey: TURNSTILE_SITE_KEY });
      }

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
      res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL });

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

  router.get('/logout', (req, res) => {
    const token = req.cookies && req.cookies.sid;
    if (token) sessions.delete(token);
    res.clearCookie('sid');
    res.redirect('/login');
  });

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

  router.get('/time-conditions', authMiddleware, adminOnly, (req, res) => {
    res.render('pages/timeconditions', locals(req));
  });

  router.get('/settings', authMiddleware, adminOnly, (req, res) => {
    res.render('pages/settings', locals(req));
  });

  router.get('/users', authMiddleware, adminOnly, (req, res) => {
    res.render('pages/users', locals(req));
  });

  return router;
}

module.exports = createWebRouter;
