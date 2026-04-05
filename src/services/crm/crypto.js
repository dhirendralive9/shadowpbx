const crypto = require('crypto');
const logger = require('../../utils/logger');

// ============================================================
// CRM Credential Encryption — AES-256-GCM
//
// Encrypts CRM credentials (API keys, OAuth tokens, secrets)
// before storing in MongoDB. Decrypts on read.
//
// Uses ADMIN_SECRET from .env as the master key, derived via
// PBKDF2 to a 256-bit key. Each encrypt call generates a
// random IV for uniqueness.
//
// Format: base64(iv + authTag + ciphertext)
// ============================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;       // 128-bit IV
const TAG_LENGTH = 16;      // 128-bit auth tag
const KEY_LENGTH = 32;      // 256-bit key
const SALT = 'shadowpbx-crm-credentials';  // static salt — key uniqueness from ADMIN_SECRET
const ITERATIONS = 100000;

/**
 * Derive a 256-bit encryption key from ADMIN_SECRET.
 * Cached after first call for performance.
 */
let _derivedKey = null;
function _getKey() {
  if (_derivedKey) return _derivedKey;

  const secret = process.env.ADMIN_SECRET;
  if (!secret || secret === 'change_me') {
    throw new Error('ADMIN_SECRET is not set or is default — cannot encrypt CRM credentials');
  }

  _derivedKey = crypto.pbkdf2Sync(secret, SALT, ITERATIONS, KEY_LENGTH, 'sha256');
  return _derivedKey;
}

/**
 * Encrypt a plaintext string or object.
 * @param {string|Object} data — plaintext to encrypt (objects are JSON.stringify'd)
 * @returns {string} — base64-encoded encrypted blob
 */
function encrypt(data) {
  const key = _getKey();
  const plaintext = typeof data === 'string' ? data : JSON.stringify(data);

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (16) + authTag (16) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString('base64');
}

/**
 * Decrypt a base64-encoded encrypted blob.
 * @param {string} encoded — base64 blob from encrypt()
 * @returns {string} — decrypted plaintext
 */
function decrypt(encoded) {
  const key = _getKey();
  const packed = Buffer.from(encoded, 'base64');

  if (packed.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('Invalid encrypted data — too short');
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Encrypt an object (convenience wrapper).
 * @param {Object} obj — object to encrypt
 * @returns {string} — base64-encoded encrypted blob
 */
function encryptObject(obj) {
  return encrypt(JSON.stringify(obj));
}

/**
 * Decrypt to an object (convenience wrapper).
 * @param {string} encoded — base64 blob
 * @returns {Object} — decrypted parsed object
 */
function decryptObject(encoded) {
  const plaintext = decrypt(encoded);
  try {
    return JSON.parse(plaintext);
  } catch (e) {
    logger.error(`CRM crypto: failed to parse decrypted data as JSON`);
    throw new Error('Decrypted CRM credentials are not valid JSON');
  }
}

/**
 * Clear cached key (for testing or key rotation).
 */
function clearKeyCache() {
  _derivedKey = null;
}

module.exports = { encrypt, decrypt, encryptObject, decryptObject, clearKeyCache };
