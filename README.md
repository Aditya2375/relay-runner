# Relay Runner

A small, local execution loop for AI workflows. The mock agent signs a task envelope; the runner checks the signature, freshness and replay ID, then dispatches a named task. No account, daemon or network listener needed for the demo.

```sh
npm run demo
npm test
```

Requires Node.js 20+. No dependencies. `npm run demo` creates a temporary home directory, signs four jobs and runs them locally. The first command job is denied; the second succeeds only after the operator enables command mode. Nothing is sent to an external service.

## Try the pieces separately

```sh
node bin/relay.js init --home ./sandbox
node bin/relay.js issue system.summary --home ./sandbox --out ./sandbox/summary.json
node bin/relay.js run ./sandbox/summary.json --home ./sandbox
node bin/relay.js issue notes.append --home ./sandbox --text 'Remember to review the diff' --out ./sandbox/note.json
node bin/relay.js run ./sandbox/note.json --home ./sandbox
```

`issue` is the mock agent side, writing signed envelopes to files. For a real two-process pairing, use the listener and agent client below. Keep `--home` on a private local directory; `init` creates `.relay/secret` with mode 0600 and never overwrites it. Each job must be consumed within two minutes. `issue` writes a new file only and refuses to overwrite one. `run` takes a JSON file, and writes only the fixed private notes file for `notes.append`.

### The wire shape

```json
{
  "v": 1,
  "id": "32 lowercase hex characters",
  "issuedAt": 1790000000000,
  "task": "system.summary",
  "args": {},
  "signature": "HMAC-SHA256 hex"
}
```

HMAC covers the ordered JSON fields `v`, `id`, `issuedAt`, `task`, `args`. Unknown top-level fields fail validation. See `src/protocol.js` for the exact canonicalization. Task names are `system.summary`, `workspace.list`, `notes.append`, and `command.node-version`. The workspace root comes from the operator, never the signed instruction. The sole command template is the current Node executable with `--version`, with no shell or variable arguments.

## Talk to it over localhost HTTP

The listener is a real transport: an agent process signs a task and posts it to the runner over loopback HTTP. It binds **127.0.0.1 only** - no remote endpoint - and runs only while the operator keeps it in the foreground.

```sh
node bin/relay.js allow my-agent --home ./sandbox   # one key per sender, printed once
node bin/relay.js listen --home ./sandbox --port 7373
node bin/relay-agent.js system.summary --sender my-agent --key-file ./sandbox/.relay/senders/my-agent.key
```

Each sender gets its own key under `.relay/senders/`; unknown senders, bad signatures, stale jobs and replays are rejected before dispatch. Command mode stays off unless the operator passes `--enable-commands` at startup. Every request and every decision - accepted or rejected, with the reason - is appended as one JSON line to `.relay/run.log`.

## AI mode (bring your own key)

AI mode proposes file edits for a plain-English task: it reads the project (skipping `.git`, `.relay`, `node_modules` and binaries), sends the snapshot plus your task to the provider you choose, prints a diff, and writes **only if you type `y`**. No key is stored or hardcoded; without one, AI mode refuses before any network call and names the variable it needs.

Pick a provider with `--provider` (or `RELAY_AI_PROVIDER`):

