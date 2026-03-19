const { RingGroup } = require('../models');
const logger = require('../utils/logger');

// Park slot range: 70-79 (dialed as *70-*79 to park, or 70-79 to pickup)
const PARK_SLOT_MIN = parseInt(process.env.PARK_SLOT_MIN) || 70;
const PARK_SLOT_MAX = parseInt(process.env.PARK_SLOT_MAX) || 79;
// Star code prefix for parking via transfer
const PARK_PREFIX = process.env.PARK_PREFIX || '*';

class ParkHandler {
  constructor(srf, registrar, callHandler, holdHandler) {
    this.srf = srf;
    this.registrar = registrar;
    this.callHandler = callHandler;
    this.holdHandler = holdHandler;

    // slot -> { sipCallId, uas, uac, cdr, parkedBy, parkedAt, mohStarted, ringGroupMembers }
    this.parkedCalls = new Map();
  }

  // ============================================================
  // Detection helpers
  // ============================================================

  // Check if a dialed number is a park slot pickup (e.g. "70")
  isParkSlot(number) {
    const n = parseInt(number);
    return !isNaN(n) && n >= PARK_SLOT_MIN && n <= PARK_SLOT_MAX;
  }

  // Check if a transfer target is a park code (e.g. "*70" or "*7")
  // Returns the slot number or null
  parseParkCode(target) {
    if (!target) return null;
    // Match *70, *71, ... *79
    const match = target.match(/^\*(\d{1,2})$/);
    if (!match) return null;

    const num = parseInt(match[1]);
    if (num >= PARK_SLOT_MIN && num <= PARK_SLOT_MAX) {
      return String(num);
    }

    // Also support just *7 → auto-assign to first empty slot
    if (match[1] === '7' || match[1] === String(PARK_SLOT_MIN).charAt(0)) {
      return this._findEmptySlot();
    }

    return null;
  }

  // ============================================================
  // Park via SIP transfer (softphone presses Transfer, dials *70)
  //
  // Called from transfer-handler when it detects a park code
  // in the Refer-To target.
  // ============================================================
  async parkViaTransfer(callId, transferorDialog, otherDialog, cdr, slotNum, transferorExt) {
    if (!slotNum) {
      slotNum = this._findEmptySlot();
      if (!slotNum) {
        logger.warn(`PARK: no empty slots available`);
        return false;
      }
    }

    if (this.parkedCalls.has(slotNum)) {
      logger.warn(`PARK: slot ${slotNum} already occupied`);
      return false;
    }

    logger.info(`PARK VIA TRANSFER: ${transferorExt} parking call in slot ${slotNum} [${callId}]`);

    // Find which ring group this extension belongs to (for pickup restriction)
    const ringGroupMembers = await this._findRingGroupMembers(transferorExt);

    // Put the other party (the caller being parked) on hold
    try {
      const callerSdp = otherDialog.remote.sdp || otherDialog.local.sdp;
      const holdSdp = this._makeSendonly(callerSdp);
      await otherDialog.modify(holdSdp);
    } catch (err) {
      logger.warn(`PARK: hold re-INVITE failed: ${err.message}`);
    }

    // Remove old destroy listeners
    otherDialog.removeAllListeners('destroy');
    transferorDialog.removeAllListeners('destroy');

    // BYE the transferor (they pressed transfer — they're done)
    try {
      transferorDialog.destroy();
    } catch (e) {}

    // Store in park slot
    this.parkedCalls.set(slotNum, {
      sipCallId: callId,
      uas: otherDialog,  // the parked party (caller)
      uac: null,
      cdr,
      parkedBy: transferorExt,
      parkedAt: new Date(),
      mohStarted: false,
      ringGroupMembers  // only these extensions can pick up
    });

    // If parked party hangs up, free the slot
    otherDialog.on('destroy', () => {
      logger.info(`PARK: parked caller hung up in slot ${slotNum}`);
      this.parkedCalls.delete(slotNum);
      this.callHandler.activeCalls.delete(callId);
      this._endParkedCall(cdr, 'caller');
    });

    // Remove from active calls
    this.callHandler.activeCalls.delete(callId);

    // Start MOH
    await this._startParkedMoh(slotNum);

    // Update CDR
    cdr.parkedSlot = slotNum;
    cdr.parkedBy = transferorExt;
    cdr.parkedAt = new Date();
    await cdr.save();

    logger.info(`PARK COMPLETE: slot ${slotNum} by ${transferorExt}, caller ${cdr.from} hearing MOH. Pickup restricted to: ${ringGroupMembers.length > 0 ? ringGroupMembers.join(',') : 'anyone'}`);
    return true;
  }

