#!/usr/bin/env node
/**
 * ShadowPBX Recording Worker
 *
 * Watches for new metadata files from RTPEngine (written when a call ends),
 * converts the corresponding pcap to WAV, and links to CDR in MongoDB.
 *
 * Key design: watches METADATA directory, not pcaps. RTPEngine writes the
 * metadata file only after the call ends and the pcap is complete. This
 * avoids triggering on partial pcaps during active calls.
 *
 * Usage:
 *   node src/recorder-worker.js
 *   systemctl start shadowpbx-recorder
 */

require('dotenv').config({ path: '/opt/shadowpbx/.env' });

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

// ============================================================
// Configuration
// ============================================================
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings';
const SPOOL_DIR = process.env.RECORDING_SPOOL_DIR || '/var/spool/rtpengine';
const PCAP_DIR = path.join(SPOOL_DIR, 'pcaps');
const META_DIR = path.join(SPOOL_DIR, 'metadata');
const WAV_DIR = path.join(RECORDINGS_DIR, 'wav');
const TMP_DIR = path.join(RECORDINGS_DIR, 'tmp');
const MONGODB_URI = process.env.MONGODB_URI;
const LOG_LEVEL = process.env.RECORDER_LOG_LEVEL || process.env.LOG_LEVEL || 'info';
const TIMEOUT_CAP = 900000; // 15 minute cap
const POLL_INTERVAL = 30000; // 30 seconds — fallback poll
const CDR_SYNC_INTERVAL = 120000; // 2 minutes

// Log levels
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[LOG_LEVEL] || 1;

function log(level, msg) {
  if (LEVELS[level] >= currentLevel) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`${ts} [${level.toUpperCase()}] [recorder] ${msg}`);
  }
}

