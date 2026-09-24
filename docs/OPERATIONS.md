# ShadowPBX — Operations Guide

Day-to-day commands for running ShadowPBX v3.0: logs, service control, updates,
and the failures that actually happen.

Everything assumes the default install at `/opt/shadowpbx`.

---

## 1. What runs where

| Component | Runs as | Ports | Purpose |
|---|---|---|---|
| shadowpbx | systemd service | 3000 (loopback) | The app: web UI, API, call logic |
| shadowpbx-recorder | systemd service | — | Turns RTPEngine pcaps into call recordings |
| drachtio | docker container | 5060 udp/tcp, 5061 ws, 5062 wss, 9022 admin | SIP stack |
| rtpengine | docker container | 22222 ng, 10000–20000 udp | Media relay and recording |
| coturn | systemd service | 3478, 49160–49200 udp | TURN relay for browsers behind NAT |
| mongod | systemd service | 27017 (loopback) | Database |
| nginx | systemd service | 80, 443 | TLS, web UI proxy, `/ws` → Drachtio |

Only 443, 5060, and the media/TURN ranges should be reachable from outside.
Ports 3000, 5061, 5062, 9022 and 27017 are loopback-only by design.

---

## 2. Logs

### Live tail (the one you want most often)

```bash
tail -f /var/log/shadowpbx/$(ls -t /var/log/shadowpbx/ | head -1)
```

**Why the subshell:** winston rotates at 10 MB by writing `shadowpbx1.log`,
`shadowpbx2.log` and so on, and the *newest* file is the highest number —
`shadowpbx.log` is often months stale. Tailing it directly is the single most
common way to conclude "nothing is being logged" when everything is fine.

List them newest-first to see which is current:

```bash
ls -lt /var/log/shadowpbx/
```

### Filtered live views

```bash
# One extension
tail -f /var/log/shadowpbx/$(ls -t /var/log/shadowpbx/ | head -1) | grep -i "2001"

# Registrations and trunks only
tail -f /var/log/shadowpbx/$(ls -t /var/log/shadowpbx/ | head -1) | grep -iE "registered|trunk"

# Web dialer / browser calls
tail -f /var/log/shadowpbx/$(ls -t /var/log/shadowpbx/ | head -1) | grep -iE "WEBCALL|WEBRTC"

# Errors as they happen
tail -f /var/log/shadowpbx/error.log
```

### Other logs

```bash
tail -f /var/log/shadowpbx/recorder.log      # recording conversion
journalctl -u shadowpbx -f                   # service start/stop, crashes
journalctl -u coturn -f                      # TURN
docker logs -f drachtio                      # SIP stack
docker logs -f rtpengine                     # media
tail -f /var/log/nginx/error.log             # 502s, TLS, /ws proxy
```

### Searching history

```bash
grep -i "919876543210" /var/log/shadowpbx/shadowpbx*.log        # a number, all files
grep -i "error\|failed" /var/log/shadowpbx/error.log | tail -50
zgrep -i "2001" /var/log/shadowpbx/*.gz 2>/dev/null             # if compressed
```

### Log level

`LOG_LEVEL=debug` in `.env` logs every raw INVITE and fills 10 MB files in
hours. Use it while diagnosing, then put it back:

```bash
sed -i 's/^LOG_LEVEL=.*/LOG_LEVEL=info/' /opt/shadowpbx/.env
systemctl restart shadowpbx
```

---

## 3. Service control

```bash
systemctl status shadowpbx          # is it up, since when, recent output
systemctl restart shadowpbx         # picks up .env and code changes
systemctl stop shadowpbx
systemctl start shadowpbx
systemctl restart shadowpbx-recorder

docker restart drachtio             # ~10s SIP outage, trunks re-register
docker restart rtpengine            # drops audio on calls in progress
systemctl restart coturn
systemctl reload nginx              # config change, no dropped connections
```

**Restarting the app is safe** — calls in progress survive, since media flows
through RTPEngine rather than the app. Restarting **Drachtio or RTPEngine drops
active calls**, so do those in quiet windows.

### Health

