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
      toDial = Math.max(0, idleAgents.length - activeCount);
    } else {
      // Predictive: use dial ratio
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
  // CALL ORIGINATION — Place outbound call via trunk
  //
  // Flow:
  //   1. Get trunk config
  //   2. Create outbound UAC to lead's phone via PSTN trunk
  //   3. Wait for answer (ringTimeout)
  //   4. On answer → bridge to agent extension via B2BUA
  //   5. Both legs through RTPEngine for recording
  //   6. On hangup → cleanup, update lead + CDR, wrap-up timer
  // ============================================================
  async _originateCall(callId, campaignId, lead, agentExt, config) {
    const { CDR, Lead: LeadModel } = require('../models');

    // Track this call
    this.activeCalls.set(callId, {
      campaignId,
      leadId: lead._id.toString(),
      agentExt,
      lead: lead.toObject(),
      uac: null,
      uas: null,
      status: 'ringing'
    });

    // Get trunk
    const trunk = this.trunkManager.getTrunk(config.trunk);
    if (!trunk) {
      logger.error(`DIALER: trunk "${config.trunk}" not found`);
      await this._callFailed(callId, campaignId, lead, agentExt, 'trunk_not_found', config);
      return;
    }

    const host = trunk.host || '';
    const port = trunk.port || 5060;
    const username = trunk.username || '';
    const password = trunk.password || '';
    const targetUri = `sip:${lead.phone}@${host}:${port}`;
    const sipDomain = process.env.SIP_DOMAIN || 'shadowpbx';

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

    logger.info(`DIALER CALL: ${config.callerId} -> ${lead.phone} via ${config.trunk} [${callId}] agent=${agentExt}`);

    try {
      // Step 1: Originate outbound call to the lead
      const uac = await this.srf.createUAC(targetUri, {
        headers: {
          'From': `<sip:${username}@${host}>`,
          'To': `<sip:${lead.phone}@${host}>`,
          'P-Asserted-Identity': `<sip:${config.callerId}@${host}>`
        },
        auth: { username, password },
        timeout: (config.ringTimeout || 30) * 1000
      });

      logger.info(`DIALER ANSWERED: ${lead.phone} picked up [${callId}]`);

      // Update tracking
      const activeCall = this.activeCalls.get(callId);
      if (activeCall) {
        activeCall.uac = uac;
        activeCall.status = 'answered';
      }

      // Update CDR
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      await cdr.save();

      this._incrementStat(campaignId, 'answered');

      // Step 2: Bridge to agent
      await this._bridgeToAgent(callId, campaignId, uac, lead, agentExt, config, cdr);

    } catch (err) {
      // Outbound call failed (no answer, busy, error)
      const sipStatus = err.status || 0;
      let outcome = 'failed';

      if (sipStatus === 486 || sipStatus === 600) {
        outcome = 'busy';
        this._incrementStat(campaignId, 'busy');
      } else if (sipStatus === 480 || sipStatus === 408 || sipStatus === 487) {
        outcome = 'no-answer';
        this._incrementStat(campaignId, 'noAnswer');
      } else {
        this._incrementStat(campaignId, 'failed');
      }

      logger.info(`DIALER ${outcome.toUpperCase()}: ${lead.phone} [${callId}] sip=${sipStatus}`);

      await this._callFailed(callId, campaignId, lead, agentExt, outcome, config, cdr);
    }
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
  // CALL FAILED — handle no-answer, busy, error, abandoned
  // ============================================================
  async _callFailed(callId, campaignId, lead, agentExt, outcome, config, cdr) {
    const { Lead: LeadModel, CDR: CDRModel } = require('../models');

    // Update CDR
    if (cdr) {
      cdr.status = outcome === 'busy' ? 'busy' : 'failed';
      cdr.endTime = new Date();
      cdr.duration = Math.round((cdr.endTime - cdr.startTime) / 1000);
      cdr.hangupCause = outcome;
      cdr.hangupBy = 'system';
      await cdr.save();
    }

    // Update lead — schedule retry or mark as failed
    const maxAttempts = config.retryAttempts || 3;
    const retryDelayMin = config.retryDelay || 30;

    if (lead.attempts < maxAttempts && (outcome === 'no-answer' || outcome === 'busy')) {
      // Schedule retry
      const nextAttempt = new Date(Date.now() + retryDelayMin * 60 * 1000);
      await LeadModel.findByIdAndUpdate(lead._id, {
        status: 'pending',
        outcome,
        nextAttempt,
        $push: { callIds: callId }
      });
      logger.debug(`DIALER: ${lead.phone} retry scheduled at ${nextAttempt.toISOString()} (attempt ${lead.attempts}/${maxAttempts})`);
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
