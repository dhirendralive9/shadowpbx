'use strict';
/**
 * The interpreter port.
 *
 * ShadowPBX listens on a second port purely for translation. An agent
 * application — the browser phone at /phone today, an Electron app later —
 * connects here, streams its microphone up as mu-law, and gets synthesised
 * speech in the customer's language back. The app then sends that synthesised
 * audio into the call in place of the microphone.
 *
 * Why this way round, when we already had a server-side pipeline working:
 *
 *   The agent's real voice must never reach the customer. Server-side, the
 *   only tool for that was rtpengine's own muting, and we established by
 *   direct test — five strategies, three runs each, plus an ordering test —
 *   that every mute applies *before* the fork point, so muting the agent's
 *   leg toward the customer also silences the tap we need for speech
 *   recognition. There is no ordering of those commands that gives both.
 *
 *   Terminating the media in the app sidesteps it entirely. The microphone
 *   never enters the call at all; what enters the call is audio we generated.
 *   The guarantee stops being a configuration we have to get right on every
 *   call and becomes a property of where the audio physically goes.
 *
 * What stays on this side of the wire:
 *
 *   Provider credentials. The app holds a single-use connect token, never a
 *   Deepgram or DeepL key, so a packaged desktop app can be handed to an agent
 *   — or decompiled by one — without exposing an account that bills by the
 *   minute. The languages are resolved from the extension's own settings when
 *   the token is minted, not taken from the socket, so a client cannot talk
 *   its way into a language pair it was not granted.
 *
 * Framing:
 *
 *   client -> server   binary          raw mu-law 8 kHz, any chunk size
 *                      JSON {type}     "start", "stop", "ping"
 *   server -> client   binary          0x01 | seq uint32be | mu-law payload
 *                      JSON {type}     "ready", "speech", "error", "stats"
 *
 *   Every "speech" JSON frame is followed by its binary frame. The sequence
 *   number ties the two together so the client can log what it is playing
 *   without depending on frame ordering holding forever.
 */
const http = require('http');
const crypto = require('crypto');
const logger = require('../utils/logger');
const tokens = require('./interpreter-tokens');
const { Direction } = require('./interpreter-pipeline');

const PORT          = parseInt(process.env.INTERPRETER_PORT || '', 10) || 3002;
const BIND          = process.env.INTERPRETER_BIND || '127.0.0.1';
const MAX_SESSIONS  = parseInt(process.env.INTERPRETER_MAX_SESSIONS || '', 10) || 20;
const MAX_CALL_MS   = parseInt(process.env.INTERPRETER_MAX_CALL_MS || '', 10) || 2 * 60 * 60 * 1000;
const FRAME_BYTES   = 160;        // 20ms of mu-law at 8 kHz

// ── Speech gating ─────────────────────────────────────────────────────────
//
// Deepgram bills for the audio we stream, and on a real call the agent is
// listening for most of it. Forwarding silence is money spent to transcribe
// nothing. So we only stream while there is something to hear.
//
// The trap in any gate is clipping the start of speech: by the time the
// energy rises enough to be sure, the first consonant is already gone, and
// "fünfzig" arrives as "ünfzig". We keep a rolling pre-roll and flush it when
// the gate opens, so the recogniser receives the onset it needs. The tail
// keeps the gate open through the short gaps inside a sentence rather than
// chopping it into fragments.
const GATE_OPEN_RMS  = parseFloat(process.env.INTERPRETER_GATE_RMS || '') || 900;
const GATE_TAIL_MS   = parseInt(process.env.INTERPRETER_GATE_TAIL_MS || '', 10) || 700;
const PREROLL_FRAMES = 15;        // 300ms

// G.711 mu-law expansion, the ITU reference form. Worth spelling out rather
// than approximating: the gate's threshold is only meaningful if the sample
// values it squares are the real ones.
const ulaw2lin = (() => {
  const BIAS = 0x84;
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    let v = ((u & 0x0f) << 3) + BIAS;
    v <<= (u & 0x70) >> 4;
    t[i] = (u & 0x80) ? (BIAS - v) : (v - BIAS);
  }
  return t;
})();

