require('dotenv').config();
const Srf = require('drachtio-srf');
const mongoose = require('mongoose');
const express = require('express');
const logger = require('./utils/logger');

// ============================================================
// Fatal-error handling
// ============================================================
// An uncaught exception can leave the call manager, registrar or media state
// half-updated. Continuing on corrupt state is not recovery — for a SIP server
// it risks stuck calls, wrong routing and leaked resources. So we log, then
// exit non-zero and let the process supervisor (systemd/Docker) restart from a
// clean state. Set CRASH_ON_UNCAUGHT=false only if you have a specific reason
// to keep a possibly-inconsistent process alive.
const CRASH_ON_UNCAUGHT = String(process.env.CRASH_ON_UNCAUGHT || 'true').toLowerCase() !== 'false';
let _shuttingDown = false;

function fatal(kind, err) {
  logger.error(`${kind}: ${(err && err.message) || err}`);
  if (err && err.stack) logger.error(err.stack);
  if (!CRASH_ON_UNCAUGHT || _shuttingDown) return;
  _shuttingDown = true;
  logger.error('Exiting so the supervisor can restart from a clean state (set CRASH_ON_UNCAUGHT=false to override).');
  // Give the logger a moment to flush, then exit non-zero.
  setTimeout(() => process.exit(1), 250);
}

process.on('uncaughtException', (err) => fatal('Uncaught exception', err));
// A rejected promise is usually a stray async error, not corrupt core state, so
// log it but don't take the process down.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection: ${reason && reason.message ? reason.message : reason}`);
  if (reason && reason.stack) logger.error(reason.stack);
});

const Registrar = require('./services/registrar');
const CallHandler = require('./services/call-handler');
const RingGroupHandler = require('./services/ring-group');
const TrunkManager = require('./services/trunk-manager');
const CallRouter = require('./services/call-router');
const TransferHandler = require('./services/transfer-handler');
const HoldHandler = require('./services/hold-handler');
const ParkHandler = require('./services/park-handler');
const VoicemailHandler = require('./services/voicemail-handler');
const IvrHandler = require('./services/ivr-handler');
const DtmfListener = require('./services/dtmf-listener');
const MonitorHandler = require('./services/monitor-handler');
const TimeConditionService = require('./services/time-condition');
const PresenceHandler = require('./services/presence-handler');
const QueueHandler = require('./services/queue-handler');
const AppointmentHandler = require('./services/appointment-handler');
const DialerEngine = require('./services/dialer-engine');
const crmManager = require('./services/crm-manager');
const createApiRouter = require('./routes/api');
const { startBackgroundSync } = require('./utils/converter');

let RtpEngineClient;
try {
  RtpEngineClient = require('rtpengine-client').Client;
} catch (e) {
  logger.warn('rtpengine-client not available - recording disabled');
}

