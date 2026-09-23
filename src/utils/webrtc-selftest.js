// ============================================================
// WebRTC bridge self-test (Phase 1)
//
// Pushes synthetic browser / desk-phone SDPs through RTPEngine via
// rtp-helper and checks that each leg comes out in the right shape:
//
//   1. Browser -> Phone : browser offer converted to plain RTP/AVP G.711,
//                         phone answer converted to DTLS-SRTP + ICE
//   2. Phone -> Browser : phone offer converted to UDP/TLS/RTP/SAVPF,
//                         browser answer converted back to RTP/AVP
//   3. Phone -> Phone   : unchanged legacy behaviour (regression guard)
//
// No SIP signalling and no real media — only the ng offer/answer/delete
// commands, each on a throwaway call-id that is deleted afterwards.
// Used by: POST /webrtc/api/selftest, GET /api/webrtc/selftest and
//          scripts/webrtc-selftest.js
// ============================================================

const crypto = require('crypto');
const rtpHelper = require('./rtp-helper');
const sdpUtil = require('./webrtc-sdp');

const CRLF = '\r\n';
const FINGERPRINT = 'sha-256 ' + Array.from({ length: 32 }, (_, i) =>
  ((i * 37 + 11) % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');

function chromeOffer() {
  return [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS selftest',
    'm=audio 54321 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
    'c=IN IP4 203.0.113.10',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0',
    'a=candidate:2 1 udp 1686052607 203.0.113.10 54321 typ srflx raddr 192.168.1.20 rport 54321 generation 0',
    'a=ice-ufrag:sT3x',
    'a=ice-pwd:selftestselftestselftest',
    'a=ice-options:trickle',
    `a=fingerprint:${FINGERPRINT}`,
    'a=setup:actpass',
    'a=mid:0',
    'a=sendrecv',
    'a=msid:selftest track0',
    'a=rtcp-mux',
    'a=rtpmap:111 opus/48000/2',
    'a=rtcp-fb:111 transport-cc',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:63 red/48000/2',
    'a=fmtp:63 111/111',
    'a=rtpmap:9 G722/8000',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:13 CN/8000',
    'a=rtpmap:110 telephone-event/48000',
    'a=rtpmap:126 telephone-event/8000',
    'a=ssrc:1001 cname:selftest'
  ].join(CRLF) + CRLF;
}

function chromeAnswer() {
  return [
    'v=0',
    'o=- 5522731400430051999 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS selftest',
    'm=audio 54322 UDP/TLS/RTP/SAVPF 0 101',
    'c=IN IP4 203.0.113.10',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=candidate:1 1 udp 2122260223 192.168.1.20 54322 typ host generation 0',
    'a=candidate:2 1 udp 1686052607 203.0.113.10 54322 typ srflx raddr 192.168.1.20 rport 54322 generation 0',
    'a=ice-ufrag:aN5w',
    'a=ice-pwd:answeransweransweranswer',
    `a=fingerprint:${FINGERPRINT}`,
    'a=setup:active',
    'a=mid:0',
    'a=sendrecv',
    'a=rtcp-mux',
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=ssrc:2002 cname:selftest'
  ].join(CRLF) + CRLF;
}

function phoneSdp(port) {
  return [
    'v=0',
    'o=phone 1000 1000 IN IP4 198.51.100.20',
    's=Phone',
    'c=IN IP4 198.51.100.20',
    't=0 0',
    `m=audio ${port} RTP/AVP 0 8 101`,
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=rtpmap:101 telephone-event/8000',
    'a=fmtp:101 0-16',
    'a=ptime:20',
    'a=sendrecv'
  ].join(CRLF) + CRLF;
}

function check(results, name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
}

function candidateIps(sdp) {
  const ips = [];
  const re = /^a=candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ/gm;
  let m;
  while ((m = re.exec(sdp || '')) !== null) ips.push(m[1]);
  return ips;
}

function isPrivateIp(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.)/.test(ip || '');
}

function checkPlainLeg(results, label, sdp) {
  const s = sdpUtil.summarize(sdp);
  check(results, `${label}: plain RTP/AVP profile`, s.protocol === 'RTP/AVP' || s.protocol === 'RTP/SAVP', s.protocol);
  check(results, `${label}: ICE removed`, !s.ice, s.ice ? 'ice-ufrag present' : '');
  check(results, `${label}: DTLS removed`, !s.fingerprint, s.fingerprint ? 'fingerprint present' : '');
  check(results, `${label}: G.711 offered`, s.codecs.includes('PCMU') || s.codecs.includes('PCMA'), s.codecs.join(','));
  check(results, `${label}: connection address set`, s.connection && s.connection !== '0.0.0.0', `c=${s.connection}`);
  return s;
}

function checkBrowserLeg(results, label, sdp, expectSetup) {
  const s = sdpUtil.summarize(sdp);
  check(results, `${label}: UDP/TLS/RTP/SAVPF profile`, /SAVPF/.test(s.protocol || ''), s.protocol);
  check(results, `${label}: ICE credentials + candidates`, s.ice && s.candidates > 0, `${s.candidates} candidate(s)`);
  check(results, `${label}: DTLS fingerprint`, s.fingerprint, '');
  if (expectSetup) check(results, `${label}: DTLS role ${expectSetup}`, s.setup === expectSetup, `setup=${s.setup}`);
  check(results, `${label}: rtcp-mux`, s.rtcpMux, '');
  check(results, `${label}: no SDES crypto lines`, !s.crypto, s.crypto ? 'a=crypto present' : '');
  const ips = candidateIps(sdp);
  const publicIps = ips.filter(ip => !isPrivateIp(ip));
  const ext = process.env.EXTERNAL_IP;
  check(results, `${label}: public ICE candidate`, publicIps.length > 0,
    ips.length ? `candidates: ${ips.join(', ')}` : 'none');
  if (ext) check(results, `${label}: candidate matches EXTERNAL_IP`, ips.includes(ext), `EXTERNAL_IP=${ext}`);
  return s;
}

async function scenario(rtpengine, name, fn) {
  const callId = `shadowpbx-selftest-${crypto.randomBytes(6).toString('hex')}`;
  const fromTag = crypto.randomBytes(4).toString('hex');
  const toTag = crypto.randomBytes(4).toString('hex');
  const results = [];
  let error = null;
  try {
    await fn({ callId, fromTag, toTag, results });
  } catch (e) {
    error = e.message;
    check(results, 'no exception', false, e.message);
  } finally {
    await rtpHelper.del(rtpengine, callId, fromTag);
  }
  return { name, callId, ok: !error && results.every(r => r.ok), results };
}

/**
 * Run all scenarios.
 * @param {object} rtpengine - rtpengine-client instance
 * @returns {Promise<{ok:boolean, scenarios:Array, summary:object}>}
 */
async function run(rtpengine) {
  if (!rtpengine) {
    return { ok: false, error: 'RTPEngine client not configured', scenarios: [] };
  }

  const scenarios = [];

  scenarios.push(await scenario(rtpengine, 'Browser -> Phone (web caller to agent)', async ({ callId, fromTag, toTag, results }) => {
    const off = await rtpHelper.offer(rtpengine, callId, fromTag, chromeOffer(), {}, { target: 'sip' });
    check(results, 'offer accepted by RTPEngine', !!off, off ? '' : rtpHelper.webrtcSummary().lastWebrtcError);
    if (!off) return;
    const s = checkPlainLeg(results, 'to phone', off.sdp);
    check(results, 'to phone: Opus/G722/RED stripped', !s.codecs.some(c => ['OPUS', 'G722', 'RED'].includes(c)), s.codecs.join(','));

    const ans = await rtpHelper.answer(rtpengine, callId, fromTag, toTag, phoneSdp(40000));
    check(results, 'answer accepted by RTPEngine', !!ans, ans ? '' : rtpHelper.webrtcSummary().lastWebrtcError);
    if (!ans) return;
    checkBrowserLeg(results, 'to browser', ans.sdp, 'passive');
  }));

  scenarios.push(await scenario(rtpengine, 'Phone -> Browser (agent on web phone)', async ({ callId, fromTag, toTag, results }) => {
    const off = await rtpHelper.offer(rtpengine, callId, fromTag, phoneSdp(40002), {}, { target: 'webrtc' });
    check(results, 'offer accepted by RTPEngine', !!off, off ? '' : rtpHelper.webrtcSummary().lastWebrtcError);
    if (!off) return;
    checkBrowserLeg(results, 'to browser', off.sdp, null);
    check(results, 'to browser: a=mid present', sdpUtil.summarize(off.sdp).mid, '');

    const ans = await rtpHelper.answer(rtpengine, callId, fromTag, toTag, chromeAnswer());
    check(results, 'answer accepted by RTPEngine', !!ans, ans ? '' : rtpHelper.webrtcSummary().lastWebrtcError);
    if (!ans) return;
    checkPlainLeg(results, 'to phone', ans.sdp);
  }));

  scenarios.push(await scenario(rtpengine, 'Phone -> Phone (legacy, must be unchanged)', async ({ callId, fromTag, toTag, results }) => {
    const plan = rtpHelper.planOffer(`${callId}-plan`, phoneSdp(40004), {});
    check(results, 'legacy parameters used', plan.mode === 'legacy', plan.mode);
    await rtpHelper.del(null, `${callId}-plan`);  // forget the dry-run leg record
    const off = await rtpHelper.offer(rtpengine, callId, fromTag, phoneSdp(40004));
    check(results, 'offer accepted by RTPEngine', !!off, '');
    if (!off) return;
    const s = sdpUtil.summarize(off.sdp);
    check(results, 'still RTP/AVP', s.protocol === 'RTP/AVP', s.protocol);
    check(results, 'no ICE / DTLS added', !s.ice && !s.fingerprint, '');
    const ans = await rtpHelper.answer(rtpengine, callId, fromTag, toTag, phoneSdp(40006));
    check(results, 'answer accepted by RTPEngine', !!ans, '');
  }));

  const total = scenarios.reduce((n, sc) => n + sc.results.length, 0);
  const passed = scenarios.reduce((n, sc) => n + sc.results.filter(r => r.ok).length, 0);
  return {
    ok: scenarios.every(sc => sc.ok),
    ranAt: new Date().toISOString(),
    summary: { passed, failed: total - passed, total },
    scenarios
  };
}

module.exports = { run, chromeOffer, chromeAnswer, phoneSdp };
