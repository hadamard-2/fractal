# Map Mode Phase 1: Fork Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let main fork a Claude or Codex conversation after any turn, either as a read-only side chat or as a full fork, and keep enforcing what each one is on every later turn.

**Architecture:** Each adapter gains `forkConversation`. Claude uses the Agent SDK's `forkSession` with `upToMessageId`, and Codex uses `thread/fork` with `lastTurnId`. A new `BranchStore` in userData records which sessions are side chats or forks, what they branched from, and the note the agent gets. `ConversationService.fork` resolves the fork point from the open conversation's turns, calls the adapter, and writes the record. On every `continue`, the service reads the record back and tells the adapter through `AgentPrompt.branch`, and each adapter enforces read-only in its own machinery. Side chats are filtered out of `list()`. The renderer reaches all of this through `window.fractal.conversations.fork`.

**Tech Stack:** Electron 43 main process, TypeScript 5.9, Vitest, `@anthropic-ai/claude-agent-sdk` 0.3.296, Claude Code 2.1.296, Codex app server (codex-cli 0.162.1).

**Spec:** `docs/superpowers/specs/2026-10-19-map-mode-side-chats-and-forks-design.md`. This plan covers phase 1 only, fork support in both harnesses. Phases 2–4 get their own plans.

## Global Constraints

- Handlers go through `registerConversationIpc`'s `invoke` helper, which checks the main frame; channel names and parsers live in `src/shared/conversation-ipc.ts` (AGENTS.md).
- `contextIsolation` stays on and `nodeIntegration` off. The renderer gets the feature only through `window.fractal`.
- Fractal never handles API keys and drives only the user's installed CLIs.
- Read-only must be enforced by the agent's own machinery: Claude's `--tools` / `--disallowedTools` / `--permission-prompts none`, and Codex's `readOnly` sandbox with `approvalPolicy: 'never'`. Never enforce it with prompt text alone.
- `ConversationService` must not gain a field whose name matches `/store|storage|transcript|data.*path/i`; `native-continuity.integration.test.ts` asserts this. Name the new field `branches`.
- Commit messages follow Conventional Commits (`feat(harness): …`, `feat(conversation): …`). Commit only inside the subagent-driven workflow, and never push.
- Run `pnpm test`, `pnpm lint` and `pnpm exec tsc --noEmit` before calling any task done.

Exact copy for the notes, defined once in `src/main/branch-notes.ts`:

```ts
export const SIDE_CHAT_NOTE = "You are in a read-only side conversation that branched off an earlier point of the user's main conversation. You can read and search the project, but you cannot change any files. The project's files may have changed since the point this conversation branched from, so when what you read disagrees with the conversation so far, trust the files.";
export const FORK_NOTE = 'This conversation was forked from an earlier point of another conversation, and work may have continued there after that point. The project\'s files may have changed since then, so when what you read disagrees with the conversation so far, trust the files.';
```

## Review Focus

- **Forking from a turn that is still running.** It must be refused with "Cannot fork from a turn in progress". Codex rejects it anyway, and Claude would copy a half-written turn. Test in Task 6.
- **An access pick sent for a side chat** (e.g. `full-access`) must be ignored by the service and never recorded by the IPC layer. Test in Task 6.
- **The user's own Claude allow rules** (say, `allow: ["Edit"]` in `~/.claude/settings.json`) must not let a side chat write. That's why Claude side chats restrict the available tools, which an allow rule can't widen, rather than relying on permission prompts. Test in Task 5.
- **A Codex side chat that receives an approval or question request** must decline it without emitting `request-opened`, so no approval card can ever show. Test in Task 3.
- **Forking "before" the very first message** must produce a fresh conversation with a fork record and `inheritedTurnCount: 0`, not an error. `before` on a side chat must be rejected. Tests in Task 6.

---

### Task 1: Contract, parsers and preload