async function main() {
  logger.info('===========================================');
  logger.info('  ShadowPBX v3.0 Starting...');
  logger.info('===========================================');

  // Refuse to start without the service credential. Previously this was only
  // a warning, and the old comparison (token !== process.env.ADMIN_SECRET)
  // let an unauthenticated request through when both sides were undefined —
  // a PBX that fails open is worse than one that does not start.
  if (!process.env.ADMIN_SECRET || process.env.ADMIN_SECRET.length < 16) {
    logger.error('ADMIN_SECRET is missing or shorter than 16 characters — refusing to start.');
    logger.error('Set it in /opt/shadowpbx/.env, e.g.  ADMIN_SECRET=$(openssl rand -hex 32)');
    process.exit(1);
  }
  if (!process.env.SESSION_SECRET && !process.env.ADMIN_PASSWORD) {
    logger.warn('No ADMIN_PASSWORD set — the web UI may be unreachable until one is configured');
  }

  // 1. MongoDB
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadowpbx';
  try {
    await mongoose.connect(mongoUri);
    logger.info(`MongoDB connected`);

    // Clean all registrations on startup — softphones will re-register
    // with fresh NAT-mapped ports within seconds
    try {
      const result = await mongoose.connection.db.collection('extensions').updateMany(
        {},
        { $set: { registrations: [] } }
      );
      logger.info(`Startup: cleared registrations from ${result.modifiedCount} extension(s) — waiting for fresh re-registers`);
    } catch (cleanErr) {
      logger.warn(`Startup registration cleanup: ${cleanErr.message}`);
    }

    // Seed default admin user if no users exist
    try {
      const { User } = require('./models');
      const bcrypt = require('bcryptjs');
      const userCount = await User.countDocuments();
      if (userCount === 0) {
        const adminUser = process.env.ADMIN_USER || 'admin';
        const adminPass = process.env.ADMIN_PASSWORD || 'admin';
        const hash = await bcrypt.hash(adminPass, 10);
        await User.create({ username: adminUser, password: hash, role: 'admin', name: 'Administrator', enabled: true });
        logger.info(`Startup: default admin user "${adminUser}" created`);
      }
    } catch (seedErr) {
      logger.warn(`Admin seed: ${seedErr.message}`);
    }
  } catch (err) {
    logger.error(`MongoDB failed: ${err.message}`);
    process.exit(1);
  }

  // 2. Drachtio
  const srf = new Srf();
  srf.connect({
    host: process.env.DRACHTIO_HOST || '127.0.0.1',
    port: parseInt(process.env.DRACHTIO_PORT) || 9022,
    secret: process.env.DRACHTIO_SECRET || 'cymru'
  });

  srf.on('connect', (err, hp) => {
    if (err) return logger.error(`Drachtio failed: ${err}`);
    logger.info(`Drachtio connected: ${hp}`);
  });

  srf.on('error', (err) => {
    logger.error(`Drachtio error: ${err.message}`);
  });

  // 3. RTPEngine
  let rtpengine = null;
  // Map to track RTPEngine call-ids: fromTag -> rtpCallId
  const rtpCallIdMap = new Map();

  if (RtpEngineClient) {
    rtpengine = new RtpEngineClient();

    // Wrap offer/answer to capture RTPEngine call-ids
    const origOffer = rtpengine.offer.bind(rtpengine);
    rtpengine.offer = async function(...args) {
      const result = await origOffer(...args);
      // args: [config, params] — params has 'call-id' and 'from-tag'
      const params = args.length > 1 ? args[1] : args[0];
      if (params && params['call-id'] && params['from-tag']) {
        rtpCallIdMap.set(params['from-tag'], params['call-id']);
        logger.debug(`RTP-TRACK: offer call-id=${params['call-id']} from-tag=${params['from-tag']}`);
      }
      return result;
    };

    const origAnswer = rtpengine.answer.bind(rtpengine);
    rtpengine.answer = async function(...args) {
      const result = await origAnswer(...args);
      const params = args.length > 1 ? args[1] : args[0];
      if (params && params['call-id'] && params['to-tag']) {
        rtpCallIdMap.set(params['to-tag'], params['call-id']);
        logger.debug(`RTP-TRACK: answer call-id=${params['call-id']} to-tag=${params['to-tag']}`);
      }
      return result;
    };

    // Expose the map for MonitorHandler
    rtpengine.callIdMap = rtpCallIdMap;

    logger.info(`RTPEngine client ready (with call-id tracking)`);
  }

  // Log SRTP mode
  const rtpHelper = require('./utils/rtp-helper');
  rtpHelper.logMode();
  require('./utils/turn-credentials').logMode();

  // 4. Initialize services
  const registrar = new Registrar(srf);
  const ringGroupHandler = new RingGroupHandler(srf, registrar, rtpengine);
  const trunkManager = new TrunkManager(srf);
  const timeConditionService = new TimeConditionService();
  const callRouter = new CallRouter(timeConditionService);
  const callHandler = new CallHandler(srf, registrar, rtpengine, ringGroupHandler, trunkManager, callRouter);

  // Toll-fraud destination guard — blocks high-risk/premium destinations and,
  // when an allow-list is configured, everything outside the countries you call.
  // Applied to dialled, click-to-call and dialer outbound alike.
  const OutboundGuard = require('./services/outbound-guard');
  const { SystemSettings } = require('./models');
  const outboundGuard = new OutboundGuard(SystemSettings);
  callHandler.outboundGuard = outboundGuard;
  logger.info(`Outbound guard: ${JSON.stringify(outboundGuard.summary())}`);

  // Security tracker — monitors attacks, manages IP blocking
  const SecurityTracker = require('./services/security-tracker');
  const securityTracker = new SecurityTracker();
  callHandler.securityTracker = securityTracker;
  registrar.securityTracker = securityTracker;
  const transferHandler = new TransferHandler(srf, registrar, callHandler, trunkManager, callRouter);
  const holdHandler = new HoldHandler(srf, rtpengine, callHandler);
  const parkHandler = new ParkHandler(srf, registrar, callHandler, holdHandler);
  const voicemailHandler = new VoicemailHandler(srf, rtpengine, callHandler);
  const dtmfListener = new DtmfListener();
  dtmfListener.start();
  const ivrHandler = new IvrHandler(srf, rtpengine, callHandler, registrar, ringGroupHandler, trunkManager, callRouter, voicemailHandler, dtmfListener);
  callHandler.transferHandler = transferHandler;
  callHandler.holdHandler = holdHandler;
  callHandler.parkHandler = parkHandler;
  callHandler.voicemailHandler = voicemailHandler;
  callHandler.ivrHandler = ivrHandler;

  const monitorHandler = new MonitorHandler(srf, rtpengine, callHandler, registrar);
  callHandler.monitorHandler = monitorHandler;

  // Web-call guests (Web Dialer Phase 2) — short-lived browser identities
  const WebCallGuestManager = require('./services/webcall-guest');
  const guestManager = new WebCallGuestManager();
  guestManager.securityTracker = securityTracker;
  guestManager.timeConditionService = timeConditionService;
  registrar.guestManager = guestManager;
  callHandler.guestManager = guestManager;
  logger.info(`Web dialer guests: ${guestManager.enabled ? 'enabled' : 'disabled (WEBCALL_ENABLED=false)'}`);

  // IVR / queue / voicemail own their dialogs, so the guest identity is
  // released when the call's CDR reaches a terminal state (Phase 3).
  const TERMINAL_CDR = ['completed', 'failed', 'missed', 'busy', 'voicemail', 'blocked'];
  guestManager.callEndedCheck = async (sipCallId) => {
    try {
      const { CDR } = require('./models');
      const cdr = await CDR.findOne({ sipCallId }, 'status').lean();
      return !!cdr && TERMINAL_CDR.includes(cdr.status);
    } catch (e) { return false; }
  };

  const presenceHandler = new PresenceHandler(srf, registrar, callHandler);
  callHandler.presenceHandler = presenceHandler;

  const queueHandler = new QueueHandler(srf, rtpengine, registrar, callHandler, voicemailHandler);
  callHandler.queueHandler = queueHandler;

  const appointmentHandler = new AppointmentHandler(srf, rtpengine, registrar, callHandler, ringGroupHandler);
  callHandler.appointmentHandler = appointmentHandler;
  // Reload pending appointment messages from DB
  setTimeout(() => appointmentHandler.reloadPendingMessages(), 5000);

  const dialerEngine = new DialerEngine(srf, rtpengine, registrar, trunkManager, callHandler, dtmfListener);
  callHandler.dialerEngine = dialerEngine;

  // Initialize CRM integrations
  callHandler.crmManager = crmManager;
  crmManager.initialize().catch(err => {
    logger.warn(`CRM Manager init: ${err.message}`);
  });

  // Initialize CRM disposition sync (auto call logging + disposition push)
  const DispositionSync = require('./services/crm/disposition-sync');
  const dispositionSync = new DispositionSync(crmManager);
  callHandler.dispositionSync = dispositionSync;

  // 5. Initialize trunks (register with providers)
  try {
    await trunkManager.initialize();
  } catch (err) {
    logger.warn(`Trunk initialization: ${err.message}`);
  }

  // 6. Background recording sync — converts pending pcaps and links to CDR
  startBackgroundSync();

  // 7. SIP handlers
  srf.register((req, res) => {
    registrar.handleRegister(req, res).catch(err => {
      logger.error(`Register error: ${err.message}`);
      if (!res.finalResponseSent) res.send(500);
    });
  });

  srf.invite((req, res) => {
    callHandler.handleInvite(req, res).catch(err => {
      logger.error(`Invite error: ${err.message}`);
      if (!res.finalResponseSent) res.send(500);
    });
  });

  srf.subscribe((req, res) => {
    presenceHandler.handleSubscribe(req, res).catch(err => {
      logger.error(`Subscribe error: ${err.message}`);
      if (!res.finalResponseSent) res.send(500);
    });
  });

  srf.options((req, res) => res.send(200));

  // 8. Express API + Web GUI
  const app = express();
  const cookieParser = require('cookie-parser');
  const path = require('path');
  const createWebRouter = require('./routes/web');

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));

  // ── Audio streaming endpoints ──
  //
  // These used to be public "shareable links": anyone who guessed or was
  // handed a callId could download a call recording or a voicemail without
  // logging in. They now require a session; recordings are restricted to
  // admins and supervisors, and a voicemail box to its owner.
  const { CDR: CDRModel, VoicemailMessage: VMModel } = require('./models');
  const fs = require('fs');
  const webAuth = require('./routes/web');
  const { safeResolve } = require('./utils/safe-path');

  function audioSession(req, res, next) {
    const session = webAuth.getSession(req.cookies && req.cookies.sid);
    if (!session) return res.status(401).json({ success: false, error: 'Unauthorized' });
    req.session = session;
    next();
  }

  app.get('/api/cdr/:callId/recording', audioSession, async (req, res) => {
    if (!['admin', 'supervisor'].includes(req.session.role)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const cdr = await CDRModel.findOne({ callId: req.params.callId });
      if (!cdr || !cdr.recordingPath) return res.status(404).json({ success: false, error: 'Recording not found' });
      if (!fs.existsSync(cdr.recordingPath)) return res.status(404).json({ success: false, error: 'Recording file missing' });
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${require('path').basename(cdr.recordingPath)}"`);
      fs.createReadStream(cdr.recordingPath).pipe(res);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/voicemail/:ext/:messageId/audio', audioSession, async (req, res) => {
    if (req.session.role === 'agent' && String(req.session.extension) !== String(req.params.ext)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const msg = await VMModel.findOne({ extension: req.params.ext, messageId: req.params.messageId });
      if (!msg || !msg.recordingPath) return res.status(404).json({ success: false, error: 'Message not found' });
      if (!fs.existsSync(msg.recordingPath)) return res.status(404).json({ success: false, error: 'Audio file missing' });
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${require('path').basename(msg.recordingPath)}"`);
      fs.createReadStream(msg.recordingPath).pipe(res);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Prompt/MOH playback for the settings page player
  const audioDir = process.env.MOH_DIR || '/opt/shadowpbx/audio';
  app.get('/api/audio/play/:filename', audioSession, (req, res) => {
    try {
      const filePath = safeResolve(audioDir, req.params.filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'File not found' });
      const ext = require('path').basename(filePath).split('.').pop().toLowerCase();
      res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${require('path').basename(filePath)}"`);
      fs.createReadStream(filePath).pipe(res);
    } catch (err) { res.status(err.status || 500).json({ success: false, error: err.message }); }
  });

  // Web-call token + widget config (PUBLIC — the browser widget calls these
  // before it has any credentials; rate-limited inside the guest manager)
  const webcallRoutes = require('./routes/webcall');
  app.use('/api', webcallRoutes.createWebcallPublicRouter({ guestManager }));

  // Appointment webhook routes (PUBLIC — Twilio/SignalWire must reach these)
  appointmentHandler.registerWebhookRoutes(app);

  // Dialer webhook routes (PUBLIC — carriers must reach these for AMD)
  dialerEngine.registerWebhookRoutes(app);

  // ── API authentication and authorization ──
  //
  // Browsers authenticate with their session cookie and are then held to
  // their role on every route; machine-to-machine callers use X-API-Key.
  // The master secret is no longer handed to the browser, and is no longer
  // accepted from the query string.
  const { createApiAuth, createApiRbac } = require('./middleware/api-auth');
  const webRoutes = require('./routes/web');
  app.use('/api', createApiAuth({ getSession: webRoutes.getSession, adminSecret: process.env.ADMIN_SECRET }));
  app.use('/api', createApiRbac());

  app.use('/api', createApiRouter(registrar, callHandler, trunkManager, transferHandler, holdHandler, parkHandler, voicemailHandler, ivrHandler, monitorHandler, timeConditionService, presenceHandler, queueHandler, appointmentHandler, dialerEngine, securityTracker));

  // WebRTC (Phase 1): bridge status + RTPEngine self-test (API-key protected)
  const webrtcRoutes = require('./routes/webrtc');
  app.use('/api', webrtcRoutes.createWebrtcApiRouter({ rtpengine, registrar, guestManager }));
  app.use('/api', webcallRoutes.createWebcallApiRouter({ guestManager }));
  // ─── Health & Monitoring Endpoint ───
  // Public liveness — intentionally minimal. A public endpoint must not reveal
  // operational detail (DB/RTPEngine state, trunk status, extension counts,
  // active calls, campaigns, memory). Load balancers and uptime checks only
  // need to know the process is up. Full diagnostics live behind auth below.
  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Detailed diagnostics — admin session only (Settings and monitoring use this).
  async function healthDetails(req, res) {
    const uptime = process.uptime();
    const mem = process.memoryUsage();
    const checks = { sip: 'ok', rtpengine: 'unknown', mongodb: 'ok', trunks: [] };

    try { if (mongoose.connection.readyState !== 1) checks.mongodb = 'disconnected'; }
    catch (e) { checks.mongodb = 'error'; }

    try {
      if (rtpengine) {
        const rtpConf = { host: process.env.RTPENGINE_HOST || '127.0.0.1', port: parseInt(process.env.RTPENGINE_PORT) || 22222 };
        const ping = await rtpengine.ping(rtpConf);
        checks.rtpengine = ping && ping.result === 'pong' ? 'ok' : 'error';
      } else { checks.rtpengine = 'not_configured'; }
    } catch (e) { checks.rtpengine = 'error'; }

    try { checks.trunks = await trunkManager.getStatus(); } catch (e) { checks.trunks = []; }

    let extOnline = 0, extTotal = 0;
    try {
      const { Extension } = require('./models');
      const exts = await Extension.find({}, 'extension').lean();
      extTotal = exts.length;
      for (const e of exts) { if (await registrar.isRegistered(e.extension)) extOnline++; }
    } catch (e) {}

    const activeCalls = callHandler.activeCalls ? callHandler.activeCalls.size : 0;
    const runningCampaigns = dialerEngine ? dialerEngine.getRunningCampaigns() : [];
    let dialerActiveCalls = 0;
    if (dialerEngine) { for (const [, c] of dialerEngine.activeCalls) dialerActiveCalls++; }

    try { checks.webrtc = rtpHelper.webrtcSummary(); } catch (e) { checks.webrtc = 'error'; }
    try { checks.webcall = guestManager.summary(); } catch (e) { checks.webcall = 'error'; }
    try { checks.outboundGuard = outboundGuard.summary(); } catch (e) { checks.outboundGuard = 'error'; }

    const overall = (checks.mongodb === 'ok' && checks.rtpengine === 'ok') ? 'healthy' :
                    (checks.mongodb === 'ok' ? 'degraded' : 'unhealthy');

    res.json({
      status: overall,
      service: 'ShadowPBX',
      version: '3.0.0',
      uptime: Math.round(uptime),
      uptimeHuman: `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024) + ' MB',
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB'
      },
      checks,
      extensions: { total: extTotal, online: extOnline },
      calls: { active: activeCalls },
      dialer: {
        runningCampaigns: runningCampaigns.length,
        activeCalls: dialerActiveCalls,
        campaigns: runningCampaigns.map(c => ({ name: c.name, strategy: c.strategy, agents: c.agentCounts }))
      }
    });
  }
  {
    const _web = require('./routes/web');
    app.get('/health/details', _web.authMiddleware, _web.adminOnly, healthDetails);
  }

  // WebRTC admin page + session-authenticated status/self-test
  app.use('/', webrtcRoutes.createWebrtcWebRouter({ rtpengine, registrar, guestManager }));
  app.use('/', webcallRoutes.createWebcallWebRouter({ guestManager }));

  // Self-update from Settings → System (admin session only)
  app.use('/', require('./routes/updates').createUpdateRouter({ callHandler }));

  // Web GUI routes
  app.use('/', createWebRouter());

  const apiPort = parseInt(process.env.API_PORT) || 3000;
  const http = require('http');
  const { Server: SocketIO } = require('socket.io');
  const server = http.createServer(app);
  const io = new SocketIO(server);

  // Socket.IO real-time updates
  const { ChatMessage } = require('./models');
  const socketUsers = new Map(); // username -> Set<socketId>

  // CRM Screen Pop handler — needs io + socketUsers + crmManager + callHandler
  const ScreenPopHandler = require('./services/crm/screen-pop');
  const screenPopHandler = new ScreenPopHandler(crmManager, io, socketUsers, callHandler);
  callHandler.screenPopHandler = screenPopHandler;

  // ── Socket.IO authentication ──
  //
  // Sockets used to be accepted unauthenticated, and identity was taken from
  // whatever the client sent (from / to / fromRole / username). Anyone who
  // could reach the port received the dashboard feed — extensions,
  // registrations, presence, trunks, recent CDRs, active calls, voicemail
  // counts — and could send or read chat as any user.
  //
  // Now the handshake is authenticated with the same session cookie as the
  // web UI, and the server decides who the caller is. The client may choose
  // a recipient; it can never choose a sender.
  io.use((socket, next) => {
    try {
      const raw = socket.handshake.headers.cookie || '';
      const sid = raw.split(';')
        .map(c => c.trim())
        .find(c => c.startsWith('sid='));
      const token = sid ? decodeURIComponent(sid.slice(4)) : null;
      const session = token ? webRoutes.getSession(token) : null;
      if (!session) {
        logger.warn(`GUI: socket rejected (no valid session) from ${socket.handshake.address}`);
        return next(new Error('unauthorized'));
      }
      socket.user = { username: session.user, role: session.role, extension: session.extension, name: session.name };
      next();
    } catch (e) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    logger.debug(`GUI: socket connected ${socket.id} as ${socket.user.username} (${socket.user.role})`);
    emitDashboardState(socket);

    // Register screen pop + click-to-call Socket.IO events
    screenPopHandler.registerSocket(socket);

    // Chat identity comes from the session, not the client. The event is kept
    // for compatibility with existing pages, but its argument is ignored.
    const chatUser = socket.user.username;
    socket.chatUser = chatUser;
    if (!socketUsers.has(chatUser)) socketUsers.set(chatUser, new Set());
    socketUsers.get(chatUser).add(socket.id);
    if (socket.user.extension) {
      const ext = String(socket.user.extension);
      if (!socketUsers.has(ext)) socketUsers.set(ext, new Set());
      socketUsers.get(ext).add(socket.id);   // screen pops are addressed by extension
    }

    socket.on('chat:register', () => {
      logger.debug(`Chat: ${chatUser} registered (socket ${socket.id})`);
    });

    // Chat: send message. The sender is always the session user.
    socket.on('chat:send', async (data) => {
      if (!data || !data.to || !data.text) return;
      if (data.from && data.from !== chatUser) {
        logger.warn(`Chat: ${chatUser} tried to send as ${data.from} — using their own identity`);
      }
      try {
        const msg = await ChatMessage.create({
          from: chatUser, to: String(data.to), text: String(data.text).slice(0, 4000),
          fromRole: socket.user.role, read: false
        });
        // Deliver to recipient if online
        const recipientSockets = socketUsers.get(data.to);
        if (recipientSockets) {
          recipientSockets.forEach(sid => {
            io.to(sid).emit('chat:message', msg.toObject());
          });
        }
        // Echo back to sender (for multi-tab)
        const senderSockets = socketUsers.get(chatUser);
        if (senderSockets) {
          senderSockets.forEach(sid => {
            io.to(sid).emit('chat:message', msg.toObject());
          });
        }
      } catch (e) { logger.debug(`Chat send error: ${e.message}`); }
    });

    // Chat: mark messages read — only messages addressed to this user
    socket.on('chat:read', async (data) => {
      if (!data || !data.from) return;
      try {
        await ChatMessage.updateMany(
          { from: String(data.from), to: chatUser, read: false },
          { $set: { read: true, readAt: new Date() } }
        );
        // Notify sender that messages were read
        const senderSockets = socketUsers.get(String(data.from));
        if (senderSockets) {
          senderSockets.forEach(sid => {
            io.to(sid).emit('chat:read', { from: String(data.from), to: chatUser });
          });
        }
      } catch (e) {}
    });

    // Chat: typing indicator
    socket.on('chat:typing', (data) => {
      if (!data || !data.to) return;
      const recipientSockets = socketUsers.get(String(data.to));
      if (recipientSockets) {
        recipientSockets.forEach(sid => {
          io.to(sid).emit('chat:typing', { from: chatUser });
        });
      }
    });

    socket.on('disconnect', () => {
      logger.debug(`GUI: socket disconnected ${socket.id}`);
      for (const key of [socket.chatUser, socket.user && socket.user.extension].filter(Boolean)) {
        const set = socketUsers.get(String(key));
        if (!set) continue;
        set.delete(socket.id);
        if (set.size === 0) socketUsers.delete(String(key));
      }
    });
  });

  // Broadcast dashboard state every 3 seconds
  async function emitDashboardState(target) {
    try {
      const { Extension, Trunk, CDR, VoicemailMessage } = require('./models');

      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      const [extensions, trunks, activeCalls, recentCDR, unreadVM, todayInbound, todayOutbound] = await Promise.all([
        Extension.find({}).lean(),
        Trunk.find({}, '-password').lean(),
        Promise.resolve(callHandler.getActiveCalls()),
        CDR.find({}).sort({ startTime: -1 }).limit(20).lean(),
        VoicemailMessage.countDocuments({ read: false }),
        CDR.countDocuments({ startTime: { $gte: todayStart }, direction: 'inbound' }),
        CDR.countDocuments({ startTime: { $gte: todayStart }, direction: 'outbound' })
      ]);

      // Enrich extensions with registration data and BLF state
      const enrichedExts = extensions.map(e => {
        const contacts = registrar.getContactsSync ? registrar.getContactsSync(e.extension) : [];
        const presence = presenceHandler ? presenceHandler.getState(e.extension) : { state: 'idle' };
        return { ...e, registrations: contacts, online: contacts.length > 0, presence: presence.state };
      });

      // Merge regular calls + dialer calls for dashboard
      let allActiveCalls = activeCalls || [];
      if (dialerEngine && dialerEngine.activeCalls) {
        for (const [id, call] of dialerEngine.activeCalls) {
          if (call.status === 'connected' || call.status === 'ringing') {
            allActiveCalls.push({
              callId: id,
              from: call.lead ? call.lead.phone : 'dialer',
              to: call.agentExt || '—',
              duration: call.connectedAt ? Math.round((Date.now() - call.connectedAt) / 1000) : 0,
              status: call.status === 'connected' ? 'answered' : call.status,
              source: 'dialer',
              leadName: call.lead ? call.lead.name : '',
              company: call.lead ? call.lead.company : ''
            });
          }
        }
      }

      const state = {
        activeCalls: allActiveCalls,
        extensions: enrichedExts,
        trunks,
        recentCDR,
        unreadVM,
        todayInbound: todayInbound || 0,
        todayOutbound: todayOutbound || 0,
        todayTotal: (todayInbound || 0) + (todayOutbound || 0),
        serverTime: new Date().toISOString(),
        presenceStats: presenceHandler ? { subscriptions: presenceHandler.subscriptions.size } : null
      };

      // Agents get their own view: they have no business seeing trunk
      // configuration or the whole CDR feed, both of which this used to
      // broadcast to every connected socket.
      const agentState = {
        ...state,
        trunks: [],
        recentCDR: (recentCDR || []).filter(c =>
          [c.from, c.to].some(v => v && String(v) === String(target.user && target.user.extension))),
        activeCalls: (allActiveCalls || []).filter(c =>
          [c.from, c.to].some(v => v && String(v) === String(target.user && target.user.extension)))
      };

      if (target.user) {
        // Single socket (on connect)
        target.emit('dashboard', target.user.role === 'agent' ? agentState : state);
      } else {
        // Periodic broadcast — split by role
        for (const [, sock] of io.sockets.sockets) {
          if (!sock.user) continue;
          if (sock.user.role === 'agent') {
            sock.emit('dashboard', {
              ...state,
              trunks: [],
              recentCDR: (recentCDR || []).filter(c =>
                [c.from, c.to].some(v => v && String(v) === String(sock.user.extension))),
              activeCalls: (allActiveCalls || []).filter(c =>
                [c.from, c.to].some(v => v && String(v) === String(sock.user.extension)))
            });
          } else {
            sock.emit('dashboard', state);
          }
        }
      }
    } catch (err) {
      logger.debug(`Dashboard state error: ${err.message}`);
    }
  }

  setInterval(() => emitDashboardState(io), 3000);

  // ─── Service Watchdog — monitors critical dependencies ───
  let lastRtpOk = true;
  let lastMongoOk = true;
  setInterval(async () => {
    // RTPEngine health check
    try {
      if (rtpengine) {
        const rtpConf = { host: process.env.RTPENGINE_HOST || '127.0.0.1', port: parseInt(process.env.RTPENGINE_PORT) || 22222 };
        const ping = await rtpengine.ping(rtpConf);
        const isOk = ping && ping.result === 'pong';
        if (!isOk && lastRtpOk) {
          logger.error('WATCHDOG: RTPEngine is NOT responding — media/recording may fail');
          // Auto-pause all dialer campaigns (no media = bad calls)
          if (dialerEngine) {
            for (const [id] of dialerEngine.runningCampaigns) {
              logger.warn(`WATCHDOG: auto-pausing campaign ${id} due to RTPEngine failure`);
              dialerEngine.pauseCampaign(id).catch(() => {});
            }
          }
        } else if (isOk && !lastRtpOk) {
          logger.info('WATCHDOG: RTPEngine recovered');
        }
        lastRtpOk = isOk;
      }
    } catch (e) {
      if (lastRtpOk) logger.error('WATCHDOG: RTPEngine check failed: ' + e.message);
      lastRtpOk = false;
    }

    // MongoDB health check
    try {
      const isOk = mongoose.connection.readyState === 1;
      if (!isOk && lastMongoOk) {
        logger.error('WATCHDOG: MongoDB connection lost');
      } else if (isOk && !lastMongoOk) {
        logger.info('WATCHDOG: MongoDB reconnected');
      }
      lastMongoOk = isOk;
    } catch (e) {}

  }, 30000); // every 30 seconds

  // ─── Trunk Registration Monitor — re-check trunk registrations every 5 min ───
  setInterval(async () => {
    try {
      const trunkStatus = await trunkManager.getStatus();
      for (const t of trunkStatus) {
        if (t.enabled && !t.registered) {
          logger.warn(`WATCHDOG: trunk "${t.name}" (${t.host}) is NOT registered — outbound calls may fail`);
        }
      }
    } catch (e) {}
  }, 300000); // every 5 minutes

  server.listen(apiPort, () => logger.info(`API + GUI on port ${apiPort}`));

  // ─── Startup Self-Check ───
  setTimeout(async () => {
    logger.info('Running startup self-check...');
    const issues = [];

    // MongoDB
    if (mongoose.connection.readyState !== 1) issues.push('MongoDB not connected');

    // RTPEngine
    try {
      if (rtpengine) {
        const rtpConf = { host: process.env.RTPENGINE_HOST || '127.0.0.1', port: parseInt(process.env.RTPENGINE_PORT) || 22222 };
        const ping = await rtpengine.ping(rtpConf);
        if (!ping || ping.result !== 'pong') issues.push('RTPEngine not responding');
      } else { issues.push('RTPEngine not configured'); }
    } catch (e) { issues.push('RTPEngine: ' + e.message); }

    // Trunks
    try {
      const trunkStatus = await trunkManager.getStatus();
      const enabledTrunks = trunkStatus.filter(t => t.enabled);
      const registeredTrunks = trunkStatus.filter(t => t.registered);
      if (enabledTrunks.length === 0) issues.push('No trunks configured');
      else if (registeredTrunks.length === 0) issues.push('No trunks registered (outbound will fail)');
    } catch (e) {}

    // Required env vars
    if (!process.env.EXTERNAL_IP) issues.push('EXTERNAL_IP not set');
    if (!process.env.ADMIN_SECRET) issues.push('ADMIN_SECRET not set');

    // Disk space check (recordings dir)
    try {
      const { execSync } = require('child_process');
      const df = execSync('df -h /var/lib/shadowpbx 2>/dev/null || df -h / 2>/dev/null').toString();
      const lines = df.trim().split('\n');
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const usePct = parseInt(parts[4]);
        if (usePct > 90) issues.push(`Disk usage critical: ${parts[4]} used`);
        else if (usePct > 80) logger.warn(`STARTUP: disk usage high: ${parts[4]}`);
      }
    } catch (e) {}

    if (issues.length === 0) {
      logger.info('Startup self-check: ALL OK');
    } else {
      logger.warn('Startup self-check: ' + issues.length + ' issue(s):');
      issues.forEach(i => logger.warn('  - ' + i));
    }
  }, 3000);

  // 9. Graceful shutdown
  let isShuttingDown = false;
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Shutdown signal received (${signal}), starting graceful shutdown...`);

    // Step 1: Pause all dialer campaigns (stop new calls, let active finish)
    try {
      await dialerEngine.shutdown();
      logger.info('Shutdown: dialer campaigns paused');
    } catch (e) { logger.warn(`Shutdown: dialer error: ${e.message}`); }

    // Step 2: Wait for active calls to finish (max 30 seconds)
    const activeCalls = callHandler.activeCalls ? callHandler.activeCalls.size : 0;
    if (activeCalls > 0) {
      logger.info(`Shutdown: waiting for ${activeCalls} active call(s) to finish (max 30s)...`);
      const waitStart = Date.now();
      while (callHandler.activeCalls && callHandler.activeCalls.size > 0 && (Date.now() - waitStart) < 30000) {
        await new Promise(r => setTimeout(r, 1000));
      }
      const remaining = callHandler.activeCalls ? callHandler.activeCalls.size : 0;
      if (remaining > 0) logger.warn(`Shutdown: ${remaining} call(s) still active, proceeding anyway`);
      else logger.info('Shutdown: all calls completed');
    }

    // Step 3: Disconnect CRM integrations
    try {
      await crmManager.shutdown();
      logger.info('Shutdown: CRM integrations disconnected');
    } catch (e) { logger.warn(`Shutdown: CRM error: ${e.message}`); }

    // Step 4: Close Socket.IO connections
    try {
      io.disconnectSockets(true);
      logger.info('Shutdown: Socket.IO connections closed');
    } catch (e) {}

    // Step 4: Close HTTP server
    try {
      await new Promise((resolve) => { server.close(resolve); setTimeout(resolve, 5000); });
      logger.info('Shutdown: HTTP server closed');
    } catch (e) {}

    // Step 5: Disconnect MongoDB
    try {
      await mongoose.disconnect();
      logger.info('Shutdown: MongoDB disconnected');
    } catch (e) {}

    logger.info('Shutdown complete. Goodbye.');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Note: uncaughtException / unhandledRejection are handled once at the top of
  // this file (see fatal()), so they are not re-registered here.

  logger.info('===========================================');
  logger.info('  ShadowPBX v3.0 Ready!');
  logger.info(`  SIP: ${process.env.EXTERNAL_IP}:${process.env.SIP_PORT || 5060}`);
  logger.info(`  API: http://localhost:${apiPort}/api`);
  logger.info('===========================================');
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
