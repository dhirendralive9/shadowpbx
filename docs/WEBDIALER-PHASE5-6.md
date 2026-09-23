# Web Dialer — Phase 5 (admin UI) & Phase 6 (caller info to agents)

## Phase 5 — Call flow → Web dialer

Widgets now have a proper page of their own at **Call flow → Web dialer**:

- Create, edit, enable/disable and delete widgets.
- Pick the destination from dropdowns of your actual extensions, ring groups,
  IVRs, queues and time conditions — no typing numbers and hoping.
- Business hours: pick a time condition; closed-hours calls follow that
  condition's own no-match destination.
- Appearance: label, colour, position and greeting, with a **live preview** of
  the button and panel as the visitor will see them.
- Access: allowed sites and a concurrent-call cap.
- Embed snippet with a copy button, pre-filled with the widget's own styling.

The widget list and the guest-session table have moved off the WebRTC page,
which now just links here. WebRTC keeps the bridge status, self-test and test
softphone.

## Phase 6 — the agent sees who is calling

The pre-call form now travels with the call:

1. The widget sends the visitor's details on the INVITE as `X-Web-Name`,
   `X-Web-Number`, `X-Web-Page` and `X-Web-Widget`, as well as on the token.
   Headers win; the token is the fallback. Values are stripped of anything that
   could break or inject into a SIP message.
2. **Screen pop** — the agent gets the usual floating card before answering,
   showing the name, number (or "No number given"), which widget the call came
   from, and the page the visitor was on, with a link to open it. It goes
   through the existing Socket.IO screen-pop path, so nothing new runs on the
   agent's machine.
3. **CRM** — if the number matches a contact, the normal CRM screen pop wins.
   If it doesn't, and the widget has *Create a CRM contact for unknown web
   callers* ticked, the caller is filed as a new contact with the widget and
   page recorded as the source.
4. **CDR** — each web call stores `webSource` (widget, page, origin) and
   `webCaller` (name, number). The CDR page shows a **web** badge, hovering it
   reveals the widget and page, and *Web* is now a direction filter.

Screen pops work for web callers even with no CRM connected and no number
given — the widget and page are enough to be useful.

## Try it

1. **Call flow → Web dialer** → add a widget → set the pre-call form to
   "name and number" → Save. The embed snippet appears.
2. Open `/widget-demo.html`, load the widget, enter a name and number, and call.
3. On the agent's screen: the card shows the name, number, widget and page.
4. After hanging up, check the CDR: a **web** badge on the row, with the widget
   and page in the tooltip.

## Remaining

- **Phase 7**: CAPTCHA, tighter per-widget rate limits, attack-monitor
  integration for web-call floods.
- **Phase 8**: TURN (coturn) — until then, visitors behind strict corporate
  firewalls may connect but hear nothing.
