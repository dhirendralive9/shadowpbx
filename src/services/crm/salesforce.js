const https = require('https');
const logger = require('../../utils/logger');
const BaseCrmAdapter = require('./base-adapter');
const oauthManager = require('./oauth');
const FieldMapper = require('./field-mapper');

// ============================================================
// Salesforce CRM Adapter
//
// Uses Salesforce REST API v59.0 for:
//   - Contact search via SOQL (phone number matching)
//   - Contact/Lead creation
//   - Call logging as Task objects
//   - Lead status updates
//   - Campaign member import for dialer
//   - Custom field discovery
//
// Auth: OAuth 2.0 (Web Server Flow) — requires a Connected App
// in Salesforce Setup with callback URL whitelisted.
//
// All API calls use oauthManager.withAutoRefresh() for automatic
// token management and 401 retry.
//
// API Reference: developer.salesforce.com/docs/atlas.en-us.api_rest.meta
// ============================================================

const API_VERSION = 'v59.0';

class SalesforceAdapter extends BaseCrmAdapter {
  constructor(config) {
    super(config);
    this.configId = config.configId || '';
    this.instanceUrl = config.instanceUrl || '';  // e.g. https://na1.salesforce.com
    this.fieldMapper = new FieldMapper('salesforce', config.fieldMapping);
  }

  // ──────────────────────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────────────────────

  async connect() {
    if (!this.configId) {
      logger.warn(`CRM [${this.name}]: no configId — cannot connect`);
      this.connected = false;
      return false;
    }

    try {
      // Get token data (triggers refresh if needed)
      const tokenData = await oauthManager.getTokenData(this.configId);
      if (tokenData.instanceUrl) {
        this.instanceUrl = tokenData.instanceUrl;
      }

      if (!this.instanceUrl) {
        logger.warn(`CRM [${this.name}]: no instanceUrl — OAuth authorization may be required`);
        this.connected = false;
        return false;
      }

      // Verify connection with a lightweight API call
      const test = await this.testConnection();
      this.connected = test.ok;
      return test.ok;

    } catch (err) {
      // OAuth tokens may not exist yet — that's okay, admin will authorize later
      logger.debug(`CRM [${this.name}]: connect deferred — ${err.message}`);
      this.connected = false;
      return false;
    }
  }

  async testConnection() {
    try {
      const result = await this._apiGet('/services/data/');
      this._apiSuccess();

      // result is an array of API versions
      if (Array.isArray(result) && result.length > 0) {
        const latest = result[result.length - 1];
        return { ok: true, message: `Connected to Salesforce (API ${latest.version})` };
      }
      return { ok: true, message: 'Connected to Salesforce' };
    } catch (err) {
      this._apiError('testConnection', err);
      return { ok: false, message: err.message };
    }
  }

  async disconnect() {
    // Revoke tokens if needed
    try {
      if (this.configId) {
        await oauthManager.revokeTokens(this.configId);
      }
    } catch (e) {
      logger.debug(`CRM [${this.name}]: revoke on disconnect: ${e.message}`);
    }
    this.connected = false;
    logger.info(`CRM [${this.name}]: disconnected`);
  }

  // ──────────────────────────────────────────────────────────
  // Contact operations
  // ──────────────────────────────────────────────────────────

