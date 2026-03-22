const mongoose = require('mongoose');

// ============================================================
// Extension
// ============================================================
const extensionSchema = new mongoose.Schema({
  extension: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  email: { type: String },
  enabled: { type: Boolean, default: true },
  maxContacts: { type: Number, default: 5 },
  registrations: [{
    contact: String,
    contactUri: String,
    ip: String,
    port: Number,
    userAgent: String,
    expires: Date,
    registeredAt: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

extensionSchema.methods.isRegistered = function () {
  return this.registrations.some(r => r.expires > new Date());
};

extensionSchema.methods.getActiveContacts = function () {
  return this.registrations.filter(r => r.expires > new Date());
};

// ============================================================
// Ring Group
// ============================================================
const ringGroupSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  strategy: {
    type: String,
    enum: ['simultaneously', 'orderby', 'random', 'roundrobin', 'ringall', 'sequential'],
    default: 'simultaneously'
  },
  members: [{ type: String }],
  ringTime: { type: Number, default: 30 },
  callerIdPrefix: { type: String, default: '' },
  hideCallerId: { type: Boolean, default: false },
  stickyAgent: { type: Boolean, default: false },
  lastAgentIndex: { type: Number, default: 0 },
  stickyMap: { type: Map, of: String, default: {} },
  noAnswerDest: {
    type: { type: String, enum: ['hangup', 'extension', 'ringgroup', 'voicemail'], default: 'hangup' },
    target: { type: String, default: '' }
  },
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// ============================================================
// SIP Trunk
// ============================================================
const trunkSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  provider: { type: String, default: 'signalwire' },
  host: { type: String, required: true },
  username: { type: String, required: true },
  password: { type: String, required: true },
  port: { type: Number, default: 5060 },
  transport: { type: String, default: 'udp' },
  register: { type: Boolean, default: true },
  enabled: { type: Boolean, default: true },
  registered: { type: Boolean, default: false },
  registeredAt: Date,
  createdAt: { type: Date, default: Date.now }
});

// ============================================================
// Inbound Route
// ============================================================
const inboundRouteSchema = new mongoose.Schema({
  did: { type: String, index: true },
  name: { type: String, required: true },
  trunk: { type: String },
  destination: {
    type: { type: String, enum: ['extension', 'ringgroup', 'ivr', 'timecondition', 'queue', 'hangup'], required: true },
    target: { type: String, required: true }
  },
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// ============================================================
// IVR / Auto Attendant
// ============================================================
const ivrSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  greeting: { type: String, default: '' },  // path to greeting WAV (container path)
  options: [{
    digit: { type: String, required: true },  // '0'-'9', '*', '#'
    destination: {
      type: { type: String, enum: ['extension', 'ringgroup', 'ivr', 'voicemail', 'external', 'hangup'], required: true },
      target: { type: String, required: true }
    }
  }],
  timeout: { type: Number, default: 10 },       // seconds to wait for input
  maxRetries: { type: Number, default: 3 },      // times to replay before timeout
  timeoutDest: {
    type: { type: String, enum: ['extension', 'ringgroup', 'ivr', 'voicemail', 'hangup'], default: 'hangup' },
    target: { type: String, default: '' }
  },
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// ============================================================
// Time Condition
// ============================================================
const timeConditionSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  timezone: { type: String, default: 'America/New_York' },
  schedule: [{
    dayOfWeek: { type: [Number], required: true },  // 0=Sun, 1=Mon ... 6=Sat
    startTime: { type: String, required: true },     // "09:00"
    endTime: { type: String, required: true }        // "17:00"
  }],
  holidays: [{ type: String }],  // ISO date strings: "2026-12-25"
  matchDest: {
    type: { type: String, enum: ['extension', 'ringgroup', 'ivr', 'voicemail', 'hangup'], required: true },
    target: { type: String, required: true }
  },
  noMatchDest: {
    type: { type: String, enum: ['extension', 'ringgroup', 'ivr', 'voicemail', 'hangup'], required: true },
    target: { type: String, required: true }
  },
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// ============================================================
// Call Queue / ACD
// ============================================================
const queueSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  strategy: {
    type: String,
    enum: ['ringall', 'longest-idle', 'round-robin', 'fewest-calls', 'random'],
    default: 'longest-idle'
  },
  agents: [{
    extension: { type: String, required: true },
    priority: { type: Number, default: 1 },      // lower = higher priority
    penalty: { type: Number, default: 0 }         // 0 = no penalty
  }],
  maxWait: { type: Number, default: 300 },         // max seconds in queue before overflow
  wrapUpTime: { type: Number, default: 10 },       // seconds agent is unavailable after call
  ringTimeout: { type: Number, default: 20 },      // seconds to ring agent before trying next
  retryDelay: { type: Number, default: 5 },        // seconds between retry attempts
  maxCallers: { type: Number, default: 20 },        // max callers in queue at once
  moh: { type: String, default: '' },               // MOH file/directory
  announceFrequency: { type: Number, default: 30 }, // seconds between position announcements (0=off)
  overflowDest: {
    type: { type: String, enum: ['extension', 'ringgroup', 'ivr', 'voicemail', 'hangup'], default: 'voicemail' },
    target: { type: String, default: '' }
  },
  joinMessage: { type: String, default: '' },       // WAV played when caller joins queue
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// ============================================================
// Outbound Route
// ============================================================
const outboundRouteSchema = new mongoose.Schema({
  name: { type: String, required: true },
  patterns: [{ type: String }],
  trunk: { type: String, required: true },
  prepend: { type: String, default: '' },
  strip: { type: Number, default: 0 },
  callerIdNumber: { type: String },
  enabled: { type: Boolean, default: true },
  priority: { type: Number, default: 10 },
  createdAt: { type: Date, default: Date.now }
});

outboundRouteSchema.index({ priority: 1 });

// ============================================================
// User (RBAC)
// ============================================================
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, index: true },
  password: { type: String, required: true },  // bcrypt hash
  role: { type: String, enum: ['admin', 'supervisor', 'agent'], required: true, default: 'agent' },
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  extension: { type: String, default: '' },        // linked extension (for agents)
  assignedExtensions: [{ type: String }],           // supervisor: extensions they manage
  assignedRingGroups: [{ type: String }],            // supervisor: ring groups they manage
  assignedQueues: [{ type: String }],                // supervisor: queues they manage
  assignedIVRs: [{ type: String }],                  // supervisor: IVRs they can view
  enabled: { type: Boolean, default: true },
  lastLogin: Date,
  createdAt: { type: Date, default: Date.now }
});

// ============================================================
// CDR
// ============================================================
const cdrSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true, index: true },
  from: { type: String, required: true, index: true },
  to: { type: String, required: true, index: true },
  direction: { type: String, enum: ['internal', 'inbound', 'outbound'], default: 'internal' },
  status: {
    type: String,
    enum: ['ringing', 'answered', 'completed', 'missed', 'failed', 'busy', 'voicemail'],
    default: 'ringing'
  },
  disposition: {
    type: String,
    enum: ['', 'resolved', 'follow-up', 'escalated', 'no-action', 'spam', 'callback'],
    default: ''
  },
  notes: [{
    text: { type: String, required: true },
    author: { type: String, required: true },     // username
    authorRole: { type: String },                  // role at time of note
    createdAt: { type: Date, default: Date.now }
  }],
  startTime: { type: Date, default: Date.now },
  answerTime: Date,
  endTime: Date,
  duration: { type: Number, default: 0 },
  talkTime: { type: Number, default: 0 },
  hangupCause: String,
  hangupBy: { type: String, enum: ['caller', 'callee', 'system'] },
  recorded: { type: Boolean, default: false },
  recordingPath: String,
  recordingSize: Number,
  sipCallId: String,
  fromIp: String,
  toIp: String,
  codec: String,
  trunkUsed: String,
  didNumber: String,
  transferredBy: String,
  transferredTo: String,
  transferType: { type: String, enum: ['blind', 'attended'] },
  transferTime: Date,
  parkedSlot: String,
  parkedBy: String,
  parkedAt: Date,
  pickedUpBy: String,
  pickedUpAt: Date,
  voicemailId: String,
});

