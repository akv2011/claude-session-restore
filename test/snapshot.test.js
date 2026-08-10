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
  assert.equal(snap.schemaVersion, 2);
  assert.ok(snap.workspaces, 'memory is kept per workspace');
});

test('the live set is what restore offers while everything is running', () => {
  writeSnapshot(nine);
  const { sessions, source } = restorableSessions();
  assert.equal(sessions.length, 9);
  assert.equal(source, 'current');
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

  const live = workspaces.find((w) => w.root === '/w/other');
  assert.equal(live.source, 'current');
});

test('a reopened workspace goes back to current with its new chats', () => {
  writeSnapshot([{ sessionId: 'x', cwd: '/w/p', name: 'Old' }]);
  writeSnapshot([]);
  assert.equal(restorableWorkspaces()[0].source, 'closed');

  writeSnapshot([{ sessionId: 'y', cwd: '/w/p', name: 'New' }]);
  const [w] = restorableWorkspaces();
  assert.equal(w.source, 'current');
  assert.equal(w.sessions[0].name, 'New', 'stale chats must not linger');
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
  assert.equal(snap.schemaVersion, 2);
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
