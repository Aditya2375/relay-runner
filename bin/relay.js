#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { makeJob } from '../src/protocol.js';
import { execute, init } from '../src/runner.js';
import { addSender, createRelayServer } from '../src/server.js';
import { runAiTask } from '../src/ai.js';
import { runAgentLoop } from '../src/loop.js';
import { createInterface } from 'node:readline/promises';

const BRIDGE_PROMPT = `You are talking to a person who runs Relay Runner on their own machine. It can do small, fixed jobs locally, but only after they approve each one themselves. You cannot reach their machine and you will never see their key.

When they ask you to do something on their machine, reply with EXACTLY one JSON object and nothing else:
{"task": "workspace.list", "args": {}}

The only four tasks:
- {"task": "system.summary", "args": {}} - OS and Node version of their machine
- {"task": "workspace.list", "args": {}} - top-level names in the workspace folder they chose
- {"task": "notes.append", "args": {"text": "..."}} - append one line (max 500 chars) to their local notes file
- {"task": "command.node-version", "args": {}} - run one fixed command: print the Node version (they must have enabled command mode)

Rules: no other tasks exist, do not invent any. File contents beyond a name listing are not available. They will paste your JSON into Relay Runner, approve or deny it themselves, and can paste the result back to you. If what they want needs more than these four tasks, say so plainly instead of guessing.`;

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
  node bin/relay.js bridge --home DIR [--workspace DIR] [--enable-commands]
                           paste a chat AI's job request, approve it, run it
  node bin/relay.js bridge --prompt    print the connector prompt for any chat AI


Tasks: system.summary, workspace.list, notes.append, command.node-version
The signing key is in DIR/.relay/secret. Keep it private.
The listener binds 127.0.0.1 only and logs every request to DIR/.relay/run.log.

  node bin/relay.js ai --task "what to change" --workspace DIR [--home DIR] [--yes]
  node bin/relay.js agent --task "multi-step goal" --workspace DIR [--max-steps 12] [--enable-commands]
