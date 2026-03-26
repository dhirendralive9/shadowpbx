const fs = require('fs');
const path = require('path');
const { execSync, exec } = require('child_process');
const mongoose = require('mongoose');
const logger = require('../utils/logger');

const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/var/lib/shadowpbx/recordings';
const SPOOL_DIR = process.env.RECORDING_SPOOL_DIR || '/var/spool/rtpengine';
const BACKUP_DIR = path.join(process.env.APP_DIR || '/opt/shadowpbx', 'backups');
const WAV_DIR = path.join(RECORDINGS_DIR, 'wav');
const PCAP_DIR = path.join(SPOOL_DIR, 'pcaps');
const META_DIR = path.join(SPOOL_DIR, 'metadata');
const MONGODB_URI = process.env.MONGODB_URI || '';

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function registerSettingsRoutes(router) {
  const { SystemSettings, CDR } = require('../models');

  // ============================================================
  // GET /api/settings — get all system settings
  // ============================================================
  router.get('/settings', async (req, res) => {
    try {
      let settings = await SystemSettings.findById('system');
      if (!settings) settings = await SystemSettings.create({ _id: 'system' });
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
      logger.info('Settings updated by admin');
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

      if (deleteRecordings && fs.existsSync(WAV_DIR)) {
        for (const f of fs.readdirSync(WAV_DIR).filter(f => f.endsWith('.wav'))) {
          try {
            const fp = path.join(WAV_DIR, f), stat = fs.statSync(fp);
            if (stat.mtime < cutoff) { freedBytes += stat.size; fs.unlinkSync(fp); deletedWav++; }
          } catch (e) {}
        }
      }

      if (deletePcaps && fs.existsSync(PCAP_DIR)) {
        for (const f of fs.readdirSync(PCAP_DIR).filter(f => f.endsWith('.pcap'))) {
          try {
            const fp = path.join(PCAP_DIR, f), stat = fs.statSync(fp);
            if (stat.mtime < cutoff) {
              freedBytes += stat.size; fs.unlinkSync(fp); deletedPcap++;
              const metaPath = path.join(META_DIR, `rtpengine-meta-${f.replace('.pcap', '')}.txt`);
              if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
            }
          } catch (e) {}
        }
      }

      if (deletedWav > 0) {
        await CDR.updateMany({ startTime: { $lt: cutoff }, recorded: true }, { $set: { recordingPath: '', recordingSize: 0 } });
      }

      await SystemSettings.findByIdAndUpdate('system', { 'recordingRetention.lastCleanup': new Date() });
      const freedMB = (freedBytes / (1024 * 1024)).toFixed(1);
      logger.info(`Recording cleanup: ${deletedWav} WAV + ${deletedPcap} pcap deleted (${freedMB}MB freed, retention=${days}d)`);
      res.json({ success: true, deletedWav, deletedPcap, freedMB: parseFloat(freedMB) });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // GET /api/settings/storage — file storage usage stats
  // ============================================================
  router.get('/settings/storage', async (req, res) => {
    try {
      const count = (dir, ext) => {
        if (!fs.existsSync(dir)) return { count: 0, size: 0 };
        let size = 0, cnt = 0;
        for (const f of fs.readdirSync(dir).filter(f => f.endsWith(ext))) {
          try { size += fs.statSync(path.join(dir, f)).size; cnt++; } catch (e) {}
        }
        return { count: cnt, size };
      };
      const wav = count(WAV_DIR, '.wav');
      const pcap = count(PCAP_DIR, '.pcap');
      const bk = count(BACKUP_DIR, '.tar.gz');
      res.json({
        success: true,
        storage: {
          recordings: { count: wav.count, sizeMB: parseFloat((wav.size / (1024 * 1024)).toFixed(1)), sizeHuman: formatBytes(wav.size) },
          pcaps: { count: pcap.count, sizeMB: parseFloat((pcap.size / (1024 * 1024)).toFixed(1)), sizeHuman: formatBytes(pcap.size) },
          backups: { count: bk.count, sizeMB: parseFloat((bk.size / (1024 * 1024)).toFixed(1)), sizeHuman: formatBytes(bk.size) },
          totalMB: parseFloat(((wav.size + pcap.size + bk.size) / (1024 * 1024)).toFixed(1))
        }
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // GET /api/settings/dbstats — detailed MongoDB statistics
  // ============================================================
  router.get('/settings/dbstats', async (req, res) => {
    try {
      const db = mongoose.connection.db;
      const dbStats = await db.stats();

      // Get all collection names
      const collections = await db.listCollections().toArray();
      const collectionStats = [];

      for (const col of collections) {
        try {
          const stats = await db.collection(col.name).stats();
          const count = await db.collection(col.name).countDocuments();
          collectionStats.push({
            name: col.name,
            documents: count,
            size: stats.size || 0,
            sizeHuman: formatBytes(stats.size || 0),
            storageSize: stats.storageSize || 0,
            storageSizeHuman: formatBytes(stats.storageSize || 0),
            avgObjSize: stats.avgObjSize ? Math.round(stats.avgObjSize) : 0,
            avgObjSizeHuman: formatBytes(stats.avgObjSize || 0),
            indexes: stats.nindexes || 0,
            indexSize: stats.totalIndexSize || 0,
            indexSizeHuman: formatBytes(stats.totalIndexSize || 0)
          });
        } catch (e) {
          collectionStats.push({ name: col.name, documents: 0, size: 0, sizeHuman: '0 B', error: e.message });
        }
      }

      // Sort by size descending
      collectionStats.sort((a, b) => (b.size || 0) - (a.size || 0));

      // Total documents across all collections
      const totalDocs = collectionStats.reduce((sum, c) => sum + (c.documents || 0), 0);

      res.json({
        success: true,
        database: {
          name: dbStats.db,
          dataSize: dbStats.dataSize || 0,
          dataSizeHuman: formatBytes(dbStats.dataSize || 0),
          storageSize: dbStats.storageSize || 0,
          storageSizeHuman: formatBytes(dbStats.storageSize || 0),
          indexSize: dbStats.indexSize || 0,
          indexSizeHuman: formatBytes(dbStats.indexSize || 0),
          totalSize: (dbStats.dataSize || 0) + (dbStats.indexSize || 0),
          totalSizeHuman: formatBytes((dbStats.dataSize || 0) + (dbStats.indexSize || 0)),
          collections: dbStats.collections || collections.length,
          totalDocuments: totalDocs
        },
        collections: collectionStats
      });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // POST /api/settings/backup — create MongoDB backup
  // ============================================================
  router.post('/settings/backup', async (req, res) => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const backupName = `shadowpbx-backup-${timestamp}`;
      const backupPath = path.join(BACKUP_DIR, backupName);
      const dumpCmd = `mongodump --uri="${MONGODB_URI}" --out="${backupPath}" --quiet`;

      exec(dumpCmd, { timeout: 120000 }, async (err) => {
        if (err) {
          logger.error(`Backup failed: ${err.message}`);
          return res.status(500).json({ success: false, error: `Backup failed: ${err.message}` });
        }
        try {
          execSync(`tar -czf "${backupPath}.tar.gz" -C "${BACKUP_DIR}" "${backupName}"`, { timeout: 60000 });
          execSync(`rm -rf "${backupPath}"`, { timeout: 10000 });

          const archivePath = `${backupPath}.tar.gz`;
          const archiveSize = fs.statSync(archivePath).size;

          await SystemSettings.findByIdAndUpdate('system', {
            'backup.lastBackup': new Date(),
            'backup.lastBackupPath': archivePath,
            'backup.lastBackupSize': archiveSize
          });

          const settings = await SystemSettings.findById('system');
          const retainDays = (settings && settings.backup && settings.backup.retainDays) || 7;
          cleanOldBackups(retainDays);

          logger.info(`Backup created: ${archivePath} (${formatBytes(archiveSize)})`);
          res.json({
            success: true,
            backup: {
              name: `${backupName}.tar.gz`,
              path: archivePath,
              size: archiveSize,
              sizeHuman: formatBytes(archiveSize),
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
          return { name: f, path: path.join(BACKUP_DIR, f), size: stat.size, sizeHuman: formatBytes(stat.size), createdAt: stat.mtime };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      res.json({ success: true, backups: files });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // GET /api/settings/backups/:name/download — download backup
  // ============================================================
  router.get('/settings/backups/:name/download', async (req, res) => {
    try {
      const filePath = path.join(BACKUP_DIR, req.params.name);
      if (!filePath.startsWith(BACKUP_DIR)) return res.status(403).json({ success: false, error: 'Access denied' });
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Backup not found' });
      res.setHeader('Content-Type', 'application/gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
      fs.createReadStream(filePath).pipe(res);
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });

  // ============================================================
  // DELETE /api/settings/backups/:name — delete backup
  // ============================================================
  router.delete('/settings/backups/:name', async (req, res) => {
    try {
      const filePath = path.join(BACKUP_DIR, req.params.name);
      if (!filePath.startsWith(BACKUP_DIR)) return res.status(403).json({ success: false, error: 'Access denied' });
      if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, error: 'Backup not found' });
      fs.unlinkSync(filePath);
      logger.info(`Backup deleted: ${req.params.name}`);
      res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
  });
}

function cleanOldBackups(retainDays) {
  try {
    if (!fs.existsSync(BACKUP_DIR)) return;
    const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000);
    for (const f of fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.tar.gz'))) {
      try {
        const fp = path.join(BACKUP_DIR, f);
        if (fs.statSync(fp).mtime < cutoff) { fs.unlinkSync(fp); logger.info(`Old backup deleted: ${f}`); }
      } catch (e) {}
    }
  } catch (e) {}
}

module.exports = registerSettingsRoutes;