```bash
curl -s localhost:3000/health | python3 -m json.tool
ss -ltn | grep -E '3000|5060|5061|5062|9022|27017'
ss -lun | grep -E '5060|3478'
docker ps
```

`/health` reports version, MongoDB, RTPEngine, the WebRTC bridge and web-call
counters. The Settings → System tab shows the same version.

---

## 4. Updating

```bash
cd /opt/shadowpbx
git pull origin main
npm install --omit=dev          # only if package.json changed
systemctl restart shadowpbx
```

That is the whole routine. No database migration is ever required: new fields
appear on new documents, and existing ones keep working.

If `git pull` refuses because of local edits:

```bash
git status --short                      # what you changed
git diff scripts/setup-webrtc.sh        # inspect before discarding
git checkout -- <file>                  # discard one file
git stash                               # or park everything, then: git stash pop
```

`.env` is gitignored, so your configuration is never touched.

### After updating

```bash
node scripts/webrtc-selftest.js         # media bridge, 36 checks
node scripts/webcall-selftest.js        # guest tokens, auth, lockdown
node scripts/wss-register-probe.js      # browser signalling path end to end
```

### Backups

```bash
mongodump --db shadowpbx --out /root/backup-$(date +%F)
cp /opt/shadowpbx/.env /root/env-backup-$(date +%F)
cp /etc/shadowpbx/drachtio.conf.xml /root/drachtio-backup-$(date +%F).xml
```

Settings → Backup does the database part from the UI.

---

## 5. Browser calling (v3.0)

### The one thing to understand

```
browser ──wss://domain/ws──> nginx (TLS) ──TLS──> Drachtio wss :5062 ──> ShadowPBX
```

Browsers connect over `wss://`, so SIP.js writes `Via: SIP/2.0/WSS`. Sofia-sip
**silently discards** any message whose Via transport has no matching listener —
nothing appears in Drachtio's log or the app's. The WebSocket connects, the
REGISTER vanishes, and the browser reports `408 Request Timeout` half a minute
later.

Two configurations produce that symptom:

- Drachtio has no `wss` listener on 5062, or
- nginx proxies `/ws` to the plain ws port (5061) instead of 5062.

Drachtio terminates that TLS itself and takes the certificate paths **only from
its config file**, with `<tls>` **inside** `<sip>`. The command-line forms do not
work: `--contact "...;transport=wss,tls-cert-file=..."` parses the transport as
empty, and `--tls-cert-file` is not a recognised option.

### Checking it

```bash
ss -ltn | grep -E '5061|5062'                  # both should be listening
grep -A3 'location /ws' /etc/nginx/sites-available/shadowpbx
node /opt/shadowpbx/scripts/wss-register-probe.js           # through nginx
node /opt/shadowpbx/scripts/wss-register-probe.js --direct  # bypass nginx
```

A `401` is success. The probe tells you which side is at fault.

### Fixing it

```bash
sudo bash /opt/shadowpbx/scripts/setup-webrtc.sh --fix-drachtio
```

This rebuilds Drachtio from `/etc/shadowpbx/drachtio.conf.xml`, and rolls back to
the previous flag-based setup automatically if the wss listener won't start, so
you don't end up with SIP down. nginx it does not touch — it will tell you if
`/ws` points at the wrong port.

### Certificates

Drachtio keeps its own copy at `/etc/shadowpbx/tls/`. The certbot deploy hook
`/etc/letsencrypt/renewal-hooks/deploy/shadowpbx-drachtio.sh` refreshes it and
restarts the container on renewal. Check it exists:

```bash
ls -l /etc/letsencrypt/renewal-hooks/deploy/
certbot renew --dry-run
```

Without it, browser calling breaks roughly 90 days after install, when the
certificate Drachtio holds goes stale — long after anyone remembers why.

### Careful with

`setup-tls.sh` rebuilds Drachtio from flags and therefore **removes the wss
listener**. If you run it, follow with `setup-webrtc.sh --fix-drachtio`.

---

## 6. Troubleshooting

