# Map Mode Phase 2: Side Chats and the Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a conversation and all its side chats on a pannable, zoomable canvas in Map mode, and let the user start, continue and delete side chats there.

**Architecture:** Main gains three things on top of phase 1's fork support. First, the side-chat tree: `BranchStore` learns to list and delete records, and `ConversationService` lists a conversation's side chats and deletes a side chat along with the side chats under it, deleting the native sessions through new `deleteConversation` adapter methods (Claude SDK `deleteSession`, Codex `thread/delete`). Second, a `MapLayoutStore` in userData holds node positions, widths and the Preview/Full setting per conversation. Third, the parked phase 1 gaps are closed. In the renderer, a `ConversationHub` makes every view share one load per conversation, so Execute (kept mounted while hidden) and Map can both show the same conversation. A pure `buildMapGraph` turns the loaded conversations, the side-chat records, the saved layout and any unsent drafts into React Flow nodes and edges. `@xyflow/react` renders them with Fractal's own node components and controls.

**Tech Stack:** Electron 43 main process, React 19, TypeScript 5.9, Tailwind v4, shadcn/ui, Vitest (node and jsdom), `@xyflow/react` 12.12.0, `@anthropic-ai/claude-agent-sdk` 0.3.296, Codex app server (codex-cli 0.162.1).

**Spec:** `docs/superpowers/specs/2026-10-19-map-mode-side-chats-and-forks-design.md`. This plan covers phase 2 only: side chats and the map. Starting side chats from Execute mode (phase 3) and forks in the UI (phase 4) get their own plans. Phase 1 is in `docs/superpowers/plans/2026-10-19-map-mode-phase-1-fork-support.md` and merged on `main`.

## Global Constraints

