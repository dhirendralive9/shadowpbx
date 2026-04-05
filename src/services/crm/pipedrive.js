const https = require('https');
const logger = require('../../utils/logger');
const BaseCrmAdapter = require('./base-adapter');
const oauthManager = require('./oauth');
const FieldMapper = require('./field-mapper');

// ============================================================
// Pipedrive CRM Adapter
//
// Uses Pipedrive REST API v1 for:
//   - Person search by phone
//   - Person/Deal creation
//   - Call logging via Activities (type=call)
//   - Deal stage updates
//   - Filter-based person import for dialer
//   - Custom field discovery
//
// Auth: OAuth 2.0 or API token (query param ?api_token=KEY)
//   - OAuth: uses oauthManager.withAutoRefresh()
//   - API token: appended to every request URL
//
// API Reference: developers.pipedrive.com/docs/api/v1
// ============================================================

const API_BASE = 'https://api.pipedrive.com';

class PipedriveAdapter extends BaseCrmAdapter {
  constructor(config) {
    super(config);
    this.configId = config.configId || '';
    this.authType = config.authType || 'apikey';
    this.apiToken = config.credentials?.apiToken || config.credentials?.apiKey || '';
    this.companyDomain = config.credentials?.companyDomain || '';  // e.g. 'mycompany'
    this.fieldMapper = new FieldMapper('pipedrive', config.fieldMapping);
  }

  // ──────────────────────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────────────────────

