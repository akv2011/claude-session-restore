/**
 * The single surface both the CLI and the GUI call.
 *
 * Keeping this here rather than in the GUI is what makes the window swappable:
 * nothing below this line knows whether it is being driven by Electrobun,
 * Electron, or a terminal.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { withoutClaudeMarkers } from './paths.js';
import { scanSessions } from './sessions.js';
import { readLiveSessions } from './registry.js';
import { planDelete, deleteSession } from './deleter.js';
import { readSnapshot, restorableSessions, restorableWorkspaces } from './snapshot.js';
import { writeRestoreTasks, clearRestoreTasks } from '../restore/tasks.js';
import {
  readAutoTaskSetting, enableAutoTasks,
  readPersistentSessions, setPersistentSessions,
} from '../restore/vscode-settings.js';
import * as launchd from '../recorder/launchd.js';
import { pollOnce } from '../recorder/daemon.js';

/**
 * Everything the sidebar needs, in one call.
 *
 * Takes a reading first. Otherwise the newest a caller can see is the last
 * recorder tick, so closing a chat and looking straight away showed nothing for
 * up to 30 seconds and the window looked broken. A poll is cheap and
 * idempotent: it reads a handful of small files and rewrites one.
 *
 * @param {{poll?:boolean}} [options] pass false to read the stored state as-is.
 */
export function getOverview(options = {}) {
  if (options.poll !== false) {
    try {
      pollOnce();
    } catch {
      // A failed poll must not stop the window rendering what it already knows.
    }
  }
  const { projects, sessions, skipped } = scanSessions();
  const snapshot = readSnapshot();
  const restorable = restorableSessions(snapshot);

  return {
    projects: projects.map((project) => ({
      label: project.label,
      cwd: project.cwd,
      projectDir: project.projectDir,
      bytes: project.bytes,
      liveCount: project.liveCount,
      sessionCount: project.sessions.length,
      sessions: project.sessions,
      // Inclusive of subfolders, which is the unit a VSCode window restores.
      depth: project.depth,
      parent: project.parent,
      allSessions: project.allSessions,
      allBytes: project.allBytes,
      allLiveCount: project.allLiveCount,
    })),
    totals: {
      projects: projects.length,
      sessions: sessions.length,
      bytes: sessions.reduce((sum, s) => sum + s.bytes + s.subagentBytes, 0),
      live: sessions.filter((s) => s.live).length,
      skipped,
    },
    restore: {
      // Exactly what the recorder saw live at the poll before those chats went.
      // No transcript sweep: a window over recently-used files offered eleven
      // chats across five folders, which is not what was open.
      groups: restorableWorkspaces(snapshot),
      count: restorableSessions(snapshot).sessions.length,
      capturedAt: restorableSessions(snapshot).capturedAt,
      source: restorableSessions(snapshot).source,
    },
    recorder: launchd.status(),
    autoTasks: readAutoTaskSetting(),
    persistence: readPersistentSessions(),
  };
}


export function getLive() {
  return readLiveSessions();
}

/** What a delete would remove. Never mutates. */
export function previewDelete(session) {
  return planDelete(session);
}

export function performDelete(session) {
  return deleteSession(session);
}

/**
 * Write restore tasks for one folder and optionally open it in VSCode.
 *
 * @param {string} cwd
 * @param {Array<{sessionId:string,name:string}>} sessions
 * @param {{launch?:boolean, staggerSeconds?:number}} [options]
 */
export function restoreProject(cwd, sessions, options = {}) {
  if (!fs.existsSync(cwd)) {
    throw new Error(`that folder no longer exists: ${cwd}`);
  }
  const written = writeRestoreTasks(cwd, sessions, options);
  if (options.launch !== false) openInVscode(cwd);
  return written;
}

export function clearProject(cwd) {
  return clearRestoreTasks(cwd);
}

/**
 * Fire and forget: `code <folder>`. Failure here is reported, never fatal.
 *
 * Launched with the Claude session markers stripped. VSCode passes its own
 * environment to every terminal it opens, so inheriting them turned each chat in
 * that window into a child session with transcript saving off, including ones
 * opened by hand long afterwards.
 */
export function openInVscode(cwd) {
  return new Promise((resolve) => {
    execFile('code', [cwd], { env: withoutClaudeMarkers() },
      (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
  });
}

export const recorder = launchd;

/** VSCode will not auto-run restored terminals unless this is on. */
export { readAutoTaskSetting, enableAutoTasks, readPersistentSessions, setPersistentSessions };