Agent mode loops: plan with the model, act step by step (read/write files,
run commands), check results, retry on failure. Every write and every command
asks the operator ([a] allows that kind for the rest of the run); commands
also need --enable-commands at startup. Full log: DIR/.relay/agent.log
AI mode reads the project, asks an LLM for edits, shows a diff and applies
only after you approve. Providers (--provider or RELAY_AI_PROVIDER):
  gemini    RELAY_GEMINI_KEY from aistudio.google.com (free tier)
  anthropic RELAY_ANTHROPIC_KEY from console.anthropic.com (pay-per-token)
  openai    RELAY_OPENAI_KEY + optional RELAY_OPENAI_BASE_URL (OpenAI,
            OpenRouter, Groq, or local Ollama: http://localhost:11434/v1)`);
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
  if (action === 'bridge') {
    if (flags.includes('--prompt')) { console.log(BRIDGE_PROMPT); return; }
    // Read the AI's request: from --file, or paste on stdin and end with Ctrl-D.
    let raw;
    const jobFile = flag('--file', null);
    if (jobFile) {
      raw = await readFile(jobFile, 'utf8');
    } else {
      console.log('Paste the job request your chat AI gave you, then press Ctrl-D:');
      raw = await new Promise((res, rej) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => { buf += c; if (buf.length > 8192) { rej(new Error('Job too large')); process.stdin.destroy(); } });
        process.stdin.on('end', () => res(buf));
        process.stdin.on('error', rej);
      });
    }
    if (raw.length > 8192) throw new Error('Job too large');
    // Tolerate the AI wrapping the JSON in prose or a code fence: take the first {...} block.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('No JSON object found in what you pasted');
    let request;
    try { request = JSON.parse(raw.slice(start, end + 1)); } catch { throw new Error('That JSON does not parse - ask the AI for exactly one JSON object'); }
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Job request must be one JSON object');
    const { task, args = {} } = request;
    const { TASKS } = await import('../src/protocol.js');
    if (!TASKS.includes(task)) throw new Error(`Unknown task "${task}". The connector prompt lists the only four tasks.`);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be an object');
    if (task === 'notes.append') {
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 500 || /[\x00-\x08\x0b-\x1f]/.test(args.text))
        throw new Error('notes.append needs args.text: 1-500 printable characters');
      const extra = Object.keys(args).filter(k => k !== 'text');
      if (extra.length) throw new Error(`notes.append takes only args.text, not: ${extra.join(', ')}`);
    } else if (Object.keys(args).length) {
      throw new Error(`${task} takes no arguments`);
    }
    // Show the operator EXACTLY what the AI asked for. The AI never sees the key;
    // the signature below attests the operator's approval, not the AI's identity.
    console.log('\nA chat AI asked for this job:');
    console.log(`  task: ${task}`);
    console.log(`  args: ${JSON.stringify(args)}`);
    console.log('  workspace: ' + resolve(flag('--workspace', home)));
    if (task === 'command.node-version' && !flags.includes('--enable-commands'))
      console.log('  NOTE: this is a command task. It runs only if you started bridge with --enable-commands.');
    // When the request came via stdin paste, that stream just hit EOF - ask on the tty instead.
    let answer;
    if (jobFile) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      answer = await rl.question('\nSign and run it on this machine? [y/N] ');
      rl.close();
    } else {
      // stdin already hit EOF from the paste, so ask on the terminal directly.
      // Byte-wise readSync: no readline, no raw-mode juggling - the terminal's
      // own line editing and echo handle the interaction.
      answer = await import('node:fs').then(({ openSync, readSync, closeSync }) => {
        let fd;
        try { fd = openSync('/dev/tty', 'r'); } catch { console.log('(no terminal to approve on - defaulting to no)'); return 'n'; }
        process.stdout.write('\nSign and run it on this machine? [y/N] ');
        let out = '';
        const ch = Buffer.alloc(1);
        try {
          while (true) {
            if (readSync(fd, ch, 0, 1, null) === 0) break;
            const c = ch.toString('utf8');
            if (c === '\n' || c === '\r') break;
            out += c;
          }
        } catch { /* fall through to default no */ }
        try { closeSync(fd); } catch {}
        return out;
      });
    }
    if (answer.trim().toLowerCase() !== 'y') { console.log('Not approved. Nothing was signed or run.'); return; }
    const key = await readFile(join(stateDir, 'secret'));
    const job = makeJob(task, args, key);
    const result = await execute(job, {
      stateDir, workspace: resolve(flag('--workspace', home)),
      enableCommands: flags.includes('--enable-commands')
    });
    console.log('\n' + JSON.stringify(result, null, 2));
    console.log('Paste this result back to the chat AI if you want it to continue.');
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
        providerName: flag('--provider', undefined),
        env: process.env,
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
  if (action === 'agent') {
    const taskText = flag('--task', '');
    if (!taskText.trim()) throw new Error('agent needs --task "multi-step goal"');
    const workspace = resolve(flag('--workspace', home));
    const maxSteps = Number(flag('--max-steps', '12'));
    const execEnabled = flags.includes('--enable-commands');
    const logFile = join(stateDir, 'agent.log');
    const { appendFileSync } = await import('node:fs');
    const sessionAllow = new Set();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const approve = async (req) => {
      if (sessionAllow.has(req.kind)) return true;
      if (req.kind === 'write_file') {
        console.log(`\n--- agent wants to write ${req.path} (step ${req.step}) ---`);
        const oldLines = (req.before || '').split('\\n'), newLines = (req.after || '').split('\\n');
        console.log(`(${oldLines.length} line(s) -> ${newLines.length} line(s); full current and proposed content shown)`);
        console.log('--- current ---'); console.log(req.before || '(file does not exist yet)');
        console.log('--- proposed ---'); console.log(req.after);
      } else {
        console.log(`\n--- agent wants to run (step ${req.step}): ${req.command} ---`);
      }
      const answer = await rl.question('Allow? [y/N/a=allow this kind for the session] ');
      const a = answer.trim().toLowerCase();
      if (a === 'a') { sessionAllow.add(req.kind); return true; }
      return /^y(es)?$/.test(a);
    };
    try {
      const result = await runAgentLoop({
        task: taskText, workspace, maxSteps, execEnabled,
        providerName: flag('--provider', undefined), env: process.env,
        approve,
        log: (e) => appendFileSync(logFile, JSON.stringify(e) + '\n')
      });
      console.log(`\nAgent finished: ${result.status} after ${result.steps} step(s). ${result.summary || result.reason || ''}`);
      console.log(`(every step, model call, command and decision logged to ${logFile})`);
      if (result.status !== 'done') process.exitCode = 1;
    } finally { rl.close(); }
    return;
  }
  throw new Error(`Unknown action: ${action}`);
}
main().catch(err => { console.error(`relay: ${err.message}`); process.exitCode = 1; });
