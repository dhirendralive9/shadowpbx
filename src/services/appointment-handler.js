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

// Normalize caller ID: strip +, leading 1 for US 11-digit
function normalizeCallerID(raw) {
  if (!raw || raw === 'unknown') return 'unknown';
  let num = raw.replace(/[^\d]/g, '');
  // Strip leading 1 for 11-digit US numbers → 10 digits
  if (num.length === 11 && num.startsWith('1')) num = num.substring(1);
  return num || 'unknown';
}

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

    // Message queue
    this.messageQueue = [];
    this.activeCallback = null;

    // Track processed RecordingSids to prevent duplicates
    // Twilio fires both action + recordingStatusCallback
    this.processedRecordings = new Set();

    if (!fs.existsSync(APPT_DIR)) {
      try { fs.mkdirSync(APPT_DIR, { recursive: true }); } catch (e) {}
    }

    // Process queue every 5 seconds
    this._presenceInterval = setInterval(() => this._processQueue(), 5000);

    // Clean old processed SIDs every hour (memory leak prevention)
    setInterval(() => {
      if (this.processedRecordings.size > 1000) this.processedRecordings.clear();
    }, 3600000);

    logger.info(`Appointment: webhook handler initialized, dir=${APPT_DIR}`);
  }

  // ============================================================
  // WEBHOOK: /webhook/appointment/:number/voice
  // ============================================================
  async handleVoiceWebhook(req, res, appointmentNumber) {
    const { Appointment, BlockedNumber } = require('../models');
    const appt = await Appointment.findOne({ number: appointmentNumber, enabled: true });

    if (!appt) {
      logger.warn(`APPT WEBHOOK: appointment ${appointmentNumber} not found`);
      return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, this service is not available.</Say><Hangup/></Response>`);
    }

    const rawCaller = req.body.From || req.body.Caller || 'unknown';
    const callerID = normalizeCallerID(rawCaller);
    const callSid = req.body.CallSid || '';

    logger.info(`APPT WEBHOOK: ${callerID} -> APPT:${appointmentNumber} (${appt.name}) CallSid=${callSid}`);

    // ─── Blacklist check ───
    try {
      // Check normalized, raw, and +1 variants
      const variants = [callerID, rawCaller.replace(/^\+/, ''), '+1' + callerID, '1' + callerID];
      const blocked = await BlockedNumber.findOne({ number: { $in: variants } });
      if (blocked) {
        logger.info(`APPT BLOCKED: ${callerID} is blacklisted (reason: ${blocked.reason || 'none'})`);
        return res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say>Sorry, we are unable to take your call at this time.</Say><Hangup/></Response>`);
      }
    } catch (e) {
      logger.debug(`APPT blacklist check: ${e.message}`);
    }

    // Build URLs
    const baseUrl = this._getBaseUrl(req);
    const actionUrl = `${baseUrl}/webhook/appointment/${appointmentNumber}/action`;
    const recordingCallbackUrl = `${baseUrl}/webhook/appointment/${appointmentNumber}/recording`;

    // Greeting
    let greetingXml = '';
    if (appt.greeting) {
      const greetingUrl = `${baseUrl}/webhook/appointment/audio/${encodeURIComponent(path.basename(appt.greeting))}`;
      greetingXml = `<Play>${greetingUrl}</Play>`;
    } else {
      greetingXml = `<Say voice="alice">Hello, please leave your name and a brief message after the beep. We will call you back shortly.</Say>`;
    }

    // CDR
    const { CDR } = require('../models');
    try {
      await CDR.create({
        callId: uuidv4(), sipCallId: callSid,
        from: callerID, to: `APPT:${appointmentNumber}`,
        direction: 'inbound', status: 'answered',
        startTime: new Date(), answerTime: new Date(),
        didNumber: req.body.To || req.body.Called || '',
        trunkUsed: 'twilio-webhook', hangupCause: 'appointment'
      });
    } catch (e) { logger.debug(`APPT CDR: ${e.message}`); }

    // TwiML — action URL is separate from recordingStatusCallback
    // action: fires when caller hangs up or recording ends (we just say thanks)
    // recordingStatusCallback: fires when recording file is ready (we process it)
    const maxLength = appt.maxRecordingLength || 120;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greetingXml}
  <Record maxLength="${maxLength}" action="${actionUrl}" recordingStatusCallback="${recordingCallbackUrl}" recordingStatusCallbackEvent="completed" playBeep="true" trim="trim-silence"/>
  <Say voice="alice">We did not receive your message. Goodbye.</Say>
  <Hangup/>
