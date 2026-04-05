const EventEmitter = require('events');
const logger = require('../utils/logger');
const { CrmConfig } = require('../models');
const { decryptObject } = require('./crm/crypto');
const FieldMapper = require('./crm/field-mapper');

// ============================================================
// CRM Manager — Singleton
//
// Central coordinator for all CRM integrations. Loads configured
// adapters from MongoDB on startup, routes PBX call events to
// all active adapters, and handles reconnection / error recovery.
//
// Event Bus:
//   The CRM Manager extends EventEmitter and broadcasts events
//   that any part of the PBX can emit:
//     - 'call.ringing'    → inbound/outbound call started
//     - 'call.answered'   → call was answered
//     - 'call.ended'      → call completed (triggers call logging)
//     - 'call.disposition' → agent set disposition (triggers sync)
//
// Adapter Registry:
//   Each CRM connection (CrmConfig doc) gets a loaded adapter
//   instance. Multiple adapters can be active simultaneously
//   (e.g. Salesforce for sales + HubSpot for marketing).
//
// Scope Filtering:
//   When an event fires, the manager checks which adapters are
//   scoped to the relevant extension/queue/ring group and only
//   routes the event to matching adapters.
// ============================================================

class CrmManager extends EventEmitter {
  constructor() {
    super();
    this.adapters = new Map();       // configId → { adapter, config, fieldMapper }
    this.initialized = false;

    // ── Bind internal event handlers ──
    this.on('call.ringing', (data) => this._handleEvent('call.ringing', data));
    this.on('call.answered', (data) => this._handleEvent('call.answered', data));
    this.on('call.ended', (data) => this._handleCallEnded(data));
    this.on('call.disposition', (data) => this._handleDisposition(data));
  }

  // ──────────────────────────────────────────────────────────
  // Initialization
  // ──────────────────────────────────────────────────────────

  /**
   * Load all enabled CRM configs from MongoDB and connect adapters.
   * Called once during PBX startup from app.js.
   */
  async initialize() {
    try {
      const configs = await CrmConfig.find({ enabled: true });
      logger.info(`CRM Manager: found ${configs.length} enabled CRM configuration(s)`);

      for (const config of configs) {
        try {
          await this._loadAdapter(config);
        } catch (err) {
          logger.error(`CRM Manager: failed to load ${config.name} (${config.provider}): ${err.message}`);
        }
      }

      this.initialized = true;
      logger.info(`CRM Manager: initialized with ${this.adapters.size} active adapter(s)`);
    } catch (err) {
      logger.error(`CRM Manager: initialization failed: ${err.message}`);
      this.initialized = true;  // mark initialized even on error so PBX doesn't block
    }
  }

  // ──────────────────────────────────────────────────────────
  // Adapter management
  // ──────────────────────────────────────────────────────────

  /**
   * Load and connect a single CRM adapter from a CrmConfig document.
   * @param {Object} config — CrmConfig Mongoose document
   */
  async _loadAdapter(config) {
    const AdapterClass = this._getAdapterClass(config.provider);
    if (!AdapterClass) {
      logger.warn(`CRM Manager: no adapter class for provider '${config.provider}'`);
      return;
    }

    // Decrypt credentials
    let credentials = {};
    if (config.credentials) {
      try {
        credentials = decryptObject(config.credentials);
      } catch (err) {
        logger.error(`CRM Manager: cannot decrypt credentials for ${config.name}: ${err.message}`);
        return;
      }
    }

    // Decrypt OAuth tokens if present
    let oauthTokens = null;
    if (config.oauthTokens) {
      try {
        oauthTokens = decryptObject(config.oauthTokens);
      } catch (err) {
        logger.warn(`CRM Manager: cannot decrypt OAuth tokens for ${config.name} — re-auth may be required`);
      }
    }

    // Build adapter config
    const adapterConfig = {
      provider: config.provider,
      name: config.name,
      authType: config.authType,
      credentials,
      oauthTokens,
      instanceUrl: config.instanceUrl,
      webhookUrl: config.webhookUrl,
      fieldMapping: config.fieldMapping,
      syncOptions: config.syncOptions,
      scope: config.scope,
      configId: config._id.toString(),
    };

    const adapter = new AdapterClass(adapterConfig);
    const fieldMapper = new FieldMapper(config.provider, config.fieldMapping);

    // Attempt connection
    try {
      const connected = await adapter.connect();
      if (connected) {
        config.connectedAt = new Date();
        config.lastError = '';
        config.errorCount = 0;
        await config.save();
        logger.info(`CRM Manager: connected ${config.name} (${config.provider})`);
      }
    } catch (err) {
      logger.error(`CRM Manager: connect failed for ${config.name}: ${err.message}`);
      config.lastError = err.message;
      config.errorCount = (config.errorCount || 0) + 1;
      await config.save();
    }

    this.adapters.set(config._id.toString(), { adapter, config, fieldMapper });
  }

