const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ============================================================
// BLF / Presence — SIP SUBSCRIBE/NOTIFY for dialog event package
//
// Tracks extension states: idle, ringing, in-call, on-hold, dnd
// Sends NOTIFY to subscribed phones when state changes.
//
// Flow:
//   1. Phone sends SUBSCRIBE for dialog event package
//   2. We store the subscription and reply 200 + initial NOTIFY
//   3. When extension state changes, send NOTIFY to all subscribers
//   4. Phone sends SUBSCRIBE with Expires: 0 to unsubscribe
//   5. We clean expired subscriptions periodically
// ============================================================

class PresenceHandler {
  constructor(srf, registrar, callHandler) {
    this.srf = srf;
    this.registrar = registrar;
    this.callHandler = callHandler;

    // Extension states: extension -> { state, since, callId, remoteParty }
    // States: 'idle', 'ringing', 'confirmed', 'held', 'dnd'
    this.extensionStates = new Map();

    // Active subscriptions: subscriptionId -> { extension, subscriberUri, subscriberContact,
    //   callId, fromTag, toTag, expires, cseq, dialog }
    this.subscriptions = new Map();

    // Index: extension -> Set of subscriptionIds
    this.extSubscribers = new Map();

    // Clean expired subscriptions every 30s
    this._cleanupInterval = setInterval(() => this._cleanExpired(), 30000);
  }

  // ============================================================
  // SIP SUBSCRIBE handler
  // ============================================================
  async handleSubscribe(req, res) {
    const eventHeader = req.get('Event') || '';
    const from = req.getParsedHeader('From');
    const to = req.getParsedHeader('To');
    const callId = req.get('Call-Id');
    const contactHeader = req.get('Contact');

    // We only handle the dialog event package (BLF)
    if (!eventHeader.startsWith('dialog')) {
      logger.debug(`SUBSCRIBE rejected: unsupported event "${eventHeader}"`);
      return res.send(489); // Bad Event
    }

    // Extract the monitored extension from the Request-URI
    const targetExt = this._extractExt(req.uri);
    if (!targetExt) {
      logger.warn(`SUBSCRIBE rejected: cannot parse extension from ${req.uri}`);
      return res.send(404);
    }

    // Parse expires (0 = unsubscribe)
    let expires = parseInt(req.get('Expires'));
    if (isNaN(expires)) expires = 3600;
    const maxExpires = 3600;
    if (expires > maxExpires) expires = maxExpires;

    const fromTag = from.params && from.params.tag;
    const subscriberUri = from.uri;

    // Check if this is an existing subscription refresh or new
    const existingId = this._findSubscription(callId, fromTag);

    if (expires === 0) {
      // ─── Unsubscribe ───
      if (existingId) {
        const sub = this.subscriptions.get(existingId);
        logger.info(`BLF: ${subscriberUri} unsubscribed from ${targetExt}`);

        // Send final NOTIFY with terminated state
        res.send(200, { headers: { 'Expires': '0' } });

        // Send terminated NOTIFY
        this._sendNotify(existingId, 'terminated', true);

        // Remove subscription
        this._removeSub(existingId);
      } else {
        res.send(200, { headers: { 'Expires': '0' } });
      }
      return;
    }

    // ─── New or refreshed subscription ───
    // Generate To-tag for new subscriptions
    const toTag = (existingId && this.subscriptions.get(existingId).toTag) ||
                  'blf-' + uuidv4().substring(0, 8);

    const subId = existingId || uuidv4();
    const cseq = existingId ? (this.subscriptions.get(existingId).cseq || 0) : 0;

    const subData = {
      extension: targetExt,
      subscriberUri,
      subscriberContact: this._extractContactUri(contactHeader),
      callId,
      fromTag,
      toTag,
      expires: Date.now() + expires * 1000,
      cseq,
      createdAt: existingId ? this.subscriptions.get(existingId).createdAt : Date.now()
    };

    this.subscriptions.set(subId, subData);

    // Add to extension index
    if (!this.extSubscribers.has(targetExt)) {
      this.extSubscribers.set(targetExt, new Set());
    }
    this.extSubscribers.get(targetExt).add(subId);

    logger.info(`BLF: ${subscriberUri} ${existingId ? 'refreshed' : 'subscribed to'} ${targetExt} (expires=${expires}s, subs=${this.extSubscribers.get(targetExt).size})`);

    // Send 200 OK with Expires
    res.send(200, {
      headers: {
        'Expires': String(expires),
        'To': `${to.uri || ''};tag=${toTag}`,
        'Contact': `<sip:${process.env.SIP_DOMAIN || '127.0.0.1'}:${process.env.SIP_PORT || 5060}>`
      }
    });

    // Send immediate NOTIFY with current state
    this._sendNotify(subId, 'active', false);
  }

