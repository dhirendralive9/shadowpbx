#!/usr/bin/env node
'use strict';
/**
 * Which muting strategy gives TOTAL SILENCE without killing the tap?
 *
 * We need two things at once on a translated call:
 *   (a) the listener must NOT hear the speaker's original audio
 *   (b) we must keep receiving that speaker's audio to transcribe it
 *
 * Every obvious approach has failed one of those:
 *   mute the listener's leg -> they still hear the speaker (wrong direction)
 *   mute the speaker's leg  -> our subscription goes silent too
 *   mute only during playback -> works, but the original leaks between turns
 *
 * Rather than guess again, this tries each candidate against a live call and
 * MEASURES both outcomes: does RTP still reach our fork, and does rtpengine
 * still forward audio to the peer. The winner (if any) decides the design.
 *
 *   node scripts/interpreter-mute-matrix.js --call '<id>'
 *
 * Have someone talking continuously on the call throughout — the test is
 * meaningless against silence.
 */
const dgram = require('dgram');
const os = require('os');

const NG_HOST = process.env.RTPENGINE_HOST || '127.0.0.1';
const NG_PORT = parseInt(process.env.RTPENGINE_PORT || '22222', 10);
const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const CALL = argOf('--call');
const SECS = parseInt(argOf('--secs') || '6', 10);

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

// Subscribe to one leg and count how much real audio arrives.
async function tap(callId, tag) {
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

  const state = { packets: 0, loud: 0 };
  sink.on('message', (buf) => {
    if (buf.length < 13) return;
    state.packets++;
    const b = buf.subarray(12);
    let sum = 0;
    for (let i = 0; i < b.length; i++) sum += Math.abs(ulawAbs(b[i]));
    if (sum / b.length > 400) state.loud++;      // actual speech, not silence
  });
  return {
    state,
    stop: async () => {
      try { await ng('unsubscribe', { 'call-id': callId, 'to-tag': toTag }); } catch (e) {}
      try { sink.close(); } catch (e) {}
    }
  };
}

// Count RTP rtpengine forwards to the peer, read from its own stats.
async function peerStats(callId, tag) {
  const q = await ng('query', { 'call-id': callId });
  if (!q || !q.tags || !q.tags[tag]) return null;
  let packets = 0;
  const medias = q.tags[tag].medias || [];
  for (const m of medias) for (const s of (m.streams || [])) {
    if (s.stats_out && typeof s.stats_out.packets === 'number') packets += s.stats_out.packets;
  }
  return packets;
}

const pause = (ms) => new Promise(r => setTimeout(r, ms));

async function trial(name, callId, speakTag, listenTag, apply, undo) {
  process.stdout.write(`\n${name}\n`);
  const t = await tap(callId, speakTag);
  if (!t) { console.log('  tap could not be created — skipped'); return; }
  await pause(1500);
  const before = Object.assign({}, t.state);
  const peerBefore = await peerStats(callId, listenTag);

  const r = await apply();
  const applied = r && r.result === 'ok';
  console.log(`  applied       : ${applied ? 'ok' : JSON.stringify(r)}`);
  if (!applied) { await t.stop(); return; }

  await pause(SECS * 1000);
  const tapDelta = t.state.packets - before.packets;
  const loudDelta = t.state.loud - before.loud;
  const peerAfter = await peerStats(callId, listenTag);
  const peerDelta = (peerAfter != null && peerBefore != null) ? peerAfter - peerBefore : null;

  await undo();
  await t.stop();

  const tapAlive = loudDelta > 10;
  const peerQuiet = peerDelta != null ? peerDelta < 20 : null;
  console.log(`  tap           : ${tapDelta} packets, ${loudDelta} with speech  -> ${tapAlive ? 'ALIVE' : 'DEAD'}`);
  console.log(`  peer received : ${peerDelta == null ? 'unknown' : peerDelta + ' packets'}  -> ${peerQuiet == null ? '?' : (peerQuiet ? 'SILENT' : 'still hearing')}`);
  console.log(`  verdict       : ${tapAlive && peerQuiet ? '*** WORKS — silence + tap alive ***' : (tapAlive ? 'tap ok but peer still hears' : 'tap killed')}`);
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
  if (tags.length < 2) { console.log('\nNeed a call with two tagged legs.\n'); process.exit(1); }
  const speakTag = tags[0], listenTag = tags[1];

  console.log(`\ncall      : ${CALL}`);
  console.log(`speaker   : ${speakTag}   (we tap this, and want it silenced for the peer)`);
  console.log(`listener  : ${listenTag}  (should hear nothing)`);
  console.log(`\nKeep talking on the SPEAKER leg for the whole test (~${(SECS + 3) * 5}s).`);
  console.log('─'.repeat(64));

  await trial('1. silence media on the speaker leg', CALL, speakTag, listenTag,
    () => ng('silence media', { 'call-id': CALL, 'from-tag': speakTag }),
    () => ng('unsilence media', { 'call-id': CALL, 'from-tag': speakTag }));

  await trial('2. block media on the speaker leg', CALL, speakTag, listenTag,
    () => ng('block media', { 'call-id': CALL, 'from-tag': speakTag }),
    () => ng('unblock media', { 'call-id': CALL, 'from-tag': speakTag }));

  await trial('3. silence media, direction to the listener only', CALL, speakTag, listenTag,
    () => ng('silence media', { 'call-id': CALL, 'from-tag': speakTag, direction: ['to-' + listenTag] }),
    () => ng('unsilence media', { 'call-id': CALL, 'from-tag': speakTag }));

  await trial('4. block media on the LISTENER leg (blocks what they receive?)', CALL, speakTag, listenTag,
    () => ng('block media', { 'call-id': CALL, 'from-tag': listenTag, flags: ['inverse-selection'] }),
    () => ng('unblock media', { 'call-id': CALL, 'from-tag': listenTag }));

  await trial('5. silence media with subscribe-exempt flag', CALL, speakTag, listenTag,
    () => ng('silence media', { 'call-id': CALL, 'from-tag': speakTag, flags: ['no-subscribers'] }),
    () => ng('unsilence media', { 'call-id': CALL, 'from-tag': speakTag }));

  console.log('\n' + '─'.repeat(64));
  console.log('Any trial marked *** WORKS *** is the strategy to build on.');
  console.log('If none do, rtpengine cannot give us silence and a tap at once,');
  console.log('and the design has to own the media path instead.\n');
  process.exit(0);
}

main().catch(e => { console.error('\nfailed:', e.message, '\n'); process.exit(1); });
