const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Queue, CDR } = require('../models');
const logger = require('../utils/logger');

const MOH_DIR = process.env.MOH_DIR || '/opt/shadowpbx/audio';
const AUDIO_HOST_DIR = MOH_DIR;

function toContainerPath(hostPath) {
  if (!hostPath) return hostPath;
  if (hostPath.startsWith(AUDIO_HOST_DIR)) return hostPath.replace(AUDIO_HOST_DIR, '/audio');
  if (hostPath.startsWith('/audio/')) return hostPath;
  return hostPath;
}

// ============================================================
// Call Queue / ACD Handler
//
// Lifecycle:
//   1. Caller enters queue: answer call, play join message, start MOH
//   2. Agent tracker: idle/busy/wrapup/logged-out per agent per queue
//   3. Dispatch loop: every retryDelay, find next agent by strategy
//   4. Ring agent: stop MOH, INVITE agent, bridge if answered
//   5. If agent doesn't answer: mark unavailable briefly, try next
//   6. Max wait exceeded: overflow to voicemail/IVR/extension
//   7. Caller hangs up: cleanup, update CDR
// ============================================================

class QueueHandler {
  constructor(srf, rtpengine, registrar, callHandler, voicemailHandler) {
    this.srf = srf;
    this.rtpengine = rtpengine;
    this.registrar = registrar;
    this.callHandler = callHandler;
    this.voicemailHandler = voicemailHandler;
    this.rtpengineConfig = {
      host: process.env.RTPENGINE_HOST || '127.0.0.1',
      port: parseInt(process.env.RTPENGINE_PORT) || 22222
    };

    // Agent states per queue: queueNumber -> Map<ext, { state, since, callCount, lastCallEnd }>
    // States: 'logged-in' (idle), 'busy', 'wrapup', 'logged-out'
    this.agentStates = new Map();

    // Active queue calls: callerId -> { queueNumber, uas, sipCallId, fromTag, toTag, cdr,
    //   callerID, joinedAt, position, timer, mohPlaying, destroyed }
    this.queueCalls = new Map();

    // Round-robin index per queue
    this.rrIndex = new Map();

    // Initialize agent states from DB on startup
    setTimeout(() => this._initAgentStates(), 3000);
  }

  async _initAgentStates() {
    try {
      const queues = await Queue.find({ enabled: true });
      for (const q of queues) {
        const stateMap = new Map();
        for (const agent of q.agents) {
          stateMap.set(agent.extension, {
            state: 'logged-out',
            since: Date.now(),
            callCount: 0,
            lastCallEnd: 0
          });
        }
        this.agentStates.set(q.number, stateMap);
      }
      logger.info(`Queue: initialized ${queues.length} queue(s)`);
    } catch (err) {
      logger.warn(`Queue init: ${err.message}`);
    }
  }

