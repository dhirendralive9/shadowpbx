#!/usr/bin/env node
'use strict';
/**
 * Phase-3 spike — text to speech, in a voice that matches the speaker.
 *
 * Takes translated text and produces 8 kHz mu-law audio ready to inject into a
 * call. Two things matter beyond "does it make sound":
 *
 *  1. VOICE GENDER. Hearing a man's words come back in a woman's voice breaks
 *     the illusion that you are hearing THAT person. Deepgram's STT does not
 *     report speaker gender, so we estimate it from the pitch of the speaker's
 *     own audio (which we already have from the tap) and pick a matching Aura
 *     voice. Pitch is a decent proxy, not a certainty — see estimateGender().
 *
 *  2. FORMAT. Aura can emit mulaw/8000 directly, which is exactly what the RTP
 *     leg wants, so there is no resampling or transcoding step to get wrong.
 *
 *   # synthesise a phrase and save it
 *   node scripts/interpreter-tts-spike.js --text "Guten Morgen" --lang de --gender female
 *
 *   # measure pitch of a live caller, then speak in a matching voice
 *   node scripts/interpreter-tts-spike.js --call '<id>' --text "..." --lang de
 *
 *   # list the voices
 *   node scripts/interpreter-tts-spike.js --voices
 */
const dgram = require('dgram');
const https = require('https');
const fs = require('fs');
const os = require('os');
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
const TEXT = argOf('--text') || 'Guten Morgen, wie kann ich Ihnen helfen?';
const LANG = (argOf('--lang') || 'de').toLowerCase();
const WANT_GENDER = (argOf('--gender') || '').toLowerCase();
const WANT_CALL = argOf('--call');
const WANT_TAG = argOf('--tag');
const LISTEN_SECS = parseInt(argOf('--listen') || '8', 10);

// Aura-2 voices, grouped so we can pick by language + gender. Deepgram has
// many more English voices; these are the conversational ones suited to a
// support call rather than narration.
const VOICES = {
  en: {
    female: ['aura-2-thalia-en', 'aura-2-luna-en', 'aura-2-athena-en', 'aura-2-hera-en'],
    male:   ['aura-2-apollo-en', 'aura-2-arcas-en', 'aura-2-orion-en', 'aura-2-atlas-en']
  },
  de: {
    female: ['aura-2-viktoria-de', 'aura-2-elara-de'],
    male:   ['aura-2-julius-de']
  },
  es: { female: ['aura-2-celeste-es'], male: ['aura-2-nestor-es'] },
  fr: { female: ['aura-2-pandora-fr'], male: ['aura-2-alcyone-fr'] },
  nl: { female: ['aura-2-beatrix-nl'], male: ['aura-2-lars-nl'] }
};

function pickVoice(lang, gender) {
  const l = VOICES[lang] || VOICES.en;
  const g = (gender === 'male' || gender === 'female') ? gender : 'female';
  const list = l[g] && l[g].length ? l[g] : (l.female || l.male);
  return list[0];
}

// ── pitch -> gender ─────────────────────────────────────────────────────
// Estimate the fundamental frequency by autocorrelation over voiced frames.
// Adult male speech typically centres near 85-155 Hz and female near 165-255 Hz,
// so the midpoint is a usable split. It is NOT reliable for everyone: the bands
// overlap around 160-180 Hz, children read high, and a phone line rolls off
// below 300 Hz which weakens the fundamental. So we report a confidence and
// fall back to the configured default when the estimate is marginal, rather
// than guessing confidently and getting it audibly wrong.
function estimateF0(pcm, rate) {
  const MINF = 70, MAXF = 300;
  const minLag = Math.floor(rate / MAXF), maxLag = Math.floor(rate / MINF);
  const frame = 1024;
  const vals = [];
  for (let start = 0; start + frame + maxLag < pcm.length; start += frame * 2) {
    // energy gate: ignore silence
    let energy = 0;
    for (let i = 0; i < frame; i++) energy += Math.abs(pcm[start + i]);
    energy /= frame;
    if (energy < 400) continue;

    let bestLag = 0, best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < frame; i++) sum += pcm[start + i] * pcm[start + i + lag];
      if (sum > best) { best = sum; bestLag = lag; }
    }
    // normalised peak: reject frames with no clear periodicity (unvoiced)
    let e0 = 0;
    for (let i = 0; i < frame; i++) e0 += pcm[start + i] * pcm[start + i];
    if (bestLag && e0 > 0 && best / e0 > 0.3) vals.push(rate / bestLag);
  }
  if (!vals.length) return null;
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length / 2)];   // median resists octave errors
}

