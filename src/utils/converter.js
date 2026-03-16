const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings';
const PCAP_DIR = path.join(RECORDINGS_DIR, 'pcaps');
const WAV_DIR = path.join(RECORDINGS_DIR, 'wav');
const TMP_DIR = path.join(RECORDINGS_DIR, 'tmp');

[WAV_DIR, TMP_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function pcapToWav(sipCallId, outputName) {
  try {
    if (!fs.existsSync(PCAP_DIR)) return null;
    const pcapFiles = fs.readdirSync(PCAP_DIR).filter(f => f.startsWith(sipCallId) && f.endsWith('.pcap'));
    if (pcapFiles.length === 0) { logger.warn(`No pcap for ${sipCallId}`); return null; }

    const pcapPath = path.join(PCAP_DIR, pcapFiles[0]);
    const rawPath = path.join(TMP_DIR, `${outputName}.raw`);
    const wavPath = path.join(WAV_DIR, `${outputName}.wav`);

    // Extract both SSRC streams and merge
    const ssrcs = execSync(
      `tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y rtp -T fields -e rtp.ssrc 2>/dev/null | sort -u`,
      { timeout: 15000 }
    ).toString().trim().split('\n').filter(Boolean);

    if (ssrcs.length >= 2) {
      // Stereo: extract each stream separately
      const raw1 = path.join(TMP_DIR, `${outputName}_1.raw`);
      const raw2 = path.join(TMP_DIR, `${outputName}_2.raw`);
      const wav1 = path.join(TMP_DIR, `${outputName}_1.wav`);
      const wav2 = path.join(TMP_DIR, `${outputName}_2.wav`);

      execSync(`tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y "rtp.ssrc==${ssrcs[0]}" -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${raw1}"`, { timeout: 30000 });
      execSync(`tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y "rtp.ssrc==${ssrcs[1]}" -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${raw2}"`, { timeout: 30000 });

      execSync(`sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${raw1}" "${wav1}" 2>/dev/null`, { timeout: 15000 });
      execSync(`sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${raw2}" "${wav2}" 2>/dev/null`, { timeout: 15000 });

      // Merge to stereo
      execSync(`sox -M "${wav1}" "${wav2}" "${wavPath}" 2>/dev/null`, { timeout: 15000 });

      // Cleanup
      [raw1, raw2, wav1, wav2].forEach(f => { try { fs.unlinkSync(f); } catch(e) {} });
    } else {
      // Single stream fallback
      execSync(`tshark -n -r "${pcapPath}" -o rtp.heuristic_rtp:TRUE -Y rtp -T fields -e rtp.payload 2>/dev/null | tr -d '\\n' | xxd -r -p > "${rawPath}"`, { timeout: 30000 });
      if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size === 0) return null;
      execSync(`sox -t raw -r 8000 -e mu-law -b 8 -c 1 "${rawPath}" "${wavPath}" 2>/dev/null`, { timeout: 15000 });
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

function convertAllPending() {
  try {
    if (!fs.existsSync(PCAP_DIR)) return;
    const pcapFiles = fs.readdirSync(PCAP_DIR).filter(f => f.endsWith('.pcap'));
    let converted = 0;
    for (const f of pcapFiles) {
      const base = f.replace('.pcap', '');
      if (!fs.existsSync(path.join(WAV_DIR, `${base}.wav`))) {
        if (pcapToWav(f.split('-')[0], base)) converted++;
      }
    }
    if (converted > 0) logger.info(`Batch: ${converted} recordings converted`);
  } catch (err) { logger.error(`Batch conversion: ${err.message}`); }
}

module.exports = { pcapToWav, convertAllPending };