  // ============================================================
  // State change API — called by CallHandler, HoldHandler, etc.
  // ============================================================

  /**
   * Update extension state and notify all subscribers.
   * @param {string} ext - Extension number
   * @param {string} state - 'idle' | 'ringing' | 'confirmed' | 'held' | 'dnd'
   * @param {object} [meta] - Optional: { callId, remoteParty, direction }
   */
  setState(ext, state, meta) {
    const prev = this.extensionStates.get(ext);
    const prevState = prev ? prev.state : 'idle';

    if (prevState === state && state !== 'idle') return; // No change

    const stateData = {
      state,
      since: Date.now(),
      callId: (meta && meta.callId) || null,
      remoteParty: (meta && meta.remoteParty) || null,
      direction: (meta && meta.direction) || null
    };

    if (state === 'idle') {
      this.extensionStates.delete(ext);
    } else {
      this.extensionStates.set(ext, stateData);
    }

    logger.debug(`BLF: ${ext} state ${prevState} -> ${state}${meta && meta.remoteParty ? ' (' + meta.remoteParty + ')' : ''}`);

    // Notify all subscribers of this extension
    this._notifyAll(ext);
  }

  /**
   * Get current state for an extension.
   */
  getState(ext) {
    return this.extensionStates.get(ext) || { state: 'idle', since: Date.now() };
  }

  /**
   * Get all extension states (for API/dashboard).
   */
  getAllStates() {
    const result = {};
    for (const [ext, data] of this.extensionStates) {
      result[ext] = data;
    }
    return result;
  }

  /**
   * Get subscription stats.
   */
  getStats() {
    return {
      totalSubscriptions: this.subscriptions.size,
      monitoredExtensions: this.extSubscribers.size,
      states: this.getAllStates()
    };
  }

  // ============================================================
  // NOTIFY sender
  // ============================================================

  _notifyAll(ext) {
    const subIds = this.extSubscribers.get(ext);
    if (!subIds || subIds.size === 0) return;

    for (const subId of subIds) {
      this._sendNotify(subId, 'active', false);
    }
  }

  async _sendNotify(subId, subscriptionState, isTerminated) {
    const sub = this.subscriptions.get(subId);
    if (!sub) return;

    const state = this.getState(sub.extension);
    const dialogState = this._mapToDialogState(state.state);

    // Build dialog-info XML (RFC 4235)
    const xml = this._buildDialogInfoXml(sub.extension, state, dialogState, isTerminated);

    // Increment CSeq
    sub.cseq = (sub.cseq || 0) + 1;

    try {
      const target = sub.subscriberContact || sub.subscriberUri;
      if (!target) {
        logger.warn(`BLF NOTIFY: no contact for subscription ${subId}`);
        return;
      }

      const requestUri = target.startsWith('sip:') ? target : `sip:${target}`;
      const domain = process.env.SIP_DOMAIN || '127.0.0.1';
      const port = process.env.SIP_PORT || 5060;

      await this.srf.request(requestUri, {
        method: 'NOTIFY',
        headers: {
          'Call-Id': sub.callId,
          'From': `<sip:${sub.extension}@${domain}>;tag=${sub.toTag}`,
          'To': `<${sub.subscriberUri}>;tag=${sub.fromTag}`,
          'Contact': `<sip:${domain}:${port}>`,
          'Event': 'dialog',
          'Subscription-State': isTerminated
            ? 'terminated;reason=timeout'
            : `active;expires=${Math.max(0, Math.round((sub.expires - Date.now()) / 1000))}`,
          'Content-Type': 'application/dialog-info+xml',
          'CSeq': `${sub.cseq} NOTIFY`
        },
        body: xml
      });

      logger.debug(`BLF NOTIFY sent: ${sub.extension} -> ${sub.subscriberUri} (${state.state})`);
    } catch (err) {
      logger.debug(`BLF NOTIFY failed for ${sub.subscriberUri}: ${err.message}`);
      // If NOTIFY fails repeatedly, the subscription will expire naturally
    }
  }

