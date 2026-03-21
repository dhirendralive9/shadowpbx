const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// MonitorHandler — Listen / Whisper / Barge
// 
// RTPEngine v9.4 compatible approach:
//
// The B2BUA (simring) creates its own RTPEngine call-id that we
// don't have access to. Instead, we:
//
//   1. Get the agent's SDP from the active UAS/UAC dialog
//   2. Re-INVITE the agent's leg with a modified SDP that includes
//      a new RTP port for mixing
//   3. Create a new call to the supervisor using the agent's audio
//
// Simpler approach used here:
//   1. Get the remote SDP from the agent's dialog (uac)
//   2. Create a brand new RTPEngine session for the monitor
//   3. Call the supervisor with that session's SDP
//   4. The supervisor receives audio — but from a new RTP stream
//
// For true media mixing, we re-INVITE the agent's dialog to point
// its media through our new RTPEngine session, which then forks
// to both the original caller and the supervisor.
//
// ACTUAL WORKING APPROACH:
//   Just create a simple B2BUA call from the system to the
//   supervisor, and use the agent leg's SDP as the offer.
//   Then modify the agent's dialog to send media to BOTH the
//   original destination AND the monitor.
//
// SIMPLEST RELIABLE APPROACH (used here):
//   Call the supervisor. On answer, do a re-INVITE on the agent's
//   leg (uac) with the supervisor's media port included. The 
//   agent's softphone then sends audio to the new port too.
//   
//   Actually — the simplest approach that works: Record the call
//   and stream it. But for real-time monitoring, we use the 
//   RTPEngine on the ORIGINAL call's tags.
//
// FINAL APPROACH:
//   The B2BUA dialogs (uas/uac) have SDP with the RTPEngine ports.
//   The uas.local.sdp contains the RTPEngine address that the
//   caller sends to. The uac.local.sdp contains the RTPEngine
//   address that the agent sends to. 
//   We need to tell RTPEngine to also send copies of this audio
//   to the supervisor. Since subscribe isn't available in v9.4,
//   we'll use a hack: create the supervisor call, then send
//   RTPEngine a new offer/answer using the B2BUA's EXISTING tags
//   plus the supervisor as an additional participant.
//   But we need the B2BUA's call-id...
//
//   GETTING THE B2BUA CALL-ID:
//   The uas.sip and uac.sip objects contain the SIP headers.
//   uas.sip.callId gives us the SIP Call-ID used by the B2BUA.
//   But simring might use a different call-id for RTPEngine.
//   
//   Let's just read it from the dialog object.
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
    const { uas, uac, cdr } = activeCall;

    logger.info(`MONITOR: ${mode} on [${sipCallId}] supervisor=${supervisorExt}`);

    try {
      // Try to extract the actual call-id used in the SIP dialog
      // The B2BUA dialog objects have the SIP Call-ID
      let rtpCallId = null;

      // Try uac (agent leg) call-id — this is what the B2BUA used with RTPEngine
      if (uac && uac.sip && uac.sip.callId) {
        rtpCallId = uac.sip.callId;
        logger.info(`MONITOR: found UAC SIP call-id: ${rtpCallId}`);
      } else if (uas && uas.sip && uas.sip.callId) {
        rtpCallId = uas.sip.callId;
        logger.info(`MONITOR: found UAS SIP call-id: ${rtpCallId}`);
      }

      // If we got a real call-id, try to query RTPEngine for it
      if (rtpCallId && rtpCallId !== sipCallId) {
        logger.info(`MONITOR: B2BUA call-id differs from SIP call-id: ${rtpCallId} vs ${sipCallId}`);
      }

      // The simring B2BUA generates call-ids internally.
      // We don't know it. But we can get the SDP from the dialogs.
      // The agent's SDP tells us what RTP port the agent sends to.
      // We'll create a new session and call the supervisor.

      // Get the caller's SDP (what the trunk sends to our RTPEngine)
      const callerSdp = uas.remote ? uas.remote.sdp : null;
      const agentSdp = uac.remote ? uac.remote.sdp : null;
      // Our local SDPs (what RTPEngine advertises)
      const ourSdpToAgent = uac.local ? uac.local.sdp : null;

      if (!agentSdp && !callerSdp) {
        throw new Error('No SDP available from active call');
      }

      // Use the agent's remote SDP as template — this has the codec info
      const templateSdp = agentSdp || callerSdp;

      // Create a completely new RTPEngine session for the monitor
      const monitorCallId = `spbx-mon-${monitorId.substring(0, 8)}`;
      const monitorTag = 'monitor-src';

      const offerResp = await this.rtpengine.offer(this.rtpengineConfig, {
        'call-id': monitorCallId,
        'from-tag': monitorTag,
        sdp: templateSdp,
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });

      if (!offerResp || offerResp.result !== 'ok') {
        throw new Error('RTPEngine offer failed');
      }

      // Call supervisor with this SDP
      const supervisorDialog = await this.srf.createUAC(supervisorUri, {
        localSdp: offerResp.sdp,
        headers: {
          'Alert-Info': '<http://www.notused.com>;info=alert-autoanswer',
          'Call-Info': '<sip:monitor>;answer-after=0',
          'X-Monitor-Mode': mode
        }
      });

      logger.info(`MONITOR: supervisor ${supervisorExt} answered`);

      // Complete RTPEngine answer
      const supTag = supervisorDialog.sip ? supervisorDialog.sip.remoteTag : `sup-${monitorId.substring(0, 8)}`;
      
      await this.rtpengine.answer(this.rtpengineConfig, {
        'call-id': monitorCallId,
        'from-tag': monitorTag,
        'to-tag': supTag,
        sdp: supervisorDialog.remote.sdp,
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });

      logger.info(`MONITOR: RTPEngine session established [${monitorCallId}]`);

      // Now the key part: bridge audio from the active call to the monitor.
      // We do this by re-INVITEing the agent's dialog so their softphone
      // sends a copy of its RTP to our monitor's RTPEngine port.
      // 
      // Extract the monitor's RTP port from the offer SDP
      const monitorRtpPort = this._extractPort(offerResp.sdp);
      const monitorRtpIp = this._extractIP(offerResp.sdp);

      if (monitorRtpPort && monitorRtpIp) {
        // Re-INVITE the agent's dialog to also include the monitor port
        // Actually, we can't do multicast via re-INVITE easily.
        // Instead, let's have the monitor RTPEngine session SEND packets
        // to the agent's RTP address — effectively bridging audio.
        
        // Get agent's actual RTP endpoint from its SDP
        const agentRtpPort = this._extractPort(agentSdp);
        const agentRtpIp = this._extractIP(agentSdp);
        
        // And the caller's RTP endpoint
        const callerRtpPort = callerSdp ? this._extractPort(callerSdp) : null;
        const callerRtpIp = callerSdp ? this._extractIP(callerSdp) : null;

        logger.info(`MONITOR: agent RTP=${agentRtpIp}:${agentRtpPort}, caller RTP=${callerRtpIp}:${callerRtpPort}, monitor RTP=${monitorRtpIp}:${monitorRtpPort}`);
      }

      // Since we can't easily fork RTP in v9.4, use the RECORDING feature
      // as a workaround: start recording on the active call, and play
      // the recording file to the supervisor in real-time.
      //
      // Actually, the simplest working approach for v9.4:
      // Use playMedia on the monitor session with the call's recording.
      // But that's not real-time.
      //
      // THE REAL SOLUTION: re-INVITE both legs of the active call
      // through our monitor's RTPEngine session. This makes the monitor
      // session the media anchor, and it can fork to the supervisor.

      // Re-INVITE the caller (uas) to send media through our monitor session
      try {
        // Create a new offer for the caller through the monitor session
        const reInviteOffer = await this.rtpengine.offer(this.rtpengineConfig, {
          'call-id': monitorCallId,
          'from-tag': 'caller-leg',
          sdp: callerSdp || templateSdp,
          'flags': ['trust-address'],
          'replace': ['origin', 'session-connection'],
          'ICE': 'remove'
        });

        if (reInviteOffer && reInviteOffer.result === 'ok') {
          // Re-INVITE the caller's dialog with the new RTP address
          await uas.modify(reInviteOffer.sdp);
          logger.info(`MONITOR: re-INVITE caller to monitor RTPEngine`);

          // Now re-INVITE the agent through the same session
          const agentReInvite = await this.rtpengine.answer(this.rtpengineConfig, {
            'call-id': monitorCallId,
            'from-tag': 'caller-leg',
            'to-tag': 'agent-leg',
            sdp: agentSdp || templateSdp,
            'flags': ['trust-address'],
            'replace': ['origin', 'session-connection'],
            'ICE': 'remove'
          });

          if (agentReInvite && agentReInvite.result === 'ok') {
            await uac.modify(agentReInvite.sdp);
            logger.info(`MONITOR: re-INVITE agent to monitor RTPEngine`);
          }
        }

        logger.info(`MONITOR: media path now flows through monitor session — supervisor should hear audio`);
      } catch (reInvErr) {
        logger.warn(`MONITOR: re-INVITE failed (${reInvErr.message}) — supervisor may not hear audio`);
      }

      // For listen mode, block supervisor's outgoing audio
      if (mode === 'listen') {
        try {
          await this.rtpengine.blockMedia(this.rtpengineConfig, {
            'call-id': monitorCallId,
            'from-tag': monitorTag
          });
          logger.info(`MONITOR: supervisor audio blocked (listen mode)`);
        } catch (e) {
          try {
            await this.rtpengine.silenceMedia(this.rtpengineConfig, {
              'call-id': monitorCallId,
              'from-tag': monitorTag
            });
          } catch (e2) {}
        }
      }

      // Track session
      const session = {
        monitorId, monitorCallId, monitorTag, supTag,
        sipCallId, supervisorExt, supervisorDialog, mode,
        startTime: new Date(), cdr,
        originalUas: uas, originalUac: uac,
        originalCallerSdp: callerSdp,
        originalAgentSdp: agentSdp
      };
      this.monitors.set(monitorId, session);

      // Cleanup on supervisor hangup
      supervisorDialog.on('destroy', () => {
        logger.info(`MONITOR: supervisor disconnected [${monitorId}]`);
        this._cleanup(monitorId);
      });

      // Cleanup on call end
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

  async changeMode(monitorId, newMode) {
    const session = this.monitors.get(monitorId);
    if (!session) throw new Error('Monitor session not found');
    if (session.mode === newMode) return { monitorId, mode: newMode, supervisorExt: session.supervisorExt, targetCallId: session.sipCallId };

    logger.info(`MONITOR: mode ${session.mode} -> ${newMode}`);

    if (newMode === 'listen') {
      try { await this.rtpengine.blockMedia(this.rtpengineConfig, { 'call-id': session.monitorCallId, 'from-tag': session.monitorTag }); } catch (e) {
        try { await this.rtpengine.silenceMedia(this.rtpengineConfig, { 'call-id': session.monitorCallId, 'from-tag': session.monitorTag }); } catch (e2) {}
      }
    } else {
      try { await this.rtpengine.unblockMedia(this.rtpengineConfig, { 'call-id': session.monitorCallId, 'from-tag': session.monitorTag }); } catch (e) {
        try { await this.rtpengine.unsilenceMedia(this.rtpengineConfig, { 'call-id': session.monitorCallId, 'from-tag': session.monitorTag }); } catch (e2) {}
      }
    }

    session.mode = newMode;
    return { monitorId, mode: newMode, supervisorExt: session.supervisorExt, targetCallId: session.sipCallId };
  }

  async stopMonitor(monitorId) { this._cleanup(monitorId); }

  _cleanup(monitorId) {
    const session = this.monitors.get(monitorId);
    if (!session) return;

    try { session.supervisorDialog.destroy(); } catch (e) {}

    // Restore original media path — re-INVITE back to original SDPs
    try {
      if (session.originalCallerSdp && session.originalUas) {
        // Re-INVITE caller back to original B2BUA RTPEngine
        session.originalUas.modify(session.originalCallerSdp).catch(() => {});
      }
      if (session.originalAgentSdp && session.originalUac) {
        session.originalUac.modify(session.originalAgentSdp).catch(() => {});
      }
    } catch (e) {
      logger.warn(`MONITOR: failed to restore original media path: ${e.message}`);
    }

    // Delete monitor RTPEngine session
    try {
      this.rtpengine.delete(this.rtpengineConfig, {
        'call-id': session.monitorCallId,
        'from-tag': session.monitorTag
      });
    } catch (e) {}

    this.monitors.delete(monitorId);
    logger.info(`MONITOR: session ${monitorId} ended`);
  }

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
    for (const [id, s] of this.monitors) {
      monitors.push({
        monitorId: id, mode: s.mode,
        supervisorExt: s.supervisorExt,
        targetCallId: s.sipCallId,
        startTime: s.startTime,
        duration: Math.round((Date.now() - s.startTime.getTime()) / 1000)
      });
    }
    return monitors;
  }

  _extractPort(sdp) {
    if (!sdp) return null;
    const m = sdp.match(/m=audio\s+(\d+)/);
    return m ? parseInt(m[1]) : null;
  }

  _extractIP(sdp) {
    if (!sdp) return null;
    const m = sdp.match(/c=IN\s+IP4\s+(\S+)/);
    return m ? m[1] : null;
  }
}

module.exports = MonitorHandler;
