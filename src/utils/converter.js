const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings';
const PCAP_DIR = path.join(RECORDINGS_DIR, 'pcaps');
const WAV_DIR = path.join(RECORDINGS_DIR, 'wav');
const TMP_DIR = path.join(RECORDINGS_DIR, 'tmp');
const TIMEOUT_CAP = 900000; // 15 minute cap

[WAV_DIR, TMP_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ============================================================
// Background conversion queue
//
// When a call ends, the pcap is queued for conversion. The queue
// processes one at a time using async child processes so live
// calls are never affected. If a conversion fails or times out,
// the pcap stays on disk and the periodic sync picks it up later.
// ============================================================
const conversionQueue = [];
let isProcessing = false;

function queueConversion(sipCallId, outputName, cdr) {
  conversionQueue.push({ sipCallId, outputName, cdr });
  logger.debug(`Recording queued: ${outputName} (queue length: ${conversionQueue.length})`);
  processQueue();
}

async function processQueue() {
  if (isProcessing || conversionQueue.length === 0) return;
  isProcessing = true;

  while (conversionQueue.length > 0) {
    const job = conversionQueue.shift();
    try {
      const wavPath = await pcapToWavAsync(job.sipCallId, job.outputName);
      if (wavPath && job.cdr) {
        job.cdr.recordingPath = wavPath;
        job.cdr.recordingSize = fs.statSync(wavPath).size;
        job.cdr.recorded = true;
        await job.cdr.save().catch(e => logger.error(`CDR recording update: ${e.message}`));
        logger.info(`RECORDING: saved ${wavPath} for [${job.outputName}]`);
      } else if (!wavPath) {
        logger.warn(`Recording conversion produced no output for ${job.outputName} — will retry in background sync`);
      }
    } catch (err) {
      logger.error(`Recording queue job failed for ${job.outputName}: ${err.message}`);
    }
  }

  isProcessing = false;
}

// ============================================================
// Dynamic timeout based on pcap file size
// ~1MB pcap ≈ 1 minute of call ≈ needs ~10s to process
// Generous padding for slow disks/CPUs
// ============================================================
function getTimeout(pcapPath, baseTimeout) {
  try {
    const sizeMB = fs.statSync(pcapPath).size / (1024 * 1024);
    // Minimum baseTimeout, scale by 15s per MB, cap at 15 minutes
    const scaled = Math.max(baseTimeout, Math.ceil(sizeMB * 15000));
    return Math.min(scaled, TIMEOUT_CAP);
  } catch (e) {
    return baseTimeout;
  }
}

// ============================================================
// Sync version — used by batch/startup conversion only
// ============================================================
function pcapToWav(sipCallId, outputName) {
  try {
    if (!fs.existsSync(PCAP_DIR)) return null;
    const pcapFiles = fs.readdirSync(PCAP_DIR).filter(f => f.startsWith(sipCallId) && f.endsWith('.pcap'));
    if (pcapFiles.length === 0) { logger.warn(`No pcap for ${sipCallId}`); return null; }

    const pcapPath = path.join(PCAP_DIR, pcapFiles[0]);
    const rawPath = path.join(TMP_DIR, `${outputName}.raw`);
    const wavPath = path.join(WAV_DIR, `${outputName}.wav`);

    const fileSizeMB = (fs.statSync(pcapPath).size / (1024 * 1024)).toFixed(1);
    const tsharkTimeout = getTimeout(pcapPath, 30000);
    const soxTimeout = getTimeout(pcapPath, 15000);

    logger.debug(`Converting ${pcapFiles[0]} (${fileSizeMB}MB, tshark timeout=${Math.round(tsharkTimeout/1000)}s)`);

    const ssrcs = execSync(
      `tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y rtp -T fields -e rtp.ssrc 2>/dev/null | sort -u`,
      { timeout: tsharkTimeout }
    ).toString().trim().split('\n').filter(Boolean);

    if (ssrcs.length >= 2) {
      const raw1 = path.join(TMP_DIR, `${outputName}_1.raw`);
      const raw2 = path.join(TMP_DIR, `${outputName}_2.raw`);
      const wav1 = path.join(TMP_DIR, `${outputName}_1.wav`);
      const wav2 = path.join(TMP_DIR, `${outputName}_2.wav`);

      execSync(`tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y "rtp.ssrc==${ssrcs[0]}" -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${raw1}"`, { timeout: tsharkTimeout });
      execSync(`tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y "rtp.ssrc==${ssrcs[1]}" -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${raw2}"`, { timeout: tsharkTimeout });

      execSync(`sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${raw1}" "${wav1}" 2>/dev/null`, { timeout: soxTimeout });
      execSync(`sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${raw2}" "${wav2}" 2>/dev/null`, { timeout: soxTimeout });

      execSync(`sox -M "${wav1}" "${wav2}" "${wavPath}" 2>/dev/null`, { timeout: soxTimeout });
      [raw1, raw2, wav1, wav2].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    } else {
      execSync(`tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y rtp -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${rawPath}"`, { timeout: tsharkTimeout });
      if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0) return null;
      execSync(`sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${rawPath}" "${wavPath}" 2>/dev/null`, { timeout: soxTimeout });
      try { fs.unlinkSync(rawPath); } catch(e) {}
    }

    if (fs.existsSync(wavPath)) {
      const size = fs.statSync(wavPath).size;
      logger.info(`Recording: ${wavPath} (${(size / 1024).toFixed(1)}KB)`);
      return wavPath;
    }
    return null;
  } catch (err) {
    logger.error(`pcap→wav failed: ${err.message}`);
    return null;
  }
}

