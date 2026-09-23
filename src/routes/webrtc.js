const express = require('express');
const logger = require('../utils/logger');
const rtpHelper = require('../utils/rtp-helper');
const selftest = require('../utils/webrtc-selftest');

// ============================================================
// WebRTC (Phase 1) routes
//
//   API (X-API-Key, mounted under /api):
//     GET  /api/webrtc/status     — bridge config, RTPEngine, WSS, browser registrations
//     POST /api/webrtc/selftest   — run the RTPEngine WebRTC<->RTP bridge self-test
//
//   Web (admin session, mounted at /):
//     GET  /webrtc                — status page + self-test + test softphone
//     GET  /webrtc/api/status     — same JSON as above, session-authenticated
//     POST /webrtc/api/selftest   — same as above, session-authenticated
//
// The web variants exist so the admin page never needs the master
// API key embedded in its HTML.
// ============================================================

const turn = require('../utils/turn-credentials');

function iceServers(label) {
  // STUN plus, when TURN is configured, a fresh ephemeral relay credential
  return turn.iceServers(label);
}

function wssUrl(req) {
  if (process.env.WSS_URL) return process.env.WSS_URL;
  const host = req && (req.get('x-forwarded-host') || req.get('host'));
  return host ? `wss://${host.split(',')[0].trim()}/ws` : '';
}

function sipDomain(req) {
  if (process.env.SIP_DOMAIN && process.env.SIP_DOMAIN !== 'your-domain-or-ip') return process.env.SIP_DOMAIN;
  const host = req && (req.get('x-forwarded-host') || req.get('host'));
  return host ? host.split(',')[0].split(':')[0].trim() : (process.env.EXTERNAL_IP || 'localhost');
}

function clientConfig(req, label) {
  return { wssUrl: wssUrl(req), sipDomain: sipDomain(req), iceServers: iceServers(label) };
}

function webrtcRegistrations(registrar) {
  const out = [];
  if (!registrar || !registrar.contactCache) return out;
  const now = new Date();
  for (const [ext, contacts] of registrar.contactCache) {
    for (const c of contacts || []) {
      if (c.expires > now && (c.webrtc || c.transport === 'ws' || c.transport === 'wss')) {
        out.push({ extension: ext, transport: c.transport, userAgent: c.userAgent, registeredAt: c.registeredAt, expires: c.expires });
      }
    }
  }
  return out;
}

async function buildStatus(deps, req) {
  const { rtpengine, registrar } = deps;
  const issues = [];
  const cfg = clientConfig(req);
  const summary = rtpHelper.webrtcSummary();

  let rtp = 'not_configured';
  if (rtpengine) {
    try {
      const ping = await rtpengine.ping(rtpHelper.getConfig());
      rtp = ping && ping.result === 'pong' ? 'ok' : 'error';
    } catch (e) { rtp = 'error'; }
  }

  if (!summary.enabled) issues.push('WebRTC bridging disabled (WEBRTC_ENABLED=false)');
  if (rtp !== 'ok') issues.push('RTPEngine not responding — WebRTC media cannot be bridged');
  if (!process.env.WSS_URL) issues.push('WSS_URL not set in .env (derived from request host)');
  if (!process.env.EXTERNAL_IP) issues.push('EXTERNAL_IP not set — ICE candidates may be wrong');
  if (cfg.wssUrl && !cfg.wssUrl.startsWith('wss://')) issues.push('WSS_URL must use wss:// — browsers block ws:// from HTTPS pages');
  const proto = req ? (req.get('x-forwarded-proto') || req.protocol) : '';
  if (req && proto && proto.split(',')[0].trim() !== 'https') issues.push('Page served over HTTP — browsers only allow microphone access on HTTPS');
  if (summary.codecPolicy === 'transcode') issues.push('WEBRTC_CODEC_POLICY=transcode — recordings of browser legs may not decode (recorder expects mu-law)');
  if (!turn.configured()) issues.push('TURN not configured — visitors behind strict NAT/firewalls will connect but hear nothing (run scripts/setup-turn.sh)');

  return {
    success: true,
    webrtc: summary,
    rtpengine: rtp,
    signalling: {
      wssUrl: cfg.wssUrl,
      sipDomain: cfg.sipDomain,
      drachtioWs: '127.0.0.1:5061 (behind nginx /ws)'
    },
    iceServers: cfg.iceServers,
    turn: turn.summary(),
    registrations: webrtcRegistrations(registrar),
    webcall: deps.guestManager ? deps.guestManager.summary() : null,
    issues
  };
}

async function runSelftest(rtpengine) {
  const result = await selftest.run(rtpengine);
  logger.info(`WEBRTC selftest: ${result.ok ? 'PASS' : 'FAIL'} ${result.summary ? `${result.summary.passed}/${result.summary.total}` : result.error || ''}`);
  return { success: true, ...result };
}

// ---------- API-key router (mounted under /api after the key middleware) ----------
function createWebrtcApiRouter(deps) {
  const router = express.Router();

  router.get('/webrtc/status', async (req, res) => {
    try { res.json(await buildStatus(deps, req)); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/webrtc/selftest', async (req, res) => {
    try { res.json(await runSelftest(deps.rtpengine)); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  return router;
}

// ---------- Session router (admin page, mounted at /) ----------
function createWebrtcWebRouter(deps) {
  const router = express.Router();
  const web = require('./web');
  const auth = web.authMiddleware;
  const admin = web.adminOnly;

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

  router.get('/webrtc', auth, admin, (req, res) => {
    res.render('pages/webrtc', locals(req, { webrtcConfig: clientConfig(req) }));
  });

  router.get('/webrtc/api/status', auth, admin, async (req, res) => {
    try { res.json(await buildStatus(deps, req)); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/webrtc/api/selftest', auth, admin, async (req, res) => {
    try { res.json(await runSelftest(deps.rtpengine)); }
    catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  return router;
}

module.exports = { createWebrtcApiRouter, createWebrtcWebRouter, buildStatus, clientConfig };
