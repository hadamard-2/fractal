# Access Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user see and choose, per conversation, how much Claude Code or Codex may do without asking, from a picker at the far left of the composer.

**Architecture:** A separate "access" slice built like the model picker: a shared level catalog, per-harness mappings to each agent's controls (Claude `--permission-mode`; Codex `turn/start` sandbox/approval/reviewer fields), a main-process `AccessChoices` service over an `access-choices.json` store, its own IPC channels, and a renderer hook plus picker. Claude re-sends the adopted mode every turn because it forgets the mode on resume; Codex sends only user picks because it stores settings with the thread.

**Tech Stack:** Electron 43, React 19, TypeScript 5.9, Vitest 2 (jsdom per-file for `.tsx`), Radix dropdown/dialog via shadcn, Codex app-server JSON-RPC.

**Spec:** `docs/superpowers/specs/2026-10-07-access-picker-design.md`

## Global Constraints

- Claude levels, in order: `plan` Plan · `default` Ask · `acceptEdits` Accept edits · `auto` Auto · `bypassPermissions` Bypass (dangerous). The id is the value passed to `--permission-mode`.
- Codex levels, in order: `read-only` Read-only (`readOnly`, `on-request`, `user`) · `auto` Auto (`workspaceWrite`, `on-request`, `user`) · `auto-review` Auto-review (`workspaceWrite`, `on-request`, `auto_review`) · `full-access` Full access (`dangerFullAccess`, `never`, `user`, dangerous).
- Level descriptions (exact copy): Plan "Reads and proposes a plan; no edits until you approve it." · Ask "Reads freely; asks before edits and commands." · Accept edits "Edits files without asking; asks before other commands." · Auto (Claude) "Acts without asking; a safety check reviews each action." · Bypass "Acts without asking and without any safety check." · Read-only "Reads and runs read-only commands; asks to do more." · Auto (Codex) "Edits and runs commands in the workspace; asks to go outside it." · Auto-review "Like Auto, but a reviewer agent answers its requests instead of you." · Full access "Runs any command with no sandbox and never asks."
- A brand-new conversation sends no access setting. There is no last-used carry-over between conversations.
- Codex: never send a read-back state. Never change `networkAccess` yourself; carry it over from the thread's current sandbox.
- Claude custom `mode` values must match `/^[A-Za-z]{1,32}$/`.
- Tooltips via `components/ui/tooltip.tsx`, never `title`. No per-element scrollbar styling.
- Before calling any task done: `pnpm exec vitest run <touched tests>`; before the last task: `pnpm test`, `pnpm lint`, `pnpm exec tsc --noEmit`.

## Review Focus

- A pick made and sent before its `choose` IPC lands: the turn must run with the pick, and it must be saved as sent. Test in Task 8.
- A saved dangerous pick after its Settings toggle is turned off: the picker still shows it as current, and sending fails visibly with "Bypass is turned off in Settings" (or "Full access…"), keeping the draft. Tests in Tasks 5 and 7.
- A brand-new Claude conversation (no transcript yet): the read-back throws, so the picker shows "Claude's default", the turn carries no access, the failure is not cached, and the picker shows the real mode once the turn ends. Tests in Tasks 5 and 7.
- Switching conversation while an access lookup is in flight: the stale result must not appear on the new conversation. Test in Task 7.
- Shift+Tab while a turn is running must not change the level, and must keep its normal focus behaviour. Test in Task 8.

---

### Task 1: Shared access contract, level catalog and IPC parsing

**Files:**
- Modify: `src/shared/conversation-contract.ts` (types near `ModelChoice`; `PromptInput`)
- Create: `src/shared/access-levels.ts`
- Modify: `src/shared/conversation-ipc.ts` (channels, parsers, `parsePromptInput`)
- Modify: `src/main/harness/types.ts` (`AgentPrompt`, `HarnessAdapter`)
- Modify: `src/main/attachments/resolve.ts` (`resolveAttachments` passes `access` through)
- Test: `src/shared/access-levels.test.ts`, `src/shared/conversation-ipc.test.ts`, `src/main/attachments/resolve.test.ts`