  /**
   * Resolve the adapter class for a given provider.
   * Adapters are lazy-loaded to avoid requiring all CRM modules at startup.
   * @param {string} provider
   * @returns {Function|null} — adapter class constructor
   */
  _getAdapterClass(provider) {
    try {
      switch (provider) {
        case 'salesforce':  return require('./crm/salesforce');
        case 'hubspot':     return require('./crm/hubspot');
        case 'zoho':        return require('./crm/zoho');
        case 'freshsales':  return require('./crm/freshsales');
        case 'pipedrive':   return require('./crm/pipedrive');
        case 'webhook':     return require('./crm/webhook');
        default:            return null;
      }
    } catch (err) {
      // Adapter file doesn't exist yet — that's fine during phased build
      logger.debug(`CRM Manager: adapter '${provider}' not yet implemented (${err.message})`);
      return null;
    }
  }

  /**
   * Add a new CRM connection at runtime (from admin UI).
   * @param {string} configId — CrmConfig document _id
   */
  async addConnection(configId) {
    const config = await CrmConfig.findById(configId);
    if (!config) throw new Error(`CRM config ${configId} not found`);

    // Remove existing adapter if re-adding
    if (this.adapters.has(configId)) {
      await this.removeConnection(configId);
    }

    await this._loadAdapter(config);
  }

  /**
   * Remove a CRM connection at runtime.
   * @param {string} configId
   */
  async removeConnection(configId) {
    const entry = this.adapters.get(configId);
    if (entry) {
      try {
        await entry.adapter.disconnect();
      } catch (e) {
        logger.debug(`CRM Manager: disconnect error for ${configId}: ${e.message}`);
      }
      this.adapters.delete(configId);
      logger.info(`CRM Manager: removed connection ${configId}`);
    }
  }

  /**
   * Reload a CRM connection (e.g. after config change in admin UI).
   * @param {string} configId
   */
  async reloadConnection(configId) {
    await this.removeConnection(configId);
    await this.addConnection(configId);
  }

  // ──────────────────────────────────────────────────────────
  // Event routing
  // ──────────────────────────────────────────────────────────

  /**
   * Generic event handler — logs and routes to adapters.
   * Currently a no-op for ringing/answered events; adapters
   * will use these in Phase 8 (screen pop).
   */
  _handleEvent(eventName, data) {
    const scoped = this._getScopedAdapters(data.extension || data.agent || data.from);
    for (const { adapter } of scoped) {
      logger.debug(`CRM [${adapter.name}]: received ${eventName} for ${data.callId || 'unknown'}`);
    }
  }

  /**
   * Handle call.ended — auto-log the call to all scoped CRM adapters.
   * @param {Object} data — call data from CDR
   */
  async _handleCallEnded(data) {
    const scoped = this._getScopedAdapters(data.agent || data.from);
    if (scoped.length === 0) return;

    for (const { adapter, fieldMapper, config } of scoped) {
      // Skip if call logging is disabled for this CRM
      if (config.syncOptions && !config.syncOptions.calls) continue;

      try {
        const mappedData = fieldMapper.mapCallData(data);
        const activityId = await adapter.logCall({ ...data, _mapped: mappedData });

        if (activityId) {
          logger.info(`CRM [${adapter.name}]: logged call ${data.callId} → activity ${activityId}`);

          // Update CrmConfig last sync
          await CrmConfig.updateOne(
            { _id: config._id },
            { lastSync: new Date(), lastError: '', updatedAt: new Date() }
          );
        }
      } catch (err) {
        logger.error(`CRM [${adapter.name}]: logCall failed for ${data.callId}: ${err.message}`);
        await CrmConfig.updateOne(
          { _id: config._id },
          { lastError: err.message, $inc: { errorCount: 1 }, updatedAt: new Date() }
        );
      }
    }
  }

