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
  // ============================================================
  async _dialLoop(campaignId) {
    const running = this.runningCampaigns.get(campaignId);
    if (!running) return;

    const config = running.config;

    // ─── TCPA Compliance: auto-pause if abandon rate too high ───
    const stats = this.statsCache.get(campaignId);
    if (stats && config.strategy === 'predictive') {
      const rollingAbandon = stats._rollingAbandonRate || 0;
      const maxAbandon = (config.maxAbandoned || 3) / 100;
      // If rolling abandon rate exceeds 2x the target, auto-pause to protect compliance
      if (rollingAbandon > maxAbandon * 2 && (stats.dialed || 0) > 20) {
        logger.warn(`DIALER COMPLIANCE: abandon rate ${(rollingAbandon * 100).toFixed(1)}% exceeds 2x target ${(maxAbandon * 100).toFixed(1)}% — AUTO-PAUSING campaign ${campaignId}`);
        this.pauseCampaign(campaignId).catch(() => {});
        return;
      }
    }

    // ─── Schedule check (time-of-day restrictions) ───
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
      // ─── PREDICTIVE ALGORITHM ───
      // Adaptive dial ratio based on rolling stats and abandon rate feedback
      toDial = this._predictivePacing(campaignId, config, idleAgents.length, activeCount);
    }

    // Cap by maxConcurrent
    toDial = Math.min(toDial, config.maxConcurrent - activeCount);
    if (toDial <= 0) return;

    // Pop leads and dial
    const { Lead, DNC } = require('../models');

    for (let i = 0; i < toDial; i++) {
      // Atomic pop
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
        const remaining = await Lead.countDocuments({
          campaignId: config._id,
          status: { $in: ['pending', 'scheduled'] }
        });
        if (remaining === 0 && activeCount === 0) {
          logger.info(`DIALER: campaign ${campaignId} — all leads processed`);
          this.stopCampaign(campaignId).catch(() => {});
        }
        break;
      }

      // DNC check at dial time
      if (config.dncEnabled) {
        const isDnc = await DNC.findOne({ phone: lead.phone });
        if (isDnc) {
          lead.status = 'dnc';
          await lead.save();
          logger.info(`DIALER: ${lead.phone} on DNC, skipping`);
          continue;
        }
      }

      // Reserve an agent
      const agent = idleAgents.shift();
      if (!agent) {
        lead.status = 'pending';
        lead.attempts = Math.max(0, lead.attempts - 1);
        await lead.save();
        break;
      }

      this.setAgentState(campaignId, agent, 'reserved');
      this._incrementStat(campaignId, 'dialed');

      // Originate the outbound call (async — don't block the loop)
      const callId = uuidv4();
      this._originateCall(callId, campaignId, lead, agent, config).catch(err => {
        logger.error(`DIALER: originate error ${lead.phone}: ${err.message}`);
      });
    }
  }

  // ============================================================
  // CALL ORIGINATION
  //
  // Two paths based on AMD setting:
  //   AMD OFF → Direct SIP via srf.createUAC() (fast, no REST API)
  //   AMD ON  → Carrier REST API with AMD detection, webhook-driven
  // ============================================================
  async _originateCall(callId, campaignId, lead, agentExt, config) {
    const { CDR } = require('../models');

    // Track this call
    this.activeCalls.set(callId, {
      campaignId,
      leadId: lead._id.toString(),
      agentExt,
      lead: lead.toObject(),
      uac: null,
      uas: null,
      status: 'ringing',
      carrierCallSid: null
    });

    // Create CDR
    const cdr = new CDR({
      callId,
      sipCallId: callId,
      from: config.callerId,
      to: lead.phone,
      direction: 'outbound',
      status: 'ringing',
      startTime: new Date(),
      trunkUsed: config.trunk,
      campaignId: campaignId,
      leadId: lead._id.toString(),
      fromIp: process.env.EXTERNAL_IP || ''
    });
    await cdr.save();

    // Choose origination path
    if (config.amd && config.carrier) {
      // AMD enabled → use carrier REST API
      await this._originateViaCarrierAPI(callId, campaignId, lead, agentExt, config, cdr);
    } else {
      // No AMD → direct SIP origination
      await this._originateViaSIP(callId, campaignId, lead, agentExt, config, cdr);
    }
  }

  // ============================================================
  // SIP ORIGINATION (non-AMD) — existing Phase 2 logic
  // ============================================================
  async _originateViaSIP(callId, campaignId, lead, agentExt, config, cdr) {
    const trunk = this.trunkManager.getTrunk(config.trunk);
    if (!trunk) {
      logger.error(`DIALER: trunk "${config.trunk}" not found`);
      await this._callFailed(callId, campaignId, lead, agentExt, 'trunk_not_found', config, cdr);
      return;
    }

    const host = trunk.host || '';
    const port = trunk.port || 5060;
    const username = trunk.username || '';
    const password = trunk.password || '';
    const targetUri = `sip:${lead.phone}@${host}:${port}`;

    logger.info(`DIALER CALL [SIP]: ${config.callerId} -> ${lead.phone} via ${config.trunk} [${callId}] agent=${agentExt}`);

    try {
      const uac = await this.srf.createUAC(targetUri, {
        headers: {
          'From': `<sip:${username}@${host}>`,
          'To': `<sip:${lead.phone}@${host}>`,
          'P-Asserted-Identity': `<sip:${config.callerId}@${host}>`
        },
        auth: { username, password },
        timeout: (config.ringTimeout || 30) * 1000
      });

      logger.info(`DIALER ANSWERED [SIP]: ${lead.phone} picked up [${callId}]`);

      const activeCall = this.activeCalls.get(callId);
      if (activeCall) { activeCall.uac = uac; activeCall.status = 'answered'; }

      cdr.status = 'answered';
      cdr.answerTime = new Date();
      await cdr.save();

      this._incrementStat(campaignId, 'answered');
      await this._bridgeToAgent(callId, campaignId, uac, lead, agentExt, config, cdr);

    } catch (err) {
      const sipStatus = err.status || 0;
      let outcome = 'failed';
      if (sipStatus === 486 || sipStatus === 600) { outcome = 'busy'; this._incrementStat(campaignId, 'busy'); }
      else if (sipStatus === 480 || sipStatus === 408 || sipStatus === 487) { outcome = 'no-answer'; this._incrementStat(campaignId, 'noAnswer'); }
      else { this._incrementStat(campaignId, 'failed'); }
      logger.info(`DIALER ${outcome.toUpperCase()} [SIP]: ${lead.phone} [${callId}] sip=${sipStatus}`);
      await this._callFailed(callId, campaignId, lead, agentExt, outcome, config, cdr);
    }
  }

  // ============================================================
  // CARRIER REST API ORIGINATION (AMD enabled)
  //
  // Places the call via carrier REST API with AMD parameters.
  // The carrier sends webhooks:
  //   /webhook/dialer/:campaignId/voice — call answered (TwiML/TeXML)
  //   /webhook/dialer/:campaignId/amd   — AMD result
  //   /webhook/dialer/:campaignId/status — call ended
  //
  // Flow:
  //   1. Call carrier API → carrier dials lead
  //   2. Lead answers → carrier runs AMD (2-4 seconds)
  //   3. AMD webhook fires → human/machine result
  //   4. If human → bridge to agent via internal SIP
  //   5. If machine → hangup or leave message
  // ============================================================
  async _originateViaCarrierAPI(callId, campaignId, lead, agentExt, config, cdr) {
    const { getAdapter } = require('./carrier-adapters');
    const adapter = getAdapter(config.carrier);

    if (!adapter) {
      logger.error(`DIALER: carrier "${config.carrier}" not configured — falling back to SIP`);
      return this._originateViaSIP(callId, campaignId, lead, agentExt, config, cdr);
    }

    const baseUrl = process.env.WEBHOOK_BASE_URL || `http://127.0.0.1:${process.env.API_PORT || 3000}`;
    const webhookUrl = `${baseUrl}/webhook/dialer/${campaignId}/voice?callId=${encodeURIComponent(callId)}&agent=${encodeURIComponent(agentExt)}`;

    logger.info(`DIALER CALL [${config.carrier.toUpperCase()} API]: ${config.callerId} -> ${lead.phone} [${callId}] agent=${agentExt} amd=ON`);

    try {
      const carrierSid = await adapter.createCall(lead.phone, config.callerId, webhookUrl, {
        amd: true,
        amdAction: config.amdAction || 'hangup',
        ringTimeout: config.ringTimeout || 30,
        callId
      });

      // Store carrier SID for hangup/tracking
      const activeCall = this.activeCalls.get(callId);
      if (activeCall) activeCall.carrierCallSid = carrierSid;

      // Store mapping: carrierSid -> callId (for webhook lookups)
      if (!this._carrierSidMap) this._carrierSidMap = new Map();
      this._carrierSidMap.set(carrierSid, callId);

      cdr.sipCallId = carrierSid;
      await cdr.save();

      logger.info(`DIALER: carrier call placed, waiting for AMD webhook [${callId}] carrierSid=${carrierSid}`);
      // Now we wait — the webhook handlers will take over

    } catch (err) {
      logger.error(`DIALER: carrier API call failed: ${err.message}`);
      this._incrementStat(campaignId, 'failed');
      await this._callFailed(callId, campaignId, lead, agentExt, 'failed', config, cdr);
    }
  }

  // ============================================================
  // WEBHOOK HANDLERS — called by carrier after AMD detection
  // ============================================================

  // Voice webhook — carrier sends this when call is answered
  // Return TwiML/TeXML to keep the call alive while AMD runs
  handleVoiceWebhook(req, res) {
    const callId = req.query.callId || '';
    const agentExt = req.query.agent || '';
    logger.debug(`DIALER WEBHOOK voice: callId=${callId} agent=${agentExt}`);

    // Return TwiML that pauses while AMD detection runs
    // The AMD result will come on a separate webhook
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="30"/>
</Response>`);
  }

  // AMD result webhook — carrier determined human vs machine
  async handleAmdWebhook(req, res) {
    res.status(200).send('OK');

    const { normalizeAmdResult } = require('./carrier-adapters');

    // Determine carrier from request
    let carrier = '';
    let callSid = '';
    let rawResult = '';
    let callId = req.query.callId || '';

    if (req.body.data && req.body.data.event_type) {
      // Telnyx format
      carrier = 'telnyx';
      const payload = req.body.data.payload || {};
      callSid = payload.call_control_id || '';
      rawResult = payload.result || '';
      // Decode client_state for callId
      if (payload.client_state) {
        try {
          const cs = JSON.parse(Buffer.from(payload.client_state, 'base64').toString());
          callId = cs.callId || callId;
        } catch (e) {}
      }
    } else if (req.body.AnsweredBy) {
      // SignalWire / Twilio format
      carrier = req.body.AccountSid ? 'twilio' : 'signalwire';
      callSid = req.body.CallSid || '';
      rawResult = req.body.AnsweredBy || '';
    }

    // Resolve callId from carrier SID if needed
    if (!callId && callSid && this._carrierSidMap) {
      callId = this._carrierSidMap.get(callSid) || '';
    }

    const amdResult = normalizeAmdResult(carrier, rawResult);
    logger.info(`DIALER AMD [${carrier.toUpperCase()}]: ${amdResult} (raw=${rawResult}) callId=${callId} sid=${callSid}`);

    const activeCall = this.activeCalls.get(callId);
    if (!activeCall) {
      logger.warn(`DIALER AMD: no active call for callId=${callId}`);
      return;
    }

    const { Campaign, CDR: CDRModel } = require('../models');
    const campaign = await Campaign.findById(activeCall.campaignId);
    if (!campaign) return;

    // Update CDR with AMD result
    await CDRModel.findOneAndUpdate({ callId }, { amdResult });

    if (amdResult === 'human') {
      // HUMAN — bridge to agent
      logger.info(`DIALER AMD: human detected — bridging ${activeCall.lead.phone} to agent ${activeCall.agentExt} [${callId}]`);

      activeCall.status = 'answered';
      this._incrementStat(activeCall.campaignId, 'answered');

      const cdr = await CDRModel.findOne({ callId });
      if (cdr) {
        cdr.status = 'answered';
        cdr.answerTime = new Date();
        cdr.amdResult = 'human';
        await cdr.save();
      }

      // Bridge to agent via internal SIP
      // We need to get the carrier to redirect audio to our server,
      // but since the carrier controls the call, we use a different approach:
      // Hangup the carrier call and immediately call the agent, playing
      // a connect tone, then conference the lead and agent.
      //
      // Simpler approach: redirect the carrier call to bridge TwiML
      await this._bridgeCarrierToAgent(callId, activeCall, campaign, callSid, carrier, cdr);

    } else if (amdResult === 'machine') {
      // MACHINE — hangup or leave message
      logger.info(`DIALER AMD: machine detected — action=${campaign.amdAction} [${callId}]`);

      this._incrementStat(activeCall.campaignId, 'machine');

      if (campaign.amdAction === 'leave-message') {
        // Leave message — carrier will play after beep detection
        // For now, just log and hangup (Phase 5 adds pre-recorded message playback)
        logger.info(`DIALER AMD: leave-message not yet implemented, hanging up [${callId}]`);
      }

      // Hangup the carrier call
      const { getAdapter } = require('./carrier-adapters');
      const adapter = getAdapter(carrier);
      if (adapter && callSid) await adapter.hangupCall(callSid);

      // Update lead
      const config = campaign.toObject();
      await this._callFailed(callId, activeCall.campaignId, activeCall.lead, activeCall.agentExt, 'machine', config);

    } else {
      // UNKNOWN — treat as human (conservative approach)
      logger.info(`DIALER AMD: unknown result — treating as human [${callId}]`);
      activeCall.status = 'answered';
      this._incrementStat(activeCall.campaignId, 'answered');

      const cdr = await CDRModel.findOne({ callId });
      if (cdr) { cdr.status = 'answered'; cdr.answerTime = new Date(); cdr.amdResult = 'unknown'; await cdr.save(); }
      await this._bridgeCarrierToAgent(callId, activeCall, campaign, callSid, carrier, cdr);
    }
  }

  // Status webhook — call ended
  async handleStatusWebhook(req, res) {
    res.status(200).send('OK');
    const callId = req.query.callId || '';
    const status = req.body.CallStatus || req.body.status || '';
    logger.debug(`DIALER WEBHOOK status: callId=${callId} status=${status}`);

    // If the carrier call ended and we haven't bridged yet, clean up
    if (['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(status)) {
      const activeCall = this.activeCalls.get(callId);
      if (activeCall && activeCall.status === 'ringing') {
        let outcome = 'failed';
        if (status === 'busy') { outcome = 'busy'; this._incrementStat(activeCall.campaignId, 'busy'); }
        else if (status === 'no-answer') { outcome = 'no-answer'; this._incrementStat(activeCall.campaignId, 'noAnswer'); }
        else { this._incrementStat(activeCall.campaignId, 'failed'); }

        const { Campaign } = require('../models');
        const campaign = await Campaign.findById(activeCall.campaignId);
        const config = campaign ? campaign.toObject() : {};
        await this._callFailed(callId, activeCall.campaignId, activeCall.lead, activeCall.agentExt, outcome, config);
      }
    }
  }

  // ============================================================
  // BRIDGE CARRIER CALL TO AGENT
  //
  // After AMD confirms human, we bridge the carrier-managed call
  // to the agent. Two approaches:
  //
  // 1. Redirect carrier call → TwiML <Dial> to our SIP server
  //    (carrier calls back into our Drachtio, we bridge internally)
  //
  // 2. Originate internal call to agent, then use carrier
  //    redirect to connect both legs
  //
  // We use approach 2 — more reliable, keeps recording on our side.
  // ============================================================
  async _bridgeCarrierToAgent(callId, activeCall, campaign, carrierSid, carrier, cdr) {
    const agentExt = activeCall.agentExt;
    const lead = activeCall.lead;
    const config = campaign.toObject();

    // Get agent contact
    const agentContacts = await this.registrar.getContacts(agentExt);
    if (agentContacts.length === 0) {
      logger.warn(`DIALER BRIDGE [AMD]: agent ${agentExt} offline, hanging up carrier call`);
      const { getAdapter } = require('./carrier-adapters');
      const adapter = getAdapter(carrier);
      if (adapter && carrierSid) await adapter.hangupCall(carrierSid);
      await this._callFailed(callId, activeCall.campaignId, lead, agentExt, 'abandoned', config, cdr);
      return;
    }

    const contact = agentContacts.sort((a, b) =>
      (b.registeredAt ? new Date(b.registeredAt).getTime() : 0) -
      (a.registeredAt ? new Date(a.registeredAt).getTime() : 0)
    )[0];

    const agentUri = `sip:${agentExt}@${contact.ip}:${contact.port}`;
    const sipDomain = process.env.SIP_DOMAIN || 'shadowpbx';
    const externalIp = process.env.EXTERNAL_IP || '127.0.0.1';

    logger.info(`DIALER BRIDGE [AMD]: connecting agent ${agentExt} at ${agentUri} [${callId}]`);

    try {
      // Call the agent internally
      const agentUac = await this.srf.createUAC(agentUri, {
        headers: {
          'From': `<sip:${lead.phone}@${sipDomain}>`,
          'To': `<sip:${agentExt}@${sipDomain}>`,
          'Contact': `<sip:${lead.phone}@${externalIp}>`,
          'X-Campaign': campaign.name || '',
          'X-Lead-Name': lead.name || '',
          'X-Lead-Phone': lead.phone || '',
          'X-AMD-Result': 'human'
        },
        callingNumber: lead.phone
      });

      logger.info(`DIALER BRIDGED [AMD]: ${lead.phone} <-> agent ${agentExt} [${callId}]`);

      // Update tracking
      activeCall.uas = agentUac;
      activeCall.status = 'connected';

      // Update agent state
      this.setAgentState(activeCall.campaignId, agentExt, 'on-call');
      const stateMap = this.agentStates.get(activeCall.campaignId);
      if (stateMap) {
        const as = stateMap.get(agentExt);
        if (as) as.currentCallId = callId;
      }

      // BLF
      if (this.callHandler.presenceHandler) {
        this.callHandler._emitPresence(agentExt, 'confirmed', { callId, remoteParty: lead.phone, direction: 'recipient' });
      }

      // Now redirect the carrier call to stream audio to/from the agent
      // We tell the carrier to dial back into our SIP server at the agent's extension
      // using <Dial><Sip> in the TwiML response
      // But since the call is already answered, we need to use the carrier's
      // update/redirect API to change the call's instructions
      const { getAdapter } = require('./carrier-adapters');
      const adapter = getAdapter(carrier);
      const baseUrl = process.env.WEBHOOK_BASE_URL || `http://127.0.0.1:${process.env.API_PORT || 3000}`;

      if (carrier === 'telnyx') {
        // Telnyx: use transfer command to bridge to our SIP endpoint
        try {
          await adapter._request('POST', `/v2/calls/${carrierSid}/actions/transfer`, {
            to: `sip:${agentExt}@${externalIp}:${process.env.SIP_PORT || 5060}`,
            from: lead.phone,
            webhook_url: `${baseUrl}/webhook/dialer/${activeCall.campaignId}/status?callId=${callId}`
          });
          logger.info(`DIALER: Telnyx transfer to SIP ${agentExt}@${externalIp}`);
        } catch (e) {
          logger.warn(`DIALER: Telnyx transfer failed: ${e.message}`);
        }
      } else {
        // SignalWire / Twilio: redirect to TwiML that dials our SIP
        const redirectUrl = `${baseUrl}/webhook/dialer/${activeCall.campaignId}/bridge?callId=${callId}&agent=${agentExt}`;
        try {
          const params = new URLSearchParams();
          params.append('Url', redirectUrl);
          params.append('Method', 'POST');
          await adapter._request(
            'POST',
            carrier === 'twilio'
              ? `/2010-04-01/Accounts/${adapter.credentials.accountSid}/Calls/${carrierSid}.json`
              : `/api/laml/2010-04-01/Accounts/${adapter.credentials.projectId}/Calls/${carrierSid}.json`,
            params.toString()
          );
          logger.info(`DIALER: ${carrier} redirect to bridge TwiML`);
        } catch (e) {
          logger.warn(`DIALER: ${carrier} redirect failed: ${e.message}`);
        }
      }

      // Handle agent hangup
      agentUac.on('destroy', async () => {
        logger.info(`DIALER: agent ${agentExt} hung up [${callId}]`);
        // Hangup carrier call too
        if (adapter && carrierSid) await adapter.hangupCall(carrierSid);

        const { Lead: LeadModel, CDR: CDRModel } = require('../models');
        const endTime = new Date();
        const talkTime = cdr && cdr.answerTime ? Math.round((endTime - cdr.answerTime) / 1000) : 0;

        if (cdr) {
          cdr.status = 'completed';
          cdr.endTime = endTime;
          cdr.duration = Math.round((endTime - cdr.startTime) / 1000);
          cdr.talkTime = talkTime;
          cdr.hangupBy = 'callee';
          cdr.hangupCause = 'normal_clearing';
          await cdr.save();
        }

        await LeadModel.findByIdAndUpdate(lead._id, {
          status: 'completed', outcome: 'answered', assignedAgent: agentExt,
          duration: talkTime, $push: { callIds: callId }
        });

        this._incrementStat(activeCall.campaignId, 'totalTalkTime', talkTime);

        if (this.callHandler.presenceHandler) this.callHandler._emitPresence(agentExt, 'idle');

        this.setAgentState(activeCall.campaignId, agentExt, 'wrap-up');
        const wrapUpMs = (config.wrapUpTime || 10) * 1000;
        setTimeout(() => {
          const sm = this.agentStates.get(activeCall.campaignId);
          if (sm) {
            const a = sm.get(agentExt);
            if (a && a.state === 'wrap-up') {
              a.state = 'idle'; a.since = Date.now(); a.callCount = (a.callCount || 0) + 1;
              a.lastCallEnd = Date.now(); a.currentCallId = null;
            }
          }
        }, wrapUpMs);

        this.activeCalls.delete(callId);
        if (this._carrierSidMap) this._carrierSidMap.delete(carrierSid);

        logger.info(`DIALER CALL ENDED [AMD]: ${lead.phone} <-> ${agentExt} talk=${talkTime}s [${callId}]`);
        this._checkCampaignComplete(activeCall.campaignId);
      });

    } catch (err) {
      logger.error(`DIALER BRIDGE [AMD] FAILED: ${err.message}`);
      const { getAdapter: ga } = require('./carrier-adapters');
      const a = ga(carrier);
      if (a && carrierSid) await a.hangupCall(carrierSid);
      this._incrementStat(activeCall.campaignId, 'abandoned');
      await this._callFailed(callId, activeCall.campaignId, lead, agentExt, 'abandoned', config, cdr);
    }
  }

  // ============================================================
  // Register dialer webhook routes (called from app.js)
  // These are PUBLIC — carrier needs to reach them
  // ============================================================
  registerWebhookRoutes(app) {
    // Voice webhook — call answered
    app.post('/webhook/dialer/:campaignId/voice', (req, res) => {
      this.handleVoiceWebhook(req, res);
    });

    // AMD result webhook
    app.post('/webhook/dialer/:campaignId/amd', (req, res) => {
      this.handleAmdWebhook(req, res).catch(err => {
        logger.error(`DIALER WEBHOOK amd: ${err.message}`);
        if (!res.headersSent) res.status(200).send('OK');
      });
    });

    // Call status webhook
    app.post('/webhook/dialer/:campaignId/status', (req, res) => {
      this.handleStatusWebhook(req, res).catch(err => {
        logger.error(`DIALER WEBHOOK status: ${err.message}`);
        if (!res.headersSent) res.status(200).send('OK');
      });
    });

    // Bridge TwiML — Twilio/SignalWire redirect here to bridge to agent SIP
    app.post('/webhook/dialer/:campaignId/bridge', (req, res) => {
      const agentExt = req.query.agent || '';
      const externalIp = process.env.EXTERNAL_IP || '127.0.0.1';
      const sipPort = process.env.SIP_PORT || 5060;

      logger.info(`DIALER BRIDGE TwiML: routing carrier call to sip:${agentExt}@${externalIp}:${sipPort}`);

      res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="60" callerId="${req.body.From || ''}">
    <Sip>sip:${agentExt}@${externalIp}:${sipPort};transport=udp</Sip>
  </Dial>
</Response>`);
    });

    logger.info('DIALER: webhook routes registered at /webhook/dialer/');
  }

  // ============================================================
  // BRIDGE TO AGENT — Connect answered lead to the reserved agent
  //
  // Creates a second call leg to the agent's registered SIP phone,
  // routes both legs through RTPEngine for recording.
  // ============================================================
  async _bridgeToAgent(callId, campaignId, leadUac, lead, agentExt, config, cdr) {
    // Get agent's registered contact
    const agentContacts = await this.registrar.getContacts(agentExt);
    if (agentContacts.length === 0) {
      logger.warn(`DIALER BRIDGE: agent ${agentExt} not registered, can't bridge`);
      // Agent went offline — hang up lead, put lead back
      try { leadUac.destroy(); } catch (e) {}
      await this._callFailed(callId, campaignId, lead, agentExt, 'no-answer', config, cdr);
      return;
    }

    const contact = agentContacts.sort((a, b) =>
      (b.registeredAt ? new Date(b.registeredAt).getTime() : 0) -
      (a.registeredAt ? new Date(a.registeredAt).getTime() : 0)
    )[0];

    const agentUri = `sip:${agentExt}@${contact.ip}:${contact.port}`;
    const sipDomain = process.env.SIP_DOMAIN || 'shadowpbx';
    const externalIp = process.env.EXTERNAL_IP || '127.0.0.1';

    logger.info(`DIALER BRIDGE: connecting ${lead.phone} -> agent ${agentExt} at ${agentUri} [${callId}]`);

    try {
      // Set up RTPEngine for the lead leg
      const rtpHelper = require('../utils/rtp-helper');
      const leadFromTag = leadUac.sip ? leadUac.sip.remoteTag : `lead-${callId}`;
      const leadSdp = leadUac.remote ? leadUac.remote.sdp : '';

      let rtpOffer = null;
      if (leadSdp && this.rtpengine) {
        rtpOffer = await rtpHelper.offer(this.rtpengine, callId, leadFromTag, leadSdp, { 'record call': 'yes' });
      }

      // Call the agent
      const agentUac = await this.srf.createUAC(agentUri, {
        localSdp: rtpOffer ? rtpOffer.sdp : leadSdp,
        headers: {
          'From': `<sip:${lead.phone}@${sipDomain}>`,
          'To': `<sip:${agentExt}@${sipDomain}>`,
          'Contact': `<sip:${lead.phone}@${externalIp}>`,
          'X-Campaign': config.name || '',
          'X-Lead-Name': lead.name || '',
          'X-Lead-Phone': lead.phone || ''
        },
        callingNumber: lead.phone
      });

      logger.info(`DIALER BRIDGED: ${lead.phone} <-> agent ${agentExt} [${callId}]`);

      // Complete RTPEngine answer with agent's SDP
      if (rtpOffer && agentUac.remote && this.rtpengine) {
        const agentToTag = agentUac.sip ? agentUac.sip.remoteTag : '';
        if (agentToTag) {
          await rtpHelper.answer(this.rtpengine, callId, leadFromTag, agentToTag, agentUac.remote.sdp, { 'record call': 'yes' });
        }
        // Re-INVITE the lead with RTPEngine's answer SDP
        try { await leadUac.modify(rtpOffer.sdp); } catch (e) {}
      }

      // Update tracking
      const activeCall = this.activeCalls.get(callId);
      if (activeCall) {
        activeCall.uas = agentUac; // agent leg
        activeCall.status = 'connected';
      }

      // Update agent state
      this.setAgentState(campaignId, agentExt, 'on-call');
      const agentState = this.agentStates.get(campaignId);
      if (agentState) {
        const as = agentState.get(agentExt);
        if (as) as.currentCallId = callId;
      }

      // Update CDR
      cdr.to = `${lead.phone} -> ${agentExt}`;
      cdr.recorded = !!rtpOffer;
      cdr.rtpengineCallId = callId;
      await cdr.save();

      // Emit BLF presence
      if (this.callHandler.presenceHandler) {
        this.callHandler._emitPresence(agentExt, 'confirmed', { callId, remoteParty: lead.phone, direction: 'recipient' });
      }

      // Socket.IO: push screen pop to agent
      // (Phase 5 will add proper screen pop UI — for now just log)
      logger.info(`DIALER SCREEN-POP: agent ${agentExt} — ${lead.name || 'Unknown'} (${lead.phone}) ${lead.company || ''}`);

      // Handle hangup from either side
      let callEnded = false;
      const onCallEnd = async (hangupBy) => {
        if (callEnded) return;
        callEnded = true;

        const endTime = new Date();
        const talkTime = cdr.answerTime ? Math.round((endTime - cdr.answerTime) / 1000) : 0;

        // Destroy the other leg
        try { if (hangupBy === 'lead') agentUac.destroy(); else leadUac.destroy(); } catch (e) {}

        // Clean up RTPEngine
        if (this.rtpengine) {
          await rtpHelper.del(this.rtpengine, callId, leadFromTag);
        }

        // Update CDR
        cdr.status = 'completed';
        cdr.endTime = endTime;
        cdr.duration = Math.round((endTime - cdr.startTime) / 1000);
        cdr.talkTime = talkTime;
        cdr.hangupBy = hangupBy === 'lead' ? 'caller' : 'callee';
        cdr.hangupCause = 'normal_clearing';
        await cdr.save();

        // Update lead
        const { Lead: LeadModel } = require('../models');
        await LeadModel.findByIdAndUpdate(lead._id, {
          status: 'completed',
          outcome: 'answered',
          assignedAgent: agentExt,
          duration: talkTime,
          $push: { callIds: callId }
        });

        // Update stats
        this._incrementStat(campaignId, 'totalTalkTime', talkTime);

        // BLF idle
        if (this.callHandler.presenceHandler) {
          this.callHandler._emitPresence(agentExt, 'idle');
        }

        // Agent → wrap-up
        this.setAgentState(campaignId, agentExt, 'wrap-up');
        const wrapUpMs = (config.wrapUpTime || 10) * 1000;
        setTimeout(() => {
          const stateMap = this.agentStates.get(campaignId);
          if (stateMap) {
            const as = stateMap.get(agentExt);
            if (as && as.state === 'wrap-up') {
              as.state = 'idle';
              as.since = Date.now();
              as.callCount = (as.callCount || 0) + 1;
              as.lastCallEnd = Date.now();
              as.currentCallId = null;
              logger.debug(`DIALER: agent ${agentExt} wrap-up done, now idle`);
            }
          }
        }, wrapUpMs);

        // Remove from active calls
        this.activeCalls.delete(callId);

        logger.info(`DIALER CALL ENDED: ${lead.phone} <-> ${agentExt} talk=${talkTime}s hangup=${hangupBy} [${callId}]`);

        // Check if campaign is done
        this._checkCampaignComplete(campaignId);
      };

      leadUac.on('destroy', () => onCallEnd('lead'));
      agentUac.on('destroy', () => onCallEnd('agent'));

    } catch (err) {
      logger.error(`DIALER BRIDGE FAILED: agent ${agentExt} error=${err.message} [${callId}]`);
      // Can't reach agent — hang up lead, mark as abandoned
      try { leadUac.destroy(); } catch (e) {}

      this._incrementStat(campaignId, 'abandoned');
      await this._callFailed(callId, campaignId, lead, agentExt, 'abandoned', config, cdr);
    }
  }

  // ============================================================
  // CALL FAILED — handle no-answer, busy, error, machine, abandoned
  // ============================================================
  async _callFailed(callId, campaignId, lead, agentExt, outcome, config, cdr) {
    const { Lead: LeadModel, CDR: CDRModel } = require('../models');

    // Update CDR
    if (cdr) {
      cdr.status = outcome === 'busy' ? 'busy' : (outcome === 'machine' ? 'completed' : 'failed');
      cdr.endTime = new Date();
      cdr.duration = Math.round((cdr.endTime - cdr.startTime) / 1000);
      cdr.hangupCause = outcome;
      cdr.hangupBy = 'system';
      if (outcome === 'machine') cdr.amdResult = 'machine';
      await cdr.save();
    }

    // Update lead — schedule retry or mark as final
    const maxAttempts = config.retryAttempts || 3;
    const retryDelayMin = config.retryDelay || 30;

    if (lead.attempts < maxAttempts && ['no-answer', 'busy', 'machine'].includes(outcome)) {
      // Schedule retry — abandoned leads get priority (shorter delay)
      const delay = outcome === 'abandoned'
        ? Math.max(5, retryDelayMin / 2) // half delay for abandoned (they DID answer)
        : retryDelayMin;
      const nextAttempt = new Date(Date.now() + delay * 60 * 1000);
      await LeadModel.findByIdAndUpdate(lead._id, {
        status: 'pending',
        outcome,
        nextAttempt,
        $push: { callIds: callId }
      });
      logger.debug(`DIALER: ${lead.phone} retry in ${delay}min (attempt ${lead.attempts}/${maxAttempts}) outcome=${outcome}`);
    } else if (outcome === 'abandoned' && lead.attempts < maxAttempts) {
      // Abandoned calls always get retried (TCPA requires callback attempt)
      const nextAttempt = new Date(Date.now() + 5 * 60 * 1000); // 5 min
      await LeadModel.findByIdAndUpdate(lead._id, {
        status: 'scheduled',
        outcome: 'abandoned',
        nextAttempt,
        $push: { callIds: callId }
      });
      logger.info(`DIALER COMPLIANCE: abandoned lead ${lead.phone} scheduled for priority retry`);
    } else {
      // Max attempts reached or fatal error
      await LeadModel.findByIdAndUpdate(lead._id, {
        status: 'failed',
        outcome,
        $push: { callIds: callId }
      });
    }

    // Release agent back to idle
    this.setAgentState(campaignId, agentExt, 'idle');
    const stateMap = this.agentStates.get(campaignId);
    if (stateMap) {
      const as = stateMap.get(agentExt);
      if (as) as.currentCallId = null;
    }

    // Remove from active calls
    this.activeCalls.delete(callId);

    // Check if campaign is done
    this._checkCampaignComplete(campaignId);
  }

  // ============================================================
  // Check if campaign has no more leads and no active calls
  // ============================================================
  async _checkCampaignComplete(campaignId) {
    const { Lead: LeadModel } = require('../models');
    const remaining = await LeadModel.countDocuments({
      campaignId: this.runningCampaigns.get(campaignId)?.config?._id,
      status: { $in: ['pending', 'scheduled', 'calling'] }
    });

    let activeCalls = 0;
    for (const [, call] of this.activeCalls) {
      if (call.campaignId === campaignId) activeCalls++;
    }

    if (remaining === 0 && activeCalls === 0) {
      logger.info(`DIALER: campaign ${campaignId} — all leads processed, stopping`);
      this.stopCampaign(campaignId).catch(() => {});
    }
  }

  // ============================================================
  // SCHEDULE CHECK
  // ============================================================
  _isInSchedule(schedule) {
    try {
      const now = new Date();
      const day = now.getDay();
      if (!schedule.days.includes(day)) return false;
      const timeStr = now.toTimeString().substring(0, 5);
      if (timeStr < schedule.startTime || timeStr >= schedule.endTime) return false;
      return true;
    } catch (e) {
      return true;
    }
  }

  // ============================================================
  // PREDICTIVE PACING ALGORITHM
  //
  // Calculates how many calls to place this cycle based on:
  //   - Available agents (idle + about to finish wrap-up)
  //   - Rolling answer rate (last N calls, not lifetime)
  //   - Currently ringing calls and their expected answers
  //   - Abandon rate feedback loop (backs off if too high)
  //   - Campaign max concurrent limit
  //
  // The dial ratio auto-adjusts between 1.0 (conservative)
  // and 5.0 (aggressive), driven by the abandon rate target.
  // ============================================================
  _predictivePacing(campaignId, config, idleCount, activeRinging) {
    const stats = this.statsCache.get(campaignId);
    if (!stats) return Math.max(0, idleCount - activeRinging);

    // Rolling answer rate (from recent calls, not lifetime)
    const answerRate = stats._rollingAnswerRate || stats.answerRate || 0.5;
    const abandonRate = stats._rollingAbandonRate || stats.abandonRate || 0;
    const maxAbandon = (config.maxAbandoned || 3) / 100; // convert % to decimal
    const avgWrapUp = stats._avgWrapUpTime || (config.wrapUpTime || 10);

    // Agents about to become free — in wrap-up with <3 seconds remaining
    let agentsAboutToFree = 0;
    const stateMap = this.agentStates.get(campaignId);
    if (stateMap) {
      for (const [, state] of stateMap) {
        if (state.state === 'wrap-up') {
          const elapsed = (Date.now() - state.since) / 1000;
          if (elapsed > avgWrapUp - 3) agentsAboutToFree++;
        }
      }
    }

    const effectiveAvailable = idleCount + agentsAboutToFree;
    if (effectiveAvailable <= 0) return 0;

    // Expected answers from currently ringing calls
    const expectedAnswers = activeRinging * answerRate;

    // Effective agent slots (available minus expected incoming answers)
    const effectiveSlots = effectiveAvailable - expectedAnswers;
    if (effectiveSlots <= 0) return 0;

    // ─── Adaptive Dial Ratio ───
    // Base ratio: inverse of answer rate
    // If 33% of calls are answered, base ratio = 3.0
    let dialRatio = answerRate > 0.05 ? (1 / answerRate) : config.dialRatio || 1.5;

    // Abandon rate feedback loop
    if (abandonRate > maxAbandon) {
      // Too many abandons — back off aggressively
      const overshoot = abandonRate / maxAbandon;
      dialRatio *= Math.max(0.5, 1 - (overshoot - 1) * 0.3);
      logger.debug(`DIALER PREDICTIVE: abandon rate ${(abandonRate * 100).toFixed(1)}% > target ${(maxAbandon * 100).toFixed(1)}% — reducing ratio to ${dialRatio.toFixed(2)}`);
    } else if (abandonRate < maxAbandon * 0.5) {
      // Well under target — speed up slightly
      dialRatio *= 1.05;
    }

    // Clamp dial ratio between 1.0 and 5.0
    dialRatio = Math.max(1.0, Math.min(5.0, dialRatio));

    // Calculate calls to place
    let toDial = Math.ceil(effectiveSlots * dialRatio);

    // Cap by maxConcurrent (already done in dial loop, but double-check)
    toDial = Math.min(toDial, (config.maxConcurrent || 50) - activeRinging);
    toDial = Math.max(0, toDial);

    // Update cached dial ratio for dashboard display
    if (stats) stats.currentDialRatio = Math.round(dialRatio * 100) / 100;

    if (toDial > 0) {
      logger.debug(`DIALER PREDICTIVE: idle=${idleCount} aboutToFree=${agentsAboutToFree} ringing=${activeRinging} expectedAns=${expectedAnswers.toFixed(1)} slots=${effectiveSlots.toFixed(1)} ratio=${dialRatio.toFixed(2)} toDial=${toDial} ansRate=${(answerRate * 100).toFixed(0)}% abandRate=${(abandonRate * 100).toFixed(1)}%`);
    }

    return toDial;
  }

  // ============================================================
  // STATS MANAGEMENT — Rolling Window + Lifetime
  //
  // Rolling stats use the last 100 call outcomes for accurate
  // real-time answer/abandon rates. Lifetime stats track totals.
  // ============================================================

  _incrementStat(campaignId, field, amount) {
    const stats = this.statsCache.get(campaignId);
    if (!stats) return;
    stats[field] = (stats[field] || 0) + (amount || 1);

    // Recalculate lifetime derived stats
    const total = stats.dialed || 1;
    stats.answerRate = stats.answered / total;
    stats.abandonRate = stats.abandoned / total;
    if (stats.answered > 0) {
      stats.avgTalkTime = stats.totalTalkTime / stats.answered;
    }

    // Push to rolling window
    if (field === 'answered' || field === 'noAnswer' || field === 'busy' ||
        field === 'failed' || field === 'machine' || field === 'abandoned') {
      if (!stats._rollingWindow) stats._rollingWindow = [];
      stats._rollingWindow.push({
        outcome: field,
        time: Date.now()
      });

      // Keep last 100 entries
      if (stats._rollingWindow.length > 100) {
        stats._rollingWindow = stats._rollingWindow.slice(-100);
      }

      // Recalculate rolling rates
      this._recalcRolling(stats);
    }

    // Track wrap-up durations for predictive pacing
    if (field === 'totalTalkTime' && amount > 0) {
      if (!stats._wrapUpSamples) stats._wrapUpSamples = [];
      stats._wrapUpSamples.push(amount);
      if (stats._wrapUpSamples.length > 50) stats._wrapUpSamples = stats._wrapUpSamples.slice(-50);
      stats._avgWrapUpTime = stats._wrapUpSamples.reduce((a, b) => a + b, 0) / stats._wrapUpSamples.length;
    }

    // Calculate calls per hour
    const running = this.runningCampaigns.get(campaignId);
    if (running && running.startedAt) {
      const runMinutes = Math.max(1, (Date.now() - running.startedAt) / 60000);
      stats.callsPerHour = Math.round((stats.dialed || 0) / runMinutes * 60);
    }
  }

  _recalcRolling(stats) {
    const window = stats._rollingWindow || [];
    if (window.length < 5) return; // need minimum samples

    let answered = 0, abandoned = 0, total = window.length;
    for (const entry of window) {
      if (entry.outcome === 'answered') answered++;
      if (entry.outcome === 'abandoned') abandoned++;
    }

    stats._rollingAnswerRate = answered / total;
    stats._rollingAbandonRate = abandoned / total;

    // Time-weighted: recent calls matter more
    // Only use calls from last 5 minutes for very recent rate
    const fiveMinAgo = Date.now() - 300000;
    const recent = window.filter(e => e.time > fiveMinAgo);
    if (recent.length >= 3) {
      let recentAnswered = 0, recentAbandoned = 0;
      for (const e of recent) {
        if (e.outcome === 'answered') recentAnswered++;
        if (e.outcome === 'abandoned') recentAbandoned++;
      }
      // Blend: 70% recent, 30% rolling
      stats._rollingAnswerRate = recentAnswered / recent.length * 0.7 + stats._rollingAnswerRate * 0.3;
      stats._rollingAbandonRate = recentAbandoned / recent.length * 0.7 + stats._rollingAbandonRate * 0.3;
    }
  }

  async _flushStats(campaignId) {
    const stats = this.statsCache.get(campaignId);
    if (!stats) return;

    const { Campaign } = require('../models');
    try {
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
        'stats.currentDialRatio': stats.currentDialRatio || 1,
        'stats.callsPerHour': stats.callsPerHour || 0,
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
    let ringingCount = 0;
    let connectedCount = 0;
    for (const [, call] of this.activeCalls) {
      if (call.campaignId === campaignId) {
        activeCallCount++;
        if (call.status === 'ringing') ringingCount++;
        if (call.status === 'connected') connectedCount++;
      }
    }

    return {
      running,
      agents,
      agentCounts: counts,
      activeCalls: activeCallCount,
      ringingCalls: ringingCount,
      connectedCalls: connectedCount,
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
        callsPerHour: stats.callsPerHour || 0,
        // Predictive-specific
        currentDialRatio: stats.currentDialRatio || 1,
        rollingAnswerRate: Math.round((stats._rollingAnswerRate || stats.answerRate || 0) * 100),
        rollingAbandonRate: Math.round((stats._rollingAbandonRate || stats.abandonRate || 0) * 1000) / 10,
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
