# Real-time voice interpreter

Live two-way call translation. The customer speaks their language, the agent
speaks theirs, and each hears the other in their own.

Off by default. With `TRANSLATION_ENABLED=false` and the master switch off in
Settings, nothing in the call path behaves differently.

---

## The problem this architecture exists to solve

The requirement that shaped everything: **the agent's real voice must never
reach the customer.** Only the translation goes out.

The obvious implementation is server-side. Fork both legs of the call to a
recogniser, translate, synthesise, inject the result, and mute the original.
We built that, and it works in one direction — the customer's voice reaches
the agent translated, and it sounds good. In the other direction it cannot be
made to work, for a reason that is a property of rtpengine rather than a bug
in our code.

To translate the agent we need two things at once from their leg:

1. The customer must not hear it.
2. We must still hear it, to recognise it.

rtpengine offers `block media`, `silence media` and the `--mute-side` variants
to do (1), and `subscribe request` to do (2). Every one of the muting
commands applies **before** the point where the stream is forked to a
subscriber. So muting the agent toward the customer also silences the tap.

This was measured, not assumed. Five strategies, three runs each, on live
calls, plus a separate test of every ordering of block-then-subscribe and
subscribe-then-block:

| Strategy | Packets reaching the tap |
|---|---|
| baseline, no muting | 106 |
| `silence media` on the agent leg | 0 |
| `silence media --mute-side` | 0 |
| `block media` on the agent leg | 0 |
| `block media` then `subscribe request` | 0 |
| `subscribe request` then `block media` | 0 |

There is no ordering that yields both. A server-side implementation of this
requirement is not possible with this media engine.

## What we do instead

Move the agent's end of the media into the agent's own application.

```
                     ┌──────── interpreter port (WSS) ─────────┐
                     │                                          │
   agent app ────────┘  mic (mu-law 8k)  ──► Deepgram STT        │
      │                                        │                │
      │                                      DeepL               │
      │                                        │                │
      │              synthesised speech ◄──── Aura TTS ──────────┘
      │                     │
      │                     ▼
      │              replaceTrack  ──► the call's outgoing audio ──► customer
      │
      └── mic is NOT connected to the call at any point
```

The microphone goes to the interpreter socket and nowhere else. What the
call carries is audio we generated. The guarantee stops being a configuration
we have to get right on every call and becomes a property of where the audio
physically goes — there is no path from the microphone to the customer to get
wrong.

Side effects worth knowing about, both good:

- **The outgoing stream is continuous.** The destination node emits constantly
  (comfort noise between utterances), so the call carries unbroken RTP. The
  server-side injection approach sent bursts with nothing in between, which we
  suspect was behind calls being torn down around the 60-second mark.
- **Translation can be toggled mid-call** with no renegotiation, because
  `replaceTrack` does not touch SDP.

Asymmetry is deliberate. The agent *does* hear the customer's original voice
underneath the translation, which is still handled server-side by the tap that
works. Users asked for this: it carries tone, urgency and gender, which a
synthesised voice strips out, and it lets an agent greet someone correctly.

## Credentials

Provider keys never leave the server, which matters more once the agent
application is a packaged desktop app that can be decompiled.

The web UI, authenticated by the session cookie, calls
`POST /api/interpreter/session`. That endpoint resolves **everything that
costs money or grants access** — which extension, which language pair — and
bakes it into a connect token. The socket takes no instructions on any of it:
a client that claims a different extension or language pair changes nothing.

The token is:

- **separately scoped** from the SIP browser credential the registrar issues.
  An interpreter token cannot REGISTER; a SIP token cannot open a translation
  socket. A leak of either buys only its own thing.
- **single use.** It is consumed the moment a socket presents it, so a copy
  taken off the wire or out of a log is already spent.
- **short lived** (2 minutes). It only has to cross the gap between the page
  loading and the socket opening.

An agent can only ever open a session for their own extension. Admins and
supervisors may specify another, the same rule the browser phone already
follows.

## Failure behaviour