cdrSchema.index({ startTime: -1 });

// ============================================================
// Voicemail Message
// ============================================================
const voicemailMessageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true, index: true },
  extension: { type: String, required: true, index: true },
  callerID: { type: String, required: true },
  duration: { type: Number, default: 0 },
  recordingPath: { type: String },
  fileSize: { type: Number, default: 0 },
  read: { type: Boolean, default: false },
  readAt: Date,
  createdAt: { type: Date, default: Date.now }
});

voicemailMessageSchema.index({ extension: 1, createdAt: -1 });
voicemailMessageSchema.index({ extension: 1, read: 1 });

// ============================================================
// Active Call
// ============================================================
const activeCallSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true },
  from: String,
  to: String,
  startTime: { type: Date, default: Date.now },
  status: { type: String, default: 'ringing' },
  rtpengineCallId: String,
  rtpengineFromTag: String,
  rtpengineToTag: String,
});

const Extension = mongoose.model('Extension', extensionSchema);
const RingGroup = mongoose.model('RingGroup', ringGroupSchema);
const Trunk = mongoose.model('Trunk', trunkSchema);
const InboundRoute = mongoose.model('InboundRoute', inboundRouteSchema);
const OutboundRoute = mongoose.model('OutboundRoute', outboundRouteSchema);
const IVR = mongoose.model('IVR', ivrSchema);
const TimeCondition = mongoose.model('TimeCondition', timeConditionSchema);
const Queue = mongoose.model('Queue', queueSchema);
const User = mongoose.model('User', userSchema);
const CDR = mongoose.model('CDR', cdrSchema);
const VoicemailMessage = mongoose.model('VoicemailMessage', voicemailMessageSchema);
const ActiveCall = mongoose.model('ActiveCall', activeCallSchema);

module.exports = { Extension, RingGroup, Trunk, InboundRoute, OutboundRoute, IVR, TimeCondition, Queue, User, CDR, VoicemailMessage, ActiveCall };