**Files:**
- Modify: `src/shared/conversation-contract.ts`
- Modify: `src/shared/conversation-ipc.ts` (channels at line 31, new parsers beside `parseConversationTitle`)
- Modify: `src/preload.ts:18-28`
- Test: `src/shared/conversation-ipc.test.ts`

**Interfaces:**
- Produces (contract):
  ```ts
  export type BranchKind = 'side-chat' | 'fork';
  /** A point in a conversation, named by a ConversationTurn.id: right after that turn's reply, or right before its user message. */
  export interface ForkPoint { turnId: string; position: 'after' | 'before' }
  // ConversationApi gains:
  fork(ref: ConversationRef, point: ForkPoint, kind: BranchKind): Promise<ConversationRef>;
  ```
- Produces (ipc): `CONVERSATION_CHANNELS.fork = 'fractal:conversations:fork'`, `parseForkPoint(value: unknown): ForkPoint`, `parseBranchKind(value: unknown): BranchKind`.

- [ ] **Step 1: Write failing tests** in `conversation-ipc.test.ts`:
  - `parseForkPoint` accepts `{ turnId: 'turn-1', position: 'after' }` and `{ turnId: 'turn-1', position: 'before' }`, and returns a copy without extra keys.
  - It rejects `{ turnId: '', position: 'after' }`, `{ turnId: 'x'.repeat(513), position: 'after' }`, `{ turnId: 'turn-1', position: 'middle' }`, `null` and an array.
  - `parseBranchKind` accepts `'side-chat'` and `'fork'`, and rejects `'branch'` and `1`.
