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
 *
 * Memory is per workspace rather than one global snapshot. A single global
 * fallback only rescued the case where everything died at once; closing one
 * project while others kept running dropped that project's chats silently.
 */

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILE, isInsidePath, canBeWorkspaceRoot } from './paths.js';

const SCHEMA_VERSION = 3;

export function readSnapshot() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!Array.isArray(raw.sessions)) return null;

    // v1 kept a single global lastNonEmpty, which only helped when everything
    // died at once. Closing one project while others kept running dropped that
    // project's chats entirely. Fold whatever v1 remembered into the per
    // workspace map rather than discarding a user's only restore set.
    if (raw.schemaVersion === 1) {
      const workspaces = {};
      for (const group of groupByWorkspace(raw.lastNonEmpty?.sessions ?? [])) {
        workspaces[group.root] = {
          lastSeen: raw.lastNonEmpty?.capturedAt ?? raw.capturedAt,
          sessions: group.sessions,
        };
      }
      return { ...raw, schemaVersion: SCHEMA_VERSION, workspaces };
    }
    // v2 had per-workspace memory but overwrote it on every poll, so opening a
    // single chat after closing a window shrank the restore set to that one.
    // Nothing to convert: the first v3 poll captures a restore point on the
    // next alive -> empty transition.
    if (raw.schemaVersion === 2) return { ...raw, schemaVersion: SCHEMA_VERSION };
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    if (!raw.workspaces || typeof raw.workspaces !== 'object') return null;
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
 * @param {Array<object>} sessions live sessions as seen by the recorder
 */
export function writeSnapshot(sessions) {
  const previous = readSnapshot();
  const now = Date.now();

  const liveByRoot = new Map(groupByWorkspace(sessions).map((g) => [g.root, g.sessions]));
  const workspaces = { ...(previous?.workspaces ?? {}) };
  const roots = new Set([...Object.keys(workspaces), ...liveByRoot.keys()]);

  for (const root of roots) {
    const prior = workspaces[root];
    const live = liveByRoot.get(root) ?? [];
    const held = prior?.restorePoint ?? null;

    if (live.length === 0) {
      // Alive to empty: this is the moment worth remembering. Capture it once,
      // and do not touch it again while the workspace stays empty.
      if (prior && !held && prior.sessions?.length) {
        // sessions must be emptied here too. Leaving the old list behind made
        // every held chat look like it was already running, so a freshly closed
        // window offered nothing at all.
        workspaces[root] = {
          ...prior,
          sessions: [],
          restorePoint: { sessions: prior.sessions, closedAt: now },
        };
      }
      continue;
    }

    // A held restore point is released only once every chat in it is running
    // again. Without this the live set overwrites it, so opening one chat by
    // hand after closing a window silently discards the rest.
    const liveIds = new Set(live.map((session) => session.sessionId));
    const satisfied = !held || held.sessions.every((session) => liveIds.has(session.sessionId));

    workspaces[root] = {
      lastSeen: now,
      sessions: live,
      ...(satisfied ? {} : { restorePoint: held }),
    };
  }

  for (const [root, entry] of Object.entries(workspaces)) {
    const when = entry.restorePoint?.closedAt ?? entry.lastSeen ?? 0;
    if (now - when > RETAIN_MS) delete workspaces[root];
  }

  const payload = { schemaVersion: SCHEMA_VERSION, capturedAt: now, sessions, workspaces };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = path.join(STATE_DIR, `.state.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, STATE_FILE);
  return payload;
}

/** How long a closed workspace stays offered for restore. */
const RETAIN_MS = 48 * 60 * 60 * 1000;

/**
 * What restore should offer, per workspace.
 *
 * A workspace whose chats are running is reported as 'current'. One whose chats
 * have gone is reported as 'closed' and stays on offer until RETAIN_MS passes,
 * which is what lets you reopen a project you shut a couple of hours ago.
 *
 * @returns {Array<{root:string, cwd:string, sessions:Array<object>,
 *                  lastSeen:number|null, source:'current'|'closed'}>}
 */
export function restorableWorkspaces(snapshot = readSnapshot(), retainMs = RETAIN_MS) {
  if (!snapshot) return [];
  const now = snapshot.capturedAt ?? Date.now();

  return Object.entries(snapshot.workspaces ?? {})
    .map(([root, entry]) => {
      const held = entry.restorePoint;
      const liveIds = new Set((entry.sessions ?? []).map((s) => s.sessionId));

      if (held) {
        // Offer only what is not already back, so restoring twice cannot
        // duplicate a chat that is already running.
        const missing = held.sessions.filter((s) => !liveIds.has(s.sessionId));
        return {
          root,
          cwd: root,
          sessions: missing,
          lastSeen: held.closedAt ?? entry.lastSeen ?? null,
          source: missing.length === held.sessions.length ? 'closed' : 'partial',
        };
      }
      return {
        root,
        cwd: root,
        sessions: entry.sessions ?? [],
        lastSeen: entry.lastSeen ?? null,
        source: 'current',
      };
    })
    .filter((w) => w.sessions.length
      && (w.source === 'current' || now - (w.lastSeen ?? 0) <= retainMs))
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
}

/**
 * Flattened view, kept because callers that just want "what would come back"
 * should not have to care how it is remembered.
 */
export function restorableSessions(snapshot = readSnapshot(), retainMs = RETAIN_MS) {
  const workspaces = restorableWorkspaces(snapshot, retainMs);
  const sessions = workspaces.flatMap((w) => w.sessions);
  const capturedAt = workspaces.length
    ? Math.max(...workspaces.map((w) => w.lastSeen ?? 0))
    : (snapshot?.capturedAt ?? null);
  const source = workspaces.length === 0
    ? 'none'
    : (workspaces.every((w) => w.source === 'current') ? 'current' : 'mixed');
  return { sessions, capturedAt, source };
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
