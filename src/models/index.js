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
  allowExternalCalls: { type: Boolean, default: false },  // allow inbound calls from external SIP URIs
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
    type: { type: String, enum: ['extension', 'ringgroup', 'ivr', 'timecondition', 'queue', 'appointment', 'hangup'], required: true },
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
  allowedExtensions: [{ type: String }],  // empty = all allowed
  allowDialer: { type: Boolean, default: false },  // allow use in dialer campaigns
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
  rtpengineCallId: String,
  // Dialer campaign fields
  campaignId: String,
  leadId: String,
  amdResult: { type: String, enum: ['', 'human', 'machine', 'notsure', 'fax'], default: '' },
});

cdrSchema.index({ startTime: -1 });
cdrSchema.index({ campaignId: 1, startTime: -1 });

// ============================================================
// Campaign (Dialer)
// ============================================================
const campaignSchema = new mongoose.Schema({
  name: { type: String, required: true },
  status: {
    type: String,
    enum: ['draft', 'running', 'paused', 'completed', 'archived'],
    default: 'draft'
  },
  strategy: {
    type: String,
    enum: ['auto', 'predictive'],
    default: 'auto'
  },
  trunk: { type: String, default: '' },                 // legacy: direct trunk name (optional)
  outboundRoute: { type: String, default: '' },         // outbound route ID or name
  callerId: { type: String, required: true },         // outbound caller ID
  carrier: { type: String, enum: ['', 'telnyx', 'signalwire', 'twilio'], default: '' },  // REST API carrier (for AMD)
  agents: [{ type: String }],                         // extension numbers assigned

  // Dialing settings
  maxConcurrent: { type: Number, default: 10 },       // max simultaneous outbound calls
  ringTimeout: { type: Number, default: 30 },          // seconds to ring before abandoning
  wrapUpTime: { type: Number, default: 10 },           // seconds agent unavailable after call
  retryAttempts: { type: Number, default: 3 },         // max dial attempts per lead
  retryDelay: { type: Number, default: 30 },           // minutes between retries

  // Predictive settings
  dialRatio: { type: Number, default: 1.2 },           // calls per available agent
  maxAbandoned: { type: Number, default: 3 },           // max abandon rate %

  // AMD
  amd: { type: Boolean, default: false },
  amdAction: { type: String, enum: ['hangup', 'leave-message'], default: 'hangup' },

  // Schedule
  schedule: {
    enabled: { type: Boolean, default: false },
    timezone: { type: String, default: 'America/New_York' },
    days: { type: [Number], default: [1, 2, 3, 4, 5] },  // 0=Sun...6=Sat
    startTime: { type: String, default: '09:00' },         // HH:MM
    endTime: { type: String, default: '17:00' }
  },

  // DNC
  dncEnabled: { type: Boolean, default: true },

  // Stats (updated in real-time)
  stats: {
    totalLeads: { type: Number, default: 0 },
    dialed: { type: Number, default: 0 },
    answered: { type: Number, default: 0 },
    noAnswer: { type: Number, default: 0 },
    busy: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    machine: { type: Number, default: 0 },
    abandoned: { type: Number, default: 0 },
    completed: { type: Number, default: 0 },
    totalTalkTime: { type: Number, default: 0 },         // seconds
    avgTalkTime: { type: Number, default: 0 },
    answerRate: { type: Number, default: 0 },             // 0-1
    abandonRate: { type: Number, default: 0 },            // 0-1
    currentDialRatio: { type: Number, default: 1 },
    callsPerHour: { type: Number, default: 0 },
  },

  startedAt: Date,
  pausedAt: Date,
  completedAt: Date,
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

campaignSchema.index({ status: 1 });

// ============================================================
// Lead (Dialer number list)
// ============================================================
const leadSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
  phone: { type: String, required: true },
  name: { type: String, default: '' },
  company: { type: String, default: '' },
  email: { type: String, default: '' },
  status: {
    type: String,
    enum: ['pending', 'calling', 'completed', 'failed', 'dnc', 'scheduled', 'abandoned'],
    default: 'pending'
  },
  attempts: { type: Number, default: 0 },
  lastAttempt: Date,
  nextAttempt: Date,                                    // null = ready to dial now
  outcome: {
    type: String,
    enum: ['', 'answered', 'no-answer', 'busy', 'machine', 'failed', 'abandoned'],
    default: ''
  },
  disposition: {
    type: String,
    enum: ['', 'interested', 'not-interested', 'callback', 'wrong-number', 'dnc', 'voicemail', 'no-answer'],
    default: ''
  },
  callbackTime: Date,                                   // if disposition=callback
  assignedAgent: { type: String, default: '' },          // last agent who handled
  duration: { type: Number, default: 0 },                // total talk time seconds
  callIds: [{ type: String }],                           // CDR callIds for this lead
  customFields: { type: mongoose.Schema.Types.Mixed, default: {} },  // arbitrary CSV columns
  createdAt: { type: Date, default: Date.now }
});

