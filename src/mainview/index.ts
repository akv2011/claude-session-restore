/**
 * Renderer.
 *
 * Holds no knowledge of the filesystem. Every fact on screen arrives over RPC
 * from the main process, which in turn is a thin pass-through to src/core.
 */

import { Electroview } from 'electrobun/view';

const electroview = new Electroview({
  rpc: Electroview.defineRPC({
    handlers: { requests: {}, messages: {} },
  }),
});

const call = (name: string, payload: unknown = {}) =>
  (electroview.rpc as any).request[name](payload);

const $ = (id: string) => document.getElementById(id)!;

type Session = {
  sessionId: string; projectDir: string | null; name: string; nameSource: string;
  bytes: number; subagentBytes: number; modifiedAt: number;
  live: boolean; pid: number | null; status: string | null; transcriptMissing?: boolean;
};
type Project = {
  label: string; cwd: string | null; projectDir: string;
  bytes: number; liveCount: number; sessionCount: number; sessions: Session[];
  depth: number; parent: string | null;
  allSessions: Session[]; allBytes: number; allLiveCount: number;
};

let state: { projects: Project[]; totals: any; restore: any; recorder: any } | null = null;
let selected: string | null = null;
/** Dismissals are per scope: '*' for all chats, otherwise the project cwd. */
const dismissed = new Set<string>();

/* ---------- formatting ---------- */

const mb = (bytes: number) => {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
};

const ago = (ts: number | null) => {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
};

const shortPath = (p: string | null) => (p ?? '').replace(/^\/Users\/[^/]+\//, '~/');

/**
 * A project label that stays readable when the rail is narrow: the folder name
 * at full strength, its immediate parent dimmed in front of it.
 */
function projectLabel(fullPath: string) {
  const segments = shortPath(fullPath).split('/').filter(Boolean);
  const base = segments.pop() ?? fullPath;
  const parent = segments.pop();
  return parent
    ? `<span class="proj-parent">${escapeHtml(parent)}/</span>${escapeHtml(base)}`
    : escapeHtml(base);
}

const SOURCE_LABEL: Record<string, string> = {
  registry: 'live', custom: 'yours', ai: 'auto', prompt: 'prompt', id: 'none',
};

/* ---------- toast ---------- */

let toastTimer: number | undefined;
function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = false;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 4200);
}

/* ---------- render ---------- */

function renderRecorder() {
  const el = $('recorder');
  const label = $('recorder-label');
  const action = $('recorder-action') as HTMLButtonElement;
  const running = state?.recorder?.armed;

  el.dataset.state = running ? 'armed' : 'off';
  label.textContent = running ? 'recorder armed' : 'recorder off';
  action.hidden = Boolean(running);
}

function renderRail() {
  const list = $('rail-list');
  list.innerHTML = '';

  const all = document.createElement('button');
  all.className = 'proj';
  all.setAttribute('aria-current', String(selected === null));
  all.innerHTML = `<span class="proj-name">All chats</span>
    <span class="proj-sub"><span>${state!.totals.sessions} chats</span><span>${mb(state!.totals.bytes)}</span></span>`;
  all.onclick = () => { selected = null; renderRail(); renderRestoreBanner(); renderPanel(); };
  list.appendChild(all);

  for (const project of state!.projects) {
    const button = document.createElement('button');
    button.className = 'proj';
    button.setAttribute('aria-current', String(selected === project.label));
    button.title = project.label;
    // Counts are inclusive of subfolders so the rail agrees with what a restore
    // would actually put in one window.
    const live = project.allLiveCount
      ? `<span class="live-pip">${project.allLiveCount}</span>` : '';
    const nested = project.depth > 0;
    button.style.paddingLeft = `${8 + project.depth * 14}px`;
    if (nested) button.classList.add('proj-nested');
    button.innerHTML = `<span class="proj-name">${
      nested ? escapeHtml(project.label.split('/').pop() ?? project.label) : projectLabel(project.label)
    }</span>
      <span class="proj-sub"><span>${project.allSessions.length}</span><span>${mb(project.allBytes)}</span>${live}</span>`;
    button.onclick = () => { selected = project.label; renderRail(); renderRestoreBanner(); renderPanel(); };
    list.appendChild(button);
  }

  $('project-count').textContent = String(state!.projects.length);
  $('rail-foot').innerHTML =
    `${state!.totals.sessions} chats · ${mb(state!.totals.bytes)}<br>${state!.totals.live} running now`;
}

