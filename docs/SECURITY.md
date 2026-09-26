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

### CDR access is role-scoped (fixed)

CDR access is now confined by role inside the handler, not left to whatever
filter the client sends:

- **agent** — only calls involving their own extension
- **supervisor** — only calls involving their assigned extensions
- **admin / service** — everything

The scope is `$and`-combined with any client filter, so a client can narrow the
result but can never widen it beyond the extensions they're allowed to see.
`GET /cdr/:callId/notes`, `POST /cdr/:callId/notes` and
`POST /cdr/:callId/disposition` apply the same per-record check, and the note
author is taken from the session (not a spoofable `author` field).

### Chat sender identity is server-derived (fixed)

Both the Socket.IO and REST chat paths now derive the sender from the session,
never the request body. `POST /api/chat/send` ignores `from`/`fromRole` for
logged-in users (service/API callers may still name a sender for integrations),
and `POST /api/chat/read/:from/:to` only lets an agent mark messages that were
sent to them.

## Object-level authorization (call control)

Route RBAC answers "can this role use this endpoint". For live-call control it
is not enough — the object (the call) is named in the path, so the handler also
enforces **participation**:

- `POST /calls/:callId/{hold,resume,transfer,park}` — an agent may act only on a
  call they are a participant in (`fromExt`, `toExt`, or the extension that put
  it on hold). Admins, supervisors and machine (API-key) callers keep broad
  authority. Enforced by `agentMayControlCall` in `routes/api.js`.
- `GET /calls/active` — an agent sees only calls they are on; supervisors and
  admins see all. This closes the enumeration path: an agent can no longer read
  other agents' live call ids and then target them.
- `POST /queues/:number/agents/{login,logout}` and `POST /calls/pickup/:slot` —
  for agents the acting extension is taken from the **session**, never from the
  request body. An agent cannot log another extension in/out of a queue or pick
  up a parked call as someone else.

  Earlier `SECURITY.md` said call ids were "random and not enumerable"; that
  was wrong — `/calls/active` exposed them. The fix is proper object-level
  authorization above, not obscurity.
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
