/* Relay Runner - live terminal.
   Runs the repository's real protocol (HMAC-SHA256 envelopes, freshness,
   replay and task checks) and runner dispatch against a small demo
   workspace kept inside this browser tab. The Node originals live in
   src/protocol.js and src/runner.js; this is the same logic with
   WebCrypto in place of node:crypto and a virtual file store in place
   of node:fs. */
'use strict';

/* ---------- protocol (port of src/protocol.js) ---------- */
const TASKS = Object.freeze(['system.summary', 'workspace.list', 'notes.append', 'command.node-version']);
const MAX_AGE_MS = 120_000;

function payload(job) {
  return JSON.stringify({ v: job.v, id: job.id, issuedAt: job.issuedAt, task: job.task, args: job.args });
}
function hex(buf) { return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function hmac(keyBytes, text) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
}
async function sign(job, keyBytes) { return hmac(keyBytes, payload(job)); }
async function makeJob(task, args, keyBytes, now = Date.now()) {
  const job = { v: 1, id: hex(crypto.getRandomValues(new Uint8Array(16)).buffer), issuedAt: now, task, args };
  return { ...job, signature: await sign(job, keyBytes) };
}
function constEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function checkJob(job, keyBytes, now = Date.now()) {
  // Same gates as src/protocol.js verify(), reported individually for display.
  const shapeOk = !!job && typeof job === 'object' && !Array.isArray(job) &&
    Object.keys(job).sort().join(',') === 'args,id,issuedAt,signature,task,v' &&
    job.v === 1 && typeof job.id === 'string' && /^[a-f0-9]{32}$/.test(job.id) &&
    Number.isSafeInteger(job.issuedAt) && typeof job.signature === 'string' && /^[a-f0-9]{64}$/.test(job.signature) &&
    !!job.args && typeof job.args === 'object' && !Array.isArray(job.args);
  const taskOk = shapeOk && TASKS.includes(job.task);
  const freshOk = shapeOk && Math.abs(now - job.issuedAt) <= MAX_AGE_MS;
  const sigOk = shapeOk && constEq(await sign(job, keyBytes), job.signature);
  return { shapeOk, taskOk, freshOk, sigOk, ok: shapeOk && taskOk && freshOk && sigOk };
}

/* ---------- demo workspace (stands in for node:fs) ---------- */
const LS_KEY = 'relay-runner-demo-notes';
const buggy = `function totalWithDiscount(items, discountPct) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  return subtotal * (1 - discountPct);
}
module.exports = { totalWithDiscount };
`;
const checkSrc = `const { totalWithDiscount } = require('./discount');
const got = totalWithDiscount([{ price: 10, qty: 2 }], 10);
if (got !== 18) { console.error('expected 18, got ' + got); process.exit(1); }
console.log('check passed: 20 at 10% off = ' + got);
`;
function freshWorkspace() {
  return {
    'notes.txt': null, // restored from this browser's storage below
    'todo.md': '# todo\n- review the relay diff\n- water the plants\n',
    'ideas.md': '- a wall of lit niches\n- a terminal that tells the truth\n',
    'src/discount.js': buggy,
    'src/check.js': checkSrc
  };
}

/* ---------- runner (port of src/runner.js) ---------- */
function exactArgs(args, keys) {
  if (Object.keys(args).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Invalid task arguments');
}
const state = { key: null, seen: new Set(), workspace: freshWorkspace(), commandsEnabled: false };

function browserSummary() {
  const n = navigator;
  return {
    host: 'this browser tab',
    platform: n.platform || 'unknown',
    language: n.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    cores: n.hardwareConcurrency || 'not exposed',
    memoryGB: n.deviceMemory || 'not exposed',
    note: 'the browser sandbox view of your machine - the local install reports the real OS values'
  };
}
async function execute(job, now = Date.now()) {
  const checks = await checkJob(job, state.key, now);
  if (!checks.ok) { const e = new Error('Signature, task, or timestamp rejected'); e.checks = checks; throw e; }
  if (state.seen.has(job.id)) { const e = new Error('Replay rejected'); e.checks = checks; throw e; }
  state.seen.add(job.id);
  switch (job.task) {
    case 'system.summary':
      exactArgs(job.args, []);
      return browserSummary();
    case 'workspace.list': {
      exactArgs(job.args, []);
      const entries = Object.keys(state.workspace).filter(n => !n.startsWith('.')).slice(0, 50)
        .map(n => ({ name: n, type: n.includes('/') ? 'file' : (n.endsWith('.js') || n.endsWith('.md') || n.endsWith('.txt') ? 'file' : 'directory') }));
      return { workspace: '~/demo-workspace (this tab)', entries };
    }
    case 'notes.append': {
      exactArgs(job.args, ['text']);
      const text = job.args.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 500 || /[\x00-\x08\x0b-\x1f]/.test(text))
        throw new Error('Note must be 1-500 printable characters');
      const line = text.replace(/\r?\n/g, ' ') + '\n';
      state.workspace['notes.txt'] = (state.workspace['notes.txt'] || '') + line;
      try { localStorage.setItem(LS_KEY, state.workspace['notes.txt']); } catch {}
      return { savedTo: '.relay/notes.txt (persisted in this browser)', characters: text.length };
    }
    case 'command.node-version':
      exactArgs(job.args, []);
      if (!state.commandsEnabled) throw new Error('Command mode is off; operator must pass --enable-commands');
      throw new Error('No process can spawn inside a browser tab. The installed runner executes the fixed template `node --version` on your machine - same envelope, same checks.');
    default: throw new Error('Unknown task');
  }
}

