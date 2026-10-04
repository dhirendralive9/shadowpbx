#!/usr/bin/env node
'use strict';
/**
 * Phase-4b spike — speech-to-text -> DeepL translation, end to end on a live call.
 *
 * Adds the two things that turn transcripts into usable translation:
 *
 *   1. SENTENCE BUFFERING. Deepgram finalises on short pauses, so a single
 *      thought arrives as fragments ("So I'm thinking about going to the east"
 *      / "because in West Bengal,"). Translating a fragment produces nonsense
 *      in a language with different word order, so finals are accumulated
 *      until the sentence actually ends (terminal punctuation, an UtteranceEnd,
 *      or a timeout) and only then sent to DeepL.
 *
 *   2. DeepL, with the free/pro host chosen from the key (":fx" => free).
 *
 * Reports the real per-stage timing: stop speaking -> final -> translated.
 *
 * Takes the proven media tap (interpreter-tap-spike.js) and, instead of writing
 * a WAV, streams the caller's audio straight into Deepgram's realtime API and
 * prints what it hears.
 *
 * The number that matters is NOT "how fast is the API". It is:
 *
 *     you stop speaking  ->  a FINAL transcript exists
 *
 * because nothing can be translated until the sentence is known to be finished.
 * That gap is endpointing + network + recognition, and it is the floor on the
 * whole turn. Everything else (translate, synthesise, inject) stacks on top.
 *
 *   node scripts/interpreter-stt-spike.js --call '<id>' [--tag <t>] [--seconds 45]
 *   node scripts/interpreter-stt-spike.js --list
 *
 * Audio is sent as mulaw/8000 exactly as it arrives from RTPEngine — Deepgram
 * accepts G.711 natively, so there is no decode step and no quality loss.
 */
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fs = require('fs');

