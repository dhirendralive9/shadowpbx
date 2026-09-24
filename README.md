# ShadowPBX v3.0

A self-hosted, open-source PBX (Private Branch Exchange) built entirely in Node.js. ShadowPBX gives you a full-featured IP phone system — SIP registration, call routing, ring groups, IVR, queues, voicemail, call recording, transfers, hold, parking, supervisor monitoring, a predictive dialer and CRM integration — all running on a Linux server.

**New in v3.0 — browser calling.** Agents can work from a browser instead of a desk phone, and any website can carry a "Call us" button that rings straight into your PBX. Visitors need nothing but a microphone: no phone number, no app, no plugin. Web calls flow through the same ring groups, IVRs and queues as PSTN calls, land in the same CDR, and are recorded the same way.

```
┌─────────────────────────────────────────────────────────────────┐
│                          ShadowPBX                              │
│                                                                 │
│  ┌────────────┐  ┌──────────────────┐  ┌──────────────────────┐ │
│  │  Express   │  │  Drachtio SRF    │  │   Web GUI (EJS)      │ │
│  │  REST API  │  │  SIP Signaling   │  │   + Socket.IO        │ │
│  │  :3000     │  │  B2BUA Logic     │  │   Real-time          │ │
│  └─────┬──────┘  └───────┬──────────┘  └────────┬─────────────┘ │
│        │                 │                      │               │
│  ┌─────┴──────┐  ┌───────┴──────────┐  ┌───────┴─────────────┐ │
│  │  MongoDB   │  │  Drachtio Server │  │  Nginx (SSL/WSS)    │ │
│  │  Config    │  │  UDP :5060       │  │  HTTPS :443         │ │
│  │  CDR / VM  │  │  WS :5061        │  │  WSS /ws → :5061    │ │
│  └────────────┘  └───────┬──────────┘  └─────────────────────┘ │
│                          │                                      │
│  ┌───────────────────────┴──────────────────────────────────┐   │
│  │                    RTPEngine (Docker)                     │   │
│  │  Media Relay | Recording (PCAP) | MOH | DTMF             │   │
│  │  Ports :10000-20000                                      │   │
│  └───────────────────────┬──────────────────────────────────┘   │
│                          │ pcap + metadata files                 │
│  ┌───────────────────────┴──────────────────────────────────┐   │
│  │              Recording Worker (separate process)         │   │
│  │  Watches spool dir | pcap→WAV | Links to CDR in MongoDB │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
        ▲                ▲                    ▲
   ┌────┴─────┐   ┌──────┴──────┐   ┌────────┴────────┐
   │  Admin   │   │ Softphones  │   │  SIP Trunks     │
   │  Web GUI │   │ MicroSIP    │   │  SignalWire     │
   │  WebRTC  │   │ X-Lite      │   │  Twilio         │
   └──────────┘   └─────────────┘   └─────────────────┘
```

---

## Architecture

ShadowPBX runs as **two systemd services**:

| Service | Purpose |
|---------|---------|
| `shadowpbx.service` | Main PBX — SIP signaling, call routing, API, web GUI |
| `shadowpbx-recorder.service` | Recording worker — converts pcap→WAV, links to CDR |

Supporting infrastructure (Docker containers):

| Container | Purpose |
|-----------|---------|
| `drachtio` (v0.8.25) | SIP server — UDP :5060 for softphones, WS :5061 for WebRTC |
| `rtpengine` (jambonz) | Media relay, pcap recording, MOH, DTMF detection |

Additional services:

| Service | Purpose |
|---------|---------|
| `nginx` | Reverse proxy — HTTPS + WSS termination |
| `mongod` | Database — extensions, CDR, config |
| `fail2ban` | SIP/SSH brute-force protection |

---

## Recording Architecture

ShadowPBX uses a **two-process recording architecture** for reliability and scalability:

```
Call ends → RTPEngine flushes pcap + metadata to /var/spool/rtpengine/
                                    ↓
         shadowpbx-recorder.service (independent process)
              ├── Detects new metadata file via inotify
              ├── Converts pcap → stereo WAV (tshark + sox)
              ├── Links WAV to CDR record via rtpengineCallId
              └── Background sync catches any missed recordings every 2 min
```