function renderRestoreBanner() {
  const host = $('restore-banner');
  host.innerHTML = '';
  const restore = state!.restore;
  if (dismissed.has(selected ?? '*') || !restore.count) return;

  // Scope the offer to what you are actually looking at. A global banner while
  // Documents/Work is selected offers to restore Desktop/Projects, which
  // reads as a bug even though it would have done the right thing.
  const allGroups = restore.groups as Array<{ cwd: string; sessions: Session[] }>;
  const groups = selected === null
    ? allGroups
    : allGroups.filter((g) => g.cwd === selected);
  if (!groups.length) return;

  const count = groups.reduce((sum, g) => sum + g.sessions.length, 0);
  const scoped = selected !== null;

  const when = restore.capturedAt
    ? new Date(restore.capturedAt).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })
    : 'unknown time';

  const names = groups.flatMap((g) => g.sessions.map((s) => s.name));
  const where = scoped
    ? escapeHtml(shortPath(selected))
    : `${groups.length} folder${groups.length === 1 ? '' : 's'}`;

  const banner = document.createElement('div');
  banner.className = 'restore';
  banner.innerHTML = `
    <div class="restore-body">
      <div class="restore-title">${count} chat${count === 1 ? '' : 's'} ${restore.source === 'pre-shutdown' ? 'open at shutdown' : 'open now'} · ${where}</div>
      <div class="restore-sub">${when} · ${restore.source === 'pre-shutdown' ? 'captured just before shutdown' : 'currently running'}</div>
      <div class="restore-list">${escapeHtml(names.slice(0, 6).join(' · '))}${names.length > 6 ? ` · +${names.length - 6} more` : ''}</div>
    </div>
    <button class="btn btn-primary" id="do-restore">${scoped ? `Restore these ${count}` : 'Restore all'}</button>
    <button class="btn btn-ghost" id="dismiss-restore">Dismiss</button>`;
  host.appendChild(banner);

  // Writing tasks.json proves nothing: VSCode ignores automatic tasks unless
  // this application-scoped setting is on. Say so before the click, not after.
  if (!state!.autoTasks?.enabled) {
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.innerHTML = `<span class="warn-body"><strong>VSCode will not run the restored terminals.</strong>
      Automatic tasks are off. This setting is application-scoped, so it only counts in your user settings.</span>
      <button class="btn" id="fix-autotasks">Turn on</button>`;
    host.appendChild(warn);
    $('fix-autotasks').onclick = async () => {
      const response = await call('enableAutoTasks');
      toast(response.ok ? 'Automatic tasks enabled. A backup of settings.json was saved.' : response.error,
        response.ok ? 'ok' : 'error');
      await refresh();
    };
  }

  $('do-restore').onclick = async () => {
    const button = $('do-restore') as HTMLButtonElement;
    button.disabled = true;
    button.textContent = 'Restoring...';
    const written = await call('restore', { groups, launch: true });
    const failed = written.filter((w: any) => w.error);
    if (failed.length) {
      toast(`${failed.length} folder(s) failed: ${failed[0].error}`, 'error');
    } else {
      toast(`Wrote restore tasks for ${written.length} folder(s). VSCode will spawn the terminals.`);
      dismissed.add(selected ?? '*');
      renderRestoreBanner();
    }
    button.disabled = false;
    button.textContent = scoped ? `Restore these ${count}` : 'Restore all';
  };
  $('dismiss-restore').onclick = () => { dismissed.add(selected ?? '*'); renderRestoreBanner(); };
}

function visibleSessions(): Session[] {
  // Selecting a folder includes its subfolders. Anything else would disagree
  // with restore, which opens one window for the whole tree.
  if (selected === null) return state!.projects.flatMap((p) => p.sessions);
  return state!.projects.find((p) => p.label === selected)?.allSessions ?? [];
}

