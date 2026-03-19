const { Extension, CDR } = require('../models');
const logger = require('../utils/logger');

let transferFn = null;
try {
  const sugar = require('drachtio-fn-b2b-sugar');
  transferFn = sugar.transfer;
  logger.info('drachtio-fn-b2b-sugar: transfer function loaded');
} catch (err) {
  logger.warn(`drachtio-fn-b2b-sugar transfer not available: ${err.message}`);
}

class TransferHandler {
  constructor(srf, registrar, callHandler, trunkManager, callRouter) {
    this.srf = srf;
    this.registrar = registrar;
    this.callHandler = callHandler;
    this.trunkManager = trunkManager;
    this.callRouter = callRouter;
  }

  // ============================================================
  // Attach REFER handlers to both dialogs in a B2BUA pair
  //
  // Called from call-handler._trackCall after every successful
  // call setup. Listens for SIP REFER on both the UAS (caller-
  // facing) and UAC (callee-facing) dialog so either party can
  // initiate a transfer from their softphone.
  // ============================================================
  attachReferHandlers(callId, uas, uac, cdr) {
    // Caller side (UAS) sends REFER — they want to transfer the callee
    uas.on('refer', async (req, res) => {
      logger.info(`REFER received on caller leg [${callId}]`);
      await this._handleRefer(req, res, callId, uas, uac, cdr, 'caller');
    });

    // Callee side (UAC) sends REFER — they want to transfer the caller
    uac.on('refer', async (req, res) => {
      logger.info(`REFER received on callee leg [${callId}]`);
      await this._handleRefer(req, res, callId, uac, uas, cdr, 'callee');
    });
  }

  // ============================================================
  // Handle SIP REFER from a softphone (blind transfer)
  //
  // Flow:
  //   1. Softphone sends REFER with Refer-To header
  //   2. We accept with 202 Accepted
  //   3. We INVITE the transfer target
  //   4. If target answers, bridge media, BYE the transferor
  //   5. Send NOTIFY to transferor with result
  //   6. Update CDR
  // ============================================================
  async _handleRefer(req, res, callId, transferorDialog, otherDialog, cdr, initiatedBy) {
    const referTo = req.get('Refer-To');
    if (!referTo) {
      logger.warn(`REFER rejected: no Refer-To header [${callId}]`);
      return res.send(400);
    }

    // Parse target from Refer-To: <sip:2003@domain> or <sip:*70@domain>
    const targetMatch = referTo.match(/<sip:([^@>]+)@/);
    if (!targetMatch) {
      logger.warn(`REFER rejected: cannot parse Refer-To: ${referTo} [${callId}]`);
      return res.send(400);
    }

    const target = targetMatch[1].replace(/^\+/, '');
    const transferorExt = initiatedBy === 'caller' ? cdr.from : cdr.to;

    // Check if this is a park code (*70-*79)
    const parkHandler = this.callHandler.parkHandler;
    if (parkHandler) {
      const parkSlot = parkHandler.parseParkCode(target);
      if (parkSlot) {
        logger.info(`PARK VIA REFER: ${transferorExt} parking to slot ${parkSlot} [${callId}]`);
        res.send(202);
        this._sendNotify(transferorDialog, 'SIP/2.0 100 Trying');

        const success = await parkHandler.parkViaTransfer(callId, transferorDialog, otherDialog, cdr, parkSlot, transferorExt);
        if (success) {
          this._sendNotify(transferorDialog, 'SIP/2.0 200 OK');
        } else {
          this._sendNotify(transferorDialog, 'SIP/2.0 503 Service Unavailable');
        }
        return;
      }
    }

    // Check for Replaces header (attended transfer)
    const replacesHeader = req.get('Replaces') || '';
    const isAttended = replacesHeader.length > 0;

    logger.info(`TRANSFER ${isAttended ? 'ATTENDED' : 'BLIND'}: ${transferorExt} transferring to ${target} [${callId}]`);

    // Accept the REFER
    res.send(202);

    // Send initial NOTIFY (100 Trying)
    this._sendNotify(transferorDialog, 'SIP/2.0 100 Trying');

    if (isAttended) {
      await this._handleAttendedTransfer(callId, transferorDialog, otherDialog, cdr, target, replacesHeader, transferorExt);
    } else {
      await this._handleBlindTransfer(callId, transferorDialog, otherDialog, cdr, target, transferorExt);
    }
  }

