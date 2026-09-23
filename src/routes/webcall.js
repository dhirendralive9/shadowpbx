const express = require('express');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { WebCallWidget, RingGroup, Extension, IVR, Queue, TimeCondition } = require('../models');
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
//
// The widget runs on the customer's own site, so these two endpoints are
// cross-origin. CORS is granted per widget: a widget with allowedDomains
// answers only those sites; one with none answers any site (Phase 5/7
// tighten that default). Credentials are never used — the token in the
// response body is the only thing that grants anything.
function createWebcallPublicRouter(deps) {
  const router = express.Router();
  const gm = deps.guestManager;

  async function corsFor(req, res, widgetId) {
    const origin = requestOrigin(req);
    if (!origin) return true;                       // same-origin or a non-browser client
    let widget = null;
    try { widget = await WebCallWidget.findOne({ widgetId, enabled: true }).lean(); } catch (e) {}
    if (!widget || !gm.originAllowed(widget, origin)) return false;
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    return true;
  }

  router.options('/webcall/token', async (req, res) => {
    const ok = await corsFor(req, res, (req.query.widgetId || req.get('x-widget-id') || '').toString());
    // The widget id is not in a preflight, so allow the method here and let
    // the POST itself decide: it re-checks the origin against the widget.
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Max-Age', '600');
    if (!ok) {
      const origin = requestOrigin(req);
      if (origin) { res.set('Access-Control-Allow-Origin', origin); res.set('Vary', 'Origin'); }
    }
    res.sendStatus(204);
  });

  router.options('/webcall/config/:widgetId', async (req, res) => {
    await corsFor(req, res, req.params.widgetId);
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Max-Age', '600');
    res.sendStatus(204);
  });

  // Branding for the button. No destination, no internals.
  router.get('/webcall/config/:widgetId', async (req, res) => {
    try {
      const w = await WebCallWidget.findOne({ widgetId: req.params.widgetId, enabled: true }).lean();
      if (!w) return res.status(404).json({ success: false, error: 'Unknown widget' });
      if (!gm.originAllowed(w, requestOrigin(req))) return res.status(403).json({ success: false, error: 'Not allowed on this site' });
      await corsFor(req, res, req.params.widgetId);
      // Business hours: tell the browser up front when the widget turns
      // callers away outside hours, so it can show the closed message
      // instead of a button that will not work (Phase 7).
      const hours = w.businessHours || {};
      let open = true;
      if (hours.enabled && hours.closedAction === 'message' && hours.timeConditionNumber) {
        const state = await gm.isOpen(hours.timeConditionNumber);
        if (state === false) open = false;
      }

      res.set('Cache-Control', open ? 'public, max-age=60' : 'no-store');
      res.json({
        success: true,
        widgetId: w.widgetId,
        branding: w.branding || {},
        collectInfo: w.collectInfo || 'none',
        captchaSiteKey: gm.captchaSiteKey(w),
        open,
        closedMessage: open ? '' : (hours.closedMessage || 'We are closed right now. Please try again during business hours.'),
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
      const widgetId = body.widgetId || req.query.widgetId;
      await corsFor(req, res, String(widgetId || ''));
      const result = await gm.issueToken({
        widgetId,
        ip: publicIp(req),
        origin: requestOrigin(req),
        userAgent: req.get('user-agent') || '',
        pageUrl: body.pageUrl || '',
        name: body.name,
        number: body.number,
        captchaToken: body.captchaToken || body['cf-turnstile-response']
      });
      if (!result.ok) {
        return res.status(result.status || 400).json({
          success: false, error: result.error,
          captcha: !!result.captcha, closed: !!result.closed
        });
      }

      // ICE servers are minted per call: STUN plus, when configured, a TURN
      // relay credential that expires on its own (Phase 8).
      const cfg = clientConfig(req, result.guest.username);
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
          businessHours: b.businessHours || { enabled: false },
          crmCreateLead: !!b.crmCreateLead,
          captcha: !!b.captcha,
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
        ['name', 'collectInfo', 'branding', 'allowedDomains', 'maxConcurrent', 'enabled', 'businessHours', 'crmCreateLead', 'captcha'].forEach(k => {
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

    // Everything a widget can point at — used by the Web Dialer editor (Phase 5)
    listDestinations: async (req, res) => {
      try {
        const [exts, groups, ivrs, queues, conds] = await Promise.all([
          Extension.find({ enabled: true }, 'extension name').sort({ extension: 1 }).lean(),
          RingGroup.find({}, 'number name').sort({ number: 1 }).lean(),
          IVR.find({ enabled: true }, 'number name').sort({ number: 1 }).lean(),
          Queue.find({ enabled: true }, 'number name').sort({ number: 1 }).lean(),
          TimeCondition.find({ enabled: true }, 'number name').sort({ number: 1 }).lean()
        ]);
        res.json({
          success: true,
          destinations: {
            extension: exts.map(e => ({ number: e.extension, name: e.name || '' })),
            ringgroup: groups.map(g => ({ number: g.number, name: g.name || '' })),
            ivr: ivrs.map(i => ({ number: i.number, name: i.name || '' })),
            queue: queues.map(q => ({ number: q.number, name: q.name || '' })),
            timecondition: conds.map(t => ({ number: t.number, name: t.name || '' }))
          }
        });
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
  router.get(`${prefix}/destinations`, ...g, h.listDestinations);
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
  const router = express.Router();

  // Web Dialer admin page (Phase 5)
  router.get('/webdialer', web.authMiddleware, web.adminOnly, (req, res) => {
    res.render('pages/webdialer', {
      apiKey: '',
      role: req.session ? req.session.role : '',
      user: req.session ? req.session.user : '',
      userName: req.session ? req.session.name : '',
      userExt: req.session ? req.session.extension : '',
      userId: req.session ? req.session.userId : ''
    });
  });

  return mountAdmin(router, adminHandlers(deps), '/webcall/api', [web.authMiddleware, web.adminOnly]);
}

module.exports = { createWebcallPublicRouter, createWebcallApiRouter, createWebcallWebRouter };
