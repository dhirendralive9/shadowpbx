'use strict';
/**
 * Media path for a translated call.
 *
 * Normally RTPEngine bridges the two legs and we only observe. That is fine for
 * one direction, but the customer must NEVER hear the agent's real voice, and
 * RTPEngine cannot mute a leg while still letting us tap it — every mute is
 * applied before the fork point (measured repeatedly; see interpreter-mute-matrix).
 *
 * So for a translated call we take over the AGENT side only:
 *
 *      customer ──RTPEngine──► (tap) ──► STT ─► translate ─► TTS ─┐
 *                    ▲                                            ▼
 *                    │                                     ┌─────────────┐
 *      customer ◄────┴──── play media (translated only) ◄───┤   this      │
 *                                                           │   service   │
 *      agent ──────────── RTP direct to us ────────────────►│             │
 *      agent ◄─────────── customer audio + translation ─────┤             │
 *                                                           └─────────────┘
 *
 * The agent's RTP terminates here, so RTPEngine has nothing of theirs to
 * forward and the customer physically cannot hear them. The customer's own
 * audio still reaches the agent, because callers told us that hearing the
 * original helps them read tone and gender — so we relay it ourselves and mix
 * the translation on top.
 *
 * Only calls with translation enabled take this path. Everything else uses the
 * normal RTPEngine bridge untouched, so an ordinary call cannot be affected.
 */
const dgram = require('dgram');
const os = require('os');
const logger = require('../utils/logger');
const { RtpStreamer, SAMPLES_PER_PACKET, ULAW_SILENCE } = require('./rtp-streamer');

// Mixing gains. They must sum to <= 1.0 or loud passages clip.
const DUCK_GAIN = parseFloat(process.env.INTERPRETER_DUCK_GAIN || '0.18');   // customer's own voice
const SPEECH_GAIN = parseFloat(process.env.INTERPRETER_SPEECH_GAIN || '0.82'); // the translation

function localIp() {
  if (process.env.EXTERNAL_IP) return process.env.EXTERNAL_IP;
  const ifs = os.networkInterfaces();
  for (const n of Object.keys(ifs)) {
    for (const a of ifs[n]) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

// mu-law <-> linear, needed to mix two sources without clipping
function ulaw2lin(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exp = (u >> 4) & 0x07, man = u & 0x0f;
  const s = (((man << 3) + 0x84) << exp) - 0x84;
  return sign ? -s : s;
}
function lin2ulaw(s) {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1);
  const man = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | man) & 0xff;
}

/**
 * One translated call's agent-side media endpoint.
 */
class InterpreterMedia {
  constructor({ callId, onAgentAudio } = {}) {
    this.callId = callId;
    this.onAgentAudio = onAgentAudio;     // (mulawBuffer) => void  — feed to STT
    this.socket = null;
    this.port = 0;
    this.agentAddr = null;                // learned from their first packet
    this.streamer = null;
    this.relayQueue = [];                 // customer audio waiting to go to the agent
    this.ttsQueue = [];                   // translated audio waiting to go to the agent
    this.closed = false;
    this.stats = { fromAgent: 0, toAgent: 0, relayed: 0, spoken: 0 };
  }

