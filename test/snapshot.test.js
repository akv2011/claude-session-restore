/**
 * The shutdown race.
 *
 * At shutdown the claude processes can die before the recorder's final poll. A
 * naive recorder then writes "0 sessions" over a good restore set and
 * everything is lost. These tests pin the fallback that prevents that, and
 * equally pin that a deliberate cleanup is NOT resurrected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-snap-'));
process.env.HOME = fakeHome;

const {
  writeSnapshot, readSnapshot, restorableSessions, restorableWorkspaces, groupByCwd,
} = await import('../src/core/snapshot.js');

const nine = Array.from({ length: 9 }, (_, i) => ({
  sessionId: `0000000${i}-1111-2222-3333-444444444444`,
  cwd: '/Users/you/Projects',
  name: `Chat_${i}`,
}));

test('a snapshot round-trips', () => {
  writeSnapshot(nine);
  const snap = readSnapshot();
  assert.equal(snap.sessions.length, 9);
  assert.equal(snap.schemaVersion, 3);
  assert.ok(snap.workspaces, 'memory is kept per workspace');
});

test('nothing is offered while every chat is still running', () => {
  writeSnapshot(nine);
  const { sessions, source } = restorableSessions();
  assert.equal(sessions.length, 0, 'restore brings back what is gone, not what is running');
  assert.equal(source, 'none');
});

test('a final empty poll at shutdown does NOT lose the restore set', () => {
  writeSnapshot(nine);
  writeSnapshot([]); // processes died first, recorder polled once more
  const { sessions, source } = restorableSessions();
  assert.equal(sessions.length, 9, 'shutdown race wiped the restore set');
  assert.equal(source, 'mixed', 'every workspace is now closed, not current');
});

test('a workspace closed long enough ago stops being offered', () => {
  writeSnapshot(nine);
  writeSnapshot([]);
  const stale = readSnapshot();
  // Well past the retention window, so this is no longer work in progress.
  const lastSeen = Math.max(...Object.values(stale.workspaces).map((w) => w.lastSeen));
  stale.capturedAt = lastSeen + 72 * 60 * 60 * 1000;
  const { sessions, source } = restorableSessions(stale);
  assert.equal(sessions.length, 0, 'a long-abandoned workspace must not be restored');
  assert.equal(source, 'none');
});

test('closing ONE project keeps its chats while others keep running', () => {
  const projects = [
    { sessionId: 'a1', cwd: '/w/projects', name: 'A' },
    { sessionId: 'a2', cwd: '/w/projects', name: 'B' },
  ];
  const other = [{ sessionId: 'b1', cwd: '/w/other', name: 'C' }];

  writeSnapshot([...projects, ...other]);
  // The projects window is closed; the other project is still open. A single
  // global fallback never fired here, so those two chats were lost outright.
  writeSnapshot(other);

  const workspaces = restorableWorkspaces();
  const closed = workspaces.find((w) => w.root === '/w/projects');
  assert.ok(closed, 'the closed project must still be offered');
  assert.equal(closed.sessions.length, 2);
  assert.equal(closed.source, 'closed');

  // The still-running project is not offered: there is nothing to bring back.
  assert.equal(workspaces.find((w) => w.root === '/w/other'), undefined);
});


test('a v1 snapshot is migrated rather than discarded', () => {
  const dir = path.join(fakeHome, '.claude-restore');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    capturedAt: Date.now(),
    sessions: [],
    lastNonEmpty: { capturedAt: Date.now(), sessions: nine },
  }));
  const snap = readSnapshot();
  assert.ok(snap, 'a v1 file must not be thrown away');
  assert.equal(snap.schemaVersion, 3);
  assert.equal(restorableSessions(snap).sessions.length, 9);
});

test('no snapshot at all means nothing to restore, never an error', () => {
  fs.rmSync(path.join(fakeHome, '.claude-restore'), { recursive: true, force: true });
  assert.equal(readSnapshot(), null);
  const { sessions, source } = restorableSessions();
  assert.deepEqual(sessions, []);
  assert.equal(source, 'none');
});

test('a corrupt snapshot degrades to nothing rather than throwing', () => {
  const dir = path.join(fakeHome, '.claude-restore');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), '{ this is not json');
  assert.equal(readSnapshot(), null);
  assert.doesNotThrow(() => restorableSessions());
});

test('a snapshot from a future schema is ignored rather than misread', () => {
  const dir = path.join(fakeHome, '.claude-restore');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ schemaVersion: 99, sessions: nine }));
  assert.equal(readSnapshot(), null);
});

test('sessions group by cwd, which is the unit a window restores', () => {
  const mixed = [
    { sessionId: 'a', cwd: '/one', name: 'A' },
    { sessionId: 'b', cwd: '/two', name: 'B' },
    { sessionId: 'c', cwd: '/one', name: 'C' },
    { sessionId: 'd', cwd: null, name: 'D' },
  ];
  const groups = groupByCwd(mixed);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((g) => g.cwd === '/one').sessions.length, 2);
});

test('nested folders restore into one window, not one window each', async () => {
  const { groupByWorkspace } = await import('../src/core/snapshot.js');
  const mixed = [
    { sessionId: 'a', cwd: '/Users/you/Projects', name: 'A' },
    { sessionId: 'b', cwd: '/Users/you/Projects/reader', name: 'B' },
    { sessionId: 'c', cwd: '/Users/you/Projects/reader/deep', name: 'C' },
    { sessionId: 'd', cwd: '/Users/you/Other', name: 'D' },
  ];
  const groups = groupByWorkspace(mixed);
  assert.equal(groups.length, 2, 'subfolders must fold into their parent');

  const projects = groups.find((g) => g.root === '/Users/you/Projects');
  assert.equal(projects.sessions.length, 3);
  assert.ok(groups.some((g) => g.root === '/Users/you/Other'));
});

test('a sibling folder with a shared prefix is not swallowed', async () => {
  const { groupByWorkspace } = await import('../src/core/snapshot.js');
  // "/a/project" must not capture "/a/project-two": containment is on a boundary.
  const groups = await groupByWorkspace([
    { sessionId: 'a', cwd: '/a/project', name: 'A' },
    { sessionId: 'b', cwd: '/a/project-two', name: 'B' },
  ]);
  assert.equal(groups.length, 2, 'prefix match must respect path boundaries');
});

test('sessions without a cwd are dropped rather than grouped under undefined', async () => {
  const { groupByWorkspace } = await import('../src/core/snapshot.js');
  const groups = groupByWorkspace([
    { sessionId: 'a', cwd: '/a', name: 'A' },
    { sessionId: 'b', cwd: null, name: 'B' },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sessions.length, 1);
});

test('a chat run in the home directory does not swallow every project', async () => {
  const { groupByWorkspace } = await import('../src/core/snapshot.js');
  const home = process.env.HOME;
  const groups = groupByWorkspace([
    { sessionId: 'a', cwd: home, name: 'Loose' },
    { sessionId: 'b', cwd: `${home}/Projects`, name: 'Real' },
    { sessionId: 'c', cwd: `${home}/Other`, name: 'Also real' },
  ]);
  // Home contains everything, so without a guard one stray chat would collapse
  // the whole machine into a single restore window.
  assert.equal(groups.length, 3, 'home must not act as a workspace root');
});




test('the VSCode extension panel is not a terminal chat', async () => {
  const { isTerminalSession } = await import('../src/core/registry.js');
  // Same kind as a real terminal chat, different entrypoint. Restoring it would
  // run claude --resume in a terminal for a chat that lives in the sidebar.
  assert.equal(isTerminalSession({ kind: 'interactive', entrypoint: 'claude-vscode' }), false);
  assert.equal(isTerminalSession({ kind: 'interactive', entrypoint: 'cli' }), true);
  assert.equal(isTerminalSession({ kind: 'bg', entrypoint: 'cli' }), false);
  // Older versions did not record an entrypoint; those must not be dropped.
  assert.equal(isTerminalSession({ kind: 'interactive' }), true);
});

test('a chat that is already running is never offered for restore', () => {
  // Offering live chats meant clicking restore launched a second process for
  // the same session id, and two processes then wrote one transcript.
  const live = [
    { sessionId: 'live1', cwd: '/w/dup', name: 'A' },
    { sessionId: 'live2', cwd: '/w/dup', name: 'B' },
  ];
  writeSnapshot(live);
  const offered = restorableWorkspaces().find((w) => w.root === '/w/dup');
  assert.equal(offered, undefined, 'a fully running workspace has nothing to restore');
  // Scoped to this workspace: earlier tests leave other workspaces behind.
  const mine = restorableSessions().sessions.filter((s) => s.cwd === '/w/dup');
  assert.equal(mine.length, 0);
});





test('reading the overview takes a fresh reading, so a closed chat shows at once', async () => {
  // paths.js resolves HOME once at import, so this reuses the fixture home
  // rather than pointing at a new one, which would silently do nothing.
  const api = await import('../src/core/api.js');
  fs.rmSync(path.join(fakeHome, '.claude-restore'), { recursive: true, force: true });
  assert.equal(readSnapshot(), null, 'nothing stored to begin with');

  api.getOverview();
  assert.ok(readSnapshot(), 'the overview must record a reading itself');

  fs.rmSync(path.join(fakeHome, '.claude-restore'), { recursive: true, force: true });
  api.getOverview({ poll: false });
  assert.equal(readSnapshot(), null, 'poll:false must leave the store untouched');
});

test('THE RULE: anything running means nothing to restore', () => {
  const four = ['A', 'B', 'C', 'D'].map((n) => ({ sessionId: n, cwd: '/w/rule', name: n }));
  const offered = () => {
    const w = restorableWorkspaces().find((x) => x.root === '/w/rule');
    return w ? w.sessions.map((x) => x.name) : [];
  };

  writeSnapshot(four);
  assert.deepEqual(offered(), [], 'working, so nothing to bring back');

  writeSnapshot([]);
  assert.deepEqual(offered(), ['A', 'B', 'C', 'D'], 'dark, so offer what was live');

  // Opening one by hand means you are working again, not recovering.
  writeSnapshot([four[0]]);
  assert.deepEqual(offered(), [], 'anything running suppresses the offer');

  // ...and the candidate is now just that one, since it is what would be lost.
  writeSnapshot([]);
  assert.deepEqual(offered(), ['A'], 'only what was live at the last poll');
});

test('a dark folder keeps its offer frozen across polls', () => {
  const two = ['P', 'Q'].map((n) => ({ sessionId: n, cwd: '/w/freeze', name: n }));
  writeSnapshot(two);
  writeSnapshot([]);
  writeSnapshot([]);
  writeSnapshot([]);
  const w = restorableWorkspaces().find((x) => x.root === '/w/freeze');
  assert.deepEqual(w.sessions.map((x) => x.name), ['P', 'Q'], 'repeated empty polls must not erode it');
});

test('a folder dark for longer than the retention window is dropped', () => {
  writeSnapshot([{ sessionId: 'old', cwd: '/w/ancient', name: 'Old' }]);
  writeSnapshot([]);
  const snap = readSnapshot();
  snap.capturedAt = snap.workspaces['/w/ancient'].darkSince + 72 * 60 * 60 * 1000;
  assert.equal(restorableWorkspaces(snap).find((w) => w.root === '/w/ancient'), undefined);
});

test('chats are ordered oldest first, so they come back as you opened them', async () => {
  const { sortByOpenOrder } = await import('../src/recorder/daemon.js');
  // Deliberately jumbled, the way readdir returns registry files.
  const jumbled = [
    { sessionId: 'c', name: 'Third', startedAt: 3000 },
    { sessionId: 'a', name: 'First', startedAt: 1000 },
    { sessionId: 'b', name: 'Second', startedAt: 2000 },
  ];
  assert.deepEqual(sortByOpenOrder(jumbled).map((s) => s.name), ['First', 'Second', 'Third']);
  assert.deepEqual(jumbled.map((s) => s.name), ['Third', 'First', 'Second'], 'must not mutate');
});

test('sessions with no timestamp fall back to name rather than arbitrary order', async () => {
  const { sortByOpenOrder } = await import('../src/recorder/daemon.js');
  assert.deepEqual(
    sortByOpenOrder([{ name: 'Zeta' }, { name: 'Alpha' }]).map((s) => s.name),
    ['Alpha', 'Zeta'],
  );
});

test('the offer and the generated tasks keep that order', async () => {
  const { buildTasks } = await import('../src/restore/tasks.js');
  const ordered = ['First', 'Second', 'Third'].map((name, i) => ({
    sessionId: `ord${i}`, cwd: '/w/ordered', name, startedAt: (i + 1) * 1000,
  }));
  writeSnapshot(ordered);
  writeSnapshot([]);

  const offered = restorableWorkspaces().find((w) => w.root === '/w/ordered');
  assert.deepEqual(offered.sessions.map((s) => s.name), ['First', 'Second', 'Third']);

  const tasks = buildTasks(offered.sessions, { workspaceRoot: '/w/ordered' });
  assert.deepEqual(tasks.map((t) => t.label),
    ['claude: First', 'claude: Second', 'claude: Third']);
  // The stagger must follow the same order, so they appear in sequence.
  assert.ok(!tasks[0].command.startsWith('sleep'));
  assert.match(tasks[1].command, /^sleep 3;/);
  assert.match(tasks[2].command, /^sleep 6;/);
});

test('a chat running with no registry file is still never offered', async () => {
  // The registry is not always complete: a live session was observed with no
  // ~/.claude/sessions/<pid>.json, so the app believed it was closed and offered
  // to restore it, which would have started a second copy.
  const chats = [
    { sessionId: 'aaaaaaaa-1111-2222-3333-444444444444', cwd: '/w/ghost', name: 'Ghost' },
    { sessionId: 'bbbbbbbb-1111-2222-3333-444444444444', cwd: '/w/ghost', name: 'Really gone' },
  ];
  writeSnapshot(chats);
  writeSnapshot([]);   // the registry says both are gone

  // ...but a process scan proves the first one is running.
  const running = new Set(['aaaaaaaa-1111-2222-3333-444444444444']);
  const offered = restorableWorkspaces(readSnapshot(), undefined, running)
    .find((w) => w.root === '/w/ghost');

  assert.deepEqual(offered.sessions.map((s) => s.name), ['Really gone'],
    'a provably running chat must be excluded even when the registry omits it');
});

test('the process scan finds a resumed session id', async () => {
  const { readRunningSessionIds } = await import('../src/core/registry.js');
  const ids = readRunningSessionIds();
  assert.ok(ids instanceof Set, 'must always return a set, never throw');
});

test('a running chat missing from the registry still shows as live', async () => {
  // The same registry gap that made restore offer a running chat also made the
  // list show it as closed. Both read liveness, so both need the cross-check.
  const src = fs.readFileSync(new URL('../src/core/sessions.js', import.meta.url), 'utf8');
  assert.match(src, /readRunningSessionIds/, 'the scan must feed the session list');
  assert.match(src, /live: Boolean\(liveEntry\) \|\| runningIds\.has\(sessionId\)/,
    'liveness must consider the process scan, not only the registry');
});