// ============================================================
// Async version — runs in child process, doesn't block event loop
// ============================================================
function pcapToWavAsync(sipCallId, outputName) {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(PCAP_DIR)) return resolve(null);
      const pcapFiles = fs.readdirSync(PCAP_DIR).filter(f => f.startsWith(sipCallId) && f.endsWith('.pcap'));
      if (pcapFiles.length === 0) { logger.warn(`No pcap for ${sipCallId}`); return resolve(null); }

      const pcapPath = path.join(PCAP_DIR, pcapFiles[0]);
      const wavPath = path.join(WAV_DIR, `${outputName}.wav`);
      const fileSizeMB = (fs.statSync(pcapPath).size / (1024 * 1024)).toFixed(1);
      const timeoutMs = getTimeout(pcapPath, 30000);

      logger.debug(`Async converting ${pcapFiles[0]} (${fileSizeMB}MB, timeout=${Math.round(timeoutMs/1000)}s)`);

      const raw1 = path.join(TMP_DIR, `${outputName}_1.raw`);
      const raw2 = path.join(TMP_DIR, `${outputName}_2.raw`);
      const wav1 = path.join(TMP_DIR, `${outputName}_1.wav`);
      const wav2 = path.join(TMP_DIR, `${outputName}_2.wav`);
      const rawPath = path.join(TMP_DIR, `${outputName}.raw`);

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

      exec(`/bin/bash -c '${script.replace(/'/g, "'\\''")}'`, { timeout: timeoutMs }, (err) => {
        if (err) {
          logger.error(`pcap→wav async failed for ${outputName}: ${err.message}`);
          return resolve(null);
        }
        if (fs.existsSync(wavPath)) {
          const size = fs.statSync(wavPath).size;
          logger.info(`Recording: ${wavPath} (${(size / 1024).toFixed(1)}KB)`);
          resolve(wavPath);
        } else {
          logger.warn(`pcap→wav: no output for ${sipCallId}`);
          resolve(null);
        }
      });
    } catch (err) {
      logger.error(`pcap→wav async setup failed: ${err.message}`);
      resolve(null);
    }
  });
}

// ============================================================
// Convert any pending pcaps that don't have a matching wav
// Runs at startup and periodically to catch:
//   - Recordings that failed/timed out on first attempt
//   - Recordings from before a crash/restart
//   - Very large pcaps that need more time
// ============================================================
function convertAllPending() {
  try {
    if (!fs.existsSync(PCAP_DIR)) return;
    const pcapFiles = fs.readdirSync(PCAP_DIR).filter(f => f.endsWith('.pcap'));
    let queued = 0;
    for (const f of pcapFiles) {
      const base = f.replace('.pcap', '');
      // Skip if wav already exists
      if (fs.existsSync(path.join(WAV_DIR, `${base}.wav`))) continue;
      // Skip tiny/empty pcaps (likely incomplete writes)
      const pcapPath = path.join(PCAP_DIR, f);
      try {
        if (fs.statSync(pcapPath).size < 1000) continue;
      } catch (e) { continue; }
      // Queue for async conversion
      queueConversion(f.split('-')[0], base, null);
      queued++;
    }
    if (queued > 0) logger.info(`Background sync: ${queued} pending recording(s) queued for conversion`);
  } catch (err) { logger.error(`Background sync: ${err.message}`); }
}

// ============================================================
// Sync pending recordings with CDR records
// Finds CDRs that have recorded=false but have a matching wav
// (e.g. from background conversion that completed after CDR was saved)
// ============================================================
async function syncRecordingsWithCDR() {
  try {
    // First convert any pending pcaps
    convertAllPending();

    // Then sync wav files back to CDR records
    if (!fs.existsSync(WAV_DIR)) return;

    let CDR;
    try { CDR = require('../models').CDR; } catch (e) { return; }

    // Find CDRs that should have recordings but don't
    const unsyncedCDRs = await CDR.find({
      status: 'completed',
      $or: [
        { recorded: { $ne: true } },
        { recordingPath: { $exists: false } },
        { recordingPath: null },
        { recordingPath: '' }
      ],
      startTime: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } // last 7 days
    }).limit(50);

    let synced = 0;
    for (const cdr of unsyncedCDRs) {
      // Check if a wav file exists for this CDR
      const wavPath = path.join(WAV_DIR, `${cdr.callId}.wav`);
      if (fs.existsSync(wavPath)) {
        cdr.recordingPath = wavPath;
        cdr.recordingSize = fs.statSync(wavPath).size;
        cdr.recorded = true;
        await cdr.save();
        synced++;
      }
    }
    if (synced > 0) logger.info(`Background sync: linked ${synced} recording(s) to CDR records`);
  } catch (err) {
    logger.error(`CDR recording sync: ${err.message}`);
  }
}

// ============================================================
// Start periodic background sync
// Runs every 2 minutes to pick up failed/pending conversions
// and link them back to CDR records
// ============================================================
let syncInterval = null;
function startBackgroundSync() {
  // Run initial sync after 10 seconds (let the app fully start)
  setTimeout(() => {
    convertAllPending();
    syncRecordingsWithCDR();
  }, 10000);

  // Then run every 2 minutes
  syncInterval = setInterval(() => {
    syncRecordingsWithCDR();
  }, 120000);

  logger.info('Recording background sync: started (every 2 minutes)');
}

function stopBackgroundSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

module.exports = {
  pcapToWav,
  pcapToWavAsync,
  queueConversion,
  convertAllPending,
  syncRecordingsWithCDR,
  startBackgroundSync,
  stopBackgroundSync
};
