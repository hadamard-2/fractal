# Claude Agent SDK transport design

## Intent

Drive Claude Code through Anthropic's Agent SDK instead of hand-built CLI flags and a hand-parsed output stream, while still running the user's own installed `claude` with the login and billing it already has. The gains are a protocol Anthropic maintains alongside the CLI, and permission prompts and questions travelling over the same pipe as everything else, which removes the local HTTP permission bridge.

The turn model does not change: one `claude` process per turn, resumed by session ID, as the [native conversation history spec](2026-09-12-native-conversation-history-and-continuation-design.md) decided. Only the transport inside a turn changes. That spec's reason for avoiding the long-lived control protocol was the cost of reproducing it; using the SDK removes that cost without taking on a long-lived session.

Out of scope for this spec: a long-lived session per conversation (one `query()` held open across turns), and with it any mid-turn control such as changing permission mode or steering while a turn runs; Codex, whose harness is unchanged; and any fallback to the current runner. If the SDK path cannot run a user's `claude`, the turn fails with a clear error and the existing version warning has already told the user they are below the tested floor.

## What exists today

`claude-runner.ts` spawns `claude --session-id|--resume <id> --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages [--mcp-config … --permission-prompt-tool …] [--model …] [--effort …] [--permission-mode …]` once per turn, writes the prompt to stdin as one stream-json user message carrying a Fractal-chosen `uuid`, closes stdin, and decodes NDJSON from stdout. It anchors the turn by finding the transcript record whose turn ID is that `uuid`, normalizes the stream through `claude-normalizer.ts`, re-reads the transcript when the process exits, and stops a turn with SIGINT then SIGTERM after two seconds. The process watchdog sends `claude` SIGINT if Fractal dies mid-turn.

Permission prompts and questions reach the UI through `claude-permission-bridge.ts`: per turn, Fractal starts a loopback HTTP server hosting an MCP tool, protected by a random bearer token, writes an MCP config file to the temp directory, and passes both to `claude` through `--mcp-config` and `--permission-prompt-tool`. The probe offers approvals and questions only when `claude --help` lists both flags.

## Findings the design rests on

Verified on 2026-10-12 against Agent SDK 0.3.296 and Claude Code 2.1.263, 2.1.291, 2.1.295 and 2.1.296, signed in with a Claude Pro plan and no API key.

- **The SDK runs any installed `claude` given `pathToClaudeCodeExecutable`.** With the SDK's own platform binary not installed, every run used the binary named and reported `apiKeySource: "none"`. The SDK has no CLI version check of its own.
- **Older CLIs work.** Against 2.1.263, 33 releases behind the version SDK 0.3.296 was built for, `canUseTool` was called and answered, and an interrupt followed by a further message in the same session succeeded.
- **`canUseTool` only sees prompts.** Commands Claude approves by itself (`echo`) never reach it; a write (`touch`) did. This matches the bridge.
- **Interrupt needs the input open.** Closing the prompt input straight after the first message made `interrupt()` fail with "Query closed before response received". Kept open, the interrupted turn ended with an `error_during_execution` result and the session continued. In one run the SDK also threw "Claude Code returned an error result" when the input closed right after an interrupted turn.
- **A caller-chosen `uuid` lands on the prompt record**, on a first turn (`--session-id`) and on a resumed one (`--resume`), through the SDK and through the raw CLI. The SDK's types document that the CLI also stamps that `uuid` as `user_message_uuid` on the turn's first reply frames; older CLIs omit it.
- **SDK sessions are ordinary transcripts.** They are written to `~/.claude/projects/` and labelled `entrypoint: "sdk-ts"` (a bare `claude -p` run is labelled `sdk-cli`). Nothing in Fractal's source reads `entrypoint`.
- **`settingSources` defaults to all sources**, matching the CLI. The SDK's documentation: "When omitted, all sources are loaded (matches CLI defaults)."
- **Questions are answered the same way as through the bridge.** `AskUserQuestion` reaches `canUseTool`; the answer is `allow` with `answers` added to the input, which is what `claude-permission-bridge.ts` already returns.
- **The SDK accepts a spawn function** (`spawnClaudeCodeProcess`), so Fractal can keep spawning `claude` itself.
- **Packaging ships only `.vite` output plus `node-pty`.** `forge.config.ts` filters everything else out of the app, so a dependency bundled into `main.js` brings none of its `node_modules` files along.
- **Billing classification is unchanged.** Anthropic's help article groups "the Claude Agent SDK, `claude -p`, and third-party apps" together; Fractal is in that group either way.

