# Native conversation history and continuation — design

**Date:** 2026-09-12
**Status:** Approved for planning
**Scope:** Execute mode's conversation history and conversation panel for native Codex and Claude Code sessions. Covers discovery, identity, transcript normalization and rendering, continuation transports, runtime ownership, approvals, recovery, and verification. It does not design Map mode or Explain mode themselves.

## Why this exists

Fractal begins as a better desktop interface for coding-agent harnesses. Its first conversation experience therefore must not behave like an ordinary chat client that happens to display tool badges. Codex and Claude Code conversations are records of work: agents inspect files, run commands, edit code, delegate to subagents, request approval, recover from errors, and only intermittently explain what they are doing.

The first slice must do two things well:

1. Discover and render conversations that were created outside Fractal by Codex or Claude Code.
2. Continue those same native conversations through their original harnesses.

Codex and Claude Code remain the source of truth. Fractal is a view and control surface over their sessions, not a transcript importer and not a replacement agent runtime. This keeps the commodity Execute experience focused while leaving Fractal's product effort for Map and Explain.

## Relationship to the earlier Execute-mode contract

This design supersedes the ownership and persistence decisions in [the 2026-08-21 Execute-mode IPC design](./2026-08-21-execute-mode-ipc-message-shape-design.md):

- A conversation is no longer primarily a Fractal-minted UUID. Its authoritative identity is the provider plus the provider's native session ID and project path.
- Fractal's JSON conversation store is no longer authoritative and is not used as a parallel transcript store.
- A native harness, rather than Fractal's session manager, owns durable conversation history.
- Renderer events remain normalized and sequenced, but they are a projection over native history and live provider events.

The earlier design's useful boundaries remain: `contextIsolation` stays enabled, the renderer uses a hand-written preload surface, tool work is typed and ordered, unknown work degrades rather than disappears, and the main process owns native process and filesystem access.

## Goals

- Group Codex and Claude Code sessions together by project.
- Render prose and agent actions in their original order.
- Keep completed work compact without discarding detail.
- Load large histories progressively and without blocking the renderer.
- Continue an externally-created session through its native harness.
- Reflect the continuation in the same native transcript so the original CLI can resume it later.
- Surface approvals and agent questions as first-class blocking states.
- Prevent simultaneous Fractal and external writers to one session.
- Preserve provider provenance and unsupported events so normalization failures are visible.
- Provide stable references that Map mode can later arrange and Explain mode can later cite.

## Non-goals for the first slice

- Fractal-owned transcript persistence or transcript import/export.
- Full-transcript search or a SQLite conversation index.
- Conversation renaming, deletion, or archival.
- Attachments and multimodal prompts.
- Branching or forking sessions.
- Steering a Claude turn while it is running.
- Recreating native authentication or reading provider credential files.
- A provider-independent promise that every capability is available everywhere.
- Designing Map or Explain UI.

## Decisions locked during brainstorming

- **Native continuity.** Codex and Claude Code sessions stay native and interchangeable with their original tools.
- **Project-first history.** A canonical project path groups sessions from both providers. Provider provenance is quiet row metadata, not the top-level hierarchy.
- **Thin provider adapters.** Provider-specific discovery, parsing, lifecycle, and continuation sit behind a shared adapter boundary.
- **No first-slice database.** Discover lightweight native metadata at startup and load full transcripts on demand.
- **Agentic transcript.** Assistant prose is visually primary; ordered actions form inline work packets.
- **Active open, completed compact.** The active work packet is expanded. Completed packets collapse to summaries while retaining expandable details.
- **Single writer.** Externally active sessions may update live in read-only mode. Fractal enables continuation only when the session is idle or when Fractal owns the run.
- **Provider-native transports.** Codex uses its App Server. Claude uses the user's unmodified Claude Code CLI and native JSONL transcripts.
- **Claude first-slice lifecycle.** One safely spawned Claude process handles one turn. Later turns resume the same native session rather than depending on a private long-lived process protocol.
- **Fail closed.** Approval plumbing never falls back to bypassing permissions.

