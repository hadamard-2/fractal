# Map Mode Phase 4: Forks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user fork a conversation from any message, in Execute, in a side-chat tab and on the map, and see each fork nested under its parent in the sidebar with a divider in Execute where its own messages begin.

**Architecture:** Main already forks (phase 1: `ConversationService.fork(ref, point, 'fork')`, `BranchStore` records with `inheritedTurnCount`). This phase makes the lineage visible. The service resolves each fork's sidebar parent (through side chats, to the main conversation they belong to), puts it on listed summaries as `forkedFrom`, lists forks the agent does not list yet, and returns the lineage from `open` so Execute can place the divider. A fork of a side chat takes the main conversation's access rather than the side chat's read-only settings. In the renderer, one app-level `ForkLauncher` forks, pre-fills the composer for a fork made from your own message, and opens the fork in Execute; every surface asks it through a "Fork from here" action. The sidebar turns each project's flat list into a tree with lineage lines.

**Tech Stack:** Electron 43, React 19, TypeScript 5.9, Tailwind v4, shadcn/ui, Vitest, `@anthropic-ai/claude-agent-sdk` 0.3.296, Codex app server.

**Spec:** `docs/superpowers/specs/2026-10-19-map-mode-side-chats-and-forks-design.md`, the Forks section and phase 4. Phases 1–3 are on `main`; their plans are beside this one.

## Global Constraints

