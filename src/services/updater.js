const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

// ============================================================
// Self-update (Settings → System)
//
// Checks GitHub for newer commits and applies them in one click:
//
//   git fetch  →  show what changed  →  git pull --ff-only
//   →  npm install (only if package.json changed)  →  restart
//
// Deliberate limits:
//   - fast-forward only. If the working tree has local edits, or the
//     branch has diverged, the update refuses and says what to do.
//     Silently discarding someone's server-side fix is worse than
//     staying a version behind.
//   - blocked while calls are in progress, unless explicitly forced —
//     the restart is brief but it does interrupt the app.
//   - the restart is handed to systemd as a detached transient unit,
//     so it survives this process being stopped.
//   - .env is never touched (it is gitignored).
// ============================================================

const APP_DIR = path.join(__dirname, '..', '..');
const SERVICE = process.env.UPDATE_SERVICE_NAME || 'shadowpbx';
const BRANCH = process.env.UPDATE_BRANCH || 'main';
const ENABLED = String(process.env.UPDATE_ENABLED || 'true').toLowerCase() !== 'false';
const TIMEOUT = 120000;

// Progress of the run in flight (or the last one)
let job = null;

function git(args, opts) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', APP_DIR, ...args], { timeout: (opts && opts.timeout) || 30000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error((stderr || err.message).trim().split('\n')[0]));
        resolve(stdout.trim());
      });
  });
}

function isGitRepo() {
  return fs.existsSync(path.join(APP_DIR, '.git'));
}

function currentVersion() {
  // Read from disk rather than require(): after a pull the module cache still
  // holds the old package.json, so the UI would report the previous version.
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version; }
  catch (e) { return null; }
}

/**
 * What's installed, what's upstream, and whether it's safe to update.
 * @param {boolean} fetch - contact the remote (slower); false reads local state only
 */
async function status(fetch = true) {
  if (!ENABLED) return { enabled: false, error: 'Updates are disabled (UPDATE_ENABLED=false)' };
  if (!isGitRepo()) {
    return { enabled: false, error: 'Not a git checkout — this install cannot update itself. Use git clone, or update manually.' };
  }

  const out = {
    enabled: true,
    version: currentVersion(),
    branch: await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null),
    checkedAt: null,
    behind: 0,
    ahead: 0,
    dirty: [],
    commits: [],
    npmChanged: false,
    updating: !!(job && job.running),
    canUpdate: false,
    blockers: []
  };

  if (fetch) {
    try {
      await git(['fetch', '--quiet', 'origin', BRANCH], { timeout: 60000 });
      out.checkedAt = new Date().toISOString();
    } catch (e) {
      out.error = `Could not reach GitHub: ${e.message}`;
      return out;
    }
  }

  out.local = await git(['rev-parse', '--short', 'HEAD']).catch(() => null);
  out.remote = await git(['rev-parse', '--short', `origin/${BRANCH}`]).catch(() => null);

  const counts = await git(['rev-list', '--left-right', '--count', `HEAD...origin/${BRANCH}`]).catch(() => '0\t0');
  const [ahead, behind] = counts.split(/\s+/).map(n => parseInt(n, 10) || 0);
  out.ahead = ahead;
  out.behind = behind;

  if (behind > 0) {
    const log = await git(['log', '--no-merges', '--format=%h\u0001%an\u0001%ar\u0001%s', `HEAD..origin/${BRANCH}`]).catch(() => '');
    out.commits = log ? log.split('\n').filter(Boolean).slice(0, 40).map(line => {
      const [hash, author, when, subject] = line.split('\u0001');
      return { hash, author, when, subject };
    }) : [];

    const changed = await git(['diff', '--name-only', 'HEAD', `origin/${BRANCH}`]).catch(() => '');
    const files = changed ? changed.split('\n').filter(Boolean) : [];
    out.changedFiles = files.length;
    out.npmChanged = files.includes('package.json') || files.includes('package-lock.json');
    out.scriptsChanged = files.some(f => f.startsWith('scripts/'));
  }

  const dirty = await git(['status', '--porcelain']).catch(() => '');
  out.dirty = dirty ? dirty.split('\n').filter(Boolean).map(l => l.slice(3)) : [];

  if (out.behind === 0) out.blockers.push('Already up to date');
  if (out.dirty.length) out.blockers.push(`${out.dirty.length} locally modified file(s) — commit, stash or discard them first`);
  if (out.ahead > 0) out.blockers.push(`${out.ahead} local commit(s) not on origin/${BRANCH} — push or reset before updating`);
  out.canUpdate = out.behind > 0 && out.dirty.length === 0 && out.ahead === 0;

  return out;
}

