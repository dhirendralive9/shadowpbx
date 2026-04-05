const logger = require('../../utils/logger');

// ============================================================
// Base CRM Adapter — Abstract Interface
//
// Every CRM adapter (Salesforce, HubSpot, Zoho, etc.) extends
// this class and implements the standard methods. The PBX never
// calls a CRM directly — it calls crm.logCall() and the adapter
// handles the rest.
//
// Methods that are not supported by a specific CRM should return
// a no-op result (null, false, or empty array) rather than throw.
//
// Lifecycle:
//   new Adapter(config) → connect() → [operations] → disconnect()
// ============================================================

class BaseCrmAdapter {
  /**
   * @param {Object} config — CRM configuration from MongoDB CrmConfig document
   * @param {string} config.provider — e.g. 'salesforce', 'hubspot', 'zoho'
   * @param {string} config.name — friendly name
   * @param {string} config.authType — 'oauth2', 'apikey', 'bearer'
   * @param {Object} config.credentials — decrypted API keys / tokens
   * @param {Object} config.fieldMapping — ShadowPBX → CRM field map
   * @param {Object} config.syncOptions — what to sync
   * @param {string} config.instanceUrl — CRM instance URL
   */
  constructor(config) {
    if (new.target === BaseCrmAdapter) {
      throw new Error('BaseCrmAdapter is abstract — extend it, do not instantiate directly');
    }
    this.provider = config.provider || 'unknown';
    this.name = config.name || this.provider;
    this.config = config;
    this.connected = false;
    this.lastApiCall = null;
    this.errorCount = 0;
  }

  // ──────────────────────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────────────────────

  /**
   * Authenticate and establish connection to the CRM.
   * @returns {Promise<boolean>} true if connected successfully
   */
  async connect() {
    throw new Error(`${this.provider}: connect() not implemented`);
  }

  /**
   * Clean up — revoke tokens, close connections.
   */
  async disconnect() {
    this.connected = false;
    logger.info(`CRM [${this.name}]: disconnected`);
  }

  /**
   * Test the connection by making a lightweight API call.
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async testConnection() {
    throw new Error(`${this.provider}: testConnection() not implemented`);
  }

  // ──────────────────────────────────────────────────────────
  // Contact operations
  // ──────────────────────────────────────────────────────────

  /**
   * Search for a contact by phone number (for screen pop).
   * @param {string} phone — phone number to search
   * @returns {Promise<Object|null>} — normalized contact object or null
   *   { id, name, company, email, phone, title, crmUrl, raw }
   */
  async searchContact(phone) {
    logger.debug(`CRM [${this.name}]: searchContact() not implemented`);
    return null;
  }

  /**
   * Get full contact details by CRM contact ID.
   * @param {string} id — CRM-specific contact ID
   * @returns {Promise<Object|null>} — normalized contact object or null
   */
  async getContact(id) {
    logger.debug(`CRM [${this.name}]: getContact() not implemented`);
    return null;
  }

  /**
   * Create a new contact in the CRM.
   * @param {Object} data — { name, phone, email, company }
   * @returns {Promise<string|null>} — CRM contact ID or null
   */
  async createContact(data) {
    logger.debug(`CRM [${this.name}]: createContact() not implemented`);
    return null;
  }

  // ──────────────────────────────────────────────────────────
  // Call logging
  // ──────────────────────────────────────────────────────────

  /**
   * Log a completed call as an activity/task in the CRM.
   * @param {Object} callData
   * @param {string} callData.callId — ShadowPBX CDR callId
   * @param {string} callData.from — caller extension or phone
   * @param {string} callData.to — callee extension or phone
   * @param {string} callData.direction — 'inbound', 'outbound', 'internal'
   * @param {number} callData.duration — total seconds
   * @param {number} callData.talkTime — talk seconds
   * @param {string} callData.disposition — agent-set disposition
   * @param {string} callData.notes — agent notes
   * @param {string} callData.recordingUrl — URL to recording WAV
   * @param {string} callData.agent — agent extension
   * @param {Date}   callData.startTime — call start timestamp
   * @param {Date}   callData.endTime — call end timestamp
   * @param {string} callData.contactId — CRM contact ID (if known from screen pop)
   * @returns {Promise<string|null>} — CRM activity/task ID or null
   */
  async logCall(callData) {
    logger.debug(`CRM [${this.name}]: logCall() not implemented`);
    return null;
  }

  // ──────────────────────────────────────────────────────────
  // Lead operations
  // ──────────────────────────────────────────────────────────

  /**
   * Create a new lead from an inbound call (unknown caller).
   * @param {Object} data — { name, phone, company, source }
   * @returns {Promise<string|null>} — CRM lead ID or null
   */
  async createLead(data) {
    logger.debug(`CRM [${this.name}]: createLead() not implemented`);
    return null;
  }

  /**
   * Update a lead's status or custom fields.
   * @param {string} id — CRM lead ID
   * @param {Object} data — field updates
   * @returns {Promise<boolean>}
   */
  async updateLead(id, data) {
    logger.debug(`CRM [${this.name}]: updateLead() not implemented`);
    return false;
  }

  /**
   * Pull leads from a CRM list/campaign for dialer import.
   * @param {string} listId — CRM list/campaign ID
   * @returns {Promise<Array>} — array of { phone, name, company, email, customFields }
   */
  async getLeadsByList(listId) {
    logger.debug(`CRM [${this.name}]: getLeadsByList() not implemented`);
    return [];
  }

  // ──────────────────────────────────────────────────────────
  // Disposition sync
  // ──────────────────────────────────────────────────────────

  /**
   * Push call disposition back to the CRM.
   * @param {string} callId — ShadowPBX CDR callId
   * @param {string} disposition — e.g. 'interested', 'callback', 'dnc'
   * @param {Object} [extra] — optional extra data (callback time, notes)
   * @returns {Promise<boolean>}
   */
  async syncDisposition(callId, disposition, extra) {
    logger.debug(`CRM [${this.name}]: syncDisposition() not implemented`);
    return false;
  }

  // ──────────────────────────────────────────────────────────
  // Discovery / metadata
  // ──────────────────────────────────────────────────────────

  /**
   * Discover CRM custom fields for field mapping UI.
   * @returns {Promise<Array>} — array of { name, label, type }
   */
  async getCustomFields() {
    logger.debug(`CRM [${this.name}]: getCustomFields() not implemented`);
    return [];
  }

  // ──────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────

  /**
   * Mark a successful API call (resets error count).
   */
  _apiSuccess() {
    this.lastApiCall = new Date();
    this.errorCount = 0;
  }

  /**
   * Mark a failed API call (increments error count).
   * @param {string} method — which method failed
   * @param {Error} err
   */
  _apiError(method, err) {
    this.errorCount++;
    this.lastApiCall = new Date();
    logger.error(`CRM [${this.name}] ${method}: ${err.message} (errors: ${this.errorCount})`);
  }

  /**
   * Get adapter status for dashboard display.
   * @returns {Object}
   */
  getStatus() {
    return {
      provider: this.provider,
      name: this.name,
      connected: this.connected,
      lastApiCall: this.lastApiCall,
      errorCount: this.errorCount
    };
  }
}

module.exports = BaseCrmAdapter;
