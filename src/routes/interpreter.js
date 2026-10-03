'use strict';
//
// Real-time voice interpreter — configuration surface.
//
// This is the control layer only: which providers are configured, the system
// defaults, and each agent's preference. It decides WHETHER a call should be
// translated; the media pipeline that does the translating is separate.
//
// Admin endpoints report whether each provider key is present — never the key
// itself, so the settings page can show a green/red status without leaking a
// credential into a browser.
//
const express = require('express');
const logger = require('../utils/logger');

// Providers the interpreter needs, and the env var each one reads.
const PROVIDERS = [
  { id: 'deepgram', env: 'DEEPGRAM_API_KEY', label: 'Deepgram', role: 'Speech-to-text + text-to-speech', required: true,
    url: 'https://console.deepgram.com' },
  { id: 'deepl', env: 'DEEPL_API_KEY', label: 'DeepL', role: 'Translation', required: true,
    url: 'https://www.deepl.com/pro-api' },
  { id: 'groq', env: 'GROQ_API_KEY', label: 'Groq Whisper', role: 'Post-call transcripts (optional)', required: false,
    url: 'https://console.groq.com' },
  { id: 'google', env: 'GOOGLE_TRANSLATE_KEY', label: 'Google Translate', role: 'Fallback translation (optional)', required: false,
    url: 'https://console.cloud.google.com' }
];

// Language pairs the interpreter supports today.
const LANGUAGES = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'hi', label: 'Hindi' }
];

function providerStatus() {
  return PROVIDERS.map(p => {
    const v = process.env[p.env];
    const set = !!(v && String(v).trim());
    return {
      id: p.id, label: p.label, role: p.role, env: p.env,
      required: p.required, url: p.url,
      configured: set,
      // A hint only — enough to confirm the right key is in place, never the key.
      hint: set ? ('…' + String(v).trim().slice(-4)) : null
    };
  });
}

function readiness(status) {
  const missing = status.filter(p => p.required && !p.configured).map(p => p.label);
  return { ready: missing.length === 0, missing };
}

