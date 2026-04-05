const https = require('https');
const logger = require('../../utils/logger');
const BaseCrmAdapter = require('./base-adapter');
const oauthManager = require('./oauth');
const FieldMapper = require('./field-mapper');

// ============================================================
// Zoho CRM Adapter
//
// Uses Zoho CRM REST API v5 for:
//   - Contact/Lead search by phone number
//   - Contact/Lead creation
//   - Call logging via Calls module
//   - Lead status updates
//   - Custom View import for dialer
//   - Custom field discovery via metadata API
//
// Auth: OAuth 2.0 (Self Client or Server-based)
//
// Multi-region: Zoho has separate data centers:
//   US  → www.zohoapis.com
//   EU  → www.zohoapis.eu
//   IN  → www.zohoapis.in
//   AU  → www.zohoapis.com.au
//   JP  → www.zohoapis.jp
//
// The adapter resolves the API domain from instanceUrl or
// credentials.zohoRegion.
//
// API Reference: zoho.com/crm/developer/docs/api/v5
// ============================================================

// Region → API domain mapping
const REGION_DOMAINS = {
  us: 'www.zohoapis.com',
  eu: 'www.zohoapis.eu',
  in: 'www.zohoapis.in',
  au: 'www.zohoapis.com.au',
  jp: 'www.zohoapis.jp',
};

