/* ShadowPBX — agent-side interpreter client.
 *
 * Takes over the outgoing audio of a call. The microphone goes to the
 * interpreter socket for recognition and never into the call; what goes into
 * the call is the synthesised speech that comes back. That is the whole point:
 * the customer cannot hear the agent's real voice because it is not there to
 * hear, rather than because a mute is holding somewhere upstream.
 *
 * It exposes a MediaStreamTrack. Whoever owns the call does
 *
 *     sender.replaceTrack(interpreter.track)
 *
 * and the swap is complete. Replacing the track rather than renegotiating
 * means translation can be turned on and off mid-call without touching SDP.
 *
 * Browser-side responsibilities, in order of how easy they are to get wrong:
 *
 *  - Resampling. The recogniser wants 8 kHz mu-law. We ask for an 8 kHz
 *    AudioContext so the browser's own resampler does the work, and fall back
 *    to doing it here if the browser refuses the rate.
 *  - Scheduling. Synthesised speech arrives in bursts. Played as it arrives
 *    it stutters, so each chunk is scheduled against an absolute timeline,
 *    the same lesson the server-side RTP sender taught us.
 *  - Continuity. The destination node emits constantly, so the call carries
 *    unbroken RTP even while nobody is speaking. Carriers tear down calls
 *    that go quiet at the packet level, and a gap is also how an agent ends
 *    up sounding dead to the customer.
 *
 * No provider credentials exist on this side. The connect token is single-use
 * and buys an audio socket, nothing else.
 */
