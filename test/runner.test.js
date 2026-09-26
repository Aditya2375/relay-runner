import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeJob, verify } from '../src/protocol.js';
import { execute, init } from '../src/runner.js';
async function setup() { const home = await mkdtemp(join(tmpdir(), 'relay-test-')); const stateDir = await init(home); return { home, stateDir, key: await readFile(join(stateDir, 'secret')) }; }
test('signed built-ins execute; replay is rejected', async () => {
  const { home, stateDir, key } = await setup();
  const job = makeJob('system.summary', {}, key);
  assert.ok((await execute(job, { stateDir, workspace: home })).node);
  await assert.rejects(execute(job, { stateDir, workspace: home }), /Replay/);
});
test('tamper, stale, unknown task and wrong key are rejected', async () => {
  const { home, stateDir, key } = await setup();
  const job = makeJob('notes.append', { text: 'safe' }, key);
  await assert.rejects(execute({ ...job, args: { text: 'changed' } }, { stateDir, workspace: home }), /Signature/);
  assert.equal(verify(makeJob('unknown', {}, key), key), false);
  assert.equal(verify(job, Buffer.alloc(32)), false);
  assert.equal(verify(job, key, job.issuedAt + 120001), false);
});
test('command gate is off by default and limited to fixed template', async () => {
  const { home, stateDir, key } = await setup();
  await assert.rejects(execute(makeJob('command.node-version', {}, key), { stateDir, workspace: home }), /off/);
  const result = await execute(makeJob('command.node-version', {}, key), { stateDir, workspace: home, enableCommands: true });
  assert.match(result.stdout, /^v\d+/);
  await assert.rejects(execute(makeJob('command.node-version', { command: 'rm -rf /' }, key), { stateDir, workspace: home, enableCommands: true }), /Invalid task arguments/);
});
test('note target refuses symlink', async () => {
  const { home, stateDir, key } = await setup();
  await symlink(join(home, 'elsewhere'), join(stateDir, 'notes.txt'));
  await assert.rejects(execute(makeJob('notes.append', { text: 'hello' }, key), { stateDir, workspace: home }), /ELOOP/);
});
