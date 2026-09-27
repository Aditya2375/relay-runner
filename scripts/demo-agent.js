// End-to-end agent-loop demo with a MOCKED provider (no API key, no network).
// The mock plays a scripted but representative session: inspect, mis-fix,
// run the check, read the failure, fix properly, re-run, declare done.
// The loop, gates, command execution and logging below are all real.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runAgentLoop } from '../src/loop.js';

const src = path.resolve('examples/buggy-app');
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-demo-'));
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(ws, f));

const fixed = `function totalWithDiscount(items, discountPct) {
  const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
  return subtotal * (1 - discountPct / 100);
}
module.exports = { totalWithDiscount };
`;
const script = [
  JSON.stringify({ action: 'read_file', path: 'discount.js' }),
  JSON.stringify({ action: 'write_file', path: 'discount.js', content: fixed.replace('discountPct / 100', 'discountPct') }),
  JSON.stringify({ action: 'run_command', command: 'node check.js' }),
  JSON.stringify({ action: 'write_file', path: 'discount.js', content: fixed }),
  JSON.stringify({ action: 'run_command', command: 'node check.js' }),
  JSON.stringify({ action: 'done', summary: 'discount.js now applies the percent correctly; node check.js passes' })
];

console.log('=== Relay Runner agent-loop demo (MOCKED provider, labeled as such) ===');
console.log(`Task: "fix the discount bug so node check.js passes"   Workspace: ${ws}\n`);
let n = 0;
const result = await runAgentLoop({
  task: 'fix the discount bug so node check.js passes',
  workspace: ws, env: { RELAY_GEMINI_KEY: 'mock-key' }, execEnabled: true,
  completeImpl: async () => script.shift(),
  approve: async (req) => {
    n++;
    if (req.kind === 'write_file') console.log(`[gate ${n}] operator approves WRITE ${req.path}: yes (auto-approved for this demo; real runs prompt y/N/a)`);
    else console.log(`[gate ${n}] operator approves COMMAND \`${req.command}\`: yes (auto-approved for this demo)`);
    return true;
  },
  log: (e) => {
    if (e.type === 'action') console.log(`step ${e.step}: ${e.action}${e.path ? ' ' + e.path : ''}${e.command ? ' `' + e.command + '`' : ''}`);
    if (e.type === 'run_command') console.log(`        -> exit ${e.code}`);
    if (e.type === 'done') console.log(`step ${e.step}: done - ${e.summary}`);
  }
});
console.log(`\nResult: ${result.status} in ${result.steps} steps. Final discount.js:`);
console.log(fs.readFileSync(path.join(ws, 'discount.js'), 'utf8'));
