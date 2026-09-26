const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const logger = require('./logger');

// ============================================================
// SSRF-safe file download (carrier recordings)
//
// A public webhook hands us a RecordingUrl. Treating it as a generic URL and
// fetching it — following redirects, no host limits — is a server-side request
// forgery primitive: an unauthenticated caller could make the PBX fetch
// http://169.254.169.254/ (cloud metadata), http://127.0.0.1/… or any internal
// service. This downloader closes that:
//
//   1. https only (recordings are always https from the carriers)
//   2. the hostname must be on the allow-list of known carrier domains
//   3. it is resolved and every resolved IP must be public — private,
//      loopback, link-local and CGNAT ranges are rejected
//   4. redirects are followed only to hosts that pass the same checks, with a
//      small hop limit
//   5. a size cap and timeout bound the fetch
//
// Allowed hosts come from RECORDING_ALLOWED_HOSTS (comma-separated, suffix
// match) plus a built-in list of the major providers. Set the env var to add
// your provider if it serves recordings from another domain.
// ============================================================

const BUILTIN_HOSTS = [
  'twilio.com', 'api.twilio.com',
  'signalwire.com',                 // *.signalwire.com
  'telnyx.com', 'api.telnyx.com',
  'plivo.com', 'api.plivo.com',
  'bandwidth.com',
  'vonage.com', 'nexmo.com'
];

function allowedHosts() {
  const extra = (process.env.RECORDING_ALLOWED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return [...BUILTIN_HOSTS, ...extra];
}

function hostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase();
  return allowedHosts().some(dom => h === dom || h.endsWith('.' + dom));
}

// Private / loopback / link-local / CGNAT / reserved — never fetch these.
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;         // link-local (incl. 169.254.169.254)
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT 100.64/10
    if (p[0] >= 224) return true;                          // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe80')) return true;                 // link-local
    if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique local
    // IPv4-mapped (::ffff:a.b.c.d) — check the embedded v4
    const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true; // not a valid IP — reject
}

// Validate a URL for fetching: https, allowed host, all resolved IPs public.
// Returns { ok, url, ip, error }.
async function validateUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { return { ok: false, error: 'invalid URL' }; }
  if (u.protocol !== 'https:') return { ok: false, error: `protocol ${u.protocol} not allowed (https only)` };
  if (!hostAllowed(u.hostname)) return { ok: false, error: `host ${u.hostname} is not an allowed recording host` };

  // If the host is a literal IP, check it directly; otherwise resolve.
  let ips = [];
  if (net.isIP(u.hostname)) ips = [u.hostname];
  else {
    try {
      const a4 = await dns.resolve4(u.hostname).catch(() => []);
      const a6 = await dns.resolve6(u.hostname).catch(() => []);
      ips = [...a4, ...a6];
    } catch (e) { return { ok: false, error: `cannot resolve ${u.hostname}` }; }
  }
  if (ips.length === 0) return { ok: false, error: `no addresses for ${u.hostname}` };
  const bad = ips.find(isPrivateIp);
  if (bad) return { ok: false, error: `${u.hostname} resolves to a private/reserved address (${bad})` };

  return { ok: true, url: u, ip: ips[0] };
}

/**
 * Download a carrier recording safely to destPath.
 * @param {string} rawUrl - the RecordingUrl from the webhook (untrusted)
 * @param {string} destPath - local file path
 * @param {object} [opts] - { auth: {username,password}, maxBytes, maxRedirects }
 */
async function downloadRecording(rawUrl, destPath, opts = {}) {
  const maxBytes = opts.maxBytes || 100 * 1024 * 1024;   // 100 MB cap
  const maxRedirects = opts.maxRedirects != null ? opts.maxRedirects : 3;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const v = await validateUrl(current);
    if (!v.ok) throw Object.assign(new Error(`Recording download refused: ${v.error}`), { ssrf: true });

    const redirectOrDone = await new Promise((resolve, reject) => {
      const u = v.url;
      const headers = {};
      if (opts.auth && opts.auth.username && opts.auth.password) {
        headers['Authorization'] = 'Basic ' + Buffer.from(`${opts.auth.username}:${opts.auth.password}`).toString('base64');
      }
      const request = https.get({
        hostname: u.hostname, port: u.port || 443,
        path: u.pathname + u.search, headers,
        // Pin the connection to the IP we validated, so DNS can't be re-resolved
        // to a private address between our check and the socket (DNS rebinding).
        lookup: (host, options, cb) => cb(null, v.ip, net.isIPv6(v.ip) ? 6 : 4)
      }, (response) => {
        const code = response.statusCode;
        if (code === 301 || code === 302 || code === 303 || code === 307 || code === 308) {
          response.resume();
          const loc = response.headers.location;
          if (!loc) return reject(new Error('redirect with no Location'));
          // Resolve relative redirects against the current URL, then re-validate.
          return resolve({ redirect: new URL(loc, u).toString() });
        }
        if (code !== 200) { response.resume(); return reject(new Error(`Download failed: HTTP ${code}`)); }

        const file = fs.createWriteStream(destPath);
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > maxBytes) {
            request.destroy();
            file.close();
            try { fs.unlinkSync(destPath); } catch (e) {}
            reject(new Error('recording exceeds size limit'));
          }
        });
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve({ done: true })));
        file.on('error', (err) => { try { fs.unlinkSync(destPath); } catch (e) {} reject(err); });
      });
      request.on('error', reject);
      request.setTimeout(30000, () => { request.destroy(); reject(new Error('Download timeout')); });
    });

    if (redirectOrDone.done) return destPath;
    current = redirectOrDone.redirect;   // loop re-validates the redirect target
  }
  throw new Error('too many redirects');
}

module.exports = { downloadRecording, validateUrl, isPrivateIp, hostAllowed };