  // ============================================================
  // QUEUE ENTRY — called from call-handler for queue destinations
  //
  // Answers the call, plays MOH, and starts the dispatch loop.
  // req/res must not have had a final response sent yet.
  // ============================================================
  async handleQueue(req, res, queueConfig, cdr, callerID) {
    const qNum = queueConfig.number;

    // Check max callers
    const currentCallers = this._getQueueCallers(qNum);
    if (currentCallers.length >= queueConfig.maxCallers) {
      logger.warn(`QUEUE ${qNum}: full (${currentCallers.length}/${queueConfig.maxCallers}), overflow`);
      return this._overflow(req, res, queueConfig, cdr, callerID);
    }

    logger.info(`QUEUE ${qNum} (${queueConfig.name}): ${callerID} entering queue`);

    try {
      // Step 1: Answer the call
      const sipCallId = req.get('Call-Id');
      const from = req.getParsedHeader('From');
      const fromTag = from.params.tag;

      const rtpOffer = await this._rtpengineOffer(sipCallId, fromTag, req.body);
      if (!rtpOffer) {
        logger.warn(`QUEUE ${qNum}: RTPEngine unavailable, cannot queue`);
        return this._overflow(req, res, queueConfig, cdr, callerID);
      }

      const uas = await this.srf.createUAS(req, res, { localSdp: rtpOffer.sdp });
      logger.info(`QUEUE ${qNum}: call answered for ${callerID}`);

      // Complete RTPEngine answer
      const toTag = uas.sip ? uas.sip.localTag : '';
      if (toTag) {
        try {
          await this.rtpengine.answer(this.rtpengineConfig, {
            'call-id': sipCallId, 'from-tag': fromTag, 'to-tag': toTag,
            sdp: rtpOffer.sdp, 'flags': ['trust-address'],
            'replace': ['origin', 'session-connection'], 'ICE': 'remove'
          });
        } catch (e) { logger.warn(`QUEUE ${qNum}: RTPEngine answer: ${e.message}`); }
      }

      // Wait for RTP to stabilize
      await this._sleep(1500);

      // Update CDR
      cdr.status = 'answered';
      cdr.answerTime = new Date();
      cdr.to = `Q:${qNum}`;
      await cdr.save();

      // Register queue call
      const qCallId = uuidv4();
      const qCall = {
        queueNumber: qNum,
        uas,
        sipCallId,
        fromTag,
        toTag,
        cdr,
        callerID,
        joinedAt: Date.now(),
        position: currentCallers.length + 1,
        mohPlaying: false,
        destroyed: false,
        bridged: false
      };
      this.queueCalls.set(qCallId, qCall);

      // Handle caller hangup
      uas.on('destroy', () => {
        qCall.destroyed = true;
        this._callerLeft(qCallId, qCall);
      });

      // BLF
      if (this.callHandler && this.callHandler.presenceHandler) {
        // callerID may not be a local extension, that's fine — _emitPresence will no-op
      }

      // Step 2: Play join message if configured
      if (queueConfig.joinMessage) {
        await this._playFile(sipCallId, fromTag, queueConfig.joinMessage);
        await this._sleep(500);
      }

      // Step 3: Start MOH
      await this._startMoh(sipCallId, fromTag, queueConfig);
      qCall.mohPlaying = true;

      // Step 4: Start dispatch loop
      this._dispatchLoop(qCallId, qCall, queueConfig);

      return true;

    } catch (err) {
      logger.error(`QUEUE ${qNum}: entry failed: ${err.message}`);
      return this._overflow(req, res, queueConfig, cdr, callerID);
    }
  }

  // ============================================================
  // DISPATCH LOOP — periodically tries to find an available agent
  // ============================================================
  async _dispatchLoop(qCallId, qCall, queueConfig) {
    const qNum = queueConfig.number;
    const retryDelay = (queueConfig.retryDelay || 5) * 1000;
    const maxWait = (queueConfig.maxWait || 300) * 1000;
    const ringTimeout = queueConfig.ringTimeout || 20;

    const loop = async () => {
      // Check if caller is still here
      if (qCall.destroyed || qCall.bridged) return;

      // Check max wait
      if (Date.now() - qCall.joinedAt > maxWait) {
        logger.info(`QUEUE ${qNum}: ${qCall.callerID} max wait exceeded (${queueConfig.maxWait}s)`);
        await this._overflowQueued(qCallId, qCall, queueConfig);
        return;
      }

      // Find an available agent
      const agent = await this._findAgent(queueConfig);
      if (!agent) {
        // No agent available, retry later
        if (!qCall.destroyed && !qCall.bridged) {
          qCall.timer = setTimeout(loop, retryDelay);
        }
        return;
      }

      // Try to bridge caller to agent
      logger.info(`QUEUE ${qNum}: trying agent ${agent.extension} for ${qCall.callerID}`);
      const success = await this._bridgeToAgent(qCallId, qCall, queueConfig, agent, ringTimeout);

      if (success) {
        logger.info(`QUEUE ${qNum}: ${qCall.callerID} connected to ${agent.extension}`);
        return; // Done!
      }

      // Agent didn't answer — retry after delay
      if (!qCall.destroyed && !qCall.bridged) {
        // Restart MOH if it was stopped
        if (!qCall.mohPlaying) {
          await this._startMoh(qCall.sipCallId, qCall.fromTag, queueConfig);
          qCall.mohPlaying = true;
        }
        qCall.timer = setTimeout(loop, retryDelay);
      }
    };

    // Start first attempt after a short delay
    qCall.timer = setTimeout(loop, 1000);
  }

