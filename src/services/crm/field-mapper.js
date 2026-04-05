const logger = require('../../utils/logger');

// ============================================================
// CRM Field Mapper
//
// Translates ShadowPBX call/contact data to CRM-specific field
// names. Each CRM has different field names for the same data.
//
// Supports:
//   - Default mappings per provider (Salesforce, HubSpot, etc.)
//   - Custom overrides stored in CrmConfig.fieldMapping
//   - Reverse mapping (CRM → PBX) for imports
//
// Usage:
//   const mapper = new FieldMapper('salesforce', customOverrides);
//   const sfData = mapper.mapCallData(cdrRecord);
//   const sfContact = mapper.mapContactData({ name, phone, email });
// ============================================================

// Default field mappings per CRM provider
const DEFAULT_MAPPINGS = {
  salesforce: {
    // Contact fields: PBX → Salesforce
    contact: {
      name:    'Name',         // SF splits into FirstName + LastName
      phone:   'Phone',
      email:   'Email',
      company: 'Account.Name',
    },
    // Call logging fields: PBX → Salesforce Task
    call: {
      contactId:   'WhoId',
      direction:   'CallType',          // 'Inbound' or 'Outbound'
      duration:    'CallDurationInSeconds',
      notes:       'Description',
      disposition: 'Status',
      agent:       'OwnerId',
      startTime:   'ActivityDate',
      subject:     'Subject',
    },
    // Lead fields: PBX → Salesforce Lead
    lead: {
      name:    'LastName',
      phone:   'Phone',
      email:   'Email',
      company: 'Company',
      source:  'LeadSource',
    },
    // Direction value mapping
    directionValues: {
      inbound:  'Inbound',
      outbound: 'Outbound',
      internal: 'Internal',
    },
  },

  hubspot: {
    contact: {
      name:    'firstname',     // HubSpot splits into firstname + lastname
      phone:   'phone',
      email:   'email',
      company: 'company',
    },
    call: {
      contactId:   'associations',
      direction:   'hs_call_direction',
      duration:    'hs_call_duration',
      notes:       'hs_call_body',
      disposition: 'hs_call_disposition',
      recordingUrl: 'hs_call_recording_url',
      agent:       'hubspot_owner_id',
      startTime:   'hs_timestamp',
      subject:     'hs_call_title',
    },
    lead: {
      name:    'firstname',
      phone:   'phone',
      email:   'email',
      company: 'company',
      source:  'hs_lead_source',
    },
    directionValues: {
      inbound:  'INBOUND',
      outbound: 'OUTBOUND',
      internal: 'INBOUND',
    },
  },

  zoho: {
    contact: {
      name:    'Full_Name',
      phone:   'Phone',
      email:   'Email',
      company: 'Company',
    },
    call: {
      contactId:   'Who_Id',
      direction:   'Call_Type',
      duration:    'Call_Duration',
      notes:       'Description',
      disposition: 'Call_Result',
      agent:       'Owner',
      startTime:   'Call_Start_Time',
      subject:     'Subject',
    },
    lead: {
      name:    'Last_Name',
      phone:   'Phone',
      email:   'Email',
      company: 'Company',
      source:  'Lead_Source',
    },
    directionValues: {
      inbound:  'Inbound',
      outbound: 'Outbound',
      internal: 'Inbound',
    },
  },

  freshsales: {
    contact: {
      name:    'display_name',
      phone:   'mobile_number',
      email:   'email',
      company: 'company_name',
    },
    call: {
      contactId:   'targetable_id',
      direction:   'call_type_id',
      duration:    'duration',
      notes:       'note',
      disposition: 'outcome',
      agent:       'user_id',
      startTime:   'created_at',
    },
    lead: {
      name:    'display_name',
      phone:   'mobile_number',
      email:   'email',
      company: 'company_name',
      source:  'lead_source_id',
    },
    directionValues: {
      inbound:  1,
      outbound: 2,
      internal: 1,
    },
  },

  pipedrive: {
    contact: {
      name:    'name',
      phone:   'phone',
      email:   'email',
      company: 'org_id',
    },
    call: {
      contactId:   'person_id',
      direction:   null,                // Pipedrive doesn't have a direction field
      duration:    'duration',
      notes:       'note',
      disposition: null,                // No native disposition
      agent:       'user_id',
      startTime:   'due_date',
      subject:     'subject',
    },
    lead: {
      name:    'name',
      phone:   'phone',
      email:   'email',
      company: 'org_id',
    },
    directionValues: {
      inbound:  'inbound',
      outbound: 'outbound',
      internal: 'internal',
    },
  },

  webhook: {
    // Webhook uses ShadowPBX field names directly — no mapping
    contact: { name: 'name', phone: 'phone', email: 'email', company: 'company' },
    call: {
      contactId: 'contactId', direction: 'direction', duration: 'duration',
      notes: 'notes', disposition: 'disposition', recordingUrl: 'recordingUrl',
      agent: 'agent', startTime: 'startTime', subject: 'subject',
    },
    lead: { name: 'name', phone: 'phone', email: 'email', company: 'company', source: 'source' },
    directionValues: { inbound: 'inbound', outbound: 'outbound', internal: 'internal' },
  },
};