// Ensure directories exist
[WAV_DIR, TMP_DIR, PCAP_DIR, META_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ============================================================
// CDR Model
// ============================================================
const cdrSchema = new mongoose.Schema({
  callId: { type: String, index: true },
  sipCallId: { type: String, index: true },
  status: String,
  recorded: Boolean,
  recordingPath: String,
  recordingSize: Number,
  startTime: Date
}, { collection: 'cdrs', strict: false });

let CDR;

// ============================================================
// Track what's been processed or is in-flight to prevent duplicates
// ============================================================
const processed = new Set();
const inFlight = new Set();
const queue = [];
let processing = false;

function enqueue(pcapFile) {
  if (processed.has(pcapFile) || inFlight.has(pcapFile) || queue.some(j => j.pcapFile === pcapFile)) {
    log('debug', `Skipping (already handled): ${pcapFile}`);
    return;
  }

  // Check if WAV already exists
  const baseName = pcapFile.replace('.pcap', '');
  const wavPath = path.join(WAV_DIR, `${baseName}.wav`);
  if (fs.existsSync(wavPath)) {
    processed.add(pcapFile);
    log('debug', `Skipping (wav exists): ${pcapFile}`);
    return;
  }

  queue.push({ pcapFile });
  log('info', `Queued: ${pcapFile} (queue: ${queue.length})`);
  processNext();
}

async function processNext() {
  if (processing || queue.length === 0) return;
  processing = true;

  while (queue.length > 0) {
    const job = queue.shift();
    inFlight.add(job.pcapFile);
    try {
      const result = await convertPcap(job.pcapFile);
      processed.add(job.pcapFile);
    } catch (err) {
      log('error', `Conversion failed for ${job.pcapFile}: ${err.message}`);
    }
    inFlight.delete(job.pcapFile);
  }

  processing = false;
}

// ============================================================
// Dynamic timeout based on file size
// ============================================================
function getTimeout(filePath) {
  try {
    const sizeMB = fs.statSync(filePath).size / (1024 * 1024);
    const scaled = Math.max(30000, Math.ceil(sizeMB * 15000));
    return Math.min(scaled, TIMEOUT_CAP);
  } catch (e) {
    return 60000;
  }
}

// ============================================================
// Parse metadata file to find the matching pcap filename
// ============================================================
function parseMeta(metaPath) {
  try {
    const content = fs.readFileSync(metaPath, 'utf-8');
    const lines = content.split('\n');
    // First line is the pcap path
    const pcapPath = lines[0].trim();
    const pcapFile = path.basename(pcapPath);
    return { pcapFile, pcapPath };
  } catch (e) {
    return null;
  }
}

// ============================================================
// Convert a single pcap file to wav
// ============================================================
function convertPcap(pcapFileName) {
  return new Promise((resolve) => {
    const pcapPath = path.join(PCAP_DIR, pcapFileName);
    const baseName = pcapFileName.replace('.pcap', '');
    const wavPath = path.join(WAV_DIR, `${baseName}.wav`);

    // Skip if wav already exists
    if (fs.existsSync(wavPath)) {
      log('debug', `Already converted: ${pcapFileName}`);
      return resolve(wavPath);
    }

    // Skip tiny/empty pcaps
    try {
      const size = fs.statSync(pcapPath).size;
      if (size < 1000) {
        log('debug', `Skipping tiny pcap: ${pcapFileName} (${size} bytes)`);
        return resolve(null);
      }
    } catch (e) {
      log('warn', `Cannot stat pcap: ${pcapFileName}`);
      return resolve(null);
    }

    const fileSizeMB = (fs.statSync(pcapPath).size / (1024 * 1024)).toFixed(1);
    const timeoutMs = getTimeout(pcapPath);

    log('info', `Converting: ${pcapFileName} (${fileSizeMB}MB, timeout=${Math.round(timeoutMs / 1000)}s)`);

    const raw1 = path.join(TMP_DIR, `${baseName}_1.raw`);
    const raw2 = path.join(TMP_DIR, `${baseName}_2.raw`);
    const wav1 = path.join(TMP_DIR, `${baseName}_1.wav`);
    const wav2 = path.join(TMP_DIR, `${baseName}_2.wav`);
    const rawPath = path.join(TMP_DIR, `${baseName}.raw`);

    const script = `
      SSRCS=$(tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y rtp -T fields -e rtp.ssrc 2>/dev/null | sort -u)
      SSRC_COUNT=$(echo "$SSRCS" | grep -c .)
      if [ "$SSRC_COUNT" -ge 2 ]; then
        SSRC1=$(echo "$SSRCS" | head -1)
        SSRC2=$(echo "$SSRCS" | tail -1)
        tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y "rtp.ssrc==$SSRC1" -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${raw1}"
        tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y "rtp.ssrc==$SSRC2" -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${raw2}"
        sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${raw1}" "${wav1}" 2>/dev/null
        sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${raw2}" "${wav2}" 2>/dev/null
        sox -M "${wav1}" "${wav2}" "${wavPath}" 2>/dev/null
        rm -f "${raw1}" "${raw2}" "${wav1}" "${wav2}"
      else
        tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y rtp -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${rawPath}"
        if [ -s "${rawPath}" ]; then
          sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${rawPath}" "${wavPath}" 2>/dev/null
        fi
        rm -f "${rawPath}"
      fi
    `;

    exec(`/bin/bash -c '${script.replace(/'/g, "'\\''")}'`, { timeout: timeoutMs }, async (err) => {
      if (err) {
        log('error', `tshark/sox failed for ${pcapFileName}: ${err.message}`);
        return resolve(null);
      }

      if (fs.existsSync(wavPath)) {
        const size = fs.statSync(wavPath).size;
        log('info', `Converted: ${wavPath} (${(size / 1024).toFixed(1)}KB)`);
        await linkToCDR(baseName, wavPath, size);
        resolve(wavPath);
      } else {
        log('warn', `No output for ${pcapFileName}`);
        resolve(null);
      }
    });
  });
}

// ============================================================
// Link wav to CDR in MongoDB
// ============================================================
async function linkToCDR(baseName, wavPath, size) {
  if (!CDR) return;

  try {
    // The pcap filename format is: rtpengineCallId-tag.pcap
    // Extract the RTPEngine call-id (first 5 UUID segments)
    const rtpCallId = baseName.split('-').slice(0, 5).join('-');

    // Primary match: rtpengineCallId field (set by call-handler when call answers)
    let cdr = await CDR.findOne({ rtpengineCallId: rtpCallId, status: 'completed' });

    // Fallback: try sipCallId or callId
    if (!cdr) cdr = await CDR.findOne({ sipCallId: rtpCallId, status: 'completed' });
    if (!cdr) cdr = await CDR.findOne({ callId: rtpCallId, status: 'completed' });

    if (cdr) {
      cdr.recordingPath = wavPath;
      cdr.recordingSize = size;
      cdr.recorded = true;
      await cdr.save();
      log('info', `CDR linked: ${cdr.callId} -> ${path.basename(wavPath)}`);
    } else {
      log('debug', `No CDR match for rtpCallId=${rtpCallId} — will retry in sync`);
    }
  } catch (err) {
    log('error', `CDR link failed: ${err.message}`);
  }
}

// ============================================================
// Sync: find CDRs missing recordings that have matching wav files
// ============================================================
async function syncCDRRecordings() {
  if (!CDR) return;

  try {
    const unsyncedCDRs = await CDR.find({
      status: 'completed',
      $or: [
        { recorded: { $ne: true } },
        { recordingPath: { $exists: false } },
        { recordingPath: null },
        { recordingPath: '' }
      ],
      startTime: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    }).limit(100);

    let synced = 0;
    const wavFiles = fs.readdirSync(WAV_DIR).filter(f => f.endsWith('.wav'));

    for (const cdr of unsyncedCDRs) {
      const match = wavFiles.find(f =>
        f.includes(cdr.callId) ||
        (cdr.sipCallId && f.includes(cdr.sipCallId)) ||
        (cdr.rtpengineCallId && f.includes(cdr.rtpengineCallId))
      );

      if (match) {
        const wavPath = path.join(WAV_DIR, match);
        cdr.recordingPath = wavPath;
        cdr.recordingSize = fs.statSync(wavPath).size;
        cdr.recorded = true;
        await cdr.save();
        synced++;
      }
    }

    if (synced > 0) log('info', `CDR sync: linked ${synced} recording(s)`);
  } catch (err) {
    log('error', `CDR sync error: ${err.message}`);
  }
}

// ============================================================
// Watch METADATA directory for new files
// RTPEngine writes the metadata file AFTER the call ends and
// the pcap is fully written — this is the safe trigger point.
// ============================================================
function startWatcher() {
  log('info', `Watching: ${META_DIR}`);

  // Debounce map to prevent duplicate processing
  const debounceTimers = {};

  try {
    fs.watch(META_DIR, (eventType, filename) => {
      if (!filename || !filename.endsWith('.txt')) return;

      // Debounce — wait 2 seconds after last event for this file
      if (debounceTimers[filename]) clearTimeout(debounceTimers[filename]);
      debounceTimers[filename] = setTimeout(() => {
        delete debounceTimers[filename];

        const metaPath = path.join(META_DIR, filename);
        if (!fs.existsSync(metaPath)) return;

        const meta = parseMeta(metaPath);
        if (!meta || !meta.pcapFile) {
          log('warn', `Cannot parse metadata: ${filename}`);
          return;
        }

        // Check pcap exists and is non-trivial
        const pcapPath = path.join(PCAP_DIR, meta.pcapFile);
        if (!fs.existsSync(pcapPath)) {
          log('warn', `Pcap not found for metadata: ${meta.pcapFile}`);
          return;
        }

        try {
          if (fs.statSync(pcapPath).size < 1000) {
            log('debug', `Skipping tiny pcap from metadata: ${meta.pcapFile}`);
            return;
          }
        } catch (e) { return; }

        enqueue(meta.pcapFile);
      }, 2000);
    });
  } catch (err) {
    log('error', `fs.watch failed on ${META_DIR}: ${err.message} — using polling only`);
  }
}

// ============================================================
// Poll for pending pcaps that don't have matching wavs
// ============================================================
function pollForPending() {
  try {
    const pcapFiles = fs.readdirSync(PCAP_DIR).filter(f => f.endsWith('.pcap'));

    for (const f of pcapFiles) {
      const baseName = f.replace('.pcap', '');

      // Skip if wav exists
      if (fs.existsSync(path.join(WAV_DIR, `${baseName}.wav`))) continue;

      // Skip tiny files
      try {
        if (fs.statSync(path.join(PCAP_DIR, f)).size < 1000) continue;
      } catch (e) { continue; }

      // Only enqueue if metadata exists (call has ended)
      const metaFile = `rtpengine-meta-${baseName}.txt`;
      if (!fs.existsSync(path.join(META_DIR, metaFile))) {
        log('debug', `Skipping ${f} — no metadata (call may still be active)`);
        continue;
      }

      enqueue(f);
    }
  } catch (err) {
    log('error', `Poll error: ${err.message}`);
  }
}

// ============================================================
// Startup
// ============================================================
async function main() {
  log('info', '═══════════════════════════════════════');
  log('info', 'ShadowPBX Recording Worker starting');
  log('info', `  Spool:    ${SPOOL_DIR}`);
  log('info', `  Pcaps:    ${PCAP_DIR}`);
  log('info', `  Metadata: ${META_DIR}`);
  log('info', `  Output:   ${WAV_DIR}`);
  log('info', `  Timeout:  ${TIMEOUT_CAP / 1000}s cap`);
  log('info', '═══════════════════════════════════════');

  // Connect to MongoDB
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI);
      CDR = mongoose.model('CDR', cdrSchema);
      log('info', 'MongoDB connected');
    } catch (err) {
      log('error', `MongoDB failed: ${err.message} — CDR linking disabled`);
    }
  } else {
    log('warn', 'No MONGODB_URI — CDR linking disabled');
  }

  // Process any existing pending pcaps
  pollForPending();

  // Start inotify watcher on metadata directory
  startWatcher();

  // Periodic poll as fallback
  setInterval(pollForPending, POLL_INTERVAL);

  // Periodic CDR sync
  setInterval(syncCDRRecordings, CDR_SYNC_INTERVAL);
  setTimeout(syncCDRRecordings, 10000);

  log('info', 'Recording worker running');
}

// Graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'Shutting down...');
  mongoose.disconnect().then(() => process.exit(0));
});
process.on('SIGINT', () => {
  log('info', 'Shutting down...');
  mongoose.disconnect().then(() => process.exit(0));
});
process.on('uncaughtException', (err) => {
  log('error', `Uncaught exception: ${err.message}`);
});
process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason && reason.message ? reason.message : reason}`);
});

main().catch(err => {
  log('error', `Fatal: ${err.message}`);
  process.exit(1);
});
