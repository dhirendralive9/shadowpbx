# Web Dialer — Phase 3 (routing) & Phase 4 (the widget)

## Phase 3 — web calls flow through your normal routing

A guest call now resolves the widget's destination and hands off to the same
engines a PSTN call uses. Nothing about ring strategies, menus or queue
positions is duplicated for web callers.

| Widget destination | Handled by |
|---|---|
| extension | direct B2BUA dial (WebRTC-aware, Phase 1) |
| ringgroup | the existing ring-group engine, all strategies |
| ivr | the IVR engine, DTMF and all |
| queue | the queue engine, MOH and position announcements |
| voicemail | the voicemail engine |
| timecondition | resolved first, then routed to whatever it points at |

Widgets can also have **business hours**: set `businessHours.enabled` with a
time-condition number and closed-hours calls follow that condition's own
no-match destination (voicemail, an after-hours group, and so on).

Every web call gets a CDR with `direction: web-inbound` and is recorded like any
other call. The browser leg stays DTLS-SRTP, the PBX side stays plain G.711, so
the recorder needs no changes.

Guest identities are reclaimed automatically: direct and ring-group calls on
hangup, and IVR/queue/voicemail calls when their CDR reaches a terminal state
(those engines own their own dialogs).

## Phase 4 — the embeddable widget

One tag on any page:

```html
<script src="https://pbx.yourdomain.com/widget.js"
        data-widget="abc123"
        data-label="Call us"
        data-color="#2563eb"
        data-position="bottom-right" async></script>
```

- Floating button opens a small panel; colour, label, position and greeting come
  from the tag or the widget's own branding.
- Asks for the microphone **before** requesting a token, so a refusal doesn't
  burn one.
- Fetches a single-use credential, registers over WSS with SIP.js, and dials the
  widget id — the PBX resolves it to the real destination, which the browser
  never learns.
- In-call: status (connecting / ringing / connected), timer, mute, hang up.
- Handles: insecure page, unsupported browser, blocked microphone, nobody
  available (480/503), busy, media failure, dropped connection.
- Everything renders in a **shadow root**, so host-page CSS can't touch it and it
  can't leak styles onto the page. SIP.js loads from your PBX, not a CDN.

A site can also drive it from its own button:

```js
window.ShadowPBXWidget['abc123'].call();   // open + start
```

### Cross-origin

The widget runs on the customer's site, so `/api/webcall/token` and
`/api/webcall/config/:id` now answer CORS per widget. A widget with
`allowedDomains` answers only those sites; one with none answers any site —
set the list before going live.

## Try it

1. **Network → WebRTC** → create a widget → **Embed** → copy the snippet.
2. Open `https://your-pbx-domain/widget-demo.html`, paste the widget id and load
   it. (The demo page is served from the PBX, so it works even before you have
   allow-listed a customer site.)
3. Click the button, allow the microphone, and call. Check that:
   - the agent's phone rings and audio works both ways;
   - the guest appears in *Active guest sessions* and disappears after hangup;
   - the CDR shows `web-inbound` with a recording.
4. Then paste the snippet on a real site and add its domain to the widget.

## Still to come

- **Phase 5**: full widget admin UI — styling, live preview, business hours.
- **Phase 6**: pre-call name/number reaching the agent (screen pop, CDR, CRM).
  The widget already collects them; they are attached to the token, not yet
  surfaced.
- **Phase 7**: CAPTCHA, tighter rate limits, attack-monitor integration.
- **Phase 8**: TURN (coturn) — until then, visitors behind strict corporate
  firewalls may connect but hear nothing.
