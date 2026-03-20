const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// RTPEngine runs in Docker — audio paths must be container paths
const AUDIO_HOST_DIR = process.env.MOH_DIR || '/opt/shadowpbx/audio';
function toContainerPath(hostPath) {
  if (!hostPath) return hostPath;
  if (hostPath.startsWith(AUDIO_HOST_DIR)) return hostPath.replace(AUDIO_HOST_DIR, '/audio');
  if (hostPath.startsWith('/audio/')) return hostPath;
  return hostPath;
}

class IvrHandler {
  constructor(srf, rtpengine, callHandler, registrar, ringGroupHandler, trunkManager, callRouter, voicemailHandler, dtmfListener) {
    this.srf = srf;
    this.rtpengine = rtpengine;
    this.callHandler = callHandler;
    this.registrar = registrar;
    this.ringGroupHandler = ringGroupHandler;
    this.trunkManager = trunkManager;
    this.callRouter = callRouter;
    this.voicemailHandler = voicemailHandler;
    this.dtmfListener = dtmfListener;
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };
  }

  // ============================================================
  // Handle an inbound call routed to an IVR
  //
  // Flow:
  //   1. Answer the call (create UAS dialog via RTPEngine)
  //   2. Play greeting WAV
  //   3. Listen for DTMF (SIP INFO or RTPEngine event)
  //   4. Route based on digit pressed
  //   5. On timeout → replay or route to default destination
  // ============================================================
  async handleIvr(req, res, ivrConfig, cdr) {
    const sipCallId = req.get('Call-Id');
    const from = req.getParsedHeader('From');
    const fromTag = from.params.tag;
    const callerID = this.callHandler.callRouter.extractCallerID(req);

    logger.info(`IVR: ${callerID} -> IVR:${ivrConfig.number} (${ivrConfig.name}) [${sipCallId}]`);

    try {
      // Step 1: Answer with RTPEngine
      const rtpOffer = await this._rtpengineOffer(sipCallId, fromTag, req.body);
      if (!rtpOffer) {
        logger.error(`IVR: RTPEngine offer failed — cannot run IVR without media`);
        return res.send(503);
      }

      const uas = await this.srf.createUAS(req, res, { localSdp: rtpOffer.sdp });
      logger.info(`IVR: call answered [${sipCallId}]`);

      // Complete RTPEngine session
      const toTag = uas.sip ? uas.sip.localTag : '';
      if (toTag) {
        await this.rtpengine.answer(this.rtpengineConfig, {
          'call-id': sipCallId,
          'from-tag': fromTag,
          'to-tag': toTag,
          sdp: rtpOffer.sdp,
          'flags': ['trust-address'],
          'replace': ['origin', 'session-connection'],
          'ICE': 'remove'
        });
      }

      // Wait for RTP to stabilize
      await this._sleep(300);

      // Update CDR
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.to = `IVR:${ivrConfig.number}`;
      await cdr.save();

      // Step 2: Run the IVR menu loop
      await this._runMenu(uas, ivrConfig, sipCallId, fromTag, callerID, cdr, req);

    } catch (err) {
      logger.error(`IVR: failed - ${err.message}`);
      if (!res.finalResponseSent) res.send(500);
    }
  }

  // ============================================================
  // IVR Menu Loop
  //
  // Plays the greeting, waits for DTMF, routes or replays.
  // Supports configurable number of retries before timeout dest.
  // ============================================================
  async _runMenu(uas, ivrConfig, sipCallId, fromTag, callerID, cdr, originalReq) {
    const maxRetries = ivrConfig.maxRetries || 3;
    const timeout = (ivrConfig.timeout || 10) * 1000; // ms
    let callerHungUp = false;
    let dtmfDigit = null;
    let dtmfResolve = null;

    // Listen for caller hangup
    uas.on('destroy', () => {
      callerHungUp = true;
      if (dtmfResolve) dtmfResolve(null);
      if (this.dtmfListener) this.dtmfListener.unregister(sipCallId);
      this._rtpengineDelete(sipCallId, fromTag);
      cdr.status = 'completed';
      cdr.endTime = new Date();
      cdr.duration = Math.round((cdr.endTime - cdr.startTime) / 1000);
      cdr.talkTime = cdr.answerTime ? Math.round((cdr.endTime - cdr.answerTime) / 1000) : 0;
      cdr.hangupBy = 'caller';
      cdr.hangupCause = 'normal_clearing';
      cdr.save().catch(() => {});
      logger.info(`IVR: caller hung up [${sipCallId}]`);
    });

    // Listen for DTMF via SIP INFO (some endpoints use this)
    uas.on('info', (infoReq, infoRes) => {
      const contentType = infoReq.get('Content-Type') || '';
      const body = infoReq.body || '';

      logger.debug(`IVR: SIP INFO received: Content-Type=${contentType} body=${body.trim()}`);

      // Handle application/dtmf-relay
      if (contentType.includes('dtmf-relay') || contentType.includes('dtmf')) {
        const signalMatch = body.match(/Signal\s*=\s*(\S+)/i);
        if (signalMatch) {
          dtmfDigit = signalMatch[1].trim();
          logger.info(`IVR: DTMF detected via SIP INFO: ${dtmfDigit}`);
          if (dtmfResolve) dtmfResolve(dtmfDigit);
        }
      }

      // Handle application/dtmf (just the digit)
      if (contentType.includes('application/dtmf')) {
        dtmfDigit = body.trim();
        logger.info(`IVR: DTMF detected via SIP INFO: ${dtmfDigit}`);
        if (dtmfResolve) dtmfResolve(dtmfDigit);
      }

      infoRes.send(200);
    });

    // Register with DTMF listener for RFC 2833 events from RTPEngine
    // This is the primary detection method for trunk calls (Twilio, SignalWire)
    if (this.dtmfListener) {
      this.dtmfListener.register(sipCallId, (digit, tag, callId) => {
        logger.info(`IVR: DTMF detected via RTPEngine UDP: digit=${digit} [${callId}]`);
        dtmfDigit = digit;
        if (dtmfResolve) dtmfResolve(digit);
      });
    }

    // Also pass DTMF log dest in the RTPEngine offer for per-call DTMF logging
    const dtmfPort = parseInt(process.env.DTMF_LISTEN_PORT) || 22223;
    try {
      await this.rtpengine.subscribeDTMF && await this.rtpengine.subscribeDTMF(this.rtpengineConfig, {
        'call-id': sipCallId,
        'from-tag': fromTag
      });
    } catch (e) {
      logger.debug(`IVR: subscribeDTMF not available: ${e.message}`);
    }

    // Menu loop
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (callerHungUp) return;

      // Play greeting
      const greetingFile = this._getGreetingFile(ivrConfig);
      if (greetingFile) {
        logger.info(`IVR: playing menu greeting (attempt ${attempt + 1}/${maxRetries})`);
        try {
          const playResp = await this.rtpengine.playMedia(this.rtpengineConfig, {
            'call-id': sipCallId,
            'from-tag': fromTag,
            file: toContainerPath(greetingFile)
          });
          logger.debug(`IVR: greeting play response: ${JSON.stringify(playResp)}`);

          // Wait for greeting duration
          const duration = playResp.duration || 5000;
          await this._sleep(Math.min(duration, 15000));
        } catch (err) {
          logger.warn(`IVR: greeting play failed: ${err.message}`);
        }
      }

      if (callerHungUp) return;

      // Wait for DTMF with timeout
      dtmfDigit = null;
      const digit = await new Promise((resolve) => {
        let timer = null;
        let resolved = false;

        const done = (d) => {
          if (resolved) return;
          resolved = true;
          dtmfResolve = null;
          if (timer) clearTimeout(timer);
          resolve(d);
        };

        // Set the closure variable so SIP INFO handler can trigger it
        dtmfResolve = done;

        timer = setTimeout(() => done(null), timeout);
      });

      if (callerHungUp) return;

      if (digit) {
        logger.info(`IVR: digit pressed: ${digit}`);

        // Find matching option
        const option = ivrConfig.options.find(o => o.digit === digit);

        if (option) {
          logger.info(`IVR: routing digit ${digit} -> ${option.destination.type}:${option.destination.target}`);
          await this._routeToDestination(uas, option.destination, sipCallId, fromTag, callerID, cdr, originalReq);
          return;
        } else {
          logger.info(`IVR: invalid digit ${digit} — replaying menu`);
          // Play invalid option tone and retry
          await this._playTone(sipCallId, fromTag, 400, 500);
          continue;
        }
      } else {
        logger.info(`IVR: no input (timeout) — attempt ${attempt + 1}/${maxRetries}`);
      }
    }

    // Max retries reached — route to timeout destination
    if (!callerHungUp) {
      if (ivrConfig.timeoutDest && ivrConfig.timeoutDest.type) {
        logger.info(`IVR: timeout -> ${ivrConfig.timeoutDest.type}:${ivrConfig.timeoutDest.target}`);
        await this._routeToDestination(uas, ivrConfig.timeoutDest, sipCallId, fromTag, callerID, cdr, originalReq);
      } else {
        logger.info(`IVR: timeout, no destination — hanging up`);
        try { uas.destroy(); } catch (e) {}
      }
    }
  }

  // ============================================================
  // Route to a destination after digit press or timeout
  // ============================================================
  async _routeToDestination(uas, destination, sipCallId, fromTag, callerID, cdr, originalReq) {
    const { type, target } = destination;

    // Clean up IVR session
    if (this.dtmfListener) this.dtmfListener.unregister(sipCallId);
    await this._rtpengineDelete(sipCallId, fromTag);

    switch (type) {
      case 'extension': {
        const contacts = await this.registrar.getContacts(target);
        if (contacts.length === 0) {
          logger.warn(`IVR ROUTE: extension ${target} not registered`);
          // Try voicemail
          if (this.voicemailHandler) {
            // We need to create a new call to the extension
            // For now, send to voicemail directly
            logger.info(`IVR ROUTE: sending to voicemail for ${target}`);
          }
          try { uas.destroy(); } catch (e) {}
          return;
        }

        const contact = contacts[0];
        const targetUri = `sip:${target}@${contact.ip}:${contact.port}`;
        logger.info(`IVR ROUTE: dialing extension ${target} at ${targetUri}`);

        try {
          // Create outbound call to extension
          const uac = await this.srf.createUAC(targetUri, {
            localSdp: uas.remote.sdp,
            callingNumber: callerID
          });

          logger.info(`IVR ROUTE: ${target} answered`);

          // Re-INVITE caller with extension's SDP
          try { await uas.modify(uac.remote.sdp); } catch (e) {}
          try { await uac.modify(uas.remote.sdp); } catch (e) {}

          // Wire up
          uas.removeAllListeners('destroy');
          uas.removeAllListeners('info');

          uas.on('destroy', () => {
            uac.destroy();
            this._endCall(cdr, 'caller');
            this.callHandler.activeCalls.delete(sipCallId);
          });
          uac.on('destroy', () => {
            uas.destroy();
            this._endCall(cdr, 'callee');
            this.callHandler.activeCalls.delete(sipCallId);
          });

          // Track as active call
          cdr.to = target;
          await cdr.save();
          this.callHandler.activeCalls.set(sipCallId, { uas, uac, cdr, fromExt: callerID, toExt: target });

          // Attach transfer/hold handlers
          if (this.callHandler.transferHandler) {
            this.callHandler.transferHandler.attachReferHandlers(sipCallId, uas, uac, cdr);
          }
          if (this.callHandler.holdHandler) {
            this.callHandler.holdHandler.attachHoldHandlers(sipCallId, uas, uac, cdr);
          }
        } catch (err) {
          logger.error(`IVR ROUTE: extension ${target} failed: ${err.message}`);
          try { uas.destroy(); } catch (e) {}
        }
        break;
      }

      case 'ringgroup': {
        logger.info(`IVR ROUTE: forwarding to ring group ${target}`);
        const { RingGroup } = require('../models');
        const ringGroup = await RingGroup.findOne({ number: target, enabled: true });
        if (!ringGroup) {
          logger.warn(`IVR ROUTE: ring group ${target} not found`);
          try { uas.destroy(); } catch (e) {}
          return;
        }

        // Get available members
        const members = [];
        for (const ext of ringGroup.members) {
          const contacts = await this.registrar.getContacts(ext);
          if (contacts.length > 0) {
            members.push({ extension: ext, contact: contacts[0] });
          }
        }

        if (members.length === 0) {
          logger.warn(`IVR ROUTE: no ring group members available`);
          try { uas.destroy(); } catch (e) {}
          return;
        }

        // Ring first available member via B2BUA
        const member = members[0];
        const targetUri = `sip:${member.extension}@${member.contact.ip}:${member.contact.port}`;

        try {
          const uac = await this.srf.createUAC(targetUri, {
            localSdp: uas.remote.sdp,
            callingNumber: callerID
          });

          try { await uas.modify(uac.remote.sdp); } catch (e) {}
          try { await uac.modify(uas.remote.sdp); } catch (e) {}

          uas.removeAllListeners('destroy');
          uas.removeAllListeners('info');

          uas.on('destroy', () => {
            uac.destroy();
            this._endCall(cdr, 'caller');
            this.callHandler.activeCalls.delete(sipCallId);
          });
          uac.on('destroy', () => {
            uas.destroy();
            this._endCall(cdr, 'callee');
            this.callHandler.activeCalls.delete(sipCallId);
          });

          cdr.to = member.extension;
          await cdr.save();
          this.callHandler.activeCalls.set(sipCallId, { uas, uac, cdr, fromExt: callerID, toExt: member.extension });

          if (this.callHandler.transferHandler) {
            this.callHandler.transferHandler.attachReferHandlers(sipCallId, uas, uac, cdr);
          }
          if (this.callHandler.holdHandler) {
            this.callHandler.holdHandler.attachHoldHandlers(sipCallId, uas, uac, cdr);
          }

          logger.info(`IVR ROUTE: connected to ${member.extension} via ring group ${target}`);
        } catch (err) {
          logger.error(`IVR ROUTE: ring group dial failed: ${err.message}`);
          try { uas.destroy(); } catch (e) {}
        }
        break;
      }

      case 'ivr': {
        // Route to another IVR
        const { IVR } = require('../models');
        const subIvr = await IVR.findOne({ number: target, enabled: true });
        if (subIvr) {
          logger.info(`IVR ROUTE: forwarding to sub-IVR ${target}`);
          // Re-establish RTPEngine for the sub-IVR
          const rtpOffer = await this._rtpengineOffer(sipCallId, fromTag, uas.remote.sdp);
          if (rtpOffer) {
            await this._runMenu(uas, subIvr, sipCallId, fromTag, callerID, cdr, originalReq);
          }
        } else {
          logger.warn(`IVR ROUTE: sub-IVR ${target} not found`);
          try { uas.destroy(); } catch (e) {}
        }
        break;
      }

      case 'voicemail': {
        logger.info(`IVR ROUTE: sending to voicemail for ${target}`);
        try { uas.destroy(); } catch (e) {}
        // The voicemail will be handled by the destroy callback in the CDR
        break;
      }

      case 'external': {
        logger.info(`IVR ROUTE: dialing external ${target}`);
        const route = await this.callRouter.findOutboundRoute(target);
        if (route) {
          const trunk = this.trunkManager.getTrunk(route.trunk);
          if (trunk) {
            const processed = this.callRouter.processOutboundNumber(target, route);
            const targetUri = `sip:${processed}@${trunk.host}:${trunk.port || 5060}`;

            try {
              const uac = await this.srf.createUAC(targetUri, {
                localSdp: uas.remote.sdp,
                callingNumber: callerID,
                auth: { username: trunk.username, password: trunk.password }
              });

              try { await uas.modify(uac.remote.sdp); } catch (e) {}
              try { await uac.modify(uas.remote.sdp); } catch (e) {}

              uas.removeAllListeners('destroy');
              uas.removeAllListeners('info');

              uas.on('destroy', () => {
                uac.destroy();
                this._endCall(cdr, 'caller');
              });
              uac.on('destroy', () => {
                uas.destroy();
                this._endCall(cdr, 'callee');
              });

              cdr.to = target;
              cdr.direction = 'outbound';
              cdr.trunkUsed = route.trunk;
              await cdr.save();

              logger.info(`IVR ROUTE: connected to external ${target}`);
            } catch (err) {
              logger.error(`IVR ROUTE: external dial failed: ${err.message}`);
              try { uas.destroy(); } catch (e) {}
            }
          }
        } else {
          logger.warn(`IVR ROUTE: no outbound route for ${target}`);
          try { uas.destroy(); } catch (e) {}
        }
        break;
      }

      default:
        logger.warn(`IVR ROUTE: unknown destination type ${type}`);
        try { uas.destroy(); } catch (e) {}
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  _getGreetingFile(ivrConfig) {
    // Check IVR-specific greeting
    if (ivrConfig.greeting) {
      // Could be a container path or host path
      const hostPath = ivrConfig.greeting.startsWith('/audio/')
        ? ivrConfig.greeting.replace('/audio/', AUDIO_HOST_DIR + '/')
        : ivrConfig.greeting;
      if (fs.existsSync(hostPath)) return ivrConfig.greeting;
    }

    // Check by IVR number
    const byNumber = path.join(AUDIO_HOST_DIR, `ivr-${ivrConfig.number}.wav`);
    if (fs.existsSync(byNumber)) return byNumber;

    return null;
  }

  async _playTone(sipCallId, fromTag, freq, durationMs) {
    // Play a short error tone using the beep file
    const beepFile = process.env.VM_BEEP_FILE || '/audio/beep.wav';
    try {
      await this.rtpengine.playMedia(this.rtpengineConfig, {
        'call-id': sipCallId,
        'from-tag': fromTag,
        file: beepFile
      });
      await this._sleep(durationMs || 500);
    } catch (e) {}
  }

  async _rtpengineOffer(callId, fromTag, sdp) {
    if (!this.rtpengine) return null;
    try {
      const response = await this.rtpengine.offer(this.rtpengineConfig, {
        'call-id': callId,
        'from-tag': fromTag,
        sdp,
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });
      return response.result === 'ok' ? response : null;
    } catch (err) { return null; }
  }

  async _rtpengineDelete(callId, fromTag) {
    if (!this.rtpengine) return;
    try { await this.rtpengine.delete(this.rtpengineConfig, { 'call-id': callId, 'from-tag': fromTag }); } catch (e) {}
  }

  async _endCall(cdr, hangupBy) {
    cdr.status = 'completed';
    cdr.endTime = new Date();
    cdr.duration = Math.round((cdr.endTime - cdr.startTime) / 1000);
    cdr.talkTime = cdr.answerTime ? Math.round((cdr.endTime - cdr.answerTime) / 1000) : 0;
    cdr.hangupBy = hangupBy;
    cdr.hangupCause = 'normal_clearing';
    await cdr.save();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = IvrHandler;
