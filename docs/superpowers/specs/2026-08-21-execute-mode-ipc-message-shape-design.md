# Execute-mode IPC message shape — design

**Date:** 2026-08-21
**Status:** Approved for planning
**Scope:** The contract between Fractal's renderer and main process that backs the execute-mode conversation panel. Covers the message/entry data model, the renderer↔main channel shape, persistence, and versioning. Does **not** choose an agent backend or implement any of it.

## Why this exists

The execute-mode conversation panel (AI Elements components, already vendored into `src/components/ai-elements/`) needs state. In birtukan-ai that state came from `useChat` talking to a Next.js route over HTTP. Fractal is Electron: the renderer is walled off from the machine by `contextIsolation`, `preload.ts` is empty, and — per [CLAUDE.md](../../../CLAUDE.md) — Fractal wraps an existing coding agent rather than calling a model itself. So the panel's state has to arrive through a hand-built preload bridge to the main process, and the shape of what crosses that bridge is the subject here.

This shape is load-bearing beyond execute mode. CLAUDE.md's standing constraint for explain mode is that **a diagram must carry its own provenance** — what was read, what was skipped, what the agent was unsure about — because a missing edge and a nonexistent edge render identically. Execute mode is where the agent's work actually happens, so provenance is captured here, at the source, not reconstructed later.

## Decisions locked during brainstorming

- **Backend-agnostic ("shape-first").** The message shape is designed on its own merits. Any backend (Claude Code CLI, Agent SDK, direct API) is an adapter that maps *into* this shape. The contract inherits no vendor's event vocabulary.
- **Entries carry typed work + provenance.** Not just text — file reads, edits, command runs are first-class ordered data, with an untyped `tool-call` escape hatch so unknown tools degrade rather than vanish.
- **Main owns state; sends deltas.** Main holds the authoritative conversation and emits small append/patch events. Renderer keeps a reducer.
- **Channel shape: one event stream + a command surface** (brainstorming option 1). A single subscription carries a discriminated union of events; a handful of commands go the other way. Ordering across event types is guaranteed by the single sequenced stream.
- **v1 scope includes all four of:** cancel/interrupt a turn, tool permission round-trip, persistence across restarts, multiple concurrent conversations.
- **Provenance's "files read" is derived** from `file-read` parts, not stored.
- **`part.updated` carries a shallow patch**, not a whole-part replacement.
- **Unanswered permission requests wait forever** (no auto-deny timeout); `cancelTurn` is the escape hatch.
- **Persistence: JSON file per conversation, write-on-settle.** A crash mid-turn loses the in-flight entry; accepted for v1.

## 1. Data model (the entry)

```ts
export const CONTRACT_VERSION = 1;

type ConversationId = string;  // uuid, minted by main
type EntryId = string;
type PartId = string;

interface Conversation {
  id: ConversationId;
  title: string;
  repoRoot: string;      // paths in parts/provenance are relative to this
  createdAt: number;     // epoch ms
  updatedAt: number;
  schemaVersion: number;
}

interface Entry {
  id: EntryId;
  conversationId: ConversationId;
  author: 'user' | 'agent';
  createdAt: number;
  status: 'streaming' | 'complete' | 'interrupted' | 'error';
  error?: { message: string };
  parts: Part[];
  provenance?: Provenance;   // agent entries only
}
```

An entry holds an **ordered list of parts**, not a text blob with metadata attached. Order is the payload: "read these three files, then edited this one, then explained why" is exactly what a reader needs, and a shape that stores text apart from work loses it.

```ts
type Part = TextPart | ReasoningPart | WorkPart;

interface TextPart      { id: PartId; kind: 'text';      text: string }
interface ReasoningPart { id: PartId; kind: 'reasoning'; text: string }

interface WorkBase {
  id: PartId;
  startedAt: number;
  endedAt?: number;
  phase: 'pending' | 'awaiting-permission' | 'running' | 'done' | 'denied' | 'error';
  error?: { message: string };
}

type WorkPart =
  | WorkBase & { kind: 'file-read';   path: string; ranges?: { start: number; end: number }[] }
  | WorkBase & { kind: 'file-edit';   path: string; diff?: string; added?: number; removed?: number }
  | WorkBase & { kind: 'command-run'; command: string; cwd?: string; exitCode?: number; output?: string }
  | WorkBase & { kind: 'tool-call';   name: string; input: unknown; result?: unknown };
```

