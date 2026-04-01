const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ============================================================
// Dialer Engine — Phase 1: Foundation
//
// Manages campaign lifecycle, agent state tracking, lead
// popping, and CSV import. The actual call origination and
// bridging (Phase 2) will build on top of this.
//
// Agent State Machine:
//   logged-out → idle → reserved → on-call → wrap-up → idle
//                  ↕ paused
// ============================================================

// Normalize phone to digits only, strip leading +/1 for US
function normalizePhone(raw) {
  if (!raw) return '';
  let num = raw.replace(/[^\d]/g, '');
  if (num.length === 11 && num.startsWith('1')) num = num.substring(1);
  return num;
}

class DialerEngine {
  constructor(srf, rtpengine, registrar, trunkManager, callHandler) {
    this.srf = srf;
    this.rtpengine = rtpengine;
    this.registrar = registrar;
    this.trunkManager = trunkManager;
    this.callHandler = callHandler;
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };

    // ─── In-memory state (Phase 7 moves to Redis) ───

    // Agent states per campaign: campaignId -> Map<ext, { state, since, callCount, lastCallEnd, currentCallId }>
    // States: 'logged-out', 'idle', 'reserved', 'on-call', 'wrap-up', 'paused'
    this.agentStates = new Map();

    // Active dialer calls: callId -> { campaignId, leadId, agentExt, lead, uac, uas, status }
    this.activeCalls = new Map();

    // Running campaigns: campaignId -> { config, intervalId, startedAt }
    this.runningCampaigns = new Map();

    // Campaign stats cache (in-memory, periodically flushed to DB)
    this.statsCache = new Map();

