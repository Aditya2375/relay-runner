import { createServer } from 'node:http';
import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { verify } from './protocol.js';
import { execute } from './runner.js';

// Sender names double as filenames under .relay/senders. Keep them boring.
export const SENDER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_BODY = 8192;

export function senderKeyPath(stateDir, sender) {
  if (typeof sender !== 'string' || !SENDER_NAME.test(sender)) throw new Error('Unknown sender');
  const dir = resolve(stateDir, 'senders');
  const file = resolve(dir, `${sender}.key`);
  if (file !== join(dir, `${sender}.key`) || !file.startsWith(dir + sep)) throw new Error('Unknown sender');
  return file;
}

// Register a sender on the allowlist. Each sender gets its own key; the
// operator hands the key file to that agent out of band. Never overwrites.
export async function addSender(stateDir, sender) {
  await mkdir(join(stateDir, 'senders'), { recursive: true, mode: 0o700 });
  const file = senderKeyPath(stateDir, sender);
  let handle;
  try { handle = await open(file, 'wx', 0o600); }
  catch (err) { if (err.code === 'EEXIST') return file; throw err; }
  try {
    const { randomBytes } = await import('node:crypto');
    await handle.writeFile(randomBytes(32));
  } finally { await handle.close(); }
  return file;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// One route: POST /jobs with { sender, job }. Every request and every
// decision lands in the run log as one JSON line, accepted or not.
export function createRelayServer({ stateDir, workspace, enableCommands = false, logFile }) {
  async function log(entry) {
    await appendFile(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  }
  return createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj) + '\n');
    };
    if (req.method !== 'POST' || req.url !== '/jobs') {
      await log({ decision: 'rejected', reason: 'not_found', method: req.method });
      return send(404, { ok: false, error: 'Not found' });
    }
    let envelope;
    try { envelope = JSON.parse(await readBody(req)); }
    catch {
      await log({ decision: 'rejected', reason: 'bad_request' });
      return send(400, { ok: false, error: 'Bad request' });
    }
    const sender = envelope && typeof envelope === 'object' ? envelope.sender : null;
    const job = envelope && typeof envelope === 'object' ? envelope.job : null;
    const base = {
      sender: typeof sender === 'string' ? sender : null,
      task: job && typeof job === 'object' ? job.task ?? null : null,
      jobId: job && typeof job === 'object' ? job.id ?? null : null
    };
    let key;
    try { key = await readFile(senderKeyPath(stateDir, sender)); }
    catch {
      await log({ ...base, decision: 'rejected', reason: 'unknown_sender' });
      return send(403, { ok: false, error: 'Unknown sender' });
    }
    if (!verify(job, key)) {
      await log({ ...base, decision: 'rejected', reason: 'signature_rejected' });
      return send(403, { ok: false, error: 'Signature, task, or timestamp rejected' });
    }
    try {
      const result = await execute(job, { stateDir, workspace, enableCommands, key });
      await log({ ...base, decision: 'accepted' });
      return send(200, { ok: true, result });
    } catch (err) {
      await log({ ...base, decision: 'rejected', reason: err.message });
      return send(/off/.test(err.message) ? 403 : 409, { ok: false, error: err.message });
    }
  });
}
