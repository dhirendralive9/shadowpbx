'use strict';
/**
 * Agent availability for outside diallers.
 *
 * A predictive dialler decides how fast to call from one number: how many
 * agents are free right now. Getting that number wrong in either direction is
 * expensive -- too low and the campaign crawls, too high and leads hear dead
 * air -- so this is deliberately strict about what "free" means.
 *
 * Free is: the extension is a member of the target, a phone is registered to
 * it, and presence says it is not on, or ringing with, a call. An extension
 * that is logged in but talking is NOT free, which is the distinction most
 * naive implementations get wrong.
 */
const crypto = require('crypto');
const { Extension, RingGroup, Queue, CampaignApiKey } = require('../models');

const AVAILABLE = 'available';
const BUSY = 'busy';
const OFFLINE = 'offline';
const DND = 'dnd';

/** presence state -> what it means for taking a new call */
function fromPresence(state) {
  switch (state) {
    case 'confirmed':            // on a call
    case 'ringing':              // already being offered one
    case 'held':
      return BUSY;
    case 'dnd':
      return DND;
    default:
      return AVAILABLE;
  }
}

/** Extension numbers that belong to this target, in configured order. */
async function membersOf(target) {
  if (!target || !target.number) return { members: [], label: '', missing: true };
  if (target.type === 'extension') {
    const e = await Extension.findOne({ extension: target.number }).lean();
    return { members: e ? [e.extension] : [], label: e ? e.name : '', missing: !e };
  }
  if (target.type === 'ringgroup') {
    const g = await RingGroup.findOne({ number: target.number }).lean();
    return { members: g ? (g.members || []) : [], label: g ? g.name : '', missing: !g };
  }
  if (target.type === 'queue') {
    const q = await Queue.findOne({ number: target.number }).lean();
    return {
      members: q ? (q.agents || []).map((a) => a.extension) : [],
      label: q ? q.name : '',
      missing: !q,
    };
  }
  return { members: [], label: '', missing: true };
}

/**
 * Build the snapshot an outside dialler reads.
 * `presence` is the running PresenceHandler, or null in a context without SIP.
 */
async function snapshot(target, presence) {
  const { members, label, missing } = await membersOf(target);
  if (missing) {
    return {
      group: '', target: `${target.type}/${target.number}`,
      total: 0, available: 0, agents: [],
      error: `${target.type} ${target.number} no longer exists on this PBX`,
    };
  }

  const docs = members.length
    ? await Extension.find({ extension: { $in: members } }).lean()
    : [];
  const byExt = new Map(docs.map((d) => [d.extension, d]));
  const now = new Date();

  const agents = members.map((ext) => {
    const doc = byExt.get(ext);
    if (!doc || doc.enabled === false) {
      return { id: ext, name: doc ? doc.name : '', status: OFFLINE, reason: doc ? 'disabled' : 'no such extension' };
    }
    const registered = (doc.registrations || []).some((r) => r.expires && new Date(r.expires) > now);
    if (!registered) return { id: ext, name: doc.name, status: OFFLINE, reason: 'not registered' };
    const st = presence ? presence.getState(ext) : { state: 'idle' };
    const status = fromPresence(st.state);
    return {
      id: ext,
      name: doc.name,
      status,
      // Useful to whoever is debugging a campaign that will not dial.
      presence: st.state || 'idle',
      since: st.since || null,
    };
  });

  return {
    group: label,
    target: `${target.type}/${target.number}`,
    total: agents.length,
    available: agents.filter((a) => a.status === AVAILABLE).length,
    agents,
  };
}

// ---------------------------------------------------------------- keys
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');

function newSecret() {
  // 32 bytes, base64url: long enough that guessing is not a strategy, short
  // enough to paste into a form without wrapping.
  return crypto.randomBytes(32).toString('base64url');
}

function newKeyId() {
  return crypto.randomBytes(8).toString('hex');   // 16 chars, public, in the URL
}

/** Constant-time compare, so a wrong key cannot be found one character at a time. */
function hashMatches(secret, storedHash) {
  const a = Buffer.from(sha256(secret), 'utf8');
  const b = Buffer.from(String(storedHash || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Pull the bearer token from a request, header or query (WebSocket clients). */
function bearerFrom(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  try {
    const u = new URL(req.url, 'http://localhost');
    return (u.searchParams.get('token') || '').trim();
  } catch (e) { return ''; }
}

/**
 * Resolve a request to its key document, or an error to report.
 * Returns { key } or { status, error }.
 */
async function authenticate(keyId, secret) {
  if (!keyId || !secret) return { status: 401, error: 'missing API key' };
  const key = await CampaignApiKey.findOne({ keyId }).lean();
  // Same answer for "no such key" and "wrong secret": a 404 here would confirm
  // which key ids exist.
  if (!key || !hashMatches(secret, key.keyHash)) return { status: 401, error: 'invalid API key' };
  if (!key.enabled) return { status: 403, error: 'this API key is disabled' };
  return { key };
}

function touch(keyId, ip, transport) {
  CampaignApiKey.updateOne({ keyId },
    { $set: { lastUsedAt: new Date(), lastUsedIp: ip || '', lastTransport: transport } })
    .catch(() => {});
}

module.exports = {
  snapshot, membersOf, fromPresence,
  newSecret, newKeyId, sha256, hashMatches, bearerFrom, authenticate, touch,
  STATUS: { AVAILABLE, BUSY, OFFLINE, DND },
};