function rms(mulaw) {
  if (!mulaw.length) return 0;
  let sum = 0;
  for (let i = 0; i < mulaw.length; i++) {
    const s = ulaw2lin[mulaw[i]];
    sum += s * s;
  }
  return Math.sqrt(sum / mulaw.length);
}


/** One connected agent application. */
class InterpreterSocket {
  constructor(ws, req, server) {
    this.ws = ws;
    this.server = server;
    this.id = crypto.randomBytes(6).toString('hex');
    this.ip = (req.headers['x-real-ip'] || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    this.extension = null;
    this.user = null;
    this.callId = null;
    this.direction = null;
    this.started = false;
    this.closed = false;
    this.seq = 0;

    this.gateOpen = false;
    this.gateUntil = 0;
    this.preroll = [];
    this.partial = Buffer.alloc(0);

    this.stats = { framesIn: 0, framesGated: 0, bytesIn: 0, spoken: 0, errors: 0, openedAt: Date.now() };

    // A socket that connects and never authenticates is a socket holding a
    // slot. Give it a few seconds and no more.
    this.helloTimer = setTimeout(() => {
      if (!this.started) this.reject('no start frame', 1008);
    }, 10000);

    // Hard ceiling. A forgotten tab left streaming overnight would otherwise
    // bill for the night.
    this.lifeTimer = setTimeout(() => {
      logger.warn(`INTERPRETER-WS[${this.id}]: session hit the ${Math.round(MAX_CALL_MS / 60000)}min ceiling — closing`);
      this.send({ type: 'error', fatal: true, error: 'Session time limit reached' });
      this.close(1000, 'time limit');
    }, MAX_CALL_MS);

    this.alive = true;
    ws.on('pong', () => { this.alive = true; });
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => this.onClose());
    ws.on('error', (e) => { logger.warn(`INTERPRETER-WS[${this.id}]: socket error: ${e.message}`); });
  }

  send(obj) {
    if (this.closed || this.ws.readyState !== 1) return;
    try { this.ws.send(JSON.stringify(obj)); } catch (e) {}
  }

  sendAudio(mulaw) {
    if (this.closed || this.ws.readyState !== 1) return;
    const seq = (this.seq = (this.seq + 1) >>> 0);
    const head = Buffer.alloc(5);
    head[0] = 0x01;
    head.writeUInt32BE(seq, 1);
    try { this.ws.send(Buffer.concat([head, mulaw]), { binary: true }); } catch (e) {}
    return seq;
  }

  reject(why, code) {
    logger.warn(`INTERPRETER-WS[${this.id}]: rejected from ${this.ip} — ${why}`);
    this.send({ type: 'error', fatal: true, error: why });
    this.close(code || 1008, why);
  }

  onMessage(data, isBinary) {
    if (this.closed) return;
    if (isBinary) return this.onAudio(Buffer.isBuffer(data) ? data : Buffer.from(data));

    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (m.type === 'ping') return this.send({ type: 'pong', t: m.t });
    if (m.type === 'stop') return this.close(1000, 'client stop');
    if (m.type === 'start') return this.onStart(m);
  }