- The renderer reaches main only through `window.fractal`; channels and parsers live in `src/shared/conversation-ipc.ts`, handlers in `src/main/agent-ipc.ts`, and handlers accept calls only from the main frame (AGENTS.md). `contextIsolation` stays on.
- Fork lineage never reuses `parentId`, which means a read-only subagent conversation. It goes in its own field, `forkedFrom`.
- Tooltips come from `components/ui/tooltip.tsx` (or `MessageAction`'s `tooltip`, which uses it); never a `title` attribute. Never set `scrollbar-width` or `scrollbar-color`.
- Exact copy: the action is **"Fork from here"** (its accessible name and its tooltip). The divider reads **"Forked here"**. A fork's title stays the service's existing `"<parent title> (fork)"`.
- The divider and the lineage lines are drawn in `--primary` and `--sidebar-border` respectively; teal is the only color.
- Subagent conversations (read-only) get no fork action anywhere.
- Commits follow Conventional Commits (`feat(conversation): …`, `feat(sidebar): …`). Implementers commit their task inside the subagent-driven workflow; nobody pushes.
- Run `pnpm test`, `pnpm lint` and `pnpm exec tsc --noEmit` before calling any task done.

## Rulings made in this plan

- **The divider comes only from Fractal's record.** A fork made outside Fractal nests in the sidebar when its agent's history names its parent, but gets no divider, since only Fractal knows how many turns were inherited.
- **Native lineage.** The installed Claude SDK's `forkSession` writes `forkedFrom: { sessionId, messageUuid }` on every record it copies (checked in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`), and a Codex `Thread` has `forkedFromId`. Both are read; Fractal's record wins when both exist.
- **A fork of a side chat records where it nests.** Its record keeps `parentKey` (the side chat, as the spec asks) plus `nestsUnder` (the main conversation), so deleting the side chat later doesn't pull the fork out from under the main conversation.
- **Forks not yet listed are still listed.** Codex leaves a fork out of `thread/list` until it has run a turn of its own, and a fork made before the first message is an unsent Claude draft. The service adds recorded forks the listing lacks, so a new fork shows under its parent at once.
- **With 0 inherited turns** (forked before the first message) the divider sits above the first turn. With every turn inherited (nothing sent yet), it sits after the last one.
- **Sidebar order.** Top-level rows keep the saved, draggable order. Forks are not draggable and sit under their parent oldest first. "Show more" counts top-level rows only.
- **Errors.** A failed fork shows where each surface already shows failures: the composer's alert line in Execute and in the side-chat tab, and a dismissable alert at the bottom of the map. While a fork is pending, every "Fork from here" is disabled.

## Review Focus

- **Forking a side chat into a full conversation on Codex.** The fork must be writable, with the main conversation's sandbox, approval policy and model, not the side chat's `read-only` / `never` settings. Test in Task 2.
- **A fork whose parent isn't shown** (the parent is archived, filtered out by agent, or deleted) shows at the top level of its project, not vanishing with the parent. Test in Task 6.
- **A fork that has not been sent yet** (a Codex fork, or a Claude fork made before the first message) is in the sidebar under its parent right after it's made. Test in Task 1.
- **Forking from your own message that has images and file attachments** opens the fork with that text and those attachments in the composer, and sending sends them. Tests in Tasks 4 and 5.
- **The running turn.** No "Fork from here" on the reply that is still streaming; it stays on earlier replies, and on the running turn's own message (that fork carries only the turns before it). Test in Task 4.

---

### Task 1: Fork lineage in main

**Files:**
- Modify: `src/shared/conversation-contract.ts` (`ConversationSummary`, `ConversationApi.open`)
- Modify: `src/main/branch-store.ts` (`BranchRecord.nestsUnder`, `forkKeys()`, coercion)
- Modify: `src/main/conversation-registry.ts` (`summaryOf` keeps `forkedFrom`; `readUnlisted` becomes public)
- Modify: `src/main/conversation-service.ts` (`list`, `open`, `fork`, new `mainConversationOf`)
- Test: `src/main/branch-store.test.ts`, `src/main/conversation-service.test.ts`

**Interfaces:**
- Produces (contract):
  ```ts
  /** Where a fork came from, as the sidebar and the divider need it. */
  export interface ForkLineage {
    /** conversationKey() of the conversation it nests under: the one it was forked from, or the main conversation of the side chat it was forked from. */
    parentKey: string;
    /** How many of its leading turns are the parent's. Absent when only the agent's own history records the fork. */
    inheritedTurnCount?: number;
  }
  // ConversationSummary gains: forkedFrom?: ForkLineage;
  // ConversationApi.open resolves { summary; capabilities; forkedFrom?: ForkLineage }
  ```
- Produces (main): `BranchRecord.nestsUnder?: string`; `BranchStore.forkKeys(): Set<string>`; `ConversationRegistry.readUnlisted(ref): Promise<ConversationSummary | null>`; `ConversationService.mainConversationOf(ref: ConversationRef): ConversationRef` (the conversation a side chat belongs to, through any depth of side chats; `ref` itself otherwise).

- [ ] **Step 1: Write failing tests.**
  - `branch-store.test.ts`: a record with `nestsUnder: 'claude:main'` round-trips through a fresh store; a non-string `nestsUnder` is dropped while the record is kept; `forkKeys()` returns only fork keys.
  - `conversation-service.test.ts`, with the existing fakes:
    - `list()` puts `forkedFrom: { parentKey: 'claude:main', inheritedTurnCount: 2 }` on a listed fork recorded after the second turn of `claude:main`.
    - A fork of a side chat of `claude:main` lists with `parentKey: 'claude:main'`, and its record has `parentKey` the side chat's key and `nestsUnder: 'claude:main'`. After `deleteSideChat` on that side chat, the fork still lists with `parentKey: 'claude:main'`.
    - A recorded fork the registry doesn't list is read with `readUnlisted` (projectPath taken from the nearest listed ancestor, side chats included) and appears in its project with its lineage; when `readUnlisted` returns null or throws it is left out and the rest of the list is unaffected.
    - A fork made `before` the first message of a Claude conversation (a draft) appears in `list()` with `forkedFrom: { parentKey, inheritedTurnCount: 0 }`.
    - A listed conversation whose registry summary carries `forkedFrom: { parentKey: 'claude:x' }` and has no record keeps it; a record overrides it.
    - `open()` of a fork resolves with `forkedFrom: { parentKey, inheritedTurnCount }`; of an ordinary conversation, without `forkedFrom`; a `summary.updated` event never carries a different lineage (the lineage is only on the open result).
    - `mainConversationOf` on a side chat of a side chat returns the main conversation's ref, with the input's projectPath.
- [ ] **Step 2: Run** `pnpm test src/main/branch-store.test.ts src/main/conversation-service.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `fork`, compute `mainKey` by walking side-chat records up from the source (stop on a missing record or a key already visited) and store `nestsUnder: mainKey` when it differs from the source key. Lineage for a key is `{ parentKey: record.nestsUnder ?? record.parentKey, inheritedTurnCount }` for a `fork` record; otherwise the summary's own `forkedFrom` with its `parentKey` passed through the same side-chat walk. `list()` applies it after the side-chat filter, then appends the unlisted forks (drafts from `this.drafts`, others through `registry.readUnlisted`, which does not re-run discovery) to their project groups. The registry's `summaryOf` copies `forkedFrom` when the adapter set one.
- [ ] **Step 4: Run** `pnpm test src/main && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(conversation): give forks a lineage the sidebar and execute can read`.

### Task 2: A fork of a side chat gets the main conversation's access

**Files:**
- Modify: `src/main/harness/types.ts` (`ForkOptions.settingsFrom`)
- Modify: `src/main/harness/codex/codex-adapter.ts:176-194`
- Modify: `src/main/conversation-service.ts` (`fork` passes `settingsFrom`)
- Modify: `src/main/access-choices.ts` (`inherit`), `src/main/agent-ipc.ts:192-195` (fork handler; widen the `accessChoices` option's `Pick` with `'inherit'`)
- Test: `src/main/harness/codex/codex-adapter.test.ts`, `src/main/access-choices.test.ts`, `src/main/conversation-service.test.ts`, `src/main/agent-ipc.test.ts`

**Interfaces:**
- Consumes: `ConversationService.mainConversationOf` (Task 1).
- Produces: `ForkOptions.settingsFrom?: ConversationRef` ("A full fork takes its model and access from this conversation instead of the source; set when the source is a side chat."); `AccessChoices.inherit(fork: ConversationRef, from: ConversationRef): Promise<void>`.

- [ ] **Step 1: Write failing tests.**
  - Codex adapter: `forkConversation(sideChat, 'turn-2', { readOnly: false, title, settingsFrom: main })` resumes `main` (not the side chat) for its settings and sends `thread/fork` with `threadId: sideChat`, `lastTurnId: 'turn-2'`, and the main thread's `sandbox` (`workspace-write` from a `workspaceWrite` sandbox), `approvalPolicy` and `model`, and no read-only `config`. Without `settingsFrom` the existing behavior is unchanged.
  - Service: forking a side chat with kind `fork` passes `settingsFrom` equal to the main conversation's ref; forking the main conversation passes none.
  - `AccessChoices.inherit`: when `from` resolves to a `level` state and the fork has no stored choice, the fork's choice becomes that level, unsent (`resolve(fork)` returns it with `picked: true`); a `custom` state, a null access, or an existing choice for the fork leaves the store untouched.
  - IPC: the fork handler calls `inherit(forkRef, mainRef)` only when the source is a side chat, and a rejected `inherit` still resolves with the fork's ref.
- [ ] **Step 2: Run** `pnpm test src/main`. Expected: FAIL.
- [ ] **Step 3: Implement.** In the Codex adapter, the full-fork branch resumes `options.settingsFrom ?? source` for `forkSettingsFrom`. The Claude adapter needs no change: its read-only mode comes from the branch record per turn, and its access from the access choice that `inherit` seeds.
- [ ] **Step 4: Run** `pnpm test src/main && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `fix(conversation): fork a side chat with the main conversation's access`.

### Task 3: Native lineage from each agent's history

**Files:**
- Modify: `src/main/harness/claude/claude-history.ts` (`summarizeConversation`)
- Modify: `src/main/harness/codex/codex-adapter.ts` (`summaryFromThread`)
- Test: `src/main/harness/claude/claude-history.test.ts`, `src/main/harness/codex/codex-adapter.test.ts`

**Interfaces:**
- Produces: adapter summaries with `forkedFrom: { parentKey }` (no `inheritedTurnCount`), consumed by Task 1's `summaryOf` and `list()`.

- [ ] **Step 1: Write failing tests.**
  - A Claude transcript whose first record has `forkedFrom: { sessionId: 'parent-uuid', messageUuid: 'm1' }` summarizes with `forkedFrom: { parentKey: 'claude:parent-uuid' }`. One without it, one whose `forkedFrom.sessionId` is its own id, and a subagent transcript have no `forkedFrom`.
  - A Codex thread with `forkedFromId: 'thr_parent'` summarizes with `forkedFrom: { parentKey: 'codex:thr_parent' }`; `forkedFromId: null` gives none.
- [ ] **Step 2: Run** those two test files. Expected: FAIL.
- [ ] **Step 3: Implement.** Claude reads the first scanned record that has a string `forkedFrom.sessionId`; build keys with `conversationKey`.
- [ ] **Step 4: Run** `pnpm test src/main && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(harness): read fork lineage from Claude and Codex history`.

### Task 4: Renderer fork model: rule, draft and lineage state

**Files:**
- Create: `src/renderer/forking.ts`
- Modify: `src/renderer/conversation-reducer.ts` (`forkedFrom` from `open.succeeded`; the hub already spreads the whole open result into that action, so only the action type gains `forkedFrom?: ForkLineage`)
- Modify: `src/components/ai-elements/prompt-input.tsx` (`initialFiles` prop, local mode only)
- Test: `src/renderer/forking.test.ts`, `src/renderer/conversation-reducer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/renderer/forking.ts
  export interface ForkDraftFile { filename: string; mediaType: string; url: string; path?: string }
  export interface ForkDraft { text: string; files: ForkDraftFile[] }
  /** Whether "Fork from here" is offered at this point: after a reply, or before your own message. */
  export function canForkAt(state: ConversationState, turnId: string, position: ForkPoint['position'], readOnly: boolean): boolean;
  /** Your message as a fork's composer starts with it: its text, its inline images as data URLs, and its file attachments by path. */
  export function forkDraftOf(turn: ConversationTurn): ForkDraft;
  export function setForkDraft(conversationKey: string, draft: ForkDraft): void;
  export function forkDraft(conversationKey: string): ForkDraft | undefined;
  export function clearForkDraft(conversationKey: string): void;
  // ConversationState gains: forkedFrom: ForkLineage | null (initial null)
  // PromptInput gains: initialFiles?: Array<Omit<PromptInputFile, 'id'>>, read once at mount
  ```

- [ ] **Step 1: Write failing tests** in `forking.test.ts`:
  - `canForkAt` is false when `readOnly`, when `history !== 'complete'`, when `capabilities.fork` is false, and for an unknown turn id.
  - `after` on a completed turn is true; `after` on the last turn while it is `active` and runtime is `active-in-fractal` is false; the same turn with runtime `idle` is true.
  - `before` on that running last turn is true when the turn before it is completed; `before` on the first turn is true.
  - `forkDraftOf` on a message with text `'Try again'`, one image `{ mediaType: 'image/png', data: 'AAA' }` and attachments `[{ path: '/p/a.ts', kind: 'file' }, { path: '/p/b.png', kind: 'image' }]` returns text `'Try again'` and files `[{ filename: 'image.png', mediaType: 'image/png', url: 'data:image/png;base64,AAA' }, { filename: 'a.ts', mediaType: 'application/octet-stream', url: '', path: '/p/a.ts' }, { filename: 'b.png', mediaType: 'application/octet-stream', url: '', path: '/p/b.png' }]`. Passing those files through `promptAttachments` gives `bytes` for the image and `path` for the two attachments.
  - `forkDraft` returns what `setForkDraft` stored until `clearForkDraft`.
  - Reducer: `open.succeeded` with `forkedFrom` stores it; a later `summary.updated` keeps it; `opened` for another load resets it to null.
- [ ] **Step 2: Run** `pnpm test src/renderer/forking.test.ts src/renderer/conversation-reducer.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** `before` checks the previous turn with `canBranchTurn` (it is the last inherited turn); `after` checks the turn itself. A path attachment is a file chip (empty `url`), since the composer has no preview for a path. `PromptInput` seeds its local items from `initialFiles` with fresh ids.
- [ ] **Step 4: Run** `pnpm test src/renderer && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(conversation): add the renderer's fork rule and composer draft`.

### Task 5: "Fork from here" in Execute, the divider, and opening the fork

**Files:**
- Create: `src/components/conversation/fork-launcher.tsx`
- Modify: `src/App.tsx` (provides the launcher above `RightWorkspace`; switches to Execute), `src/components/app-shell.tsx` (an `openRequest` prop)
- Modify: `src/components/conversation/conversation-turn.tsx` (hover actions), `src/components/conversation/virtual-timeline.tsx` (divider), `src/components/conversation-panel.tsx` (provides the turn actions, prefill, divider index)
- Test: `src/components/conversation/conversation-turn.test.tsx`, `src/components/conversation/virtual-timeline.test.tsx`, `src/components/conversation/fork-launcher.test.tsx`

**Interfaces:**
- Consumes: `canForkAt`, `forkDraftOf`, `setForkDraft`, `forkDraft`, `clearForkDraft`, `ConversationState.forkedFrom`, `PromptInput.initialFiles` (Task 4).
- Produces:
  ```ts
  // fork-launcher.tsx
  export interface ForkLauncher {
    /** Forks `source` after `turn`'s reply or before its message, then opens the fork in Execute. Rejects with the agent's error. */
    fork(source: ConversationRef, turn: ConversationTurn, position: ForkPoint['position']): Promise<void>;
    /** True while a fork is being made; every "Fork from here" is disabled meanwhile. */
    pending: boolean;
  }
  export const ForkLauncherContext: React.Context<ForkLauncher | null>;
  export const useForkLauncher: () => ForkLauncher | null;
  /** The launcher App provides; `open` shows the new fork in Execute. */
  export function useForkLauncherValue(open: (ref: ConversationRef) => void): ForkLauncher;
  // conversation-turn.tsx
  export interface TurnForkActions { can(turn: ConversationTurn, position: ForkPoint['position']): boolean; fork(turn: ConversationTurn, position: ForkPoint['position']): void }
  export const TurnForkContext: React.Context<TurnForkActions | null>;
  // virtual-timeline.tsx Props gains: dividerBefore?: number — the index of the first turn the fork made itself
  // app-shell.tsx AppShell gains: openRequest?: { ref: ConversationRef; id: number } | null
  ```

- [ ] **Step 1: Write failing tests.**
  - `conversation-turn.test.tsx`: inside a `TurnForkContext` whose `can` is true, the user message shows a "Fork from here" button that calls `fork(turn, 'before')`, and the reply shows one that calls `fork(turn, 'after')`; with `can` false for a position, or with no context, that button is absent; the reply's button shows even when the reply has no copyable text.
  - `virtual-timeline.test.tsx`: with three turns and `dividerBefore: 2`, a separator named "Forked here" sits between the second and third turn's articles; with `dividerBefore: 0` it precedes the first; with `dividerBefore: 3` it follows the last; without the prop there is none.
  - `fork-launcher.test.tsx`: `fork(source, turn, 'before')` calls `window.fractal.conversations.fork(source, { turnId: turn.id, position: 'before' }, 'fork')`, stores `forkDraftOf(turn)` under the new ref's key before calling `open(newRef)`; `'after'` stores no draft; `pending` is true until the IPC settles; a rejection propagates and `open` is not called.
- [ ] **Step 2: Run** those three files. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The hover row beside Copy becomes one `MessageActions` holding Copy (when there is text) and Fork (when `can`), using `MessageAction` with label and tooltip "Fork from here" and lucide's `GitFork`.
  - The divider is a `role="separator"` row with `aria-label="Forked here"`: a 1px `bg-primary` line each side of the words in `text-primary text-xs`, rendered inside the row of turn `dividerBefore` above its article, or in the footer slot ahead of `footer` when `dividerBefore === turns.length`.
  - The panel provides `TurnForkContext` with `can = launcher && !launcher.pending && canForkAt(state, turn.id, position, readOnly)` and `fork` catching into `actionError`; passes `dividerBefore={state.forkedFrom?.inheritedTurnCount}`; reads `forkDraft(key)` in its `useState` initializers for the input and `initialFiles`, and calls `clearForkDraft(key)` in a mount effect (never inside an initializer, which StrictMode runs twice).
  - App keeps `openRequest` state; `open(ref)` sets Execute mode and a new request id. AppShell applies each new id once: `selectCreated(ref)` and `refreshHistory()`, so the sidebar lists the fork.
- [ ] **Step 4: Run** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(conversation): fork from any message in execute and mark where the fork begins`.

### Task 6: Forks nested in the sidebar with lineage lines

**Files:**
- Modify: `src/components/sidebar-03/sidebar-order.ts` (`chatRows`)
- Modify: `src/components/sidebar-03/nav-main.tsx` (tree rendering; `sidebarMoveAtIndices` over top-level rows)
- Test: `src/components/sidebar-03/sidebar-order.test.ts`, `src/components/sidebar-03/nav-main.test.tsx`

**Interfaces:**
- Consumes: `ConversationSummary.forkedFrom` (Task 1).
- Produces:
  ```ts
  export interface ChatRow { conversation: ConversationSummary; forks: ChatRow[] }
  /** A project's chats as a tree: a fork under its parent when the parent is among `conversations`, else at the top level in its own place. */
  export function chatRows(conversations: ConversationSummary[]): ChatRow[];
  ```

- [ ] **Step 1: Write failing tests.**
  - `chatRows`: `[a, f1 (fork of a, createdAt 2), b, f2 (fork of a, createdAt 1), g (fork of f1)]` gives top level `[a, b]`, `a.forks` `[f2, f1]`, and `f1.forks` `[g]`. A fork whose parent is absent stays top-level at its own index. Two forks naming each other as parents both end up top-level, with no infinite loop.
  - `nav-main.test.tsx`: a fork renders inside a `role="group"` named "Forks of <parent title>" under its parent's row; selecting the fork row calls `onSelect` with the fork; "Show more" appears after five top-level rows regardless of forks; `sidebarMoveAtIndices` maps sortable indices to top-level rows (moving the second top-level row onto the first reports those two chats, even with forks under the first); a fork's row has the same context menu (Rename, Archive) as any chat.
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Forks under one parent sort oldest first by `createdAt`, falling back to `updatedAt`. Pull the chat row's button and context menu out into one component that both levels use. Only top-level rows are `SortableRow`s; a row's forks render inside its sortable item, so they move with it while dragging. Each nesting level is a `ul` indented one step, whose `li`s draw the lineage with `before:` pseudo-elements in `bg-sidebar-border`: a vertical line down from the parent and a short horizontal tick into the row, where the last child's vertical line stops at its tick. Build the rows from the already-filtered project (`sidebarProjects`, `withoutAgents`), so an archived or hidden parent leaves its forks at the top level.
- [ ] **Step 4: Run** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(sidebar): nest forks under their parent with lineage lines`.

### Task 7: "Fork from here" in side-chat tabs and on the map

**Files:**
- Modify: `src/components/right-panel/side-chat-pane.tsx` (provides `TurnForkContext` once bound)
- Modify: `src/components/map/map-nodes.tsx` (`ForkAction` in `NodeFrame`'s header; environment gains `fork`), `src/components/map/map-canvas.tsx` (builds it; alert)
- Test: `src/components/right-panel/side-chat-pane.test.tsx`; create `src/components/map/map-nodes.test.tsx` (jsdom, rendering nodes inside `ReactFlowProvider` with a `MapNodeEnvironmentContext` value)

**Interfaces:**
- Consumes: `useForkLauncher`, `TurnForkContext` (Task 5); `canForkAt` (Task 4).
- Produces: `MapNodeEnvironment.fork?: { can(owner: ConversationRef, turn: ConversationTurn, position: ForkPoint['position']): boolean; start(owner: ConversationRef, turn: ConversationTurn, position: ForkPoint['position']): void }`.

- [ ] **Step 1: Write failing tests.**
  - Side-chat pane: once bound, its turns show "Fork from here", and choosing one on a reply calls the launcher with the side chat's ref, the turn and `'after'`; an unsent tab shows none; a launcher rejection shows its message in the pane's alert line.
  - Map nodes: a user node shows a "Fork from here" header button that calls `start(owner, turn, 'before')`, and a reply node one that calls `start(owner, turn, 'after')`, in both Preview and Full; with `can` false or no `fork` in the environment, there's no button; composer and detached nodes never have one; in Full, the message bodies show Copy but no second "Fork from here" (the map provides no `TurnForkContext`).
- [ ] **Step 2: Run** both files. Expected: FAIL.
- [ ] **Step 3: Implement.** The map builds `fork` only when the root is not read-only and a launcher exists; `can` uses the owner's state from `states` with `canForkAt`; `start` catches into a map-level error shown as a `role="alert"` line at the bottom center of the canvas with a "Dismiss" button, cleared by the next fork. `ForkAction` mirrors `OpenAction` (`nodrag nopan`, our tooltip, `GitFork`).
- [ ] **Step 4: Run** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(map): fork from side-chat tabs and map nodes`.

### Task 8: Verify in the real app (controller)

Not an implementer task: the controller drives `pnpm start -- --remote-debugging-port=9333` with playwright-core, with real Claude and Codex conversations, and records what it saw in the ledger.

- [ ] Fork from an earlier reply in Execute, for each agent: the fork opens in Execute titled "<title> (fork)", sits under its parent in the sidebar with lineage lines, and shows "Forked here" after the inherited turns. Send in it and confirm the parent is untouched.
- [ ] Fork from your own earlier message with an attachment: the composer opens with that text and attachment, the divider sits before where the message was, and sending works.
- [ ] Fork before the very first message, for each agent: the fork is listed under its parent before anything is sent.
- [ ] Fork a side chat from its tab and from the map, on Codex and on Claude: the fork nests under the main conversation, and a write succeeds in it (it is not read-only). Then delete the side chat and confirm the fork stays nested.
- [ ] Archive the parent: the fork moves to the top level of its project.
- [ ] `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit` on the finished branch.