**Interfaces:**
- Produces (in `conversation-contract.ts`):
  ```ts
  export type AccessState = { kind: 'level'; level: string } | { kind: 'custom'; label: string; mode?: string };
  export interface AccessLevel { id: string; label: string; description: string; dangerous: boolean }
  export interface TurnAccess { state: AccessState; picked: boolean }
  export interface AccessListing { levels: AccessLevel[]; access: TurnAccess | null; observed?: AccessState; allowDangerous: boolean }
  export interface AccessApi { list(ref: ConversationRef): Promise<AccessListing>; choose(ref: ConversationRef, level: string): Promise<void> }
  // PromptInput gains: access?: TurnAccess
  ```
- Produces (in `access-levels.ts`): `accessLevels(provider: ProviderId): AccessLevel[]`, `findAccessLevel(provider: ProviderId, id: string): AccessLevel | undefined`, `sameAccess(a: AccessState, b: AccessState): boolean`.
- Produces (in `conversation-ipc.ts`): `ACCESS_CHANNELS = { list: 'fractal:access:list', choose: 'fractal:access:choose' } as const`, `parseAccessState(value: unknown): AccessState`, `parseTurnAccess(value: unknown): TurnAccess`, `parseAccessLevelId(value: unknown): string`.
- Produces (in `harness/types.ts`): `AgentPrompt.access?: TurnAccess`; `HarnessAdapter.readAccess?(ref: ConversationRef): Promise<AccessState | undefined>`.

- [ ] **Step 1: Write the failing tests**

`access-levels.test.ts`:
```ts
test('lists each agent\'s levels in order of increasing autonomy', () => {
  expect(accessLevels('claude').map((l) => [l.id, l.label, l.dangerous])).toEqual([
    ['plan', 'Plan', false], ['default', 'Ask', false], ['acceptEdits', 'Accept edits', false], ['auto', 'Auto', false], ['bypassPermissions', 'Bypass', true],
  ]);
  expect(accessLevels('codex').map((l) => [l.id, l.label, l.dangerous])).toEqual([
    ['read-only', 'Read-only', false], ['auto', 'Auto', false], ['auto-review', 'Auto-review', false], ['full-access', 'Full access', true],
  ]);
});
test('returns copies, so a caller cannot change the catalog', () => { accessLevels('codex')[0].label = 'x'; expect(accessLevels('codex')[0].label).toBe('Read-only'); });
test('compares states by level id, or by custom label and mode', () => {
  expect(sameAccess({ kind: 'level', level: 'auto' }, { kind: 'level', level: 'auto' })).toBe(true);
  expect(sameAccess({ kind: 'level', level: 'auto' }, { kind: 'custom', label: 'auto' })).toBe(false);
  expect(sameAccess({ kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' })).toBe(true);
});
```
`conversation-ipc.test.ts` additions:
```ts
test('parses turn access and rejects malformed states', () => {
  expect(parseTurnAccess({ state: { kind: 'level', level: 'auto' }, picked: true })).toEqual({ state: { kind: 'level', level: 'auto' }, picked: true });
  expect(parseTurnAccess({ state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false })).toEqual({ state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false });
  for (const bad of [null, { state: { kind: 'level', level: '' }, picked: true }, { state: { kind: 'custom', label: 'x', mode: '--yolo' }, picked: false }, { state: { kind: 'level', level: 'auto' } }]) expect(() => parseTurnAccess(bad)).toThrow('Invalid access');
});
test('carries access through a prompt', () => {
  expect(parsePromptInput({ text: 'hi', access: { state: { kind: 'level', level: 'plan' }, picked: true } }).access).toEqual({ state: { kind: 'level', level: 'plan' }, picked: true });
  expect(parsePromptInput({ text: 'hi' })).not.toHaveProperty('access');
});
```
`resolve.test.ts`: a prompt with `access` and no attachments resolves to an `AgentPrompt` with the same `access`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/shared/access-levels.test.ts src/shared/conversation-ipc.test.ts src/main/attachments/resolve.test.ts`
Expected: FAIL — `accessLevels`, `parseTurnAccess` not exported; `access` missing.

- [ ] **Step 3: Implement the types, catalog and parsers**

Catalog values and description copy are in Global Constraints. Parsers throw `new Error('Invalid access')`; level ids are nonblank text ≤ 64 chars, custom labels nonblank ≤ 200, custom `mode` matches `/^[A-Za-z]{1,32}$/`, `picked` must be a boolean. `parsePromptInput` adds `access` only when present.

- [ ] **Step 4: Run them to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared src/main/harness/types.ts src/main/attachments
git commit -m "feat(access): add access levels, contract and IPC parsing"
```

