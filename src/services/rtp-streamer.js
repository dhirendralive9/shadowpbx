'use strict';
/**
 * RTP streamer — emits audio into a call on a real-time clock.
 *
 * This is the piece the interpreter needs that rtpengine will not give us: the
 * ability to decide, packet by packet, what one party hears. rtpengine can mute
 * a leg or fork it, but never both, so for the direction where the original
 * voice must NEVER reach the far side, we have to send the audio ourselves.
 *
 * The hard part is not the packets, it is the CLOCK. Audio must leave every
 * 20ms; drift or bursts are heard immediately as stutter. setInterval is not
 * good enough on a loaded box (it accumulates lateness), so this schedules
 * against an absolute timeline and corrects on every tick.
 *
 *   const s = new RtpStreamer({ host, port, payloadType: 0 });
 *   s.start();
 *   s.queue(mulawBuffer);        // speak this
 *   s.queueSilence(500);         // 500ms of comfort noise
 *   s.stop();
 *
 * Silence is sent continuously when there is nothing to say, because a leg that
 * simply stops receiving RTP is treated as dead by most endpoints — they will
 * tear the call down or trigger their own comfort noise.
 */
const dgram = require('dgram');

const PTIME_MS = 20;
const SAMPLES_PER_PACKET = 160;        // 8 kHz * 20ms
const ULAW_SILENCE = 0xff;             // mu-law digital silence

class RtpStreamer {
  /**
   * @param {string} host       where to send (the far side's media address)
   * @param {number} port       their RTP port
   * @param {number} payloadType 0 = PCMU, 8 = PCMA
   * @param {number} ssrc       optional fixed SSRC; random if omitted
   * @param {boolean} sendSilence keep the stream alive when idle (default true)
   */
  constructor({ host, port, payloadType = 0, ssrc = null, sendSilence = true, socket = null } = {}) {
    if (!host || !port) throw new Error('RtpStreamer needs host and port');
    this.host = host;
    this.port = port;
    this.payloadType = payloadType;
    this.ssrc = ssrc || Math.floor(Math.random() * 0xffffffff);
    this.sendSilence = sendSilence;

    this.seq = Math.floor(Math.random() * 0xffff);
    this.timestamp = Math.floor(Math.random() * 0xffffffff);
    this.socket = socket;
    this.ownSocket = !socket;

    this.queueBuf = [];          // pending audio, as 160-byte frames
    this.timer = null;
    this.nextAt = 0;
    this.stats = { sent: 0, silence: 0, late: 0, maxLateMs: 0, started: 0 };
    this._onDrain = null;
  }

  start() {
    if (this.timer) return;
    if (!this.socket) this.socket = dgram.createSocket('udp4');
    this.stats.started = Date.now();
    this.nextAt = Date.now();
    this._tick();
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ownSocket && this.socket) { try { this.socket.close(); } catch (e) {} this.socket = null; }
  }

  /** Queue mu-law/A-law audio (any length); it is split into 20ms frames. */
  queue(audio) {
    if (!audio || !audio.length) return;
    for (let off = 0; off < audio.length; off += SAMPLES_PER_PACKET) {
      let frame = audio.subarray(off, off + SAMPLES_PER_PACKET);
      if (frame.length < SAMPLES_PER_PACKET) {
        const pad = Buffer.alloc(SAMPLES_PER_PACKET, ULAW_SILENCE);
        frame.copy(pad, 0);
        frame = pad;
      }
      this.queueBuf.push(frame);
    }
  }

  queueSilence(ms) {
    const frames = Math.ceil(ms / PTIME_MS);
    for (let i = 0; i < frames; i++) this.queueBuf.push(Buffer.alloc(SAMPLES_PER_PACKET, ULAW_SILENCE));
  }

  /** Drop anything not yet sent — used when a turn is superseded. */
  flush() { this.queueBuf = []; }

  get pending() { return this.queueBuf.length; }
  get pendingMs() { return this.queueBuf.length * PTIME_MS; }

  /** Resolves when the queue has drained (i.e. the utterance finished playing). */
  whenDrained() {
    if (!this.queueBuf.length) return Promise.resolve();
    return new Promise(res => { this._onDrain = res; });
  }

  _packet(payload) {
    const h = Buffer.alloc(12);
    h[0] = 0x80;                                   // version 2
    h[1] = this.payloadType & 0x7f;
    h.writeUInt16BE(this.seq & 0xffff, 2);
    h.writeUInt32BE(this.timestamp >>> 0, 4);
    h.writeUInt32BE(this.ssrc >>> 0, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + SAMPLES_PER_PACKET) >>> 0;
    return Buffer.concat([h, payload]);
  }

  _tick() {
    const now = Date.now();
    const late = now - this.nextAt;
    if (late > 0) {
      this.stats.late++;
      if (late > this.stats.maxLateMs) this.stats.maxLateMs = late;
    }

    let payload = this.queueBuf.shift();
    if (!payload) {
      if (!this.sendSilence) { this.nextAt += PTIME_MS; this._schedule(); return; }
      payload = Buffer.alloc(SAMPLES_PER_PACKET, ULAW_SILENCE);
      this.stats.silence++;
    } else if (!this.queueBuf.length && this._onDrain) {
      const cb = this._onDrain; this._onDrain = null;
      setImmediate(cb);
    }

    if (this.socket) {
      this.socket.send(this._packet(payload), this.port, this.host, () => {});
      this.stats.sent++;
    }

    // Absolute scheduling: each packet is due at a fixed offset from the start,
    // so a slow tick is corrected by the next one instead of accumulating.
    this.nextAt += PTIME_MS;
    this._schedule();
  }

  _schedule() {
    const delay = Math.max(0, this.nextAt - Date.now());
    this.timer = setTimeout(() => this._tick(), delay);
  }

  report() {
    const secs = (Date.now() - this.stats.started) / 1000;
    const expected = Math.round(secs * 1000 / PTIME_MS);
    return {
      sent: this.stats.sent,
      expected,
      drift: this.stats.sent - expected,
      silenceFrames: this.stats.silence,
      lateTicks: this.stats.late,
      maxLateMs: this.stats.maxLateMs,
      seconds: +secs.toFixed(2)
    };
  }
}

module.exports = { RtpStreamer, PTIME_MS, SAMPLES_PER_PACKET, ULAW_SILENCE };