- Handlers go through `registerConversationIpc`'s `invoke` helper (or the same main-frame check in a new `register*Ipc`), with channel names and parsers in `src/shared/` (AGENTS.md). `contextIsolation` stays on and `nodeIntegration` off.
- New channels, exactly: `fractal:conversations:side-chats`, `fractal:conversations:delete-side-chat`, `fractal:map:layout`, `fractal:map:save-layout`.
- Only a side chat can be deleted through the new API. `deleteSideChat` on a conversation whose record isn't `side-chat` throws `Only side chats can be deleted`, and on a busy one throws `Side chat is busy`. Deleting removes the side chat and every side chat below it, never a fork.
- Native sessions are deleted before their records. If a native delete fails, its record stays, so the session stays hidden from the sidebar and read-only.
- `ConversationService` must not gain a field matching `/store|storage|transcript|data.*path/i` (`native-continuity.integration.test.ts`).
- Layout lives in `<userData>/map-layouts.json`. It's convenience state: an unreadable file or invalid entry reads as absent, like `access-choice-store.ts`.
- Canvas values: grid `20` px with snapping on, default node width `320`, resize range `240`–`960` (width only), Preview clamps a message to `3` lines, zoom range `0.2`–`2`, vertical gap `40`, horizontal gap `80`. Stored branch-point text is capped at `500` characters.
- Exact copy:
  - Empty map: `Pick a conversation to see its map.`
  - A conversation with no messages: `No messages yet.`
  - Selection menu entry: `Side chat`
  - Composer placeholder: `Ask a side question`, with the hint `Ctrl+Enter to send`
  - Detached label: `Branch point no longer in the conversation`
  - Controls: tooltips `Zoom in`, `Zoom out` and `Fit to view`, and a `Preview` / `Full` toggle
  - Delete dialog: title `Delete side chat?`, body `This deletes the side chat from the map and from {Claude|Codex}'s own history. It can't be undone.`, or `This deletes the side chat and the {n} side chats inside it…` when it has nested ones, and buttons `Cancel` and `Delete`
  - Composer failure: `Couldn't start the side chat.` / `Couldn't send to the side chat.`
  - Delete: the action's tooltip is `Delete side chat`, and a failed delete shows `Couldn't delete the side chat.`
- UI rules (AGENTS.md and spec): no OS scrollbars and no `scrollbar-width` / `scrollbar-color`; tooltips only from `components/ui/tooltip.tsx`, never `title`. That means React Flow's stock `Controls` and `MiniMap` aren't used. Canvas controls sit bottom-left, clear of the mode toggle. Colors come only from theme tokens: `--background`, `--card`, `--border`, `--primary` (the main line) and `--muted-foreground` at reduced strength (side chats).
- `@xyflow/react` is pinned exactly to `12.12.0`, and `reactflow` is removed. Read `docs/environment-notes.md` first: a dependency edit can trigger pnpm's purge prompt, which recreates Electron and needs the chrome-sandbox fix re-applied.
- Commits use Conventional Commits. Commit only inside the subagent-driven workflow, and never push.
- Run `pnpm test`, `pnpm lint` and `pnpm exec tsc --noEmit` before calling any task done.

## Review Focus

- **The main conversation open in Execute while Map is shown.** Execute stays mounted while hidden, and the service keeps one load per conversation, so a second `open` would cut Execute off. Both views must share one load: after visiting Map and returning, sending from Execute still streams. Test in Task 5.
- **A side chat whose branch point is gone** because the main conversation was rewound outside Fractal. Once the parent's history is complete and the turn isn't in it, the side chat shows detached, with its stored branch-point text, and is never re-attached to another reply. Test in Task 6.
- **Deleting a side chat while it, or one nested in it, is running.** This must be refused before anything is deleted. Test in Task 3.
- **A fork made from a side chat** (possible from phase 1's API, and a UI feature in phase 4). Deleting the side chat leaves the fork and its record alone. Tests in Tasks 1 and 3.
- **An abandoned draft.** A composer node that is never sent creates no native session. Escape on an empty draft, or switching conversations, drops it. Test in Task 8.

---

### Task 1: Side-chat records and the parked store gaps

**Files:**
- Modify: `src/main/branch-store.ts`, `src/shared/conversation-contract.ts` (next to `conversationKey`), `src/main.ts` (single-instance lock)
- Test: `src/main/branch-store.test.ts`, `src/shared/conversation-ipc.test.ts` (or a new `conversation-contract.test.ts`), `src/main.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // BranchRecord gains:
  /** The start of the reply a side chat was cut after, at most 500 characters; shown when that reply is gone. */
  branchPointText?: string;
  // BranchStore gains:
  delete(conversationKey: string): void;
  /** Every record below `conversationKey`, at any depth, as [key, record] pairs, parents before children, oldest first among siblings. */
  descendants(conversationKey: string): Array<[string, BranchRecord]>;
  // conversation-contract.ts:
  export function parseConversationKey(key: string): Pick<ConversationRef, 'provider' | 'nativeSessionId'>; // throws on a key conversationKey() could not have made
  ```

- [ ] **Step 1: Write failing tests** in `branch-store.test.ts`:
  - `delete` removes one record, persists the removal, and leaves its siblings.
  - `descendants('claude:root')` returns side chats and forks at every depth, parents before children. A record whose `parentKey` is a deleted record isn't returned for the root.
  - A cycle in `parentKey` (a hand-edited file) doesn't loop: each key is returned at most once.
  - `branchPointText` round-trips. A non-string value is dropped while the rest of the record is kept.
  - **Backup:** after two `set`s, `branches.json.bak` holds the state before the second. When `branches.json` doesn't parse, it's moved aside as today, and the store reads `branches.json.bak` instead of starting empty. When both are unparseable, it reads as empty.
- [ ] **Step 2: Run them**, `pnpm vitest run src/main/branch-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `save` copies the current file to `branches.json.bak` (only when it exists and parses) before the atomic tmp-and-rename write. `descendants` is a breadth-first walk over the in-memory records with a visited set.
- [ ] **Step 4: Test and implement `parseConversationKey`.** It splits at the first `:`, requires a known `ProviderId` and a nonblank id, and round-trips with `conversationKey`.
- [ ] **Step 5: Single instance.** In `src/main.ts`, call `app.requestSingleInstanceLock()` before `app.on('ready', …)`. If the lock is lost, `app.quit()` and return. On `second-instance`, restore and focus the existing window. Add a `main.test.ts` case for the lost lock, following that file's existing Electron mocks. The point is that two instances can't overwrite each other's `branches.json`.
- [ ] **Step 6:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`, all passing.
- [ ] **Step 7: Commit:** `feat(conversation): list and delete side-chat records, keep a store backup, run one app instance`.

### Task 2: Deleting native sessions

**Files:**
- Modify: `src/main/harness/types.ts`, `src/main/harness/claude/claude-adapter.ts`, `src/main/harness/codex/codex-adapter.ts`, `src/main/harness/codex/codex-app-server.ts` (request map), `src/main/conversation-registry.ts`
- Create: `src/main/real-cli.integration.test.ts`, skipped unless `FRACTAL_REAL_CLI=1`
- Test: `claude-adapter.test.ts`, `codex-adapter.test.ts`, `conversation-registry.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // HarnessAdapter gains:
  /** Removes the session from the agent's own history. Absent when the agent cannot delete. */
  deleteConversation?(ref: ConversationRef): Promise<void>;
  // ConversationRegistry gains:
  delete(ref: ConversationRef): Promise<void>; // throws 'Conversation deletion is not available' without the method; refreshes the provider afterwards
  ```
- Consumes: the Claude SDK's `deleteSession(sessionId, { dir })` from `@anthropic-ai/claude-agent-sdk` (installed `sdk.d.ts`: it removes `{sessionId}.jsonl` and the `{sessionId}/` subagent directory, and throws if the session isn't found). Codex's `thread/delete` takes `{ threadId }` and returns `{}` (`generated/v2/ThreadDeleteParams.ts`, `ThreadDeleteResponse.ts`).

- [ ] **Step 1: Write failing tests:**
  - Claude: `deleteConversation` calls the injected `deleteSession` (a new `ClaudeAdapterDependencies.deleteSession?: typeof sdkDeleteSession`) with the session id and `{ dir: <canonical project path> }`, after `find` confirms the session is in that project. It drops the id from `readOnlySessions` only after the delete resolves.
  - Codex: `deleteConversation` sends `thread/delete` with `{ threadId }`, then drops the id from `readOnlyThreads` and `resumedWithoutOverrides`. A rejected request leaves both sets unchanged.
  - Registry: `delete` resolves the adapter, throws `Conversation deletion is not available` when it has no `deleteConversation`, and refreshes the provider after a successful delete.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** Add `'thread/delete': { params: ThreadDeleteParams; result: ThreadDeleteResponse }` to the Codex request map.
- [ ] **Step 4: Write `real-cli.integration.test.ts`.** It drives the real adapters, with no model turns, against a source conversation named by env vars: `FRACTAL_PROBE_PROVIDER`, `FRACTAL_PROBE_SESSION` and `FRACTAL_PROBE_PROJECT`. Codex uses a real `CodexAppServer`, and Claude a real `ClaudeAdapter` on `~/.claude/projects`. For the given provider, it:
  - loads the source and counts its turns
  - forks a read-only side chat after the source's second turn
  - loads the fork and asserts its turn count is exactly `2`, which is what `BranchRecord.inheritedTurnCount` assumes
  - calls `deleteConversation` and asserts that `listConversations()` no longer includes the fork and that `loadConversation` on it throws.
  It's wrapped in `describe.skipIf(process.env.FRACTAL_REAL_CLI !== '1')`, so `pnpm test` skips it.
- [ ] **Step 5:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 6: Commit:** `feat(harness): delete Claude and Codex sessions`.
- [ ] **Step 7 (controller, not the implementer): run the real-CLI test once per provider.** Use a small conversation with at least two turns in this repo. Each run creates one native fork and deletes it, and spends no model turns. Run `FRACTAL_REAL_CLI=1 FRACTAL_PROBE_PROVIDER=… FRACTAL_PROBE_SESSION=… FRACTAL_PROBE_PROJECT=… pnpm vitest run src/main/real-cli.integration.test.ts`. Ledger the outcome. Rulings already made for the two ways it can go wrong:
  - **Codex `thread/delete` refuses a thread this connection has resumed.** Send `thread/unsubscribe` first, then delete, and add that to Step 1's tests.
  - **A fork's turn count isn't `afterIndex + 1`.** Stop: the map's slicing in Task 6 rests on it.

### Task 3: Listing and deleting side chats in the service, IPC and preload

**Files:**
- Modify: `src/shared/conversation-contract.ts`, `src/shared/conversation-ipc.ts`, `src/preload.ts`, `src/main/conversation-service.ts`, `src/main/agent-ipc.ts`, the test doubles that implement `ConversationApi` (App, app-shell, conversation-panel, preload tests)
- Test: `conversation-service.test.ts`, `agent-ipc.test.ts`, `conversation-ipc.test.ts`, `preload.test.ts`

**Interfaces:**
- Produces (contract):
  ```ts
  export interface SideChatSummary {
    ref: ConversationRef;
    /** conversationKey() of the conversation or side chat it branched from. */
    parentKey: string;
    /** The parent's ConversationTurn.id it was cut after. */
    afterTurnId: string;
    /** How many of its leading turns came from the parent; the map shows only the rest. */
    inheritedTurnCount: number;
    branchPointText?: string;
    createdAt: number;
  }
  // ConversationApi gains:
  /** Every side chat below this conversation, at any depth, parents before children. */
  sideChats(ref: ConversationRef): Promise<SideChatSummary[]>;
  /** Deletes the side chat and the side chats below it, from Fractal and from the agent's own history. */
  deleteSideChat(ref: ConversationRef): Promise<void>;
  ```
- Produces (service): `sideChats(ref): SideChatSummary[]`, and `deleteSideChat(ref): Promise<ConversationRef[]>`, which returns the deleted refs, deepest first. On fork, side-chat records now store `branchPointText`.
- Consumes: `BranchStore.descendants` / `delete` and `parseConversationKey` (Task 1), and `ConversationRegistry.delete` (Task 2).

- [ ] **Step 1: Write failing service tests:**
  - `sideChats(root)` returns only `side-chat` descendants as `SideChatSummary`, with `ref.projectPath` set to the root's. A record with `afterTurnId: null` is left out, since side chats always have a branch point.
  - `fork(…, 'side-chat')` stores `branchPointText`: the cut turn's `assistant-prose` blocks joined with `\n\n`, cut to 500 characters.
  - `deleteSideChat(sideChat)` with two nested side chats and one fork beneath it:
    - deletes the three side chats' native sessions deepest first, then their records
    - leaves the fork's record and native session untouched
    - releases any open load of the deleted ones.
  - `deleteSideChat` throws:
    - `Only side chats can be deleted` for a main conversation or a fork
    - `Side chat is busy` when any side chat in that subtree has a starting or owned run, or a busy summary runtime. Nothing is deleted in that case.
  - **Partial failure:** a failing native delete throws, keeps that record and every record above it, and keeps the records already deleted gone.
  - **Fork rollback (parked from phase 1):** if `branches.set` throws after the native fork succeeds, the service calls `registry.delete` on the new ref (best effort) and rethrows.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement** the service methods. Delete deepest first, so a failure part-way never leaves a recorded side chat whose parent's record is gone.
- [ ] **Step 4: IPC and preload.**
  - Add the channels `sideChats: 'fractal:conversations:side-chats'` and `deleteSideChat: 'fractal:conversations:delete-side-chat'`, and `parseSideChatSummary` for the preload's validation of what comes back.
  - `sideChats` takes one ref; `deleteSideChat` takes one ref, and the handler forgets this owner's IPC loads for each returned ref.
  - Neither handler needs the ref to be loaded by the caller.
  - Tests: arity, main-frame rejection, and forgotten loads.
- [ ] **Step 5:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 6: Commit:** `feat(conversation): list and delete side chats`.

### Task 4: Map layout store and IPC

**Files:**
- Create: `src/shared/map-contract.ts` (types, channels and parser), `src/main/map-layout-store.ts`, `src/main/map-ipc.ts`
- Modify: `src/preload.ts` (adds `window.fractal.map`), `src/main.ts`, the `window.fractal` type declaration and test doubles
- Test: `src/shared/map-contract.test.ts`, `src/main/map-layout-store.test.ts`, `src/main/map-ipc.test.ts`, `preload.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MapView = 'preview' | 'full';
  export interface MapNodeLayout { x: number; y: number; width?: number }
  /** Per root conversation. A node is listed only once the user has moved or resized it; the rest are placed automatically. */
  export interface MapLayout { view: MapView; nodes: Record<string, MapNodeLayout> }
  export const MAP_CHANNELS = { layout: 'fractal:map:layout', saveLayout: 'fractal:map:save-layout' } as const;
  export function parseMapLayout(value: unknown): MapLayout;
  export interface MapApi { layout(ref: ConversationRef): Promise<MapLayout>; saveLayout(ref: ConversationRef, layout: MapLayout): Promise<void> }
  export const EMPTY_MAP_LAYOUT: MapLayout; // { view: 'preview', nodes: {} }
  // main:
  export class MapLayoutStore { constructor(rootDir: string); get(conversationKey: string): MapLayout | undefined; set(conversationKey: string, layout: MapLayout): void }
  export function registerMapIpc(store: MapLayoutStore, getWindow: () => BrowserWindow | null): { dispose(): void };
  ```

- [ ] **Step 1: Write failing tests:**
  - `parseMapLayout` accepts a valid layout and returns a copy with no extra keys. It rejects:
    - more than 5000 nodes
    - a node id longer than 600 characters
    - non-finite numbers, or coordinates beyond ±10 000 000
    - a width outside 240–960
    - any other `view`.
  - The store round-trips layouts per key, treats unreadable JSON as empty, and drops an invalid entry while keeping its siblings.
  - IPC: `layout` returns `EMPTY_MAP_LAYOUT` for an unknown key, `saveLayout` parses before writing, and both reject a sender that isn't the main frame.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement**, modeled on `access-choice-store.ts` and the existing `register*Ipc` main-frame check. A failed write in `saveLayout` rejects, and the renderer ignores it.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `feat(map): store map layouts per conversation`.

### Task 5: One shared load per conversation in the renderer

**Files:**
- Create: `src/renderer/conversation-hub.ts`
- Modify: `src/renderer/use-conversation.ts`, which keeps its exact return shape and moves onto the hub
- Test: `src/renderer/conversation-hub.test.ts`, and the existing `use-conversation.test.tsx` and `conversation-panel.test.tsx` must still pass unchanged apart from setup

**Interfaces:**
- Produces:
  ```ts
  export class ConversationHub {
    constructor(api: Pick<ConversationApi, 'open' | 'close' | 'continue' | 'interrupt' | 'resolveRequest' | 'onEvent'>);
    /** Opens on the first lease and closes after the last is released (deferred one microtask, so a release-then-acquire in one commit keeps the load). */
    acquire(ref: ConversationRef): () => void;
    state(ref: ConversationRef): ConversationState; // initialConversationState when not acquired
    subscribe(listener: () => void): () => void;
    canSend(ref: ConversationRef): boolean;
    send(ref: ConversationRef, prompt: PromptInput): Promise<void | undefined> | undefined;
    interrupt(ref: ConversationRef): Promise<void | undefined> | undefined;
    resolveRequest(ref: ConversationRef, requestId: string, decision: UserDecision): Promise<void | undefined> | undefined;
    reload(ref: ConversationRef): void;
  }
  export function conversationHub(): ConversationHub; // the app's single hub over window.fractal.conversations
  export function useConversationStates(refs: readonly ConversationRef[]): ReadonlyMap<string, ConversationState>; // leases each ref while mounted, keyed by conversationKey
  ```
  `useConversation(ref)` keeps returning `{ state, canSend, send, interrupt, resolveRequest, reload }` with today's semantics.

- [ ] **Step 1: Write failing hub tests**, with a fake API:
  - Two `acquire`s of one ref call `open` once. Releasing one keeps the load, and releasing both calls `close` once.
  - Release then re-acquire in the same tick keeps the load: no `close`, no second `open`.
  - Events route by `conversationKey` and `loadId` through `conversationReducer`. Events for another load are ignored.
  - A `sync: 'gap'` reopens once per loadId, as `use-conversation.ts` does today.
  - `send` on an unacquired or stale load returns `undefined`. A rejection after the load changed is swallowed, which is today's `containActionSettlement`.
  - **Review Focus:** two `useConversation` hooks on one ref (Execute and Map) share one `open`. After the second unmounts, events still reach the first.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the open/close, generation and gap-recovery logic out of `use-conversation.ts` into the hub, one entry per key. One `onEvent` subscription is made lazily for the hub's lifetime. Hooks read through `useSyncExternalStore`, and `useConversationStates` memoizes its map so it changes only when one of its states does.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`. Expected: the existing conversation tests pass.
