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

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Register fails, "Start failed" | WSS: cert, nginx `/ws`, or Drachtio WS listener — re-run setup-webrtc.sh |
| Call connects, ICE `failed` | UDP 10000-20000 blocked, or RTPEngine advertises a private IP (`--fix-rtpengine`) |
| Sent packets rise, received stay 0 | Same as above, or one-way NAT — TURN arrives in Phase 8 |
| 488 on call | RTPEngine not responding — `docker logs rtpengine` |

Logs: every bridged leg logs a line starting `WEBRTC offer` / `WEBRTC answer`
with the resulting profile, codecs, ICE and DTLS role.

## API

- `GET /api/webrtc/status` (X-API-Key) — config, RTPEngine, WSS, browser registrations, issues
- `POST /api/webrtc/selftest` (X-API-Key) — run the bridge self-test
- `/health` now includes `checks.webrtc`

## Known limits (later phases)

- Only direct extension calls and inbound-to-extension paths can *ring* a
  browser-registered agent. Ring groups, queues, IVR transfers and the dialer
  still ring desk phones only. Browser *callers* work through all of them.
- No TURN yet (Phase 8): visitors behind strict firewalls may get no audio.
- Real client IPs of browsers aren't visible (nginx proxy), so browser
  brute-force lockouts are per extension, not per IP.
