# External SIP whitelist — source-IP trust (and a crash fix)

`_handleExternalSIP()` in `call-handler.js` handles inbound SIP from external
domains (not trunks) to a local extension. Two problems, both fixed.

## 1. Spoofable whitelist (security)

The whitelist matched the **From-URI domain**:

```js
$or: [ { domain: callerDomain }, { domain: sourceIp } ]
```

The From domain is attacker-controllable — anyone can send
`From: sip:x@trusted-domain.example` from an unauthorized IP and pass the
whitelist. This is the same class of trust error behind the toll-fraud incident.

Now authorization is **source-IP based**, matching how trunk trust already works:

- an **`ip`** whitelist entry must equal the packet's source IP;
- a **`domain`** entry grants access only if the source IP actually **resolves**
  to that domain (DNS A/AAAA) — so the caller genuinely is that domain, not just
  claiming to be. Unresolvable or mismatched → rejected.
- the From domain is now **informational metadata only**.

A request that names a whitelisted domain but comes from an unauthorized IP is
rejected and logged distinctly as a spoofing attempt:

```
EXTERNAL SIP REJECTED: spoofed From domain trusted.example from unauthorized IP 89.239.43.206
```

Note: domain entries now require a DNS lookup at call time (cached by the
resolver). If you rely on a domain whose IPs change, or DNS is unreliable, add
an explicit **`ip`** entry for the provider's SBC — that's the strongest match
and needs no lookup.

## 2. `ReferenceError` on a successful external call (crash)

After passing the whitelist, the success log referenced `allowedDomain`, which
never existed (the variable is `allowedEntry`). Any external SIP call that got
past the whitelist hit a `ReferenceError` at that line. Fixed to `allowedEntry`.
