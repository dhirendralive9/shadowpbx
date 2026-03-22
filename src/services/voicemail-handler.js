const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const VM_DIR = process.env.VOICEMAIL_DIR || '/var/lib/shadowpbx/voicemail';
const VM_GREETINGS_DIR = path.join(VM_DIR, 'greetings');
const DEFAULT_GREETING = process.env.VM_DEFAULT_GREETING || '';
const MAX_MESSAGE_LENGTH = parseInt(process.env.VM_MAX_MESSAGE_LENGTH) || 120; // seconds
const BEEP_FILE = process.env.VM_BEEP_FILE || '';

// RTPEngine runs in Docker — file paths in RTPEngine commands must use
// container paths, not host paths. These are the Docker volume mounts:
//   Host /opt/shadowpbx/audio       → Container /audio
//   Host /var/lib/shadowpbx/voicemail → Container /voicemail
//   Host /var/lib/shadowpbx/recordings → Container /recordings
const AUDIO_HOST_DIR = process.env.MOH_DIR || '/opt/shadowpbx/audio';
const PATH_MAP = [
  { host: AUDIO_HOST_DIR, container: '/audio' },
  { host: VM_DIR, container: '/voicemail' },
  { host: process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings', container: '/recordings' }
];

// Convert a host path to the equivalent container path for RTPEngine
function toContainerPath(hostPath) {
  if (!hostPath) return hostPath;
  for (const m of PATH_MAP) {
    if (hostPath.startsWith(m.host)) {
      return hostPath.replace(m.host, m.container);
    }
  }
  // If the path already looks like a container path, use as-is
  if (hostPath.startsWith('/audio/') || hostPath.startsWith('/voicemail/') || hostPath.startsWith('/recordings/')) {
    return hostPath;
  }
  return hostPath;
}

class VoicemailHandler {
  constructor(srf, rtpengine, callHandler) {
    this.srf = srf;
    this.rtpengine = rtpengine;
    this.callHandler = callHandler;
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };

    // Ensure directories exist
    [VM_DIR, VM_GREETINGS_DIR].forEach(d => {
      if (!fs.existsSync(d)) {
        try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
      }
    });

    this._logSetup();
  }

  _logSetup() {
    const greetingExists = DEFAULT_GREETING && fs.existsSync(DEFAULT_GREETING);
    const beepExists = BEEP_FILE && fs.existsSync(BEEP_FILE);
    logger.info(`Voicemail: dir=${VM_DIR} maxLen=${MAX_MESSAGE_LENGTH}s greeting=${greetingExists ? DEFAULT_GREETING : 'none'} beep=${beepExists ? BEEP_FILE : 'none'}`);
  }

  // ============================================================
  // Check if voicemail is enabled for an extension
  //
  // For now, voicemail is enabled for all extensions by default.
  // Per-extension config can be added to the Extension model later.
  // ============================================================
  async isEnabled(extension) {
    // Check if extension has voicemail explicitly disabled
    // For now, always enabled
    return true;
  }

  // ============================================================
  // Handle voicemail for an unanswered call
  //
  // Called from call-handler when:
  //   - Extension call fails (timeout/busy/no-answer)
  //   - Ring group call fails (nobody answered)
  //   - Inbound call to extension fails
  //
  // The req/res must NOT have had a final response sent yet.
  // We answer the call, play greeting, record, and save.
  //
  // Parameters:
  //   req/res - original SIP INVITE request/response (not yet answered)
  //   callerID - who's calling
  //   targetExt - whose voicemail box to use
  //   cdr - the CDR record for this call
  // ============================================================
  async handleVoicemail(req, res, callerID, targetExt, cdr) {
    if (res.finalResponseSent) {
      logger.debug(`VM: final response already sent for ${targetExt}, cannot record`);
      return false;
    }

    const vmEnabled = await this.isEnabled(targetExt);
    if (!vmEnabled) {
      logger.debug(`VM: disabled for ${targetExt}`);
      return false;
    }

    logger.info(`VOICEMAIL: ${callerID} -> ${targetExt} [${cdr.callId}]`);

    // Ensure extension voicemail directory exists
    const extVmDir = path.join(VM_DIR, targetExt);
    if (!fs.existsSync(extVmDir)) {
      try { fs.mkdirSync(extVmDir, { recursive: true }); } catch (e) {}
    }

    try {
      // Step 1: Answer the call with RTPEngine SDP
      const sipCallId = req.get('Call-Id');
      const from = req.getParsedHeader('From');
      const fromTag = from.params.tag;

      // Create RTPEngine session for the voicemail
      const rtpOffer = await this._rtpengineOffer(sipCallId, fromTag, req.body);

      if (!rtpOffer) {
        // No RTPEngine — answer with original SDP and just record silence
        logger.warn(`VM: no RTPEngine, answering with caller SDP`);
        const uas = await this.srf.createUAS(req, res, { localSdp: req.body });
        await this._recordWithDialog(uas, callerID, targetExt, cdr, sipCallId, fromTag);
        return true;
      }

      // Answer with RTPEngine's SDP
      const uas = await this.srf.createUAS(req, res, { localSdp: rtpOffer.sdp });

      logger.info(`VM: call answered for voicemail [${cdr.callId}]`);

      // Complete the RTPEngine session by sending the answer
      // This is critical — without this, RTPEngine doesn't know both sides
      // and can't inject audio via play media
      const toTag = uas.sip ? uas.sip.localTag : '';
      if (toTag) {
        try {
          const rtpHelper = require('../utils/rtp-helper');
          await rtpHelper.answer(this.rtpengine, sipCallId, fromTag, toTag, rtpOffer.sdp);
          logger.info(`VM: RTPEngine answer completed (from-tag=${fromTag} to-tag=${toTag})`);
        } catch (ansErr) {
          logger.warn(`VM: RTPEngine answer failed: ${ansErr.message}`);
        }
      }

      // Wait for RTP session to stabilize before playing audio
      // Some trunks (e.g. Twilio) take ~3s to confirm peer address
      await this._sleep(2000);

      // Update CDR
      cdr.status = 'voicemail';
      cdr.answerTime = new Date();
      cdr.to = `VM:${targetExt}`;
      await cdr.save();

      // Step 2: Play greeting, then record
      await this._playAndRecord(uas, callerID, targetExt, cdr, sipCallId, fromTag);

      return true;

    } catch (err) {
      logger.error(`VM: failed for ${targetExt}: ${err.message}`);
      return false;
    }
  }

  // ============================================================
  // Play greeting then record
  // ============================================================
  async _playAndRecord(uas, callerID, targetExt, cdr, sipCallId, fromTag) {
    const messageId = uuidv4();
    const extVmDir = path.join(VM_DIR, targetExt);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const recordingPath = path.join(extVmDir, `${timestamp}_${callerID}.wav`);

    let recordingStarted = false;
    let recordingTimeout = null;

    // Track when caller hangs up
    let callerHungUp = false;
    uas.on('destroy', async () => {
      callerHungUp = true;
      if (recordingTimeout) clearTimeout(recordingTimeout);

      // Stop recording
      if (recordingStarted) {
        await this._rtpengineStopRecording(sipCallId, fromTag);
      }

      // Clean up RTPEngine
      await this._rtpengineDelete(sipCallId, fromTag);

      // Save voicemail message to DB
      const duration = cdr.answerTime ? Math.round((Date.now() - cdr.answerTime.getTime()) / 1000) : 0;

      // Wait a moment for RTPEngine to flush the pcap file
      await this._sleep(2000);

      // Find the pcap recording from RTPEngine's recording dir
      // RTPEngine writes pcap files to recording-dir/pcaps/ (note: plural)
      let savedPath = null;
      let fileSize = 0;
      const recDir = process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings';

      // Check both pcaps/ (RTPEngine default) and pcap/ (legacy)
      let pcapDir = path.join(recDir, 'pcaps');
      if (!fs.existsSync(pcapDir)) {
        pcapDir = path.join(recDir, 'pcap');
      }

      try {
        if (fs.existsSync(pcapDir)) {
          // RTPEngine names files as: {call-id}-{hash}.pcap
          // We match on the call-id prefix
          const pcapFiles = fs.readdirSync(pcapDir).filter(f =>
            f.startsWith(sipCallId) && f.endsWith('.pcap')
          );

          if (pcapFiles.length > 0) {
            const pcapPath = path.join(pcapDir, pcapFiles[0]);
            const pcapSize = fs.statSync(pcapPath).size;
            logger.info(`VM: found pcap recording ${pcapFiles[0]} (${pcapSize} bytes)`);

            // Convert pcap to wav using the existing converter
            if (pcapSize > 1000) {
              try {
                const { pcapToWav } = require('../utils/converter');
                const wavPath = pcapToWav(sipCallId, `vm_${messageId}`);
                if (wavPath && fs.existsSync(wavPath)) {
                  // Move wav to voicemail dir
                  const finalPath = recordingPath;
                  fs.copyFileSync(wavPath, finalPath);
                  savedPath = finalPath;
                  fileSize = fs.statSync(finalPath).size;
                  logger.info(`VM: converted pcap to wav: ${finalPath} (${fileSize} bytes)`);
                }
              } catch (convErr) {
                logger.warn(`VM: pcap conversion failed: ${convErr.message}`);
                // Fallback: save the pcap itself
                savedPath = pcapPath;
                fileSize = pcapSize;
              }
            }
          } else {
            logger.info(`VM: no pcap file found for call-id ${sipCallId} in ${pcapDir}`);
          }
        }
      } catch (e) {
        logger.warn(`VM: recording lookup error: ${e.message}`);
      }

      if (savedPath && duration > 2) { // at least 2 seconds
        try {
          const VoicemailMessage = require('../models').VoicemailMessage;
          await VoicemailMessage.create({
            messageId,
            extension: targetExt,
            callerID,
            duration: Math.max(0, duration - 5), // subtract greeting+beep time
            recordingPath: savedPath,
            fileSize,
            read: false
          });
          logger.info(`VM SAVED: ${callerID} -> ${targetExt} duration=${duration}s path=${savedPath}`);
        } catch (dbErr) {
          logger.error(`VM DB save failed: ${dbErr.message}`);
        }
      } else {
        logger.info(`VM: message too short or no recording (${duration}s, ${fileSize} bytes) — discarded`);
      }

      // Update CDR
      cdr.status = 'voicemail';
      cdr.endTime = new Date();
      cdr.duration = Math.round((cdr.endTime - cdr.startTime) / 1000);
      cdr.talkTime = duration;
      cdr.hangupBy = 'caller';
      cdr.hangupCause = 'voicemail';
      cdr.voicemailId = messageId;
      await cdr.save();
    });

    // Step 1: Play greeting (if available)
    const greetingFile = this._getGreetingFile(targetExt);
    if (greetingFile && this.rtpengine) {
      logger.info(`VM: playing greeting ${greetingFile} for ${targetExt} (call-id=${sipCallId} from-tag=${fromTag})`);
      try {
        const playResp = await this.rtpengine.playMedia(this.rtpengineConfig, {
          'call-id': sipCallId,
          'from-tag': fromTag,
          file: toContainerPath(greetingFile)
        });
        logger.info(`VM: greeting play response: ${JSON.stringify(playResp)}`);
        // Wait for greeting to finish
        await this._sleep(4000);
      } catch (err) {
        logger.warn(`VM: greeting playback failed: ${err.message}`);
      }

      if (callerHungUp) return;
    } else {
      logger.info(`VM: no greeting file for ${targetExt} (checked: ${greetingFile || 'none'})`);
      // Short pause before beep even without greeting
      await this._sleep(1000);
    }

    // Step 2: Play beep (if available)
    const beepFile = this._getBeepFile();
    if (beepFile && this.rtpengine) {
      logger.info(`VM: playing beep ${beepFile}`);
      try {
        const beepResp = await this.rtpengine.playMedia(this.rtpengineConfig, {
          'call-id': sipCallId,
          'from-tag': fromTag,
          file: toContainerPath(beepFile)
        });
        logger.info(`VM: beep play response: ${JSON.stringify(beepResp)}`);
        await this._sleep(1000);
      } catch (err) {
        logger.debug(`VM: beep playback failed: ${err.message}`);
      }

      if (callerHungUp) return;
    }

    // Step 3: Start recording via RTPEngine
    // RTPEngine records to its --recording-dir as pcap files named by call-id.
    // After the call ends, we'll find and convert the pcap to wav.
    if (this.rtpengine) {
      try {
        const recResponse = await this.rtpengine.startRecording(this.rtpengineConfig, {
          'call-id': sipCallId,
          'from-tag': fromTag
        });

        if (recResponse && recResponse.result === 'ok') {
          recordingStarted = true;
          logger.info(`VM: recording started (call-id=${sipCallId})`);
        } else {
          logger.warn(`VM: start recording failed: ${JSON.stringify(recResponse)}`);
        }
      } catch (err) {
        logger.warn(`VM: start recording error: ${err.message}`);
      }
    }

    // Step 4: Set max recording timeout
    recordingTimeout = setTimeout(async () => {
      if (!callerHungUp) {
        logger.info(`VM: max recording time reached (${MAX_MESSAGE_LENGTH}s), ending`);
        try { uas.destroy(); } catch (e) {}
      }
    }, MAX_MESSAGE_LENGTH * 1000);
  }

  // Fallback recording when no RTPEngine
  async _recordWithDialog(uas, callerID, targetExt, cdr, sipCallId, fromTag) {
    logger.info(`VM: recording without RTPEngine (limited functionality)`);

    cdr.status = 'voicemail';
    cdr.answerTime = new Date();
    cdr.to = `VM:${targetExt}`;
    await cdr.save();

    // Set timeout to end the call
    const timeout = setTimeout(() => {
      try { uas.destroy(); } catch (e) {}
    }, MAX_MESSAGE_LENGTH * 1000);

    uas.on('destroy', async () => {
      clearTimeout(timeout);
      cdr.status = 'voicemail';
      cdr.endTime = new Date();
      cdr.duration = Math.round((cdr.endTime - cdr.startTime) / 1000);
      cdr.hangupBy = 'caller';
      cdr.hangupCause = 'voicemail';
      await cdr.save();
      logger.info(`VM: call ended (no recording without RTPEngine)`);
    });
  }

  // ============================================================
  // File helpers
  // ============================================================

  _getGreetingFile(extension) {
    // Check per-extension greeting on host filesystem
    const extGreeting = path.join(VM_GREETINGS_DIR, `${extension}.wav`);
    if (fs.existsSync(extGreeting)) return extGreeting;

    // Fall back to default greeting
    // DEFAULT_GREETING may be a container path (/audio/vm-greeting.wav)
    // or a host path (/opt/shadowpbx/audio/vm-greeting.wav)
    if (DEFAULT_GREETING) {
      // If it's a container path, check the corresponding host path
      const hostPath = this._toHostPath(DEFAULT_GREETING);
      if (fs.existsSync(hostPath)) return DEFAULT_GREETING; // return original (container or host)
      // Try as-is
      if (fs.existsSync(DEFAULT_GREETING)) return DEFAULT_GREETING;
    }

    return null;
  }

  _getBeepFile() {
    if (BEEP_FILE) {
      const hostPath = this._toHostPath(BEEP_FILE);
      if (fs.existsSync(hostPath)) return BEEP_FILE;
      if (fs.existsSync(BEEP_FILE)) return BEEP_FILE;
    }

    // Check common locations
    const defaultBeep = path.join(AUDIO_HOST_DIR, 'beep.wav');
    if (fs.existsSync(defaultBeep)) return defaultBeep;

    return null;
  }

  // Convert container path to host path for fs.existsSync checks
  _toHostPath(filePath) {
    if (!filePath) return filePath;
    for (const m of PATH_MAP) {
      if (filePath.startsWith(m.container + '/') || filePath === m.container) {
        return filePath.replace(m.container, m.host);
      }
    }
    return filePath;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

  // ============================================================
  // API: List voicemail messages
  // ============================================================
  async getMessages(extension, options = {}) {
    const VoicemailMessage = require('../models').VoicemailMessage;
    const filter = { extension };
    if (options.unreadOnly) filter.read = false;

    const limit = options.limit || 50;
    const page = options.page || 1;

    const [messages, total] = await Promise.all([
      VoicemailMessage.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      VoicemailMessage.countDocuments(filter)
    ]);

    return {
      messages,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      unread: await VoicemailMessage.countDocuments({ extension, read: false })
    };
  }

  // Mark message as read
  async markRead(extension, messageId) {
    const VoicemailMessage = require('../models').VoicemailMessage;
    const msg = await VoicemailMessage.findOne({ extension, messageId });
    if (!msg) throw new Error('Message not found');
    msg.read = true;
    msg.readAt = new Date();
    await msg.save();
    return msg;
  }

  // Delete message
  async deleteMessage(extension, messageId) {
    const VoicemailMessage = require('../models').VoicemailMessage;
    const msg = await VoicemailMessage.findOne({ extension, messageId });
    if (!msg) throw new Error('Message not found');

    // Delete recording file
    if (msg.recordingPath && fs.existsSync(msg.recordingPath)) {
      try { fs.unlinkSync(msg.recordingPath); } catch (e) {}
    }

    await VoicemailMessage.deleteOne({ _id: msg._id });
    return { deleted: true };
  }

  // Get audio file path for streaming
  getAudioPath(extension, messageId) {
    // We need to look up the message synchronously for the audio endpoint
    // The actual serving is done in the route handler
    return null; // handled by async version below
  }

  async getAudioPathAsync(extension, messageId) {
    const VoicemailMessage = require('../models').VoicemailMessage;
    const msg = await VoicemailMessage.findOne({ extension, messageId });
    if (!msg) throw new Error('Message not found');
    if (!msg.recordingPath || !fs.existsSync(msg.recordingPath)) {
      throw new Error('Recording file not found');
    }

    // Mark as read when audio is accessed
    if (!msg.read) {
      msg.read = true;
      msg.readAt = new Date();
      await msg.save();
    }

    return msg.recordingPath;
  }

  // Get voicemail summary for an extension (unread count)
  async getSummary(extension) {
    const VoicemailMessage = require('../models').VoicemailMessage;
    const [total, unread] = await Promise.all([
      VoicemailMessage.countDocuments({ extension }),
      VoicemailMessage.countDocuments({ extension, read: false })
    ]);
    return { extension, total, unread };
  }
}

module.exports = VoicemailHandler;
