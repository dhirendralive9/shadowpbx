const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// ============================================================
// Simplified converter — the heavy lifting is now done by the
// standalone recorder-worker.js service.
//
// This module only provides:
//   - startBackgroundSync() — periodically checks if wav files
//     exist that haven't been linked to CDR records yet
//   - No more tshark/sox/pcapToWav in the PBX process
// ============================================================

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings';
const WAV_DIR = path.join(RECORDINGS_DIR, 'wav');

let syncInterval = null;

// ============================================================
// Sync wav files back to CDR records
// The recorder-worker does the conversion and CDR linking,
// but this catches any edge cases where the worker linked
// the file but the PBX didn't see it yet
// ============================================================
async function syncRecordingsWithCDR() {
  try {
    if (!fs.existsSync(WAV_DIR)) return;

    let CDR;
    try { CDR = require('../models').CDR; } catch (e) { return; }

    const unsyncedCDRs = await CDR.find({
      status: 'completed',
      $or: [
        { recorded: { $ne: true } },
        { recordingPath: { $exists: false } },
        { recordingPath: null },
        { recordingPath: '' }
      ],
      startTime: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
    }).limit(50);

    let synced = 0;
    for (const cdr of unsyncedCDRs) {
      // Look for wav files matching callId or sipCallId
      const wavFiles = fs.readdirSync(WAV_DIR).filter(f =>
        f.endsWith('.wav') && (
          f.includes(cdr.callId) ||
          (cdr.sipCallId && f.includes(cdr.sipCallId))
        )
      );

      if (wavFiles.length > 0) {
        const wavFile = wavFiles[0];
        const wavPath = path.join(WAV_DIR, wavFile);
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

function startBackgroundSync() {
  // Initial sync after 15 seconds (give recorder-worker time to process)
  setTimeout(() => syncRecordingsWithCDR(), 15000);

  // Then sync every 2 minutes
  syncInterval = setInterval(() => syncRecordingsWithCDR(), 120000);

  logger.info('Recording background sync: started (every 2 minutes)');
}

function stopBackgroundSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

module.exports = { startBackgroundSync, stopBackgroundSync, syncRecordingsWithCDR };
