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

test('a different chat does not count as restoring the one you closed', () => {
  writeSnapshot([{ sessionId: 'x', cwd: '/w/p', name: 'Old' }]);
  writeSnapshot([]);
  const closed = restorableWorkspaces().find((w) => w.root === '/w/p');
  assert.equal(closed.source, 'closed');

  // Starting some other chat in the same folder is not the chat you lost, so
  // the hold stays and Old is still on offer.
  writeSnapshot([{ sessionId: 'y', cwd: '/w/p', name: 'New' }]);
  const held = restorableWorkspaces().find((w) => w.root === '/w/p');
  assert.equal(held.source, 'closed');
  assert.deepEqual(held.sessions.map((s) => s.name), ['Old']);

  // Bringing Old back releases it from the hold. New has now gone, so it takes
  // its place: anything that disappears is restorable.
  writeSnapshot([{ sessionId: 'x', cwd: '/w/p', name: 'Old' }]);
  const after = restorableWorkspaces().find((w) => w.root === '/w/p');
  assert.deepEqual(after.sessions.map((s) => s.name), ['New']);
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

test('the restore point survives opening chats by hand', () => {
  // The rule: what was tracked while alive is the candidate, and it is not
  // overwritten until those chats are actually running again. Without it,
  // opening one chat after closing a window discarded the rest.
  const eight = Array.from({ length: 8 }, (_, i) => ({
    sessionId: `h${i}`, cwd: '/w/hold', name: `Chat_${i}`,
  }));
  const offers = () => restorableWorkspaces().find((w) => w.root === '/w/hold');

  writeSnapshot(eight);
  assert.equal(offers(), undefined, 'nothing to restore while they all run');

  writeSnapshot([]);
  assert.equal(offers().sessions.length, 8, 'a freshly closed window must offer everything');
  assert.equal(offers().source, 'closed');

  writeSnapshot([eight[0]]);
  assert.equal(offers().sessions.length, 7, 'opening one by hand must not discard the other seven');

  writeSnapshot(eight.slice(0, 5));
  assert.equal(offers().sessions.length, 3, 'only what is still missing is offered');

  writeSnapshot(eight);
  assert.equal(offers(), undefined, 'fully restored means nothing left to restore');
});

test('after the hold is released, normal tracking resumes', () => {
  const three = Array.from({ length: 3 }, (_, i) => ({
    sessionId: `r${i}`, cwd: '/w/resume', name: `C${i}`,
  }));
  const offers = () => restorableWorkspaces().find((w) => w.root === '/w/resume');

  writeSnapshot(three);
  writeSnapshot([]);
  writeSnapshot(three);                 // fully restored, hold released
  writeSnapshot(three.slice(0, 2));     // you close one deliberately
  // Restore cannot tell "finished with it" from "lost it", and being unable to
  // bring a chat back is the worse failure, so a closed chat is offered. The
  // banner is dismissible, and the offer expires after RETAIN_MS.
  assert.deepEqual(offers().sessions.map((s) => s.name), ['C2']);
});

test('a restored chat is never offered twice', () => {
  const two = [
    { sessionId: 'd1', cwd: '/w/dupe', name: 'A' },
    { sessionId: 'd2', cwd: '/w/dupe', name: 'B' },
  ];
  writeSnapshot(two);
  writeSnapshot([]);
  writeSnapshot([two[0]]);
  const offered = restorableWorkspaces().find((w) => w.root === '/w/dupe').sessions;
  assert.deepEqual(offered.map((s) => s.sessionId), ['d2'], 'the running chat must not be re-offered');
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

test('only the chats that are gone are offered after a partial restore', () => {
  const two = [
    { sessionId: 'p1', cwd: '/w/part', name: 'A' },
    { sessionId: 'p2', cwd: '/w/part', name: 'B' },
  ];
  writeSnapshot(two);
  writeSnapshot([]);
  writeSnapshot([two[0]]);      // A is back, B is not
  const offered = restorableWorkspaces().find((w) => w.root === '/w/part');
  assert.deepEqual(offered.sessions.map((s) => s.sessionId), ['p2']);
});

test('closing some chats is remembered even while others keep running', () => {
  // The workspace never empties here, so waiting for emptiness captured nothing.
  const four = Array.from({ length: 4 }, (_, i) => ({
    sessionId: `v${i}`, cwd: '/w/vanish', name: `C${i}`,
  }));
  const offers = () => restorableWorkspaces().find((w) => w.root === '/w/vanish');

  writeSnapshot(four);
  assert.equal(offers(), undefined, 'nothing gone yet');

  writeSnapshot([four[0]]);           // you close three, one stays open
  assert.deepEqual(offers().sessions.map((s) => s.name).sort(), ['C1', 'C2', 'C3']);
});

test('a later close is captured even when a restore point already exists', () => {
  // This lost real chats: with a hold in place the capture was skipped, so a
  // shutdown left the stale hold on offer and dropped what was actually open.
  const offers = () => restorableWorkspaces().find((w) => w.root === '/w/later');
  const a = { sessionId: 'l1', cwd: '/w/later', name: 'Old' };
  const b = { sessionId: 'l2', cwd: '/w/later', name: 'New' };

  writeSnapshot([a]);
  writeSnapshot([]);                  // Old closes, hold = [Old]
  assert.deepEqual(offers().sessions.map((s) => s.name), ['Old']);

  writeSnapshot([b]);                 // you work on something else
  writeSnapshot([]);                  // and close that too
  assert.deepEqual(offers().sessions.map((s) => s.name).sort(), ['New', 'Old'],
    'the newly closed chat must join the hold, not be dropped');
});

test('a chat that comes back leaves the hold', () => {
  const offers = () => restorableWorkspaces().find((w) => w.root === '/w/back');
  const one = { sessionId: 'b1', cwd: '/w/back', name: 'A' };
  const two = { sessionId: 'b2', cwd: '/w/back', name: 'B' };

  writeSnapshot([one, two]);
  writeSnapshot([]);
  assert.equal(offers().sessions.length, 2);

  writeSnapshot([one]);
  assert.deepEqual(offers().sessions.map((s) => s.name), ['B']);

  writeSnapshot([one, two]);
  assert.equal(offers(), undefined, 'everything back means nothing to restore');
});