If the socket dies mid-call, the call ends.

This is deliberate and it is the safe choice. Carrying on would leave the
customer hearing comfort noise with no idea why, and any attempt to recover by
restoring the microphone would put the agent's untranslated voice on the line
— the one outcome the whole design exists to prevent. The agent is told what
happened rather than left guessing.

A provider error on a single utterance is *not* fatal: the socket stays up and
the next turn can succeed. Only losing the socket itself ends the call.

## Cost control

Deepgram bills for the audio streamed to it, and on a real call the agent is
listening most of the time. Streaming that silence is money spent transcribing
nothing, so the server gates on speech.

The trap in any gate is clipping word onsets — by the time the energy has
risen enough to be certain, the first consonant is gone. So a 300 ms pre-roll
is held and flushed when the gate opens, and a 700 ms tail keeps it open
through the pauses inside a sentence rather than chopping it into fragments.

The log line at session close reports both numbers, so the saving is visible:

```
INTERPRETER-WS[a1b2c3]: closed after 184s — 23 utterances,
  61s of audio streamed of 184s captured, 0 errors
```

Other guards: one session per extension (a second tab replaces the first
rather than doubling the bill), a server-wide concurrency cap, a hard
per-session time ceiling, and ping/pong so a half-open socket on a mobile or
VPN link does not hold a Deepgram connection open invisibly.

## Measured latency

All on real PSTN calls, not synthetic tests:

| Stage | Typical |
|---|---|
| speech stop → final transcript | ~750 ms |
| DeepL translation | ~470 ms |
| Aura first byte | ~490 ms |
| **end to end per turn** | **~1.8 s** |

Verified in English, German and Hindi, both directions.

## Ports

| Port | What |
|---|---|
| 3000 | API + GUI, and also accepts `/interpreter/ws` |
| 3002 | the interpreter port (`INTERPRETER_PORT`) |

Two ways in, one server, the same limits and the same authentication on both.
The dedicated port is what a packaged desktop app connects to, and what an
operator can firewall or move to its own interface. The browser phone uses the
main port because it is already talking to it over TLS that nginx terminates
— a second port would mean a second certificate or a mixed-content failure.

The interpreter port binds to `127.0.0.1` by default. `scripts/setup-webrtc.sh`
writes an nginx `location /interpreter/ws` into new vhosts; existing
deployments need no change, because the main port carries it. **If you expose
the interpreter port directly, firewall it** — it is an audio socket.

## Configuration

See the interpreter block in `.env.example`. The settings most likely to need
touching:

| Variable | Default | Why you would change it |
|---|---|---|
| `INTERPRETER_GATE_RMS` | 900 | Lower if quiet speakers get clipped; raise if a noisy room holds the gate open. Scale is RMS on mu-law's ±32124: room noise ≈ 100, telephone speech ≈ 1600–3200. |
| `INTERPRETER_GATE_TAIL_MS` | 700 | Raise if sentences are being split mid-thought. |
| `INTERPRETER_MAX_SESSIONS` | 20 | Concurrency ceiling across the server. |
| `INTERPRETER_PUBLIC_URL` | unset | Only when a desktop app reaches the port directly. |

Language and on/off behaviour are set in the UI, not here: Settings → System
for the system defaults, `/preferences` for an agent's own choice, and a
per-call toggle on `/phone`.

## Testing

```
node scripts/interpreter-ws-selftest.js
```

Exercises the whole port — token handling, replay, language spoofing,
session limits, speech gating, frame reassembly, teardown — with the
translator stubbed. Free to run, and safe to run on a live box.

The translation itself is covered by the spike scripts, which need a live call
and real provider keys:

```
node scripts/interpreter-translate-spike.js --list
node scripts/interpreter-translate-spike.js --call <id> --lang de --to EN
```

## Status

Working: the server-side customer→agent direction, the interpreter port, the
browser client, and the track swap.

Not yet done: Electron packaging, and a policy check that refuses to translate
for an extension not registered from an interpreter-capable client.
