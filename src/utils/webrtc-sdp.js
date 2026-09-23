// ============================================================
// WebRTC SDP / transport inspection helpers
//
// Pure functions (no I/O) used by rtp-helper, the registrar and
// the call-handler to decide whether a leg is a WebRTC endpoint
// (browser: ICE + DTLS-SRTP + rtcp-mux) or a classic SIP endpoint
// (desk phone / softphone / trunk: plain RTP/AVP).
// ============================================================

/**
 * Pull the first audio m= line protocol, e.g. "UDP/TLS/RTP/SAVPF".
 */
function audioProtocol(sdp) {
  if (!sdp || typeof sdp !== 'string') return null;
  const m = sdp.match(/^m=audio\s+\d+(?:\/\d+)?\s+(\S+)/m);
  return m ? m[1] : null;
}

/**
 * True when the SDP was produced by a WebRTC stack.
 * Browsers always use a SAVPF profile, DTLS fingerprints and ICE.
 * We require the SAVPF profile OR (fingerprint AND ice-ufrag) so
 * that SDES-SRTP desk phones (RTP/SAVP, no ICE) are NOT misdetected.
 */
function isWebRTCSdp(sdp) {
  if (!sdp || typeof sdp !== 'string') return false;
  const proto = audioProtocol(sdp) || '';
  if (/SAVPF/i.test(proto)) return true;
  const hasFingerprint = /^a=fingerprint:/m.test(sdp);
  const hasIce = /^a=ice-ufrag:/m.test(sdp);
  return hasFingerprint && hasIce;
}

/**
 * Codec names offered on the audio m= line, upper-cased, in order.
 */
function audioCodecs(sdp) {
  if (!sdp || typeof sdp !== 'string') return [];
  const mline = sdp.match(/^m=audio\s+\d+(?:\/\d+)?\s+\S+\s+([\d\s]+)$/m);
  if (!mline) return [];
  const pts = mline[1].trim().split(/\s+/);
  const names = {};
  const re = /^a=rtpmap:(\d+)\s+([^/\s]+)/gm;
  let r;
  while ((r = re.exec(sdp)) !== null) names[r[1]] = r[2].toUpperCase();
  // Static payload types when no rtpmap is present
  const statics = { '0': 'PCMU', '8': 'PCMA', '9': 'G722', '18': 'G729', '13': 'CN' };
  return pts.map(pt => names[pt] || statics[pt] || `PT${pt}`);
}

/**
 * Compact description of an SDP — used for logs and diagnostics.
 */
function summarize(sdp) {
  if (!sdp || typeof sdp !== 'string') return { present: false };
  const setup = (sdp.match(/^a=setup:(\S+)/m) || [])[1] || null;
  const conn = (sdp.match(/^c=IN IP[46]\s+(\S+)/m) || [])[1] || null;
  const port = (sdp.match(/^m=audio\s+(\d+)/m) || [])[1] || null;
  return {
    present: true,
    webrtc: isWebRTCSdp(sdp),
    protocol: audioProtocol(sdp),
    codecs: audioCodecs(sdp),
    connection: conn,
    port: port ? parseInt(port, 10) : null,
    ice: /^a=ice-ufrag:/m.test(sdp),
    candidates: (sdp.match(/^a=candidate:/gm) || []).length,
    fingerprint: /^a=fingerprint:/m.test(sdp),
    setup,
    rtcpMux: /^a=rtcp-mux\b/m.test(sdp),
    crypto: /^a=crypto:/m.test(sdp),
    mid: /^a=mid:/m.test(sdp)
  };
}

function summaryLine(sdp) {
  const s = summarize(sdp);
  if (!s.present) return 'no-sdp';
  return `${s.webrtc ? 'WebRTC' : 'SIP'} proto=${s.protocol} codecs=${s.codecs.join(',')} ` +
    `ice=${s.ice ? s.candidates + 'cand' : 'no'} dtls=${s.fingerprint ? (s.setup || 'yes') : 'no'} ` +
    `mux=${s.rtcpMux ? 'yes' : 'no'} c=${s.connection}:${s.port}`;
}

/**
 * Normalise a transport string: 'udp' | 'tcp' | 'tls' | 'ws' | 'wss'.
 */
function normalizeTransport(t) {
  if (!t) return null;
  const v = String(t).toLowerCase().trim();
  return ['udp', 'tcp', 'tls', 'ws', 'wss'].includes(v) ? v : null;
}

function isWebSocketTransport(t) {
  const v = normalizeTransport(t);
  return v === 'ws' || v === 'wss';
}

/**
 * Work out which transport a SIP request arrived on.
 * drachtio-srf exposes req.protocol; fall back to the top Via.
 */
function requestTransport(req) {
  if (!req) return null;
  const direct = normalizeTransport(req.protocol);
  if (direct) return direct;
  try {
    const via = (req.get && req.get('Via')) || '';
    const m = String(via).match(/SIP\/2\.0\/(UDP|TCP|TLS|WSS|WS)\b/i);
    if (m) return m[1].toLowerCase();
  } catch (e) {}
  return null;
}

/**
 * Transport declared inside a Contact header / URI (";transport=ws").
 */
function contactTransport(contact) {
  if (!contact) return null;
  const m = String(contact).match(/;transport=([a-z]+)/i);
  return m ? normalizeTransport(m[1]) : null;
}

function isLoopback(ip) {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip.startsWith('127.') || ip === '::1' || ip === '::ffff:127.0.0.1';
}

module.exports = {
  audioProtocol,
  isWebRTCSdp,
  audioCodecs,
  summarize,
  summaryLine,
  normalizeTransport,
  isWebSocketTransport,
  requestTransport,
  contactTransport,
  isLoopback
};