## Architecture overview

```text
Codex App Server                    ~/.claude/projects/**/*.jsonl
       |                                          |
       +----------------+  +----------------------+
                        v  v
                 Provider adapters
              discover / read / watch / run
                        |
                 normalized event ledger
                        |
          turn projection + inline work packets
                        |
           validated preload conversation API
                        |
        project-first history + conversation panel
```

Native history is authoritative. The normalized ledger is an in-memory representation used to make two different provider vocabularies render consistently. The UI projection may group events for readability, but it never changes native order or writes its projection back into provider files.

## Conversation identity

```ts
type ProviderId = 'codex' | 'claude';

interface ConversationRef {
  provider: ProviderId;
  nativeSessionId: string;
  projectPath: string;
}
```

`projectPath` is canonicalized in the main process. A stable renderer key may be derived as `${provider}:${nativeSessionId}`, but that key is not a second source of identity.

A lightweight sidebar descriptor is separate from a loaded conversation:

```ts
interface ConversationSummary {
  ref: ConversationRef;
  title: string;
  updatedAt: number;
  createdAt?: number;
  runtime: ConversationRuntime;
}
```

Titles come from provider metadata where available, otherwise from the first meaningful user prompt. Fractal does not generate or persist replacement titles in this slice.

## Provider adapter boundary

```ts
interface HarnessAdapter {
  readonly provider: ProviderId;

  probe(): Promise<HarnessStatus>;
  capabilities(): HarnessCapabilities;
  listConversations(projectPath: string): Promise<ConversationSummary[]>;
  loadConversation(
    ref: ConversationRef,
    sink: NativeEventSink,
  ): Promise<LoadedConversation>;
  watchConversation(
    ref: ConversationRef,
    sink: NativeEventSink,
  ): Unsubscribe;
  createConversation(input: StartConversationInput): Promise<ConversationRef>;
  continueConversation(
    ref: ConversationRef,
    prompt: PromptInput,
  ): Promise<ConversationRun>;
}

interface ConversationRun {
  readonly events: AsyncIterable<NativeEvent>;
  interrupt(): Promise<void>;
  resolveRequest?(decision: UserDecision): Promise<void>;
  dispose(): Promise<void>;
}

interface HarnessCapabilities {
  partialStreaming: boolean;
  approvals: boolean;
  questions: boolean;
  interrupt: boolean;
  steerWhileRunning: boolean;
  fork: boolean;
}
```

Capabilities are reported rather than inferred in the renderer. Codex may expose App Server steering, for example, without forcing the Claude adapter to pretend it can do the same thing.

## Native provider integrations

### Codex

Fractal starts and owns a persistent `codex app-server` subprocess in the Electron main process and communicates over its documented JSON-RPC protocol. The first implementation uses the stable API surface only:

- `thread/list` for discovery.
- `thread/read` to load history.
- `thread/resume` before continuing a native thread.
- `turn/start` to send a prompt.
- item and delta notifications for live rendering.
- server-initiated approval requests for decisions.
- `turn/interrupt` for cancellation.
- thread and turn status notifications for runtime ownership.

If the App Server disconnects, the adapter reconnects, rereads the thread, reconciles by native item identity, and only then re-enables the composer.

### Claude Code

Fractal reads conversation history from Claude Code's native project JSONL files and watches the open file for appended entries. It never appends to or rewrites those files itself.

To continue a session, the main process locates the user's unmodified `claude` executable and spawns it directly with an argument array and explicit working directory. The first-slice command shape is equivalent to:

```text
claude --resume <native-session-id>
       --print <prompt>
       --output-format stream-json
       --verbose
       --include-partial-messages
```

New sessions omit `--resume`. Arguments are passed individually; prompts, session IDs, and paths are never interpolated into a shell command.

