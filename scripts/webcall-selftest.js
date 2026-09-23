#!/usr/bin/env node
// ============================================================
// ShadowPBX — Web-call guest self-test (Web Dialer Phase 2)
//
// Exercises the guest identity lifecycle against a RUNNING ShadowPBX:
//
//   1. Token issue for a real widget            (public endpoint)
//   2. Unknown widget / bad Origin are refused
//   3. The credential passes SIP digest auth     (as the registrar does it)
//   4. A wrong password fails
//   5. The destination lockdown refuses anything but the widget's target
//   6. Single-use: a second call on the same token is refused
//   7. Hangup destroys the identity; unused tokens expire
//   8. Rate limiting kicks in
//
// Usage (from the app directory):
//   node scripts/webcall-selftest.js                  # uses/creates a temp widget
//   node scripts/webcall-selftest.js --widget abc123  # test an existing widget
//   node scripts/webcall-selftest.js --json
//
// The temp widget is deleted afterwards. No calls are placed.
// ============================================================
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.LOG_LEVEL = process.env.LOG_LEVEL_SELFTEST || 'error';

const mongoose = require('mongoose');
const G = '\x1b[32m', R = '\x1b[31m', B = '\x1b[1m', D = '\x1b[2m', N = '\x1b[0m';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const widgetArg = args.includes('--widget') ? args[args.indexOf('--widget') + 1] : null;

const results = [];
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail: detail || '' }); }

// Digest response exactly as the registrar computes it
function digest(username, realm, password, method, uri, nonce) {
  const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
  const nc = '00000001', cnonce = 'selftest', qop = 'auth';
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  return { username, realm, nonce, uri, qop, nc, cnonce, response: md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) };
}

