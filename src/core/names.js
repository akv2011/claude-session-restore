/**
 * Resolve the name a chat is actually known by.
 *
 * Names live inside the transcript, not the live registry, which is why a dead
 * session can still be named:
 *
 *   {"type":"custom-title","customTitle":"Refactor_auth"}
 *   {"type":"ai-title","aiTitle":"Fixing the parser"}
 *
 * Both are rewritten repeatedly and names are mutable mid-session, so the LAST
 * occurrence wins.
 */

import { readHead, readTail, parseLines } from './jsonl.js';

/** How far back to look for a title before giving up and widening the window. */
const TAIL_WINDOWS = [256 * 1024, 2 * 1024 * 1024];

const MAX_PROMPT_CHARS = 60;

/**
 * @param {string} file transcript path
 * @returns {{customTitle:string|null, aiTitle:string|null}}
 */
export function readTitles(file) {
  let customTitle = null;
  let aiTitle = null;

  for (const window of TAIL_WINDOWS) {
    const entries = parseLines(readTail(file, window), 'tail');
    for (const entry of entries) {
      if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle;
      else if (entry.type === 'ai-title' && entry.aiTitle) aiTitle = entry.aiTitle;
    }
    if (customTitle || aiTitle) break;
  }
  return { customTitle, aiTitle };
}

/** First thing the user typed, used only when a session has no title at all. */
export function readFirstPrompt(file) {
  const entries = parseLines(readHead(file, 256 * 1024), 'head');
  for (const entry of entries) {
    if (entry.type !== 'user') continue;
    const content = entry.message?.content;
    let text = null;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      const block = content.find((c) => c?.type === 'text' && typeof c.text === 'string');
      if (block) text = block.text;
    }
    if (!text) continue;
    // Skip harness noise so the fallback shows something the user recognises.
    if (text.startsWith('<')) continue;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    return clean.length > MAX_PROMPT_CHARS ? `${clean.slice(0, MAX_PROMPT_CHARS)}...` : clean;
  }
  return null;
}

/**
 * The display name, in precedence order.
 *
 * @param {string} file transcript path
 * @param {string} sessionId used for the last resort label
 * @returns {{name:string, source:'custom'|'ai'|'prompt'|'id'}}
 */
export function resolveName(file, sessionId) {
  const { customTitle, aiTitle } = readTitles(file);
  if (customTitle) return { name: customTitle, source: 'custom' };
  if (aiTitle) return { name: aiTitle, source: 'ai' };

  const prompt = readFirstPrompt(file);
  if (prompt) return { name: prompt, source: 'prompt' };

  return { name: `(unnamed ${String(sessionId).slice(0, 8)})`, source: 'id' };
}
