/**
 * The recorder.
 *
 * This exists because ~/.claude/sessions/<pid>.json is wiped when a session
 * ends. After a shutdown there is nothing left on the machine describing what
 * had been open, so the only way to restore anything is to have been watching
 * while the work was happening.
 *
 * It is deliberately dull: poll, verify, write, repeat. Any failure is logged
 * and swallowed, because a recorder that crashes is a recorder that silently
 * stops protecting you.
 */

import fs from 'node:fs';
import { readLiveSessions } from '../core/registry.js';
import { writeSnapshot, readSnapshot } from '../core/snapshot.js';
import { clearRestoreTasks } from '../restore/tasks.js';
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
      startedAt: session.startedAt ?? null,
      lastSeen: Date.now(),
    }));
  const ordered = sortByOpenOrder(sessions);
  writeSnapshot(ordered);
  sweepFinishedRestores();
  return ordered;
}

/**
 * Oldest first, so chats come back in the order you opened them rather than in
 * whatever order readdir happened to return the registry files. VSCode does not
 * expose tab order, and opening order is the closest honest proxy for it. Ties
 * and missing timestamps fall back to the name so the result is never arbitrary.
 */
export function sortByOpenOrder(sessions) {
  return [...sessions].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)
    || String(a.name ?? '').localeCompare(String(b.name ?? '')));
}

/**
 * Remove generated tasks once their restore has completed.
 *
 * The tasks are written to a project's .vscode/tasks.json and stay there, so
 * simply opening that folder weeks later resurrects whatever was open at the
 * time. Once a workspace has nothing left to restore, the tasks have done their
 * job and are litter. Only labels we generated are touched.
 */
export function sweepFinishedRestores() {
  const snapshot = readSnapshot();
  if (!snapshot) return [];

  const cleared = [];
  for (const [root, entry] of Object.entries(snapshot.workspaces ?? {})) {
    // A dark folder still has an offer outstanding, so its tasks may yet be
    // needed. Only sweep once something is running there again.
    if (!entry.sessions?.length && entry.lastLiveSet?.length) continue;
    try {
      const { removed } = clearRestoreTasks(root);
      if (removed > 0) {
        cleared.push({ root, removed });
        log(`cleared ${removed} finished restore task(s) in ${root}`);
      }
    } catch {
      // A folder that has moved or is unwritable is not worth failing a poll for.
    }
  }
  return cleared;
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
