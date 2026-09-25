const path = require('path');

// ============================================================
// Safe path resolution
//
// Any filesystem path built from HTTP input has to be proven to stay
// inside its intended directory before use. String sanitising like
// name.replace(/\.\./g, '') is not enough — "....//" collapses back to
// "../", absolute paths ignore the base entirely, and symlinks can point
// out. The only reliable check is to resolve the full path and confirm it
// is the base directory or sits beneath it.
//
//   const file = safeResolve(audioDir, req.params.filename);  // throws on escape
//
// Use this for every path derived from a request: audio files, recordings,
// uploads, anything.
// ============================================================

/**
 * Resolve `name` against `baseDir` and guarantee containment.
 * @param {string} baseDir - the directory the result must stay within
 * @param {string} name - untrusted path segment from the request
 * @returns {string} the absolute, contained path
 * @throws {Error} (status 400) if name is empty, absolute, or escapes baseDir
 */
function safeResolve(baseDir, name) {
  if (name === undefined || name === null || name === '') {
    throw badPath('empty path');
  }
  const raw = String(name);

  // Reject NUL bytes outright — they can truncate paths in native calls.
  if (raw.includes('\0')) throw badPath('illegal characters in path');

  // An absolute input would make path.resolve ignore baseDir completely.
  if (path.isAbsolute(raw)) throw badPath('absolute paths are not allowed');

  const base = path.resolve(baseDir);
  const target = path.resolve(base, raw);

  // Contained means: exactly the base, or below it (base + separator prefix).
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw badPath('path escapes the allowed directory');
  }
  return target;
}

/**
 * True/false variant for when you'd rather branch than catch.
 */
function isContained(baseDir, name) {
  try { safeResolve(baseDir, name); return true; }
  catch (e) { return false; }
}

/**
 * A safe single-segment filename: strips any directory parts and rejects
 * traversal. Use when you want just a name, never a subpath.
 */
function safeBasename(name) {
  const b = path.basename(String(name || ''));
  if (!b || b === '.' || b === '..' || b.includes('\0')) throw badPath('invalid filename');
  return b;
}

function badPath(reason) {
  const err = new Error(`Invalid path: ${reason}`);
  err.status = 400;
  err.code = 'EBADPATH';
  return err;
}

module.exports = { safeResolve, isContained, safeBasename };
