# IP intelligence on the attack monitor

**Settings → Security** now enriches each attacker IP with proxy / VPN /
datacenter / Tor / risk / geo / ASN data, so you can judge at a glance whether
an IP is worth blocking.

## What you see

Each row gets an **Intel** column:

- a **verdict** badge — `clean` (green), `suspicious` (amber), `high` (red);
- **tags** — VPN, Proxy, Tor, Datacenter, Abuser;
- the **country** (with flag) and the **ASN / provider**;
- a proxycheck **risk** score when available.

Verdict logic: Tor / known-abuser / risk ≥ 66 → high; proxy / VPN / datacenter /
risk ≥ 34 → suspicious; otherwise clean.

## How it works

- **proxycheck.io** is the primary source (purpose-built for the proxy/VPN/risk
  verdict); **iplocate.io** adds geo/ASN and acts as a fallback. Both are
  optional; whichever has a key is used, and their results are merged.
- Results are **cached** per IP (`IP_INTEL_TTL_HOURS`, default 24), so the same
  scanner IP is looked up once — keeping you inside free-tier limits.
- **Fail-open**: if a key is unset, an API is down, or a lookup fails, the IP
  still lists — just without the badges. The enrichment never blocks the page.
- **Display only**: it helps a human decide; it never auto-blocks (a
  miscategorised mobile/CGNAT IP must not be firewalled automatically).

## Setup

In `.env`:

```
PROXYCHECK_API_KEY=your-proxycheck-key     # free tier ~1000/day
IPLOCATE_API_KEY=your-iplocate-key         # optional; geo/ASN + fallback
# or IPLOCATE_KEYLESS=true for iplocate's keyless tier
```

With neither key set, the feature is off and the Security page works exactly as
before (the summary line says intel is off).