---

### Task 2: Claude — send and read back the permission mode

**Files:**
- Create: `src/main/harness/claude/claude-access.ts`
- Modify: `src/main/harness/claude/claude-history.ts` (new reader beside `readClaudeLastRun`)
- Modify: `src/main/harness/claude/claude-runner.ts` (`RunClaudeTurnOptions`, args)
- Modify: `src/main/harness/claude/claude-adapter.ts` (`readAccess`, pass mode in `continueConversation`)
- Test: `claude-access.test.ts`, `claude-history.test.ts`, `claude-runner.test.ts`, `claude-adapter.test.ts` (same folder)

**Interfaces:**
- Consumes: `TurnAccess`, `AccessState`, `findAccessLevel` (Task 1).
- Produces: `claudePermissionMode(access: TurnAccess | undefined): string | undefined`; `claudeAccessState(mode: string): AccessState`; `readClaudeLastPermissionMode(filePath: string): Promise<string | undefined>`; `RunClaudeTurnOptions.permissionMode?: string`; `ClaudeAdapter.readAccess(ref)`.

- [ ] **Step 1: Write the failing tests**

```ts
// claude-access.test.ts
test('sends a level as its id and a custom state as its mode, picked or read back', () => {
  expect(claudePermissionMode({ state: { kind: 'level', level: 'acceptEdits' }, picked: true })).toBe('acceptEdits');
  expect(claudePermissionMode({ state: { kind: 'level', level: 'plan' }, picked: false })).toBe('plan');
  expect(claudePermissionMode({ state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false })).toBe('dontAsk');
  expect(claudePermissionMode({ state: { kind: 'custom', label: 'x' }, picked: false })).toBeUndefined();
  expect(claudePermissionMode(undefined)).toBeUndefined();
});
test('maps a recorded mode to a level, the manual alias to Ask, and anything else to custom', () => {
  expect(claudeAccessState('auto')).toEqual({ kind: 'level', level: 'auto' });
  expect(claudeAccessState('manual')).toEqual({ kind: 'level', level: 'default' });
  expect(claudeAccessState('dontAsk')).toEqual({ kind: 'custom', label: 'dontAsk', mode: 'dontAsk' });
});
```
`claude-history.test.ts`: a transcript whose `user` records carry `"permissionMode":"plan"` then `"permissionMode":"auto"` reads back `'auto'`; a transcript with none reads back `undefined`; a half-written final record with a mode still counts (same tail handling as `readClaudeLastRun`). Use trimmed real records as fixture lines.
`claude-runner.test.ts`: with `permissionMode: 'plan'` the spawned args contain `'--permission-mode', 'plan'`; without it they contain no `--permission-mode`.
`claude-adapter.test.ts`: `continueConversation` with `access: { state: { kind: 'level', level: 'auto' }, picked: false }` calls `runTurn` with `permissionMode: 'auto'`; `readAccess` on a transcript ending in `bypassPermissions` resolves `{ kind: 'level', level: 'bypassPermissions' }`, and on one without a mode resolves `undefined`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/main/harness/claude`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

`readClaudeLastPermissionMode` reuses the `NdjsonDecoder` streaming pattern of `readClaudeLastRun`, keeping the last non-empty string `permissionMode` on any record. The runner appends `['--permission-mode', mode]` with the model/effort arguments. The adapter's `readAccess` uses `this.find(ref)` like `readLastRun`; it throws for a draft with no transcript yet, and the service turns that into `null` (Task 5).

- [ ] **Step 4: Run them to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/harness/claude
git commit -m "feat(access): pass and read back Claude's permission mode"
```

---

### Task 3: Codex — send picked levels and read back thread settings

**Files:**
- Create: `src/main/harness/codex/codex-access.ts`
- Modify: `src/main/harness/codex/codex-adapter.ts` (`resumeThread`, `readLastRun`, `readAccess`, `continueConversation`)
- Test: `codex-access.test.ts`, `codex-adapter.test.ts`