  /**
   * Handle call.disposition — sync disposition to all scoped CRM adapters.
   * @param {Object} data — { callId, disposition, extra }
   */
  async _handleDisposition(data) {
    const scoped = this._getScopedAdapters(data.agent || data.extension);
    if (scoped.length === 0) return;

    for (const { adapter, config } of scoped) {
      if (config.syncOptions && !config.syncOptions.dispositions) continue;

      try {
        await adapter.syncDisposition(data.callId, data.disposition, data.extra);
        logger.info(`CRM [${adapter.name}]: synced disposition '${data.disposition}' for ${data.callId}`);
      } catch (err) {
        logger.error(`CRM [${adapter.name}]: syncDisposition failed: ${err.message}`);
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // Scope filtering
  // ──────────────────────────────────────────────────────────

  /**
   * Get adapters scoped to a specific extension.
   * If an adapter has allExtensions=true, it matches everything.
   * Otherwise, the extension must be in the adapter's scope list.
   *
   * @param {string} extension — extension number or agent identifier
   * @returns {Array<{adapter, config, fieldMapper}>}
   */
  _getScopedAdapters(extension) {
    const result = [];
    for (const [id, entry] of this.adapters) {
      if (!entry.adapter.connected) continue;

      const scope = entry.config.scope || {};

      // allExtensions = true → matches everything
      if (scope.allExtensions !== false) {
        result.push(entry);
        continue;
      }

      // Check if extension is in the scoped list
      const exts = scope.extensions || [];
      if (extension && exts.includes(extension)) {
        result.push(entry);
      }
    }
    return result;
  }

  // ──────────────────────────────────────────────────────────
  // Public API — called by other PBX modules
  // ──────────────────────────────────────────────────────────

  /**
   * Search for a contact across all scoped CRM adapters (for screen pop).
   * Returns the first match found.
   *
   * @param {string} phone — caller phone number
   * @param {string} [extension] — agent extension (for scope filtering)
   * @returns {Promise<Object|null>} — { contact, provider, configId } or null
   */
  async searchContact(phone, extension) {
    const scoped = this._getScopedAdapters(extension);
    if (scoped.length === 0) return null;

    // Race all adapters — first match wins
    const promises = scoped.map(async ({ adapter, config }) => {
      if (config.syncOptions && !config.syncOptions.contacts) return null;
      try {
        const contact = await adapter.searchContact(phone);
        if (contact) {
          return {
            contact,
            provider: adapter.provider,
            adapterName: adapter.name,
            configId: config._id.toString()
          };
        }
      } catch (err) {
        logger.debug(`CRM [${adapter.name}]: searchContact error: ${err.message}`);
      }
      return null;
    });

    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) return r.value;
    }
    return null;
  }

  /**
   * Search ALL adapters and return combined results (for multi-CRM screen pop).
   * @param {string} phone
   * @param {string} [extension]
   * @returns {Promise<Array>} — array of { contact, provider, adapterName, configId }
   */
  async searchContactAll(phone, extension) {
    const scoped = this._getScopedAdapters(extension);
    if (scoped.length === 0) return [];

    const promises = scoped.map(async ({ adapter, config }) => {
      if (config.syncOptions && !config.syncOptions.contacts) return null;
      try {
        const contact = await adapter.searchContact(phone);
        if (contact) {
          return {
            contact,
            provider: adapter.provider,
            adapterName: adapter.name,
            configId: config._id.toString()
          };
        }
      } catch (err) {
        logger.debug(`CRM [${adapter.name}]: searchContact error: ${err.message}`);
      }
      return null;
    });

    const results = await Promise.allSettled(promises);
    return results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
  }

  /**
   * Create a new contact in a specific CRM adapter.
   * @param {string} configId — CrmConfig _id
   * @param {Object} data — { name, phone, email, company }
   * @returns {Promise<string|null>} — CRM contact ID
   */
  async createContact(configId, data) {
    const entry = this.adapters.get(configId);
    if (!entry) throw new Error(`CRM adapter ${configId} not loaded`);

    const mapped = entry.fieldMapper.mapContactData(data);
    return entry.adapter.createContact({ ...data, _mapped: mapped });
  }

  /**
   * Pull leads from a CRM list for dialer import.
   * @param {string} configId — CrmConfig _id
   * @param {string} listId — CRM list/campaign ID
   * @returns {Promise<Array>}
   */
  async getLeadsByList(configId, listId) {
    const entry = this.adapters.get(configId);
    if (!entry) throw new Error(`CRM adapter ${configId} not loaded`);
    return entry.adapter.getLeadsByList(listId);
  }

  // ──────────────────────────────────────────────────────────
  // Status / dashboard
  // ──────────────────────────────────────────────────────────

  /**
   * Get status of all loaded adapters (for admin dashboard).
   * @returns {Array<Object>}
   */
  getStatus() {
    const result = [];
    for (const [configId, { adapter, config }] of this.adapters) {
      result.push({
        configId,
        ...adapter.getStatus(),
        syncOptions: config.syncOptions,
        scope: config.scope,
        lastSync: config.lastSync,
        lastError: config.lastError,
      });
    }
    return result;
  }

  /**
   * Get count of active (connected) adapters.
   * @returns {number}
   */
  getActiveCount() {
    let count = 0;
    for (const [, { adapter }] of this.adapters) {
      if (adapter.connected) count++;
    }
    return count;
  }

  /**
   * Shutdown — disconnect all adapters.
   */
  async shutdown() {
    logger.info('CRM Manager: shutting down...');
    for (const [id, { adapter }] of this.adapters) {
      try {
        await adapter.disconnect();
      } catch (e) {
        logger.debug(`CRM Manager: disconnect error during shutdown: ${e.message}`);
      }
    }
    this.adapters.clear();
    this.removeAllListeners();
    logger.info('CRM Manager: shutdown complete');
  }
}

// ── Singleton ──
const crmManager = new CrmManager();

module.exports = crmManager;
