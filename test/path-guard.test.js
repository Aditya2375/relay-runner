import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardedPath } from '../src/path-guard.js';
import { snapshotFiles, applyEdits } from '../src/ai.js';
import { runAgentLoop } from '../src/loop.js';

test('guard refuses symlink ancestors, protected paths and traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-guard-'));
  const outside = await mkdtemp(join(tmpdir(), 'relay-outside-'));
  await symlink(outside, join(root, 'link'));
  for (const p of ['../escape', 'link/new.txt', '.env', 'nested/.env.local', '.git/config', '.relay/secret', 'private.key', 'service-account.json']) {
    assert.throws(() => guardedPath(root, p), /escape|symlink|protected/);
  }
  assert.equal(guardedPath(root, 'src/new.txt'), join(root, 'src/new.txt'));
  await assert.rejects(applyEdits([{ path: 'link/new.txt', content: 'bad' }], root), /symlink/);
});

test('snapshot excludes credentials, private state and symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-snapshot-'));
  await mkdir(join(root, '.relay'));
  for (const p of ['.env', '.env.local', 'account.pem', '.relay/secret', 'ok.txt']) await writeFile(join(root, p), 'test');
  await symlink(join(root, 'ok.txt'), join(root, 'linked.txt'));
  assert.deepEqual((await snapshotFiles(root)).map(f => f.path), ['ok.txt']);
});

test('agent loop refuses reads and writes through a directory symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-loop-guard-'));
  const outside = await mkdtemp(join(tmpdir(), 'relay-loop-out-'));
  await writeFile(join(outside, 'private.txt'), 'untouched');
  await symlink(outside, join(root, 'link'));
  let step = 0, approvals = 0;
  const events = [];
  const actions = [
    { action: 'read_file', path: 'link/private.txt' },
    { action: 'write_file', path: 'link/private.txt', content: 'changed' },
    { action: 'done', summary: 'finished' }
  ];
  await runAgentLoop({ task: 'test', workspace: root, env: { RELAY_GEMINI_KEY: 'test' },
    completeImpl: async () => JSON.stringify(actions[step++]),
    approve: async () => { approvals++; return true; }, log: e => events.push(e) });
  assert.equal(approvals, 0);
  assert.equal(events.find(e => e.type === 'read_file').ok, false);
  assert.equal(events.find(e => e.type === 'write_file').ok, false);
  assert.equal(await readFile(join(outside, 'private.txt'), 'utf8'), 'untouched');
});