class FieldMapper {
  /**
   * @param {string} provider — CRM provider name
   * @param {Object} [customMapping] — custom overrides from CrmConfig.fieldMapping
   */
  constructor(provider, customMapping) {
    this.provider = provider;

    // Start with defaults, overlay custom overrides
    const defaults = DEFAULT_MAPPINGS[provider] || DEFAULT_MAPPINGS.webhook;
    this.mapping = {
      contact: { ...defaults.contact, ...(customMapping?.contact || {}) },
      call:    { ...defaults.call,    ...(customMapping?.call || {}) },
      lead:    { ...defaults.lead,    ...(customMapping?.lead || {}) },
      directionValues: { ...defaults.directionValues, ...(customMapping?.directionValues || {}) },
    };
  }

  // ──────────────────────────────────────────────────────────
  // Forward mapping: ShadowPBX → CRM
  // ──────────────────────────────────────────────────────────

  /**
   * Map ShadowPBX call data to CRM call/activity fields.
   * @param {Object} callData — ShadowPBX call data
   * @returns {Object} — CRM-formatted call data
   */
  mapCallData(callData) {
    const m = this.mapping.call;
    const result = {};

    if (m.contactId && callData.contactId)     result[m.contactId] = callData.contactId;
    if (m.direction && callData.direction)      result[m.direction] = this._mapDirection(callData.direction);
    if (m.duration != null)                     result[m.duration] = callData.duration || 0;
    if (m.notes && callData.notes)              result[m.notes] = callData.notes;
    if (m.disposition && callData.disposition)  result[m.disposition] = callData.disposition;
    if (m.recordingUrl && callData.recordingUrl) result[m.recordingUrl] = callData.recordingUrl;
    if (m.agent && callData.agent)              result[m.agent] = callData.agent;
    if (m.startTime && callData.startTime)      result[m.startTime] = callData.startTime;
    if (m.subject) {
      result[m.subject] = callData.subject ||
        `${callData.direction || 'Call'}: ${callData.from} → ${callData.to}`;
    }

    // Always include PBX call ID for reference
    result._pbxCallId = callData.callId;

    return result;
  }

  /**
   * Map ShadowPBX contact data to CRM contact fields.
   * @param {Object} data — { name, phone, email, company }
   * @returns {Object} — CRM-formatted contact data
   */
  mapContactData(data) {
    const m = this.mapping.contact;
    const result = {};

    // Handle name splitting for CRMs that use first/last
    if (m.name && data.name) {
      if (this.provider === 'salesforce') {
        const parts = _splitName(data.name);
        result.FirstName = parts.first;
        result.LastName = parts.last;
      } else if (this.provider === 'hubspot') {
        const parts = _splitName(data.name);
        result.firstname = parts.first;
        result.lastname = parts.last;
      } else if (this.provider === 'zoho') {
        const parts = _splitName(data.name);
        result.First_Name = parts.first;
        result.Last_Name = parts.last;
      } else {
        result[m.name] = data.name;
      }
    }

    if (m.phone && data.phone)     result[m.phone] = data.phone;
    if (m.email && data.email)     result[m.email] = data.email;
    if (m.company && data.company) result[m.company] = data.company;

    return result;
  }

  /**
   * Map ShadowPBX lead data to CRM lead fields.
   * @param {Object} data — { name, phone, email, company, source }
   * @returns {Object} — CRM-formatted lead data
   */
  mapLeadData(data) {
    const m = this.mapping.lead;
    const result = {};

    if (m.name && data.name)       result[m.name] = data.name;
    if (m.phone && data.phone)     result[m.phone] = data.phone;
    if (m.email && data.email)     result[m.email] = data.email;
    if (m.company && data.company) result[m.company] = data.company;
    if (m.source) result[m.source] = data.source || 'ShadowPBX';

    return result;
  }

  // ──────────────────────────────────────────────────────────
  // Reverse mapping: CRM → ShadowPBX
  // ──────────────────────────────────────────────────────────

  /**
   * Normalize a CRM contact object to ShadowPBX format.
   * @param {Object} crmContact — raw CRM contact object
   * @returns {Object} — { id, name, phone, email, company, title, crmUrl, raw }
   */
  normalizeContact(crmContact) {
    // Each adapter should override this for CRM-specific normalization.
    // This is a fallback that tries the reverse mapping.
    const m = this.mapping.contact;
    return {
      id:      crmContact.id || crmContact.Id || null,
      name:    crmContact[m.name] || crmContact.Name || crmContact.name || '',
      phone:   crmContact[m.phone] || '',
      email:   crmContact[m.email] || '',
      company: crmContact[m.company] || '',
      title:   crmContact.Title || crmContact.title || '',
      crmUrl:  null,
      raw:     crmContact,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────

  /**
   * Map ShadowPBX direction to CRM-specific direction value.
   */
  _mapDirection(direction) {
    return this.mapping.directionValues[direction] || direction;
  }

  /**
   * Get the current mapping configuration (for the admin UI).
   */
  getMapping() {
    return { ...this.mapping };
  }

  /**
   * Get default mapping for a provider (static, for admin UI).
   */
  static getDefaults(provider) {
    return DEFAULT_MAPPINGS[provider] || DEFAULT_MAPPINGS.webhook;
  }

  /**
   * Get all supported providers (static).
   */
  static getProviders() {
    return Object.keys(DEFAULT_MAPPINGS);
  }
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

function _splitName(fullName) {
  if (!fullName) return { first: '', last: '(unknown)' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: '', last: parts[0] };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

module.exports = FieldMapper;
