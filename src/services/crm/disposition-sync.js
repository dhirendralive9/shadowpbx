const logger = require('../../utils/logger');
const { CDR } = require('../../models');

// ============================================================
// Disposition Sync Service
//
// Manages the bidirectional sync between ShadowPBX call
// dispositions and CRM activity records.
//
// Auto Call Logging:
//   When a call ends, the CRM Manager fires call.ended →
//   each scoped adapter.logCall() creates an activity in the CRM.
//   This service stores the returned CRM activity IDs on the CDR
//   record for future reference.
//
// Disposition Sync:
//   When an agent sets a disposition in the ShadowPBX CDR view,
//   this service pushes the disposition to all CRM adapters that
//   logged the call. It also handles special dispositions:
//     - 'callback' → creates follow-up task in CRM
//     - 'dnc' → updates CRM contact to Do Not Contact
//
// Screen Pop Contact Linking:
//   When a screen pop matches a CRM contact, the contact ID is
//   stored on the CDR. When the call is logged to CRM, the
//   adapter uses this contact ID to link the activity.
//
// Recording URL:
//   After the recorder-worker converts pcap → WAV, the recording
//   path is available on the CDR. The call logging includes this
//   URL so the CRM activity links to the recording.
// ============================================================

class DispositionSync {
  /**
   * @param {Object} crmManager — CRM Manager singleton
   */
  constructor(crmManager) {
    this.crmManager = crmManager;

    // Replace the default call.ended handler with our enhanced version
    this.crmManager.removeAllListeners('call.ended');
    this.crmManager.on('call.ended', (data) => this._handleCallEnded(data));

    // Replace the default call.disposition handler
    this.crmManager.removeAllListeners('call.disposition');
    this.crmManager.on('call.disposition', (data) => this._handleDisposition(data));

    logger.info('Disposition Sync: initialized');
  }

  // ──────────────────────────────────────────────────────────
  // Auto call logging with CDR linking
  // ──────────────────────────────────────────────────────────

