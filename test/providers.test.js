import test from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, resolveProvider, complete } from '../src/providers.js';

test('provider selection: default gemini, flag and env overrides', () => {
  assert.equal(resolveProvider({ env: { RELAY_GEMINI_KEY: 'x' } }).name, 'gemini');
  assert.equal(resolveProvider({ provider: 'anthropic', env: { RELAY_ANTHROPIC_KEY: 'x' } }).name, 'anthropic');
  assert.equal(resolveProvider({ env: { RELAY_AI_PROVIDER: 'openai', RELAY_OPENAI_KEY: 'x' } }).name, 'openai');
  assert.throws(() => resolveProvider({ provider: 'bogus', env: {} }), /Unknown provider "bogus"/);
});

test('each provider names its own env var when the key is missing', () => {
  assert.throws(() => resolveProvider({ env: {} }), /RELAY_GEMINI_KEY/);
  assert.throws(() => resolveProvider({ provider: 'anthropic', env: {} }), /RELAY_ANTHROPIC_KEY/);
  assert.throws(() => resolveProvider({ provider: 'openai', env: {} }), /RELAY_OPENAI_KEY/);
});

test('local OpenAI-compatible endpoint (Ollama) needs no key', () => {
  const r = resolveProvider({ provider: 'openai', env: { RELAY_OPENAI_BASE_URL: 'http://localhost:11434/v1' } });
  assert.equal(r.baseUrl, 'http://localhost:11434/v1');
  assert.equal(r.key, '');
});

test('model override: flag beats provider env beats default', () => {
  assert.equal(resolveProvider({ model: 'explicit', env: { RELAY_GEMINI_KEY: 'x' } }).model, 'explicit');
  assert.equal(resolveProvider({ env: { RELAY_GEMINI_KEY: 'x', RELAY_GEMINI_MODEL: 'gemini-pro' } }).model, 'gemini-pro');
  assert.equal(resolveProvider({ env: { RELAY_GEMINI_KEY: 'x' } }).model, 'gemini-2.0-flash');
});

test('gemini request shape and response parsing', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'world' }] } }] }) };
  };
  const r = resolveProvider({ env: { RELAY_GEMINI_KEY: 'GK' } });
  const text = await complete({ prompt: 'P', provider: r.provider, model: r.model, key: r.key, fetchImpl });
  assert.match(seen.url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.0-flash:generateContent/);
  assert.equal(seen.opts.headers['x-goog-api-key'], 'GK');
  assert.equal(JSON.parse(seen.opts.body).contents[0].parts[0].text, 'P');
  assert.equal(text, 'hello world');
});

test('anthropic request shape and response parsing', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'claude says hi' }] }) };
  };
  const r = resolveProvider({ provider: 'anthropic', env: { RELAY_ANTHROPIC_KEY: 'AK' } });
  const text = await complete({ prompt: 'P', provider: r.provider, model: r.model, key: r.key, fetchImpl });
  assert.equal(seen.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(seen.opts.headers['x-api-key'], 'AK');
  assert.equal(seen.opts.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.messages[0].content, 'P');
  assert.equal(text, 'claude says hi');
});

test('openai-compatible: base URL override, bearer auth, response parsing', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'router reply' } }] }) };
  };
  const r = resolveProvider({ provider: 'openai', env: { RELAY_OPENAI_KEY: 'OK', RELAY_OPENAI_BASE_URL: 'https://openrouter.ai/api/v1/', RELAY_OPENAI_MODEL: 'some/model' } });
  const text = await complete({ prompt: 'P', provider: r.provider, model: r.model, key: r.key, baseUrl: r.baseUrl, fetchImpl });
  assert.equal(seen.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(seen.opts.headers.authorization, 'Bearer OK');
  assert.equal(JSON.parse(seen.opts.body).model, 'some/model');
  assert.equal(text, 'router reply');
});

test('ollama-style local call sends no auth header when keyless', async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'local reply' } }] }) };
  };
  const r = resolveProvider({ provider: 'openai', env: { RELAY_OPENAI_BASE_URL: 'http://localhost:11434/v1', RELAY_OPENAI_MODEL: 'llama3.1' } });
  const text = await complete({ prompt: 'P', provider: r.provider, model: r.model, key: r.key, baseUrl: r.baseUrl, fetchImpl });
  assert.equal(seen.url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(seen.opts.headers.authorization, undefined);
  assert.equal(text, 'local reply');
});

test('provider API errors surface status and provider label', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  const r = resolveProvider({ provider: 'anthropic', env: { RELAY_ANTHROPIC_KEY: 'wrong' } });
  await assert.rejects(
    complete({ prompt: 'P', provider: r.provider, model: r.model, key: r.key, fetchImpl }),
    /Anthropic Claude API error 401/
  );
});

test('AI mode end to end through a non-default provider (mocked)', async () => {
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { init } = await import('../src/runner.js');
  const { runAiTask } = await import('../src/ai.js');
  const root = await mkdtemp(join(tmpdir(), 'relay-prov-'));
  await writeFile(join(root, 'a.txt'), 'old\n');
  const home = await mkdtemp(join(tmpdir(), 'relay-prov-home-'));
  const stateDir = await init(home);
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ summary: 's', edits: [{ path: 'a.txt', content: 'new\n' }] }) }] }) });
  const out = await runAiTask({ task: 'update', root, stateDir, providerName: 'anthropic', env: { RELAY_ANTHROPIC_KEY: 'k' }, fetchImpl, approve: () => true });
  assert.equal(out.applied, true);
  assert.equal(out.provider, 'anthropic');
  assert.equal(await readFile(join(root, 'a.txt'), 'utf8'), 'new\n');
  const log = JSON.parse((await readFile(join(stateDir, 'ai.log'), 'utf8')).trim());
  assert.equal(log.provider, 'anthropic');
});

test('all three providers are registered', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['anthropic', 'gemini', 'openai']);
});
