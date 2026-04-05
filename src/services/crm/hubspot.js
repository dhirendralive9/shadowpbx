const https = require('https');
const logger = require('../../utils/logger');
const BaseCrmAdapter = require('./base-adapter');
const oauthManager = require('./oauth');
const FieldMapper = require('./field-mapper');
const crmCrypto = require('./crypto');

// ============================================================
// HubSpot CRM Adapter
//
// Uses HubSpot CRM API v3 for:
//   - Contact search by phone number
//   - Contact/Deal creation
//   - Call logging via Calls object + Associations API
//   - Lead status updates via contact properties
//   - Contact list import for dialer
//   - Custom property discovery
//
// Auth: OAuth 2.0 or Private App token (Bearer)
//   - OAuth: uses oauthManager.withAutoRefresh()
//   - Private App: uses static Bearer token from credentials
//
// HubSpot has simpler API than Salesforce — no SOQL, just REST
// endpoints with filter objects for search.
//
// API Reference: developers.hubspot.com/docs/api/crm
// ============================================================

const API_BASE = 'https://api.hubapi.com';

class HubSpotAdapter extends BaseCrmAdapter {
  constructor(config) {
    super(config);
    this.configId = config.configId || '';
    this.authType = config.authType || 'oauth2';

    // Private App token (alternative to OAuth)
    this.apiToken = config.credentials?.apiToken || config.credentials?.accessToken || '';

    this.fieldMapper = new FieldMapper('hubspot', config.fieldMapping);
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
      // Lightweight: fetch account info
      const result = await this._apiGet('/account-info/v3/details');
      this._apiSuccess();

      const portalId = result.portalId || result.hub_id || '';
      return { ok: true, message: `Connected to HubSpot (Portal ${portalId})` };
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
  // Contact operations
  // ──────────────────────────────────────────────────────────

  /**
   * Search for a contact by phone number.
   * Uses HubSpot Search API with phone property filter.
   */
  async searchContact(phone) {
    if (!phone) return null;

    // Normalize: strip non-digits, try multiple formats
    const digits = phone.replace(/\D/g, '');

    try {
      const body = {
        filterGroups: [
          {
            filters: [
              { propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: `*${digits.slice(-7)}` }
            ]
          },
          {
            filters: [
              { propertyName: 'mobilephone', operator: 'CONTAINS_TOKEN', value: `*${digits.slice(-7)}` }
            ]
          }
        ],
        properties: ['firstname', 'lastname', 'phone', 'mobilephone', 'email',
                      'company', 'jobtitle', 'hs_lead_status', 'lifecyclestage',
                      'hubspot_owner_id'],
        limit: 5,
      };

      const result = await this._apiPost('/crm/v3/objects/contacts/search', body);

      if (result.results && result.results.length > 0) {
        this._apiSuccess();
        return this._normalizeContact(result.results[0]);
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
      const props = 'firstname,lastname,phone,mobilephone,email,company,jobtitle,hs_lead_status,lifecyclestage,hubspot_owner_id';
      const result = await this._apiGet(`/crm/v3/objects/contacts/${id}?properties=${props}`);
      this._apiSuccess();
      return this._normalizeContact(result);
    } catch (err) {
      this._apiError('getContact', err);
      return null;
    }
  }

  async createContact(data) {
    try {
      const properties = {};

      if (data.name) {
        const parts = _splitName(data.name);
        properties.firstname = parts.first;
        properties.lastname = parts.last;
      }

      if (data.phone) properties.phone = data.phone;
      if (data.email) properties.email = data.email;
      if (data.company) properties.company = data.company;
      properties.hs_lead_status = 'NEW';

      const result = await this._apiPost('/crm/v3/objects/contacts', { properties });
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: created Contact ${result.id}`);
      return result.id;

    } catch (err) {
      this._apiError('createContact', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Call logging — HubSpot Calls object + Associations
  // ──────────────────────────────────────────────────────────

  async logCall(callData) {
    try {
      const properties = {
        hs_call_title: `ShadowPBX ${callData.direction || 'Call'}: ${callData.from} → ${callData.to}`,
        hs_call_body: this._buildCallBody(callData),
        hs_call_direction: this.fieldMapper._mapDirection(callData.direction) || 'OUTBOUND',
        hs_call_duration: String((callData.talkTime || callData.duration || 0) * 1000),  // HS uses milliseconds
        hs_call_disposition: callData.disposition || '',
        hs_call_status: 'COMPLETED',
        hs_timestamp: callData.startTime
          ? new Date(callData.startTime).getTime().toString()
          : Date.now().toString(),
      };

      // Recording URL
      if (callData.recordingUrl) {
        properties.hs_call_recording_url = callData.recordingUrl;
      }

      // Build associations if we have a contact ID
      const associations = [];
      if (callData.contactId) {
        associations.push({
          to: { id: callData.contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 194 }]  // call-to-contact
        });
      }

      const body = { properties };
      if (associations.length > 0) body.associations = associations;

      const result = await this._apiPost('/crm/v3/objects/calls', body);
      this._apiSuccess();

      // If no association was set in creation, associate separately
      if (callData.contactId && associations.length === 0) {
        await this._associateCallToContact(result.id, callData.contactId);
      }

      logger.info(`CRM [${this.name}]: logged call ${result.id}`);
      return result.id;

    } catch (err) {
      this._apiError('logCall', err);
      return null;
    }
  }

  /**
   * Associate a Call object with a Contact via the Associations API.
   */
  async _associateCallToContact(callId, contactId) {
    try {
      await this._apiPut(
        `/crm/v3/objects/calls/${callId}/associations/contacts/${contactId}/194`,
        {}
      );
    } catch (err) {
      logger.debug(`CRM [${this.name}]: association failed: ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Lead operations
  // ──────────────────────────────────────────────────────────

  /**
   * HubSpot doesn't have a separate Lead object — leads are Contacts
   * with lifecyclestage = 'lead'.
   */
  async createLead(data) {
    try {
      const properties = {
        lifecyclestage: 'lead',
        hs_lead_status: 'NEW',
        lead_source: data.source || 'ShadowPBX',
      };

      if (data.name) {
        const parts = _splitName(data.name);
        properties.firstname = parts.first;
        properties.lastname = parts.last;
      }

      if (data.phone) properties.phone = data.phone;
      if (data.email) properties.email = data.email;
      if (data.company) properties.company = data.company;

      const result = await this._apiPost('/crm/v3/objects/contacts', { properties });
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: created Lead (Contact) ${result.id}`);
      return result.id;

    } catch (err) {
      this._apiError('createLead', err);
      return null;
    }
  }

  async updateLead(id, data) {
    if (!id) return false;

    try {
      const properties = {};
      if (data.status) properties.hs_lead_status = data.status;
      if (data.phone) properties.phone = data.phone;
      if (data.email) properties.email = data.email;
      if (data.company) properties.company = data.company;

      // Custom fields
      if (data.customFields) {
        Object.assign(properties, data.customFields);
      }

      await this._apiPatch(`/crm/v3/objects/contacts/${id}`, { properties });
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: updated Contact ${id}`);
      return true;

    } catch (err) {
      this._apiError('updateLead', err);
      return false;
    }
  }

  /**
   * Pull contacts from a HubSpot Contact List for dialer import.
   * Uses the Lists API to get list members.
   */
  async getLeadsByList(listId) {
    if (!listId) return [];

    try {
      // HubSpot Lists API — get contacts in a list
      let leads = [];
      let hasMore = true;
      let offset = 0;

      while (hasMore && leads.length < 10000) {
        const result = await this._apiGet(
          `/contacts/v1/lists/${listId}/contacts/all?count=100&vidOffset=${offset}&property=phone&property=mobilephone&property=firstname&property=lastname&property=email&property=company`
        );

        if (result.contacts && result.contacts.length > 0) {
          for (const c of result.contacts) {
            const props = c.properties || {};
            const phone = _propVal(props.phone) || _propVal(props.mobilephone);
            if (!phone) continue;

            leads.push({
              phone,
              name: `${_propVal(props.firstname) || ''} ${_propVal(props.lastname) || ''}`.trim(),
              email: _propVal(props.email) || '',
              company: _propVal(props.company) || '',
              customFields: {
                hsContactId: String(c.vid),
              },
            });
          }
        }

        hasMore = result['has-more'] === true;
        offset = result['vid-offset'] || 0;
      }

      this._apiSuccess();
      logger.info(`CRM [${this.name}]: imported ${leads.length} leads from list ${listId}`);
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
      // Search for the call we logged by looking at recent calls with our callId in the body
      const body = {
        filterGroups: [{
          filters: [{
            propertyName: 'hs_call_body',
            operator: 'CONTAINS_TOKEN',
            value: callId,
          }]
        }],
        properties: ['hs_call_disposition'],
        sorts: [{ propertyName: 'hs_timestamp', direction: 'DESCENDING' }],
        limit: 1,
      };

      const result = await this._apiPost('/crm/v3/objects/calls/search', body);

      if (result.results && result.results.length > 0) {
        const hsCallId = result.results[0].id;

        const updateProps = {
          hs_call_disposition: disposition,
        };

        await this._apiPatch(`/crm/v3/objects/calls/${hsCallId}`, { properties: updateProps });
        this._apiSuccess();

        // Create follow-up task for callback disposition
        if (disposition === 'callback' && extra && extra.callbackTime) {
          await this._createTask(
            `Callback requested — ${callId}`,
            extra.callbackTime,
            result.results[0]
          );
        }

        logger.info(`CRM [${this.name}]: disposition '${disposition}' synced to call ${hsCallId}`);
        return true;
      }

      logger.debug(`CRM [${this.name}]: no call found for callId ${callId}`);
      return false;

    } catch (err) {
      this._apiError('syncDisposition', err);
      return false;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Deal operations (HubSpot-specific)
  // ──────────────────────────────────────────────────────────

  /**
   * Create a deal associated with a contact.
   */
  async createDeal(contactId, data) {
    try {
      const properties = {
        dealname: data.name || 'ShadowPBX Deal',
        pipeline: data.pipeline || 'default',
        dealstage: data.stage || 'appointmentscheduled',
        amount: data.amount || '',
      };

      const associations = [];
      if (contactId) {
        associations.push({
          to: { id: contactId },
          types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]  // deal-to-contact
        });
      }

      const body = { properties };
      if (associations.length > 0) body.associations = associations;

      const result = await this._apiPost('/crm/v3/objects/deals', body);
      this._apiSuccess();

      logger.info(`CRM [${this.name}]: created Deal ${result.id}`);
      return result.id;

    } catch (err) {
      this._apiError('createDeal', err);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────────
  // Custom property discovery
  // ──────────────────────────────────────────────────────────

  async getCustomFields() {
    try {
      const result = await this._apiGet('/crm/v3/properties/contacts');
      this._apiSuccess();

      if (!result.results) return [];

      return result.results
        .filter(p => !p.hubspotDefined || ['phone', 'mobilephone', 'email', 'jobtitle', 'company'].includes(p.name))
        .map(p => ({
          name: p.name,
          label: p.label,
          type: p.type,
          custom: !p.hubspotDefined,
          required: false,
          options: p.options || [],
        }));

    } catch (err) {
      this._apiError('getCustomFields', err);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  // HubSpot-specific: list contact lists (for dialer UI)
  // ──────────────────────────────────────────────────────────

  async listContactLists() {
    try {
      const result = await this._apiGet('/contacts/v1/lists?count=100');
      this._apiSuccess();

      return (result.lists || []).map(l => ({
        id: String(l.listId),
        name: l.name,
        contactCount: l.metaData ? l.metaData.size : 0,
        listType: l.listType,
        dynamic: l.dynamic,
      }));

    } catch (err) {
      this._apiError('listContactLists', err);
      return [];
    }
  }

  // ──────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────

  /**
   * Build call body text with notes, callId, and recording link.
   */
  _buildCallBody(callData) {
    const parts = [];
    if (callData.notes) parts.push(callData.notes);
    parts.push(`Call ID: ${callData.callId}`);
    parts.push(`Duration: ${callData.talkTime || 0}s`);
    parts.push(`Direction: ${callData.direction || 'unknown'}`);
    if (callData.recordingUrl) parts.push(`Recording: ${callData.recordingUrl}`);
    return parts.join('\n');
  }

  /**
   * Create a follow-up task in HubSpot.
   */
  async _createTask(title, dueDate, callRecord) {
    try {
      const properties = {
        hs_task_subject: title,
        hs_task_status: 'NOT_STARTED',
        hs_task_priority: 'MEDIUM',
        hs_timestamp: new Date(dueDate).getTime().toString(),
      };

      await this._apiPost('/crm/v3/objects/tasks', { properties });
    } catch (err) {
      logger.debug(`CRM [${this.name}]: task creation failed: ${err.message}`);
    }
  }

  /**
   * Normalize HubSpot contact to standard format.
   */
  _normalizeContact(record) {
    if (!record) return null;
    const props = record.properties || {};

    return {
      id: record.id,
      name: `${props.firstname || ''} ${props.lastname || ''}`.trim() || '(Unknown)',
      phone: props.phone || props.mobilephone || '',
      email: props.email || '',
      company: props.company || '',
      title: props.jobtitle || '',
      status: props.hs_lead_status || props.lifecyclestage || '',
      objectType: 'Contact',
      crmUrl: record.id ? `https://app.hubspot.com/contacts/${record.id}` : null,
      raw: record,
    };
  }

  // ──────────────────────────────────────────────────────────
  // HTTP helpers
  // ──────────────────────────────────────────────────────────

  /**
   * Get an access token — handles both OAuth and Private App modes.
   */
  async _getToken() {
    if (this.authType === 'oauth2' && this.configId) {
      return oauthManager.getAccessToken(this.configId);
    }
    // Private App / API key mode
    return this.apiToken;
  }

  /**
   * Wrap an API call with auto-refresh for OAuth, or direct call for API key.
   */
  async _withAuth(apiFn) {
    if (this.authType === 'oauth2' && this.configId) {
      return oauthManager.withAutoRefresh(this.configId, apiFn);
    }
    // Private App token — no refresh needed
    const token = this.apiToken;
    if (!token) throw new Error('No HubSpot API token configured');
    return apiFn(token);
  }

  async _apiGet(path) {
    return this._withAuth(async (token) => {
      return this._request('GET', path, null, token);
    });
  }

  async _apiPost(path, body) {
    return this._withAuth(async (token) => {
      return this._request('POST', path, body, token);
    });
  }

  async _apiPatch(path, body) {
    return this._withAuth(async (token) => {
      return this._request('PATCH', path, body, token);
    });
  }

  async _apiPut(path, body) {
    return this._withAuth(async (token) => {
      return this._request('PUT', path, body, token);
    });
  }

  /**
   * Raw HTTPS request to HubSpot API.
   */
  _request(method, path, body, accessToken) {
    return new Promise((resolve, reject) => {
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

      const parsed = new URL(`${API_BASE}${path}`);

      const options = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method,
        headers,
        timeout: 20000,
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 204) return resolve({ success: true });

          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { resolve(data || { success: true }); }
          } else {
            const err = new Error(`HubSpot API ${res.statusCode}: ${data.substring(0, 300)}`);
            err.statusCode = res.statusCode;
            err.status = res.statusCode;

            // Parse HS error for better message
            try {
              const hsErr = JSON.parse(data);
              if (hsErr.message) err.message = `HubSpot: ${hsErr.message}`;
            } catch {}

            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HubSpot request timeout')); });
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
 * Extract value from HubSpot property object { value: '...' }.
 */
function _propVal(prop) {
  if (!prop) return '';
  if (typeof prop === 'string') return prop;
  return prop.value || '';
}

module.exports = HubSpotAdapter;