**Interfaces:**
- Consumes: `TurnAccess`, `AccessState` (Task 1); generated `SandboxPolicy`, `AskForApproval`, `ApprovalsReviewer`, `ThreadResumeResponse` from `generated/v2`.
- Produces: `codexAccessOverrides(level: string, current: SandboxPolicy): { approvalPolicy: AskForApproval; approvalsReviewer: ApprovalsReviewer; sandboxPolicy: SandboxPolicy }` (throws `Unknown access level` for an unknown id); `codexAccessState(thread: Pick<ThreadResumeResponse, 'approvalPolicy' | 'approvalsReviewer' | 'sandbox'>): AccessState`; `CodexAdapter.readAccess(ref)`.

- [ ] **Step 1: Write the failing tests**

```ts
// codex-access.test.ts
const ws = { type: 'workspaceWrite', writableRoots: ['/extra'], networkAccess: true, excludeTmpdirEnvVar: true, excludeSlashTmp: false } as const;
test('changes only the sandbox type, carrying network access and workspace fields over', () => {
  expect(codexAccessOverrides('read-only', ws)).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: true } });
  expect(codexAccessOverrides('auto-review', ws)).toEqual({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxPolicy: ws });
  expect(codexAccessOverrides('full-access', ws)).toEqual({ approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } });
});
test('defaults the workspace fields when coming from full access, and reads an enabled external sandbox as network on', () => {
  expect(codexAccessOverrides('auto', { type: 'dangerFullAccess' }).sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  expect(codexAccessOverrides('read-only', { type: 'externalSandbox', networkAccess: 'enabled' }).sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: true });
});
test('reads a matching combination as its level and anything else as custom', () => {
  expect(codexAccessState({ approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: ws })).toEqual({ kind: 'level', level: 'auto' });
  expect(codexAccessState({ approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'readOnly', networkAccess: false } })).toEqual({ kind: 'custom', label: 'read-only · never ask' });
  expect(codexAccessState({ approvalPolicy: 'on-request', approvalsReviewer: 'guardian_subagent', sandbox: ws })).toEqual({ kind: 'custom', label: 'workspace-write · ask on request · guardian review' });
});
```
Custom label parts: sandbox `readOnly` "read-only", `workspaceWrite` "workspace-write", `dangerFullAccess` "full access", `externalSandbox` "external sandbox"; approval `on-request` "ask on request", `never` "never ask", `untrusted` "untrusted", granular "granular"; reviewer `user` omitted, `auto_review` "auto-review", `guardian_subagent` "guardian review"; joined with " · ".

`codex-adapter.test.ts` (extend `createFakeAppServer` so `thread/resume` returns `approvalPolicy`, `approvalsReviewer`, `sandbox`):
- `continueConversation` with a picked `auto-review` sends `turn/start` with `approvalPolicy`, `approvalsReviewer: 'auto_review'` and a `sandboxPolicy` built from the resume response's `sandbox`.
- With a read-back level (`picked: false`) or a custom state, `turn/start` has none of the three keys.
- `readAccess` maps the resume response; concurrent `readAccess` and `readLastRun` for one thread produce one `thread/resume` request; a later call after both settle makes a new request.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/main/harness/codex/codex-access.test.ts src/main/harness/codex/codex-adapter.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

`resumeThread(ref)` is private: it coalesces in-flight `thread/resume` calls per thread id in a `Map<string, Promise<…>>` and deletes the entry when the promise settles. `readLastRun`, `readAccess` and `continueConversation` all use it. `continueConversation` spreads `codexAccessOverrides(prompt.access.state.level, resumed.sandbox)` into `turn/start` only when `prompt.access?.picked && prompt.access.state.kind === 'level'`.

