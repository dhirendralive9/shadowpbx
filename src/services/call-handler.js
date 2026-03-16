const { v4: uuidv4 } = require('uuid');
const { Extension, CDR, ActiveCall } = require('../models');
const logger = require('../utils/logger');

class CallHandler {
  constructor(srf, registrar, rtpengine) {
    this.srf = srf;
    this.registrar = registrar;
    this.rtpengine = rtpengine;
    this.activeCalls = new Map(); // callId -> call state
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };
  }

  // Handle incoming INVITE
  async handleInvite(req, res) {
    const from = req.getParsedHeader('From');
    const to = req.getParsedHeader('To');
    const callId = req.get('Call-Id');

    // Extract extension numbers
    const fromExt = from.uri.match(/sip:(\d+)@/)?.[1];
    const toExt = to.uri.match(/sip:(\d+)@/)?.[1];

    if (!fromExt || !toExt) {
      logger.warn(`INVITE rejected: invalid from=${fromExt} to=${toExt}`);
      return res.send(404);
    }

    logger.info(`CALL ${fromExt} -> ${toExt} [${callId}]`);

    // Verify caller is registered
    const callerRegistered = await this.registrar.isRegistered(fromExt);
    if (!callerRegistered) {
      logger.warn(`INVITE rejected: caller ${fromExt} not registered`);
      return res.send(403);
    }

    // Verify callee exists and is registered
    const calleeContacts = await this.registrar.getContacts(toExt);
    if (calleeContacts.length === 0) {
      logger.warn(`INVITE rejected: callee ${toExt} not registered or not found`);
      return res.send(480); // Temporarily Unavailable
    }

    // Create CDR
    const cdr = new CDR({
      callId: uuidv4(),
      sipCallId: callId,
      from: fromExt,
      to: toExt,
      direction: 'internal',
      status: 'ringing',
      startTime: new Date(),
      fromIp: req.source_address
    });
    await cdr.save();

    try {
      // Build the target SIP URI from first active contact
      const contact = calleeContacts[0];
      const targetUri = `sip:${toExt}@${contact.ip}:${contact.port}`;

      // Use rtpengine for media relay + recording
      const rtpOffer = await this._rtpengineOffer(callId, from.params.tag, req.body);

      if (!rtpOffer) {
        // Fallback: direct media (no recording)
        logger.warn(`RTPEngine unavailable, falling back to direct media for call ${callId}`);
        return this._directCall(req, res, targetUri, cdr);
      }

      // B2BUA: connect caller to callee through rtpengine
      const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
        localSdpB: rtpOffer.sdp,
        localSdpA: async (sdp, res) => {
          // Get answer SDP from rtpengine
          const rtpAnswer = await this._rtpengineAnswer(
            callId,
            from.params.tag,
            res.getParsedHeader('To').params.tag,
            sdp
          );
          return rtpAnswer ? rtpAnswer.sdp : sdp;
        },
        proxyRequestHeaders: ['Subject', 'X-Custom-Header'],
        proxyResponseHeaders: ['Subject', 'X-Custom-Header']
      });

      // Call answered
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.recorded = !!rtpOffer;
      await cdr.save();

      logger.info(`CALL ANSWERED ${fromExt} -> ${toExt} [${callId}]`);

      // Track active call
      this.activeCalls.set(callId, { uas, uac, cdr, fromExt, toExt });
      await ActiveCall.create({
        callId: cdr.callId,
        from: fromExt,
        to: toExt,
        status: 'answered',
        rtpengineCallId: callId,
        rtpengineFromTag: from.params.tag
      });

      // Handle hangup from either side
      const onDestroy = async (hangupBy) => {
        const endTime = new Date();
        cdr.status = 'completed';
        cdr.endTime = endTime;
        cdr.duration = Math.round((endTime - cdr.startTime) / 1000);
        cdr.talkTime = cdr.answerTime
          ? Math.round((endTime - cdr.answerTime) / 1000)
          : 0;
        cdr.hangupBy = hangupBy;
        cdr.hangupCause = 'normal_clearing';

        // Stop rtpengine recording
        await this._rtpengineDelete(callId, from.params.tag);

        // Check for recording file
        const recPath = `${process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings'}/${cdr.callId}.wav`;
        cdr.recordingPath = recPath;
        await cdr.save();

        // Clean up
        this.activeCalls.delete(callId);
        await ActiveCall.deleteOne({ callId: cdr.callId });

        logger.info(`CALL ENDED ${fromExt} -> ${toExt} duration=${cdr.talkTime}s hangup=${hangupBy}`);
      };

      uas.on('destroy', () => {
        uac.destroy();
        onDestroy('caller');
      });
      uac.on('destroy', () => {
        uas.destroy();
        onDestroy('callee');
      });

    } catch (err) {
      logger.error(`CALL FAILED ${fromExt} -> ${toExt}: ${err.message}`);
      cdr.status = 'failed';
      cdr.endTime = new Date();
      cdr.hangupCause = err.status ? `sip_${err.status}` : err.message;
      await cdr.save();

      if (!res.finalResponseSent) {
        if (err.status === 486) {
          cdr.status = 'busy';
          await cdr.save();
        }
      }
    }
  }

  // Direct call without rtpengine (no recording)
  async _directCall(req, res, targetUri, cdr) {
    try {
      const { uas, uac } = await this.srf.createB2BUA(req, res, targetUri, {
        localSdpB: req.body
      });

      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.recorded = false;
      await cdr.save();

      const callId = req.get('Call-Id');
      this.activeCalls.set(callId, { uas, uac, cdr });

      uas.on('destroy', async () => {
        uac.destroy();
        await this._endCall(cdr, 'caller');
        this.activeCalls.delete(callId);
      });
      uac.on('destroy', async () => {
        uas.destroy();
        await this._endCall(cdr, 'callee');
        this.activeCalls.delete(callId);
      });
    } catch (err) {
      cdr.status = 'failed';
      cdr.endTime = new Date();
      cdr.hangupCause = err.message;
      await cdr.save();
    }
  }

  async _endCall(cdr, hangupBy) {
    const endTime = new Date();
    cdr.status = 'completed';
    cdr.endTime = endTime;
    cdr.duration = Math.round((endTime - cdr.startTime) / 1000);
    cdr.talkTime = cdr.answerTime
      ? Math.round((endTime - cdr.answerTime) / 1000)
      : 0;
    cdr.hangupBy = hangupBy;
    cdr.hangupCause = 'normal_clearing';
    await cdr.save();
    logger.info(`CALL ENDED ${cdr.from} -> ${cdr.to} duration=${cdr.talkTime}s`);
  }

  // RTPEngine integration
  async _rtpengineOffer(callId, fromTag, sdp) {
    if (!this.rtpengine) return null;
    try {
      const response = await this.rtpengine.offer(this.rtpengineConfig, {
        'call-id': callId,
        'from-tag': fromTag,
        sdp,
        'record call': 'yes',
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });
      if (response.result === 'ok') return response;
      logger.warn(`RTPEngine offer failed: ${response['error-reason']}`);
      return null;
    } catch (err) {
      logger.warn(`RTPEngine unreachable: ${err.message}`);
      return null;
    }
  }

  async _rtpengineAnswer(callId, fromTag, toTag, sdp) {
    if (!this.rtpengine) return null;
    try {
      const response = await this.rtpengine.answer(this.rtpengineConfig, {
        'call-id': callId,
        'from-tag': fromTag,
        'to-tag': toTag,
        sdp,
        'record call': 'yes',
        'flags': ['trust-address'],
        'replace': ['origin', 'session-connection'],
        'ICE': 'remove'
      });
      if (response.result === 'ok') return response;
      return null;
    } catch (err) {
      logger.warn(`RTPEngine answer error: ${err.message}`);
      return null;
    }
  }

  async _rtpengineDelete(callId, fromTag) {
    if (!this.rtpengine) return;
    try {
      await this.rtpengine.delete(this.rtpengineConfig, {
        'call-id': callId,
        'from-tag': fromTag
      });
    } catch (err) {
      logger.warn(`RTPEngine delete error: ${err.message}`);
    }
  }

  // Get active calls
  getActiveCalls() {
    const calls = [];
    for (const [id, call] of this.activeCalls) {
      calls.push({
        callId: id,
        from: call.fromExt || call.cdr.from,
        to: call.toExt || call.cdr.to,
        duration: Math.round((Date.now() - call.cdr.startTime) / 1000),
        status: call.cdr.status
      });
    }
    return calls;
  }
}

module.exports = CallHandler;
