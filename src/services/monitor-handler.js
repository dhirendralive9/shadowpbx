const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// MonitorHandler — Listen / Whisper / Barge
//
// Uses RTPEngine 'subscribe request' to fork media from an
// active call to a supervisor's softphone.
//
// Flow:
//   1. Send 'subscribe request' to RTPEngine with the active call's
//      call-id and 'all' flag — RTPEngine returns an offer SDP
//      containing the forked audio
//   2. Call the supervisor's softphone with that SDP
//   3. Send 'subscribe answer' with the supervisor's answer SDP
//   4. Media flows: supervisor hears the call
//
// For whisper/barge, we additionally need to inject the supervisor's
// audio back into the call legs.
// ============================================================

class MonitorHandler {
  constructor(srf, rtpengine, callHandler, registrar) {
    this.srf = srf;
    this.rtpengine = rtpengine;
    this.callHandler = callHandler;
    this.registrar = registrar;
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };
    this.monitors = new Map();
  }

  // ============================================================
  // Start monitoring
  // ============================================================
  async startMonitor(callId, supervisorExt, mode = 'listen') {
    mode = ['listen', 'whisper', 'barge'].includes(mode) ? mode : 'listen';

    // Find the active call
    let sipCallId = callId;
    let activeCall = this.callHandler.activeCalls.get(callId);

    if (!activeCall) {
      // Try finding by CDR callId
      for (const [scid, call] of this.callHandler.activeCalls) {
        if (call.cdr && call.cdr.callId === callId) {
          sipCallId = scid;
          activeCall = call;
          break;
        }
      }
    }

    if (!activeCall) throw new Error('Call not found or not active');

    // Get supervisor contact
    const contacts = await this.registrar.getContacts(supervisorExt);
    if (!contacts || contacts.length === 0) {
      throw new Error(`Supervisor ${supervisorExt} not registered`);
    }

    const contact = contacts[0];
    const supervisorUri = `sip:${supervisorExt}@${contact.ip}:${contact.port}`;
    const monitorId = uuidv4();
    const { uas, uac, cdr } = activeCall;

    logger.info(`MONITOR: ${mode} on [${sipCallId}] supervisor=${supervisorExt}`);

    try {
      // Step 1: RTPEngine subscribe request
      // This asks RTPEngine to fork media from the existing call
      const subscribeOpts = {
        'call-id': sipCallId,
        'from-tags': ['all'],  // subscribe to audio from all parties
        'flags': ['all']
      };

      let offerSdp;
      try {
        const subResp = await this._rtpengineCommand('subscribe request', subscribeOpts);
        if (subResp && subResp.sdp) {
          offerSdp = subResp.sdp;
          logger.info(`MONITOR: subscribe request OK, got SDP offer`);
        } else {
          throw new Error('No SDP in subscribe response');
        }
      } catch (subErr) {
        logger.warn(`MONITOR: subscribe request failed (${subErr.message}), using fallback`);
        // Fallback: create a separate offer using the caller's SDP
        offerSdp = await this._createFallbackOffer(sipCallId, uas);
      }

      if (!offerSdp) throw new Error('Failed to get monitor SDP');

      // Step 2: Call the supervisor's softphone
      // Use sendrecv — the softphone needs to answer normally
      // For listen mode, we'll mute the supervisor's audio at RTPEngine level
      const supervisorDialog = await this.srf.createUAC(supervisorUri, {
        localSdp: offerSdp,
        headers: {
          'Alert-Info': '<http://www.notused.com>;info=alert-autoanswer',
          'X-Monitor-Mode': mode,
          'Call-Info': '<sip:monitor>;answer-after=0'
        }
      });

      logger.info(`MONITOR: supervisor ${supervisorExt} answered`);

      // Step 3: Send subscribe answer with supervisor's SDP
      const supToTag = supervisorDialog.sip ? supervisorDialog.sip.remoteTag : uuidv4();
      try {
        await this._rtpengineCommand('subscribe answer', {
          'call-id': sipCallId,
          'to-tag': supToTag,
          'sdp': supervisorDialog.remote.sdp,
          'flags': ['trust-address'],
          'replace': ['origin', 'session-connection'],
          'ICE': 'remove'
        });
        logger.info(`MONITOR: subscribe answer completed`);
      } catch (ansErr) {
        logger.warn(`MONITOR: subscribe answer failed (${ansErr.message}), using fallback answer`);
        await this._fallbackAnswer(sipCallId, monitorId, supervisorDialog);
      }

      // Step 4: For listen mode, block supervisor's audio from reaching the call
      if (mode === 'listen') {
        try {
          await this.rtpengine.blockMedia(this.rtpengineConfig, {
            'call-id': sipCallId,
            'from-tag': supToTag
          });
          logger.info(`MONITOR: blocked supervisor audio (listen mode)`);
        } catch (e) {
          logger.debug(`MONITOR: blockMedia not available: ${e.message}`);
        }
      }

      // Step 5: For whisper, only send to agent leg
      // For barge, audio goes to both (default behavior)
      // These require more complex RTPEngine routing — for now whisper = barge

      // Track session
      const session = {
        monitorId,
        sipCallId,
        supervisorExt,
        supervisorDialog,
        supervisorTag: supToTag,
        mode,
        startTime: new Date(),
        cdr
      };
      this.monitors.set(monitorId, session);

      // Handle supervisor hangup
      supervisorDialog.on('destroy', () => {
        logger.info(`MONITOR: supervisor disconnected [${monitorId}]`);
        this._cleanup(monitorId);
      });

      // Handle monitored call ending
      const callEndHandler = () => {
        if (this.monitors.has(monitorId)) {
          logger.info(`MONITOR: call ended, disconnecting supervisor`);
          try { supervisorDialog.destroy(); } catch (e) {}
          this._cleanup(monitorId);
        }
      };
      uas.on('destroy', callEndHandler);
      uac.on('destroy', callEndHandler);

      return {
        monitorId, mode, supervisorExt,
        targetCallId: sipCallId,
        targetFrom: cdr ? cdr.from : '?',
        targetTo: cdr ? cdr.to : '?'
      };

    } catch (err) {
      logger.error(`MONITOR: failed - ${err.message}`);
      throw err;
    }
  }

  // ============================================================
  // Fallback offer: use RTPEngine offer on a new call-id
  // that mirrors the active call's media
  // ============================================================
  async _createFallbackOffer(sipCallId, uas) {
    const callerSdp = uas.remote ? uas.remote.sdp : null;
    if (!callerSdp) return null;

    const monCallId = `mon-${sipCallId}`;
    try {
      const resp = await this.rtpengine.offer(this.rtpengineConfig, {
        'call-id': monCallId,
        'from-tag': 'monitor',
        sdp: callerSdp,
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });
      return resp && resp.result === 'ok' ? resp.sdp : null;
    } catch (e) { return null; }
  }

  async _fallbackAnswer(sipCallId, monitorId, supervisorDialog) {
    const monCallId = `mon-${sipCallId}`;
    try {
      await this.rtpengine.answer(this.rtpengineConfig, {
        'call-id': monCallId,
        'from-tag': 'monitor',
        'to-tag': 'sup-' + monitorId.substring(0, 8),
        sdp: supervisorDialog.remote.sdp,
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });
    } catch (e) {
      logger.warn(`MONITOR: fallback answer failed: ${e.message}`);
    }
  }

  // ============================================================
  // Send raw command to RTPEngine via ng protocol
  // The rtpengine-client may not have subscribe methods,
  // so we use the generic command interface
  // ============================================================
  async _rtpengineCommand(command, params) {
    // Try the method directly (newer rtpengine-client versions)
    const methodName = command.replace(/\s+/g, '_').replace('subscribe_', 'subscribe');
    if (typeof this.rtpengine[methodName] === 'function') {
      return this.rtpengine[methodName](this.rtpengineConfig, params);
    }

    // Try camelCase version
    const camel = command.split(' ').map((w, i) => i === 0 ? w : w[0].toUpperCase() + w.slice(1)).join('');
    if (typeof this.rtpengine[camel] === 'function') {
      return this.rtpengine[camel](this.rtpengineConfig, params);
    }

    // The rtpengine-client uses a generic request method internally
    // All ng commands go through the same UDP bencode protocol
    // We can send any command by calling the client's internal method
    if (typeof this.rtpengine.request === 'function') {
      return this.rtpengine.request(this.rtpengineConfig, command, params);
    }

    throw new Error(`RTPEngine client does not support '${command}'`);
  }

  // ============================================================
  // Change mode
  // ============================================================
  async changeMode(monitorId, newMode) {
    const session = this.monitors.get(monitorId);
    if (!session) throw new Error('Monitor session not found');

    if (session.mode === newMode) return session;

    logger.info(`MONITOR: mode change ${session.mode} -> ${newMode}`);

    if (newMode === 'listen') {
      // Block supervisor audio
      try {
        await this.rtpengine.blockMedia(this.rtpengineConfig, {
          'call-id': session.sipCallId,
          'from-tag': session.supervisorTag
        });
      } catch (e) {}
    } else {
      // Unblock supervisor audio (whisper/barge)
      try {
        await this.rtpengine.unblockMedia(this.rtpengineConfig, {
          'call-id': session.sipCallId,
          'from-tag': session.supervisorTag
        });
      } catch (e) {}
    }

    session.mode = newMode;
    return {
      monitorId, mode: newMode,
      supervisorExt: session.supervisorExt,
      targetCallId: session.sipCallId
    };
  }

  // ============================================================
  // Stop monitor
  // ============================================================
  async stopMonitor(monitorId) {
    this._cleanup(monitorId);
  }

  _cleanup(monitorId) {
    const session = this.monitors.get(monitorId);
    if (!session) return;

    try { session.supervisorDialog.destroy(); } catch (e) {}

    // Unsubscribe from RTPEngine
    try {
      this._rtpengineCommand('unsubscribe', {
        'call-id': session.sipCallId,
        'to-tag': session.supervisorTag
      }).catch(() => {});
    } catch (e) {}

    // Also clean up fallback session if used
    try {
      this.rtpengine.delete(this.rtpengineConfig, {
        'call-id': `mon-${session.sipCallId}`,
        'from-tag': 'monitor'
      });
    } catch (e) {}

    this.monitors.delete(monitorId);
    logger.info(`MONITOR: session ${monitorId} ended`);
  }

  // ============================================================
  // Dial codes: *11{ext}=listen, *12{ext}=whisper, *13{ext}=barge
  // ============================================================
  async handleMonitorDial(req, res, fromExt, dialedNumber) {
    const match = dialedNumber.match(/^\*1([123])(\d+)$/);
    if (!match) return false;

    const modeMap = { '1': 'listen', '2': 'whisper', '3': 'barge' };
    const mode = modeMap[match[1]];
    const targetExt = match[2];

    logger.info(`MONITOR: ${fromExt} dialed *1${match[1]}${targetExt} (${mode})`);

    // Find active call for target extension
    let targetCallId = null;
    for (const [sipCallId, call] of this.callHandler.activeCalls) {
      if (call.toExt === targetExt || call.fromExt === targetExt) {
        targetCallId = sipCallId;
        break;
      }
    }

    if (!targetCallId) {
      logger.warn(`MONITOR: no active call for ${targetExt}`);
      return res.send(404);
    }

    try {
      await this.startMonitor(targetCallId, fromExt, mode);
      return true;
    } catch (err) {
      logger.error(`MONITOR: dial failed - ${err.message}`);
      return res.send(503);
    }
  }

  // ============================================================
  // Get active monitors
  // ============================================================
  getActiveMonitors() {
    const monitors = [];
    for (const [id, session] of this.monitors) {
      monitors.push({
        monitorId: id,
        mode: session.mode,
        supervisorExt: session.supervisorExt,
        targetCallId: session.sipCallId,
        startTime: session.startTime,
        duration: Math.round((Date.now() - session.startTime.getTime()) / 1000)
      });
    }
    return monitors;
  }
}

module.exports = MonitorHandler;
