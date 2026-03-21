const dgram = require('dgram');
const logger = require('../utils/logger');
const { v4: uuidv4 } = require('uuid');

// ============================================================
// MonitorHandler — Listen / Whisper / Barge
//
// RTPEngine v12+ with 'subscribe request' support.
//
// The rtpengine-client npm package doesn't have subscribe methods,
// so we send the ng command directly via UDP bencode.
//
// Flow:
//   1. Send 'subscribe request' to RTPEngine with the active call's
//      SIP call-id (from UAS dialog) + 'all' flag
//   2. RTPEngine returns an offer SDP with forked audio
//   3. Call supervisor's softphone with that SDP
//   4. Send 'subscribe answer' with supervisor's answer SDP
//   5. Supervisor receives mixed audio from both call legs
// ============================================================

class MonitorHandler {
  constructor(srf, rtpengine, callHandler, registrar) {
    this.srf = srf;
    this.rtpengine = rtpengine;
    this.callHandler = callHandler;
    this.registrar = registrar;
    this.ngHost = process.env.RTPENGINE_HOST || '127.0.0.1';
    this.ngPort = parseInt(process.env.RTPENGINE_PORT) || 22222;
    this.monitors = new Map();
    this._cookie = 0;
  }

  // ============================================================
  // Send raw ng protocol command via UDP
  // RTPEngine ng protocol: cookie<space>bencode_dict
  // ============================================================
  _sendNg(command, params) {
    return new Promise((resolve, reject) => {
      const cookie = `spbx_${++this._cookie}`;
      const bencode = this._bencode({ command, ...params });
      const msg = `${cookie} ${bencode}`;

      const client = dgram.createSocket('udp4');
      const timer = setTimeout(() => {
        client.close();
        reject(new Error('RTPEngine ng timeout'));
      }, 5000);

      client.on('message', (data) => {
        clearTimeout(timer);
        const str = data.toString();
        // Response format: cookie<space>bencode_dict
        const spaceIdx = str.indexOf(' ');
        if (spaceIdx > 0) {
          const respBencode = str.substring(spaceIdx + 1);
          const parsed = this._bdecode(respBencode);
          client.close();
          resolve(parsed);
        } else {
          client.close();
          reject(new Error('Invalid ng response'));
        }
      });

      client.on('error', (err) => {
        clearTimeout(timer);
        client.close();
        reject(err);
      });

      client.send(msg, this.ngPort, this.ngHost);
    });
  }

