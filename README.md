# ShadowPBX v1.0

Minimal Node.js PBX for internal team communications with call recording.

## Architecture

```
┌─────────────────────────────────────────┐
│              ShadowPBX                  │
│                                         │
│  ┌──────────┐  ┌──────────────────┐     │
│  │ Express  │  │  Drachtio SRF    │     │
│  │ API :3000│  │  (SIP Logic)     │     │
│  └────┬─────┘  └───────┬──────────┘     │
│       │                │                │
│       │         ┌──────┴──────┐         │
│       │         │  Drachtio   │         │
│       │         │  Server     │         │
│       │         │  :5060 SIP  │         │
│       │         └──────┬──────┘         │
│       │                │                │
│  ┌────┴────┐    ┌──────┴──────┐         │
│  │ MongoDB │    │  RTPEngine  │         │
│  │ Config  │    │  Media+Rec  │         │
│  │ CDR     │    │  :10000-20k │         │
│  └─────────┘    └─────────────┘         │
└─────────────────────────────────────────┘
         ▲              ▲
         │              │
    ┌────┴────┐   ┌─────┴─────┐
    │  Admin  │   │ Softphones│
    │  API    │   │ Zoiper    │
    │  calls  │   │ Linphone  │
    └─────────┘   └───────────┘
```

## Components

- **Drachtio** - SIP signaling server (handles REGISTER, INVITE, BYE)
- **RTPEngine** - Media relay + call recording (audio streams)
- **Node.js App** - Business logic, extension management, CDR
- **MongoDB** - Extensions, call records, config

## v1 Features

- [x] SIP extension registration (digest auth)
- [x] Internal calling between extensions
- [x] Call recording via RTPEngine
- [x] Call Detail Records (CDR) in MongoDB
- [x] REST API for extension management
- [x] Active call monitoring

## Quick Start

### 1. Install (Debian 12)

```bash
git clone <repo> /opt/shadowpbx
cd /opt/shadowpbx
sudo bash scripts/install-drachtio.sh
```

### 2. Configure

```bash
cp .env.example .env
nano .env
```

### 3. Install dependencies and start

```bash
npm install
systemctl start shadowpbx
```

## API Reference

All API calls require `X-API-Key` header.

### Extensions

```bash
# Create extension
curl -X POST http://localhost:3000/api/extensions \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_SECRET' \
  -d '{"extension":"2001","name":"Alice","password":"secret123"}'

# List all extensions
curl http://localhost:3000/api/extensions \
  -H 'X-API-Key: YOUR_SECRET'

# Bulk create
curl -X POST http://localhost:3000/api/extensions/bulk \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_SECRET' \
  -d '{"extensions":[
    {"extension":"2001","name":"Alice","password":"pass1"},
    {"extension":"2002","name":"Bob","password":"pass2"},
    {"extension":"2003","name":"Charlie","password":"pass3"}
  ]}'

# Update extension
curl -X PUT http://localhost:3000/api/extensions/2001 \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: YOUR_SECRET' \
  -d '{"name":"Alice Smith","enabled":true}'

# Delete extension
curl -X DELETE http://localhost:3000/api/extensions/2001 \
  -H 'X-API-Key: YOUR_SECRET'
```

### Call Records

```bash
# Recent calls
curl http://localhost:3000/api/cdr?limit=20 \
  -H 'X-API-Key: YOUR_SECRET'

# Filter by extension
curl http://localhost:3000/api/cdr?extension=2001 \
  -H 'X-API-Key: YOUR_SECRET'

# Filter by date
curl "http://localhost:3000/api/cdr?from=2026-03-01&to=2026-03-31" \
  -H 'X-API-Key: YOUR_SECRET'
```

### System

```bash
# Stats
curl http://localhost:3000/api/stats \
  -H 'X-API-Key: YOUR_SECRET'

# Health check (no auth)
curl http://localhost:3000/health
```

## Softphone Setup

Use any SIP softphone (Zoiper, Linphone, MicroSIP):

| Setting   | Value              |
|-----------|--------------------|
| Server    | your-server-ip     |
| Port      | 5060               |
| Transport | UDP                |
| Username  | extension number   |
| Password  | extension password |

## Roadmap

- **v2**: Ring groups, inbound trunks (SignalWire), outbound routing, IVR
- **v3**: Web GUI (EJS dashboard), WebRTC browser calling, voicemail
- **v4**: Multi-tenant, billing, API tokens, webhook events
