# ShadowPBX v2.0

A self-hosted, open-source PBX (Private Branch Exchange) built entirely in Node.js. ShadowPBX gives you a full-featured IP phone system — SIP registration, call routing, ring groups, IVR, voicemail, call recording, transfers, hold, parking, and supervisor monitoring — all running as a single-process application on a Linux server.

```
┌──────────────────────────────────────────────────────────────┐
│                        ShadowPBX                             │
│                                                              │
│  ┌───────────┐   ┌─────────────────┐   ┌──────────────────┐ │
│  │  Express   │   │  Drachtio SRF   │   │   Web GUI (EJS)  │ │
│  │  REST API  │   │  SIP Signaling  │   │   + Socket.IO    │ │
│  │  :3000     │   │  B2BUA Logic    │   │   Real-time      │ │
│  └─────┬──────┘   └───────┬─────────┘   └────────┬─────────┘ │
│        │                  │                       │           │
│  ┌─────┴──────┐   ┌───────┴─────────┐                        │
│  │  MongoDB   │   │   Drachtio      │                        │
│  │  Config    │   │   Server        │                        │
│  │  CDR / VM  │   │   :5060 SIP     │                        │
│  └────────────┘   └───────┬─────────┘                        │
│                           │                                  │
│                   ┌───────┴─────────┐                        │
│                   │   RTPEngine     │                        │
│                   │   Media Relay   │                        │
│                   │   Recording     │                        │
│                   │   :10000-20000  │                        │
│                   └─────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
        ▲                ▲                    ▲
        │                │                    │
   ┌────┴─────┐   ┌──────┴──────┐   ┌────────┴────────┐
   │  Admin   │   │ Softphones  │   │  SIP Trunks     │
   │  API     │   │ MicroSIP    │   │  SignalWire     │
   │  Web GUI │   │ X-Lite      │   │  Twilio         │
   └──────────┘   └─────────────┘   └─────────────────┘
```

---

## Features

### Core Telephony
- **SIP Extension Registration** — Digest authentication, multi-device support (up to 5 contacts per extension), NAT-aware contact tracking
- **Internal Calling** — B2BUA-based calls between extensions via `drachtio-fn-b2b-sugar`
- **Call Recording** — Automatic recording through RTPEngine with PCAP-to-WAV conversion (stereo, per-SSRC stream extraction using tshark + sox)
- **Call Detail Records** — Every call logged to MongoDB with full metadata: duration, status, direction, codec, hangup cause, recording path, transfer/park history

### Ring Groups
- **Simultaneous Ringing** — Ring all members at once using `simring()` from `drachtio-fn-b2b-sugar`
- **Multiple Strategies** — `ringall` (simultaneous), `sequential`, `random`, `roundrobin`, `orderby`
- **Sticky Agent** — Route repeat callers to the same agent
- **No-Answer Destination** — Failover to extension, another ring group, or voicemail
- **Caller ID Prefix** — Prepend text to caller ID for group identification

### SIP Trunking
- **Inbound DID Routing** — Route incoming calls by DID number to extensions, ring groups, or IVRs
- **Outbound Routing** — Pattern-based routing with digit stripping, prepend, and caller ID override
- **Provider Support** — Tested with SignalWire and Twilio; works with any standards-based SIP trunk
- **Trunk Registration** — Automatic registration with SIP providers on startup