  async connect() {
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
      const result = await this._apiGet('/v1/users/me');
      this._apiSuccess();

      if (result.success && result.data) {
        this.companyDomain = result.data.company_domain || this.companyDomain;
        return { ok: true, message: `Connected to Pipedrive (${result.data.name}, ${this.companyDomain})` };
      }
      return { ok: false, message: 'Unexpected response from Pipedrive' };
    } catch (err) {
      this._apiError('testConnection', err);
      return { ok: false, message: err.message };
    }
  }

  async disconnect() {
    if (this.authType === 'oauth2' && this.configId) {
      try { await oauthManager.revokeTokens(this.configId); } catch (e) {}
    }
    this.connected = false;
    logger.info(`CRM [${this.name}]: disconnected`);
  }

  // ──────────────────────────────────────────────────────────
  // Contact (Person) operations
  // ──────────────────────────────────────────────────────────

  /**
   * Search for a person by phone number.
   * Pipedrive search API searches across all phone fields.
   */
  async searchContact(phone) {
    if (!phone) return null;

    const digits = phone.replace(/\D/g, '');
    const searchTerm = digits.length > 7 ? digits.slice(-10) : digits;

    try {
      const result = await this._apiGet(
        `/v1/persons/search?term=${encodeURIComponent(searchTerm)}&fields=phone&limit=5`
      );

      if (result.success && result.data && result.data.items && result.data.items.length > 0) {
        const match = result.data.items[0].item;
        this._apiSuccess();
        return this._normalizePerson(match);
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
      const result = await this._apiGet(`/v1/persons/${id}`);
      if (result.success && result.data) {
        this._apiSuccess();
        return this._normalizePerson(result.data);
      }
      return null;
    } catch (err) {
      this._apiError('getContact', err);
      return null;
    }
  }

  async createContact(data) {
    try {
      const body = {
        name: data.name || '(Unknown)',
      };

      if (data.phone) body.phone = [{ value: data.phone, primary: true, label: 'work' }];
      if (data.email) body.email = [{ value: data.email, primary: true, label: 'work' }];

      // Link to organization if company provided
      if (data.company) {
        const orgId = await this._findOrCreateOrg(data.company);
        if (orgId) body.org_id = orgId;
      }

      const result = await this._apiPost('/v1/persons', body);
      this._apiSuccess();

      const id = result.success && result.data ? result.data.id : null;
      if (id) logger.info(`CRM [${this.name}]: created Person ${id}`);
      return id ? String(id) : null;

    } catch (err) {
      this._apiError('createContact', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Call logging — Pipedrive Activities (type=call)
  // ──────────────────────────────────────────────────────────

  async logCall(callData) {
    try {
      const body = {
        subject: `ShadowPBX ${callData.direction || 'Call'}: ${callData.from} → ${callData.to}`,
        type: 'call',
        done: 1,
        duration: _formatPipedriveDuration(callData.talkTime || callData.duration || 0),
        note: this._buildNote(callData),
        due_date: callData.startTime
          ? new Date(callData.startTime).toISOString().split('T')[0]
          : new Date().toISOString().split('T')[0],
        due_time: callData.startTime
          ? new Date(callData.startTime).toISOString().split('T')[1].substring(0, 5)
          : new Date().toISOString().split('T')[1].substring(0, 5),
      };

      // Link to person
      if (callData.contactId) {
        body.person_id = Number(callData.contactId);
      }

      const result = await this._apiPost('/v1/activities', body);
      this._apiSuccess();

      const id = result.success && result.data ? result.data.id : null;
      if (id) logger.info(`CRM [${this.name}]: logged call as Activity ${id}`);
      return id ? String(id) : null;

    } catch (err) {
      this._apiError('logCall', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Lead / Deal operations
  // ──────────────────────────────────────────────────────────

  /**
   * Pipedrive uses Deals, not Leads (though Leads exist in newer plans).
   * createLead creates a Person + optionally a Deal.
   */
  async createLead(data) {
    // Create person first
    const personId = await this.createContact(data);
    if (!personId) return null;

    // Optionally create a deal linked to the person
    try {
      const deal = {
        title: `${data.name || 'Unknown'} — ShadowPBX Lead`,
        person_id: Number(personId),
        status: 'open',
      };

      const result = await this._apiPost('/v1/deals', deal);
      if (result.success && result.data) {
        logger.info(`CRM [${this.name}]: created Deal ${result.data.id} for Person ${personId}`);
      }
    } catch (err) {
      logger.debug(`CRM [${this.name}]: deal creation failed: ${err.message}`);
    }

    return personId;
  }

  async updateLead(id, data) {
    if (!id) return false;

    try {
      const body = {};
      if (data.name) body.name = data.name;
      if (data.phone) body.phone = [{ value: data.phone, primary: true, label: 'work' }];
      if (data.email) body.email = [{ value: data.email, primary: true, label: 'work' }];

      if (data.customFields) Object.assign(body, data.customFields);

      const result = await this._apiPut(`/v1/persons/${id}`, body);
      this._apiSuccess();

      return result.success === true;

    } catch (err) {
      this._apiError('updateLead', err);
      return false;
    }
  }

  /**
   * Pull persons from a Pipedrive filter for dialer import.
   */
  async getLeadsByList(filterId) {
    if (!filterId) return [];

    try {
      let leads = [];
      let start = 0;
      let moreItems = true;

      while (moreItems && leads.length < 10000) {
        const result = await this._apiGet(
          `/v1/persons?filter_id=${filterId}&start=${start}&limit=100`
        );

        if (result.success && result.data && result.data.length > 0) {
          for (const p of result.data) {
            const phone = _extractPhone(p.phone);
            if (!phone) continue;

            leads.push({
              phone,
              name: p.name || '',
              email: _extractEmail(p.email),
              company: p.org_name || (p.org_id ? p.org_id.name : '') || '',
              customFields: { pdPersonId: String(p.id) },
            });
          }
          moreItems = result.additional_data &&
                      result.additional_data.pagination &&
                      result.additional_data.pagination.more_items_in_collection;
          start += 100;
        } else {
          moreItems = false;
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
    if (!callId) return false;

    try {
      // Search recent activities for our call
      const result = await this._apiGet(
        `/v1/activities?type=call&done=1&limit=20&sort=add_time DESC`
      );

      if (result.success && result.data) {
        const match = result.data.find(a =>
          a.note && a.note.includes(`Call ID: ${callId}`)
        );

        if (match) {
          // Update the activity note with disposition
          const updatedNote = (match.note || '') + `\nDisposition: ${disposition}`;
          await this._apiPut(`/v1/activities/${match.id}`, { note: updatedNote });
          this._apiSuccess();

          // Create follow-up activity for callback
          if (disposition === 'callback' && extra && extra.callbackTime) {
            await this._createFollowUp(callId, extra.callbackTime, match.person_id);
          }

          logger.info(`CRM [${this.name}]: disposition '${disposition}' synced to activity ${match.id}`);
          return true;
        }
      }

      logger.debug(`CRM [${this.name}]: no activity found for callId ${callId}`);
      return false;

    } catch (err) {
      this._apiError('syncDisposition', err);
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Custom fields
  // ──────────────────────────────────────────────────────────

  async getCustomFields() {
    try {
      const result = await this._apiGet('/v1/personFields');
      this._apiSuccess();

      if (!result.success || !result.data) return [];

      return result.data
        .filter(f => f.edit_flag || ['phone', 'email', 'name'].includes(f.key))
        .map(f => ({
          name: f.key,
          label: f.name,
          type: f.field_type,
          custom: f.edit_flag || false,
          required: f.mandatory_flag || false,
          options: (f.options || []).map(o => ({ id: o.id, label: o.label })),
        }));

    } catch (err) {
      this._apiError('getCustomFields', err);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  // Pipedrive-specific
  // ──────────────────────────────────────────────────────────

  /**
   * List person filters (for dialer import dropdown).
   */
  async listFilters() {
    try {
      const result = await this._apiGet('/v1/filters?type=people');
      this._apiSuccess();

      if (!result.success || !result.data) return [];
      return result.data.map(f => ({
        id: String(f.id),
        name: f.name,
        type: f.type,
      }));

    } catch (err) {
      this._apiError('listFilters', err);
      return [];
    }
  }

  async _findOrCreateOrg(name) {
    if (!name) return null;

    try {
      // Search for existing org
      const search = await this._apiGet(
        `/v1/organizations/search?term=${encodeURIComponent(name)}&limit=1`
      );

      if (search.success && search.data && search.data.items && search.data.items.length > 0) {
        return search.data.items[0].item.id;
      }

      // Create new org
      const result = await this._apiPost('/v1/organizations', { name });
      return result.success && result.data ? result.data.id : null;

    } catch (err) {
      logger.debug(`CRM [${this.name}]: org lookup/create failed: ${err.message}`);
      return null;
    }
  }

  async _createFollowUp(callId, dueDate, personId) {
    try {
      const body = {
        subject: `Callback requested — ${callId}`,
        type: 'call',
        done: 0,
        due_date: new Date(dueDate).toISOString().split('T')[0],
        due_time: new Date(dueDate).toISOString().split('T')[1].substring(0, 5),
      };
      if (personId) body.person_id = personId;

      await this._apiPost('/v1/activities', body);
    } catch (err) {
      logger.debug(`CRM [${this.name}]: follow-up creation failed: ${err.message}`);
    }
  }

  _buildNote(callData) {
    const parts = [];
    if (callData.notes) parts.push(callData.notes);
    parts.push(`Call ID: ${callData.callId}`);
    parts.push(`Direction: ${callData.direction || 'unknown'}`);
    parts.push(`Duration: ${callData.talkTime || 0}s`);
    if (callData.recordingUrl) parts.push(`Recording: ${callData.recordingUrl}`);
    return parts.join('\n');
  }

  _normalizePerson(record) {
    if (!record) return null;

    const phone = _extractPhone(record.phone || record.phones);
    const email = _extractEmail(record.email || record.emails);

    return {
      id: String(record.id),
      name: record.name || '(Unknown)',
      phone,
      email,
      company: record.org_name || (record.org_id && typeof record.org_id === 'object' ? record.org_id.name : '') || '',
      title: record.job_title || '',
      status: '',
      objectType: 'Person',
      crmUrl: this.companyDomain && record.id
        ? `https://${this.companyDomain}.pipedrive.com/person/${record.id}`
        : null,
      raw: record,
    };
  }

  // ──────────────────────────────────────────────────────────
  // HTTP helpers — dual auth (OAuth or API token)
  // ──────────────────────────────────────────────────────────

  async _withAuth(apiFn) {
    if (this.authType === 'oauth2' && this.configId) {
      return oauthManager.withAutoRefresh(this.configId, apiFn);
    }
    // API token mode
    if (!this.apiToken) throw new Error('No Pipedrive API token configured');
    return apiFn(null);  // token appended as query param
  }

  async _apiGet(path) {
    return this._withAuth(async (token) => this._request('GET', path, null, token));
  }

  async _apiPost(path, body) {
    return this._withAuth(async (token) => this._request('POST', path, body, token));
  }

  async _apiPut(path, body) {
    return this._withAuth(async (token) => this._request('PUT', path, body, token));
  }

  _request(method, path, body, oauthToken) {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : null;

      // Add API token as query param if not using OAuth
      let finalPath = path;
      if (!oauthToken && this.apiToken) {
        const sep = path.includes('?') ? '&' : '?';
        finalPath = `${path}${sep}api_token=${this.apiToken}`;
      }

      const headers = {
        'Accept': 'application/json',
        'User-Agent': 'ShadowPBX/2.0',
      };

      if (oauthToken) {
        headers['Authorization'] = `Bearer ${oauthToken}`;
      }

      if (bodyStr) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const parsed = new URL(`${API_BASE}${finalPath}`);

      const options = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
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
            const err = new Error(`Pipedrive API ${res.statusCode}: ${data.substring(0, 300)}`);
            err.statusCode = res.statusCode;
            err.status = res.statusCode;
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Pipedrive request timeout')); });
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

/**
 * Extract primary phone from Pipedrive phone array.
 * Pipedrive stores phones as [{ value, primary, label }]
 */
function _extractPhone(phones) {
  if (!phones) return '';
  if (typeof phones === 'string') return phones;
  if (Array.isArray(phones)) {
    const primary = phones.find(p => p.primary) || phones[0];
    return primary ? primary.value : '';
  }
  return '';
}

/**
 * Extract primary email from Pipedrive email array.
 */
function _extractEmail(emails) {
  if (!emails) return '';
  if (typeof emails === 'string') return emails;
  if (Array.isArray(emails)) {
    const primary = emails.find(e => e.primary) || emails[0];
    return primary ? primary.value : '';
  }
  return '';
}

/**
 * Format seconds to Pipedrive duration string "HH:MM:SS".
 */
function _formatPipedriveDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

module.exports = PipedriveAdapter;