  /** Bind our RTP socket and return the SDP to offer the agent. */
  async start() {
    this.socket = dgram.createSocket('udp4');
    await new Promise(res => this.socket.bind(0, '0.0.0.0', res));
    this.port = this.socket.address().port;

    this.socket.on('message', (buf, rinfo) => {
      if (this.closed || buf.length < 13) return;
      // Learn where to send: the agent may be behind NAT, so trust the source
      // of their actual packets rather than whatever their SDP claimed.
      if (!this.agentAddr || this.agentAddr.port !== rinfo.port || this.agentAddr.address !== rinfo.address) {
        const first = !this.agentAddr;
        this.agentAddr = { address: rinfo.address, port: rinfo.port };
        if (first) {
          logger.info(`INTERPRETER-MEDIA[${this.callId}]: agent media from ${rinfo.address}:${rinfo.port}`);
          this._startSending();
        } else {
          logger.info(`INTERPRETER-MEDIA[${this.callId}]: agent re-latched to ${rinfo.address}:${rinfo.port}`);
          if (this.streamer) { this.streamer.host = rinfo.address; this.streamer.port = rinfo.port; }
        }
      }
      const csrc = buf[0] & 0x0f, ext = (buf[0] >> 4) & 0x01;
      let off = 12 + csrc * 4;
      if (ext && buf.length > off + 4) off += 4 + buf.readUInt16BE(off + 2) * 4;
      const payload = buf.subarray(off);
      if (!payload.length) return;
      this.stats.fromAgent++;
      if (this.onAgentAudio) {
        try { this.onAgentAudio(payload); } catch (e) { /* never let STT break media */ }
      }
    });

    const ip = localIp();
    this.sdp = [
      'v=0',
      `o=- ${Date.now()} ${Date.now()} IN IP4 ${ip}`,
      's=ShadowPBX Interpreter',
      `c=IN IP4 ${ip}`,
      't=0 0',
      `m=audio ${this.port} RTP/AVP 0 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=fmtp:101 0-16',
      'a=ptime:20',
      'a=sendrecv'
    ].join('\r\n') + '\r\n';

    logger.info(`INTERPRETER-MEDIA[${this.callId}]: listening on ${ip}:${this.port}`);
    return this.sdp;
  }

  _startSending() {
    if (this.streamer || !this.agentAddr) return;
    this.streamer = new RtpStreamer({
      host: this.agentAddr.address,
      port: this.agentAddr.port,
      payloadType: 0,
      socket: this.socket,          // send from the same port we receive on
      sendSilence: true
    });
    // We build each outgoing frame ourselves so the customer's voice and the
    // translation can be heard together rather than one cutting off the other.
    this.streamer.queue = () => {};              // disable direct queueing
    const origTick = this.streamer._tick.bind(this.streamer);
    this.streamer._tick = () => {
      this.streamer.queueBuf.push(this._nextFrame());
      origTick();
    };
    this.streamer.start();
  }

  /** Mix one 20ms frame: relayed customer audio + any translation playing. */
  _nextFrame() {
    const relay = this.relayQueue.shift();
    const tts = this.ttsQueue.shift();
    if (!relay && !tts) return Buffer.alloc(SAMPLES_PER_PACKET, ULAW_SILENCE);
    if (relay && !tts) { this.stats.relayed++; return relay; }
    if (tts && !relay) { this.stats.spoken++; return tts; }

    // Both present: duck the original hard and pull the translation down a
    // little, so their sum cannot exceed full scale. Naively adding two loud
    // signals produces a result LOUDER than either one, which clips and sounds
    // harsh — worse than the problem the mix is meant to solve.
    const out = Buffer.alloc(SAMPLES_PER_PACKET);
    for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
      const a = ulaw2lin(relay[i]) * DUCK_GAIN;   // original, well under
      const b = ulaw2lin(tts[i]) * SPEECH_GAIN;   // translation, dominant
      let m = (a + b) | 0;
      if (m > 32767) m = 32767; else if (m < -32768) m = -32768;
      out[i] = lin2ulaw(m);
    }
    this.stats.relayed++; this.stats.spoken++;
    return out;
  }

  /** Customer audio (mu-law, any length) to be heard by the agent. */
  relayToAgent(audio) {
    if (this.closed || !audio || !audio.length) return;
    // Keep this shallow: if we fall behind, drop rather than add delay.
    if (this.relayQueue.length > 25) this.relayQueue.splice(0, this.relayQueue.length - 25);
    for (let off = 0; off < audio.length; off += SAMPLES_PER_PACKET) {
      let f = audio.subarray(off, off + SAMPLES_PER_PACKET);
      if (f.length < SAMPLES_PER_PACKET) {
        const pad = Buffer.alloc(SAMPLES_PER_PACKET, ULAW_SILENCE);
        f.copy(pad, 0); f = pad;
      }
      this.relayQueue.push(f);
    }
  }

  /** Translated speech (mu-law) for the agent to hear. */
  speakToAgent(audio) {
    if (this.closed || !audio || !audio.length) return;
    for (let off = 0; off < audio.length; off += SAMPLES_PER_PACKET) {
      let f = audio.subarray(off, off + SAMPLES_PER_PACKET);
      if (f.length < SAMPLES_PER_PACKET) {
        const pad = Buffer.alloc(SAMPLES_PER_PACKET, ULAW_SILENCE);
        f.copy(pad, 0); f = pad;
      }
      this.ttsQueue.push(f);
    }
  }

  report() {
    return Object.assign({ port: this.port, agent: this.agentAddr, streamer: this.streamer ? this.streamer.report() : null }, this.stats);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.streamer) this.streamer.stop(); } catch (e) {}
    try { if (this.socket) this.socket.close(); } catch (e) {}
    this.socket = null;
    logger.info(`INTERPRETER-MEDIA[${this.callId}]: closed ${JSON.stringify(this.stats)}`);
  }
}

module.exports = { InterpreterMedia, ulaw2lin, lin2ulaw };