- [ ] **Step 4: Run them to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/harness/codex
git commit -m "feat(access): send picked Codex levels and read back thread settings"
```

---

### Task 4: Settings — dangerous-level toggles and a sender check

**Files:**
- Modify: `src/shared/settings-contract.ts` (`FractalSettings`)
- Modify: `src/main/settings-store.ts` (defaults, coerce)
- Modify: `src/main/settings-ipc.ts` (`sanitizePatch`, sender check, signature)
- Modify: `src/main.ts` (pass `() => mainWindowRef` to `registerSettingsIpc`)
- Modify: `src/components/settings-dialog.tsx`
- Test: `src/main/settings-store.test.ts`, `src/main/settings-ipc.test.ts`, `src/components/settings-dialog.test.tsx`

**Interfaces:**
- Produces: `FractalSettings.allowDangerousAccess: Partial<Record<ProviderId, boolean>>` (default `{}`); `registerSettingsIpc(agentEnvironment, getWindow: () => BrowserWindow | null): SettingsStore`.

- [ ] **Step 1: Write the failing tests**

- Store: a missing or malformed `allowDangerousAccess` loads as `{}`; `{ claude: true, codex: 'yes', other: true }` loads as `{ claude: true }`.
- IPC: a `set` patch with `allowDangerousAccess` is saved; a call whose `event.sender` is not the app window's `webContents`, or whose `senderFrame` is not its `mainFrame`, rejects with `Unauthorized settings sender`. Follow `model-ipc.test.ts`'s fake window/event.
- Dialog: a "Dangerous access levels" block with the description "Offer the levels that remove an agent's safety checks." and two switches labelled "Claude Code: Bypass" and "Codex: Full access"; toggling one calls `settings.set({ allowDangerousAccess: { claude: true } })` optimistically and reverts on failure, as `setShowAgentColorTags` does.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/main/settings-store.test.ts src/main/settings-ipc.test.ts src/components/settings-dialog.test.tsx`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

The sender check is the same predicate `model-ipc.ts`'s `authorize` uses. The dialog block sits in the Agents section after "Agent color tags", with the same row layout.

- [ ] **Step 4: Run them to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/settings-contract.ts src/main/settings-store* src/main/settings-ipc* src/main.ts src/components/settings-dialog*
git commit -m "feat(access): add dangerous-level settings and check the settings sender"
```

---

### Task 5: Access choice store and service

**Files:**
- Create: `src/main/access-choice-store.ts`, `src/main/access-choices.ts`
- Test: `src/main/access-choice-store.test.ts`, `src/main/access-choices.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `parseAccessState`, `accessLevels`, `findAccessLevel`, `sameAccess`; `HarnessAdapter.readAccess`.
- Produces:
  ```ts
  export interface StoredAccess { state: AccessState; sent: boolean }
  export class AccessChoiceStore { constructor(rootDir: string); get(key: string): StoredAccess | undefined; set(key: string, value: StoredAccess): void }
  export class AccessChoices {
    constructor(sources: Array<Pick<HarnessAdapter, 'provider' | 'readAccess'>>, store: Pick<AccessChoiceStore, 'get' | 'set'>, allowDangerous: (provider: ProviderId) => boolean);
    levels(provider: ProviderId): AccessLevel[];
    allowDangerous(provider: ProviderId): boolean;
    resolve(ref: ConversationRef): Promise<{ access: TurnAccess | null; observed?: AccessState }>;
    choose(ref: ConversationRef, level: string): void;           // saves { state, sent: false }
    validateSend(ref: ConversationRef, access: TurnAccess | undefined): void;
    recordSend(ref: ConversationRef, access: TurnAccess | undefined): void; // saves a pick as sent; always drops the cached read-back
  }
  ```
- Error copy: unknown level → `Unknown access level`; dangerous while not allowed → `` `${level.label} is turned off in Settings` ``.

- [ ] **Step 1: Write the failing tests**

Store (mirror `model-choice-store.test.ts`): keeps entries across instances in `access-choices.json`; a corrupt file reads as empty; malformed entries (bad state, non-boolean `sent`) are dropped.

Service:
```ts
test('resolves a saved pick, else the read-back adopted, else the agent default', async () => { /* saved → { access: { state, picked: true } }; none saved + readAccess → { picked: false }; readAccess undefined → null */ });
test('treats a read-back failure as the default and does not cache it', async () => { /* readAccess throws once → null; next resolve calls readAccess again */ });
test('reads back once until a turn is sent, then reads again', async () => { /* two resolves → one readAccess call; recordSend(ref, undefined) → next resolve calls it again */ });
test('reports observed only for a sent pick that differs from the read-back', async () => {
  // choose 'auto' (unsent) with read-back 'default' → no observed
  // recordSend picked 'auto' → observed { kind: 'level', level: 'default' }
  // read-back 'auto' → no observed
});
test('rejects unknown levels and dangerous levels that Settings has not allowed', () => {
  expect(() => choices.choose(claudeRef, 'nope')).toThrow('Unknown access level');
  expect(() => choices.choose(claudeRef, 'bypassPermissions')).toThrow('Bypass is turned off in Settings');
  expect(() => choices.validateSend(codexRef, { state: { kind: 'level', level: 'full-access' }, picked: true })).toThrow('Full access is turned off in Settings');
  expect(() => choices.validateSend(claudeRef, { state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false })).not.toThrow();
});
test('saves only picked states on send', () => { /* recordSend with picked:false saves nothing; picked:true saves { sent: true } */ });
```
`allowDangerous` throwing (corrupt settings) counts as not allowed.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/main/access-choice-store.test.ts src/main/access-choices.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