  onStart(m) {
    if (this.started) return;                       // one call per socket
    clearTimeout(this.helloTimer);

    const grant = tokens.consume(m.token);
    if (!grant) return this.reject('Invalid or expired token', 1008);

    // One live session per extension. A second tab, or a reconnect after a
    // crash, replaces the first rather than doubling the bill and splitting
    // the agent's speech across two recognisers.
    const existing = this.server.byExtension.get(grant.extension);
    if (existing && existing !== this) {
      logger.info(`INTERPRETER-WS[${this.id}]: replacing existing session for ${grant.extension}`);
      existing.send({ type: 'error', fatal: true, error: 'Replaced by a newer session' });
      existing.close(1000, 'replaced');
    }

    let live = 0;
    for (const s of this.server.sockets) if (s !== this && s.started && !s.closed) live++;
    if (live >= MAX_SESSIONS) {
      return this.reject('Server is at its translation session limit', 1013);
    }

    this.extension = grant.extension;
    this.user = grant.user;
    this.callId = String(m.callId || '').slice(0, 128) || `ws-${this.id}`;
    this.server.byExtension.set(this.extension, this);

    // Languages come from the token, not the socket. The client may say what
    // it thinks they are; it does not get to decide.
    const agentLang    = (grant.languages.agent || 'en').toLowerCase();
    const customerLang = (grant.languages.customer || 'auto').toLowerCase();
    const target       = (customerLang === 'auto' ? 'en' : customerLang).toUpperCase();

    this.direction = new Direction({
      name: `${this.extension}:agent->cust`,
      sourceLang: agentLang,
      targetLang: target,
      voiceGender: grant.voiceGender,
      onSpeech: (audio, translated, said) => {
        this.stats.spoken++;
        const seq = this.sendAudio(audio);
        this.send({
          type: 'speech', seq,
          bytes: audio.length,
          ms: Math.round(audio.length / 8),
          said, text: translated
        });
      },
      onError: (e) => {
        this.stats.errors++;
        // Not fatal: the socket stays up so the next utterance can succeed.
        // The client decides what to do about a run of these.
        this.send({ type: 'error', fatal: false, error: e.message });
      }
    });
    this.direction.start();
    this.started = true;

    logger.info(`INTERPRETER-WS[${this.id}]: ${this.user} ext ${this.extension} from ${this.ip} — ${agentLang} -> ${target} (call ${this.callId})`);
    this.send({
      type: 'ready',
      sessionId: this.id,
      extension: this.extension,
      agentLanguage: agentLang,
      targetLanguage: target,
      frameBytes: FRAME_BYTES,
      sampleRate: 8000,
      encoding: 'mulaw'
    });
  }

  onAudio(chunk) {
    if (!this.started || !this.direction) return;
    this.stats.bytesIn += chunk.length;

    // Normalise to 20ms frames regardless of what the client sends, so the
    // gate and the pre-roll work in units of time rather than units of
    // whatever the browser's audio thread happened to hand us.
    let buf = this.partial.length ? Buffer.concat([this.partial, chunk]) : chunk;
    let off = 0;
    for (; off + FRAME_BYTES <= buf.length; off += FRAME_BYTES) {
      this.onFrame(buf.subarray(off, off + FRAME_BYTES));
    }
    this.partial = off < buf.length ? Buffer.from(buf.subarray(off)) : Buffer.alloc(0);
  }

  onFrame(frame) {
    this.stats.framesIn++;
    const now = Date.now();
    const loud = rms(frame) >= GATE_OPEN_RMS;

    if (loud) {
      if (!this.gateOpen) {
        this.gateOpen = true;
        // Flush the onset we were holding, oldest first, so the recogniser
        // hears the whole word rather than its second half.
        for (const f of this.preroll) this.direction.write(f);
        this.preroll.length = 0;
      }
      this.gateUntil = now + GATE_TAIL_MS;
    } else if (this.gateOpen && now > this.gateUntil) {
      this.gateOpen = false;
    }

    if (this.gateOpen) {
      this.direction.write(frame);
    } else {
      this.stats.framesGated++;
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();
    }
  }

  onClose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.helloTimer);
    clearTimeout(this.lifeTimer);
    try { if (this.direction) this.direction.close(); } catch (e) {}
    this.direction = null;
    this.server.sockets.delete(this);
    if (this.extension && this.server.byExtension.get(this.extension) === this) {
      this.server.byExtension.delete(this.extension);
    }
    if (this.started) {
      const secs = Math.round((Date.now() - this.stats.openedAt) / 1000);
      const streamed = Math.round((this.stats.framesIn - this.stats.framesGated) * 0.02);
      logger.info(`INTERPRETER-WS[${this.id}]: closed after ${secs}s — ${this.stats.spoken} utterances, ${streamed}s of audio streamed of ${Math.round(this.stats.framesIn * 0.02)}s captured, ${this.stats.errors} errors`);
    }
  }

  close(code, why) {
    this.onClose();
    try { this.ws.close(code || 1000, why || ''); } catch (e) {}
  }
}


class InterpreterServer {
  constructor() {
    this.sockets = new Set();
    this.byExtension = new Map();
    this.http = null;
    this.wss = null;
    this.pinger = null;
    this.attached = new Set();
  }

