import { appendFile, mkdir, readdir, readFile, writeFile, lstat } from 'node:fs/promises';
import { join, resolve, sep, relative } from 'node:path';

export const GEMINI_MODEL = 'gemini-2.0-flash';
export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 20000;
export const MAX_EDITS = 20;
export const MAX_EDIT_CHARS = 100000;
const SKIP_DIRS = new Set(['.git', '.relay', 'node_modules']);
const SKIP_FILES = new Set(['.DS_Store']);

// Read the workspace into a capped text snapshot. Binary and oversized files
// are skipped with a note, never sent partially without saying so.
export async function snapshotFiles(root, { maxFiles = MAX_FILES, maxBytesPerFile = MAX_FILE_BYTES } = {}) {
  const base = resolve(root);
  const files = [];
  async function walk(dir) {
    if (files.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
      } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
        const stat = await lstat(full);
        if (stat.isSymbolicLink() || stat.size > maxBytesPerFile) continue;
        const text = await readFile(full, 'utf8').catch(() => null);
        if (text === null || text.includes('\0')) continue;
        files.push({ path: relative(base, full).split(sep).join('/'), content: text });
      }
    }
  }
  await walk(base);
  return files;
}

export function buildPrompt(task, files) {
  const listing = files.map(f => `--- ${f.path} ---\n${f.content}`).join('\n');
  return [
    'You are editing a local project on behalf of its operator. Read the files below, then propose the changes for this task:',
    '',
    `TASK: ${task}`,
    '',
    'Respond with ONLY a JSON object, no prose, no code fences:',
    '{"summary": "one paragraph describing the changes", "edits": [{"path": "relative/file/path", "content": "the complete new file content"}]}',
    'Rules: paths stay inside the project; content is the FULL file, not a fragment; only include files that change; at most 10 files.',
    '',
    'PROJECT FILES:',
    listing
  ].join('\n');
}

export function parseEdits(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let obj;
  try { obj = JSON.parse(cleaned); }
  catch { throw new Error('Model did not return parseable JSON'); }
  if (!obj || typeof obj !== 'object' || typeof obj.summary !== 'string' || !Array.isArray(obj.edits)) {
    throw new Error('Model response is not the expected { summary, edits } shape');
  }
  if (obj.edits.length > MAX_EDITS) throw new Error(`Model proposed too many edits (max ${MAX_EDITS})`);
  for (const edit of obj.edits) {
    if (!edit || typeof edit.path !== 'string' || typeof edit.content !== 'string') {
      throw new Error('Every edit needs a path string and a content string');
    }
    if (edit.content.length > MAX_EDIT_CHARS) throw new Error('Proposed file content too large');
    safeEditPath('/relay-shape-check', edit.path); // lexical check; the real root is checked again later
  }
  return { summary: obj.summary, edits: obj.edits };
}

// A proposed path must be relative, inside the workspace, and outside .git/.relay.
export function safeEditPath(root, p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) {
    throw new Error(`Unsafe edit path: ${p}`);
  }
  const base = resolve(root);
  const target = resolve(base, p);
  if (target === base || !target.startsWith(base + sep)) throw new Error(`Edit path escapes workspace: ${p}`);
  const first = relative(base, target).split(sep)[0];
  if (SKIP_DIRS.has(first)) throw new Error(`Edit path targets a protected directory: ${p}`);
  return target;
}

export async function proposeEdits({ task, root, key, model = GEMINI_MODEL, fetchImpl = fetch }) {
  const files = await snapshotFiles(root);
  const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: buildPrompt(task, files) }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? '').join('');
  const { summary, edits } = parseEdits(text);
  for (const edit of edits) safeEditPath(root, edit.path);
  return { summary, edits, filesConsidered: files.length };
}

// Small line diff: LCS for files up to 400 lines, otherwise a size summary.
export function diffLines(oldText, newText) {
  const a = oldText === null ? [] : oldText.split('\n');
  const b = newText.split('\n');
  if (a.length > 400 || b.length > 400) {
    return [`~ ${oldText === null ? 'new file' : 'file replaced'} (${a.length} -> ${b.length} lines)`];
  }
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`- ${a[i]}`); i++; }
    else { out.push(`+ ${b[j]}`); j++; }
  }
  while (i < m) { out.push(`- ${a[i]}`); i++; }
  while (j < n) { out.push(`+ ${b[j]}`); j++; }
  return out.length ? out : ['(no changes)'];
}

export async function renderDiffs(edits, root) {
  const parts = [];
  for (const edit of edits) {
    const target = safeEditPath(root, edit.path);
    const current = await readFile(target, 'utf8').catch(() => null);
    parts.push(`=== ${edit.path}${current === null ? ' (new file)' : ''} ===\n${diffLines(current, edit.content).join('\n')}`);
  }
  return parts.join('\n\n');
}

export async function applyEdits(edits, root) {
  for (const edit of edits) {
    const target = safeEditPath(root, edit.path);
    const stat = await lstat(target).catch(() => null);
    if (stat && stat.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${edit.path}`);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, edit.content);
  }
}

// Full loop: snapshot -> API -> diff -> operator decision -> apply -> log.
// Nothing is written unless approve() returns true.
export async function runAiTask({ task, root, stateDir, key, model = GEMINI_MODEL, fetchImpl = fetch, approve, logFile = join(stateDir, 'ai.log') }) {
  if (!key) throw new Error('AI mode needs your own Gemini API key: set RELAY_GEMINI_KEY (the free tier is enough)');
  const { summary, edits, filesConsidered } = await proposeEdits({ task, root, key, model, fetchImpl });
  const diff = await renderDiffs(edits, root);
  const approved = approve ? await approve({ summary, edits, diff }) : false;
  if (approved) await applyEdits(edits, root);
  await appendFile(logFile, JSON.stringify({
    at: new Date().toISOString(), mode: 'ai', task, model, filesConsidered,
    editsProposed: edits.map(e => e.path), decision: approved ? 'applied' : 'rejected'
  }) + '\n', { mode: 0o600 });
  return { summary, edits, diff, applied: approved, filesConsidered };
}