`tool-call` is the deliberate untyped escape hatch. When a backend adapter meets a tool it has no mapping for, it emits `tool-call` rather than dropping the work — unknown tools degrade to generic rendering instead of vanishing. Without it, "shape-first" silently becomes "shape-first until a backend surprises us," and silent omission is the exact failure CLAUDE.md warns against.

```ts
interface Provenance {
  filesSkipped: { path: string; reason: string }[];
  uncertainties: string[];
  complete: boolean;   // did the adapter capture the whole trail?
}
```

`complete` is the load-bearing field. A partial trail from a backend that cannot report skips must be distinguishable from a genuinely exhaustive one — otherwise the provenance display becomes the authoritative-looking lie it exists to prevent. `filesRead` is intentionally **absent**: it is derivable from the entry's `file-read` parts, and storing it twice invites the two copies to disagree.

## 2. Event stream (main → renderer)

```ts
interface EventEnvelope {
  v: number;                    // CONTRACT_VERSION
  seq: number;                  // monotonic per conversation
  conversationId: ConversationId;
}

type AgentEvent = EventEnvelope & (
  | { type: 'conversation.created';  conversation: Conversation }
  | { type: 'conversation.updated';  title?: string; updatedAt: number }
  | { type: 'entry.added';           entry: Entry }
  | { type: 'part.added';            entryId: EntryId; index: number; part: Part }
  | { type: 'text.appended';         entryId: EntryId; partId: PartId; delta: string }
  | { type: 'part.updated';          entryId: EntryId; partId: PartId; patch: PartPatch }
  | { type: 'entry.status';          entryId: EntryId; status: Entry['status']; error?: { message: string } }
  | { type: 'provenance.updated';    entryId: EntryId; provenance: Provenance }
  | { type: 'permission.requested';  entryId: EntryId; partId: PartId; requestId: string }
  | { type: 'permission.resolved';   requestId: string; decision: PermissionDecision }
);

// Shallow patch over a work part's mutable fields; id and kind cannot change.
type PartPatch = Partial<Omit<WorkPart, 'id' | 'kind'>>;
```

Rationale for the shape:

- **`text.appended` is separate from `part.updated`** because they merge differently (append vs. shallow-replace) and because `text.appended` is the only per-token hot-path event. Keeping it apart lets the reducer stay a dumb `switch` and keeps the hot path a single small string.
- **`seq` is per conversation.** It lets the renderer detect it missed something (after reload, or if main emitted while no subscriber was attached) and resync rather than render a conversation with a hole in it. Same principle as `provenance.complete`: the shape can notice its own gaps. Global sequencing would make each conversation's gap-detection depend on unrelated traffic.
- **`permission.resolved` is broadcast** even though the renderer answered, because resolution is conversation state — it must survive a reload mid-prompt and reach a second window.
- **`part.updated` merges a shallow patch.** Work parts are small and mostly flat, so this is compact and sufficient for phase transitions. The known sharp edge — shallow merge can't clear a field to `undefined` or patch inside `ranges` — is accepted; the only nested field today is `file-read.ranges`, and it can be replaced wholesale via the patch.

**Subscription is live-only.** `onAgentEvent` delivers events from now on; it does not replay history. The renderer loads history via the `getConversation` command (section 3), which returns a snapshot plus the `seq` it was taken at, then applies live events with a greater `seq`. This keeps subscribe O(1) and keeps "entry I already have" out of the reducer's normal path.

## 3. Command surface (renderer → main) and permission

Exposed as `window.fractal.agent`. `ipcRenderer` is never exposed — preload holds the only reference and hand-writes each method, so the renderer's reachable surface is exactly this interface.

```ts
type PermissionDecision = { outcome: 'allow' } | { outcome: 'deny'; reason?: string };

interface FractalAgentApi {
  // queries
  listConversations(): Promise<Conversation[]>;
  getConversation(id: ConversationId):
    Promise<{ conversation: Conversation; entries: Entry[]; seq: number } | null>;
  createConversation(): Promise<Conversation>;

  // turn control
  sendMessage(input: { conversationId: ConversationId; text: string }): Promise<{ entryId: EntryId }>;
  cancelTurn(input: { conversationId: ConversationId }): Promise<void>;

  // permission
  respondToPermission(input: { requestId: string; decision: PermissionDecision }): Promise<void>;

  // stream
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;   // returns unsubscribe
}
```

