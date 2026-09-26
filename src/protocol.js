import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TASKS = Object.freeze(['system.summary', 'workspace.list', 'notes.append', 'command.node-version']);
export const MAX_AGE_MS = 120_000;

// Fixed field order is the wire format. Both sides use this function, not arbitrary JSON order.
export function payload(job) {
  return JSON.stringify({ v: job.v, id: job.id, issuedAt: job.issuedAt, task: job.task, args: job.args });
}
export function sign(job, key) {
  return createHmac('sha256', key).update(payload(job)).digest('hex');
}
export function makeJob(task, args, key, now = Date.now()) {
  const job = { v: 1, id: randomBytes(16).toString('hex'), issuedAt: now, task, args };
  return { ...job, signature: sign(job, key) };
}
export function verify(job, key, now = Date.now()) {
  if (!job || typeof job !== 'object' || Array.isArray(job) ||
      Object.keys(job).sort().join(',') !== 'args,id,issuedAt,signature,task,v' ||
      job.v !== 1 || typeof job.id !== 'string' || !/^[a-f0-9]{32}$/.test(job.id) ||
      !Number.isSafeInteger(job.issuedAt) || Math.abs(now - job.issuedAt) > MAX_AGE_MS ||
      !TASKS.includes(job.task) || !job.args || typeof job.args !== 'object' ||
      Array.isArray(job.args) || typeof job.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(job.signature)) return false;
  const expected = Buffer.from(sign(job, key), 'hex');
  return timingSafeEqual(expected, Buffer.from(job.signature, 'hex'));
}
