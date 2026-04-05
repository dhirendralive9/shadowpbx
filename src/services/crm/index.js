// ============================================================
// CRM Module Index
//
// Re-exports all CRM components for convenient importing:
//   const { BaseCrmAdapter, FieldMapper, crypto } = require('./crm');
// ============================================================

const BaseCrmAdapter = require('./base-adapter');
const FieldMapper = require('./field-mapper');
const crypto = require('./crypto');
const oauth = require('./oauth');

// Adapter classes — lazy-loaded to avoid errors if not yet implemented
const adapters = {};
function getAdapter(name) {
  if (!adapters[name]) {
    try { adapters[name] = require(`./${name}`); } catch { adapters[name] = null; }
  }
  return adapters[name];
}

module.exports = {
  BaseCrmAdapter,
  FieldMapper,
  crypto,
  oauth,
  getAdapter,
};