  /**
   * Search for a contact by phone number using SOQL.
   * Searches both Contact and Lead objects.
   * Phone matching uses LIKE with last 10 digits for flexibility.
   */
  async searchContact(phone) {
    if (!phone) return null;

    // Normalize: extract last 10 digits for matching
    const digits = phone.replace(/\D/g, '');
    const searchDigits = digits.length > 10 ? digits.slice(-10) : digits;

    try {
      // Search Contacts first
      const contactQuery = `SELECT Id, FirstName, LastName, Name, Phone, MobilePhone, Email, `
        + `Title, Account.Name, AccountId `
        + `FROM Contact `
        + `WHERE Phone LIKE '%${searchDigits}' OR MobilePhone LIKE '%${searchDigits}' `
        + `LIMIT 5`;

      const contactResult = await this._soqlQuery(contactQuery);

      if (contactResult.records && contactResult.records.length > 0) {
        const c = contactResult.records[0];
        this._apiSuccess();
        return this._normalizeContact(c, 'Contact');
      }

      // Fallback: search Leads
      const leadQuery = `SELECT Id, FirstName, LastName, Name, Phone, MobilePhone, Email, `
        + `Title, Company, Status `
        + `FROM Lead `
        + `WHERE Phone LIKE '%${searchDigits}' OR MobilePhone LIKE '%${searchDigits}' `
        + `LIMIT 5`;

      const leadResult = await this._soqlQuery(leadQuery);

      if (leadResult.records && leadResult.records.length > 0) {
        const l = leadResult.records[0];
        this._apiSuccess();
        return this._normalizeContact(l, 'Lead');
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
      // Try Contact first
      try {
        const c = await this._apiGet(`/services/data/${API_VERSION}/sobjects/Contact/${id}`);
        this._apiSuccess();
        return this._normalizeContact(c, 'Contact');
      } catch (e) {
        // If not a Contact, try Lead
        if (e.message && e.message.includes('404')) {
          const l = await this._apiGet(`/services/data/${API_VERSION}/sobjects/Lead/${id}`);
          this._apiSuccess();
          return this._normalizeContact(l, 'Lead');
        }
        throw e;
      }
    } catch (err) {
      this._apiError('getContact', err);
      return null;
    }
  }

  async createContact(data) {
    try {
      const body = {};

      // Name handling
      if (data.name) {
        const parts = _splitName(data.name);
        body.FirstName = parts.first;
        body.LastName = parts.last;
      } else {
        body.LastName = '(Unknown)';
      }

      if (data.phone) body.Phone = data.phone;
      if (data.email) body.Email = data.email;
      body.Description = 'Created by ShadowPBX';

      // If company provided, try to find/create Account
      if (data.company) {
        const accountId = await this._findOrCreateAccount(data.company);
        if (accountId) body.AccountId = accountId;
      }

      const result = await this._apiPost(`/services/data/${API_VERSION}/sobjects/Contact`, body);
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: created Contact ${result.id}`);
      return result.id;

    } catch (err) {
      this._apiError('createContact', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Call logging — Salesforce Task object
  // ──────────────────────────────────────────────────────────

  async logCall(callData) {
    try {
      const task = {
        Subject: `ShadowPBX ${callData.direction || 'Call'}: ${callData.from} → ${callData.to}`,
        Status: callData.disposition || 'Completed',
        Priority: 'Normal',
        TaskSubtype: 'Call',
        CallType: this.fieldMapper._mapDirection(callData.direction) || 'Outbound',
        CallDurationInSeconds: callData.talkTime || callData.duration || 0,
        ActivityDate: _formatSfDate(callData.startTime),
      };

      // Description: notes + recording link
      const descParts = [];
      if (callData.notes) descParts.push(callData.notes);
      descParts.push(`Call ID: ${callData.callId}`);
      descParts.push(`Duration: ${callData.talkTime || 0}s`);
      if (callData.recordingUrl) {
        descParts.push(`Recording: ${callData.recordingUrl}`);
      }
      task.Description = descParts.join('\n');

      // Link to Contact/Lead if we have a CRM contact ID
      if (callData.contactId) {
        task.WhoId = callData.contactId;
      }

      const result = await this._apiPost(`/services/data/${API_VERSION}/sobjects/Task`, task);
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: logged call as Task ${result.id}`);
      return result.id;

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
      const body = {
        LeadSource: data.source || 'ShadowPBX',
      };

      if (data.name) {
        const parts = _splitName(data.name);
        body.FirstName = parts.first;
        body.LastName = parts.last;
      } else {
        body.LastName = '(Unknown Caller)';
      }

      if (data.phone) body.Phone = data.phone;
      if (data.email) body.Email = data.email;
      if (data.company) body.Company = data.company;
      else body.Company = '(Unknown)';  // SF requires Company on Lead

      const result = await this._apiPost(`/services/data/${API_VERSION}/sobjects/Lead`, body);
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: created Lead ${result.id}`);
      return result.id;

    } catch (err) {
      this._apiError('createLead', err);
      return null;
    }
  }

  async updateLead(id, data) {
    if (!id) return false;

    try {
      const body = {};
      if (data.status) body.Status = data.status;
      if (data.phone) body.Phone = data.phone;
      if (data.email) body.Email = data.email;
      if (data.company) body.Company = data.company;
      if (data.description) body.Description = data.description;

      // Apply custom fields
      if (data.customFields) {
        Object.assign(body, data.customFields);
      }

      await this._apiPatch(`/services/data/${API_VERSION}/sobjects/Lead/${id}`, body);
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: updated Lead ${id}`);
      return true;

    } catch (err) {
      this._apiError('updateLead', err);
      return false;
    }
  }

  /**
   * Pull leads from a Salesforce Campaign for dialer import.
   * Fetches CampaignMembers with their Contact/Lead phone numbers.
   */
  async getLeadsByList(campaignId) {
    if (!campaignId) return [];

    try {
      const query = `SELECT Id, ContactId, LeadId, `
        + `Contact.Name, Contact.Phone, Contact.MobilePhone, Contact.Email, Contact.Account.Name, `
        + `Lead.Name, Lead.Phone, Lead.MobilePhone, Lead.Email, Lead.Company `
        + `FROM CampaignMember `
        + `WHERE CampaignId = '${_sanitizeSoql(campaignId)}' `
        + `AND (Contact.Phone != null OR Lead.Phone != null) `
        + `LIMIT 10000`;

      const result = await this._soqlQuery(query);
      this._apiSuccess();

      if (!result.records || result.records.length === 0) return [];

      return result.records.map(cm => {
        const isContact = !!cm.ContactId;
        const record = isContact ? cm.Contact : cm.Lead;
        if (!record) return null;

        return {
          phone: record.Phone || record.MobilePhone || '',
          name: record.Name || '',
          email: record.Email || '',
          company: isContact ? (record.Account ? record.Account.Name : '') : (record.Company || ''),
          customFields: {
            sfCampaignMemberId: cm.Id,
            sfContactId: cm.ContactId || '',
            sfLeadId: cm.LeadId || '',
          },
        };
      }).filter(l => l && l.phone);

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
      // Find the Task we logged for this call
      const query = `SELECT Id FROM Task `
        + `WHERE Description LIKE '%Call ID: ${_sanitizeSoql(callId)}%' `
        + `ORDER BY CreatedDate DESC LIMIT 1`;

      const result = await this._soqlQuery(query);

      if (result.records && result.records.length > 0) {
        const taskId = result.records[0].Id;
        const body = { Status: disposition };

        // Add callback as a follow-up
        if (disposition === 'callback' && extra && extra.callbackTime) {
          body.Status = 'Deferred';
          body.ReminderDateTime = new Date(extra.callbackTime).toISOString();
          body.IsReminderSet = true;
        }

        await this._apiPatch(`/services/data/${API_VERSION}/sobjects/Task/${taskId}`, body);
        this._apiSuccess();

        logger.info(`CRM [${this.name}]: disposition '${disposition}' synced to Task ${taskId}`);
        return true;
      }

      logger.debug(`CRM [${this.name}]: no Task found for callId ${callId}`);
      return false;

    } catch (err) {
      this._apiError('syncDisposition', err);
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Custom field discovery
  // ──────────────────────────────────────────────────────────

  async getCustomFields() {
    try {
      // Describe Contact object to get all fields
      const result = await this._apiGet(`/services/data/${API_VERSION}/sobjects/Contact/describe`);
      this._apiSuccess();

      if (!result.fields) return [];

      return result.fields
        .filter(f => f.custom || ['Phone', 'MobilePhone', 'Email', 'Title', 'Department'].includes(f.name))
        .map(f => ({
          name: f.name,
          label: f.label,
          type: f.type,
          custom: f.custom || false,
          required: !f.nillable && !f.defaultedOnCreate,
        }));

    } catch (err) {
      this._apiError('getCustomFields', err);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  // Salesforce-specific: Account lookup/create
  // ──────────────────────────────────────────────────────────

  async _findOrCreateAccount(companyName) {
    if (!companyName) return null;

    try {
      // Search for existing account
      const query = `SELECT Id FROM Account WHERE Name = '${_sanitizeSoql(companyName)}' LIMIT 1`;
      const result = await this._soqlQuery(query);

      if (result.records && result.records.length > 0) {
        return result.records[0].Id;
      }

      // Create new account
      const createResult = await this._apiPost(
        `/services/data/${API_VERSION}/sobjects/Account`,
        { Name: companyName }
      );
      return createResult.id || null;

    } catch (err) {
      logger.debug(`CRM [${this.name}]: Account lookup/create failed: ${err.message}`);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Salesforce-specific: Campaign list (for dialer UI)
  // ──────────────────────────────────────────────────────────

  /**
   * List active SF Campaigns (for the dialer campaign import dropdown).
   */
  async listCampaigns() {
    try {
      const query = `SELECT Id, Name, Status, NumberOfContacts, NumberOfLeads `
        + `FROM Campaign WHERE IsActive = true ORDER BY Name LIMIT 100`;

      const result = await this._soqlQuery(query);
      this._apiSuccess();

      return (result.records || []).map(c => ({
        id: c.Id,
        name: c.Name,
        status: c.Status,
        contactCount: c.NumberOfContacts || 0,
        leadCount: c.NumberOfLeads || 0,
      }));

    } catch (err) {
      this._apiError('listCampaigns', err);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  // Contact normalization
  // ──────────────────────────────────────────────────────────

  _normalizeContact(record, objectType) {
    const baseUrl = this.instanceUrl || '';

    return {
      id: record.Id,
      name: record.Name || `${record.FirstName || ''} ${record.LastName || ''}`.trim(),
      phone: record.Phone || record.MobilePhone || '',
      email: record.Email || '',
      company: objectType === 'Contact'
        ? (record.Account ? record.Account.Name : '')
        : (record.Company || ''),
      title: record.Title || '',
      objectType,  // 'Contact' or 'Lead'
      status: record.Status || '',
      accountId: record.AccountId || '',
      crmUrl: baseUrl ? `${baseUrl}/${record.Id}` : null,
      raw: record,
    };
  }

  // ──────────────────────────────────────────────────────────
  // HTTP helpers — all wrapped in oauthManager.withAutoRefresh
  // ──────────────────────────────────────────────────────────

  async _soqlQuery(soql) {
    const encodedQuery = encodeURIComponent(soql);
    return this._apiGet(`/services/data/${API_VERSION}/query?q=${encodedQuery}`);
  }

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

  async _apiPatch(path, body) {
    return oauthManager.withAutoRefresh(this.configId, async (token) => {
      return this._request('PATCH', path, body, token);
    });
  }

  /**
   * Raw HTTPS request to Salesforce instance.
   */
  _request(method, path, body, accessToken) {
    return new Promise((resolve, reject) => {
      if (!this.instanceUrl) {
        return reject(new Error('No Salesforce instance URL — OAuth authorization required'));
      }

      const parsed = new URL(this.instanceUrl);
      const bodyStr = body ? JSON.stringify(body) : null;

      const headers = {
        'Authorization': `Bearer ${accessToken}`,
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
        path: path,
        method: method,
        headers,
        timeout: 20000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          // PATCH returns 204 No Content on success
          if (res.statusCode === 204) {
            return resolve({ success: true });
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data || { success: true });
            }
          } else {
            const err = new Error(`Salesforce API ${res.statusCode}: ${data.substring(0, 300)}`);
            err.statusCode = res.statusCode;
            err.status = res.statusCode;

            // Parse SF error array for better messages
            try {
              const sfErrors = JSON.parse(data);
              if (Array.isArray(sfErrors) && sfErrors[0] && sfErrors[0].message) {
                err.message = `Salesforce: ${sfErrors[0].message} (${sfErrors[0].errorCode})`;
              }
            } catch {}

            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Salesforce request timeout')); });
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
 * Format a date for Salesforce ActivityDate (YYYY-MM-DD).
 */
function _formatSfDate(date) {
  if (!date) return new Date().toISOString().split('T')[0];
  const d = new Date(date);
  return d.toISOString().split('T')[0];
}

/**
 * Sanitize a value for safe use in SOQL queries.
 * Escapes single quotes to prevent SOQL injection.
 */
function _sanitizeSoql(value) {
  if (!value) return '';
  return String(value).replace(/'/g, "\\'").replace(/\\/g, '\\\\');
}

module.exports = SalesforceAdapter;
