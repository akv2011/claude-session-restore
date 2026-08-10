/**
 * Name resolution: customTitle > aiTitle > first prompt > id, last write wins.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveName, readTitles, readFirstPrompt } from '../src/core/names.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-names-'));
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

const userLine = (text) => ({ type: 'user', cwd: '/tmp/x', message: { role: 'user', content: text } });

test('a custom title beats an AI title', () => {
  const file = writeTranscript([
    userLine('hello'),
    { type: 'ai-title', aiTitle: 'Some generated summary' },
    { type: 'custom-title', customTitle: 'Session_restore' },
  ]);
  assert.deepEqual(resolveName(file, SID), { name: 'Session_restore', source: 'custom' });
});

test('an AI title is used when there is no custom one', () => {
  const file = writeTranscript([userLine('hi'), { type: 'ai-title', aiTitle: 'Fixing the parser' }]);
  assert.deepEqual(resolveName(file, SID), { name: 'Fixing the parser', source: 'ai' });
});

test('the LAST title wins, because names are mutable mid-session', () => {
  // Names can change mid-session, so the last write must win.
  const file = writeTranscript([
    { type: 'custom-title', customTitle: 'Refactor_auth' },
    userLine('carry on'),
    { type: 'custom-title', customTitle: 'Api_client' },
  ]);
  assert.equal(readTitles(file).customTitle, 'Api_client');
  assert.equal(resolveName(file, SID).name, 'Api_client');
});

test('an untitled session falls back to the first real prompt', () => {
  const file = writeTranscript([userLine('write me a web scraper for the catalog')]);
  const { name, source } = resolveName(file, SID);
  assert.equal(source, 'prompt');
  assert.equal(name, 'write me a web scraper for the catalog');
});

test('harness noise is skipped when picking a fallback prompt', () => {
  const file = writeTranscript([
    userLine('<system-reminder>ignore me</system-reminder>'),
    userLine('the actual question'),
  ]);
  assert.equal(readFirstPrompt(file), 'the actual question');
});

test('long prompts are truncated rather than blowing out the sidebar', () => {
  const file = writeTranscript([userLine('x'.repeat(500))]);
  const { name } = resolveName(file, SID);
  assert.ok(name.length <= 64, `got ${name.length} chars`);
  assert.ok(name.endsWith('...'));
});

test('structured content blocks are understood, not just plain strings', () => {
  const file = writeTranscript([
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'block form prompt' }] } },
  ]);
  assert.equal(readFirstPrompt(file), 'block form prompt');
});

test('a session with nothing usable degrades to a short id, never a crash', () => {
  const file = writeTranscript([{ type: 'system', subtype: 'noise' }]);
  assert.deepEqual(resolveName(file, SID), { name: '(unnamed aaaaaaaa)', source: 'id' });
});

test('a corrupt or truncated transcript does not throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csr-names-'));
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, '{"type":"user","message":{"content":"ok"}}\n{"type":"ai-tit');
  assert.doesNotThrow(() => resolveName(file, SID));
});

test('a missing file resolves to the id fallback instead of throwing', () => {
  assert.equal(resolveName('/nope/does-not-exist.jsonl', SID).source, 'id');
});