The store copies `ModelChoiceStore`'s atomic write and forgiving read, validating entries with `parseAccessState`. `validateSend` checks picked states (known level, dangerous only when allowed) and accepts any well-formed read-back state. The read-back cache is a `Map<conversationKey, AccessState | undefined>`; a thrown read is not cached.

- [ ] **Step 4: Run them to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/access-choice-store* src/main/access-choices*
git commit -m "feat(access): store, resolve and validate access choices"
```

---

### Task 6: Access IPC, send path and app wiring

**Files:**
- Create: `src/main/access-ipc.ts`
- Modify: `src/main/agent-ipc.ts` (options, continue handler)
- Modify: `src/main.ts` (construct, register, dispose)
- Modify: `src/preload.ts`, `src/global.d.ts`
- Test: `src/main/access-ipc.test.ts`, `src/main/agent-ipc.test.ts`, `src/preload.test.ts`

**Interfaces:**
- Consumes: `AccessChoices` (Task 5), `ACCESS_CHANNELS`, `parseConversationRef`, `parseAccessLevelId` (Task 1).
- Produces: `registerAccessIpc(choices: Pick<AccessChoices, 'levels' | 'resolve' | 'choose' | 'allowDangerous'>, getWindow: () => BrowserWindow | null): { dispose(): void }`; `registerConversationIpc(..., options: { attachmentsRoot; modelChoices?; accessChoices?: Pick<AccessChoices, 'validateSend' | 'recordSend'> })`; `window.fractal.access: AccessApi`.

- [ ] **Step 1: Write the failing tests**

- `access-ipc.test.ts` (mirror `model-ipc.test.ts`): `list` returns `{ levels, access, observed, allowDangerous }` for the ref's provider; `choose` calls `choices.choose(ref, 'plan')`; both reject a foreign sender with `Unauthorized access sender`; `choose` rejects a non-string level.
- `agent-ipc.test.ts`: a `continue` whose prompt carries access calls `validateSend` before `service.continue`, and `recordSend(ref, access)` after it; a `validateSend` throw rejects the invoke with that message and never calls `service.continue`; a `recordSend` throw does not fail the send.
- `preload.test.ts`: `fractal.access.list/choose` invoke `ACCESS_CHANNELS.list/choose` with the given args.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/main/access-ipc.test.ts src/main/agent-ipc.test.ts src/preload.test.ts`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

`validateSend` runs in the continue handler's synchronous parse phase, so a rejection reaches the renderer as that send's error. `main.ts` builds `new AccessChoices([codexAdapter, claudeAdapter], new AccessChoiceStore(app.getPath('userData')), (provider) => settingsStore.load().allowDangerousAccess[provider] === true)` beside `modelChoices`, registers it, and disposes the registration wherever `modelRegistration` is disposed.

