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

AI mode proposes file edits for a plain-English task: it reads the project (skipping `.git`, `.relay`, `node_modules` and binaries), sends the snapshot plus your task to the Gemini API, prints a diff, and writes **only if you type `y`**. It needs your own Gemini API key - the free tier is enough - in an environment variable. No key is stored or hardcoded; without one, AI mode refuses before any network call.

```sh
export RELAY_GEMINI_KEY=your-own-free-key
node bin/relay.js ai --task "add a --port flag to the listener CLI" --workspace .
```

Honest limits: the project files you point it at are sent to Google's API - do not run AI mode on code you would not paste into a chatbot. Proposed paths are confined to the workspace and cannot touch `.git` or `.relay`. Every AI run - task, files considered, proposed edits and your decision - is logged to `.relay/ai.log`.

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
- `src/ai.js` - Gemini-backed edit proposals with operator approval gate
- `bin/relay.js` - CLI: init, issue, run, allow, listen, ai, demo
- `bin/relay-agent.js` - agent client: sign and POST one task
- `test/runner.test.js` - negative security cases
- `test/server.test.js` - transport: auth, allowlist, gate, replay, logging
- `test/ai.test.js` - AI mode with the API mocked; no key needed
- `docs/` - static GitHub Pages landing page

To publish the landing page, select `/docs` on the default branch under repository Settings > Pages. No API keys or build step required. The site never connects to the runner.
