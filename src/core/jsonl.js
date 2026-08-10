/**
 * Bounded readers for transcript files.
 *
 * Transcripts reach hundreds of megabytes, so reading whole files just to pull
 * out a name makes the sidebar take minutes. Everything needed sits at one end:
 * cwd and the first prompt near the head, titles near the tail.
 */

import fs from 'node:fs';

/** Read up to `bytes` from the start of a file. */
export function readHead(file, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/** Read up to `bytes` from the end of a file. */
export function readTail(file, bytes = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Split a chunk into parsed JSON objects, dropping the partial line at whichever
 * end the chunk was torn. Unparseable lines are skipped rather than thrown.
 *
 * @param {string} chunk
 * @param {'head'|'tail'} origin which end the chunk came from
 */
export function parseLines(chunk, origin) {
  if (!chunk) return [];
  const lines = chunk.split('\n');
  // A head chunk may be cut mid-line at the end; a tail chunk at the start.
  if (origin === 'head') lines.pop();
  else lines.shift();

  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Truncated or corrupt line. Skipping is always safe here.
    }
  }
  return out;
}
