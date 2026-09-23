#!/usr/bin/env node
// ============================================================
// ShadowPBX — SIP-over-WebSocket probe (Web Dialer Phase 1)
//
// Sends a real REGISTER through the whole browser path
//   nginx (TLS)  ->  Drachtio wss listener  ->  ShadowPBX
// and reports what comes back. No credentials are needed: an
// unauthenticated REGISTER should be answered with 401, which is
// proof the path works end to end.
//
// This catches the one failure that leaves no trace anywhere:
// browsers connect over wss:// so SIP.js writes "Via: SIP/2.0/WSS",
// and sofia-sip silently discards any message whose Via transport
// has no matching listener. The WebSocket connects, the REGISTER
// vanishes, and the browser reports a 408 half a minute later.
//
// Usage (from the app directory):
//   node scripts/wss-register-probe.js                       # uses WSS_URL from .env
//   node scripts/wss-register-probe.js wss://host/ws         # explicit URL
//   node scripts/wss-register-probe.js --direct              # bypass nginx (ws://127.0.0.1:5061)
//   node scripts/wss-register-probe.js --json
//
// Exit 0 when a SIP response comes back, 1 otherwise.
// ============================================================
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

let WebSocket;
try { WebSocket = require('ws'); }
catch (e) { console.error('The "ws" module is missing — run npm install in /opt/shadowpbx'); process.exit(1); }

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[1m', D = '\x1b[2m', N = '\x1b[0m';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const direct = args.includes('--direct');
const urlArg = args.find(a => a.startsWith('ws://') || a.startsWith('wss://'));

const url = urlArg || (direct ? 'ws://127.0.0.1:5061' : process.env.WSS_URL);
const domain = process.env.SIP_DOMAIN || process.env.WEB_DOMAIN || '127.0.0.1';
// Match what a browser sends: WSS over a wss:// connection, WS over ws://
const viaTransport = url && url.startsWith('wss://') ? 'WSS' : 'WS';
const TIMEOUT = 10000;

function done(ok, summary, detail) {
  if (asJson) console.log(JSON.stringify({ ok, url, viaTransport, summary, detail }, null, 2));
  else {
    console.log(`\n${ok ? G + 'PASS' : R + 'FAIL'}${N}  ${summary}`);
    if (detail) console.log(`${D}${detail}${N}`);
    console.log('');
  }
  process.exit(ok ? 0 : 1);
}

if (!url) done(false, 'No WSS URL', 'Set WSS_URL in .env or pass one as an argument.');

if (!asJson) console.log(`\n${B}SIP-over-WebSocket probe${N} ${D}${url}  (Via: SIP/2.0/${viaTransport}, realm ${domain})${N}`);

const ws = new WebSocket(url, 'sip', { rejectUnauthorized: false });
const timer = setTimeout(() => {
  done(false, 'No SIP response within 10s — the REGISTER was swallowed',
    viaTransport === 'WSS'
      ? 'Drachtio has no wss listener, or nginx /ws proxies to the plain ws port (5061).\n' +
        'Fix both with: sudo bash scripts/setup-webrtc.sh --fix-drachtio\n' +
        'nginx /ws should be:  proxy_pass https://127.0.0.1:5062;  plus  proxy_ssl_verify off;'
      : 'Drachtio accepted the WebSocket but is not processing SIP on it — check: docker logs drachtio');
}, TIMEOUT);

ws.on('open', () => {
  if (!asJson) console.log(`${D}WebSocket open, sending REGISTER…${N}`);
  const id = Date.now();
  ws.send([
    `REGISTER sip:${domain} SIP/2.0`,
    `Via: SIP/2.0/${viaTransport} probe.invalid;branch=z9hG4bK${id}`,
    'Max-Forwards: 70',
    `From: <sip:probe@${domain}>;tag=probe${id}`,
    `To: <sip:probe@${domain}>`,
    `Call-ID: shadowpbx-probe-${id}`,
    'CSeq: 1 REGISTER',
    `Contact: <sip:probe@probe.invalid;transport=${viaTransport.toLowerCase()}>`,
    'Expires: 60',
    'Content-Length: 0', '', ''
  ].join('\r\n'));
});

ws.on('message', (data) => {
  clearTimeout(timer);
  const text = data.toString();
  const status = (text.match(/^SIP\/2\.0 (\d{3})/) || [])[1];
  const realm = (text.match(/realm="([^"]+)"/) || [])[1];
  try { ws.close(); } catch (e) {}

  if (status === '401' || status === '403' || status === '404') {
    done(true, `Drachtio and ShadowPBX answered (${status})`,
      realm && realm !== domain
        ? `${Y}Note:${N} the digest realm is "${realm}" but SIP_DOMAIN is "${domain}" — set them to match, or registrations will fail auth.`
        : 'The browser path is working end to end.');
  }
  done(true, `Answered with ${status || 'a SIP message'}`, text.split('\r\n')[0]);
});

ws.on('error', (e) => {
  clearTimeout(timer);
  const m = e.message || String(e);
  let hint = '';
  if (m.includes('502')) hint = 'nginx cannot reach Drachtio — is it listening on 127.0.0.1:5062? (docker logs drachtio)';
  else if (m.includes('404')) hint = 'The /ws location is missing from the nginx server block for this domain.';
  else if (m.includes('ECONNREFUSED')) hint = 'Nothing is listening — Drachtio may be in a restart loop.';
  done(false, `Could not open the WebSocket: ${m}`, hint);
});
