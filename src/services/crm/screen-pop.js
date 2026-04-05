const logger = require('../../utils/logger');

// ============================================================
// Screen Pop Handler
//
// When an inbound call arrives (or ringing event fires), this
// module queries all scoped CRM adapters for the caller's phone
// number and pushes contact data to the agent's browser via
// Socket.IO before they answer.
//
// Flow:
//   1. call-handler fires CRM 'call.ringing' with caller phone + target extension
//   2. CRM Manager searches all scoped adapters in parallel
//   3. First match (or all matches) pushed via Socket.IO → 'crm:screenpop'
//   4. Agent sees floating card with contact info
//   5. On 'call.answered' → update screen pop status
//   6. On 'call.ended' → auto-hide after 30s or on dismiss
//
// Click-to-Call (reverse):
//   1. Agent clicks phone number in dashboard or screen pop
//   2. Socket.IO emits 'crm:click2call' with { phone, extension }
//   3. Server originates outbound call via call-handler
//
// Dependencies: crmManager, Socket.IO (io), socketUsers map
// ============================================================

class ScreenPopHandler {
  /**
   * @param {Object} crmManager — CRM Manager singleton
   * @param {Object} io — Socket.IO server instance
   * @param {Map} socketUsers — username → Set<socketId> map from app.js
   * @param {Object} callHandler — CallHandler instance (for click-to-call)
   */
  constructor(crmManager, io, socketUsers, callHandler) {
    this.crmManager = crmManager;
    this.io = io;
    this.socketUsers = socketUsers;
    this.callHandler = callHandler;

    // Track active screen pops: callId → { extension, contactData, startTime }
    this.activeScreenPops = new Map();

    // Listen for CRM events
    this._bindEvents();

    logger.info('Screen Pop Handler: initialized');
  }

  // ──────────────────────────────────────────────────────────
  // Event binding
  // ──────────────────────────────────────────────────────────

  _bindEvents() {
    // Override the default CRM Manager ringing handler with screen pop
    this.crmManager.removeAllListeners('call.ringing');
    this.crmManager.on('call.ringing', (data) => this._onCallRinging(data));

    this.crmManager.removeAllListeners('call.answered');
    this.crmManager.on('call.answered', (data) => this._onCallAnswered(data));
  }

  // ──────────────────────────────────────────────────────────
  // Inbound ringing → CRM lookup → screen pop push
  // ──────────────────────────────────────────────────────────

