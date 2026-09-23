# Web Dialer — Phase 2: Guest / Anonymous Extensions

Web visitors have no extension. Each web call now gets a short-lived guest
identity (`web-8f3a2c`) that exists only for that call, lives in memory only,
and can reach exactly one destination.

## How it works

1. The widget calls `POST /api/webcall/token` (public, rate-limited) with its
   `widgetId`.
2. The PBX mints `username` + `password`, bound to that widget, origin and IP.
3. The browser authenticates its REGISTER/INVITE with those credentials over
   WSS — ordinary SIP digest auth, same as a desk phone.
4. The token is single-use. Unused, it dies after `WEBCALL_TOKEN_TTL` (60s).
5. On hangup the identity is destroyed.

Guests are never written to the Extension collection — no stray registrations,
no BLF noise, nothing to clean up.

## Lockdown

A guest can only reach its widget's destination. Anything else — a PSTN number,
another extension, a feature code such as `*11` — is refused with 403 and
recorded in the security tracker. Enforced in the call handler, not the UI, so
toll fraud is structurally impossible rather than merely discouraged.

## Admin

**Network → WebRTC** now has *Web dialer widgets* and *Active guest sessions*.
Create a widget, point it at an extension or ring group, optionally restrict it
to your own domains, and watch guests appear and disappear as calls come and go.

## API

Public (no auth, rate-limited):

| Endpoint | Purpose |
|---|---|
| `POST /api/webcall/token` | issue a single-use guest credential |
| `GET /api/webcall/config/:widgetId` | branding for the button — never the destination |

Admin (`X-API-Key`, or the session equivalents under `/webcall/api/...`):

| Endpoint | Purpose |
|---|---|
| `GET/POST /api/webcall/widgets` | list / create |
| `PUT/DELETE /api/webcall/widgets/:widgetId` | update / delete |
| `GET /api/webcall/guests` | active guest sessions |
| `DELETE /api/webcall/guests/:username` | end one |

`/health` now includes `checks.webcall`.

## Verify

```bash
node scripts/webcall-selftest.js      # 20 checks: issuing, auth, lockdown, lifecycle
```

Then, on the WebRTC page: create a widget pointing at a registered extension,
and from a browser console on the PBX domain:

```js
const t = await (await fetch('/api/webcall/token', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ widgetId: 'YOUR_WIDGET_ID' })
})).json();
```

Put `t.username` / `t.password` into the WebRTC page's test softphone, register,
and dial the widget id. The agent's phone rings; the guest disappears from the
session list on hangup. Phase 4 replaces this manual step with the widget.

## Limits (later phases)

- Destination types `extension` and `ringgroup` work now. `ivr`, `queue` and
  `timecondition` return 503 until Phase 3 wires in full route resolution.
- Pre-call form data (name/number) is captured on the token but not yet shown to
  agents or written to the CDR — that is Phase 6.
- The domain allow-list and rate limits are basic; Phase 7 hardens them
  (CAPTCHA, per-widget caps, attack-monitor integration).
