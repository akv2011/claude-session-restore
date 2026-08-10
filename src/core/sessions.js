/**
 * Enumerate every chat that has ever existed, grouped by project.
 *
 * Two things worth knowing about the on-disk layout:
 *
 * 1. `find ~/.claude/projects -name '*.jsonl'` reports 1008 files on this
 *    machine but only 235 are sessions. The rest are subagent transcripts nested
 *    at <project>/<sessionId>/subagents/*.jsonl. Only top level files count.
 *
 * 2. The project directory name cannot be turned back into a path (see
 *    paths.js). The real cwd is read out of the transcript body instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PROJECTS_DIR, isSessionId, encodeCwd } from './paths.js';
import { readHead, parseLines } from './jsonl.js';
import { resolveName } from './names.js';
import { readLiveSessions } from './registry.js';

/** Authoritative working directory for a session, read from its transcript. */
export function readCwd(file) {
  const entries = parseLines(readHead(file, 64 * 1024), 'head');
  for (const entry of entries) {
    if (typeof entry.cwd === 'string' && entry.cwd) return entry.cwd;
  }
  return null;
}

/** Bytes used by a session's subagent transcripts, 0 if it has none. */
function dirSize(dir) {
  let total = 0;
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of names) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    } catch {
      // Vanished mid-scan. Ignore.
    }
  }
  return total;
}

/**
 * Scan the whole store.
 *
 * @param {{resolveNames?:boolean}} [options] names require reading each file, so
 *   callers that only need counts can turn it off.
 * @returns {{projects:Array, sessions:Array, skipped:number}}
 */
export function scanSessions(options = {}) {
  const { resolveNames = true } = options;
  const live = readLiveSessions();
  const liveBySessionId = new Map(live.map((s) => [s.sessionId, s]));

  let projectDirs;
  try {
    projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return { projects: [], sessions: [], skipped: 0 };
  }

  const sessions = [];
  let skipped = 0;

  for (const projectDir of projectDirs) {
    const dir = path.join(PROJECTS_DIR, projectDir);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped += 1;
      continue;
    }

    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionId = entry.name.slice(0, -'.jsonl'.length);
      if (!isSessionId(sessionId)) continue;

      const file = path.join(dir, entry.name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        skipped += 1;
        continue;
      }

      const subagents = dirSize(path.join(dir, sessionId));
      const liveEntry = liveBySessionId.get(sessionId);

      // A live session's registry name is fresher than the transcript's.
      let name = liveEntry?.name ?? null;
      let nameSource = name ? 'registry' : null;
      if (!name && resolveNames) {
        const resolved = resolveName(file, sessionId);
        name = resolved.name;
        nameSource = resolved.source;
      }

      sessions.push({
        sessionId,
        projectDir,
        file,
        cwd: liveEntry?.cwd ?? readCwd(file),
        name,
        nameSource,
        bytes: stat.size,
        subagentBytes: subagents,
        modifiedAt: stat.mtimeMs,
        live: Boolean(liveEntry),
        pid: liveEntry?.pid ?? null,
        status: liveEntry?.status ?? null,
      });
    }
  }

  // A live session does not always have a transcript on disk yet. Observed with
  // session 397dd761 ("Widget_ui"), which was running with no .jsonl file at
  // all. Scanning transcripts alone would make it invisible in the sidebar and,
  // worse, silently drop it from a restore. Union the registry back in.
  const seen = new Set(sessions.map((s) => s.sessionId));
  for (const entry of live) {
    if (!entry.sessionId || seen.has(entry.sessionId)) continue;
    sessions.push({
      sessionId: entry.sessionId,
      projectDir: entry.cwd ? encodeCwd(entry.cwd) : null,
      file: null,
      cwd: entry.cwd,
      name: entry.name ?? `(unnamed ${entry.sessionId.slice(0, 8)})`,
      nameSource: entry.name ? 'registry' : 'id',
      bytes: 0,
      subagentBytes: 0,
      modifiedAt: entry.startedAt ?? Date.now(),
      live: true,
      pid: entry.pid,
      status: entry.status ?? null,
      transcriptMissing: true,
    });
  }

  // A transcript whose head holds no `cwd` would otherwise surface as a raw
  // encoded directory name in the sidebar. Siblings in the same directory almost
  // always resolved, and the encoding is deterministic, so borrow theirs.
  const cwdByDir = new Map();
  for (const session of sessions) {
    if (session.cwd && !cwdByDir.has(session.projectDir)) {
      cwdByDir.set(session.projectDir, session.cwd);
    }
  }
  for (const session of sessions) {
    if (!session.cwd) session.cwd = cwdByDir.get(session.projectDir) ?? null;
  }

  sessions.sort((a, b) => b.modifiedAt - a.modifiedAt);

  // Group by real cwd where known, falling back to the encoded directory name.
  const byProject = new Map();
  for (const session of sessions) {
    const key = session.cwd ?? session.projectDir;
    if (!byProject.has(key)) {
      byProject.set(key, {
        cwd: session.cwd,
        projectDir: session.projectDir,
        label: key,
        sessions: [],
        bytes: 0,
        liveCount: 0,
      });
    }
    const project = byProject.get(key);
    project.sessions.push(session);
    project.bytes += session.bytes + session.subagentBytes;
    if (session.live) project.liveCount += 1;
  }

  const projects = [...byProject.values()].sort((a, b) => {
    if (b.liveCount !== a.liveCount) return b.liveCount - a.liveCount;
    return b.sessions[0].modifiedAt - a.sessions[0].modifiedAt;
  });

  return { projects, sessions, skipped };
}
