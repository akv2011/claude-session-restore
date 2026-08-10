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
 * Memory is per workspace rather than one global snapshot, so closing one
 * project while others keep running does not lose it.
 *
 * The rule is deliberately simple: while anything is running in a folder there
 * is nothing to restore, and once the folder goes dark the set that was live at
 * the previous poll is what comes back. Earlier attempts held individual chats
 * across partial closes, which meant chats you had moved on from kept being
 * offered for days.
 */

import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, STATE_FILE, isInsidePath, canBeWorkspaceRoot } from './paths.js';
import { readRunningSessionIds } from './registry.js';

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
        // These chats were remembered because they had gone, so they are the
        // set to bring back once the folder is dark.
        workspaces[group.root] = {
          lastSeen: raw.lastNonEmpty?.capturedAt ?? raw.capturedAt,
          sessions: [],
          lastLiveSet: group.sessions,
          darkSince: raw.lastNonEmpty?.capturedAt ?? raw.capturedAt,
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

    if (live.length) {
      // Working here. The live set is what would be lost if the folder went
      // dark, so it becomes the candidate, replacing whatever came before.
      workspaces[root] = { lastSeen: now, sessions: live, lastLiveSet: live };
    } else {
      // Gone dark. Freeze whatever was live at the previous poll; that is the
      // set to bring back, and it must not be touched while the folder is empty.
      workspaces[root] = {
        lastSeen: prior?.lastSeen ?? now,
        sessions: [],
        lastLiveSet: prior?.lastLiveSet ?? [],
        darkSince: prior?.darkSince ?? now,
      };
    }
  }

  for (const [root, entry] of Object.entries(workspaces)) {
    const when = entry.darkSince ?? entry.lastSeen ?? 0;
    if (!entry.sessions.length && now - when > RETAIN_MS) delete workspaces[root];
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
 *                  lastSeen:number|null, source:'closed'}>} only workspaces with
 *   something to bring back are returned.
 */
export function restorableWorkspaces(snapshot = readSnapshot(), retainMs = RETAIN_MS,
  runningIds = readRunningSessionIds()) {
  if (!snapshot) return [];
  const now = snapshot.capturedAt ?? Date.now();

  return Object.entries(snapshot.workspaces ?? {})
    // Anything running here means you are working, not recovering.
    .filter(([, entry]) => !entry.sessions?.length)
    .map(([root, entry]) => ({
      root,
      cwd: root,
      // Never offer a chat that is provably running. The registry sometimes
      // lacks a file for a live session, and without this cross-check restore
      // offered it and would have started a second copy.
      sessions: (entry.lastLiveSet ?? []).filter((x) => !runningIds.has(x.sessionId)),
      lastSeen: entry.darkSince ?? entry.lastSeen ?? null,
      source: 'closed',
    }))
    .filter((w) => w.sessions.length && now - (w.lastSeen ?? 0) <= retainMs)
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
