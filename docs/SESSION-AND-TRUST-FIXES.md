# Session lifecycle, proxy trust, CIDR & webcall origin

## Session invalidation via securityStamp (fixed)

Sessions are an in-process Map with a 24h TTL, so an admin change (disable, role,
extension, password) previously didn't take effect until the session expired — a
demoted agent could keep admin rights for up to a day.

Now each User has a **`securityStamp`**. It's stored in the session at login, and
`authMiddleware` re-checks the user against the DB at most every
`SESSION_REVALIDATE_SECONDS` (default 30). If the user is disabled, gone, or the
stamp no longer matches, the session is destroyed and the user is bounced to
login. The stamp is rolled whenever a security-relevant field changes:

- role change, extension change, disable, or password reset (Users page)
- web-login password reset (Extensions page)
- a forced password change rolls it too (invalidating that user's *other*
  sessions, keeping the current one)

Benign changes are picked up without forcing re-login (the session's role /
extension are refreshed in place).

Note: this is still an in-process store. A Redis/Mongo-backed store is the right
move once you run more than one PBX process — noted, not yet done.

## Trust proxy + non-spoofable client IP (fixed)

`trust proxy` was not set, so `req.ip` was nginx's loopback address for every
request — and the login rate-limiter was effectively keyed on 127.0.0.1 (one
attacker could lock everyone out). The webcall code worked around it by parsing
`X-Forwarded-For` by hand, which a client can spoof.

Now `app.set('trust proxy', TRUST_PROXY)` (default 'loopback') makes `req.ip` the
real client IP taken from *our* nginx, and the manual header parsing is removed.
Rate limiting, abuse tracking and blocking now key on a trustworthy IP.

## Trunk trusted IPs: real CIDR support (fixed)

`TRUNK_TRUSTED_IPS` and per-trunk `trustedIps` documented CIDR but only did exact
equality, so `203.0.113.0/24` matched nothing. CIDR blocks are now matched as
subnets (exact IPs still fast-path via the Map). Both exact IPs and CIDRs may be
mixed in the same list.

## Web-call open-widget policy (hardened)

A widget with no `allowedDomains` is globally embeddable — anyone can put it on
any site and consume a telephony line. Still allowed by default (a product
choice), but now it **warns loudly** once per widget. Set
`WEBCALL_REQUIRE_ALLOWED_DOMAINS=true` to refuse open widgets entirely.
