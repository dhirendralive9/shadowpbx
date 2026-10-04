#!/usr/bin/env node
'use strict';
/**
 * Phase-3b spike — INJECTION. The last unknown, and the one that closes the loop.
 *
 * Everything so far has been read-only: we copied audio out of a call and sent
 * it to APIs. This writes audio back IN — the agent (or caller) actually hears
 * synthesised speech inside the live call.
 *
 * Mechanism: synthesise with Deepgram Aura, write a WAV where rtpengine can
 * read it, then "play media" targeted at one leg. rtpengine's player needs the
 * daemon to be built with media playback support (libavcodec); if this build
 * lacks it the command fails cleanly and says so, which is itself the answer we
 * need before building anything on top.
 *
 *   # list legs so you can choose who hears it
 *   node scripts/interpreter-inject-spike.js --call '<id>' --legs
 *
 *   # speak German into a specific leg
 *   node scripts/interpreter-inject-spike.js --call '<id>' --tag '<leg>' \
 *        --text "Ich möchte mein Abonnement kündigen." --lang de
 *
 *   # play to everyone on the call (easiest first test)
 *   node scripts/interpreter-inject-spike.js --call '<id>' --all --text "Hallo"
 */
const dgram = require('dgram');
const https = require('https');
const fs = require('fs');
const path = require('path');

(function loadEnv() {
  const f = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const DG_KEY = process.env.DEEPGRAM_API_KEY || '';
const NG_HOST = process.env.RTPENGINE_HOST || '127.0.0.1';
const NG_PORT = parseInt(process.env.RTPENGINE_PORT || '22222', 10);

const argOf = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };
const CALL = argOf('--call');
const TAG = argOf('--tag');
const TEXT = argOf('--text') || 'Hallo, dies ist ein Test der Sprachübersetzung.';
const LANG = (argOf('--lang') || 'de').toLowerCase();
const GENDER = (argOf('--gender') || 'female').toLowerCase();
const TO_ALL = process.argv.includes('--all');
const LIST_LEGS = process.argv.includes('--legs');
const BLOCK = process.argv.includes('--block');   // mute the far speaker while we talk
const USE_BLOB = process.argv.includes('--blob');

const VOICES = {
  en: { female: 'aura-2-thalia-en', male: 'aura-2-apollo-en' },
  de: { female: 'aura-2-viktoria-de', male: 'aura-2-julius-de' },
  es: { female: 'aura-2-celeste-es', male: 'aura-2-nestor-es' },
  fr: { female: 'aura-2-pandora-fr', male: 'aura-2-alcyone-fr' }
};
const voiceFor = (l, g) => ((VOICES[l] || VOICES.en)[g] || (VOICES[l] || VOICES.en).female);

// ── ng ──────────────────────────────────────────────────────────────────
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
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const msg = Buffer.from(`${Math.random().toString(36).slice(2, 10)} ${bencode(Object.assign({ command }, params))}`, 'binary');
    const t = setTimeout(() => { try { sock.close(); } catch (e) {} reject(new Error('ng timeout')); }, 10000);
    sock.on('message', (d) => {
      clearTimeout(t); const s = d.toString(), sp = s.indexOf(' ');
      try { sock.close(); } catch (e) {}
      resolve(sp < 0 ? null : bdecode(s.slice(sp + 1)));
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
    sock.send(msg, NG_PORT, NG_HOST, (e) => { if (e) { clearTimeout(t); reject(e); } });
  });
}