  // ============================================================
  // BLIND TRANSFER
  //
  // Media bridging strategy:
  //   1. Get caller's current SDP (what they're sending RTP to)
  //   2. INVITE new target with caller's SDP as the offer
  //   3. New target answers with their SDP
  //   4. Re-INVITE caller with new target's SDP
  //   5. Now caller<->new target RTP flows directly
  //   6. BYE the old extension (transferor)
  // ============================================================
  async _handleBlindTransfer(callId, transferorDialog, otherDialog, cdr, target, transferorExt) {
    try {
      // Resolve target to a SIP URI
      const targetUri = await this._resolveTarget(target);
      if (!targetUri) {
        logger.warn(`BLIND TRANSFER: target ${target} not reachable`);
        this._sendNotify(transferorDialog, 'SIP/2.0 486 Busy Here');
        return;
      }

      logger.info(`BLIND TRANSFER: dialing ${target} at ${targetUri}`);

      // Step 1: Get the caller's local SDP (what the PBX offered to the caller)
      // This is what the caller is currently sending their RTP to
      const callerLocalSdp = otherDialog.local.sdp;
      const callerRemoteSdp = otherDialog.remote.sdp;

      logger.debug(`BLIND TRANSFER: caller local SDP available: ${!!callerLocalSdp}`);
      logger.debug(`BLIND TRANSFER: caller remote SDP available: ${!!callerRemoteSdp}`);

      // Step 2: INVITE new target with the transferor's local SDP
      // This way the new target's RTP will be set up to match the existing media path
      const transferorLocalSdp = transferorDialog.local.sdp;

      const newUac = await this.srf.createUAC(targetUri, {
        localSdp: transferorLocalSdp || callerLocalSdp,
        callingNumber: cdr.from
      });

      logger.info(`BLIND TRANSFER: ${target} answered`);

      // Notify transferor of success before we disconnect them
      this._sendNotify(transferorDialog, 'SIP/2.0 200 OK');

      // Step 3: Re-INVITE the caller (otherDialog) with the new target's SDP
      // This makes the caller send their RTP to the new target's address
      const newTargetSdp = newUac.remote.sdp;

      try {
        await otherDialog.modify(newTargetSdp);
        logger.info(`BLIND TRANSFER: caller re-INVITE successful — media path updated`);
      } catch (modErr) {
        logger.warn(`BLIND TRANSFER: caller re-INVITE failed: ${modErr.message}`);
      }

      // Step 4: Re-INVITE the new target with the caller's updated SDP
      // This ensures bidirectional RTP flow
      try {
        const updatedCallerSdp = otherDialog.remote.sdp;
        await newUac.modify(updatedCallerSdp);
        logger.info(`BLIND TRANSFER: target re-INVITE successful — bidirectional media established`);
      } catch (modErr) {
        logger.warn(`BLIND TRANSFER: target re-INVITE failed: ${modErr.message}`);
      }

      // Step 5: BYE the transferor (they're done)
      try {
        transferorDialog.destroy();
      } catch (e) {}

      // Remove old event listeners to avoid double-cleanup
      otherDialog.removeAllListeners('destroy');
      newUac.removeAllListeners('destroy');

      // Wire up the new call pair
      const activeCall = this.callHandler.activeCalls.get(callId);

      otherDialog.on('destroy', () => {
        newUac.destroy();
        this._endTransferredCall(cdr, 'caller');
        this.callHandler.activeCalls.delete(callId);
      });
      newUac.on('destroy', () => {
        otherDialog.destroy();
        this._endTransferredCall(cdr, 'callee');
        this.callHandler.activeCalls.delete(callId);
      });

      // Attach REFER handlers on the new pair for chain transfers
      if (this.callHandler.transferHandler) {
        this.callHandler.transferHandler.attachReferHandlers(callId, otherDialog, newUac, cdr);
      }

      // Update active call tracking
      if (activeCall) {
        activeCall.uas = otherDialog;
        activeCall.uac = newUac;
        activeCall.toExt = target;
      }

      // Update CDR
      cdr.transferredBy = transferorExt;
      cdr.transferredTo = target;
      cdr.transferType = 'blind';
      cdr.transferTime = new Date();
      await cdr.save();

      logger.info(`BLIND TRANSFER COMPLETE: ${cdr.from} now connected to ${target} [${callId}]`);

    } catch (err) {
      logger.error(`BLIND TRANSFER FAILED: ${err.message} (status=${err.status || 'N/A'})`);
      this._sendNotify(transferorDialog, `SIP/2.0 ${err.status || 503} ${err.reason || 'Service Unavailable'}`);
    }
  }

