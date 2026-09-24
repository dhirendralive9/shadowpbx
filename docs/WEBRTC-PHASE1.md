# Web Dialer — Phase 1: WebRTC Foundations

Browser calls now bridge through RTPEngine: the browser leg is
UDP/TLS/RTP/SAVPF (ICE + DTLS-SRTP + rtcp-mux), the phone/trunk leg is
plain RTP/AVP G.711. Calls with no browser on either side use exactly the
same RTPEngine parameters as before.

## Deploy

1. Copy these files over `/opt/shadowpbx` (same folder structure).
2. `sudo bash /opt/shadowpbx/scripts/setup-webrtc.sh`
   - add `--fix-drachtio` if Drachtio lost its WS listener (older setup-tls.sh did this)
   - add `--fix-rtpengine` on cloud servers whose public IP is NAT'd (AWS/GCP/Azure)
3. The script restarts ShadowPBX and runs the self-test. It must end with
   `All checks passed`.

## Verify with a real call

Admin → **Network → WebRTC**:

1. **Run self-test** — 36 checks across browser→phone, phone→browser, phone→phone.
2. **Test softphone** — register an extension (its SIP password), dial a desk
   phone. Expect: ICE `connected`, packets rising in both directions, codec
   `audio/PCMU/8000`, recording in CDR as usual.
3. Call the browser extension from a desk phone to test the reverse direction.

## How the signalling path fits together

```
browser ──wss://domain/ws──> nginx (TLS) ──TLS──> Drachtio wss  127.0.0.1:5062 ──> ShadowPBX
```

Drachtio needs a **wss** listener, not just a ws one, and it terminates that
TLS itself — it refuses to start the transport without a certificate, which is
why `/etc/shadowpbx/tls` exists and is refreshed by a certbot renewal hook.

Those certificate paths can only be given in Drachtio's **config file**, with
`<tls>` **inside** `<sip>`. Both command-line forms fail, and neither says so
clearly:

| Attempt | Result |
|---|---|
| `--contact "sips:...;transport=wss,tls-cert-file=..."` | transport parses as empty: `bind(...;transport=;...): Protocol not supported` |
| `--tls-cert-file` / `--tls-key-file` | `unrecognized option` |
| `<tls>` at the top level of the config file | ignored: `tls key file ... is required and not specified` |
| `<tls>` inside `<sip>` | works |

The installer writes `/etc/shadowpbx/drachtio.conf.xml` from
`scripts/drachtio.conf.xml.template` and runs Drachtio with
`-f /etc/drachtio.conf.xml`. Note that `setup-tls.sh` rebuilds Drachtio from
flags and so drops the wss listener — follow it with
`setup-webrtc.sh --fix-drachtio`.

This matters because of one silent failure mode: browsers connect over `wss://`,
so SIP.js writes `Via: SIP/2.0/WSS`, and sofia-sip discards any message whose
Via transport has no matching listener — with no log line in Drachtio or
ShadowPBX. The WebSocket connects happily, the REGISTER disappears, and the
browser reports `408 Request Timeout` about 30 seconds later. Proxying `/ws` to
the plain ws port (5061) produces exactly the same symptom.

Check the whole path in one command:

```bash
node scripts/wss-register-probe.js            # through nginx, as a browser does
node scripts/wss-register-probe.js --direct   # bypass nginx, straight to Drachtio
```

A `401` is success: the request reached ShadowPBX and was challenged.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| WebSocket connects, REGISTER times out (408), nothing logged | No Drachtio wss listener, or nginx `/ws` points at 5061 — `setup-webrtc.sh --fix-drachtio` |
| Register fails, "Start failed" | WSS: cert, nginx `/ws`, or Drachtio WS listener — re-run setup-webrtc.sh |
| Call connects, ICE `failed` | UDP 10000-20000 blocked, or RTPEngine advertises a private IP (`--fix-rtpengine`) |
| Sent packets rise, received stay 0 | Same as above, or one-way NAT — TURN arrives in Phase 8 |
| 488 on call | RTPEngine not responding — `docker logs rtpengine` |

Logs: every bridged leg logs a line starting `WEBRTC offer` / `WEBRTC answer`
with the resulting profile, codecs, ICE and DTLS role.

## API

- `GET /api/webrtc/status` (X-API-Key) — config, RTPEngine, WSS, TURN, browser registrations, issues
- `POST /api/webrtc/selftest` (X-API-Key) — run the bridge self-test
- `/health` now includes `checks.webrtc`

## Known limits (later phases)

- Only direct extension calls and inbound-to-extension paths can *ring* a
  browser-registered agent. Ring groups, queues, IVR transfers and the dialer
  still ring desk phones only. Browser *callers* work through all of them.
- No TURN yet (Phase 8): visitors behind strict firewalls may get no audio.
- Real client IPs of browsers aren't visible (nginx proxy), so browser
  brute-force lockouts are per extension, not per IP.
