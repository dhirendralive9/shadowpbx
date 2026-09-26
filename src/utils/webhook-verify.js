const crypto = require('crypto');
const logger = require('./logger');

// ============================================================
// Carrier webhook signature verification
//
// The /webhook/* endpoints are public — carriers must reach them. Without
// verifying that a request genuinely came from the carrier, anyone can POST
// forged call state (CallStatus, RecordingUrl, AMD result, agent, campaignId)
// and drive the PBX: fake "human answered" to bridge calls, point recording
// downloads at attacker URLs, mark calls completed, etc.
//
// Twilio and SignalWire (TwiML/LaML compatible) sign requests the same way:
//   signature = base64(HMAC-SHA1(authToken, fullUrl + sorted(k+v for POST params)))
// sent in the X-Twilio-Signature header. We recompute it and constant-time
// compare. The full URL must match exactly what the carrier signed, which is
// why WEBHOOK_BASE_URL (the canonical public URL) is used to build it — not
// spoofable request headers.
//
// Config:
//   WEBHOOK_VERIFY=true|false   (default true — do not disable in production)
//   The signing key is the carrier auth token: TWILIO_AUTH_TOKEN, or
//   SIGNALWIRE_TOKEN / TELNYX tokens if set. All configured tokens are tried,
//   so a mixed-provider setup verifies against whichever one signed it.
// ============================================================

const VERIFY = String(process.env.WEBHOOK_VERIFY || 'true').toLowerCase() !== 'false';

function signingTokens() {
  return [
    process.env.TWILIO_AUTH_TOKEN,
    process.env.SIGNALWIRE_TOKEN,
    process.env.SIGNALWIRE_AUTH_TOKEN
  ].filter(Boolean);
}

// Twilio/SignalWire signature: base64(HMAC-SHA1(token, url + sortedParams)).
function expectedSignature(token, url, params) {
  let data = url;
  Object.keys(params).sort().forEach(k => { data += k + params[k]; });
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a || '', 'utf-8');
  const bb = Buffer.from(b || '', 'utf-8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// The exact URL the carrier signed: canonical base + original path + query.
function fullUrl(req) {
  const base = (process.env.WEBHOOK_BASE_URL || '').replace(/\/$/, '');
  if (base) return base + req.originalUrl;
  // No canonical base configured — reconstruct (less reliable). Verification is
  // still attempted; a mismatch here is a strong hint WEBHOOK_BASE_URL is unset.
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Express middleware. Rejects a webhook whose signature doesn't verify.
 * Applied to every /webhook/* route that changes state.
 */
function verifyWebhook(req, res, next) {
  if (!VERIFY) return next();

  const tokens = signingTokens();
  if (tokens.length === 0) {
    // No token to verify against. Fail CLOSED for state-changing webhooks — an
    // unverifiable public endpoint that mutates call state is the whole risk.
    logger.error(`WEBHOOK: no carrier auth token configured — rejecting ${req.method} ${req.path}. Set TWILIO_AUTH_TOKEN (or SIGNALWIRE_TOKEN), or WEBHOOK_VERIFY=false to disable (not recommended).`);
    return res.status(403).type('text/plain').send('Forbidden');
  }

  const provided = req.headers['x-twilio-signature'] || req.headers['x-signalwire-signature'] || '';
  if (!provided) {
    logger.warn(`WEBHOOK REJECTED: no signature on ${req.method} ${req.path} from ${req.ip}`);
    return res.status(403).type('text/plain').send('Forbidden');
  }

  const url = fullUrl(req);
  const params = (req.body && typeof req.body === 'object') ? req.body : {};
  const ok = tokens.some(t => timingSafeEqual(expectedSignature(t, url, params), provided));

  if (!ok) {
    logger.warn(`WEBHOOK REJECTED: bad signature on ${req.method} ${req.path} from ${req.ip} (url used: ${url})`);
    return res.status(403).type('text/plain').send('Forbidden');
  }
  next();
}

module.exports = { verifyWebhook, expectedSignature };
