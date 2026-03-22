const logger = require('./logger');

// ============================================================
// Centralized RTPEngine Helper
//
// All services call these functions instead of calling rtpengine
// directly. Ensures consistent parameters and makes it trivial
// to enable SRTP across the entire PBX with one env var.
//
// SRTP modes (SRTP_MODE env var):
//   'off'      — plain RTP only (default, current behavior)
//   'offer'    — offer SRTP via SDES, accept plain RTP fallback
//   'require'  — require SRTP, reject plain RTP
// ============================================================

const SRTP_MODE = (process.env.SRTP_MODE || 'off').toLowerCase();

function getConfig() {
  return {
    host: process.env.RTPENGINE_HOST || '127.0.0.1',
    port: parseInt(process.env.RTPENGINE_PORT) || 22222
  };
}

/**
 * Build base params for every offer/answer call.
 * SRTP flags injected based on SRTP_MODE.
 */
function baseParams() {
  const flags = ['trust-address'];
  const params = {
    'replace': ['origin', 'session-connection'],
    'ICE': 'remove'
  };

  if (SRTP_MODE === 'offer') {
    // Offer SRTP via SDES — if peer supports it, use SRTP; otherwise fall back to RTP
    flags.push('generate-SRTP');
  } else if (SRTP_MODE === 'require') {
    // Force SRTP — reject endpoints that don't support SDES
    flags.push('SRTP-required', 'generate-SRTP');
  }

  params['flags'] = flags;
  return params;
}

/**
 * RTPEngine offer.
 * @param {object} rtpengine - rtpengine-client instance
 * @param {string} callId - SIP Call-ID
 * @param {string} fromTag - SIP From-tag
 * @param {string} sdp - SDP body
 * @param {object} [extra] - Additional params (e.g. { 'record call': 'yes' })
 * @returns {object|null}
 */
async function offer(rtpengine, callId, fromTag, sdp, extra) {
  if (!rtpengine) return null;
  try {
    const params = { ...baseParams(), 'call-id': callId, 'from-tag': fromTag, sdp, ...(extra || {}) };
    const response = await rtpengine.offer(getConfig(), params);
    return response && response.result === 'ok' ? response : null;
  } catch (err) {
    logger.debug(`RTPEngine offer failed: ${err.message}`);
    return null;
  }
}

/**
 * RTPEngine answer.
 */
async function answer(rtpengine, callId, fromTag, toTag, sdp, extra) {
  if (!rtpengine) return null;
  try {
    const params = { ...baseParams(), 'call-id': callId, 'from-tag': fromTag, 'to-tag': toTag, sdp, ...(extra || {}) };
    const response = await rtpengine.answer(getConfig(), params);
    return response && response.result === 'ok' ? response : null;
  } catch (err) {
    logger.debug(`RTPEngine answer failed: ${err.message}`);
    return null;
  }
}

/**
 * RTPEngine delete session.
 */
async function del(rtpengine, callId, fromTag) {
  if (!rtpengine) return;
  try { await rtpengine.delete(getConfig(), { 'call-id': callId, 'from-tag': fromTag }); } catch (e) {}
}

function logMode() {
  if (SRTP_MODE === 'off') logger.info('Media encryption: disabled (plain RTP)');
  else if (SRTP_MODE === 'offer') logger.info('Media encryption: SRTP offered (SDES with plain RTP fallback)');
  else if (SRTP_MODE === 'require') logger.info('Media encryption: SRTP required (SDES, no fallback)');
}

module.exports = { offer, answer, del, getConfig, baseParams, logMode, SRTP_MODE };
