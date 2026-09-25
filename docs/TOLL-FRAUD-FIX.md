# Toll-fraud incident (2026-09-25) — root cause and fix

## What happened

Over ~90 minutes, 140 outbound calls were placed to premium fraud
destinations — Central African Republic (`236`), satellite ranges (`88x`,
`870`), and a repeated Canadian number — bursting to 25 calls in one minute.
About 39 billable minutes on the `suii` trunk. This is International Revenue
Share Fraud: the attacker owns the destination numbers and is paid per minute.

## Root cause

The CDRs showed the calls originating from extensions `2001`/`2002`, so it
looked like stolen SIP credentials. It wasn't. The logs told the real story:

```
INVITE From-URI=sip:2001@89.239.43.206:5060  UA=Asterisk PBX 18.9.0
```

- The real agents register from **106.219.122.234** (MicroSIP).
- The fraud INVITEs came from **89.239.43.206** (an Asterisk box), simply
  putting `From: sip:2001@…` in the header.

The PBX checked only whether `2001` was registered **somewhere**
(`isRegistered`), not whether the INVITE actually came from where `2001`
registered. A spoofed From header from any IP was accepted, and the
wide-open dial plan (`ZXXXXXXXXX.` — any international number) then routed it
to the trunk. Two holes, both in code.

## The fix

### 1. Anti-spoofing: source-IP verification

`registrar.isRegisteredFrom(ext, sourceIp)` now confirms an INVITE claiming
`From: <ext>` actually originates from an IP where that extension is
registered. Loopback (internal calls: IVR, dialer, click-to-call) is trusted,
and WebRTC contacts are matched on being browser registrations rather than IP
(they share the proxy address).

`call-handler` uses it on every INVITE. A spoofed extension from a foreign IP
is rejected with 403 and logged as a security event:

```
SECURITY: INVITE from 89.239.43.206 spoofing extension 2001 ... — REJECTED
```

Genuine external SIP callers are unaffected — they can only ever reach a local
extension, never a trunk, so that path can't be abused for outbound fraud.

### 2. Destination guard

`src/services/outbound-guard.js` gates **every** outbound call (dialled,
click-to-call, dialer) regardless of route:

- **Block-list** (default, always on): high-risk satellite/premium ranges,
  including every range from this incident. Longest-match wins, so `1809`
  (Dominican Republic) is blocked without blocking `1`.
- **Allow-list** (opt-in, recommended): set `OUTBOUND_ALLOWED_PREFIXES` to the
  countries you call and nothing else can be dialled.

Configured via env or, live, `SystemSettings.outboundPolicy`.

## Do this now on the server

1. **Rotate the SIP passwords for 2001 and 2002** and re-provision the agents
   (the attacker knows those extension numbers).
2. **Set the allow-list** to the countries you actually call. You dial
   Canada/US — for example:
   ```
   OUTBOUND_ALLOWED_PREFIXES=1
   ```
   in `/opt/shadowpbx/.env`, then `systemctl restart shadowpbx`.
3. **Verify** — the guard summary is logged at startup and in `/health`:
   ```bash
   curl -s localhost:3000/health | python3 -m json.tool | grep -A6 outboundGuard
   ```
4. **Report the fraud** to the `suii` provider and ask them to bar
   international destinations you never use — a provider-side block is the
   backstop if anything reaches the trunk.
5. **Firewall the SIP port.** Consider restricting UDP/TCP 5060 to your agents'
   known IPs, or ensure fail2ban is banning the scanners (the logs show heavy
   probing — `1001`, `1000`, `100`, dictionary usernames).

## Why this can't recur

Even with a stolen credential or a spoofed From, an attacker now has to (a)
send from an IP where the extension is genuinely registered, **and** (b) dial a
permitted destination. The incident's calls fail both checks.
