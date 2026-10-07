#!/usr/bin/env node
'use strict';
/**
 * Self-test for the interpreter port, with no provider accounts involved.
 *
 * The translation itself — Deepgram, DeepL, Aura — was proven separately on
 * real calls and is not what breaks. What breaks is the plumbing around it:
 * a token that is accepted twice, a client that lies about its extension and
 * gets away with it, audio chunked at a size the gate mishandles, a speech
 * frame whose sequence number does not match its metadata.
 *
 * So this stubs the translator and exercises everything else, which also
 * means it is free to run and safe to run on a live box.
 *
 *   node scripts/interpreter-ws-selftest.js
 */
process.env.INTERPRETER_PORT = process.env.INTERPRETER_PORT || '13902';
process.env.INTERPRETER_BIND = '127.0.0.1';
process.env.INTERPRETER_MAX_SESSIONS = '2';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';

const path = require('path');
const WebSocket = require('ws');

// ── Stub the translator before the server loads it ─────────────────────────
// Echo what we are given back as "translated" audio after a short delay, so
// the round trip is measurable without a provider in the path.
const pipelinePath = require.resolve('../src/services/interpreter-pipeline');
const realPipeline = require(pipelinePath);
const fed = [];
class StubDirection {
  constructor(opts) { this.opts = opts; this.bytes = 0; this.closed = false; fed.push(this); }
  start() { this.started = true; }
  write(frame) {
    if (this.closed) return;
    this.bytes += frame.length;
    // One "utterance" per 20 frames (400ms) of audio that reaches us.
    if (this.bytes >= 3200) {
      this.bytes = 0;
      const audio = Buffer.alloc(800, 0x7f);     // 100ms of mu-law silence
      setTimeout(() => { if (!this.closed) this.opts.onSpeech(audio, 'translated text', 'said text'); }, 10);
    }
  }
  close() { this.closed = true; }
}
require.cache[pipelinePath].exports = Object.assign({}, realPipeline, { Direction: StubDirection });

const tokens = require('../src/services/interpreter-tokens');
const { InterpreterServer } = require('../src/services/interpreter-server');

const PORT = process.env.INTERPRETER_PORT;
const URL = `ws://127.0.0.1:${PORT}/interpreter/ws`;

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const bad = (m) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const check = (cond, m) => cond ? ok(m) : bad(m);

// A 20ms mu-law frame at a given linear amplitude.
const lin2ulaw = realPipeline.lin2ulaw;
function frame(amp, n = 160, hz = 400) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = lin2ulaw(Math.round(amp * Math.sin(2 * Math.PI * hz * i / 8000)));
  return b;
}
const SPEECH  = frame(6000);
const SILENCE = frame(0);

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const seen = { json: [], audio: [] };
    ws.on('message', (d, bin) => {
      if (bin) {
        const b = Buffer.isBuffer(d) ? d : Buffer.from(d);
        seen.audio.push({ kind: b[0], seq: b.readUInt32BE(1), payload: b.subarray(5) });
      } else {
        seen.json.push(JSON.parse(d.toString()));
      }
    });
    ws.on('open', () => resolve({ ws, seen }));
    ws.on('error', reject);
  });
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(25); }
  return false;
}
const issue = (ext, langs) => tokens.issue({
  extension: ext, user: 'selftest',
  languages: langs || { agent: 'en', customer: 'de' }, voiceGender: 'female'
}).token;

