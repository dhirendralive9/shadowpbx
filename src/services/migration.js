'use strict';
//
// Server-to-server config migration.
//
// Copies configuration (extensions, call flows, network) from one ShadowPBX to
// another. The receiver generates a single-use, time-boxed "accept code"; the
// sender encrypts its config under that code with AES-256-GCM and POSTs it.
// Because the code is the decryption key AND the payload is authenticated, a
// wrong code cannot decrypt or tamper — so the transfer is safe even over plain
// HTTP. On the receiver, incoming items OVERWRITE existing ones with the same
// natural key (migrated extensions keep the SENDER's password). Users and CDR
// are never touched. The receiver snapshots its current config first, so a
// destructive apply is recoverable.
//
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

// Config collections that migrate, with the natural key used to match/overwrite.
// Order matters: things others reference (domains, trunks) go first.
const MIGRATE = [
  { name: 'SIPDomain',     key: 'domain' },
  { name: 'Trunk',         key: 'name' },
  { name: 'Extension',     key: 'extension' },
  { name: 'RingGroup',     key: 'number' },
  { name: 'Queue',         key: 'number' },
  { name: 'IVR',           key: 'number' },
  { name: 'TimeCondition', key: 'number' },
  { name: 'InboundRoute',  key: 'name' },
  { name: 'OutboundRoute', key: 'name' },
  { name: 'BlockedNumber', key: 'number' },
];
// Explicitly never migrated (login accounts + call records + all runtime data).
const NEVER = ['User', 'CDR'];

const BACKUP_DIR = process.env.MIGRATION_BACKUP_DIR || '/var/log/shadowpbx';
const TTL_MS = (parseInt(process.env.MIGRATION_TOKEN_TTL_MIN || '30', 10)) * 60 * 1000;

function stripDoc(doc) {
  const o = { ...doc };
  delete o._id; delete o.__v;
  return o;
}

// ── export ──
async function exportConfig(models) {
  const collections = {};
  let total = 0;
  for (const { name } of MIGRATE) {
    const Model = models[name];
    if (!Model) continue;
    const docs = await Model.find({}).lean();
    collections[name] = docs.map(stripDoc);
    total += collections[name].length;
  }
  return { version: 1, generatedAt: new Date().toISOString(), total, collections };
}

// ── crypto: AES-256-GCM keyed from the shared accept code ──
function keyFromToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest(); // 32 bytes
}
function encrypt(obj, token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromToken(token), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64'); // iv(12) | tag(16) | ciphertext
}
function decrypt(blobB64, token) {
  const buf = Buffer.from(String(blobB64), 'base64');
  if (buf.length < 28) throw new Error('payload too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFromToken(token), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]); // throws on wrong key / tamper
  return JSON.parse(pt.toString('utf8'));
}

// ── snapshot (rollback file written before a destructive apply) ──
async function snapshot(models) {
  try {
    const cfg = await exportConfig(models);
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `migration-backup-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    return file;
  } catch (e) {
    logger.error(`MIGRATION: snapshot failed: ${e.message}`);
    return null;
  }
}

// ── apply (destructive: incoming overwrites existing, matched by natural key) ──
async function applyConfig(models, config) {
  const summary = {};
  const collections = (config && config.collections) || {};
  for (const { name, key } of MIGRATE) {
    const Model = models[name];
    const rows = collections[name];
    if (!Model || !Array.isArray(rows)) continue;
    let replaced = 0, added = 0, skipped = 0;
    for (const raw of rows) {
      const doc = stripDoc(raw);
      const kv = doc[key];
      if (kv === undefined || kv === null || kv === '') { skipped++; continue; }
      const existed = await Model.exists({ [key]: kv });
      await Model.replaceOne({ [key]: kv }, doc, { upsert: true }); // whole-doc overwrite or insert
      if (existed) replaced++; else added++;
    }
    summary[name] = { added, replaced, skipped, total: rows.length };
  }
  return summary;
}

// ── single active accept code (receiver side), in memory, single-use + TTL ──
let active = null; // { token, createdAt, expiresAt, used }

function newToken() {
  const token = crypto.randomBytes(24).toString('base64url');
  active = { token, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS, used: false };
  return active;
}
function tokenStatus() {
  if (!active) return null;
  if (Date.now() > active.expiresAt) { active = null; return null; }
  return { createdAt: active.createdAt, expiresAt: active.expiresAt, used: active.used };
}
function cancelToken() { active = null; }
function currentToken() {
  if (!active) return null;
  if (Date.now() > active.expiresAt) { active = null; return null; }
  return active.used ? null : active.token;
}
// Constant-time check that a presented code matches the active, unexpired, unused one.
function consumeToken(presented) {
  if (!active || Date.now() > active.expiresAt || active.used) return false;
  const a = Buffer.from(active.token);
  const b = Buffer.from(String(presented || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function markUsed() { if (active) active.used = true; }

// ── rollback: list and restore the snapshots written before each apply ──
function listSnapshots() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^migration-backup-\d+\.json$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(BACKUP_DIR, f));
        return { file: f, sizeBytes: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
}

// Restore a snapshot by RE-APPLYING its config (brings overwritten items back to
// their saved values). Items the migration newly ADDED are not removed. The file
// name is validated to a bare migration-backup-*.json inside BACKUP_DIR — no
// path traversal.
async function restoreSnapshot(models, fileName) {
  const base = path.basename(String(fileName || ''));
  if (!/^migration-backup-\d+\.json$/.test(base)) throw new Error('invalid snapshot name');
  const full = path.join(BACKUP_DIR, base);
  if (!fs.existsSync(full)) throw new Error('snapshot not found');
  const cfg = JSON.parse(fs.readFileSync(full, 'utf8'));
  return applyConfig(models, cfg);
}

module.exports = {
  MIGRATE, NEVER,
  exportConfig, encrypt, decrypt, snapshot, applyConfig,
  newToken, tokenStatus, cancelToken, currentToken, consumeToken, markUsed,
  listSnapshots, restoreSnapshot,
};