// .env (same file the app uses)
(function loadEnv() {
  const f = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

let WebSocket;
try { WebSocket = require('ws'); }
catch (e) {
  console.error('\nThe "ws" package is required.  npm install ws --prefix /opt/shadowpbx\n');
  process.exit(1);
}

const NG_HOST = process.env.RTPENGINE_HOST || '127.0.0.1';
const NG_PORT = parseInt(process.env.RTPENGINE_PORT || '22222', 10);
const DG_KEY = process.env.DEEPGRAM_API_KEY || '';
const MODEL = process.env.TRANSLATION_STT_MODEL || 'nova-3';
// "auto" is OUR word for detect-the-language; Deepgram has no such code and
// answers 400. Nova-3 does multilingual detection under the code "multi".
const RAW_LANG = argOf('--lang') || process.env.TRANSLATION_DEFAULT_CUSTOMER_LANG || 'multi';
const LANG = (!RAW_LANG || RAW_LANG === 'auto') ? 'multi' : RAW_LANG;
const SECONDS = parseInt(argOf('--seconds') || '45', 10);
const WANT_CALL = argOf('--call');
const WANT_TAG = argOf('--tag');
const LIST_ONLY = process.argv.includes('--list');

// Endpointing: how long Deepgram waits after speech before finalising.
// This is the single biggest lever on perceived turn latency.
const TARGET = (argOf('--to') || 'DE').toUpperCase();   // translate INTO this
const DEEPL_KEY = process.env.DEEPL_API_KEY || '';
// A key ending ":fx" is a free-tier key and MUST use the free host; sending it
// to api.deepl.com returns 403 and looks like a bad key.
const DEEPL_HOST = /:fx$/.test(DEEPL_KEY.trim()) ? 'api-free.deepl.com' : 'api.deepl.com';
const SENTENCE_IDLE_MS = parseInt(argOf('--flush-ms') || '1200', 10);

const ENDPOINTING = argOf('--endpointing') || '300';
const UTTERANCE_END = argOf('--utterance-end') || '1000';

function argOf(f) { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; }

// ── bencode / ng ────────────────────────────────────────────────────────
function bencode(o) {
  if (typeof o === 'number') return 'i' + o + 'e';
  if (typeof o === 'string') return o.length + ':' + o;
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
    const col = str.indexOf(':', i); const len = parseInt(str.slice(i, col), 10);
    const s = str.slice(col + 1, col + 1 + len); i = col + 1 + len; return s;
  }
  try { return val(); } catch (e) { return null; }
}
function ng(command, params) {
  return new Promise((resolve, reject) => {
    const cookie = Math.random().toString(36).slice(2, 10);
    const sock = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { sock.close(); } catch (e) {} reject(new Error('ng timeout')); }, 5000);
    sock.on('message', (d) => {
      clearTimeout(t); const s = d.toString(); const sp = s.indexOf(' ');
      try { sock.close(); } catch (e) {}
      resolve(sp < 0 ? null : bdecode(s.slice(sp + 1)));
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
    sock.send(Buffer.from(`${cookie} ${bencode(Object.assign({ command }, params))}`), NG_PORT, NG_HOST,
      (e) => { if (e) { clearTimeout(t); reject(e); } });
  });
}
function localIp() {
  if (process.env.EXTERNAL_IP) return process.env.EXTERNAL_IP;
  const ifs = os.networkInterfaces();
  for (const n of Object.keys(ifs)) for (const a of ifs[n]) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}
const ms = (n) => `${Math.round(n)}ms`;

const https = require('https');
function deeplTranslate(text, target) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text: [text], target_lang: target });
    const req = https.request({
      method: 'POST', hostname: DEEPL_HOST, path: '/v2/translate',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`DeepL ${res.statusCode}: ${d.slice(0, 200)}`));
        try {
          const j = JSON.parse(d);
          const t = j.translations && j.translations[0];
          resolve({ text: t ? t.text : '', detected: t ? t.detected_source_language : '' });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('DeepL timeout')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function main() {
  if (!DG_KEY) { console.error('\nDEEPGRAM_API_KEY is not set in .env\n'); process.exit(1); }

  const r = await ng('list', { limit: 64 });
  const calls = (r && (r.calls || r.list)) || [];
  if (!calls.length) { console.log('\nNo live calls.\n'); process.exit(1); }
  console.log(`\nLive calls    : ${calls.length}`);
  calls.forEach(c => console.log(`  - ${c}`));
  if (LIST_ONLY) return;

  const callId = WANT_CALL || calls[0];
  console.log(`\nTapping call  : ${callId}`);

  const sink = dgram.createSocket('udp4');
  await new Promise(res => sink.bind(0, '0.0.0.0', res));
  const sinkPort = sink.address().port;
  const ip = localIp();

  // Pick a leg (see tap spike: an unnamed subscribe matches no monologue).
  const attempts = [];
  if (WANT_TAG) attempts.push({ label: `tag=${WANT_TAG}`, params: { 'from-tags': [WANT_TAG] } });
  else {
    const q = await ng('query', { 'call-id': callId });
    const tags = q && q.tags ? Object.keys(q.tags).filter(t => t && t !== '0' && !/^<untagged/.test(t)) : [];
    console.log(`legs          : ${tags.join(', ') || '(none)'}`);
    for (const t of tags) attempts.push({ label: `tag=${t}`, params: { 'from-tags': [t] } });
    attempts.push({ label: 'all (mixed)', params: { flags: ['all'] } });
  }

  let sub = null, used = null;
  for (const a of attempts) {
    const resp = await ng('subscribe request', Object.assign({ 'call-id': callId }, a.params));
    if (resp && resp.sdp) { sub = resp; used = a.label; break; }
  }
  if (!sub) { console.error('\nsubscribe failed\n'); process.exit(2); }
  const toTag = sub['to-tag'] || sub.tag;
  console.log(`subscribed to : ${used}`);

  const answer = sub.sdp.split(/\r?\n/).filter(Boolean).map((line) => {
    if (line.startsWith('c=')) return `c=IN IP4 ${ip}`;
    if (line.startsWith('o=')) { const p = line.split(' '); if (p.length >= 6) { p[5] = ip; return p.join(' '); } return `o=- 0 0 IN IP4 ${ip}`; }
    if (line.startsWith('m=audio')) { const p = line.split(' '); p[1] = String(sinkPort); return p.join(' '); }
    if (/^a=(candidate|ice-|fingerprint|setup|rtcp:)/.test(line)) return null;
    if (line === 'a=sendrecv' || line === 'a=sendonly') return 'a=recvonly';
    return line;
  }).filter(Boolean).join('\r\n') + '\r\n';

  const ans = await ng('subscribe answer', {
    'call-id': callId, 'to-tag': toTag, sdp: answer,
    flags: ['trust-address'], replace: ['origin', 'session-connection'], ICE: 'remove'
  });
  if (!ans || ans.result !== 'ok') { console.error(`\nsubscribe answer failed: ${JSON.stringify(ans)}\n`); process.exit(3); }

  // ── Deepgram ──
  const qs = new URLSearchParams({
    model: MODEL,
    language: LANG,
    encoding: 'mulaw',          // send G.711 exactly as it arrives — no decode
    sample_rate: '8000',
    channels: '1',
    interim_results: 'true',    // required for utterance_end_ms
    punctuate: 'true',
    endpointing: ENDPOINTING,
    utterance_end_ms: UTTERANCE_END
  });
  const url = `wss://api.deepgram.com/v1/listen?${qs}`;
  console.log(`\nDeepgram      : ${MODEL}, lang=${LANG}, endpointing=${ENDPOINTING}ms, utterance_end=${UTTERANCE_END}ms`);
  console.log(`DeepL         : ${DEEPL_HOST} -> ${TARGET}  (${/:fx$/.test(DEEPL_KEY) ? 'free key' : 'pro key'})`);
  if (!DEEPL_KEY) { console.error('\nDEEPL_API_KEY is not set in .env\n'); process.exit(1); }

  const t0 = Date.now();
  const ws = new WebSocket(url, { headers: { Authorization: `Token ${DG_KEY}` } });

  let open = false, pktCount = 0, lastAudioAt = 0, speaking = false;
  let speechEndedAt = 0;                 // when audio went quiet (our clock)
  const turns = [];                      // measured silence -> final gaps

  // ── sentence buffer ──────────────────────────────────────────────────
  // Finals are fragments. Accumulate until the thought is complete, then
  // translate once. Flushing on: terminal punctuation, UtteranceEnd, or a
  // short idle timeout (someone trailed off without a full stop).
  let buf = [], bufStartedAt = 0, firstGap = null, idleTimer = null;
  const translations = [];

  function pushFragment(text, gap) {
    if (!text) return;
    if (!buf.length) { bufStartedAt = Date.now(); firstGap = gap; }
    buf.push(text.trim());
    const joined = buf.join(' ');
    console.log(`  frag   ${gap !== null ? ('[' + ms(gap) + ']').padEnd(9) : ''.padEnd(9)} "${text.trim()}"`);
    if (/[.!?。]\s*$/.test(joined)) flush('punctuation');
    else {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => flush('idle'), SENTENCE_IDLE_MS);
    }
  }

  async function flush(reason) {
    clearTimeout(idleTimer);
    if (!buf.length) return;
    const text = buf.join(' ').trim();
    buf = [];
    if (text.length < 2) return;

    const t1 = Date.now();
    try {
      const out = await deeplTranslate(text, TARGET);
      const dt = Date.now() - t1;
      const total = firstGap !== null ? firstGap + dt : null;
      translations.push({ translateMs: dt, totalMs: total });
      console.log('');
      console.log(`  ${out.detected || '??'} → ${TARGET}   (translate ${ms(dt)}${total ? `, stop→translated ${ms(total)}` : ''}, flush: ${reason})`);
      console.log(`     said      : ${text}`);
      console.log(`     translated: ${out.text}`);
      console.log('');
    } catch (e) {
      console.log(`  !! DeepL failed: ${e.message}`);
    }
    firstGap = null;
  }

  ws.on('open', () => {
    open = true;
    console.log(`connected     : ${ms(Date.now() - t0)} to open the websocket\n`);
    console.log('Speak on the call. Interim results appear as you talk; the');
    console.log('number in [brackets] is the wait from you stopping to a FINAL.\n');
    console.log('─'.repeat(64));
  });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }

    if (m.type === 'UtteranceEnd') {
      if (speechEndedAt) {
        const gap = Date.now() - speechEndedAt;
        console.log(`   · UtteranceEnd after ${ms(gap)} of real silence`);
      }
      flush('utterance-end');
      return;
    }
    const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
    if (!alt || !alt.transcript) return;

    if (m.is_final) {
      const gap = speechEndedAt ? Date.now() - speechEndedAt : null;
      if (gap !== null) turns.push(gap);
      speechEndedAt = 0;
      process.stdout.write('\r' + ' '.repeat(70) + '\r');
      pushFragment(alt.transcript, gap);
    } else {
      process.stdout.write(`\r  …${alt.transcript.slice(-60).padEnd(62)}`);
    }
  });

  ws.on('error', (e) => console.error('\nDeepgram error:', e.message));
  ws.on('close', (c, reason) => { if (c !== 1000) console.log(`\ndeepgram closed: ${c} ${reason || ''}`); });

  // RTP -> Deepgram. Strip the 12-byte header and forward the mulaw payload.
  sink.on('message', (buf) => {
    if (buf.length < 13) return;
    const csrc = buf[0] & 0x0f, ext = (buf[0] >> 4) & 0x01;
    let off = 12 + csrc * 4;
    if (ext && buf.length > off + 4) off += 4 + buf.readUInt16BE(off + 2) * 4;
    const body = buf.subarray(off);
    if (!body.length) return;

    pktCount++;
    const now = Date.now();

    // Track speech vs silence from the audio itself, so the latency figure is
    // measured against when the SPEAKER stopped, not when a packet arrived.
    let sum = 0;
    for (let i = 0; i < body.length; i++) sum += Math.abs(ulawAbs(body[i]));
    const level = sum / body.length;
    if (level > 500) { speaking = true; lastAudioAt = now; }
    else if (speaking && now - lastAudioAt > 150) { speaking = false; speechEndedAt = lastAudioAt; }

    if (open && ws.readyState === 1) ws.send(body);
  });

  setTimeout(async () => {
    try { if (open && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'CloseStream' })); } } catch (e) {}
    setTimeout(async () => {
      try { ws.close(); } catch (e) {}
      try { await ng('unsubscribe', { 'call-id': callId, 'to-tag': toTag }); } catch (e) {}
      try { sink.close(); } catch (e) {}

      console.log('\n' + '─'.repeat(64));
      console.log(`rtp packets   : ${pktCount}`);
      if (turns.length) {
        const avg = turns.reduce((a, b) => a + b, 0) / turns.length;
        const min = Math.min(...turns), max = Math.max(...turns);
        console.log(`turns         : ${turns.length}`);
        console.log(`stop→final    : avg ${ms(avg)}, min ${ms(min)}, max ${ms(max)}`);
        if (translations.length) {
          const tr = translations.map(t => t.translateMs);
          const tot = translations.filter(t => t.totalMs).map(t => t.totalMs);
          console.log(`sentences     : ${translations.length}`);
          console.log(`deepl         : avg ${ms(tr.reduce((a,b)=>a+b,0)/tr.length)}, max ${ms(Math.max(...tr))}`);
          if (tot.length) console.log(`stop→translated: avg ${ms(tot.reduce((a,b)=>a+b,0)/tot.length)}`);
          console.log('');
          console.log('Add TTS (~300-800ms) + inject (~100ms) for the full turn.');
        }
        console.log('');
        console.log(`This is the FLOOR for a translated turn. Add translate`);
        console.log(`(~150-350ms) + TTS (~300-800ms) + inject (~100ms) on top,`);
        console.log(`so expect roughly ${ms(avg + 600)}-${ms(avg + 1200)} before the other party`);
        console.log(`hears anything. Lower --endpointing shortens it but cuts`);
        console.log(`people off mid-sentence; that is the trade-off to tune.`);
      } else {
        console.log('No finalised transcripts — was anyone speaking on this leg?');
      }
      console.log('─'.repeat(64) + '\n');
      process.exit(0);
    }, 1500);
  }, SECONDS * 1000);

  console.log(`\nCapturing ${SECONDS}s …`);
}

// amplitude of a mulaw byte, for the speech/silence gate
function ulawAbs(u) {
  u = ~u & 0xff;
  const exp = (u >> 4) & 0x07, man = u & 0x0f;
  return (((man << 3) + 0x84) << exp) - 0x84;
}

main().catch(e => { console.error('\nspike failed:', e.message, '\n'); process.exit(1); });