- [ ] **Step 5: Commit:** `refactor(renderer): share one conversation load across views`.

### Task 6: The map graph

**Files:**
- Create: `src/renderer/map/map-graph.ts`
- Test: `src/renderer/map/map-graph.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const MAP = { grid: 20, nodeWidth: 320, minWidth: 240, maxWidth: 960, previewLines: 3, minZoom: 0.2, maxZoom: 2, gapY: 40, gapX: 80 } as const;
  export type MapNodeData =
    | { kind: 'user'; owner: ConversationRef; line: 'main' | 'side'; turn: ConversationTurn }
    | { kind: 'reply'; owner: ConversationRef; line: 'main' | 'side'; turn: ConversationTurn; latest: boolean; canBranch: boolean }
    | { kind: 'composer'; draft: SideChatDraft }
    | { kind: 'detached'; sideChat: SideChatSummary };
  export interface SideChatDraft { id: string; parent: ConversationRef; afterTurnId: string; /** Set when the draft continues this side chat instead of starting one. */ continues?: ConversationRef; text: string; position?: XYPosition }
  export function mapNodeId(owner: ConversationRef, turnId: string, part: 'user' | 'reply'): string; // `${conversationKey(owner)}|${turnId}|${part}`
  export function buildMapGraph(input: {
    root: { ref: ConversationRef; state: ConversationState };
    sideChats: ReadonlyArray<{ summary: SideChatSummary; state: ConversationState }>;
    drafts: readonly SideChatDraft[];
    layout: MapLayout;
    /** Measured node heights by id, from React Flow; a missing one counts as 120. */
    heights: ReadonlyMap<string, number>;
    readOnly: boolean; // a subagent conversation: no handles
  }): { nodes: Node<MapNodeData>[]; edges: Edge[] };
  ```