    logger.info('DIALER: engine initialized');
  }

  // ============================================================
  // CAMPAIGN LIFECYCLE
  // ============================================================

  async startCampaign(campaignId) {
    const { Campaign, Lead } = require('../models');
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) throw new Error('Campaign not found');
    if (campaign.status === 'running') throw new Error('Campaign already running');
    if (!campaign.agents || campaign.agents.length === 0) throw new Error('No agents assigned');
    if (!campaign.trunk) throw new Error('No trunk configured');

    // Count leads
    const pendingLeads = await Lead.countDocuments({
      campaignId: campaign._id,
      status: { $in: ['pending', 'scheduled'] }
    });
    if (pendingLeads === 0) throw new Error('No pending leads in campaign');

    // Initialize agent states
    const stateMap = new Map();
    for (const ext of campaign.agents) {
      const isOnline = await this.registrar.isRegistered(ext);
      stateMap.set(ext, {
        state: isOnline ? 'idle' : 'logged-out',
        since: Date.now(),
        callCount: 0,
        lastCallEnd: 0,
        currentCallId: null
      });
    }
    this.agentStates.set(campaignId, stateMap);

    // Initialize stats cache
    this.statsCache.set(campaignId, {
      dialed: campaign.stats.dialed || 0,
      answered: campaign.stats.answered || 0,
      noAnswer: campaign.stats.noAnswer || 0,
      busy: campaign.stats.busy || 0,
      failed: campaign.stats.failed || 0,
      machine: campaign.stats.machine || 0,
      abandoned: campaign.stats.abandoned || 0,
      totalTalkTime: campaign.stats.totalTalkTime || 0,
      _lastFlush: Date.now()
    });

    // Update campaign status
    campaign.status = 'running';
    campaign.startedAt = new Date();
    campaign.stats.totalLeads = await Lead.countDocuments({ campaignId: campaign._id });
    await campaign.save();

    // Start the dial loop (every 1 second)
    const intervalId = setInterval(() => {
      this._dialLoop(campaignId).catch(err => {
        logger.error(`DIALER: dial loop error for campaign ${campaignId}: ${err.message}`);
      });
    }, 1000);

    // Flush stats to DB every 10 seconds
    const statsIntervalId = setInterval(() => {
      this._flushStats(campaignId).catch(() => {});
    }, 10000);

    // Agent presence monitor — check every 5 seconds which agents are online
    const presenceIntervalId = setInterval(() => {
      this._updateAgentPresence(campaignId).catch(() => {});
    }, 5000);

    this.runningCampaigns.set(campaignId, {
      config: campaign.toObject(),
      intervalId,
      statsIntervalId,
      presenceIntervalId,
      startedAt: Date.now()
    });

    logger.info(`DIALER: campaign "${campaign.name}" (${campaignId}) STARTED — ${campaign.agents.length} agents, ${pendingLeads} leads, strategy=${campaign.strategy}`);
    return campaign;
  }

  async pauseCampaign(campaignId) {
    const { Campaign } = require('../models');
    const running = this.runningCampaigns.get(campaignId);
    if (running) {
      clearInterval(running.intervalId);
      clearInterval(running.statsIntervalId);
      clearInterval(running.presenceIntervalId);
      this.runningCampaigns.delete(campaignId);
    }

    // Don't kill active calls — let them finish naturally
    await this._flushStats(campaignId);

    const campaign = await Campaign.findByIdAndUpdate(campaignId, {
      status: 'paused', pausedAt: new Date()
    }, { new: true });

    // Set all agents to logged-out
    if (this.agentStates.has(campaignId)) {
      for (const [ext, state] of this.agentStates.get(campaignId)) {
        if (state.state !== 'on-call') { // don't interrupt active calls
          state.state = 'logged-out';
          state.since = Date.now();
        }
      }
    }

    logger.info(`DIALER: campaign "${campaign.name}" (${campaignId}) PAUSED`);
    return campaign;
  }

  async stopCampaign(campaignId) {
    const { Campaign } = require('../models');
    const running = this.runningCampaigns.get(campaignId);
    if (running) {
      clearInterval(running.intervalId);
      clearInterval(running.statsIntervalId);
      clearInterval(running.presenceIntervalId);
      this.runningCampaigns.delete(campaignId);
    }

    await this._flushStats(campaignId);

    const campaign = await Campaign.findByIdAndUpdate(campaignId, {
      status: 'completed', completedAt: new Date()
    }, { new: true });

    // Clean up agent states
    this.agentStates.delete(campaignId);
    this.statsCache.delete(campaignId);

    logger.info(`DIALER: campaign "${campaign.name}" (${campaignId}) STOPPED`);
    return campaign;
  }

  // ============================================================
  // AGENT STATE MANAGEMENT
  // ============================================================

  getAgentStates(campaignId) {
    const stateMap = this.agentStates.get(campaignId);
    if (!stateMap) return [];
    const result = [];
    for (const [ext, state] of stateMap) {
      result.push({ extension: ext, ...state });
    }
    return result;
  }

  setAgentState(campaignId, ext, newState) {
    const stateMap = this.agentStates.get(campaignId);
    if (!stateMap) return;
    const agent = stateMap.get(ext);
    if (!agent) return;

    const oldState = agent.state;
    agent.state = newState;
    agent.since = Date.now();

    logger.debug(`DIALER: agent ${ext} state: ${oldState} -> ${newState} (campaign ${campaignId})`);
  }

  // Agent login/logout (manual)
  agentLogin(campaignId, ext) {
    this.setAgentState(campaignId, ext, 'idle');
  }

  agentLogout(campaignId, ext) {
    const stateMap = this.agentStates.get(campaignId);
    if (!stateMap) return;
    const agent = stateMap.get(ext);
    if (!agent) return;
    if (agent.state === 'on-call') return; // can't logout while on call
    this.setAgentState(campaignId, ext, 'logged-out');
  }

  agentPause(campaignId, ext) {
    const stateMap = this.agentStates.get(campaignId);
    if (!stateMap) return;
    const agent = stateMap.get(ext);
    if (!agent || agent.state === 'on-call') return;
    this.setAgentState(campaignId, ext, 'paused');
  }

  agentUnpause(campaignId, ext) {
    const stateMap = this.agentStates.get(campaignId);
    if (!stateMap) return;
    const agent = stateMap.get(ext);
    if (!agent || agent.state !== 'paused') return;
    this.setAgentState(campaignId, ext, 'idle');
  }

  // Get idle agents for a campaign
  _getIdleAgents(campaignId) {
    const stateMap = this.agentStates.get(campaignId);
    if (!stateMap) return [];
    const idle = [];
    for (const [ext, state] of stateMap) {
      if (state.state === 'idle') idle.push(ext);
    }
    return idle;
  }

  // Get count of agents in various states
  _getAgentCounts(campaignId) {
    const stateMap = this.agentStates.get(campaignId);
    if (!stateMap) return { idle: 0, reserved: 0, onCall: 0, wrapUp: 0, paused: 0, loggedOut: 0 };
    const counts = { idle: 0, reserved: 0, onCall: 0, wrapUp: 0, paused: 0, loggedOut: 0 };
    for (const [, state] of stateMap) {
      if (state.state === 'idle') counts.idle++;
      else if (state.state === 'reserved') counts.reserved++;
      else if (state.state === 'on-call') counts.onCall++;
      else if (state.state === 'wrap-up') counts.wrapUp++;
      else if (state.state === 'paused') counts.paused++;
      else if (state.state === 'logged-out') counts.loggedOut++;
    }
    return counts;
  }

  // ============================================================
  // AGENT PRESENCE MONITOR
  //
  // Checks registrar to auto-login/logout agents based on
  // whether their SIP phone is registered.
  // ============================================================
  async _updateAgentPresence(campaignId) {
    const stateMap = this.agentStates.get(campaignId);
    if (!stateMap) return;

    for (const [ext, state] of stateMap) {
      const isOnline = await this.registrar.isRegistered(ext);

      if (isOnline && state.state === 'logged-out') {
        // Phone came online — auto-login
        state.state = 'idle';
        state.since = Date.now();
        logger.info(`DIALER: agent ${ext} auto-login (phone registered) — campaign ${campaignId}`);
      } else if (!isOnline && state.state === 'idle') {
        // Phone went offline — auto-logout (only if idle, don't interrupt calls)
        state.state = 'logged-out';
        state.since = Date.now();
        logger.info(`DIALER: agent ${ext} auto-logout (phone unregistered) — campaign ${campaignId}`);
      }
    }
  }

  // ============================================================
  // DIAL LOOP — runs every 1 second per campaign
  //
  // Phase 1: just pops leads and prepares for calling.
  // Phase 2 will add actual srf.createUAC() origination.
  // ============================================================
  async _dialLoop(campaignId) {
    const running = this.runningCampaigns.get(campaignId);
    if (!running) return;

    const config = running.config;

    // Check schedule
    if (config.schedule && config.schedule.enabled) {
      if (!this._isInSchedule(config.schedule)) return;
    }

    // Get idle agents
    const idleAgents = this._getIdleAgents(campaignId);
    if (idleAgents.length === 0) return;

    // Count active outbound calls for this campaign
    let activeCount = 0;
    for (const [, call] of this.activeCalls) {
      if (call.campaignId === campaignId && (call.status === 'ringing' || call.status === 'connected')) {
        activeCount++;
      }
    }

    // Calculate how many calls to place
    let toDial = 0;

    if (config.strategy === 'auto') {
      // Auto: 1 call per idle agent, minus active ringing calls
      toDial = Math.max(0, idleAgents.length - activeCount);
    } else {
      // Predictive: use dial ratio (Phase 4 will refine this)
      const stats = this.statsCache.get(campaignId) || {};
      const answerRate = stats.answerRate || 0.5;
      const dialRatio = config.dialRatio || 1.2;
      const expectedAnswers = activeCount * answerRate;
      const effectiveSlots = idleAgents.length - expectedAnswers;
      toDial = Math.max(0, Math.ceil(effectiveSlots * dialRatio));
    }

    // Cap by maxConcurrent
    toDial = Math.min(toDial, config.maxConcurrent - activeCount);
    if (toDial <= 0) return;

    // Pop leads and dial
    const { Lead, DNC } = require('../models');

    for (let i = 0; i < toDial; i++) {
      // Atomic pop: findOneAndUpdate prevents two workers grabbing the same lead
      const lead = await Lead.findOneAndUpdate(
        {
          campaignId: config._id,
          status: { $in: ['pending', 'scheduled'] },
          $or: [
            { nextAttempt: null },
            { nextAttempt: { $lte: new Date() } }
          ]
        },
        {
          $set: { status: 'calling', lastAttempt: new Date() },
          $inc: { attempts: 1 }
        },
        { new: true, sort: { nextAttempt: 1, createdAt: 1 } }
      );

      if (!lead) {
        // No more leads — check if campaign is done
        const remaining = await Lead.countDocuments({
          campaignId: config._id,
          status: { $in: ['pending', 'scheduled'] }
        });
        if (remaining === 0) {
          logger.info(`DIALER: campaign ${campaignId} — all leads processed`);
          // Auto-stop only if no calls are active
          if (activeCount === 0) {
            this.stopCampaign(campaignId).catch(() => {});
          }
        }
        break;
      }

      // DNC check at dial time
      if (config.dncEnabled) {
        const isDnc = await DNC.findOne({ phone: lead.phone });
        if (isDnc) {
          lead.status = 'dnc';
          lead.outcome = '';
          await lead.save();
          logger.info(`DIALER: lead ${lead.phone} is on DNC list, skipping`);
          continue;
        }
      }

      // Reserve an agent for this lead
      const agent = idleAgents.shift();
      if (!agent) {
        // No more idle agents — put lead back
        lead.status = 'pending';
        lead.attempts = Math.max(0, lead.attempts - 1);
        await lead.save();
        break;
      }

      this.setAgentState(campaignId, agent, 'reserved');

      // Queue the call for origination
      // Phase 2 will replace this with actual srf.createUAC()
      const callId = uuidv4();
      this.activeCalls.set(callId, {
        campaignId,
        leadId: lead._id.toString(),
        agentExt: agent,
        lead: lead.toObject(),
        uac: null,
        uas: null,
        status: 'pending'  // will become 'ringing' when originated
      });

      // Increment dialed count
      this._incrementStat(campaignId, 'dialed');

      logger.info(`DIALER: queued call ${callId} — ${lead.phone} -> agent ${agent} (campaign ${config.name})`);

      // Phase 2 will add: await this._originateCall(callId, campaignId, lead, agent, config);
    }
  }

  // ============================================================
  // SCHEDULE CHECK
  // ============================================================
  _isInSchedule(schedule) {
    try {
      const now = new Date();
      // Simple check — use system timezone for now (Phase 4 adds proper TZ)
      const day = now.getDay(); // 0=Sun
      if (!schedule.days.includes(day)) return false;

      const timeStr = now.toTimeString().substring(0, 5); // "HH:MM"
      if (timeStr < schedule.startTime || timeStr >= schedule.endTime) return false;
      return true;
    } catch (e) {
      return true; // on error, allow dialing
    }
  }

  // ============================================================
  // STATS MANAGEMENT
  // ============================================================

  _incrementStat(campaignId, field, amount) {
    const stats = this.statsCache.get(campaignId);
    if (!stats) return;
    stats[field] = (stats[field] || 0) + (amount || 1);

    // Recalculate derived stats
    const total = stats.dialed || 1;
    stats.answerRate = stats.answered / total;
    stats.abandonRate = stats.abandoned / total;
    if (stats.answered > 0) {
      stats.avgTalkTime = stats.totalTalkTime / stats.answered;
    }
  }

  async _flushStats(campaignId) {
    const stats = this.statsCache.get(campaignId);
    if (!stats) return;

    const { Campaign } = require('../models');
    try {
      const total = stats.dialed || 1;
      await Campaign.findByIdAndUpdate(campaignId, {
        'stats.dialed': stats.dialed || 0,
        'stats.answered': stats.answered || 0,
        'stats.noAnswer': stats.noAnswer || 0,
        'stats.busy': stats.busy || 0,
        'stats.failed': stats.failed || 0,
        'stats.machine': stats.machine || 0,
        'stats.abandoned': stats.abandoned || 0,
        'stats.totalTalkTime': stats.totalTalkTime || 0,
        'stats.avgTalkTime': stats.answered > 0 ? Math.round(stats.totalTalkTime / stats.answered) : 0,
        'stats.answerRate': Math.round((stats.answerRate || 0) * 100) / 100,
        'stats.abandonRate': Math.round((stats.abandonRate || 0) * 100) / 100,
        'stats.completed': (stats.answered || 0) + (stats.noAnswer || 0) + (stats.busy || 0) + (stats.failed || 0) + (stats.machine || 0),
      });
      stats._lastFlush = Date.now();
    } catch (e) {
      logger.debug(`DIALER: stats flush error: ${e.message}`);
    }
  }

  // ============================================================
  // CSV IMPORT
  //
  // Parses CSV, validates, deduplicates, scrubs DNC, and
  // bulk-inserts leads into MongoDB.
  // ============================================================
  async importCSV(campaignId, csvContent, columnMapping) {
    const { Campaign, Lead, DNC } = require('../models');
    const campaign = await Campaign.findById(campaignId);
    if (!campaign) throw new Error('Campaign not found');

    // Parse CSV
    const lines = csvContent.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) throw new Error('CSV must have a header row and at least one data row');

    const headers = lines[0].split(',').map(h => h.trim().replace(/^"(.*)"$/, '$1').toLowerCase());

    // Column mapping: { phone: 'phone_number', name: 'full_name', ... }
    // If not provided, auto-detect common column names
    const mapping = columnMapping || {};
    if (!mapping.phone) {
      const phoneAliases = ['phone', 'phone_number', 'phonenumber', 'number', 'tel', 'telephone', 'mobile', 'cell'];
      mapping.phone = headers.find(h => phoneAliases.includes(h)) || headers[0];
    }
    if (!mapping.name) {
      const nameAliases = ['name', 'full_name', 'fullname', 'contact', 'contact_name'];
      mapping.name = headers.find(h => nameAliases.includes(h)) || '';
    }
    if (!mapping.company) {
      const companyAliases = ['company', 'business', 'organization', 'org'];
      mapping.company = headers.find(h => companyAliases.includes(h)) || '';
    }
    if (!mapping.email) {
      const emailAliases = ['email', 'email_address', 'mail'];
      mapping.email = headers.find(h => emailAliases.includes(h)) || '';
    }

    const phoneIdx = headers.indexOf(mapping.phone);
    if (phoneIdx === -1) throw new Error(`Phone column "${mapping.phone}" not found in CSV headers: ${headers.join(', ')}`);

    const nameIdx = mapping.name ? headers.indexOf(mapping.name) : -1;
    const companyIdx = mapping.company ? headers.indexOf(mapping.company) : -1;
    const emailIdx = mapping.email ? headers.indexOf(mapping.email) : -1;

    // Parse rows
    const leads = [];
    const seenPhones = new Set();
    let invalid = 0;
    let duplicates = 0;
    let dncFiltered = 0;

    for (let i = 1; i < lines.length; i++) {
      const cols = this._parseCSVLine(lines[i]);
      if (!cols || cols.length <= phoneIdx) continue;

      const rawPhone = cols[phoneIdx].trim().replace(/^"(.*)"$/, '$1');
      const phone = normalizePhone(rawPhone);

      if (!phone || phone.length < 7) {
        invalid++;
        continue;
      }

      // In-memory dedup
      if (seenPhones.has(phone)) {
        duplicates++;
        continue;
      }
      seenPhones.add(phone);

      // Build custom fields from all columns
      const customFields = {};
      headers.forEach((h, idx) => {
        if (idx !== phoneIdx && cols[idx]) {
          customFields[h] = cols[idx].trim().replace(/^"(.*)"$/, '$1');
        }
      });

      leads.push({
        campaignId: campaign._id,
        phone,
        name: nameIdx >= 0 && cols[nameIdx] ? cols[nameIdx].trim().replace(/^"(.*)"$/, '$1') : '',
        company: companyIdx >= 0 && cols[companyIdx] ? cols[companyIdx].trim().replace(/^"(.*)"$/, '$1') : '',
        email: emailIdx >= 0 && cols[emailIdx] ? cols[emailIdx].trim().replace(/^"(.*)"$/, '$1') : '',
        status: 'pending',
        customFields
      });
    }

    // DNC scrub
    if (campaign.dncEnabled && leads.length > 0) {
      const phones = leads.map(l => l.phone);
      const dncNumbers = await DNC.find({ phone: { $in: phones } }).lean();
      const dncSet = new Set(dncNumbers.map(d => d.phone));
      const beforeCount = leads.length;
      const filtered = leads.filter(l => {
        if (dncSet.has(l.phone)) {
          dncFiltered++;
          return false;
        }
        return true;
      });
      leads.length = 0;
      leads.push(...filtered);
    }

    // DB dedup — check existing leads in this campaign
    if (leads.length > 0) {
      const existingPhones = await Lead.find({
        campaignId: campaign._id,
        phone: { $in: leads.map(l => l.phone) }
      }, 'phone').lean();
      const existingSet = new Set(existingPhones.map(e => e.phone));
      const beforeCount = leads.length;
      const deduped = leads.filter(l => {
        if (existingSet.has(l.phone)) {
          duplicates++;
          return false;
        }
        return true;
      });
      leads.length = 0;
      leads.push(...deduped);
    }

    // Bulk insert
    let imported = 0;
    if (leads.length > 0) {
      try {
        const result = await Lead.insertMany(leads, { ordered: false });
        imported = result.length;
      } catch (e) {
        // Some may have inserted before error (duplicate key)
        if (e.insertedDocs) imported = e.insertedDocs.length;
        else if (e.result && e.result.nInserted) imported = e.result.nInserted;
        logger.debug(`DIALER: CSV bulk insert partial: ${e.message}`);
      }
    }

    // Update campaign total
    const totalLeads = await Lead.countDocuments({ campaignId: campaign._id });
    await Campaign.findByIdAndUpdate(campaignId, { 'stats.totalLeads': totalLeads });

    const result = {
      total: lines.length - 1,
      imported,
      duplicates,
      dncFiltered,
      invalid,
      totalInCampaign: totalLeads
    };

    logger.info(`DIALER: CSV import for "${campaign.name}" — ${JSON.stringify(result)}`);
    return result;
  }

  // Simple CSV line parser (handles quoted fields with commas)
  _parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  // ============================================================
  // STATUS / DASHBOARD DATA
  // ============================================================

  getCampaignStatus(campaignId) {
    const running = this.runningCampaigns.has(campaignId);
    const agents = this.getAgentStates(campaignId);
    const counts = this._getAgentCounts(campaignId);
    const stats = this.statsCache.get(campaignId) || {};

    let activeCallCount = 0;
    for (const [, call] of this.activeCalls) {
      if (call.campaignId === campaignId) activeCallCount++;
    }

    return {
      running,
      agents,
      agentCounts: counts,
      activeCalls: activeCallCount,
      stats: {
        dialed: stats.dialed || 0,
        answered: stats.answered || 0,
        noAnswer: stats.noAnswer || 0,
        busy: stats.busy || 0,
        failed: stats.failed || 0,
        machine: stats.machine || 0,
        abandoned: stats.abandoned || 0,
        answerRate: Math.round((stats.answerRate || 0) * 100),
        abandonRate: Math.round((stats.abandonRate || 0) * 100),
        avgTalkTime: Math.round(stats.avgTalkTime || 0),
      }
    };
  }

  getRunningCampaigns() {
    const result = [];
    for (const [id, data] of this.runningCampaigns) {
      result.push({
        campaignId: id,
        name: data.config.name,
        strategy: data.config.strategy,
        startedAt: data.startedAt,
        agentCounts: this._getAgentCounts(id)
      });
    }
    return result;
  }

  // ============================================================
  // CLEANUP
  // ============================================================
  async shutdown() {
    logger.info('DIALER: shutting down...');
    for (const [id] of this.runningCampaigns) {
      await this.pauseCampaign(id);
    }
    logger.info('DIALER: shutdown complete');
  }
}

module.exports = DialerEngine;
