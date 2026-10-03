#!/usr/bin/env node
'use strict';
/**
 * Phase-2 spike — can we get clean, decodable audio out of a live call?
 *
 * This is the experiment the whole interpreter rests on. It does NOT touch
 * call handling: it asks RTPEngine for a copy of one party's RTP, terminates
 * that copy in a plain UDP socket here, depacketises it, decodes G.711 to
 * 16-bit PCM and writes a WAV. If the WAV is intelligible, the media path for
 * the interpreter is proven. If it is not, nothing downstream is worth
 * building yet.
 *
 * It also reports jitter/loss and the real packet cadence, which is what the
 * STT stream will actually be fed.
 *
 *   node scripts/interpreter-tap-spike.js                 # tap the newest live call
 *   node scripts/interpreter-tap-spike.js --list          # just list live calls
 *   node scripts/interpreter-tap-spike.js --call <id>     # tap a specific call-id
 *   node scripts/interpreter-tap-spike.js --seconds 20    # capture length (default 15)
 *
 * Writes /tmp/tap-<callid>.wav  (8 kHz, mono, 16-bit PCM)
 */
const dgram = require('dgram');
const fs = require('fs');
const os = require('os');
const path = require('path');

const NG_HOST = process.env.RTPENGINE_HOST || '127.0.0.1';
const NG_PORT = parseInt(process.env.RTPENGINE_PORT || '22222', 10);
const EXTERNAL_IP = process.env.EXTERNAL_IP || '';
const SECONDS = parseInt(argOf('--seconds') || '15', 10);
const WANT_CALL = argOf('--call');
const WANT_TAG = argOf('--tag');          // subscribe to ONE leg by its SIP tag
const USE_ALL = process.argv.includes('--all'); // mixed both-party tap (diagnostic)
const LIST_ONLY = process.argv.includes('--list');

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : null;
}

// ── bencode (same wire format monitor-handler uses) ─────────────────────
function bencode(obj) {
  if (typeof obj === 'number') return 'i' + obj + 'e';
  if (typeof obj === 'string') return obj.length + ':' + obj;
  if (Array.isArray(obj)) return 'l' + obj.map(bencode).join('') + 'e';
  if (obj && typeof obj === 'object') {
    let s = 'd';
    for (const k of Object.keys(obj)) s += bencode(k) + bencode(obj[k]);
    return s + 'e';
  }
  return '0:';
}
function bdecode(str) {
  let i = 0;
  function val() {
    const c = str[i];
    if (c === 'i') { const e = str.indexOf('e', i); const n = parseInt(str.slice(i + 1, e), 10); i = e + 1; return n; }
    if (c === 'l') { i++; const a = []; while (str[i] !== 'e') a.push(val()); i++; return a; }
    if (c === 'd') { i++; const o = {}; while (str[i] !== 'e') { const k = val(); o[k] = val(); } i++; return o; }
    const col = str.indexOf(':', i);
    const len = parseInt(str.slice(i, col), 10);
    const s = str.slice(col + 1, col + 1 + len);
    i = col + 1 + len;
    return s;
  }
  try { return val(); } catch (e) { return null; }
}

function ng(command, params) {
  return new Promise((resolve, reject) => {
    const cookie = Math.random().toString(36).slice(2, 10);
    const msg = `${cookie} ${bencode(Object.assign({ command }, params))}`;
    const sock = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { sock.close(); } catch (e) {} reject(new Error('RTPEngine ng timeout')); }, 5000);
    sock.on('message', (data) => {
      clearTimeout(t);
      const s = data.toString();
      const sp = s.indexOf(' ');
      try { sock.close(); } catch (e) {}
      if (sp < 0) return reject(new Error('bad ng response'));
      resolve(bdecode(s.slice(sp + 1)));
    });
    sock.on('error', (e) => { clearTimeout(t); try { sock.close(); } catch (e2) {} reject(e); });
    sock.send(Buffer.from(msg), NG_PORT, NG_HOST, (e) => { if (e) { clearTimeout(t); reject(e); } });
  });
}

