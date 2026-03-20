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
  if (RtpEngineClient) {
    rtpengine = new RtpEngineClient();
    logger.info(`RTPEngine client ready`);
  }

  // 4. Initialize services
  const registrar = new Registrar(srf);
  const ringGroupHandler = new RingGroupHandler(srf, registrar, rtpengine);
  const trunkManager = new TrunkManager(srf);
  const callRouter = new CallRouter();
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

  srf.options((req, res) => res.send(200));

  // 8. Express API
  const app = express();
  app.use(express.json());

  app.use('/api', (req, res, next) => {
    const token = req.headers['x-api-key'] || req.query.apikey;
    if (token !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
  });

  app.use('/api', createApiRouter(registrar, callHandler, trunkManager, transferHandler, holdHandler, parkHandler, voicemailHandler, ivrHandler));
  app.get('/health', (req, res) => res.json({ status: 'ok', service: 'ShadowPBX', version: '2.0.0' }));

  const apiPort = parseInt(process.env.API_PORT) || 3000;
  app.listen(apiPort, () => logger.info(`API on port ${apiPort}`));

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
