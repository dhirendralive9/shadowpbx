require('dotenv').config();
const Srf = require('drachtio-srf');
const mongoose = require('mongoose');
const express = require('express');
const logger = require('./utils/logger');
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
const createApiRouter = require('./routes/api');
const { convertAllPending } = require('./utils/converter');

let RtpEngineClient;
try {
  RtpEngineClient = require('rtpengine-client').Client;
} catch (e) {
  logger.warn('rtpengine-client not available - recording disabled');
}

async function main() {
  logger.info('===========================================');
  logger.info('  ShadowPBX v2.0 Starting...');
  logger.info('===========================================');

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

  // 4. Initialize services
  const registrar = new Registrar(srf);
  const ringGroupHandler = new RingGroupHandler(srf, registrar, rtpengine);
  const trunkManager = new TrunkManager(srf);
  const timeConditionService = new TimeConditionService();
  const callRouter = new CallRouter(timeConditionService);
  const callHandler = new CallHandler(srf, registrar, rtpengine, ringGroupHandler, trunkManager, callRouter);
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

  const presenceHandler = new PresenceHandler(srf, registrar, callHandler);
  callHandler.presenceHandler = presenceHandler;

  const queueHandler = new QueueHandler(srf, rtpengine, registrar, callHandler, voicemailHandler);
  callHandler.queueHandler = queueHandler;

  // 5. Initialize trunks (register with providers)
  try {
    await trunkManager.initialize();
  } catch (err) {
    logger.warn(`Trunk initialization: ${err.message}`);
  }

  // 6. Convert pending recordings from previous session
  setTimeout(() => convertAllPending(), 5000);

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

  // Public audio endpoints (no auth — shareable/downloadable links)
  const { CDR: CDRModel, VoicemailMessage: VMModel } = require('./models');
  const fs = require('fs');

  app.get('/api/cdr/:callId/recording', async (req, res) => {
    try {
      const cdr = await CDRModel.findOne({ callId: req.params.callId });
      if (!cdr || !cdr.recordingPath) return res.status(404).json({ success: false, error: 'Recording not found' });
      if (!fs.existsSync(cdr.recordingPath)) return res.status(404).json({ success: false, error: 'Recording file missing' });
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${require('path').basename(cdr.recordingPath)}"`);
      fs.createReadStream(cdr.recordingPath).pipe(res);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  app.get('/api/voicemail/:ext/:messageId/audio', async (req, res) => {
    try {
      const msg = await VMModel.findOne({ extension: req.params.ext, messageId: req.params.messageId });
      if (!msg || !msg.recordingPath) return res.status(404).json({ success: false, error: 'Message not found' });
      if (!fs.existsSync(msg.recordingPath)) return res.status(404).json({ success: false, error: 'Audio file missing' });
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${require('path').basename(msg.recordingPath)}"`);
      fs.createReadStream(msg.recordingPath).pipe(res);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // API auth middleware
  app.use('/api', (req, res, next) => {
    const token = req.headers['x-api-key'] || req.query.apikey;
    if (token !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
  });

  app.use('/api', createApiRouter(registrar, callHandler, trunkManager, transferHandler, holdHandler, parkHandler, voicemailHandler, ivrHandler, monitorHandler, timeConditionService, presenceHandler, queueHandler));
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'ShadowPBX', version: '2.0.0' }));

  // Web GUI routes
  app.use('/', createWebRouter(process.env.ADMIN_SECRET));

  const apiPort = parseInt(process.env.API_PORT) || 3000;
  const http = require('http');
  const { Server: SocketIO } = require('socket.io');
  const server = http.createServer(app);
  const io = new SocketIO(server);

  // Socket.IO real-time updates
  io.on('connection', (socket) => {
    logger.debug(`GUI: socket connected ${socket.id}`);
    // Send initial state immediately
    emitDashboardState(socket);

    socket.on('disconnect', () => {
      logger.debug(`GUI: socket disconnected ${socket.id}`);
    });
  });

  // Broadcast dashboard state every 3 seconds
  async function emitDashboardState(target) {
    try {
      const { Extension, Trunk, CDR, VoicemailMessage } = require('./models');
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const [extensions, trunks, activeCalls, todayCalls, recentCDR, unreadVM] = await Promise.all([
        Extension.find({}).lean(),
        Trunk.find({}, '-password').lean(),
        Promise.resolve(callHandler.getActiveCalls()),
        CDR.countDocuments({ startTime: { $gte: today } }),
        CDR.find({}).sort({ startTime: -1 }).limit(8).lean(),
        VoicemailMessage.countDocuments({ read: false })
      ]);

      // Enrich extensions with registration data and BLF state
      const enrichedExts = extensions.map(e => {
        const contacts = registrar.getContactsSync ? registrar.getContactsSync(e.extension) : [];
        const presence = presenceHandler ? presenceHandler.getState(e.extension) : { state: 'idle' };
        return { ...e, registrations: contacts, online: contacts.length > 0, presence: presence.state };
      });

      const state = {
        activeCalls: activeCalls || [],
        extensions: enrichedExts,
        trunks,
        todayCalls,
        recentCDR,
        unreadVM,
        presenceStats: presenceHandler ? { subscriptions: presenceHandler.subscriptions.size } : null
      };

      if (target.emit) {
        target.emit('dashboard', state);
      } else {
        target.emit('dashboard', state);
      }
    } catch (err) {
      logger.debug(`Dashboard state error: ${err.message}`);
    }
  }

  setInterval(() => emitDashboardState(io), 3000);

  server.listen(apiPort, () => logger.info(`API + GUI on port ${apiPort}`));

  // 9. Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('===========================================');
  logger.info('  ShadowPBX v2.0 Ready!');
  logger.info(`  SIP: ${process.env.EXTERNAL_IP}:${process.env.SIP_PORT || 5060}`);
  logger.info(`  API: http://localhost:${apiPort}/api`);
  logger.info('===========================================');
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
