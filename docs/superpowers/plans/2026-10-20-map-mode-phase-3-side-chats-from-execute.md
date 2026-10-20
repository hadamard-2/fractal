# Map Mode Phase 3: Side Chats from Execute Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start, read and continue side chats from Execute mode, in a side-chat tab in the right panel, opened from the panel's tool list (branching from the latest reply), from text selected in the transcript, or from a side chat on the map.

**Architecture:** This phase is renderer-only. Phases 1 and 2 already give the renderer everything native: `conversations.fork(…, 'side-chat')`, `sideChats`, `deleteSideChat`, and the shared `ConversationHub`. The map's send flow (`submitDraft`) and its text-selection menu move out of `map/` so Execute and the right panel can use them too. The panel's tab model gains a `side-chat` kind, which starts as an unsent draft (nothing native exists yet) and binds to a side-chat ref once the first send forks it. `RightWorkspace` provides a `SideChatLauncherContext` next to the existing terminal launcher, so Execute's selection menu and the map's new "Open in panel" action can open tabs. A small renderer-wide signal tells every `useSideChats` for a root to re-list, so a side chat started in the panel shows up on a visible map, and a tab closes when its side chat is deleted on the map.

**Tech Stack:** React 19, TypeScript 5.9, Tailwind v4, shadcn/ui, Vitest (node and jsdom), `@xyflow/react` 12.12.0.

**Spec:** `docs/superpowers/specs/2026-10-19-map-mode-side-chats-and-forks-design.md`. This plan covers phase 3 only: side chats from Execute mode (start ways 3 and 4), plus the spec's "Open in panel" call, which needs the panel tab this phase adds. Forks in the UI (phase 4) get their own plan. Phases 1 and 2 are merged on `main`: `docs/superpowers/plans/2026-10-19-map-mode-phase-1-fork-support.md` and `docs/superpowers/plans/2026-10-19-map-mode-phase-2-side-chats-and-map.md`.

## Global Constraints

- No new IPC channels and no main-process changes. Everything goes through the existing `window.fractal.conversations` and `window.fractal.models` surfaces.
- One branching rule everywhere. A turn can start a side chat when its conversation isn't a subagent conversation and the turn isn't `active` while the conversation's runtime is in `BUSY_RUNTIMES`. This is today's rule in `map-graph.ts` (`canBranch`), extracted and reused, not restated.
- Side chats in the panel show only their own turns (from `inheritedTurnCount` on), as the map does.
- Closing a side-chat tab only closes the view. An unsent tab leaves nothing native behind. Deleting stays on the map (spec: "getting rid of it means deleting it").
- A side chat never sends an access setting. Its first message runs with the parent's resolved model choice, and later ones with its own (today's `submitDraft` behavior, unchanged).
- Exact copy:
  - Tool entry `Side chat`, disabled hints: `Open a conversation first` (nothing selected), `Not available in subagent chats` (a subagent conversation), `No reply to branch from yet` (no turn can branch).
  - Tab label: `Side chat`. Tab tooltip: the first line of its branch-point text, cut to 80 characters with a trailing `…` when cut, or `Side chat` when there's no text.
  - Pane header: `Branched from`, above the branch-point text clamped to 3 lines. No header when there's no text.
  - Composer: placeholder `Ask a side question`, `aria-label` `Side question`. Enter sends and Shift+Enter adds a newline, as in Execute's composer.
  - Read-only note under the composer: `Side chats can read files but can't change them.`
  - Failures: `Couldn't start the side chat.` and `Couldn't send to the side chat.`, the strings `submitDraft` already throws.
  - Selection menu entry: `Side chat` (unchanged).
  - Map action: `aria-label` and tooltip `Open in panel`.
- UI rules (AGENTS.md): tooltips only from `components/ui/tooltip.tsx`, never `title`; no `scrollbar-width` / `scrollbar-color`; anything new in the app-bar band needs `app-region-no-drag` (nothing in this plan should go there).
- Commits use Conventional Commits. Commit only inside the subagent-driven workflow, and never push.
- Run `pnpm test`, `pnpm lint` and `pnpm exec tsc --noEmit` before calling any task done.