- [ ] **Step 1: Write failing tests**, one per rule:
  - **Nodes:** one `user` node per turn with any user text, images or attachments, and one `reply` node per turn. Edges run user → reply → next user. Main-line edges and nodes have `line: 'main'`, with the edge's class `map-edge-main`.
  - **Side chats:** a side chat shows only `turns.slice(inheritedTurnCount)`. Its first node gets a `map-edge-side` edge from its parent's reply node for `afterTurnId`, leaving from the reply's right handle (`sourceHandle: 'branch'`). Nested side chats attach to their parent side chat's reply in the same way.
  - **Detached (Review Focus):** when the parent's `history` is `complete` and `afterTurnId` isn't among its turns, the side chat gets a `detached` node above its first node, no edge, and keeps its saved or automatic position. While the parent is still loading, nothing about the side chat is drawn.
  - **Branching:** `canBranch` is false while the reply's turn is `active` and when `readOnly` is set. `latest` marks the last reply of each line.
  - **Auto layout:**
    - The main line is a column at x = 0, each node's y the previous node's bottom (its measured height) plus `gapY`.
    - A side chat chain is a column at its parent node's x + `nodeWidth` + `gapX`, starting at the parent reply's y. It's pushed down below any earlier chain already in that column (older `createdAt` first), plus `gapY`.
    - A node with a saved layout uses its saved x/y/width.
    - All automatic positions snap to the grid.
  - **Drafts:**
    - A draft becomes a `composer` node at `draft.position`, or below its continued side chat's last node, or at the automatic spot for a new side chat from its parent reply.
    - A new side chat's draft gets a `map-edge-side` edge from the parent reply. A continuing draft gets an edge from the side chat's latest reply.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement** as pure functions with no React imports, apart from the `Node`/`Edge`/`XYPosition` types from `@xyflow/react`. Install the dependency here: `pnpm remove reactflow && pnpm add @xyflow/react@12.12.0` (exact pin), then check `package.json` shows `"@xyflow/react": "12.12.0"`.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `feat(map): build the map graph from a conversation and its side chats`.

