const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const logger = require('../utils/logger');

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings';
const SPOOL_DIR = process.env.RECORDING_SPOOL_DIR || '/var/spool/rtpengine';
const BACKUP_DIR = path.join(process.env.APP_DIR || '/opt/shadowpbx', 'backups');
const WAV_DIR = path.join(RECORDINGS_DIR, 'wav');
const PCAP_DIR = path.join(SPOOL_DIR, 'pcaps');
const META_DIR = path.join(SPOOL_DIR, 'metadata');
const MONGODB_URI = process.env.MONGODB_URI || '';

// Ensure backup dir exists
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function registerSettingsRoutes(router) {
  const { SystemSettings, CDR } = require('../models');

  // ============================================================
  // GET /api/settings — get all system settings
  // ============================================================
  router.get('/settings', async (req, res) => {
    try {
      let settings = await SystemSettings.findById('system');
      if (!settings) {
        settings = await SystemSettings.create({ _id: 'system' });
      }
      res.json({ success: true, settings });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // PUT /api/settings — update system settings
  // ============================================================
  router.put('/settings', async (req, res) => {
    try {
      const updates = {};
      if (req.body.recordingRetention) updates.recordingRetention = req.body.recordingRetention;
      if (req.body.backup) updates.backup = req.body.backup;
      updates.updatedAt = new Date();

      let settings = await SystemSettings.findByIdAndUpdate('system', updates, { new: true, upsert: true });
      logger.info(`Settings updated by admin`);
      res.json({ success: true, settings });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // POST /api/settings/cleanup — run recording cleanup now
  // ============================================================
  router.post('/settings/cleanup', async (req, res) => {
    try {
      const settings = await SystemSettings.findById('system');
      const days = (settings && settings.recordingRetention && settings.recordingRetention.days) || 90;
      const deleteRecordings = !settings || !settings.recordingRetention || settings.recordingRetention.deleteRecordings !== false;
      const deletePcaps = !settings || !settings.recordingRetention || settings.recordingRetention.deletePcaps !== false;

      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      let deletedWav = 0, deletedPcap = 0, freedBytes = 0;

      // Delete old WAV files
      if (deleteRecordings && fs.existsSync(WAV_DIR)) {
        const wavFiles = fs.readdirSync(WAV_DIR).filter(f => f.endsWith('.wav'));
        for (const f of wavFiles) {
          const filePath = path.join(WAV_DIR, f);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtime < cutoff) {
              freedBytes += stat.size;
              fs.unlinkSync(filePath);
              deletedWav++;
            }
          } catch (e) {}
        }
      }

      // Delete old pcap files
      if (deletePcaps && fs.existsSync(PCAP_DIR)) {
        const pcapFiles = fs.readdirSync(PCAP_DIR).filter(f => f.endsWith('.pcap'));
        for (const f of pcapFiles) {
          const filePath = path.join(PCAP_DIR, f);
          try {
            const stat = fs.statSync(filePath);
            if (stat.mtime < cutoff) {
              freedBytes += stat.size;
              fs.unlinkSync(filePath);
              deletedPcap++;
              // Also delete matching metadata
              const metaFile = `rtpengine-meta-${f.replace('.pcap', '')}.txt`;
              const metaPath = path.join(META_DIR, metaFile);
              if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
            }
          } catch (e) {}
        }
      }

      // Update CDR records — clear recording paths for deleted files
      if (deletedWav > 0) {
        await CDR.updateMany(
          { startTime: { $lt: cutoff }, recorded: true },
          { $set: { recordingPath: '', recordingSize: 0 } }
        );
      }

      // Update last cleanup time
      await SystemSettings.findByIdAndUpdate('system', {
        'recordingRetention.lastCleanup': new Date()
      });

      const freedMB = (freedBytes / (1024 * 1024)).toFixed(1);
      logger.info(`Recording cleanup: ${deletedWav} WAV + ${deletedPcap} pcap files deleted (${freedMB}MB freed), cutoff=${days} days`);

      res.json({
        success: true,
        message: `Cleanup complete`,
        deletedWav,
        deletedPcap,
        freedMB: parseFloat(freedMB)
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // GET /api/settings/storage — get storage usage stats
  // ============================================================
  router.get('/settings/storage', async (req, res) => {
    try {
      let wavSize = 0, wavCount = 0, pcapSize = 0, pcapCount = 0;

      if (fs.existsSync(WAV_DIR)) {
        const files = fs.readdirSync(WAV_DIR).filter(f => f.endsWith('.wav'));
        wavCount = files.length;
        for (const f of files) {
          try { wavSize += fs.statSync(path.join(WAV_DIR, f)).size; } catch (e) {}
        }
      }

      if (fs.existsSync(PCAP_DIR)) {
        const files = fs.readdirSync(PCAP_DIR).filter(f => f.endsWith('.pcap'));
        pcapCount = files.length;
        for (const f of files) {
          try { pcapSize += fs.statSync(path.join(PCAP_DIR, f)).size; } catch (e) {}
        }
      }

      // Get backup files
      let backupSize = 0, backupCount = 0;
      if (fs.existsSync(BACKUP_DIR)) {
        const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.gz') || f.endsWith('.archive'));
        backupCount = files.length;
        for (const f of files) {
          try { backupSize += fs.statSync(path.join(BACKUP_DIR, f)).size; } catch (e) {}
        }
      }

      res.json({
        success: true,
        storage: {
          recordings: { count: wavCount, sizeMB: parseFloat((wavSize / (1024 * 1024)).toFixed(1)) },
          pcaps: { count: pcapCount, sizeMB: parseFloat((pcapSize / (1024 * 1024)).toFixed(1)) },
          backups: { count: backupCount, sizeMB: parseFloat((backupSize / (1024 * 1024)).toFixed(1)) },
          totalMB: parseFloat(((wavSize + pcapSize + backupSize) / (1024 * 1024)).toFixed(1))
        }
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // POST /api/settings/backup — create MongoDB backup now
  // ============================================================
  router.post('/settings/backup', async (req, res) => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const backupName = `shadowpbx-backup-${timestamp}`;
      const backupPath = path.join(BACKUP_DIR, backupName);

      // Parse MongoDB URI for mongodump
      let dumpCmd = `mongodump --uri="${MONGODB_URI}" --out="${backupPath}" --quiet`;

      exec(dumpCmd, { timeout: 120000 }, async (err) => {
        if (err) {
          logger.error(`Backup failed: ${err.message}`);
          return res.status(500).json({ success: false, error: `Backup failed: ${err.message}` });
        }

        // Compress the backup
        try {
          execSync(`tar -czf "${backupPath}.tar.gz" -C "${BACKUP_DIR}" "${backupName}"`, { timeout: 60000 });
          // Remove uncompressed directory
          execSync(`rm -rf "${backupPath}"`, { timeout: 10000 });

          const archivePath = `${backupPath}.tar.gz`;
          const archiveSize = fs.statSync(archivePath).size;

          // Update settings
          await SystemSettings.findByIdAndUpdate('system', {
            'backup.lastBackup': new Date(),
            'backup.lastBackupPath': archivePath,
            'backup.lastBackupSize': archiveSize
          });

          // Clean old backups based on retention
          const settings = await SystemSettings.findById('system');
          const retainDays = (settings && settings.backup && settings.backup.retainDays) || 7;
          cleanOldBackups(retainDays);

          const sizeMB = (archiveSize / (1024 * 1024)).toFixed(1);
          logger.info(`Backup created: ${archivePath} (${sizeMB}MB)`);

          res.json({
            success: true,
            message: `Backup created`,
            backup: {
              path: archivePath,
              name: `${backupName}.tar.gz`,
              sizeMB: parseFloat(sizeMB),
              createdAt: new Date()
            }
          });
        } catch (compressErr) {
          logger.error(`Backup compress failed: ${compressErr.message}`);
          res.status(500).json({ success: false, error: `Compress failed: ${compressErr.message}` });
        }
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // GET /api/settings/backups — list available backups
  // ============================================================
  router.get('/settings/backups', async (req, res) => {
    try {
      if (!fs.existsSync(BACKUP_DIR)) return res.json({ success: true, backups: [] });

      const files = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.tar.gz'))
        .map(f => {
          const stat = fs.statSync(path.join(BACKUP_DIR, f));
          return {
            name: f,
            path: path.join(BACKUP_DIR, f),
            sizeMB: parseFloat((stat.size / (1024 * 1024)).toFixed(1)),
            createdAt: stat.mtime
          };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      res.json({ success: true, backups: files });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // GET /api/settings/backups/:name/download — download a backup
  // ============================================================
  router.get('/settings/backups/:name/download', async (req, res) => {
    try {
      const filePath = path.join(BACKUP_DIR, req.params.name);
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Backup not found' });
      // Security: ensure the path is within BACKUP_DIR
      if (!filePath.startsWith(BACKUP_DIR)) return res.status(403).json({ success: false, error: 'Access denied' });

      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
      fs.createReadStream(filePath).pipe(res);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // DELETE /api/settings/backups/:name — delete a backup
  // ============================================================
  router.delete('/settings/backups/:name', async (req, res) => {
    try {
      const filePath = path.join(BACKUP_DIR, req.params.name);
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Backup not found' });
      if (!filePath.startsWith(BACKUP_DIR)) return res.status(403).json({ success: false, error: 'Access denied' });

      fs.unlinkSync(filePath);
      logger.info(`Backup deleted: ${req.params.name}`);
      res.json({ success: true, message: `Backup ${req.params.name} deleted` });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

// Clean old backups beyond retention
function cleanOldBackups(retainDays) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.tar.gz'));
    for (const f of files) {
      const filePath = path.join(BACKUP_DIR, f);
      try {
        if (fs.statSync(filePath).mtime < cutoff) {
          fs.unlinkSync(filePath);
          logger.info(`Old backup deleted: ${f}`);
        }
      } catch (e) {}
    }
  } catch (e) {}
}

module.exports = registerSettingsRoutes;