  // ============================================================
  // ATTENDED TRANSFER
  //
  // The transferor has already spoken to the target (via a
  // consultation call). The REFER includes a Replaces header
  // that identifies the consultation call. We bridge the two
  // existing call legs together.
  //
  //   Call 1: Caller <--uas1-- PBX --uac1--> Ext2001 (transferor)
  //   Call 2: Ext2001 <--uas2-- PBX --uac2--> Ext2003 (target)
  //   REFER from 2001 on Call 1 with Replaces=Call2
  //   Result: Caller <--> Ext2003, 2001 drops out
  // ============================================================
  async _handleAttendedTransfer(callId, transferorDialog, otherDialog, cdr, target, replacesHeader, transferorExt) {
    try {
      // Parse the Replaces header to find the consultation call
      // Format: callid;to-tag=xxx;from-tag=yyy
      const replacesCallId = replacesHeader.split(';')[0];

      logger.info(`ATTENDED TRANSFER: looking for consultation call ${replacesCallId}`);

      // Find the consultation call in active calls
      let consultCall = null;
      let consultDialog = null;

      for (const [id, call] of this.callHandler.activeCalls) {
        if (!call.uas || !call.uac) continue;
        // Check if either dialog matches the Replaces Call-ID
        if (call.uas.sip && call.uas.sip.callId === replacesCallId) {
          consultCall = call;
          consultDialog = call.uac; // The other end of the consultation
          break;
        }
        if (call.uac.sip && call.uac.sip.callId === replacesCallId) {
          consultCall = call;
          consultDialog = call.uas;
          break;
        }
      }

      if (!consultCall || !consultDialog) {
        logger.warn(`ATTENDED TRANSFER: consultation call not found for ${replacesCallId}`);
        this._sendNotify(transferorDialog, 'SIP/2.0 481 Call Does Not Exist');
        return;
      }

      logger.info(`ATTENDED TRANSFER: found consultation call, bridging parties`);

      // Notify success
      this._sendNotify(transferorDialog, 'SIP/2.0 200 OK');

      // Re-INVITE other party with consultation target's SDP
      try {
        await otherDialog.modify(consultDialog.remote.sdp);
      } catch (modErr) {
        logger.warn(`ATTENDED TRANSFER: re-INVITE failed: ${modErr.message}`);
      }

      // Re-INVITE consultation target with other party's SDP
      try {
        await consultDialog.modify(otherDialog.remote.sdp);
      } catch (modErr) {
        logger.warn(`ATTENDED TRANSFER: reverse re-INVITE failed: ${modErr.message}`);
      }

      // BYE both transferor legs
      try { transferorDialog.destroy(); } catch (e) {}
      // Find and destroy the other leg of the consultation call that faces the transferor
      for (const [id, call] of this.callHandler.activeCalls) {
        if (call === consultCall) {
          if (call.uas === consultDialog) {
            try { call.uac.destroy(); } catch (e) {}
          } else {
            try { call.uas.destroy(); } catch (e) {}
          }
          this.callHandler.activeCalls.delete(id);
          break;
        }
      }

      // Clean up old listeners
      otherDialog.removeAllListeners('destroy');
      consultDialog.removeAllListeners('destroy');

      // Wire up new pair
      otherDialog.on('destroy', () => {
        consultDialog.destroy();
        this._endTransferredCall(cdr, 'caller');
        this.callHandler.activeCalls.delete(callId);
      });
      consultDialog.on('destroy', () => {
        otherDialog.destroy();
        this._endTransferredCall(cdr, 'callee');
        this.callHandler.activeCalls.delete(callId);
      });

      // Update active call
      const activeCall = this.callHandler.activeCalls.get(callId);
      if (activeCall) {
        activeCall.uas = otherDialog;
        activeCall.uac = consultDialog;
        activeCall.toExt = target;
      }

      // Update CDR
      cdr.transferredBy = transferorExt;
      cdr.transferredTo = target;
      cdr.transferType = 'attended';
      cdr.transferTime = new Date();
      await cdr.save();

      logger.info(`ATTENDED TRANSFER COMPLETE: ${cdr.from} now connected to ${target} [${callId}]`);

    } catch (err) {
      logger.error(`ATTENDED TRANSFER FAILED: ${err.message}`);
      this._sendNotify(transferorDialog, 'SIP/2.0 500 Server Error');
    }
  }