- [ ] **Step 2: Run** `pnpm test src/shared/conversation-ipc.test.ts`. Expected: FAIL, because `parseForkPoint` is not exported.
- [ ] **Step 3: Implement** the contract types, the `fork` channel, both parsers (turn id length capped at `MAX_SESSION_ID_LENGTH`, using the file's existing `nonblankText` / `plainObject` helpers), and `fork: (ref, point, kind) => ipcRenderer.invoke(CHANNELS.fork, ref, point, kind)` in `preload.ts`.
- [ ] **Step 4: Run** `pnpm test src/shared/conversation-ipc.test.ts && pnpm exec tsc --noEmit`. Expected: PASS. The typecheck fails until preload implements `fork`, since `ConversationApi` requires it.
- [ ] **Step 5: Commit** `feat(conversation): add fork point and branch kind to the IPC contract`.

### Task 2: Branch store

**Files:**
- Create: `src/main/branch-store.ts`, `src/main/branch-notes.ts` (the two notes, verbatim from Global Constraints)
- Test: `src/main/branch-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface BranchRecord {
    kind: BranchKind;
    /** conversationKey() of the conversation this one branched from. */
    parentKey: string;
    /** The parent's ConversationTurn.id this branch carries history through; null when it carries none. */
    afterTurnId: string | null;
    /** How many of this conversation's leading turns came from the parent; where phase 4's divider goes, since Claude forks get fresh turn ids. */
    inheritedTurnCount: number;
    /** Told to the agent on every turn (Claude) or set once at fork time (Codex). */
    note?: string;
    createdAt: number;
  }
  export class BranchStore {
    constructor(rootDir: string);
    get(conversationKey: string): BranchRecord | undefined;
    set(conversationKey: string, record: BranchRecord): void;
    sideChatKeys(): Set<string>;
  }
  ```

- [ ] **Step 1: Write failing tests**, using a `mkdtemp` directory as the access-choice-store tests do:
  - A record round-trips through `set`/`get` across two `BranchStore` instances on the same directory, and the file is `branches.json`.
  - `sideChatKeys()` returns only `side-chat` keys.
  - A file with invalid JSON reads as empty, and the next `set` replaces it.
  - An entry with `kind: 'branch'`, a negative `inheritedTurnCount`, or a non-string `parentKey` is dropped on read while valid siblings survive.
- [ ] **Step 2: Run** `pnpm test src/main/branch-store.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `BranchStore`, mirroring `src/main/access-choice-store.ts`: `{ conversations: Record<string, BranchRecord> }`, a tmp-file-and-rename write, and per-entry coercion with `parseBranchKind`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(conversation): store side chat and fork lineage`.

### Task 3: Codex fork and read-only runs

**Files:**
- Modify: `src/main/harness/types.ts`. Shared with Task 5, which uses the same types, so add them here.
- Modify: `src/main/harness/codex/codex-app-server.ts:42-53` (request map)
- Modify: `src/main/harness/codex/codex-access.ts`
- Modify: `src/main/harness/codex/codex-adapter.ts`
- Test: `src/main/harness/codex/codex-adapter.test.ts`, `src/main/harness/codex/codex-access.test.ts`

**Interfaces:**
- Produces (harness types):
  ```ts
  export interface BranchRun { readOnly: boolean; note?: string }
  // AgentPrompt gains:
  /** Set by the service on every turn of a side chat or fork. */
  branch?: BranchRun;
  export interface ForkOptions { readOnly: boolean; note?: string; title: string }
  // HarnessAdapter gains:
  /** Copies history through `afterTurnId` (a ConversationTurn.id, inclusive) into a new session. Absent when the agent cannot fork. */
  forkConversation?(source: ConversationRef, afterTurnId: string, options: ForkOptions): Promise<ConversationRef>;
  ```
- Produces (codex-access): `codexReadOnlyOverrides(current: SandboxPolicy): CodexAccessOverrides`, which is `codexAccessOverrides('read-only', current)` with `approvalPolicy: 'never'`.

- [ ] **Step 1: Write failing tests:**
  - `codex-access.test.ts`: `codexReadOnlyOverrides` gives `{ approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess } }`, keeping the current policy's network access.
  - `codex-adapter.test.ts`, `forkConversation`, side chat: with `readOnly: true`, it sends `thread/fork` with `{ threadId, lastTurnId, cwd, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', developerInstructions: note }` and returns `{ provider: 'codex', nativeSessionId: <response thread id>, projectPath }`.
  - Full fork: with `readOnly: false` and no note, the `thread/fork` params carry the parent's `approvalPolicy`, `approvalsReviewer`, `model`, and `sandbox` mapped from the parent's `thread/resume` sandbox type (`readOnly→'read-only'`, `workspaceWrite→'workspace-write'`, `dangerFullAccess→'danger-full-access'`, `externalSandbox` omitted), and no `developerInstructions`.
  - It rejects a response whose `thread.cwd` canonicalizes to another project.
  - Read-only turns: `continueConversation` with `branch: { readOnly: true }` sends `turn/start` with the `codexReadOnlyOverrides` fields, even when `prompt.access` picks `full-access`.
  - During that run, an `item/commandExecution/requestApproval` request is answered `{ decision: 'decline' }` and an `item/tool/requestUserInput` request gets `respondError`, and neither produces a `request-opened` event.
  - `capabilities().fork` is `true`.
- [ ] **Step 2: Run** `pnpm test src/main/harness/codex`. Expected: FAIL.
- [ ] **Step 3: Implement:**
  - Add `'thread/fork': { params: ThreadForkParams; result: ThreadForkResponse }` to `CodexRequestMap`.
  - Add `codexReadOnlyOverrides`.
  - Add `CodexAdapter.forkConversation`, reading the parent through the existing `resumeThread` for a full fork.
  - In `continueConversation`, apply the read-only overrides when `prompt.branch?.readOnly`, and decline every server request in that run via `denyRequestSafely` before normalizing it.
  - Set `fork: true` in `CAPABILITIES`. `prompt.branch.note` is ignored here, because Codex keeps `developerInstructions` on the thread.
- [ ] **Step 4: Run** `pnpm test src/main/harness/codex && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(harness): fork Codex threads and run side chats read-only`.

### Task 4: Claude turn end lookup

**Files:**
- Modify: `src/main/harness/claude/claude-history.ts`
- Test: `src/main/harness/claude/claude-history.test.ts`

**Interfaces:**
- Produces: `readClaudeTurnEnd(filePath: string, turnId: string): Promise<string>`. It returns the `uuid` of the last transcript record that the normalizer assigns to `turnId`. That's the value `forkSession`'s `upToMessageId` takes to keep the whole turn. It throws `'Claude turn is not in this conversation'` when no record belongs to the turn.

- [ ] **Step 1: Write failing tests** with an inline JSONL temp file, following the file's existing fixtures:
  - The file has two prompt turns. Turn 1 is a prompt `u1`, an assistant `a1` with a tool_use, a tool-result carrier `r1`, and an assistant `a2`. Turn 2 is a prompt `u2` and an assistant `a3`.
  - `readClaudeTurnEnd(file, 'u1')` is `'a2'`, and `readClaudeTurnEnd(file, 'u2')` is `'a3'`.
  - A trailing `custom-title` record with no uuid doesn't change the result.
  - `readClaudeTurnEnd(file, 'nope')` rejects.
- [ ] **Step 2: Run** `pnpm test src/main/harness/claude/claude-history.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by reading the file's records in order, assigning each record's turn exactly as `normalizeClaudeRecord` does (`claude-normalizer.ts:107`: `context.recordTurn(record, uuid)`, then `parentUuid`, then the uuid, with one `createClaudeNormalizationContext()` across the file), so the two can't disagree, and keeping the last uuid whose turn matches.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(harness): find where a Claude turn ends in its transcript`.

### Task 5: Claude fork and read-only runs

**Files:**
- Modify: `src/main/harness/claude/claude-probe.ts`, `src/main/harness/claude/claude-runner.ts`, `src/main/harness/claude/claude-adapter.ts`
- Test: `claude-probe.test.ts`, `claude-runner.test.ts`, `claude-adapter.test.ts` (same directory)

**Interfaces:**
- Consumes: `BranchRun`, `ForkOptions` and `forkConversation` from Task 3, and `readClaudeTurnEnd` from Task 4.
- Produces:
  - `ClaudeCapabilityEvidence.tools: boolean`, which is `hasFlag(helpText, '--tools')`. Capability `fork` is `evidence.resume && evidence.tools && evidence.streamJson`.
  - `RunClaudeTurnOptions` gains `tools?: string[]`, `disallowedTools?: string[]`, `permissionPrompts?: 'none'` and `appendSystemPrompt?: string`, passed to the SDK as `tools`, `disallowedTools`, `permissionPrompts` and `systemPrompt: { type: 'preset', preset: 'claude_code', append }`.
  - `ClaudeAdapterDependencies.forkSession?: typeof import('@anthropic-ai/claude-agent-sdk').forkSession`.
  - `export const CLAUDE_READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'] as const` in `claude-adapter.ts`. Bash is left out on purpose: no rule can tell a read-only command from a writing one, and the user's own allow rules could approve a writing one.

- [ ] **Step 1: Write failing tests:**
  - Probe: help text containing `--tools` with the existing flags gives `fork: true`, and without `--tools` gives `fork: false`.
  - Runner: with `tools`, `disallowedTools: ['mcp__*']`, `permissionPrompts: 'none'` and `appendSystemPrompt: 'note'`, the fake `query` receives exactly those options and `systemPrompt: { type: 'preset', preset: 'claude_code', append: 'note' }`. Without them, `systemPrompt` is `{ type: 'preset', preset: 'claude_code' }` as today.
  - Adapter, fork: `forkConversation(ref, 'u1', { readOnly: true, note, title: 'T (side chat)' })` calls the injected `forkSession(ref.nativeSessionId, { dir: projectPath, upToMessageId: <readClaudeTurnEnd result>, title: 'T (side chat)' })` and returns `{ provider: 'claude', nativeSessionId: <returned sessionId>, projectPath }`. It throws when `capabilities().fork` is false.
  - Adapter, read-only continue: `continueConversation` with `branch: { readOnly: true, note: 'n' }` and `access` picking `bypassPermissions` passes `tools: [...CLAUDE_READ_ONLY_TOOLS]`, `disallowedTools: ['mcp__*']`, `permissionPrompts: 'none'` and `appendSystemPrompt: 'n'` to `runTurn`, with no `canUseTool` and no `permissionMode`.
  - Adapter, fork continue: with `branch: { readOnly: false, note: 'n' }`, it passes only `appendSystemPrompt: 'n'` and keeps the normal access and permissions.
- [ ] **Step 2: Run** `pnpm test src/main/harness/claude`. Expected: FAIL.
- [ ] **Step 3: Implement** the probe evidence and capability, the runner options, `ClaudeAdapter.forkConversation` (resolving the file with the existing `find`), and the `branch` handling in `continueConversation`. Default `forkSession` to the SDK export.
- [ ] **Step 4: Run** `pnpm test src/main/harness/claude && pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(harness): fork Claude sessions and run side chats with read-only tools`.

### Task 6: Service, registry, IPC and wiring

**Files:**
- Modify: `src/main/conversation-registry.ts`, `src/main/conversation-service.ts`, `src/main/agent-ipc.ts`, `src/main.ts:234-242`
- Test: `conversation-registry.test.ts`, `conversation-service.test.ts`, `agent-ipc.test.ts` (all in `src/main/`)

**Interfaces:**
- Consumes: `BranchStore` and `BranchRecord` (Task 2), the notes (Task 2), `forkConversation` and `AgentPrompt.branch` (Task 3), and the contract (Task 1).
- Produces:
  - `ConversationRegistry.fork(source: ConversationRef, afterTurnId: string, options: ForkOptions): Promise<ConversationRef>`. It mirrors `create`: provider available and `capabilities.fork`, the returned ref has the same provider and project, then `refreshProvider`.
  - `ConversationService` constructor options gain `branches?: BranchStore`.
  - `ConversationService.fork(source: ConversationRef, point: ForkPoint, kind: BranchKind): Promise<ConversationRef>`.
  - `ConversationService.branchKind(ref: ConversationRef): BranchKind | undefined`.
  - `main.ts` constructs `new BranchStore(app.getPath('userData'))` and passes it to the service.

`fork` works like this. Get the open load for `source` (otherwise `'Conversation is not open'`) and read its turns in history order. If `point.turnId` isn't among them, throw `'Fork point is not in this conversation'`. For `kind === 'side-chat'` with `position === 'before'`, throw `'Side chats branch after a reply'`. Then `afterIndex = after ? index : index - 1`. If that turn's `status === 'active'`, throw `'Cannot fork from a turn in progress'`. If the source summary has `parentId`, throw `'Subagent conversations are read-only'`. The note is `SIDE_CHAT_NOTE` for side chats, and `FORK_NOTE` for a fork whose `afterIndex` isn't the last turn. The title is `` `${title} (side chat)` `` or `` `${title} (fork)` ``. If `afterIndex < 0`, use `this.create(provider, projectPath)`. Otherwise call `registry.fork(source, turns[afterIndex].id, { readOnly: kind === 'side-chat', note, title })`. Finally `branches.set(conversationKey(ref), { kind, parentKey: conversationKey(source), afterTurnId: turns[afterIndex]?.id ?? null, inheritedTurnCount: afterIndex + 1, note, createdAt: Date.now() })`.

- [ ] **Step 1: Write failing tests** with the fake registry and adapters the service tests already use:
  - **Side chat after turn 1 of 2:** `fork(ref, { turnId: 't1', position: 'after' }, 'side-chat')` calls `forkConversation(ref, 't1', { readOnly: true, note: SIDE_CHAT_NOTE, title: 'Chat (side chat)' })`, and stores `{ kind: 'side-chat', afterTurnId: 't1', inheritedTurnCount: 1 }`.
  - **Fork after the latest turn:** no note.
  - **Fork before t2:** forks after `t1` with `FORK_NOTE`.
  - **Fork before t1:** no adapter fork. `create` is called, and the stored record has `afterTurnId: null, inheritedTurnCount: 0`.
  - **Rejections:** side chat with `before` → `'Side chats branch after a reply'`; a running turn → `'Cannot fork from a turn in progress'`; unknown turn → `'Fork point is not in this conversation'`; source not open → `'Conversation is not open'`.
  - **Continuing a side chat** with `access` picking `full-access` reaches the adapter with `access` undefined and `branch: { readOnly: true, note: SIDE_CHAT_NOTE }`. Continuing a fork that has a note sends `branch: { readOnly: false, note }` and keeps `access`. A plain conversation sends no `branch`.
  - **`list()`** leaves out side-chat conversations and keeps forks.
  - **`agent-ipc.test.ts`:** the `fork` channel parses its three arguments, requires the source to be loaded by that renderer, and returns the service's ref. A `continue` on a side chat calls neither `accessChoices.validateSend` nor `recordSend`.
  - **`conversation-registry.test.ts`:** `fork` throws `'Conversation forking is not available'` when the capability is false, and when the adapter returns another project.
- [ ] **Step 2: Run** `pnpm test src/main`. Expected: FAIL.
- [ ] **Step 3: Implement** the registry `fork`, then the service `fork`, `branchKind`, `continue` (look up the record and rewrite the prompt before `continueConversation`) and `list` filtering. Then add the `fork` IPC handler (`invoke(CHANNELS.fork, 3, …)` with `requireLoad`), skip access validation and recording for side chats in the `continue` handler, and wire the store in `main.ts`.
- [ ] **Step 4: Run** `pnpm test && pnpm lint && pnpm exec tsc --noEmit`. Expected: all PASS, including `native-continuity.integration.test.ts`.
- [ ] **Step 5: Commit** `feat(conversation): fork conversations into side chats and forks`.

### Task 7: Drive it against the real CLIs

Phase 1 has no UI, so verify through the running app's DevTools console, which calls the real `window.fractal` surface.

- [ ] **Step 1:** Run `pnpm start`. Open an existing Claude conversation with at least two turns in a scratch git repo, and open DevTools.
- [ ] **Step 2:** Get a turn id by opening the conversation's stream (or the reducer state in React DevTools), then run `await window.fractal.conversations.fork(ref, { turnId, position: 'after' }, 'side-chat')`. Expected: it returns a new ref, and `~/.config/fractal/branches.json` (the userData path) has a `side-chat` entry.
- [ ] **Step 3:** Open the returned ref and continue it with "Create a file named side-chat-probe.txt containing hi". Expected: the reply says it can't. `ls side-chat-probe.txt` fails in the repo, and the sidebar doesn't list the side chat after a refresh.
- [ ] **Step 4:** Continue the side chat with "What is in package.json's name field?". Expected: a correct answer, which shows the read tools work.
- [ ] **Step 5:** Repeat steps 2–4 with a Codex conversation. Also check that a Codex side chat asked to run `touch side-chat-probe.txt` fails without showing an approval card.
- [ ] **Step 6:** Fork (kind `fork`, position `before` the second turn's id) on each provider. Expected:
  - The new conversation appears in the sidebar and opens with only the first turn's history.
  - Asking it "what files changed recently?" works.
  - Asking it to create a file succeeds, because forks have full access.
- [ ] **Step 7:** Write up what you observed: the outputs from steps 3, 5 and 6, and anything that didn't behave as expected. In particular, report whether Codex's `developerInstructions` override replaced instructions the user had configured. Leave any fix for that to a follow-up.