- **Permission is not a promise the caller awaits.** Main emits `permission.requested` with a `requestId` and parks its own promise; the renderer answers with an ordinary `respondToPermission` command. Modelling it as "main awaits the renderer" would put an in-flight request in the renderer's call stack, so a reload would strand main awaiting an answer nobody will give. Keeping the request in main's state and the reply as a normal command lets a reloaded renderer be re-handed pending requests on resubscribe.
- **`createConversation()` takes no arguments — deliberately.** `createConversation({ repoRoot })` would let the renderer name any path and have main act on it, making the preload boundary a formality. Instead main opens the directory picker itself and returns the conversation with `repoRoot` set. The renderer learns the path; it never chooses it. This aligns with CLAUDE.md: filesystem access belongs behind the preload API, not in the renderer.
- **Unanswered permission requests wait forever** (decision: option A). A wedged turn is visible and recoverable via `cancelTurn`; an auto-deny would fabricate a denial the user never made and discard the agent's work. On resubscribe, main re-emits still-pending `permission.requested` events so the UI can re-prompt.

**Deferred (not v1):** remembered permission scopes (`allow-always`). Additive later — a new `PermissionDecision` outcome — but it implies a persisted policy store and a scope model (this tool? this path? this repo?) that is its own design. v1 asks every time.

## 4. Persistence and versioning

**Store:** one JSON file per conversation at `app.getPath('userData')/conversations/<id>.json`, holding `{ conversation, entries }`, plus a separate index file for the sidebar list so startup does not read every conversation. Main is the only writer.

JSON over SQLite for v1: the access pattern is "load one conversation, list all titles" — no joins, no queries — and at desktop scale a file read is not the bottleneck. Files are also inspectable and diffable while the shape is still moving. Known future pressure: explain mode may want cross-conversation queries over provenance ("what has the agent never read?"), which is SQLite's case. That migration is taken when the requirement is real, not built against a guess.

> Note (verify at implementation): Electron 43.4.0 bundles Node v24.18.1, which ships `node:sqlite`, so a later SQLite move needs no native module. Confirm `node:sqlite` is reachable from the main process before relying on it.

**Write timing:** never on the token hot path. Main writes when an entry reaches a terminal status (`complete` / `interrupted` / `error`) and when conversation metadata changes. Streaming state lives in memory until the entry settles.

**Crash behaviour (decision: option A, simpler).** A crash or force-quit mid-turn loses the entire in-flight entry; on restart the conversation looks as though the turn never happened. Accepted for v1: turns are usually short, the loss is bounded, and the alternative (an append-only delta log with replay + compaction) is a second implementation of the renderer's reducer, and two reducers that must agree is a bug factory.

**Versioning.** `Conversation.schemaVersion` is stamped at creation; `v` rides every event. On load, a conversation older than `CONTRACT_VERSION` runs forward migrations. A conversation *newer* than the running build is refused and surfaced as "created by a newer version of Fractal" rather than partially parsed — silently loading a conversation you don't fully understand and writing it back is how you lose the fields you didn't recognise.

## Module boundaries (for the implementation plan)

Each unit below has one job, a typed interface, and can be understood without reading the others:

- **`src/shared/agent-contract.ts`** — the types in this doc. Imported by both processes; the single source of truth for the shape. Type-only, no runtime.
- **preload (`src/preload.ts`)** — hand-written `contextBridge` exposing `window.fractal.agent`. Translates each command to an `ipcRenderer.invoke` and adapts the event channel to the `onAgentEvent` listener. No logic.
- **main: conversation store** — owns durable state, the JSON files, the index, migrations. Pure of Electron beyond `app.getPath`.
- **main: session manager** — owns in-flight turns, `seq` counters, pending permission requests; emits `AgentEvent`s; drives the (future) backend adapter. The only stateful hot-path component.
- **main: backend adapter (stub in v1)** — the seam where a real agent plugs in. v1 may ship a scripted/echo adapter so the panel can be exercised end-to-end without choosing a backend.
- **renderer: `useConversation` hook** — subscribes to `onAgentEvent`, runs the reducer, exposes the entry list + status + command callbacks the panel consumes. Replaces `useChat`.
- **renderer: panel wiring** — mounts the vendored AI Elements against the hook inside `execute-mode.tsx`.

## Explicit non-goals for v1

- Choosing or implementing a real agent backend.
- Remembered permission scopes.
- Crash-durable in-flight turns.
- SQLite / cross-conversation queries.
- Rendering design for the work/provenance parts (this doc fixes the data; the visual treatment is a separate pass).