**Why two processes:**
- The PBX process never touches recording conversion — stays focused on calls
- The recording worker can crash/restart independently without affecting live calls
- Long recordings (30+ minutes) convert with dynamic timeouts (up to 15 min cap)
- Sequential processing — no CPU spikes from parallel conversions
- Scalable — add more workers via PM2 cluster mode when needed

**Required tools** (installed automatically): `tshark`, `sox`, `xxd`

---

## Features

### Core Telephony
- SIP extension registration with digest auth and multi-device support
- B2BUA internal calling via `drachtio-fn-b2b-sugar`
- Automatic call recording with dedicated background worker
- Full CDR with duration, status, direction, recording path, transfer/park history

### Ring Groups
- Simultaneous, sequential, random, round-robin, order-by strategies
- Sticky agent routing for repeat callers
- No-answer failover to extension, ring group, or voicemail

### SIP Trunking
- Inbound DID routing to extensions, ring groups, IVRs, queues
- Pattern-based outbound routing with digit manipulation
- Tested with SignalWire and Twilio

### IVR / Auto Attendant
- Multi-level DTMF menus with custom WAV greetings
- Timeout/retry handling with failover destinations

### Call Control
- Blind transfers (SIP REFER + REST API)
- Hold/resume with Music on Hold via RTPEngine
- Call parking on numbered slots (70-79)

### WebRTC & Web Dialer (v3.0)
- Browser calling end to end: RTPEngine bridges the browser's DTLS-SRTP to the plain RTP your phones and trunks use
- Embeddable "Call us" widget — one script tag, shadow-DOM isolated, no CDN
- Guest identities: each web call gets a single-use SIP credential that can reach one destination and nothing else
- Web calls route through your existing ring groups, IVRs, queues, voicemail and time conditions
- Caller's name, number and the page they called from reach the agent as a screen pop and land in the CDR
- Optional CAPTCHA, per-IP and per-widget rate limits, domain allow-lists, concurrency caps
- TURN relay (coturn) with ephemeral credentials for visitors behind restrictive firewalls
- Admin UI at **Call flow → Web dialer**, diagnostics at **Network → WebRTC**

### Voicemail
- Per-extension mailbox with recording/playback
- Message management via REST API

### Supervisor Monitoring
- Listen (silent), Whisper (agent only), Barge (three-way)
- Live mode switching via API

### Call Queues (ACD)
- Multiple strategies: ring all, longest idle, round robin, fewest calls, random
- Queue announcements, overflow handling, agent priority

### Time Conditions
- Schedule-based routing with timezone and holiday support

### Web Dashboard
- Real-time dashboard via Socket.IO
- Role-based access: Admin, Supervisor, Agent
- Auto-generated passwords with copy/download
- Dark/light theme

### Predictive Dialer & CRM
- Campaign engine with auto, predictive and pre-connect (announce / press-1) modes
- Answering machine detection, DNC handling and call dispositions
- Hold, retention and opt-out flows with per-campaign audio
- Salesforce, HubSpot, Zoho, Freshsales and Pipedrive integration with screen pop and disposition sync

### Security
- Nginx reverse proxy with Let's Encrypt SSL
- API port locked to localhost
- SIP rate limiting (20/min per IP)
- fail2ban: 3 fails = 24hr ban, recidive = 7 day ban
- UDP buffer tuning for VoIP
- Crash protection via uncaught exception handlers

---

## Quick Start

### Prerequisites

- Debian 12 or Ubuntu 24 server
- Root access
- Public IP address
- Domain name (optional — enables HTTPS and WebRTC)

### 1. Install

```bash
git clone https://github.com/dhirendralive9/shadowpbx.git /opt/shadowpbx
cd /opt/shadowpbx
sudo bash scripts/install-drachtio.sh
```

The installer prompts for:
- **SIP domain** — server IP or domain (used in SIP signaling)
- **Web domain** — domain pointing to this server (enables HTTPS + WebRTC, optional)
- **SSL email** — for Let's Encrypt (only if web domain provided)