function estimateGender(f0) {
  if (!f0) return { gender: null, confidence: 0, f0: null };
  if (f0 < 145) return { gender: 'male', confidence: f0 < 125 ? 'high' : 'medium', f0 };
  if (f0 > 185) return { gender: 'female', confidence: f0 > 205 ? 'high' : 'medium', f0 };
  return { gender: f0 < 165 ? 'male' : 'female', confidence: 'low', f0 };
}

const ulaw2lin = (u) => {
  u = ~u & 0xff;
  const sign = u & 0x80, exp = (u >> 4) & 0x07, man = u & 0x0f;
  let s = (((man << 3) + 0x84) << exp) - 0x84;
  return sign ? -s : s;
};

// ── Deepgram TTS ────────────────────────────────────────────────────────
function speak(text, voice) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const q = `model=${voice}&encoding=mulaw&sample_rate=8000&container=none`;
    const t0 = Date.now();
    let firstByteAt = 0;
    const req = https.request({
      method: 'POST', hostname: 'api.deepgram.com', path: `/v1/speak?${q}`,
      headers: {
        'Authorization': `Token ${DG_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }, timeout: 20000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => { if (!firstByteAt) firstByteAt = Date.now(); chunks.push(c); });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) return reject(new Error(`Deepgram ${res.statusCode}: ${buf.toString().slice(0, 200)}`));
        resolve({ audio: buf, ttfbMs: firstByteAt - t0, totalMs: Date.now() - t0 });
      });
    });
    req.on('timeout', () => req.destroy(new Error('TTS timeout')));
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ── ng helpers (same as the tap spike) ──────────────────────────────────
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
    const col = str.indexOf(':', i), len = parseInt(str.slice(i, col), 10);
    const s = str.slice(col + 1, col + 1 + len); i = col + 1 + len; return s;
  }
  try { return val(); } catch (e) { return null; }
}
function ng(command, params) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    const t = setTimeout(() => { try { sock.close(); } catch (e) {} reject(new Error('ng timeout')); }, 5000);
    sock.on('message', (d) => {
      clearTimeout(t); const s = d.toString(), sp = s.indexOf(' ');
      try { sock.close(); } catch (e) {}
      resolve(sp < 0 ? null : bdecode(s.slice(sp + 1)));
    });
    sock.on('error', (e) => { clearTimeout(t); reject(e); });
    sock.send(Buffer.from(`${Math.random().toString(36).slice(2, 10)} ${bencode(Object.assign({ command }, params))}`),
      NG_PORT, NG_HOST, (e) => { if (e) { clearTimeout(t); reject(e); } });
  });
}
function localIp() {
  if (process.env.EXTERNAL_IP) return process.env.EXTERNAL_IP;
  const ifs = os.networkInterfaces();
  for (const n of Object.keys(ifs)) for (const a of ifs[n]) if (a.family === 'IPv4' && !a.internal) return a.address;
  return '127.0.0.1';
}

// Listen to a live leg briefly and measure the speaker's pitch.
async function measureSpeaker(callId, tag, secs) {
  const sink = dgram.createSocket('udp4');
  await new Promise(r => sink.bind(0, '0.0.0.0', r));
  const port = sink.address().port, ip = localIp();

  const attempts = [];
  if (tag) attempts.push({ 'from-tags': [tag] });
  else {
    const q = await ng('query', { 'call-id': callId });
    const tags = q && q.tags ? Object.keys(q.tags).filter(t => t && t !== '0' && !/^<untagged/.test(t)) : [];
    for (const t of tags) attempts.push({ 'from-tags': [t] });
  }
  let sub = null;
  for (const a of attempts) {
    const r = await ng('subscribe request', Object.assign({ 'call-id': callId }, a));
    if (r && r.sdp) { sub = r; break; }
  }
  if (!sub) { try { sink.close(); } catch (e) {} return null; }
  const toTag = sub['to-tag'] || sub.tag;

  const answer = sub.sdp.split(/\r?\n/).filter(Boolean).map((line) => {
    if (line.startsWith('c=')) return `c=IN IP4 ${ip}`;
    if (line.startsWith('o=')) { const p = line.split(' '); if (p.length >= 6) { p[5] = ip; return p.join(' '); } return `o=- 0 0 IN IP4 ${ip}`; }
    if (line.startsWith('m=audio')) { const p = line.split(' '); p[1] = String(port); return p.join(' '); }
    if (/^a=(candidate|ice-|fingerprint|setup|rtcp:)/.test(line)) return null;
    if (line === 'a=sendrecv' || line === 'a=sendonly') return 'a=recvonly';
    return line;
  }).filter(Boolean).join('\r\n') + '\r\n';

  await ng('subscribe answer', { 'call-id': callId, 'to-tag': toTag, sdp: answer, flags: ['trust-address'], ICE: 'remove' });

  const pcm = [];
  sink.on('message', (buf) => {
    if (buf.length < 13) return;
    const csrc = buf[0] & 0x0f, ext = (buf[0] >> 4) & 0x01;
    let off = 12 + csrc * 4;
    if (ext && buf.length > off + 4) off += 4 + buf.readUInt16BE(off + 2) * 4;
    const b = buf.subarray(off);
    for (let i = 0; i < b.length; i++) pcm.push(ulaw2lin(b[i]));
  });

  console.log(`listening ${secs}s to the speaker to estimate pitch — have them talk…`);
  await new Promise(r => setTimeout(r, secs * 1000));
  try { await ng('unsubscribe', { 'call-id': callId, 'to-tag': toTag }); } catch (e) {}
  try { sink.close(); } catch (e) {}
  if (pcm.length < 8000) return null;
  return estimateF0(pcm, 8000);
}

async function main() {
  if (process.argv.includes('--voices')) {
    console.log('\nAura-2 voices available here:\n');
    for (const [l, g] of Object.entries(VOICES)) {
      console.log(`  ${l}:`);
      for (const [k, v] of Object.entries(g)) console.log(`    ${k.padEnd(7)} ${v.join(', ')}`);
    }
    console.log('');
    return;
  }
  if (!DG_KEY) { console.error('\nDEEPGRAM_API_KEY not set\n'); process.exit(1); }

  let gender = WANT_GENDER, detected = null;
  if (!gender && WANT_CALL) {
    const f0 = await measureSpeaker(WANT_CALL, WANT_TAG, LISTEN_SECS);
    detected = estimateGender(f0);
    if (detected.gender && detected.confidence !== 'low') gender = detected.gender;
    console.log('');
    if (f0) {
      console.log(`pitch         : ${Math.round(f0)} Hz  -> ${detected.gender} (${detected.confidence} confidence)`);
      if (detected.confidence === 'low') console.log(`                ambiguous range — using the default voice instead`);
    } else {
      console.log('pitch         : could not measure (no voiced audio) — using the default voice');
    }
  }

  const voice = pickVoice(LANG, gender);
  console.log(`voice         : ${voice}${gender ? ` (${gender})` : ' (default)'}`);
  console.log(`text          : ${TEXT}`);

  const r = await speak(TEXT, voice);
  const seconds = r.audio.length / 8000;          // mulaw 8k = 1 byte/sample
  const out = path.join('/tmp', `tts-${voice}-${Date.now()}.wav`);

  // wrap as WAV so it is playable; the raw bytes are what gets injected
  const pcm = Buffer.alloc(r.audio.length * 2);
  for (let i = 0; i < r.audio.length; i++) pcm.writeInt16LE(ulaw2lin(r.audio[i]), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(out, Buffer.concat([h, pcm]));
  fs.writeFileSync(out.replace(/\.wav$/, '.ulaw'), r.audio);

  console.log('');
  console.log('─'.repeat(58));
  console.log(`first byte    : ${r.ttfbMs}ms   (when playback could start)`);
  console.log(`complete      : ${r.totalMs}ms`);
  console.log(`audio         : ${seconds.toFixed(2)}s, ${r.audio.length} bytes mulaw/8000`);
  console.log(`wav           : ${out}`);
  console.log(`raw mulaw     : ${out.replace(/\.wav$/, '.ulaw')}   <- this is what gets injected`);
  console.log('─'.repeat(58));
  console.log('');
}

main().catch(e => { console.error('\nspike failed:', e.message, '\n'); process.exit(1); });
