# Carrier webhook security

The dialer and appointment features expose public webhook endpoints the carrier
POSTs to:

```
/webhook/dialer/:campaignId/{voice,amd,status,bridge}
/webhook/appointment/:number/{voice,action,recording}
```

Four problems, all fixed.

## 1. No signature verification (spoofable call state)

These endpoints changed call state (bridge on "human", mark completed, set
disposition) and downloaded recordings — trusting whatever HTTP arrived. Anyone
could POST forged `CallStatus`, `AnsweredBy`, `RecordingUrl`, `agent`,
`campaignId`.

Every state-changing webhook now verifies the **Twilio/SignalWire signature**
(`utils/webhook-verify.js`): HMAC-SHA1 over the exact URL + sorted POST params,
keyed by the carrier auth token, constant-time compared. A forged or tampered
request (e.g. flipping `AnsweredBy` to `human`) fails the check and gets 403.

- Requires `TWILIO_AUTH_TOKEN` (or `SIGNALWIRE_TOKEN`) and `WEBHOOK_BASE_URL`.
- **Fails closed**: with no token configured, state-changing webhooks are
  rejected, not waved through. `WEBHOOK_VERIFY=false` disables it (don't, in
  production).

## 2. SSRF in the recording download (arbitrary fetch)

`_downloadFile` took `RecordingUrl` from the webhook and fetched it — following
redirects, no host or IP restriction. An unauthenticated caller could make the
PBX fetch `http://169.254.169.254/` (cloud metadata), `http://127.0.0.1/…` or
any internal service — a server-side request forgery primitive.

Downloads now go through `utils/safe-download.js`, which:

- allows **https only**;
- restricts the host to known carrier domains (`RECORDING_ALLOWED_HOSTS` adds
  more);
- resolves the host and **rejects any private / loopback / link-local / CGNAT
  address** (including the cloud-metadata IP);
- pins the connection to the validated IP (no DNS-rebinding between check and
  fetch);
- follows redirects only to hosts that pass the same checks, with a hop limit;
- caps size and time.

## 3. Callback URLs built from spoofable headers

`_getBaseUrl` fell back to `x-forwarded-proto` / `x-forwarded-host` — headers an
untrusted caller can set — to build the callback URLs embedded in TwiML. It now
prefers `WEBHOOK_BASE_URL` and warns loudly if it isn't set. **Set
`WEBHOOK_BASE_URL` in production.**

## 4. Webhook state transitions weren't idempotent

Carriers retry and duplicate webhooks, so two AMD callbacks could race and
bridge the same call twice. The dialer now treats the call as a state machine:

```
ringing → bridging → connected → ended
```

The bridge transition is claimed atomically (a synchronous check-and-set, atomic
under Node's single thread) and allowed **once**. Duplicate or late AMD/status
callbacks see `bridging`/`connected`/`ended` and stop.
