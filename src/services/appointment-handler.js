const fs = require('fs');
const path = require('path');
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

function toHostPath(filePath) {
  if (!filePath) return filePath;
  for (const m of PATH_MAP) {
    if (filePath.startsWith(m.container + '/') || filePath === m.container) {
      return filePath.replace(m.container, m.host);
    }
  }
  return filePath;
}

// ============================================================
// Appointment Handler
//
// Flow:
//   1. Inbound call routed to appointment
//   2. Answer call, play greeting audio
//   3. Record caller's message (pcap via RTPEngine)
//   4. Caller hangs up → convert pcap to WAV
//   5. Queue internal callback
//   6. Monitor target extension/ring group presence
//   7. When agent comes online → originate internal call
//      with caller's number as caller ID
//   8. Agent picks up → 3s pause → play recorded message → hangup
//   9. If nobody picks up → retry on next presence change
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
    //   recordingPath, destination, createdAt, attempts, status }
    // status: 'pending' | 'delivering' | 'delivered' | 'failed'
    this.messageQueue = [];

    // Currently active callback call (only one at a time)
    this.activeCallback = null;

    // Ensure directory exists
    if (!fs.existsSync(APPT_DIR)) {
      try { fs.mkdirSync(APPT_DIR, { recursive: true }); } catch (e) {}
    }

    // Start presence monitor — check every 5 seconds
    this._presenceInterval = setInterval(() => this._processQueue(), 5000);

    logger.info(`Appointment: handler initialized, queue dir=${APPT_DIR}`);
  }

  // ============================================================
  // INBOUND — Handle a call routed to an appointment
  // ============================================================
  async handleAppointment(req, res, apptConfig, cdr) {
    const sipCallId = req.get('Call-Id');
    const from = req.getParsedHeader('From');
    const fromTag = from.params.tag;
    const callerID = this.callHandler.callRouter.extractCallerID(req);

    logger.info(`APPOINTMENT: ${callerID} -> APPT:${apptConfig.number} (${apptConfig.name}) [${sipCallId}]`);

    try {
      // Step 1: Answer with RTPEngine
      const rtpOffer = await this._rtpengineOffer(sipCallId, fromTag, req.body);
      if (!rtpOffer) {
        logger.error(`APPOINTMENT: RTPEngine offer failed`);
        return res.send(503);
      }

      const uas = await this.srf.createUAS(req, res, { localSdp: rtpOffer.sdp });
      logger.info(`APPOINTMENT: call answered [${sipCallId}]`);

      // Complete RTPEngine answer
      const toTag = uas.sip ? uas.sip.localTag : '';
      if (toTag) {
        try {
          const rtpHelper = require('../utils/rtp-helper');
          await rtpHelper.answer(this.rtpengine, sipCallId, fromTag, toTag, rtpOffer.sdp);
        } catch (ansErr) {
          logger.warn(`APPOINTMENT: RTPEngine answer failed: ${ansErr.message}`);
        }
      }

      // Wait for RTP to stabilize
      await this._sleep(2000);

      // Update CDR
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.to = `APPT:${apptConfig.number}`;
      await cdr.save();

      // Step 2: Play greeting + record
      await this._playAndRecord(uas, apptConfig, callerID, cdr, sipCallId, fromTag);

      return true;

    } catch (err) {
      logger.error(`APPOINTMENT: failed - ${err.message}`);
      if (!res.finalResponseSent) res.send(500);
      return false;
    }
  }

  // ============================================================
  // Play greeting audio, then record caller message
  // ============================================================
  async _playAndRecord(uas, apptConfig, callerID, cdr, sipCallId, fromTag) {
    const messageId = uuidv4();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recordingPath = path.join(APPT_DIR, `${timestamp}_${apptConfig.number}_${callerID}.wav`);

    let recordingStarted = false;
    let callerHungUp = false;
    let maxTimer = null;
    const maxRecordingLength = apptConfig.maxRecordingLength || 120; // seconds

    // On caller hangup
    uas.on('destroy', async () => {
      callerHungUp = true;
      if (maxTimer) clearTimeout(maxTimer);

      // Stop recording
      if (recordingStarted) {
        await this._rtpengineStopRecording(sipCallId, fromTag);
      }

      // Clean up RTPEngine
      await this._rtpengineDelete(sipCallId, fromTag);

      const duration = cdr.answerTime ? Math.round((Date.now() - cdr.answerTime.getTime()) / 1000) : 0;

      // Wait for pcap flush
      await this._sleep(2000);

      // Convert pcap to WAV
      let savedPath = null;
      let fileSize = 0;
      const spoolDir = process.env.RECORDING_SPOOL_DIR || '/var/spool/rtpengine';
      const pcapDir = path.join(spoolDir, 'pcaps');

      try {
        if (fs.existsSync(pcapDir)) {
          const pcapFiles = fs.readdirSync(pcapDir).filter(f =>
            f.startsWith(sipCallId) && f.endsWith('.pcap')
          );

          if (pcapFiles.length > 0) {
            const pcapPath = path.join(pcapDir, pcapFiles[0]);
            const pcapSize = fs.statSync(pcapPath).size;
            logger.info(`APPOINTMENT: found pcap ${pcapFiles[0]} (${pcapSize} bytes)`);

            if (pcapSize > 1000) {
              try {
                const { execSync } = require('child_process');
                const recDir = process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings';
                const tmpDir = path.join(recDir, 'tmp');
                if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

                const baseName = pcapFiles[0].replace('.pcap', '');
                const rawPath = path.join(tmpDir, `appt_${baseName}.raw`);
                const tmpWav = path.join(tmpDir, `appt_${baseName}.wav`);

                execSync(`tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y rtp -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${rawPath}"`, { timeout: 30000 });

                if (fs.existsSync(rawPath) && fs.statSync(rawPath).size > 0) {
                  execSync(`sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${rawPath}" "${tmpWav}" 2>/dev/null`, { timeout: 30000 });

                  if (fs.existsSync(tmpWav)) {
                    fs.copyFileSync(tmpWav, recordingPath);
                    savedPath = recordingPath;
                    fileSize = fs.statSync(recordingPath).size;
                    logger.info(`APPOINTMENT: converted pcap to wav: ${recordingPath} (${fileSize} bytes)`);
                  }
                }

                try { fs.unlinkSync(rawPath); } catch (e) {}
                try { fs.unlinkSync(tmpWav); } catch (e) {}
              } catch (convErr) {
                logger.warn(`APPOINTMENT: pcap conversion failed: ${convErr.message}`);
              }
            }
          }
        }
      } catch (e) {
        logger.warn(`APPOINTMENT: recording lookup error: ${e.message}`);
      }

      // Update CDR
      cdr.status = 'completed';
      cdr.endTime = new Date();
      cdr.duration = Math.round((cdr.endTime - cdr.startTime) / 1000);
      cdr.talkTime = duration;
      cdr.hangupBy = 'caller';
      cdr.hangupCause = 'appointment';
      await cdr.save();

      // Queue callback if we have a valid recording (at least 2 seconds)
      if (savedPath && duration > 2) {
        // Save to DB
        const { AppointmentMessage } = require('../models');
        try {
          await AppointmentMessage.create({
            messageId,
            appointmentNumber: apptConfig.number,
            callerID,
            duration: Math.max(0, duration - 5),
            recordingPath: savedPath,
            fileSize,
            status: 'pending'
          });
        } catch (dbErr) {
          logger.error(`APPOINTMENT: DB save failed: ${dbErr.message}`);
        }

        this.messageQueue.push({
          messageId,
          appointmentNumber: apptConfig.number,
          callerID,
          recordingPath: savedPath,
          destination: apptConfig.destination,
          createdAt: Date.now(),
          attempts: 0,
          status: 'pending'
        });

        logger.info(`APPOINTMENT QUEUED: ${callerID} -> ${apptConfig.destination.type}:${apptConfig.destination.target} (${this.messageQueue.length} in queue)`);
      } else {
        logger.info(`APPOINTMENT: message too short or no recording (${duration}s) — discarded`);
      }
    });

    // Play greeting
    const greetingFile = apptConfig.greeting;
    if (greetingFile && this.rtpengine) {
      const hostPath = toHostPath(greetingFile);
      const fileExists = fs.existsSync(hostPath) || fs.existsSync(greetingFile);

      if (fileExists) {
        logger.info(`APPOINTMENT: playing greeting ${greetingFile}`);
        try {
          await this.rtpengine.playMedia(this.rtpengineConfig, {
            'call-id': sipCallId,
            'from-tag': fromTag,
            file: toContainerPath(greetingFile)
          });
          // Wait for greeting to finish
          await this._sleep(5000);
        } catch (err) {
          logger.warn(`APPOINTMENT: greeting playback failed: ${err.message}`);
        }
      } else {
        logger.info(`APPOINTMENT: greeting file not found: ${greetingFile}`);
        await this._sleep(1000);
      }
    } else {
      await this._sleep(1000);
    }

    if (callerHungUp) return;

    // Play beep
    const beepFile = path.join(AUDIO_HOST_DIR, 'beep.wav');
    if (fs.existsSync(beepFile) && this.rtpengine) {
      try {
        await this.rtpengine.playMedia(this.rtpengineConfig, {
          'call-id': sipCallId,
          'from-tag': fromTag,
          file: toContainerPath(beepFile)
        });
        await this._sleep(1000);
      } catch (err) {
        logger.debug(`APPOINTMENT: beep playback failed: ${err.message}`);
      }
    }

    if (callerHungUp) return;

    // Start recording
    if (this.rtpengine) {
      try {
        const recResp = await this.rtpengine.startRecording(this.rtpengineConfig, {
          'call-id': sipCallId,
          'from-tag': fromTag
        });
        if (recResp && recResp.result === 'ok') {
          recordingStarted = true;
          logger.info(`APPOINTMENT: recording started (call-id=${sipCallId})`);
        }
      } catch (err) {
        logger.warn(`APPOINTMENT: start recording error: ${err.message}`);
      }
    }

    // Max recording timeout
    maxTimer = setTimeout(() => {
      if (!callerHungUp) {
        logger.info(`APPOINTMENT: max recording time (${maxRecordingLength}s), ending`);
        try { uas.destroy(); } catch (e) {}
      }
    }, maxRecordingLength * 1000);
  }

  // ============================================================
  // CALLBACK QUEUE PROCESSOR
  //
  // Runs every 5 seconds. Checks for pending messages.
  // For each pending message:
  //   - Check if target extension/ring group has anyone online
  //   - If yes, originate internal call and play recording
  //   - If no, skip and retry next cycle
  // ============================================================
  async _processQueue() {
    if (this.activeCallback) return; // one callback at a time
    if (this.messageQueue.length === 0) return;

    // Find first pending message
    const msg = this.messageQueue.find(m => m.status === 'pending');
    if (!msg) return;

    const { destination } = msg;
    if (!destination) {
      msg.status = 'failed';
      return;
    }

    try {
      // Check if target is online
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

      if (!targetOnline) {
        // Nobody online — skip, will retry next cycle
        return;
      }

      // Somebody is online — originate callback
      msg.status = 'delivering';
      msg.attempts++;
      this.activeCallback = msg.messageId;

      logger.info(`APPOINTMENT CALLBACK: calling ${destination.type}:${destination.target} for message from ${msg.callerID}`);

      await this._originateCallback(msg, targetContacts);

    } catch (err) {
      logger.error(`APPOINTMENT QUEUE: error processing ${msg.messageId}: ${err.message}`);
      msg.status = 'pending'; // retry
      this.activeCallback = null;
    }
  }

  // ============================================================
  // ORIGINATE CALLBACK — ring all target extensions
  //
  // Uses Drachtio to create a UAS+UAC call internally.
  // Shows caller's number as the caller ID.
  // On answer: 3s pause → play recording → hangup.
  // ============================================================
  async _originateCallback(msg, targetContacts) {
    const { callerID, recordingPath, messageId } = msg;

    // Verify recording still exists
    if (!fs.existsSync(recordingPath)) {
      logger.warn(`APPOINTMENT CALLBACK: recording missing ${recordingPath}`);
      msg.status = 'failed';
      this.activeCallback = null;
      this._removeFromQueue(messageId);
      return;
    }

    // Build target URIs for all online extensions
    const targets = [];
    for (const tc of targetContacts) {
      const contact = tc.contacts.sort((a, b) => {
        const ta = a.registeredAt ? new Date(a.registeredAt).getTime() : 0;
        const tb = b.registeredAt ? new Date(b.registeredAt).getTime() : 0;
        return tb - ta;
      })[0];
      if (contact) {
        targets.push({
          ext: tc.ext,
          uri: `sip:${tc.ext}@${contact.ip}:${contact.port}`
        });
      }
    }

    if (targets.length === 0) {
      msg.status = 'pending';
      this.activeCallback = null;
      return;
    }

    // Originate call — try each target (ring all simultaneously by trying first one)
    // For simplicity: try first available target. Ring group logic could be expanded.
    const target = targets[0];
    const sipDomain = process.env.SIP_DOMAIN || 'shadowpbx';
    const externalIp = process.env.EXTERNAL_IP || '127.0.0.1';

    try {
      logger.info(`APPOINTMENT CALLBACK: originating ${callerID} -> ${target.ext} at ${target.uri}`);

      // Create outgoing INVITE using Drachtio
      const uac = await this.srf.createUAC(target.uri, {
        headers: {
          'From': `<sip:${callerID}@${sipDomain}>`,
          'To': `<sip:${target.ext}@${sipDomain}>`,
          'Contact': `<sip:${callerID}@${externalIp}>`
        },
        callingNumber: callerID
      });

      logger.info(`APPOINTMENT CALLBACK: ${target.ext} answered — playing message from ${callerID}`);

      // Agent answered — now play the recording
      const sipCallId = uac.sip ? uac.sip.callId : `appt-cb-${messageId}`;
      let agentHungUp = false;

      uac.on('destroy', () => {
        agentHungUp = true;
        logger.info(`APPOINTMENT CALLBACK: agent ${target.ext} hung up`);
      });

      // 3 second delay before playing
      await this._sleep(3000);
      if (agentHungUp) {
        this._callbackComplete(msg, false);
        return;
      }

      // Play the recorded message via RTPEngine
      if (this.rtpengine) {
        const fromTag = uac.sip ? uac.sip.remoteTag : '';

        try {
          // We need to set up RTPEngine for this call leg
          // Use the call's SDP to create an RTPEngine session
          const rtpHelper = require('../utils/rtp-helper');
          const rtpOffer = await rtpHelper.offer(this.rtpengine, sipCallId, fromTag, uac.remote.sdp);

          if (rtpOffer) {
            // Re-INVITE agent with RTPEngine SDP
            try {
              await uac.modify(rtpOffer.sdp);
            } catch (modErr) {
              logger.debug(`APPOINTMENT CALLBACK: re-INVITE failed: ${modErr.message}`);
            }

            await this._sleep(500);

            // Play the recording
            logger.info(`APPOINTMENT CALLBACK: playing ${recordingPath}`);
            const playResp = await this.rtpengine.playMedia(this.rtpengineConfig, {
              'call-id': sipCallId,
              'from-tag': fromTag,
              file: toContainerPath(recordingPath)
            });

            // Estimate recording duration and wait
            const fileSize = fs.statSync(recordingPath).size;
            const estimatedDuration = Math.max(3000, Math.round(fileSize / 16)); // rough: 8kHz mono
            logger.info(`APPOINTMENT CALLBACK: waiting ${estimatedDuration}ms for playback`);

            // Wait for playback, check if agent hung up
            const waitStep = 500;
            let waited = 0;
            while (waited < estimatedDuration && !agentHungUp) {
              await this._sleep(Math.min(waitStep, estimatedDuration - waited));
              waited += waitStep;
            }

            // Clean up RTPEngine
            await rtpHelper.del(this.rtpengine, sipCallId, fromTag);
          }
        } catch (playErr) {
          logger.warn(`APPOINTMENT CALLBACK: playback failed: ${playErr.message}`);
        }
      }

      // Playback finished — hang up
      if (!agentHungUp) {
        await this._sleep(1000); // brief pause after message
        try { uac.destroy(); } catch (e) {}
      }

      this._callbackComplete(msg, true);

    } catch (err) {
      logger.error(`APPOINTMENT CALLBACK: failed for ${target.ext}: ${err.message} (status=${err.status})`);

      // If nobody answered, mark as pending for retry
      if (err.status === 480 || err.status === 408 || err.status === 487) {
        msg.status = 'pending';
        if (msg.attempts >= 10) {
          msg.status = 'failed';
          logger.warn(`APPOINTMENT CALLBACK: giving up after ${msg.attempts} attempts for ${msg.callerID}`);
          this._removeFromQueue(messageId);
        }
      } else {
        msg.status = 'pending';
      }
      this.activeCallback = null;
    }
  }

  // ============================================================
  // Callback complete — update status and remove from queue
  // ============================================================
  _callbackComplete(msg, success) {
    if (success) {
      msg.status = 'delivered';
      logger.info(`APPOINTMENT DELIVERED: message from ${msg.callerID} delivered to ${msg.destination.type}:${msg.destination.target}`);
    } else {
      msg.status = 'pending';
      logger.info(`APPOINTMENT CALLBACK: not delivered, will retry`);
    }

    // Update DB
    const { AppointmentMessage } = require('../models');
    AppointmentMessage.findOneAndUpdate(
      { messageId: msg.messageId },
      { status: msg.status, attempts: msg.attempts, deliveredAt: success ? new Date() : undefined }
    ).catch(e => logger.debug(`APPOINTMENT DB update: ${e.message}`));

    if (success) {
      this._removeFromQueue(msg.messageId);
    }
    this.activeCallback = null;
  }

  _removeFromQueue(messageId) {
    this.messageQueue = this.messageQueue.filter(m => m.messageId !== messageId);
  }

  // ============================================================
  // STARTUP — reload pending messages from DB
  // ============================================================
  async reloadPendingMessages() {
    try {
      const { AppointmentMessage, Appointment } = require('../models');
      const pending = await AppointmentMessage.find({ status: 'pending' }).sort({ createdAt: 1 });

      for (const msg of pending) {
        // Look up the appointment config to get destination
        const appt = await Appointment.findOne({ number: msg.appointmentNumber, enabled: true });
        if (!appt) continue;
        if (!msg.recordingPath || !fs.existsSync(msg.recordingPath)) continue;

        this.messageQueue.push({
          messageId: msg.messageId,
          appointmentNumber: msg.appointmentNumber,
          callerID: msg.callerID,
          recordingPath: msg.recordingPath,
          destination: appt.destination,
          createdAt: msg.createdAt.getTime(),
          attempts: msg.attempts || 0,
          status: 'pending'
        });
      }

      if (this.messageQueue.length > 0) {
        logger.info(`APPOINTMENT: reloaded ${this.messageQueue.length} pending message(s) from DB`);
      }
    } catch (err) {
      logger.warn(`APPOINTMENT: reload pending failed: ${err.message}`);
    }
  }

  // ============================================================
  // API helpers
  // ============================================================
  getQueueStatus() {
    return {
      total: this.messageQueue.length,
      pending: this.messageQueue.filter(m => m.status === 'pending').length,
      delivering: this.messageQueue.filter(m => m.status === 'delivering').length,
      activeCallback: this.activeCallback
    };
  }

  // ============================================================
  // RTPEngine helpers
  // ============================================================
  async _rtpengineOffer(callId, fromTag, sdp) {
    const rtpHelper = require('../utils/rtp-helper');
    return rtpHelper.offer(this.rtpengine, callId, fromTag, sdp);
  }

  async _rtpengineStopRecording(callId, fromTag) {
    if (!this.rtpengine) return;
    try {
      await this.rtpengine.stopRecording(this.rtpengineConfig, {
        'call-id': callId,
        'from-tag': fromTag
      });
    } catch (err) {}
  }

  async _rtpengineDelete(callId, fromTag) {
    const rtpHelper = require('../utils/rtp-helper');
    return rtpHelper.del(this.rtpengine, callId, fromTag);
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = AppointmentHandler;
