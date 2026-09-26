# Security review — P2 batch

## Recording (P1) — already fixed

The RTP sequence-wrap and hardcoded-codec issues were fixed in an earlier batch
and are present in the current build: recordings are ordered by `rtp.timestamp`
(32-bit, no wrap) and decoded per the negotiated payload type (mu-law / A-law).
No further change.

## Login hardening (P2) — already fixed

Rate limiting (always on, independent of Turnstile), the `Secure` session
cookie under HTTPS, POST logout, and the env-fallback admin warning are all in
the current build. The one item left open is the **session store**: it is an
in-process `Map`, correct for a single instance but not shared across instances
or restarts. Moving to a Mongo/Redis-backed store is a deliberate future change
(it adds a store dependency and changes restart behaviour) and is not done here.

## Encryption key separated from the API secret (fixed)

`ADMIN_SECRET` was used both for API authentication and for encrypting CRM
credentials — two different security domains, and rotating the API secret would
have made stored CRM credentials undecryptable.

Now `src/services/crm/crypto.js` uses a dedicated **`CREDENTIAL_ENCRYPTION_KEY`**
(a real 32-byte key, hex or base64; anything else is stretched with PBKDF2),
falling back to `ADMIN_SECRET` for existing installs. Blobs are **key-versioned**
(`v1:` = current key, `v0:` = legacy): decryption tries the blob's own key then
the others, so you can roll a new key in and re-encrypt lazily. Rotating
`ADMIN_SECRET` no longer touches CRM credentials once a dedicated key is set.

To adopt: `openssl rand -hex 32` → put it in `CREDENTIAL_ENCRYPTION_KEY`,
restart. Existing credentials keep decrypting; new saves use the new key.

## `/health` no longer leaks operational detail (fixed)

The public `GET /health` previously exposed MongoDB/RTPEngine state, trunk
status, extension counts, active calls, dialer campaigns and memory. It now
returns only:

```json
{ "status": "ok" }
```

Full diagnostics moved to **`GET /health/details`**, behind admin session.
Uptime checks and load balancers use the public endpoint; the Settings → System
tab reads the authenticated `/api/health` (version + uptime) as before.

## Uncaught exceptions are now fatal (fixed)

Two conflicting handlers existed, and the in-`main` one logged and continued.
For a SIP server, continuing after an uncaught exception risks running on
corrupt call state. There is now a single policy: log the error, then exit
non-zero so systemd/Docker restarts from a clean state. `unhandledRejection` is
logged but not fatal (usually a stray promise, not core-state corruption).
Override with `CRASH_ON_UNCAUGHT=false` only if you have a specific reason.

Make sure the service is set to restart — the installer's unit uses
`Restart=always`; verify with `systemctl show shadowpbx -p Restart`.
