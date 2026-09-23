#!/usr/bin/env node
// ============================================================
// ShadowPBX — RTPEngine WebRTC bridge self-test (Phase 1)
//
// Usage (from the app directory, e.g. /opt/shadowpbx):
//   node scripts/webrtc-selftest.js          # human-readable
//   node scripts/webrtc-selftest.js --json   # machine-readable
//
// Talks to RTPEngine's ng port directly (RTPENGINE_HOST/PORT from .env).
// Safe to run on a live PBX: uses throwaway call-ids that are deleted.
// Exit code 0 = all checks passed, 1 = something failed.
// ============================================================
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.LOG_LEVEL = process.env.LOG_LEVEL_SELFTEST || 'error';

const selftest = require('../src/utils/webrtc-selftest');
const rtpHelper = require('../src/utils/rtp-helper');

const G = '\x1b[32m', R = '\x1b[31m', B = '\x1b[1m', D = '\x1b[2m', N = '\x1b[0m';
const asJson = process.argv.includes('--json');

(async () => {
  let Client;
  try { Client = require('rtpengine-client').Client; }
  catch (e) { console.error('rtpengine-client not installed — run npm install'); process.exit(1); }

  const client = new Client({ timeout: 3000 });
  const cfg = rtpHelper.getConfig();

  let ping = null;
  try { ping = await client.ping(cfg); } catch (e) { ping = { result: 'error', error: e.message }; }
  if (!ping || ping.result !== 'pong') {
    const msg = `RTPEngine not responding on ${cfg.host}:${cfg.port} (${(ping && (ping.error || ping.result)) || 'no reply'})`;
    if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.log(`${R}[FAIL]${N} ${msg}`);
    process.exit(1);
  }

  const result = await selftest.run(client);
  try { client.close && client.close(); } catch (e) {}

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  console.log(`\n${B}RTPEngine WebRTC bridge self-test${N} ${D}(${cfg.host}:${cfg.port}, codec policy ${rtpHelper.webrtcSummary().codecPolicy})${N}\n`);
  for (const sc of result.scenarios) {
    console.log(`${sc.ok ? G + 'PASS' : R + 'FAIL'}${N}  ${B}${sc.name}${N}`);
    for (const r of sc.results) {
      console.log(`   ${r.ok ? G + '✓' : R + '✗'}${N} ${r.name}${r.detail ? ` ${D}— ${r.detail}${N}` : ''}`);
    }
    console.log('');
  }
  const s = result.summary;
  console.log(`${result.ok ? G + 'All checks passed' : R + `${s.failed} check(s) failed`}${N} (${s.passed}/${s.total})\n`);
  process.exit(result.ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