  // ============================================================
  // Bencode encoder (dict only, supports strings and integers)
  // ============================================================
  _bencode(obj) {
    if (typeof obj === 'string') return `${obj.length}:${obj}`;
    if (typeof obj === 'number') return `i${Math.floor(obj)}e`;
    if (Array.isArray(obj)) return 'l' + obj.map(v => this._bencode(v)).join('') + 'e';
    if (typeof obj === 'object' && obj !== null) {
      let s = 'd';
      for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        s += this._bencode(k) + this._bencode(v);
      }
      return s + 'e';
    }
    return `${String(obj).length}:${String(obj)}`;
  }

  // ============================================================
  // Bencode decoder (basic — handles strings, ints, lists, dicts)
  // ============================================================
  _bdecode(str) {
    let pos = 0;

    function decode() {
      if (pos >= str.length) return null;
      const ch = str[pos];

      if (ch === 'd') {
        pos++;
        const dict = {};
        while (pos < str.length && str[pos] !== 'e') {
          const key = decode();
          const val = decode();
          if (key !== null) dict[key] = val;
        }
        pos++; // skip 'e'
        return dict;
      }
      if (ch === 'l') {
        pos++;
        const list = [];
        while (pos < str.length && str[pos] !== 'e') {
          list.push(decode());
        }
        pos++;
        return list;
      }
      if (ch === 'i') {
        pos++;
        const end = str.indexOf('e', pos);
        const num = parseInt(str.substring(pos, end));
        pos = end + 1;
        return num;
      }
      // String: length:data
      const colonIdx = str.indexOf(':', pos);
      if (colonIdx < 0) { pos = str.length; return null; }
      const len = parseInt(str.substring(pos, colonIdx));
      pos = colonIdx + 1;
      const s = str.substring(pos, pos + len);
      pos += len;
      return s;
    }

    return decode();
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
    const { uas, uac, cdr } = activeCall;

    // Get the B2BUA's actual SIP call-id from the dialog
    // The B2BUA creates new SIP dialogs with their own call-ids
    // We need to find ALL possible call-ids
    const uasCallId = uas.sip ? uas.sip.callId : null;
    const uacCallId = uac.sip ? uac.sip.callId : null;

    // Also try to get call-id from other dialog properties
    const uasCallId2 = uas.callId || null;
    const uacCallId2 = uac.callId || null;

    // Try dialog.meta or dialog.req for stored call-id
    const uasMeta = (uas.req && uas.req.get) ? uas.req.get('Call-Id') : null;
    const uacMeta = (uac.req && uac.req.get) ? uac.req.get('Call-Id') : null;

    // Collect all unique call-ids to try
    const allCallIds = new Set();
    [uasCallId, uacCallId, uasCallId2, uacCallId2, uasMeta, uacMeta, sipCallId].forEach(id => {
      if (id) allCallIds.add(id);
    });

    // CRITICAL: Look up RTPEngine call-id
    // The ring group now stores it on the dialog objects
    if (uas._rtpCallId) {
      allCallIds.add(uas._rtpCallId);
      logger.info(`MONITOR: found RTPEngine call-id from UAS dialog: ${uas._rtpCallId}`);
    }
    if (uac._rtpCallId) {
      allCallIds.add(uac._rtpCallId);
      logger.info(`MONITOR: found RTPEngine call-id from UAC dialog: ${uac._rtpCallId}`);
    }

    // Also check the callIdMap from wrapped rtpengine client
    if (this.rtpengine && this.rtpengine.callIdMap) {
      const map = this.rtpengine.callIdMap;
      const uasLocalTag = uas.sip ? uas.sip.localTag : null;
      const uasRemoteTag = uas.sip ? uas.sip.remoteTag : null;
      const uacLocalTag = uac.sip ? uac.sip.localTag : null;
      const uacRemoteTag = uac.sip ? uac.sip.remoteTag : null;

      for (const tag of [uasLocalTag, uasRemoteTag, uacLocalTag, uacRemoteTag]) {
        if (tag && map.has(tag)) {
          const rtpId = map.get(tag);
          allCallIds.add(rtpId);
          logger.info(`MONITOR: found RTPEngine call-id via tag map ${tag}: ${rtpId}`);
        }
      }
    }

    // Fallback: query RTPEngine for active sessions
    try {
      const listResp = await this._sendNg('list', { limit: 32 });
      if (listResp && listResp.calls) {
        const calls = Array.isArray(listResp.calls) ? listResp.calls : [];
        logger.info(`MONITOR: RTPEngine has ${calls.length} active session(s)`);
        for (const rtpCid of calls) {
          if (rtpCid && !allCallIds.has(rtpCid) && !rtpCid.startsWith('spbx-mon-') && !rtpCid.startsWith('mon-')) {
            allCallIds.add(rtpCid);
          }
        }
      }
    } catch (e) {
      logger.debug(`MONITOR: RTPEngine list failed: ${e.message}`);
    }

    logger.info(`MONITOR: ${mode} on [${sipCallId}] supervisor=${supervisorExt}`);
    logger.info(`MONITOR: candidate call-ids: ${[...allCallIds].join(', ')}`);

    // Also dump all dialog properties that might contain the call-id
    try {
      const uasKeys = Object.keys(uas.sip || {}).filter(k => k.toLowerCase().includes('call') || k.toLowerCase().includes('id'));
      const uacKeys = Object.keys(uac.sip || {}).filter(k => k.toLowerCase().includes('call') || k.toLowerCase().includes('id'));
      if (uasKeys.length) logger.debug(`MONITOR: UAS sip keys with 'call/id': ${uasKeys.join(', ')} = ${uasKeys.map(k => uas.sip[k]).join(', ')}`);
      if (uacKeys.length) logger.debug(`MONITOR: UAC sip keys with 'call/id': ${uacKeys.join(', ')} = ${uacKeys.map(k => uac.sip[k]).join(', ')}`);
    } catch (e) {}

    try {
      // Step 1: Send subscribe request to RTPEngine
      // Try with both call-ids — one of them will match
      let subscribeResp = null;
      let usedCallId = null;

      for (const tryCallId of allCallIds) {
        try {
          logger.info(`MONITOR: trying subscribe request with call-id=${tryCallId}`);
          subscribeResp = await this._sendNg('subscribe request', {
            'call-id': tryCallId,
            flags: ['all']
          });

          if (subscribeResp && subscribeResp.sdp) {
            usedCallId = tryCallId;
            logger.info(`MONITOR: subscribe request OK with call-id=${tryCallId}`);
            break;
          } else if (subscribeResp && subscribeResp.result === 'error') {
            logger.debug(`MONITOR: subscribe failed for ${tryCallId}: ${subscribeResp['error-reason'] || 'unknown'}`);
            subscribeResp = null;
          }
        } catch (e) {
          logger.debug(`MONITOR: subscribe attempt failed for ${tryCallId}: ${e.message}`);
        }
      }

      if (!subscribeResp || !subscribeResp.sdp) {
        throw new Error('Subscribe request failed — no matching RTPEngine session found');
      }

      const subscribeTag = subscribeResp['to-tag'] || subscribeResp['tag'] || monitorId;
      logger.info(`MONITOR: got subscribe SDP, to-tag=${subscribeTag}`);

      // Fix SDP direction: subscribe returns sendonly/recvonly which makes
      // the softphone show "on hold". Change to sendrecv.
      let offerSdp = subscribeResp.sdp;
      offerSdp = offerSdp
        .replace(/a=sendonly/g, 'a=sendrecv')
        .replace(/a=recvonly/g, 'a=sendrecv')
        .replace(/a=inactive/g, 'a=sendrecv');

      // Step 2: Call supervisor's softphone with the fixed SDP
      const supervisorDialog = await this.srf.createUAC(supervisorUri, {
        localSdp: offerSdp,
        headers: {
          'Alert-Info': '<http://www.notused.com>;info=alert-autoanswer',
          'Call-Info': '<sip:monitor>;answer-after=0',
          'X-Monitor-Mode': mode
        }
      });

      logger.info(`MONITOR: supervisor ${supervisorExt} answered`);

      // Step 3: Send subscribe answer with supervisor's SDP
      const answerResp = await this._sendNg('subscribe answer', {
        'call-id': usedCallId,
        'to-tag': subscribeTag,
        sdp: supervisorDialog.remote.sdp,
        flags: ['trust-address', 'allow-transcoding'],
        replace: ['origin', 'session-connection'],
        ICE: 'remove'
      });

      if (answerResp && answerResp.result === 'ok') {
        logger.info(`MONITOR: subscribe answer OK — media forking active`);
      } else {
        logger.warn(`MONITOR: subscribe answer response: ${JSON.stringify(answerResp)}`);
      }

      // Step 4: For listen mode, block supervisor's outgoing audio
      if (mode === 'listen') {
        try {
          await this._sendNg('block media', {
            'call-id': usedCallId,
            'from-tag': subscribeTag
          });
          logger.info(`MONITOR: supervisor audio blocked (listen mode)`);
        } catch (e) {
          logger.debug(`MONITOR: block media failed: ${e.message}`);
        }
      }

      // Track session
      const session = {
        monitorId, usedCallId, subscribeTag,
        sipCallId, supervisorExt, supervisorDialog, mode,
        startTime: new Date(), cdr
      };
      this.monitors.set(monitorId, session);

      // Cleanup handlers
      supervisorDialog.on('destroy', () => {
        logger.info(`MONITOR: supervisor disconnected [${monitorId}]`);
        this._cleanup(monitorId);
      });

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
      try { await this._sendNg('block media', { 'call-id': session.usedCallId, 'from-tag': session.subscribeTag }); } catch (e) {}
    } else {
      try { await this._sendNg('unblock media', { 'call-id': session.usedCallId, 'from-tag': session.subscribeTag }); } catch (e) {}
    }

    session.mode = newMode;
    return { monitorId, mode: newMode, supervisorExt: session.supervisorExt, targetCallId: session.sipCallId };
  }

  // ============================================================
  // Stop / cleanup
  // ============================================================
  async stopMonitor(monitorId) { this._cleanup(monitorId); }

  _cleanup(monitorId) {
    const session = this.monitors.get(monitorId);
    if (!session) return;

    try { session.supervisorDialog.destroy(); } catch (e) {}

    // Unsubscribe from RTPEngine
    try {
      this._sendNg('unsubscribe', {
        'call-id': session.usedCallId,
        'to-tag': session.subscribeTag
      }).catch(() => {});
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
}

module.exports = MonitorHandler;
