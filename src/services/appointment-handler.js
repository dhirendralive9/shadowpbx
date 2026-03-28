const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const VM_DIR = process.env.VOICEMAIL_DIR || '/var/lib/shadowpbx/voicemail';
const APPT_DIR = path.join(VM_DIR, 'appointments');
const AUDIO_HOST_DIR = process.env.MOH_DIR || '/opt/shadowpbx/audio';

const PATH_MAP = [
  { host: AUDIO_HOST_DIR, container: '/audio' },
  { host: VM_DIR, container: '/voicemail' },
  { host: process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings', container: '/recordings' }
];

function toContainerPath(hostPath) {
  if (!hostPath) return hostPath;
  for (const m of PATH_MAP) {
    if (hostPath.startsWith(m.host)) return hostPath.replace(m.host, m.container);
  }
  if (hostPath.startsWith('/audio/') || hostPath.startsWith('/voicemail/') || hostPath.startsWith('/recordings/')) return hostPath;
  return hostPath;
}

// ============================================================
// Appointment Handler — Twilio Webhook + Internal Callback
//
// INBOUND (Twilio webhook — no SIP trunk needed for this DID):
//   1. Twilio calls POST /webhook/appointment/:number/voice
//   2. App returns TwiML: <Play> greeting → <Record> with callback
//   3. Twilio POSTs recording URL to /webhook/appointment/:number/recording
//   4. App downloads the WAV from Twilio and queues callback
//
// CALLBACK (Internal Drachtio/RTPEngine — zero PSTN cost):
//   5. Queue processor monitors extension/RG presence every 5s
//   6. When agent online → originate internal call via Drachtio
//      using caller's number as CID
//   7. Agent picks up → 3s pause → play recorded WAV via RTPEngine
//   8. Playback done → auto hangup
//   9. If nobody picks up → retry next cycle
//
// CARRIER ABSTRACTION:
//   Currently Twilio. The webhook pattern is the same for
//   SignalWire (LaML) and Telnyx (TeXML) — future modules
//   just need different auth validation.
// ============================================================

class AppointmentHandler {
  constructor(srf, rtpengine, registrar, callHandler, ringGroupHandler) {
    this.srf = srf;
    this.rtpengine = rtpengine;
    this.registrar = registrar;
    this.callHandler = callHandler;
    this.ringGroupHandler = ringGroupHandler;
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };

    // Message queue: array of { messageId, appointmentNumber, callerID,
    //   recordingPath, recordingUrl, destination, createdAt, attempts, status }
    this.messageQueue = [];

    // Currently active callback call (only one at a time)
    this.activeCallback = null;

    // Ensure directory exists
    if (!fs.existsSync(APPT_DIR)) {
      try { fs.mkdirSync(APPT_DIR, { recursive: true }); } catch (e) {}
    }

    // Start presence monitor — check every 5 seconds
    this._presenceInterval = setInterval(() => this._processQueue(), 5000);

    logger.info(`Appointment: webhook handler initialized, recordings dir=${APPT_DIR}`);
  }

  // ============================================================
  // WEBHOOK: /webhook/appointment/:number/voice
  //
  // Called by Twilio when someone dials the TFN.
  // Returns TwiML to play greeting and record the message.
  // ============================================================
  async handleVoiceWebhook(req, res, appointmentNumber) {
    const { Appointment } = require('../models');
    const appt = await Appointment.findOne({ number: appointmentNumber, enabled: true });

    if (!appt) {
      logger.warn(`APPOINTMENT WEBHOOK: appointment ${appointmentNumber} not found`);
      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, this service is not available.</Say><Hangup/></Response>`);
      return;
    }

    const callerID = req.body.From || req.body.Caller || 'unknown';
    const callSid = req.body.CallSid || '';
    logger.info(`APPOINTMENT WEBHOOK: ${callerID} -> APPT:${appointmentNumber} (${appt.name}) CallSid=${callSid}`);

    // Build the public base URL for callbacks
    const baseUrl = this._getBaseUrl(req);
    const recordingCallbackUrl = `${baseUrl}/webhook/appointment/${appointmentNumber}/recording`;

    // Build greeting URL — if it's a local audio file, serve it via our own endpoint
    let greetingXml = '';
    if (appt.greeting) {
      const greetingUrl = `${baseUrl}/webhook/appointment/audio/${encodeURIComponent(path.basename(appt.greeting))}`;
      greetingXml = `<Play>${greetingUrl}</Play>`;
    } else {
      greetingXml = `<Say voice="alice">Hello, please leave your name and a brief message after the beep. We will call you back shortly.</Say>`;
    }

    // Create CDR for tracking
    const { CDR } = require('../models');
    try {
      await CDR.create({
        callId: uuidv4(),
        sipCallId: callSid,
        from: callerID,
        to: `APPT:${appointmentNumber}`,
        direction: 'inbound',
        status: 'answered',
        startTime: new Date(),
        answerTime: new Date(),
        didNumber: req.body.To || req.body.Called || '',
        trunkUsed: 'twilio-webhook',
        hangupCause: 'appointment'
      });
    } catch (e) {
      logger.debug(`APPOINTMENT CDR: ${e.message}`);
    }

    // Return TwiML
    const maxLength = appt.maxRecordingLength || 120;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greetingXml}
  <Record maxLength="${maxLength}" action="${recordingCallbackUrl}" recordingStatusCallback="${recordingCallbackUrl}" recordingStatusCallbackEvent="completed" playBeep="true" trim="trim-silence"/>
  <Say voice="alice">We did not receive your message. Goodbye.</Say>
  <Hangup/>
</Response>`;

    logger.info(`APPOINTMENT WEBHOOK: returning TwiML for ${appointmentNumber}`);
    res.type('text/xml').send(twiml);
  }

  // ============================================================
  // WEBHOOK: /webhook/appointment/:number/recording
  //
  // Called by Twilio after recording completes.
  // Twilio sends RecordingUrl, RecordingDuration, etc.
  // We download the WAV and queue the callback.
  // ============================================================
  async handleRecordingWebhook(req, res, appointmentNumber) {
    // Respond immediately so Twilio doesn't retry
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="alice">Thank you. We will call you back shortly.</Say><Hangup/></Response>`);

    const { Appointment, AppointmentMessage } = require('../models');
    const appt = await Appointment.findOne({ number: appointmentNumber, enabled: true });

    if (!appt) {
      logger.warn(`APPOINTMENT RECORDING: appointment ${appointmentNumber} not found`);
      return;
    }

    const callerID = (req.body.From || req.body.Caller || 'unknown').replace(/^\+/, '');
    const recordingUrl = req.body.RecordingUrl || '';
    const recordingSid = req.body.RecordingSid || '';
    const duration = parseInt(req.body.RecordingDuration) || 0;
    const callSid = req.body.CallSid || '';

    if (!recordingUrl) {
      logger.warn(`APPOINTMENT RECORDING: no RecordingUrl in webhook body`);
      logger.debug(`APPOINTMENT RECORDING: body keys=${Object.keys(req.body).join(',')}`);
      return;
    }

    logger.info(`APPOINTMENT RECORDING: ${callerID} -> APPT:${appointmentNumber} duration=${duration}s url=${recordingUrl} sid=${recordingSid}`);

    // Skip very short messages
    if (duration < 2) {
      logger.info(`APPOINTMENT RECORDING: message too short (${duration}s), discarding`);
      return;
    }

    const messageId = uuidv4();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const localFilename = `${timestamp}_${appointmentNumber}_${callerID}.wav`;
    const localPath = path.join(APPT_DIR, localFilename);

    // Download the recording from Twilio (append .wav for WAV format)
    const wavUrl = recordingUrl.endsWith('.wav') ? recordingUrl : recordingUrl + '.wav';

    try {
      await this._downloadFile(wavUrl, localPath);
      const fileSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
      logger.info(`APPOINTMENT RECORDING: downloaded to ${localPath} (${fileSize} bytes)`);

      // Save to DB
      await AppointmentMessage.create({
        messageId,
        appointmentNumber,
        callerID,
        duration,
        recordingPath: localPath,
        recordingUrl: wavUrl,
        fileSize,
        status: 'pending',
        callSid
      });

      // Add to in-memory queue
      this.messageQueue.push({
        messageId,
        appointmentNumber,
        callerID,
        recordingPath: localPath,
        recordingUrl: wavUrl,
        destination: appt.destination,
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending'
      });

      logger.info(`APPOINTMENT QUEUED: ${callerID} -> ${appt.destination.type}:${appt.destination.target} (${this.messageQueue.length} in queue)`);

    } catch (dlErr) {
      logger.error(`APPOINTMENT RECORDING: download failed: ${dlErr.message}`);

      // Still queue with URL fallback — can retry download later
      await AppointmentMessage.create({
        messageId,
        appointmentNumber,
        callerID,
        duration,
        recordingUrl: wavUrl,
        fileSize: 0,
        status: 'pending',
        callSid
      });

      this.messageQueue.push({
        messageId,
        appointmentNumber,
        callerID,
        recordingPath: null,
        recordingUrl: wavUrl,
        destination: appt.destination,
        createdAt: Date.now(),
        attempts: 0,
        status: 'pending'
      });
    }
  }

  // ============================================================
  // WEBHOOK: /webhook/appointment/audio/:filename
  //
  // Serves local audio files to Twilio for <Play> in TwiML.
  // No auth — Twilio needs public access.
  // ============================================================
  serveAudioFile(req, res) {
    const filename = req.params.filename.replace(/\.\./g, '');
    const audioDir = process.env.MOH_DIR || '/opt/shadowpbx/audio';
    const filePath = path.join(audioDir, filename);

    if (!fs.existsSync(filePath)) {
      logger.warn(`APPOINTMENT AUDIO: file not found: ${filename}`);
      return res.status(404).send('Not found');
    }

    const ext = filename.split('.').pop().toLowerCase();
    res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    fs.createReadStream(filePath).pipe(res);
  }

  // ============================================================
  // LEGACY SIP HANDLER — still works for non-Twilio trunks
  //
  // Called from call-handler when inbound route points to
  // appointment AND the call came in via SIP trunk (not webhook).
  // Falls back to a simple message.
  // ============================================================
  async handleAppointment(req, res, apptConfig, cdr) {
    logger.info(`APPOINTMENT SIP: ${cdr.from} -> APPT:${apptConfig.number} — use Twilio webhook for best quality`);
    if (!res.finalResponseSent) {
      res.send(503);
    }
    return false;
  }

  // ============================================================
  // CALLBACK QUEUE PROCESSOR
  //
  // Runs every 5 seconds. For each pending message:
  //   - Check if target extension/ring group has anyone online
  //   - If yes → originate internal call via Drachtio
  //   - Play the downloaded WAV via RTPEngine playMedia
  // ============================================================
  async _processQueue() {
    if (this.activeCallback) return;
    if (this.messageQueue.length === 0) return;

    const msg = this.messageQueue.find(m => m.status === 'pending');
    if (!msg) return;

    const { destination } = msg;
    if (!destination) {
      msg.status = 'failed';
      this._removeFromQueue(msg.messageId);
      return;
    }

    try {
      let targetOnline = false;
      let targetContacts = [];

      if (destination.type === 'extension') {
        const contacts = await this.registrar.getContacts(destination.target);
        if (contacts.length > 0) {
          targetOnline = true;
          targetContacts = [{ ext: destination.target, contacts }];
        }
      } else if (destination.type === 'ringgroup') {
        const { RingGroup } = require('../models');
        const rg = await RingGroup.findOne({ number: destination.target, enabled: true });
        if (rg && rg.members) {
          for (const member of rg.members) {
            const contacts = await this.registrar.getContacts(member);
            if (contacts.length > 0) {
              targetOnline = true;
              targetContacts.push({ ext: member, contacts });
            }
          }
        }
      }

      if (!targetOnline) return;

      // Ensure we have the recording file locally
      if (!msg.recordingPath || !fs.existsSync(msg.recordingPath)) {
        if (msg.recordingUrl) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const localPath = path.join(APPT_DIR, `${timestamp}_${msg.appointmentNumber}_${msg.callerID}.wav`);
          try {
            await this._downloadFile(msg.recordingUrl, localPath);
            msg.recordingPath = localPath;
            logger.info(`APPOINTMENT CALLBACK: re-downloaded recording to ${localPath}`);
          } catch (dlErr) {
            logger.error(`APPOINTMENT CALLBACK: download failed: ${dlErr.message}`);
            return;
          }
        } else {
          logger.warn(`APPOINTMENT CALLBACK: no recording for ${msg.messageId}`);
          msg.status = 'failed';
          this._removeFromQueue(msg.messageId);
          return;
        }
      }

      msg.status = 'delivering';
      msg.attempts++;
      this.activeCallback = msg.messageId;

      logger.info(`APPOINTMENT CALLBACK: calling ${destination.type}:${destination.target} for message from ${msg.callerID}`);

      await this._originateCallback(msg, targetContacts);

    } catch (err) {
      logger.error(`APPOINTMENT QUEUE: error: ${err.message}`);
      msg.status = 'pending';
      this.activeCallback = null;
    }
  }

  // ============================================================
  // ORIGINATE CALLBACK — ring target extension(s)
  // ============================================================
  async _originateCallback(msg, targetContacts) {
    const { callerID, recordingPath, messageId } = msg;

    if (!fs.existsSync(recordingPath)) {
      logger.warn(`APPOINTMENT CALLBACK: recording missing ${recordingPath}`);
      msg.status = 'failed';
      this.activeCallback = null;
      this._removeFromQueue(messageId);
      return;
    }

    const targets = [];
    for (const tc of targetContacts) {
      const contact = tc.contacts.sort((a, b) => {
        const ta = a.registeredAt ? new Date(a.registeredAt).getTime() : 0;
        const tb = b.registeredAt ? new Date(b.registeredAt).getTime() : 0;
        return tb - ta;
      })[0];
      if (contact) {
        targets.push({ ext: tc.ext, uri: `sip:${tc.ext}@${contact.ip}:${contact.port}` });
      }
    }

    if (targets.length === 0) {
      msg.status = 'pending';
      this.activeCallback = null;
      return;
    }

    const target = targets[0];
    const sipDomain = process.env.SIP_DOMAIN || 'shadowpbx';
    const externalIp = process.env.EXTERNAL_IP || '127.0.0.1';

    try {
      logger.info(`APPOINTMENT CALLBACK: originating ${callerID} -> ${target.ext} at ${target.uri}`);

      const uac = await this.srf.createUAC(target.uri, {
        headers: {
          'From': `<sip:${callerID}@${sipDomain}>`,
          'To': `<sip:${target.ext}@${sipDomain}>`,
          'Contact': `<sip:${callerID}@${externalIp}>`
        },
        callingNumber: callerID
      });

      logger.info(`APPOINTMENT CALLBACK: ${target.ext} answered — playing message from ${callerID}`);

      const sipCallId = uac.sip ? uac.sip.callId : `appt-cb-${messageId}`;
      let agentHungUp = false;

      uac.on('destroy', () => {
        agentHungUp = true;
        logger.info(`APPOINTMENT CALLBACK: agent ${target.ext} hung up`);
      });

      // 3 second delay
      await this._sleep(3000);
      if (agentHungUp) { this._callbackComplete(msg, false); return; }

      // Play the recorded message via RTPEngine
      if (this.rtpengine) {
        const fromTag = uac.sip ? uac.sip.remoteTag : '';
        try {
          const rtpHelper = require('../utils/rtp-helper');
          const rtpOffer = await rtpHelper.offer(this.rtpengine, sipCallId, fromTag, uac.remote.sdp);

          if (rtpOffer) {
            try { await uac.modify(rtpOffer.sdp); } catch (modErr) {
              logger.debug(`APPOINTMENT CALLBACK: re-INVITE: ${modErr.message}`);
            }

            await this._sleep(500);

            logger.info(`APPOINTMENT CALLBACK: playing ${recordingPath}`);
            await this.rtpengine.playMedia(this.rtpengineConfig, {
              'call-id': sipCallId,
              'from-tag': fromTag,
              file: toContainerPath(recordingPath)
            });

            // Wait for playback
            const fileSize = fs.statSync(recordingPath).size;
            const estimatedMs = Math.max(3000, Math.round(fileSize / 16));
            logger.info(`APPOINTMENT CALLBACK: waiting ${estimatedMs}ms for playback`);

            const waitStep = 500;
            let waited = 0;
            while (waited < estimatedMs && !agentHungUp) {
              await this._sleep(Math.min(waitStep, estimatedMs - waited));
              waited += waitStep;
            }

            await rtpHelper.del(this.rtpengine, sipCallId, fromTag);
          }
        } catch (playErr) {
          logger.warn(`APPOINTMENT CALLBACK: playback failed: ${playErr.message}`);
        }
      }

      // Done — hang up
      if (!agentHungUp) {
        await this._sleep(1000);
        try { uac.destroy(); } catch (e) {}
      }

      this._callbackComplete(msg, true);

    } catch (err) {
      logger.error(`APPOINTMENT CALLBACK: failed for ${target.ext}: ${err.message} (status=${err.status})`);
      if (err.status === 480 || err.status === 408 || err.status === 487) {
        msg.status = 'pending';
        if (msg.attempts >= 10) {
          msg.status = 'failed';
          logger.warn(`APPOINTMENT CALLBACK: giving up after ${msg.attempts} attempts`);
          this._removeFromQueue(messageId);
        }
      } else {
        msg.status = 'pending';
      }
      this.activeCallback = null;
    }
  }

  // ============================================================
  // Callback complete
  // ============================================================
  _callbackComplete(msg, success) {
    if (success) {
      msg.status = 'delivered';
      logger.info(`APPOINTMENT DELIVERED: message from ${msg.callerID} to ${msg.destination.type}:${msg.destination.target}`);
    } else {
      msg.status = 'pending';
    }

    const { AppointmentMessage } = require('../models');
    AppointmentMessage.findOneAndUpdate(
      { messageId: msg.messageId },
      { status: msg.status, attempts: msg.attempts, deliveredAt: success ? new Date() : undefined }
    ).catch(e => logger.debug(`APPOINTMENT DB update: ${e.message}`));

    if (success) this._removeFromQueue(msg.messageId);
    this.activeCallback = null;
  }

  _removeFromQueue(messageId) {
    this.messageQueue = this.messageQueue.filter(m => m.messageId !== messageId);
  }

  // ============================================================
  // Reload pending messages from DB on startup
  // ============================================================
  async reloadPendingMessages() {
    try {
      const { AppointmentMessage, Appointment } = require('../models');
      const pending = await AppointmentMessage.find({ status: 'pending' }).sort({ createdAt: 1 });

      for (const msg of pending) {
        const appt = await Appointment.findOne({ number: msg.appointmentNumber, enabled: true });
        if (!appt) continue;

        const hasFile = msg.recordingPath && fs.existsSync(msg.recordingPath);
        const hasUrl = !!msg.recordingUrl;
        if (!hasFile && !hasUrl) continue;

        this.messageQueue.push({
          messageId: msg.messageId,
          appointmentNumber: msg.appointmentNumber,
          callerID: msg.callerID,
          recordingPath: hasFile ? msg.recordingPath : null,
          recordingUrl: msg.recordingUrl || null,
          destination: appt.destination,
          createdAt: msg.createdAt.getTime(),
          attempts: msg.attempts || 0,
          status: 'pending'
        });
      }

      if (this.messageQueue.length > 0) {
        logger.info(`APPOINTMENT: reloaded ${this.messageQueue.length} pending message(s)`);
      }
    } catch (err) {
      logger.warn(`APPOINTMENT: reload pending failed: ${err.message}`);
    }
  }

  // ============================================================
  // Register Express webhook routes (called from app.js)
  //
  // These are PUBLIC — no API key auth.
  // Twilio/SignalWire/Telnyx must be able to POST to them.
  // ============================================================
  registerWebhookRoutes(app) {
    app.post('/webhook/appointment/:number/voice', (req, res) => {
      this.handleVoiceWebhook(req, res, req.params.number).catch(err => {
        logger.error(`APPOINTMENT WEBHOOK voice: ${err.message}`);
        res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>An error occurred.</Say><Hangup/></Response>`);
      });
    });

    app.post('/webhook/appointment/:number/recording', (req, res) => {
      this.handleRecordingWebhook(req, res, req.params.number).catch(err => {
        logger.error(`APPOINTMENT WEBHOOK recording: ${err.message}`);
        if (!res.headersSent) res.status(200).send('OK');
      });
    });

    app.get('/webhook/appointment/audio/:filename', (req, res) => {
      this.serveAudioFile(req, res);
    });

    logger.info('APPOINTMENT: webhook routes registered at /webhook/appointment/');
  }

  // ============================================================
  // Helpers
  // ============================================================
  getQueueStatus() {
    return {
      total: this.messageQueue.length,
      pending: this.messageQueue.filter(m => m.status === 'pending').length,
      delivering: this.messageQueue.filter(m => m.status === 'delivering').length,
      activeCallback: this.activeCallback
    };
  }

  _getBaseUrl(req) {
    if (process.env.WEBHOOK_BASE_URL) return process.env.WEBHOOK_BASE_URL.replace(/\/$/, '');
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
  }

  _downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);

      // Add Twilio Basic Auth if downloading from Twilio
      if (parsedUrl.hostname.includes('twilio.com') || parsedUrl.hostname.includes('twilio')) {
        const accountSid = process.env.TWILIO_ACCOUNT_SID || '';
        const authToken = process.env.TWILIO_AUTH_TOKEN || '';
        if (accountSid && authToken) {
          parsedUrl.username = accountSid;
          parsedUrl.password = authToken;
        }
      }

      const proto = parsedUrl.protocol === 'https:' ? https : http;
      const file = fs.createWriteStream(destPath);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {}
      };

      // Set Basic Auth header
      if (parsedUrl.username && parsedUrl.password) {
        const auth = Buffer.from(`${parsedUrl.username}:${parsedUrl.password}`).toString('base64');
        options.headers['Authorization'] = `Basic ${auth}`;
      }

      const request = proto.get(options, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          file.close();
          try { fs.unlinkSync(destPath); } catch (e) {}
          return this._downloadFile(redirectUrl, destPath).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(destPath); } catch (e) {}
          return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        }
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      });

      request.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(destPath); } catch (e) {}
        reject(err);
      });

      request.setTimeout(30000, () => {
        request.destroy();
        reject(new Error('Download timeout'));
      });
    });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AppointmentHandler;