  // ============================================================
  // FIND AGENT by strategy
  // ============================================================
  async _findAgent(queueConfig) {
    const qNum = queueConfig.number;
    let stateMap = this.agentStates.get(qNum);
    if (!stateMap) return null;

    // Get agents who are logged in and idle
    const available = [];
    for (const agentConf of queueConfig.agents) {
      const state = stateMap.get(agentConf.extension);
      if (!state || state.state !== 'logged-in') continue;

      // Check if registered
      const contacts = await this.registrar.getContacts(agentConf.extension);
      if (contacts.length === 0) continue;

      available.push({
        extension: agentConf.extension,
        priority: agentConf.priority || 1,
        callCount: state.callCount || 0,
        lastCallEnd: state.lastCallEnd || 0,
        idleTime: Date.now() - (state.lastCallEnd || state.since || Date.now()),
        contacts
      });
    }

    if (available.length === 0) return null;

    // Sort by priority first (lower = higher)
    available.sort((a, b) => a.priority - b.priority);
    const topPriority = available[0].priority;
    const samePriority = available.filter(a => a.priority === topPriority);

    switch (queueConfig.strategy) {
      case 'ringall':
        return samePriority[0]; // ringall will be handled differently — for now just pick first
      case 'longest-idle':
        return samePriority.sort((a, b) => b.idleTime - a.idleTime)[0];
      case 'fewest-calls':
        return samePriority.sort((a, b) => a.callCount - b.callCount)[0];
      case 'round-robin': {
        const idx = (this.rrIndex.get(qNum) || 0) % samePriority.length;
        this.rrIndex.set(qNum, idx + 1);
        return samePriority[idx];
      }
      case 'random':
        return samePriority[Math.floor(Math.random() * samePriority.length)];
      default:
        return samePriority.sort((a, b) => b.idleTime - a.idleTime)[0];
    }
  }

