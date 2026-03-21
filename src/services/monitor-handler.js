const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// MonitorHandler — Listen / Whisper / Barge (RTPEngine v9.4 compatible)
//
// Approach for v9.4 (no subscribe support):
//   1. Query the active call in RTPEngine to get its media info
//   2. Call the supervisor's softphone via Drachtio
//   3. Use RTPEngine offer/answer with the SAME call-id but a NEW
//      from-tag — this adds a third participant to the RTPEngine
//      call session. RTPEngine treats it as another leg and mixes
//      the audio.
//   4. For listen mode: use blockMedia on supervisor's tag so
//      their mic doesn't reach the other parties
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

    let sipCallId = callId;
    let activeCall = this.callHandler.activeCalls.get(callId);

    if (!activeCall) {
      for (const [scid, call] of this.callHandler.activeCalls) {
        if (call.cdr && call.cdr.callId === callId) {
          sipCallId = scid;
          activeCall = call;
          break;
        }
      }
    }
    if (!activeCall) throw new Error('Call not found or not active');

    const contacts = await this.registrar.getContacts(supervisorExt);
    if (!contacts || contacts.length === 0) {
      throw new Error(`Supervisor ${supervisorExt} not registered`);
    }

    const contact = contacts[0];
    const supervisorUri = `sip:${supervisorExt}@${contact.ip}:${contact.port}`;
    const monitorId = uuidv4();
    const monitorTag = `mon-${monitorId.substring(0, 8)}`;
    const { uas, uac, cdr } = activeCall;

    logger.info(`MONITOR: ${mode} on [${sipCallId}] supervisor=${supervisorExt}`);

    try {
      // Get the caller's SDP to use as a template for the monitor offer
      const callerSdp = uas.remote ? uas.remote.sdp : null;
      if (!callerSdp) throw new Error('Cannot get SDP from active call');

      // Step 1: Create a third RTPEngine leg on the SAME call-id
      // By using the same call-id with a new from-tag, RTPEngine
      // treats this as an additional participant in the call
      const offerResp = await this.rtpengine.offer(this.rtpengineConfig, {
        'call-id': sipCallId,
        'from-tag': monitorTag,
        sdp: callerSdp,
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });

      if (!offerResp || offerResp.result !== 'ok') {
        throw new Error('RTPEngine offer failed for monitor leg');
      }

      logger.info(`MONITOR: RTPEngine offer OK for third leg (tag=${monitorTag})`);

      // Step 2: Call supervisor's softphone with RTPEngine's SDP
      const supervisorDialog = await this.srf.createUAC(supervisorUri, {
        localSdp: offerResp.sdp,
        headers: {
          'Alert-Info': '<http://www.notused.com>;info=alert-autoanswer',
          'Call-Info': '<sip:monitor>;answer-after=0',
          'X-Monitor-Mode': mode
        }
      });

      logger.info(`MONITOR: supervisor ${supervisorExt} answered`);

      // Step 3: Complete RTPEngine answer with supervisor's SDP
      const supRemoteTag = supervisorDialog.sip ? supervisorDialog.sip.remoteTag : `sup-${monitorId.substring(0, 8)}`;

      const answerResp = await this.rtpengine.answer(this.rtpengineConfig, {
        'call-id': sipCallId,
        'from-tag': monitorTag,
        'to-tag': supRemoteTag,
        sdp: supervisorDialog.remote.sdp,
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });

      if (answerResp && answerResp.result === 'ok') {
        logger.info(`MONITOR: RTPEngine answer OK — third leg established`);
      } else {
        logger.warn(`MONITOR: RTPEngine answer response: ${JSON.stringify(answerResp)}`);
      }

      // Step 4: For listen mode, block supervisor's outgoing audio
      if (mode === 'listen') {
        try {
          await this.rtpengine.blockMedia(this.rtpengineConfig, {
            'call-id': sipCallId,
            'from-tag': monitorTag
          });
          logger.info(`MONITOR: supervisor audio blocked (listen mode)`);
        } catch (e) {
          // blockMedia might not work perfectly — also try silenceMedia
          try {
            await this.rtpengine.silenceMedia(this.rtpengineConfig, {
              'call-id': sipCallId,
              'from-tag': monitorTag
            });
            logger.info(`MONITOR: supervisor audio silenced (listen mode)`);
          } catch (e2) {
            logger.debug(`MONITOR: could not block/silence supervisor audio: ${e2.message}`);
          }
        }
      }

      // Track session
      const session = {
        monitorId,
        sipCallId,
        monitorTag,
        supRemoteTag,
        supervisorExt,
        supervisorDialog,
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
  // Change mode
  // ============================================================
  async changeMode(monitorId, newMode) {
    const session = this.monitors.get(monitorId);
    if (!session) throw new Error('Monitor session not found');
    if (session.mode === newMode) return { monitorId, mode: newMode, supervisorExt: session.supervisorExt, targetCallId: session.sipCallId };

    logger.info(`MONITOR: mode ${session.mode} -> ${newMode}`);

    if (newMode === 'listen') {
      // Block supervisor audio
      try {
        await this.rtpengine.blockMedia(this.rtpengineConfig, {
          'call-id': session.sipCallId,
          'from-tag': session.monitorTag
        });
      } catch (e) {
        try { await this.rtpengine.silenceMedia(this.rtpengineConfig, { 'call-id': session.sipCallId, 'from-tag': session.monitorTag }); } catch (e2) {}
      }
    } else {
      // Unblock supervisor audio for whisper/barge
      try {
        await this.rtpengine.unblockMedia(this.rtpengineConfig, {
          'call-id': session.sipCallId,
          'from-tag': session.monitorTag
        });
      } catch (e) {
        try { await this.rtpengine.unsilenceMedia(this.rtpengineConfig, { 'call-id': session.sipCallId, 'from-tag': session.monitorTag }); } catch (e2) {}
      }
    }

    session.mode = newMode;
    return { monitorId, mode: newMode, supervisorExt: session.supervisorExt, targetCallId: session.sipCallId };
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

    // Delete the monitor leg from RTPEngine
    try {
      this.rtpengine.delete(this.rtpengineConfig, {
        'call-id': session.sipCallId,
        'from-tag': session.monitorTag,
        'to-tag': session.supRemoteTag,
        'delete-delay': 0
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

  getActiveMonitors() {
    const monitors = [];
    for (const [id, session] of this.monitors) {
      monitors.push({
        monitorId: id, mode: session.mode,
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