function createInterpreterRouter({ models }) {
  const router = express.Router();
  const web = require('./web');
  const auth = web.authMiddleware;
  const admin = web.adminOnly;
  const { SystemSettings, Extension } = models;

  async function settings() {
    let s = await SystemSettings.findById('system');
    if (!s) s = await SystemSettings.create({ _id: 'system' });
    return s;
  }
  const defaults = {
    enabled: false, defaultOn: false, agentMayToggle: true,
    customerLanguage: 'auto', agentLanguage: 'en',
    sttProvider: 'deepgram', translateProvider: 'deepl', ttsProvider: 'deepgram'
  };

  // ── Admin: provider keys + system defaults ──
  router.get('/interpreter/config', auth, admin, async (req, res) => {
    try {
      const s = await settings();
      const status = providerStatus();
      res.json({
        success: true,
        providers: status,
        readiness: readiness(status),
        languages: LANGUAGES,
        settings: Object.assign({}, defaults, (s.interpreter || {}).toObject ? s.interpreter.toObject() : s.interpreter)
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/interpreter/config', auth, admin, async (req, res) => {
    try {
      const b = req.body || {};
      const s = await settings();
      const cur = Object.assign({}, defaults, (s.interpreter || {}).toObject ? s.interpreter.toObject() : s.interpreter);
      ['enabled', 'defaultOn', 'agentMayToggle'].forEach(k => {
        if (b[k] !== undefined) cur[k] = !!b[k];
      });
      ['customerLanguage', 'agentLanguage'].forEach(k => {
        if (b[k] !== undefined) cur[k] = String(b[k] || '').trim() || defaults[k];
      });
      s.interpreter = cur;
      s.updatedAt = new Date();
      await s.save();
      logger.info(`INTERPRETER: settings updated by ${req.session && req.session.user} (enabled=${cur.enabled} defaultOn=${cur.defaultOn})`);
      res.json({ success: true, settings: cur });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ── Agent: read / set their own preference ──
  // An agent may only touch their OWN extension; admins and supervisors may set
  // any. The server decides from the session, never from the request body.
  function targetExt(req) {
    const role = req.session ? req.session.role : '';
    const mine = req.session ? String(req.session.extension || '') : '';
    const asked = String((req.body && req.body.extension) || req.query.extension || '').trim();
    if (role === 'admin' || role === 'supervisor') return asked || mine;
    return mine;
  }

  router.get('/interpreter/me', auth, async (req, res) => {
    try {
      const s = await settings();
      const sys = Object.assign({}, defaults, (s.interpreter || {}).toObject ? s.interpreter.toObject() : s.interpreter);
      const ext = targetExt(req);
      const row = ext ? await Extension.findOne({ extension: ext }, 'extension name translation') : null;
      const pref = (row && row.translation) || { mode: 'default', agentLanguage: '', spokenLanguages: [] };
      const mode = pref.mode || 'default';
      res.json({
        success: true,
        extension: ext || null,
        languages: LANGUAGES,
        system: { enabled: sys.enabled, defaultOn: sys.defaultOn, agentMayToggle: sys.agentMayToggle, agentLanguage: sys.agentLanguage, customerLanguage: sys.customerLanguage },
        preference: { mode, agentLanguage: pref.agentLanguage || '', spokenLanguages: pref.spokenLanguages || [] },
        // What will actually happen on the next call, after all the rules.
        effective: effectiveFor(sys, mode)
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  router.post('/interpreter/me', auth, async (req, res) => {
    try {
      const s = await settings();
      const sys = Object.assign({}, defaults, (s.interpreter || {}).toObject ? s.interpreter.toObject() : s.interpreter);
      const role = req.session ? req.session.role : '';
      if (!sys.agentMayToggle && role === 'agent') {
        return res.status(403).json({ success: false, error: 'Translation is locked by your administrator' });
      }
      const ext = targetExt(req);
      if (!ext) return res.status(400).json({ success: false, error: 'No extension assigned to your account' });

      const b = req.body || {};
      const row = await Extension.findOne({ extension: ext });
      if (!row) return res.status(404).json({ success: false, error: 'Extension not found' });

      const pref = row.translation || {};
      if (b.mode !== undefined) {
        const m = String(b.mode);
        if (['default', 'on', 'off'].indexOf(m) === -1) return res.status(400).json({ success: false, error: 'mode must be default, on or off' });
        pref.mode = m;
      }
      if (b.agentLanguage !== undefined) pref.agentLanguage = String(b.agentLanguage || '').trim();
      if (b.spokenLanguages !== undefined) {
        pref.spokenLanguages = Array.isArray(b.spokenLanguages)
          ? b.spokenLanguages.map(String)
          : String(b.spokenLanguages).split(',').map(x => x.trim()).filter(Boolean);
      }
      row.translation = pref;
      row.updatedAt = new Date();
      await row.save();
      logger.info(`INTERPRETER: ${ext} translation mode=${pref.mode} by ${req.session && req.session.user}`);
      res.json({ success: true, extension: ext, preference: pref, effective: effectiveFor(sys, pref.mode) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  return router;
}

// Resolve what a call will actually do: the master switch wins, then the
// agent's explicit choice, then the system default.
function effectiveFor(sys, mode) {
  if (!sys.enabled) return { translate: false, reason: 'Interpreter is switched off system-wide' };
  if (mode === 'on') return { translate: true, reason: 'Always on for this extension' };
  if (mode === 'off') return { translate: false, reason: 'Turned off for this extension' };
  return sys.defaultOn
    ? { translate: true, reason: 'System default is on' }
    : { translate: false, reason: 'System default is off' };
}

module.exports = { createInterpreterRouter, PROVIDERS, LANGUAGES, providerStatus, readiness, effectiveFor };
