# Web Dialer — Phase 7 (abuse prevention) & Phase 8 (TURN, go-live)

## Phase 7 — keeping a public endpoint safe

The token endpoint is public by design, so it is the one part of the PBX
anyone on the internet can reach without credentials. What protects it:

| Control | Behaviour |
|---|---|
| Domain allow-list | Tokens and CORS only for the widget's own sites; empty = any site |
| Per-IP rate limit | `WEBCALL_TOKENS_PER_IP` (10) per `WEBCALL_RATE_WINDOW` (600s) |
| Per-widget rate limit | `WEBCALL_TOKENS_PER_WIDGET` (60) per window — one popular widget can't drown the PBX |
| Concurrency cap | Per widget, set in the admin UI |
| Single-use tokens | One call each, 60s to use them |
| Guest lockdown | One destination only — never a trunk, another extension or a feature code |
| Call cap | `WEBCALL_MAX_CALL_MINUTES` (60) hard stop |
| Attack monitor | Every refusal is recorded in the existing security tracker |
| Auto-block | `WEBCALL_ABUSE_BLOCK_AFTER=N` blocks an IP at the firewall after N refusals. **Default 0 = report only** |
| CAPTCHA | Optional, off by default — see below |
| Business hours | Optionally turn callers away outside hours with a message |

### CAPTCHA is optional

A widget can only require a challenge when **both** are true: `TURNSTILE_SECRET`
is set in `.env`, and the widget's *Require a CAPTCHA before calling* box is
ticked. With no secret configured the checkbox is disabled and nothing about
calling changes. If Cloudflare cannot be reached, a widget that asked for a
challenge keeps refusing rather than quietly letting everyone through.

ShadowPBX already uses Turnstile for admin login, so if you have it set up for
that, the same keys work here.

### Business hours

Each widget with a time condition chooses what happens outside hours:

- **Take the call** (default) — routes to the condition's own no-match
  destination, e.g. voicemail or an after-hours group.
- **Turn callers away** — the widget shows your closed message and the button
  is disabled, so nobody waits on a call that won't be answered.

## Phase 8 — TURN

Many visitors sit behind NATs and corporate firewalls where direct WebRTC media
never gets through; they connect the call and hear silence. A TURN relay fixes
that, which makes it effectively mandatory for reliable web calling.

```bash
sudo bash scripts/setup-turn.sh
```

The script installs coturn, generates a shared secret, re-uses your Let's
Encrypt certificate for TURN over TLS (5349), opens the ports, writes
`TURN_URLS` / `TURN_SECRET` to `.env`, and verifies a relay allocation.

Credentials are **ephemeral**: the username is an expiry timestamp, the password
an HMAC of it. ShadowPBX mints a fresh pair for every call and hands it to the
browser with the token. Nothing is stored, and a leaked credential dies within
`TURN_TTL` (3600s).

The relay is configured to refuse private address ranges, so it can never be
used to reach inside your network.

## Testing matrix

| Test | Expected |
|---|---|
| Chrome / Firefox / Safari / Edge desktop | Call connects, two-way audio |
| Mobile Chrome / Safari | Mic permission, call works |
| Behind a corporate NAT, or on mobile data | TURN relay kicks in, audio works |
| Microphone denied | Clear message, no token consumed |
| Outside business hours | Routed as configured, or the closed message |
| Ring group / queue / IVR destinations | Each routes correctly |
| Recording + CDR | Web call recorded and logged as `web-inbound` |
| Concurrent callers | Extra callers get "all lines are busy" at the cap |
| CAPTCHA widget | Challenge appears, call proceeds after solving |

## Go-live checklist

- [ ] Valid TLS certificate on the PBX domain; `wss://domain/ws` returns 101
- [ ] `node scripts/webrtc-selftest.js` — all 36 checks pass
- [ ] `node scripts/webcall-selftest.js` — all checks pass
- [ ] coturn running; **Network → WebRTC** no longer warns about TURN
- [ ] Every production widget has its `allowedDomains` set
- [ ] Concurrency caps match how many agents can actually answer
- [ ] A test widget exercised end to end from a real customer page
- [ ] A call placed from mobile data (proves the relay path)
- [ ] Decide on `WEBCALL_ABUSE_BLOCK_AFTER` — leave at 0 until you have seen
      normal traffic, so you don't block real visitors
