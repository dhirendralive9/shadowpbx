const https = require('https');
const logger = require('../../utils/logger');
const BaseCrmAdapter = require('./base-adapter');
const FieldMapper = require('./field-mapper');

// ============================================================
// Freshsales CRM Adapter
//
// Uses Freshsales REST API for:
//   - Contact search by phone
//   - Contact/Lead creation
//   - Call logging via Phone Calls API
//   - Lead status updates
//   - Filter-based lead import for dialer
//   - Custom field discovery
//
// Auth: API Key — passed as header "Authorization: Token token=API_KEY"
// No OAuth needed — simplest auth model of all supported CRMs.
//
// Instance URL format: https://{domain}.freshsales.io
//   or https://{domain}.myfreshworks.com/crm/sales
//
// API Reference: developers.freshworks.com/crm/api
// ============================================================

class FreshsalesAdapter extends BaseCrmAdapter {
  constructor(config) {
    super(config);
    this.apiKey = config.credentials?.apiKey || '';
    this.domain = config.credentials?.domain || '';  // e.g. 'mycompany' or 'mycompany.freshsales.io'
    this.baseUrl = this._resolveBaseUrl(config);
    this.fieldMapper = new FieldMapper('freshsales', config.fieldMapping);
  }

  _resolveBaseUrl(config) {
    if (config.instanceUrl) return config.instanceUrl.replace(/\/$/, '');
    if (this.domain) {
      if (this.domain.includes('.')) return `https://${this.domain}`;
      return `https://${this.domain}.freshsales.io`;
    }
    return '';
  }

  // ──────────────────────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────────────────────

  async connect() {
    if (!this.apiKey || !this.baseUrl) {
      logger.warn(`CRM [${this.name}]: missing API key or domain`);
      this.connected = false;
      return false;
    }

    try {
      const test = await this.testConnection();
      this.connected = test.ok;
      return test.ok;
    } catch (err) {
      logger.debug(`CRM [${this.name}]: connect failed — ${err.message}`);
      this.connected = false;
      return false;
    }
  }

  async testConnection() {
    try {
      const result = await this._apiGet('/api/contacts?page=1&per_page=1');
      this._apiSuccess();
      return { ok: true, message: `Connected to Freshsales (${this.baseUrl})` };
    } catch (err) {
      this._apiError('testConnection', err);
      return { ok: false, message: err.message };
    }
  }

  async disconnect() {
    this.connected = false;
    logger.info(`CRM [${this.name}]: disconnected`);
  }

  // ──────────────────────────────────────────────────────────
  // Contact operations
  // ──────────────────────────────────────────────────────────

  async searchContact(phone) {
    if (!phone) return null;

    const digits = phone.replace(/\D/g, '');
    const searchTerm = digits.length > 7 ? digits.slice(-10) : digits;

    try {
      // Freshsales search API
      const result = await this._apiGet(
        `/api/search?q=${encodeURIComponent(searchTerm)}&include=contact`
      );

      if (result && Array.isArray(result) && result.length > 0) {
        // Filter to contacts with matching phone
        const match = result.find(r =>
          r.type === 'contact' &&
          (r.phone || r.mobile_number || '').replace(/\D/g, '').includes(searchTerm)
        );

        if (match) {
          this._apiSuccess();
          // Fetch full contact details
          return this.getContact(match.id);
        }
      }

      return null;

    } catch (err) {
      this._apiError('searchContact', err);
      return null;
    }
  }

  async getContact(id) {
    if (!id) return null;

    try {
      const result = await this._apiGet(`/api/contacts/${id}`);
      this._apiSuccess();

      const c = result.contact || result;
      return this._normalizeContact(c);
    } catch (err) {
      this._apiError('getContact', err);
      return null;
    }
  }

