# ShadowPBX — API Security Model (v3.0)

## What changed, and why

Until v3.0 the whole API was protected by a single shared secret:

```js
const token = req.headers['x-api-key'] || req.query.apikey;
if (token !== process.env.ADMIN_SECRET) return res.status(401)...
```

and that same `ADMIN_SECRET` was injected into **every rendered page** as
`apiKey`, where page JavaScript used it for its own calls. Any logged-in
user — including an agent on a page they were entitled to see — could open
DevTools, read the master credential out of the HTML, and then call every
administrative endpoint directly: extensions, trunks, routes, users,
settings, recordings, security controls, the dialer, monitoring, CDR.

The role checks in the web UI were decoration; they controlled which pages
rendered, not what the API would do. The query-string form made it worse:
`?apikey=...` lands in nginx access logs, browser history and any proxy in
between.

## The model now

```
Browser  →  session cookie  →  role from the session  →  per-route policy
Service  →  X-API-Key header →  role "service"        →  full access
```

- The browser never receives a service credential. `apiKey` in template
  locals is now an empty string, kept only so existing views render.
- Browser calls to `/api` authenticate with the login session cookie, sent
  automatically on same-origin requests.
- `X-API-Key` remains for machine-to-machine callers and is accepted **only**
  from the header. A key in the query string is rejected with a message
  saying so, rather than silently working.
- Every `/api` route is then checked against the caller's role.

Implemented in `src/middleware/api-auth.js`, mounted in `src/app.js`.

## Authorization policy

**Deny by default.** Anything not explicitly listed is admin-only, so a newly
added endpoint is closed until someone opens it deliberately.

| Role | Can do |
|---|---|
| service (API key) | Everything — machine-to-machine integrations |
| admin | Everything |
| supervisor | Everything above agent, plus call monitoring, recordings, campaigns, the dialer, appointments, blocklist and DNC management |
| agent | Directory and presence, active/parked calls, call control (hold, resume, transfer, park, pickup), their own voicemail and chat, queue and campaign login/logout for their own extension, CDR list and notes, CRM lookups, DNC checks |

Agents are explicitly **denied**: extensions (write), trunks, routes, IVR,
time conditions, users, SIP domains, CRM configuration, security controls,
recordings, call monitoring, audio upload and delete, and anything unlisted.

Supervisors are denied the same infrastructure endpoints as agents; they
differ in oversight, not configuration rights.

### Ownership

Where an extension or username appears in the path, agents are held to their
own:

- `/voicemail/:ext/...` — their own mailbox only
- `/chat/conversations/:username` — their own conversations
- `/chat/messages/:user1/:user2` — they must be one side of it
- `/campaigns/:id/agents/:ext/...` — their own agent state

Admins and supervisors are exempt from these checks.

## Audio endpoints

`/api/cdr/:callId/recording`, `/api/voicemail/:ext/:messageId/audio` and
`/api/audio/play/:filename` were previously **unauthenticated**, on the
reasoning that they were shareable links. Anyone who had or guessed a callId
could download a call recording without logging in. They now require a
session: recordings are admin/supervisor only, and a voicemail box is
restricted to its owner.

## Known limits

Worth being explicit about what this does *not* yet do:

- **Row-level CDR scoping.** Agents can list CDRs, not only their own calls.
  Restricting that needs a query filter inside the CDR handler, not a route
  policy.
- **Call-ownership on control actions.** An agent can hold or transfer any
  call id they know, not only calls they are on. The call ids are random and
  not enumerable through the API, but this is not an authorization check.
- **Sessions are in memory.** They clear on restart, so everyone is logged
  out by a restart or an update, and a second instance cannot share them.
- **`ADMIN_SECRET` is still a single shared service credential.** Per-integration
  keys with their own scopes would be the next step.

## If something breaks

A page that suddenly gets 403s is the policy being stricter than the UI. Check
the log — every denial is recorded with the role, user, method and path:

```bash
grep "API:.*denied" /var/log/shadowpbx/$(ls -t /var/log/shadowpbx/ | head -1)
```

Then either the page shouldn't be offering that action to that role, or the
route belongs in the policy table in `src/middleware/api-auth.js`.
