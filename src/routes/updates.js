const express = require('express');
const logger = require('../utils/logger');
const updater = require('../services/updater');
const os = require('os');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

// ============================================================
// Update routes (Settings → System)
//
// Admin session only, never the API key: applying an update runs git and
// npm and restarts the service, so it should not be reachable with a
// credential that gets embedded in pages or scripts.
//
//   GET  /system/api/update/status    what's installed vs upstream
//   POST /system/api/update/apply     pull, install, restart
//   GET  /system/api/update/progress  step-by-step, polled by the UI
// ============================================================

function createUpdateRouter(deps) {
  const router = express.Router();
  const web = require('./web');
  const guards = [web.authMiddleware, web.adminOnly];

  const activeCalls = () => {
    try { return deps.callHandler && deps.callHandler.activeCalls ? deps.callHandler.activeCalls.size : 0; }
    catch (e) { return 0; }
  };

  router.get('/system/api/update/status', ...guards, async (req, res) => {
    try {
      const doFetch = req.query.fetch !== '0';
      const status = await updater.status(doFetch);
      res.json({ success: true, ...status, activeCalls: activeCalls() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/system/api/update/apply', ...guards, async (req, res) => {
    try {
      const force = !!(req.body && req.body.force);
      logger.info(`UPDATE: requested by ${req.session ? req.session.user : 'admin'}${force ? ' (forced)' : ''}`);
      const job = await updater.update({ force }, activeCalls);
      res.json({ success: true, started: true, from: job.from, to: job.to, behind: job.behind });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  router.get('/system/api/update/progress', ...guards, (req, res) => {
    res.json({ success: true, ...updater.progress() });
  });

  // ── Host system info (admin only) ──
  // CPU / memory from Node's os module; disk from `df` on the app directory.
  // Exposes host details, so it stays behind the admin session like updates.
  router.get('/system/api/info', ...guards, async (req, res) => {
    try {
      const cpus = os.cpus() || [];
      const load = os.loadavg();               // [1m, 5m, 15m] — 0s on Windows
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const mem = process.memoryUsage();

      const info = {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        node: process.version,
        uptimeHost: Math.round(os.uptime()),         // seconds the machine has been up
        uptimeProcess: Math.round(process.uptime()), // seconds this app has run
        cpu: {
          model: cpus.length ? cpus[0].model.trim() : 'unknown',
          cores: cpus.length,
          speedMHz: cpus.length ? cpus[0].speed : 0,
          load1: load[0], load5: load[1], load15: load[2],
          // load as a % of capacity (1m load / cores)
          loadPct: cpus.length ? Math.round((load[0] / cpus.length) * 100) : 0
        },
        memory: {
          totalBytes: totalMem,
          freeBytes: freeMem,
          usedBytes: totalMem - freeMem,
          usedPct: totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
          processRssBytes: mem.rss
        },
        disk: await diskUsage(),
        fail2ban: await fail2banStatus()
      };
      res.json({ success: true, info });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

// Disk usage of the filesystem holding the app, via `df -kP`. Returns null if
// df isn't available (e.g. a non-POSIX host).
function diskUsage() {
  return new Promise((resolve) => {
    execFile('df', ['-kP', __dirname], { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try {
        const line = stdout.trim().split('\n').pop().split(/\s+/);
        // Filesystem  1024-blocks  Used  Available  Capacity  Mounted
        const totalKb = parseInt(line[1], 10);
        const usedKb = parseInt(line[2], 10);
        const availKb = parseInt(line[3], 10);
        if (isNaN(totalKb)) return resolve(null);
        resolve({
          totalBytes: totalKb * 1024,
          usedBytes: usedKb * 1024,
          freeBytes: availKb * 1024,
          usedPct: totalKb ? Math.round((usedKb / totalKb) * 100) : 0,
          mount: line[5] || '/'
        });
      } catch (e) { resolve(null); }
    });
  });
}

// Brute-force protection status via `fail2ban-client` (read-only). Reports
// whether the daemon is up and, per jail, how many IPs are banned and which.
// Returns { running: false } if the socket is down or the client is missing,
// so the UI can show a clear red "not running" state. The command is fixed
// (no user input), so there is no injection surface.
function f2bClient(args) {
  return new Promise((resolve) => {
    execFile('fail2ban-client', args, { timeout: 5000 }, (err, stdout) => {
      resolve({ err, out: (stdout || '').toString() });
    });
  });
}

async function fail2banStatus() {
  const top = await f2bClient(['status']);
  if (top.err) {
    // socket down (daemon failed/stopped) or client not installed
    return { running: false };
  }
  const jailsLine = (top.out.match(/Jail list:\s*(.*)/i) || [])[1] || '';
  const jailNames = jailsLine.split(',').map((s) => s.trim()).filter(Boolean);
  const jails = [];
  for (const name of jailNames) {
    const j = await f2bClient(['status', name]);
    if (j.err) { jails.push({ name, error: true }); continue; }
    const cur = parseInt((j.out.match(/Currently banned:\s*(\d+)/i) || [])[1] || '0', 10);
    const tot = parseInt((j.out.match(/Total banned:\s*(\d+)/i) || [])[1] || '0', 10);
    const ipLine = (j.out.match(/Banned IP list:\s*(.*)/i) || [])[1] || '';
    const ips = ipLine.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    jails.push({ name, currentlyBanned: cur, totalBanned: tot, bannedIps: ips });
  }
  return { running: true, jails };
}

// ── fail2ban whitelist (ignoreip) ───────────────────────────────────────
// Addresses here are never banned. This exists because it is very easy to lock
// YOURSELF out: a softphone retrying with a stale password trips the same jail
// as an attacker, and then the web UI is unreachable from your own network.
//
// Managed in its own drop-in file so we never rewrite the operator's jail.local.
const F2B_WHITELIST_FILE = '/etc/fail2ban/jail.d/zz-shadowpbx-whitelist.conf';

// IPv4/IPv6 address or CIDR. Deliberately strict: a bad entry makes fail2ban
// refuse to start, which would be a worse outage than the one it prevents.
function validIpOrCidr(s) {
  const v = String(s || '').trim();
  if (!v) return false;
  const m = v.match(/^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/);
  if (!m) return false;
  const addr = m[1], bits = m[2] === undefined ? null : parseInt(m[2], 10);
  if (addr.indexOf(':') > -1) {                       // IPv6
    if (!/^[0-9a-fA-F:]+$/.test(addr) || (addr.match(/::/g) || []).length > 1) return false;
    return bits === null || (bits >= 0 && bits <= 128);
  }
  const parts = addr.split('.');                      // IPv4
  if (parts.length !== 4) return false;
  if (!parts.every(p => /^\d{1,3}$/.test(p) && +p >= 0 && +p <= 255)) return false;
  return bits === null || (bits >= 0 && bits <= 32);
}

function readWhitelist() {
  try {
    if (!fs.existsSync(F2B_WHITELIST_FILE)) return [];
    const txt = fs.readFileSync(F2B_WHITELIST_FILE, 'utf8');
    const out = [];
    const notes = {};
    txt.split('\n').forEach(line => {
      const n = line.match(/^#\s*note\s+(\S+)\s*:\s*(.*)$/);
      if (n) notes[n[1]] = n[2].trim();
    });
    const m = txt.match(/^ignoreip\s*=\s*(.*)$/m);
    if (m) {
      m[1].split(/\s+/).filter(Boolean).forEach(ip => {
        if (ip === '127.0.0.1/8' || ip === '::1') return;   // always-present defaults
        out.push({ ip, note: notes[ip] || '' });
      });
    }
    return out;
  } catch (e) { return []; }
}

function writeWhitelist(entries) {
  const dir = path.dirname(F2B_WHITELIST_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const notes = entries.filter(e => e.note)
    .map(e => `# note ${e.ip}: ${String(e.note).replace(/[\r\n]/g, ' ').slice(0, 160)}`)
    .join('\n');
  const ips = entries.map(e => e.ip).join(' ');
  const body =
    '# Managed by ShadowPBX (Settings → Security → Whitelist). Edits here may be\n' +
    '# overwritten. Addresses listed are never banned by any jail.\n' +
    (notes ? notes + '\n' : '') +
    '[DEFAULT]\n' +
    `ignoreip = 127.0.0.1/8 ::1${ips ? ' ' + ips : ''}\n`;
  fs.writeFileSync(F2B_WHITELIST_FILE, body);
}

function createWhitelistRouter() {
  const router = express.Router();
  const web = require('./web');
  const guard = [web.authMiddleware, web.adminOnly];

  router.get('/system/api/whitelist', ...guard, (req, res) => {
    res.json({ success: true, entries: readWhitelist(), file: F2B_WHITELIST_FILE });
  });

  router.post('/system/api/whitelist', ...guard, async (req, res) => {
    try {
      const ip = String((req.body && req.body.ip) || '').trim();
      const note = String((req.body && req.body.note) || '').trim();
      if (!validIpOrCidr(ip)) {
        return res.status(400).json({ success: false, error: 'Enter a valid IP address or CIDR range (e.g. 203.0.113.5 or 203.0.113.0/24)' });
      }
      const entries = readWhitelist();
      if (entries.some(e => e.ip === ip)) {
        return res.status(409).json({ success: false, error: 'That address is already whitelisted' });
      }
      entries.push({ ip, note });
      writeWhitelist(entries);
      await reloadFail2ban();
      // Clear any ban it already has, so adding yourself works immediately.
      const jails = await f2bJailNames();
      for (const j of jails) { try { await f2bClient(['set', j, 'unbanip', ip]); } catch (e) {} }
      logger.info(`WHITELIST: added ${ip} (${note || 'no note'}) by ${req.session && req.session.user}`);
      res.json({ success: true, entries: readWhitelist() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/system/api/whitelist/:ip', ...guard, async (req, res) => {
    try {
      const ip = decodeURIComponent(req.params.ip || '');
      const entries = readWhitelist().filter(e => e.ip !== ip);
      writeWhitelist(entries);
      await reloadFail2ban();
      logger.info(`WHITELIST: removed ${ip} by ${req.session && req.session.user}`);
      res.json({ success: true, entries: readWhitelist() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Unban an address without whitelisting it (one-off recovery).
  router.post('/system/api/unban', ...guard, async (req, res) => {
    try {
      const ip = String((req.body && req.body.ip) || '').trim();
      if (!validIpOrCidr(ip)) return res.status(400).json({ success: false, error: 'Enter a valid IP address' });
      const jails = await f2bJailNames();
      let cleared = 0;
      for (const j of jails) {
        const r = await f2bClient(['set', j, 'unbanip', ip]);
        if (!r.err) cleared++;
      }
      logger.info(`WHITELIST: unbanned ${ip} from ${cleared} jail(s) by ${req.session && req.session.user}`);
      res.json({ success: true, cleared });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  return router;
}

async function f2bJailNames() {
  const top = await f2bClient(['status']);
  if (top.err) return [];
  const line = (top.out.match(/Jail list:\s*(.*)/i) || [])[1] || '';
  return line.split(',').map(s => s.trim()).filter(Boolean);
}

function reloadFail2ban() {
  return new Promise((resolve) => {
    execFile('fail2ban-client', ['reload'], { timeout: 15000 }, () => resolve());
  });
}

module.exports = { createUpdateRouter, createWhitelistRouter };
