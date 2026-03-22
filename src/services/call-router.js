const { InboundRoute, OutboundRoute } = require('../models');
const logger = require('../utils/logger');

class CallRouter {
  constructor(timeConditionService) {
    this.timeConditionService = timeConditionService || null;
  }

  // ============================================================
  // TIME CONDITION RESOLUTION
  // ============================================================

  /**
   * If the destination is a time condition, evaluate it and return the
   * resolved destination. Otherwise return the original destination.
   * Supports up to 5 levels of nesting to prevent loops.
   */
  async resolveDestination(destination, depth) {
    depth = depth || 0;
    if (!destination || destination.type !== 'timecondition') return destination;
    if (depth > 5) {
      logger.warn(`TimeCondition: nesting depth exceeded for ${destination.target}`);
      return { type: 'hangup', target: 'hangup' };
    }
    if (!this.timeConditionService) {
      logger.warn('TimeCondition: service not available, passing through');
      return destination;
    }

    const result = await this.timeConditionService.evaluate(destination.target);
    if (!result) {
      logger.warn(`TimeCondition ${destination.target}: not found, treating as hangup`);
      return { type: 'hangup', target: 'hangup' };
    }

    // The resolved destination could itself be a time condition — recurse
    return this.resolveDestination(result.destination, depth + 1);
  }

  // ============================================================
  // INBOUND ROUTING
  // ============================================================

  // Find matching inbound route for a DID
  async findInboundRoute(did, trunkName) {
    // Try exact DID match first
    let route = await InboundRoute.findOne({
      did: did,
      enabled: true
    });

    if (route) {
      logger.info(`Inbound route matched: DID ${did} -> ${route.destination.type}:${route.destination.target}`);
      return route;
    }

    // Try without leading 1 (US numbers)
    if (did && did.length === 11 && did.startsWith('1')) {
      route = await InboundRoute.findOne({
        did: did.substring(1),
        enabled: true
      });
      if (route) {
        logger.info(`Inbound route matched (stripped 1): ${did} -> ${route.destination.type}:${route.destination.target}`);
        return route;
      }
    }

    // Try catch-all (empty DID)
    route = await InboundRoute.findOne({
      $or: [{ did: '' }, { did: { $exists: false } }, { did: null }],
      enabled: true
    });

    if (route) {
      logger.info(`Inbound catch-all route: ${did} -> ${route.destination.type}:${route.destination.target}`);
      return route;
    }

    logger.warn(`No inbound route found for DID: ${did}`);
    return null;
  }

  // Extract DID from inbound SIP INVITE (SignalWire format)
  extractDID(req) {
    // Try To header first
    const to = req.getParsedHeader('To');
    let did = to.uri.match(/sip:\+?1?(\d+)@/)?.[1];

    if (did) return did;

    // Try PJSIP header (SignalWire sends DID in To header with +1 prefix)
    const toHeader = req.get('To');
    const match = toHeader.match(/sip:\+?(\d+)@/);
    if (match) return match[1];

    // Try Request-URI
    const ruri = req.uri;
    const ruriMatch = ruri.match(/sip:\+?(\d+)@/);
    if (ruriMatch) return ruriMatch[1];

    return null;
  }

  // Extract caller ID from inbound call
  extractCallerID(req) {
    const from = req.getParsedHeader('From');
    const match = from.uri.match(/sip:\+?(\d+)@/);
    return match ? match[1] : 'unknown';
  }

  // ============================================================
  // OUTBOUND ROUTING
  // ============================================================

  // Find matching outbound route for a dialed number
  async findOutboundRoute(dialedNumber, callerExt) {
    const routes = await OutboundRoute.find({ enabled: true }).sort({ priority: 1 });

    for (const route of routes) {
      // Check if caller is allowed on this route
      if (route.allowedExtensions && route.allowedExtensions.length > 0) {
        if (!callerExt || !route.allowedExtensions.includes(callerExt)) {
          continue; // This extension is not permitted on this route
        }
      }

      for (const pattern of route.patterns) {
        if (this._matchDialPattern(dialedNumber, pattern)) {
          logger.info(`Outbound route matched: ${dialedNumber} -> trunk:${route.trunk} (pattern: ${pattern}, caller: ${callerExt || 'any'})`);
          return route;
        }
      }
    }

    logger.warn(`No outbound route found for: ${dialedNumber} (caller: ${callerExt || 'unknown'})`);
    return null;
  }

  // Process dialed number through route (strip/prepend)
  processOutboundNumber(dialedNumber, route) {
    let processed = dialedNumber;

    // Strip leading digits
    if (route.strip > 0) {
      processed = processed.substring(route.strip);
    }

    // Prepend digits
    if (route.prepend) {
      processed = route.prepend + processed;
    }

    return processed;
  }

  // Match a dialed number against a dial pattern
  // Patterns: N=2-9, X=0-9, Z=1-9, .=wildcard
  // Examples: "1NXXNXXXXXX" matches US 11-digit, "NXXNXXXXXX" matches US 10-digit
  _matchDialPattern(number, pattern) {
    if (pattern === '_.' || pattern === '.') return true; // match anything

    // Remove leading _ if present (FreePBX style)
    const p = pattern.startsWith('_') ? pattern.substring(1) : pattern;

    if (number.length !== p.length && !p.includes('.')) return false;

    for (let i = 0; i < p.length; i++) {
      const pc = p[i];
      const nc = number[i];

      if (!nc && pc !== '.') return false;

      if (pc === 'X') {
        if (!/[0-9]/.test(nc)) return false;
      } else if (pc === 'N') {
        if (!/[2-9]/.test(nc)) return false;
      } else if (pc === 'Z') {
        if (!/[1-9]/.test(nc)) return false;
      } else if (pc === '.') {
        return true; // match rest
      } else {
        if (pc !== nc) return false;
      }
    }

    return true;
  }
}

module.exports = CallRouter;