One child process represents one user turn. Streamed JSON is normalized live, the harness persists the turn to its native transcript, and the process exits when the turn settles. A later prompt spawns a new process that resumes the same native session. This matches mature open-source wrappers, keeps crash recovery simple, and avoids spending first-slice effort reproducing the Agent SDK's long-lived control protocol. The adapter boundary allows a future transport replacement without changing the renderer model.

When the installed version supports it, the adapter uses `claude agents --json` as one input to external-runtime detection. Transcript growth, Fractal's own process registry, and provider status are reconciled conservatively: if Fractal cannot prove that a session is idle, its runtime is `unknown` and the composer remains read-only.

The app does not provide a Claude login screen and does not read, copy, store, or intermediate Claude credentials. If Claude Code is unavailable or unauthenticated, Fractal reports that state and directs the user to complete setup through the native CLI.

## Normalized event ledger and turn projection

The lossless internal layer is an ordered ledger of normalized events. Provider-native IDs and event metadata remain attached so events can be reconciled after a reload and parser defects can be diagnosed.

The renderer consumes turns projected from that ledger:

```ts
interface ConversationTurn {
  id: string;
  userMessage: MessageBlock;
  blocks: TurnBlock[];
  status: 'active' | 'completed' | 'interrupted' | 'failed';
}

type TurnBlock =
  | AssistantProse
  | WorkPacket
  | ApprovalRequest
  | AgentQuestion
  | SystemNotice
  | UnsupportedActivity;

interface WorkPacket {
  id: string;
  actions: AgentAction[];
  status: 'active' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
}

type AgentAction =
  | FileReadAction
  | FileEditAction
  | CommandAction
  | SearchAction
  | ToolAction
  | SubagentAction;
```

Every action carries a lifecycle:

```text
requested -> awaiting-approval -> running -> completed
                         |             +--> failed
                         +----------------> denied
                                       +--> interrupted
```

Normalization rules:

- Pair tool requests and results by provider-native tool or item ID.
- Merge partial assistant deltas without creating duplicate final messages.
- Preserve prose/action chronology. Grouping into a work packet is a view operation, not event reordering.
- Render file patches only when the provider supplies sufficient exact data; never invent a diff from an uncertain state.
- Nest subagent activity beneath its parent action when a parent tool-use relationship exists.
- Render provider-supplied reasoning or thinking only when it is actually present in the transcript. Do not imply access to hidden reasoning.
- Convert approvals and questions into historical decision records once resolved.
- Preserve unfamiliar native events as `UnsupportedActivity` with provider provenance. They appear collapsed in the normal UI rather than being discarded or dumped as raw JSON.
- Carry a capture-completeness marker when provider data may omit parts of the work. Explain mode must be able to distinguish an exhaustive activity trail from an incomplete one.

## Discovery, loading, and watching

At startup, each available adapter returns lightweight summaries only. Fractal canonicalizes project paths, groups summaries by project, merges providers, and sorts sessions within a project by last meaningful activity.

Opening a conversation performs incremental loading:

```text
open row
  -> render header and loading state
  -> stream-parse native history in the main process
  -> emit normalized turns in bounded chunks
  -> virtualize the timeline in the renderer
  -> restore the last in-memory reading position when available
  -> begin watching native updates
```

The preload API never returns an unbounded raw transcript in one IPC response. The main process validates every `ConversationRef`, owns all paths, and sends validated chunks and live deltas.

Search in this slice covers project names, conversation titles, provider, and native session ID. Full-text transcript search is deferred until its indexing and privacy behavior are designed.

## Runtime ownership and concurrency

Transcript status and runtime ownership are separate:

```ts
type ConversationRuntime =
  | 'idle'
  | 'active-in-fractal'
  | 'waiting-for-user'
  | 'active-externally'
  | 'unknown'
  | 'failed';
```