- [ ] **Step 4: Run them to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/access-ipc* src/main/agent-ipc* src/main.ts src/preload* src/global.d.ts
git commit -m "feat(access): expose access choices over IPC and validate sends"
```

---

### Task 7: Access hook and picker

**Files:**
- Create: `src/components/conversation/access-choice.ts`, `src/renderer/use-access-choice.ts`, `src/components/conversation/access-picker.tsx`
- Test: `src/components/conversation/access-choice.test.ts`, `src/renderer/use-access-choice.test.tsx`, `src/components/conversation/access-picker.test.tsx`

**Interfaces:**
- Consumes: `AccessApi`, `AccessListing`, `TurnAccess`, `AccessLevel`, `AccessState`, `ConversationRuntime`.
- Produces:
  ```ts
  // access-choice.ts
  export function accessStateLabel(state: AccessState, levels: AccessLevel[]): string;               // level label, or `Custom: ${label}`
  export function accessTriggerLabel(provider: ProviderId, access: TurnAccess | null, levels: AccessLevel[]): string; // null → "Claude's default" / "Codex's default"
  export function visibleAccessLevels(levels: AccessLevel[], allowDangerous: boolean, access: TurnAccess | null): AccessLevel[]; // dangerous only when allowed or current
  export function nextAccessLevel(levels: AccessLevel[], access: TurnAccess | null): string | undefined; // skips dangerous, wraps; null/custom → first
  // use-access-choice.ts
  export function useAccessChoice(ref: ConversationRef, runtime: ConversationRuntime): { levels: AccessLevel[]; access: TurnAccess | null; observed?: AccessState; allowDangerous: boolean; loaded: boolean; refresh(): void; choose(level: string): void };
  // access-picker.tsx
  export function AccessPicker(props: { provider: ProviderId; levels: AccessLevel[]; access: TurnAccess | null; observed?: AccessState; allowDangerous: boolean; onChoose(level: string): void; onOpen(): void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

`access-choice.test.ts`:
```ts
test('labels the default, levels and custom states', () => {
  expect(accessTriggerLabel('claude', null, claudeLevels)).toBe("Claude's default");
  expect(accessTriggerLabel('codex', null, codexLevels)).toBe("Codex's default");
  expect(accessTriggerLabel('claude', { state: { kind: 'level', level: 'default' }, picked: false }, claudeLevels)).toBe('Ask');
  expect(accessTriggerLabel('codex', { state: { kind: 'custom', label: 'read-only · never ask' }, picked: false }, codexLevels)).toBe('Custom: read-only · never ask');
});
test('shows a dangerous level only when allowed or already current', () => {
  expect(visibleAccessLevels(claudeLevels, false, null).map((l) => l.id)).not.toContain('bypassPermissions');
  expect(visibleAccessLevels(claudeLevels, false, { state: { kind: 'level', level: 'bypassPermissions' }, picked: true }).map((l) => l.id)).toContain('bypassPermissions');
});
test('cycles forward through safe levels, wrapping, starting from the first', () => {
  expect(nextAccessLevel(claudeLevels, null)).toBe('plan');
  expect(nextAccessLevel(claudeLevels, { state: { kind: 'level', level: 'acceptEdits' }, picked: true })).toBe('auto');
  expect(nextAccessLevel(claudeLevels, { state: { kind: 'level', level: 'auto' }, picked: true })).toBe('plan');
  expect(nextAccessLevel(claudeLevels, { state: { kind: 'custom', label: 'dontAsk', mode: 'dontAsk' }, picked: false })).toBe('plan');
});
```
`use-access-choice.test.tsx` (jsdom): loads the listing; `choose('plan')` updates `access` to `{ state: { kind: 'level', level: 'plan' }, picked: true }` at once and calls `access.choose`; a pick made while the first list is in flight wins; switching `ref` while a list is in flight never shows the old ref's result; a runtime change from `active-in-fractal` to `idle` lists again; a missing or rejecting `window.fractal.access` yields `{ levels: [], access: null, loaded: true }`.
`access-picker.test.tsx` (jsdom): trigger aria-label "Access" showing the trigger label; items show label and description; picking a dangerous level opens a dialog titled "Allow Bypass?" with body "Claude Code will act without asking you and without any safety check, on every turn of this conversation until you change it." (Codex: "Codex will run any command with no sandbox and never ask, on every turn of this conversation until you change it."), and `onChoose` fires only after "Use Bypass"; "Cancel" does not call it; with `observed`, the menu shows "Last turn ran in Ask, not Auto"; a custom state appears as a checked item "Custom: dontAsk".

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/components/conversation/access-choice.test.ts src/renderer/use-access-choice.test.tsx src/components/conversation/access-picker.test.tsx`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement**

The hook mirrors `useModelChoice`, including the key guard and the "pick wins" rule. The picker reuses `model-picker.tsx`'s `TRIGGER` classes and `Option` look; consider moving those two into a small shared module instead of copying them. A dangerous current level gives the trigger `text-destructive` and a `TriangleAlert` icon. `observed` adds a `TriangleAlert` with a `Tooltip` carrying the same "Last turn ran in…" text. The dialog uses `components/ui/dialog.tsx`, with a destructive confirm button.

- [ ] **Step 4: Run them to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/conversation/access-* src/renderer/use-access-choice*
git commit -m "feat(access): add the access picker and its hook"
```

---

### Task 8: Composer integration

**Files:**
- Modify: `src/renderer/use-conversation.ts` (`send`)
- Modify: `src/components/conversation-panel.tsx` (footer, submit, Shift+Tab)
- Modify: `src/components/conversation/model-picker.tsx` (menus `align="end"`)
- Test: `src/components/conversation-panel.test.tsx`, `src/renderer/use-conversation.test.tsx`

**Interfaces:**
- Consumes: `useAccessChoice`, `AccessPicker`, `nextAccessLevel` (Task 7).
- Produces: `send(text, attachments?, choice?, access?: TurnAccess | null)`.

- [ ] **Step 1: Write the failing tests**

In `conversation-panel.test.tsx` add an `installAccess(listing)` helper beside `installModels`, then:
- Footer order: the footer's buttons read, in DOM order, Access, Attach files, Model, (Effort), Send.
- Sends the shown access: with a read-back `{ kind: 'level', level: 'auto' }`, `continue` receives `access: { state: { kind: 'level', level: 'auto' }, picked: false }`; with `null`, the prompt has no `access`.
- Pick then send at once: choose Plan from the picker with `access.choose` left pending, send, and `continue` receives `picked: true` Plan.
- Shift+Tab in the message box while idle moves Ask → Accept edits (calls `access.choose(ref, 'acceptEdits')`) and keeps focus in the box; while `active-in-fractal` it calls nothing.
- Submit stays blocked until the access listing has loaded.
- A rejected send ("Bypass is turned off in Settings") shows that message and keeps the draft.

`use-conversation.test.tsx`: `send('hi', [], null, access)` passes `access` in the prompt to `conversations.continue`.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run src/components/conversation-panel.test.tsx src/renderer/use-conversation.test.tsx`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

The footer becomes `[AccessPicker][AttachButton] … [ModelPicker][Stop][Submit]`, with `AccessPicker`'s `onOpen` wired to `accessChoice.refresh` so a Settings change shows on the next open. Bind Shift+Tab with `onKeyDownCapture` on `PromptInputTextarea`, **not** `onKeyDown`: the textarea spreads its props after its own `onKeyDown`, so passing one would replace Enter-to-send. Intercept only when `state.runtime === 'idle'`, not composing, and `nextAccessLevel` returns a level; then `preventDefault()` and `accessChoice.choose(level)`. `handleSubmit` also requires `accessChoice.loaded` and passes `accessChoice.access` to `send`.

- [ ] **Step 4: Run them to verify they pass**

Same command. Expected: PASS.

- [ ] **Step 5: Run the whole suite, lint and typecheck**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit`
Expected: all tests pass; lint and tsc report no errors.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/use-conversation* src/components/conversation-panel* src/components/conversation/model-picker.tsx
git commit -m "feat(access): put the access picker in the composer"
```

---

### Task 9: End-to-end check against the real agents

No code changes unless a check fails, in which case go back to the owning task.

- [ ] **Step 1: Claude.** Run `pnpm start`, open a Claude conversation in a scratch project, pick each non-dangerous level in turn and send "hi" each time. After each send, `grep -o '"permissionMode":"[a-zA-Z]*"' ~/.claude/projects/<project>/<session>.jsonl | tail -1` shows that level's id. This works without a subscription: the record is written before the API call fails. Then turn on "Claude Code: Bypass" in Settings, pick Bypass, confirm, send, and check the record shows `bypassPermissions`.
- [ ] **Step 2: Claude fallback.** In the same conversation pick Auto, choose Haiku in the model picker, and send. Haiku made Auto fall back to `default` when probed on 2.1.291; if the catalog doesn't list Haiku, make Auto unavailable another way, for example `"disableAutoMode": "disable"` in that project's `.claude/settings.local.json`. The picker should then show the mismatch warning "Last turn ran in Ask, not Auto".
- [ ] **Step 3: Codex.** Pick each Codex level and send. Afterwards a `thread/resume` (for example via the throwaway probe in the session folder, `files/codex-access-probe.cjs`, adapted to resume an existing thread id) reports that level's sandbox, approval policy and reviewer. Reopen the conversation in Fractal and confirm the picker shows the same level.
- [ ] **Step 4: Clean up** any scratch Claude project folders and Codex threads created for these checks.
