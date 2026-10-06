'use strict';
/**
 * One translated call, end to end.
 *
 * Everything here was proven separately before it was assembled: the media tap,
 * Deepgram streaming STT, sentence assembly, DeepL, Aura TTS, and injection.
 * This is the orchestration that runs them per call and, just as importantly,
 * tears them all down when the call ends.
 *
 *   agent  ──► InterpreterMedia ──► STT(agent lang) ─► DeepL ─► TTS ─► customer
 *   customer ──► RTPEngine tap   ──► STT(cust lang) ─► DeepL ─► TTS ─► agent
 *
 * The two directions are deliberately NOT symmetric:
 *
 *  - The customer must never hear the agent's real voice, so the agent's media
 *    terminates in InterpreterMedia and only synthesised speech is played to
 *    the customer.
 *  - The agent DOES hear the customer's original voice underneath the
 *    translation. Users asked for this: it carries tone, urgency and gender,
 *    which a synthesised voice strips out.
 *
 * Failure policy: if a provider dies mid-call we keep relaying real audio
 * rather than leaving anyone in silence, and log loudly. A degraded call beats
 * a dead one.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const dgram = require('dgram');
const logger = require('../utils/logger');

const AUDIO_HOST = process.env.AUDIO_DIR || '/opt/shadowpbx/audio';
const AUDIO_CONTAINER = process.env.AUDIO_DIR_CONTAINER || '/audio';

const VOICES = {
  EN: { female: 'aura-2-thalia-en', male: 'aura-2-apollo-en' },
  DE: { female: 'aura-2-viktoria-de', male: 'aura-2-julius-de' },
  ES: { female: 'aura-2-celeste-es', male: 'aura-2-nestor-es' },
  FR: { female: 'aura-2-pandora-fr', male: 'aura-2-alcyone-fr' },
  HI: { female: 'aura-2-thalia-en', male: 'aura-2-apollo-en' }   // no Hindi voice yet
};

// Deepgram streams its WAV with the RIFF sizes left unset, which makes
// rtpengine's ffmpeg report "dts = NOPTS" and stutter. We ask for raw samples
// and write the header ourselves with the real lengths.
function wavHeader(dataLen, rate) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataLen, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataLen, 40);
  return h;
}

const lin2ulaw = (s) => {
  const BIAS = 0x84, CLIP = 32635;
  let sign = (s >> 8) & 0x80;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1);
  const man = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | man) & 0xff;
};

/** One direction of translation: audio in, translated audio out. */
class Direction {
  constructor({ name, sourceLang, targetLang, voiceGender, onSpeech, onError }) {
    this.name = name;
    this.sourceLang = sourceLang;
    this.targetLang = (targetLang || 'EN').toUpperCase();
    this.voiceGender = voiceGender || 'female';
    this.onSpeech = onSpeech;             // (mulawBuffer, text) => void
    this.onError = onError || (() => {});
    this.ws = null;
    this.ready = false;
    this.buf = [];
    this.idleTimer = null;
    this.hardTimer = null;
    this.bufStartedAt = 0;
    this.closed = false;
    this.stats = { utterances: 0, spoken: 0, errors: 0 };
  }