## Review Focus

- **A side chat started in the panel while the map of the same conversation is on screen.** The panel is visible in every mode, so this happens. The new side chat shows up on the map without switching modes. Tests in Tasks 1 and 6.
- **Deleting a side chat on the map while it, or a side chat nested in it, is open in a panel tab.** The tab closes, and no "failed to load" error flashes first. An unsent tab whose parent was deleted stays, and its send fails with `Couldn't start the side chat.` Tests in Tasks 3 and 6.
- **Opening the tool while the latest turn is still running.** It branches from the latest reply that can branch, which is the previous finished one, and is disabled with `No reply to branch from yet` if there's none. Tests in Tasks 1 and 4.
- **The first send fails after the fork succeeded.** `submitDraft` deletes the new side chat. The tab goes back to unsent, keeps the typed text, and shows `Couldn't start the side chat.` A retry forks afresh. Test in Task 3.
- **Selections that must not offer the menu:** text in the composer, a selection spanning two turns, a selection in a subagent conversation, and a selection in the hidden Execute view while Map is shown. Tests in Tasks 2 and 5.

---

### Task 1: Shared side-chat start logic and the re-list signal

**Files:**
- Create: `src/renderer/side-chat-start.ts` (moved from `src/renderer/map/side-chat-drafts.ts`: `quoteSelection`, `submitDraft`, and its private `whenReady` and `send`), `src/renderer/side-chat-events.ts`, `src/renderer/side-chat-branching.ts`
- Modify: `src/renderer/map/side-chat-drafts.ts` (keeps the canvas-only parts and imports the rest), `src/renderer/map/map-graph.ts` (uses `canBranchTurn`), `src/renderer/map/use-side-chats.ts`, `src/components/map/map-canvas.tsx` (imports only)
- Test: `src/renderer/side-chat-start.test.ts` (the moved `submitDraft` and `quoteSelection` cases, plus the new ones), `src/renderer/side-chat-branching.test.ts`, `src/renderer/map/use-side-chats.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // side-chat-start.ts
  export function quoteSelection(text: string): string;
  /** What to send: more of an existing side chat when `continues` is set, otherwise a new side chat after `afterTurnId`'s reply in `parent`. */
  export type SideChatRequest = { text: string } & ({ continues: ConversationRef } | { parent: ConversationRef; afterTurnId: string });
  export function submitDraft(request: SideChatRequest, deps: {
    hub: ConversationHub;
    fork: ConversationApi['fork'];
    deleteSideChat: ConversationApi['deleteSideChat'];
    modelChoice: (ref: ConversationRef) => Promise<ModelChoice | null>;
    refreshSideChats: () => Promise<void>;
    /** Called once the fork has made the side chat, before its history is read or anything is sent. */
    onStarted?: (ref: ConversationRef) => void;
    timeoutMs?: number;
  }): Promise<ConversationRef>;
  // side-chat-branching.ts
  export function canBranchTurn(turn: ConversationTurn, runtime: ConversationRuntime, readOnly: boolean): boolean;
  /** The latest turn a side chat can branch from, or null; null too until the history is complete. */
  export function latestBranchableTurn(state: ConversationState, readOnly: boolean): ConversationTurn | null;
  // side-chat-events.ts
  /** Tells every useSideChats for this root (by conversationKey) to list again. */
  export function announceSideChats(rootKey: string): void;
  export function onSideChatsChanged(listener: (rootKey: string) => void): () => void;
  // use-side-chats.ts: the hook gains `listed`
  export function useSideChats(root: ConversationRef | null): { sideChats: SideChatSummary[]; listed: boolean; refresh(): Promise<void> };
  ```
  `SideChatDraft` (in `map-graph.ts`) stays as it is and is assignable to `SideChatRequest`.

