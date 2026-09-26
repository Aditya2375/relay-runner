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

`issue` is the mock agent side. In a real pairing, a trusted agent would sign an envelope and transfer it to this machine. That transport is deliberately **not implemented** here. Keep `--home` on a private local directory; `init` creates `.relay/secret` with mode 0600 and never overwrites it. Each job must be consumed within two minutes. `issue` writes a new file only and refuses to overwrite one. `run` takes a JSON file, and writes only the fixed private notes file for `notes.append`.

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

## Security model

A naive "agent sends commands to a bot on your laptop" is a command-and-control channel: whoever controls that agent or endpoint can run programs, read files and keep access. A prompt alone cannot make it safe. Relay Runner does **not** expose a remote endpoint, poll an instruction server, or accept arbitrary shell commands. The demo is self-contained.

- **Authentication:** HMAC-SHA256 signs each task. The key stays on the machine in a private `.relay` directory. A malformed, modified, expired or incorrectly signed envelope is rejected.
- **Small authority:** Tasks are named, arguments are validated, and there is no path supplied by the agent. `workspace.list` returns only up to 50 top-level names, not file contents. `notes.append` writes one fixed file, refuses symlinks, and caps text at 500 characters.
- **Operator gate:** Command mode is off by default. `--enable-commands` permits *one fixed command template*, `node --version`, not a shell or arbitrary executable. Expanding this registry means reviewing code and granting more capability on purpose. Shell execution is not supported, even when command mode is enabled.
- **Replay and freshness:** Jobs expire after two minutes. A nonce file is reserved before execution, so the same job cannot be executed twice. If the process crashes after reservation, that job is lost rather than retried.

This is a **teaching prototype**, not a production sandbox. The HMAC key is a shared secret: any process running as the same OS user that can read the key can impersonate the mock agent. It does not protect against a compromised user account, malicious repository code, compromised Node runtime, or a malicious operator. Directory permissions do not isolate processes sharing a user ID, and Unix permissions may behave differently on Windows. Do not pair an untrusted remote model or accept internet-submitted jobs with this sample. Before real deployment, use distinct OS identities, authenticated pairing and key rotation, a reviewed job transport, isolated workers, per-task consent for meaningful effects, resource limits, audit logs and tests for your target OS.

## Layout

- `src/protocol.js` - signing and envelope validation
- `src/runner.js` - allowlisted dispatch and command gate
- `bin/relay.js` - mock agent, CLI and end-to-end demo
- `test/runner.test.js` - negative security cases
- `docs/` - static GitHub Pages landing page

To publish the landing page, select `/docs` on the default branch under repository Settings > Pages. No API keys or build step required. The site never connects to the runner.
