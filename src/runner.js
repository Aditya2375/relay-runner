import { mkdir, open, readFile, readdir, realpath, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { hostname, platform, arch, release } from 'node:os';
import { verify } from './protocol.js';

function exactArgs(args, keys) {
  if (Object.keys(args).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Invalid task arguments');
}
function runVersion() {
  return new Promise((resolvePromise, reject) => {
    // The only command template: fixed executable, fixed argument vector, no shell.
    const child = spawn(process.execPath, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
    let out = '';
    child.stdout.on('data', b => { out += b.toString(); if (out.length > 1024) child.kill(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolvePromise(out.trim()) : reject(new Error('Version command failed')));
  });
}

export async function execute(job, { stateDir, workspace, enableCommands = false, now = Date.now() }) {
  const key = await readFile(join(stateDir, 'secret'));
  if (!verify(job, key, now)) throw new Error('Signature, task, or timestamp rejected');
  const nonceDir = join(stateDir, 'seen');
  await mkdir(nonceDir, { recursive: true, mode: 0o700 });
  // Reserve before execution. Crash means no retry; duplication is more dangerous than a missed job.
  let nonce;
  try { nonce = await open(join(nonceDir, job.id), 'wx', 0o600); }
  catch (err) { if (err.code === 'EEXIST') throw new Error('Replay rejected'); throw err; }
  await nonce.close();
  switch (job.task) {
    case 'system.summary':
      exactArgs(job.args, []);
      return { host: hostname(), platform: platform(), arch: arch(), release: release(), node: process.version };
    case 'workspace.list': {
      exactArgs(job.args, []);
      // Workspace is fixed by the operator. Do not accept paths from an agent.
      const root = await realpath(workspace);
      const items = await readdir(root, { withFileTypes: true });
      return { workspace: root, entries: items.filter(e => !e.name.startsWith('.')).slice(0, 50)
        .map(e => ({ name: e.name, type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'other' })) };
    }
    case 'notes.append': {
      exactArgs(job.args, ['text']);
      const text = job.args.text;
      if (typeof text !== 'string' || !text.trim() || text.length > 500 || /[\x00-\x08\x0b-\x1f]/.test(text)) throw new Error('Note must be 1-500 printable characters');
      const file = join(stateDir, 'notes.txt');
      // State dir is created by operator as private, not a user-specified path.
      const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(text.replace(/\r?\n/g, ' ') + '\n'); } finally { await handle.close(); }
      return { savedTo: file, characters: text.length };
    }
    case 'command.node-version':
      exactArgs(job.args, []);
      if (!enableCommands) throw new Error('Command mode is off; operator must pass --enable-commands');
      return { stdout: await runVersion() };
    default: throw new Error('Unknown task');
  }
}

export async function init(base) {
  const stateDir = resolve(base, '.relay');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const secret = join(stateDir, 'secret');
  let handle;
  try { handle = await open(secret, 'wx', 0o600); }
  catch (err) { if (err.code !== 'EEXIST') throw err; return stateDir; }
  try {
    const { randomBytes } = await import('node:crypto');
    await handle.writeFile(randomBytes(32));
  } finally { await handle.close(); }
  return stateDir;
}