### Task 7: The canvas

**Files:**
- Create: `src/components/map/map-mode.tsx`, `map-canvas.tsx`, `map-nodes.tsx`, `map-controls.tsx`, `src/renderer/map/use-map-layout.ts`, `src/renderer/map/use-side-chats.ts`
- Modify: `src/App.tsx`, which renders `<MapMode {...shell} />` from the new path. Delete `src/components/map-mode.tsx`. Modify `src/components/conversation/conversation-turn.tsx`: extract `UserMessageBody` and `AgentReplyBody` from `ConversationTurn` unchanged, for the nodes to reuse. Modify `src/index.css`, with canvas styles on tokens only.
- Test: `src/components/map/map-mode.test.tsx`, `src/renderer/map/use-map-layout.test.tsx`

**Interfaces:**
- Consumes: `buildMapGraph`, `MAP` and `mapNodeId` (Task 6); `useConversationStates` (Task 5); `window.fractal.map` (Task 4); `window.fractal.conversations.sideChats` (Task 3).
- Produces:
  - `useSideChats(root: ConversationRef | null): { sideChats: SideChatSummary[]; refresh(): Promise<void> }`
  - `useMapLayout(root: ConversationRef | null): { layout: MapLayout; moveNode(id: string, position: XYPosition): void; resizeNode(id: string, width: number): void; setView(view: MapView): void }`. Saves are debounced by 300 ms, and the latest layout is flushed when the root changes or on unmount.
  - `MapMode(props: ShellContext)`