class ZohoAdapter extends BaseCrmAdapter {
  constructor(config) {
    super(config);
    this.configId = config.configId || '';
    this.region = config.credentials?.zohoRegion || 'us';
    this.apiDomain = REGION_DOMAINS[this.region] || REGION_DOMAINS.us;

    // Override from instanceUrl if provided (e.g. https://www.zohoapis.in)
    if (config.instanceUrl) {
      const match = config.instanceUrl.match(/zohoapis\.(\w+(?:\.\w+)?)/);
      if (match) {
        const tld = match[1];  // 'com', 'eu', 'in', 'com.au', 'jp'
        this.apiDomain = `www.zohoapis.${tld}`;
        // Reverse-map region
        for (const [r, d] of Object.entries(REGION_DOMAINS)) {
          if (d === this.apiDomain) { this.region = r; break; }
        }
      }
    }

    this.fieldMapper = new FieldMapper('zoho', config.fieldMapping);
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
      logger.debug(`CRM [${this.name}]: connect deferred — ${err.message}`);
      this.connected = false;
      return false;
    }
  }

  async testConnection() {
    try {
      // Lightweight: fetch org info
      const result = await this._apiGet('/crm/v5/org');
      this._apiSuccess();

      const org = result.org && result.org[0];
      const orgName = org ? org.company_name : 'Unknown';
      return { ok: true, message: `Connected to Zoho CRM (${orgName}, ${this.region.toUpperCase()})` };
    } catch (err) {
      this._apiError('testConnection', err);
      return { ok: false, message: err.message };
    }
  }

  async disconnect() {
    if (this.configId) {
      try { await oauthManager.revokeTokens(this.configId); } catch (e) {}
    }
    this.connected = false;
    logger.info(`CRM [${this.name}]: disconnected`);
  }

  // ──────────────────────────────────────────────────────────
  // Contact operations
  // ──────────────────────────────────────────────────────────

  /**
   * Search for a contact by phone number.
   * Searches both Contacts and Leads modules.
   */
  async searchContact(phone) {
    if (!phone) return null;

    const digits = phone.replace(/\D/g, '');
    const searchTerm = digits.length > 7 ? digits.slice(-10) : digits;

    try {
      // Search Contacts
      const contacts = await this._apiGet(
        `/crm/v5/Contacts/search?phone=${encodeURIComponent(searchTerm)}`
      );

      if (contacts.data && contacts.data.length > 0) {
        this._apiSuccess();
        return this._normalizeContact(contacts.data[0], 'Contacts');
      }

      // Fallback: search Leads
      const leads = await this._apiGet(
        `/crm/v5/Leads/search?phone=${encodeURIComponent(searchTerm)}`
      );

      if (leads.data && leads.data.length > 0) {
        this._apiSuccess();
        return this._normalizeContact(leads.data[0], 'Leads');
      }

      return null;

    } catch (err) {
      // Zoho returns 204 for no results — not an error
      if (err.statusCode === 204) return null;
      this._apiError('searchContact', err);
      return null;
    }
  }

  async getContact(id) {
    if (!id) return null;

    try {
      // Try Contacts first
      try {
        const result = await this._apiGet(`/crm/v5/Contacts/${id}`);
        if (result.data && result.data[0]) {
          this._apiSuccess();
          return this._normalizeContact(result.data[0], 'Contacts');
        }
      } catch (e) {
        if (e.statusCode !== 404) throw e;
      }

      // Try Leads
      const result = await this._apiGet(`/crm/v5/Leads/${id}`);
      if (result.data && result.data[0]) {
        this._apiSuccess();
        return this._normalizeContact(result.data[0], 'Leads');
      }

      return null;
    } catch (err) {
      this._apiError('getContact', err);
      return null;
    }
  }

  async createContact(data) {
    try {
      const record = {};

      if (data.name) {
        const parts = _splitName(data.name);
        record.First_Name = parts.first;
        record.Last_Name = parts.last;
      } else {
        record.Last_Name = '(Unknown)';
      }

      if (data.phone) record.Phone = data.phone;
      if (data.email) record.Email = data.email;
      if (data.company) record.Company = data.company;
      record.Lead_Source = 'ShadowPBX';

      const result = await this._apiPost('/crm/v5/Contacts', { data: [record] });
      this._apiSuccess();

      const id = result.data && result.data[0] ? result.data[0].details.id : null;
      if (id) logger.info(`CRM [${this.name}]: created Contact ${id}`);
      return id;

    } catch (err) {
      this._apiError('createContact', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Call logging — Zoho Calls module
  // ──────────────────────────────────────────────────────────

  async logCall(callData) {
    try {
      const record = {
        Subject: `ShadowPBX ${callData.direction || 'Call'}: ${callData.from} → ${callData.to}`,
        Call_Type: this.fieldMapper._mapDirection(callData.direction) || 'Outbound',
        Call_Duration: _formatZohoDuration(callData.talkTime || callData.duration || 0),
        Call_Start_Time: callData.startTime
          ? new Date(callData.startTime).toISOString()
          : new Date().toISOString(),
        Call_Result: callData.disposition || 'Completed',
        Description: this._buildDescription(callData),
      };

      // Link to Contact/Lead
      if (callData.contactId) {
        record.Who_Id = callData.contactId;
      }

      const result = await this._apiPost('/crm/v5/Calls', { data: [record] });
      this._apiSuccess();

      const id = result.data && result.data[0] ? result.data[0].details.id : null;
      if (id) logger.info(`CRM [${this.name}]: logged call ${id}`);
      return id;

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
      const record = {
        Lead_Source: data.source || 'ShadowPBX',
      };

      if (data.name) {
        const parts = _splitName(data.name);
        record.First_Name = parts.first;
        record.Last_Name = parts.last;
      } else {
        record.Last_Name = '(Unknown Caller)';
      }

      if (data.phone) record.Phone = data.phone;
      if (data.email) record.Email = data.email;
      if (data.company) record.Company = data.company;
      else record.Company = '(Unknown)';  // Zoho may require Company

      const result = await this._apiPost('/crm/v5/Leads', { data: [record] });
      this._apiSuccess();

      const id = result.data && result.data[0] ? result.data[0].details.id : null;
      if (id) logger.info(`CRM [${this.name}]: created Lead ${id}`);
      return id;

    } catch (err) {
      this._apiError('createLead', err);
      return null;
    }
  }

  async updateLead(id, data) {
    if (!id) return false;

    try {
      const record = { id };
      if (data.status) record.Lead_Status = data.status;
      if (data.phone) record.Phone = data.phone;
      if (data.email) record.Email = data.email;
      if (data.company) record.Company = data.company;

      // Custom fields
      if (data.customFields) {
        Object.assign(record, data.customFields);
      }

      await this._apiPut(`/crm/v5/Leads`, { data: [record] });
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: updated Lead ${id}`);
      return true;

    } catch (err) {
      this._apiError('updateLead', err);
      return false;
    }
  }

  /**
   * Pull leads from a Zoho Custom View for dialer import.
   * Custom Views are saved filters in Zoho CRM.
   */
  async getLeadsByList(viewId) {
    if (!viewId) return [];

    try {
      let leads = [];
      let page = 1;
      let morePages = true;

      while (morePages && leads.length < 10000) {
        const result = await this._apiGet(
          `/crm/v5/Leads?cvid=${encodeURIComponent(viewId)}&page=${page}&per_page=200&fields=Phone,Mobile,First_Name,Last_Name,Email,Company`
        );

        if (result.data && result.data.length > 0) {
          for (const r of result.data) {
            const phone = r.Phone || r.Mobile || '';
            if (!phone) continue;

            leads.push({
              phone,
              name: `${r.First_Name || ''} ${r.Last_Name || ''}`.trim(),
              email: r.Email || '',
              company: r.Company || '',
              customFields: {
                zohoLeadId: r.id,
              },
            });
          }
        }

        morePages = result.info && result.info.more_records === true;
        page++;
      }

      this._apiSuccess();
      logger.info(`CRM [${this.name}]: imported ${leads.length} leads from view ${viewId}`);
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
      // Search Calls module for our logged call
      const result = await this._apiGet(
        `/crm/v5/Calls/search?criteria=(Description:contains:${encodeURIComponent(callId)})&fields=id,Call_Result`
      );

      if (result.data && result.data.length > 0) {
        const zohoCallId = result.data[0].id;

        const update = {
          id: zohoCallId,
          Call_Result: disposition,
        };

        await this._apiPut('/crm/v5/Calls', { data: [update] });
        this._apiSuccess();

        // Create follow-up activity for callback
        if (disposition === 'callback' && extra && extra.callbackTime) {
          await this._createFollowUp(callId, extra.callbackTime);
        }

        logger.info(`CRM [${this.name}]: disposition '${disposition}' synced to call ${zohoCallId}`);
        return true;
      }

      logger.debug(`CRM [${this.name}]: no call found for callId ${callId}`);
      return false;

    } catch (err) {
      // 204 = no results
      if (err.statusCode === 204) return false;
      this._apiError('syncDisposition', err);
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Custom field discovery
  // ──────────────────────────────────────────────────────────

  async getCustomFields() {
    try {
      const result = await this._apiGet('/crm/v5/settings/fields?module=Contacts');
      this._apiSuccess();

      if (!result.fields) return [];

      return result.fields
        .filter(f => f.custom_field || ['Phone', 'Mobile', 'Email', 'Title', 'Department'].includes(f.api_name))
        .map(f => ({
          name: f.api_name,
          label: f.display_label || f.field_label,
          type: f.data_type,
          custom: f.custom_field || false,
          required: f.system_mandatory || false,
        }));

    } catch (err) {
      this._apiError('getCustomFields', err);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  // Zoho-specific: list Custom Views (for dialer UI)
  // ──────────────────────────────────────────────────────────

  async listCustomViews() {
    try {
      const result = await this._apiGet('/crm/v5/settings/custom_views?module=Leads');
      this._apiSuccess();

      return (result.custom_views || []).map(v => ({
        id: v.id,
        name: v.display_value || v.name,
        category: v.category || '',
        isDefault: v.default || false,
      }));

    } catch (err) {
      this._apiError('listCustomViews', err);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────

  _buildDescription(callData) {
    const parts = [];
    if (callData.notes) parts.push(callData.notes);
    parts.push(`Call ID: ${callData.callId}`);
    parts.push(`Duration: ${callData.talkTime || 0}s`);
    if (callData.recordingUrl) parts.push(`Recording: ${callData.recordingUrl}`);
    return parts.join('\n');
  }

  async _createFollowUp(callId, dueDate) {
    try {
      const record = {
        Subject: `Callback requested — ${callId}`,
        Due_Date: new Date(dueDate).toISOString().split('T')[0],
        Status: 'Not Started',
        Priority: 'Normal',
      };
      await this._apiPost('/crm/v5/Tasks', { data: [record] });
    } catch (err) {
      logger.debug(`CRM [${this.name}]: follow-up task failed: ${err.message}`);
    }
  }

  _normalizeContact(record, module) {
    if (!record) return null;

    return {
      id: record.id,
      name: record.Full_Name || `${record.First_Name || ''} ${record.Last_Name || ''}`.trim() || '(Unknown)',
      phone: record.Phone || record.Mobile || '',
      email: record.Email || '',
      company: module === 'Contacts'
        ? (record.Account_Name ? (record.Account_Name.name || record.Account_Name) : '')
        : (record.Company || ''),
      title: record.Title || record.Designation || '',
      status: record.Lead_Status || '',
      objectType: module === 'Contacts' ? 'Contact' : 'Lead',
      crmUrl: record.id ? `https://crm.zoho.${_regionTld(this.region)}/crm/tab/${module}/${record.id}` : null,
      raw: record,
    };
  }

  // ──────────────────────────────────────────────────────────
  // HTTP helpers — OAuth auto-refresh via oauthManager
  // ──────────────────────────────────────────────────────────

  async _apiGet(path) {
    return oauthManager.withAutoRefresh(this.configId, async (token) => {
      return this._request('GET', path, null, token);
    });
  }

  async _apiPost(path, body) {
    return oauthManager.withAutoRefresh(this.configId, async (token) => {
      return this._request('POST', path, body, token);
    });
  }

  async _apiPut(path, body) {
    return oauthManager.withAutoRefresh(this.configId, async (token) => {
      return this._request('PUT', path, body, token);
    });
  }

  _request(method, path, body, accessToken) {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : null;

      const headers = {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Accept': 'application/json',
        'User-Agent': 'ShadowPBX/2.0',
      };

      if (bodyStr) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(bodyStr);
      }

      const options = {
        hostname: this.apiDomain,
        port: 443,
        path,
        method,
        headers,
        timeout: 20000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // 204 = no content (search with no results)
          if (res.statusCode === 204) {
            const err = new Error('No results');
            err.statusCode = 204;
            return reject(err);
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { resolve(data || { success: true }); }
          } else {
            const err = new Error(`Zoho API ${res.statusCode}: ${data.substring(0, 300)}`);
            err.statusCode = res.statusCode;
            err.status = res.statusCode;

            // Parse Zoho error
            try {
              const zohoErr = JSON.parse(data);
              if (zohoErr.message) err.message = `Zoho: ${zohoErr.message} (${zohoErr.code || ''})`;
            } catch {}

            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Zoho request timeout')); });
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
 * Format seconds to Zoho duration string "HH:MM:SS".
 */
function _formatZohoDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Map region code to Zoho CRM web TLD.
 */
function _regionTld(region) {
  const map = { us: 'com', eu: 'eu', in: 'in', au: 'com.au', jp: 'jp' };
  return map[region] || 'com';
}

module.exports = ZohoAdapter;
