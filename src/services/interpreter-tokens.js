'use strict';
/**
 * Connect tokens for the interpreter socket.
 *
 * The agent application — browser phone today, Electron later — needs to open
 * a WebSocket to the interpreter port and prove who it is. It cannot use the
 * session cookie: the interpreter runs on its own port and, once packaged as a
 * desktop app, there is no cookie jar to borrow from.
 *
 * So the web UI, which IS cookie-authenticated, mints a token here and hands
 * it to the client. Three properties matter, and each one is deliberate:
 *
 *  - Separate scope from the SIP browser credential. The registrar issues
 *    tokens that work as a REGISTER password; these do not, and vice versa.
 *    If an interpreter token leaks it buys an audio socket, not an extension.
 *  - Single use. The token is consumed the moment a socket presents it, so a
 *    copy taken off the wire or out of a log is already spent.
 *  - Short lived. It exists to cross the gap between "page loaded" and
 *    "socket open", which is seconds, so the window is a couple of minutes,
 *    not the length of a shift.
 *
 * Deliberately in memory only. These are worthless after one use and after a
 * restart; persisting them would add a table whose only job is to hold
 * credentials longer than necessary.
 */
const crypto = require('crypto');
const logger = require('../utils/logger');

const TTL_MS = parseInt(process.env.INTERPRETER_TOKEN_TTL_MS || '', 10) || 120000; // 2 min to connect

class InterpreterTokens {
  constructor() {
    this.tokens = new Map();   // token -> { extension, user, languages, voiceGender, expires }
    this.timer = setInterval(() => this.sweep(), 60000);
    if (this.timer.unref) this.timer.unref();
  }

  /**
   * @param extension   the extension this socket may translate for
   * @param user        who asked, for the audit line
   * @param languages   { agent, customer } resolved server-side — the client
   *                    does not get to choose what it is billed for
   */
  issue({ extension, user, languages, voiceGender }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = Date.now() + TTL_MS;
    this.tokens.set(token, {
      extension: String(extension),
      user: user || '',
      languages: languages || {},
      voiceGender: voiceGender || 'female',
      expires
    });
    return { token, expires };
  }

  /** Redeem a token. Returns its payload once, then never again. */
  consume(token) {
    if (!token) return null;
    const row = this.tokens.get(token);
    if (!row) return null;
    this.tokens.delete(token);                     // single use, even if expired
    if (row.expires <= Date.now()) {
      logger.warn(`INTERPRETER: connect token for ${row.extension} presented after expiry`);
      return null;
    }
    return row;
  }

  revokeFor(extension) {
    const ext = String(extension);
    for (const [t, row] of this.tokens) if (row.extension === ext) this.tokens.delete(t);
  }

  sweep() {
    const now = Date.now();
    for (const [t, row] of this.tokens) if (row.expires <= now) this.tokens.delete(t);
  }

  stop() { clearInterval(this.timer); this.tokens.clear(); }
}

module.exports = new InterpreterTokens();
module.exports.InterpreterTokens = InterpreterTokens;