/* ---------- mock agent (labeled) ---------- */
function mockAgentPlan(input) {
  const s = input.toLowerCase();
  if (/(fix|repair).*(discount|bug)/.test(s)) return { kind: 'agent', task: 'fix the discount bug so node src/check.js passes' };
  if (/\b(list|show|what).*(file|workspace|folder|directory)|^ls\b|what.*(in|on) my/.test(s)) return { kind: 'job', task: 'workspace.list', args: {} };
  if (/system|machine|spec|summary|about this (machine|device|computer)|info/.test(s)) return { kind: 'job', task: 'system.summary', args: {} };
  if (/node.*version|version.*node/.test(s)) return { kind: 'job', task: 'command.node-version', args: {} };
  const m = s.match(/(?:remember|note|append|write(?: down)?|add(?: to notes)?)\s*[:\-]?\s*(?:that\s+)?(.+)/);
  if (m) return { kind: 'job', task: 'notes.append', args: { text: input.trim().replace(/^(remember\s+to|remember|note|append|write\s+down|add\s+to\s+notes|add)\s*[:\-]?\s*(that\s+)?/i, '') } };
  return null;
}

/* The agent-loop demo: same story as scripts/demo-agent.js, with the
   provider mocked and labeled, and the check genuinely evaluated
   against the code the agent writes. */
async function runCheck(ws) {
  const srcFile = ws['src/discount.js'];
  let mod;
  try {
    const factory = new Function('module', 'exports', 'require', srcFile);
    const module = { exports: {} };
    factory(module, module.exports, () => ({}));
    mod = module.exports;
  } catch (err) { return { code: 1, out: 'discount.js does not parse: ' + err.message }; }
  try {
    const got = mod.totalWithDiscount([{ price: 10, qty: 2 }], 10);
    if (got !== 18) return { code: 1, out: 'expected 18, got ' + got };
    return { code: 0, out: 'check passed: 20 at 10% off = ' + got };
  } catch (err) { return { code: 1, out: String(err) }; }
}
const properFix = `function totalWithDiscount(items, discountPct) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  return subtotal * (1 - discountPct / 100);
}
module.exports = { totalWithDiscount };
`;
const misFix = properFix.replace('discountPct / 100', 'discountPct');

/* ---------- exports for a headless test harness ---------- */
const RelayDemo = { TASKS, payload, sign, makeJob, checkJob, execute, state, freshWorkspace, mockAgentPlan, runCheck, properFix, misFix, buggy };
if (typeof module !== 'undefined' && module.exports) module.exports = RelayDemo;
if (typeof globalThis !== 'undefined') globalThis.RelayDemo = RelayDemo;

