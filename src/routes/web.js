const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');

const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET || '';
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';

// Simple session store (in-memory, clears on restart)
const sessions = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies.sid;
  if (!token || !sessions.has(token)) {
    return res.redirect('/login');
  }
  const session = sessions.get(token);
  if (Date.now() - session.created > SESSION_TTL) {
    sessions.delete(token);
    return res.redirect('/login');
  }
  req.session = session;
  next();
}

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) return true; // Turnstile not configured
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

  // Login page
  router.get('/login', (req, res) => {
    const token = req.cookies && req.cookies.sid;
    if (token && sessions.has(token)) return res.redirect('/');
    res.render('pages/login', {
      error: null,
      turnstileSiteKey: TURNSTILE_SITE_KEY
    });
  });

  // Login handler
  router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const turnstileToken = req.body['cf-turnstile-response'];

    // Verify Turnstile if configured
    if (TURNSTILE_SECRET) {
      const valid = await verifyTurnstile(turnstileToken);
      if (!valid) {
        return res.render('pages/login', {
          error: 'Captcha verification failed. Please try again.',
          turnstileSiteKey: TURNSTILE_SITE_KEY
        });
      }
    }

    // Check credentials
    const adminUser = process.env.ADMIN_USER || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || '';

    if (!adminPass) {
      return res.render('pages/login', {
        error: 'Admin password not configured. Run: node scripts/reset-password.js',
        turnstileSiteKey: TURNSTILE_SITE_KEY
      });
    }

    if (username !== adminUser || password !== adminPass) {
      logger.warn(`GUI: failed login attempt for user '${username}' from ${req.ip}`);
      return res.render('pages/login', {
        error: 'Invalid username or password.',
        turnstileSiteKey: TURNSTILE_SITE_KEY
      });
    }

    // Create session
    const sid = generateToken();
    sessions.set(sid, { user: username, created: Date.now() });
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: SESSION_TTL });

    logger.info(`GUI: admin logged in from ${req.ip}`);
    res.redirect('/');
  });

  // Logout
  router.get('/logout', (req, res) => {
    const token = req.cookies && req.cookies.sid;
    if (token) sessions.delete(token);
    res.clearCookie('sid');
    res.redirect('/login');
  });

  // Protected routes
  router.get('/', authMiddleware, (req, res) => {
    res.render('pages/dashboard', { apiKey });
  });

  router.get('/extensions', authMiddleware, (req, res) => {
    res.render('pages/extensions', { apiKey });
  });

  router.get('/calls', authMiddleware, (req, res) => {
    res.render('pages/calls', { apiKey });
  });

  router.get('/cdr', authMiddleware, (req, res) => {
    res.render('pages/cdr', { apiKey });
  });

  router.get('/voicemail', authMiddleware, (req, res) => {
    res.render('pages/voicemail', { apiKey });
  });

  router.get('/ringgroups', authMiddleware, (req, res) => {
    res.render('pages/ringgroups', { apiKey });
  });

  router.get('/trunks', authMiddleware, (req, res) => {
    res.render('pages/trunks', { apiKey });
  });

  router.get('/routes', authMiddleware, (req, res) => {
    res.render('pages/routes', { apiKey });
  });

  router.get('/ivr', authMiddleware, (req, res) => {
    res.render('pages/ivr', { apiKey });
  });

  router.get('/time-conditions', authMiddleware, (req, res) => {
    res.render('pages/timeconditions', { apiKey });
  });

  router.get('/settings', authMiddleware, (req, res) => {
    res.render('pages/settings', { apiKey });
  });

  return router;
}

module.exports = createWebRouter;
