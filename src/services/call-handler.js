
const { v4: uuidv4 } = require('uuid');
const { Extension, CDR, ActiveCall } = require('../models');
const logger = require('../utils/logger');

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
    this.securityTracker = null;  // set after construction (attack tracking)
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
    // Feature codes (monitor *11/*12/*13, park pickups, etc.) have a non-numeric
    // userpart and must survive parsing — they are dispatched before generic
    // extension handling. Return the raw userpart so the caller can classify it;
    // _isFeatureCode() below decides what is a feature code vs. an unknown user.
    match = uri.match(/sip:([^@;>]+)@/);
    if (match) {
      const user = match[1];
      if (/^\d+$/.test(user)) return user;
      if (this._isFeatureCode(user)) return user;
    }
    return null;
  }

  // A dialled string that is a feature code rather than an extension or an
  // external SIP user. Kept in one place so the parser and the dispatcher agree.
  //   *11NNN listen · *12NNN whisper · *13NNN barge   (call monitoring)
  _isFeatureCode(user) {
    if (!user) return false;
    return /^\*1[123]\d+$/.test(user);
  }

  async handleInvite(req, res) {
    const callId = req.get('Call-Id');
    const from = req.getParsedHeader('From');
    const to = req.getParsedHeader('To');
    const userAgent = req.get('User-Agent') || '';
    const fromUri = from.uri || '';

    logger.debug(`INVITE raw: From-URI=${fromUri} To-URI=${to.uri || ''} Call-Id=${callId} UA=${userAgent}`);

    const trunkCheck = await this.trunkManager.isFromTrunk(req);
    if (trunkCheck.isTrunk) {
      logger.info(`INBOUND TRUNK DETECTED: trunk=${trunkCheck.trunkName} UA=${userAgent} From=${fromUri} src=${req.source_address}`);
      return this._handleInbound(req, res, trunkCheck);
    }

    // Web-call guests (Phase 2): From is web-xxxxxx, authenticated with a
    // one-shot token and locked to its widget's destination.
    const fromUser = (String(fromUri).match(/sip:([^@;>]+)@/) || [])[1];
    if (this.guestManager && this.guestManager.isGuestUser(fromUser)) {
      return this._handleGuestInvite(req, res, fromUser, to, callId);
    }

    const fromExt = this._extractExtFromUri(fromUri);
    const toExt = this._extractExtFromUri(to.uri);

    if (!fromExt) {
      // Not a local extension — could be an external SIP caller
      // e.g. user@sip2sip.info calling 2002@our-server
      if (toExt) {
        const handled = await this._handleExternalSIP(req, res, fromUri, toExt, callId);
        if (handled) return;
      }
      logger.warn(`INVITE rejected: cannot parse extension from From-URI: ${fromUri}`);
      if (this.securityTracker) this.securityTracker.record(req.source_address, 'INVITE cannot parse extension', req.get('User-Agent'), toExt || fromUri);
      return res.send(404);
    }

    // Monitor feature codes: *11{ext} listen, *12{ext} whisper, *13{ext} barge.
    // These must be handled before the numeric-extension checks below, or the
    // "invalid to" guard rejects them (the To userpart starts with *, not a
    // digit). The caller is verified as a registered extension first.
    const toUser = (String(to.uri).match(/sip:([^@;>]+)@/) || [])[1];
    if (this.monitorHandler && this._isFeatureCode(toUser)) {
      const callerOk = await this.registrar.isRegistered(fromExt);
      if (!callerOk) {
        logger.warn(`MONITOR: caller ${fromExt} not registered, rejecting ${toUser}`);
        return res.send(403);
      }
      logger.info(`MONITOR: ${fromExt} dialled feature code ${toUser}`);
      const handled = await this.monitorHandler.handleMonitorDial(req, res, fromExt, toUser);
      if (handled) return;
      return res.send(404);
    }

    // Anti-spoofing: the caller must be registered FROM THIS SOURCE IP, not
    // merely registered somewhere. An attacker who knows a valid extension
    // number can otherwise send an INVITE with From: <ext> from anywhere and
    // place outbound calls as that extension (toll fraud). We check the source
    // IP against where the extension actually registered.
    const callerRegistered = await this.registrar.isRegisteredFrom(fromExt, req.source_address);
    if (!callerRegistered) {
      // Could be a genuine external SIP call where the user part happens to be
      // numeric (e.g. 15551234567@sip2sip.info calling 2002@our-server). Those
      // are handled separately and can only ever reach a local extension, never
      // a trunk — so this path cannot be abused for outbound fraud.
      if (toExt && fromExt !== toExt) {
        const handled = await this._handleExternalSIP(req, res, fromUri, toExt, callId);
        if (handled) return;
      }
      // Distinguish "not registered at all" from "registered elsewhere" (spoof)
      const registeredSomewhere = await this.registrar.isRegistered(fromExt);
      if (registeredSomewhere) {
        logger.warn(`SECURITY: INVITE from ${req.source_address} spoofing extension ${fromExt} (registered from a different IP) -> ${toExt} — REJECTED`);
        if (this.securityTracker) this.securityTracker.record(req.source_address, 'Spoofed extension in From header (possible toll fraud)', req.get('User-Agent'), `${fromExt}->${toExt}`);
      } else {
        logger.warn(`INVITE rejected: caller ${fromExt} not registered (from ${req.source_address})`);
        if (this.securityTracker) this.securityTracker.record(req.source_address, 'INVITE caller not registered', req.get('User-Agent'), toExt || '');
      }
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

    // BLF: both parties ringing
    this._emitPresence(fromExt, 'ringing', { callId, remoteParty: toExt, direction: 'initiator' });
    this._emitPresence(toExt, 'ringing', { callId, remoteParty: fromExt, direction: 'recipient' });

    try {
      const contact = this._getLatestContact(calleeContacts);
      const target = this._contactTarget(toExt, contact);
      const targetUri = target.uri;
      logger.info(`INTERNAL: ${fromExt} -> ${toExt} at ${contact.ip}:${contact.port}${target.webrtc ? ' (WebRTC)' : ''}${this._isWebRTCRequest(req) ? ' [caller WebRTC]' : ''}`);
      const rtpOffer = await this._rtpengineOffer(callId, from.params.tag, req.body, { target: target.media });

      if (!rtpOffer) {
        // A browser leg can't talk directly to a plain-RTP phone (DTLS-SRTP/ICE
        // vs RTP/AVP) — without RTPEngine there is no media, so fail cleanly.
        if (target.webrtc || this._isWebRTCRequest(req)) {
          logger.warn(`INTERNAL: WebRTC call ${fromExt} -> ${toExt} needs RTPEngine bridging but the offer failed [${callId}]`);
          this._emitPresence(fromExt, 'idle');
          this._emitPresence(toExt, 'idle');
          try { res.send(488); } catch (e) {}
          return this._failCall(cdr, Object.assign(new Error('WebRTC media bridge unavailable'), { status: 488 }), fromExt, toExt);
        }
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
        result.uas.on('destroy', () => { try { result.uac.destroy(); } catch(e) {} onDestroy('caller'); });
        result.uac.on('destroy', () => { try { result.uas.destroy(); } catch(e) {} onDestroy('callee'); });
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

    // Check blocklist
    try {
      const { BlockedNumber } = require('../models');
      const blocked = await BlockedNumber.findOne({ number: callerID });
      if (blocked) {
        logger.info(`INBOUND BLOCKED: ${callerID} is on blocklist (reason: ${blocked.reason || 'none'})`);
        // Create CDR for the blocked call
        const cdr = await this._createCDR(callerID, did || 'unknown', 'inbound', callId, req.source_address);
        cdr.status = 'blocked';
        cdr.hangupCause = 'blocked';
        cdr.trunkUsed = trunkCheck.trunkName;
        cdr.didNumber = did;
        cdr.endTime = new Date();
        cdr.duration = 0;
        cdr.talkTime = 0;
        await cdr.save();
        return res.send(603); // 603 Decline
      }
    } catch (blErr) {
      logger.debug(`Blocklist check error: ${blErr.message}`);
    }

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

      // CRM: screen pop — fire-and-forget, don't block call setup
      if (this.crmManager) {
        try {
          this.crmManager.emit('call.ringing', {
            callId, callerPhone: callerID, targetExtension: target,
            direction: 'inbound', callerName: req.callingName || '',
          });
        } catch (e) {}
      }

      const contact = this._getLatestContact(contacts);
      const dest = this._contactTarget(target, contact);
      const targetUri = dest.uri;
      logger.info(`INBOUND: dialing ${target} at ${contact.ip}:${contact.port}${dest.webrtc ? ' (WebRTC)' : ''}`);

      try {
        // Route through RTPEngine for proper NAT/media handling
        const fromTag = req.getParsedHeader('From').params.tag;
        const rtpOffer = await this._rtpengineOffer(callId, fromTag, req.body, { target: dest.media });
        const offerSdp = rtpOffer ? rtpOffer.sdp : req.body;

        const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
          localSdpB: offerSdp,
          localSdpA: (sdp, res) => {
            // Answer: send the extension's SDP back through RTPEngine
            // Note: uas is not yet available here — extract to-tag from the response
            const toTag = (res && res.getParsedHeader && res.getParsedHeader('To')) ?
              (res.getParsedHeader('To').params.tag || '') : '';
            if (toTag && this.rtpengine) {
              return this._rtpengineAnswer(callId, fromTag, toTag, sdp).then(r => r ? r.sdp : sdp);
            }
            return sdp;
          },
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
        const rtpCallId = callId;
        const rtpFromTag = fromTag;
        cdr.rtpengineCallId = rtpCallId;
        cdr.save().catch(e => logger.error(`CDR rtpCallId update: ${e.message}`));
        const onDestroy = async (hangupBy) => {
          await this._endCall(cdr, hangupBy);
          this.activeCalls.delete(callId);
          await this._rtpengineDelete(rtpCallId, rtpFromTag);
        };
        uas.on('destroy', () => { try { uac.destroy(); } catch(e) {} onDestroy('caller'); });
        uac.on('destroy', () => { try { uas.destroy(); } catch(e) {} onDestroy('callee'); });
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

      // CRM: screen pop for all ring group members
      if (this.crmManager && ringGroup.members) {
        try {
          ringGroup.members.forEach(m => {
            this.crmManager.emit('call.ringing', {
              callId, callerPhone: callerID, targetExtension: m,
              direction: 'inbound', callerName: req.callingName || '',
            });
          });
        } catch (e) {}
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
          if (rtpCallId) {
            cdr.rtpengineCallId = rtpCallId;
            cdr.save().catch(e => logger.error(`CDR rtpCallId update: ${e.message}`));
          }

          const onDestroy = async (hangupBy) => {
            await this._endCall(cdr, hangupBy);
            // Clean up RTPEngine session — recorder-worker handles pcap→wav conversion
            if (rtpCallId && rtpFromTag) {
              await this._rtpengineDelete(rtpCallId, rtpFromTag);
              logger.debug(`Recording pcap released for ${cdr.callId} (sipCallId=${rtpCallId})`);
            }
            this.activeCalls.delete(callId);
          };
          result.uas.on('destroy', () => { try { result.uac.destroy(); } catch(e) {} onDestroy('caller'); });
          result.uac.on('destroy', () => { try { result.uas.destroy(); } catch(e) {} onDestroy('callee'); });
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

    } else if (type === 'appointment') {
      if (this.appointmentHandler) {
        const { Appointment } = require('../models');
        const apptConfig = await Appointment.findOne({ number: target, enabled: true });
        if (apptConfig) {
          logger.info(`INBOUND: routing to appointment ${target} (${apptConfig.name})`);
          const handled = await this.appointmentHandler.handleAppointment(req, res, apptConfig, cdr);
          if (handled) return;
        }
        logger.warn(`INBOUND: appointment ${target} not found`);
      } else {
        logger.warn(`INBOUND: appointment handler not available`);
      }
      if (!res.finalResponseSent) res.send(404);
      return;

    } else {
      logger.info(`INBOUND: destination is hangup for DID ${did}`);
      cdr.status = 'completed';
      cdr.hangupCause = 'no_destination';
      await cdr.save();
      res.send(503);
    }
  }

  // ============================================================
  // EXTERNAL SIP CALL
  //
  // Handles calls from external SIP URIs (e.g. user@sip2sip.info)
  // to local extensions. Two checks:
  //   1. Caller's domain must be in the SIPDomain whitelist
  //   2. Target extension must have allowExternalCalls: true
  //
  // If both pass, route to the extension as an inbound call.
  // ============================================================
  async _handleExternalSIP(req, res, fromUri, toExt, callId) {
    // Extract the domain/IP from the From URI
    const domainMatch = fromUri.match(/@([^>;:\s]+)/);
    if (!domainMatch) return false;
    const callerDomain = domainMatch[1].toLowerCase();
    const sourceIp = req.source_address || '';

    // Skip our own domain/IP — these should be handled as internal
    const ownDomain = (process.env.SIP_DOMAIN || '').toLowerCase();
    const ownIp = (process.env.EXTERNAL_IP || '').toLowerCase();
    if (callerDomain === ownDomain || callerDomain === ownIp) return false;
    if (sourceIp === ownIp) return false;

    // Check 1: Is the domain OR source IP whitelisted?
    const { SIPDomain } = require('../models');
    // Match against: the From-URI domain, OR the actual source IP of the packet
    const allowedEntry = await SIPDomain.findOne({
      enabled: true,
      $or: [
        { domain: callerDomain },
        { domain: sourceIp }
      ]
    });
    if (!allowedEntry) {
      logger.info(`EXTERNAL SIP: ${callerDomain} (src=${sourceIp}) not in whitelist, rejecting`);
      if (this.securityTracker) this.securityTracker.record(sourceIp, 'external SIP not whitelisted', req.get('User-Agent'), toExt || '');
      return false;
    }

    logger.info(`EXTERNAL SIP: matched whitelist entry "${allowedEntry.name || allowedEntry.domain}" (type=${allowedEntry.entryType || 'domain'}, pattern=${allowedEntry.domain})`);

    // Check 2: Does the target extension allow external calls?
    const targetExt = await Extension.findOne({ extension: toExt, enabled: true });
    if (!targetExt) {
      logger.info(`EXTERNAL SIP: extension ${toExt} not found`);
      return false;
    }
    if (!targetExt.allowExternalCalls) {
      logger.info(`EXTERNAL SIP: extension ${toExt} has external calls disabled`);
      res.send(403);
      return true; // handled — we sent the response
    }

    // Check 3: Is the extension registered?
    const contacts = await this.registrar.getContacts(toExt);
    if (contacts.length === 0) {
      logger.info(`EXTERNAL SIP: extension ${toExt} not registered`);
      // Try voicemail
      if (this.voicemailHandler) {
        const callerID = this._extractCallerFromUri(fromUri);
        const cdr = await this._createCDR(callerID, toExt, 'inbound', callId, req.source_address);
        cdr.trunkUsed = `sip:${callerDomain}`;
        await cdr.save();
        const handled = await this.voicemailHandler.handleVoicemail(req, res, callerID, toExt, cdr);
        if (handled) return true;
      }
      res.send(480);
      return true;
    }

    // Extract a readable caller ID
    const callerID = this._extractCallerFromUri(fromUri);
    logger.info(`EXTERNAL SIP: ${callerID}@${callerDomain} -> ${toExt} [${callId}] (domain: ${allowedDomain.name || callerDomain})`);

    // Check blocklist
    try {
      const { BlockedNumber } = require('../models');
      const blocked = await BlockedNumber.findOne({ number: callerID });
      if (blocked) {
        logger.info(`EXTERNAL SIP BLOCKED: ${callerID} is on blocklist`);
        res.send(603);
        return true;
      }
    } catch (e) {}

    // Create CDR
    const cdr = await this._createCDR(callerID, toExt, 'inbound', callId, req.source_address);
    cdr.trunkUsed = `sip:${callerDomain}`;
    await cdr.save();

    // BLF
    this._emitPresence(toExt, 'ringing', { callId, remoteParty: callerID, direction: 'recipient' });

    const contact = this._getLatestContact(contacts);
    const dest = this._contactTarget(toExt, contact);
    const targetUri = dest.uri;

    try {
      const fromTag = req.getParsedHeader('From').params.tag;
      const rtpOffer = await this._rtpengineOffer(callId, fromTag, req.body, { target: dest.media });
      const offerSdp = rtpOffer ? rtpOffer.sdp : req.body;

      const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
        localSdpB: offerSdp,
        localSdpA: (sdp, res) => {
          const toTag = (res && res.getParsedHeader && res.getParsedHeader('To')) ?
            (res.getParsedHeader('To').params.tag || '') : '';
          if (toTag && this.rtpengine) {
            return this._rtpengineAnswer(callId, fromTag, toTag, sdp).then(r => r ? r.sdp : sdp);
          }
          return sdp;
        },
        passFailure: false
      });

      cdr.status = 'answered';
      cdr.answerTime = new Date();
      await cdr.save();
      logger.info(`EXTERNAL SIP ANSWERED: ${callerID}@${callerDomain} -> ${toExt} [${callId}]`);

      this._emitPresence(toExt, 'confirmed', { callId, remoteParty: callerID, direction: 'recipient' });

      this.activeCalls.set(callId, { uas, uac, cdr, fromExt: callerID, toExt });
      cdr.rtpengineCallId = callId;
      cdr.save().catch(() => {});

      const onDestroy = async (hangupBy) => {
        await this._endCall(cdr, hangupBy);
        this.activeCalls.delete(callId);
        await this._rtpengineDelete(callId, fromTag);
      };
      uas.on('destroy', () => { try { uac.destroy(); } catch (e) {} onDestroy('caller'); });
      uac.on('destroy', () => { try { uas.destroy(); } catch (e) {} onDestroy('callee'); });

    } catch (err) {
      logger.error(`EXTERNAL SIP FAILED: ${callerID}@${callerDomain} -> ${toExt}: ${err.message}`);
      this._emitPresence(toExt, 'idle');
      // Try voicemail on no-answer
      if (this.voicemailHandler && !res.finalResponseSent) {
        const handled = await this.voicemailHandler.handleVoicemail(req, res, callerID, toExt, cdr);
        if (handled) return true;
      }
      await this._failCall(cdr, err, callerID, toExt);
    }

    return true;
  }

  // Extract a caller identifier from a SIP URI
  // sip:john@sip2sip.info → john
  // sip:+15551234567@provider.com → 15551234567
  _extractCallerFromUri(uri) {
    if (!uri) return 'unknown';
    const match = uri.match(/sip:([^@]+)@/);
    if (match) {
      return match[1].replace(/^\+/, '');
    }
    return 'unknown';
  }

  async _handleOutbound(req, res, fromExt, dialedNumber, callId) {
    logger.info(`OUTBOUND: ${fromExt} -> ${dialedNumber} [${callId}]`);

    // Toll-fraud destination guard — applied before routing, so a permitted
    // route can never carry a blocked/foreign destination.
    if (this.outboundGuard) {
      const g = await this.outboundGuard.check(dialedNumber);
      if (!g.allowed) {
        logger.warn(`SECURITY: OUTBOUND BLOCKED ${fromExt} -> ${dialedNumber} [${callId}]: ${g.reason}`);
        if (this.securityTracker) this.securityTracker.record(req.source_address, `Outbound blocked: ${g.reason}`, req.get('User-Agent'), `${fromExt}->${dialedNumber}`);
        return res.send(403);
      }
    }

    const route = await this.callRouter.findOutboundRoute(dialedNumber, fromExt);
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
    cdr.didNumber = callerId;
    await cdr.save();

    this._emitPresence(fromExt, 'ringing', { callId, remoteParty: dialedNumber, direction: 'initiator' });

    const from = req.getParsedHeader('From');
    const fromTag = from.params.tag;

    try {
      // Step 1: RTPEngine offer (same as internal calls line 144)
      const rtpOffer = await this._rtpengineOffer(callId, fromTag, req.body);

      // Step 2: createB2BUA with ring timeout from outbound route
      const ringTimeout = route.ringTimeout || 60;
      const { uas, uac } = await this.trunkManager.sendOutboundWithRtp(req, res, trunk, processedNumber, callerId, {
        localSdpB: rtpOffer ? rtpOffer.sdp : req.body,
        localSdpA: async (sdp, res2) => {
          const toTag = res2.getParsedHeader('To').params.tag;
          const rtpAnswer = await this._rtpengineAnswer(callId, fromTag, toTag, sdp);
          return rtpAnswer ? rtpAnswer.sdp : sdp;
        }
      }, ringTimeout);

      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.recorded = !!rtpOffer;
      cdr.rtpengineCallId = callId;
      await cdr.save();
      logger.info(`OUTBOUND ANSWERED: ${fromExt} -> ${processedNumber} via ${route.trunk} [${callId}] (ringTimeout=${ringTimeout}s)`);

      this._emitPresence(fromExt, 'confirmed', { callId, remoteParty: dialedNumber, direction: 'initiator' });
      this._trackCall(callId, uas, uac, cdr, fromExt, dialedNumber, fromTag);
    } catch (err) {
      if (fromTag) this._rtpengineDelete(callId, fromTag).catch(() => {});
      this._emitPresence(fromExt, 'idle');
      await this._failCall(cdr, err, fromExt, dialedNumber);
    }
  }

  // ============================================================
  // Click-to-call origination (CRM screen pop, and any UI "dial" button)
  //
  // There is no inbound INVITE to drive the call, so we originate BOTH legs:
  // dial the trunk toward the number, dial the agent's phone, and bridge the
  // two through RTPEngine — the same two-UAC pattern the predictive dialer
  // uses. Both legs are RTPEngine-bridged and recorded like a normal call.
  //
  // Routing and authorization go through the SAME central service as a
  // dialled call — callRouter.findOutboundRoute(number, fromExt), which
  // enforces each route's allowedExtensions. Screen-pop cannot originate to a
  // number, or via a route, the agent's normal outbound permissions forbid.
  //
  // @returns {Promise<{success, callId?, error?}>}
  // ============================================================
  async originate(extension, phone, opts = {}) {
    if (!this.srf) return { success: false, error: 'PBX not ready' };
    const rtpHelper = require('../utils/rtp-helper');
    const fromExt = String(extension || '').trim();
    const number = String(phone || '').trim();
    if (!fromExt || !number) return { success: false, error: 'Extension and number are required' };

    // 1. Agent must be registered
    const agentContacts = await this.registrar.getContacts(fromExt);
    if (!agentContacts || agentContacts.length === 0) {
      return { success: false, error: `Extension ${fromExt} is not registered` };
    }

    // 2. Central outbound authorization + routing (enforces allowedExtensions)
    const route = await this.callRouter.findOutboundRoute(number, fromExt);
    if (!route) {
      logger.warn(`CLICK2CALL: ${fromExt} not permitted to dial ${number} (no authorized outbound route)`);
      return { success: false, error: 'You are not permitted to call this number' };
    }
    const trunk = this.trunkManager.getTrunk(route.trunk);
    if (!trunk) {
      logger.warn(`CLICK2CALL: trunk ${route.trunk} not available`);
      return { success: false, error: `Trunk ${route.trunk} is not available` };
    }

    if (this.outboundGuard) {
      const g = await this.outboundGuard.check(number);
      if (!g.allowed) {
        logger.warn(`SECURITY: CLICK2CALL BLOCKED ${fromExt} -> ${number}: ${g.reason}`);
        return { success: false, error: `This destination is not permitted: ${g.reason}` };
      }
    }

    const processedNumber = this.callRouter.processOutboundNumber(number, route);
    const callerId = route.callerIdNumber || fromExt;
    const callId = uuidv4();
    const bridgeTag = `c2c-${callId}`;
    const externalIp = process.env.EXTERNAL_IP || '127.0.0.1';
    const host = trunk.host || '';
    const port = trunk.port || 5060;

    const cdr = await this._createCDR(fromExt, number, 'outbound', callId, 'click2call');
    cdr.trunkUsed = route.trunk;
    cdr.didNumber = callerId;
    await cdr.save();

    logger.info(`CLICK2CALL: ${fromExt} -> ${number} via ${route.trunk} [${callId}]`);
    this._emitPresence(fromExt, 'ringing', { callId, remoteParty: number, direction: 'initiator' });

    // The origination runs after we return, so the click responds immediately.
    (async () => {
      let trunkUac = null, agentUac = null;
      try {
        // 3. Dial the trunk toward the number
        const trunkUri = `sip:${processedNumber}@${host}:${port}`;
        trunkUac = await this.srf.createUAC(trunkUri, {
          headers: {
            'From': `<sip:${trunk.username || callerId}@${host}>`,
            'To': `<sip:${processedNumber}@${host}>`,
            'P-Asserted-Identity': `<sip:${callerId}@${host}>`
          },
          auth: (trunk.username ? { username: trunk.username, password: trunk.password } : undefined),
          timeout: (route.ringTimeout || 30) * 1000
        });

        // 4. Bridge the answered trunk leg out to the agent through RTPEngine
        const trunkSdp = trunkUac.remote ? trunkUac.remote.sdp : '';
        let offerSdp = trunkSdp;
        const off = await rtpHelper.offer(this.rtpengine, callId, bridgeTag, trunkSdp, { 'record call': 'yes' });
        if (off && off.sdp) offerSdp = off.sdp;

        const contact = this._getLatestContact(agentContacts);
        const target = this._contactTarget(fromExt, contact);

        agentUac = await this.srf.createUAC(target.uri, {
          localSdp: offerSdp,
          headers: {
            'From': `<sip:${number}@${externalIp}>`,
            'To': `<sip:${fromExt}@${externalIp}>`,
            'Contact': `<sip:${number}@${externalIp}>`
          },
          callingNumber: number
        });

        // 5. Answer the trunk with the agent's SDP, re-INVITE trunk to RTPEngine
        if (agentUac.remote && agentUac.remote.sdp) {
          const agentTag = agentUac.sip ? agentUac.sip.localTag : `at-${callId}`;
          const ans = await rtpHelper.answer(this.rtpengine, callId, bridgeTag, agentTag, agentUac.remote.sdp,
            { 'record call': 'yes' }, { offerer: target.media });
          if (ans && ans.sdp) {
            try { await trunkUac.modify(ans.sdp); } catch (e) { logger.warn(`CLICK2CALL: trunk re-INVITE failed [${callId}]: ${e.message}`); }
          }
        }

        cdr.status = 'answered';
        cdr.answerTime = new Date();
        cdr.recorded = !!off;
        cdr.rtpengineCallId = callId;
        await cdr.save();

        this._emitPresence(fromExt, 'confirmed', { callId, remoteParty: number, direction: 'initiator' });
        this._trackCall(callId, agentUac, trunkUac, cdr, fromExt, number, bridgeTag);
        logger.info(`CLICK2CALL ANSWERED: ${fromExt} <-> ${number} via ${route.trunk} [${callId}]`);
      } catch (err) {
        const sip = err.status || 0;
        try { if (trunkUac) trunkUac.destroy(); } catch (e) {}
        try { if (agentUac) agentUac.destroy(); } catch (e) {}
        await rtpHelper.del(this.rtpengine, callId, bridgeTag).catch(() => {});
        this._emitPresence(fromExt, 'idle');
        if (sip === 486 || sip === 600) { cdr.status = 'busy'; }
        else if (sip === 480 || sip === 408 || sip === 487) { cdr.status = 'missed'; }
        else { cdr.status = 'failed'; }
        cdr.hangupCause = `click2call_${sip || 'error'}`;
        cdr.endTime = new Date();
        await cdr.save().catch(() => {});
        logger.warn(`CLICK2CALL FAILED: ${fromExt} -> ${number} [${callId}] sip=${sip}: ${err.message}`);
      }
    })();

    return { success: true, callId };
  }

  async _createCDR(from, to, direction, sipCallId, fromIp) {
    const cdr = new CDR({ callId: uuidv4(), sipCallId, from, to, direction, status: 'ringing', startTime: new Date(), fromIp });
    await cdr.save();
    return cdr;
  }

  _trackCall(callId, uas, uac, cdr, fromExt, toExt, fromTag) {
    this.activeCalls.set(callId, { uas, uac, cdr, fromExt, toExt });

    // Save RTPEngine call-id so recorder-worker can link pcap to CDR
    if (fromTag) {
      cdr.rtpengineCallId = callId;
      cdr.save().catch(e => logger.error(`CDR rtpCallId update: ${e.message}`));
    }

    // Attach transfer (REFER) handlers if transfer handler is available
    if (this.transferHandler) {
      this.transferHandler.attachReferHandlers(callId, uas, uac, cdr);
    }

    // Attach hold (re-INVITE) handlers if hold handler is available
    if (this.holdHandler) {
      this.holdHandler.attachHoldHandlers(callId, uas, uac, cdr, {
        rtpengine: this.rtpengine,
        fromTag: fromTag
      });
    }

    const onDestroy = async (hangupBy) => {
      await this._endCall(cdr, hangupBy);
      if (fromTag) {
        await this._rtpengineDelete(callId, fromTag);
        logger.debug(`Recording pcap released for ${cdr.callId} (sipCallId=${callId})`);
      }
      this.activeCalls.delete(callId);
      if (this.holdHandler) this.holdHandler.cleanup(callId);
      await ActiveCall.deleteOne({ callId: cdr.callId }).catch(() => {});
    };
    uas.on('destroy', () => { try { uac.destroy(); } catch(e) {} onDestroy('caller'); });
    uac.on('destroy', () => { try { uas.destroy(); } catch(e) {} onDestroy('callee'); });
  }

  async _endCall(cdr, hangupBy) {
    // Idempotency guard. Both call legs fire 'destroy' on a normal hangup, so
    // every teardown path can reach here twice (BYE + the resulting destroy of
    // the other leg). Without this, one hangup produces duplicate CDR saves,
    // presence changes, CRM events and cleanup. Guard on the CDR object so it
    // holds regardless of which of the several onDestroy closures calls us.
    if (!cdr) return;
    if (cdr.__ended) return;
    cdr.__ended = true;

    // Web calls: the guest identity dies with the call (Phase 2/3)
    if (this.guestManager && cdr && cdr.direction === 'web-inbound' && cdr.sipCallId) {
      try { this.guestManager.endCall(cdr.sipCallId, `call ended (${hangupBy})`); } catch (e) {}
      if (this.screenPopHandler) { try { this.screenPopHandler.onCallEnded(cdr.sipCallId); } catch (e) {} }
    }
    // If the CDR was already finalised (failed/missed/busy), don't overwrite it
    // as 'completed' — just run the cleanup side-effects once.
    const alreadyTerminal = ['completed', 'failed', 'missed', 'busy', 'voicemail'].includes(cdr.status);
    const endTime = new Date();
    if (!alreadyTerminal) {
      cdr.status = 'completed';
      cdr.hangupCause = 'normal_clearing';
    }
    cdr.endTime = endTime;
    cdr.duration = Math.round((endTime - cdr.startTime) / 1000);
    cdr.talkTime = cdr.answerTime ? Math.round((endTime - cdr.answerTime) / 1000) : 0;
    cdr.hangupBy = hangupBy;
    await cdr.save();
    logger.info(`CALL ENDED ${cdr.from} -> ${cdr.to} duration=${cdr.talkTime}s hangup=${hangupBy}`);

    // BLF: both parties go idle
    this._emitPresence(cdr.from, 'idle');
    this._emitPresence(cdr.to, 'idle');

    // CRM: emit call.ended event for auto-logging
    if (this.crmManager) {
      try {
        this.crmManager.emit('call.ended', {
          callId: cdr.callId,
          from: cdr.from,
          to: cdr.to,
          direction: cdr.direction,
          duration: cdr.duration,
          talkTime: cdr.talkTime,
          disposition: cdr.disposition || '',
          notes: '',
          recordingUrl: cdr.recordingPath || '',
          agent: cdr.direction === 'outbound' ? cdr.from : cdr.to,
          startTime: cdr.startTime,
          endTime: cdr.endTime,
          extension: cdr.direction === 'outbound' ? cdr.from : cdr.to,
        });
      } catch (e) {
        logger.debug(`CRM event emit error: ${e.message}`);
      }
    }
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
      uas.on('destroy', async () => { try { uac.destroy(); } catch(e) {} await this._endCall(cdr, 'caller'); this.activeCalls.delete(callId); });
      uac.on('destroy', async () => { try { uas.destroy(); } catch(e) {} await this._endCall(cdr, 'callee'); this.activeCalls.delete(callId); });
    } catch (err) {
      await this._failCall(cdr, err, cdr.from, cdr.to);
    }
  }


  // ============================================================
  // Web-call guest INVITE (Web Dialer — Phase 2)
  //
  //   1. Digest-challenge the INVITE and verify it against the guest's
  //      one-shot token (browsers all share the proxy's loopback address,
  //      so the credential is the only identity that counts)
  //   2. Refuse any destination except the widget's own — a guest can
  //      never reach a trunk, another extension or a feature code
  //   3. Bind the token to this call (single-use) and destroy the guest
  //      identity when the call ends
  //
  // Phase 3 replaces the dialling below with full route resolution
  // (IVR, queues, time conditions) and the web-call CDR/screen-pop work.
  // ============================================================
  async _handleGuestInvite(req, res, username, to, callId) {
    const gm = this.guestManager;
    const sdpUtil = require('../utils/webrtc-sdp');
    const transport = sdpUtil.requestTransport(req);

    if (!sdpUtil.isWebSocketTransport(transport)) {
      logger.warn(`WEBCALL: INVITE from guest ${username} over ${transport || 'unknown'} — only WS/WSS is allowed`);
      return res.send(403);
    }

    const guest = gm.get(username);
    if (!guest) {
      logger.warn(`WEBCALL: INVITE rejected: unknown or expired guest ${username}`);
      return res.send(403);
    }

    // --- 1. Authenticate ---
    const authHeader = req.get('Authorization') || req.get('Proxy-Authorization');
    if (!authHeader) return gm.challenge(res, username);

    const authParams = this.registrar._parseAuthHeader(authHeader);
    const check = gm.verify(username, authParams, req.method);
    if (!check.ok) {
      logger.warn(`WEBCALL: INVITE rejected for guest ${username}: ${check.reason}`);
      if (check.reason === 'bad credentials' && this.securityTracker) {
        this.securityTracker.record(req.source_address, 'Web-call guest bad credentials', req.get('User-Agent'), username);
      }
      return gm.challenge(res, username);
    }

    // --- 2. Lockdown: only this widget's destination ---
    const requested = (String(to.uri).match(/sip:\+?([^@;>]+)@/) || [])[1];
    const authz = gm.authorizeDestination(guest, requested);
    if (!authz.allowed) {
      logger.warn(`WEBCALL: guest ${username} DENIED: ${authz.reason}`);
      if (this.securityTracker) {
        this.securityTracker.record(req.source_address, 'Web-call guest dialled a forbidden destination', req.get('User-Agent'), requested);
      }
      return res.send(403);
    }

    // --- 3. Single-use binding ---
    const bind = gm.bindCall(username, callId);
    if (!bind.ok) {
      logger.warn(`WEBCALL: guest ${username} refused: ${bind.reason}`);
      return res.send(403);
    }

    logger.info(`WEBCALL: ${username} (widget ${guest.widgetId}) -> ${authz.destination.type}:${authz.destination.target} [${callId}]`);
    return this._routeGuestCall(req, res, guest, authz.destination, callId);
  }

  // ============================================================
  // Web-call routing (Web Dialer — Phase 3)
  //
  // Resolves the widget's destination — through business hours and time
  // conditions if configured — and hands the call to the SAME handlers a
  // PSTN call uses: ring groups, IVR, queues, voicemail. Nothing about
  // ring strategies, menus or queue positions is duplicated here.
  //
  // Media is bridged by RTPEngine exactly as in Phase 1: the browser leg
  // stays DTLS-SRTP, everything inside the PBX stays plain RTP, and the
  // recorder sees an ordinary G.711 call.
  // ============================================================
  // ============================================================
  // Who is calling (Web Dialer — Phase 6)
  //
  // The widget sends the pre-call form both on the token and as SIP
  // headers on the INVITE. Headers win (they belong to this call), the
  // token record is the fallback. Values are treated as untrusted text
  // from a public web form: trimmed, length-capped, never interpreted.
  // ============================================================
  _webCallerInfo(req, guest) {
    const clean = (v, max) => String(v || '').replace(/[\r\n]/g, ' ').trim().slice(0, max || 80);
    const h = (name) => { try { return req.get(name); } catch (e) { return null; } };
    const name = clean(h('X-Web-Name') || guest.callerName, 80);
    const number = clean(h('X-Web-Number') || guest.callerNumber, 40);
    const page = clean(h('X-Web-Page') || guest.pageUrl, 250);
    return {
      name,
      number,
      page,
      widgetId: guest.widgetId,
      widgetName: guest.widgetName,
      origin: guest.origin || '',
      // What the agent sees in the CDR and on their phone
      label: name || number || 'Web caller'
    };
  }

  // Stamp the web details onto the CDR (fire-and-forget; never blocks the call)
  _stampWebCdr(cdr, info) {
    try {
      cdr.webSource = { widgetId: info.widgetId, widgetName: info.widgetName, page: info.page, origin: info.origin };
      cdr.webCaller = { name: info.name, number: info.number };
      cdr.save().catch(() => {});
    } catch (e) {}
  }

  // Screen pop for a web call — the same Socket.IO path a PSTN call uses,
  // with the widget details attached so the agent knows where it came from.
  _webScreenPop(extension, callId, info, guest) {
    if (!this.crmManager || !extension) return;
    try {
      this.crmManager.emit('call.ringing', {
        callId,
        callerPhone: info.number || '',
        callerName: info.name || '',
        targetExtension: extension,
        direction: 'web-inbound',
        web: {
          widgetId: info.widgetId,
          widgetName: info.widgetName,
          page: info.page,
          origin: info.origin,
          name: info.name,
          number: info.number,
          createLead: !!(guest && guest.crmCreateLead)
        }
      });
    } catch (e) { /* screen pop must never break a call */ }
  }

  async _routeGuestCall(req, res, guest, dest, callId) {
    // Widget business hours — closed hours follow the time condition's
    // own no-match destination (voicemail, another group, and so on).
    const hours = guest.businessHours;
    if (hours && hours.enabled && hours.timeConditionNumber && this.callRouter) {
      try {
        const resolved = await this.callRouter.resolveDestination({ type: 'timecondition', target: hours.timeConditionNumber });
        if (resolved && resolved.type) {
          logger.info(`WEBCALL: business hours ${hours.timeConditionNumber} -> ${resolved.type}:${resolved.target} [${callId}]`);
          dest = resolved;
        }
      } catch (e) {
        logger.warn(`WEBCALL: business hours check failed (${e.message}) — using the widget destination [${callId}]`);
      }
    }

    // A destination that is itself a time condition
    if (dest.type === 'timecondition' && this.callRouter) {
      try {
        const resolved = await this.callRouter.resolveDestination(dest);
        logger.info(`WEBCALL: time condition ${dest.target} -> ${resolved.type}:${resolved.target} [${callId}]`);
        dest = resolved;
      } catch (e) {
        logger.warn(`WEBCALL: time condition ${dest.target} failed: ${e.message} [${callId}]`);
      }
    }

    return this._dialGuestDestination(req, res, guest, dest, callId);
  }

  async _dialGuestDestination(req, res, guest, dest, callId) {
    const gm = this.guestManager;
    const from = req.getParsedHeader('From');
    const fromTag = from.params.tag;
    const web = this._webCallerInfo(req, guest);
    const callerLabel = web.label;

    const finish = (reason) => { try { gm.endCall(callId, reason); } catch (e) {} };

    // Ring group — reuse the existing ring-group engine unchanged
    if (dest.type === 'ringgroup') {
      const ringGroup = await this.ringGroupHandler.isRingGroup(dest.target);
      if (!ringGroup) { logger.warn(`WEBCALL: ring group ${dest.target} not found [${callId}]`); finish('destination missing'); return res.send(404); }
      const cdr = await this._createCDR(callerLabel, `RG:${ringGroup.number}`, 'web-inbound', callId, req.source_address);
      this._stampWebCdr(cdr, web);
      if (ringGroup.members) {
        ringGroup.members.forEach(m => {
          this._emitPresence(m, 'ringing', { callId, remoteParty: callerLabel, direction: 'recipient' });
          this._webScreenPop(m, callId, web, guest);
        });
      }
      try {
        const result = await this.ringGroupHandler.ringGroup(req, res, ringGroup, cdr);
        if (result && result.uas && result.uac) {
          cdr.status = 'answered';
          cdr.answerTime = new Date();
          if (result.answeredBy) cdr.to = result.answeredBy;
          await cdr.save();
          this._emitPresence(result.answeredBy, 'confirmed', { callId, remoteParty: callerLabel, direction: 'recipient' });
          if (this.crmManager) { try { this.crmManager.emit('call.answered', { callId, targetExtension: result.answeredBy }); } catch (e) {} }
          if (ringGroup.members) ringGroup.members.forEach(m => { if (m !== result.answeredBy) this._emitPresence(m, 'idle'); });

          const onDestroy = async (hangupBy) => {
            await this._endCall(cdr, hangupBy);
            this.activeCalls.delete(callId);
            finish(hangupBy === 'caller' ? 'web caller hung up' : 'agent hung up');
          };
          result.uas.on('destroy', () => { try { result.uac.destroy(); } catch (e) {} onDestroy('caller'); });
          result.uac.on('destroy', () => { try { result.uas.destroy(); } catch (e) {} onDestroy('callee'); });
          this.activeCalls.set(callId, { uas: result.uas, uac: result.uac, cdr, fromExt: callerLabel, toExt: result.answeredBy });
        } else {
          if (ringGroup.members) ringGroup.members.forEach(m => this._emitPresence(m, 'idle'));
          await this._endCall(cdr, 'system');
          finish('nobody answered');
        }
      } catch (err) {
        await this._failCall(cdr, err, callerLabel, `RG:${ringGroup.number}`);
        finish('failed');
      }
      return;
    }

    // Single extension
    if (dest.type === 'extension') {
      const contacts = await this.registrar.getContacts(dest.target);
      if (contacts.length === 0) {
        logger.warn(`WEBCALL: extension ${dest.target} not registered [${callId}]`);
        finish('agent offline');
        return res.send(480);
      }
      const cdr = await this._createCDR(callerLabel, dest.target, 'web-inbound', callId, req.source_address);
      this._stampWebCdr(cdr, web);
      this._emitPresence(dest.target, 'ringing', { callId, remoteParty: callerLabel, direction: 'recipient' });
      this._webScreenPop(dest.target, callId, web, guest);

      try {
        const contact = this._getLatestContact(contacts);
        const target = this._contactTarget(dest.target, contact);
        const rtpOffer = await this._rtpengineOffer(callId, fromTag, req.body, { target: target.media });
        if (!rtpOffer) {
          logger.warn(`WEBCALL: RTPEngine offer failed — a browser call cannot bridge without it [${callId}]`);
          this._emitPresence(dest.target, 'idle');
          try { res.send(488); } catch (e) {}
          finish('no media bridge');
          return this._failCall(cdr, Object.assign(new Error('WebRTC media bridge unavailable'), { status: 488 }), callerLabel, dest.target);
        }

        const { uas, uac } = await this.srf.createB2BUA(req, res, target.uri, {
          localSdpB: rtpOffer.sdp,
          localSdpA: async (sdp, r) => {
            const toTag = (r && r.getParsedHeader && r.getParsedHeader('To')) ? (r.getParsedHeader('To').params.tag || '') : '';
            if (!toTag) return sdp;
            const rtpAnswer = await this._rtpengineAnswer(callId, fromTag, toTag, sdp);
            return rtpAnswer ? rtpAnswer.sdp : sdp;
          }
        });

        cdr.status = 'answered';
        cdr.answerTime = new Date();
        cdr.recorded = true;
        cdr.rtpengineCallId = callId;
        await cdr.save();
        this._emitPresence(dest.target, 'confirmed', { callId, remoteParty: callerLabel, direction: 'recipient' });
        if (this.crmManager) { try { this.crmManager.emit('call.answered', { callId, targetExtension: dest.target }); } catch (e) {} }
        this._trackCall(callId, uas, uac, cdr, callerLabel, dest.target, fromTag);
        // _trackCall ends the CDR and releases media; we only need to drop the guest identity
        uas.on('destroy', () => { this._emitPresence(dest.target, 'idle'); finish('web caller hung up'); });
        uac.on('destroy', () => { this._emitPresence(dest.target, 'idle'); finish('agent hung up'); });
      } catch (err) {
        this._emitPresence(dest.target, 'idle');
        await this._failCall(cdr, err, callerLabel, dest.target);
        await this._rtpengineDelete(callId, fromTag);
        finish('failed');
      }
      return;
    }

    // IVR, queue and voicemail are handled by their own engines. They own the
    // dialog from here, so the guest identity is reclaimed by the call-ended
    // reconciliation in the guest manager rather than a destroy handler.
    const cdr = await this._createCDR(callerLabel, `${dest.type}:${dest.target}`, 'web-inbound', callId, req.source_address);
    this._stampWebCdr(cdr, web);

    try {
      if (dest.type === 'ivr') {
        const { IVR } = require('../models');
        const ivrConfig = this.ivrHandler ? await IVR.findOne({ number: dest.target, enabled: true }) : null;
        if (!ivrConfig) {
          logger.warn(`WEBCALL: IVR ${dest.target} not found or disabled [${callId}]`);
          cdr.status = 'failed'; cdr.hangupCause = 'ivr_missing'; await cdr.save();
          finish('IVR missing');
          return res.send(404);
        }
        cdr.to = `IVR:${dest.target}`;
        await cdr.save();
        logger.info(`WEBCALL: ${callerLabel} -> IVR ${dest.target} (${ivrConfig.name}) [${callId}]`);
        return this.ivrHandler.handleIvr(req, res, ivrConfig, cdr);
      }

      if (dest.type === 'queue') {
        const { Queue } = require('../models');
        const queueConfig = this.queueHandler ? await Queue.findOne({ number: dest.target, enabled: true }) : null;
        if (!queueConfig) {
          logger.warn(`WEBCALL: queue ${dest.target} not found or disabled [${callId}]`);
          cdr.status = 'failed'; cdr.hangupCause = 'queue_missing'; await cdr.save();
          finish('queue missing');
          return res.send(404);
        }
        cdr.to = `Q:${dest.target}`;
        await cdr.save();
        logger.info(`WEBCALL: ${callerLabel} -> queue ${dest.target} (${queueConfig.name}) [${callId}]`);
        const handled = await this.queueHandler.handleQueue(req, res, queueConfig, cdr, callerLabel);
        if (handled) return;
        finish('queue declined the call');
        if (!res.finalResponseSent) res.send(503);
        return;
      }

      if (dest.type === 'voicemail') {
        if (!this.voicemailHandler) {
          finish('voicemail unavailable');
          return res.send(480);
        }
        logger.info(`WEBCALL: ${callerLabel} -> voicemail ${dest.target} [${callId}]`);
        const handled = await this.voicemailHandler.handleVoicemail(req, res, callerLabel, dest.target, cdr);
        if (handled) return;
        finish('voicemail declined the call');
        if (!res.finalResponseSent) res.send(480);
        return;
      }
    } catch (err) {
      logger.error(`WEBCALL: ${dest.type} ${dest.target} failed: ${err.message} [${callId}]`);
      await this._failCall(cdr, err, callerLabel, `${dest.type}:${dest.target}`);
      finish('failed');
      if (!res.finalResponseSent) res.send(500);
      return;
    }

    logger.warn(`WEBCALL: unsupported destination type '${dest.type}' [${callId}]`);
    cdr.status = 'failed'; cdr.hangupCause = 'bad_destination'; await cdr.save();
    finish('unsupported destination type');
    return res.send(503);
  }

  // opts.target: 'webrtc' | 'sip' — media type of the endpoint receiving the offer.
  // Omitted = SIP endpoint (previous behaviour). A browser caller's offer is
  // detected automatically from its SDP and converted to plain RTP.
  async _rtpengineOffer(callId, fromTag, sdp, opts) {
    const rtpHelper = require('../utils/rtp-helper');
    return rtpHelper.offer(this.rtpengine, callId, fromTag, sdp, { 'record call': 'yes' }, opts);
  }

  // ============================================================
  // WebRTC helpers (Phase 1)
  // ============================================================

  // Request-URI + media type for a registered contact.
  // Falls back to the classic sip:ext@ip:port form if the registrar
  // predates the WebRTC changes.
  _contactTarget(ext, contact) {
    if (this.registrar && typeof this.registrar.contactTarget === 'function') {
      const t = this.registrar.contactTarget(ext, contact);
      if (t) return t;
    }
    return { uri: `sip:${ext}@${contact.ip}:${contact.port}`, media: 'sip', webrtc: false };
  }

  // True when the INVITE came from a browser (WS transport or WebRTC SDP).
  _isWebRTCRequest(req) {
    const sdpUtil = require('../utils/webrtc-sdp');
    return sdpUtil.isWebSocketTransport(sdpUtil.requestTransport(req)) || sdpUtil.isWebRTCSdp(req.body);
  }

  async _rtpengineAnswer(callId, fromTag, toTag, sdp) {
    const rtpHelper = require('../utils/rtp-helper');
    return rtpHelper.answer(this.rtpengine, callId, fromTag, toTag, sdp, { 'record call': 'yes' });
  }

  async _rtpengineDelete(callId, fromTag) {
    const rtpHelper = require('../utils/rtp-helper');
    return rtpHelper.del(this.rtpengine, callId, fromTag);
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