- [ ] **Step 1: Write failing tests:**
  - The existing `submitDraft` and `quoteSelection` cases pass against `side-chat-start.ts`.
  - `onStarted` is called once with the forked ref, before `modelChoice` and before `hub.send`. It isn't called when the fork fails or when the request continues a side chat.
  - `canBranchTurn`: false when `readOnly`; false for an `active` turn while the runtime is `active-in-fractal`, `active-externally` or `waiting-for-user`; true for an `active` turn while `idle` (a history that never recorded the turn's end).
  - `latestBranchableTurn`: null while `history` isn't `complete`, and null with no turns. With the last turn active and the runtime busy, it returns the turn before it, or null if that was the only one.
  - `useSideChats`: `listed` is false until the first listing for the current root resolves, and false again right after the root changes. `announceSideChats(key)` makes every mounted hook for that root list again, and hooks for other roots don't.
- [ ] **Step 2:** Run them, `pnpm vitest run src/renderer`. Expected: FAIL.
- [ ] **Step 3: Implement.** Move the code rather than copy it. `map-graph.ts`'s `canBranch` becomes `canBranchTurn(turn, state.runtime, readOnly)`. The events module is a plain `Set` of listeners.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`. The map's tests pass unchanged apart from imports.
- [ ] **Step 5: Commit:** `refactor(side-chats): share the side-chat send flow and branching rule outside the map`.

### Task 2: A selection menu for any transcript

**Files:**
- Create: `src/components/conversation/selection-menu.tsx` (moved from `src/components/map/selection-menu.tsx`)
- Modify: `src/components/map/map-nodes.tsx` (the message body's `data-map-message` becomes `data-selection-source={id}`), `src/components/map/map-canvas.tsx` (passes a container ref)
- Test: `src/components/conversation/selection-menu.test.tsx` (moved and extended)

**Interfaces:**
- Produces:
  ```ts
  export interface MessageSelection { sourceId: string; text: string; left: number; bottom: number }
  /**
   * Text selected inside one `[data-selection-source]` element within `container`
   * that `accepts` takes, or null. `accepts` null offers nothing.
   */
  export function useMessageSelection(container: RefObject<HTMLElement | null>, accepts: ((sourceId: string) => boolean) | null): { selection: MessageSelection | null; dismiss(): void };
  export function SelectionMenu(props: { selection: MessageSelection; onChoose(): void }): ReactPortal;
  ```
  `sourceId` replaces `nodeId`. On the map, it's the node id.

- [ ] **Step 1: Write failing tests:**
  - The existing cases pass with `data-selection-source` in place of `data-map-message` and `.react-flow__node`.
  - A selection inside a source that sits outside `container` gives null, even when `accepts` would take it. Two hooks with sibling containers each see only their own selections.
  - A selection inside a `textarea` inside the container gives null.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** Both endpoints must resolve to the same source element, and that element must be inside `container.current`. The map passes a ref to the element that wraps its `ReactFlow`.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `refactor(conversation): let any transcript offer the side-chat selection menu`.

### Task 3: The side-chat pane

**Files:**
- Create: `src/components/right-panel/side-chat-pane.tsx`, `src/components/right-panel/side-chat-launcher.tsx`
- Modify: `src/components/conversation/conversation-turn.tsx` (`ConversationTurn`'s `article` gets `data-selection-source={turn.id}`, and `replyPreview` moves here from `map-nodes.tsx` as an export)
- Test: `src/components/right-panel/side-chat-pane.test.tsx`

**Interfaces:**
- Consumes: `submitDraft`, `SideChatRequest`, `useSideChats`, `announceSideChats`, `canBranchTurn` (Task 1); `useMessageSelection`, `SelectionMenu` (Task 2); `useConversation`; `VirtualTimeline`.
- Produces:
  ```ts
  // side-chat-launcher.tsx
  export interface SideChatLauncher {
    /** A new, unsent side chat after `turn`'s reply in `parent`, opening with `text` in its composer. */
    start(input: { root: ConversationRef; parent: ConversationRef; turn: ConversationTurn; text: string }): void;
    /** An existing side chat: its open tab if it has one, otherwise a new tab. */
    open(input: { root: ConversationRef; sideChat: ConversationRef; branchPointText?: string }): void;
  }
  export const SideChatLauncherContext: Context<SideChatLauncher | null>;
  export const useSideChatLauncher: () => SideChatLauncher | null;
  // conversation-turn.tsx
  /** The prose a reply's preview starts from: its answer as Execute shows it, or all its prose without one. */
  export function replyPreview(turn: ConversationTurn): string;
  // side-chat-pane.tsx
  export function SideChatPane(props: {
    root: ConversationRef;
    /** Set while unsent: what the first send forks from, and the composer's starting text. */
    draft: { parent: ConversationRef; afterTurnId: string; text: string } | undefined;
    /** Null until the first send creates it. */
    sideChat: ConversationRef | null;
    branchPointText: string | undefined;
    /** The first send forked this side chat; null puts the tab back to unsent after that send failed. */
    onBound(sideChat: ConversationRef | null): void;
    /** The side chat is no longer listed under its root: it was deleted. */
    onGone(): void;
  }): JSX.Element;
  ```

- [ ] **Step 1: Write failing tests** (jsdom, `window.fractal.conversations` and `models` mocked):
  - **Unsent:** shows `Branched from` and the branch-point text, and the composer prefilled with the draft text. Nothing native is called on mount or unmount (Review Focus: an abandoned tab leaves nothing).
  - **First send:** Enter calls `fork(parent, { turnId: afterTurnId, position: 'after' }, 'side-chat')`, calls `onBound(ref)` before the send, and sends `{ text, ...parentChoice }` with no `access`. Shift+Enter adds a newline and sends nothing.
  - **Failed first send (Review Focus):** when the send after the fork rejects, `deleteSideChat(ref)` is called, `onBound(null)` follows, the composer keeps the text, and `Couldn't start the side chat.` shows. A second Enter forks again.
  - **Bound:** shows only the turns from `inheritedTurnCount` on, from the listing for `root`. A send continues the side chat (no fork) with the side chat's own model choice. A failed one shows `Couldn't send to the side chat.`
  - **Gone (Review Focus):** once a listing for `root` that started after binding resolves without the side chat, `onGone` is called once. A listing from before the bind never counts.
  - **Read-only note:** `Side chats can read files but can't change them.` is shown in both states.
  - **Interrupt:** while the side chat is `active-in-fractal` and its capabilities allow `interrupt`, the submit button becomes the stop button and calls `conversations.interrupt(sideChat)`.
  - **Nested start:** with a launcher in context, selecting text in one of the side chat's own turns (one `canBranchTurn` accepts) shows `Side chat`, and choosing it calls `launcher.start({ root, parent: sideChat, turn, text: quoteSelection(selected) })`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The pane holds its lease through `useConversation(sideChat)` and reads its listing with `useSideChats(sideChat ? root : null)`. Passing null while unsent makes the first listing after binding the first one that counts for `onGone`.
  - Sends go through `submitDraft` with `hub: conversationHub()`, `refreshSideChats: async () => announceSideChats(conversationKey(root))`, and `onStarted: onBound`. A continuing send passes `{ continues: sideChat, text }`.
  - Layout: the bound transcript is a `VirtualTimeline` in the panel's width, and the composer is a `PromptInput` with a `PromptInputTextarea` and `PromptInputSubmit`, with no attachments, access picker or model picker. Use the conversation panel's `@container` column pattern, so the pane reads like Execute at panel width.
  - Until the listing gives `inheritedTurnCount`, a bound pane shows `Shimmer` `Reading history…`.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `feat(right-panel): add a side-chat pane that starts, shows and continues a side chat`.

### Task 4: Side-chat tabs in the right panel

**Files:**
- Modify: `src/renderer/panel-tabs.ts`, `src/components/right-panel/panel-tabs.tsx`, `src/components/right-panel/tool-entries.tsx`, `src/components/right-workspace.tsx`, `src/components/app-shell.tsx`, `src/App.tsx`
- Test: `src/renderer/panel-tabs.test.ts`, `src/components/right-panel/panel-tabs.test.tsx`, `src/components/right-panel/tool-entries.test.tsx`, `src/components/right-workspace.test.tsx`

**Interfaces:**
- Consumes: `SideChatPane`, `SideChatLauncherContext`, `replyPreview` (Task 3); `latestBranchableTurn` (Task 1); `conversationHub()`.
- Produces:
  ```ts
  // panel-tabs.ts
  export type SideChatPanelTab = {
    kind: 'side-chat'; id: string;
    root: ConversationRef;
    draft?: { parent: ConversationRef; afterTurnId: string; text: string };
    sideChat: ConversationRef | null;
    branchPointText?: string;
  };
  export type PanelTab = TerminalPanelTab | FilePanelTab | ChangesPanelTab | SideChatPanelTab;
  /** A new unsent tab, except that an unsent tab with the same parent and turn and empty text is selected instead. */
  export function startSideChatTab(state: PanelTabsState, input: { root: ConversationRef; parent: ConversationRef; afterTurnId: string; text: string; branchPointText?: string }, newId: string): PanelTabsState;
  /** Selects the tab bound to `sideChat`, or adds one. */
  export function openSideChatTab(state: PanelTabsState, input: { root: ConversationRef; sideChat: ConversationRef; branchPointText?: string }, newId: string): PanelTabsState;
  export function bindSideChatTab(state: PanelTabsState, id: string, sideChat: ConversationRef | null): PanelTabsState;
  // app-shell.tsx: AppShell gains
  onConversationChange?: (conversation: { ref: ConversationRef; readOnly: boolean } | null) => void;
  // right-workspace.tsx: RightWorkspace gains
  conversation: { ref: ConversationRef; readOnly: boolean } | null;
  // tool-entries.tsx: Handlers gains
  sideChat: { onSelect?: () => void; hint?: string };
  ```

- [ ] **Step 1: Write failing tests:**
  - **Tab model:** `startSideChatTab` adds and selects an unsent tab, and reuses an unsent one with the same parent, turn and empty text. `openSideChatTab` selects the tab already bound to that side chat (compared by `conversationKey`), or adds one. `bindSideChatTab` sets or clears `sideChat` and keeps `draft`. `closeTab` works on side-chat tabs like any other.
  - **Tab strip:** a side-chat tab is labelled `Side chat`, its tooltip is the cut branch-point text, or `Side chat`, and no element has a `title`.
  - **Tool entry:** enabled when the selected conversation has a branchable turn. Otherwise it's disabled with the hint from Global Constraints for each of the three cases. The menu item in the `+` dropdown behaves the same.
  - **Latest reply (Review Focus):** with the selected conversation's last turn `active` and its runtime `active-in-fractal`, choosing the entry opens a tab whose `draft.afterTurnId` is the turn before. Hub state is mocked through `conversationHub()`.
  - **Launcher:** `start` and `open` from a child of `RightWorkspace` open the panel if it's closed and select the new or existing tab. With no project, the context value is null.
  - **Gone:** a pane's `onGone` closes its tab.
  - **Panes stay mounted:** switching away from a side-chat tab and back keeps its typed text.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `AppShell` reports the selected conversation the way it reports `onProjectPathChange`, with `readOnly` true when its summary has a `parentId`. `App` holds it and passes it to `RightWorkspace`.
  - The tool entry's state comes from the hub through `useSyncExternalStore` with a selector that returns the branchable turn's id, or the hint, so the panel doesn't re-render on every streamed event.
  - Every side-chat tab's pane renders, hidden when it isn't selected, like the Changes panes. Pick an icon from `lucide-react` (`MessageCircle`) for the tab.
  - The launcher computes `branchPointText` for `start` with `replyPreview(turn)`.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `feat(right-panel): open side chats in right-panel tabs from the tool list`.

### Task 5: The selection menu in Execute

**Files:**
- Modify: `src/components/conversation-panel.tsx`, `src/components/execute-mode.tsx`
- Test: `src/components/conversation-panel.test.tsx`, `src/components/execute-mode.test.tsx`

**Interfaces:**
- Consumes: `useMessageSelection`, `SelectionMenu` (Task 2); `canBranchTurn`, `quoteSelection` (Task 1); `useSideChatLauncher` (Task 3).
- Produces: `ConversationPanel` gains `readOnly?: boolean`. `ExecuteMode` passes it, true for a subagent conversation (summary with a `parentId`, the same test `MapMode` uses).

- [ ] **Step 1: Write failing tests:**
  - Selecting text in a finished reply shows `Side chat`. Choosing it calls `launcher.start({ root: ref, parent: ref, turn, text: quoteSelection(selected) })`, clears the selection and hides the menu.
  - Text selected in a user message branches after that same turn's reply (the same `turn`).
  - No menu (Review Focus): with `readOnly`, for a turn `canBranchTurn` refuses, in the composer, across two turns, with no launcher in context, and while `ExecuteMode` is inactive (hidden behind Map).
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** The container is the transcript's wrapper. The menu is offered only while the panel is active and a launcher is present.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `feat(execute): start a side chat from text selected in the transcript`.

### Task 6: The map and the panel together

**Files:**
- Modify: `src/components/map/map-nodes.tsx`, `src/components/map/map-canvas.tsx`
- Test: `src/components/map/map-mode.test.tsx`

**Interfaces:**
- Consumes: `useSideChatLauncher` (Task 3), `announceSideChats` and the `useSideChats` re-listing (Task 1).
- Produces: `MapNodeEnvironment.deletions` becomes
  ```ts
  /** By conversationKey() of the side chat. */
  sideChats: ReadonlyMap<string, { firstTurnId: string | undefined; open?: () => void; requestDelete?: () => void }>;
  ```
  Every side chat is listed. `open` is set when a launcher is present, and `requestDelete` when it isn't busy (today's rule).

- [ ] **Step 1: Write failing tests:**
  - A side chat's first own user node, and its detached node, show an `Open in panel` button with that tooltip, next to `Delete side chat` when deleting is offered. It shows even while the side chat is busy. Clicking it calls `launcher.open({ root, sideChat: summary.ref, branchPointText: summary.branchPointText })`.
  - With no launcher in context, there's no `Open in panel`.
  - **Review Focus:** `announceSideChats(rootKey)` while the map is mounted lists the side chats again, and a newly listed side chat's nodes appear.
  - After a successful delete, the map calls `announceSideChats(rootKey)`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the `PanelRight` icon, in the same ghost `icon-xs` button style as the delete action.
- [ ] **Step 4:** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit:** `feat(map): open a side chat in the right panel`.

### Task 7: Drive it in the real app (controller)

These steps spend real model turns on the user's Claude and Codex accounts. Approving this plan approves them, and nothing else.

- [ ] **Step 1:** Start the app with `pnpm start -- --remote-debugging-port=9333` and drive the renderer with `playwright-core`'s `chromium.connectOverCDP`, from a script in the scratchpad, as in phase 2. Use the scratch git repo with a short Claude conversation and a short Codex conversation, each with at least two turns.
- [ ] **Step 2:** For each provider, in Execute, open the right panel's tool list and choose `Side chat`. Expected: the tab's header shows the latest reply's start. Ask `What does package.json name this project?`. Expected: the answer streams in the tab, and the side chat isn't in the sidebar.
- [ ] **Step 3:** In the same tab, ask `Create a file named side-chat-probe.txt`. Expected: it refuses, with no approval card, and the file doesn't exist.
- [ ] **Step 4:** Select text in a main-line reply in Execute and choose `Side chat`. Expected: a new tab opens with the quote in its composer. Send a question under it. Expected: the reply streams in.
- [ ] **Step 5:** Switch to Map with the panel open. Expected: both side chats are on the canvas. Choose `Open in panel` on one. Expected: its existing tab is selected. Start one more from the panel's `+` menu while the map is showing. Expected: it appears on the map after its first send (Review Focus 1).
- [ ] **Step 6:** Delete, on the map, a side chat that's open in a tab. Expected: the tab closes and no error shows (Review Focus 2).
- [ ] **Step 7:** Close an unsent side-chat tab. Expected: no new native session (no new entry in `branches.json`, and the CLIs' session lists are unchanged).
- [ ] **Step 8:** Screenshot the side-chat tab in light and dark mode for the user's look-and-feel check. Write up what was observed against each expected result.
