// ============================================================
// Security Tracker — tracks SIP attack attempts and manages IP blocking
// ============================================================
const { execFile } = require('child_process');
const logger = require('../utils/logger');

class SecurityTracker {
  constructor() {
    // Map<ip, { ip, count, firstSeen, lastSeen, userAgents:Set, reasons:Set, sampleTargets:Set }>
    this.attackers = new Map();
    this.blockedIps = new Set();
    this.maxTracked = 500; // cap memory

    // Load currently blocked IPs from iptables on startup
    this._loadBlockedIps();
  }

  // Record a rejected/suspicious SIP event
  record(ip, reason, userAgent, target) {
    if (!ip || ip === '127.0.0.1' || ip.startsWith('::1')) return;

    let entry = this.attackers.get(ip);
    if (!entry) {
      // Cap memory — evict oldest if full
      if (this.attackers.size >= this.maxTracked) {
        let oldest = null, oldestTime = Infinity;
        for (const [k, v] of this.attackers) {
          if (v.lastSeen < oldestTime) { oldestTime = v.lastSeen; oldest = k; }
        }
        if (oldest) this.attackers.delete(oldest);
      }
      entry = {
        ip, count: 0,
        firstSeen: Date.now(), lastSeen: Date.now(),
        userAgents: new Set(), reasons: new Set(), sampleTargets: new Set()
      };
      this.attackers.set(ip, entry);
    }

    entry.count++;
    entry.lastSeen = Date.now();
    if (userAgent) entry.userAgents.add(userAgent.substring(0, 60));
    if (reason) entry.reasons.add(reason);
    if (target && entry.sampleTargets.size < 5) entry.sampleTargets.add(target.substring(0, 40));
  }

  // Get the list of attackers, sorted by hit count
  getAttackers(limit = 100) {
    const list = [];
    for (const [ip, e] of this.attackers) {
      list.push({
        ip,
        count: e.count,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
        userAgents: Array.from(e.userAgents),
        reasons: Array.from(e.reasons),
        sampleTargets: Array.from(e.sampleTargets),
        blocked: this.blockedIps.has(ip)
      });
    }
    list.sort((a, b) => b.count - a.count);
    return list.slice(0, limit);
  }

  getStats() {
    let totalAttempts = 0;
    for (const [, e] of this.attackers) totalAttempts += e.count;
    return {
      uniqueIps: this.attackers.size,
      totalAttempts,
      blockedCount: this.blockedIps.size
    };
  }

  // Block an IP via iptables
  blockIp(ip) {
    return new Promise((resolve) => {
      if (!this._validIp(ip)) return resolve({ success: false, error: 'Invalid IP' });
      if (this.blockedIps.has(ip)) return resolve({ success: true, message: 'Already blocked' });

      // iptables -I INPUT -s <ip> -j DROP
      execFile('iptables', ['-I', 'INPUT', '-s', ip, '-j', 'DROP'], (err) => {
        if (err) {
          logger.error(`SECURITY: failed to block ${ip}: ${err.message}`);
          return resolve({ success: false, error: err.message });
        }
        this.blockedIps.add(ip);
        logger.info(`SECURITY: blocked IP ${ip} via iptables`);
        // Persist
        this._saveRules();
        resolve({ success: true, message: `Blocked ${ip}` });
      });
    });
  }

  // Unblock an IP
  unblockIp(ip) {
    return new Promise((resolve) => {
      if (!this._validIp(ip)) return resolve({ success: false, error: 'Invalid IP' });

      execFile('iptables', ['-D', 'INPUT', '-s', ip, '-j', 'DROP'], (err) => {
        if (err) {
          logger.warn(`SECURITY: failed to unblock ${ip}: ${err.message}`);
          // Still remove from our set even if iptables rule wasn't there
        }
        this.blockedIps.delete(ip);
        logger.info(`SECURITY: unblocked IP ${ip}`);
        this._saveRules();
        resolve({ success: true, message: `Unblocked ${ip}` });
      });
    });
  }

  // Clear tracking data (not blocks)
  clearTracking() {
    this.attackers.clear();
    logger.info('SECURITY: attack tracking cleared');
  }

  _validIp(ip) {
    // IPv4 validation
    return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
      ip.split('.').every(o => parseInt(o) >= 0 && parseInt(o) <= 255);
  }

  _loadBlockedIps() {
    execFile('iptables', ['-L', 'INPUT', '-n'], (err, stdout) => {
      if (err) return;
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.includes('DROP')) {
          const m = line.match(/DROP\s+.*?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
          if (m && m[1] && m[1] !== '0.0.0.0') this.blockedIps.add(m[1]);
        }
      }
      logger.info(`SECURITY: loaded ${this.blockedIps.size} blocked IP(s) from iptables`);
    });
  }

  _saveRules() {
    // Persist iptables rules (Debian/Ubuntu)
    execFile('netfilter-persistent', ['save'], (err) => {
      if (err) {
        // Fallback: iptables-save
        execFile('sh', ['-c', 'iptables-save > /etc/iptables/rules.v4 2>/dev/null'], () => {});
      }
    });
  }
}

module.exports = SecurityTracker;