### IVR / Auto Attendant
- **Multi-Level Menus** — Nested IVR trees with DTMF digit routing (0–9, *, #)
- **Configurable Destinations** — Route to extensions, ring groups, sub-IVRs, voicemail, or external numbers
- **Timeout & Retry** — Configurable input timeout and max retries before fallback destination
- **Custom Greetings** — WAV file playback via RTPEngine

### Call Transfers
- **SIP REFER** — Native softphone-initiated blind transfers
- **REST API Transfer** — Blind and attended transfers via API (`POST /api/calls/:callId/transfer`)
- **Bidirectional SDP Exchange** — Full re-INVITE negotiation ensures audio continuity post-transfer
- **REFER Listeners** — Active on both B2BUA legs for correct party handling

### Call Hold & Music on Hold
- **SIP Hold Detection** — Intercepts re-INVITEs and detects SDP direction changes (`sendonly`/`inactive`)
- **Music on Hold** — WAV file playback through RTPEngine's `play media` command
- **API Hold/Resume** — Programmatic hold and resume via REST endpoints

### Call Parking
- **Numbered Slots** — Park calls on slots 70–79 (configurable) with MOH playback
- **Park & Pickup** — Park via API, retrieve from any extension
- **Timeout Recovery** — Parked calls return to the original party after a configurable timeout

### Voicemail
- **Per-Extension Mailbox** — Automatic voicemail when calls go unanswered
- **Recording & Playback** — Record messages via RTPEngine, stream audio back through API
- **Message Management** — List, mark as read, delete messages via REST API
- **Unread Count** — Summary endpoint for mailbox status

### Supervisor Monitoring
- **Listen Mode** — Silent monitoring of active calls (receive-only audio)
- **Whisper Mode** — Speak to the agent without the caller hearing
- **Barge Mode** — Join the call as a full participant (three-way)
- **Live Mode Switching** — Change between listen/whisper/barge mid-session via API

### Web Dashboard
- **Real-Time Dashboard** — Live view of active calls, extension status, trunk health, and today's stats via Socket.IO (3-second refresh)
- **Admin Pages** — Extensions, Calls, CDR, Voicemail, Ring Groups, Trunks, Routes, IVR, Settings
- **Authentication** — Session-based login with Cloudflare Turnstile CAPTCHA support
- **Responsive UI** — EJS templates with a clean tabbed interface

### Security
- **API Key Authentication** — All API endpoints secured with `X-API-Key` header
- **SIP Rate Limiting** — 30 requests/minute per IP via iptables
- **fail2ban Integration** — 5 failed SIP auth attempts = 1 hour IP ban
- **Stale Registration Cleanup** — All registrations cleared on startup; softphones re-register with fresh NAT mappings
- **API Port Lockdown** — Port 3000 bound to localhost by default (access via SSH tunnel)

---

## Project Structure

```
shadowpbx/
├── package.json
├── scripts/
│   ├── install-drachtio.sh       # Full server installer (Debian 12)
│   ├── setup-features.sh         # Post-install feature setup (MOH, VM, park)
│   └── reset-password.js         # Admin GUI password reset
├── src/
│   ├── app.js                    # Entry point — wires all services, SIP handlers, Express
│   ├── models/
│   │   └── index.js              # Mongoose schemas (Extension, RingGroup, Trunk,
│   │                             #   InboundRoute, OutboundRoute, IVR, CDR,
│   │                             #   VoicemailMessage, ActiveCall)
│   ├── services/
│   │   ├── registrar.js          # SIP REGISTER handler, digest auth, contact management
│   │   ├── call-handler.js       # INVITE handler, B2BUA setup, RTPEngine integration
│   │   ├── call-router.js        # Routing logic (extension → ring group → trunk → IVR)
│   │   ├── ring-group.js         # Ring group strategies (simring, sequential, round-robin)
│   │   ├── trunk-manager.js      # SIP trunk registration and management
│   │   ├── transfer-handler.js   # Blind/attended transfers (SIP REFER + REST API)
│   │   ├── hold-handler.js       # Hold/resume with Music on Hold via RTPEngine
│   │   ├── park-handler.js       # Call parking on numbered slots
│   │   ├── voicemail-handler.js  # Voicemail recording, playback, message management
│   │   ├── ivr-handler.js        # IVR auto attendant with DTMF navigation
│   │   ├── dtmf-listener.js      # DTMF event capture from RTPEngine
│   │   └── monitor-handler.js    # Supervisor listen/whisper/barge
│   ├── routes/
│   │   ├── api.js                # REST API endpoints (all CRUD + call control)
│   │   └── web.js                # Web GUI routes, session auth, Turnstile verification
│   ├── utils/
│   │   ├── logger.js             # Winston logger
│   │   └── converter.js          # PCAP → WAV recording converter (tshark + sox)
│   ├── views/
│   │   ├── pages/                # EJS pages (dashboard, extensions, calls, cdr,
│   │   │                         #   voicemail, ringgroups, trunks, routes, ivr,
│   │   │                         #   settings, login)
│   │   └── partials/             # EJS partials (head, header, tabs, foot)
│   └── public/
│       ├── css/                  # Stylesheets
│       └── js/                   # Client-side JavaScript
└── LICENSE                       # MIT
```

---

## Tech Stack

| Component | Role |
|-----------|------|
| **Node.js** | Application runtime |
| **Drachtio** | SIP signaling server (REGISTER, INVITE, BYE, REFER) |
| **drachtio-srf** | SIP framework for Node.js |
| **drachtio-fn-b2b-sugar** | B2BUA helper — `simring()`, SDP manipulation |
| **RTPEngine** | Media relay, call recording (PCAP), MOH playback, DTMF detection |
| **MongoDB** | Extensions, CDR, voicemail, ring groups, trunks, routes, IVR config |
| **Express** | REST API and web GUI server |
| **EJS** | Server-side HTML templating for the dashboard |
| **Socket.IO** | Real-time dashboard updates |
| **Winston** | Structured logging |
| **tshark + sox** | Recording conversion pipeline (PCAP → stereo WAV) |
| **fail2ban** | SIP brute-force protection |

---

## Quick Start

### Prerequisites

- Debian 12 (or compatible) server
- Root access
- Public IP address (for SIP)

### 1. Install

```bash
git clone https://github.com/dhirendralive9/shadowpbx.git /opt/shadowpbx
cd /opt/shadowpbx
sudo bash scripts/install-drachtio.sh
```

This installs Node.js 18, MongoDB 7, Drachtio (Docker), RTPEngine (Docker), fail2ban, generates all passwords, and creates the systemd service.

### 2. Post-Install Feature Setup

```bash
sudo bash scripts/setup-features.sh
```

Sets up voicemail directories, MOH audio, beep tones, and adds feature-specific environment variables.

### 3. Create Extensions

```bash
curl -X POST http://localhost:3000/api/extensions/bulk \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{"extensions":[
    {"extension":"2001","name":"Alice","password":"secret123"},
    {"extension":"2002","name":"Bob","password":"secret456"},
    {"extension":"2003","name":"Charlie","password":"secret789"}
  ]}'
```

### 4. Register a Softphone

Use MicroSIP, X-Lite, Zoiper, or any SIP softphone:

| Setting | Value |
|---------|-------|
| Server | your-server-ip |
| Port | 5060 |
| Transport | UDP |
| Username | extension number (e.g. `2001`) |
| Password | extension password |

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DRACHTIO_HOST` | `127.0.0.1` | Drachtio server address |
| `DRACHTIO_PORT` | `9022` | Drachtio control port |
| `DRACHTIO_SECRET` | `cymru` | Drachtio shared secret |
| `SIP_DOMAIN` | — | SIP domain (usually server IP) |
| `SIP_PORT` | `5060` | SIP listening port |
| `EXTERNAL_IP` | — | Public IP of the server |
| `RTPENGINE_HOST` | `127.0.0.1` | RTPEngine address |
| `RTPENGINE_PORT` | `22222` | RTPEngine control port |
| `MONGODB_URI` | `mongodb://localhost:27017/shadowpbx` | MongoDB connection string |
| `RECORDINGS_DIR` | `/var/lib/shadowpbx/recordings` | Call recording storage path |
| `API_PORT` | `3000` | Express server port |
| `ADMIN_SECRET` | — | API key for REST endpoints |
| `ADMIN_USER` | `admin` | Web GUI username |
| `ADMIN_PASSWORD` | — | Web GUI password |
| `LOG_LEVEL` | `info` | Logging level (`debug`, `info`, `warn`, `error`) |
| `MOH_DIR` | — | Music on Hold WAV directory |
| `VOICEMAIL_DIR` | — | Voicemail storage directory |
| `VM_BEEP_FILE` | — | Beep tone WAV for voicemail recording |
| `VM_DEFAULT_GREETING` | — | Default voicemail greeting WAV |
| `VM_MAX_MESSAGE_LENGTH` | `120` | Max voicemail message length (seconds) |
| `PARK_SLOT_MIN` | `70` | First call park slot number |
| `PARK_SLOT_MAX` | `79` | Last call park slot number |
| `DTMF_LISTEN_PORT` | `22223` | Port for DTMF events from RTPEngine |
| `MAX_REGISTRATION_EXPIRES` | `300` | Max SIP registration TTL (seconds) |
| `MAX_REGISTER_ATTEMPTS` | `5` | Failed auth attempts before ban |
| `REGISTER_BAN_DURATION` | `300` | Auth ban duration (seconds) |
| `SIP_RATE_LIMIT` | `20` | SIP requests per minute per IP |
| `TURNSTILE_SECRET` | — | Cloudflare Turnstile secret (optional) |
| `TURNSTILE_SITE_KEY` | — | Cloudflare Turnstile site key (optional) |

---

## REST API Reference

All API endpoints are prefixed with `/api` and require the `X-API-Key` header (value = `ADMIN_SECRET` from `.env`).

```
X-API-Key: YOUR_API_KEY
Content-Type: application/json
```

### Health Check (No Auth)

```
GET /health
```

Returns: `{ "status": "ok", "service": "ShadowPBX", "version": "2.0.0", "uptime": 12345 }`

---

### Extensions

**List all extensions**
```
GET /api/extensions
```
Returns all extensions with registration status and active contacts.

**Get single extension**
```
GET /api/extensions/:ext
```

**Create extension**
```
POST /api/extensions
```
Body: `{ "extension": "2001", "name": "Alice", "password": "secret123", "email": "alice@example.com" }`

Required fields: `extension`, `name`, `password`. Optional: `email`.

**Bulk create extensions**
```
POST /api/extensions/bulk
```
Body: `{ "extensions": [ { "extension": "2001", "name": "Alice", "password": "pass1" }, ... ] }`

Returns per-extension status (`created`, `exists`, or `error`).

**Update extension**
```
PUT /api/extensions/:ext
```
Body (any of): `{ "name": "Alice Smith", "password": "newpass", "email": "new@example.com", "enabled": true }`

**Delete extension**
```
DELETE /api/extensions/:ext
```

---

### Ring Groups

**List ring groups**
```
GET /api/ringgroups
```

**Create ring group**
```
POST /api/ringgroups
```
Body:
```json
{
  "number": "601",
  "name": "Sales Team",
  "strategy": "ringall",
  "members": ["2001", "2002", "2003"],
  "ringTime": 30
}
```
Required: `number`, `name`, `members`. Optional: `strategy` (default `ringall`), `ringTime` (default `30`).

Strategies: `ringall` / `simultaneously`, `sequential` / `orderby`, `random`, `roundrobin`.

**Update ring group**
```
PUT /api/ringgroups/:number
```

**Delete ring group**
```
DELETE /api/ringgroups/:number
```

---

### SIP Trunks

**List trunks**
```
GET /api/trunks
```

**Create trunk**
```
POST /api/trunks
```
Body:
```json
{
  "name": "signalwire-main",
  "provider": "signalwire",
  "host": "example.signalwire.com",
  "username": "your-username",
  "password": "your-password",
  "port": 5060,
  "register": true
}
```
Required: `name`, `host`, `username`, `password`. Trunk registers immediately on creation.

**Delete trunk**
```
DELETE /api/trunks/:name
```

---

### Inbound Routes

**List inbound routes**
```
GET /api/inbound-routes
```

**Create inbound route**
```
POST /api/inbound-routes
```
Body:
```json
{
  "did": "+15551234567",
  "name": "Main Number",
  "destination": {
    "type": "ringgroup",
    "target": "601"
  }
}
```
Required: `name`, `destination`. Optional: `did` (empty = catch-all).

Destination types: `extension`, `ringgroup`, `ivr`, `hangup`.

**Delete inbound route**
```
DELETE /api/inbound-routes/:id
```

---

### Outbound Routes

**List outbound routes**
```
GET /api/outbound-routes
```

**Create outbound route**
```
POST /api/outbound-routes
```
Body:
```json
{
  "name": "US Domestic",
  "patterns": ["1NXXNXXXXXX", "NXXNXXXXXX"],
  "trunk": "signalwire-main",
  "prepend": "1",
  "strip": 0,
  "callerIdNumber": "+15559876543",
  "priority": 10
}
```
Required: `name`, `patterns`, `trunk`. Optional: `prepend`, `strip`, `callerIdNumber`, `priority`.

**Delete outbound route**
```
DELETE /api/outbound-routes/:id
```

---

### IVR / Auto Attendant

**List IVRs**
```
GET /api/ivr
```

**Get single IVR**
```
GET /api/ivr/:number
```

**Create IVR**
```
POST /api/ivr
```
Body:
```json
{
  "number": "800",
  "name": "Main Menu",
  "greeting": "/path/to/greeting.wav",
  "options": [
    { "digit": "1", "destination": { "type": "ringgroup", "target": "601" } },
    { "digit": "2", "destination": { "type": "extension", "target": "2001" } },
    { "digit": "9", "destination": { "type": "ivr", "target": "801" } },
    { "digit": "0", "destination": { "type": "extension", "target": "2003" } }
  ],
  "timeout": 10,
  "maxRetries": 3,
  "timeoutDest": { "type": "voicemail", "target": "2001" }
}
```
Required: `number`, `name`, `options`. Option destination types: `extension`, `ringgroup`, `ivr`, `voicemail`, `external`, `hangup`.

**Update IVR**
```
PUT /api/ivr/:number
```

**Delete IVR**
```
DELETE /api/ivr/:number
```

---

### Active Calls & Call Control

**List active calls**
```
GET /api/calls/active
```
Returns all in-progress calls with caller/callee, status, hold state, and CDR call ID.

**Transfer a call**
```
POST /api/calls/:callId/transfer
```
Body: `{ "target": "2002", "type": "blind" }`

Required: `target`. Optional: `type` (default `blind`).

**Hold a call**
```
POST /api/calls/:callId/hold
```

**Resume a held call**
```
POST /api/calls/:callId/resume
```

**Park a call**
```
POST /api/calls/:callId/park
```
Body (optional): `{ "slot": "71" }` — auto-assigns if omitted.

**Pickup a parked call**
```
POST /api/calls/pickup/:slot
```
Body: `{ "extension": "2001" }`

**List parked calls**
```
GET /api/calls/parked
```

---

### Voicemail

**List messages for an extension**
```
GET /api/voicemail/:ext
```
Query params: `limit` (default 50), `page` (default 1), `unread=true` (filter unread only).

**Get mailbox summary**
```
GET /api/voicemail/:ext/summary
```
Returns total and unread message counts.

**Mark message as read**
```
POST /api/voicemail/:ext/:messageId/read
```

**Delete message**
```
DELETE /api/voicemail/:ext/:messageId
```

**Stream voicemail audio**
```
GET /api/voicemail/:ext/:messageId/audio
```
Returns `audio/wav` stream.

---

### Supervisor Monitoring

**Start monitoring a call**
```
POST /api/calls/:callId/monitor
```
Body: `{ "supervisorExt": "2001", "mode": "listen" }`

Modes: `listen` (silent), `whisper` (speak to agent only), `barge` (three-way).

**Change monitor mode**
```
POST /api/monitors/:monitorId/mode
```
Body: `{ "mode": "whisper" }`

**Stop monitoring**
```
DELETE /api/monitors/:monitorId
```

**List active monitor sessions**
```
GET /api/monitors
```

---

### Call Detail Records (CDR)

**Query CDR**
```
GET /api/cdr
```
Query params:

| Param | Description |
|-------|-------------|
| `limit` | Results per page (default 50) |
| `page` | Page number (default 1) |
| `search` | Search from, to, or DID number |
| `extension` | Filter by extension (as caller or callee) |
| `status` | Filter by status: `ringing`, `answered`, `completed`, `missed`, `failed`, `busy`, `voicemail` |
| `direction` | Filter by direction: `internal`, `inbound`, `outbound` |
| `from` | Start date (ISO format) |
| `to` | End date (ISO format) |

Response includes paginated results with `total`, `page`, `limit`, and `pages`.

**Stream call recording**
```
GET /api/cdr/:callId/recording
```
Returns `audio/wav` stream of the call recording.

---

### System Stats

**Get system stats**
```
GET /api/stats
```
Returns: total calls, today's calls, active calls, total extensions, ring group count, and trunk status.

---

## Data Models

### Extension
- `extension` (string, unique) — Extension number (e.g. "2001")
- `name` (string) — Display name
- `password` (string) — SIP auth password
- `email` (string, optional) — Email address
- `enabled` (boolean, default true)
- `maxContacts` (number, default 5) — Max simultaneous device registrations
- `registrations` (array) — Active SIP contacts with IP, port, User-Agent, expiry

### Ring Group
- `number` (string, unique) — Group number (e.g. "601")
- `name` (string) — Group name
- `strategy` (enum) — `simultaneously`, `orderby`, `random`, `roundrobin`, `ringall`, `sequential`
- `members` (array of strings) — Member extension numbers
- `ringTime` (number, default 30) — Seconds to ring before timeout
- `stickyAgent` (boolean) — Route repeat callers to same agent
- `noAnswerDest` (object) — Failover destination on no answer
- `callerIdPrefix` (string) — Prefix added to caller ID

### Trunk
- `name` (string, unique) — Trunk identifier
- `provider` (string, default "signalwire") — Provider name
- `host` (string) — SIP server hostname
- `username` / `password` (string) — SIP credentials
- `port` (number, default 5060)
- `transport` (string, default "udp")
- `register` (boolean, default true) — Whether to register with provider

### Inbound Route
- `did` (string) — DID number to match (empty = catch-all)
- `name` (string) — Route name
- `destination` — `{ type: "extension"|"ringgroup"|"ivr"|"hangup", target: "..." }`

### Outbound Route
- `name` (string) — Route name
- `patterns` (array of strings) — Dial patterns to match
- `trunk` (string) — Trunk name to use
- `prepend` (string) — Digits to prepend before sending
- `strip` (number) — Digits to strip from the front
- `callerIdNumber` (string) — Override caller ID
- `priority` (number, default 10) — Lower = higher priority

### IVR
- `number` (string, unique) — IVR number
- `name` (string) — IVR name
- `greeting` (string) — Path to greeting WAV file
- `options` (array) — DTMF digit → destination mappings
- `timeout` (number, default 10) — Seconds to wait for input
- `maxRetries` (number, default 3) — Replays before failover
- `timeoutDest` (object) — Destination on timeout

### CDR (Call Detail Record)
- `callId` (string, unique) — Internal call identifier
- `from` / `to` (string) — Caller and callee
- `direction` — `internal`, `inbound`, `outbound`
- `status` — `ringing`, `answered`, `completed`, `missed`, `failed`, `busy`, `voicemail`
- `startTime` / `answerTime` / `endTime` (Date)
- `duration` / `talkTime` (number, seconds)
- `hangupCause` / `hangupBy` — Termination details
- `recorded` (boolean) / `recordingPath` / `recordingSize`
- `trunkUsed` / `didNumber` — Trunk and DID info for external calls
- `transferredBy` / `transferredTo` / `transferType` / `transferTime` — Transfer metadata
- `parkedSlot` / `parkedBy` / `parkedAt` / `pickedUpBy` / `pickedUpAt` — Park metadata
- `voicemailId` — Link to voicemail message if applicable

### Voicemail Message
- `messageId` (string, unique) — Message identifier
- `extension` (string) — Mailbox extension
- `callerID` (string) — Who left the message
- `duration` (number, seconds)
- `recordingPath` (string) — WAV file path
- `read` (boolean) / `readAt` (Date)

---

## Web Dashboard

Access the web GUI at `http://your-server:3000/` (default localhost-only; use SSH tunnel for remote access).

```bash
ssh -L 3000:localhost:3000 root@your-server-ip
# Then open http://localhost:3000 in your browser
```

**Pages:** Dashboard, Extensions, Active Calls, CDR, Voicemail, Ring Groups, Trunks, Routes, IVR, Settings.

The dashboard provides real-time updates via Socket.IO showing active calls, online extensions, trunk status, today's call volume, recent CDR entries, and unread voicemail count.

---

## Logging & Debugging

Logs are written to:
- `/var/log/shadowpbx/shadowpbx.log` — Application log
- `/var/log/shadowpbx/error.log` — Error log

Set `LOG_LEVEL=debug` in `.env` for verbose SIP and RTPEngine tracing, then restart:

```bash
systemctl restart shadowpbx
tail -f /var/log/shadowpbx/shadowpbx.log
```

---

## Deployment

ShadowPBX runs as a systemd service:

```bash
systemctl start shadowpbx      # Start
systemctl stop shadowpbx       # Stop
systemctl restart shadowpbx    # Restart
systemctl status shadowpbx     # Check status
journalctl -u shadowpbx -f     # Stream logs
```

**Manual file deployment:**
```bash
# Copy updated files to server
scp -r src/ root@server:/opt/shadowpbx/src/
ssh root@server "systemctl restart shadowpbx"
```

**Git-based deployment:**
```bash
cd /opt/shadowpbx
git pull origin main
npm install --production
systemctl restart shadowpbx
```

---

## Firewall & Security

The install script configures:
- **SIP rate limiting** — 30 SIP requests/minute per IP via iptables
- **fail2ban** — Monitors `/var/log/shadowpbx/shadowpbx.log` for failed auth; 5 failures = 1 hour ban
- **API lockdown** — Port 3000 accepts connections from `127.0.0.1` only
- **RTP range** — UDP ports 10000–20000 open for media

Required open ports:

| Port | Protocol | Purpose |
|------|----------|---------|
| 5060 | UDP/TCP | SIP signaling |
| 10000–20000 | UDP | RTP media |
| 3000 | TCP | API + Web GUI (localhost only) |
| 22 | TCP | SSH |

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Roadmap

- WebRTC browser calling
- Multi-tenant support
- Webhook events for call lifecycle
- Billing and usage tracking
- API token management (per-user keys)
