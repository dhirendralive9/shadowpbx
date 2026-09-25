# Security review — fixes (P1/P2 batch)

Response to the code review covering trunk trust, call teardown, recording
correctness and login hardening.

## P1 — Trunk trust was spoofable  (fixed)

`isFromTrunk()` classified inbound traffic on `From` domain and `User-Agent`,
both of which any endpoint can forge (`From: user@twilio.com`, `User-Agent:
Twilio`). This let an attacker be treated as an inbound carrier call — the same
class of spoofing behind the toll-fraud incident.

Trust is now **source-IP first**:

1. Each trunk's `host` is resolved to its IP(s) at startup (and hourly), plus
   any `TRUNK_TRUSTED_IPS` / per-trunk `trustedIps` for SBCs or published
   ranges. An INVITE from one of those IPs is genuine trunk traffic.
2. `From` / `User-Agent` are **no longer used to grant trust.**
3. DID and catch-all matching remain only as a fallback for deployments that
   have not configured IP trust; once trusted IPs exist, an unknown source IP
   is never treated as a trunk even if it guesses one of your DIDs.

Config: set `TRUNK_TRUSTED_IPS` if your provider sends from IPs that differ
from its hostname's DNS.

## P1 — Call teardown was not idempotent  (fixed)

Both legs fire `destroy` on a normal hangup, so `_endCall()` could run twice —
duplicate CDR saves, presence changes, CRM events and cleanup. `_endCall()` now
guards on the CDR (`__ended` flag): the side-effects run exactly once no matter
how many teardown closures reach it, verified under concurrent double-destroy.
A CDR already in a terminal state (failed/missed/busy) is not overwritten as
`completed`.

## P1 — Recording correctness  (fixed)

Two bugs:

- **Sequence wrap.** Packets were ordered by `sort -n` on `rtp.seq`, which is
  16-bit and wraps at 65535 — ~21.8 minutes at 20 ms/packet — after which long
  calls were reordered and the audio scrambled. Ordering is now by
  `rtp.timestamp` (32-bit, monotonic, does not wrap in any realistic call).
- **Hardcoded codec.** Payload was always decoded as mu-law. A-law (PCMA)
  calls came out as noise. The decoder now reads the RTP payload type per
  stream (PT 0 = mu-law, PT 8 = A-law) and passes the right law to sox.

## P2 — Login hardening  (fixed)

- **Rate limiting**, always on and independent of Turnstile: `LOGIN_MAX_FAILS`
  (5) failures per IP within `LOGIN_WINDOW_SECONDS` (300) locks that IP out for
  `LOGIN_LOCKOUT_SECONDS` (900). Checked before any DB/bcrypt work; a success
  clears the counter. Verified: the correct password is refused with 429 once
  an IP is locked.
- **Secure cookie**: the session cookie now sets `Secure` when the request
  arrived over HTTPS (direct or via `X-Forwarded-Proto`), so it is never sent
  in the clear.
- **Logout is POST** (state-changing); a GET is kept as a convenience redirect
  and both invalidate the session server-side. The "Sign out" link is now a
  POST form.
- **Env-fallback admin** logs a loud `SECURITY:` warning if used while real DB
  admins exist, so a forgotten `ADMIN_PASSWORD` in production is visible. It
  remains available only as a first-install bootstrap.

### Not changed: session store

Sessions are still an in-process `Map`. That is correct for a single-instance
PBX (which this is) but does not share across instances and clears on restart.
Moving to MongoDB/Redis-backed sessions is a deliberate future change — it has
its own tradeoffs (a store dependency, and restart behaviour) and is noted here
rather than half-done.
