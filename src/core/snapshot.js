/**
 * The durable record of what was open.
 *
 * Claude Code deletes ~/.claude/sessions/<pid>.json when a session ends, so
 * after a shutdown nothing on the machine remembers what had been running. This
 * store is the answer: the recorder keeps rewriting it while work happens, and
 * it is the only thing left to read at boot.
 *
 * Writes are atomic (temp file plus rename) because the failure mode being
 * defended against is literally the machine losing power mid write.
 */

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILE, isInsidePath, canBeWorkspaceRoot } from './paths.js';

const SCHEMA_VERSION = 1;

export function readSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw?.schemaVersion !== SCHEMA_VERSION) return null;
    if (!Array.isArray(raw.sessions)) return null;
    return raw;
  } catch {
    // Missing or corrupt. Callers must treat this as "nothing to restore",
    // never as an error worth blocking on.
    return null;
  }
}

/**
 * Write a poll result.
 *
 * There is a race at shutdown worth defending against: the claude processes can
 * die before the recorder's last poll, in which case a naive recorder writes
 * "0 sessions" over a perfectly good restore set and everything is lost. So the
 * last non-empty observation is retained alongside the current one, and restore
 * falls back to it when the final poll came up empty.
 *
 * @param {Array<object>} sessions live sessions as seen by the recorder
 */
export function writeSnapshot(sessions) {
  const previous = readSnapshot();
  const now = Date.now();

  const lastNonEmpty = sessions.length > 0
    ? { capturedAt: now, sessions }
    : previous?.lastNonEmpty ?? null;

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    capturedAt: now,
    sessions,
    lastNonEmpty,
  };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = path.join(STATE_DIR, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, STATE_FILE);
  return payload;
}

/** How stale a last-non-empty observation may be and still count as "was open". */
const SHUTDOWN_GRACE_MS = 10 * 60 * 1000;

/**
 * What restore should actually offer.
 *
 * Prefers the final poll. Falls back to the last non-empty observation when the
 * final poll was empty but recent, which is the shutdown race described above.
 * If everything was closed long before shutdown, nothing is offered, because
 * that was a deliberate cleanup rather than a crash.
 *
 * @returns {{sessions:Array<object>, capturedAt:number|null, source:'current'|'pre-shutdown'|'none'}}
 */
export function restorableSessions(snapshot = readSnapshot(), graceMs = SHUTDOWN_GRACE_MS) {
  if (!snapshot) return { sessions: [], capturedAt: null, source: 'none' };
  if (snapshot.sessions.length > 0) {
    return { sessions: snapshot.sessions, capturedAt: snapshot.capturedAt, source: 'current' };
  }
  const fallback = snapshot.lastNonEmpty;
  if (fallback && snapshot.capturedAt - fallback.capturedAt <= graceMs) {
    return { sessions: fallback.sessions, capturedAt: fallback.capturedAt, source: 'pre-shutdown' };
  }
  return { sessions: [], capturedAt: snapshot.capturedAt, source: 'none' };
}

/**
 * Sessions grouped by cwd, which is the unit a VSCode window restores.
 * @returns {Array<{cwd:string, sessions:Array<object>}>}
 */
export function groupByCwd(sessions) {
  const byCwd = new Map();
  for (const session of sessions) {
    if (!session.cwd) continue;
    if (!byCwd.has(session.cwd)) byCwd.set(session.cwd, []);
    byCwd.get(session.cwd).push(session);
  }
  return [...byCwd.entries()].map(([cwd, group]) => ({ cwd, sessions: group }));
}

/**
 * Group sessions by the folder you would actually open in VSCode.
 *
 * Grouping by exact cwd looks right in a list but restores badly: a chat started
 * in Projects/reader would open its own VSCode window, separate from the
 * Projects window you work in. Nested cwds are therefore folded into the
 * shallowest cwd that also has sessions, and each task carries its own cwd so
 * the terminals still start in the right subfolder.
 *
 * @returns {Array<{root:string, sessions:Array<object>}>}
 */
export function groupByWorkspace(sessions) {
  const roots = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))]
    .sort((a, b) => a.length - b.length);

  const rootFor = new Map();
  for (const cwd of roots) {
    rootFor.set(cwd, roots.find(
      (candidate) => canBeWorkspaceRoot(candidate) && isInsidePath(cwd, candidate),
    ) ?? cwd);
  }

  const grouped = new Map();
  for (const session of sessions) {
    if (!session.cwd) continue;
    const root = rootFor.get(session.cwd) ?? session.cwd;
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(session);
  }
  // `cwd` is kept as an alias so callers that group by folder need no change.
  return [...grouped.entries()].map(([root, group]) => ({ root, cwd: root, sessions: group }));
}