// ── TTS ─────────────────────────────────────────────────────────────────
function speak(text, voice) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    // 8 kHz mu-law in a WAV container: rtpengine reads the container, and the
    // samples are already the codec the call uses, so nothing is transcoded.
    // 16-bit PCM, not mulaw. rtpengine's player decodes linear16 cleanly and
    // transcodes to whatever the call is using; a mu-law WAV played back
    // broken and stuttering.
    const q = `model=${voice}&encoding=linear16&sample_rate=8000&container=wav`;
    const t0 = Date.now();
    const req = https.request({
      method: 'POST', hostname: 'api.deepgram.com', path: `/v1/speak?${q}`,
      headers: { Authorization: `Token ${DG_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 20000
    }, (res) => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(ch);
        if (res.statusCode !== 200) return reject(new Error(`Deepgram ${res.statusCode}: ${buf.toString().slice(0, 200)}`));
        resolve({ audio: buf, ms: Date.now() - t0 });
      });
    });
    req.on('timeout', () => req.destroy(new Error('TTS timeout')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

async function main() {
  if (!CALL) {
    const r = await ng('list', { limit: 32 });
    const calls = (r && (r.calls || r.list)) || [];
    console.log('\nLive calls:');
    calls.forEach(c => console.log('  - ' + c));
    console.log('\nPass one with --call\n');
    return;
  }

  const q = await ng('query', { 'call-id': CALL });
  if (!q || q.result === 'error') {
    console.log(`\ncall-id not known to rtpengine: ${CALL}`);
    console.log('(dead sessions linger in "list" — make a fresh call and use its id)\n');
    process.exit(1);
  }
  const tags = q && q.tags ? Object.keys(q.tags).filter(t => t && t !== '0') : [];
  console.log(`\ncall          : ${CALL}`);
  console.log('legs          :');
  tags.forEach(t => console.log(`  - ${t}${/^<untagged/.test(t) ? '   (no SIP tag — cannot be targeted individually)' : ''}`));
  if (LIST_LEGS) { console.log(''); return; }

  if (!DG_KEY) { console.error('\nDEEPGRAM_API_KEY not set\n'); process.exit(1); }
  const voice = voiceFor(LANG, GENDER);
  console.log(`\nvoice         : ${voice}`);
  console.log(`text          : ${TEXT}`);

  const tts = await speak(TEXT, voice);
  // rtpengine runs in a container with its own filesystem: /tmp here is NOT
  // /tmp there. The installer bind-mounts /opt/shadowpbx/audio -> /audio, so
  // that is the one place both sides can see.
  const AUDIO_HOST = process.env.AUDIO_DIR || '/opt/shadowpbx/audio';
  const AUDIO_CONTAINER = process.env.AUDIO_DIR_CONTAINER || '/audio';
  const name = `inject-${Date.now()}.wav`;
  const file = path.join(AUDIO_HOST, name);
  const fileForRtpengine = `${AUDIO_CONTAINER}/${name}`;
  if (!fs.existsSync(AUDIO_HOST)) fs.mkdirSync(AUDIO_HOST, { recursive: true });
  fs.writeFileSync(file, tts.audio);
  fs.chmodSync(file, 0o644);
  console.log(`tts           : ${tts.ms}ms, ${tts.audio.length} bytes`);
  console.log(`file          : ${file}  (rtpengine sees ${fileForRtpengine})`);

  // Who hears it. "all" is the simplest first proof; a from-tag targets one
  // party, which is what the interpreter needs (the agent hears German while
  // the caller does not).
  const target = TO_ALL ? { all: 'all' } : { 'from-tag': TAG || tags[0] };
  console.log(`target        : ${TO_ALL ? 'ALL parties' : (TAG || tags[0])}`);

  if (BLOCK && !TO_ALL) {
    try {
      await ng('block media', { 'call-id': CALL, 'from-tag': TAG || tags[0] });
      console.log('blocked       : far-end audio muted during playback');
    } catch (e) { console.log(`block failed  : ${e.message}`); }
  }

  const params = Object.assign({ 'call-id': CALL }, target);
  if (USE_BLOB) params.blob = tts.audio.toString('binary');
  else params.file = fileForRtpengine;

  console.log(`\nplaying via   : ${USE_BLOB ? 'blob (inline bytes)' : 'file path'}`);
  const t0 = Date.now();
  const res = await ng('play media', params);
  const dt = Date.now() - t0;

  console.log('');
  console.log('─'.repeat(60));
  if (res && res.result === 'ok') {
    console.log(`PLAYING  (${dt}ms to start${res.duration ? `, duration ${res.duration}ms` : ''})`);
    console.log('');
    console.log('Listen on the call — you should hear the synthesised voice now.');
    if (!TO_ALL) console.log('Only the targeted leg hears it; the other party hears nothing.');
  } else {
    console.log(`play media FAILED: ${JSON.stringify(res)}`);
    console.log('');
    if (res && /unknown command|not supported|unsupported/i.test(JSON.stringify(res))) {
      console.log('This rtpengine build has no media player (needs libavcodec support).');
      console.log('Check: docker exec rtpengine rtpengine --version');
    } else if (!USE_BLOB) {
      console.log('rtpengine could not read or decode the file. Check it can see it:');
      console.log(`  docker exec rtpengine ls -l ${fileForRtpengine}`);
    }
  }
  console.log('─'.repeat(60));

  if (BLOCK && !TO_ALL) {
    const secs = Math.ceil(tts.audio.length / 8000) + 1;
    console.log(`\nunblocking in ${secs}s …`);
    setTimeout(async () => {
      try { await ng('unblock media', { 'call-id': CALL, 'from-tag': TAG || tags[0] }); console.log('unblocked\n'); } catch (e) {}
      process.exit(0);
    }, secs * 1000);
  } else {
    console.log('');
  }
}

main().catch(e => { console.error('\nspike failed:', e.message, '\n'); process.exit(1); });