  async createContact(data) {
    try {
      const body = {};

      if (data.name) {
        const parts = _splitName(data.name);
        body.first_name = parts.first;
        body.last_name = parts.last;
      } else {
        body.last_name = '(Unknown)';
      }

      if (data.phone) body.mobile_number = data.phone;
      if (data.email) body.email = data.email;
      if (data.company) body.company_name = data.company;

      const result = await this._apiPost('/api/contacts', { contact: body });
      this._apiSuccess();

      const id = result.contact ? result.contact.id : null;
      if (id) logger.info(`CRM [${this.name}]: created Contact ${id}`);
      return id ? String(id) : null;

    } catch (err) {
      this._apiError('createContact', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Call logging — Freshsales Phone Calls API
  // ──────────────────────────────────────────────────────────

  async logCall(callData) {
    try {
      const body = {
        note: this._buildNote(callData),
        duration: callData.talkTime || callData.duration || 0,
        outcome: callData.disposition || 'completed',
      };

      // Link to contact
      if (callData.contactId) {
        body.targetable_id = Number(callData.contactId);
        body.targetable_type = 'Contact';
      }

      const result = await this._apiPost('/api/phone_calls', { phone_call: body });
      this._apiSuccess();

      const id = result.phone_call ? result.phone_call.id : null;
      if (id) logger.info(`CRM [${this.name}]: logged call ${id}`);
      return id ? String(id) : null;

    } catch (err) {
      this._apiError('logCall', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Lead operations
  // ──────────────────────────────────────────────────────────

  async createLead(data) {
    try {
      const body = {};

      if (data.name) {
        const parts = _splitName(data.name);
        body.first_name = parts.first;
        body.last_name = parts.last;
      } else {
        body.last_name = '(Unknown Caller)';
      }

      if (data.phone) body.mobile_number = data.phone;
      if (data.email) body.email = data.email;
      if (data.company) body.company_name = data.company;

      const result = await this._apiPost('/api/leads', { lead: body });
      this._apiSuccess();

      const id = result.lead ? result.lead.id : null;
      if (id) logger.info(`CRM [${this.name}]: created Lead ${id}`);
      return id ? String(id) : null;

    } catch (err) {
      this._apiError('createLead', err);
      return null;
    }
  }

  async updateLead(id, data) {
    if (!id) return false;

    try {
      const body = {};
      if (data.status) body.lead_stage_id = data.status;
      if (data.phone) body.mobile_number = data.phone;
      if (data.email) body.email = data.email;
      if (data.company) body.company_name = data.company;

      if (data.customFields) Object.assign(body, data.customFields);

      await this._apiPut(`/api/leads/${id}`, { lead: body });
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: updated Lead ${id}`);
      return true;

    } catch (err) {
      this._apiError('updateLead', err);
      return false;
    }
  }

  /**
   * Pull leads from a Freshsales filter/view for dialer import.
   */
  async getLeadsByList(filterId) {
    if (!filterId) return [];

    try {
      let leads = [];
      let page = 1;
      let hasMore = true;

      while (hasMore && leads.length < 10000) {
        const result = await this._apiGet(
          `/api/leads/view/${filterId}?page=${page}&per_page=100`
        );

        const records = result.leads || result;
        if (Array.isArray(records) && records.length > 0) {
          for (const r of records) {
            const phone = r.mobile_number || r.work_number || '';
            if (!phone) continue;

            leads.push({
              phone,
              name: r.display_name || `${r.first_name || ''} ${r.last_name || ''}`.trim(),
              email: r.email || '',
              company: r.company_name || '',
              customFields: { fsLeadId: String(r.id) },
            });
          }
          page++;
        } else {
          hasMore = false;
        }
      }

      this._apiSuccess();
      logger.info(`CRM [${this.name}]: imported ${leads.length} leads from filter ${filterId}`);
      return leads;

    } catch (err) {
      this._apiError('getLeadsByList', err);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  // Disposition sync
  // ──────────────────────────────────────────────────────────

  async syncDisposition(callId, disposition, extra) {
    // Freshsales phone_calls don't have a searchable callId field
    // Best effort: update via notes on the contact if contactId is in extra
    logger.debug(`CRM [${this.name}]: syncDisposition — limited in Freshsales (no call search by ID)`);
    return false;
  }

  // ──────────────────────────────────────────────────────────
  // Custom fields
  // ──────────────────────────────────────────────────────────

  async getCustomFields() {
    try {
      const result = await this._apiGet('/api/settings/contacts/fields');
      this._apiSuccess();

      const fields = result.fields || result;
      if (!Array.isArray(fields)) return [];

      return fields
        .filter(f => f.custom || ['mobile_number', 'work_number', 'email', 'job_title'].includes(f.name))
        .map(f => ({
          name: f.name,
          label: f.label,
          type: f.type,
          custom: f.custom || false,
          required: f.required || false,
        }));

    } catch (err) {
      this._apiError('getCustomFields', err);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────

  _buildNote(callData) {
    const parts = [];
    parts.push(`ShadowPBX ${callData.direction || 'Call'}: ${callData.from} → ${callData.to}`);
    if (callData.notes) parts.push(callData.notes);
    parts.push(`Call ID: ${callData.callId}`);
    parts.push(`Duration: ${callData.talkTime || 0}s`);
    if (callData.recordingUrl) parts.push(`Recording: ${callData.recordingUrl}`);
    return parts.join('\n');
  }

  _normalizeContact(record) {
    if (!record) return null;

    return {
      id: String(record.id),
      name: record.display_name || `${record.first_name || ''} ${record.last_name || ''}`.trim() || '(Unknown)',
      phone: record.mobile_number || record.work_number || '',
      email: record.email || '',
      company: record.company_name || (record.company ? record.company.name : '') || '',
      title: record.job_title || '',
      status: record.lead_stage || '',
      objectType: 'Contact',
      crmUrl: this.baseUrl && record.id ? `${this.baseUrl}/contacts/${record.id}` : null,
      raw: record,
    };
  }

  // ──────────────────────────────────────────────────────────
  // HTTP helpers — API key auth
  // ──────────────────────────────────────────────────────────

  async _apiGet(path) { return this._request('GET', path); }
  async _apiPost(path, body) { return this._request('POST', path, body); }
  async _apiPut(path, body) { return this._request('PUT', path, body); }

  _request(method, path, body) {
    return new Promise((resolve, reject) => {
      if (!this.baseUrl) return reject(new Error('No Freshsales base URL configured'));

      const parsed = new URL(this.baseUrl);
      const bodyStr = body ? JSON.stringify(body) : null;

      const headers = {
        'Authorization': `Token token=${this.apiKey}`,
        'Accept': 'application/json',
        'User-Agent': 'ShadowPBX/2.0',
      };

      if (bodyStr) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const options = {
        hostname: parsed.hostname,
        port: 443,
        path,
        method,
        headers,
        timeout: 15000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { resolve(data || { success: true }); }
          } else {
            const err = new Error(`Freshsales API ${res.statusCode}: ${data.substring(0, 300)}`);
            err.statusCode = res.statusCode;
            err.status = res.statusCode;
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Freshsales request timeout')); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function _splitName(fullName) {
  if (!fullName) return { first: '', last: '(Unknown)' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

module.exports = FreshsalesAdapter;
