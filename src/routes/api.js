const express = require('express');
const { Extension, RingGroup, Trunk, InboundRoute, OutboundRoute, CDR } = require('../models');
const logger = require('../utils/logger');

function createApiRouter(registrar, callHandler, trunkManager, transferHandler, holdHandler, parkHandler) {
  const router = express.Router();

  // ============================================================
  // Extensions CRUD (same as v1)
  // ============================================================
  router.get('/extensions', async (req, res) => {
    try {
      const extensions = await Extension.find({}, '-password').sort('extension');
      const result = extensions.map(ext => ({
        extension: ext.extension, name: ext.name, email: ext.email,
        enabled: ext.enabled, registered: ext.isRegistered(),
        contacts: ext.getActiveContacts().map(c => ({ ip: c.ip, port: c.port, userAgent: c.userAgent, expires: c.expires })),
        createdAt: ext.createdAt
      }));
      res.json({ success: true, extensions: result });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/extensions/:ext', async (req, res) => {
    try {
      const ext = await Extension.findOne({ extension: req.params.ext }, '-password');
      if (!ext) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, extension: ext });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/extensions', async (req, res) => {
    try {
      const { extension, name, password, email } = req.body;
      if (!extension || !name || !password) return res.status(400).json({ success: false, error: 'extension, name, password required' });
      if (await Extension.findOne({ extension })) return res.status(409).json({ success: false, error: 'Already exists' });
      await Extension.create({ extension, name, password, email });
      logger.info(`Extension ${extension} (${name}) created`);
      res.status(201).json({ success: true, extension: { extension, name, email } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/extensions/:ext', async (req, res) => {
    try {
      const updates = {};
      ['name', 'password', 'email', 'enabled'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
      updates.updatedAt = new Date();
      const ext = await Extension.findOneAndUpdate({ extension: req.params.ext }, updates, { new: true, select: '-password' });
      if (!ext) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, extension: ext });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/extensions/:ext', async (req, res) => {
    try {
      const ext = await Extension.findOneAndDelete({ extension: req.params.ext });
      if (!ext) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, message: `Extension ${req.params.ext} deleted` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/extensions/bulk', async (req, res) => {
    try {
      const { extensions } = req.body;
      if (!Array.isArray(extensions)) return res.status(400).json({ success: false, error: 'extensions array required' });
      const results = [];
      for (const ext of extensions) {
        try {
          if (await Extension.findOne({ extension: ext.extension })) { results.push({ extension: ext.extension, status: 'exists' }); continue; }
          await Extension.create(ext);
          results.push({ extension: ext.extension, status: 'created' });
        } catch (err) { results.push({ extension: ext.extension, status: 'error', error: err.message }); }
      }
      res.json({ success: true, results });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Ring Groups
  // ============================================================
  router.get('/ringgroups', async (req, res) => {
    try {
      const groups = await RingGroup.find({}).sort('number');
      res.json({ success: true, ringgroups: groups });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/ringgroups', async (req, res) => {
    try {
      const { number, name, strategy, members, ringTime } = req.body;
      if (!number || !name || !members) return res.status(400).json({ success: false, error: 'number, name, members required' });
      if (await RingGroup.findOne({ number })) return res.status(409).json({ success: false, error: 'Ring group number exists' });
      const rg = await RingGroup.create({ number, name, strategy: strategy || 'ringall', members, ringTime: ringTime || 30 });
      logger.info(`Ring group ${number} (${name}) created: ${members.join(',')}`);
      res.status(201).json({ success: true, ringgroup: rg });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/ringgroups/:number', async (req, res) => {
    try {
      const rg = await RingGroup.findOneAndUpdate({ number: req.params.number }, req.body, { new: true });
      if (!rg) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, ringgroup: rg });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/ringgroups/:number', async (req, res) => {
    try {
      const rg = await RingGroup.findOneAndDelete({ number: req.params.number });
      if (!rg) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, message: `Ring group ${req.params.number} deleted` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Trunks
  // ============================================================
  router.get('/trunks', async (req, res) => {
    try {
      const trunks = await Trunk.find({}, '-password');
      res.json({ success: true, trunks });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/trunks', async (req, res) => {
    try {
      const { name, provider, host, username, password, port, register } = req.body;
      if (!name || !host || !username || !password) return res.status(400).json({ success: false, error: 'name, host, username, password required' });
      const trunk = await Trunk.create({ name, provider, host, username, password, port, register: register !== false });
      logger.info(`Trunk ${name} created: ${host}`);

      // Register immediately
      if (trunkManager) await trunkManager.registerTrunk(trunk);

      res.status(201).json({ success: true, trunk: { name, provider, host, registered: trunk.registered } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/trunks/:name', async (req, res) => {
    try {
      const trunk = await Trunk.findOneAndDelete({ name: req.params.name });
      if (!trunk) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, message: `Trunk ${req.params.name} deleted` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Inbound Routes
  // ============================================================
  router.get('/inbound-routes', async (req, res) => {
    try {
      const routes = await InboundRoute.find({});
      res.json({ success: true, routes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/inbound-routes', async (req, res) => {
    try {
      const { did, name, destination } = req.body;
      if (!name || !destination) return res.status(400).json({ success: false, error: 'name, destination required' });
      const route = await InboundRoute.create({ did: did || '', name, destination });
      logger.info(`Inbound route: DID=${did || 'catch-all'} -> ${destination.type}:${destination.target}`);
      res.status(201).json({ success: true, route });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/inbound-routes/:id', async (req, res) => {
    try {
      await InboundRoute.findByIdAndDelete(req.params.id);
      res.json({ success: true, message: 'Route deleted' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Outbound Routes
  // ============================================================
  router.get('/outbound-routes', async (req, res) => {
    try {
      const routes = await OutboundRoute.find({}).sort('priority');
      res.json({ success: true, routes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/outbound-routes', async (req, res) => {
    try {
      const { name, patterns, trunk, prepend, strip, callerIdNumber, priority } = req.body;
      if (!name || !patterns || !trunk) return res.status(400).json({ success: false, error: 'name, patterns, trunk required' });
      const route = await OutboundRoute.create({ name, patterns, trunk, prepend, strip, callerIdNumber, priority });
      logger.info(`Outbound route: ${name} patterns=${patterns.join(',')} -> trunk:${trunk}`);
      res.status(201).json({ success: true, route });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/outbound-routes/:id', async (req, res) => {
    try {
      await OutboundRoute.findByIdAndDelete(req.params.id);
      res.json({ success: true, message: 'Route deleted' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Active Calls + Transfer
  // ============================================================
  router.get('/calls/active', async (req, res) => {
    try {
      const calls = callHandler.getActiveCalls();
      res.json({ success: true, calls });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/calls/:callId/transfer', async (req, res) => {
    try {
      const { target, type } = req.body;
      if (!target) return res.status(400).json({ success: false, error: 'target required' });
      if (!transferHandler) return res.status(503).json({ success: false, error: 'Transfer handler not available' });

      const result = await transferHandler.apiTransfer(req.params.callId, target, type || 'blind');
      res.json(result);
    } catch (err) {
      res.status(err.message.includes('not found') ? 404 : 500).json({ success: false, error: err.message });
    }
  });

  router.post('/calls/:callId/hold', async (req, res) => {
    try {
      if (!holdHandler) return res.status(503).json({ success: false, error: 'Hold handler not available' });
      const result = await holdHandler.apiHold(req.params.callId);
      res.json(result);
    } catch (err) {
      res.status(err.message.includes('not found') ? 404 : 500).json({ success: false, error: err.message });
    }
  });

  router.post('/calls/:callId/resume', async (req, res) => {
    try {
      if (!holdHandler) return res.status(503).json({ success: false, error: 'Hold handler not available' });
      const result = await holdHandler.apiResume(req.params.callId);
      res.json(result);
    } catch (err) {
      res.status(err.message.includes('not found') ? 404 : 500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // Call Park / Pickup
  // ============================================================
  router.get('/calls/parked', async (req, res) => {
    try {
      if (!parkHandler) return res.status(503).json({ success: false, error: 'Park handler not available' });
      const calls = parkHandler.getParkedCalls();
      res.json({ success: true, parked: calls });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/calls/:callId/park', async (req, res) => {
    try {
      if (!parkHandler) return res.status(503).json({ success: false, error: 'Park handler not available' });
      const result = await parkHandler.apiPark(req.params.callId, req.body.slot);
      res.json(result);
    } catch (err) {
      res.status(err.message.includes('not found') ? 404 : 500).json({ success: false, error: err.message });
    }
  });

  router.post('/calls/pickup/:slot', async (req, res) => {
    try {
      if (!parkHandler) return res.status(503).json({ success: false, error: 'Park handler not available' });
      const { extension } = req.body;
      if (!extension) return res.status(400).json({ success: false, error: 'extension required' });
      const result = await parkHandler.apiPickup(req.params.slot, extension);
      res.json(result);
    } catch (err) {
      res.status(err.message.includes('empty') ? 404 : 500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // CDR + Stats
  // ============================================================
  router.get('/cdr', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const page = parseInt(req.query.page) || 1;
      const filter = {};
      if (req.query.extension) filter.$or = [{ from: req.query.extension }, { to: req.query.extension }];
      if (req.query.status) filter.status = req.query.status;
      if (req.query.direction) filter.direction = req.query.direction;
      if (req.query.from) filter.startTime = { $gte: new Date(req.query.from) };
      if (req.query.to) { filter.startTime = filter.startTime || {}; filter.startTime.$lte = new Date(req.query.to); }
      const [records, total] = await Promise.all([
        CDR.find(filter).sort({ startTime: -1 }).skip((page - 1) * limit).limit(limit),
        CDR.countDocuments(filter)
      ]);
      res.json({ success: true, cdr: records, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/stats', async (req, res) => {
    try {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const [totalCalls, todayCalls, totalExtensions, rgCount, trunkStatus] = await Promise.all([
        CDR.countDocuments(),
        CDR.countDocuments({ startTime: { $gte: today } }),
        Extension.countDocuments(),
        RingGroup.countDocuments(),
        trunkManager ? trunkManager.getStatus() : []
      ]);
      res.json({
        success: true,
        stats: {
          totalCalls, todayCalls,
          activeCalls: callHandler.getActiveCalls(),
          totalExtensions, ringGroups: rgCount,
          trunks: trunkStatus
        }
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/health', (req, res) => {
    res.json({ success: true, service: 'ShadowPBX', version: '2.0.0', uptime: process.uptime() });
  });

  return router;
}

module.exports = createApiRouter;