- [ ] **Step 1: Write failing tests** (jsdom; `vitest.setup.ts` already stubs `ResizeObserver`):
  - With no selection, MapMode shows `Pick a conversation to see its map.` With an empty conversation, it shows `No messages yet.`
  - With a loaded conversation and one side chat, it renders a node per message with the message text. In Preview, the node clamps the text to 3 lines (a `line-clamp-3` class); in Full, there's no clamp.
  - The `Preview` / `Full` toggle calls `setView`, and the choice survives a remount through the saved layout.
  - The zoom and fit controls are `Button`s with Tooltip content `Zoom in`, `Zoom out` and `Fit to view`, and nothing on the canvas has a `title` attribute (query `[title]`).
  - `useMapLayout`: one save for a burst of moves, a flush on root change, and a failed save leaves the in-memory layout in place.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Import `@xyflow/react/dist/base.css`, not `style.css`, and style the rest in `index.css` on theme tokens.
  - `ReactFlow` props: `snapToGrid`, `snapGrid={[20, 20]}`, `minZoom={0.2}`, `maxZoom={2}`, `fitView` on first show, `nodesConnectable` (for the branch handle only), `proOptions={{ hideAttribution: true }}`, and a dotted `Background` in a `--border`-derived color on `--background`.
  - Nodes:
    - on `--card` with `--border`, in Geist
    - the main line's borders in `--primary`, and side-chat edges in `--muted-foreground` at reduced opacity
    - a top strip as the drag handle (`dragHandle: '.map-node-drag'`), with the body `nodrag nopan` so its text can be selected
    - width-only `NodeResizer` between 240 and 960.
  - Reply nodes carry a styled source `Handle` with id `branch` on the right edge, shown only when `canBranch`.
  - Layout writes: a drag-stop calls `moveNode`, and a resize-end calls `resizeNode`.
  - Measured heights come from React Flow's `node.measured.height` and feed back into `buildMapGraph`.
  - Edges use React Flow's `default` (bezier) type.
  - `readOnly` is true when the root's summary in `history.projects` has a `parentId`, meaning a subagent conversation.
  - Map leases the root and every side chat through `useConversationStates`, only while it's mounted.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `feat(map): draw a conversation and its side chats on a canvas`.