function step(name, state, detail) {
  if (!job) return;
  job.steps.push({ name, state, detail: detail || '', at: new Date().toISOString() });
  logger.info(`UPDATE: ${name} — ${state}${detail ? ' (' + detail + ')' : ''}`);
}

function npmInstall() {
  return new Promise((resolve, reject) => {
    execFile('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: APP_DIR, timeout: TIMEOUT, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' '))) : resolve(stdout));
  });
}

/**
 * Restart the service without being killed along with it: systemd-run
 * creates a transient unit outside this process's cgroup. Falls back to a
 * detached setsid shell where systemd-run is unavailable.
 */
function scheduleRestart(delaySeconds = 3) {
  const unit = `shadowpbx-update-restart-${Date.now()}`;
  try {
    const p = spawn('systemd-run', [
      `--unit=${unit}`, '--collect', `--on-active=${delaySeconds}`,
      '/bin/systemctl', 'restart', SERVICE
    ], { detached: true, stdio: 'ignore' });
    p.unref();
    return true;
  } catch (e) {
    try {
      const p = spawn('/bin/sh', ['-c', `sleep ${delaySeconds}; systemctl restart ${SERVICE}`], { detached: true, stdio: 'ignore' });
      p.unref();
      return true;
    } catch (e2) {
      return false;
    }
  }
}

/**
 * Apply the update. Returns as soon as the work is done; the restart
 * happens a few seconds later so the response reaches the browser.
 * @param {object} opts - { force: ignore active calls, restart: default true }
 * @param {function} activeCalls - () => number
 */
async function update(opts = {}, activeCalls) {
  if (!ENABLED) throw new Error('Updates are disabled (UPDATE_ENABLED=false)');
  if (job && job.running) throw new Error('An update is already running');

  const st = await status(true);
  if (st.error) throw new Error(st.error);
  if (!st.canUpdate) throw new Error(st.blockers.join('; ') || 'Nothing to update');

  const calls = typeof activeCalls === 'function' ? activeCalls() : 0;
  if (calls > 0 && !opts.force) {
    throw new Error(`${calls} call(s) in progress — updating restarts the app. Retry when the system is idle, or force it.`);
  }

  job = {
    running: true, startedAt: new Date().toISOString(),
    from: st.local, to: st.remote, behind: st.behind,
    steps: [], ok: null, error: null, willRestart: opts.restart !== false
  };

  (async () => {
    try {
      step('Pulling changes', 'running', `${st.local} → ${st.remote}`);
      const pull = await git(['pull', '--ff-only', 'origin', BRANCH], { timeout: 60000 });
      step('Pulling changes', 'done', pull.split('\n').slice(-1)[0]);

      if (st.npmChanged) {
        step('Installing dependencies', 'running', 'package.json changed');
        await npmInstall();
        step('Installing dependencies', 'done');
      } else {
        step('Installing dependencies', 'skipped', 'no dependency changes');
      }

      job.version = currentVersion();

      if (st.scriptsChanged) {
        step('Setup scripts changed', 'note',
          'Review scripts/ — infrastructure changes may need setup-webrtc.sh or setup-turn.sh re-run');
      }

      if (job.willRestart) {
        const scheduled = scheduleRestart(3);
        step('Restarting service', scheduled ? 'scheduled' : 'failed',
          scheduled ? 'in 3 seconds' : 'run: systemctl restart shadowpbx');
      } else {
        step('Restarting service', 'skipped', 'run: systemctl restart shadowpbx');
      }

      job.ok = true;
    } catch (err) {
      job.ok = false;
      job.error = err.message;
      step('Update failed', 'failed', err.message);
      logger.error(`UPDATE failed: ${err.message}`);
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    }
  })();

  return job;
}

function progress() {
  return job || { running: false, steps: [] };
}

module.exports = { status, update, progress, currentVersion, isGitRepo, ENABLED, BRANCH, SERVICE };
