const https = require('https');
const logger = require('./logger');

// ============================================================
// IP intelligence enrichment (Security → attack monitor)
//
// Enriches attacker IPs with proxy / VPN / datacenter / risk / geo / ASN data
// from proxycheck.io (primary — purpose-built for the proxy/VPN/risk verdict)
// and iplocate.io (geo + ASN enrichment and fallback). Results are NORMALIZED
// into one shape and CACHED on this service, so the same scanner IP is looked
// up once, not on every page load — which also keeps you inside free-tier
// limits.
//
// Design decisions (chosen for all scenarios):
//   - enrich ON DEMAND but CACHE the result (TTL below), keyed by IP.
//   - proxycheck primary, iplocate merged in for geo/ASN and as a fallback if
//     proxycheck has no key or fails.
//   - FAIL-OPEN everywhere: if a key is unset, the API is down, or rate-limited,
//     the IP still lists — just without (or with partial) enrichment. The
//     overlay is never a blocker.
//   - DISPLAY ONLY: this produces a verdict/badges to help a human decide. It
//     does not auto-block. (A miscategorised mobile/CGNAT IP must not be
//     auto-firewalled.)
//
// Config (.env):
//   PROXYCHECK_API_KEY   proxycheck.io key (free tier ~1000/day)
//   IPLOCATE_API_KEY     iplocate.io key (optional; iplocate has a keyless tier)
//   IP_INTEL_ENABLED     true|false (default true; auto-off if no keys)
//   IP_INTEL_TTL_HOURS   cache lifetime, default 24
// ============================================================

const ENABLED = String(process.env.IP_INTEL_ENABLED || 'true').toLowerCase() !== 'false';
const TTL_MS = (parseInt(process.env.IP_INTEL_TTL_HOURS) || 24) * 3600 * 1000;
const HTTP_TIMEOUT = 4000;

class IpIntel {
  constructor() {
    this.cache = new Map();       // ip -> { data, at }
    this.inflight = new Map();    // ip -> Promise (dedupe concurrent lookups)
    this.stats = { lookups: 0, cacheHits: 0, proxycheckOk: 0, iplocateOk: 0, errors: 0 };
    const sweep = setInterval(() => this._sweep(), 3600 * 1000);
    if (sweep.unref) sweep.unref();
  }

  get available() {
    return ENABLED && (!!process.env.PROXYCHECK_API_KEY || !!process.env.IPLOCATE_API_KEY ||
      String(process.env.IPLOCATE_KEYLESS || '').toLowerCase() === 'true');
  }

  _sweep() {
    const cutoff = Date.now() - TTL_MS;
    for (const [ip, rec] of this.cache) if (rec.at < cutoff) this.cache.delete(ip);
  }

  // Cached lookup for one IP. Returns the normalized object, or null when
  // enrichment is unavailable/failed (caller renders the IP without badges).
  async lookup(ip) {
    if (!this.available || !ip) return null;
    if (ip === '127.0.0.1' || ip.startsWith('::1') || ip.startsWith('192.168.') || ip.startsWith('10.')) return null;

    const cached = this.cache.get(ip);
    if (cached && Date.now() - cached.at < TTL_MS) { this.stats.cacheHits++; return cached.data; }

    if (this.inflight.has(ip)) return this.inflight.get(ip);
    const p = this._fetch(ip).finally(() => this.inflight.delete(ip));
    this.inflight.set(ip, p);
    return p;
  }

  // Enrich many IPs, respecting the cache. Only uncached IPs hit the network,
  // and those are throttled to avoid a burst against the providers.
  async lookupMany(ips) {
    const out = {};
    const toFetch = [];
    for (const ip of ips) {
      const c = this.cache.get(ip);
      if (c && Date.now() - c.at < TTL_MS) out[ip] = c.data;
      else toFetch.push(ip);
    }
    // Small concurrency so a page with many new IPs doesn't hammer the APIs.
    const CONC = 4;
    for (let i = 0; i < toFetch.length; i += CONC) {
      const batch = toFetch.slice(i, i + CONC);
      const results = await Promise.all(batch.map(ip => this.lookup(ip).catch(() => null)));
      batch.forEach((ip, j) => { if (results[j]) out[ip] = results[j]; });
    }
    return out;
  }

  async _fetch(ip) {
    this.stats.lookups++;
    let proxycheck = null, iplocate = null;

    // Run both in parallel; either may be missing/failing.
    const jobs = [];
    if (process.env.PROXYCHECK_API_KEY) jobs.push(this._proxycheck(ip).then(d => { proxycheck = d; }).catch(() => {}));
    if (process.env.IPLOCATE_API_KEY || String(process.env.IPLOCATE_KEYLESS || '').toLowerCase() === 'true') {
      jobs.push(this._iplocate(ip).then(d => { iplocate = d; }).catch(() => {}));
    }
    await Promise.all(jobs);

    if (!proxycheck && !iplocate) { this.stats.errors++; return null; }

    const data = this._merge(ip, proxycheck, iplocate);
    this.cache.set(ip, { data, at: Date.now() });
    return data;
  }