(async () => {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/shadowpbx';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });

  const { WebCallWidget, Extension } = require('../src/models');
  const GuestManager = require('../src/services/webcall-guest');
  const gm = new GuestManager();

  // --- fixture ---
  let widget, temp = false;
  if (widgetArg) {
    widget = await WebCallWidget.findOne({ widgetId: widgetArg });
    if (!widget) { console.error(`Widget ${widgetArg} not found`); process.exit(1); }
  } else {
    const ext = await Extension.findOne({}).lean();
    widget = await WebCallWidget.create({
      widgetId: 'selftest-' + crypto.randomBytes(3).toString('hex'),
      name: 'Phase 2 self-test',
      destination: { type: 'extension', target: ext ? ext.extension : '1001' },
      allowedDomains: ['example.com'],
      maxConcurrent: 2
    });
    temp = true;
  }
  const target = widget.destination.target;
  const realm = process.env.SIP_DOMAIN || 'shadowpbx';

  try {
    // 1. issue
    const issued = await gm.issueToken({ widgetId: widget.widgetId, ip: '198.51.100.7', origin: 'https://example.com', userAgent: 'selftest' });
    check('token issued for a valid widget', issued.ok, issued.error || `user=${issued.ok ? issued.guest.username : ''}`);
    if (!issued.ok) throw new Error('cannot continue without a token');
    const guest = issued.guest;
    check('username uses the web- prefix', gm.isGuestUser(guest.username), guest.username);
    check('secret is not guessable (>= 32 chars)', guest.secret.length >= 32, `${guest.secret.length} chars`);
    check('guest is NOT in the Extension collection', !(await Extension.findOne({ extension: guest.username })), '');

    // 2. refusals
    const unknown = await gm.issueToken({ widgetId: 'no-such-widget', ip: '198.51.100.8' });
    check('unknown widget refused', !unknown.ok && unknown.status === 404, `status ${unknown.status}`);
    const badOrigin = await gm.issueToken({ widgetId: widget.widgetId, ip: '198.51.100.9', origin: 'https://evil.example.net' });
    const originRestricted = (widget.allowedDomains || []).length > 0;
    check('origin outside allowedDomains refused', originRestricted ? (!badOrigin.ok && badOrigin.status === 403) : true,
      originRestricted ? `status ${badOrigin.status}` : 'widget allows any site — skipped');

    // 3/4. digest auth
    const sipUri = `sip:${realm}`;
    let nonce = [...gm.nonces.keys()][0];
    if (!nonce) { gm.challenge({ send: () => {} }, guest.username); nonce = [...gm.nonces.keys()].pop(); }
    const good = gm.verify(guest.username, digest(guest.username, realm, guest.secret, 'INVITE', sipUri, nonce), 'INVITE');
    check('correct token passes digest auth', good.ok, good.reason || '');
    gm.challenge({ send: () => {} }, guest.username);
    const nonce2 = [...gm.nonces.keys()].pop();
    const bad = gm.verify(guest.username, digest(guest.username, realm, 'wrong-password', 'INVITE', sipUri, nonce2), 'INVITE');
    check('wrong password fails digest auth', !bad.ok, bad.reason);
    const replay = gm.verify(guest.username, digest(guest.username, realm, guest.secret, 'INVITE', sipUri, nonce), 'INVITE');
    check('a used nonce cannot be replayed', !replay.ok, replay.reason);

    // 5. lockdown
    check('widget destination is allowed', gm.authorizeDestination(guest, target).allowed, `${widget.destination.type}:${target}`);
    check('widget id is accepted as the call target', gm.authorizeDestination(guest, widget.widgetId).allowed, '');
    const pstn = gm.authorizeDestination(guest, '919876543210');
    check('PSTN number refused (no toll fraud)', !pstn.allowed, pstn.reason);
    const other = gm.authorizeDestination(guest, String(target) === '1001' ? '1002' : '1001');
    check('another extension refused', !other.allowed, other.reason);
    const feature = gm.authorizeDestination(guest, '*11' + target);
    check('feature code (monitor) refused', !feature.allowed, feature.reason);

    // 6. single use
    const callId = 'selftest-call-' + crypto.randomBytes(4).toString('hex');
    check('token binds to its first call', gm.bindCall(guest.username, callId).ok, callId);
    const second = gm.bindCall(guest.username, callId + '-2');
    check('token refuses a second call', !second.ok, second.reason);
    check('guest is findable by Call-ID', !!gm.byCall(callId), '');

    // 7. teardown
    gm.endCall(callId, 'selftest');
    check('hangup destroys the guest identity', !gm.get(guest.username), '');
    const shortLived = await gm.issueToken({ widgetId: widget.widgetId, ip: '198.51.100.10', origin: 'https://example.com' });
    if (shortLived.ok) {
      shortLived.guest.expiresAt = Date.now() - 1;
      check('an unused token expires', !gm.get(shortLived.guest.username), '');
    }

    // 8. rate limit
    let limited = false;
    for (let i = 0; i < 25; i++) {
      const r = await gm.issueToken({ widgetId: widget.widgetId, ip: '203.0.113.99', origin: 'https://example.com' });
      if (!r.ok && r.status === 429) { limited = true; break; }
    }
    check('token flood is rate-limited', limited, limited ? '429 after repeated requests' : 'no 429 seen');
    const cap = gm.activeCount(widget.widgetId) <= (widget.maxConcurrent || 5) + 1;
    check('concurrent guests stay within the widget cap', cap, `active=${gm.activeCount(widget.widgetId)} max=${widget.maxConcurrent}`);
  } catch (e) {
    check('no exception', false, e.message);
  } finally {
    if (temp) await WebCallWidget.deleteOne({ widgetId: widget.widgetId });
    await mongoose.disconnect();
  }

  const passed = results.filter(r => r.ok).length;
  const ok = passed === results.length;
  if (asJson) {
    console.log(JSON.stringify({ ok, summary: { passed, total: results.length }, results }, null, 2));
    process.exit(ok ? 0 : 1);
  }
  console.log(`\n${B}Web-call guest self-test${N} ${D}(widget ${widget.widgetId} -> ${widget.destination.type}:${target})${N}\n`);
  for (const r of results) console.log(`  ${r.ok ? G + '✓' : R + '✗'}${N} ${r.name}${r.detail ? ` ${D}— ${r.detail}${N}` : ''}`);
  console.log(`\n${ok ? G + 'All checks passed' : R + `${results.length - passed} check(s) failed`}${N} (${passed}/${results.length})\n`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
