const https = require('https');
const logger = require('../utils/logger');

// ============================================================
// Carrier Adapters for AMD-enabled outbound calling
//
// When AMD is enabled on a campaign, the dialer uses the carrier's
// REST API to originate calls instead of raw SIP. The carrier
// handles AMD and sends a webhook with the result.
//
// Supported carriers:
//   - Telnyx (Call Control API v2)
//   - SignalWire (Compatibility API — Twilio-compatible)
//   - Twilio (REST API)
//
// Each adapter implements:
//   - createCall(phone, callerId, webhookUrl, options) → callSid
//   - hangupCall(callSid)
// ============================================================

class CarrierAdapter {
  constructor(carrier, credentials) {
    this.carrier = carrier;
    this.credentials = credentials;
  }

  async createCall(phone, callerId, webhookUrl, options) {
    throw new Error('Not implemented');
  }

  async hangupCall(callSid) {
    throw new Error('Not implemented');
  }
}

// ============================================================
// TELNYX — Call Control API v2
//
// Env vars:
//   TELNYX_API_KEY — API key from Telnyx portal
//   TELNYX_CONNECTION_ID — Call Control connection ID
// ============================================================
class TelnyxAdapter extends CarrierAdapter {
  constructor() {
    super('telnyx', {
      apiKey: process.env.TELNYX_API_KEY || '',
      connectionId: process.env.TELNYX_CONNECTION_ID || ''
    });
  }

  async createCall(phone, callerId, webhookUrl, options = {}) {
    const { amd, amdAction, ringTimeout, callId } = options;

    const body = {
      connection_id: this.credentials.connectionId,
      to: phone.startsWith('+') ? phone : `+1${phone}`,
      from: callerId.startsWith('+') ? callerId : `+1${callerId}`,
      webhook_url: webhookUrl,
      webhook_url_method: 'POST',
      timeout_secs: ringTimeout || 30,
      client_state: Buffer.from(JSON.stringify({ callId: callId || '' })).toString('base64')
    };

    // AMD configuration
    if (amd) {
      body.answering_machine_detection = 'detect_words';
      body.answering_machine_detection_config = {
        total_analysis_time_millis: 5000,
        after_greeting_silence_millis: 1000,
        between_words_silence_millis: 500,
        greeting_duration_millis: 3500,
        initial_silence_millis: 3500,
        maximum_number_of_words: 5,
        maximum_word_length_millis: 3500,
        silence_threshold: 256
      };
    }

    const result = await this._request('POST', '/v2/calls', body);
    const sid = result.data ? result.data.call_control_id : '';
    logger.info(`TELNYX: call created to ${phone} callControlId=${sid} amd=${!!amd}`);
    return sid;
  }

  async hangupCall(callSid) {
    try {
      await this._request('POST', `/v2/calls/${callSid}/actions/hangup`, {});
      logger.debug(`TELNYX: hangup ${callSid}`);
    } catch (e) {
      logger.debug(`TELNYX: hangup failed ${callSid}: ${e.message}`);
    }
  }

  // Parse Telnyx webhook event
  static parseWebhook(body) {
    const data = body.data || body;
    const eventType = data.event_type || '';
    const payload = data.payload || {};

    // Decode client_state
    let clientState = {};
    if (payload.client_state) {
      try { clientState = JSON.parse(Buffer.from(payload.client_state, 'base64').toString()); } catch (e) {}
    }

    return {
      eventType,
      callControlId: payload.call_control_id || '',
      callSid: payload.call_control_id || '',
      from: payload.from || '',
      to: payload.to || '',
      callId: clientState.callId || '',
      // AMD specific
      amdResult: payload.result || '',  // 'human', 'machine', 'not_sure'
    };
  }

