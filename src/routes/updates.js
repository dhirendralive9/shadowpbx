const express = require('express');
const logger = require('../utils/logger');
const updater = require('../services/updater');

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

  return router;
}

module.exports = { createUpdateRouter };