leadSchema.index({ campaignId: 1, status: 1, nextAttempt: 1 });
leadSchema.index({ campaignId: 1, phone: 1 }, { unique: true });
leadSchema.index({ phone: 1 });

// ============================================================
// DNC (Do Not Call) — outbound specific
// ============================================================
const dncSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  reason: { type: String, default: '' },
  source: { type: String, enum: ['agent', 'admin', 'import', 'system'], default: 'admin' },
  addedBy: { type: String, default: '' },               // username who added
  createdAt: { type: Date, default: Date.now }
});

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
// Chat Message
// ============================================================
const chatMessageSchema = new mongoose.Schema({
  from: { type: String, required: true, index: true },        // sender username
  to: { type: String, required: true, index: true },          // recipient username
  fromRole: { type: String },
  text: { type: String, required: true },
  read: { type: Boolean, default: false },
  readAt: Date,
  createdAt: { type: Date, default: Date.now }
});

chatMessageSchema.index({ from: 1, to: 1, createdAt: -1 });
chatMessageSchema.index({ to: 1, read: 1 });

// ============================================================
// Blocked Number
// ============================================================
const blockedNumberSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  reason: { type: String, default: '' },
  blockedBy: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

// ============================================================
// Appointment
// ============================================================
const appointmentSchema = new mongoose.Schema({
  number: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  greeting: { type: String, default: '' },         // path to greeting WAV
  destination: {
    type: { type: String, enum: ['extension', 'ringgroup'], required: true },
    target: { type: String, required: true }
  },
  maxRecordingLength: { type: Number, default: 120 },  // seconds
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// ============================================================
// Appointment Message (recorded caller messages pending delivery)
// ============================================================
const appointmentMessageSchema = new mongoose.Schema({
  messageId: { type: String, required: true, unique: true, index: true },
  appointmentNumber: { type: String, required: true, index: true },
  callerID: { type: String, required: true },
  duration: { type: Number, default: 0 },
  recordingPath: { type: String },
  recordingUrl: { type: String },          // Twilio recording URL (fallback)
  fileSize: { type: Number, default: 0 },
  callSid: { type: String },               // Twilio CallSid
  status: {
    type: String,
    enum: ['pending', 'delivering', 'delivered', 'failed'],
    default: 'pending'
  },
  attempts: { type: Number, default: 0 },
  deliveredAt: Date,
  createdAt: { type: Date, default: Date.now }
});

appointmentMessageSchema.index({ status: 1, createdAt: 1 });
appointmentMessageSchema.index({ appointmentNumber: 1, createdAt: -1 });

// ============================================================
// Allowed SIP Domain (whitelist for external SIP callers)
// ============================================================
const sipDomainSchema = new mongoose.Schema({
  domain: { type: String, required: true, unique: true, index: true },  // e.g. 'sip2sip.info' or '51.77.118.142'
  entryType: { type: String, enum: ['domain', 'ip'], default: 'domain' },  // 'domain' or 'ip'
  name: { type: String, default: '' },           // friendly name
  description: { type: String, default: '' },
  enabled: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

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

// ============================================================
// System Settings (singleton — one document)
// ============================================================
const systemSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: 'system' },

  // Recording retention
  recordingRetention: {
    enabled: { type: Boolean, default: false },
    days: { type: Number, default: 90 },          // 15, 30, 60, 90
    deleteRecordings: { type: Boolean, default: true },  // delete WAV files
    deletePcaps: { type: Boolean, default: true },       // delete source pcaps
    lastCleanup: Date
  },

  // MongoDB backup
  backup: {
    autoBackup: { type: Boolean, default: false },
    schedule: { type: String, default: 'daily' },  // daily, weekly
    retainDays: { type: Number, default: 7 },       // keep backups for N days
    lastBackup: Date,
    lastBackupPath: String,
    lastBackupSize: Number
  },

  updatedAt: { type: Date, default: Date.now }
}, { collection: 'systemsettings' });

// ============================================================
// CRM Configuration (one document per CRM connection)
// ============================================================
const crmConfigSchema = new mongoose.Schema({
  provider: {
    type: String,
    enum: ['salesforce', 'hubspot', 'zoho', 'freshsales', 'pipedrive', 'webhook'],
    required: true
  },
  name: { type: String, required: true },                // friendly name, e.g. "Production Salesforce"
  enabled: { type: Boolean, default: true },
  authType: {
    type: String,
    enum: ['oauth2', 'apikey', 'bearer'],
    required: true
  },
  credentials: { type: String, default: '' },            // AES-256-GCM encrypted JSON blob
  instanceUrl: { type: String, default: '' },            // CRM instance URL (e.g. SF org URL)
  webhookUrl: { type: String, default: '' },             // for webhook adapter: target URL

  // OAuth 2.0 token state (encrypted)
  oauthTokens: { type: String, default: '' },            // AES-256-GCM encrypted JSON: { accessToken, refreshToken, expiresAt }

  // Field mapping overrides (PBX field → CRM field)
  fieldMapping: {
    contact: { type: mongoose.Schema.Types.Mixed, default: {} },
    call:    { type: mongoose.Schema.Types.Mixed, default: {} },
    lead:    { type: mongoose.Schema.Types.Mixed, default: {} },
    directionValues: { type: mongoose.Schema.Types.Mixed, default: {} },
  },

  // Sync options — what to sync
  syncOptions: {
    calls:        { type: Boolean, default: true },
    contacts:     { type: Boolean, default: true },
    leads:        { type: Boolean, default: false },
    dispositions: { type: Boolean, default: true },
  },

  // Scope — which extensions/groups use this CRM
  scope: {
    allExtensions: { type: Boolean, default: true },     // true = all agents use this CRM
    extensions:    [{ type: String }],                    // if not all: specific extension numbers
    ringGroups:    [{ type: String }],                    // ring group numbers
    queues:        [{ type: String }],                    // queue numbers
  },

  // Status tracking
  lastSync: Date,
  lastError: { type: String, default: '' },
  errorCount: { type: Number, default: 0 },
  connectedAt: Date,

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

crmConfigSchema.index({ provider: 1 });
crmConfigSchema.index({ enabled: 1 });

const Extension = mongoose.model('Extension', extensionSchema);
const RingGroup = mongoose.model('RingGroup', ringGroupSchema);
const Trunk = mongoose.model('Trunk', trunkSchema);
const InboundRoute = mongoose.model('InboundRoute', inboundRouteSchema);
const OutboundRoute = mongoose.model('OutboundRoute', outboundRouteSchema);
const IVR = mongoose.model('IVR', ivrSchema);
const TimeCondition = mongoose.model('TimeCondition', timeConditionSchema);
const Queue = mongoose.model('Queue', queueSchema);
const User = mongoose.model('User', userSchema);
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);
const BlockedNumber = mongoose.model('BlockedNumber', blockedNumberSchema);
const CDR = mongoose.model('CDR', cdrSchema);
const VoicemailMessage = mongoose.model('VoicemailMessage', voicemailMessageSchema);
const ActiveCall = mongoose.model('ActiveCall', activeCallSchema);
const SystemSettings = mongoose.model('SystemSettings', systemSettingsSchema);
const Appointment = mongoose.model('Appointment', appointmentSchema);
const AppointmentMessage = mongoose.model('AppointmentMessage', appointmentMessageSchema);
const SIPDomain = mongoose.model('SIPDomain', sipDomainSchema);
const Campaign = mongoose.model('Campaign', campaignSchema);
const Lead = mongoose.model('Lead', leadSchema);
const DNC = mongoose.model('DNC', dncSchema);
const CrmConfig = mongoose.model('CrmConfig', crmConfigSchema);

module.exports = { Extension, RingGroup, Trunk, InboundRoute, OutboundRoute, IVR, TimeCondition, Queue, User, ChatMessage, BlockedNumber, CDR, VoicemailMessage, ActiveCall, SystemSettings, Appointment, AppointmentMessage, SIPDomain, Campaign, Lead, DNC, CrmConfig };