### Task 8: Starting and continuing side chats on the map

**Files:**
- Create: `src/renderer/map/side-chat-drafts.ts` (draft reducer and submit flow), `src/components/map/composer-node.tsx`, `src/components/map/selection-menu.tsx`
- Modify: `src/components/map/map-canvas.tsx`, `map-nodes.tsx`
- Test: `src/renderer/map/side-chat-drafts.test.ts`, `src/components/map/composer-node.test.tsx`, `src/components/map/selection-menu.test.tsx`

**Interfaces:**
- Consumes: `SideChatDraft` (Task 6), `ConversationHub` (Task 5), `conversations.fork`, `models.list`, `useSideChats().refresh`, and `useMapLayout().moveNode`.
- Produces:
  ```ts
  export function quoteSelection(text: string): string; // every line prefixed '> ', then a blank line
  /** Forks (unless it continues), waits for the new side chat's history, then sends with its resolved model choice. Resolves with the side chat's ref. */
  export function submitDraft(draft: SideChatDraft, deps: { hub: ConversationHub; fork: ConversationApi['fork']; modelChoice: (ref: ConversationRef) => Promise<ModelChoice | null>; refreshSideChats: () => Promise<void>; timeoutMs?: number }): Promise<ConversationRef>;
  ```

- [ ] **Step 1: Write failing tests:**
  - **`submitDraft`, new side chat:**
    - calls `fork(parent, { turnId: afterTurnId, position: 'after' }, 'side-chat')`, refreshes the side-chat list, and waits until the hub reports the new ref's `history: 'complete'` and `runtime: 'idle'`
    - sends `{ text, ...choice }` with no `access`
    - rejects with `Couldn't start the side chat.` if the fork fails, or if the history isn't complete within `timeoutMs` (default 30 000).
  - **`submitDraft`, continuing:** doesn't fork, sends to `draft.continues`, and rejects with `Couldn't send to the side chat.` on failure.
  - **Composer:** Ctrl+Enter (Cmd+Enter on macOS) submits, and Enter adds a newline. Escape on an empty draft removes it, and with text does nothing. While sending, the textarea is disabled. On failure, the error copy shows and the text is kept.
  - **Drafts (Review Focus):** dropping a handle drag on empty canvas adds one draft and calls neither `fork` nor `continue`. Removing it, or changing the root conversation, leaves no draft and no native call.
  - **Handle drags:** `onConnectEnd` with no target node adds a draft at `screenToFlowPosition` of the drop point.
    - From a main-line reply, or a side chat's earlier reply, the draft starts a side chat after that turn.
    - From a side chat's `latest` reply, the draft has `continues` set to that side chat.
  - **Selection menu:**
    - A non-empty selection inside one message node's body shows a `Side chat` button by the selection.
    - Choosing it adds a draft beside that node, prefilled with `quoteSelection(selected)`, branching after that turn's reply (the same turn when the message is the user's).
    - A selection spanning two nodes, or outside any node, shows no menu.
  - **Hand-off:** after a successful submit, the draft is removed, and its position, if the user dragged or dropped it, is saved through `moveNode` as the new side chat's first user node (`mapNodeId(ref, firstOwnTurnId, 'user')`).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** Use `MessageResponse` for the quoted prompt preview where useful. The reply node streams from the hub's state of the side chat, showing `Shimmer` while it has no text.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `feat(map): start and continue side chats on the canvas`.

### Task 9: Deleting side chats from the map

**Files:**
- Create: `src/components/map/delete-side-chat-dialog.tsx`
- Modify: `src/components/map/map-nodes.tsx`, which puts a delete action on a side chat's first user node and on its detached node
- Test: `src/components/map/delete-side-chat-dialog.test.tsx`

- [ ] **Step 1: Write failing tests:**
  - The dialog shows the exact title, body (with the nested count when there is one) and buttons from Global Constraints.
  - `Delete` calls `conversations.deleteSideChat(ref)` once, then refreshes side chats.
  - On failure, it stays open with `Couldn't delete the side chat.`
  - `Cancel` calls nothing.
  - The delete action is a `Button` with a Tooltip `Delete side chat`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement** with `components/ui/dialog.tsx`. Once a delete succeeds, also drop the deleted nodes' entries from the layout.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `feat(map): delete side chats from the map`.

