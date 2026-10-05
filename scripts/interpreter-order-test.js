#!/usr/bin/env node
'use strict';
/**
 * One cheap question before committing to a media takeover:
 *
 *   does the ORDER matter?
 *
 * Every test so far subscribed first and then muted, and the fork always went
 * silent with the peer. But rtpengine decides what a subscriber receives when
 * the subscription is created. If a subscription made AFTER the block attaches
 * to the leg's raw input rather than its muted output, we get exactly what we
 * need — peer silent, tap alive — and no takeover is required.
 *
 * It is a long shot, but it is five minutes against days of rebuilding the
 * media path, so it is worth asking.
 *
 *   node scripts/interpreter-order-test.js --call '<id>'
 *
 * Talk continuously on the speaker leg for ~30s.
 */
const dgram = require('dgram');
const os = require('os');

const NG_HOST = process.env.RTPENGINE_HOST || '127.0.0.1';
const NG_PORT = parseInt(process.env.RTPENGINE_PORT || '22222', 10);
const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const CALL = argOf('--call');
const SECS = parseInt(argOf('--secs') || '8', 10);

function bencode(o) {
  if (typeof o === 'number') return 'i' + o + 'e';
  if (typeof o === 'string') return Buffer.byteLength(o) + ':' + o;
  if (Array.isArray(o)) return 'l' + o.map(bencode).join('') + 'e';
  if (o && typeof o === 'object') { let s = 'd'; for (const k of Object.keys(o)) s += bencode(k) + bencode(o[k]); return s + 'e'; }
  return '0:';
}
function bdecode(str) {
  let i = 0;
  function val() {
    const c = str[i];
    if (c === 'i') { const e = str.indexOf('e', i); const n = parseInt(str.slice(i + 1, e), 10); i = e + 1; return n; }
    if (c === 'l') { i++; const a = []; while (str[i] !== 'e') a.push(val()); i++; return a; }
    if (c === 'd') { i++; const o = {}; while (str[i] !== 'e') { const k = val(); o[k] = val(); } i++; return o; }
    const col = str.indexOf(':', i), len = parseInt(str.slice(i, col), 10);
    const s = str.slice(col + 1, col + 1 + len); i = col + 1 + len; return s;
  }
  try { return val(); } catch (e) { return null; }
}
function ng(command, params) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { sock.close(); } catch (e) {} resolve({ result: 'error', 'error-reason': 'timeout' }); }, 5000);
    sock.on('message', (d) => {
      clearTimeout(t); const s = d.toString(), sp = s.indexOf(' ');
      try { sock.close(); } catch (e) {}
      resolve(sp < 0 ? null : bdecode(s.slice(sp + 1)));
    });
    sock.on('error', () => { clearTimeout(t); resolve({ result: 'error' }); });
    sock.send(Buffer.from(`${Math.random().toString(36).slice(2, 10)} ${bencode(Object.assign({ command }, params))}`),
      NG_PORT, NG_HOST, () => {});
  });
}
const localIp = () => {
  if (process.env.EXTERNAL_IP) return process.env.EXTERNAL_IP;
  const ifs = os.networkInterfaces();
  for (const n of Object.keys(ifs)) for (const a of ifs[n]) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
};
const ulawAbs = (u) => { u = ~u & 0xff; const e = (u >> 4) & 0x07, m = u & 0x0f; return (((m << 3) + 0x84) << e) - 0x84; };
const pause = (ms) => new Promise(r => setTimeout(r, ms));