// ── G.711 decode ────────────────────────────────────────────────────────
function ulaw2lin(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exp = (u >> 4) & 0x07, man = u & 0x0f;
  let s = ((man << 3) + 0x84) << exp;
  s -= 0x84;
  return sign ? -s : s;
}
function alaw2lin(a) {
  a ^= 0x55;
  const sign = a & 0x80, exp = (a >> 4) & 0x07, man = a & 0x0f;
  let s = exp ? ((man << 4) + 0x108) << (exp - 1) : (man << 4) + 8;
  return sign ? -s : s;
}

function wavHeader(bytes, rate) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

function localIp() {
  if (EXTERNAL_IP) return EXTERNAL_IP;
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name]) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

async function listCalls() {
  const r = await ng('list', { limit: 64 });
  const ids = (r && (r.calls || r.list)) || [];
  return Array.isArray(ids) ? ids : [];
}

async function main() {
  console.log(`\nRTPEngine ng  : ${NG_HOST}:${NG_PORT}`);

  const calls = await listCalls();
  if (!calls.length) {
    console.log('\nNo live calls on RTPEngine. Start a call and run this again.\n');
    process.exit(1);
  }
  console.log(`Live calls    : ${calls.length}`);
  calls.forEach(c => console.log(`  - ${c}`));
  if (LIST_ONLY) return;

  const callId = WANT_CALL || calls[calls.length - 1];
  console.log(`\nTapping call  : ${callId}`);

  // Our own RTP sink. RTPEngine will send the forked copy of the call's audio
  // straight here instead of to a softphone.
  const sink = dgram.createSocket('udp4');
  await new Promise(res => sink.bind(0, '0.0.0.0', res));
  const sinkPort = sink.address().port;
  const ip = localIp();
  console.log(`RTP sink      : ${ip}:${sinkPort}`);

  // Ask for a copy of the call. flags:['all'] mixes both parties, which is
  // right for a supervisor but WRONG for translation (each STT must hear ONE
  // speaker). Request a single leg so the fork carries one voice only.
  // Which leg to listen to. RTPEngine needs to be told: with no criteria it
  // answers "no monologues matched". Each STT stream must hear ONE speaker, so
  // the real interpreter always names a tag; --all is only for diagnosing.
  const attempts = [];
  if (WANT_TAG) attempts.push({ label: `tag=${WANT_TAG}`, params: { 'from-tags': [WANT_TAG] } });
  if (USE_ALL) attempts.push({ label: 'all (mixed)', params: { flags: ['all'] } });
  if (!WANT_TAG && !USE_ALL) {
    // Discover the legs and take the first tagged one, then fall back to mixed.
    const q = await ng('query', { 'call-id': callId });
    const tags = q && q.tags ? Object.keys(q.tags).filter(t => t && t !== '0') : [];
    console.log(`legs          : ${tags.length ? tags.join(', ') : '(none tagged)'}`);
    for (const t of tags) attempts.push({ label: `tag=${t}`, params: { 'from-tags': [t] } });
    attempts.push({ label: 'all (mixed)', params: { flags: ['all'] } });
  }

  let sub = null, used = null;
  for (const a of attempts) {
    const r = await ng('subscribe request', Object.assign({ 'call-id': callId }, a.params));
    if (r && r.sdp) { sub = r; used = a.label; break; }
    console.log(`  subscribe (${a.label}) -> ${r && r['error-reason'] ? r['error-reason'] : JSON.stringify(r)}`);
  }
  if (!sub || !sub.sdp) {
    console.log('\nsubscribe request failed for every leg.');
    console.log('If it said "unknown command", the RTPEngine build predates v9.5 subscribe support.\n');
    process.exit(2);
  }
  console.log(`subscribed to : ${used}`);
  const toTag = sub['to-tag'] || sub.tag;
  console.log(`subscribe ok  : to-tag=${toTag}`);

  // Tell RTPEngine where to deliver the fork: our UDP socket.
  const answer = [
    'v=0',
    `o=- 0 0 IN IP4 ${ip}`,
    's=tap',
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${sinkPort} RTP/AVP 0 8`,
    'a=rtpmap:0 PCMU/8000',
    'a=rtpmap:8 PCMA/8000',
    'a=recvonly'
  ].join('\r\n') + '\r\n';

  const ans = await ng('subscribe answer', {
    'call-id': callId,
    'to-tag': toTag,
    sdp: answer,
    flags: ['trust-address'],
    replace: ['origin', 'session-connection'],
    ICE: 'remove'
  });
  console.log(`subscribe ans : ${ans && ans.result}`);
  if (!ans || ans.result !== 'ok') {
    console.log(`  -> ${JSON.stringify(ans)}`);
  }

  // ── collect ──
  const pcm = [];
  let packets = 0, bytes = 0, lost = 0, lastSeq = null, payloadType = null;
  let firstAt = 0, lastAt = 0;
  const gaps = [];

  sink.on('message', (buf) => {
    if (buf.length < 12) return;                 // not RTP
    const now = Date.now();
    if (!firstAt) { firstAt = now; console.log('\nfirst RTP packet received — audio is flowing'); }
    else gaps.push(now - lastAt);
    lastAt = now;

    const pt = buf[1] & 0x7f;
    const seq = buf.readUInt16BE(2);
    const csrc = buf[0] & 0x0f;
    const ext = (buf[0] >> 4) & 0x01;
    let off = 12 + csrc * 4;
    if (ext && buf.length > off + 4) off += 4 + buf.readUInt16BE(off + 2) * 4;

    if (lastSeq !== null) {
      const d = (seq - lastSeq + 65536) % 65536;
      if (d > 1 && d < 1000) lost += d - 1;
    }
    lastSeq = seq;
    if (payloadType === null) payloadType = pt;

    const body = buf.subarray(off);
    packets++; bytes += body.length;

    const out = Buffer.alloc(body.length * 2);
    for (let i = 0; i < body.length; i++) {
      const s = pt === 8 ? alaw2lin(body[i]) : ulaw2lin(body[i]);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, s)), i * 2);
    }
    pcm.push(out);
  });

  console.log(`\nCapturing ${SECONDS}s … talk on the call now.\n`);
  await new Promise(res => setTimeout(res, SECONDS * 1000));

  try { await ng('unsubscribe', { 'call-id': callId, 'to-tag': toTag }); } catch (e) {}
  try { sink.close(); } catch (e) {}

  // ── report ──
  console.log('─'.repeat(58));
  if (!packets) {
    console.log('NO RTP RECEIVED.');
    console.log('  • Is UDP ' + sinkPort + ' reachable from RTPEngine (same host should be fine)?');
    console.log('  • Was anyone actually speaking?');
    console.log('  • Check: docker logs rtpengine | tail');
    console.log('─'.repeat(58) + '\n');
    process.exit(3);
  }

  const data = Buffer.concat(pcm);
  const secs = (lastAt - firstAt) / 1000 || 1;
  const codec = payloadType === 8 ? 'PCMA (A-law)' : payloadType === 0 ? 'PCMU (mu-law)' : `PT=${payloadType}`;
  // crude level check so you can tell silence from speech without listening
  let peak = 0, sum = 0;
  for (let i = 0; i < data.length; i += 2) { const v = Math.abs(data.readInt16LE(i)); peak = Math.max(peak, v); sum += v; }
  const avg = sum / (data.length / 2);
  const jitter = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const maxGap = gaps.length ? Math.max(...gaps) : 0;

  const out = path.join('/tmp', `tap-${String(callId).replace(/[^\w.-]/g, '_')}.wav`);
  fs.writeFileSync(out, Buffer.concat([wavHeader(data.length, 8000), data]));

  console.log(`codec         : ${codec}`);
  console.log(`packets       : ${packets} (${(packets / secs).toFixed(1)}/s — expect ~50/s)`);
  console.log(`lost (seq)    : ${lost}`);
  console.log(`inter-packet  : avg ${jitter.toFixed(1)}ms, max ${maxGap}ms (expect ~20ms)`);
  console.log(`audio         : ${secs.toFixed(1)}s, peak ${peak}, avg level ${avg.toFixed(0)}`);
  console.log(`               ${peak < 100 ? '!! near silence — was anyone speaking on this leg?' : 'signal present'}`);
  console.log(`wav           : ${out}`);
  console.log('─'.repeat(58));
  console.log('Listen to the WAV. If it is clear single-speaker audio, the');
  console.log('media tap works and Phase 2 is proven.\n');
}

main().catch(e => { console.error('\nspike failed:', e.message, '\n'); process.exit(1); });
