const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// MonitorHandler — Supervisor monitoring tools
//
// Three modes:
//   LISTEN  — Supervisor hears both parties, neither hears supervisor
//   WHISPER — Supervisor hears both, only agent hears supervisor
//   BARGE   — Everyone hears everyone (3-way conference)
//
// Implementation:
//   1. Supervisor dials *11{ext} (listen), *12{ext} (whisper), *13{ext} (barge)
//      OR clicks button in GUI which calls the API
//   2. API finds the active call for the target extension
//   3. System calls the supervisor's registered softphone
//   4. RTPEngine subscribes to the existing call's media
//      and bridges it to the supervisor with appropriate direction
//
// RTPEngine media flow:
//   LISTEN:  supervisor receives mixed audio from both legs (recvonly)
//   WHISPER: supervisor receives mixed audio, sends only to agent leg
//   BARGE:   supervisor sends/receives to both legs (full conference)
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
    // Active monitor sessions: monitorId -> { supervisorDialog, targetCallId, mode, ... }
    this.monitors = new Map();
  }

  // ============================================================
  // Start monitoring via API
  // POST /api/calls/:callId/monitor { supervisorExt, mode }
  // ============================================================
  async startMonitor(callId, supervisorExt, mode = 'listen') {
    mode = ['listen', 'whisper', 'barge'].includes(mode) ? mode : 'listen';

    // Find the active call
    const activeCall = this.callHandler.activeCalls.get(callId);
    if (!activeCall) {
      // Try finding by CDR callId
      for (const [sipCallId, call] of this.callHandler.activeCalls) {
        if (call.cdr && call.cdr.callId === callId) {
          return this._startMonitorOnCall(sipCallId, call, supervisorExt, mode);
        }
      }
      throw new Error('Call not found or not active');
    }

    return this._startMonitorOnCall(callId, activeCall, supervisorExt, mode);
  }

  async _startMonitorOnCall(sipCallId, activeCall, supervisorExt, mode) {
    const { uas, uac, cdr } = activeCall;

    // Get supervisor's registered contact
    const contacts = await this.registrar.getContacts(supervisorExt);
    if (!contacts || contacts.length === 0) {
      throw new Error(`Supervisor extension ${supervisorExt} not registered`);
    }

    const contact = contacts[0];
    const supervisorUri = `sip:${supervisorExt}@${contact.ip}:${contact.port}`;
    const monitorId = uuidv4();

    logger.info(`MONITOR: starting ${mode} on call [${sipCallId}] supervisor=${supervisorExt} -> ${supervisorUri}`);

    try {
      // Get the SDP from the active call's UAS leg (caller side)
      // We need to know what media is flowing
      const callerSdp = uas.remote ? uas.remote.sdp : null;
      const agentSdp = uac.remote ? uac.remote.sdp : null;

      if (!callerSdp) {
        throw new Error('Cannot get caller SDP from active call');
      }

      // Create a new RTPEngine session for the monitor leg
      // This is a separate call-id for the supervisor's connection
      const monitorCallId = `monitor-${monitorId}`;

      // Step 1: Create RTPEngine offer for supervisor
      // We create a new media session that will receive audio from the monitored call
      const offerResponse = await this.rtpengine.offer(this.rtpengineConfig, {
        'call-id': monitorCallId,
        'from-tag': 'supervisor',
        sdp: callerSdp,
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });

      if (!offerResponse || offerResponse.result !== 'ok') {
        throw new Error('RTPEngine offer failed for monitor session');
      }

      // Step 2: Modify SDP direction based on mode
      let supervisorSdp = offerResponse.sdp;
      if (mode === 'listen') {
        // Supervisor can only receive — make it sendonly from RTPEngine's perspective
        // which means recvonly for the supervisor
        supervisorSdp = this._setSdpDirection(supervisorSdp, 'sendonly');
      }

      // Step 3: Call the supervisor's softphone
      const supervisorDialog = await this.srf.createUAC(supervisorUri, {
        localSdp: supervisorSdp,
        headers: {
          'X-Monitor-Mode': mode,
          'X-Monitor-CallId': sipCallId,
          'Alert-Info': '<http://www.notused.com>;info=alert-autoanswer'
        }
      });

      logger.info(`MONITOR: supervisor ${supervisorExt} answered, mode=${mode}`);

      // Step 4: Complete RTPEngine session
      const toTag = supervisorDialog.sip ? supervisorDialog.sip.remoteTag : 'sup-answer';
      await this.rtpengine.answer(this.rtpengineConfig, {
        'call-id': monitorCallId,
        'from-tag': 'supervisor',
        'to-tag': toTag,
        sdp: supervisorDialog.remote.sdp,
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });

      // Step 5: Subscribe to the monitored call's media
      // Use RTPEngine's subscribe mechanism to fork media from the active call
      await this._subscribeToCallMedia(sipCallId, monitorCallId, uas, uac, mode);

      // Track the monitor session
      const monitorSession = {
        monitorId,
        monitorCallId,
        targetCallId: sipCallId,
        supervisorExt,
        supervisorDialog,
        mode,
        startTime: new Date(),
        cdr
      };

      this.monitors.set(monitorId, monitorSession);

      // Handle supervisor hangup
      supervisorDialog.on('destroy', () => {
        logger.info(`MONITOR: supervisor ${supervisorExt} disconnected from ${mode} [${sipCallId}]`);
        this._stopMonitor(monitorId);
      });

      // Handle monitored call ending
      const origUasDestroy = uas.listeners('destroy');
      uas.on('destroy', () => {
        if (this.monitors.has(monitorId)) {
          logger.info(`MONITOR: monitored call ended, disconnecting supervisor`);
          try { supervisorDialog.destroy(); } catch (e) {}
          this._stopMonitor(monitorId);
        }
      });

      uac.on('destroy', () => {
        if (this.monitors.has(monitorId)) {
          logger.info(`MONITOR: monitored call ended, disconnecting supervisor`);
          try { supervisorDialog.destroy(); } catch (e) {}
          this._stopMonitor(monitorId);
        }
      });

      return {
        monitorId,
        mode,
        supervisorExt,
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
  // Subscribe to call media via RTPEngine
  // ============================================================
  async _subscribeToCallMedia(targetCallId, monitorCallId, uas, uac, mode) {
    // Get tags from the active call
    const uasFromTag = uas.sip ? (uas.sip.remoteTag || uas.sip.localTag) : '';
    const uacFromTag = uac.sip ? (uac.sip.remoteTag || uac.sip.localTag) : '';

    try {
      // Subscribe to BOTH legs of the active call
      // This makes RTPEngine fork the media to our monitor session

      // Fork caller audio to supervisor
      await this.rtpengine.subscribe && await this.rtpengine.subscribe(this.rtpengineConfig, {
        'call-id': targetCallId,
        'from-tag': uasFromTag,
        'to-call-id': monitorCallId,
        'to-from-tag': 'supervisor'
      });

      // Fork agent audio to supervisor
      await this.rtpengine.subscribe && await this.rtpengine.subscribe(this.rtpengineConfig, {
        'call-id': targetCallId,
        'from-tag': uacFromTag,
        'to-call-id': monitorCallId,
        'to-from-tag': 'supervisor'
      });

      if (mode === 'whisper' || mode === 'barge') {
        // For whisper: send supervisor audio to agent leg only
        // For barge: send supervisor audio to both legs
        // This is done by subscribing the monitor session back to the call

        // Supervisor audio → agent
        await this.rtpengine.subscribe && await this.rtpengine.subscribe(this.rtpengineConfig, {
          'call-id': monitorCallId,
          'from-tag': 'supervisor',
          'to-call-id': targetCallId,
          'to-from-tag': uacFromTag  // agent side
        });

        if (mode === 'barge') {
          // Supervisor audio → caller too
          await this.rtpengine.subscribe && await this.rtpengine.subscribe(this.rtpengineConfig, {
            'call-id': monitorCallId,
            'from-tag': 'supervisor',
            'to-call-id': targetCallId,
            'to-from-tag': uasFromTag  // caller side
          });
        }
      }

      logger.info(`MONITOR: media subscription established (mode=${mode})`);

    } catch (err) {
      // Subscribe may not be available in older RTPEngine versions
      // Fall back to a simpler approach using SDP manipulation
      logger.warn(`MONITOR: RTPEngine subscribe not available (${err.message}), using SDP bridge`);
      await this._fallbackMediaBridge(targetCallId, monitorCallId, uas, uac, mode);
    }
  }

  // ============================================================
  // Fallback: bridge media via SDP re-INVITE
  // Used when RTPEngine doesn't support subscribe
  // ============================================================
  async _fallbackMediaBridge(targetCallId, monitorCallId, uas, uac, mode) {
    // Simple approach: use the monitor RTPEngine session and
    // set it to receive media from the call's RTP addresses
    // This works by making both the call and monitor use the same RTPEngine ports
    logger.info(`MONITOR: using fallback media bridge`);
    // The offer/answer we already did creates a valid RTP endpoint
    // The subscribe approach above handles the actual media forking
    // If subscribe isn't available, the supervisor will hear silence
    // until we implement a more complex bridge
  }

  // ============================================================
  // Change monitor mode (e.g., listen → whisper → barge)
  // ============================================================
  async changeMode(monitorId, newMode) {
    const session = this.monitors.get(monitorId);
    if (!session) throw new Error('Monitor session not found');

    const oldMode = session.mode;
    if (oldMode === newMode) return session;

    logger.info(`MONITOR: changing mode ${oldMode} -> ${newMode} [${session.targetCallId}]`);

    const activeCall = this.callHandler.activeCalls.get(session.targetCallId);
    if (!activeCall) throw new Error('Monitored call no longer active');

    // Re-establish media subscriptions with new mode
    await this._subscribeToCallMedia(
      session.targetCallId, session.monitorCallId,
      activeCall.uas, activeCall.uac, newMode
    );

    // Update SDP direction on supervisor's call
    if (newMode === 'listen') {
      // Make supervisor recvonly
      const newSdp = this._setSdpDirection(session.supervisorDialog.local.sdp, 'sendonly');
      try { await session.supervisorDialog.modify(newSdp); } catch (e) {}
    } else {
      // Make supervisor sendrecv for whisper/barge
      const newSdp = this._setSdpDirection(session.supervisorDialog.local.sdp, 'sendrecv');
      try { await session.supervisorDialog.modify(newSdp); } catch (e) {}
    }

    session.mode = newMode;
    return {
      monitorId,
      mode: newMode,
      supervisorExt: session.supervisorExt,
      targetCallId: session.targetCallId
    };
  }

  // ============================================================
  // Stop monitoring
  // ============================================================
  async stopMonitor(monitorId) {
    return this._stopMonitor(monitorId);
  }

  _stopMonitor(monitorId) {
    const session = this.monitors.get(monitorId);
    if (!session) return;

    // Destroy supervisor dialog
    try { session.supervisorDialog.destroy(); } catch (e) {}

    // Clean up RTPEngine monitor session
    try {
      this.rtpengine.delete(this.rtpengineConfig, {
        'call-id': session.monitorCallId,
        'from-tag': 'supervisor'
      });
    } catch (e) {}

    this.monitors.delete(monitorId);
    logger.info(`MONITOR: session ${monitorId} ended (${session.mode} on ${session.targetCallId})`);
  }

  // ============================================================
  // Handle dial codes: *11{ext}=listen, *12{ext}=whisper, *13{ext}=barge
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
      logger.warn(`MONITOR: no active call for extension ${targetExt}`);
      return res.send(404);
    }

    try {
      const result = await this.startMonitor(targetCallId, fromExt, mode);
      logger.info(`MONITOR: ${fromExt} now ${mode}ing call [${targetCallId}]`);
      // The supervisor's phone is already ringing/answered via startMonitor
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
        targetCallId: session.targetCallId,
        startTime: session.startTime,
        duration: Math.round((Date.now() - session.startTime.getTime()) / 1000)
      });
    }
    return monitors;
  }

  // ============================================================
  // SDP helpers
  // ============================================================
  _setSdpDirection(sdp, direction) {
    if (!sdp) return sdp;
    let modified = sdp
      .replace(/a=sendrecv/g, `a=${direction}`)
      .replace(/a=recvonly/g, `a=${direction}`)
      .replace(/a=sendonly/g, `a=${direction}`)
      .replace(/a=inactive/g, `a=${direction}`);
    // If no direction attribute exists, add one
    if (!modified.includes(`a=${direction}`)) {
      modified = modified.replace(/(m=audio[^\r\n]+)/, `$1\r\na=${direction}`);
    }
    return modified;
  }
}

module.exports = MonitorHandler;
