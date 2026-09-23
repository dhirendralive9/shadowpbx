const crypto = require('crypto');
const logger = require('../utils/logger');

// ============================================================
// TURN / STUN credentials (Web Dialer — Phase 8)
//
// Many visitors sit behind NATs or corporate firewalls where direct
// WebRTC media never gets through. A TURN server relays the media for
// them, which makes it effectively mandatory for reliable web calling.
//
// Credentials are ephemeral, using coturn's REST API scheme
// (draft-uberti-behave-turn-rest): the username is an expiry timestamp
// plus a label, and the password is an HMAC-SHA1 of that username with
// the shared secret. coturn validates it without ever storing a user,
// so a leaked credential dies on its own within TURN_TTL seconds.
//
// Env:
//   TURN_URLS    comma-separated, e.g.
//                turn:pbx.example.com:3478?transport=udp,turn:pbx.example.com:3478?transport=tcp,turns:pbx.example.com:5349?transport=tcp
//   TURN_SECRET  the same static-auth-secret coturn was started with
//   TURN_TTL     credential lifetime in seconds (default 3600)
//   WEBRTC_STUN_SERVERS  comma-separated STUN URLs (default Google's)
//
// With no TURN_SECRET configured this falls back to STUN only, which is
// exactly how Phases 1-7 behaved.
// ============================================================

const TTL = parseInt(process.env.TURN_TTL) || 3600;

function turnUrls() {
  return (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
}

function stunUrls() {
  return (process.env.WEBRTC_STUN_SERVERS || 'stun:stun.l.google.com:19302')
    .split(',').map(s => s.trim()).filter(Boolean);
}

function configured() {
  return !!(process.env.TURN_SECRET && turnUrls().length > 0);
}

/**
 * One ephemeral credential pair, valid for TTL seconds.
 * @param {string} [label] - appears in coturn's logs; keep it short
 */
function credentials(label) {
  if (!configured()) return null;
  const expiry = Math.floor(Date.now() / 1000) + TTL;
  const username = `${expiry}:${(label || 'web').replace(/[^\w.-]/g, '').slice(0, 24) || 'web'}`;
  const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
  return { username, credential, expiresAt: expiry, ttl: TTL };
}

/**
 * The iceServers array a browser needs: STUN first, then TURN relays.
 * ICE tries them in order — direct, then reflexive, then relay.
 */
function iceServers(label) {
  const servers = [];
  const stun = stunUrls();
  if (stun.length) servers.push({ urls: stun });

  const creds = credentials(label);
  if (creds) {
    servers.push({ urls: turnUrls(), username: creds.username, credential: creds.credential });
  }
  return servers;
}

function summary() {
  return {
    configured: configured(),
    urls: turnUrls(),
    stun: stunUrls(),
    ttlSeconds: TTL,
    scheme: configured() ? 'ephemeral HMAC (coturn REST)' : 'STUN only — no relay'
  };
}

function logMode() {
  if (configured()) logger.info(`TURN: ${turnUrls().length} relay URL(s), ephemeral credentials valid ${TTL}s`);
  else logger.info('TURN: not configured — browsers behind strict NAT may get no audio (run scripts/setup-turn.sh)');
}

module.exports = { credentials, iceServers, configured, summary, logMode, turnUrls, stunUrls };