  // ============================================================
  // Pickup via SIP dial (extension dials 70-79)
  //
  // Called from call-handler when toExt matches a park slot.
  // Checks ring group membership before allowing pickup.
  // ============================================================
  async handlePickupDial(req, res, fromExt, slot, callId) {
    const slotNum = String(slot);
    const parked = this.parkedCalls.get(slotNum);

    if (!parked) {
      logger.warn(`PARK PICKUP: slot ${slotNum} is empty — dialed by ${fromExt}`);
      return res.send(404);
    }

    // Check ring group restriction
    if (!this._canPickup(fromExt, parked)) {
      logger.warn(`PARK PICKUP DENIED: ${fromExt} is not in the same ring group as ${parked.parkedBy} for slot ${slotNum}`);
      return res.send(403);
    }

    logger.info(`PARK PICKUP: ${fromExt} picking up slot ${slotNum} [parked by ${parked.parkedBy}]`);

    try {
      // Stop MOH
      await this._stopParkedMoh(slotNum, parked);

      const callerDialog = parked.uas;
      if (!callerDialog) {
        logger.error(`PARK PICKUP: no caller dialog for slot ${slotNum}`);
        this.parkedCalls.delete(slotNum);
        return res.send(410);
      }

      // Get caller's SDP
      const callerSdp = callerDialog.local.sdp || callerDialog.remote.sdp;

      // Answer the picker's INVITE
      const pickerDialog = await this.srf.createUAS(req, res, {
        localSdp: callerSdp
      });

      logger.info(`PARK PICKUP: ${fromExt} connected`);

      // Resume caller with picker's SDP
      const resumeSdp = this._makeSendrecv(pickerDialog.remote.sdp);
      try {
        await callerDialog.modify(resumeSdp);
        logger.info(`PARK PICKUP: caller re-INVITE successful`);
      } catch (modErr) {
        logger.warn(`PARK PICKUP: caller re-INVITE failed: ${modErr.message}`);
      }

      // Re-INVITE picker with caller's updated SDP
      try {
        await pickerDialog.modify(callerDialog.remote.sdp);
        logger.info(`PARK PICKUP: picker re-INVITE successful`);
      } catch (modErr) {
        logger.warn(`PARK PICKUP: picker re-INVITE failed: ${modErr.message}`);
      }

      // Wire up new pair
      callerDialog.removeAllListeners('destroy');
      const cdr = parked.cdr;
      const sipCallId = parked.sipCallId;

      callerDialog.on('destroy', () => {
        pickerDialog.destroy();
        this._endParkedCall(cdr, 'caller');
        this.callHandler.activeCalls.delete(sipCallId);
      });
      pickerDialog.on('destroy', () => {
        callerDialog.destroy();
        this._endParkedCall(cdr, 'callee');
        this.callHandler.activeCalls.delete(sipCallId);
      });

      // Track as active call
      this.callHandler.activeCalls.set(sipCallId, {
        uas: callerDialog,
        uac: pickerDialog,
        cdr,
        fromExt: cdr.from,
        toExt: fromExt
      });

      // Attach handlers
      if (this.callHandler.transferHandler) {
        this.callHandler.transferHandler.attachReferHandlers(sipCallId, callerDialog, pickerDialog, cdr);
      }
      if (this.callHandler.holdHandler) {
        this.callHandler.holdHandler.attachHoldHandlers(sipCallId, callerDialog, pickerDialog, cdr);
      }

      // Update CDR
      cdr.to = fromExt;
      cdr.pickedUpBy = fromExt;
      cdr.pickedUpAt = new Date();
      await cdr.save();

      this.parkedCalls.delete(slotNum);
      logger.info(`PARK PICKUP COMPLETE: slot ${slotNum} -> ${fromExt}, caller ${cdr.from} connected`);

    } catch (err) {
      logger.error(`PARK PICKUP FAILED: ${err.message}`);
      if (!res.finalResponseSent) res.send(500);
    }
  }

