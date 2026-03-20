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
    this.tagMap = new Map();    // from-tag -> call-id (for lookup when call-id missing)
  }

  start() {
    this.server = dgram.createSocket('udp4');

    this.server.on('message', (msg, rinfo) => {
      try {
        const raw = msg.toString();
        logger.debug(`DTMF RAW: ${raw}`);

        const data = this._parseBencode(raw);
        if (!data) return;

        const callId = data['call-id'] || data['callid'] || '';
        const event = data['event'] || data['digit'] || '';
        const fromTag = data['source_tag'] || data['source-tag'] || data['from-tag'] || data['tag'] || '';
        const type = data['type'] || '';

        if (type === 'DTMF' || event) {
          const digit = String(event).trim();
          logger.info(`DTMF EVENT: digit=${digit} call-id=${callId} from-tag=${fromTag}`);

          // Try exact call-id match first
          let cb = this.callbacks.get(callId);

          // If call-id is empty or no match, try matching by from-tag
          if (!cb) {
            for (const [registeredCallId, registeredCb] of this.callbacks) {
              // The from-tag from RTPEngine should match one of the tags we know about
              if (fromTag && this.tagMap && this.tagMap.get(fromTag) === registeredCallId) {
                cb = registeredCb;
                break;
              }
            }
          }

          // Last resort: if only one callback is registered, use it
          if (!cb && this.callbacks.size === 1) {
            cb = this.callbacks.values().next().value;
            logger.debug(`DTMF: using single registered handler as fallback`);
          }

          if (cb) {
            cb(digit, fromTag, callId);
          } else {
            logger.debug(`DTMF EVENT: no handler registered for call-id=${callId} from-tag=${fromTag}`);
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
  // Also register from-tag for fallback lookup when RTPEngine sends empty call-id
  register(callId, callback, fromTag) {
    this.callbacks.set(callId, callback);
    if (fromTag) {
      this.tagMap.set(fromTag, callId);
    }
    logger.debug(`DTMF: registered listener for call-id=${callId} from-tag=${fromTag || 'none'}`);
  }

  // Unregister callback
  unregister(callId) {
    this.callbacks.delete(callId);
    // Clean up tagMap entries for this call-id
    for (const [tag, cid] of this.tagMap) {
      if (cid === callId) this.tagMap.delete(tag);
    }
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