  // ── proxycheck.io ──
  // GET https://proxycheck.io/v2/<ip>?key=KEY&vpn=1&asn=1&risk=1
  // Response: { status:'ok', <ip>: { proxy:'yes|no', type, risk, provider,
  //   asn, isocode, country, city, ... } }
  _proxycheck(ip) {
    const key = process.env.PROXYCHECK_API_KEY;
    const path = `/v2/${encodeURIComponent(ip)}?key=${encodeURIComponent(key)}&vpn=1&asn=1&risk=1`;
    return this._getJson('proxycheck.io', path).then(json => {
      if (!json || json.status !== 'ok' || !json[ip]) return null;
      this.stats.proxycheckOk++;
      const r = json[ip];
      return {
        proxy: String(r.proxy).toLowerCase() === 'yes',
        type: r.type || '',                       // VPN, Compromised Server, Business, etc.
        risk: typeof r.risk === 'number' ? r.risk : (r.risk ? parseInt(r.risk, 10) : null),
        provider: r.provider || r.organisation || '',
        asn: r.asn || '',
        country: r.country || '',
        isocode: r.isocode || '',
        city: r.city || ''
      };
    });
  }

  // ── iplocate.io ──
  // GET https://www.iplocate.io/api/lookup/<ip>?apikey=KEY
  // Response: { country, country_code, city, asn:{asn,name,route}, privacy:{
  //   is_vpn, is_proxy, is_tor, is_hosting, ... }, threat:{...}, ... }
  _iplocate(ip) {
    const key = process.env.IPLOCATE_API_KEY;
    const path = `/api/lookup/${encodeURIComponent(ip)}` + (key ? `?apikey=${encodeURIComponent(key)}` : '');
    return this._getJson('www.iplocate.io', path).then(json => {
      if (!json || (json.error)) return null;
      this.stats.iplocateOk++;
      const priv = json.privacy || {};
      const asnObj = json.asn || {};
      return {
        country: json.country || '',
        isocode: json.country_code || '',
        city: json.city || '',
        asn: asnObj.asn || '',
        provider: asnObj.name || asnObj.route || '',
        isVpn: !!priv.is_vpn,
        isProxy: !!priv.is_proxy,
        isTor: !!priv.is_tor,
        isHosting: !!priv.is_hosting,        // datacenter / hosting
        isAbuser: !!priv.is_abuser
      };
    });
  }

  // Merge the two into one normalized verdict.
  _merge(ip, pc, il) {
    const country = (pc && pc.country) || (il && il.country) || '';
    const isocode = (pc && pc.isocode) || (il && il.isocode) || '';
    const city = (pc && pc.city) || (il && il.city) || '';
    const asn = (pc && pc.asn) || (il && il.asn) || '';
    const provider = (pc && pc.provider) || (il && il.provider) || '';

    // proxy/vpn/datacenter signals from either source
    const isProxy = !!(pc && pc.proxy) || !!(il && il.isProxy);
    const pcType = (pc && pc.type || '').toLowerCase();
    const isVpn = !!(il && il.isVpn) || pcType.includes('vpn');
    const isTor = !!(il && il.isTor) || pcType.includes('tor');
    const isHosting = !!(il && il.isHosting) || pcType.includes('server') || pcType.includes('hosting') || pcType.includes('business');
    const isAbuser = !!(il && il.isAbuser) || pcType.includes('compromised');
    const risk = pc && pc.risk != null ? pc.risk : null;

    // A single verdict for the badge colour.
    let verdict = 'clean';
    if (isTor || isAbuser || (risk != null && risk >= 66)) verdict = 'high';
    else if (isProxy || isVpn || isHosting || (risk != null && risk >= 34)) verdict = 'suspicious';

    const tags = [];
    if (isVpn) tags.push('VPN');
    if (isProxy && !isVpn) tags.push('Proxy');
    if (isTor) tags.push('Tor');
    if (isHosting) tags.push('Datacenter');
    if (isAbuser) tags.push('Abuser');

    return {
      country, isocode, city, asn, provider,
      isProxy, isVpn, isTor, isHosting, isAbuser,
      risk, verdict, tags,
      sources: [pc ? 'proxycheck' : null, il ? 'iplocate' : null].filter(Boolean),
      at: Date.now()
    };
  }

  _getJson(host, path) {
    return new Promise((resolve) => {
      const req = https.get({ hostname: host, path, headers: { 'Accept': 'application/json', 'User-Agent': 'ShadowPBX' } }, (res) => {
        let body = '';
        res.on('data', c => { body += c; if (body.length > 256 * 1024) req.destroy(); });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(HTTP_TIMEOUT, () => { req.destroy(); resolve(null); });
    });
  }

  summary() {
    return {
      available: this.available,
      providers: [
        process.env.PROXYCHECK_API_KEY ? 'proxycheck' : null,
        (process.env.IPLOCATE_API_KEY || process.env.IPLOCATE_KEYLESS === 'true') ? 'iplocate' : null
      ].filter(Boolean),
      cached: this.cache.size,
      ...this.stats
    };
  }
}

module.exports = new IpIntel();