  async _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body);
      const options = {
        hostname: 'api.telnyx.com',
        port: 443,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.credentials.apiKey}`,
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (res.statusCode >= 400) {
              reject(new Error(`Telnyx API ${res.statusCode}: ${body.substring(0, 200)}`));
            } else {
              resolve(json);
            }
          } catch (e) {
            reject(new Error(`Telnyx parse error: ${body.substring(0, 200)}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Telnyx API timeout')); });
      req.write(data);
      req.end();
    });
  }
}

// ============================================================
// SIGNALWIRE — Compatibility API (Twilio-compatible)
//
// Env vars:
//   SIGNALWIRE_PROJECT_ID — Project ID
//   SIGNALWIRE_API_TOKEN — API Token
//   SIGNALWIRE_SPACE — Space URL (e.g. example.signalwire.com)
// ============================================================
class SignalWireAdapter extends CarrierAdapter {
  constructor() {
    super('signalwire', {
      projectId: process.env.SIGNALWIRE_PROJECT_ID || '',
      apiToken: process.env.SIGNALWIRE_API_TOKEN || '',
      space: process.env.SIGNALWIRE_SPACE || ''
    });
  }

  async createCall(phone, callerId, webhookUrl, options = {}) {
    const { amd, amdAction, ringTimeout, callId } = options;

    const params = new URLSearchParams();
    params.append('Url', webhookUrl);
    params.append('To', phone.startsWith('+') ? phone : `+1${phone}`);
    params.append('From', callerId.startsWith('+') ? callerId : `+1${callerId}`);
    params.append('Timeout', String(ringTimeout || 30));
    params.append('StatusCallback', webhookUrl.replace('/voice', '/status'));
    params.append('StatusCallbackEvent', 'completed');

    if (amd) {
      params.append('MachineDetection', 'DetectMessageEnd');
      params.append('MachineDetectionTimeout', '45');
      params.append('MachineDetectionSpeechThreshold', '2400');
      params.append('MachineDetectionSpeechEndThreshold', '1200');
      params.append('MachineDetectionSilenceTimeout', '5000');
      params.append('AsyncAmd', 'true');
      params.append('AsyncAmdStatusCallback', webhookUrl.replace('/voice', '/amd'));
      params.append('AsyncAmdStatusCallbackMethod', 'POST');
    }

    const result = await this._request(
      'POST',
      `/api/laml/2010-04-01/Accounts/${this.credentials.projectId}/Calls.json`,
      params.toString()
    );

    const sid = result.sid || '';
    logger.info(`SIGNALWIRE: call created to ${phone} sid=${sid} amd=${!!amd}`);
    return sid;
  }

  async hangupCall(callSid) {
    try {
      const params = new URLSearchParams();
      params.append('Status', 'completed');
      await this._request(
        'POST',
        `/api/laml/2010-04-01/Accounts/${this.credentials.projectId}/Calls/${callSid}.json`,
        params.toString()
      );
    } catch (e) {
      logger.debug(`SIGNALWIRE: hangup failed ${callSid}: ${e.message}`);
    }
  }

  static parseWebhook(body) {
    return {
      eventType: body.CallStatus || '',
      callSid: body.CallSid || '',
      from: body.From || '',
      to: body.To || '',
      amdResult: (body.AnsweredBy || '').toLowerCase(),
      // AnsweredBy: 'human', 'machine_start', 'machine_end_beep', 'machine_end_silence', 'machine_end_other', 'unknown'
    };
  }

