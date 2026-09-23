const logger = require('./logger');
const sdpUtil = require('./webrtc-sdp');

// ============================================================
// Centralized RTPEngine Helper
//
// All services call these functions instead of calling rtpengine
// directly. Ensures consistent parameters and makes it trivial
// to enable SRTP across the entire PBX with one env var.
//
// SRTP modes (SRTP_MODE env var) — classic SIP legs only:
//   'off'      — plain RTP only (default, current behavior)
//   'offer'    — offer SRTP via SDES, accept plain RTP fallback
//   'require'  — require SRTP, reject plain RTP
//
// ------------------------------------------------------------
// WebRTC bridging (Phase 1 — WebRTC Web Dialer)
// ------------------------------------------------------------
// Browsers speak ICE + DTLS-SRTP + rtcp-mux (UDP/TLS/RTP/SAVPF).
// Desk phones, softphones and trunks speak plain RTP/AVP.
// RTPEngine bridges the two, but each direction needs its own
// flag set. This helper works out, per call, which side is a
// browser and builds the right parameters automatically:
//
//   output toward a SIP leg    -> RTP/AVP, ICE=remove, DTLS=off,
//                                 rtcp-mux demux, G.711 only
//   output toward a WebRTC leg -> UDP/TLS/RTP/SAVPF, ICE=force,
//                                 DTLS=passive (answers), rtcp-mux,
//                                 generate-mid, SDES off
//
// Calls where NEITHER side is WebRTC get exactly the same
// parameters as before this change (zero behaviour change for
// existing SIP-to-SIP traffic).
//
// Env:
//   WEBRTC_ENABLED=true|false        (default true)
//   WEBRTC_CODEC_POLICY=g711|pcmu|transcode (default g711)
//     g711      — strip Opus/G722/RED toward SIP legs, keep PCMU+PCMA.
//                 No transcoding; recordings keep working.
//     pcmu      — like g711 but PCMU only (matches the recorder,
//                 which decodes mu-law).
//     transcode — let RTPEngine transcode Opus <-> G.711. Needs an
//                 RTPEngine build with transcoding; recordings of the
//                 browser leg may not decode.
//   WEBRTC_DTLS_ANSWER=passive|active (default passive)
// ============================================================

const SRTP_MODE = (process.env.SRTP_MODE || 'off').toLowerCase();
const WEBRTC_ENABLED = String(process.env.WEBRTC_ENABLED || 'true').toLowerCase() !== 'false';
const CODEC_POLICY = (process.env.WEBRTC_CODEC_POLICY || 'g711').toLowerCase();
const DTLS_ANSWER = (process.env.WEBRTC_DTLS_ANSWER || 'passive').toLowerCase();

const WEBRTC_PROTOCOL = 'UDP/TLS/RTP/SAVPF';
const NON_G711_AUDIO = ['opus', 'G722', 'red', 'ISAC', 'ILBC', 'G729', 'CN'];

// Per-call leg memory: callId -> { a: offererType, b: answererType, at }
// type is 'webrtc' | 'sip'
const legs = new Map();
const LEG_TTL_MS = 12 * 60 * 60 * 1000;

const stats = {
  webrtcOffers: 0,
  webrtcAnswers: 0,
  webrtcFailures: 0,
  lastWebrtcError: null,
  lastWebrtcCallId: null,
  lastWebrtcAt: null
};

const sweeper = setInterval(() => {
  const cutoff = Date.now() - LEG_TTL_MS;
  for (const [id, rec] of legs) if (rec.at < cutoff) legs.delete(id);
}, 10 * 60 * 1000);
if (sweeper.unref) sweeper.unref();

function getConfig() {
  return {
    host: process.env.RTPENGINE_HOST || '127.0.0.1',
    port: parseInt(process.env.RTPENGINE_PORT) || 22222
  };
}

/**
 * Build base params for every offer/answer call (classic SIP legs).
 * SRTP flags injected based on SRTP_MODE.
 * UNCHANGED from the pre-WebRTC version — used for SIP<->SIP calls.
 */
