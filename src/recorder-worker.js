#!/usr/bin/env node
/**
 * ShadowPBX Recording Worker
 *
 * A standalone service that watches for new pcap recordings from RTPEngine,
 * converts them to WAV files, and links them to CDR records in MongoDB.
 *
 * Runs as a separate systemd service (shadowpbx-recorder.service) so it
 * never impacts the main PBX process. If this worker crashes, calls
 * continue unaffected. If the PBX crashes, pending recordings still
 * get processed.
 *
 * Usage:
 *   node src/recorder-worker.js
 *   systemctl start shadowpbx-recorder
 *
 * Config via environment variables (reads .env from /opt/shadowpbx):
 *   RECORDINGS_DIR  - base recordings directory
 *   MONGODB_URI     - MongoDB connection string
 *   LOG_LEVEL       - debug|info|warn|error (default: info)
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
const POLL_INTERVAL = 10000; // 10 seconds — fallback if inotify misses
const CDR_SYNC_INTERVAL = 120000; // 2 minutes — sync wav files back to CDR

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
// CDR Model (minimal — just what the worker needs)
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
// Conversion queue
// ============================================================
const queue = [];
let processing = false;

function enqueue(pcapFile) {
  // Skip if already queued
  if (queue.some(j => j.pcapFile === pcapFile)) return;
  queue.push({ pcapFile });
  log('info', `Queued: ${pcapFile} (queue: ${queue.length})`);
  processNext();
}

async function processNext() {
  if (processing || queue.length === 0) return;
  processing = true;

  while (queue.length > 0) {
    const job = queue.shift();
    try {
      await convertPcap(job.pcapFile);
    } catch (err) {
      log('error', `Conversion failed for ${job.pcapFile}: ${err.message}`);
    }
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
// Convert a single pcap file to wav
// ============================================================
function convertPcap(pcapFileName) {
  return new Promise((resolve) => {
    const pcapPath = path.join(PCAP_DIR, pcapFileName);
    const baseName = pcapFileName.replace('.pcap', '');
    const sipCallId = baseName.split('-').slice(0, 5).join('-'); // UUID part
    const wavPath = path.join(WAV_DIR, `${baseName}.wav`);

    // Skip if wav already exists
    if (fs.existsSync(wavPath)) {
      log('debug', `Already converted: ${pcapFileName}`);
      return resolve(wavPath);
    }

    // Skip tiny/empty pcaps
    try {
      if (fs.statSync(pcapPath).size < 1000) {
        log('debug', `Skipping tiny pcap: ${pcapFileName} (${fs.statSync(pcapPath).size} bytes)`);
        return resolve(null);
      }
    } catch (e) {
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

        // Link to CDR
        await linkToCDR(sipCallId, baseName, wavPath, size);
        resolve(wavPath);
      } else {
        log('warn', `No output for ${pcapFileName}`);
        resolve(null);
      }
    });
  });
}

// ============================================================
// Link a wav file to its CDR record in MongoDB
// ============================================================
async function linkToCDR(sipCallId, baseName, wavPath, size) {
  if (!CDR) return;

  try {
    // Try matching by sipCallId first
    let cdr = await CDR.findOne({ sipCallId, status: 'completed' });

    // Fallback: try matching by callId (UUID)
    if (!cdr) {
      cdr = await CDR.findOne({ callId: sipCallId, status: 'completed' });
    }

    // Fallback: try matching the base name parts
    if (!cdr) {
      // The pcap filename is: sipCallId-tag.pcap
      // Try just the first UUID part
      const uuidPart = baseName.split('-').slice(0, 5).join('-');
      cdr = await CDR.findOne({
        $or: [{ sipCallId: uuidPart }, { callId: uuidPart }],
        status: 'completed'
      });
    }

    if (cdr) {
      cdr.recordingPath = wavPath;
      cdr.recordingSize = size;
      cdr.recorded = true;
      await cdr.save();
      log('info', `CDR linked: ${cdr.callId} -> ${path.basename(wavPath)}`);
    } else {
      log('debug', `No CDR match for sipCallId=${sipCallId}`);
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
    for (const cdr of unsyncedCDRs) {
      // Check for wav files matching callId or sipCallId
      const wavFiles = fs.readdirSync(WAV_DIR).filter(f =>
        f.endsWith('.wav') && (f.includes(cdr.callId) || (cdr.sipCallId && f.includes(cdr.sipCallId)))
      );

      if (wavFiles.length > 0) {
        // Prefer the 'mix' file if available
        const wavFile = wavFiles.find(f => f.includes('mix')) || wavFiles[0];
        const wavPath = path.join(WAV_DIR, wavFile);
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
// Watch for new pcap files using fs.watch (inotify)
// ============================================================
function startWatcher() {
  log('info', `Watching: ${PCAP_DIR}`);

  try {
    fs.watch(PCAP_DIR, (eventType, filename) => {
      if (!filename || !filename.endsWith('.pcap')) return;
      // Wait a moment for RTPEngine to finish writing
      setTimeout(() => {
        const pcapPath = path.join(PCAP_DIR, filename);
        if (fs.existsSync(pcapPath) && fs.statSync(pcapPath).size > 1000) {
          enqueue(filename);
        }
      }, 3000);
    });
  } catch (err) {
    log('error', `fs.watch failed: ${err.message} — falling back to polling only`);
  }
}

// ============================================================
// Poll for any pcap files that inotify might have missed
// ============================================================
function pollForPending() {
  try {
    const pcapFiles = fs.readdirSync(PCAP_DIR).filter(f => f.endsWith('.pcap'));

    for (const f of pcapFiles) {
      const baseName = f.replace('.pcap', '');
      const wavPath = path.join(WAV_DIR, `${baseName}.wav`);

      // Skip if already converted
      if (fs.existsSync(wavPath)) continue;

      // Skip tiny files
      const pcapPath = path.join(PCAP_DIR, f);
      try {
        if (fs.statSync(pcapPath).size < 1000) continue;
      } catch (e) { continue; }

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
  log('info', `  Spool:  ${PCAP_DIR}`);
  log('info', `  Output: ${WAV_DIR}`);
  log('info', `  Temp:   ${TMP_DIR}`);
  log('info', `  Timeout cap: ${TIMEOUT_CAP / 1000}s`);
  log('info', '═══════════════════════════════════════');

  // Connect to MongoDB
  if (MONGODB_URI) {
    try {
      await mongoose.connect(MONGODB_URI);
      CDR = mongoose.model('CDR', cdrSchema);
      log('info', 'MongoDB connected');
    } catch (err) {
      log('error', `MongoDB failed: ${err.message} — recordings will convert but CDR linking disabled`);
    }
  } else {
    log('warn', 'No MONGODB_URI — CDR linking disabled');
  }

  // Process any existing pending pcaps
  pollForPending();

  // Start inotify watcher
  startWatcher();

  // Periodic poll as fallback (every 10 seconds)
  setInterval(pollForPending, POLL_INTERVAL);

  // Periodic CDR sync (every 2 minutes)
  setInterval(syncCDRRecordings, CDR_SYNC_INTERVAL);

  // Initial CDR sync after 5 seconds
  setTimeout(syncCDRRecordings, 5000);

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
