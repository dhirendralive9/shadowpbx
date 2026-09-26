const crypto = require('crypto');
const logger = require('../../utils/logger');

// ============================================================
// CRM Credential Encryption — AES-256-GCM
//
// Encrypts CRM credentials (API keys, OAuth tokens, secrets)
// before storing in MongoDB. Decrypts on read.
//
// KEY SEPARATION (security review): API authentication and credential
// encryption are different security domains and must not share a secret.
//   - CREDENTIAL_ENCRYPTION_KEY  — dedicated key for this. Preferred.
//     A 32-byte key, hex or base64 (64 hex / 44 base64 chars), used
//     directly; anything else is treated as a passphrase and stretched
//     with PBKDF2. Generate one with:  openssl rand -hex 32
//   - ADMIN_SECRET               — legacy fallback, so existing installs
//     keep decrypting. Rotating ADMIN_SECRET (the API secret) no longer
//     silently breaks CRM credentials once a dedicated key is set.
//
// KEY VERSIONING / ROTATION: every blob is tagged with the id of the key
// that encrypted it (v1 = current key, v0 = the legacy ADMIN_SECRET key).
// Decryption tries the blob's own key first, then any other configured
// key, so you can roll a new key in and re-encrypt lazily without a flag
// day. New encryptions always use the current key.
//
// Format: "<keyId>:" + base64(iv + authTag + ciphertext)
//         (a blob with no "<keyId>:" prefix is a pre-versioning v0 blob)
// ============================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT = 'shadowpbx-crm-credentials';
const ITERATIONS = 100000;

// Turn a configured secret into a 32-byte key. A real 32-byte key given as
// hex or base64 is used verbatim; anything else is a passphrase, stretched.
function toKey(secret) {
  if (!secret) return null;
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  if (/^[A-Za-z0-9+/]{43}=$/.test(secret)) {
    const b = Buffer.from(secret, 'base64');
    if (b.length === KEY_LENGTH) return b;
  }
  return crypto.pbkdf2Sync(secret, SALT, ITERATIONS, KEY_LENGTH, 'sha256');
}

// The set of keys we know about, newest first. v1 = dedicated key (if set),
// v0 = the legacy ADMIN_SECRET key (if set). Cached after first build.
let _keyring = null;
function keyring() {
  if (_keyring) return _keyring;
  const ring = [];
  const dedicated = process.env.CREDENTIAL_ENCRYPTION_KEY;
  const legacy = process.env.ADMIN_SECRET && process.env.ADMIN_SECRET !== 'change_me'
    ? process.env.ADMIN_SECRET : null;

  if (dedicated) ring.push({ id: 'v1', key: toKey(dedicated) });
  if (legacy) ring.push({ id: 'v0', key: toKey(legacy) });

  if (ring.length === 0) {
    throw new Error('No encryption key configured — set CREDENTIAL_ENCRYPTION_KEY (preferred) or ADMIN_SECRET');
  }
  if (dedicated === undefined && legacy) {
    logger.warn('CRM crypto: using ADMIN_SECRET for credential encryption. Set CREDENTIAL_ENCRYPTION_KEY (openssl rand -hex 32) to separate the auth and encryption keys.');
  }
  _keyring = ring;
  return ring;
}

function keyById(id) {
  return keyring().find(k => k.id === id) || null;
}
function currentKey() {
  return keyring()[0];
}

function encrypt(data) {
  const { id, key } = currentKey();
  const plaintext = typeof data === 'string' ? data : JSON.stringify(data);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, authTag, encrypted]).toString('base64');
  return `${id}:${packed}`;
}

function _decryptWith(key, packed) {
  if (packed.length < IV_LENGTH + TAG_LENGTH + 1) throw new Error('Invalid encrypted data — too short');
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function decrypt(encoded) {
  // Split the "<keyId>:" prefix if present. A blob without one is v0 (legacy,
  // pre-versioning) and was encrypted with the ADMIN_SECRET-derived key.
  let keyId = null, b64 = encoded;
  const m = /^(v\d+):(.*)$/.exec(encoded);
  if (m) { keyId = m[1]; b64 = m[2]; }

  const packed = Buffer.from(b64, 'base64');

  // Try the blob's own key first; on GCM auth failure fall back to the others
  // (covers a blob written under an old key after a new one was added).
  const ordered = [];
  if (keyId) { const k = keyById(keyId); if (k) ordered.push(k); }
  else { const v0 = keyById('v0'); if (v0) ordered.push(v0); }   // unprefixed = v0
  for (const k of keyring()) if (!ordered.includes(k)) ordered.push(k);

  let lastErr = null;
  for (const k of ordered) {
    try { return _decryptWith(k.key, packed); }
    catch (e) { lastErr = e; }
  }
  throw new Error(`CRM credential decryption failed with all configured keys${lastErr ? ': ' + lastErr.message : ''}`);
}

function encryptObject(obj) { return encrypt(JSON.stringify(obj)); }
function decryptObject(encoded) {
  const plaintext = decrypt(encoded);
  try { return JSON.parse(plaintext); }
  catch (e) {
    logger.error('CRM crypto: failed to parse decrypted data as JSON');
    throw new Error('Decrypted CRM credentials are not valid JSON');
  }
}

// True when a blob is not encrypted under the current key — i.e. re-encrypting
// it would upgrade it to the newest key. Lets callers migrate lazily.
function needsRotation(encoded) {
  const m = /^(v\d+):/.exec(encoded);
  const id = m ? m[1] : 'v0';
  return id !== currentKey().id;
}

function clearKeyCache() { _keyring = null; }

module.exports = { encrypt, decrypt, encryptObject, decryptObject, needsRotation, clearKeyCache };
