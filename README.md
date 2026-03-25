# ShadowPBX v2.0

A self-hosted, open-source PBX (Private Branch Exchange) built entirely in Node.js. ShadowPBX gives you a full-featured IP phone system — SIP registration, call routing, ring groups, IVR, voicemail, call recording, transfers, hold, parking, and supervisor monitoring — all running on a Linux server.

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
- WSS proxy for WebRTC (`wss://domain/ws` → `ws://127.0.0.1:5061`)
- Let's Encrypt SSL with RSA key (ECDSA not supported by Drachtio)
- `shadowpbx.service` and `shadowpbx-recorder.service`
- fail2ban, iptables firewall, UDP buffer tuning
- All passwords auto-generated

### 2. Feature Setup

```bash
sudo bash scripts/setup-features.sh
```

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

Port 3000 is localhost-only — all external access goes through nginx.

---

## Roadmap

- [ ] WebRTC browser phone (SIP.js via WSS — infrastructure ready)
- [ ] PM2 cluster mode with Redis state externalization
- [ ] Multi-tenant SaaS (Kamailio edge + Docker per tenant)
- [ ] Webhook events for call lifecycle
- [ ] Billing and usage tracking

---

## License

MIT — see [LICENSE](LICENSE) for details.
