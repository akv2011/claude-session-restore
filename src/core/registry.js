/**
 * Read the live session registry Claude Code maintains.
 *
 * Every running `claude` process writes ~/.claude/sessions/<pid>.json, keyed by
 * PID. Claude removes these on exit, so this is a snapshot of NOW and nothing
 * else. That is why the recorder exists.
 *
 * Not every entry is a chat: the daemon pre-warms background workers that
 * register themselves too. Only kind "interactive" is a terminal a human used.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_DIR } from './paths.js';
import { verifyLiveness } from './liveness.js';

/**
 * @returns {Array<object>} raw registry entries, unverified
 */
export function readRegistry() {
  let files;
  try {
    files = fs.readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }

  const entries = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const pidFromName = Number(path.basename(file, '.json'));
    if (!Number.isInteger(pidFromName) || pidFromName <= 0) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8'));
      // Trust the filename over the body: the filename is what the OS keyed it by.
      entries.push({ ...raw, pid: pidFromName });
    } catch {
      // Half-written or corrupt registry file. Skip it.
    }
  }
  return entries;
}

/**
 * Registry entries that are genuinely running, PID-recycle checked.
 *
 * Not everything in the registry is a chat. The Claude daemon pre-warms
 * background spare workers that register themselves too:
 *
 *   { "kind": "bg", "jobId": "397dd761", "name": "Widget_ui", "status": "idle" }
 *   -> claude bg-spare --bg-spare /tmp/cc-daemon-501/.../93d2b0d1.claim.sock
 *
 * Such a worker has no transcript because it never held a conversation, and
 * `claude --resume` on it is meaningless, so counting it as a chat inflates the
 * running count and would poison a restore.
 *
 * @param {{interactiveOnly?:boolean}} [options] pass false when you need every
 *   live session regardless of kind, e.g. to protect one from deletion.
 */
export function readLiveSessions(options = {}) {
  const { interactiveOnly = true } = options;
  const raw = readRegistry();
  const liveness = verifyLiveness(raw);

  const live = [];
  for (const entry of raw) {
    const verdict = liveness.get(entry.pid);
    if (!verdict?.alive) continue;
    if (interactiveOnly && entry.kind !== 'interactive') continue;
    live.push({
      pid: entry.pid,
      sessionId: entry.sessionId ?? null,
      cwd: entry.cwd ?? null,
      name: entry.name ?? null,
      status: entry.status ?? null,
      version: entry.version ?? null,
      kind: entry.kind ?? null,
      startedAt: entry.startedAt ?? null,
      verifiedReason: verdict.reason,
    });
  }
  return live;
}

/**
 * Session ids that must not be deleted because something is using them.
 * Deliberately includes background agents: a bg session is not a chat, but its
 * data is still in use and must not be pulled out from under it.
 */
export function liveSessionIds() {
  return new Set(
    readLiveSessions({ interactiveOnly: false }).map((s) => s.sessionId).filter(Boolean),
  );
}
