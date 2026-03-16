const mongoose = require('mongoose');

// Extension schema - represents a SIP user/phone
const extensionSchema = new mongoose.Schema({
  extension: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  password: { type: String, required: true },
  email: { type: String },
  enabled: { type: Boolean, default: true },
  maxContacts: { type: Number, default: 5 },
  // Runtime state (updated by SIP registrations)
  registrations: [{
    contact: String,
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

// Call Detail Record schema
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
  duration: { type: Number, default: 0 },      // total seconds
  talkTime: { type: Number, default: 0 },       // seconds after answer
  hangupCause: String,
  hangupBy: { type: String, enum: ['caller', 'callee', 'system'] },
  // Recording
  recorded: { type: Boolean, default: false },
  recordingPath: String,
  recordingSize: Number,
  // SIP details
  sipCallId: String,
  fromIp: String,
  toIp: String,
  codec: String,
});

cdrSchema.index({ startTime: -1 });
cdrSchema.index({ from: 1, startTime: -1 });
cdrSchema.index({ to: 1, startTime: -1 });

// Active call tracking (in-memory, but persisted for crash recovery)
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
const CDR = mongoose.model('CDR', cdrSchema);
const ActiveCall = mongoose.model('ActiveCall', activeCallSchema);

module.exports = { Extension, CDR, ActiveCall };