</Response>`;

    res.type('text/xml').send(twiml);
  }

  // ============================================================
  // WEBHOOK: /webhook/appointment/:number/action
  //
  // Called by Twilio when caller hangs up after recording.
  // Just says "thank you" — does NOT process the recording.
  // ============================================================
  async handleActionWebhook(req, res) {
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="alice">Thank you for your message. We will call you back shortly. Goodbye.</Say><Hangup/></Response>`);
  }

  // ============================================================
  // WEBHOOK: /webhook/appointment/:number/recording
  //
  // Called by Twilio when the recording FILE is ready.
  // This is the ONLY place we process and queue callbacks.
  // Uses RecordingSid for deduplication.
  // ============================================================
  async handleRecordingWebhook(req, res, appointmentNumber) {
    // Always respond 200 immediately
    res.status(200).send('OK');

    const recordingSid = req.body.RecordingSid || '';
    const recordingUrl = req.body.RecordingUrl || '';
    const duration = parseInt(req.body.RecordingDuration) || 0;
    const callSid = req.body.CallSid || '';
    const rawCaller = req.body.From || req.body.Caller || 'unknown';
    const callerID = normalizeCallerID(rawCaller);

    // ─── Deduplication: skip if we already processed this RecordingSid ───
    if (recordingSid && this.processedRecordings.has(recordingSid)) {
      logger.debug(`APPT RECORDING: duplicate RecordingSid ${recordingSid}, skipping`);
      return;
    }
    if (recordingSid) this.processedRecordings.add(recordingSid);

    if (!recordingUrl) {
      logger.warn(`APPT RECORDING: no RecordingUrl, body keys=${Object.keys(req.body).join(',')}`);
      return;
    }

    logger.info(`APPT RECORDING: ${callerID} -> APPT:${appointmentNumber} duration=${duration}s sid=${recordingSid}`);

    if (duration < 2) {
      logger.info(`APPT RECORDING: too short (${duration}s), discarding`);
      return;
    }

    // ─── Also check DB for duplicate RecordingSid ───
    const { Appointment, AppointmentMessage } = require('../models');
    if (recordingSid) {
      const existing = await AppointmentMessage.findOne({ callSid: recordingSid });
      if (existing) {
        logger.debug(`APPT RECORDING: already in DB (recordingSid=${recordingSid}), skipping`);
        return;
      }
    }

    const appt = await Appointment.findOne({ number: appointmentNumber, enabled: true });
    if (!appt) {
      logger.warn(`APPT RECORDING: appointment ${appointmentNumber} not found`);
      return;
    }

    const messageId = uuidv4();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const localFilename = `${timestamp}_${appointmentNumber}_${callerID}.wav`;
    const localPath = path.join(APPT_DIR, localFilename);
    const wavUrl = recordingUrl.endsWith('.wav') ? recordingUrl : recordingUrl + '.wav';

    let savedPath = null;
    let fileSize = 0;

    try {
      await this._downloadFile(wavUrl, localPath);
      fileSize = fs.existsSync(localPath) ? fs.statSync(localPath).size : 0;
      savedPath = localPath;
      logger.info(`APPT RECORDING: downloaded ${localPath} (${fileSize} bytes)`);
    } catch (dlErr) {
      logger.error(`APPT RECORDING: download failed: ${dlErr.message}`);
    }

    // Save to DB
    await AppointmentMessage.create({
      messageId, appointmentNumber, callerID, duration,
      recordingPath: savedPath, recordingUrl: wavUrl, fileSize,
      callSid: recordingSid || callSid,
      status: 'pending'
    });

    // Add to in-memory queue
    this.messageQueue.push({
      messageId, appointmentNumber, callerID,
      recordingPath: savedPath, recordingUrl: wavUrl,
      destination: appt.destination,
      createdAt: Date.now(), attempts: 0, status: 'pending'
    });

    logger.info(`APPT QUEUED: ${callerID} -> ${appt.destination.type}:${appt.destination.target} (queue size: ${this.messageQueue.length})`);
  }

  // ============================================================
  // Serve audio files for Twilio <Play>
  // ============================================================
  serveAudioFile(req, res) {
    const filename = req.params.filename.replace(/\.\./g, '');
    const audioDir = process.env.MOH_DIR || '/opt/shadowpbx/audio';
    const filePath = path.join(audioDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
    const ext = filename.split('.').pop().toLowerCase();
    res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'audio/wav');
    fs.createReadStream(filePath).pipe(res);
  }

  // ============================================================
  // Legacy SIP handler (fallback)
  // ============================================================
  async handleAppointment(req, res, apptConfig, cdr) {
    logger.info(`APPT SIP: ${cdr.from} -> APPT:${apptConfig.number} — use webhook instead`);
    if (!res.finalResponseSent) res.send(503);
    return false;
  }

  // ============================================================
  // QUEUE PROCESSOR — runs every 5s
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

      // Ensure local file exists
      if (!msg.recordingPath || !fs.existsSync(msg.recordingPath)) {
        if (msg.recordingUrl) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const lp = path.join(APPT_DIR, `${ts}_${msg.appointmentNumber}_${msg.callerID}.wav`);
          try {
            await this._downloadFile(msg.recordingUrl, lp);
            msg.recordingPath = lp;
            logger.info(`APPT CALLBACK: re-downloaded to ${lp}`);
          } catch (e) {
            logger.error(`APPT CALLBACK: download failed: ${e.message}`);
            return;
          }
        } else {
          msg.status = 'failed';
          this._updateDB(msg);
          this._removeFromQueue(msg.messageId);
          return;
        }
      }

      msg.status = 'delivering';
      msg.attempts++;
      this.activeCallback = msg.messageId;

      logger.info(`APPT CALLBACK: calling ${destination.type}:${destination.target} for ${msg.callerID}`);
      await this._originateCallback(msg, targetContacts);

    } catch (err) {
      logger.error(`APPT QUEUE: ${err.message}`);
      msg.status = 'pending';
      this.activeCallback = null;
    }
  }

  // ============================================================
  // ORIGINATE CALLBACK
  // ============================================================
  async _originateCallback(msg, targetContacts) {
    const { callerID, recordingPath, messageId } = msg;

    if (!fs.existsSync(recordingPath)) {
      msg.status = 'failed';
      this.activeCallback = null;
      this._updateDB(msg);
      this._removeFromQueue(messageId);
      return;
    }

    const targets = [];
    for (const tc of targetContacts) {
      const contact = tc.contacts.sort((a, b) =>
        (b.registeredAt ? new Date(b.registeredAt).getTime() : 0) -
        (a.registeredAt ? new Date(a.registeredAt).getTime() : 0)
      )[0];
      if (contact) targets.push({ ext: tc.ext, uri: `sip:${tc.ext}@${contact.ip}:${contact.port}` });
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
      logger.info(`APPT CALLBACK: originating ${callerID} -> ${target.ext} at ${target.uri}`);

      const uac = await this.srf.createUAC(target.uri, {
        headers: {
          'From': `<sip:${callerID}@${sipDomain}>`,
          'To': `<sip:${target.ext}@${sipDomain}>`,
          'Contact': `<sip:${callerID}@${externalIp}>`
        },
        callingNumber: callerID
      });

      logger.info(`APPT CALLBACK: ${target.ext} answered — playing message from ${callerID}`);

      const sipCallId = uac.sip ? uac.sip.callId : `appt-${messageId}`;
      let agentHungUp = false;
      uac.on('destroy', () => { agentHungUp = true; });

      // 3 second delay
      await this._sleep(3000);
      if (agentHungUp) { this._callbackDone(msg, false); return; }

      // Play via RTPEngine
      if (this.rtpengine) {
        const fromTag = uac.sip ? uac.sip.remoteTag : '';
        try {
          const rtpHelper = require('../utils/rtp-helper');
          const rtpOffer = await rtpHelper.offer(this.rtpengine, sipCallId, fromTag, uac.remote.sdp);
          if (rtpOffer) {
            try { await uac.modify(rtpOffer.sdp); } catch (e) {}
            await this._sleep(500);

            logger.info(`APPT CALLBACK: playing ${path.basename(recordingPath)}`);
            await this.rtpengine.playMedia(this.rtpengineConfig, {
              'call-id': sipCallId, 'from-tag': fromTag,
              file: toContainerPath(recordingPath)
            });

            const fileSize = fs.statSync(recordingPath).size;
            const waitMs = Math.max(3000, Math.round(fileSize / 16));

            let waited = 0;
            while (waited < waitMs && !agentHungUp) {
              await this._sleep(500);
              waited += 500;
            }

            await rtpHelper.del(this.rtpengine, sipCallId, fromTag);
          }
        } catch (e) {
          logger.warn(`APPT CALLBACK: playback error: ${e.message}`);
        }
      }

      if (!agentHungUp) {
        await this._sleep(1000);
        try { uac.destroy(); } catch (e) {}
      }

      this._callbackDone(msg, true);

    } catch (err) {
      logger.error(`APPT CALLBACK: failed ${target.ext}: ${err.message} (status=${err.status})`);
      msg.status = 'pending';
      if (msg.attempts >= 10) {
        msg.status = 'failed';
        this._updateDB(msg);
        this._removeFromQueue(messageId);
      }
      this.activeCallback = null;
    }
  }

  // ============================================================
  // Callback done
  // ============================================================
  _callbackDone(msg, success) {
    msg.status = success ? 'delivered' : 'pending';
    if (success) {
      logger.info(`APPT DELIVERED: ${msg.callerID} -> ${msg.destination.type}:${msg.destination.target}`);
    }
    this._updateDB(msg);
    if (success) this._removeFromQueue(msg.messageId);
    this.activeCallback = null;
  }

  _updateDB(msg) {
    const { AppointmentMessage } = require('../models');
    const update = { status: msg.status, attempts: msg.attempts };
    if (msg.status === 'delivered') update.deliveredAt = new Date();
    AppointmentMessage.findOneAndUpdate({ messageId: msg.messageId }, update)
      .catch(e => logger.debug(`APPT DB: ${e.message}`));
  }

  _removeFromQueue(messageId) {
    this.messageQueue = this.messageQueue.filter(m => m.messageId !== messageId);
  }

  // ============================================================
  // Reload pending on startup
  // ============================================================
  async reloadPendingMessages() {
    try {
      const { AppointmentMessage, Appointment } = require('../models');
      const pending = await AppointmentMessage.find({ status: 'pending' }).sort({ createdAt: 1 });

      for (const msg of pending) {
        const appt = await Appointment.findOne({ number: msg.appointmentNumber, enabled: true });
        if (!appt) continue;
        const hasFile = msg.recordingPath && fs.existsSync(msg.recordingPath);
        if (!hasFile && !msg.recordingUrl) continue;

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
        logger.info(`APPT: reloaded ${this.messageQueue.length} pending message(s)`);
      }
    } catch (err) {
      logger.warn(`APPT: reload failed: ${err.message}`);
    }
  }

  // ============================================================
  // Register webhook routes (PUBLIC — no auth)
  // ============================================================
  registerWebhookRoutes(app) {
    app.post('/webhook/appointment/:number/voice', (req, res) => {
      this.handleVoiceWebhook(req, res, req.params.number).catch(err => {
        logger.error(`APPT WEBHOOK voice: ${err.message}`);
        res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>An error occurred.</Say><Hangup/></Response>`);
      });
    });

    app.post('/webhook/appointment/:number/action', (req, res) => {
      this.handleActionWebhook(req, res).catch(err => {
        logger.error(`APPT WEBHOOK action: ${err.message}`);
        res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>`);
      });
    });

    app.post('/webhook/appointment/:number/recording', (req, res) => {
      this.handleRecordingWebhook(req, res, req.params.number).catch(err => {
        logger.error(`APPT WEBHOOK recording: ${err.message}`);
        if (!res.headersSent) res.status(200).send('OK');
      });
    });

    app.get('/webhook/appointment/audio/:filename', (req, res) => {
      this.serveAudioFile(req, res);
    });

    logger.info('APPT: webhook routes registered at /webhook/appointment/');
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
      if (parsedUrl.hostname.includes('twilio')) {
        const sid = process.env.TWILIO_ACCOUNT_SID || '';
        const token = process.env.TWILIO_AUTH_TOKEN || '';
        if (sid && token) { parsedUrl.username = sid; parsedUrl.password = token; }
      }

      const proto = parsedUrl.protocol === 'https:' ? https : http;
      const file = fs.createWriteStream(destPath);
      const options = {
        hostname: parsedUrl.hostname, port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search, headers: {}
      };
      if (parsedUrl.username && parsedUrl.password) {
        options.headers['Authorization'] = 'Basic ' + Buffer.from(`${parsedUrl.username}:${parsedUrl.password}`).toString('base64');
      }

      const request = proto.get(options, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          try { fs.unlinkSync(destPath); } catch (e) {}
          return this._downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
        }
        if (response.statusCode !== 200) {
          file.close();
          try { fs.unlinkSync(destPath); } catch (e) {}
          return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        }
        response.pipe(file);
        file.on('finish', () => file.close(resolve));
      });
      request.on('error', (err) => { file.close(); try { fs.unlinkSync(destPath); } catch (e) {} reject(err); });
      request.setTimeout(30000, () => { request.destroy(); reject(new Error('Download timeout')); });
    });
  }

  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

module.exports = AppointmentHandler;