| Provider | Key variable | Cost, honestly |
| --- | --- | --- |
| `gemini` (default) | `RELAY_GEMINI_KEY` from [aistudio.google.com](https://aistudio.google.com) | **Free tier available** - the zero-cost path |
| `anthropic` | `RELAY_ANTHROPIC_KEY` from [console.anthropic.com](https://console.anthropic.com) | **Pay-per-token. There is no free tier.** |
| `openai` | `RELAY_OPENAI_KEY`, optional `RELAY_OPENAI_BASE_URL` | OpenAI and OpenRouter are paid; a local [Ollama](https://ollama.com) (`RELAY_OPENAI_BASE_URL=http://localhost:11434/v1`) is free and needs no key |

Override the model with `RELAY_AI_MODEL` (or per provider, e.g. `RELAY_GEMINI_MODEL`).

```sh
export RELAY_GEMINI_KEY=your-own-free-key
node bin/relay.js ai --task "add a --port flag to the listener CLI" --workspace .
node bin/relay.js ai --provider anthropic --task "..." --workspace .
```

Honest limits: the project files you point it at are sent to that provider's API - do not run AI mode on code you would not paste into a chatbot (the Ollama path keeps everything on your machine). Proposed paths are confined to the workspace and cannot touch `.git` or `.relay`. Every AI run - provider, model, task, files considered, proposed edits and your decision - is logged to `.relay/ai.log`.


## Agent mode (multi-step loop)

Agent mode runs a full plan-act-check loop with the provider you select: the model picks the next step as strict JSON (`read_file`, `write_file`, `run_command`, `done`), the runner executes it, feeds the result (file contents, exit codes, test output) back, and the model continues until it declares the task done or the step cap stops it.

```sh
node bin/relay.js agent --task "fix the failing test in this project" --workspace . --enable-commands
```

The gates, always:

- **Every file write** shows the current and proposed content and waits for your `y`. Answer `a` to allow writes for the rest of that run.
- **Every shell command** needs the same approval, *and* command execution must be enabled at startup with `--enable-commands` - the same opt-in posture as the transport's command mode. Without it, a model that asks for a command halts the run instead of running anything.
- **Paths are confined to the workspace.** A model reply that tries to write outside it is refused.
- **Step cap** (default 12, `--max-steps`) stops runaway loops.
- **Everything is logged.** Every step, model request and response, approval decision, command and exit code lands in `.relay/agent.log` as JSON lines.

The loop is model-agnostic: it uses the same provider layer as AI mode (`--provider gemini|anthropic|openai`, same env vars), driving whichever provider through one strict JSON action protocol, so Gemini's JSON mode, Claude and any OpenAI-compatible endpoint (OpenRouter, Ollama) all work. A mocked-provider demo of the loop fixing a seeded bug end to end - inspect, mis-fix, run, read the failure, fix, re-run, done - is in [docs/agent-demo-transcript.txt](docs/agent-demo-transcript.txt) (`node scripts/demo-agent.js`).

What the loop **cannot** do yet, honestly:

- It uses a structured JSON action protocol over plain completions, not each provider's native tool/function-calling API; the provider seam (`complete()` in `src/providers.js`) is where native adapters would plug in.
- One file at a time per step, whole-file writes only - no partial patches, so large files are expensive and small models struggle with them.
- No memory between runs and no parallel steps; each run starts from the task and the workspace listing.
- Approval is a person at a keyboard. `--yes`-style unattended runs exist for AI mode's single diff, but agent mode always asks - that is deliberate.
- Free-tier and local models frequently produce invalid JSON or give up early. The loop feeds parse errors back and retries, but a weak model can burn the step cap without finishing.

## Use it from any chat AI (bridge)

Web chat AIs - ChatGPT, Claude, Gemini in a browser - cannot reach your machine, and they never see your key. The bridge is the honest transport between them and the runner:

```sh
node bin/relay.js bridge --prompt   # prints the connector prompt; paste it into the chat
# the AI replies with one JSON job request
node bin/relay.js bridge            # paste the reply, then Ctrl-D (Ctrl+Z, Enter on Windows)
# Relay Runner shows exactly what the AI asked for. You type y, or nothing happens.
```

Your approval **is** the verification: the job is signed locally only after you type `y`, so the signature attests your decision at your keyboard, never the AI's identity. The bridge exposes the same four registered tasks as the listener (`system.summary`, `workspace.list`, `notes.append`, and `command.node-version` when started with `--enable-commands`) - nothing free-form. For open-ended work use agent mode in the terminal with your own provider key. The same prompt lives in [docs/connector-prompt.txt](docs/connector-prompt.txt).

Honest limits: a web AI cannot trigger anything by itself - every job is carried by you and approved by you. Results can be pasted back into the chat so the AI can react to them. Desktop agent clients that support MCP are the cleaner long-term interface; the bridge is the one that works with every chat AI today.

## Security model

A naive "agent sends commands to a bot on your laptop" is a command-and-control channel: whoever controls that agent or endpoint can run programs, read files and keep access. A prompt alone cannot make it safe. Relay Runner exposes no **remote** endpoint: the optional listener binds loopback only, authenticates each sender with its own HMAC key, and accepts no arbitrary shell commands. The demo remains fully self-contained and network-free.

- **Authentication:** HMAC-SHA256 signs each task. The key stays on the machine in a private `.relay` directory. A malformed, modified, expired or incorrectly signed envelope is rejected.
- **Small authority:** Tasks are named, arguments are validated, and there is no path supplied by the agent. `workspace.list` returns only up to 50 top-level names, not file contents. `notes.append` writes one fixed file, refuses symlinks, and caps text at 500 characters.
- **Operator gate:** Command mode is off by default. `--enable-commands` permits *one fixed command template*, `node --version`, not a shell or arbitrary executable. Expanding this registry means reviewing code and granting more capability on purpose. Shell execution is not supported, even when command mode is enabled.
- **Replay and freshness:** Jobs expire after two minutes. A nonce file is reserved before execution, so the same job cannot be executed twice. If the process crashes after reservation, that job is lost rather than retried.

This is a **teaching prototype**, not a production sandbox. The HMAC key is a shared secret: any process running as the same OS user that can read the key can impersonate the mock agent. It does not protect against a compromised user account, malicious repository code, compromised Node runtime, or a malicious operator. Directory permissions do not isolate processes sharing a user ID, and Unix permissions may behave differently on Windows. Do not pair an untrusted remote model or accept internet-submitted jobs with this sample. Before real deployment, use distinct OS identities, authenticated pairing and key rotation, a reviewed job transport, isolated workers, per-task consent for meaningful effects, resource limits, audit logs and tests for your target OS.

## Layout

- `src/protocol.js` - signing and envelope validation
- `src/runner.js` - allowlisted dispatch and command gate
- `src/server.js` - loopback listener, sender allowlist, run log
- `src/ai.js` - edit proposals with operator approval gate
- `src/providers.js` - provider abstraction (Gemini, Anthropic, OpenAI-compatible)
- `bin/relay.js` - CLI: init, issue, run, allow, listen, ai, demo
- `bin/relay-agent.js` - agent client: sign and POST one task
- `test/runner.test.js` - negative security cases
- `test/server.test.js` - transport: auth, allowlist, gate, replay, logging
- `test/ai.test.js` - AI mode with the API mocked; no key needed
- `test/providers.test.js` - provider selection, request shapes, key rules
- `docs/` - static GitHub Pages landing page

To publish the landing page, select `/docs` on the default branch under repository Settings > Pages. No API keys or build step required. The site never connects to the runner.