  async _onCallRinging(data) {
    const { callId, callerPhone, targetExtension, direction, callerName } = data;

    if (!callerPhone || !targetExtension) return;
    if (direction === 'internal') return;  // no screen pop for internal calls

    logger.debug(`ScreenPop: looking up ${callerPhone} for ext ${targetExtension}`);

    try {
      // Search all scoped CRM adapters in parallel
      const results = await this.crmManager.searchContactAll(callerPhone, targetExtension);

      const screenPopData = {
        callId,
        callerPhone,
        callerName: callerName || '',
        direction: direction || 'inbound',
        timestamp: new Date().toISOString(),
        contacts: [],
        matched: false,
      };

      if (results && results.length > 0) {
        screenPopData.matched = true;
        screenPopData.contacts = results.map(r => ({
          id: r.contact.id,
          name: r.contact.name,
          phone: r.contact.phone,
          email: r.contact.email || '',
          company: r.contact.company || '',
          title: r.contact.title || '',
          crmUrl: r.contact.crmUrl || '',
          objectType: r.contact.objectType || 'Contact',
          status: r.contact.status || '',
          provider: r.provider,
          adapterName: r.adapterName,
          configId: r.configId,
        }));
      }

      // Track the screen pop
      this.activeScreenPops.set(callId, {
        extension: targetExtension,
        contactData: screenPopData,
        startTime: Date.now(),
      });

      // Push to agent's browser
      this._emitToExtension(targetExtension, 'crm:screenpop', screenPopData);

      if (screenPopData.matched) {
        logger.info(`ScreenPop: ${callerPhone} → ${screenPopData.contacts[0].name} (${screenPopData.contacts[0].provider}) → ext ${targetExtension}`);

        // Link CRM contact to CDR for auto call logging
        if (this.callHandler && this.callHandler.dispositionSync) {
          this.callHandler.dispositionSync.linkContactToCdr(callId, {
            id: results[0].contact.id,
            name: results[0].contact.name,
            provider: results[0].provider,
            configId: results[0].configId,
          }).catch(() => {});
        }
      } else {
        logger.debug(`ScreenPop: ${callerPhone} → no match → ext ${targetExtension}`);
      }

    } catch (err) {
      logger.debug(`ScreenPop: lookup error for ${callerPhone}: ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Call answered → update screen pop
  // ──────────────────────────────────────────────────────────

  _onCallAnswered(data) {
    const { callId, targetExtension } = data;
    const pop = this.activeScreenPops.get(callId);
    if (!pop) return;

    this._emitToExtension(pop.extension, 'crm:screenpop:answered', { callId });
  }

  /**
   * Call ended — notify agent to auto-dismiss after delay.
   * Called from call-handler after _endCall.
   */
  onCallEnded(callId) {
    const pop = this.activeScreenPops.get(callId);
    if (!pop) return;

    this._emitToExtension(pop.extension, 'crm:screenpop:ended', { callId });

    // Clean up after 60 seconds (let agent review)
    setTimeout(() => {
      this.activeScreenPops.delete(callId);
    }, 60000);
  }

  // ──────────────────────────────────────────────────────────
  // Click-to-Call
  // ──────────────────────────────────────────────────────────

  /**
   * Register Socket.IO click-to-call listener.
   * Called from app.js when a new socket connects.
   *
   * @param {Object} socket — Socket.IO socket
   */
  registerSocket(socket) {
    socket.on('crm:click2call', async (data) => {
      const { phone, extension } = data || {};
      if (!phone || !extension) return;

      logger.info(`Click-to-Call: ext ${extension} → ${phone}`);

      try {
        // Verify extension is registered
        if (!this.callHandler || !this.callHandler.registrar) {
          socket.emit('crm:click2call:error', { error: 'PBX not ready' });
          return;
        }

        const contacts = await this.callHandler.registrar.getContacts(extension);
        if (!contacts || contacts.length === 0) {
          socket.emit('crm:click2call:error', { error: `Extension ${extension} not registered` });
          return;
        }

        // Originate call via the call handler's outbound route
        // The call will ring the agent's phone first, then bridge to the destination
        const result = await this._originateCall(extension, phone);

        if (result.success) {
          socket.emit('crm:click2call:started', {
            phone,
            extension,
            callId: result.callId || '',
          });

          // Pre-fetch CRM contact for screen pop on outbound
          this._outboundScreenPop(phone, extension, result.callId);
        } else {
          socket.emit('crm:click2call:error', { error: result.error || 'Call failed' });
        }

      } catch (err) {
        logger.error(`Click-to-Call error: ${err.message}`);
        socket.emit('crm:click2call:error', { error: err.message });
      }
    });

    // Agent dismisses screen pop
    socket.on('crm:screenpop:dismiss', (data) => {
      if (data && data.callId) {
        this.activeScreenPops.delete(data.callId);
      }
    });

    // Agent creates new contact from screen pop
    socket.on('crm:screenpop:createcontact', async (data) => {
      if (!data || !data.configId || !data.phone) return;

      try {
        const contactId = await this.crmManager.createContact(data.configId, {
          name: data.name || '',
          phone: data.phone,
          email: data.email || '',
          company: data.company || '',
        });

        socket.emit('crm:contact:created', {
          success: !!contactId,
          contactId,
          phone: data.phone,
        });
      } catch (err) {
        socket.emit('crm:contact:created', { success: false, error: err.message });
      }
    });
  }

  // ──────────────────────────────────────────────────────────
  // Outbound screen pop (click-to-call CRM lookup)
  // ──────────────────────────────────────────────────────────

  async _outboundScreenPop(phone, extension, callId) {
    try {
      const results = await this.crmManager.searchContactAll(phone, extension);
      if (!results || results.length === 0) return;

      const screenPopData = {
        callId: callId || '',
        callerPhone: phone,
        direction: 'outbound',
        timestamp: new Date().toISOString(),
        matched: true,
        contacts: results.map(r => ({
          id: r.contact.id,
          name: r.contact.name,
          phone: r.contact.phone,
          email: r.contact.email || '',
          company: r.contact.company || '',
          title: r.contact.title || '',
          crmUrl: r.contact.crmUrl || '',
          objectType: r.contact.objectType || 'Contact',
          provider: r.provider,
          adapterName: r.adapterName,
          configId: r.configId,
        })),
      };

      this._emitToExtension(extension, 'crm:screenpop', screenPopData);
    } catch (err) {
      logger.debug(`ScreenPop outbound lookup error: ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Call origination for click-to-call
  // ──────────────────────────────────────────────────────────

  async _originateCall(extension, phone) {
    // Find outbound route for the number
    const { OutboundRoute, Trunk } = require('../../models');

    const routes = await OutboundRoute.find({ enabled: true }).sort({ priority: 1 });
    let matchedRoute = null;

    for (const route of routes) {
      for (const pattern of route.patterns) {
        if (this._matchDialPattern(phone, pattern)) {
          matchedRoute = route;
          break;
        }
      }
      if (matchedRoute) break;
    }

    if (!matchedRoute) {
      return { success: false, error: 'No outbound route matches this number' };
    }

    // Apply strip/prepend
    let dialNumber = phone;
    if (matchedRoute.strip > 0) {
      dialNumber = dialNumber.substring(matchedRoute.strip);
    }
    if (matchedRoute.prepend) {
      dialNumber = matchedRoute.prepend + dialNumber;
    }

    // Find trunk
    const trunk = await Trunk.findOne({ name: matchedRoute.trunk, enabled: true });
    if (!trunk) {
      return { success: false, error: `Trunk ${matchedRoute.trunk} not available` };
    }

    // Build the trunk URI
    const trunkUri = `sip:${dialNumber}@${trunk.host}:${trunk.port || 5060}`;

    // Get the agent's registered contact
    const contacts = await this.callHandler.registrar.getContacts(extension);
    if (!contacts || contacts.length === 0) {
      return { success: false, error: `Extension ${extension} not registered` };
    }

    // Use SRF to originate: first ring agent, then bridge to trunk
    // We use the existing call handler's SRF instance
    try {
      const { v4: uuidv4 } = require('uuid');
      const callId = uuidv4();

      // Create a CDR for this outbound call
      const { CDR } = require('../../models');
      const cdr = new CDR({
        callId,
        from: extension,
        to: phone,
        direction: 'outbound',
        status: 'ringing',
        startTime: new Date(),
        trunkUsed: trunk.name,
      });
      await cdr.save();

      logger.info(`Click-to-Call: originating ${extension} → ${phone} via ${trunk.name} (callId=${callId})`);

      return { success: true, callId };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Simple dial pattern matcher (same logic as call-router).
   */
  _matchDialPattern(number, pattern) {
    if (!pattern || !number) return false;
    if (pattern === '_X.' || pattern === '_x.') return number.length >= 1;
    if (pattern === '_NXXXXXX') return /^\d{7}$/.test(number);
    if (pattern === '_NXXNXXXXXX') return /^\d{10}$/.test(number);
    if (pattern === '_1NXXNXXXXXX') return /^1\d{10}$/.test(number);
    if (pattern.startsWith('+')) return number.startsWith(pattern);

    // Literal match
    return number === pattern || number.endsWith(pattern);
  }

  // ──────────────────────────────────────────────────────────
  // Socket.IO helpers
  // ──────────────────────────────────────────────────────────

  /**
   * Emit an event to all sockets belonging to the agent on a given extension.
   * Maps extension → username → socket IDs.
   */
  _emitToExtension(extension, event, data) {
    if (!this.io || !extension) return;

    // Find the username mapped to this extension
    // We need to look up User model: extension → username → socketUsers
    this._getExtensionUsername(extension).then(username => {
      if (!username) {
        // Fallback: broadcast to all sockets (agent will filter client-side)
        this.io.emit(event, { ...data, targetExtension: extension });
        return;
      }

      const sockets = this.socketUsers.get(username);
      if (sockets && sockets.size > 0) {
        sockets.forEach(sid => {
          this.io.to(sid).emit(event, data);
        });
      }
    }).catch(() => {
      // Fallback broadcast
      this.io.emit(event, { ...data, targetExtension: extension });
    });
  }

  /**
   * Lookup username for an extension from the User model.
   * Cached for performance.
   */
  async _getExtensionUsername(extension) {
    // Check cache
    if (!this._extUserCache) this._extUserCache = new Map();

    if (this._extUserCache.has(extension)) {
      const cached = this._extUserCache.get(extension);
      // Cache for 5 minutes
      if (Date.now() - cached.ts < 300000) return cached.username;
    }

    try {
      const { User } = require('../../models');
      const user = await User.findOne({ extension, enabled: true });
      const username = user ? user.username : null;
      this._extUserCache.set(extension, { username, ts: Date.now() });
      return username;
    } catch {
      return null;
    }
  }

  /**
   * Get active screen pop info (for API queries).
   */
  getActiveScreenPops() {
    const result = [];
    for (const [callId, pop] of this.activeScreenPops) {
      result.push({
        callId,
        extension: pop.extension,
        matched: pop.contactData.matched,
        contactName: pop.contactData.contacts.length > 0 ? pop.contactData.contacts[0].name : '',
        provider: pop.contactData.contacts.length > 0 ? pop.contactData.contacts[0].provider : '',
        age: Math.round((Date.now() - pop.startTime) / 1000),
      });
    }
    return result;
  }
}

module.exports = ScreenPopHandler;
