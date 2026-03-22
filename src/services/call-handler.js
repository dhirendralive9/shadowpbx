
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
    this.ivrHandler = null;       // set after construction
    this.presenceHandler = null;  // set after construction (BLF/presence)
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };
  }

  // BLF state change helper — safe to call even if presence is not wired
  _emitPresence(ext, state, meta) {
    if (this.presenceHandler && ext) {
      try { this.presenceHandler.setState(ext, state, meta); } catch (e) {}
    }
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

    // Check if dialing monitor codes: *11{ext}=listen, *12{ext}=whisper, *13{ext}=barge
    if (this.monitorHandler && toExt && /^\*1[123]\d+$/.test(toExt)) {
      const handled = await this.monitorHandler.handleMonitorDial(req, res, fromExt, toExt);
      if (handled) return;
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

    // BLF: both parties ringing
    this._emitPresence(fromExt, 'ringing', { callId, remoteParty: toExt, direction: 'initiator' });
    this._emitPresence(toExt, 'ringing', { callId, remoteParty: fromExt, direction: 'recipient' });

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

      // BLF: both parties in call
      this._emitPresence(fromExt, 'confirmed', { callId, remoteParty: toExt, direction: 'initiator' });
      this._emitPresence(toExt, 'confirmed', { callId, remoteParty: fromExt, direction: 'recipient' });

      this._trackCall(callId, uas, uac, cdr, fromExt, toExt, from.params.tag);
    } catch (err) {
      // BLF: call failed, both go idle
      this._emitPresence(fromExt, 'idle');
      this._emitPresence(toExt, 'idle');
      await this._failCall(cdr, err, fromExt, toExt);
    }
  }

  async _handleRingGroupCall(req, res, fromExt, ringGroup, callId) {
    logger.info(`CALL ${fromExt} -> RG:${ringGroup.number} (${ringGroup.name}) [${callId}]`);
    const cdr = await this._createCDR(fromExt, `RG:${ringGroup.number}`, 'internal', callId, req.source_address);

    // BLF: caller is ringing, all ring group members are ringing
    this._emitPresence(fromExt, 'ringing', { callId, remoteParty: 'RG:' + ringGroup.number, direction: 'initiator' });
    if (ringGroup.members) {
      ringGroup.members.forEach(m => this._emitPresence(m, 'ringing', { callId, remoteParty: fromExt, direction: 'recipient' }));
    }

    try {
      const result = await this.ringGroupHandler.ringGroup(req, res, ringGroup, cdr);
      if (result && result.uas && result.uac) {
        cdr.status = 'answered';
        cdr.answerTime = new Date();
        if (result.answeredBy) cdr.to = result.answeredBy;
        await cdr.save();

        // BLF: caller + answerer in call, other members go idle
        this._emitPresence(fromExt, 'confirmed', { callId, remoteParty: result.answeredBy || ringGroup.number, direction: 'initiator' });
        if (ringGroup.members) {
          ringGroup.members.forEach(m => {
            if (m === result.answeredBy) {
              this._emitPresence(m, 'confirmed', { callId, remoteParty: fromExt, direction: 'recipient' });
            } else {
              this._emitPresence(m, 'idle');
            }
          });
        }

        const onDestroy = async (hangupBy) => {
          await this._endCall(cdr, hangupBy);
          this.activeCalls.delete(callId);
        };
        result.uas.on('destroy', () => { result.uac.destroy(); onDestroy('caller'); });
        result.uac.on('destroy', () => { result.uas.destroy(); onDestroy('callee'); });
        this.activeCalls.set(callId, { uas: result.uas, uac: result.uac, cdr, fromExt, toExt: result.answeredBy });
      } else {
        // Nobody answered — everyone goes idle
        this._emitPresence(fromExt, 'idle');
        if (ringGroup.members) ringGroup.members.forEach(m => this._emitPresence(m, 'idle'));
      }
    } catch (err) {
      this._emitPresence(fromExt, 'idle');
      if (ringGroup.members) ringGroup.members.forEach(m => this._emitPresence(m, 'idle'));
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

    // Resolve the destination — if it's a time condition, evaluate it now
    let { type, target } = route.destination;
    if (type === 'timecondition' && this.callRouter.timeConditionService) {
      const resolved = await this.callRouter.resolveDestination(route.destination);
      type = resolved.type;
      target = resolved.target;
      logger.info(`INBOUND: time condition resolved -> ${type}:${target}`);
    }

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

      // BLF: target extension is ringing
      this._emitPresence(target, 'ringing', { callId, remoteParty: callerID, direction: 'recipient' });

      const contact = this._getLatestContact(contacts);
      const targetUri = `sip:${target}@${contact.ip}:${contact.port}`;
      logger.info(`INBOUND: dialing ${target} at ${contact.ip}:${contact.port}`);

      try {
        const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
          localSdpB: req.body,
          passFailure: false  // Don't send failure — voicemail needs req/res
        });

        cdr.status = 'answered';
        cdr.answerTime = new Date();
        cdr.to = target;
        await cdr.save();
        logger.info(`INBOUND ANSWERED: ${callerID} -> ${target} [${callId}]`);

        // BLF: target extension is in call
        this._emitPresence(target, 'confirmed', { callId, remoteParty: callerID, direction: 'recipient' });

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
        // BLF: target goes idle on failure
        this._emitPresence(target, 'idle');
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

      // BLF: all ring group members ringing
      if (ringGroup.members) {
        ringGroup.members.forEach(m => this._emitPresence(m, 'ringing', { callId, remoteParty: callerID, direction: 'recipient' }));
      }

      try {
        const result = await this.ringGroupHandler.ringGroup(req, res, ringGroup, cdr);
        if (result && result.uas && result.uac) {
          cdr.status = 'answered';
          cdr.answerTime = new Date();
          if (result.answeredBy) cdr.to = result.answeredBy;
          await cdr.save();
          logger.info(`INBOUND ANSWERED via RG: ${callerID} -> ${result.answeredBy || target} [${callId}]`);

          // BLF: answerer in call, others idle
          if (ringGroup.members) {
            ringGroup.members.forEach(m => {
              if (m === result.answeredBy) {
                this._emitPresence(m, 'confirmed', { callId, remoteParty: callerID, direction: 'recipient' });
              } else {
                this._emitPresence(m, 'idle');
              }
            });
          }

          // Get the RTPEngine call-id and from-tag stored by the ring group
          const rtpCallId = result.uas._rtpCallId || null;
          const rtpFromTag = result.uas._rtpFromTag || null;

          const onDestroy = async (hangupBy) => {
            await this._endCall(cdr, hangupBy);
            // Clean up RTPEngine session and convert recording
            if (rtpCallId && rtpFromTag) {
              await this._rtpengineDelete(rtpCallId, rtpFromTag);
              setTimeout(() => {
                try {
                  const wavPath = pcapToWav(rtpCallId, cdr.callId);
                  if (wavPath) {
                    cdr.recordingPath = wavPath;
                    cdr.recordingSize = require('fs').statSync(wavPath).size;
                    cdr.recorded = true;
                    cdr.save().catch(e => logger.error(`CDR recording update: ${e.message}`));
                    logger.info(`RECORDING: saved ${wavPath} for [${cdr.callId}]`);
                  }
                } catch (err) { logger.error(`Recording conversion: ${err.message}`); }
              }, 2000);
            }
            this.activeCalls.delete(callId);
          };
          result.uas.on('destroy', () => { result.uac.destroy(); onDestroy('caller'); });
          result.uac.on('destroy', () => { result.uas.destroy(); onDestroy('callee'); });
          this.activeCalls.set(callId, { uas: result.uas, uac: result.uac, cdr, fromExt: callerID, toExt: result.answeredBy });
        } else {
          // Ring group returned null — nobody answered → all idle
          if (ringGroup.members) ringGroup.members.forEach(m => this._emitPresence(m, 'idle'));
          // Use first ring group member as voicemail target
          const vmTarget = ringGroup.members && ringGroup.members[0] ? ringGroup.members[0] : target;
          if (this.voicemailHandler && !res.finalResponseSent) {
            logger.info(`INBOUND RG NO ANSWER: trying voicemail for ${vmTarget}`);
            const handled = await this.voicemailHandler.handleVoicemail(req, res, callerID, vmTarget, cdr);
            if (handled) return;
          }
        }
      } catch (err) {
        // Ring group threw an error → all idle
        if (ringGroup.members) ringGroup.members.forEach(m => this._emitPresence(m, 'idle'));
        // Ring group threw an error → try voicemail
        const vmTarget = ringGroup.members && ringGroup.members[0] ? ringGroup.members[0] : target;
        if (this.voicemailHandler && !res.finalResponseSent) {
          const handled = await this.voicemailHandler.handleVoicemail(req, res, callerID, vmTarget, cdr);
          if (handled) return;
        }
        await this._failCall(cdr, err, callerID, `RG:${target}`);
      }

    } else if (type === 'ivr') {
      if (this.ivrHandler) {
        const { IVR } = require('../models');
        const ivrConfig = await IVR.findOne({ number: target, enabled: true });
        if (ivrConfig) {
          return this.ivrHandler.handleIvr(req, res, ivrConfig, cdr);
        }
        logger.warn(`INBOUND: IVR ${target} not found`);
      } else {
        logger.warn(`INBOUND: IVR handler not available`);
      }
      return res.send(404);

    } else if (type === 'queue') {
      if (this.queueHandler) {
        const { Queue } = require('../models');
        const queueConfig = await Queue.findOne({ number: target, enabled: true });
        if (queueConfig) {
          logger.info(`INBOUND: routing to queue ${target} (${queueConfig.name})`);
          const handled = await this.queueHandler.handleQueue(req, res, queueConfig, cdr, callerID);
          if (handled) return;
        }
        logger.warn(`INBOUND: queue ${target} not found`);
      } else {
        logger.warn(`INBOUND: queue handler not available`);
      }
      if (!res.finalResponseSent) res.send(404);
      return;

    } else if (type === 'voicemail') {
      if (this.voicemailHandler) {
        logger.info(`INBOUND: routing to voicemail for ${target}`);
        const handled = await this.voicemailHandler.handleVoicemail(req, res, callerID, target, cdr);
        if (handled) return;
      }
      logger.warn(`INBOUND: voicemail handler not available for ${target}`);
      cdr.status = 'missed';
      await cdr.save();
      return res.send(480);

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

    // BLF: caller is ringing outbound
    this._emitPresence(fromExt, 'ringing', { callId, remoteParty: dialedNumber, direction: 'initiator' });

    try {
      const { uas, uac } = await this.trunkManager.sendOutbound(req, res, trunk, processedNumber, callerId);
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      await cdr.save();
      logger.info(`OUTBOUND ANSWERED: ${fromExt} -> ${processedNumber} via ${route.trunk} [${callId}]`);

      // BLF: caller is in call
      this._emitPresence(fromExt, 'confirmed', { callId, remoteParty: dialedNumber, direction: 'initiator' });

      this._trackCall(callId, uas, uac, cdr, fromExt, dialedNumber, null);
    } catch (err) {
      // BLF: caller goes idle on failure
      this._emitPresence(fromExt, 'idle');
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

    // BLF: both parties go idle
    this._emitPresence(cdr.from, 'idle');
    this._emitPresence(cdr.to, 'idle');
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