  /**
   * Enhanced call.ended handler that stores CRM activity IDs on the CDR.
   */
  async _handleCallEnded(data) {
    const scoped = this.crmManager._getScopedAdapters(data.agent || data.from);
    if (scoped.length === 0) return;

    // Build recording URL if we have a path
    const recordingUrl = this._buildRecordingUrl(data);

    // Look up CRM contact ID from CDR (set by screen pop)
    let contactId = data.contactId || '';
    let cdr = null;
    try {
      cdr = await CDR.findOne({ callId: data.callId });
      if (cdr && cdr.crmContactId) contactId = cdr.crmContactId;
    } catch (e) {}

    const activityIds = {};

    for (const { adapter, fieldMapper, config } of scoped) {
      if (config.syncOptions && !config.syncOptions.calls) continue;

      try {
        const callData = {
          ...data,
          recordingUrl: recordingUrl || data.recordingUrl || '',
          contactId,
          _mapped: fieldMapper.mapCallData(data),
        };

        const activityId = await adapter.logCall(callData);

        if (activityId) {
          activityIds[adapter.provider] = activityId;
          logger.info(`DispositionSync [${adapter.name}]: logged call ${data.callId} → ${activityId}`);

          // Update CrmConfig last sync
          const { CrmConfig } = require('../../models');
          await CrmConfig.updateOne(
            { _id: config._id },
            { lastSync: new Date(), lastError: '', updatedAt: new Date() }
          );
        }
      } catch (err) {
        logger.error(`DispositionSync [${adapter.name}]: logCall failed: ${err.message}`);
        const { CrmConfig } = require('../../models');
        await CrmConfig.updateOne(
          { _id: config._id },
          { lastError: err.message, $inc: { errorCount: 1 }, updatedAt: new Date() }
        );
      }
    }

    // Store CRM activity IDs on the CDR
    if (cdr && Object.keys(activityIds).length > 0) {
      try {
        cdr.crmActivityIds = { ...(cdr.crmActivityIds || {}), ...activityIds };
        await cdr.save();
        logger.debug(`DispositionSync: saved activity IDs on CDR ${data.callId}: ${JSON.stringify(activityIds)}`);
      } catch (e) {
        logger.debug(`DispositionSync: CDR activity ID save error: ${e.message}`);
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // Disposition sync to CRM
  // ──────────────────────────────────────────────────────────

  /**
   * Push disposition to all CRM adapters that logged this call.
   * Called when agent sets disposition in CDR view.
   *
   * @param {Object} data — { callId, disposition, agent, extension, extra }
   */
  async _handleDisposition(data) {
    const { callId, disposition, extra } = data;
    if (!callId || !disposition) return;

    const scoped = this.crmManager._getScopedAdapters(data.agent || data.extension);
    if (scoped.length === 0) return;

    for (const { adapter, config } of scoped) {
      if (config.syncOptions && !config.syncOptions.dispositions) continue;

      try {
        const success = await adapter.syncDisposition(callId, disposition, extra);
        if (success) {
          logger.info(`DispositionSync [${adapter.name}]: synced '${disposition}' for ${callId}`);
        }
      } catch (err) {
        logger.error(`DispositionSync [${adapter.name}]: syncDisposition failed: ${err.message}`);
      }
    }

    // Handle special dispositions locally
    await this._handleSpecialDisposition(callId, disposition, extra);
  }

  /**
   * Push a disposition for a specific call.
   * Called directly from the API endpoint.
   *
   * @param {string} callId — CDR callId
   * @param {string} disposition — disposition value
   * @param {Object} [extra] — { callbackTime, notes }
   */
  async syncDisposition(callId, disposition, extra) {
    // Look up CDR to find the agent extension
    let agent = '';
    try {
      const cdr = await CDR.findOne({ callId });
      if (cdr) {
        agent = cdr.direction === 'outbound' ? cdr.from : cdr.to;
      }
    } catch (e) {}

    // Emit to CRM event bus
    this.crmManager.emit('call.disposition', {
      callId,
      disposition,
      agent,
      extension: agent,
      extra: extra || {},
    });
  }

  // ──────────────────────────────────────────────────────────
  // Special dispositions
  // ──────────────────────────────────────────────────────────

  /**
   * Handle dispositions that need local PBX actions.
   */
  async _handleSpecialDisposition(callId, disposition, extra) {
    try {
      const cdr = await CDR.findOne({ callId });
      if (!cdr) return;

      if (disposition === 'dnc') {
        // Add caller to DNC list
        const callerPhone = cdr.direction === 'inbound' ? cdr.from : cdr.to;
        if (callerPhone) {
          const { DNC } = require('../../models');
          await DNC.findOneAndUpdate(
            { phone: callerPhone },
            {
              phone: callerPhone,
              reason: `Disposition set by agent on call ${callId}`,
              source: 'agent',
              addedBy: cdr.direction === 'outbound' ? cdr.from : cdr.to,
            },
            { upsert: true }
          );
          logger.info(`DispositionSync: added ${callerPhone} to DNC list`);
        }
      }

      if (disposition === 'callback' && extra && extra.callbackTime) {
        // If this is a dialer lead, update the lead callback time
        if (cdr.leadId) {
          const { Lead } = require('../../models');
          await Lead.updateOne(
            { _id: cdr.leadId },
            {
              disposition: 'callback',
              callbackTime: new Date(extra.callbackTime),
              status: 'scheduled',
              nextAttempt: new Date(extra.callbackTime),
            }
          );
          logger.info(`DispositionSync: scheduled callback for lead ${cdr.leadId}`);
        }
      }
    } catch (err) {
      logger.debug(`DispositionSync: special disposition error: ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Screen pop → CDR contact linking
  // ──────────────────────────────────────────────────────────

  /**
   * Store CRM contact info on the CDR when screen pop matches.
   * Called from ScreenPopHandler after a successful lookup.
   *
   * @param {string} callId — SIP Call-ID
   * @param {Object} contactData — { id, name, provider, configId }
   */
  async linkContactToCdr(callId, contactData) {
    if (!callId || !contactData) return;

    try {
      // Find CDR by SIP callId (stored as sipCallId) or by callId
      const cdr = await CDR.findOne({
        $or: [{ callId }, { sipCallId: callId }]
      });

      if (cdr) {
        cdr.crmContactId = contactData.id || '';
        cdr.crmContactName = contactData.name || '';
        cdr.crmProvider = contactData.provider || '';
        await cdr.save();
        logger.debug(`DispositionSync: linked contact ${contactData.name} to CDR ${cdr.callId}`);
      }
    } catch (err) {
      logger.debug(`DispositionSync: contact link error: ${err.message}`);
    }
  }

  // ──────────────────────────────────────────────────────────
  // Recording URL builder
  // ──────────────────────────────────────────────────────────

  /**
   * Build a public recording URL from CDR recording path.
   */
  _buildRecordingUrl(data) {
    if (data.recordingUrl) return data.recordingUrl;

    const recordingPath = data.recordingPath || '';
    if (!recordingPath) return '';

    // Build URL from PBX base URL
    const baseUrl = process.env.WEBHOOK_BASE_URL || process.env.PBX_URL || '';
    if (!baseUrl) return '';

    // Recording served via /api/cdr/:callId/recording
    return `${baseUrl.replace(/\/$/, '')}/api/cdr/${data.callId}/recording`;
  }
}

module.exports = DispositionSync;
