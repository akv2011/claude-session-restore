/**
 * The single surface both the CLI and the GUI call.
 *
 * Keeping this here rather than in the GUI is what makes the window swappable:
 * nothing below this line knows whether it is being driven by Electrobun,
 * Electron, or a terminal.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
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

/** Everything the sidebar needs, in one call. */
export function getOverview() {
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
      source: restorable.source,
      capturedAt: restorable.capturedAt,
      // Each group carries its own source, so a project you closed an hour ago
      // is offered and labelled rather than silently dropped.
      groups: restorableWorkspaces(snapshot),
      count: restorable.sessions.length,
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

/** Fire and forget: `code <folder>`. Failure here is reported, never fatal. */
export function openInVscode(cwd) {
  return new Promise((resolve) => {
    execFile('code', [cwd], (err) => resolve(err ? { ok: false, error: err.message } : { ok: true }));
  });
}

export const recorder = launchd;

/** VSCode will not auto-run restored terminals unless this is on. */
export { readAutoTaskSetting, enableAutoTasks, readPersistentSessions, setPersistentSessions };