function baseParams() {
  const flags = ['trust-address'];
  const params = {
    'replace': ['origin', 'session-connection'],
    'ICE': 'remove'
  };

  if (SRTP_MODE === 'offer') {
    // Offer SRTP via SDES — if peer supports it, use SRTP; otherwise fall back to RTP
    flags.push('generate-SRTP');
  } else if (SRTP_MODE === 'require') {
    // Force SRTP — reject endpoints that don't support SDES
    flags.push('SRTP-required', 'generate-SRTP');
  }

  params['flags'] = flags;
  return params;
}

/**
 * Codec rules applied when a browser's offer is sent on to a SIP leg.
 */
function codecParamsTowardSip(browserSdp) {
  const offered = sdpUtil.audioCodecs(browserSdp);
  const hasPCMU = offered.includes('PCMU');
  const hasPCMA = offered.includes('PCMA');

  if (CODEC_POLICY === 'transcode') {
    return { transcode: ['PCMU', 'PCMA'] };
  }

  if (CODEC_POLICY === 'pcmu') {
    if (hasPCMU) return { strip: [...NON_G711_AUDIO, 'PCMA'] };
    return { mask: NON_G711_AUDIO.filter(c => c !== 'CN'), transcode: ['PCMU'] };
  }

  // default: g711
  if (hasPCMU || hasPCMA) return { strip: NON_G711_AUDIO };
  // Browser offered no G.711 at all (unusual) — fall back to transcoding
  return { mask: NON_G711_AUDIO.filter(c => c !== 'CN'), transcode: ['PCMU', 'PCMA'] };
}

/**
 * Params for SDP that RTPEngine will hand to a classic SIP endpoint
 * when the other side of the call is a browser.
 */
function sipLegParams({ codecFromSdp } = {}) {
  const params = {
    'replace': ['origin', 'session-connection'],
    'flags': ['trust-address'],
    'transport-protocol': SRTP_MODE === 'require' ? 'RTP/SAVP' : 'RTP/AVP',
    'ICE': 'remove',
    'DTLS': 'off',
    'rtcp-mux': ['demux']
  };
  if (codecFromSdp) params.codec = codecParamsTowardSip(codecFromSdp);
  return params;
}

/**
 * Params for SDP that RTPEngine will hand to a browser.
 * @param {'offer'|'answer'} direction
 */
function webrtcLegParams(direction) {
  const params = {
    'replace': ['origin', 'session-connection'],
    'flags': ['trust-address', 'generate-mid'],
    'transport-protocol': WEBRTC_PROTOCOL,
    'ICE': 'force',
    'rtcp-mux': ['require'],
    'SDES': ['off']
  };
  // In an answer toward a browser (browser offered setup:actpass) RTPEngine
  // takes the DTLS server role. In an offer toward a browser we leave the
  // default (actpass) and let the browser choose.
  if (direction === 'answer') params['DTLS'] = DTLS_ANSWER === 'active' ? 'active' : 'passive';
  return params;
}

function typeOf(sdp) {
  return sdpUtil.isWebRTCSdp(sdp) ? 'webrtc' : 'sip';
}

function normType(t) {
  if (!t) return null;
  const v = String(t).toLowerCase();
  if (v === 'webrtc' || v === 'ws' || v === 'wss' || v === 'browser') return 'webrtc';
  if (v === 'sip' || v === 'rtp' || v === 'plain') return 'sip';
  return null;
}

/**
 * Decide the parameters for an OFFER.
 * sender = whoever produced `sdp`; target = who receives RTPEngine's output.
 */
