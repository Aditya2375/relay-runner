// Multi-step agent loop. Given a task, the runner asks the selected model
// provider for the next action as strict JSON, executes it under operator
// gates, feeds the result back, and repeats until the model says done or
// the step cap hits. Writes and shell commands need explicit approval;
// commands additionally need execEnabled at startup. Everything lands in
// an append-only JSONL run log.

import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { resolveProvider, complete } from './providers.js';

const ACTIONS = ['read_file', 'write_file', 'run_command', 'done'];

function safeJoin(workspace, p) {
  const abs = path.resolve(workspace, String(p || ''));
  if (abs !== workspace && !abs.startsWith(workspace + path.sep)) {
    throw new Error(`path escapes the workspace: ${p}`);
  }
  return abs;
}

function parseAction(text) {
  const cleaned = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('model reply contained no JSON action');
  const a = JSON.parse(cleaned.slice(start, end + 1));
  if (!ACTIONS.includes(a.action)) throw new Error(`unknown action "${a.action}"`);
  return a;
}

function buildPrompt({ task, history, workspaceListing }) {
  return [
    'You are the planner inside Relay Runner, a local task runner. You complete the user task one small step at a time.',
    'Reply with EXACTLY one JSON object and no other text, choosing one action:',
    '{"action":"read_file","path":"relative/path"} - read a workspace file (result comes back to you)',
    '{"action":"write_file","path":"relative/path","content":"full new file content"} - create or replace a file (the operator reviews a diff first)',
    '{"action":"run_command","command":"shell command"} - run a shell command in the workspace (operator approval; only if commands are enabled)',
    '{"action":"done","summary":"what was accomplished"} - only when the task is genuinely complete and verified',
    'Rules: stay inside the workspace. Prefer small verifiable steps. After changing code, run the project\'s tests or the relevant command and read the output before deciding you are done. If a command fails, fix the cause and retry.',
    `Workspace top level: ${workspaceListing}`,
    `Task: ${task}`,
    history.length ? `Steps so far (oldest first):\n${history.join('\n')}` : 'No steps taken yet.'
  ].join('\n\n');
}

function runShell(command, cwd, timeoutMs = 60000) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout).slice(0, 8000),
        stderr: String(stderr).slice(0, 8000)
      });
    });
  });
}

export async function runAgentLoop({
  task,
  workspace,
  providerName,
  model,
  env = process.env,
  fetchImpl,
  maxSteps = 12,
  execEnabled = false,
  approve = async () => false, // caller must supply a real gate; default denies everything
  log = null,                  // optional (event) => void, receives every loop event
  completeImpl = complete      // seam for tests
}) {
  const ws = path.resolve(workspace);
  const { provider, key, baseUrl, model: resolvedModel, name } = resolveProvider({ provider: providerName, model, env });
  const emit = (event) => { if (log) log({ ts: new Date().toISOString(), ...event }); };
  const history = [];
  emit({ type: 'start', task, provider: name, model: resolvedModel, workspace: ws, maxSteps, execEnabled });

  for (let step = 1; step <= maxSteps; step++) {
    let listing = '(unreadable)';
    try { listing = fs.readdirSync(ws).slice(0, 50).join(', '); } catch {}
    const prompt = buildPrompt({ task, history, workspaceListing: listing });
    emit({ type: 'model_request', step, promptBytes: prompt.length });
    const raw = await completeImpl({ prompt, provider, model: resolvedModel, key, baseUrl, fetchImpl });
    emit({ type: 'model_response', step, bytes: raw.length });

    let action;
    try {
      action = parseAction(raw);
    } catch (err) {
      emit({ type: 'parse_error', step, error: err.message });
      history.push(`step ${step}: your reply was not valid JSON (${err.message}); answer with exactly one JSON object`);
      continue;
    }
    emit({ type: 'action', step, action: action.action, path: action.path, command: action.command, rationale: action.rationale });

    if (action.action === 'done') {
      emit({ type: 'done', step, summary: action.summary || '' });
      return { status: 'done', steps: step, summary: action.summary || '', provider: name, model: resolvedModel };
    }

    if (action.action === 'read_file') {
      let note;
      try {
        const abs = safeJoin(ws, action.path);
        const content = fs.readFileSync(abs, 'utf8');
        note = `read_file ${action.path}: ok (${content.length} chars)\n---\n${content.slice(0, 6000)}`;
        emit({ type: 'read_file', step, path: action.path, ok: true });
      } catch (err) {
        note = `read_file ${action.path}: failed: ${err.message}`;
        emit({ type: 'read_file', step, path: action.path, ok: false, error: err.message });
      }
      history.push(`step ${step}: ${note}`);
      continue;
    }

    if (action.action === 'write_file') {
      let abs;
      try { abs = safeJoin(ws, action.path); } catch (err) {
        history.push(`step ${step}: write_file ${action.path}: refused: ${err.message}`);
        emit({ type: 'write_file', step, path: action.path, ok: false, error: err.message });
        continue;
      }
      const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
      const decision = await approve({ kind: 'write_file', path: action.path, before, after: String(action.content ?? ''), step });
      emit({ type: 'approval', step, kind: 'write_file', path: action.path, approved: Boolean(decision) });
      if (!decision) {
        emit({ type: 'halt', step, reason: `operator denied write to ${action.path}` });
        return { status: 'halted', steps: step, reason: `operator denied write to ${action.path}`, provider: name, model: resolvedModel };
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(action.content ?? ''));
      emit({ type: 'write_file', step, path: action.path, ok: true, bytes: String(action.content ?? '').length });
      history.push(`step ${step}: write_file ${action.path}: applied after operator approval`);
      continue;
    }

    if (action.action === 'run_command') {
      if (!execEnabled) {
        emit({ type: 'halt', step, reason: 'command requested but command mode is not enabled at startup' });
        return { status: 'halted', steps: step, reason: 'model asked to run a command but the operator did not enable command mode (--enable-commands)', provider: name, model: resolvedModel };
      }
      const decision = await approve({ kind: 'run_command', command: action.command, step });
      emit({ type: 'approval', step, kind: 'run_command', command: action.command, approved: Boolean(decision) });
      if (!decision) {
        emit({ type: 'halt', step, reason: `operator denied command: ${action.command}` });
        return { status: 'halted', steps: step, reason: `operator denied command: ${action.command}`, provider: name, model: resolvedModel };
      }
      const result = await runShell(String(action.command), ws);
      emit({ type: 'run_command', step, command: action.command, code: result.code });
      history.push(`step ${step}: run_command \`${action.command}\` exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      continue;
    }
  }
  emit({ type: 'halt', reason: `step cap ${maxSteps} reached` });
  return { status: 'step_cap', steps: maxSteps, reason: `step cap ${maxSteps} reached before the model declared done`, provider: name, model: resolvedModel };
}
