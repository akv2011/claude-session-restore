/**
 * Every filesystem location this tool touches.
 *
 * One important asymmetry lives here: encoding a cwd into a project directory
 * name is easy, but decoding it back is impossible. Claude Code replaces "/"
 * with "-", and it also replaces "_" with "-", so
 *
 *   /Users/you/Code/my_project  ->  -Users-you-Code-my-project
 *
 * is indistinguishable from a path that really did contain those dashes. Never
 * try to reverse it. Read the authoritative `cwd` out of the transcript instead
 * (see sessions.js readCwd).
 */

import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');

export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
export const SESSION_ENV_DIR = path.join(CLAUDE_DIR, 'session-env');
export const IDE_DIR = path.join(CLAUDE_DIR, 'ide');
export const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');

/** Our own durable store. Claude never touches this. */
export const STATE_DIR = path.join(HOME, '.claude-restore');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const LOG_FILE = path.join(STATE_DIR, 'recorder.log');

/** Lossy on purpose. Use for lookup only, never to recover a path. */
export function encodeCwd(cwd) {
  return cwd.replace(/[/_]/g, '-');
}

/** Transcript path for a session inside an already known project directory. */
export function transcriptPath(projectDir, sessionId) {
  return path.join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`);
}

/** Sibling directory holding this session's subagent transcripts. */
export function subagentDir(projectDir, sessionId) {
  return path.join(PROJECTS_DIR, projectDir, sessionId);
}

export function sessionEnvDir(sessionId) {
  return path.join(SESSION_ENV_DIR, sessionId);
}

/**
 * Guard against a bug or a crafted id deleting something outside ~/.claude.
 * Returns true only if `target` really sits under `~/.claude`.
 */
export function isInsideClaudeDir(target) {
  const rel = path.relative(CLAUDE_DIR, path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSessionId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}
