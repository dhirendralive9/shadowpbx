const express = require('express');
const { Extension, RingGroup, Trunk, InboundRoute, OutboundRoute, CDR } = require('../models');
const logger = require('../utils/logger');

function createApiRouter(registrar, callHandler, trunkManager, transferHandler, holdHandler, parkHandler, voicemailHandler, ivrHandler, monitorHandler, timeConditionService, presenceHandler, queueHandler, appointmentHandler, dialerEngine) {
  const router = express.Router();

  // ============================================================
  // Extensions CRUD (same as v1)
  // ============================================================
  router.get('/extensions', async (req, res) => {
    try {
      const extensions = await Extension.find({}, '-password').sort('extension');

      // Build a map of extensions currently in active calls for fallback
      const activeCallMap = {};
      if (callHandler && callHandler.activeCalls) {
        for (const [id, call] of callHandler.activeCalls) {
          const holdState = callHandler.holdHandler ? callHandler.holdHandler.holdState.get(id) : null;
          const isHeld = holdState && holdState.held;
          const fromExt = call.fromExt || (call.cdr && call.cdr.from);
          const toExt = call.toExt || (call.cdr && call.cdr.to);
          if (fromExt) activeCallMap[fromExt] = { state: isHeld ? 'held' : 'confirmed', remoteParty: toExt, callId: id };
          if (toExt) activeCallMap[toExt] = { state: isHeld ? 'held' : 'confirmed', remoteParty: fromExt, callId: id };
        }
      }

      const result = extensions.map(ext => {
        // Get presence from handler first, then fallback to active calls map
        let presence = presenceHandler ? presenceHandler.getState(ext.extension) : { state: 'idle' };
        let pState = presence.state || 'idle';
        let pRemote = presence.remoteParty || null;

        // Fallback: if presence says idle but activeCalls shows this ext in a call
        if (pState === 'idle' && activeCallMap[ext.extension]) {
          pState = activeCallMap[ext.extension].state;
          pRemote = activeCallMap[ext.extension].remoteParty;
        }

        return {
          extension: ext.extension, name: ext.name, email: ext.email,
          enabled: ext.enabled, registered: ext.isRegistered(),
          allowExternalCalls: ext.allowExternalCalls || false,
          contacts: ext.getActiveContacts().map(c => ({ ip: c.ip, port: c.port, userAgent: c.userAgent, expires: c.expires })),
          presence: pState,
          presenceRemote: pRemote,
          presenceSince: presence.since || null,
          createdAt: ext.createdAt
        };
      });
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
      ['name', 'password', 'email', 'enabled', 'allowExternalCalls'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
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

  // Regenerate password for a single extension
  router.post('/extensions/:ext/regenerate-password', async (req, res) => {
    try {
      const ext = await Extension.findOne({ extension: req.params.ext });
      if (!ext) return res.status(404).json({ success: false, error: 'Not found' });
      const crypto = require('crypto');
      const newPassword = crypto.randomBytes(12).toString('base64url').substring(0, 16);
      ext.password = newPassword;
      ext.updatedAt = new Date();
      await ext.save();
      logger.info(`Extension ${ext.extension}: password regenerated`);
      res.json({ success: true, extension: ext.extension, name: ext.name, password: newPassword });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Regenerate passwords for ALL extensions
  router.post('/extensions/regenerate-all', async (req, res) => {
    try {
      const crypto = require('crypto');
      const extensions = await Extension.find({}).sort('extension');
      const results = [];
      for (const ext of extensions) {
        const newPassword = crypto.randomBytes(12).toString('base64url').substring(0, 16);
        ext.password = newPassword;
        ext.updatedAt = new Date();
        await ext.save();
        results.push({ extension: ext.extension, name: ext.name, password: newPassword });
      }
      logger.info(`Regenerated passwords for ${results.length} extension(s)`);
      res.json({ success: true, extensions: results });
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

  router.put('/inbound-routes/:id', async (req, res) => {
    try {
      const route = await InboundRoute.findByIdAndUpdate(req.params.id, req.body, { new: true });
      if (!route) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, route });
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
      const { name, patterns, trunk, prepend, strip, callerIdNumber, priority, allowedExtensions, allowDialer } = req.body;
      if (!name || !patterns || !trunk) return res.status(400).json({ success: false, error: 'name, patterns, trunk required' });
      const route = await OutboundRoute.create({ name, patterns, trunk, prepend, strip, callerIdNumber, priority, allowedExtensions: allowedExtensions || [], allowDialer: allowDialer || false });
      logger.info(`Outbound route: ${name} patterns=${patterns.join(',')} -> trunk:${trunk} dialer=${allowDialer || false}`);
      res.status(201).json({ success: true, route });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/outbound-routes/:id', async (req, res) => {
    try {
      const route = await OutboundRoute.findByIdAndUpdate(req.params.id, req.body, { new: true });
      if (!route) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, route });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/outbound-routes/:id', async (req, res) => {
    try {
      await OutboundRoute.findByIdAndDelete(req.params.id);
      res.json({ success: true, message: 'Route deleted' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Outbound routes enabled for dialer campaigns
  router.get('/outbound-routes/dialer', async (req, res) => {
    try {
      const routes = await OutboundRoute.find({ enabled: true, allowDialer: true }).sort('priority');
      res.json({ success: true, routes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // IVR / Auto Attendant
  // ============================================================
  const { IVR } = require('../models');
  const multer = require('multer');
  const audioDir = process.env.MOH_DIR || '/opt/shadowpbx/audio';

  // Audio file upload (WAV only, max 10MB)
  const audioUpload = multer({
    storage: multer.diskStorage({
      destination: function(req, file, cb) {
        const fs = require('fs');
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
        cb(null, audioDir);
      },
      filename: function(req, file, cb) {
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, Date.now() + '-' + safeName);
      }
    }),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: function(req, file, cb) {
      if (file.mimetype === 'audio/wav' || file.mimetype === 'audio/x-wav' || file.mimetype === 'audio/wave' ||
          file.mimetype === 'audio/mpeg' || file.originalname.match(/\.(wav|mp3)$/i)) {
        cb(null, true);
      } else {
        cb(new Error('Only WAV and MP3 files are allowed'));
      }
    }
  });

  router.post('/audio/upload', audioUpload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
    const fs = require('fs');
    const path = require('path');
    const { execSync } = require('child_process');
    const uploadedPath = req.file.path;
    const baseName = path.basename(uploadedPath, path.extname(uploadedPath));
    const convertedPath = path.join(audioDir, baseName + '.wav');

    try {
      // Convert to 8kHz mono 16-bit PCM WAV (RTPEngine standard)
      // Use a temp file because ffmpeg can't read and write the same file
      const tmpPath = uploadedPath + '.tmp.wav';
      execSync(`ffmpeg -y -i "${uploadedPath}" -ar 8000 -ac 1 -sample_fmt s16 -acodec pcm_s16le "${tmpPath}" 2>/dev/null`);

      // Replace original with converted
      if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath);
      fs.renameSync(tmpPath, convertedPath);

      const stat = fs.statSync(convertedPath);
      logger.info(`Audio uploaded + converted: ${req.file.originalname} -> ${convertedPath} (8kHz mono PCM, ${Math.round(stat.size / 1024)}KB)`);
      res.json({ success: true, path: convertedPath, filename: baseName + '.wav', originalName: req.file.originalname, size: stat.size });
    } catch (convErr) {
      // ffmpeg not available or conversion failed — keep original
      logger.warn(`Audio conversion failed (${convErr.message}), keeping original: ${uploadedPath}`);
      res.json({ success: true, path: uploadedPath, filename: req.file.filename, originalName: req.file.originalname, size: req.file.size, warning: 'Conversion failed — file may not play correctly. Install ffmpeg for auto-conversion.' });
    }
  });

  router.get('/audio/list', (req, res) => {
    try {
      const fs = require('fs');
      if (!fs.existsSync(audioDir)) return res.json({ success: true, files: [] });
      const files = fs.readdirSync(audioDir)
        .filter(f => f.match(/\.(wav|mp3)$/i))
        .map(f => {
          const stat = fs.statSync(require('path').join(audioDir, f));
          return { name: f, path: require('path').join(audioDir, f), size: stat.size, modified: stat.mtime };
        })
        .sort((a, b) => new Date(b.modified) - new Date(a.modified));
      res.json({ success: true, files });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Serve audio file for playback
  router.get('/audio/play/:filename', (req, res) => {
    try {
      const fs = require('fs');
      const filePath = require('path').join(audioDir, req.params.filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'File not found' });
      const ext = req.params.filename.split('.').pop().toLowerCase();
      res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${req.params.filename}"`);
      fs.createReadStream(filePath).pipe(res);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Rename audio file
  router.post('/audio/rename', (req, res) => {
    try {
      const fs = require('fs');
      const path = require('path');
      const { oldName, newName } = req.body;
      if (!oldName || !newName) return res.status(400).json({ success: false, error: 'oldName and newName required' });
      const safeName = newName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = path.extname(oldName) || '.wav';
      const finalName = safeName.endsWith(ext) ? safeName : safeName + ext;
      const oldPath = path.join(audioDir, oldName);
      const newPath = path.join(audioDir, finalName);
      if (!fs.existsSync(oldPath)) return res.status(404).json({ success: false, error: 'File not found' });
      if (fs.existsSync(newPath) && oldPath !== newPath) return res.status(409).json({ success: false, error: 'A file with that name already exists' });
      fs.renameSync(oldPath, newPath);
      logger.info(`Audio renamed: ${oldName} -> ${finalName}`);
      res.json({ success: true, oldName, newName: finalName, path: newPath });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Delete audio file
  router.delete('/audio/:filename', (req, res) => {
    try {
      const fs = require('fs');
      const filePath = require('path').join(audioDir, req.params.filename);
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'File not found' });
      fs.unlinkSync(filePath);
      logger.info(`Audio deleted: ${req.params.filename}`);
      res.json({ success: true, message: `${req.params.filename} deleted` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

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
  // Call Queues / ACD
  // ============================================================
  const { Queue } = require('../models');

  router.get('/queues', async (req, res) => {
    try {
      const queues = await Queue.find({}).sort('number');
      const result = queues.map(q => {
        const obj = q.toObject();
        if (queueHandler) obj.stats = queueHandler.getStats(q.number);
        return obj;
      });
      res.json({ success: true, queues: result });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/queues/:number', async (req, res) => {
    try {
      const q = await Queue.findOne({ number: req.params.number });
      if (!q) return res.status(404).json({ success: false, error: 'Queue not found' });
      const obj = q.toObject();
      if (queueHandler) obj.stats = queueHandler.getStats(q.number);
      res.json({ success: true, queue: obj });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/queues', async (req, res) => {
    try {
      const { number, name, strategy, agents, maxWait, wrapUpTime, ringTimeout, retryDelay, maxCallers, moh, announceFrequency, overflowDest, joinMessage } = req.body;
      if (!number || !name) return res.status(400).json({ success: false, error: 'number, name required' });
      if (await Queue.findOne({ number })) return res.status(409).json({ success: false, error: 'Queue number already exists' });
      const q = await Queue.create({ number, name, strategy, agents: agents || [], maxWait, wrapUpTime, ringTimeout, retryDelay, maxCallers, moh, announceFrequency, overflowDest, joinMessage });
      // Initialize agent states
      if (queueHandler) {
        const stateMap = new Map();
        for (const a of (agents || [])) stateMap.set(a.extension, { state: 'logged-out', since: Date.now(), callCount: 0, lastCallEnd: 0 });
        queueHandler.agentStates.set(number, stateMap);
      }
      logger.info(`Queue created: ${number} (${name})`);
      res.status(201).json({ success: true, queue: q });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/queues/:number', async (req, res) => {
    try {
      const q = await Queue.findOneAndUpdate({ number: req.params.number }, req.body, { new: true });
      if (!q) return res.status(404).json({ success: false, error: 'Queue not found' });
      res.json({ success: true, queue: q });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/queues/:number', async (req, res) => {
    try {
      const q = await Queue.findOneAndDelete({ number: req.params.number });
      if (!q) return res.status(404).json({ success: false, error: 'Queue not found' });
      if (queueHandler) queueHandler.agentStates.delete(req.params.number);
      res.json({ success: true, message: `Queue ${req.params.number} deleted` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Agent login/logout
  router.post('/queues/:number/agents/login', async (req, res) => {
    try {
      if (!queueHandler) return res.status(503).json({ success: false, error: 'Queue handler not available' });
      const { extension } = req.body;
      if (!extension) return res.status(400).json({ success: false, error: 'extension required' });
      queueHandler.agentLogin(req.params.number, extension);
      res.json({ success: true, message: `Agent ${extension} logged into queue ${req.params.number}` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/queues/:number/agents/logout', async (req, res) => {
    try {
      if (!queueHandler) return res.status(503).json({ success: false, error: 'Queue handler not available' });
      const { extension } = req.body;
      if (!extension) return res.status(400).json({ success: false, error: 'extension required' });
      queueHandler.agentLogout(req.params.number, extension);
      res.json({ success: true, message: `Agent ${extension} logged out of queue ${req.params.number}` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Queue stats
  router.get('/queues/:number/stats', async (req, res) => {
    try {
      if (!queueHandler) return res.json({ success: true, stats: {} });
      res.json({ success: true, stats: queueHandler.getStats(req.params.number) });
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
  // BLF / Presence
  // ============================================================
  router.get('/presence', async (req, res) => {
    try {
      if (!presenceHandler) return res.json({ success: true, states: {}, totalSubscriptions: 0, monitoredExtensions: 0 });
      const stats = presenceHandler.getStats();
      res.json({ success: true, ...stats });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/presence/:ext', async (req, res) => {
    try {
      if (!presenceHandler) return res.json({ success: true, state: 'idle' });
      const state = presenceHandler.getState(req.params.ext);
      res.json({ success: true, extension: req.params.ext, ...state });
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
  // Users (RBAC)
  // ============================================================
  const { User } = require('../models');
  const bcrypt = require('bcryptjs');

  router.get('/users', async (req, res) => {
    try {
      const users = await User.find({}, '-password').sort('username');
      res.json({ success: true, users });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/users/:id', async (req, res) => {
    try {
      const user = await User.findById(req.params.id, '-password');
      if (!user) return res.status(404).json({ success: false, error: 'User not found' });
      res.json({ success: true, user });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/users', async (req, res) => {
    try {
      const { username, password, role, name, email, extension, assignedExtensions, assignedRingGroups, assignedQueues, assignedIVRs } = req.body;
      if (!username || !password || !role) return res.status(400).json({ success: false, error: 'username, password, role required' });
      if (!['admin', 'supervisor', 'agent'].includes(role)) return res.status(400).json({ success: false, error: 'role must be admin, supervisor, or agent' });
      if (await User.findOne({ username })) return res.status(409).json({ success: false, error: 'Username already exists' });
      const hash = await bcrypt.hash(password, 10);
      const user = await User.create({
        username, password: hash, role, name, email, extension,
        assignedExtensions: assignedExtensions || [],
        assignedRingGroups: assignedRingGroups || [],
        assignedQueues: assignedQueues || [],
        assignedIVRs: assignedIVRs || []
      });
      logger.info(`User created: ${username} (${role})`);
      res.status(201).json({ success: true, user: { _id: user._id, username, role, name, email, extension } });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/users/:id', async (req, res) => {
    try {
      const identifier = req.params.id;
      const updates = {};
      ['name', 'email', 'role', 'extension', 'enabled', 'assignedExtensions', 'assignedRingGroups', 'assignedQueues', 'assignedIVRs'].forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      });
      if (req.body.password) {
        updates.password = await bcrypt.hash(req.body.password, 10);
      }
      // Protect admin from being disabled or role-changed
      if (identifier === 'admin' && (updates.enabled === false || (updates.role && updates.role !== 'admin'))) {
        return res.status(403).json({ success: false, error: 'Cannot disable or change role of the admin account' });
      }
      // Try by username first, then by _id
      let user = await User.findOneAndUpdate({ username: identifier }, updates, { new: true, select: '-password' });
      if (!user && identifier.match(/^[0-9a-f]{24}$/i)) {
        user = await User.findByIdAndUpdate(identifier, updates, { new: true, select: '-password' });
      }
      if (!user) return res.status(404).json({ success: false, error: 'User not found' });
      res.json({ success: true, user });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/users/:id', async (req, res) => {
    try {
      const identifier = req.params.id;
      // Protect the default admin account
      if (identifier === 'admin') {
        return res.status(403).json({ success: false, error: 'Cannot delete the admin account' });
      }
      // Try by username first, then by _id
      let user = await User.findOneAndDelete({ username: identifier });
      if (!user && identifier.match(/^[0-9a-f]{24}$/i)) {
        user = await User.findByIdAndDelete(identifier);
      }
      if (!user) return res.status(404).json({ success: false, error: 'User not found' });
      res.json({ success: true, message: `User ${user.username} deleted` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Call Notes + Disposition
  // ============================================================

  // Add note to a call
  router.post('/cdr/:callId/notes', async (req, res) => {
    try {
      const { text, author, authorRole } = req.body;
      if (!text || !author) return res.status(400).json({ success: false, error: 'text, author required' });
      const cdr = await CDR.findOne({ callId: req.params.callId });
      if (!cdr) return res.status(404).json({ success: false, error: 'Call not found' });
      cdr.notes.push({ text, author, authorRole: authorRole || '', createdAt: new Date() });
      await cdr.save();
      res.json({ success: true, notes: cdr.notes });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Get notes for a call
  router.get('/cdr/:callId/notes', async (req, res) => {
    try {
      const cdr = await CDR.findOne({ callId: req.params.callId });
      if (!cdr) return res.status(404).json({ success: false, error: 'Call not found' });
      res.json({ success: true, notes: cdr.notes || [], disposition: cdr.disposition || '' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Set call disposition
  router.post('/cdr/:callId/disposition', async (req, res) => {
    try {
      const { disposition } = req.body;
      const cdr = await CDR.findOne({ callId: req.params.callId });
      if (!cdr) return res.status(404).json({ success: false, error: 'Call not found' });
      cdr.disposition = disposition || '';
      await cdr.save();
      res.json({ success: true, disposition: cdr.disposition });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Chat
  // ============================================================
  const { ChatMessage } = require('../models');

  // Get conversations list (unique chat partners with last message + unread count)
  router.get('/chat/conversations/:username', async (req, res) => {
    try {
      const me = req.params.username;
      const msgs = await ChatMessage.aggregate([
        { $match: { $or: [{ from: me }, { to: me }] } },
        { $sort: { createdAt: -1 } },
        { $group: {
          _id: { $cond: [{ $eq: ['$from', me] }, '$to', '$from'] },
          lastMessage: { $first: '$text' },
          lastTime: { $first: '$createdAt' },
          unread: { $sum: { $cond: [{ $and: [{ $eq: ['$to', me] }, { $eq: ['$read', false] }] }, 1, 0] } }
        }},
        { $sort: { lastTime: -1 } }
      ]);
      // Enrich with user info
      const usernames = msgs.map(m => m._id);
      const users = await User.find({ username: { $in: usernames } }, 'username name role').lean();
      const userMap = {};
      users.forEach(u => { userMap[u.username] = u; });
      const conversations = msgs.map(m => ({
        username: m._id,
        name: userMap[m._id] ? userMap[m._id].name : m._id,
        role: userMap[m._id] ? userMap[m._id].role : '',
        lastMessage: m.lastMessage,
        lastTime: m.lastTime,
        unread: m.unread
      }));
      res.json({ success: true, conversations });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Get messages between two users
  router.get('/chat/messages/:user1/:user2', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const before = req.query.before ? new Date(req.query.before) : new Date();
      const msgs = await ChatMessage.find({
        $or: [
          { from: req.params.user1, to: req.params.user2 },
          { from: req.params.user2, to: req.params.user1 }
        ],
        createdAt: { $lt: before }
      }).sort({ createdAt: -1 }).limit(limit).lean();
      res.json({ success: true, messages: msgs.reverse() });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Send a message (also used by Socket.IO fallback)
  router.post('/chat/send', async (req, res) => {
    try {
      const { from, to, text, fromRole } = req.body;
      if (!from || !to || !text) return res.status(400).json({ success: false, error: 'from, to, text required' });
      const msg = await ChatMessage.create({ from, to, text, fromRole: fromRole || '', read: false });
      res.json({ success: true, message: msg });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Mark messages as read
  router.post('/chat/read/:from/:to', async (req, res) => {
    try {
      await ChatMessage.updateMany(
        { from: req.params.from, to: req.params.to, read: false },
        { $set: { read: true, readAt: new Date() } }
      );
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Get total unread count for a user
  router.get('/chat/unread/:username', async (req, res) => {
    try {
      const count = await ChatMessage.countDocuments({ to: req.params.username, read: false });
      res.json({ success: true, unread: count });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Get contacts (users this person can chat with based on RBAC)
  router.get('/chat/contacts/:username', async (req, res) => {
    try {
      const me = await User.findOne({ username: req.params.username });
      if (!me) return res.json({ success: true, contacts: [] });
      let contacts;
      if (me.role === 'admin') {
        contacts = await User.find({ username: { $ne: me.username }, enabled: true }, 'username name role extension').lean();
      } else if (me.role === 'supervisor') {
        // Supervisor can chat with admins + agents in their assigned extensions
        const adminUsers = await User.find({ role: 'admin', enabled: true }, 'username name role extension').lean();
        const agentUsers = await User.find({
          role: 'agent', enabled: true,
          extension: { $in: me.assignedExtensions || [] }
        }, 'username name role extension').lean();
        const otherSupers = await User.find({ role: 'supervisor', username: { $ne: me.username }, enabled: true }, 'username name role extension').lean();
        contacts = [...adminUsers, ...otherSupers, ...agentUsers];
      } else {
        // Agent can chat with supervisors who manage their extension + admins
        const supervisors = await User.find({
          role: 'supervisor', enabled: true,
          assignedExtensions: me.extension
        }, 'username name role extension').lean();
        const adminUsers = await User.find({ role: 'admin', enabled: true }, 'username name role extension').lean();
        contacts = [...adminUsers, ...supervisors];
      }
      res.json({ success: true, contacts });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Allowed SIP Domains (external caller whitelist)
  // ============================================================
  const { SIPDomain } = require('../models');

  router.get('/sip-domains', async (req, res) => {
    try {
      const domains = await SIPDomain.find({}).sort('domain');
      res.json({ success: true, domains });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/sip-domains', async (req, res) => {
    try {
      const { domain, name, description } = req.body;
      if (!domain) return res.status(400).json({ success: false, error: 'domain or IP required' });
      const clean = domain.toLowerCase().trim();
      if (await SIPDomain.findOne({ domain: clean })) return res.status(409).json({ success: false, error: 'Entry already exists' });
      // Auto-detect type: if it looks like an IP address, mark as 'ip'
      const isIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean);
      const entryType = isIp ? 'ip' : 'domain';
      const d = await SIPDomain.create({ domain: clean, entryType, name: name || clean, description: description || '', enabled: true });
      logger.info(`SIP whitelist added: ${clean} (type=${entryType})`);
      res.status(201).json({ success: true, domain: d });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/sip-domains/:domain', async (req, res) => {
    try {
      const updates = {};
      ['name', 'description', 'enabled'].forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
      const d = await SIPDomain.findOneAndUpdate({ domain: req.params.domain }, updates, { new: true });
      if (!d) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, domain: d });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/sip-domains/:domain', async (req, res) => {
    try {
      const d = await SIPDomain.findOneAndDelete({ domain: req.params.domain });
      if (!d) return res.status(404).json({ success: false, error: 'Not found' });
      logger.info(`SIP Domain removed: ${req.params.domain}`);
      res.json({ success: true, message: `Domain ${req.params.domain} removed` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Appointments
  // ============================================================
  const { Appointment, AppointmentMessage } = require('../models');

  router.get('/appointments', async (req, res) => {
    try {
      const appointments = await Appointment.find({}).sort('number');
      res.json({ success: true, appointments });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/appointments', async (req, res) => {
    try {
      const { number, name, greeting, destination, maxRecordingLength, enabled } = req.body;
      if (!number || !name || !destination || !destination.type || !destination.target) {
        return res.status(400).json({ success: false, error: 'number, name, destination (type+target) required' });
      }
      if (await Appointment.findOne({ number })) {
        return res.status(409).json({ success: false, error: 'Appointment number already exists' });
      }
      const appt = await Appointment.create({
        number, name, greeting: greeting || '',
        destination, maxRecordingLength: maxRecordingLength || 120,
        enabled: enabled !== false
      });
      logger.info(`Appointment ${number} (${name}) created -> ${destination.type}:${destination.target}`);
      res.status(201).json({ success: true, appointment: appt });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/appointments/:number', async (req, res) => {
    try {
      const updates = {};
      ['name', 'greeting', 'destination', 'maxRecordingLength', 'enabled'].forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      });
      const appt = await Appointment.findOneAndUpdate(
        { number: req.params.number }, updates, { new: true }
      );
      if (!appt) return res.status(404).json({ success: false, error: 'Not found' });
      logger.info(`Appointment ${req.params.number} updated`);
      res.json({ success: true, appointment: appt });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/appointments/:number', async (req, res) => {
    try {
      const appt = await Appointment.findOneAndDelete({ number: req.params.number });
      if (!appt) return res.status(404).json({ success: false, error: 'Not found' });
      logger.info(`Appointment ${req.params.number} deleted`);
      res.json({ success: true, message: `Appointment ${req.params.number} deleted` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Appointment messages (for viewing recorded messages + queue status)
  router.get('/appointments/:number/messages', async (req, res) => {
    try {
      const msgs = await AppointmentMessage.find({ appointmentNumber: req.params.number })
        .sort({ createdAt: -1 }).limit(50);
      res.json({ success: true, messages: msgs });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/appointments/queue/status', async (req, res) => {
    try {
      const status = appointmentHandler ? appointmentHandler.getQueueStatus() : { total: 0 };
      res.json({ success: true, queue: status });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Play appointment message audio
  router.get('/appointments/messages/:messageId/audio', async (req, res) => {
    try {
      const msg = await AppointmentMessage.findOne({ messageId: req.params.messageId });
      if (!msg || !msg.recordingPath) return res.status(404).json({ success: false, error: 'Message not found' });
      const fs = require('fs');
      if (!fs.existsSync(msg.recordingPath)) return res.status(404).json({ success: false, error: 'Audio file missing' });
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Disposition', `inline; filename="${require('path').basename(msg.recordingPath)}"`);
      fs.createReadStream(msg.recordingPath).pipe(res);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // Blocklist
  // ============================================================
  const { BlockedNumber } = require('../models');

  router.get('/blocklist', async (req, res) => {
    try {
      const numbers = await BlockedNumber.find({}).sort({ createdAt: -1 });
      res.json({ success: true, blocked: numbers });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/blocklist', async (req, res) => {
    try {
      const { number, reason, blockedBy } = req.body;
      if (!number) return res.status(400).json({ success: false, error: 'number required' });
      const clean = number.replace(/[^0-9+]/g, '');
      if (await BlockedNumber.findOne({ number: clean })) return res.status(409).json({ success: false, error: 'Number already blocked' });
      const blocked = await BlockedNumber.create({ number: clean, reason: reason || '', blockedBy: blockedBy || '' });
      logger.info(`Blocklist: ${clean} blocked (by ${blockedBy || 'admin'}, reason: ${reason || 'none'})`);
      res.status(201).json({ success: true, blocked });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/blocklist/:number', async (req, res) => {
    try {
      const result = await BlockedNumber.findOneAndDelete({ number: req.params.number });
      if (!result) return res.status(404).json({ success: false, error: 'Not found' });
      logger.info(`Blocklist: ${req.params.number} unblocked`);
      res.json({ success: true, message: `${req.params.number} unblocked` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Check if a number is blocked
  router.get('/blocklist/check/:number', async (req, res) => {
    try {
      const blocked = await BlockedNumber.findOne({ number: req.params.number });
      res.json({ success: true, blocked: !!blocked, details: blocked || null });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
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

  // ============================================================
  // Campaigns (Dialer)
  // ============================================================
  const { Campaign, Lead, DNC } = require('../models');
  const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  // Campaign CRUD
  router.get('/campaigns', async (req, res) => {
    try {
      const campaigns = await Campaign.find({}).sort({ createdAt: -1 });
      res.json({ success: true, campaigns });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/campaigns/:id', async (req, res) => {
    try {
      const c = await Campaign.findById(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Not found' });
      const liveStatus = dialerEngine ? dialerEngine.getCampaignStatus(req.params.id) : {};
      res.json({ success: true, campaign: c, live: liveStatus });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/campaigns', async (req, res) => {
    try {
      const { name, strategy, outboundRoute, trunk, callerId, carrier, agents, maxConcurrent, ringTimeout,
              wrapUpTime, retryAttempts, retryDelay, amd, amdAction, schedule,
              dialRatio, maxAbandoned, dncEnabled } = req.body;
      if (!name || !callerId) {
        return res.status(400).json({ success: false, error: 'name and callerId required' });
      }
      if (!outboundRoute && !trunk) {
        return res.status(400).json({ success: false, error: 'outbound route required' });
      }
      const c = await Campaign.create({
        name, strategy: strategy || 'auto',
        outboundRoute: outboundRoute || '', trunk: trunk || '',
        callerId, carrier: carrier || '',
        agents: agents || [], maxConcurrent: maxConcurrent || 10,
        ringTimeout: ringTimeout || 30, wrapUpTime: wrapUpTime || 10,
        retryAttempts: retryAttempts || 3, retryDelay: retryDelay || 30,
        amd: amd || false, amdAction: amdAction || 'hangup',
        schedule: schedule || {}, dialRatio: dialRatio || 1.2,
        maxAbandoned: maxAbandoned || 3, dncEnabled: dncEnabled !== false
      });
      logger.info(`Campaign created: ${name} (${c._id})`);
      res.status(201).json({ success: true, campaign: c });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.put('/campaigns/:id', async (req, res) => {
    try {
      const updates = {};
      ['name', 'strategy', 'outboundRoute', 'trunk', 'callerId', 'carrier', 'agents', 'maxConcurrent', 'ringTimeout',
       'wrapUpTime', 'retryAttempts', 'retryDelay', 'amd', 'amdAction', 'schedule',
       'dialRatio', 'maxAbandoned', 'dncEnabled', 'enabled'].forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      });
      const c = await Campaign.findByIdAndUpdate(req.params.id, updates, { new: true });
      if (!c) return res.status(404).json({ success: false, error: 'Not found' });
      res.json({ success: true, campaign: c });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/campaigns/:id', async (req, res) => {
    try {
      const c = await Campaign.findById(req.params.id);
      if (!c) return res.status(404).json({ success: false, error: 'Not found' });
      if (c.status === 'running') return res.status(400).json({ success: false, error: 'Stop campaign before deleting' });
      await Lead.deleteMany({ campaignId: c._id });
      await Campaign.findByIdAndDelete(req.params.id);
      logger.info(`Campaign deleted: ${c.name} (${c._id})`);
      res.json({ success: true, message: 'Campaign and leads deleted' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Campaign controls
  router.post('/campaigns/:id/start', async (req, res) => {
    try {
      const c = await dialerEngine.startCampaign(req.params.id);
      res.json({ success: true, campaign: c });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  router.post('/campaigns/:id/pause', async (req, res) => {
    try {
      const c = await dialerEngine.pauseCampaign(req.params.id);
      res.json({ success: true, campaign: c });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  router.post('/campaigns/:id/stop', async (req, res) => {
    try {
      const c = await dialerEngine.stopCampaign(req.params.id);
      res.json({ success: true, campaign: c });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Campaign live status
  router.get('/campaigns/:id/live', async (req, res) => {
    try {
      const status = dialerEngine ? dialerEngine.getCampaignStatus(req.params.id) : {};
      res.json({ success: true, live: status });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Agent controls
  router.post('/campaigns/:id/agents/:ext/login', async (req, res) => {
    try { dialerEngine.agentLogin(req.params.id, req.params.ext); res.json({ success: true }); }
    catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
  router.post('/campaigns/:id/agents/:ext/logout', async (req, res) => {
    try { dialerEngine.agentLogout(req.params.id, req.params.ext); res.json({ success: true }); }
    catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
  router.post('/campaigns/:id/agents/:ext/pause', async (req, res) => {
    try { dialerEngine.agentPause(req.params.id, req.params.ext); res.json({ success: true }); }
    catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });
  router.post('/campaigns/:id/agents/:ext/unpause', async (req, res) => {
    try { dialerEngine.agentUnpause(req.params.id, req.params.ext); res.json({ success: true }); }
    catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // CSV Import
  router.post('/campaigns/:id/import', csvUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'CSV file required' });
      const csvContent = req.file.buffer.toString('utf-8');
      const mapping = req.body.mapping ? JSON.parse(req.body.mapping) : null;
      const result = await dialerEngine.importCSV(req.params.id, csvContent, mapping);
      res.json({ success: true, import: result });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // Leads
  router.get('/campaigns/:id/leads', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const status = req.query.status || '';
      const filter = { campaignId: req.params.id };
      if (status) filter.status = status;

      const [leads, total] = await Promise.all([
        Lead.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
        Lead.countDocuments(filter)
      ]);

      // Status summary
      const statusCounts = await Lead.aggregate([
        { $match: { campaignId: require('mongoose').Types.ObjectId.createFromHexString(req.params.id) } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ]);
      const summary = {};
      statusCounts.forEach(s => { summary[s._id] = s.count; });

      res.json({ success: true, leads, total, page, limit, summary });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Update lead disposition
  router.put('/campaigns/:campaignId/leads/:leadId', async (req, res) => {
    try {
      const updates = {};
      ['disposition', 'callbackTime', 'status'].forEach(k => {
        if (req.body[k] !== undefined) updates[k] = req.body[k];
      });
      if (req.body.disposition === 'callback' && req.body.callbackTime) {
        updates.status = 'scheduled';
        updates.nextAttempt = new Date(req.body.callbackTime);
      }
      if (req.body.disposition === 'dnc') {
        updates.status = 'dnc';
        // Also add to DNC list
        const lead = await Lead.findById(req.params.leadId);
        if (lead) {
          await DNC.findOneAndUpdate(
            { phone: lead.phone },
            { phone: lead.phone, reason: 'Agent marked DNC', source: 'agent', addedBy: req.body.agent || '' },
            { upsert: true }
          );
        }
      }
      const lead = await Lead.findByIdAndUpdate(req.params.leadId, updates, { new: true });
      if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
      res.json({ success: true, lead });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Running campaigns summary
  router.get('/dialer/running', async (req, res) => {
    try {
      const running = dialerEngine ? dialerEngine.getRunningCampaigns() : [];
      res.json({ success: true, campaigns: running });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // DNC (Do Not Call) List
  // ============================================================
  router.get('/dnc', async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const [items, total] = await Promise.all([
        DNC.find({}).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
        DNC.countDocuments()
      ]);
      res.json({ success: true, dnc: items, total, page, limit });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/dnc', async (req, res) => {
    try {
      const { phone, reason, source, addedBy } = req.body;
      if (!phone) return res.status(400).json({ success: false, error: 'phone required' });
      const clean = phone.replace(/[^\d]/g, '');
      if (await DNC.findOne({ phone: clean })) return res.status(409).json({ success: false, error: 'Already on DNC list' });
      const d = await DNC.create({ phone: clean, reason: reason || '', source: source || 'admin', addedBy: addedBy || '' });
      logger.info(`DNC added: ${clean}`);
      res.status(201).json({ success: true, dnc: d });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.delete('/dnc/:phone', async (req, res) => {
    try {
      const d = await DNC.findOneAndDelete({ phone: req.params.phone });
      if (!d) return res.status(404).json({ success: false, error: 'Not found' });
      logger.info(`DNC removed: ${req.params.phone}`);
      res.json({ success: true, message: 'Removed from DNC' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.get('/dnc/check/:phone', async (req, res) => {
    try {
      const d = await DNC.findOne({ phone: req.params.phone.replace(/[^\d]/g, '') });
      res.json({ success: true, isDnc: !!d, details: d || null });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // DNC CSV import
  router.post('/dnc/import', csvUpload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, error: 'CSV file required' });
      const lines = req.file.buffer.toString('utf-8').split(/\r?\n/).filter(l => l.trim());
      let imported = 0, duplicates = 0, invalid = 0;
      for (let i = 1; i < lines.length; i++) {
        const phone = lines[i].split(',')[0].trim().replace(/[^\d]/g, '');
        if (!phone || phone.length < 7) { invalid++; continue; }
        try {
          await DNC.create({ phone, reason: 'CSV import', source: 'import' });
          imported++;
        } catch (e) { duplicates++; }
      }
      res.json({ success: true, imported, duplicates, invalid, total: lines.length - 1 });
    } catch (err) { res.status(400).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // CRM Integration API
  // ============================================================
  const { CrmConfig } = require('../models');
  const crmManager = require('../services/crm-manager');
  const crmCrypto = require('../services/crm/crypto');
  const FieldMapper = require('../services/crm/field-mapper');

  // List all CRM connections
  router.get('/crm', requireRole('admin'), async (req, res) => {
    try {
      const configs = await CrmConfig.find().sort({ createdAt: -1 });
      // Strip encrypted credentials for the response
      const safe = configs.map(c => {
        const obj = c.toObject();
        obj.credentials = c.credentials ? '(encrypted)' : '';
        obj.oauthTokens = c.oauthTokens ? '(encrypted)' : '';
        return obj;
      });
      res.json(safe);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Get CRM adapter statuses (live from manager)
  router.get('/crm/status', requireRole('admin'), async (req, res) => {
    try {
      res.json(crmManager.getStatus());
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Get available providers and default field mappings
  router.get('/crm/providers', requireRole('admin'), (req, res) => {
    const providers = FieldMapper.getProviders().map(p => ({
      id: p,
      name: p.charAt(0).toUpperCase() + p.slice(1),
      defaultMapping: FieldMapper.getDefaults(p),
    }));
    res.json(providers);
  });

  // Add new CRM connection
  router.post('/crm', requireRole('admin'), async (req, res) => {
    try {
      const { provider, name, authType, credentials, instanceUrl, webhookUrl,
              fieldMapping, syncOptions, scope } = req.body;

      if (!provider || !name || !authType) {
        return res.status(400).json({ error: 'provider, name, and authType are required' });
      }

      // Encrypt credentials
      let encryptedCreds = '';
      if (credentials && typeof credentials === 'object' && Object.keys(credentials).length > 0) {
        encryptedCreds = crmCrypto.encryptObject(credentials);
      }

      const config = new CrmConfig({
        provider, name, authType,
        credentials: encryptedCreds,
        instanceUrl: instanceUrl || '',
        webhookUrl: webhookUrl || '',
        fieldMapping: fieldMapping || {},
        syncOptions: syncOptions || {},
        scope: scope || { allExtensions: true },
      });

      await config.save();

      // Load the adapter immediately if enabled
      if (config.enabled) {
        try {
          await crmManager.addConnection(config._id.toString());
        } catch (e) {
          logger.warn(`CRM add: adapter load failed: ${e.message}`);
        }
      }

      res.json({ success: true, id: config._id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Update CRM connection
  router.put('/crm/:id', requireRole('admin'), async (req, res) => {
    try {
      const config = await CrmConfig.findById(req.params.id);
      if (!config) return res.status(404).json({ error: 'CRM config not found' });

      const { name, enabled, authType, credentials, instanceUrl, webhookUrl,
              fieldMapping, syncOptions, scope } = req.body;

      if (name !== undefined) config.name = name;
      if (enabled !== undefined) config.enabled = enabled;
      if (authType !== undefined) config.authType = authType;
      if (instanceUrl !== undefined) config.instanceUrl = instanceUrl;
      if (webhookUrl !== undefined) config.webhookUrl = webhookUrl;
      if (fieldMapping !== undefined) config.fieldMapping = fieldMapping;
      if (syncOptions !== undefined) config.syncOptions = syncOptions;
      if (scope !== undefined) config.scope = scope;

      // Re-encrypt credentials if provided
      if (credentials && typeof credentials === 'object' && Object.keys(credentials).length > 0) {
        config.credentials = crmCrypto.encryptObject(credentials);
      }

      config.updatedAt = new Date();
      await config.save();

      // Reload the adapter
      try {
        if (config.enabled) {
          await crmManager.reloadConnection(config._id.toString());
        } else {
          await crmManager.removeConnection(config._id.toString());
        }
      } catch (e) {
        logger.warn(`CRM update: adapter reload failed: ${e.message}`);
      }

      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Delete CRM connection
  router.delete('/crm/:id', requireRole('admin'), async (req, res) => {
    try {
      await crmManager.removeConnection(req.params.id);
      await CrmConfig.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Test CRM connection
  router.post('/crm/:id/test', requireRole('admin'), async (req, res) => {
    try {
      const entry = crmManager.adapters.get(req.params.id);
      if (!entry) {
        return res.status(400).json({ ok: false, message: 'Adapter not loaded — enable the connection first' });
      }
      const result = await entry.adapter.testConnection();
      res.json(result);
    } catch (err) { res.status(500).json({ ok: false, message: err.message }); }
  });

  // Search contact across all CRMs (for testing / manual screen pop)
  router.get('/crm/search/:phone', requireRole('admin', 'supervisor'), async (req, res) => {
    try {
      const results = await crmManager.searchContactAll(req.params.phone);
      res.json(results);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Get active screen pops
  router.get('/crm/screenpops', requireRole('admin', 'supervisor'), (req, res) => {
    try {
      if (callHandler.screenPopHandler) {
        res.json(callHandler.screenPopHandler.getActiveScreenPops());
      } else {
        res.json([]);
      }
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── OAuth 2.0 Endpoints ──
  const oauthManager = require('../services/crm/oauth');

  // Generate OAuth authorize URL (admin clicks "Connect [CRM]")
  router.post('/crm/:id/oauth/authorize', requireRole('admin'), async (req, res) => {
    try {
      const config = await CrmConfig.findById(req.params.id);
      if (!config) return res.status(404).json({ error: 'CRM config not found' });

      if (config.authType !== 'oauth2') {
        return res.status(400).json({ error: 'This CRM does not use OAuth 2.0' });
      }

      // Decrypt credentials to get clientId
      let credentials = {};
      if (config.credentials) {
        credentials = crmCrypto.decryptObject(config.credentials);
      }

      const options = req.body || {};  // { scopes, zohoRegion }
      const authorizeUrl = oauthManager.generateAuthorizeUrl(
        config._id.toString(), config.provider, credentials, options
      );

      res.json({ success: true, authorizeUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Get OAuth token status for a CRM connection
  router.get('/crm/:id/oauth/status', requireRole('admin'), async (req, res) => {
    try {
      const status = await oauthManager.getTokenStatus(req.params.id);
      res.json(status);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Force token refresh
  router.post('/crm/:id/oauth/refresh', requireRole('admin'), async (req, res) => {
    try {
      await oauthManager.refreshToken(req.params.id);
      res.json({ success: true, message: 'Token refreshed successfully' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Revoke OAuth tokens (disconnect)
  router.post('/crm/:id/oauth/revoke', requireRole('admin'), async (req, res) => {
    try {
      await oauthManager.revokeTokens(req.params.id);

      // Disconnect the adapter
      await crmManager.removeConnection(req.params.id);

      res.json({ success: true, message: 'OAuth tokens revoked' });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // Get OAuth provider configs (for admin UI dropdown)
  router.get('/crm/oauth/providers', requireRole('admin'), (req, res) => {
    const providers = oauthManager.getOAuthProviders().map(p => ({
      id: p,
      name: p.charAt(0).toUpperCase() + p.slice(1),
      config: oauthManager.getProviderConfig(p),
    }));
    res.json(providers);
  });

  // ============================================================
  // Settings, Backup & Maintenance routes
  // ============================================================
  const registerSettingsRoutes = require('./settings-api');
  registerSettingsRoutes(router);

  return router;
}

module.exports = createApiRouter;
