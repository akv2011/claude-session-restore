/**
 * Enabling VSCode's automatic tasks, in the only place VSCode reads it.
 *
 * VSCode's schema marks task.allowAutomaticTasks as scope 1 (APPLICATION), the
 * same scope as update.mode, and application-scoped settings are read from USER
 * settings only. A copy in a project's .vscode/settings.json is ignored
 * silently, so tasks get written and then never run.
 *
 * User settings.json is JSONC and hand-maintained, so it is patched textually
 * rather than parsed and rewritten. Losing someone's comments to flip a setting
 * would be a poor trade.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const KEY = 'task.allowAutomaticTasks';

/**
 * Where task terminals appear. VSCode has no per-task option for this
 * (microsoft/vscode#212070 is still open), so it is one global setting:
 *   "view"   the bottom terminal panel
 *   "editor" the editor area, as tabs
 * With it unset, VSCode restores whatever layout each terminal last had, which
 * is how a single restore ends up split across both places.
 */
export const LOCATION_KEY = 'terminal.integrated.defaultLocation';

export function userSettingsPath() {
  return path.join(
    os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json',
  );
}

/**
 * Blank out comments so a value can be read from JSONC without a full parser.
 * Scanned rather than regexed, because a "//" inside a string value (a URL, a
 * path) must not be mistaken for the start of a comment.
 */
function stripComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }

    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * @returns {{enabled:boolean, present:boolean, value:string|null, file:string,
 *            readable:boolean}}
 */
export function readAutoTaskSetting() {
  const file = userSettingsPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { enabled: false, present: false, value: null, file, readable: false };
  }
  const match = stripComments(raw).match(
    new RegExp(`"${KEY.replace('.', '\\.')}"\\s*:\\s*"(on|off)"`),
  );
  return {
    enabled: match?.[1] === 'on',
    present: Boolean(match),
    value: match?.[1] ?? null,
    file,
    readable: true,
  };
}

/**
 * Turn automatic tasks on in user settings, preserving comments and formatting.
 * Backs the file up first. Returns what it did.
 */
export function enableAutoTasks() {
  const file = userSettingsPath();
  const current = readAutoTaskSetting();
  if (current.enabled) return { changed: false, reason: 'already on', file };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{\n  "${KEY}": "on"\n}\n`, 'utf8');
    return { changed: true, reason: 'created settings.json', file, backup: null };
  }

  const backup = `${file}.csr-backup`;
  fs.writeFileSync(backup, raw, 'utf8');

  let next;
  if (current.present) {
    // Flip the existing value in place, touching nothing else.
    next = raw.replace(
      new RegExp(`("${KEY.replace('.', '\\.')}"\\s*:\\s*")off(")`),
      '$1on$2',
    );
    if (next === raw) return { changed: false, reason: 'could not patch value', file, backup };
  } else {
    // Insert right after the opening brace so surrounding formatting survives.
    const brace = raw.indexOf('{');
    if (brace < 0) return { changed: false, reason: 'settings.json has no object', file, backup };
    next = `${raw.slice(0, brace + 1)}\n  "${KEY}": "on",${raw.slice(brace + 1)}`;
  }

  fs.writeFileSync(file, next, 'utf8');
  return { changed: true, reason: current.present ? 'flipped off to on' : 'inserted', file, backup };
}

/** Read any string setting out of user settings.json. */
export function readUserSetting(key) {
  const file = userSettingsPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { value: null, present: false, file, readable: false };
  }
  const match = stripComments(raw).match(
    new RegExp(`"${key.replace(/\./g, '\\.')}"\\s*:\\s*"([^"]*)"`),
  );
  return { value: match?.[1] ?? null, present: Boolean(match), file, readable: true };
}

/**
 * Set a string setting in user settings.json, preserving comments and layout.
 * Backs the file up first, same as enableAutoTasks.
 */
export function setUserSetting(key, value) {
  const file = userSettingsPath();
  const current = readUserSetting(key);
  if (current.value === value) return { changed: false, reason: 'already set', file };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `{\n  "${key}": "${value}"\n}\n`, 'utf8');
    return { changed: true, reason: 'created settings.json', file, backup: null };
  }

  const backup = `${file}.csr-backup`;
  fs.writeFileSync(backup, raw, 'utf8');

  let next;
  if (current.present) {
    next = raw.replace(
      new RegExp(`("${key.replace(/\./g, '\\.')}"\\s*:\\s*")[^"]*(")`),
      `$1${value}$2`,
    );
    if (next === raw) return { changed: false, reason: 'could not patch value', file, backup };
  } else {
    const brace = raw.indexOf('{');
    if (brace < 0) return { changed: false, reason: 'settings.json has no object', file, backup };
    next = `${raw.slice(0, brace + 1)}\n  "${key}": "${value}",${raw.slice(brace + 1)}`;
  }

  fs.writeFileSync(file, next, 'utf8');
  return { changed: true, reason: current.present ? 'replaced' : 'inserted', file, backup };
}

/** @param {'view'|'editor'} location */
export function setTerminalLocation(location) {
  if (!['view', 'editor'].includes(location)) {
    throw new Error(`location must be "view" or "editor", got "${location}"`);
  }
  return setUserSetting(LOCATION_KEY, location);
}

export function readTerminalLocation() {
  const s = readUserSetting(LOCATION_KEY);
  return { ...s, value: s.value ?? null, effective: s.value ?? 'unset (VSCode restores per-terminal)' };
}
