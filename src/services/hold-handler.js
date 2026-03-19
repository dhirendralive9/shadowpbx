const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const MOH_DIR = process.env.MOH_DIR || '/var/lib/shadowpbx/moh';

class HoldHandler {
  constructor(srf, rtpengine, callHandler) {
    this.srf = srf;
    this.rtpengine = rtpengine;
    this.callHandler = callHandler;
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };
    // Track hold state per call: callId -> { held: boolean, heldBy: 'caller'|'callee', mohPlaying: boolean }
    this.holdState = new Map();

    // Ensure MOH directory exists
    if (!fs.existsSync(MOH_DIR)) {
      try {
        fs.mkdirSync(MOH_DIR, { recursive: true });
        logger.info(`Created MOH directory: ${MOH_DIR}`);
      } catch (e) {
        logger.warn(`Cannot create MOH directory ${MOH_DIR}: ${e.message}`);
      }
    }

    this._logMohFiles();
  }

  _logMohFiles() {
    try {
      if (fs.existsSync(MOH_DIR)) {
        const files = fs.readdirSync(MOH_DIR).filter(f => f.endsWith('.wav') || f.endsWith('.mp3'));
        if (files.length > 0) {
          logger.info(`MOH: ${files.length} file(s) found in ${MOH_DIR}: ${files.join(', ')}`);
        } else {
          logger.warn(`MOH: no .wav/.mp3 files in ${MOH_DIR} — hold will be silent`);
        }
      }
    } catch (e) {}
  }

  // ============================================================
  // Attach re-INVITE (modify) handlers to both dialog legs
  //
  // Drachtio Dialog emits 'modify' when a re-INVITE is received.
  // We intercept it to detect hold/resume SDP direction changes
  // and forward the re-INVITE to the other leg.
  // ============================================================
  attachHoldHandlers(callId, uas, uac, cdr) {
    // Caller side (UAS) sends re-INVITE (hold or resume)
    uas.on('modify', async (req, res) => {
      logger.info(`RE-INVITE from caller leg [${callId}]`);
      await this._handleModify(req, res, callId, uas, uac, cdr, 'caller');
    });

    // Callee side (UAC) sends re-INVITE (hold or resume)
    uac.on('modify', async (req, res) => {
      logger.info(`RE-INVITE from callee leg [${callId}]`);
      await this._handleModify(req, res, callId, uac, uas, cdr, 'callee');
    });
  }

  // ============================================================
  // Handle re-INVITE from one party
  //
  // 1. Detect if this is a hold (sendonly/inactive) or resume (sendrecv)
  // 2. Forward the re-INVITE to the other leg via modify()
  // 3. If hold → start MOH on the held party via RTPEngine
  // 4. If resume → stop MOH
  // 5. Respond to the originator with the other party's answer
  // ============================================================
  async _handleModify(req, res, callId, originatorDialog, otherDialog, cdr, initiatedBy) {
    const sdp = req.body;

    if (!sdp) {
      logger.warn(`RE-INVITE with no SDP [${callId}] — sending 200 OK with current SDP`);
      return res.send(200, { body: originatorDialog.local.sdp });
    }

    const direction = this._detectDirection(sdp);
    const isHold = (direction === 'sendonly' || direction === 'inactive');
    const isResume = (direction === 'sendrecv' && this._isHeld(callId));

    if (isHold) {
      logger.info(`HOLD detected from ${initiatedBy} [${callId}] direction=${direction}`);
    } else if (isResume) {
      logger.info(`RESUME detected from ${initiatedBy} [${callId}]`);
    } else {
      logger.debug(`RE-INVITE passthrough [${callId}] direction=${direction}`);
    }

    try {
      // Forward re-INVITE to the other leg
      await otherDialog.modify(sdp);
      logger.debug(`RE-INVITE forwarded to other leg [${callId}]`);

      // Respond to originator with 200 OK using other leg's SDP
      const responseSdp = otherDialog.remote.sdp;
      res.send(200, {
        body: responseSdp,
        headers: {
          'Content-Type': 'application/sdp'
        }
      });

      // Handle hold/resume state and MOH
      if (isHold) {
        this.holdState.set(callId, { held: true, heldBy: initiatedBy, mohPlaying: false });
        await this._startMoh(callId, cdr, initiatedBy);
      } else if (isResume) {
        await this._stopMoh(callId, cdr);
        this.holdState.delete(callId);
      }

    } catch (err) {
      logger.error(`RE-INVITE handling failed [${callId}]: ${err.message}`);
      try {
        res.send(500);
      } catch (e) {}
    }
  }

  // ============================================================
  // Detect SDP media direction
  // ============================================================
  _detectDirection(sdp) {
    if (!sdp) return 'unknown';
    // Check for direction attributes in the SDP
    // a=sendonly → hold (originator is putting other party on hold)
    // a=inactive → hold (both directions stopped)
    // a=recvonly → other party put us on hold
    // a=sendrecv → normal/resume
    if (sdp.includes('a=inactive')) return 'inactive';
    if (sdp.includes('a=sendonly')) return 'sendonly';
    if (sdp.includes('a=recvonly')) return 'recvonly';
    if (sdp.includes('a=sendrecv')) return 'sendrecv';
    // No explicit direction → default is sendrecv
    return 'sendrecv';
  }

  _isHeld(callId) {
    const state = this.holdState.get(callId);
    return state && state.held;
  }

  // ============================================================
  // Music on Hold via RTPEngine play media
  //
  // When a party is put on hold, we use RTPEngine's "play media"
  // command to inject audio into the held party's RTP stream.
  // The held party hears music instead of silence.
  // ============================================================
  async _startMoh(callId, cdr, heldBy) {
    if (!this.rtpengine) {
      logger.debug(`MOH: no RTPEngine — held party will hear silence`);
      return;
    }

    // Find a MOH file
    const mohFile = this._getMohFile();
    if (!mohFile) {
      logger.debug(`MOH: no MOH files available — held party will hear silence`);
      return;
    }

    // Get the SIP Call-ID and from-tag for the RTPEngine session
    const activeCall = this._findCallBySipCallId(callId);
    if (!activeCall) {
      logger.warn(`MOH: cannot find active call for ${callId}`);
      return;
    }

    const sipCallId = activeCall.cdr.sipCallId;

    try {
      // RTPEngine "play media" command injects audio into the call
      // We play to the party that was NOT the one who pressed hold
      // (i.e., the held party should hear MOH)
      const response = await this.rtpengine.playMedia(this.rtpengineConfig, {
        'call-id': sipCallId,
        'from-tag': this._getFromTag(activeCall, heldBy),
        file: mohFile,
        'repeat-times': 0  // loop forever
      });

      if (response && response.result === 'ok') {
        const state = this.holdState.get(callId);
        if (state) state.mohPlaying = true;
        logger.info(`MOH: playing ${path.basename(mohFile)} for held party [${callId}]`);
      } else {
        logger.warn(`MOH: RTPEngine play media failed: ${JSON.stringify(response)}`);
      }
    } catch (err) {
      logger.warn(`MOH: play media error: ${err.message}`);
    }
  }

  async _stopMoh(callId, cdr) {
    if (!this.rtpengine) return;

    const state = this.holdState.get(callId);
    if (!state || !state.mohPlaying) return;

    const activeCall = this._findCallBySipCallId(callId);
    if (!activeCall) return;

    const sipCallId = activeCall.cdr.sipCallId;

    try {
      const response = await this.rtpengine.stopMedia(this.rtpengineConfig, {
        'call-id': sipCallId,
        'from-tag': this._getFromTag(activeCall, state.heldBy)
      });

      if (response && response.result === 'ok') {
        logger.info(`MOH: stopped [${callId}]`);
      }
    } catch (err) {
      logger.debug(`MOH: stop media error: ${err.message}`);
    }
  }

  // Get the from-tag for the party that should receive MOH
  // If caller holds, the callee is held → play MOH to callee (uac's from-tag)
  // If callee holds, the caller is held → play MOH to caller (uas's from-tag)
  _getFromTag(activeCall, heldBy) {
    // We need the from-tag of the held party (the one hearing MOH)
    // In our B2BUA: uas faces the caller, uac faces the callee
    try {
      if (heldBy === 'caller') {
        // Caller held → callee hears MOH → use caller's from-tag
        // RTPEngine play media uses from-tag to identify which side to play to
        return activeCall.uas.sip.remoteTag || activeCall.uas.sip.localTag;
      } else {
        return activeCall.uac.sip.remoteTag || activeCall.uac.sip.localTag;
      }
    } catch (e) {
      logger.debug(`_getFromTag: cannot extract tag: ${e.message}`);
      return '';
    }
  }

  // Find a MOH audio file
  _getMohFile() {
    try {
      if (!fs.existsSync(MOH_DIR)) return null;
      const files = fs.readdirSync(MOH_DIR).filter(f => f.endsWith('.wav') || f.endsWith('.mp3'));
      if (files.length === 0) return null;
      // Pick a random file if multiple
      const picked = files[Math.floor(Math.random() * files.length)];
      return path.join(MOH_DIR, picked);
    } catch (e) {
      return null;
    }
  }

  // Find active call by SIP Call-ID (used internally for matching)
  _findCallBySipCallId(callId) {
    // callId here is the SIP Call-ID (the key in activeCalls map)
    const call = this.callHandler.activeCalls.get(callId);
    if (call) return call;

    // Also try matching by CDR's callId (UUID)
    for (const [sipId, call] of this.callHandler.activeCalls) {
      if (call.cdr && call.cdr.callId === callId) return call;
    }
    return null;
  }

  // ============================================================
  // API: Hold/Resume
  //
  // These modify the SDP to add sendonly/sendrecv and send a
  // re-INVITE through both legs.
  // ============================================================
  async apiHold(callId) {
    const activeCall = this._findCallByCdrId(callId);
    if (!activeCall) throw new Error('Call not found or not active');

    if (this._isHeld(activeCall.sipCallId)) {
      throw new Error('Call is already on hold');
    }

    const { uas, uac, cdr } = activeCall.call;

    // Put the callee on hold by sending re-INVITE with sendonly to the callee
    const currentSdp = uac.remote.sdp || uac.local.sdp;
    const holdSdp = this._makeSendonly(currentSdp);

    try {
      await uac.modify(holdSdp);
      logger.info(`API HOLD: callee put on hold [${callId}]`);

      // Also re-INVITE caller to sendonly
      const callerSdp = uas.remote.sdp || uas.local.sdp;
      const callerHoldSdp = this._makeSendonly(callerSdp);
      try {
        await uas.modify(callerHoldSdp);
      } catch (e) {
        logger.debug(`API HOLD: caller re-INVITE optional: ${e.message}`);
      }

      this.holdState.set(activeCall.sipCallId, { held: true, heldBy: 'api', mohPlaying: false });
      await this._startMoh(activeCall.sipCallId, cdr, 'caller');

      return { success: true, message: 'Call placed on hold' };
    } catch (err) {
      throw new Error(`Hold failed: ${err.message}`);
    }
  }

  async apiResume(callId) {
    const activeCall = this._findCallByCdrId(callId);
    if (!activeCall) throw new Error('Call not found or not active');

    if (!this._isHeld(activeCall.sipCallId)) {
      throw new Error('Call is not on hold');
    }

    const { uas, uac, cdr } = activeCall.call;

    // Resume by sending re-INVITE with sendrecv
    const currentSdp = uac.remote.sdp || uac.local.sdp;
    const resumeSdp = this._makeSendrecv(currentSdp);

    try {
      await this._stopMoh(activeCall.sipCallId, cdr);

      await uac.modify(resumeSdp);
      logger.info(`API RESUME: callee resumed [${callId}]`);

      // Also re-INVITE caller back to sendrecv
      const callerSdp = uas.remote.sdp || uas.local.sdp;
      const callerResumeSdp = this._makeSendrecv(callerSdp);
      try {
        await uas.modify(callerResumeSdp);
      } catch (e) {
        logger.debug(`API RESUME: caller re-INVITE optional: ${e.message}`);
      }

      this.holdState.delete(activeCall.sipCallId);

      return { success: true, message: 'Call resumed' };
    } catch (err) {
      throw new Error(`Resume failed: ${err.message}`);
    }
  }

  // ============================================================
  // SDP manipulation helpers
  // ============================================================

  // Change SDP direction to sendonly (hold)
  _makeSendonly(sdp) {
    if (!sdp) return sdp;
    let modified = sdp
      .replace(/a=sendrecv/g, 'a=sendonly')
      .replace(/a=recvonly/g, 'a=inactive');
    // If no direction attribute exists, add sendonly
    if (!modified.includes('a=sendonly') && !modified.includes('a=inactive')) {
      modified = modified.replace(/(m=audio[^\r\n]+)/g, '$1\r\na=sendonly');
    }
    return modified;
  }

  // Change SDP direction to sendrecv (resume)
  _makeSendrecv(sdp) {
    if (!sdp) return sdp;
    let modified = sdp
      .replace(/a=sendonly/g, 'a=sendrecv')
      .replace(/a=recvonly/g, 'a=sendrecv')
      .replace(/a=inactive/g, 'a=sendrecv');
    return modified;
  }

  // Find active call by CDR callId (UUID) — returns { sipCallId, call }
  _findCallByCdrId(cdrCallId) {
    for (const [sipCallId, call] of this.callHandler.activeCalls) {
      if (call.cdr && call.cdr.callId === cdrCallId) {
        return { sipCallId, call };
      }
    }
    return null;
  }

  // Cleanup when a call ends
  cleanup(callId) {
    this.holdState.delete(callId);
  }
}

module.exports = HoldHandler;