async function makeTap(callId, tag) {
  const sink = dgram.createSocket('udp4');
  await new Promise(r => sink.bind(0, '0.0.0.0', r));
  const port = sink.address().port, ip = localIp();
  const sub = await ng('subscribe request', { 'call-id': callId, 'from-tags': [tag] });
  if (!sub || !sub.sdp) { try { sink.close(); } catch (e) {} return null; }
  const toTag = sub['to-tag'] || sub.tag;
  const answer = sub.sdp.split(/\r?\n/).filter(Boolean).map((line) => {
    if (line.startsWith('c=')) return `c=IN IP4 ${ip}`;
    if (line.startsWith('o=')) { const p = line.split(' '); if (p.length >= 6) { p[5] = ip; return p.join(' '); } return `o=- 0 0 IN IP4 ${ip}`; }
    if (line.startsWith('m=audio')) { const p = line.split(' '); p[1] = String(port); return p.join(' '); }
    if (/^a=(candidate|ice-|fingerprint|setup|rtcp:)/.test(line)) return null;
    if (line === 'a=sendrecv' || line === 'a=sendonly') return 'a=recvonly';
    return line;
  }).filter(Boolean).join('\r\n') + '\r\n';
  const ans = await ng('subscribe answer', { 'call-id': callId, 'to-tag': toTag, sdp: answer, flags: ['trust-address'], ICE: 'remove' });
  if (!ans || ans.result !== 'ok') { try { sink.close(); } catch (e) {} return null; }
  const st = { packets: 0, loud: 0, peak: 0 };
  sink.on('message', (buf) => {
    if (buf.length < 13) return;
    st.packets++;
    const b = buf.subarray(12);
    let sum = 0, pk = 0;
    for (let i = 0; i < b.length; i++) { const v = Math.abs(ulawAbs(b[i])); sum += v; if (v > pk) pk = v; }
    if (sum / b.length > 400) st.loud++;
    if (pk > st.peak) st.peak = pk;
  });
  return { st, toTag, stop: async () => {
    try { await ng('unsubscribe', { 'call-id': callId, 'to-tag': toTag }); } catch (e) {}
    try { sink.close(); } catch (e) {}
  } };
}

async function main() {
  if (!CALL) {
    const r = await ng('list', { limit: 32 });
    const calls = (r && (r.calls || r.list)) || [];
    console.log('\nLive calls:'); calls.forEach(c => console.log('  - ' + c));
    console.log('\nPass one with --call\n'); return;
  }
  const q = await ng('query', { 'call-id': CALL });
  const tags = q && q.tags ? Object.keys(q.tags).filter(t => t && t !== '0' && !/^<untagged/.test(t)) : [];
  if (tags.length < 2) { console.log('\nNeed two tagged legs.\n'); process.exit(1); }
  const speaker = tags[0];

  console.log(`\ncall     : ${CALL}`);
  console.log(`speaker  : ${speaker}`);
  console.log(`\nTalk continuously on the speaker leg for the next ~${SECS * 3 + 10}s.`);
  console.log('─'.repeat(62));

  // Baseline: no muting at all, so we know what "working" looks like.
  console.log('\nA. baseline — no mute, subscribe normally');
  let t = await makeTap(CALL, speaker);
  if (!t) { console.log('  could not subscribe'); process.exit(1); }
  await pause(SECS * 1000);
  console.log(`   tap: ${t.st.packets} packets, ${t.st.loud} with speech, peak ${t.st.peak}`);
  const baseline = t.st.loud;
  await t.stop();

  // B. the order we have always used: subscribe, then block.
  console.log('\nB. subscribe FIRST, then block  (what we tested before)');
  t = await makeTap(CALL, speaker);
  await pause(1000);
  const before = t.st.loud;
  await ng('block media', { 'call-id': CALL, 'from-tag': speaker });
  await pause(SECS * 1000);
  console.log(`   tap after block: ${t.st.loud - before} loud packets`);
  await ng('unblock media', { 'call-id': CALL, 'from-tag': speaker });
  await t.stop();

  // C. the untested order: block first, THEN subscribe.
  console.log('\nC. block FIRST, then subscribe  (the question)');
  await ng('block media', { 'call-id': CALL, 'from-tag': speaker });
  await pause(500);
  t = await makeTap(CALL, speaker);
  if (!t) {
    console.log('   could not subscribe while blocked');
  } else {
    await pause(SECS * 1000);
    console.log(`   tap while blocked: ${t.st.packets} packets, ${t.st.loud} with speech, peak ${t.st.peak}`);
    await t.stop();
  }
  await ng('unblock media', { 'call-id': CALL, 'from-tag': speaker });

  console.log('\n' + '─'.repeat(62));
  console.log(`baseline speech packets: ${baseline}`);
  console.log('');
  console.log('If C shows speech packets close to the baseline, ordering is the');
  console.log('answer: block the leg, then subscribe, and we get silence toward');
  console.log('the peer with a live tap — no media takeover needed.');
  console.log('If C is ~0, rtpengine always forks post-mute and we own the path.');
  console.log('─'.repeat(62) + '\n');
  process.exit(0);
}

main().catch(e => { console.error('\nfailed:', e.message, '\n'); process.exit(1); });