  // ============================================================
  // Dialog-info XML builder (RFC 4235)
  // ============================================================

  _buildDialogInfoXml(ext, state, dialogState, isTerminated) {
    const domain = process.env.SIP_DOMAIN || '127.0.0.1';
    const entity = `sip:${ext}@${domain}`;
    const version = Math.floor(Date.now() / 1000) % 100000;

    if (state.state === 'idle' || isTerminated) {
      // No active dialog — send empty dialog-info
      return `<?xml version="1.0" encoding="UTF-8"?>\r\n` +
        `<dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info" version="${version}" state="full" entity="${entity}">\r\n` +
        `</dialog-info>\r\n`;
    }

    const callId = state.callId || uuidv4();
    const remoteUri = state.remoteParty ? `sip:${state.remoteParty}@${domain}` : `sip:unknown@${domain}`;
    const direction = state.direction || 'recipient';

    // Map direction to local/remote identity tags
    const localTag = `<local><identity>sip:${ext}@${domain}</identity></local>`;
    const remoteTag = `<remote><identity>${remoteUri}</identity></remote>`;

    return `<?xml version="1.0" encoding="UTF-8"?>\r\n` +
      `<dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info" version="${version}" state="full" entity="${entity}">\r\n` +
      `  <dialog id="${callId}" direction="${direction}">\r\n` +
      `    <state>${dialogState}</state>\r\n` +
      `    ${localTag}\r\n` +
      `    ${remoteTag}\r\n` +
      `  </dialog>\r\n` +
      `</dialog-info>\r\n`;
  }

  /**
   * Map internal states to RFC 4235 dialog states.
   * Dialog states: trying, proceeding, early, confirmed, terminated
   * For BLF on phones:
   *   - idle        -> (no dialog) -> phone LED off
   *   - ringing     -> early       -> phone LED flashing
   *   - confirmed   -> confirmed   -> phone LED solid (in call)
   *   - held        -> confirmed   -> phone LED solid (still in call)
   *   - dnd         -> confirmed   -> phone LED solid
   */
  _mapToDialogState(state) {
    switch (state) {
      case 'ringing':   return 'early';
      case 'confirmed': return 'confirmed';
      case 'held':      return 'confirmed';
      case 'dnd':       return 'confirmed';
      default:          return 'terminated';
    }
  }

  // ============================================================
  // Subscription management helpers
  // ============================================================

  _findSubscription(callId, fromTag) {
    for (const [id, sub] of this.subscriptions) {
      if (sub.callId === callId && sub.fromTag === fromTag) return id;
    }
    return null;
  }

  _removeSub(subId) {
    const sub = this.subscriptions.get(subId);
    if (!sub) return;

    // Remove from extension index
    const subs = this.extSubscribers.get(sub.extension);
    if (subs) {
      subs.delete(subId);
      if (subs.size === 0) this.extSubscribers.delete(sub.extension);
    }

    this.subscriptions.delete(subId);
  }

  _cleanExpired() {
    const now = Date.now();
    const expired = [];
    for (const [id, sub] of this.subscriptions) {
      if (sub.expires <= now) expired.push(id);
    }
    for (const id of expired) {
      const sub = this.subscriptions.get(id);
      logger.debug(`BLF: subscription expired for ${sub.extension} from ${sub.subscriberUri}`);
      this._sendNotify(id, 'terminated', true);
      this._removeSub(id);
    }
  }

  _extractExt(uri) {
    if (!uri) return null;
    const match = uri.match(/sip:(\d+)@/);
    return match ? match[1] : null;
  }

  _extractContactUri(contactHeader) {
    if (!contactHeader) return null;
    const match = contactHeader.match(/<([^>]+)>/);
    return match ? match[1] : contactHeader.split(';')[0].trim();
  }

  // ============================================================
  // Cleanup
  // ============================================================
  destroy() {
    if (this._cleanupInterval) clearInterval(this._cleanupInterval);
  }
}

module.exports = PresenceHandler;