/* ---------- terminal UI (browser only) ---------- */
if (typeof document !== 'undefined') (() => {
  const out = document.getElementById('termOut');
  const form = document.getElementById('termForm');
  const input = document.getElementById('termIn');
  if (!out || !form || !input) return;

  const history = []; let hpos = 0;
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  function line(html, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.innerHTML = html;
    out.appendChild(div);
    while (out.children.length > 400) out.removeChild(out.firstChild);
    out.scrollTop = out.scrollHeight;
  }
  const cmd = t => line('<span class="prompt">&gt;</span> ' + esc(t), 't-cmd');
  const info = t => line(esc(t), 't-mut');
  const ok = t => line('<span class="ok">&#10003;</span> ' + esc(t), 't-ok');
  const bad = t => line('<span class="no">&#10007;</span> ' + esc(t), 't-err');
  const json = o => line('<pre>' + esc(JSON.stringify(o, null, 2)) + '</pre>', 't-json');
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function restoreNotes() {
    try {
      const saved = localStorage.getItem(LS_KEY);
      state.workspace['notes.txt'] = saved || 'first light, then the rest\n';
    } catch { state.workspace['notes.txt'] = 'first light, then the rest\n'; }
  }

  async function runJob(task, args, via) {
    const job = await makeJob(task, args, state.key);
    info((via || 'mock agent') + ' signed a ' + task + ' envelope:');
    json({ ...job, signature: job.signature.slice(0, 24) + '...' });
    await sleep(120);
    let checks;
    try {
      const pre = await checkJob(job, state.key);
      checks = pre;
      line((pre.sigOk ? '<span class="ok">&#10003;</span>' : '<span class="no">&#10007;</span>') + ' HMAC-SHA256 signature', 't-chk');
      line((pre.freshOk ? '<span class="ok">&#10003;</span>' : '<span class="no">&#10007;</span>') + ' fresh (under two minutes old)', 't-chk');
      line((pre.taskOk ? '<span class="ok">&#10003;</span>' : '<span class="no">&#10007;</span>') + ' task on the allowlist', 't-chk');
      line('<span class="ok">&#10003;</span> id not seen before', 't-chk');
      const result = await execute(job);
      ok(task + ' accepted');
      json(result);
    } catch (err) {
      bad(task + ' denied - ' + err.message);
    }
  }

  async function agentDemo() {
    const ws = state.workspace;
    ws['src/discount.js'] = buggy; // reset the demo file
    info('agent loop (mock provider, labeled as such - the loop, gates and check are real):');
    await sleep(150);
    line('step 1: read_file src/discount.js', 't-mut');
    await sleep(200);
    line('step 2: write_file src/discount.js <span class="t-mut">[gate] operator approves WRITE: yes (auto-approved in this demo; the installed loop prompts y/N)</span>', 't-mut');
    ws['src/discount.js'] = misFix;
    await sleep(200);
    line('step 3: run_command `node src/check.js`', 't-mut');
    let r = await runCheck(ws);
    line('&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;-&gt; exit ' + r.code + (r.out ? ' · ' + esc(r.out) : ''), r.code ? 't-err' : 't-ok');
    await sleep(250);
    line('step 4: write_file src/discount.js <span class="t-mut">[gate] operator approves WRITE: yes (auto-approved in this demo)</span>', 't-mut');
    ws['src/discount.js'] = properFix;
    await sleep(200);
    line('step 5: run_command `node src/check.js`', 't-mut');
    r = await runCheck(ws);
    line('&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;-&gt; exit ' + r.code + ' · ' + esc(r.out), r.code ? 't-err' : 't-ok');
    await sleep(150);
    if (r.code === 0) ok('done - discount.js now applies the percent correctly; the check above really evaluated the written code in this tab');
  }

  async function handle(raw) {
    const text = raw.trim();
    if (!text) return;
    cmd(text);
    history.push(text); hpos = history.length;
    const low = text.toLowerCase();
    if (low === 'clear') { out.innerHTML = ''; return; }
    if (low === 'help') {
      info('type naturally - the offline mock agent maps it to a signed task:');
      line('&nbsp;&nbsp;"list my files" &nbsp;"system summary" &nbsp;"remember to review the diff" &nbsp;"node version" &nbsp;"fix the discount bug"', 't-mut');
      info('raw commands: tasks · demo · agent · notes · enable-commands · reset · clear');
      return;
    }
    if (low === 'tasks') { json(TASKS); return; }
    if (low === 'enable-commands') { state.commandsEnabled = true; ok('command mode enabled by the operator (this tab)'); return; }
    if (low === 'notes') { line('<pre>' + esc(state.workspace['notes.txt'] || '(empty)') + '</pre>', 't-json'); return; }
    if (low === 'reset') { try { localStorage.removeItem(LS_KEY); } catch {} state.workspace = freshWorkspace(); restoreNotes(); state.commandsEnabled = false; ok('demo workspace reset'); return; }
    if (low === 'demo') {
      await runJob('system.summary', {});
      await sleep(200); await runJob('workspace.list', {});
      await sleep(200); await runJob('command.node-version', {});
      if (!state.commandsEnabled) {
        await sleep(250); info('operator turns the key: enable-commands');
        state.commandsEnabled = true;
        await sleep(150); await runJob('command.node-version', {});
      }
      return;
    }
    if (low === 'agent') { await agentDemo(); return; }
    const plan = mockAgentPlan(text);
    if (!plan) {
      bad('the mock agent could not map that - it is deliberately small. try "help" for examples.');
      return;
    }
    if (plan.kind === 'agent') { await agentDemo(); return; }
    await runJob(plan.task, plan.args);
  }

  let busy = false;
  form.addEventListener('submit', async e => {
    e.preventDefault();
    if (busy) return;
    const v = input.value; input.value = '';
    busy = true; input.disabled = true;
    try { await handle(v); } finally { busy = false; input.disabled = false; input.focus(); }
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp') { if (hpos > 0) { hpos--; input.value = history[hpos] || ''; } e.preventDefault(); }
    if (e.key === 'ArrowDown') { if (hpos < history.length) { hpos++; input.value = history[hpos] || ''; } e.preventDefault(); }
  });
  document.querySelectorAll('[data-term-try]').forEach(b => b.addEventListener('click', () => {
    input.value = b.getAttribute('data-term-try');
    form.requestSubmit();
  }));
  const term = document.getElementById('termLive');
  if (term) term.addEventListener('click', e => { if (!e.target.closest('button')) input.focus(); });

  /* boot: init runs the real key generation */
  (async () => {
    restoreNotes();
    state.key = crypto.getRandomValues(new Uint8Array(32));
    line('<span class="prompt">$</span> relay init --home ./demo-home', 't-cmd');
    await sleep(250);
    ok('created .relay/secret (32 random bytes, this tab only) - never overwritten, never leaves the browser');
    await sleep(200);
    info('This terminal runs Relay Runner\'s real protocol and runner against a demo workspace in your tab.');
    info('Natural language is mapped by the offline mock agent; the installed version plans with a real model (free Gemini key, or a local model).');
    info('Try a suggestion below, or type "help".');
  })();
})();