  // ============================================================
  // BRIDGE caller to agent
  // ============================================================
  async _bridgeToAgent(qCallId, qCall, queueConfig, agent, ringTimeout) {
    const qNum = queueConfig.number;

    // Mark agent as busy
    this._setAgentState(qNum, agent.extension, 'busy');

    // Stop MOH
    if (qCall.mohPlaying) {
      await this._stopMoh(qCall.sipCallId, qCall.fromTag);
      qCall.mohPlaying = false;
    }

    const contact = agent.contacts.sort((a, b) => {
      const ta = a.registeredAt ? new Date(a.registeredAt).getTime() : 0;
      const tb = b.registeredAt ? new Date(b.registeredAt).getTime() : 0;
      return tb - ta;
    })[0];

    const targetUri = `sip:${agent.extension}@${contact.ip}:${contact.port}`;

    try {
      // Send INVITE to agent using srf.createUAC
      const uac = await this.srf.createUAC(targetUri, {
        localSdp: qCall.uas.local.sdp,
        headers: {
          'From': `<sip:queue-${qNum}@${process.env.SIP_DOMAIN || '127.0.0.1'}>`,
          'Alert-Info': '<http://www.notused.com>;info=alert-queue'
        }
      }, {
        cbRequest: (err, inviteReq) => {
          // Set a timer to cancel if not answered
          if (inviteReq) {
            setTimeout(() => {
              if (!qCall.bridged && !qCall.destroyed) {
                try { inviteReq.cancel(); } catch (e) {}
              }
            }, ringTimeout * 1000);
          }
        }
      });

      // Agent answered! Bridge the media
      qCall.bridged = true;

      // Re-INVITE the caller side to use the agent's SDP
      try {
        await qCall.uas.modify(uac.remote.sdp);
      } catch (e) {
        logger.debug(`QUEUE ${qNum}: re-INVITE to caller: ${e.message}`);
      }

      // BLF
      if (this.callHandler) {
        this.callHandler._emitPresence(agent.extension, 'confirmed', {
          callId: qCall.sipCallId, remoteParty: qCall.callerID, direction: 'recipient'
        });
      }

      // Update CDR
      qCall.cdr.to = agent.extension;
      qCall.cdr.status = 'answered';
      await qCall.cdr.save();

      // Track in callHandler active calls
      const sipCallId = qCall.sipCallId;
      if (this.callHandler) {
        this.callHandler.activeCalls.set(sipCallId, {
          uas: qCall.uas, uac, cdr: qCall.cdr,
          fromExt: qCall.callerID, toExt: agent.extension
        });
      }

      // Increment agent call count
      const state = this.agentStates.get(qNum) && this.agentStates.get(qNum).get(agent.extension);
      if (state) state.callCount = (state.callCount || 0) + 1;

      // Handle hangup from either side
      const onEnd = async (hangupBy) => {
        const wrapUp = (queueConfig.wrapUpTime || 10) * 1000;
        this._setAgentState(qNum, agent.extension, 'wrapup');

        if (this.callHandler) {
          this.callHandler._emitPresence(agent.extension, 'idle');
          this.callHandler.activeCalls.delete(sipCallId);
        }

        // After wrap-up, agent becomes idle
        setTimeout(() => {
          const s = this.agentStates.get(qNum) && this.agentStates.get(qNum).get(agent.extension);
          if (s && s.state === 'wrapup') {
            this._setAgentState(qNum, agent.extension, 'logged-in');
          }
        }, wrapUp);

        // Clean up queue call
        this.queueCalls.delete(qCallId);

        // End CDR
        const endTime = new Date();
        qCall.cdr.status = 'completed';
        qCall.cdr.endTime = endTime;
        qCall.cdr.duration = Math.round((endTime - qCall.cdr.startTime) / 1000);
        qCall.cdr.talkTime = qCall.cdr.answerTime ? Math.round((endTime - qCall.cdr.answerTime) / 1000) : 0;
        qCall.cdr.hangupBy = hangupBy;
        qCall.cdr.hangupCause = 'normal_clearing';
        await qCall.cdr.save();

        // RTPEngine cleanup
        try {
          await this.rtpengine.delete(this.rtpengineConfig, {
            'call-id': sipCallId, 'from-tag': qCall.fromTag
          });
        } catch (e) {}
      };

      qCall.uas.on('destroy', () => { try { uac.destroy(); } catch (e) {} onEnd('caller'); });
      uac.on('destroy', () => { try { qCall.uas.destroy(); } catch (e) {} onEnd('callee'); });

      return true;

    } catch (err) {
      logger.info(`QUEUE ${qNum}: agent ${agent.extension} didn't answer: ${err.message}`);
      // Mark agent as idle again (they didn't pick up — not their fault)
      this._setAgentState(qNum, agent.extension, 'logged-in');
      qCall.bridged = false;
      return false;
    }
  }

  // ============================================================
  // OVERFLOW — handle max wait or full queue
  // ============================================================
  async _overflow(req, res, queueConfig, cdr, callerID) {
    const dest = queueConfig.overflowDest;
    if (!dest || !dest.type || dest.type === 'hangup') {
      cdr.status = 'missed';
      cdr.hangupCause = 'queue_overflow';
      await cdr.save();
      if (!res.finalResponseSent) res.send(503);
      return false;
    }

    if (dest.type === 'voicemail' && this.voicemailHandler) {
      return this.voicemailHandler.handleVoicemail(req, res, callerID, dest.target, cdr);
    }

    // For other types, let call-handler handle it
    cdr.status = 'missed';
    cdr.hangupCause = 'queue_overflow';
    await cdr.save();
    if (!res.finalResponseSent) res.send(503);
    return false;
  }

