import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { init } from '../src/runner.js';
import { makeJob } from '../src/protocol.js';
import { addSender, createRelayServer } from '../src/server.js';

const AGENT_BIN = fileURLToPath(new URL('../bin/relay-agent.js', import.meta.url));

async function setup(enableCommands = false) {
  const home = await mkdtemp(join(tmpdir(), 'relay-http-'));
  const stateDir = await init(home);
  const keyFile = await addSender(stateDir, 'test-agent');
  const key = await readFile(keyFile);
  const logFile = join(stateDir, 'run.log');
  const server = createRelayServer({ stateDir, workspace: home, enableCommands, logFile });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${url}/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { home, stateDir, key, keyFile, url, post, logFile, close: () => new Promise(r => server.close(r)) };
}

test('valid signature from an allowlisted sender is accepted', async () => {
  const { key, post, close } = await setup();
  try {
    const res = await post({ sender: 'test-agent', job: makeJob('system.summary', {}, key) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(body.result.node);
  } finally { await close(); }
});

test('bad signature is rejected', async () => {
  const { post, close } = await setup();
  try {
    const job = makeJob('system.summary', {}, Buffer.alloc(32));
    const res = await post({ sender: 'test-agent', job });
    assert.equal(res.status, 403);
    assert.equal((await res.json()).ok, false);
  } finally { await close(); }
});

test('unknown or malformed sender is rejected before any verification', async () => {
  const { key, post, close } = await setup();
  try {
    for (const sender of ['nobody', '../secret', 'a/b', null]) {
      const res = await post({ sender, job: makeJob('system.summary', {}, key) });
      assert.equal(res.status, 403, `sender ${sender}`);
      assert.equal((await res.json()).ok, false);
    }
  } finally { await close(); }
});

test('command mode without operator opt-in is rejected; opt-in accepts (approval flow)', async () => {
  const off = await setup(false);
  try {
    const res = await off.post({ sender: 'test-agent', job: makeJob('command.node-version', {}, off.key) });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /off/);
  } finally { await off.close(); }
  const on = await setup(true);
  try {
    const res = await on.post({ sender: 'test-agent', job: makeJob('command.node-version', {}, on.key) });
    assert.equal(res.status, 200);
    assert.match((await res.json()).result.stdout, /^v\d+/);
  } finally { await on.close(); }
});

test('replayed job is rejected over HTTP', async () => {
  const { key, post, close } = await setup();
  try {
    const job = makeJob('system.summary', {}, key);
    assert.equal((await post({ sender: 'test-agent', job })).status, 200);
    const replay = await post({ sender: 'test-agent', job });
    assert.equal(replay.status, 409);
    assert.match((await replay.json()).error, /Replay/);
  } finally { await close(); }
});

test('every request and decision is written to the run log', async () => {
  const { key, post, logFile, close } = await setup();
  try {
    await post({ sender: 'test-agent', job: makeJob('system.summary', {}, key) });
    await post({ sender: 'ghost', job: makeJob('system.summary', {}, key) });
    await post({ sender: 'test-agent', job: makeJob('system.summary', {}, Buffer.alloc(32)) });
  } finally { await close(); }
  const lines = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(l => l.decision), ['accepted', 'rejected', 'rejected']);
  assert.deepEqual(lines.map(l => l.reason ?? null), [null, 'unknown_sender', 'signature_rejected']);
  assert.equal(lines[0].sender, 'test-agent');
  assert.equal(lines[0].task, 'system.summary');
});

test('agent client CLI talks to a running listener end to end', async () => {
  const { keyFile, url, close } = await setup();
  try {
    const out = await new Promise((resolveRun, rejectRun) => {
      const child = spawn(process.execPath, [AGENT_BIN, 'system.summary', '--sender', 'test-agent', '--key-file', keyFile, '--url', url]);
      let stdout = '', stderr = '';
      child.stdout.on('data', b => { stdout += b; });
      child.stderr.on('data', b => { stderr += b; });
      child.on('close', code => code === 0 ? resolveRun(stdout) : rejectRun(new Error(`exit ${code}: ${stderr}`)));
    });
    const body = JSON.parse(out);
    assert.equal(body.ok, true);
    assert.ok(body.result.node);
  } finally { await close(); }
});
