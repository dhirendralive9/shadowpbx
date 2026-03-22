const express = require('express');
const { Extension, RingGroup, Trunk, InboundRoute, OutboundRoute, CDR } = require('../models');
const logger = require('../utils/logger');

function createApiRouter(registrar, callHandler, trunkManager, transferHandler, holdHandler, parkHandler, voicemailHandler, ivrHandler, monitorHandler, timeConditionService) {
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
  // IVR / Auto Attendant
  // ============================================================
  const { IVR } = require('../models');

  router.get('/ivr', async (req, res) => {
    try {
      const ivrs = await IVR.find({}).sort('number');
      res.json({ success: true, ivrs });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/ivr/:number', async (req, res) => {
    try {
      const ivr = await IVR.findOne({ number: req.params.number });
      if (!ivr) return res.status(404).json({ success: false, error: 'IVR not found' });
      res.json({ success: true, ivr });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/ivr', async (req, res) => {
    try {
      const { number, name, greeting, options, timeout, maxRetries, timeoutDest } = req.body;
      if (!number || !name || !options) return res.status(400).json({ success: false, error: 'number, name, options required' });
      if (await IVR.findOne({ number })) return res.status(409).json({ success: false, error: 'IVR number already exists' });
      const ivr = await IVR.create({ number, name, greeting, options, timeout, maxRetries, timeoutDest });
      logger.info(`IVR created: ${number} (${name}) with ${options.length} option(s)`);
      res.status(201).json({ success: true, ivr });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/ivr/:number', async (req, res) => {
    try {
      const ivr = await IVR.findOneAndUpdate({ number: req.params.number }, req.body, { new: true });
      if (!ivr) return res.status(404).json({ success: false, error: 'IVR not found' });
      res.json({ success: true, ivr });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/ivr/:number', async (req, res) => {
    try {
      const ivr = await IVR.findOneAndDelete({ number: req.params.number });
      if (!ivr) return res.status(404).json({ success: false, error: 'IVR not found' });
      res.json({ success: true, message: `IVR ${req.params.number} deleted` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Time Conditions
  // ============================================================
  const { TimeCondition } = require('../models');

  router.get('/time-conditions', async (req, res) => {
    try {
      const conditions = await TimeCondition.find({}).sort('number');
      // Attach live match status to each condition
      const result = conditions.map(tc => {
        const obj = tc.toObject();
        if (timeConditionService) {
          obj.currentlyMatched = timeConditionService._isMatch(tc);
        }
        return obj;
      });
      res.json({ success: true, conditions: result });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/time-conditions/:number', async (req, res) => {
    try {
      const tc = await TimeCondition.findOne({ number: req.params.number });
      if (!tc) return res.status(404).json({ success: false, error: 'Time condition not found' });
      const obj = tc.toObject();
      if (timeConditionService) obj.currentlyMatched = timeConditionService._isMatch(tc);
      res.json({ success: true, condition: obj });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/time-conditions', async (req, res) => {
    try {
      const { number, name, timezone, schedule, holidays, matchDest, noMatchDest } = req.body;
      if (!number || !name || !schedule || !matchDest || !noMatchDest) {
        return res.status(400).json({ success: false, error: 'number, name, schedule, matchDest, noMatchDest required' });
      }
      if (await TimeCondition.findOne({ number })) {
        return res.status(409).json({ success: false, error: 'Time condition number already exists' });
      }
      const tc = await TimeCondition.create({ number, name, timezone, schedule, holidays, matchDest, noMatchDest });
      logger.info(`Time condition created: ${number} (${name})`);
      res.status(201).json({ success: true, condition: tc });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/time-conditions/:number', async (req, res) => {
    try {
      const tc = await TimeCondition.findOneAndUpdate({ number: req.params.number }, req.body, { new: true });
      if (!tc) return res.status(404).json({ success: false, error: 'Time condition not found' });
      res.json({ success: true, condition: tc });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/time-conditions/:number', async (req, res) => {
    try {
      const tc = await TimeCondition.findOneAndDelete({ number: req.params.number });
      if (!tc) return res.status(404).json({ success: false, error: 'Time condition not found' });
      res.json({ success: true, message: `Time condition ${req.params.number} deleted` });
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
  // Voicemail
  // ============================================================
  router.get('/voicemail/:ext', async (req, res) => {
    try {
      if (!voicemailHandler) return res.status(503).json({ success: false, error: 'Voicemail not available' });
      const options = {
        limit: parseInt(req.query.limit) || 50,
        page: parseInt(req.query.page) || 1,
        unreadOnly: req.query.unread === 'true'
      };
      const result = await voicemailHandler.getMessages(req.params.ext, options);
      res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/voicemail/:ext/summary', async (req, res) => {
    try {
      if (!voicemailHandler) return res.status(503).json({ success: false, error: 'Voicemail not available' });
      const summary = await voicemailHandler.getSummary(req.params.ext);
      res.json({ success: true, ...summary });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/voicemail/:ext/:messageId/read', async (req, res) => {
    try {
      if (!voicemailHandler) return res.status(503).json({ success: false, error: 'Voicemail not available' });
      const msg = await voicemailHandler.markRead(req.params.ext, req.params.messageId);
      res.json({ success: true, message: msg });
    } catch (err) {
      res.status(err.message.includes('not found') ? 404 : 500).json({ success: false, error: err.message });
    }
  });

  router.delete('/voicemail/:ext/:messageId', async (req, res) => {
    try {
      if (!voicemailHandler) return res.status(503).json({ success: false, error: 'Voicemail not available' });
      await voicemailHandler.deleteMessage(req.params.ext, req.params.messageId);
      res.json({ success: true, message: 'Voicemail deleted' });
    } catch (err) {
      res.status(err.message.includes('not found') ? 404 : 500).json({ success: false, error: err.message });
    }
  });

  router.get('/voicemail/:ext/:messageId/audio', async (req, res) => {
    try {
      if (!voicemailHandler) return res.status(503).json({ success: false, error: 'Voicemail not available' });
      const audioPath = await voicemailHandler.getAudioPathAsync(req.params.ext, req.params.messageId);
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${require('path').basename(audioPath)}"`);
      require('fs').createReadStream(audioPath).pipe(res);
    } catch (err) {
      res.status(err.message.includes('not found') ? 404 : 500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // Supervisor Monitoring (Listen / Whisper / Barge)
  // ============================================================
  router.post('/calls/:callId/monitor', async (req, res) => {
    try {
      if (!monitorHandler) return res.status(503).json({ success: false, error: 'Monitor not available' });
      const { supervisorExt, mode } = req.body;
      if (!supervisorExt) return res.status(400).json({ success: false, error: 'supervisorExt required' });
      const result = await monitorHandler.startMonitor(req.params.callId, supervisorExt, mode || 'listen');
      res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/monitors/:monitorId/mode', async (req, res) => {
    try {
      if (!monitorHandler) return res.status(503).json({ success: false, error: 'Monitor not available' });
      const { mode } = req.body;
      if (!mode) return res.status(400).json({ success: false, error: 'mode required' });
      const result = await monitorHandler.changeMode(req.params.monitorId, mode);
      res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/monitors/:monitorId', async (req, res) => {
    try {
      if (!monitorHandler) return res.status(503).json({ success: false, error: 'Monitor not available' });
      await monitorHandler.stopMonitor(req.params.monitorId);
      res.json({ success: true, message: 'Monitor session ended' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/monitors', async (req, res) => {
    try {
      if (!monitorHandler) return res.json({ success: true, monitors: [] });
      res.json({ success: true, monitors: monitorHandler.getActiveMonitors() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // CDR + Stats
  // ============================================================
  router.get('/cdr', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const page = parseInt(req.query.page) || 1;
      const filter = {};
      if (req.query.search) {
        const s = req.query.search;
        filter.$or = [
          { from: { $regex: s, $options: 'i' } },
          { to: { $regex: s, $options: 'i' } },
          { didNumber: { $regex: s, $options: 'i' } }
        ];
      }
      if (req.query.extension) {
        filter.$or = [{ from: req.query.extension }, { to: req.query.extension }];
      }
      if (req.query.status) filter.status = req.query.status;
      if (req.query.direction) filter.direction = req.query.direction;
      if (req.query.from) filter.startTime = { $gte: new Date(req.query.from) };
      if (req.query.to) { filter.startTime = filter.startTime || {}; filter.startTime.$lte = new Date(req.query.to); }
      const [records, total] = await Promise.all([
        CDR.find(filter).sort({ startTime: -1 }).skip((page - 1) * limit).limit(limit),
        CDR.countDocuments(filter)
      ]);
      res.json({ success: true, cdrs: records, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
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

  // ============================================================
  // CDR Recording playback
  // ============================================================
  router.get('/cdr/:callId/recording', async (req, res) => {
    try {
      const cdr = await CDR.findOne({ callId: req.params.callId });
      if (!cdr || !cdr.recordingPath) return res.status(404).json({ success: false, error: 'Recording not found' });
      const fs = require('fs');
      if (!fs.existsSync(cdr.recordingPath)) return res.status(404).json({ success: false, error: 'Recording file missing' });
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${require('path').basename(cdr.recordingPath)}"`);
      fs.createReadStream(cdr.recordingPath).pipe(res);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  return router;
}

module.exports = createApiRouter;
