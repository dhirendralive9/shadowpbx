const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { WebCallWidget, RingGroup, Extension, IVR, Queue } = require('../models');
const { clientConfig } = require('./webrtc');

// ============================================================
// Web-call routes (Web Dialer — Phase 2)
//
//   Public (no auth — mounted BEFORE the /api key middleware):
//     POST /api/webcall/token        issue a single-use guest credential
//     GET  /api/webcall/config/:id   branding a browser needs to draw the button
//
//   Admin (X-API-Key, mounted under /api):
//     GET/POST/PUT/DELETE /api/webcall/widgets[/:widgetId]
//     GET    /api/webcall/guests
//     DELETE /api/webcall/guests/:username
//
//   Admin (login session, mounted at /) — used by the WebRTC page:
//     the same widget + guest endpoints under /webcall/api/...
//
// The public endpoints deliberately expose nothing about the internal
// destination: the browser learns its SIP credentials and how to reach
// the PBX, never which extension or ring group it will land on.
// ============================================================

function publicIp(req) {
  const fwd = req.get('x-forwarded-for');
  return (fwd ? fwd.split(',')[0].trim() : null) || req.ip || req.connection.remoteAddress;
}

function requestOrigin(req) {
  const origin = req.get('origin');
  if (origin) return origin;
  const ref = req.get('referer');
  if (!ref) return '';
  try { return new URL(ref).origin; } catch (e) { return ''; }
}