(function (global) {
  'use strict';

  // The capture worklet. Inlined as a Blob so there is no second file to
  // deploy and no extra request before a call can start.
  var WORKLET = [
    "class Cap extends AudioWorkletProcessor {",
    "  constructor(o){",
    "    super();",
    "    const target = (o.processorOptions && o.processorOptions.targetRate) || 8000;",
    "    this.ratio = sampleRate / target;",
    "    this.pos  = 0;",                     // fractional read position
    "    this.tail = new Float32Array(0);",   // samples carried into the next block
    "    this.out  = new Float32Array(160);", // 20ms at the target rate
    "    this.n    = 0;",
    // Anti-aliasing, and only when we are actually decimating. Dropping
    // samples without it folds everything above 4 kHz back into the speech
    // band, which costs recognition accuracy on exactly the consonants that
    // distinguish words. One biquad at 3.4 kHz — the telephone band limit —
    // takes about 11 dB off the worst of it. Not a brick wall, but this
    // branch only runs if the browser refused an 8 kHz context, in which case
    // its own resampler would have done the filtering properly; measured on
    // Chrome, Firefox and Safari the ratio here is 1 and this is bypassed.
    "    this.filter = this.ratio > 1.5;",
    "    if (this.filter){",
    "      const w = 2*Math.PI*3400/sampleRate, cs = Math.cos(w), sn = Math.sin(w);",
    "      const al = sn/(2*0.707), a0 = 1+al;",
    "      this.b0=((1-cs)/2)/a0; this.b1=(1-cs)/a0; this.b2=this.b0;",
    "      this.a1=(-2*cs)/a0;    this.a2=(1-al)/a0;",
    "      this.x1=this.x2=this.y1=this.y2=0;",
    "    }",
    "  }",
    "  process(inputs){",
    "    const ch = inputs[0] && inputs[0][0];",
    "    if (!ch) return true;",
    "    let src = ch;",
    "    if (this.filter){",
    "      src = new Float32Array(ch.length);",
    "      for (let i=0;i<ch.length;i++){",
    "        const x = ch[i];",
    "        const y = this.b0*x + this.b1*this.x1 + this.b2*this.x2 - this.a1*this.y1 - this.a2*this.y2;",
    "        this.x2=this.x1; this.x1=x; this.y2=this.y1; this.y1=y;",
    "        src[i]=y;",
    "      }",
    "    }",
    // Carry the unconsumed tail across blocks. Restarting the read position
    // at every 128-sample boundary is what puts a periodic tick in the
    // stream — inaudible, and ruinous for recognition.
    "    let buf;",
    "    if (this.tail.length){ buf = new Float32Array(this.tail.length + src.length); buf.set(this.tail,0); buf.set(src,this.tail.length); }",
    "    else buf = src;",
    "    let p = this.pos;",
    "    while (p + 1 < buf.length){",
    "      const i = p | 0, f = p - i;",
    "      this.out[this.n++] = buf[i]*(1-f) + buf[i+1]*f;",
    "      if (this.n === this.out.length){ this.port.postMessage(this.out.slice()); this.n = 0; }",
    "      p += this.ratio;",
    "    }",
    "    const keep = Math.min(p|0, buf.length);",
    "    this.tail = buf.slice(keep);",
    "    this.pos  = p - keep;",
    "    return true;",
    "  }",
    "}",
    "registerProcessor('sp-cap', Cap);"
  ].join('\n');

  // ── G.711 mu-law ────────────────────────────────────────────────────────
  var ENC = (function () {
    var t = new Uint8Array(65536);
    for (var i = 0; i < 65536; i++) {
      var s = i >= 32768 ? i - 65536 : i;
      var sign = (s >> 8) & 0x80;
      if (sign) s = -s;
      if (s > 32635) s = 32635;
      s += 0x84;
      var exp = 7;
      for (var m = 0x4000; (s & m) === 0 && exp > 0; exp--, m >>= 1) {}
      t[i] = ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
    }
    return t;
  })();

  var DEC = (function () {
    var t = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var u = ~i & 0xff;
      var v = ((u & 0x0f) << 3) + 0x84;
      v <<= (u & 0x70) >> 4;
      t[i] = ((u & 0x80) ? (0x84 - v) : (v - 0x84)) / 32768;
    }
    return t;
  })();

  function encode(f32) {
    var out = new Uint8Array(f32.length);
    for (var i = 0; i < f32.length; i++) {
      var s = f32[i];
      s = s > 1 ? 1 : (s < -1 ? -1 : s);
      out[i] = ENC[(Math.round(s * 32767) & 0xffff)];
    }
    return out;
  }


  function InterpreterClient(opts) {
    opts = opts || {};
    this.micStream = opts.micStream || null;
    this.onLog = opts.onLog || function () {};
    this.onState = opts.onState || function () {};
    this.onSpeech = opts.onSpeech || function () {};
    // Called when translation can no longer be guaranteed. The caller's job
    // is to end the call: carrying on would put the agent's real voice on the
    // line, which is the one outcome this whole design exists to prevent.
    this.onFail = opts.onFail || function () {};

    this.ws = null;
    this.actx = null;
    this.dest = null;
    this.capture = null;
    this.source = null;
    this.comfort = null;
    this.track = null;

    this.state = 'idle';
    this.playAt = 0;
    this.queued = 0;
    this.stats = { sent: 0, received: 0, utterances: 0, errors: 0, lateDrops: 0 };
    this.lastText = null;
    this.closedByUs = false;
  }

  InterpreterClient.prototype._set = function (s, detail) {
    this.state = s;
    try { this.onState(s, detail); } catch (e) {}
  };

  InterpreterClient.prototype._log = function (m) { try { this.onLog(m); } catch (e) {} };

  /**
   * Open the session. Resolves once the server has confirmed it is ready and
   * the outgoing track exists — so the caller can swap it in knowing the
   * translation path is live, not merely requested.
   */
  InterpreterClient.prototype.start = function (callId) {
    var self = this;
    this.closedByUs = false;
    this._set('connecting');

    return fetch('/api/interpreter/session', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callId: callId || '' })
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j.success) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    }).then(function (session) {
      self.session = session;
      self._log('Translation session granted (' + session.agentLanguage + ' → ' + session.customerLanguage + ')');
      return self._audio();
    }).then(function () {
      return self._socket(callId);
    }).then(function (ready) {
      self._set('live', ready);
      self._log('Translation live — your microphone is not going into the call');
      return ready;
    }).catch(function (e) {
      self._set('failed', e.message);
      self.stop();
      throw e;
    });
  };

  /** Build the audio graph and the outgoing track. */
  InterpreterClient.prototype._audio = function () {
    var self = this;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return Promise.reject(new Error('This browser has no Web Audio support'));

    // Ask for 8 kHz so the browser's resampler handles rate conversion both
    // ways. If it refuses, the worklet resamples instead.
    try { this.actx = new AC({ sampleRate: 8000 }); }
    catch (e) { this.actx = new AC(); }
    this.rate = this.actx.sampleRate;
    this._log('Audio context at ' + this.rate + ' Hz' + (this.rate === 8000 ? '' : ' (resampling to 8 kHz here)'));

    this.dest = this.actx.createMediaStreamDestination();

    // Comfort noise, far below anything audible. Two jobs: it keeps the
    // encoder producing packets through silence, and it stops the line
    // sounding dead to a customer waiting for a reply.
    var noise = this.actx.createBufferSource();
    var nb = this.actx.createBuffer(1, Math.floor(this.rate), this.rate);
    var nd = nb.getChannelData(0);
    for (var i = 0; i < nd.length; i++) nd[i] = (Math.random() - 0.5) * 0.0008;
    noise.buffer = nb; noise.loop = true;
    noise.connect(this.dest);
    noise.start();
    this.comfort = noise;

    this.track = this.dest.stream.getAudioTracks()[0];
    if (!this.track) return Promise.reject(new Error('Could not create an outgoing audio track'));

    var resume = this.actx.state === 'suspended' ? this.actx.resume() : Promise.resolve();
    return resume.then(function () {
      return self.actx.audioWorklet.addModule(
        URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
      );
    }).then(function () {
      if (!self.micStream) throw new Error('No microphone stream was provided');
      self.source = self.actx.createMediaStreamSource(self.micStream);
      self.capture = new AudioWorkletNode(self.actx, 'sp-cap', {
        numberOfInputs: 1, numberOfOutputs: 0,
        processorOptions: { targetRate: 8000 }
      });
      self.capture.port.onmessage = function (ev) { self._mic(ev.data); };
      self.source.connect(self.capture);
      // Deliberately NOT connected to self.dest. This single omission is what
      // keeps the agent's voice out of the call.
    });
  };

  InterpreterClient.prototype._socket = function (callId) {
    var self = this;
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(self.session.url); }
      catch (e) { return reject(new Error('Could not open the translation socket: ' + e.message)); }
      ws.binaryType = 'arraybuffer';
      self.ws = ws;

      var settled = false;
      var giveUp = setTimeout(function () {
        if (!settled) { settled = true; try { ws.close(); } catch (e) {} reject(new Error('Translation server did not respond')); }
      }, 10000);

      ws.onopen = function () {
        ws.send(JSON.stringify({ type: 'start', token: self.session.token, callId: callId || '' }));
      };

      ws.onmessage = function (ev) {
        if (typeof ev.data !== 'string') return self._audioIn(ev.data);
        var m; try { m = JSON.parse(ev.data); } catch (e) { return; }

        if (m.type === 'ready') {
          clearTimeout(giveUp);
          if (!settled) { settled = true; resolve(m); }
          return;
        }
        if (m.type === 'speech') {
          self.stats.utterances++;
          self.lastText = m.text;
          self._log('→ "' + m.said + '"  ⇒  "' + m.text + '"');
          try { self.onSpeech(m); } catch (e) {}
          return;
        }
        if (m.type === 'error') {
          self.stats.errors++;
          self._log('Translation error: ' + m.error);
          if (m.fatal) {
            clearTimeout(giveUp);
            if (!settled) { settled = true; reject(new Error(m.error)); }
            else self._fail(m.error);
          }
          return;
        }
      };

      ws.onerror = function () {
        clearTimeout(giveUp);
        if (!settled) { settled = true; reject(new Error('Could not reach the translation server')); }
      };

      ws.onclose = function (ev) {
        if (!settled) {
          clearTimeout(giveUp);
          settled = true;
          return reject(new Error('Translation socket closed (' + ev.code + ')'));
        }
        if (!self.closedByUs) self._fail('Translation socket closed (' + ev.code + ')');
      };
    });
  };

  // The socket dying mid-call is not recoverable in place: the outgoing track
  // would keep sending comfort noise and the customer would hear nothing at
  // all, or — worse, if someone "helpfully" restored the microphone — would
  // hear the agent untranslated. Hand it up and let the caller end the call.
  InterpreterClient.prototype._fail = function (why) {
    if (this.state === 'failed') return;
    this._set('failed', why);
    this._log('Translation lost: ' + why);
    try { this.onFail(why); } catch (e) {}
  };

  /** A block of 8 kHz float samples from the capture worklet. */
  InterpreterClient.prototype._mic = function (f32) {
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(encode(f32)); this.stats.sent += f32.length; } catch (e) {}
  };

  /** Synthesised speech back from the server: 0x01 | seq | mu-law. */
  InterpreterClient.prototype._audioIn = function (ab) {
    var b = new Uint8Array(ab);
    if (!b.length || b[0] !== 0x01) return;
    var mulaw = b.subarray(5);
    if (!mulaw.length) return;
    this.stats.received += mulaw.length;

    var buf = this.actx.createBuffer(1, mulaw.length, 8000);
    var d = buf.getChannelData(0);
    for (var i = 0; i < mulaw.length; i++) d[i] = DEC[mulaw[i]];

    // Absolute timeline. Scheduling each chunk relative to "now" lets the
    // gaps accumulate; scheduling against a running cursor does not.
    var now = this.actx.currentTime;
    var lead = 0.06;
    if (this.playAt < now + lead) this.playAt = now + lead;

    var src = this.actx.createBufferSource();
    src.buffer = buf;
    src.connect(this.dest);
    src.start(this.playAt);
    this.playAt += buf.duration;
    this.queued++;
    var self = this;
    src.onended = function () { self.queued--; };
  };

  /** True while synthesised speech is actually on the line. */
  InterpreterClient.prototype.isSpeaking = function () {
    return !!this.actx && this.playAt > this.actx.currentTime;
  };

  InterpreterClient.prototype.report = function () {
    return {
      state: this.state,
      secondsSent: Math.round(this.stats.sent / 8000),
      utterances: this.stats.utterances,
      errors: this.stats.errors,
      lastText: this.lastText
    };
  };

  InterpreterClient.prototype.stop = function () {
    this.closedByUs = true;
    try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ type: 'stop' })); } catch (e) {}
    try { if (this.ws) this.ws.close(); } catch (e) {}
    this.ws = null;
    try { if (this.capture) { this.capture.port.onmessage = null; this.capture.disconnect(); } } catch (e) {}
    try { if (this.source) this.source.disconnect(); } catch (e) {}
    try { if (this.comfort) { this.comfort.stop(); this.comfort.disconnect(); } } catch (e) {}
    // The microphone stream belongs to the caller — it is still needed if
    // translation is switched off and the call continues normally.
    try { if (this.actx && this.actx.state !== 'closed') this.actx.close(); } catch (e) {}
    this.actx = null; this.capture = null; this.source = null; this.comfort = null;
    this.playAt = 0;
    if (this.state !== 'failed') this._set('idle');
  };

  global.InterpreterClient = InterpreterClient;
})(window);