**What it installs automatically:**
- Node.js 18, MongoDB 7 (with auth), Docker
- Drachtio v0.8.25 (UDP :5060 + WS :5061)
- RTPEngine with pcap recording to `/var/spool/rtpengine/`
- Nginx reverse proxy (HTTPS if domain provided)
- WSS proxy for WebRTC (`wss://domain/ws` → Drachtio's wss listener on 127.0.0.1:5062)
- Let's Encrypt SSL with RSA key (ECDSA not supported by Drachtio)
- `shadowpbx.service` and `shadowpbx-recorder.service`
- fail2ban, iptables firewall, UDP buffer tuning
- All passwords auto-generated

### 2. Feature Setup

```bash
sudo bash scripts/setup-features.sh
```

### 2b. Browser calling (v3.0, optional but recommended)

> **Point your DNS at the server before installing.** Browsers block microphone
> access and `ws://` on anything but HTTPS, so browser calling needs a real
> hostname with a certificate — an IP address alone cannot work.

```bash
sudo bash scripts/setup-webrtc.sh     # checks WSS, RTPEngine ICE, firewall; fixes what it can
sudo bash scripts/setup-turn.sh       # installs coturn so calls work behind strict firewalls
```

`setup-webrtc.sh` ends with a self-test that must report **All checks passed**.
Then open **Network → WebRTC** to run it from the UI, register the test softphone
and place a browser call. See [docs/WEBRTC-PHASE1.md](docs/WEBRTC-PHASE1.md).

To put a call button on a website, go to **Call flow → Web dialer**, create a
widget, and copy its embed snippet:

```html
<script src="https://pbx.yourdomain.com/widget.js"
        data-widget="abc123"
        data-label="Call us"
        data-color="#2563eb"
        data-position="bottom-right" async></script>
```

Test it first on `https://your-pbx-domain/widget-demo.html`.

### 3. Create Extensions

```bash
curl -X POST http://localhost:3000/api/extensions/bulk \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_API_KEY' \
  -d '{"extensions":[
    {"extension":"2001","name":"Alice","password":"secret123"},
    {"extension":"2002","name":"Bob","password":"secret456"}
  ]}'
```

### 4. Register Softphone

| Setting | Value |
|---------|-------|
| Server | your-server-ip |
| Port | 5060 |
| Transport | UDP |
| Username | 2001 |
| Password | extension password |

**MicroSIP tips:** Use G.711 A-law/u-law only, STUN off, ICE off, Keep-Alive 10s.

### 5. Or skip the softphone — use a browser

Agents can register from **Network → WebRTC** (test softphone) over `wss://your-domain/ws`.
Browser-registered extensions ring from direct calls exactly like a desk phone.

---

## Services Management

```bash
# Main PBX
systemctl {start|stop|restart|status} shadowpbx

# Recording Worker
systemctl {start|stop|restart|status} shadowpbx-recorder

# Logs
tail -f /var/log/shadowpbx/shadowpbx.log      # PBX
tail -f /var/log/shadowpbx/recorder.log        # Recorder
tail -f /var/log/shadowpbx/error.log           # PBX errors

# Docker
docker logs drachtio      # SIP server
docker logs rtpengine      # Media server
```

---

## RTPEngine Management

### Verify Recording Pipeline

```bash
# 1. Check pcaps are created during calls
ls -lt /var/spool/rtpengine/pcaps/ | head -5

# 2. Check metadata appears after call ends
ls -lt /var/spool/rtpengine/metadata/ | head -5

# 3. Check recorder worker is converting
tail -10 /var/log/shadowpbx/recorder.log

# 4. Check WAV output
ls -lt /var/lib/shadowpbx/recordings/wav/ | head -5
```

### Server Migration

When moving to a new server, RTPEngine's interface IP must be updated:

```bash
sudo bash scripts/fix-rtpengine.sh
# or: sudo bash scripts/fix-rtpengine.sh NEW_IP
```

Updates RTPEngine, Drachtio, and `.env` with the new IP.

### Troubleshooting

| Problem | Check |
|---------|-------|
| No pcaps during calls | `docker inspect rtpengine --format '{{json .Args}}'` — verify `--interface` matches server IP |
| pcaps exist but no WAV | `systemctl status shadowpbx-recorder` — is it running? Check `which tshark xxd sox` |
| WAV exists but CDR shows `-` | Check `rtpengineCallId` field in CDR: `grep "CDR linked" /var/log/shadowpbx/recorder.log` |
| Audio issues on calls | Run `scripts/fix-rtpengine.sh` to fix interface IP |

---

## Nginx & SSL

### With Domain (HTTPS + WebRTC ready)

```
https://domain/      → proxy to :3000 (web UI + API)
wss://domain/ws      → proxy to :5061 (SIP WebSocket for WebRTC)
http://domain/       → redirects to HTTPS
```

### Without Domain

```
http://SERVER_IP/    → proxy to :3000
```

### Adding SSL Later

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.com --cert-name your-domain.com \
  --key-type rsa --non-interactive --agree-tos --email you@example.com --redirect
```

**Important:** Use `--key-type rsa` — Drachtio requires RSA certificates.

---

## Deployment

```bash
# Git pull
cd /opt/shadowpbx
git pull origin main
npm install --production
systemctl restart shadowpbx
systemctl restart shadowpbx-recorder

# Or manual
scp -r src/ root@server:/opt/shadowpbx/src/
ssh root@server "systemctl restart shadowpbx && systemctl restart shadowpbx-recorder"
```

---

## Firewall

Required open ports:

| Port | Protocol | Purpose |
|------|----------|---------|
| 22 | TCP | SSH |
| 80 | TCP | HTTP (nginx) |
| 443 | TCP | HTTPS + WSS (nginx) |
| 5060 | UDP/TCP | SIP signaling |
| 10000–20000 | UDP | RTP media |
| 3478 | UDP/TCP | TURN (v3.0, if coturn installed) |
| 5349 | TCP | TURN over TLS (v3.0, optional) |
| 49160–49200 | UDP | TURN relay range (v3.0) |

Port 3000 is localhost-only — all external access goes through nginx.
Drachtio's WebSocket listener (127.0.0.1:5061) must **not** be public: nginx
proxies `/ws` to it.

---

## Documentation

| Doc | Covers |
|-----|--------|
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | **Day-to-day running**: logs, live tailing, restarts, updates, troubleshooting, fresh-install checklist |
| [docs/WEBRTC-PHASE1.md](docs/WEBRTC-PHASE1.md) | WebRTC foundations, media bridging, self-test, troubleshooting |
| [docs/WEBCALL-PHASE2.md](docs/WEBCALL-PHASE2.md) | Guest identities, destination lockdown, web-call API |
| [docs/WEBDIALER-PHASE3-4.md](docs/WEBDIALER-PHASE3-4.md) | Web-call routing and the embeddable widget |
| [docs/WEBDIALER-PHASE5-6.md](docs/WEBDIALER-PHASE5-6.md) | Widget admin UI, screen pop, CDR attribution |
| [docs/WEBDIALER-PHASE7-8.md](docs/WEBDIALER-PHASE7-8.md) | Abuse prevention, CAPTCHA, TURN, go-live checklist |

## Self-tests

```bash
node scripts/webrtc-selftest.js      # RTPEngine WebRTC bridge — 36 checks
node scripts/webcall-selftest.js     # guest tokens, auth, lockdown, lifecycle
node scripts/wss-register-probe.js   # browser signalling path: nginx -> Drachtio -> PBX
```

## Logs

The app rotates logs by writing `shadowpbx1.log`, `shadowpbx2.log` and so on,
with the **newest being the highest number** — so tail the most recent file
rather than `shadowpbx.log`, which is often stale:

```bash
tail -f /var/log/shadowpbx/$(ls -t /var/log/shadowpbx/ | head -1)
```

Full command reference in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Drachtio configuration

From v3.0 Drachtio runs from `/etc/shadowpbx/drachtio.conf.xml` rather than
command-line flags, because the `wss` listener browsers need requires TLS
certificate paths that can only be set in that file (inside `<sip>`, not at the
top level). The installer generates it from
[scripts/drachtio.conf.xml.template](scripts/drachtio.conf.xml.template), and a
certbot deploy hook refreshes Drachtio's copy of the certificate on renewal.

---

## Roadmap

- [x] WebRTC browser phone (v3.0)
- [x] Embeddable web-call widget (v3.0)
- [ ] Video calling and screen share
- [ ] PM2 cluster mode with Redis state externalization
- [ ] Multi-tenant SaaS (Kamailio edge + Docker per tenant)
- [ ] Webhook events for call lifecycle
- [ ] Billing and usage tracking

---

## License

MIT — see [LICENSE](LICENSE) for details.
