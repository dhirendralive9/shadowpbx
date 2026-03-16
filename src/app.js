require('dotenv').config();
const Srf = require('drachtio-srf');
const mongoose = require('mongoose');
const express = require('express');
const logger = require('./utils/logger');
const Registrar = require('./services/registrar');
const CallHandler = require('./services/call-handler');
const createApiRouter = require('./routes/api');

// Try to load rtpengine client (optional - recording won't work without it)
let RtpEngineClient;
try {
  RtpEngineClient = require('rtpengine-client').Client;
} catch (e) {
  logger.warn('rtpengine-client not available - call recording disabled');
}

async function main() {
  logger.info('===========================================');
  logger.info('  ShadowPBX v1.0 Starting...');
  logger.info('===========================================');

  // ============================================================
  // 1. Connect to MongoDB
  // ============================================================
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadowpbx';
  try {
    await mongoose.connect(mongoUri);
    logger.info(`MongoDB connected: ${mongoUri}`);
  } catch (err) {
    logger.error(`MongoDB connection failed: ${err.message}`);
    process.exit(1);
  }

  // ============================================================
  // 2. Connect to Drachtio server
  // ============================================================
  const srf = new Srf();

  srf.connect({
    host: process.env.DRACHTIO_HOST || '127.0.0.1',
    port: parseInt(process.env.DRACHTIO_PORT) || 9022,
    secret: process.env.DRACHTIO_SECRET || 'cymru'
  });

  srf.on('connect', (err, hp) => {
    if (err) {
      logger.error(`Drachtio connection failed: ${err}`);
      return;
    }
    logger.info(`Drachtio connected, listening on ${hp}`);
  });

  srf.on('error', (err) => {
    logger.error(`Drachtio error: ${err.message}`);
    // Will auto-reconnect
  });

  // ============================================================
  // 3. Initialize RTPEngine client (optional)
  // ============================================================
  let rtpengine = null;
  if (RtpEngineClient) {
    rtpengine = new RtpEngineClient();
    logger.info(`RTPEngine client initialized (${process.env.RTPENGINE_HOST}:${process.env.RTPENGINE_PORT})`);
  }

  // ============================================================
  // 4. Initialize services
  // ============================================================
  const registrar = new Registrar(srf);
  const callHandler = new CallHandler(srf, registrar, rtpengine);

  // ============================================================
  // 5. SIP request handlers
  // ============================================================

  // Handle REGISTER
  srf.register((req, res) => {
    registrar.handleRegister(req, res).catch(err => {
      logger.error(`Register error: ${err.message}`);
      if (!res.finalResponseSent) res.send(500);
    });
  });

  // Handle INVITE (calls)
  srf.invite((req, res) => {
    callHandler.handleInvite(req, res).catch(err => {
      logger.error(`Invite error: ${err.message}`);
      if (!res.finalResponseSent) res.send(500);
    });
  });

  // Handle OPTIONS (keepalive/ping)
  srf.options((req, res) => {
    res.send(200);
  });

  // Handle BYE, CANCEL, etc are managed by drachtio dialog layer

  // ============================================================
  // 6. Express API server
  // ============================================================
  const app = express();
  app.use(express.json());

  // Simple auth middleware
  app.use('/api', (req, res, next) => {
    const token = req.headers['x-api-key'] || req.query.apikey;
    if (token !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    next();
  });

  app.use('/api', createApiRouter(registrar, callHandler));

  // Public health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ShadowPBX' });
  });

  const apiPort = parseInt(process.env.API_PORT) || 3000;
  app.listen(apiPort, () => {
    logger.info(`API server listening on port ${apiPort}`);
  });

  // ============================================================
  // 7. Graceful shutdown
  // ============================================================
  process.on('SIGINT', async () => {
    logger.info('Shutting down ShadowPBX...');
    await mongoose.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down ShadowPBX...');
    await mongoose.disconnect();
    process.exit(0);
  });

  logger.info('===========================================');
  logger.info('  ShadowPBX v1.0 Ready!');
  logger.info(`  SIP: ${process.env.EXTERNAL_IP}:${process.env.SIP_PORT || 5060}`);
  logger.info(`  API: http://localhost:${apiPort}/api`);
  logger.info('===========================================');
}

main().catch(err => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