- **Idle:** composer enabled; Fractal may resume.
- **Active in Fractal:** stream live events and own approval routing.
- **Waiting for user:** keep the blocking request visually prominent and the run paused.
- **Active externally:** watch and render appended native events, but disable the composer with an explanation.
- **Unknown:** remain read-only until the adapter establishes that resume is safe.
- **Failed:** show the error and reconcile native history before allowing recovery.

Fractal never attempts to become a second writer to an externally active session. Explicit takeover and fork flows are future features.

## History and conversation-panel behavior

The sidebar is project-first. Sessions from both providers are mixed within each project and sorted by recency. Each row shows a restrained provider mark plus runtime state. The current project is visually prominent, but provider is not a separate navigation level.

The conversation panel follows these rules:

- User prompts are strong reading anchors.
- Assistant prose reads as document content rather than oversized chat bubbles.
- Consecutive actions appear as an inline ordered work packet where the action phase occurred.
- The active packet remains open. Completed packets collapse to a summary and remain expandable.
- Approvals and questions interrupt the visual hierarchy because work cannot continue without them.
- Auto-scroll occurs only when the reader is already near the bottom.
- New external events never pull someone away from earlier history they are reading.
- Interrupted and failed turns remain visibly incomplete and resumable.
- Unknown provider events degrade into a subdued expandable record.
- The header contains project, native title, provider, runtime state, and a details menu. Provider-specific controls render only when capabilities permit them.

## Approvals and user questions

Codex approvals arrive as App Server requests. Claude print-mode approvals are routed through an ephemeral local MCP permission bridge supplied to the unmodified CLI with a temporary MCP configuration and permission-prompt tool. The main process owns that bridge and forwards validated requests to the renderer.

The UI supports:

- Allow once.
- Deny, optionally with a reason returned to the agent.
- Allow and remember only when the provider supplies an explicit supported permission update and Fractal can display its exact scope.

Fractal never turns a one-time approval into a remembered rule and never falls back to `--dangerously-skip-permissions`. If approval plumbing fails, the operation is denied or the turn is interrupted.

Tool approvals and agent questions are different blocks. Questions present the provider-supplied prompt and choices; approvals present the exact requested operation. Resolved requests remain in history with the decision and outcome.

Before the Claude continuation milestone begins, a narrow compatibility spike must verify the installed CLI's documented permission-prompt behavior for both ordinary tool approval and `AskUserQuestion`. The adapter records those as separate capabilities. If the installed version cannot route one of them through the host bridge, Fractal reports that limitation explicitly and does not substitute permission bypass or fabricated input.

## Security boundary

- `contextIsolation` remains on and `nodeIntegration` remains off.
- Native process and filesystem access live in the Electron main process.
- Preload exposes explicit methods; it never exposes `ipcRenderer`.
- All provider IDs, session IDs, paths, prompts, decisions, and event payloads are runtime-validated at IPC boundaries.
- Claude and Codex executables are spawned directly with argument arrays and explicit `cwd`; no shell interpolation is used.
- The Claude permission bridge binds locally, has an unguessable per-run identity, and is removed when the run settles.
- If the renderer disappears while a decision is pending, the operation cannot be implicitly approved.
- Fractal does not inspect or transmit provider credential stores.
- Raw provider events are not written to application logs by default because they can contain prompts, code, paths, and command output.

## Recovery and schema drift

- On Fractal restart, reload native history rather than reconstructing it from renderer state.
- On Claude process failure, drain parsable buffered output, mark the displayed turn interrupted or failed, reread the JSONL, and reconcile by native IDs.
- On Codex App Server failure, reconnect and reread before permitting another turn.
- Treat truncated final JSONL lines as potentially in-flight and retry after the file changes instead of declaring the whole transcript corrupt.
- Isolate malformed lines and unsupported event variants; one bad record must not prevent later valid history from rendering.
- Probe provider versions and capabilities at runtime. Unsupported versions produce a targeted compatibility state rather than undefined behavior.
- Deduplicate file-watch and live-process events by provider-native identity.

## Delivery sequence

