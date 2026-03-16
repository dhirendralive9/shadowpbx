const express = require('express');
const { Extension, CDR } = require('../models');
const logger = require('../utils/logger');

function createApiRouter(registrar, callHandler) {
  const router = express.Router();

  // ============================================================
  // Extensions CRUD
  // ============================================================

  // List all extensions
  router.get('/extensions', async (req, res) => {
    try {
      const extensions = await Extension.find({}, '-password').sort('extension');
      const result = extensions.map(ext => ({
        extension: ext.extension,
        name: ext.name,
        email: ext.email,
        enabled: ext.enabled,
        registered: ext.isRegistered(),
        contacts: ext.getActiveContacts().map(c => ({
          ip: c.ip,
          port: c.port,
          userAgent: c.userAgent,
          expires: c.expires
        })),
        createdAt: ext.createdAt
      }));
      res.json({ success: true, extensions: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get single extension
  router.get('/extensions/:ext', async (req, res) => {
    try {
      const ext = await Extension.findOne({ extension: req.params.ext }, '-password');
      if (!ext) return res.status(404).json({ success: false, error: 'Extension not found' });
      res.json({ success: true, extension: ext });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Create extension
  router.post('/extensions', async (req, res) => {
    try {
      const { extension, name, password, email } = req.body;
      if (!extension || !name || !password) {
        return res.status(400).json({
          success: false,
          error: 'extension, name, and password are required'
        });
      }

      const existing = await Extension.findOne({ extension });
      if (existing) {
        return res.status(409).json({ success: false, error: 'Extension already exists' });
      }

      const ext = new Extension({ extension, name, password, email });
      await ext.save();

      logger.info(`Extension ${extension} (${name}) created`);
      res.status(201).json({ success: true, extension: { extension, name, email } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Update extension
  router.put('/extensions/:ext', async (req, res) => {
    try {
      const updates = {};
      if (req.body.name) updates.name = req.body.name;
      if (req.body.password) updates.password = req.body.password;
      if (req.body.email) updates.email = req.body.email;
      if (req.body.enabled !== undefined) updates.enabled = req.body.enabled;
      updates.updatedAt = new Date();

      const ext = await Extension.findOneAndUpdate(
        { extension: req.params.ext },
        updates,
        { new: true, select: '-password' }
      );
      if (!ext) return res.status(404).json({ success: false, error: 'Extension not found' });

      logger.info(`Extension ${req.params.ext} updated`);
      res.json({ success: true, extension: ext });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Delete extension
  router.delete('/extensions/:ext', async (req, res) => {
    try {
      const ext = await Extension.findOneAndDelete({ extension: req.params.ext });
      if (!ext) return res.status(404).json({ success: false, error: 'Extension not found' });

      logger.info(`Extension ${req.params.ext} deleted`);
      res.json({ success: true, message: `Extension ${req.params.ext} deleted` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Bulk create extensions
  router.post('/extensions/bulk', async (req, res) => {
    try {
      const { extensions } = req.body; // [{extension, name, password, email}]
      if (!Array.isArray(extensions)) {
        return res.status(400).json({ success: false, error: 'extensions array required' });
      }

      const results = [];
      for (const ext of extensions) {
        try {
          const existing = await Extension.findOne({ extension: ext.extension });
          if (existing) {
            results.push({ extension: ext.extension, status: 'exists' });
            continue;
          }
          await Extension.create(ext);
          results.push({ extension: ext.extension, status: 'created' });
        } catch (err) {
          results.push({ extension: ext.extension, status: 'error', error: err.message });
        }
      }

      res.json({ success: true, results });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // Call Detail Records
  // ============================================================

  // Get recent calls
  router.get('/cdr', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 50;
      const page = parseInt(req.query.page) || 1;
      const skip = (page - 1) * limit;

      const filter = {};
      if (req.query.extension) {
        filter.$or = [
          { from: req.query.extension },
          { to: req.query.extension }
        ];
      }
      if (req.query.status) filter.status = req.query.status;
      if (req.query.from) filter.startTime = { $gte: new Date(req.query.from) };
      if (req.query.to) {
        filter.startTime = filter.startTime || {};
        filter.startTime.$lte = new Date(req.query.to);
      }

      const [records, total] = await Promise.all([
        CDR.find(filter).sort({ startTime: -1 }).skip(skip).limit(limit),
        CDR.countDocuments(filter)
      ]);

      res.json({
        success: true,
        cdr: records,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get call stats
  router.get('/stats', async (req, res) => {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [
        totalCalls,
        todayCalls,
        activeCalls,
        totalExtensions,
        registeredCount
      ] = await Promise.all([
        CDR.countDocuments(),
        CDR.countDocuments({ startTime: { $gte: today } }),
        callHandler.getActiveCalls(),
        Extension.countDocuments(),
        Extension.countDocuments({
          'registrations.0': { $exists: true },
          'registrations.expires': { $gt: new Date() }
        })
      ]);

      const avgDuration = await CDR.aggregate([
        { $match: { status: 'completed', talkTime: { $gt: 0 } } },
        { $group: { _id: null, avg: { $avg: '$talkTime' } } }
      ]);

      res.json({
        success: true,
        stats: {
          totalCalls,
          todayCalls,
          activeCalls: activeCalls.length,
          activeCallDetails: activeCalls,
          totalExtensions,
          registeredExtensions: registeredCount,
          avgCallDuration: avgDuration[0]?.avg?.toFixed(1) || 0
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ============================================================
  // System
  // ============================================================

  router.get('/health', (req, res) => {
    res.json({
      success: true,
      service: 'ShadowPBX',
      version: '1.0.0',
      uptime: process.uptime(),
      timestamp: new Date()
    });
  });

  return router;
}

module.exports = createApiRouter;
