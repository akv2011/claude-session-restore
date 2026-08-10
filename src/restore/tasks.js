/**
 * Restore terminals without a VSCode extension.
 *
 * VSCode natively runs tasks when a folder opens, via
 * runOptions.runOn = "folderOpen", and gives each task its own terminal panel.
 * So restoring is just writing a tasks.json: open the folder and VSCode itself
 * spawns the terminals and resumes every chat. No extension, no AppleScript, no
 * driving the UI from outside.
 *
 * Two gates decide whether those tasks ever run, and both fail silently:
 *
 *   1. "task.allowAutomaticTasks" must be "on" in USER settings. VSCode marks it
 *      scope 1 (APPLICATION), like update.mode, so a workspace copy is read by
 *      nobody. See restore/vscode-settings.js.
 *   2. The folder must be trusted. RunAutomaticTasks returns before it inspects
 *      the setting when isWorkspaceTrusted() is false.
 *
 * Starts are staggered with a leading sleep so a dozen terminals do not launch
 * in the same instant.
 */

import fs from 'node:fs';
import path from 'node:path';
import { readAutoTaskSetting } from './vscode-settings.js';

const TASK_PREFIX = 'claude: ';
const DEFAULT_STAGGER_SECONDS = 3;

/** Shell-quote for the single-quoted context we build commands in. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {Array<{sessionId:string, name:string}>} sessions
 * @param {{staggerSeconds?:number, claudePath?:string}} [options]
 */
export function buildTasks(sessions, options = {}) {
  const stagger = options.staggerSeconds ?? DEFAULT_STAGGER_SECONDS;
  const claude = options.claudePath ?? 'claude';

  return sessions.map((session, index) => {
    const delay = index * stagger;
    const resume = `${claude} --resume ${shellQuote(session.sessionId)}`;
    return {
      label: `${TASK_PREFIX}${session.name ?? session.sessionId.slice(0, 8)}`,
      type: 'shell',
      command: delay > 0 ? `sleep ${delay}; ${resume}` : resume,
      runOptions: { runOn: 'folderOpen' },
      presentation: {
        panel: 'dedicated',
        group: 'claude',
        reveal: 'always',
        focus: false,
        echo: false,
      },
      problemMatcher: [],
    };
  });
}

/**
 * Merge our tasks into an existing tasks.json.
 *
 * Anything the user wrote themselves is preserved. Only tasks we previously
 * generated (label starts with "claude: ") are replaced, so repeated restores
 * do not accumulate duplicates.
 */
export function mergeTasks(existing, generated) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  const previous = Array.isArray(base.tasks) ? base.tasks : [];
  const userTasks = previous.filter(
    (task) => typeof task?.label !== 'string' || !task.label.startsWith(TASK_PREFIX),
  );
  return { ...base, version: base.version ?? '2.0.0', tasks: [...userTasks, ...generated] };
}

function readJsonIfPresent(file) {
  try {
    // tasks.json permits comments. Strip the common cases before parsing.
    const raw = fs.readFileSync(file, 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write .vscode/tasks.json for one project folder.
 *
 * @param {string} cwd project folder
 * @param {Array<{sessionId:string, name:string}>} sessions
 * @param {{staggerSeconds?:number, claudePath?:string}} [options]
 */
export function writeRestoreTasks(cwd, sessions, options = {}) {
  const vscodeDir = path.join(cwd, '.vscode');
  fs.mkdirSync(vscodeDir, { recursive: true });

  const tasksFile = path.join(vscodeDir, 'tasks.json');
  const merged = mergeTasks(readJsonIfPresent(tasksFile), buildTasks(sessions, options));
  fs.writeFileSync(tasksFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

  // Deliberately does NOT write task.allowAutomaticTasks here. That setting is
  // application-scoped, so a workspace copy is inert, and writing it produced a
  // convincing-looking file that changed nothing.
  return {
    tasksFile,
    taskCount: merged.tasks.length,
    autoTasks: readAutoTaskSetting(),
  };
}

/** Remove only our generated tasks, leaving the user's own intact. */
export function clearRestoreTasks(cwd) {
  const tasksFile = path.join(cwd, '.vscode', 'tasks.json');
  const existing = readJsonIfPresent(tasksFile);
  if (!existing) return { tasksFile, removed: 0 };

  const previous = Array.isArray(existing.tasks) ? existing.tasks : [];
  const kept = previous.filter(
    (task) => typeof task?.label !== 'string' || !task.label.startsWith(TASK_PREFIX),
  );
  const removed = previous.length - kept.length;
  if (removed > 0) {
    fs.writeFileSync(
      tasksFile,
      `${JSON.stringify({ ...existing, tasks: kept }, null, 2)}\n`,
      'utf8',
    );
  }
  return { tasksFile, removed };
}