  // Overflow for a caller already in the queue (max wait exceeded)
  async _overflowQueued(qCallId, qCall, queueConfig) {
    const dest = queueConfig.overflowDest;
    logger.info(`QUEUE ${qCall.queueNumber}: overflow for ${qCall.callerID}`);

    // Stop MOH
    if (qCall.mohPlaying) {
      await this._stopMoh(qCall.sipCallId, qCall.fromTag);
      qCall.mohPlaying = false;
    }

    // Update CDR
    qCall.cdr.status = 'missed';
    qCall.cdr.hangupCause = 'queue_timeout';
    qCall.cdr.endTime = new Date();
    qCall.cdr.duration = Math.round((qCall.cdr.endTime - qCall.cdr.startTime) / 1000);
    await qCall.cdr.save();

    // Hang up the caller
    try { qCall.uas.destroy(); } catch (e) {}
    this.queueCalls.delete(qCallId);
  }

  // ============================================================
  // CALLER LEFT — cleanup when caller hangs up while in queue
  // ============================================================
  _callerLeft(qCallId, qCall) {
    logger.info(`QUEUE ${qCall.queueNumber}: ${qCall.callerID} left queue`);
    if (qCall.timer) clearTimeout(qCall.timer);

    // Stop MOH
    if (qCall.mohPlaying) {
      this._stopMoh(qCall.sipCallId, qCall.fromTag).catch(() => {});
    }

    // RTPEngine cleanup
    try {
      this.rtpengine.delete(this.rtpengineConfig, {
        'call-id': qCall.sipCallId, 'from-tag': qCall.fromTag
      }).catch(() => {});
    } catch (e) {}

    // Update CDR
    if (qCall.cdr && !qCall.bridged) {
      qCall.cdr.status = 'missed';
      qCall.cdr.hangupCause = 'caller_abandon';
      qCall.cdr.endTime = new Date();
      qCall.cdr.duration = Math.round((qCall.cdr.endTime - qCall.cdr.startTime) / 1000);
      qCall.cdr.hangupBy = 'caller';
      qCall.cdr.save().catch(() => {});
    }

    this.queueCalls.delete(qCallId);
  }

  // ============================================================
  // AGENT STATE MANAGEMENT
  // ============================================================
  _setAgentState(qNum, ext, state) {
    let stateMap = this.agentStates.get(qNum);
    if (!stateMap) {
      stateMap = new Map();
      this.agentStates.set(qNum, stateMap);
    }
    const current = stateMap.get(ext) || { callCount: 0, lastCallEnd: 0 };
    current.state = state;
    current.since = Date.now();
    if (state === 'logged-in' && current.state === 'wrapup') {
      current.lastCallEnd = Date.now();
    }
    stateMap.set(ext, current);
    logger.debug(`QUEUE ${qNum}: agent ${ext} -> ${state}`);
  }

  agentLogin(qNum, ext) {
    this._setAgentState(qNum, ext, 'logged-in');
    logger.info(`QUEUE ${qNum}: agent ${ext} logged in`);
  }

  agentLogout(qNum, ext) {
    this._setAgentState(qNum, ext, 'logged-out');
    logger.info(`QUEUE ${qNum}: agent ${ext} logged out`);
  }

  // ============================================================
  // QUEUE STATUS / STATS
  // ============================================================
  getQueueCallers(qNum) {
    return this._getQueueCallers(qNum).map(([id, c]) => ({
      id, callerID: c.callerID, position: c.position,
      waitTime: Math.round((Date.now() - c.joinedAt) / 1000),
      bridged: c.bridged
    }));
  }