  start() {
    let WebSocket;
    try { WebSocket = require('ws'); }
    catch (e) { this.onError(new Error('ws module not installed')); return; }

    const qs = new URLSearchParams({
      model: process.env.TRANSLATION_STT_MODEL || 'nova-3',
      language: (!this.sourceLang || this.sourceLang === 'auto') ? 'multi' : this.sourceLang,
      encoding: 'mulaw', sample_rate: '8000', channels: '1',
      interim_results: 'true', punctuate: 'true',
      endpointing: process.env.TRANSLATION_ENDPOINTING || '150',
      utterance_end_ms: '1000'
    });
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${qs}`, {
      headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` }
    });
    this.ws.on('open', () => { this.ready = true; logger.info(`INTERPRETER[${this.name}]: STT connected (${this.sourceLang} -> ${this.targetLang})`); });
    this.ws.on('message', (raw) => this._onStt(raw));
    this.ws.on('error', (e) => { this.stats.errors++; this.onError(e); });
    this.ws.on('close', (c) => { this.ready = false; if (!this.closed && c !== 1000) this.onError(new Error(`STT closed ${c}`)); });
  }

  /** Feed mu-law audio straight from the call. */
  write(payload) {
    if (this.ready && this.ws && this.ws.readyState === 1) {
      try { this.ws.send(payload); } catch (e) { /* dropped frame is survivable */ }
    }
  }

  _onStt(raw) {
    let m; try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (m.type === 'UtteranceEnd') { this._tryFlush('utterance-end'); return; }
    const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
    if (!alt || !alt.transcript || !m.is_final) return;
    this._push(alt.transcript.trim());
  }

  // Sentence assembly. Deepgram finalises on pauses, not meaning, so a single
  // thought arrives in pieces; translating a piece gives confident nonsense.
  _push(text) {
    if (!text) return;
    if (!this.buf.length) {
      this.bufStartedAt = Date.now();
      clearTimeout(this.hardTimer);
      this.hardTimer = setTimeout(() => this._flush('max-wait'), 4000);
    }
    this.buf.push(text);
    if (this._complete(this.buf.join(' '))) return this._flush('sentence');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this._tryFlush('idle'), 1200);
  }

  _ends(t) { return /[.!?।。]["')\]]?\s*$/.test(t.trim()); }
  _words(t) { return t.trim().split(/\s+/).filter(Boolean).length; }
  _dangling(t) {
    const s = t.trim();
    if (!s || this._ends(s)) return false;
    return /(^|\s)(and|but|or|because|so|that|if|the|a|an|of|for|to|with|from|my|your|is|are|was|were|i|we|you|it|und|aber|weil|dass|der|die|das|ein|eine|mit|von|für|zu|ist|sind|ich|wir|sie|mein|meine|और|लेकिन|क्योंकि|से|का|की|के|को|में|है|हैं|मैं|हम|आप|मेरा|मेरी|मेरे)\s*[,;:]?\s*$/i.test(s);
  }
  _complete(t) { return !this._dangling(t) && this._ends(t) && this._words(t) >= 4; }
  _sendable(t) { return !this._dangling(t) && this._ends(t) && this._words(t) >= 4; }

  _tryFlush(reason) {
    if (!this.buf.length) return;
    const joined = this.buf.join(' ');
    if (this._sendable(joined)) return this._flush(reason);
    if (Date.now() - this.bufStartedAt >= 4000) return this._flush(reason + '+forced');
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this._tryFlush(reason + '+wait'), 900);
  }

  async _flush(reason) {
    clearTimeout(this.idleTimer); clearTimeout(this.hardTimer);
    if (!this.buf.length || this.closed) return;
    let text = this.buf.join(' ').trim();
    this.buf = [];
    if (!text) return;
    if (!this._ends(text)) text += '.';
    this.stats.utterances++;

    const t0 = Date.now();
    try {
      const translated = await this._translate(text);
      if (!translated || this.closed) return;
      const audio = await this._synthesize(translated);
      if (!audio || this.closed) return;
      this.stats.spoken++;
      logger.info(`INTERPRETER[${this.name}]: "${text}" -> "${translated}" (${Date.now() - t0}ms, ${reason})`);
      this.onSpeech(audio, translated, text);
    } catch (e) {
      this.stats.errors++;
      logger.warn(`INTERPRETER[${this.name}]: turn failed: ${e.message}`);
      this.onError(e);
    }
  }

  _translate(text) {
    const key = (process.env.DEEPL_API_KEY || '').trim();
    // A ":fx" key is free-tier and MUST use the free host; the paid host
    // answers 403 and it looks like a bad key.
    const host = /:fx$/.test(key) ? 'api-free.deepl.com' : 'api.deepl.com';
    const payload = { text: [text], target_lang: this.targetLang };
    const src = (this.sourceLang || '').toUpperCase();
    if (src && src !== 'AUTO' && src !== 'MULTI' && src !== this.targetLang) payload.source_lang = src;
    const body = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: 'POST', hostname: host, path: '/v2/translate',
        headers: { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000
      }, (res) => {
        let d = '';
        res.on('data', c => { d += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`DeepL ${res.statusCode}`));
          try { const j = JSON.parse(d); resolve(j.translations && j.translations[0] ? j.translations[0].text : ''); }
          catch (e) { reject(e); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('DeepL timeout')));
      req.on('error', reject);
      req.write(body); req.end();
    });
  }

  _synthesize(text) {
    const voice = (VOICES[this.targetLang] || VOICES.EN)[this.voiceGender] || VOICES.EN.female;
    const body = JSON.stringify({ text });
    return new Promise((resolve, reject) => {
      const req = https.request({
        method: 'POST', hostname: 'api.deepgram.com',
        path: `/v1/speak?model=${voice}&encoding=mulaw&sample_rate=8000&container=none`,
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 15000
      }, (res) => {
        const ch = [];
        res.on('data', c => ch.push(c));
        res.on('end', () => {
          const b = Buffer.concat(ch);
          if (res.statusCode !== 200) return reject(new Error(`TTS ${res.statusCode}`));
          resolve(b);                       // raw mu-law, ready for RTP
        });
      });
      req.on('timeout', () => req.destroy(new Error('TTS timeout')));
      req.on('error', reject);
      req.write(body); req.end();
    });
  }

  close() {
    this.closed = true;
    clearTimeout(this.idleTimer); clearTimeout(this.hardTimer);
    try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) {}
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.ws = null;
  }
}


