const express = require('express');
const logger = require('../utils/logger');
const updater = require('../services/updater');
const os = require('os');
const { execFile } = require('child_process');

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
        disk: await diskUsage()
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

module.exports = { createUpdateRouter };