function renderPanel() {
  const project = selected === null ? null : state!.projects.find((p) => p.label === selected);
  $('panel-title').textContent = project ? shortPath(project.label) : 'All chats';
  ($('panel-title') as HTMLElement).title = project?.label ?? '';

  const sessions = visibleSessions();
  const bytes = sessions.reduce((sum, s) => sum + s.bytes + s.subagentBytes, 0);
  const live = sessions.filter((s) => s.live).length;
  $('panel-meta').textContent = `${sessions.length} chats · ${mb(bytes)}${live ? ` · ${live} running` : ''}`;

  const host = $('rows');
  host.innerHTML = '';

  if (!sessions.length) {
    host.innerHTML = `<div class="empty"><strong>Nothing here</strong>No chats recorded for this project yet.</div>`;
    return;
  }

  sessions.forEach((session, index) => {
    const row = document.createElement('div');
    row.className = `row${session.live ? ' is-live' : ''}${session.status === 'busy' ? ' is-busy' : ''}`;
    // Stagger only the first screenful; beyond that it just delays the paint.
    if (index < 24) row.style.animationDelay = `${index * 14}ms`;

    const size = session.transcriptMissing
      ? '<span class="num faint">no file</span>'
      : `<span class="num">${mb(session.bytes + session.subagentBytes)}</span>`;

    row.innerHTML = `
      <span class="row-name">
        <span class="status-dot"></span>
        <span class="row-label" title="${escapeHtml(session.name)}">${escapeHtml(session.name)}</span>
      </span>
      <span class="tag" data-src="${session.nameSource}">${SOURCE_LABEL[session.nameSource] ?? session.nameSource}</span>
      ${size}
      <span class="num faint">${ago(session.modifiedAt)}</span>
      <button class="row-del" aria-label="Delete ${escapeHtml(session.name)}" title="${session.live ? 'running: close it first' : 'delete'}" ${session.live ? 'disabled' : ''}>&#x2715;</button>`;

    const del = row.querySelector('.row-del') as HTMLButtonElement;
    if (!session.live) del.onclick = () => openSheet(session);
    host.appendChild(row);
  });
}

/* ---------- delete sheet ---------- */

let pending: Session | null = null;

async function openSheet(session: Session) {
  pending = session;
  const plan = await call('previewDelete', {
    sessionId: session.sessionId, projectDir: session.projectDir,
  });

  $('sheet-title').textContent = session.name;
  $('sheet-sub').textContent = session.sessionId;

  const body = $('sheet-body');
  body.innerHTML = '';
  for (const target of plan.targets) {
    const el = document.createElement('div');
    el.className = 'target';
    el.innerHTML = `<div><div class="target-kind">${target.kind}</div>
      <div class="target-path">${escapeHtml(shortPath(target.path))}</div></div>
      <div class="target-size">${mb(target.bytes)}</div>`;
    body.appendChild(el);
  }
  if (plan.historyLines) {
    const el = document.createElement('div');
    el.className = 'target';
    el.innerHTML = `<div><div class="target-kind">prompt history</div>
      <div class="target-path">~/.claude/history.jsonl</div></div>
      <div class="target-size">${plan.historyLines} lines</div>`;
    body.appendChild(el);
  }
  const total = document.createElement('div');
  total.className = 'target total';
  total.innerHTML = `<div class="target-kind">Total reclaimed</div><div class="target-size">${mb(plan.totalBytes)}</div>`;
  body.appendChild(total);

  $('sheet-scrim').hidden = false;
}

function closeSheet() {
  $('sheet-scrim').hidden = true;
  pending = null;
}

/* ---------- boot ---------- */

function escapeHtml(value: string) {
  return String(value).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

async function refresh() {
  state = await call('overview');
  renderRecorder();
  renderRail();
  renderRestoreBanner();
  renderPanel();
}

$('sheet-cancel').onclick = closeSheet;
$('sheet-confirm').onclick = async () => {
  if (!pending) return;
  const button = $('sheet-confirm') as HTMLButtonElement;
  button.disabled = true;
  const response = await call('confirmDelete', {
    sessionId: pending.sessionId, projectDir: pending.projectDir,
  });
  button.disabled = false;
  if (!response.ok) {
    toast(response.error, 'error');
  } else {
    toast(`Moved ${mb(response.result.bytesReclaimed)} to Trash, pruned ${response.result.historyRemoved} history line(s).`);
  }
  closeSheet();
  await refresh();
};

$('recorder-action').onclick = async () => {
  const response = await call('recorderInstall');
  if (response.ok) toast('Recorder armed. It will capture your sessions from now on.');
  else toast(response.error, 'error');
  await refresh();
};

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSheet();
  if (event.key === 'r' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); refresh(); }
});

$('sheet-scrim').addEventListener('click', (event) => {
  if (event.target === $('sheet-scrim')) closeSheet();
});

refresh();
// Keep live status honest without hammering the disk.
setInterval(refresh, 15000);
