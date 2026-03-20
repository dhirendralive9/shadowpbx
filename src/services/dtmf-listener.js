const dgram = require('dgram');
const logger = require('../utils/logger');

// ============================================================
// DTMF Listener
//
// RTPEngine can detect RFC 2833/4733 DTMF events in the RTP stream
// and send notifications to a UDP destination via --dtmf-log-dest.
//
// The notification format is bencode (used by the ng protocol):
// d8:call-id36:xxxxx...8:from-tag8:xxxxx...5:event1:14:typee
//
// This service listens for those notifications and dispatches
// them to registered callbacks keyed by call-id.
// ============================================================

class DtmfListener {
  constructor(port, host) {
    this.port = port || parseInt(process.env.DTMF_LISTEN_PORT) || 22223;
    this.host = host || '127.0.0.1';
    this.server = null;
    this.callbacks = new Map(); // call-id -> callback function
  }

  start() {
    this.server = dgram.createSocket('udp4');

    this.server.on('message', (msg, rinfo) => {
      try {
        const data = this._parseBencode(msg.toString());
        if (!data) return;

        const callId = data['call-id'] || '';
        const event = data['event'] || data['digit'] || '';
        const fromTag = data['source_tag'] || data['from-tag'] || data['tag'] || '';
        const type = data['type'] || '';

        if (type === 'DTMF' || event) {
          const digit = String(event).trim();
          logger.info(`DTMF EVENT: digit=${digit} call-id=${callId} from-tag=${fromTag}`);

          // Dispatch to registered callback
          const cb = this.callbacks.get(callId);
          if (cb) {
            cb(digit, fromTag, callId);
          } else {
            logger.debug(`DTMF EVENT: no handler registered for call-id ${callId}`);
          }
        }
      } catch (err) {
        logger.debug(`DTMF listener parse error: ${err.message}`);
      }
    });

    this.server.on('error', (err) => {
      logger.error(`DTMF listener error: ${err.message}`);
    });

    this.server.bind(this.port, this.host, () => {
      logger.info(`DTMF listener started on ${this.host}:${this.port}`);
    });
  }

  // Register a callback for DTMF events on a specific call-id
  register(callId, callback) {
    this.callbacks.set(callId, callback);
    logger.debug(`DTMF: registered listener for call-id ${callId}`);
  }

  // Unregister callback
  unregister(callId) {
    this.callbacks.delete(callId);
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // ============================================================
  // Parse bencode format from RTPEngine DTMF notifications
  //
  // RTPEngine sends DTMF events in bencode dictionary format:
  // d8:call-id36:uuid...5:event1:14:type4:DTMFe
  //
  // Also try JSON format as some versions may use it.
  // ============================================================
  _parseBencode(str) {
    // Try JSON first (some RTPEngine versions)
    try {
      if (str.startsWith('{')) {
        return JSON.parse(str);
      }
    } catch (e) {}

    // Try bencode
    if (!str.startsWith('d') || !str.endsWith('e')) {
      // Not a bencode dictionary — try to extract key info with regex
      return this._parseRaw(str);
    }

    try {
      const result = {};
      let pos = 1; // skip 'd'

      while (pos < str.length - 1) {
        // Parse key (string)
        const keyMatch = str.substring(pos).match(/^(\d+):/);
        if (!keyMatch) break;

        const keyLen = parseInt(keyMatch[1]);
        pos += keyMatch[0].length;
        const key = str.substring(pos, pos + keyLen);
        pos += keyLen;

        // Parse value
        if (str[pos] === 'i') {
          // Integer: i<number>e
          const endIdx = str.indexOf('e', pos + 1);
          result[key] = parseInt(str.substring(pos + 1, endIdx));
          pos = endIdx + 1;
        } else if (str[pos] >= '0' && str[pos] <= '9') {
          // String: <length>:<data>
          const valMatch = str.substring(pos).match(/^(\d+):/);
          if (!valMatch) break;
          const valLen = parseInt(valMatch[1]);
          pos += valMatch[0].length;
          result[key] = str.substring(pos, pos + valLen);
          pos += valLen;
        } else {
          break;
        }
      }

      return Object.keys(result).length > 0 ? result : null;
    } catch (e) {
      return this._parseRaw(str);
    }
  }

  // Fallback: try to extract call-id and event from raw string
  _parseRaw(str) {
    const callIdMatch = str.match(/call-id[:\s]*([^\s,}]+)/i);
    const eventMatch = str.match(/event[:\s]*(\d+)/i) || str.match(/digit[:\s]*(\d+)/i);
    const tagMatch = str.match(/(?:source_tag|from-tag)[:\s]*([^\s,}]+)/i);

    if (callIdMatch && eventMatch) {
      return {
        'call-id': callIdMatch[1],
        'event': eventMatch[1],
        'from-tag': tagMatch ? tagMatch[1] : '',
        'type': 'DTMF'
      };
    }
    return null;
  }
}

module.exports = DtmfListener;