  // ============================================================
  // API: Park
  // ============================================================
  async apiPark(cdrCallId, slot) {
    const slotNum = String(slot || this._findEmptySlot());
    if (!slotNum) throw new Error('No empty park slots available');

    const slotInt = parseInt(slotNum);
    if (isNaN(slotInt) || slotInt < PARK_SLOT_MIN || slotInt > PARK_SLOT_MAX) {
      throw new Error(`Invalid slot ${slotNum} — must be ${PARK_SLOT_MIN}-${PARK_SLOT_MAX}`);
    }
    if (this.parkedCalls.has(slotNum)) throw new Error(`Slot ${slotNum} is already occupied`);

    const activeCall = this._findCallByCdrId(cdrCallId);
    if (!activeCall) throw new Error('Call not found or not active');

    const { sipCallId, call } = activeCall;
    const { uas, uac, cdr } = call;
    const parkedBy = call.toExt || cdr.to;

    // Find ring group members for pickup restriction
    const ringGroupMembers = await this._findRingGroupMembers(parkedBy);

    logger.info(`API PARK: slot ${slotNum} by ${parkedBy}`);

    // Hold the caller
    try {
      const holdSdp = this._makeSendonly(uas.remote.sdp || uas.local.sdp);
      await uas.modify(holdSdp);
    } catch (err) {
      logger.warn(`API PARK: hold failed: ${err.message}`);
    }

    uas.removeAllListeners('destroy');
    uac.removeAllListeners('destroy');

    // BYE the extension
    try { uac.destroy(); } catch (e) {}

    this.parkedCalls.set(slotNum, {
      sipCallId,
      uas,
      uac: null,
      cdr,
      parkedBy,
      parkedAt: new Date(),
      mohStarted: false,
      ringGroupMembers
    });

    uas.on('destroy', () => {
      logger.info(`PARK: parked caller hung up in slot ${slotNum}`);
      this.parkedCalls.delete(slotNum);
      this.callHandler.activeCalls.delete(sipCallId);
      this._endParkedCall(cdr, 'caller');
    });

    this.callHandler.activeCalls.delete(sipCallId);
    await this._startParkedMoh(slotNum);

    cdr.parkedSlot = slotNum;
    cdr.parkedBy = parkedBy;
    cdr.parkedAt = new Date();
    await cdr.save();

    logger.info(`API PARK COMPLETE: slot ${slotNum}, pickup restricted to: ${ringGroupMembers.length > 0 ? ringGroupMembers.join(',') : 'anyone'}`);

    return {
      success: true,
      slot: slotNum,
      message: `Call parked in slot ${slotNum}`,
      parkedBy,
      from: cdr.from,
      pickupAllowed: ringGroupMembers.length > 0 ? ringGroupMembers : 'anyone'
    };
  }

