import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentLoop } from '../src/loop.js';

const ENV = { RELAY_GEMINI_KEY: 'test-key' };

function tmpWorkspace(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-loop-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

// A scripted model: each call shifts the next reply off the script.
function scriptedModel(replies, calls = []) {
  return async ({ prompt }) => {
    calls.push(prompt);
    if (!replies.length) throw new Error('model called more times than scripted');
    return replies.shift();
  };
}

test('loop: plan -> edit -> run(fail) -> fix -> run(pass) -> done', async () => {
  const ws = tmpWorkspace({ 'sum.js': 'module.exports = (a, b) => a - b; // BUG\n', 'test.sh': 'node -e "const s=require(\'./sum.js\');if(s(2,3)!==5){console.error(\'sum wrong\');process.exit(1)}console.log(\'ok\')"\n' });
  const events = [];
  const model = scriptedModel([
    JSON.stringify({ action: 'read_file', path: 'sum.js' }),
    JSON.stringify({ action: 'write_file', path: 'sum.js', content: 'module.exports = (a, b) => a - b; // still wrong\n' }),
    JSON.stringify({ action: 'run_command', command: 'sh test.sh' }),
    JSON.stringify({ action: 'write_file', path: 'sum.js', content: 'module.exports = (a, b) => a + b;\n' }),
    JSON.stringify({ action: 'run_command', command: 'sh test.sh' }),
    JSON.stringify({ action: 'done', summary: 'fixed the subtraction bug; test passes' })
  ]);
  const approvals = [];
  const result = await runAgentLoop({
    task: 'fix sum.js so the test passes', workspace: ws, env: ENV,
    completeImpl: model, execEnabled: true,
    approve: async (req) => { approvals.push(req.kind); return true; },
    log: (e) => events.push(e)
  });
  assert.equal(result.status, 'done');
  assert.equal(result.steps, 6);
  assert.equal(fs.readFileSync(path.join(ws, 'sum.js'), 'utf8'), 'module.exports = (a, b) => a + b;\n');
  // the failing run really failed and the passing run really passed
  const runs = events.filter((e) => e.type === 'run_command');
  assert.deepEqual(runs.map((r) => r.code), [1, 0]);
  assert.deepEqual(approvals, ['write_file', 'run_command', 'write_file', 'run_command']);
  // log completeness: every model call, action, approval and outcome recorded
  const types = new Set(events.map((e) => e.type));
  for (const t of ['start', 'model_request', 'model_response', 'action', 'approval', 'run_command', 'write_file', 'done']) {
    assert.ok(types.has(t), `log missing ${t}`);
  }
});

test('loop: approval denial on a write halts the run, nothing written', async () => {
  const ws = tmpWorkspace({ 'keep.txt': 'original\n' });
  const events = [];
  const model = scriptedModel([
    JSON.stringify({ action: 'write_file', path: 'keep.txt', content: 'overwritten\n' })
  ]);
  const result = await runAgentLoop({
    task: 'change keep.txt', workspace: ws, env: ENV, completeImpl: model,
    approve: async () => false, log: (e) => events.push(e)
  });
  assert.equal(result.status, 'halted');
  assert.match(result.reason, /denied write/);
  assert.equal(fs.readFileSync(path.join(ws, 'keep.txt'), 'utf8'), 'original\n');
  assert.ok(events.some((e) => e.type === 'approval' && e.approved === false));
  assert.ok(events.some((e) => e.type === 'halt'));
});

test('loop: approval denial on a command halts the run', async () => {
  const ws = tmpWorkspace();
  const model = scriptedModel([
    JSON.stringify({ action: 'run_command', command: 'echo hi' })
  ]);
  const result = await runAgentLoop({
    task: 'say hi', workspace: ws, env: ENV, completeImpl: model,
    execEnabled: true, approve: async () => false
  });
  assert.equal(result.status, 'halted');
  assert.match(result.reason, /denied command/);
});

test('loop: command gate - model asking for a command without execEnabled halts', async () => {
  const ws = tmpWorkspace();
  const events = [];
  const model = scriptedModel([
    JSON.stringify({ action: 'run_command', command: 'npm test' })
  ]);
  const result = await runAgentLoop({
    task: 'run the tests', workspace: ws, env: ENV, completeImpl: model,
    execEnabled: false, approve: async () => true, log: (e) => events.push(e)
  });
  assert.equal(result.status, 'halted');
  assert.match(result.reason, /not enable command mode/);
  assert.ok(events.some((e) => e.type === 'start' && e.execEnabled === false));
});

test('loop: step cap is enforced', async () => {
  const ws = tmpWorkspace({ 'a.txt': 'x\n' });
  const model = scriptedModel(Array(20).fill(JSON.stringify({ action: 'read_file', path: 'a.txt' })));
  const result = await runAgentLoop({
    task: 'never finishes', workspace: ws, env: ENV, completeImpl: model, maxSteps: 4
  });
  assert.equal(result.status, 'step_cap');
  assert.equal(result.steps, 4);
});

test('loop: invalid model JSON is fed back, not fatal', async () => {
  const ws = tmpWorkspace();
  const calls = [];
  const model = scriptedModel([
    'sure! here you go', // not JSON
    JSON.stringify({ action: 'done', summary: 'recovered' })
  ], calls);
  const result = await runAgentLoop({
    task: 'anything', workspace: ws, env: ENV, completeImpl: model
  });
  assert.equal(result.status, 'done');
  assert.match(calls[1], /not valid JSON/); // the error was fed back to the model
});

test('loop: write_file path escaping the workspace is refused', async () => {
  const ws = tmpWorkspace();
  const model = scriptedModel([
    JSON.stringify({ action: 'write_file', path: '../outside.txt', content: 'nope\n' }),
    JSON.stringify({ action: 'done', summary: 'gave up' })
  ]);
  const result = await runAgentLoop({
    task: 'try to escape', workspace: ws, env: ENV, completeImpl: model,
    approve: async () => true
  });
  assert.equal(result.status, 'done');
  assert.equal(fs.existsSync(path.join(ws, '..', 'outside.txt')), false);
});
