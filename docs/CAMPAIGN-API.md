# Campaign Agent API

A read-only feed of **who is free to take a call** on one ring group, queue or
extension. Built for predictive diallers, which need that number and nothing
else, but it is plain HTTP and WebSocket — anything can consume it.

A key cannot place calls, read CDRs, change configuration, or see any group
other than the one it is attached to.

---

## 1. Create a key

**Settings → Campaign API → New key.** Give it a name, pick the ring group,
queue or extension it should read, and ShadowPBX returns three things:

```
API URL        https://pbx.example.com/api/campaign/agents/ab12cd34ef567890
WebSocket URL  wss://pbx.example.com/api/campaign/agents/ab12cd34ef567890/ws
API key        xK3n...                       (shown once)
```

Only a SHA-256 hash of the secret is stored, so it cannot be shown again. Lose
it and you issue a new key.

The `keyId` in the URL is public; the secret is the credential. Keys can be
disabled (traffic stops, key is kept) or revoked (gone).

---

## 2. REST

```bash
curl -H "Authorization: Bearer $API_KEY" \
  https://pbx.example.com/api/campaign/agents/ab12cd34ef567890
```

```json
{
  "group": "Sales queue",
  "target": "queue/700",
  "total": 3,
  "available": 2,
  "agents": [
    { "id": "2001", "name": "Asha", "status": "available", "presence": "idle",      "since": 1763467200000 },
    { "id": "2002", "name": "Ravi", "status": "busy",      "presence": "confirmed", "since": 1763467330000 },
    { "id": "2003", "name": "Mo",   "status": "offline",   "reason": "not registered" }
  ],
  "wsUrl": "wss://pbx.example.com/api/campaign/agents/ab12cd34ef567890/ws",
  "at": "2026-11-18T10:42:03.221Z"
}
```

| Field | Meaning |
|---|---|
| `group` | name of the ring group or queue, for display |
| `target` | `queue/700`, `ringgroup/600` or `extension/2001` |
| `total` | agents configured on it |
| `available` | agents that could take a call **right now** |
| `agents[].status` | `available`, `busy`, `offline`, `dnd` |
| `agents[].presence` | raw PBX state: `idle`, `ringing`, `confirmed`, `held`, `dnd` |
| `at` | when the snapshot was taken, ISO 8601 |

### What "available" means

An agent counts as available when **all** of these hold:

1. the extension is a member of the target,
2. a phone is currently registered to it, and
3. presence says it is not on a call, not being rung, and not on hold.

An agent who is logged in but talking is **not** available. This is the
distinction that matters: pace against "logged in" and you will abandon calls.

`offline` carries a `reason` — `not registered`, `disabled`, or
`no such extension` — which is usually enough to find the problem without
opening the PBX.

### Errors

| Code | Body | Meaning |
|---|---|---|
| 401 | `{"error":"missing API key"}` | no `Authorization` header and no `?token=` |
| 401 | `{"error":"invalid API key"}` | unknown key id **or** wrong secret |
| 403 | `{"error":"this API key is disabled"}` | key exists, switched off in Settings |
| 500 | `{"error":"could not read agent state"}` | the PBX could not answer |

Unknown key and wrong secret deliberately return the same 401: a 404 would
confirm which key ids exist.

If the group a key points at is deleted, requests still succeed with
`total: 0`, `available: 0` and an `error` string naming what went missing.
Treat that as "do not dial", not as a transport failure.

---

## 3. WebSocket

Same JSON, pushed when something changes.

```js
const ws = new WebSocket(
  'wss://pbx.example.com/api/campaign/agents/ab12cd34ef567890/ws?token=' +
  encodeURIComponent(API_KEY));

ws.onmessage = (ev) => {
  const snap = JSON.parse(ev.data);
  dialer.setAvailableAgents(snap.available);
};
```

Authenticate either way:

- `Authorization: Bearer <secret>` on the upgrade request — preferred, and what
  a server-side client should do; or
- `?token=<secret>` in the query string, for browser clients, which cannot set
  headers on a WebSocket.

A bad credential is refused at the upgrade with `401`, before the socket opens.

Behaviour:

- **On connect** you get a full snapshot immediately.
- **On change** you get another. Changes are detected from presence events the
  instant they happen, plus a 3-second sweep that catches registrations
  expiring and configuration edits, which emit no event.
- **No change, no frame.** Identical snapshots are not re-sent, so an idle
  queue is an idle socket.
- Every frame is a **full snapshot**, never a delta. Replace your state with it
  — a missed frame then cannot leave you stale.
- `{"type":"ping"}` is answered with `{"type":"pong"}` if you want a keepalive.
  Ignore `pong` frames when parsing snapshots.

### Reconnecting

The socket can drop for ordinary reasons: PBX restart, proxy idle timeout,
network blip. Reconnect with backoff and **poll REST while disconnected** — a
dialler that silently keeps its last number is the failure mode this API exists
to prevent.

A reasonable schedule: retry at 1s, 2s, 5s, 10s, then every 30s, polling REST
every 5s throughout.

---

## 4. Treat stale data as zero

Whatever you build, apply a freshness rule. If the newest snapshot is older
than roughly 20 seconds, treat availability as **0** rather than reusing the
last good figure.

Dialling against a number that stopped updating is how campaigns end up calling
people with no one to connect them to.

---

## 5. Hand-off

This API says *whether* to dial. It does not say *where* to send the call.

Add an inbound route on ShadowPBX (**Routes → Inbound**) pointing at the same
ring group or queue, and have the dialler send confirmed calls to that number
over SIP. The queue picks the agent; the dialler never chooses one and never
reserves one.

Keeping those two concerns apart is deliberate: the dialler needs no knowledge
of your agents, and changing queue strategy or membership on the PBX requires no
change on the dialler.

---

## 6. Minimal client

```js
const BASE = 'https://pbx.example.com/api/campaign/agents/ab12cd34ef567890';
const KEY = process.env.PBX_API_KEY;
const STALE_MS = 20000;

let snap = { available: 0, total: 0, at: 0 };
const fresh = () => Date.now() - snap.at < STALE_MS;
const available = () => (fresh() ? snap.available : 0);

async function poll() {
  try {
    const r = await fetch(BASE, { headers: { Authorization: `Bearer ${KEY}` } });
    if (r.ok) snap = { ...(await r.json()), at: Date.now() };
  } catch (e) { /* leave snap alone; fresh() will go false on its own */ }
}
setInterval(poll, 5000);
poll();

function connect(attempt = 0) {
  const ws = new WebSocket(`${BASE}/ws?token=${encodeURIComponent(KEY)}`);
  ws.onmessage = (ev) => {
    const body = JSON.parse(ev.data);
    if (body.type === 'pong') return;
    snap = { ...body, at: Date.now() };
  };
  ws.onclose = () => setTimeout(() => connect(attempt + 1),
    [1000, 2000, 5000, 10000, 30000][Math.min(attempt, 4)]);
}
connect();
```

`available()` is the only thing a dialler needs from this.