## Turn flow

The runner keeps its interface: `runClaudeTurn(options)` returns `{ events, completion, interrupt }`. The adapter changes in one place: instead of starting a bridge and passing its config path, it passes an `onRequest(request, signal)` callback (the function the bridge calls today) and the runner wires it into `canUseTool`.

For each turn the runner:

1. Builds one SDK user message, `{ type: 'user', uuid: turnId, message: { role: 'user', content }, parent_tool_use_id: null }`, with the same text and image blocks `claudeStdinMessage` builds today, and offers it through an input stream that stays open until the turn's `result` record arrives.
2. Calls `query()` with `pathToClaudeCodeExecutable` set to the user's `claude` (always), `cwd` set to the project, `resume` for an existing session or `sessionId` for a new one, `model`, `effort` and `permissionMode` when chosen, `includePartialMessages: true`, `canUseTool` from the permission module, `stderr` feeding the existing bounded and redacting diagnostic buffer, and `spawnClaudeCodeProcess` spawning `claude` with the arguments and environment the SDK supplies.
3. Registers the spawned process with the watchdog (SIGINT) and unregisters it when it exits, as today.
4. Normalizes each yielded record with the existing normalizer: `stream_event` through `normalizeClaudeStreamRecord`, `assistant` and `result` through `normalizeClaudeRecord`. Anchoring is unchanged: the runner re-reads the transcript for the `turn-started` record whose turn ID is `turnId`, publishes it first, and attributes the stream to it. `user_message_uuid` is not used; the turn ID is already known.
5. On the `result` record, closes the input. When the process exits, the runner does the final authoritative transcript re-read it does today and settles `completion` from the spawned process's exit code and signal.

**Interrupt.** `interrupt()` sends the SDK's `interrupt()` control message. A turn that Fractal interrupted ends as interrupted, whether it arrives as an `error_during_execution` result, as the SDK's "returned an error result" throw, or both; neither is reported as a failure. If the process has not exited two seconds after the interrupt, the runner sends SIGTERM to the process it spawned, as today.

**Failure.** A `claude` that cannot be launched surfaces through the existing launch-error path, so the "Couldn't find …" message is unchanged. Any other SDK error fails the turn with a sanitized message, as stdout pipe failures do today.

## Permissions

The bridge's decision logic moves to a new module, `claude-permissions.ts`, which builds the `canUseTool(toolName, input, { signal, toolUseID })` function. It keeps today's behaviour exactly:

- `AskUserQuestion` becomes a `question` request (prompt, header as field ID, choices from option labels, free text when there are no options). Only one question per call; more is denied with "Multiple questions are not supported". An answer returns `allow` with `answers` added to the input.
- `ExitPlanMode` becomes a "Review plan" approval showing the plan text, with the plan file path as its operation.
- `Bash` shows its command; other tools show a one-line summary of their command, file path, path or query.
- "Allow once" returns `allow` with the input unchanged; "deny" returns `deny` with the user's reason; anything else is denied as unsupported. Input that cannot be read is denied as an invalid permission request.
- Requests time out after 10 minutes. A request is abandoned when the SDK's `signal` fires (the turn ended or was interrupted); this replaces the bridge's HTTP client-disconnect abort. The adapter's existing cleanup still settles open requests with "Conversation run ended".
- Routing is off per kind when the probe reports no approvals or no questions, with today's denial messages.

Deleted: `claude-permission-bridge.ts` with its loopback HTTP server, bearer token, MCP server, temp MCP config file, and the `--mcp-config` and `--permission-prompt-tool` flags. Its dependencies (`@modelcontextprotocol/*`, `express`) go too, unless something else uses them.

