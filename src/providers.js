// Provider abstraction for AI mode. Each provider knows how to build one
// "complete this prompt" request and how to read the text out of the reply,
// so anything later (like an agent loop) can reuse the same interface.
// Keys come from per-provider environment variables and are never stored.

export const PROVIDERS = Object.freeze({
  gemini: {
    label: 'Google Gemini',
    keyEnv: 'RELAY_GEMINI_KEY',
    defaultModel: 'gemini-2.0-flash',
    keyHint: 'aistudio.google.com - free tier available',
    buildRequest({ model, key, prompt }) {
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: {
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
        }
      };
    },
    parseResponse(data) {
      return (data?.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('');
    }
  },
  anthropic: {
    label: 'Anthropic Claude',
    keyEnv: 'RELAY_ANTHROPIC_KEY',
    defaultModel: 'claude-sonnet-4-5',
    keyHint: 'console.anthropic.com - pay-per-token, no free tier',
    buildRequest({ model, key, prompt }) {
      return {
        url: 'https://api.anthropic.com/v1/messages',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: 8192, messages: [{ role: 'user', content: prompt }] }
      };
    },
    parseResponse(data) {
      return (data?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
    }
  },
  openai: {
    label: 'OpenAI-compatible endpoint',
    keyEnv: 'RELAY_OPENAI_KEY',
    baseUrlEnv: 'RELAY_OPENAI_BASE_URL',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyHint: 'platform.openai.com or openrouter.ai/keys (paid), or local Ollama via RELAY_OPENAI_BASE_URL=http://localhost:11434/v1 (free, no key)',
    buildRequest({ model, key, prompt, baseUrl }) {
      const headers = { 'content-type': 'application/json' };
      if (key) headers.authorization = `Bearer ${key}`;
      return {
        url: `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`,
        headers,
        body: { model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }
      };
    },
    parseResponse(data) {
      return data?.choices?.[0]?.message?.content ?? '';
    }
  }
});

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

// Pick provider + model + key from flags and environment. Fails loudly,
// naming the exact env var, before any network call happens.
export function resolveProvider({ provider, model, env = process.env } = {}) {
  const name = provider || env.RELAY_AI_PROVIDER || 'gemini';
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown provider "${name}". Available: ${Object.keys(PROVIDERS).join(', ')}`);
  const baseUrl = p.baseUrlEnv ? (env[p.baseUrlEnv] || p.defaultBaseUrl) : undefined;
  const key = env[p.keyEnv] || '';
  if (!key && !(baseUrl && LOCAL.test(baseUrl))) {
    throw new Error(`AI mode needs your own ${p.label} API key: set ${p.keyEnv} (${p.keyHint})`);
  }
  return {
    name,
    provider: p,
    key,
    baseUrl,
    model: model || env[`RELAY_${name.toUpperCase()}_MODEL`] || env.RELAY_AI_MODEL || p.defaultModel
  };
}

// One text completion through the chosen provider. This is the seam a
// future agent loop (plan -> edit -> run -> retry) plugs into.
export async function complete({ prompt, provider, model, key, baseUrl, fetchImpl = fetch }) {
  const req = provider.buildRequest({ model, key, prompt, baseUrl });
  const res = await fetchImpl(req.url, {
    method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(120000)
  });
  if (!res.ok) throw new Error(`${provider.label} API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return provider.parseResponse(await res.json());
}