  // ============================================================
  // API: Pickup
  // ============================================================
  async apiPickup(slot, extension) {
    const slotNum = String(slot);
    const parked = this.parkedCalls.get(slotNum);

    if (!parked) throw new Error(`Slot ${slotNum} is empty`);
    if (!extension) throw new Error('extension required');

    // Check ring group restriction
    if (!this._canPickup(extension, parked)) {
      throw new Error(`Extension ${extension} is not authorized to pick up slot ${slotNum} — not in the same ring group`);
    }

    logger.info(`API PICKUP: slot ${slotNum} -> ${extension}`);

    await this._stopParkedMoh(slotNum, parked);

    const contacts = await this.registrar.getContacts(extension);
    if (contacts.length === 0) throw new Error(`Extension ${extension} is not registered`);

    const contact = contacts[0];
    const targetUri = `sip:${extension}@${contact.ip}:${contact.port}`;
    const callerDialog = parked.uas;

    if (!callerDialog) {
      this.parkedCalls.delete(slotNum);
      throw new Error('Parked caller dialog no longer available');
    }

    try {
      const callerSdp = callerDialog.local.sdp || callerDialog.remote.sdp;

      const pickerUac = await this.srf.createUAC(targetUri, {
        localSdp: callerSdp,
        callingNumber: parked.cdr.from
      });

      logger.info(`API PICKUP: ${extension} answered`);

      // Resume caller
      const resumeSdp = this._makeSendrecv(pickerUac.remote.sdp);
      try { await callerDialog.modify(resumeSdp); } catch (e) {
        logger.warn(`API PICKUP: caller re-INVITE: ${e.message}`);
      }

      // Update picker with caller's SDP
      try { await pickerUac.modify(callerDialog.remote.sdp); } catch (e) {
        logger.warn(`API PICKUP: picker re-INVITE: ${e.message}`);
      }

      callerDialog.removeAllListeners('destroy');

      const cdr = parked.cdr;
      const sipCallId = parked.sipCallId;

      callerDialog.on('destroy', () => {
        pickerUac.destroy();
        this._endParkedCall(cdr, 'caller');
        this.callHandler.activeCalls.delete(sipCallId);
      });
      pickerUac.on('destroy', () => {
        callerDialog.destroy();
        this._endParkedCall(cdr, 'callee');
        this.callHandler.activeCalls.delete(sipCallId);
      });

      this.callHandler.activeCalls.set(sipCallId, {
        uas: callerDialog, uac: pickerUac, cdr,
        fromExt: cdr.from, toExt: extension
      });

      if (this.callHandler.transferHandler) {
        this.callHandler.transferHandler.attachReferHandlers(sipCallId, callerDialog, pickerUac, cdr);
      }
      if (this.callHandler.holdHandler) {
        this.callHandler.holdHandler.attachHoldHandlers(sipCallId, callerDialog, pickerUac, cdr);
      }

      cdr.to = extension;
      cdr.pickedUpBy = extension;
      cdr.pickedUpAt = new Date();
      await cdr.save();

      this.parkedCalls.delete(slotNum);
      logger.info(`API PICKUP COMPLETE: slot ${slotNum} -> ${extension}`);

      return { success: true, slot: slotNum, extension, message: `Picked up by ${extension}` };

    } catch (err) {
      throw new Error(`Pickup failed: ${err.message}`);
    }
  }

  // ============================================================
  // List parked calls
  // ============================================================
  getParkedCalls() {
    const calls = [];
    for (const [slot, parked] of this.parkedCalls) {
      calls.push({
        slot,
        from: parked.cdr ? parked.cdr.from : 'unknown',
        parkedBy: parked.parkedBy,
        parkedAt: parked.parkedAt,
        duration: Math.round((Date.now() - parked.parkedAt.getTime()) / 1000),
        pickupAllowed: parked.ringGroupMembers.length > 0 ? parked.ringGroupMembers : 'anyone'
      });
    }
    return calls;
  }

  // ============================================================
  // Ring group membership check
  //
  // Find all ring groups that the parking extension belongs to,
  // collect all members. Only those members can pick up.
  // If the extension is not in any ring group, anyone can pick up.
  // ============================================================
  async _findRingGroupMembers(extension) {
    try {
      const groups = await RingGroup.find({
        members: extension,
        enabled: true
      });

      if (groups.length === 0) return []; // no ring group = anyone can pickup

      // Collect all unique members from all matching ring groups
      const members = new Set();
      for (const group of groups) {
        for (const m of group.members) {
          members.add(m);
        }
      }
      return Array.from(members);
    } catch (err) {
      logger.warn(`Ring group lookup failed: ${err.message}`);
      return [];
    }
  }

