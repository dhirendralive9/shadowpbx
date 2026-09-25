# Click-to-call

Clicking a phone number in the dashboard or a CRM screen pop originates a real
outbound call: the trunk is dialled toward the number, the agent's own phone is
rung, and the two legs are bridged through RTPEngine and recorded — exactly like
any other outbound call.

## How it works

```
agent clicks number
  → socket 'crm:click2call' { phone }   (extension comes from the session)
  → callHandler.originate(extension, phone)
      1. agent must be registered
      2. callRouter.findOutboundRoute(number, extension)   ← authorization
      3. dial the trunk toward the number   (createUAC + trunk auth)
      4. dial the agent's phone             (createUAC, RTPEngine-bridged)
      5. answer trunk with agent SDP, re-INVITE to RTPEngine
  → 'crm:click2call:started' { callId }
```

## Authorization

Origination goes through the **same** `findOutboundRoute(number, extension)`
that a dialled call uses, so a route's `allowedExtensions` restriction applies
identically. An agent cannot click-to-call a number, or via a route, their
normal dialling permissions would forbid — the check is not duplicated or
bypassed. The originating extension is taken from the authenticated socket
session; agents may only originate from their own extension, while supervisors
and admins may name another.

## History

Before v3.0 this path matched a route, built a trunk URI and the agent's
contact, then created a CDR and returned success **without sending any INVITE**.
The UI reported "call started" while nothing was dialled, and the route lookup
did not enforce `allowedExtensions`. Both are fixed: origination is real, and it
runs through the central outbound authorization service.
