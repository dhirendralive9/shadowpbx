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
    type: { type: String, enum: ['extension', 'ringgroup', 'hangup'], required: true },
    target: { type: String, required: true }
  },
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
// CDR
// ============================================================
const cdrSchema = new mongoose.Schema({
  callId: { type: String, required: true, unique: true, index: true },
  from: { type: String, required: true, index: true },
  to: { type: String, required: true, index: true },
  direction: { type: String, enum: ['internal', 'inbound', 'outbound'], default: 'internal' },
  status: {
    type: String,
    enum: ['ringing', 'answered', 'completed', 'missed', 'failed', 'busy'],
    default: 'ringing'
  },
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
});

cdrSchema.index({ startTime: -1 });

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
const CDR = mongoose.model('CDR', cdrSchema);
const ActiveCall = mongoose.model('ActiveCall', activeCallSchema);

module.exports = { Extension, RingGroup, Trunk, InboundRoute, OutboundRoute, CDR, ActiveCall };