### Task 10: Drive it in the real app (controller)

These steps spend real model turns on the user's Claude and Codex accounts. Approving this plan approves them, and nothing else.

- [ ] **Step 1:** Start the app with Chromium's remote debugging on: `pnpm start -- --remote-debugging-port=9222`, then check that `curl -s http://127.0.0.1:9222/json` lists the Fractal window. Drive the renderer with a small Node script in the scratchpad over CDP (Node's built-in `WebSocket`: `Runtime.evaluate`, `Input.dispatchMouseEvent`, `Page.captureScreenshot`). Use a scratch git repo with a short Claude conversation and a short Codex conversation, each with at least two turns.
- [ ] **Step 2:** For each provider, in Map mode:
  - Drag from the first reply's handle to empty canvas, type `What does package.json name this project?`, and press Ctrl+Enter. Expected: a new node streams a correct answer, and the side chat isn't in the sidebar after Mod+R.
  - Continue it from its latest reply with `Create a file named side-chat-probe.txt`. Expected: it refuses, and the file doesn't exist.
- [ ] **Step 3:** Select text in a main-line reply, choose `Side chat`, and send. Expected: the quote is at the top of the message and the reply streams in. Then drag one node, resize it, toggle `Full`, switch to Execute and back, and restart the app. Expected: the layout and view come back.
- [ ] **Step 4:** Send a message from Execute after visiting Map. Expected: it streams in Execute (Review Focus 1).
- [ ] **Step 5:** Delete the first side chat, including its nested one if any. Expected: both are gone from the map. They're also gone from the agent's own history: the session file under `~/.claude/projects/…` for Claude, and `codex resume` / `thread/list` for Codex. `branches.json` no longer lists them.
- [ ] **Step 6:** Screenshot the map in light and dark mode for the user's look-and-feel check. Write up what was observed against each expected result.