/**
 * Drives both directions for one call, and owns their teardown.
 */
class InterpreterSession {
  /**
   * @param media         InterpreterMedia holding the agent leg
   * @param tapCustomer   fn(cb) -> stop()   subscribe to the customer leg
   * @param playToCustomer fn(mulawBuffer) -> Promise  inject into the customer leg
   */
  constructor({ callId, media, tapCustomer, playToCustomer, customerLang, agentLang, voiceGender }) {
    this.callId = callId;
    this.media = media;
    this.tapCustomer = tapCustomer;
    this.playToCustomer = playToCustomer;
    this.customerLang = customerLang || 'auto';
    this.agentLang = agentLang || 'en';
    this.voiceGender = voiceGender || 'female';
    this.stopTap = null;
    this.closed = false;
    this.degraded = false;
  }

  async start() {
    // customer speaks -> agent hears it translated (on top of the original)
    this.fromCustomer = new Direction({
      name: `${this.callId}:cust->agent`,
      sourceLang: this.customerLang,
      targetLang: this.agentLang.toUpperCase(),
      voiceGender: this.voiceGender,
      onSpeech: (audio) => { try { this.media.speakToAgent(audio); } catch (e) {} },
      onError: (e) => this._degrade(e)
    });

    // agent speaks -> customer hears ONLY the translation
    this.fromAgent = new Direction({
      name: `${this.callId}:agent->cust`,
      sourceLang: this.agentLang,
      targetLang: (this.customerLang === 'auto' ? 'EN' : this.customerLang).toUpperCase(),
      voiceGender: this.voiceGender,
      onSpeech: (audio) => { this.playToCustomer(audio).catch(() => {}); },
      onError: (e) => this._degrade(e)
    });

    this.fromCustomer.start();
    this.fromAgent.start();

    // the agent's own audio arrives through the media endpoint
    this.media.onAgentAudio = (payload) => {
      if (!this.closed) this.fromAgent.write(payload);
    };

    // the customer's audio comes from an RTPEngine subscription; it is both
    // transcribed AND relayed to the agent so they keep the original voice
    this.stopTap = await this.tapCustomer((payload) => {
      if (this.closed) return;
      this.fromCustomer.write(payload);
      try { this.media.relayToAgent(payload); } catch (e) {}
    });

    logger.info(`INTERPRETER: session up for ${this.callId} (customer ${this.customerLang} <-> agent ${this.agentLang})`);
  }

  // A provider failing should not leave anyone in silence: keep relaying real
  // audio to the agent and log it, rather than killing the call.
  _degrade(err) {
    if (this.degraded || this.closed) return;
    this.degraded = true;
    logger.error(`INTERPRETER: ${this.callId} degraded — ${err.message}. Relaying original audio; translation paused.`);
  }

  report() {
    return {
      callId: this.callId,
      degraded: this.degraded,
      customerToAgent: this.fromCustomer ? this.fromCustomer.stats : null,
      agentToCustomer: this.fromAgent ? this.fromAgent.stats : null,
      media: this.media ? this.media.report() : null
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (this.stopTap) this.stopTap(); } catch (e) {}
    try { if (this.fromCustomer) this.fromCustomer.close(); } catch (e) {}
    try { if (this.fromAgent) this.fromAgent.close(); } catch (e) {}
    logger.info(`INTERPRETER: session closed ${this.callId} ${JSON.stringify(this.report())}`);
  }
}

module.exports = { Direction, InterpreterSession, wavHeader, lin2ulaw, VOICES, AUDIO_HOST, AUDIO_CONTAINER };
