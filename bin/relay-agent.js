#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { makeJob, TASKS } from '../src/protocol.js';

const [task, ...flags] = process.argv.slice(2);
function flag(name, fallback) { const i = flags.indexOf(name); return i < 0 ? fallback : flags[i + 1]; }
function usage() {
  console.log(`Relay Runner agent client - sign and send one task to a running listener

  node bin/relay-agent.js TASK --sender NAME --key-file FILE [--url URL] [--text NOTE]

Tasks: ${TASKS.join(', ')}
The key file is the sender key the operator created with: relay.js allow NAME`);
}
async function main() {
  if (!task || !TASKS.includes(task)) { usage(); process.exitCode = 1; return; }
  const sender = flag('--sender');
  const keyFile = flag('--key-file');
  if (!sender || !keyFile) { usage(); process.exitCode = 1; return; }
  const url = flag('--url', 'http://127.0.0.1:7373');
  const args = task === 'notes.append' ? { text: flag('--text', '') } : {};
  const key = await readFile(keyFile);
  const job = makeJob(task, args, key);
  const res = await fetch(`${url}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sender, job }),
    signal: AbortSignal.timeout(5000)
  });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok || !body.ok) process.exitCode = 1;
}
main().catch(err => { console.error(`relay-agent: ${err.message}`); process.exitCode = 1; });