The probe's capabilities change with it: approvals require stream-json support (no longer `--mcp-config` and `--permission-prompt-tool`), and questions additionally require `AskUserQuestion` in `claude --help`, as now.

## Dependency and packaging

- `@anthropic-ai/claude-agent-sdk` is added at an exact version, not a range. Its `package.json` names the CLI version it was built for (`claudeCodeVersion`); the pinned SDK's must be at or below `TESTED_VERSION_FLOOR.claude`. Raising the floor and updating the SDK happen together, after re-running the checks below; `version-floor.ts` says so.
- The SDK's JavaScript is bundled into `main.js` by Vite. Its native binary package is never part of the packaged app, because Forge's filter ships only `.vite` and `node-pty`. The runner always passes `pathToClaudeCodeExecutable`, so the SDK never looks for its own binary at runtime.
- Development installs still download the SDK's optional binary package. It is never used; the runner test asserting `pathToClaudeCodeExecutable` and TypeScript's checking of the options guard against it ever being used.
- The SDK is ESM-only, and its one `import.meta.url` use sits in the branch that looks for its own binary, which Fractal never takes. If it does not bundle cleanly into the main process, the fallback is to mark it external in `vite.main.config.ts` and add it, without its platform binary package, to the packaging filter.

## History and idle detection

Unchanged. SDK sessions are written where the history reader already looks, and nothing in Fractal depends on the `sdk-ts` label. Sessions started before the switch continue through the SDK as ordinary resumes by session ID. Idle detection keeps its three inputs: the owned-process registry (claimed for each turn, as now), `claude agents --json`, and transcript growth.

As today, a user's `claude --continue` in a terminal skips Fractal's sessions (it skips `-p` and SDK sessions); `claude --resume <id>` opens them.

## Testing

**Unit tests (the default `pnpm test`).** The runner takes its SDK `query` function as an injectable dependency, the way it takes a spawn function today, and tests feed it hand-written records of the shapes the SDK yields. Today's runner tests for normalization, anchoring by turn ID, the final re-read, interrupt timing, stderr redaction and the watchdog carry over; the tests of Fractal's own NDJSON decoding (malformed and partial lines) are removed with that code. New runner tests cover: the options given to `query` (user's `claude` always set; `resume` or `sessionId`; model, effort, permission mode, partial messages); the prompt's `uuid`; an interrupted turn ending as interrupted, not failed, through either the error result or the throw; and the spawn function registering the process with the watchdog. The bridge's decision tests move to `claude-permissions.test.ts` with literal inputs; its HTTP tests are deleted. The probe's capability tests are updated.

**Manual smoke test.** The Claude procedure in `docs/testing/native-conversation-interoperability.md` is updated for the SDK path and gains steps for interrupt then continue, a conversation started before the switch continued after it, and two turns with identical text attributed to the right turns. It stays opt-in because it uses the operator's login and plan usage.

**Before the implementation is called done.** Run `pnpm package`, confirm no `claude` binary anywhere in `out/`, and complete a Claude turn from the packaged app. Repeat the Electron crash and normal-quit checks from the process watchdog work, since `claude` is now spawned through the SDK's hook. Run the full suite, typecheck and lint.

Not tested here: the SDK's own protocol handling, which the manual smoke test exercises end to end where it touches Fractal.

## Risks

- **SDK and CLI version drift.** A pinned SDK talks to whatever `claude` the user has. The checks above passed across 33 releases, but a protocol change could break turns for users above or below the tested range. The version floor warns users below it; users above it are covered only by re-running the checks on SDK updates.
- **Interrupt edge cases.** The spike saw the SDK throw after an interrupted turn once. The runner treats every error after a Fractal-initiated interrupt as an interruption, which could hide a genuine failure that happens to coincide with a stop.
- **Policy.** Unchanged from today. Fractal runs the user's unmodified binary with the user's own sign-in, which Claude Code's legal and compliance page allows, and offers no login of its own. The SDK documentation's note that third-party products may not offer claude.ai login or rate limits without approval is the same grey area Fractal already accepted (see AGENTS.md); using the SDK neither resolves nor worsens it.
