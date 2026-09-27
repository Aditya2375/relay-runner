#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { makeJob } from '../src/protocol.js';
import { execute, init } from '../src/runner.js';
import { addSender, createRelayServer } from '../src/server.js';
import { runAiTask } from '../src/ai.js';
import { createInterface } from 'node:readline/promises';

const [action, ...flags] = process.argv.slice(2);
function flag(name, fallback) { const i = flags.indexOf(name); return i < 0 ? fallback : flags[i + 1]; }
function help() {
  console.log(`Relay Runner · local signed tasks

  npm run demo                 private, zero-network loop
  node bin/relay.js init --home DIR
  node bin/relay.js issue TASK --home DIR [--text NOTE] [--out FILE]
  node bin/relay.js run FILE --home DIR [--workspace DIR] [--enable-commands]
  node bin/relay.js allow NAME --home DIR        register an agent sender
  node bin/relay.js listen --home DIR [--port 7373] [--workspace DIR] [--enable-commands]
  node bin/relay-agent.js TASK --sender NAME --key-file FILE [--url URL]

Tasks: system.summary, workspace.list, notes.append, command.node-version
The signing key is in DIR/.relay/secret. Keep it private.
The listener binds 127.0.0.1 only and logs every request to DIR/.relay/run.log.

  node bin/relay.js ai --task "what to change" --workspace DIR [--home DIR] [--yes]
AI mode reads the project, asks Gemini for edits, shows a diff and applies
only after you approve. Needs your own key in RELAY_GEMINI_KEY (free tier).`);
}
async function main() {
  if (!action || action === 'help') return help();
  if (action === 'demo') {
    const home = await mkdtemp(join(tmpdir(), 'relay-demo-'));
    const stateDir = await init(home);
    const key = await readFile(join(stateDir, 'secret'));
    console.log('Mock agent -> signed jobs -> local runner\n');
    for (const [task, args] of [
      ['system.summary', {}], ['workspace.list', {}],
      ['notes.append', { text: 'The loop works without a cloud account.' }],
      ['command.node-version', {}]
    ]) {
      const job = makeJob(task, args, key);
      try { console.log(`${task}:`, JSON.stringify(await execute(job, { stateDir, workspace: home }))); }
      catch (err) { console.log(`${task}: REJECTED (${err.message})`); }
    }
    console.log('\nOperator explicitly enables the one allowed command template:');
    console.log('command.node-version:', JSON.stringify(await execute(makeJob('command.node-version', {}, key), { stateDir, workspace: home, enableCommands: true })));
    console.log(`\nDemo state: ${home}`);
    return;
  }
  const home = resolve(flag('--home', process.cwd()));
  if (action === 'init') { console.log(`Initialized ${await init(home)} (existing key preserved)`); return; }
  const stateDir = join(home, '.relay');
  if (action === 'issue') {
    const task = flags[0];
    const args = task === 'notes.append' ? { text: flag('--text', '') } : {};
    const key = await readFile(join(stateDir, 'secret'));
    const job = makeJob(task, args, key);
    const out = flag('--out', join(home, 'job.json'));
    await writeFile(out, JSON.stringify(job, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    console.log(`Signed ${task} -> ${out}`);
    return;
  }
  if (action === 'run') {
    if (!flags[0] || flags[0].startsWith('--')) throw new Error('run needs a job JSON file');
    const file = flags[0];
    const raw = await readFile(file, 'utf8');
    if (raw.length > 8192) throw new Error('Job too large');
    const job = JSON.parse(raw);
    console.log(JSON.stringify(await execute(job, {
      stateDir, workspace: resolve(flag('--workspace', home)),
      enableCommands: flags.includes('--enable-commands')
    }), null, 2));
    return;
  }
  if (action === 'allow') {
    const name = flags[0];
    if (!name || name.startsWith('--')) throw new Error('allow needs a sender name');
    const file = await addSender(stateDir, name);
    console.log(`Sender ${name} registered: ${file} (give this key file to that agent, keep it private)`);
    return;
  }
  if (action === 'listen') {
    const port = Number(flag('--port', '7373'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const logFile = join(stateDir, 'run.log');
    const server = createRelayServer({
      stateDir, workspace: resolve(flag('--workspace', home)),
      enableCommands: flags.includes('--enable-commands'), logFile
    });
    await new Promise((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(port, '127.0.0.1', resolveListen);
    });
    console.log(`Listening on http://127.0.0.1:${port}/jobs (localhost only)`);
    console.log(`Command mode: ${flags.includes('--enable-commands') ? 'ON (operator opt-in)' : 'off'}. Logging to ${logFile}. Ctrl+C to stop.`);
    await new Promise(resolveWait => {
      process.on('SIGINT', () => { server.close(() => resolveWait()); });
    });
    return;
  }
  if (action === 'ai') {
    const taskText = flag('--task', '');
    if (!taskText.trim()) throw new Error('ai needs --task "what to change"');
    const workspace = resolve(flag('--workspace', home));
    const skipPrompt = flags.includes('--yes');
    const rl = skipPrompt ? null : createInterface({ input: process.stdin, output: process.stdout });
    try {
      const result = await runAiTask({
        task: taskText, root: workspace, stateDir,
        key: process.env.RELAY_GEMINI_KEY,
        approve: skipPrompt ? () => true : async ({ summary, diff }) => {
          console.log(`\nProposed changes:\n${summary}\n\n${diff}\n`);
          const answer = await rl.question('Apply these edits? [y/N] ');
          return /^y(es)?$/i.test(answer.trim());
        }
      });
      console.log(result.applied ? `Applied ${result.edits.length} file edit(s).` : 'Rejected. Nothing was written.');
      console.log(`(${result.filesConsidered} project files considered; run logged to ${join(stateDir, 'ai.log')})`);
    } finally { if (rl) rl.close(); }
    return;
  }
  throw new Error(`Unknown action: ${action}`);
}
main().catch(err => { console.error(`relay: ${err.message}`); process.exitCode = 1; });
