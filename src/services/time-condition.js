const { TimeCondition } = require('../models');
const logger = require('../utils/logger');

class TimeConditionService {
  constructor() {}

  /**
   * Evaluate a time condition by its number.
   * Returns { matched: boolean, destination: { type, target }, condition }
   */
  async evaluate(number) {
    const tc = await TimeCondition.findOne({ number, enabled: true });
    if (!tc) {
      logger.warn(`TimeCondition: ${number} not found or disabled`);
      return null;
    }

    const matched = this._isMatch(tc);
    const destination = matched ? tc.matchDest : tc.noMatchDest;

    logger.info(`TimeCondition ${tc.number} (${tc.name}): ${matched ? 'MATCH' : 'NO MATCH'} -> ${destination.type}:${destination.target}`);

    return { matched, destination, condition: tc };
  }

  /**
   * Check if current time matches any schedule entry and is NOT a holiday.
   */
  _isMatch(tc) {
    const now = this._nowInTimezone(tc.timezone || 'America/New_York');

    // Check holidays first — if today is a holiday, no match
    if (this._isHoliday(now, tc.holidays)) {
      logger.debug(`TimeCondition ${tc.number}: today is a holiday`);
      return false;
    }

    // Check schedule entries
    const currentDay = now.getDay();       // 0=Sun ... 6=Sat
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    for (const entry of tc.schedule) {
      // Check if current day is in this schedule entry's dayOfWeek array
      if (!entry.dayOfWeek || !entry.dayOfWeek.includes(currentDay)) continue;

      const startMinutes = this._parseTime(entry.startTime);
      const endMinutes = this._parseTime(entry.endTime);

      if (startMinutes === null || endMinutes === null) continue;

      // Handle overnight ranges (e.g. 22:00 - 06:00)
      if (endMinutes <= startMinutes) {
        // Overnight: match if current >= start OR current < end
        if (currentMinutes >= startMinutes || currentMinutes < endMinutes) {
          return true;
        }
      } else {
        // Normal: match if current >= start AND current < end
        if (currentMinutes >= startMinutes && currentMinutes < endMinutes) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if today is in the holidays list.
   * Holidays are stored as ISO date strings: "2026-12-25"
   */
  _isHoliday(now, holidays) {
    if (!holidays || holidays.length === 0) return false;

    // Format current date as YYYY-MM-DD
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const today = `${y}-${m}-${d}`;

    return holidays.includes(today);
  }

  /**
   * Parse "HH:MM" into minutes since midnight.
   */
  _parseTime(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(':');
    if (parts.length !== 2) return null;
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
    return h * 60 + m;
  }

  /**
   * Get current Date object adjusted to the specified timezone.
   * Uses Intl.DateTimeFormat to compute local time components.
   */
  _nowInTimezone(tz) {
    try {
      const now = new Date();
      // Build a formatter that extracts each component in the target timezone
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      });
      const parts = {};
      for (const { type, value } of fmt.formatToParts(now)) {
        parts[type] = value;
      }
      // Construct a Date-like object with the correct local components
      // We return a real Date set to the equivalent local time
      return new Date(
        parseInt(parts.year),
        parseInt(parts.month) - 1,
        parseInt(parts.day),
        parseInt(parts.hour),
        parseInt(parts.minute),
        parseInt(parts.second)
      );
    } catch (err) {
      logger.warn(`TimeCondition: invalid timezone "${tz}", falling back to server time`);
      return new Date();
    }
  }

  /**
   * Get current evaluation status for all time conditions (for GUI/API).
   */
  async getStatus() {
    const conditions = await TimeCondition.find({ enabled: true });
    return conditions.map(tc => {
      const matched = this._isMatch(tc);
      return {
        number: tc.number,
        name: tc.name,
        matched,
        currentDest: matched ? tc.matchDest : tc.noMatchDest,
        timezone: tc.timezone
      };
    });
  }
}

module.exports = TimeConditionService;