  start() {
    let WebSocketServer;
    try { ({ WebSocketServer } = require('ws')); }
    catch (e) {
      logger.error('INTERPRETER-WS: the "ws" module is not installed — the interpreter port will not open. Run: npm install');
      return null;
    }

    // A plain HTTP server so a health probe works and so nginx can terminate
    // TLS in front of it. The port is bound to loopback by default: in
    // production the browser and the desktop app both arrive through nginx
    // over WSS, and an interpreter port open to the internet is an audio
    // socket open to the internet.
    this.http = http.createServer((req, res) => {
      if (req.url === '/health' || req.url === '/interpreter/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: true, sessions: this.sockets.size, limit: MAX_SESSIONS
        }));
      }
      res.writeHead(404).end();
    });

    // noServer, then attached by hand to each listener. The main API port
    // already has Socket.IO on it, and two libraries each owning the
    // "upgrade" event is how one of them silently stops working.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
    this.wss.on('connection', (ws, req) => {
      const sock = new InterpreterSocket(ws, req, this);
      this.sockets.add(sock);
    });
    this.attach(this.http);

    // Half-open sockets are the normal failure on mobile and VPN links: the
    // peer is gone but the TCP connection never closes, so the slot and the
    // Deepgram connection behind it stay alive. Ping, and drop what does not
    // answer.
    this.pinger = setInterval(() => {
      for (const s of this.sockets) {
        if (!s.alive) { logger.warn(`INTERPRETER-WS[${s.id}]: no pong — dropping`); s.close(1001, 'no pong'); continue; }
        s.alive = false;
        try { s.ws.ping(); } catch (e) {}
      }
    }, 20000);
    if (this.pinger.unref) this.pinger.unref();

    this.http.on('error', (e) => {
      logger.error(`INTERPRETER-WS: cannot listen on ${BIND}:${PORT}: ${e.message}`);
    });
    this.http.listen(PORT, BIND, () => {
      logger.info(`INTERPRETER-WS: interpreter port on ${BIND}:${PORT} (path /interpreter/ws, max ${MAX_SESSIONS} sessions)`);
    });
    return this;
  }

  /**
   * Also accept the upgrade on an existing server — in practice the main
   * API/GUI listener.
   *
   * The dedicated port above is the one a packaged desktop app connects to,
   * and the one an operator can firewall, rate-limit or move to its own
   * interface. But a browser on the /phone page is already talking to the
   * main vhost over TLS that nginx terminates, and sending it to a second
   * port would mean either a second certificate or a mixed-content failure.
   * Accepting the same path here means the browser phone works on an existing
   * deployment with no nginx change at all, while the separate port stays
   * available for the app. Same server object, same limits, same auth.
   *
   * Socket.IO is already listening for "upgrade" on that server and, for a
   * path it does not recognise, ends the socket after a second unless
   * something has written to it. We complete the handshake synchronously, so
   * by the time that check runs the connection is established and it leaves
   * us alone — but it is the reason this must not be made lazy.
   */
  attach(server) {
    if (!this.wss || this.attached.has(server)) return this;
    this.attached.add(server);
    server.on('upgrade', (req, socket, head) => {
      let pathname;
      try { pathname = new URL(req.url, 'http://localhost').pathname; } catch (e) { return; }
      if (pathname !== '/interpreter/ws') return;        // not ours; leave it be
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    return this;
  }

  /** Does this extension have a live interpreter socket right now? */
  isLive(extension) {
    const s = this.byExtension.get(String(extension));
    return !!(s && !s.closed && s.started);
  }

  report() {
    return {
      port: PORT, bind: BIND, limit: MAX_SESSIONS,
      sessions: [...this.sockets].filter(s => s.started).map(s => ({
        id: s.id, extension: s.extension, user: s.user, callId: s.callId,
        upSeconds: Math.round((Date.now() - s.stats.openedAt) / 1000),
        utterances: s.stats.spoken, errors: s.stats.errors
      }))
    };
  }

  stop() {
    clearInterval(this.pinger);
    for (const s of [...this.sockets]) s.close(1001, 'server shutting down');
    try { if (this.wss) this.wss.close(); } catch (e) {}
    try { if (this.http) this.http.close(); } catch (e) {}
  }
}

module.exports = { InterpreterServer, PORT, BIND };