1. **Native identity and adapter contracts.** Refactor the existing Fractal-owned contract into native references, capability reporting, runtime states, and validated preload messages.
2. **Read-only history for both harnesses.** Implement project/session discovery, incremental parsers, normalization, and the project-first sidebar.
3. **Agentic transcript rendering.** Implement turns, prose, work packets, actions, requests, failures, virtualization, and scroll behavior.
4. **Codex continuation.** Add App Server lifecycle, native thread resume, streaming, approvals, interruption, and reconnection.
5. **Claude continuation.** Begin with the permission/question compatibility spike, then add safe CLI discovery/spawn, native resume, stream parsing, transcript reconciliation, cancellation, and the supported prompt bridge.

The shared read/render foundation is completed before the two continuation transports so provider work does not duplicate UI or normalization logic.

## Acceptance criteria

- A session started in the Codex or Claude CLI appears under the correct project in Fractal.
- Codex and Claude sessions for one repository appear together and retain provider provenance.
- Messages and actions render in their original order.
- Active and completed work packets follow the approved expansion behavior.
- Large histories load progressively without freezing the renderer.
- Continuing a native session in Fractal writes to that same provider session.
- The original provider CLI can subsequently resume and see Fractal's continuation.
- An externally active session updates live but cannot be resumed concurrently.
- Approval-required actions cannot proceed without an explicit valid decision.
- Fractal termination does not corrupt or duplicate native history.
- Unknown or malformed provider events degrade visibly and do not break the remaining transcript.

## Verification strategy

Routine tests use no model calls and no user credentials:

- Sanitized provider fixtures: Claude JSONL plus Codex App Server JSON-RPC responses and notifications representing messages, actions, subagents, approvals, failures, interruptions, partial writes, and unknown events.
- Golden parser tests asserting normalized event ledgers and projected turns.
- Adapter contract tests against fake App Server and CLI subprocesses.
- Stream tests for partial JSON chunks, multiple records per chunk, stderr, malformed records, cancellation, nonzero exits, and delayed approvals.
- Reconciliation tests proving file-watch and process-stream observations do not duplicate events.
- Runtime state-machine tests for idle, internal activity, external activity, waiting, interruption, and reconnect.
- Preload and IPC validation tests using hostile paths, IDs, and payloads.
- Renderer reducer tests for incremental loading and live deltas.
- Component tests for work-packet expansion, request priority, and scroll anchoring where practical.
- One opt-in manual interoperability smoke test per installed harness: start in the native CLI, open and continue in Fractal, then resume again in the native CLI.
- `pnpm lint` and `pnpm exec tsc --noEmit` remain the repository completion gates.

## Research basis

- OpenAI documents Codex App Server as the integration surface for rich clients, including thread history, resume, streaming, status, and approvals: <https://developers.openai.com/codex/app-server>
- Anthropic documents programmatic Claude Code, `--resume`, and structured output: <https://code.claude.com/docs/en/headless>
- Anthropic's legal guidance explicitly contemplates products that install or run the unmodified Claude Code binary while end users authenticate with their own credentials: <https://code.claude.com/docs/en/legal-and-compliance>
- Opcode reads native Claude history and resumes the installed CLI through `stream-json`: <https://github.com/winfunc/opcode/blob/main/src-tauri/src/commands/claude.rs>
- Crystal resumes the installed CLI through `stream-json` and demonstrates a permission-prompt MCP bridge: <https://github.com/stravu/crystal/blob/main/main/src/services/panels/claude/claudeCodeManager.ts>
- CloudCLI demonstrates native `~/.claude` session and settings continuity with the user's own provider subscription: <https://github.com/siteboon/claudecodeui>
- ClaudeLens demonstrates native transcript reading plus a structured long-lived continuation UI, which remains a useful future reference even though Fractal's first Claude transport is the unmodified CLI: <https://github.com/giulio333/ClaudeLens/blob/main/electron/modules/chat-runner.ts>