  // Can this extension pick up this parked call?
  _canPickup(extension, parked) {
    // No restriction = anyone can pick up
    if (!parked.ringGroupMembers || parked.ringGroupMembers.length === 0) {
      return true;
    }
    // Must be a member of the same ring group
    return parked.ringGroupMembers.includes(extension);
  }

  // ============================================================
  // MOH for parked calls (reuses holdHandler's RTPEngine)
  // ============================================================
  async _startParkedMoh(slotNum) {
    if (!this.holdHandler) return;

    const parked = this.parkedCalls.get(slotNum);
    if (!parked || !parked.uas) return;

    const mohFile = this.holdHandler._getMohFile();
    if (!mohFile) return;

    const rtpengine = this.holdHandler.rtpengine;
    if (!rtpengine) return;

    try {
      let fromTag = '';
      try { fromTag = parked.uas.sip.remoteTag || parked.uas.sip.localTag || ''; } catch (e) {}

      const response = await rtpengine.playMedia(this.holdHandler.rtpengineConfig, {
        'call-id': parked.cdr.sipCallId,
        'from-tag': fromTag,
        file: mohFile,
        'repeat-times': 0
      });

      if (response && response.result === 'ok') {
        parked.mohStarted = true;
        logger.info(`PARK MOH: playing for slot ${slotNum}`);
      }
    } catch (err) {
      logger.warn(`PARK MOH: error: ${err.message}`);
    }
  }

  async _stopParkedMoh(slotNum, parked) {
    if (!this.holdHandler || !parked.mohStarted) return;

    const rtpengine = this.holdHandler.rtpengine;
    if (!rtpengine) return;

    try {
      let fromTag = '';
      try { fromTag = parked.uas.sip.remoteTag || parked.uas.sip.localTag || ''; } catch (e) {}

      await rtpengine.stopMedia(this.holdHandler.rtpengineConfig, {
        'call-id': parked.cdr.sipCallId,
        'from-tag': fromTag
      });
      parked.mohStarted = false;
      logger.info(`PARK MOH: stopped for slot ${slotNum}`);
    } catch (err) {
      logger.debug(`PARK MOH stop: ${err.message}`);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================
  _findEmptySlot() {
    for (let i = PARK_SLOT_MIN; i <= PARK_SLOT_MAX; i++) {
      if (!this.parkedCalls.has(String(i))) return String(i);
    }
    return null;
  }

  _findCallByCdrId(cdrCallId) {
    for (const [sipCallId, call] of this.callHandler.activeCalls) {
      if (call.cdr && call.cdr.callId === cdrCallId) return { sipCallId, call };
    }
    return null;
  }

  _makeSendonly(sdp) {
    if (!sdp) return sdp;
    let m = sdp.replace(/a=sendrecv/g, 'a=sendonly').replace(/a=recvonly/g, 'a=inactive');
    if (!m.includes('a=sendonly') && !m.includes('a=inactive')) {
      m = m.replace(/(m=audio[^\r\n]+)/g, '$1\r\na=sendonly');
    }
    return m;
  }

  _makeSendrecv(sdp) {
    if (!sdp) return sdp;
    return sdp.replace(/a=sendonly/g, 'a=sendrecv').replace(/a=recvonly/g, 'a=sendrecv').replace(/a=inactive/g, 'a=sendrecv');
  }

  async _endParkedCall(cdr, hangupBy) {
    cdr.status = 'completed';
    cdr.endTime = new Date();
    cdr.duration = Math.round((cdr.endTime - cdr.startTime) / 1000);
    cdr.talkTime = cdr.answerTime ? Math.round((cdr.endTime - cdr.answerTime) / 1000) : 0;
    cdr.hangupBy = hangupBy;
    cdr.hangupCause = 'normal_clearing';
    await cdr.save();
    logger.info(`PARKED CALL ENDED ${cdr.from} -> ${cdr.to} duration=${cdr.talkTime}s`);
  }
}

module.exports = ParkHandler;