function planOffer(callId, sdp, opts) {
  const sender = typeOf(sdp);
  const hinted = normType(opts && opts.target);
  const rec = legs.get(callId);

  let target;
  if (hinted) target = hinted;
  else if (rec) target = (sender === rec.a) ? rec.b : rec.a;   // re-INVITE: route to the other side
  else target = 'sip';

  if (!rec) legs.set(callId, { a: sender, b: target, at: Date.now() });
  else rec.at = Date.now();

  if (!WEBRTC_ENABLED || (sender === 'sip' && target === 'sip')) {
    return { mode: 'legacy', sender, target, params: baseParams() };
  }
  if (target === 'sip') {
    return { mode: 'webrtc', sender, target, params: sipLegParams({ codecFromSdp: sender === 'webrtc' ? sdp : null }) };
  }
  return { mode: 'webrtc', sender, target, params: webrtcLegParams('offer') };
}

/**
 * Decide the parameters for an ANSWER.
 * answerer = whoever produced `sdp`; output goes back to the offerer.
 */
function planAnswer(callId, sdp, opts) {
  const answerer = typeOf(sdp);
  const hinted = normType(opts && opts.offerer);
  const rec = legs.get(callId);

  let offerer;
  if (hinted) offerer = hinted;
  else if (rec) offerer = (answerer === rec.b) ? rec.a : rec.b;
  else offerer = answerer === 'webrtc' ? 'sip' : null;   // unknown -> legacy

  if (rec) rec.at = Date.now();

  if (!WEBRTC_ENABLED || !offerer || (answerer === 'sip' && offerer === 'sip')) {
    return { mode: 'legacy', answerer, offerer, params: baseParams() };
  }
  if (offerer === 'sip') {
    return { mode: 'webrtc', answerer, offerer, params: sipLegParams() };
  }
  return { mode: 'webrtc', answerer, offerer, params: webrtcLegParams('answer') };
}

function noteWebrtc(kind, callId, ok, err) {
  if (ok) {
    stats[kind === 'offer' ? 'webrtcOffers' : 'webrtcAnswers']++;
    stats.lastWebrtcCallId = callId;
    stats.lastWebrtcAt = new Date().toISOString();
  } else {
    stats.webrtcFailures++;
    stats.lastWebrtcError = `${kind} ${callId}: ${err || 'unknown error'}`;
  }
}

/**
 * RTPEngine offer.
 * @param {object} rtpengine - rtpengine-client instance
 * @param {string} callId - SIP Call-ID
 * @param {string} fromTag - SIP From-tag
 * @param {string} sdp - SDP body
 * @param {object} [extra] - Additional params (e.g. { 'record call': 'yes' })
 * @param {object} [opts] - { target: 'webrtc'|'sip' } — media type of the
 *                          endpoint that will RECEIVE this offer. Omit to
 *                          auto-detect (defaults to a SIP endpoint).
 * @returns {object|null}
 */
async function offer(rtpengine, callId, fromTag, sdp, extra, opts) {
  if (!rtpengine) return null;
  const plan = planOffer(callId, sdp, opts);
  try {
    const params = { ...plan.params, 'call-id': callId, 'from-tag': fromTag, sdp, ...(extra || {}) };
    const response = await rtpengine.offer(getConfig(), params);
    const ok = response && response.result === 'ok';
    if (plan.mode === 'webrtc') {
      noteWebrtc('offer', callId, ok, ok ? null : (response && (response['error-reason'] || response.result)));
      if (ok) logger.info(`WEBRTC offer ${plan.sender}->${plan.target} [${callId}] out: ${sdpUtil.summaryLine(response.sdp)}`);
      else logger.warn(`WEBRTC offer failed ${plan.sender}->${plan.target} [${callId}]: ${response && (response['error-reason'] || response.result)}`);
    }
    return ok ? response : null;
  } catch (err) {
    if (plan.mode === 'webrtc') {
      noteWebrtc('offer', callId, false, err.message);
      logger.warn(`WEBRTC offer error [${callId}]: ${err.message}`);
    } else {
      logger.debug(`RTPEngine offer failed: ${err.message}`);
    }
    return null;
  }
}

/**
 * RTPEngine answer.
 * @param {object} [opts] - { offerer: 'webrtc'|'sip' } — media type of the
 *                          endpoint that made the offer (receives this answer).
 *                          Omit to use what was learned at offer time.
 */