| Symptom | Check |
|---|---|
| "No logs at all" | You're tailing a rotated file — use `ls -t` (section 2) |
| Trunks offline, phones can't register | `docker ps` — is Drachtio in a restart loop? `docker logs drachtio` |
| Web UI down, SIP fine | `systemctl status shadowpbx`, `journalctl -u shadowpbx -n 50` |
| Browser registers, then 408 | Drachtio wss listener or nginx `/ws` port — section 5 |
| Browser WebSocket won't open (502) | Drachtio isn't listening on 5062 — `docker logs drachtio` |
| Call connects, no audio either way | UDP 10000–20000 blocked at the cloud firewall |
| Audio one way only | NAT — check RTPEngine advertises the public IP: `docker inspect rtpengine \| grep interface` |
| Browser call silent from some networks | TURN — `systemctl status coturn`, `ss -lun \| grep 3478` |
| Recordings missing | `tail -f /var/log/shadowpbx/recorder.log`, `ls -l /var/spool/rtpengine` |
| Disk filling | `du -sh /var/log/shadowpbx /var/spool/rtpengine /var/lib/shadowpbx/*` |

### Full restart, in order

```bash
systemctl stop shadowpbx shadowpbx-recorder
docker restart drachtio rtpengine
sleep 5
systemctl start shadowpbx shadowpbx-recorder
sleep 5
curl -s localhost:3000/health | python3 -m json.tool
```

### Emergency: get SIP back now

If Drachtio won't start and you need phones working immediately, this drops
browser calling but restores everything else in about ten seconds:

```bash
cd /opt/shadowpbx
EXTERNAL_IP=$(grep '^EXTERNAL_IP=' .env | cut -d= -f2)
DRACHTIO_SECRET=$(grep '^DRACHTIO_SECRET=' .env | cut -d= -f2)
docker rm -f drachtio
docker run -d --name drachtio --restart unless-stopped --net host \
  --entrypoint drachtio drachtio/drachtio-server:0.8.25 \
    --contact "sip:${EXTERNAL_IP}:5060;transport=udp,tcp" \
    --contact "sip:127.0.0.1:5061;transport=ws" \
    --external-ip ${EXTERNAL_IP} --secret ${DRACHTIO_SECRET} --loglevel info
systemctl restart shadowpbx
```

Restore browser calling afterwards with `setup-webrtc.sh --fix-drachtio`.

---

## 7. Fresh install checklist

In order — most problems come from doing these out of sequence.

1. **DNS first.** Point the hostname at the server and confirm before installing:
   `dig +short pbx.example.com` must return your public IP. The installer skips
   HTTPS entirely without it, and browser calling then can't work at all.
2. `sudo bash scripts/install-drachtio.sh` — answer the domain prompt with the
   real hostname, not the IP.
3. `sudo bash scripts/setup-features.sh`
4. `sudo bash scripts/setup-webrtc.sh` — must end with **All checks passed**.
5. `sudo bash scripts/setup-turn.sh` — needed for visitors on restrictive networks.
6. Open in your **cloud firewall** (Contabo, AWS, etc.), not just iptables:
   443/tcp, 5060/udp+tcp, 10000–20000/udp, 3478/udp+tcp, 49160–49200/udp.
7. Verify:
   ```bash
   node scripts/webrtc-selftest.js
   node scripts/wss-register-probe.js
   ```
8. In the UI: **Network → WebRTC**, register the test softphone, call a desk
   phone. Then **Call flow → Web dialer**, create a widget, test it on
   `/widget-demo.html`.

### Things worth getting right up front

- **`SIP_DOMAIN` must match the hostname phones and browsers use.** A mismatch
  makes the digest realm wrong and registrations fail authentication.
- **`EXTERNAL_IP` must be the public IP.** On a cloud server whose public IP
  isn't on a local NIC, RTPEngine needs `--interface=private!public` —
  `setup-webrtc.sh --fix-rtpengine` handles it.
- **Leave `LOG_LEVEL=info`** unless you're diagnosing something.
- **Set `allowedDomains` on every production web-dialer widget** before sharing
  the embed snippet; an empty list means any site can use it.
- **Leave `WEBCALL_ABUSE_BLOCK_AFTER=0`** until you've seen a week of normal
  traffic, so you don't firewall real visitors.
