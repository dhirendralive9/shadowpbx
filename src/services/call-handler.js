
const { v4: uuidv4 } = require('uuid');
const { Extension, CDR, ActiveCall } = require('../models');
const logger = require('../utils/logger');
const { pcapToWav } = require('../utils/converter');

class CallHandler {
  constructor(srf, registrar, rtpengine, ringGroupHandler, trunkManager, callRouter) {
    this.srf = srf;
    this.registrar = registrar;
    this.rtpengine = rtpengine;
    this.ringGroupHandler = ringGroupHandler;
    this.trunkManager = trunkManager;
    this.callRouter = callRouter;
    this.activeCalls = new Map();
    this.transferHandler = null; // set after construction
    this.holdHandler = null;     // set after construction
    this.parkHandler = null;     // set after construction
    this.voicemailHandler = null; // set after construction
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };
  }

  // Extract extension number from a SIP URI, handling various formats
  _extractExtFromUri(uri) {
    if (!uri) return null;
    // Try standard sip:NNN@host
    let match = uri.match(/sip:\+?(\d+)@/);
    if (match) return match[1];
    // Try sip:user@host (non-numeric userpart — return null)
    match = uri.match(/sip:([^@]+)@/);
    if (match && /^\d+$/.test(match[1])) return match[1];
    return null;
  }

  async handleInvite(req, res) {
    const callId = req.get('Call-Id');
    const from = req.getParsedHeader('From');
    const to = req.getParsedHeader('To');
    const userAgent = req.get('User-Agent') || '';
    const fromUri = from.uri || '';

    logger.debug(`INVITE raw: From-URI=${fromUri} To-URI=${to.uri || ''} Call-Id=${callId} UA=${userAgent}`);

    if (userAgent.includes('SignalWire') || userAgent.includes('Twilio') || fromUri.includes('signalwire.com') || fromUri.includes('twilio.com')) {
      logger.info(`INBOUND TRUNK DETECTED: User-Agent=${userAgent} From=${fromUri}`);
      return this._handleInbound(req, res, { isTrunk: true, trunkName: 'signalwire', trunk: this.trunkManager.getTrunk('signalwire') });
    }

    const trunkCheck = this.trunkManager.isFromTrunk(req);
    if (trunkCheck.isTrunk) {
      return this._handleInbound(req, res, trunkCheck);
    }

    const fromExt = this._extractExtFromUri(fromUri);
    const toExt = this._extractExtFromUri(to.uri);

    if (!fromExt) {
      logger.warn(`INVITE rejected: cannot parse extension from From-URI: ${fromUri}`);
      return res.send(404);
    }

    const callerRegistered = await this.registrar.isRegistered(fromExt);
    if (!callerRegistered) {
      logger.warn(`INVITE rejected: caller ${fromExt} not registered`);
      return res.send(403);
    }

    if (!toExt) {
      logger.warn(`INVITE rejected: invalid to=${toExt}`);
      return res.send(404);
    }

    // Check if dialing a park slot (pickup)
    if (this.parkHandler && this.parkHandler.isParkSlot(toExt)) {
      return this.parkHandler.handlePickupDial(req, res, fromExt, toExt, callId);
    }

    const ringGroup = await this.ringGroupHandler.isRingGroup(toExt);
    if (ringGroup) {
      return this._handleRingGroupCall(req, res, fromExt, ringGroup, callId);
    }

    const isExtension = await Extension.findOne({ extension: toExt });
    if (!isExtension) {
      return this._handleOutbound(req, res, fromExt, toExt, callId);
    }

    logger.info(`CALL ${fromExt} -> ${toExt} [${callId}]`);
    return this._handleInternal(req, res, fromExt, toExt, callId, from);
  }

  // Get the most recent contact for an extension (avoids stale NAT ports)
  _getLatestContact(contacts) {
    if (contacts.length <= 1) return contacts[0];
    return contacts.sort((a, b) => {
      const ta = a.registeredAt ? new Date(a.registeredAt).getTime() : 0;
      const tb = b.registeredAt ? new Date(b.registeredAt).getTime() : 0;
      return tb - ta;
    })[0];
  }

  async _handleInternal(req, res, fromExt, toExt, callId, from) {
    const calleeContacts = await this.registrar.getContacts(toExt);
    if (calleeContacts.length === 0) {
      logger.warn(`INVITE rejected: callee ${toExt} not registered`);
      return res.send(480);
    }

    const cdr = await this._createCDR(fromExt, toExt, 'internal', callId, req.source_address);

    try {
      const contact = this._getLatestContact(calleeContacts);
      const targetUri = `sip:${toExt}@${contact.ip}:${contact.port}`;
      logger.info(`INTERNAL: ${fromExt} -> ${toExt} at ${contact.ip}:${contact.port}`);
      const rtpOffer = await this._rtpengineOffer(callId, from.params.tag, req.body);

      if (!rtpOffer) {
        return this._directCall(req, res, targetUri, cdr, callId);
      }

      const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
        localSdpB: rtpOffer.sdp,
        localSdpA: async (sdp, res) => {
          const rtpAnswer = await this._rtpengineAnswer(callId, from.params.tag, res.getParsedHeader('To').params.tag, sdp);
          return rtpAnswer ? rtpAnswer.sdp : sdp;
        }
      });

      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.recorded = !!rtpOffer;
      await cdr.save();
      logger.info(`CALL ANSWERED ${fromExt} -> ${toExt} [${callId}]`);
      this._trackCall(callId, uas, uac, cdr, fromExt, toExt, from.params.tag);
    } catch (err) {
      await this._failCall(cdr, err, fromExt, toExt);
    }
  }

  async _handleRingGroupCall(req, res, fromExt, ringGroup, callId) {
    logger.info(`CALL ${fromExt} -> RG:${ringGroup.number} (${ringGroup.name}) [${callId}]`);
    const cdr = await this._createCDR(fromExt, `RG:${ringGroup.number}`, 'internal', callId, req.source_address);

    try {
      const result = await this.ringGroupHandler.ringGroup(req, res, ringGroup, cdr);
      if (result && result.uas && result.uac) {
        cdr.status = 'answered';
        cdr.answerTime = new Date();
        if (result.answeredBy) cdr.to = result.answeredBy;
        await cdr.save();
        const onDestroy = async (hangupBy) => {
          await this._endCall(cdr, hangupBy);
          this.activeCalls.delete(callId);
        };
        result.uas.on('destroy', () => { result.uac.destroy(); onDestroy('caller'); });
        result.uac.on('destroy', () => { result.uas.destroy(); onDestroy('callee'); });
        this.activeCalls.set(callId, { uas: result.uas, uac: result.uac, cdr, fromExt });
      }
    } catch (err) {
      await this._failCall(cdr, err, fromExt, `RG:${ringGroup.number}`);
    }
  }

  async _handleInbound(req, res, trunkCheck) {
    const callId = req.get('Call-Id');
    const callerID = this.callRouter.extractCallerID(req);
    const did = this.callRouter.extractDID(req);

    logger.info(`INBOUND via ${trunkCheck.trunkName}: ${callerID} -> DID:${did} [${callId}]`);

    const route = await this.callRouter.findInboundRoute(did, trunkCheck.trunkName);
    if (!route) {
      logger.warn(`INBOUND: no route for DID ${did}`);
      return res.send(404);
    }

    const cdr = await this._createCDR(callerID, did || 'unknown', 'inbound', callId, req.source_address);
    cdr.trunkUsed = trunkCheck.trunkName;
    cdr.didNumber = did;
    await cdr.save();

    const { type, target } = route.destination;

    if (type === 'extension') {
      const contacts = await this.registrar.getContacts(target);
      if (contacts.length === 0) {
        logger.warn(`INBOUND: extension ${target} not registered`);
        // Try voicemail
        if (this.voicemailHandler) {
          const handled = await this.voicemailHandler.handleVoicemail(req, res, callerID, target, cdr);
          if (handled) return;
        }
        cdr.status = 'missed';
        await cdr.save();
        return res.send(480);
      }

      const contact = this._getLatestContact(contacts);
      const targetUri = `sip:${target}@${contact.ip}:${contact.port}`;
      logger.info(`INBOUND: dialing ${target} at ${contact.ip}:${contact.port}`);

      try {
        const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
          localSdpB: req.body
        });

        cdr.status = 'answered';
        cdr.answerTime = new Date();
        cdr.to = target;
        await cdr.save();
        logger.info(`INBOUND ANSWERED: ${callerID} -> ${target} [${callId}]`);

        // Track the call
        this.activeCalls.set(callId, { uas, uac, cdr, fromExt: callerID, toExt: target });
        const onDestroy = async (hangupBy) => {
          await this._endCall(cdr, hangupBy);
          this.activeCalls.delete(callId);
        };
        uas.on('destroy', () => { uac.destroy(); onDestroy('caller'); });
        uac.on('destroy', () => { uas.destroy(); onDestroy('callee'); });
      } catch (err) {
        logger.error(`INBOUND DIAL FAILED: ${target} error=${err.message} status=${err.status}`);
        // On no-answer/timeout/busy → try voicemail
        if (this.voicemailHandler && !res.finalResponseSent) {
          const handled = await this.voicemailHandler.handleVoicemail(req, res, callerID, target, cdr);
          if (handled) return;
        }
        await this._failCall(cdr, err, callerID, target);
      }

    } else if (type === 'ringgroup') {
      const ringGroup = await this.ringGroupHandler.isRingGroup(target);
      if (!ringGroup) {
        logger.warn(`INBOUND: ring group ${target} not found`);
        return res.send(404);
      }

      try {
        const result = await this.ringGroupHandler.ringGroup(req, res, ringGroup, cdr);
        if (result && result.uas && result.uac) {
          cdr.status = 'answered';
          cdr.answerTime = new Date();
          if (result.answeredBy) cdr.to = result.answeredBy;
          await cdr.save();
          logger.info(`INBOUND ANSWERED via RG: ${callerID} -> ${result.answeredBy || target} [${callId}]`);
          const onDestroy = async (hangupBy) => {
            await this._endCall(cdr, hangupBy);
            this.activeCalls.delete(callId);
          };
          result.uas.on('destroy', () => { result.uac.destroy(); onDestroy('caller'); });
          result.uac.on('destroy', () => { result.uas.destroy(); onDestroy('callee'); });
          this.activeCalls.set(callId, { uas: result.uas, uac: result.uac, cdr, fromExt: callerID, toExt: result.answeredBy });
        } else {
          // Ring group returned null — nobody answered → try voicemail
          // Use first ring group member as voicemail target
          const vmTarget = ringGroup.members && ringGroup.members[0] ? ringGroup.members[0] : target;
          if (this.voicemailHandler && !res.finalResponseSent) {
            logger.info(`INBOUND RG NO ANSWER: trying voicemail for ${vmTarget}`);
            const handled = await this.voicemailHandler.handleVoicemail(req, res, callerID, vmTarget, cdr);
            if (handled) return;
          }
        }
      } catch (err) {
        // Ring group threw an error → try voicemail
        const vmTarget = ringGroup.members && ringGroup.members[0] ? ringGroup.members[0] : target;
        if (this.voicemailHandler && !res.finalResponseSent) {
          const handled = await this.voicemailHandler.handleVoicemail(req, res, callerID, vmTarget, cdr);
          if (handled) return;
        }
        await this._failCall(cdr, err, callerID, `RG:${target}`);
      }

    } else {
      logger.info(`INBOUND: destination is hangup for DID ${did}`);
      cdr.status = 'completed';
      cdr.hangupCause = 'no_destination';
      await cdr.save();
      res.send(503);
    }
  }

  async _handleOutbound(req, res, fromExt, dialedNumber, callId) {
    logger.info(`OUTBOUND: ${fromExt} -> ${dialedNumber} [${callId}]`);

    const route = await this.callRouter.findOutboundRoute(dialedNumber);
    if (!route) {
      logger.warn(`OUTBOUND: no route for ${dialedNumber}`);
      return res.send(404);
    }

    const trunk = this.trunkManager.getTrunk(route.trunk);
    if (!trunk) {
      logger.warn(`OUTBOUND: trunk ${route.trunk} not found`);
      return res.send(503);
    }

    const processedNumber = this.callRouter.processOutboundNumber(dialedNumber, route);
    const callerId = route.callerIdNumber || fromExt;

    const cdr = await this._createCDR(fromExt, dialedNumber, 'outbound', callId, req.source_address);
    cdr.trunkUsed = route.trunk;
    await cdr.save();

    try {
      const { uas, uac } = await this.trunkManager.sendOutbound(req, res, trunk, processedNumber, callerId);
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      await cdr.save();
      logger.info(`OUTBOUND ANSWERED: ${fromExt} -> ${processedNumber} via ${route.trunk} [${callId}]`);
      this._trackCall(callId, uas, uac, cdr, fromExt, dialedNumber, null);
    } catch (err) {
      await this._failCall(cdr, err, fromExt, dialedNumber);
    }
  }

  async _createCDR(from, to, direction, sipCallId, fromIp) {
    const cdr = new CDR({ callId: uuidv4(), sipCallId, from, to, direction, status: 'ringing', startTime: new Date(), fromIp });
    await cdr.save();
    return cdr;
  }

  _trackCall(callId, uas, uac, cdr, fromExt, toExt, fromTag) {
    this.activeCalls.set(callId, { uas, uac, cdr, fromExt, toExt });

    // Attach transfer (REFER) handlers if transfer handler is available
    if (this.transferHandler) {
      this.transferHandler.attachReferHandlers(callId, uas, uac, cdr);
    }

    // Attach hold (re-INVITE) handlers if hold handler is available
    if (this.holdHandler) {
      this.holdHandler.attachHoldHandlers(callId, uas, uac, cdr);
    }

    const onDestroy = async (hangupBy) => {
      await this._endCall(cdr, hangupBy);
      if (fromTag) {
        await this._rtpengineDelete(callId, fromTag);
        setTimeout(() => {
          try {
            const wavPath = pcapToWav(callId, cdr.callId);
            if (wavPath) {
              cdr.recordingPath = wavPath;
              cdr.recordingSize = require('fs').statSync(wavPath).size;
              cdr.save().catch(e => logger.error(`CDR update: ${e.message}`));
            }
          } catch (err) { logger.error(`Recording conversion: ${err.message}`); }
        }, 2000);
      }
      this.activeCalls.delete(callId);
      if (this.holdHandler) this.holdHandler.cleanup(callId);
      await ActiveCall.deleteOne({ callId: cdr.callId }).catch(() => {});
    };
    uas.on('destroy', () => { uac.destroy(); onDestroy('caller'); });
    uac.on('destroy', () => { uas.destroy(); onDestroy('callee'); });
  }

  async _endCall(cdr, hangupBy) {
    const endTime = new Date();
    cdr.status = 'completed';
    cdr.endTime = endTime;
    cdr.duration = Math.round((endTime - cdr.startTime) / 1000);
    cdr.talkTime = cdr.answerTime ? Math.round((endTime - cdr.answerTime) / 1000) : 0;
    cdr.hangupBy = hangupBy;
    cdr.hangupCause = 'normal_clearing';
    await cdr.save();
    logger.info(`CALL ENDED ${cdr.from} -> ${cdr.to} duration=${cdr.talkTime}s hangup=${hangupBy}`);
  }

  async _failCall(cdr, err, from, to) {
    logger.error(`CALL FAILED ${from} -> ${to}: ${err.message}`);
    cdr.status = err.status === 486 ? 'busy' : 'failed';
    cdr.endTime = new Date();
    cdr.hangupCause = err.status ? `sip_${err.status}` : err.message;
    await cdr.save();
  }

  async _directCall(req, res, targetUri, cdr, callId) {
    try {
      const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, { localSdpB: req.body });
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.recorded = false;
      await cdr.save();
      this.activeCalls.set(callId, { uas, uac, cdr });
      uas.on('destroy', async () => { uac.destroy(); await this._endCall(cdr, 'caller'); this.activeCalls.delete(callId); });
      uac.on('destroy', async () => { uas.destroy(); await this._endCall(cdr, 'callee'); this.activeCalls.delete(callId); });
    } catch (err) {
      await this._failCall(cdr, err, cdr.from, cdr.to);
    }
  }

  async _rtpengineOffer(callId, fromTag, sdp) {
    if (!this.rtpengine) return null;
    try {
      const response = await this.rtpengine.offer(this.rtpengineConfig, { 'call-id': callId, 'from-tag': fromTag, sdp, 'record call': 'yes', 'flags': ['trust-address'], 'replace': ['origin', 'session-connection'], 'ICE': 'remove' });
      return response.result === 'ok' ? response : null;
    } catch (err) { return null; }
  }

  async _rtpengineAnswer(callId, fromTag, toTag, sdp) {
    if (!this.rtpengine) return null;
    try {
      const response = await this.rtpengine.answer(this.rtpengineConfig, { 'call-id': callId, 'from-tag': fromTag, 'to-tag': toTag, sdp, 'record call': 'yes', 'flags': ['trust-address'], 'replace': ['origin', 'session-connection'], 'ICE': 'remove' });
      return response.result === 'ok' ? response : null;
    } catch (err) { return null; }
  }

  async _rtpengineDelete(callId, fromTag) {
    if (!this.rtpengine) return;
    try { await this.rtpengine.delete(this.rtpengineConfig, { 'call-id': callId, 'from-tag': fromTag }); } catch (err) {}
  }

  getActiveCalls() {
    const calls = [];
    for (const [id, call] of this.activeCalls) {
      const holdState = this.holdHandler ? this.holdHandler.holdState.get(id) : null;
      calls.push({
        callId: id,
        cdrCallId: call.cdr ? call.cdr.callId : null,
        from: call.fromExt || call.cdr.from,
        to: call.toExt || call.cdr.to,
        duration: Math.round((Date.now() - call.cdr.startTime) / 1000),
        status: holdState && holdState.held ? 'held' : call.cdr.status,
        onHold: holdState ? holdState.held : false,
        heldBy: holdState ? holdState.heldBy : null
      });
    }
    return calls;
  }
}

module.exports = CallHandler;