async function answer(rtpengine, callId, fromTag, toTag, sdp, extra, opts) {
  if (!rtpengine) return null;
  const plan = planAnswer(callId, sdp, opts);
  try {
    const params = { ...plan.params, 'call-id': callId, 'from-tag': fromTag, 'to-tag': toTag, sdp, ...(extra || {}) };
    const response = await rtpengine.answer(getConfig(), params);
    const ok = response && response.result === 'ok';
    if (plan.mode === 'webrtc') {
      noteWebrtc('answer', callId, ok, ok ? null : (response && (response['error-reason'] || response.result)));
      if (ok) logger.info(`WEBRTC answer ${plan.answerer}->${plan.offerer} [${callId}] out: ${sdpUtil.summaryLine(response.sdp)}`);
      else logger.warn(`WEBRTC answer failed ${plan.answerer}->${plan.offerer} [${callId}]: ${response && (response['error-reason'] || response.result)}`);
    }
    return ok ? response : null;
  } catch (err) {
    if (plan.mode === 'webrtc') {
      noteWebrtc('answer', callId, false, err.message);
      logger.warn(`WEBRTC answer error [${callId}]: ${err.message}`);
    } else {
      logger.debug(`RTPEngine answer failed: ${err.message}`);
    }
    return null;
  }
}

/**
 * RTPEngine delete session.
 */
async function del(rtpengine, callId, fromTag) {
  legs.delete(callId);
  if (!rtpengine) return;
  try { await rtpengine.delete(getConfig(), { 'call-id': callId, 'from-tag': fromTag }); } catch (e) {}
}

/**
 * Explicitly declare the media type of each side of a call
 * (e.g. when the target is known to be a browser before the offer).
 */
function setLegTypes(callId, { offerer, answerer } = {}) {
  const a = normType(offerer), b = normType(answerer);
  const rec = legs.get(callId) || { a: 'sip', b: 'sip', at: Date.now() };
  if (a) rec.a = a;
  if (b) rec.b = b;
  rec.at = Date.now();
  legs.set(callId, rec);
}

function getLegTypes(callId) {
  const rec = legs.get(callId);
  return rec ? { offerer: rec.a, answerer: rec.b } : null;
}

function isWebRTCCall(callId) {
  const rec = legs.get(callId);
  return !!rec && (rec.a === 'webrtc' || rec.b === 'webrtc');
}

function webrtcSummary() {
  let activeWebrtc = 0;
  for (const [, rec] of legs) if (rec.a === 'webrtc' || rec.b === 'webrtc') activeWebrtc++;
  return {
    enabled: WEBRTC_ENABLED,
    codecPolicy: CODEC_POLICY,
    dtlsAnswerRole: DTLS_ANSWER === 'active' ? 'active' : 'passive',
    browserProtocol: WEBRTC_PROTOCOL,
    trackedCalls: legs.size,
    trackedWebrtcCalls: activeWebrtc,
    ...stats
  };
}

function logMode() {
  if (SRTP_MODE === 'off') logger.info('Media encryption: disabled (plain RTP)');
  else if (SRTP_MODE === 'offer') logger.info('Media encryption: SRTP offered (SDES with plain RTP fallback)');
  else if (SRTP_MODE === 'require') logger.info('Media encryption: SRTP required (SDES, no fallback)');
  if (WEBRTC_ENABLED) {
    logger.info(`WebRTC bridging: enabled (browser legs ${WEBRTC_PROTOCOL} + ICE + DTLS-${DTLS_ANSWER}, codec policy=${CODEC_POLICY})`);
  } else {
    logger.info('WebRTC bridging: disabled (WEBRTC_ENABLED=false)');
  }
}

module.exports = {
  offer, answer, del, getConfig, baseParams, logMode, SRTP_MODE,
  // WebRTC (Phase 1)
  planOffer, planAnswer, setLegTypes, getLegTypes, isWebRTCCall, webrtcSummary,
  sipLegParams, webrtcLegParams, WEBRTC_ENABLED
};