// ---------- public ----------
function createWebcallPublicRouter(deps) {
  const router = express.Router();
  const gm = deps.guestManager;

  // Branding for the button. No destination, no internals.
  router.get('/webcall/config/:widgetId', async (req, res) => {
    try {
      const w = await WebCallWidget.findOne({ widgetId: req.params.widgetId, enabled: true }).lean();
      if (!w) return res.status(404).json({ success: false, error: 'Unknown widget' });
      if (!gm.originAllowed(w, requestOrigin(req))) return res.status(403).json({ success: false, error: 'Not allowed on this site' });
      res.set('Cache-Control', 'public, max-age=60');
      res.json({
        success: true,
        widgetId: w.widgetId,
        branding: w.branding || {},
        collectInfo: w.collectInfo || 'none',
        enabled: true
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Issue a single-use guest credential.
  router.post('/webcall/token', async (req, res) => {
    try {
      const body = req.body || {};
      const result = await gm.issueToken({
        widgetId: body.widgetId || req.query.widgetId,
        ip: publicIp(req),
        origin: requestOrigin(req),
        userAgent: req.get('user-agent') || '',
        pageUrl: body.pageUrl || '',
        name: body.name,
        number: body.number
      });
      if (!result.ok) return res.status(result.status || 400).json({ success: false, error: result.error });

      const cfg = clientConfig(req);
      const g = result.guest;
      res.set('Cache-Control', 'no-store');
      res.json({
        success: true,
        // SIP credentials — valid for ONE call, for this widget only
        username: g.username,
        password: g.secret,
        sipDomain: cfg.sipDomain,
        wssUrl: cfg.wssUrl,
        iceServers: cfg.iceServers,       // TURN credentials join this in Phase 8
        // Where to send the INVITE. The PBX resolves it to the real destination.
        callTarget: g.widgetId,
        expiresIn: result.ttl
      });
    } catch (err) {
      logger.error(`WEBCALL token error: ${err.message}`);
      res.status(500).json({ success: false, error: 'Token issue failed' });
    }
  });

  return router;
}

// ---------- admin (shared by the API-key and session routers) ----------
async function validateDestination(dest) {
  if (!dest || !dest.type || !dest.target) return 'destination type and target are required';
  const t = String(dest.target);
  if (dest.type === 'extension' && !(await Extension.findOne({ extension: t }))) return `extension ${t} does not exist`;
  if (dest.type === 'ringgroup' && !(await RingGroup.findOne({ number: t }))) return `ring group ${t} does not exist`;
  if (dest.type === 'ivr' && !(await IVR.findOne({ number: t }))) return `IVR ${t} does not exist`;
  if (dest.type === 'queue' && !(await Queue.findOne({ number: t }))) return `queue ${t} does not exist`;
  return null;
}

function adminHandlers(deps) {
  const gm = deps.guestManager;

  return {
    listWidgets: async (req, res) => {
      try {
        const widgets = await WebCallWidget.find({}).sort({ createdAt: -1 }).lean();
        res.json({ success: true, widgets, guests: gm.summary() });
      } catch (err) { res.status(500).json({ success: false, error: err.message }); }
    },

    createWidget: async (req, res) => {
      try {
        const b = req.body || {};
        if (!b.name) return res.status(400).json({ success: false, error: 'name is required' });
        const dest = b.destination || {};
        const bad = await validateDestination(dest);
        if (bad) return res.status(400).json({ success: false, error: bad });

        const widget = await WebCallWidget.create({
          widgetId: b.widgetId || crypto.randomBytes(5).toString('hex'),
          name: b.name,
          destination: { type: dest.type, target: String(dest.target) },
          collectInfo: b.collectInfo || 'none',
          branding: b.branding || {},
          allowedDomains: Array.isArray(b.allowedDomains) ? b.allowedDomains : [],
          maxConcurrent: b.maxConcurrent || 5,
          enabled: b.enabled !== false
        });
        logger.info(`WEBCALL: widget created ${widget.widgetId} (${widget.name}) -> ${dest.type}:${dest.target}`);
        res.json({ success: true, widget });
      } catch (err) {
        if (err.code === 11000) return res.status(409).json({ success: false, error: 'widgetId already exists' });
        res.status(500).json({ success: false, error: err.message });
      }
    },

    updateWidget: async (req, res) => {
      try {
        const b = req.body || {};
        const update = { updatedAt: new Date() };
        if (b.destination) {
          const bad = await validateDestination(b.destination);
          if (bad) return res.status(400).json({ success: false, error: bad });
          update.destination = { type: b.destination.type, target: String(b.destination.target) };
        }
        ['name', 'collectInfo', 'branding', 'allowedDomains', 'maxConcurrent', 'enabled'].forEach(k => {
          if (b[k] !== undefined) update[k] = b[k];
        });
        const widget = await WebCallWidget.findOneAndUpdate({ widgetId: req.params.widgetId }, update, { new: true });
        if (!widget) return res.status(404).json({ success: false, error: 'Widget not found' });
        res.json({ success: true, widget });
      } catch (err) { res.status(500).json({ success: false, error: err.message }); }
    },

    deleteWidget: async (req, res) => {
      try {
        const r = await WebCallWidget.deleteOne({ widgetId: req.params.widgetId });
        if (!r.deletedCount) return res.status(404).json({ success: false, error: 'Widget not found' });
        // Drop any guest still holding a token for it
        gm.list().filter(g => g.widgetId === req.params.widgetId)
          .forEach(g => gm.destroy(g.username, 'widget deleted'));
        logger.info(`WEBCALL: widget ${req.params.widgetId} deleted`);
        res.json({ success: true });
      } catch (err) { res.status(500).json({ success: false, error: err.message }); }
    },

    listGuests: (req, res) => {
      res.json({ success: true, summary: gm.summary(), guests: gm.list() });
    },

    killGuest: (req, res) => {
      gm.destroy(req.params.username, 'terminated by admin');
      res.json({ success: true });
    }
  };
}

function mountAdmin(router, h, prefix, guards) {
  const g = guards || [];
  router.get(`${prefix}/widgets`, ...g, h.listWidgets);
  router.post(`${prefix}/widgets`, ...g, h.createWidget);
  router.put(`${prefix}/widgets/:widgetId`, ...g, h.updateWidget);
  router.delete(`${prefix}/widgets/:widgetId`, ...g, h.deleteWidget);
  router.get(`${prefix}/guests`, ...g, h.listGuests);
  router.delete(`${prefix}/guests/:username`, ...g, h.killGuest);
  return router;
}

// ---------- API-key router (mounted under /api, after the key middleware) ----------
function createWebcallApiRouter(deps) {
  return mountAdmin(express.Router(), adminHandlers(deps), '/webcall');
}

// ---------- session router (admin UI, mounted at /) ----------
function createWebcallWebRouter(deps) {
  const web = require('./web');
  return mountAdmin(express.Router(), adminHandlers(deps), '/webcall/api', [web.authMiddleware, web.adminOnly]);
}

module.exports = { createWebcallPublicRouter, createWebcallApiRouter, createWebcallWebRouter };