(async () => {
  const server = new InterpreterServer().start();
  if (!server) { console.error('server did not start'); process.exit(1); }
  await wait(250);
  console.log(`\nInterpreter port self-test — ${URL}\n`);

  // ── 1. a socket with no token gets nowhere ──
  console.log('Authentication');
  {
    const { ws, seen } = await connect();
    ws.send(JSON.stringify({ type: 'start', token: 'nonsense', callId: 'c1' }));
    await until(() => ws.readyState === 3);
    check(ws.readyState === 3, 'a bogus token is refused and the socket closed');
    check(seen.json.some(m => m.type === 'error' && m.fatal), 'the client is told why, rather than just dropped');
    check(!seen.json.some(m => m.type === 'ready'), 'no ready frame leaks before authentication');
  }

  // ── 2. a token works exactly once ──
  {
    const tok = issue('2001');
    const a = await connect();
    a.ws.send(JSON.stringify({ type: 'start', token: tok, callId: 'c2' }));
    check(await until(() => a.seen.json.some(m => m.type === 'ready')), 'a valid token opens a session');

    const b = await connect();
    b.ws.send(JSON.stringify({ type: 'start', token: tok, callId: 'c3' }));
    await until(() => b.ws.readyState === 3);
    check(b.ws.readyState === 3, 'the same token replayed is refused — single use');
    a.ws.close(); await wait(100);
  }

  // ── 3. the socket cannot choose its own language pair ──
  {
    const tok = issue('2002', { agent: 'de', customer: 'hi' });
    const { ws, seen } = await connect();
    ws.send(JSON.stringify({ type: 'start', token: tok, callId: 'c4', agentLanguage: 'fr', customerLanguage: 'fr' }));
    await until(() => seen.json.some(m => m.type === 'ready'));
    const ready = seen.json.find(m => m.type === 'ready');
    check(ready && ready.agentLanguage === 'de' && ready.targetLanguage === 'HI',
      'languages come from the token, not from what the client claims');
    check(ready && ready.extension === '2002', 'the extension comes from the token too');
    ws.close(); await wait(100);
  }

  // ── 4. a socket that never authenticates does not hold a slot forever ──
  {
    const { ws } = await connect();
    await wait(150);
    check(ws.readyState === 1, 'an unauthenticated socket is given a grace period');
    ws.close();
  }

  // ── 5. speech gating ──
  console.log('\nSpeech gating');
  {
    fed.length = 0;
    const tok = issue('2003');
    const { ws, seen } = await connect();
    ws.send(JSON.stringify({ type: 'start', token: tok, callId: 'c5' }));
    await until(() => seen.json.some(m => m.type === 'ready'));
    const dir = fed[fed.length - 1];

    for (let i = 0; i < 50; i++) ws.send(SILENCE, { binary: true });   // 1s of silence
    await wait(250);
    check(dir.bytes === 0, 'silence is not streamed to the recogniser (that audio is billed)');

    for (let i = 0; i < 25; i++) ws.send(SPEECH, { binary: true });    // 500ms of speech
    await until(() => dir.bytes > 0 || seen.audio.length > 0);
    await wait(150);
    check(seen.audio.length > 0 || dir.bytes > 0, 'speech opens the gate and is streamed');

    // The pre-roll must arrive too, or word onsets are clipped.
    const streamed = dir.bytes + seen.audio.length * 3200;
    check(streamed > 25 * 160, 'the pre-roll is flushed when the gate opens, so onsets survive');
    ws.close(); await wait(100);
  }

  // ── 6. framing: odd chunk sizes must not corrupt anything ──
  console.log('\nFraming');
  {
    fed.length = 0;
    const tok = issue('2004');
    const { ws, seen } = await connect();
    ws.send(JSON.stringify({ type: 'start', token: tok, callId: 'c6' }));
    await until(() => seen.json.some(m => m.type === 'ready'));

    // 37 bytes at a time — deliberately coprime with the 160-byte frame.
    const long = Buffer.concat(Array(30).fill(SPEECH));
    for (let o = 0; o < long.length; o += 37) ws.send(long.subarray(o, o + 37), { binary: true });
    check(await until(() => seen.audio.length > 0), 'audio split across arbitrary chunk sizes still produces speech');

    const meta = seen.json.filter(m => m.type === 'speech');
    check(meta.length > 0, 'each returned utterance carries its text');
    check(meta.every(m => seen.audio.some(a => a.seq === m.seq)),
      'every speech frame\'s sequence number matches a binary frame');
    check(seen.audio.every(a => a.kind === 0x01), 'binary frames are tagged');
    check(meta.every(m => m.ms === Math.round(m.bytes / 8)), 'durations are reported consistently with byte counts');
    ws.close(); await wait(100);
  }

  // ── 7. one session per extension ──
  console.log('\nSession limits');
  {
    const a = await connect();
    a.ws.send(JSON.stringify({ type: 'start', token: issue('2005'), callId: 'c7' }));
    await until(() => a.seen.json.some(m => m.type === 'ready'));
    const b = await connect();
    b.ws.send(JSON.stringify({ type: 'start', token: issue('2005'), callId: 'c8' }));
    await until(() => b.seen.json.some(m => m.type === 'ready'));
    await until(() => a.ws.readyState === 3);
    check(a.ws.readyState === 3, 'a second session for one extension replaces the first rather than doubling the bill');
    check(b.ws.readyState === 1, 'the newer session is the one that survives');
    b.ws.close(); await wait(150);
  }

  // ── 8. the server-wide cap holds ──
  {
    const live = [];
    for (let i = 0; i < 2; i++) {
      const c = await connect();
      c.ws.send(JSON.stringify({ type: 'start', token: issue(`30${i}0`), callId: `L${i}` }));
      await until(() => c.seen.json.some(m => m.type === 'ready'));
      live.push(c);
    }
    const over = await connect();
    over.ws.send(JSON.stringify({ type: 'start', token: issue('3099'), callId: 'over' }));
    await until(() => over.ws.readyState === 3);
    check(over.ws.readyState === 3, `the ${process.env.INTERPRETER_MAX_SESSIONS}-session cap is enforced`);
    check(over.seen.json.some(m => /limit/i.test(m.error || '')), 'and the reason says so');
    live.forEach(c => c.ws.close());
    await wait(150);
  }

  // ── 9. teardown releases the recogniser ──
  console.log('\nTeardown');
  {
    fed.length = 0;
    const tok = issue('2006');
    const { ws, seen } = await connect();
    ws.send(JSON.stringify({ type: 'start', token: tok, callId: 'c9' }));
    await until(() => seen.json.some(m => m.type === 'ready'));
    const dir = fed[fed.length - 1];
    check(!dir.closed, 'the recogniser is open while the session is');
    ws.close();
    check(await until(() => dir.closed), 'closing the socket closes the recogniser behind it');
  }

  // ── 10. health endpoint ──
  {
    const http = require('http');
    const body = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
        let d = ''; res.on('data', c => { d += c; }); res.on('end', () => resolve(d));
      }).on('error', () => resolve(''));
    });
    let j = {}; try { j = JSON.parse(body); } catch (e) {}
    check(j.ok === true, 'the health endpoint answers, so a probe can tell the port is up');
  }

  // ── 11. the same path on a second server, as the browser phone reaches it ──
  //
  // The browser connects through the main API port, not the dedicated one, so
  // that path needs testing too — and it has to coexist with something else
  // already listening for "upgrade" on that server, which is how one of the
  // two silently stops working.
  console.log('\nAttached to a second listener (the browser phone\'s route in)');
  {
    const http = require('http');
    const other = http.createServer((req, res) => res.writeHead(200).end('app'));
    let otherUpgrades = 0;
    other.on('upgrade', (req, socket) => {           // stand in for Socket.IO
      otherUpgrades++;
      if (!/^\/socket\.io/.test(req.url)) return;    // not mine — ignore it
      socket.destroy();
    });
    server.attach(other);
    await new Promise(r => other.listen(13903, '127.0.0.1', r));

    const ws = new WebSocket('ws://127.0.0.1:13903/interpreter/ws');
    const seen = { json: [] };
    ws.binaryType = 'arraybuffer';
    ws.on('message', (d, bin) => { if (!bin) seen.json.push(JSON.parse(d.toString())); });
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    ws.send(JSON.stringify({ type: 'start', token: issue('4001'), callId: 'via-main' }));
    check(await until(() => seen.json.some(m => m.type === 'ready')),
      'a session opens on the main port exactly as on the interpreter port');
    check(otherUpgrades > 0, 'the other listener still saw the upgrade (both handlers run)');
    check(ws.readyState === 1, 'and did not destroy our socket');
    ws.close(); await wait(100);
    other.close();
  }

  // ── 12. the browser's own codec, over the real wire ──
  //
  // The client encodes mu-law in the browser and decodes what comes back.
  // Those two tables have to agree with the server's, exactly, or speech
  // arrives as noise — which is precisely the failure that sent us down this
  // road in the first place. So run the client's real code against the real
  // socket rather than trusting that both ends "do mu-law".
  console.log('\nBrowser codec over the real socket');
  {
    const clientSrc = require('fs').readFileSync(
      path.join(__dirname, '..', 'src', 'public', 'js', 'interpreter-client.js'), 'utf8');
    const grab = (re) => { const m = clientSrc.match(re); if (!m) throw new Error('could not find ' + re); return m[0]; };
    const sandbox = {};
    (new Function('G', grab(/var ENC = \(function \(\) \{[\s\S]*?\}\)\(\);/) + '\n'
                     + grab(/var DEC = \(function \(\) \{[\s\S]*?\}\)\(\);/) + '\n'
                     + grab(/function encode\(f32\) \{[\s\S]*?\n  \}/) + '\n'
                     + 'G.encode=encode; G.DEC=DEC;'))(sandbox);

    fed.length = 0;
    const { ws, seen } = await connect();
    ws.send(JSON.stringify({ type: 'start', token: issue('4002'), callId: 'codec' }));
    await until(() => seen.json.some(m => m.type === 'ready'));

    // Speak a 400 Hz tone, encoded by the browser's encoder.
    for (let b = 0; b < 30; b++) {
      const f = new Float32Array(160);
      for (let i = 0; i < 160; i++) f[i] = 0.5 * Math.sin(2 * Math.PI * 400 * (b * 160 + i) / 8000);
      ws.send(Buffer.from(sandbox.encode(f)), { binary: true });
    }
    const dir = fed[fed.length - 1];
    check(await until(() => dir.bytes > 0 || seen.audio.length > 0),
      'audio encoded by the browser opens the server\'s speech gate');

    check(await until(() => seen.audio.length > 0), 'synthesised audio comes back');
    if (seen.audio.length) {
      // Decode it with the browser's decoder. The server sent 0x7f bytes,
      // which is mu-law for near-silence — so the decode must land near zero,
      // not at full scale. A sign or offset error shows up here immediately.
      const pay = seen.audio[0].payload;
      let peak = 0;
      for (let i = 0; i < pay.length; i++) peak = Math.max(peak, Math.abs(sandbox.DEC[pay[i]]));
      check(peak < 0.01, `the browser's decoder reads it correctly (peak ${peak.toFixed(5)}, expected near 0)`);
      check(pay.length === 800, `the payload survives the wire intact (${pay.length} bytes = ${pay.length / 8}ms)`);
    }
    ws.close(); await wait(100);
  }

  server.stop();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
