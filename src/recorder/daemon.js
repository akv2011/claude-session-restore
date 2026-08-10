/**
 * The recorder.
 *
 * Exists because ~/.claude/sessions/<pid>.json is wiped when a session ends, so
 * the only way to restore anything is to have been watching while the work
 * happened. Deliberately dull: poll, verify, write, repeat. Failures are logged
 * and swallowed, because a recorder that crashes stops protecting you.
 */

import fs from 'node:fs';
import { readLiveSessions } from '../core/registry.js';
import { writeSnapshot } from '../core/snapshot.js';
import { STATE_DIR, LOG_FILE } from '../core/paths.js';

const POLL_INTERVAL_MS = 5000;
const MAX_LOG_BYTES = 512 * 1024;

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Cheap rotation so an always-on daemon cannot fill the disk.
    try {
      if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
      }
    } catch { /* no log yet */ }
    fs.appendFileSync(LOG_FILE, line);
  } catch { /* logging must never be fatal */ }
}

/** One poll. Exported so the CLI and tests can run it without the loop. */
export function pollOnce() {
  const live = readLiveSessions();
  const sessions = live
    .filter((session) => session.sessionId && session.cwd)
    .map((session) => ({
      sessionId: session.sessionId,
      cwd: session.cwd,
      name: session.name,
      status: session.status,
      version: session.version,
      pid: session.pid,
      lastSeen: Date.now(),
    }));
  writeSnapshot(sessions);
  return sessions;
}

export function run() {
  log(`recorder started (pid ${process.pid}, interval ${POLL_INTERVAL_MS}ms)`);

  let lastCount = -1;
  const tick = () => {
    try {
      const sessions = pollOnce();
      if (sessions.length !== lastCount) {
        log(`tracking ${sessions.length} session(s): ${sessions.map((s) => s.name).join(', ')}`);
        lastCount = sessions.length;
      }
    } catch (err) {
      log(`poll failed: ${err.message}`);
    }
  };

  tick();
  const timer = setInterval(tick, POLL_INTERVAL_MS);

  const stop = (signal) => {
    log(`recorder stopping (${signal})`);
    clearInterval(timer);
    process.exit(0);
  };
  // On shutdown, do NOT poll again: the claude processes may already be gone and
  // a final poll would overwrite a good snapshot with an empty one. Just leave.
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // --once exists for launchd StartInterval mode, where launchd owns the timer
  // and nothing stays resident between ticks.
  if (process.argv.includes('--once')) {
    try {
      const sessions = pollOnce();
      log(`tick: captured ${sessions.length} session(s)`);
    } catch (err) {
      log(`tick failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    run();
  }
}
