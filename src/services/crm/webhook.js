const https = require('https');
const http = require('http');
const logger = require('../../utils/logger');
const BaseCrmAdapter = require('./base-adapter');

// ============================================================
// Webhook / Generic REST Adapter
//
// For CRMs not directly supported, this adapter sends HTTP POST
// requests to a configured URL whenever call events occur.
// The payload is a standardized JSON object any system can consume.
//
// Also supports:
//   - Reverse lookup (screen pop) via configurable GET endpoint
//   - Call logging via POST to a logging endpoint
//   - Retry on failure: 3 attempts with exponential backoff
//
// Works with: n8n, Zapier, Make.com, custom middleware, any REST API
// ============================================================

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 5000, 15000];  // 1s, 5s, 15s

class WebhookAdapter extends BaseCrmAdapter {
  constructor(config) {
    super(config);
    this.webhookUrl = config.webhookUrl || '';
    this.searchUrl = config.credentials?.searchUrl || '';    // GET {searchUrl}?phone={number}
    this.logUrl = config.credentials?.logUrl || '';          // POST call summary
    this.authHeader = config.credentials?.authHeader || '';  // e.g. 'Bearer xxx' or 'Token xxx'
    this.authHeaderName = config.credentials?.authHeaderName || 'Authorization';
  }

  // ──────────────────────────────────────────────────────────
  // Connection
  // ──────────────────────────────────────────────────────────

  async connect() {
    if (!this.webhookUrl) {
      logger.warn(`CRM [${this.name}]: no webhook URL configured`);
      this.connected = false;
      return false;
    }
    this.connected = true;
    logger.info(`CRM [${this.name}]: webhook adapter ready → ${this.webhookUrl}`);
    return true;
  }

  async testConnection() {
    if (!this.webhookUrl) {
      return { ok: false, message: 'No webhook URL configured' };
    }

    try {
      const payload = { event: 'test', timestamp: new Date().toISOString() };
      await this._post(this.webhookUrl, payload);
      this._apiSuccess();
      return { ok: true, message: 'Webhook test POST successful' };
    } catch (err) {
      this._apiError('testConnection', err);
      return { ok: false, message: err.message };
    }
  }

  // ──────────────────────────────────────────────────────────
  // Contact search (screen pop via reverse lookup)
  // ──────────────────────────────────────────────────────────

  async searchContact(phone) {
    if (!this.searchUrl) return null;

    try {
      const separator = this.searchUrl.includes('?') ? '&' : '?';
      const url = `${this.searchUrl}${separator}phone=${encodeURIComponent(phone)}`;
      const result = await this._get(url);
      this._apiSuccess();

      if (!result) return null;

      // Normalize — expect the remote to return { id, name, phone, email, company }
      // or an array (take first match)
      const contact = Array.isArray(result) ? result[0] : result;
      if (!contact || (!contact.name && !contact.phone)) return null;

      return {
        id: contact.id || null,
        name: contact.name || '',
        phone: contact.phone || phone,
        email: contact.email || '',
        company: contact.company || '',
        title: contact.title || '',
        crmUrl: contact.url || contact.crmUrl || null,
        raw: contact,
      };
    } catch (err) {
      this._apiError('searchContact', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Call logging
  // ──────────────────────────────────────────────────────────

  async logCall(callData) {
    const url = this.logUrl || this.webhookUrl;
    if (!url) return null;

    const payload = {
      event: 'call.completed',
      callId: callData.callId,
      from: callData.from,
      to: callData.to,
      direction: callData.direction,
      duration: callData.duration || 0,
      talkTime: callData.talkTime || 0,
      agent: callData.agent || '',
      disposition: callData.disposition || '',
      notes: callData.notes || '',
      recordingUrl: callData.recordingUrl || '',
      contactId: callData.contactId || '',
      startTime: callData.startTime,
      endTime: callData.endTime,
      timestamp: new Date().toISOString(),
    };

    try {
      const result = await this._postWithRetry(url, payload);
      this._apiSuccess();
      // Return whatever ID the remote gives us
      return result?.id || result?.activityId || callData.callId;
    } catch (err) {
      this._apiError('logCall', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Disposition sync
  // ──────────────────────────────────────────────────────────

  async syncDisposition(callId, disposition, extra) {
    if (!this.webhookUrl) return false;

    const payload = {
      event: 'call.disposition',
      callId,
      disposition,
      ...(extra || {}),
      timestamp: new Date().toISOString(),
    };

    try {
      await this._postWithRetry(this.webhookUrl, payload);
      this._apiSuccess();
      return true;
    } catch (err) {
      this._apiError('syncDisposition', err);
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Lead / contact creation (POST to webhook)
  // ──────────────────────────────────────────────────────────

  async createContact(data) {
    if (!this.webhookUrl) return null;

    const payload = {
      event: 'contact.create',
      name: data.name,
      phone: data.phone,
      email: data.email || '',
      company: data.company || '',
      timestamp: new Date().toISOString(),
    };

    try {
      const result = await this._postWithRetry(this.webhookUrl, payload);
      this._apiSuccess();
      return result?.id || null;
    } catch (err) {
      this._apiError('createContact', err);
      return null;
    }
  }

  async createLead(data) {
    if (!this.webhookUrl) return null;

    const payload = {
      event: 'lead.create',
      name: data.name,
      phone: data.phone,
      email: data.email || '',
      company: data.company || '',
      source: data.source || 'ShadowPBX',
      timestamp: new Date().toISOString(),
    };

    try {
      const result = await this._postWithRetry(this.webhookUrl, payload);
      this._apiSuccess();
      return result?.id || null;
    } catch (err) {
      this._apiError('createLead', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // HTTP helpers with retry
  // ──────────────────────────────────────────────────────────

  /**
   * POST with exponential backoff retry (1s, 5s, 15s).
   */
  async _postWithRetry(url, payload) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this._post(url, payload);
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES - 1) {
          const delay = RETRY_DELAYS[attempt] || 5000;
          logger.debug(`CRM [${this.name}]: webhook retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
          await _sleep(delay);
        }
      }
    }
    throw lastErr;
  }

  /**
   * HTTP POST — native https/http module (no npm dependencies).
   */
  _post(url, payload) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const bodyStr = JSON.stringify(payload);
      const headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'User-Agent': 'ShadowPBX/2.0',
      };
      if (this.authHeader) {
        headers[this.authHeaderName] = this.authHeader;
      }

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
        timeout: 15000,
      };

      const req = lib.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch { resolve(body || null); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.write(bodyStr);
      req.end();
    });
  }

  /**
   * HTTP GET — for reverse contact lookup.
   */
  _get(url) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const headers = { 'User-Agent': 'ShadowPBX/2.0' };
      if (this.authHeader) {
        headers[this.authHeaderName] = this.authHeader;
      }

      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
        timeout: 10000,
      };

      const req = lib.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(body)); } catch { resolve(null); }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  }
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = WebhookAdapter;
