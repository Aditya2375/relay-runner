import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '../src/runner.js';
import { parseEdits, safeEditPath, snapshotFiles, proposeEdits, diffLines, runAiTask } from '../src/ai.js';

function geminiResponse(payload) {
  return {
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: typeof payload === 'string' ? payload : JSON.stringify(payload) }] } }] }),
    text: async () => ''
  };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'relay-ai-'));
  await writeFile(join(root, 'index.js'), 'console.log("hi");\n');
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'junk.js'), 'x'.repeat(100));
  await mkdir(join(root, '.git'), { recursive: true });
  await writeFile(join(root, '.git', 'config'), 'secret');
  const home = await mkdtemp(join(tmpdir(), 'relay-ai-home-'));
  const stateDir = await init(home);
  return { root, stateDir };
}

test('parseEdits accepts plain and fenced JSON, rejects garbage and bad shapes', () => {
  const good = { summary: 's', edits: [{ path: 'a.js', content: 'x' }] };
  assert.deepEqual(parseEdits(JSON.stringify(good)), good);
  assert.deepEqual(parseEdits('```json\n' + JSON.stringify(good) + '\n```'), good);
  assert.throws(() => parseEdits('not json at all'), /JSON/);
  assert.throws(() => parseEdits('{"summary": 1, "edits": []}'), /shape/);
  assert.throws(() => parseEdits('{"summary": "s", "edits": [{"path": 2}]}'), /path string/);
});

test('edit paths cannot escape the workspace or hit protected dirs', () => {
  assert.throws(() => safeEditPath('/w', '../outside.js'), /escapes|Unsafe/);
  assert.throws(() => safeEditPath('/w', '/abs.js'), /Unsafe/);
  assert.throws(() => safeEditPath('/w', '.relay/secret'), /protected/);
  assert.throws(() => safeEditPath('/w', '.git/config'), /protected/);
  assert.ok(safeEditPath('/w', 'src/nested/ok.js').endsWith('src/nested/ok.js') || safeEditPath('/w', 'src/nested/ok.js').endsWith('src\\nested\\ok.js'));
});

test('snapshotFiles skips node_modules, .git, .relay and caps the count', async () => {
  const { root } = await workspace();
  const files = await snapshotFiles(root);
  assert.deepEqual(files.map(f => f.path), ['index.js']);
  const many = await snapshotFiles(root, { maxFiles: 0 });
  assert.equal(many.length, 0);
});

test('proposeEdits sends the task plus file contents and parses the reply', async () => {
  const { root } = await workspace();
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return geminiResponse({ summary: 'add a greeting', edits: [{ path: 'index.js', content: 'console.log("hello");\n' }] });
  };
  const out = await proposeEdits({ task: 'change the greeting', root, env: { RELAY_GEMINI_KEY: 'TEST-KEY' }, fetchImpl });
  assert.match(seen.url, /models\/gemini-flash-latest:generateContent/);
  assert.equal(seen.opts.headers['x-goog-api-key'], 'TEST-KEY');
  const body = JSON.parse(seen.opts.body);
  const prompt = body.contents[0].parts[0].text;
  assert.match(prompt, /change the greeting/);
  assert.match(prompt, /console\.log\("hi"\)/);
  assert.equal(out.summary, 'add a greeting');
  assert.equal(out.edits.length, 1);
  assert.equal(out.filesConsidered, 1);
});

test('proposeEdits refuses model edits that escape the workspace', async () => {
  const { root } = await workspace();
  const fetchImpl = async () => geminiResponse({ summary: 'evil', edits: [{ path: '../evil.js', content: 'x' }] });
  await assert.rejects(proposeEdits({ task: 't', root, env: { RELAY_GEMINI_KEY: 'k' }, fetchImpl }), /escapes|Unsafe/);
});

test('API failure surfaces the status, not a crash', async () => {
  const { root } = await workspace();
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'quota exceeded' });
  await assert.rejects(proposeEdits({ task: 't', root, env: { RELAY_GEMINI_KEY: 'k' }, fetchImpl }), /429/);
});

test('approval gate: rejected run writes nothing, approved run writes, both are logged', async () => {
  const { root, stateDir } = await workspace();
  const edit = { path: 'new-file.txt', content: 'fresh content\n' };
  const fetchImpl = async () => geminiResponse({ summary: 'make a file', edits: [edit] });

  const rejected = await runAiTask({ task: 'make a file', root, stateDir, env: { RELAY_GEMINI_KEY: 'k' }, fetchImpl, approve: () => false });
  assert.equal(rejected.applied, false);
  await assert.rejects(readFile(join(root, 'new-file.txt')));

  const approved = await runAiTask({ task: 'make a file', root, stateDir, env: { RELAY_GEMINI_KEY: 'k' }, fetchImpl, approve: () => true });
  assert.equal(approved.applied, true);
  assert.equal(await readFile(join(root, 'new-file.txt'), 'utf8'), 'fresh content\n');

  const lines = (await readFile(join(stateDir, 'ai.log'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.decision), ['rejected', 'applied']);
  assert.equal(lines[0].mode, 'ai');
  assert.deepEqual(lines[1].editsProposed, ['new-file.txt']);
});

test('missing key fails before any API call or file write', async () => {
  const { root, stateDir } = await workspace();
  let called = false;
  await assert.rejects(
    runAiTask({ task: 't', root, stateDir, env: {}, fetchImpl: async () => { called = true; }, approve: () => true }),
    /RELAY_GEMINI_KEY/
  );
  assert.equal(called, false);
});

test('diffLines shows removals and additions', () => {
  const out = diffLines('a\nb\nc', 'a\nx\nc');
  assert.deepEqual(out, ['- b', '+ x']);
  assert.deepEqual(diffLines(null, 'new'), ['+ new']);
});
