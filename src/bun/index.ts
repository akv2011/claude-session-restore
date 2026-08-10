/**
 * Main process.
 *
 * Deliberately thin. Every request below forwards straight into src/core, which
 * is plain Node-compatible ESM with zero dependencies, so the same logic backs
 * the CLI and would back a different window framework unchanged.
 */

// defineRPC is a static on BrowserView, not BrowserWindow.
import { BrowserWindow, BrowserView } from 'electrobun/bun';
import {
  getOverview, previewDelete, performDelete, restoreProject, clearProject,
  openInVscode, recorder, enableAutoTasks,
} from '../core/api.js';

const rpc = BrowserView.defineRPC({
  handlers: {
    requests: {
      overview: () => getOverview(),

      previewDelete: ({ sessionId, projectDir }) => previewDelete({ sessionId, projectDir }),

      confirmDelete: ({ sessionId, projectDir }) => {
        try {
          return { ok: true, result: performDelete({ sessionId, projectDir }) };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      restore: async ({ groups, launch }) => {
        const written: Array<Record<string, unknown>> = [];
        for (const group of groups) {
          try {
            written.push({ cwd: group.cwd, ...restoreProject(group.cwd, group.sessions, { launch }) });
          } catch (err) {
            written.push({ cwd: group.cwd, error: (err as Error).message });
          }
        }
        return written;
      },

      clearTasks: ({ cwd }) => clearProject(cwd),

      enableAutoTasks: () => {
        try {
          return { ok: true, result: enableAutoTasks() };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      openProject: ({ cwd }) => openInVscode(cwd),

      recorderInstall: () => {
        try {
          recorder.install();
          return { ok: true, status: recorder.status() };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      },

      recorderUninstall: () => {
        recorder.uninstall();
        return { ok: true, status: recorder.status() };
      },
    },
    messages: {},
  },
});

new BrowserWindow({
  title: 'Claude Session Restore',
  url: 'views://mainview/index.html',
  frame: { x: 120, y: 100, width: 1080, height: 720 },
  rpc,
});