  async _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${this.credentials.projectId}:${this.credentials.apiToken}`).toString('base64');
      const isForm = typeof body === 'string';

      const options = {
        hostname: this.credentials.space,
        port: 443,
        path,
        method,
        headers: {
          'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
          'Authorization': `Basic ${auth}`,
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) reject(new Error(`SignalWire API ${res.statusCode}: ${data.substring(0, 200)}`));
            else resolve(json);
          } catch (e) { reject(new Error(`SignalWire parse error: ${data.substring(0, 200)}`)); }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('SignalWire API timeout')); });
      req.write(body);
      req.end();
    });
  }
}

// ============================================================
// TWILIO — REST API
//
// Env vars:
//   TWILIO_ACCOUNT_SID — Account SID
//   TWILIO_AUTH_TOKEN — Auth Token
// ============================================================
class TwilioAdapter extends CarrierAdapter {
  constructor() {
    super('twilio', {
      accountSid: process.env.TWILIO_ACCOUNT_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || ''
    });
  }

  async createCall(phone, callerId, webhookUrl, options = {}) {
    const { amd, amdAction, ringTimeout, callId } = options;

    const params = new URLSearchParams();
    params.append('Url', webhookUrl);
    params.append('To', phone.startsWith('+') ? phone : `+1${phone}`);
    params.append('From', callerId.startsWith('+') ? callerId : `+1${callerId}`);
    params.append('Timeout', String(ringTimeout || 30));
    params.append('StatusCallback', webhookUrl.replace('/voice', '/status'));
    params.append('StatusCallbackEvent', 'completed');

    if (amd) {
      params.append('MachineDetection', 'DetectMessageEnd');
      params.append('MachineDetectionTimeout', '30');
      params.append('AsyncAmd', 'true');
      params.append('AsyncAmdStatusCallback', webhookUrl.replace('/voice', '/amd'));
      params.append('AsyncAmdStatusCallbackMethod', 'POST');
    }

    const result = await this._request(
      'POST',
      `/2010-04-01/Accounts/${this.credentials.accountSid}/Calls.json`,
      params.toString()
    );

    const sid = result.sid || '';
    logger.info(`TWILIO: call created to ${phone} sid=${sid} amd=${!!amd}`);
    return sid;
  }

  async hangupCall(callSid) {
    try {
      const params = new URLSearchParams();
      params.append('Status', 'completed');
      await this._request(
        'POST',
        `/2010-04-01/Accounts/${this.credentials.accountSid}/Calls/${callSid}.json`,
        params.toString()
      );
    } catch (e) {
      logger.debug(`TWILIO: hangup failed ${callSid}: ${e.message}`);
    }
  }

  static parseWebhook(body) {
    return {
      eventType: body.CallStatus || '',
      callSid: body.CallSid || '',
      from: body.From || '',
      to: body.To || '',
      amdResult: (body.AnsweredBy || '').toLowerCase(),
    };
  }

  async _request(method, path, body) {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${this.credentials.accountSid}:${this.credentials.authToken}`).toString('base64');
      const isForm = typeof body === 'string';

      const options = {
        hostname: 'api.twilio.com',
        port: 443,
        path,
        method,
        headers: {
          'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
          'Authorization': `Basic ${auth}`,
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) reject(new Error(`Twilio API ${res.statusCode}: ${data.substring(0, 200)}`));
            else resolve(json);
          } catch (e) { reject(new Error(`Twilio parse error: ${data.substring(0, 200)}`)); }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Twilio API timeout')); });
      req.write(body);
      req.end();
    });
  }
}

// ============================================================
// Factory — get adapter by carrier name
// ============================================================
function getAdapter(carrier) {
  switch ((carrier || '').toLowerCase()) {
    case 'telnyx': return new TelnyxAdapter();
    case 'signalwire': return new SignalWireAdapter();
    case 'twilio': return new TwilioAdapter();
    default: return null;
  }
}

// Normalize AMD result across carriers to: 'human', 'machine', 'unknown'
function normalizeAmdResult(carrier, rawResult) {
  if (!rawResult) return 'unknown';
  const r = rawResult.toLowerCase();

  if (carrier === 'telnyx') {
    if (r === 'human') return 'human';
    if (r === 'machine') return 'machine';
    return 'unknown';
  }

  // SignalWire + Twilio use same format
  if (r === 'human') return 'human';
  if (r.startsWith('machine')) return 'machine'; // machine_end_beep, machine_end_silence, etc.
  return 'unknown';
}

module.exports = {
  getAdapter,
  normalizeAmdResult,
  TelnyxAdapter,
  SignalWireAdapter,
  TwilioAdapter
};