  // ============================================================
  // API TRANSFER - POST /api/calls/:callId/transfer
  //
  // Allows external systems to trigger a transfer via REST API
  // ============================================================
  async apiTransfer(callId, target, type = 'blind') {
    const activeCall = this._findCallByCdrId(callId);
    if (!activeCall) {
      throw new Error('Call not found or not active');
    }

    const { uas, uac, cdr } = activeCall.call;

    if (type === 'blind') {
      logger.info(`API BLIND TRANSFER: ${callId} -> ${target}`);
      // API transfer: keep the caller (uas), drop current callee (uac)
      // transferorDialog = uac (the one being replaced/dropped)
      // otherDialog = uas (the caller who stays connected)
      await this._handleBlindTransfer(
        activeCall.sipCallId, uac, uas, cdr, target, 'api'
      );
      return { success: true, message: `Call transferred to ${target}` };
    }

    throw new Error('API attended transfer not supported — use softphone REFER');
  }

  // ============================================================
  // Helpers
  // ============================================================

  // Resolve a target (extension number or external number) to a SIP URI
  async _resolveTarget(target) {
    // Check if it's an internal extension
    const ext = await Extension.findOne({ extension: target, enabled: true });
    if (ext) {
      const contacts = await this.registrar.getContacts(target);
      if (contacts.length > 0) {
        const contact = contacts[0]; // Already sorted newest-first by registrar
        return `sip:${target}@${contact.ip}:${contact.port}`;
      }
      logger.warn(`TRANSFER: extension ${target} exists but not registered`);
      return null;
    }

    // Check if it's an external number — find an outbound route
    if (this.callRouter) {
      const route = await this.callRouter.findOutboundRoute(target);
      if (route) {
        const trunk = this.trunkManager.getTrunk(route.trunk);
        if (trunk) {
          const processed = this.callRouter.processOutboundNumber(target, route);
          return `sip:${processed}@${trunk.host}:${trunk.port || 5060}`;
        }
      }
    }

    logger.warn(`TRANSFER: no route found for target ${target}`);
    return null;
  }

  // Send SIP NOTIFY to inform transferor of transfer progress
  _sendNotify(dialog, sipFrag) {
    try {
      dialog.request({
        method: 'NOTIFY',
        headers: {
          'Event': 'refer',
          'Subscription-State': sipFrag.includes('200') ? 'terminated;reason=noresource' : 'active',
          'Content-Type': 'message/sipfrag'
        },
        body: sipFrag
      });
    } catch (err) {
      logger.debug(`NOTIFY send failed: ${err.message}`);
    }
  }

  // Find active call by CDR callId (UUID)
  _findCallByCdrId(cdrCallId) {
    for (const [sipCallId, call] of this.callHandler.activeCalls) {
      if (call.cdr && call.cdr.callId === cdrCallId) {
        return { sipCallId, call };
      }
    }
    return null;
  }

  // End a transferred call
  async _endTransferredCall(cdr, hangupBy) {
    const endTime = new Date();
    cdr.status = 'completed';
    cdr.endTime = endTime;
    cdr.duration = Math.round((endTime - cdr.startTime) / 1000);
    cdr.talkTime = cdr.answerTime ? Math.round((endTime - cdr.answerTime) / 1000) : 0;
    cdr.hangupBy = hangupBy;
    cdr.hangupCause = 'normal_clearing';
    await cdr.save();
    logger.info(`TRANSFERRED CALL ENDED ${cdr.from} -> ${cdr.to} duration=${cdr.talkTime}s`);
  }
}

module.exports = TransferHandler;