  _getQueueCallers(qNum) {
    const callers = [];
    for (const [id, c] of this.queueCalls) {
      if (c.queueNumber === qNum && !c.destroyed) callers.push([id, c]);
    }
    return callers.sort((a, b) => a[1].joinedAt - b[1].joinedAt);
  }

  getAgentStates(qNum) {
    const stateMap = this.agentStates.get(qNum);
    if (!stateMap) return [];
    const result = [];
    for (const [ext, state] of stateMap) {
      result.push({ extension: ext, ...state });
    }
    return result;
  }

  getStats(qNum) {
    const callers = this.getQueueCallers(qNum);
    const agents = this.getAgentStates(qNum);
    const loggedIn = agents.filter(a => a.state !== 'logged-out').length;
    const idle = agents.filter(a => a.state === 'logged-in').length;
    const busy = agents.filter(a => a.state === 'busy').length;
    const wrapup = agents.filter(a => a.state === 'wrapup').length;
    const avgWait = callers.length > 0
      ? Math.round(callers.reduce((sum, c) => sum + c.waitTime, 0) / callers.length)
      : 0;

    return {
      callers: callers.length,
      callersWaiting: callers.filter(c => !c.bridged).length,
      callersBridged: callers.filter(c => c.bridged).length,
      avgWaitTime: avgWait,
      agents: { total: agents.length, loggedIn, idle, busy, wrapup },
      agentList: agents,
      callerList: callers
    };
  }

  getAllStats() {
    const result = {};
    for (const [qNum] of this.agentStates) {
      result[qNum] = this.getStats(qNum);
    }
    return result;
  }

  // ============================================================
  // RTPEngine helpers
  // ============================================================
  async _rtpengineOffer(callId, fromTag, sdp) {
    if (!this.rtpengine) return null;
    try {
      const r = await this.rtpengine.offer(this.rtpengineConfig, {
        'call-id': callId, 'from-tag': fromTag, sdp,
        'flags': ['trust-address'], 'replace': ['origin', 'session-connection'], 'ICE': 'remove'
      });
      return r && r.result === 'ok' ? r : null;
    } catch (e) { return null; }
  }

  async _startMoh(sipCallId, fromTag, queueConfig) {
    if (!this.rtpengine) return;
    const mohFile = this._getMohFile(queueConfig.moh);
    if (!mohFile) return;
    try {
      await this.rtpengine.playMedia(this.rtpengineConfig, {
        'call-id': sipCallId, 'from-tag': fromTag,
        'file': toContainerPath(mohFile), 'repeat': true
      });
      logger.debug(`QUEUE: MOH started for ${sipCallId}`);
    } catch (e) { logger.debug(`QUEUE: MOH start failed: ${e.message}`); }
  }

  async _stopMoh(sipCallId, fromTag) {
    if (!this.rtpengine) return;
    try {
      await this.rtpengine.stopMedia(this.rtpengineConfig, {
        'call-id': sipCallId, 'from-tag': fromTag
      });
    } catch (e) {}
  }

  async _playFile(sipCallId, fromTag, filePath) {
    if (!this.rtpengine || !filePath) return;
    try {
      await this.rtpengine.playMedia(this.rtpengineConfig, {
        'call-id': sipCallId, 'from-tag': fromTag,
        'file': toContainerPath(filePath)
      });
      // Wait for approximate playback time (5s max)
      await this._sleep(3000);
    } catch (e) { logger.debug(`QUEUE: play file failed: ${e.message}`); }
  }

  _getMohFile(mohPath) {
    // If a specific file is given, use it
    if (mohPath && fs.existsSync(mohPath)) return mohPath;
    // Otherwise, look in the MOH directory
    if (!fs.existsSync(MOH_DIR)) return null;
    const files = fs.readdirSync(MOH_DIR).filter(f => f.endsWith('.wav') || f.endsWith('.mp3'));
    return files.length > 0 ? path.join(MOH_DIR, files[0]) : null;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = QueueHandler;
