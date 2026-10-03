# Model and Effort Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick the model and reasoning effort for each conversation from the composer, for Claude and Codex, with the picker always showing what the next turn will run with.

**Architecture:** Each harness adapter gains two optional methods: `listModels()` (Codex: `model/list` on the shared app-server; Claude: a short-lived hook-free `claude` process answering the stream-json `initialize` control request) and `readLastRun(ref)` (Codex: `thread/resume`; Claude: the transcript's last assistant record). A main-process `ModelChoices` service fetches both catalogs once at startup, resolves a conversation's choice (saved → last run → agent default), seeds new conversations from the last choice sent with that agent, and persists choices in `<userData>/model-choices.json`. The renderer reads and saves through a new `window.fractal.models` preload namespace, shows two compact selects in the composer footer, and sends `model`/`effort` with each prompt; the Claude runner turns them into `--model`/`--effort` and Codex into `turn/start` fields.

**Tech Stack:** Electron 43 (main, preload with `contextBridge`), React 19, TypeScript 5.9, vitest 2 (node and jsdom environments), shadcn/ui Select (Radix), Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-09-30-model-effort-picker-design.md`

## Global Constraints

- Claude catalog process arguments, exactly: `--print --input-format stream-json --output-format stream-json --verbose --settings {"disableAllHooks":true}`. It times out after 10 000 ms and is always killed with `SIGTERM`.
- Claude catalog request: `{"type":"control_request","request_id":"fractal-models","request":{"subtype":"initialize"}}`; the answer is the `control_response` whose `response.request_id` is `fractal-models`, models at `response.response.models`.
- Claude assistant records with `message.model === '<synthetic>'` are not a model and never count as a last run.
- Codex `readLastRun` never calls `thread/unsubscribe`.
- `model` and `effort` are nonblank strings of at most 200 characters (`MAX_MODEL_FIELD_LENGTH = 200`); `effort` is never sent without `model`.
- Model channels: `fractal:models:list`, `fractal:models:choose`.
- Choices persist in `<userData>/model-choices.json`, not `settings.json`. An unreadable file reads as empty.
- A failed catalog fetch, last-run read, or choice write never fails creating, opening, or sending a conversation.
- `contextIsolation` stays on and `nodeIntegration` stays off.
- `pnpm lint`, `pnpm exec tsc --noEmit`, and `pnpm test` pass after every task.
- Commits use Conventional Commits (`feat(scope): subject`). Never `git push`. Outside a subagent-driven-development run, do not commit without the user asking.

## File Structure

Create:
- `src/main/harness/claude/claude-models.ts`: `listClaudeModels()`, `parseClaudeModels()`, `CLAUDE_MODELS_ARGS`.
- `src/main/model-choice-store.ts`: `ModelChoiceStore`, the JSON file of saved and last-used choices.
- `src/main/model-choices.ts`: `ModelChoices`, catalogs in memory plus choice resolution, seeding, and recording.
- `src/main/model-ipc.ts`: `registerModelIpc()` for the two model channels.
- `src/components/conversation/model-choice.ts`: pure picker helpers `pickerModels()` and `switchModel()`.
- `src/components/conversation/model-picker.tsx`: the two composer selects.
- `src/renderer/use-model-choice.ts`: loads, refreshes, and saves a conversation's choice.
- Tests beside each (`*.test.ts` / `*.test.tsx`), plus `src/shared/model-choice-ipc.test.ts`.

Modify:
- `src/shared/conversation-contract.ts`: `AgentModel`, `ModelChoice`, `ModelsApi`; `PromptInput.model/effort`.
- `src/shared/conversation-ipc.ts`: `MODEL_CHANNELS`, `parseModelChoice()`, `parsePromptInput()` carries the choice.
- `src/main/harness/types.ts`: `AgentPrompt.model/effort`; optional `listModels()`/`readLastRun()` on `HarnessAdapter`.
- `src/main/attachments/resolve.ts`: carry `model`/`effort` into the `AgentPrompt`.
- `src/main/harness/claude/claude-runner.ts`: `--model`/`--effort` arguments.
- `src/main/harness/claude/claude-history.ts`: `readClaudeLastRun()`.
- `src/main/harness/claude/claude-adapter.ts`: pass the choice to the runner; `listModels()`, `readLastRun()`.
- `src/main/harness/codex/codex-app-server.ts`: `model/list` in `CodexRequestMap`.
- `src/main/harness/codex/codex-adapter.ts`: `turn/start` fields; `listModels()`, `readLastRun()`.
- `src/main/agent-ipc.ts`: optional `modelChoices` hooks on create and continue.
- `src/main.ts`: build `ModelChoices`, fetch catalogs, register model IPC, dispose on quit.
- `src/preload.ts`, `src/global.d.ts`: `window.fractal.models`.
- `src/renderer/use-conversation.ts`: `send(text, attachments?, choice?)`.
- `src/components/conversation-panel.tsx`: render the picker, send the choice.

---

### Task 1: Model choice contract

**Files:**
- Modify: `src/shared/conversation-contract.ts:88-91` (and append new types after `PromptInput`)
- Modify: `src/shared/conversation-ipc.ts:25-31` (channels), `:152-158` (`parsePromptInput`)
- Test: `src/shared/model-choice-ipc.test.ts`

**Interfaces:**
- Produces: `AgentModel { id: string; label: string; description?: string; efforts: string[]; defaultEffort?: string }`, `ModelChoice { model: string; effort?: string }`, `ModelsApi { list(ref): Promise<{ models: AgentModel[]; choice: ModelChoice | null }>; choose(ref, choice: ModelChoice): Promise<void> }`, `PromptInput.model?: string`, `PromptInput.effort?: string` (all in `@/shared/conversation-contract`); `MODEL_CHANNELS`, `parseModelChoice(value: unknown): ModelChoice | null` (in `@/shared/conversation-ipc`).

- [ ] **Step 1: Write the failing test**

Create `src/shared/model-choice-ipc.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { MODEL_CHANNELS, parseModelChoice, parsePromptInput } from '@/shared/conversation-ipc';

describe('model choice contract', () => {
  test('accepts a model with or without an effort, and null for the agent default', () => {
    expect(parseModelChoice({ model: 'opus' })).toEqual({ model: 'opus' });
    expect(parseModelChoice({ model: 'gpt-5.5', effort: 'high' })).toEqual({ model: 'gpt-5.5', effort: 'high' });
    expect(parseModelChoice(null)).toBeNull();
  });

  test.each([
    undefined, 'opus', { model: '' }, { model: '   ' }, { model: 'x'.repeat(201) },
    { model: 'opus', effort: '' }, { model: 'opus', effort: 3 }, { effort: 'high' },
  ])('rejects %j', (value) => {
    expect(() => parseModelChoice(value)).toThrow('Invalid model choice');
  });

  test('carries model and effort on a prompt only when given', () => {
    expect(parsePromptInput({ text: 'Go' })).toEqual({ text: 'Go' });
    expect(parsePromptInput({ text: 'Go', model: 'opus' })).toEqual({ text: 'Go', model: 'opus' });
    expect(parsePromptInput({ text: 'Go', model: 'opus', effort: 'high' })).toEqual({ text: 'Go', model: 'opus', effort: 'high' });
    expect(() => parsePromptInput({ text: 'Go', effort: 'high' })).toThrow('Invalid model choice');
    expect(() => parsePromptInput({ text: 'Go', model: 'x'.repeat(201) })).toThrow('Invalid model choice');
  });

  test('names its own channels', () => {
    expect(MODEL_CHANNELS).toEqual({ list: 'fractal:models:list', choose: 'fractal:models:choose' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/shared/model-choice-ipc.test.ts`
Expected: FAIL, `MODEL_CHANNELS` / `parseModelChoice` are not exported.

- [ ] **Step 3: Add the contract types**

In `src/shared/conversation-contract.ts`, replace the `PromptInput` interface with:

```ts
export interface PromptInput {
  text: string;
  attachments?: PromptAttachment[];
  /** Absent means the agent's own default model. */
  model?: string;
  /** Only sent together with `model`. */
  effort?: string;
}

/** A model an agent offers, as its own picker lists it. `id` is what goes back to the agent. */
export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  /** Effort levels this model accepts; empty when it takes none. */
  efforts: string[];
  defaultEffort?: string;
}

/** The model and effort a conversation's next turn runs with. A missing effort means the agent's default for that model. */
export interface ModelChoice {
  model: string;
  effort?: string;
}

export interface ModelsApi {
  /** The agent's catalog (empty until its startup fetch finishes) and the conversation's resolved choice; null means the agent's default. */
  list(ref: ConversationRef): Promise<{ models: AgentModel[]; choice: ModelChoice | null }>;
  /** Saves the conversation's choice for its next turns. */
  choose(ref: ConversationRef, choice: ModelChoice): Promise<void>;
}
```

- [ ] **Step 4: Add the parser and channels**

In `src/shared/conversation-ipc.ts`, add `type ModelChoice` to the import from `@/shared/conversation-contract`. After `CONVERSATION_CHANNELS`, add:

```ts
export const MODEL_CHANNELS = { list: 'fractal:models:list', choose: 'fractal:models:choose' } as const;
```

Next to the other `MAX_*` constants, add:

```ts
const MAX_MODEL_FIELD_LENGTH = 200;
```

Replace `parsePromptInput` with:

```ts
export function parsePromptInput(value: unknown): PromptInput {
  if (!plainObject(value) || typeof value.text !== 'string') invalidPrompt();
  if (value.text.length > MAX_TEXT_LENGTH) throw new Error('Prompt is too large');
  const attachments = value.attachments === undefined ? [] : parsePromptAttachments(value.attachments);
  if (value.text.trim().length === 0 && attachments.length === 0) throw new Error('Prompt cannot be empty');
  const choice = value.model === undefined && value.effort === undefined
    ? null
    : parseModelChoice(value.effort === undefined ? { model: value.model } : { model: value.model, effort: value.effort });
  return { text: value.text, ...(attachments.length > 0 ? { attachments } : {}), ...(choice ?? {}) };
}

/** A model choice from the renderer; null is the agent's own default. */
export function parseModelChoice(value: unknown): ModelChoice | null {
  if (value === null) return null;
  if (!plainObject(value) || !nonblankText(value.model, MAX_MODEL_FIELD_LENGTH)) throw new Error('Invalid model choice');
  if (value.effort === undefined) return { model: value.model };
  if (!nonblankText(value.effort, MAX_MODEL_FIELD_LENGTH)) throw new Error('Invalid model choice');
  return { model: value.model, effort: value.effort };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/shared`
Expected: PASS, including the existing `conversation-contract.test.ts` prompt tests.

- [ ] **Step 6: Full checks and commit**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`
Expected: all pass.

```bash
git add src/shared/conversation-contract.ts src/shared/conversation-ipc.ts src/shared/model-choice-ipc.test.ts
git commit -m "feat(models): add the model choice contract and prompt fields"
```

---

### Task 2: Model choice store

**Files:**
- Create: `src/main/model-choice-store.ts`
- Test: `src/main/model-choice-store.test.ts`

**Interfaces:**
- Consumes: `ModelChoice`, `ProviderId` from `@/shared/conversation-contract`; `parseModelChoice` from `@/shared/conversation-ipc` (Task 1).
- Produces: `class ModelChoiceStore { constructor(rootDir: string); get(conversationKey: string): ModelChoice | undefined; set(conversationKey: string, choice: ModelChoice): void; lastUsed(provider: ProviderId): ModelChoice | undefined; setLastUsed(provider: ProviderId, choice: ModelChoice | null): void }`.

- [ ] **Step 1: Write the failing test**

Create `src/main/model-choice-store.test.ts`:

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ModelChoiceStore } from './model-choice-store';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(path.join(tmpdir(), 'fractal-model-choices-')); dirs.push(dir); return dir; }

test('keeps a choice per conversation and the last choice per agent across instances', () => {
  const dir = tempDir();
  const store = new ModelChoiceStore(dir);
  store.set('claude:a', { model: 'opus', effort: 'high' });
  store.set('codex:b', { model: 'gpt-5.5' });
  store.setLastUsed('claude', { model: 'opus', effort: 'high' });
  const reopened = new ModelChoiceStore(dir);
  expect(reopened.get('claude:a')).toEqual({ model: 'opus', effort: 'high' });
  expect(reopened.get('codex:b')).toEqual({ model: 'gpt-5.5' });
  expect(reopened.get('codex:missing')).toBeUndefined();
  expect(reopened.lastUsed('claude')).toEqual({ model: 'opus', effort: 'high' });
  expect(reopened.lastUsed('codex')).toBeUndefined();
  expect(JSON.parse(readFileSync(path.join(dir, 'model-choices.json'), 'utf8'))).toEqual({
    conversations: { 'claude:a': { model: 'opus', effort: 'high' }, 'codex:b': { model: 'gpt-5.5' } },
    lastUsed: { claude: { model: 'opus', effort: 'high' } },
  });
});

test('clears the last choice for an agent', () => {
  const store = new ModelChoiceStore(tempDir());
  store.setLastUsed('codex', { model: 'gpt-5.5' });
  store.setLastUsed('codex', null);
  expect(store.lastUsed('codex')).toBeUndefined();
});

test('reads a corrupt file as empty and drops malformed entries', () => {
  const dir = tempDir();
  const file = path.join(dir, 'model-choices.json');
  writeFileSync(file, '{ not json');
  expect(new ModelChoiceStore(dir).get('claude:a')).toBeUndefined();
  writeFileSync(file, JSON.stringify({
    conversations: { 'claude:a': { model: 'opus' }, 'claude:b': { model: '' }, 'claude:c': 'opus', 'claude:d': { model: 'opus', effort: 4 } },
    lastUsed: { claude: { model: 'sonnet' }, gemini: { model: 'x' }, codex: null },
  }));
  const store = new ModelChoiceStore(dir);
  expect(store.get('claude:a')).toEqual({ model: 'opus' });
  expect(store.get('claude:b')).toBeUndefined();
  expect(store.get('claude:c')).toBeUndefined();
  expect(store.get('claude:d')).toBeUndefined();
  expect(store.lastUsed('claude')).toEqual({ model: 'sonnet' });
  expect(store.lastUsed('codex')).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/model-choice-store.test.ts`
Expected: FAIL, cannot resolve `./model-choice-store`.

- [ ] **Step 3: Write the store**

Create `src/main/model-choice-store.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ModelChoice, ProviderId } from '@/shared/conversation-contract';
import { parseModelChoice } from '@/shared/conversation-ipc';

interface StoredChoices {
  conversations: Record<string, ModelChoice>;
  lastUsed: Partial<Record<ProviderId, ModelChoice>>;
}

const PROVIDERS: readonly ProviderId[] = ['codex', 'claude'];
const empty = (): StoredChoices => ({ conversations: {}, lastUsed: {} });

/**
 * Per-conversation model choices and the last choice sent with each agent.
 * Kept apart from settings.json so a renderer settings patch can never
 * overwrite them. This is Fractal's own convenience state, so an unreadable
 * file reads as empty and is replaced on the next write rather than blocking
 * a conversation.
 */
export class ModelChoiceStore {
  private readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, 'model-choices.json');
    mkdirSync(rootDir, { recursive: true });
  }

  get(conversationKey: string): ModelChoice | undefined { return this.load().conversations[conversationKey]; }

  set(conversationKey: string, choice: ModelChoice): void {
    const stored = this.load();
    stored.conversations[conversationKey] = choice;
    this.save(stored);
  }

  lastUsed(provider: ProviderId): ModelChoice | undefined { return this.load().lastUsed[provider]; }

  setLastUsed(provider: ProviderId, choice: ModelChoice | null): void {
    const stored = this.load();
    if (choice) stored.lastUsed[provider] = choice;
    else delete stored.lastUsed[provider];
    this.save(stored);
  }

  private load(): StoredChoices {
    if (!existsSync(this.filePath)) return empty();
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.filePath, 'utf8')); } catch { return empty(); }
    const record = objectValue(parsed);
    const stored = empty();
    for (const [key, value] of Object.entries(objectValue(record?.conversations) ?? {})) {
      const choice = coerceChoice(value);
      if (choice) stored.conversations[key] = choice;
    }
    const lastUsed = objectValue(record?.lastUsed);
    for (const provider of PROVIDERS) {
      const choice = coerceChoice(lastUsed?.[provider]);
      if (choice) stored.lastUsed[provider] = choice;
    }
    return stored;
  }

  private save(stored: StoredChoices): void {
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(stored, null, 2));
    renameSync(tmpPath, this.filePath);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function coerceChoice(value: unknown): ModelChoice | undefined {
  try { return parseModelChoice(value) ?? undefined; } catch { return undefined; }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/main/model-choice-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Full checks and commit**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`

```bash
git add src/main/model-choice-store.ts src/main/model-choice-store.test.ts
git commit -m "feat(models): persist per-conversation and last-used model choices"
```

---

### Task 3: Send the choice to both agents

**Files:**
- Modify: `src/main/harness/types.ts:26-29` (`AgentPrompt`), `:38-49` (`HarnessAdapter`)
- Modify: `src/main/attachments/resolve.ts:17-24`
- Modify: `src/main/harness/claude/claude-runner.ts:29-49`
- Modify: `src/main/harness/claude/claude-adapter.ts` (the `runTurn` call in `continueConversation`)
- Modify: `src/main/harness/codex/codex-adapter.ts` (the `turn/start` request in `continueConversation`)
- Test: `src/main/attachments/resolve.test.ts`, `src/main/harness/claude/claude-runner.test.ts`, `src/main/harness/claude/claude-adapter.test.ts`, `src/main/harness/codex/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `PromptInput.model/effort`, `AgentModel`, `ModelChoice` (Task 1).
- Produces: `AgentPrompt.model?: string`, `AgentPrompt.effort?: string`; `RunClaudeTurnOptions.model?: string`, `RunClaudeTurnOptions.effort?: string`; optional `HarnessAdapter.listModels?(): Promise<AgentModel[]>` and `HarnessAdapter.readLastRun?(ref: ConversationRef): Promise<ModelChoice | undefined>`, which Tasks 5 and 6 implement.

- [ ] **Step 1: Write the failing tests**

In `src/main/attachments/resolve.test.ts`, inside `describe('resolveAttachments', …)` (it already has `root` and `ref` in scope), add:

```ts
  test('carries the model choice through unchanged', async () => {
    await expect(resolveAttachments({ text: 'Hi', model: 'opus', effort: 'high' }, { root, ref })).resolves.toEqual({ text: 'Hi', model: 'opus', effort: 'high' });
  });
```

In `src/main/harness/claude/claude-runner.test.ts`, inside `describe('runClaudeTurn', …)`, add:

```ts
  test('passes the chosen model and effort as flags', async () => {
    const child = fakeProcess(); const spawnProcess = vi.fn(() => child);
    const run = runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', spawnProcess, model: 'opus', effort: 'high', rereadNative: async () => [] });
    child.finish(); await collect(run.events);
    const args = (spawnProcess.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args.slice(-4)).toEqual(['--model', 'opus', '--effort', 'high']);
  });
```

In `src/main/harness/claude/claude-adapter.test.ts`, inside `describe('Claude adapter', …)`, add:

```ts
  test('hands the prompt model choice to the runner', async () => {
    const runTurn = vi.fn((_options: RunClaudeTurnOptions): ClaudeTurnRun => ({ events: (async function* () { yield* [] as NativeEvent[]; })(), completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined) }));
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn });
    const run = await adapter.continueConversation(ref, { text: 'Go', model: 'opus', effort: 'high' });
    expect(runTurn.mock.calls[0][0]).toMatchObject({ model: 'opus', effort: 'high' });
    await run.dispose();
  });
```

In `src/main/harness/codex/codex-adapter.test.ts`, next to the existing `turn/start` tests, add:

```ts
  test('sends the chosen model and effort on turn/start', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    const run = await adapter.continueConversation(ref, { text: 'Go', model: 'gpt-5.5', effort: 'high' });
    expect(server.requests.at(-1)).toEqual({ method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Go', text_elements: [] }], model: 'gpt-5.5', effort: 'high' } });
    await run.dispose();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/main/attachments src/main/harness/claude src/main/harness/codex`
Expected: the four new tests FAIL (choice dropped / unexpected arguments). The typecheck will also flag `model` as unknown on `RunClaudeTurnOptions`; that is expected at this step.

- [ ] **Step 3: Extend the harness types**

In `src/main/harness/types.ts`, add `AgentModel` and `ModelChoice` to the type import from `@/shared/conversation-contract`. Replace `AgentPrompt` with:

```ts
export interface AgentPrompt {
  text: string;
  attachments?: ResolvedAttachment[];
  /** Absent means the agent's own default model. */
  model?: string;
  effort?: string;
}
```

Add to `HarnessAdapter`, after `renameConversation?`:

```ts
  /** The models this agent offers. Absent when it has no way to list them. */
  listModels?(): Promise<AgentModel[]>;
  /** The model and effort this conversation's own history says it last ran with. */
  readLastRun?(ref: ConversationRef): Promise<ModelChoice | undefined>;
```

- [ ] **Step 4: Carry the choice through attachment resolution**

In `src/main/attachments/resolve.ts`, replace `resolveAttachments` with:

```ts
export async function resolveAttachments(prompt: PromptInput, options: { root: string; ref: ConversationRef }): Promise<AgentPrompt> {
  const choice = { ...(prompt.model ? { model: prompt.model } : {}), ...(prompt.effort ? { effort: prompt.effort } : {}) };
  if (!prompt.attachments?.length) return { text: prompt.text, ...choice };
  const attachments: ResolvedAttachment[] = [];
  for (const attachment of prompt.attachments) {
    attachments.push(attachment.kind === 'bytes' ? await writePasted(attachment, options) : await inspectPath(attachment.path));
  }
  return { text: prompt.text, attachments, ...choice };
}
```

- [ ] **Step 5: Add the Claude flags**

In `src/main/harness/claude/claude-runner.ts`, add to `RunClaudeTurnOptions`:

```ts
  /** Passed as --model; absent leaves Claude on its configured default. */
  model?: string;
  /** Passed as --effort; only meaningful with a model that takes effort. */
  effort?: string;
```

and replace the `args` construction in `runClaudeTurn` with:

```ts
  const choiceArguments = [
    ...(options.model ? ['--model', options.model] : []),
    ...(options.effort ? ['--effort', options.effort] : []),
  ];
  const args = [
    ...sessionArguments, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', ...bridgeArguments, ...choiceArguments,
  ];
```

In `src/main/harness/claude/claude-adapter.ts`, in `continueConversation`, change the runner call's options object from `{ ref, prompt: turnPrompt, executable: …` to start with:

```ts
{ ref, prompt: turnPrompt, ...(prompt.model ? { model: prompt.model } : {}), ...(prompt.effort ? { effort: prompt.effort } : {}), executable: this.dependencies.executable ?? 'claude', …
```

(leave the rest of that object unchanged).

- [ ] **Step 6: Add the Codex fields**

In `src/main/harness/codex/codex-adapter.ts`, replace the `turn/start` request in `continueConversation` with:

```ts
      const started = await this.server.request('turn/start', {
        threadId: ref.nativeSessionId,
        input: codexTurnInput(prompt),
        // Codex applies both to this turn and the thread's later turns.
        ...(prompt.model ? { model: prompt.model } : {}),
        ...(prompt.effort ? { effort: prompt.effort } : {}),
      });
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm exec vitest run src/main/attachments src/main/harness`
Expected: PASS, including the existing exact-argument and exact-`turn/start` assertions (no choice means no extra fields).

- [ ] **Step 8: Full checks and commit**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`

```bash
git add src/main/harness/types.ts src/main/attachments src/main/harness/claude/claude-runner.ts src/main/harness/claude/claude-runner.test.ts src/main/harness/claude/claude-adapter.ts src/main/harness/claude/claude-adapter.test.ts src/main/harness/codex/codex-adapter.ts src/main/harness/codex/codex-adapter.test.ts
git commit -m "feat(models): send the chosen model and effort to Claude and Codex"
```

---

### Task 4: Claude model catalog

**Files:**
- Create: `src/main/harness/claude/claude-models.ts`
- Test: `src/main/harness/claude/claude-models.test.ts`

**Interfaces:**
- Consumes: `AgentModel` (Task 1); `NdjsonDecoder` from `@/main/harness/ndjson-decoder` (`push(chunk): Array<{ ok: true; value } | { ok: false; … }>`).
- Produces: `listClaudeModels(options?: { executable?: string; spawnProcess?: SpawnClaudeModelsProcess; timeoutMs?: number }): Promise<AgentModel[]>` (never rejects), `parseClaudeModels(value: unknown): AgentModel[]`, `CLAUDE_MODELS_ARGS: readonly string[]`, `type ClaudeModelsProcess`, `type SpawnClaudeModelsProcess`.

- [ ] **Step 1: Write the failing test**

Create `src/main/harness/claude/claude-models.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
import { CLAUDE_MODELS_ARGS, listClaudeModels, type ClaudeModelsProcess } from './claude-models';

type FakeProcess = ClaudeModelsProcess & EventEmitter & { stdout: PassThrough; stdin: PassThrough; signals: NodeJS.Signals[] };
function fakeProcess(): FakeProcess {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  return Object.assign(emitter, {
    stdout, stdin, signals,
    kill(signal: NodeJS.Signals) { signals.push(signal); stdout.end(); return true; },
  }) as unknown as FakeProcess;
}
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const initialized = (models: unknown, requestId = 'fractal-models') => line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { commands: [], models } } });

describe('listClaudeModels', () => {
  test('asks a hook-free Claude for its models and reads them from the initialize response', async () => {
    const child = fakeProcess();
    const spawnProcess = vi.fn(() => child);
    const listing = listClaudeModels({ executable: '/usr/bin/claude', spawnProcess });
    expect(CLAUDE_MODELS_ARGS).toEqual(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', '{"disableAllHooks":true}']);
    expect(spawnProcess).toHaveBeenCalledWith('/usr/bin/claude', CLAUDE_MODELS_ARGS);
    expect(JSON.parse(child.stdin.read().toString())).toEqual({ type: 'control_request', request_id: 'fractal-models', request: { subtype: 'initialize' } });
    child.stdout.write(line({ type: 'system', subtype: 'hook_started' }));
    child.stdout.write(initialized([{ value: 'ignored' }], 'someone-else'));
    child.stdout.write(initialized([
      { value: 'opus', displayName: 'Opus', description: 'Opus 5', supportsEffort: true, supportedEffortLevels: ['low', 'high', 7] },
      { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5' },
      { value: 'sonnet', supportsEffort: false, supportedEffortLevels: ['low'] },
      { displayName: 'No value' },
    ]));
    await expect(listing).resolves.toEqual([
      { id: 'opus', label: 'Opus', description: 'Opus 5', efforts: ['low', 'high'] },
      { id: 'haiku', label: 'Haiku', description: 'Haiku 4.5', efforts: [] },
      { id: 'sonnet', label: 'sonnet', efforts: [] },
    ]);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  test('returns no models when the response has none', async () => {
    const child = fakeProcess();
    const listing = listClaudeModels({ spawnProcess: () => child });
    child.stdout.write(initialized(undefined));
    await expect(listing).resolves.toEqual([]);
  });

  test('returns no models on timeout and still kills the process', async () => {
    const child = fakeProcess();
    await expect(listClaudeModels({ spawnProcess: () => child, timeoutMs: 5 })).resolves.toEqual([]);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  test('returns no models when the process exits early or fails to launch', async () => {
    const exited = fakeProcess();
    const early = listClaudeModels({ spawnProcess: () => exited });
    exited.stdout.end();
    await expect(early).resolves.toEqual([]);
    const missing = fakeProcess();
    const failed = listClaudeModels({ spawnProcess: () => missing });
    missing.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await expect(failed).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/harness/claude/claude-models.test.ts`
Expected: FAIL, cannot resolve `./claude-models`.

- [ ] **Step 3: Write the catalog reader**

Create `src/main/harness/claude/claude-models.ts`:

```ts
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { NdjsonDecoder } from '@/main/harness/ndjson-decoder';
import type { AgentModel } from '@/shared/conversation-contract';

export interface ClaudeModelsProcess {
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stdin: { write(chunk: string): unknown; on(event: 'error', listener: (error: Error) => void): unknown };
  once(event: 'error', listener: (error: Error) => void): this;
  kill(signal: NodeJS.Signals): boolean;
}
export type SpawnClaudeModelsProcess = (file: string, args: readonly string[]) => ClaudeModelsProcess;

const REQUEST_ID = 'fractal-models';
const TIMEOUT_MS = 10_000;

/**
 * Stream-json mode answers an `initialize` control request with the models
 * Claude Code's own picker offers. Hooks are disabled so listing models does
 * not run the user's SessionStart hooks. This control protocol is not a
 * documented CLI contract, so every failure reads as "no models".
 */
export const CLAUDE_MODELS_ARGS: readonly string[] = ['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--settings', '{"disableAllHooks":true}'];

export async function listClaudeModels(options: { executable?: string; spawnProcess?: SpawnClaudeModelsProcess; timeoutMs?: number } = {}): Promise<AgentModel[]> {
  let child: ClaudeModelsProcess;
  try { child = (options.spawnProcess ?? spawnModelsProcess)(options.executable ?? 'claude', CLAUDE_MODELS_ARGS); } catch { return []; }
  child.stdin.on('error', () => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<AgentModel[]>((resolve) => { timer = setTimeout(() => resolve([]), options.timeoutMs ?? TIMEOUT_MS); });
  const failed = new Promise<AgentModel[]>((resolve) => { child.once('error', () => resolve([])); });
  try {
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'initialize' } })}\n`);
    return await Promise.race([readModels(child.stdout), timedOut, failed]);
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
  }
}

export function parseClaudeModels(value: unknown): AgentModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): AgentModel[] => {
    const model = objectValue(entry);
    if (!model || typeof model.value !== 'string' || !model.value) return [];
    const efforts = model.supportsEffort === true && Array.isArray(model.supportedEffortLevels)
      ? model.supportedEffortLevels.filter((level): level is string => typeof level === 'string' && level.length > 0)
      : [];
    return [{
      id: model.value,
      label: typeof model.displayName === 'string' && model.displayName ? model.displayName : model.value,
      ...(typeof model.description === 'string' && model.description ? { description: model.description } : {}),
      efforts,
    }];
  });
}

async function readModels(stdout: AsyncIterable<Uint8Array | string>): Promise<AgentModel[]> {
  const decoder = new NdjsonDecoder<unknown>();
  try {
    for await (const chunk of stdout) {
      for (const line of decoder.push(chunk)) {
        if (!line.ok) continue;
        const record = objectValue(line.value);
        const response = objectValue(record?.response);
        if (record?.type !== 'control_response' || response?.request_id !== REQUEST_ID) continue;
        return parseClaudeModels(objectValue(response.response)?.models);
      }
    }
  } catch { /* A broken pipe is the same as no answer. */ }
  return [];
}

function spawnModelsProcess(file: string, args: readonly string[]): ClaudeModelsProcess {
  return spawn(file, [...args], { cwd: homedir(), shell: false, stdio: ['pipe', 'pipe', 'ignore'] }) as unknown as ClaudeModelsProcess;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/main/harness/claude/claude-models.test.ts`
Expected: PASS.

- [ ] **Step 5: Check against the real CLI once**

Run from a scratch script (do not commit it) that imports nothing from the app, to confirm the installed CLI still answers the same way:

```bash
(printf '%s\n' '{"type":"control_request","request_id":"fractal-models","request":{"subtype":"initialize"}}'; sleep 5) | timeout 15 claude --print --input-format stream-json --output-format stream-json --verbose --settings '{"disableAllHooks":true}' | grep -c '"request_id":"fractal-models"'
```

Expected: `1`. If it prints `0`, stop and report: the CLI's control protocol changed and the parser needs revisiting.

- [ ] **Step 6: Full checks and commit**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`

```bash
git add src/main/harness/claude/claude-models.ts src/main/harness/claude/claude-models.test.ts
git commit -m "feat(claude): list models from the stream-json initialize response"
```

---

### Task 5: Claude last run and adapter methods

**Files:**
- Modify: `src/main/harness/claude/claude-history.ts` (new export; reuse its private `objectValue`)
- Modify: `src/main/harness/claude/claude-adapter.ts` (dependencies, two methods)
- Test: `src/main/harness/claude/claude-history.test.ts`, `src/main/harness/claude/claude-adapter.test.ts`

**Interfaces:**
- Consumes: `listClaudeModels` (Task 4); `HarnessAdapter.listModels/readLastRun` (Task 3); `ModelChoice`, `AgentModel` (Task 1).
- Produces: `readClaudeLastRun(filePath: string): Promise<ModelChoice | undefined>`; `ClaudeAdapter.listModels(): Promise<AgentModel[]>`; `ClaudeAdapter.readLastRun(ref): Promise<ModelChoice | undefined>`; new optional dependency `ClaudeAdapterDependencies.listModels?: () => Promise<AgentModel[]>`.

- [ ] **Step 1: Write the failing tests**

In `src/main/harness/claude/claude-history.test.ts`, add `readClaudeLastRun` to the import from `@/main/harness/claude/claude-history`, and inside `describe('Claude native history', …)` add:

```ts
  test('reads the model and effort of the last real assistant record', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-last-run-'));
    const file = path.join(directory, 'session.jsonl');
    const records = [
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', effort: 'low', message: { role: 'assistant', model: 'claude-sonnet-5', content: [] } },
      { type: 'assistant', effort: 'high', message: { role: 'assistant', model: 'claude-opus-5-5', content: [] } },
      { type: 'assistant', message: { role: 'assistant', model: '<synthetic>', content: [] } },
      { type: 'user', message: { role: 'user', content: 'thanks' } },
    ];
    await writeFile(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    await expect(readClaudeLastRun(file)).resolves.toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    await writeFile(file, JSON.stringify({ type: 'assistant', message: { model: 'claude-haiku-4-5-20251001', content: [] } }));
    await expect(readClaudeLastRun(file)).resolves.toEqual({ model: 'claude-haiku-4-5-20251001' });
    await writeFile(file, `${JSON.stringify({ type: 'user', message: { content: 'only' } })}\n`);
    await expect(readClaudeLastRun(file)).resolves.toBeUndefined();
    await rm(directory, { recursive: true, force: true });
  });
```

(The second write has no trailing newline on purpose: a final unterminated record still counts.)

In `src/main/harness/claude/claude-adapter.test.ts`, inside `describe('Claude adapter', …)`, add:

```ts
  test('lists models through its catalog dependency and reads the last run from the transcript', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'fractal-claude-models-'));
    const source = await readFile(path.join(root, 'claude-session-1.jsonl'), 'utf8');
    const last = { type: 'assistant', sessionId: 'claude-session-1', cwd: '/work/fractal', uuid: 'assistant-last', parentUuid: null, timestamp: '2026-09-30T00:00:00.000Z', effort: 'high', message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Done' }] } };
    await writeFile(path.join(directory, 'claude-session-1.jsonl'), `${source.trimEnd()}\n${JSON.stringify(last)}\n`);
    const models = [{ id: 'opus', label: 'Opus', efforts: ['high'] }];
    const adapter = new ClaudeAdapter(directory, { realpath, listModels: async () => models });
    await expect(adapter.listModels()).resolves.toEqual(models);
    await expect(adapter.readLastRun(ref)).resolves.toEqual({ model: 'claude-opus-5', effort: 'high' });
    await rm(directory, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/main/harness/claude`
Expected: the two new tests FAIL (`readClaudeLastRun` not exported; `listModels`/`readLastRun` not functions).

- [ ] **Step 3: Read the last run from a transcript**

In `src/main/harness/claude/claude-history.ts`, add `import type { ModelChoice } from '@/shared/conversation-contract';` (merge into the existing type import from that module), and add this export after `appendClaudeCustomTitle`:

```ts
/**
 * The model and effort of the last assistant record Claude wrote. Claude Code
 * writes `<synthetic>` as the model on notices it generates itself, so those
 * never count as a run.
 */
export async function readClaudeLastRun(filePath: string): Promise<ModelChoice | undefined> {
  const decoder = new NdjsonDecoder<unknown>();
  let last: ModelChoice | undefined;
  const take = (value: unknown): void => {
    const record = objectValue(value);
    if (record?.type !== 'assistant') return;
    const model = objectValue(record.message)?.model;
    if (typeof model !== 'string' || !model || model === '<synthetic>') return;
    last = typeof record.effort === 'string' && record.effort ? { model, effort: record.effort } : { model };
  };
  for await (const chunk of createReadStream(filePath)) {
    for (const line of decoder.push(chunk as Buffer)) if (line.ok) take(line.value);
  }
  const tail = decoder.finish();
  if (tail.kind === 'incomplete') {
    try { take(JSON.parse(tail.raw)); } catch { /* A half-written final record is not a run yet. */ }
  }
  return last;
}
```

(`createReadStream`, `NdjsonDecoder`, and `objectValue` are already imported or defined in this file.)

- [ ] **Step 4: Add the adapter methods**

In `src/main/harness/claude/claude-adapter.ts`:
- Add `import { listClaudeModels } from './claude-models';` and add `readClaudeLastRun` to the import from `./claude-history`.
- Add `AgentModel` and `ModelChoice` to the type import from `@/shared/conversation-contract`.
- Add to `ClaudeAdapterDependencies`: `listModels?: () => Promise<AgentModel[]>;`
- Add these methods after `renameConversation`:

```ts
  listModels(): Promise<AgentModel[]> {
    return this.dependencies.listModels?.() ?? listClaudeModels({ executable: this.dependencies.executable ?? 'claude' });
  }

  async readLastRun(ref: ConversationRef): Promise<ModelChoice | undefined> {
    return readClaudeLastRun((await this.find(ref)).filePath);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/main/harness/claude`
Expected: PASS.

- [ ] **Step 6: Full checks and commit**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`

```bash
git add src/main/harness/claude
git commit -m "feat(claude): read the last run's model and expose the model catalog"
```

---

### Task 6: Codex model catalog and last run

**Files:**
- Modify: `src/main/harness/codex/codex-app-server.ts:22-31` (`CodexRequestMap` and imports)
- Modify: `src/main/harness/codex/codex-adapter.ts` (two methods)
- Test: `src/main/harness/codex/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `HarnessAdapter.listModels/readLastRun` (Task 3); generated `ModelListParams`, `ModelListResponse`.
- Produces: `CodexAdapter.listModels(): Promise<AgentModel[]>` (hidden models dropped; `id` is the model slug `Model.model`); `CodexAdapter.readLastRun(ref): Promise<ModelChoice | undefined>`.

- [ ] **Step 1: Write the failing tests**

In `src/main/harness/codex/codex-adapter.test.ts`, add this helper above `createFakeAppServer`:

```ts
function codexModel(model: string, efforts: string[]) {
  return {
    id: model, model, displayName: model.toUpperCase(), description: `${model} description`, hidden: false, isDefault: false,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })), defaultReasoningEffort: 'medium',
  };
}
```

In `createFakeAppServer`'s `request` mock, replace the `thread/resume` line and add a `model/list` case:

```ts
      if (method === 'thread/resume') return { thread: threadRead.thread, model: 'gpt-5.6-terra', reasoningEffort: 'high' };
      if (method === 'model/list') return params.cursor === 'models-2'
        ? { data: [codexModel('gpt-5.5', ['low', 'medium', 'high', 'xhigh'])], nextCursor: null }
        : { data: [codexModel('gpt-5.6-terra', ['low', 'medium', 'ultra']), { ...codexModel('codex-auto-review', ['low']), hidden: true }], nextCursor: 'models-2' };
```

Then add these tests:

```ts
  test('lists visible models across pages with their efforts', async () => {
    const server = createFakeAppServer();
    await expect(new CodexAdapter(server as never).listModels()).resolves.toEqual([
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-TERRA', description: 'gpt-5.6-terra description', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'medium' },
      { id: 'gpt-5.5', label: 'GPT-5.5', description: 'gpt-5.5 description', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    ]);
    expect(server.requests.filter((request) => request.method === 'model/list').map((request) => request.params)).toEqual([{}, { cursor: 'models-2' }]);
  });

  test('reads the last run from thread/resume without unsubscribing', async () => {
    const server = createFakeAppServer();
    const adapter = new CodexAdapter(server as never, { realpath: async (value) => value });
    await expect(adapter.readLastRun(ref)).resolves.toEqual({ model: 'gpt-5.6-terra', effort: 'high' });
    expect(server.requests).toEqual([{ method: 'thread/resume', params: { threadId: 'thread-1', cwd: '/work/fractal' } }]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/main/harness/codex/codex-adapter.test.ts`
Expected: the two new tests FAIL (`listModels`/`readLastRun` are not functions). Existing tests still pass with the richer `thread/resume` response.

- [ ] **Step 3: Type the `model/list` request**

In `src/main/harness/codex/codex-app-server.ts`, add:

```ts
import type { ModelListParams } from '@/main/harness/codex/generated/v2/ModelListParams';
import type { ModelListResponse } from '@/main/harness/codex/generated/v2/ModelListResponse';
```

and add to `CodexRequestMap`:

```ts
  'model/list': { params: ModelListParams; result: ModelListResponse };
```

- [ ] **Step 4: Add the adapter methods**

In `src/main/harness/codex/codex-adapter.ts`, add `AgentModel` and `ModelChoice` to the type import from `@/shared/conversation-contract`, and add after `renameConversation`:

```ts
  async listModels(): Promise<AgentModel[]> {
    const models: AgentModel[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await this.server.request('model/list', cursor ? { cursor } : {});
      for (const model of response.data) {
        if (model.hidden) continue;
        models.push({
          id: model.model, label: model.displayName || model.model,
          ...(model.description ? { description: model.description } : {}),
          efforts: model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
          defaultEffort: model.defaultReasoningEffort,
        });
      }
      cursor = response.nextCursor;
      if (cursor && cursors.has(cursor)) break;
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return models;
  }

  async readLastRun(ref: ConversationRef): Promise<ModelChoice | undefined> {
    if (ref.provider !== 'codex') throw new Error('Conversation provider must be codex');
    // Codex reports a thread's model only on resume. The thread stays
    // subscribed, as it does after continueConversation: this connection is
    // shared, and unsubscribing would also silence a run streaming on it.
    const resumed = await this.server.request('thread/resume', { threadId: ref.nativeSessionId, cwd: await this.canonicalPath(ref.projectPath) });
    if (!resumed.model) return undefined;
    return resumed.reasoningEffort ? { model: resumed.model, effort: resumed.reasoningEffort } : { model: resumed.model };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm exec vitest run src/main/harness/codex`
Expected: PASS.

- [ ] **Step 6: Full checks and commit**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`

```bash
git add src/main/harness/codex/codex-app-server.ts src/main/harness/codex/codex-adapter.ts src/main/harness/codex/codex-adapter.test.ts
git commit -m "feat(codex): list models and read a thread's last run"
```

---

### Task 7: Model choices service

**Files:**
- Create: `src/main/model-choices.ts`
- Test: `src/main/model-choices.test.ts`

**Interfaces:**
- Consumes: `HarnessAdapter.provider/listModels/readLastRun` (Task 3); `ModelChoiceStore` method shapes (Task 2); `conversationKey` from `@/shared/conversation-contract`.
- Produces: `class ModelChoices { constructor(sources: ModelSource[], store: ChoiceStore); fetchCatalogs(): Promise<void>; catalog(provider: ProviderId): AgentModel[]; resolve(ref: ConversationRef): Promise<ModelChoice | null>; seed(ref: ConversationRef): void; choose(ref: ConversationRef, choice: ModelChoice): void; recordSend(ref: ConversationRef, choice: ModelChoice | null): void }`, where `ModelSource = Pick<HarnessAdapter, 'provider' | 'listModels' | 'readLastRun'>` and `ChoiceStore = Pick<ModelChoiceStore, 'get' | 'set' | 'lastUsed' | 'setLastUsed'>`.

- [ ] **Step 1: Write the failing test**

Create `src/main/model-choices.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import { ModelChoices } from './model-choices';
import type { AgentModel, ConversationRef, ModelChoice, ProviderId } from '@/shared/conversation-contract';

const claudeRef: ConversationRef = { provider: 'claude', nativeSessionId: 'a', projectPath: '/work' };
const codexRef: ConversationRef = { provider: 'codex', nativeSessionId: 'b', projectPath: '/work' };
const opus: AgentModel = { id: 'opus', label: 'Opus', efforts: ['high'] };

function memoryStore() {
  const conversations = new Map<string, ModelChoice>();
  const last = new Map<ProviderId, ModelChoice>();
  return {
    conversations, last,
    get: (key: string) => conversations.get(key),
    set: (key: string, choice: ModelChoice) => { conversations.set(key, choice); },
    lastUsed: (provider: ProviderId) => last.get(provider),
    setLastUsed: (provider: ProviderId, choice: ModelChoice | null) => { if (choice) last.set(provider, choice); else last.delete(provider); },
  };
}

describe('ModelChoices', () => {
  test('fetches each catalog once and treats a failure or missing lister as empty', async () => {
    const listModels = vi.fn(async () => [opus]);
    const choices = new ModelChoices([
      { provider: 'claude', listModels },
      { provider: 'codex', listModels: async () => { throw new Error('offline'); } },
    ], memoryStore());
    expect(choices.catalog('claude')).toEqual([]);
    await choices.fetchCatalogs();
    expect(choices.catalog('claude')).toEqual([opus]);
    expect(choices.catalog('codex')).toEqual([]);
    choices.catalog('claude').pop();
    expect(choices.catalog('claude')).toEqual([opus]);
    expect(listModels).toHaveBeenCalledOnce();
    const bare = new ModelChoices([{ provider: 'claude' }], memoryStore());
    await bare.fetchCatalogs();
    expect(bare.catalog('claude')).toEqual([]);
  });

  test('resolves a saved choice before the last run, and falls back to the agent default', async () => {
    const store = memoryStore();
    const readLastRun = vi.fn(async (): Promise<ModelChoice | undefined> => ({ model: 'claude-opus-5-5', effort: 'high' }));
    const choices = new ModelChoices([{ provider: 'claude', readLastRun }, { provider: 'codex', readLastRun: async () => { throw new Error('gone'); } }], store);
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ model: 'claude-opus-5-5', effort: 'high' });
    choices.choose(claudeRef, { model: 'opus' });
    await expect(choices.resolve(claudeRef)).resolves.toEqual({ model: 'opus' });
    expect(readLastRun).toHaveBeenCalledOnce();
    await expect(choices.resolve(codexRef)).resolves.toBeNull();
    readLastRun.mockResolvedValueOnce(undefined);
    await expect(new ModelChoices([{ provider: 'claude', readLastRun }], memoryStore()).resolve(claudeRef)).resolves.toBeNull();
  });

  test('seeds a new conversation from the last choice sent with its agent', () => {
    const store = memoryStore();
    const choices = new ModelChoices([], store);
    choices.seed(claudeRef);
    expect(store.conversations.size).toBe(0);
    store.last.set('claude', { model: 'opus', effort: 'high' });
    choices.seed(claudeRef);
    expect(store.conversations.get('claude:a')).toEqual({ model: 'opus', effort: 'high' });
  });

  test('records a send as the conversation choice and the agent last choice; a default send clears only the latter', () => {
    const store = memoryStore();
    const choices = new ModelChoices([], store);
    choices.recordSend(codexRef, { model: 'gpt-5.5', effort: 'high' });
    expect(store.conversations.get('codex:b')).toEqual({ model: 'gpt-5.5', effort: 'high' });
    expect(store.last.get('codex')).toEqual({ model: 'gpt-5.5', effort: 'high' });
    choices.recordSend(codexRef, null);
    expect(store.last.has('codex')).toBe(false);
    expect(store.conversations.get('codex:b')).toEqual({ model: 'gpt-5.5', effort: 'high' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/model-choices.test.ts`
Expected: FAIL, cannot resolve `./model-choices`.

- [ ] **Step 3: Write the service**

Create `src/main/model-choices.ts`:

```ts
import type { HarnessAdapter } from '@/main/harness/types';
import type { ModelChoiceStore } from '@/main/model-choice-store';
import { conversationKey, type AgentModel, type ConversationRef, type ModelChoice, type ProviderId } from '@/shared/conversation-contract';

type ModelSource = Pick<HarnessAdapter, 'provider' | 'listModels' | 'readLastRun'>;
type ChoiceStore = Pick<ModelChoiceStore, 'get' | 'set' | 'lastUsed' | 'setLastUsed'>;

/**
 * Which model and effort each conversation runs with. Catalogs are fetched
 * once per launch; a conversation's choice is what Fractal saved for it,
 * else what its own history last ran with, else the agent's default (null).
 */
export class ModelChoices {
  private readonly sources = new Map<ProviderId, ModelSource>();
  private readonly catalogs = new Map<ProviderId, AgentModel[]>();

  constructor(sources: ModelSource[], private readonly store: ChoiceStore) {
    for (const source of sources) this.sources.set(source.provider, source);
  }

  /** A failed or missing lister leaves that agent's list empty; the picker then offers only the current choice. */
  async fetchCatalogs(): Promise<void> {
    await Promise.all([...this.sources.values()].map(async (source) => {
      try { this.catalogs.set(source.provider, await source.listModels?.() ?? []); }
      catch { this.catalogs.set(source.provider, []); }
    }));
  }

  catalog(provider: ProviderId): AgentModel[] { return structuredClone(this.catalogs.get(provider) ?? []); }

  async resolve(ref: ConversationRef): Promise<ModelChoice | null> {
    const saved = this.store.get(conversationKey(ref));
    if (saved) return saved;
    try { return await this.sources.get(ref.provider)?.readLastRun?.(ref) ?? null; }
    catch { return null; }
  }

  /** A new conversation starts from the last choice sent with its agent. */
  seed(ref: ConversationRef): void {
    const last = this.store.lastUsed(ref.provider);
    if (last) this.store.set(conversationKey(ref), last);
  }

  choose(ref: ConversationRef, choice: ModelChoice): void { this.store.set(conversationKey(ref), choice); }

  /** Only a send moves the agent's last choice, so browsing options does not change what new conversations start with. */
  recordSend(ref: ConversationRef, choice: ModelChoice | null): void {
    if (choice) this.store.set(conversationKey(ref), choice);
    this.store.setLastUsed(ref.provider, choice);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/main/model-choices.test.ts`
Expected: PASS.

- [ ] **Step 5: Full checks and commit**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`

```bash
git add src/main/model-choices.ts src/main/model-choices.test.ts
git commit -m "feat(models): resolve, seed, and record conversation model choices"
```

---

### Task 8: IPC, preload, and startup wiring

**Files:**
- Create: `src/main/model-ipc.ts`
- Modify: `src/main/agent-ipc.ts` (options type; `create` and `continue` handlers)
- Modify: `src/preload.ts`, `src/global.d.ts`, `src/main.ts`
- Test: `src/main/model-ipc.test.ts`, `src/main/agent-ipc.test.ts`, `src/preload.test.ts`

**Interfaces:**
- Consumes: `ModelChoices` (Task 7); `MODEL_CHANNELS`, `parseModelChoice`, `parseConversationRef` (Task 1); `ModelsApi` (Task 1); `ModelChoiceStore` (Task 2); `CodexAdapter`/`ClaudeAdapter` `listModels`/`readLastRun` (Tasks 5–6).
- Produces: `registerModelIpc(choices: Pick<ModelChoices, 'catalog' | 'resolve' | 'choose'>, getWindow: () => BrowserWindow | null): { dispose(): void }`; `registerConversationIpc(…, options: { attachmentsRoot: string; modelChoices?: Pick<ModelChoices, 'seed' | 'recordSend'> })`; `window.fractal.models: ModelsApi`.

- [ ] **Step 1: Write the failing model IPC test**

Create `src/main/model-ipc.test.ts`:

```ts
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';
import { registerModelIpc } from './model-ipc';

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { electron.handlers.set(channel, handler); },
    removeHandler: (channel: string) => { electron.handlers.delete(channel); },
  },
}));

const ref = { provider: 'claude' as const, nativeSessionId: 'a', projectPath: '/work' };
const sender = { mainFrame: {} };
const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
const event = (source: typeof sender) => ({ sender: source, senderFrame: source.mainFrame }) as unknown as IpcMainInvokeEvent;
function setup() {
  const choices = { catalog: vi.fn(() => [{ id: 'opus', label: 'Opus', efforts: ['high'] }]), resolve: vi.fn(async () => ({ model: 'opus' })), choose: vi.fn() };
  const registration = registerModelIpc(choices, () => window);
  const call = (channel: string, source: typeof sender, ...args: unknown[]) => electron.handlers.get(channel)!(event(source), ...args);
  return { choices, registration, call };
}
afterEach(() => { electron.handlers.clear(); });

test('lists the agent catalog with the conversation resolved choice', async () => {
  const { choices, call } = setup();
  await expect(call('fractal:models:list', sender, ref)).resolves.toEqual({ models: [{ id: 'opus', label: 'Opus', efforts: ['high'] }], choice: { model: 'opus' } });
  expect(choices.catalog).toHaveBeenCalledWith('claude');
  expect(choices.resolve).toHaveBeenCalledWith(ref);
});

test('saves a valid choice and rejects an invalid or empty one', async () => {
  const { choices, call } = setup();
  await call('fractal:models:choose', sender, ref, { model: 'opus', effort: 'high' });
  expect(choices.choose).toHaveBeenCalledWith(ref, { model: 'opus', effort: 'high' });
  await expect(call('fractal:models:choose', sender, ref, null)).rejects.toThrow('Invalid model choice');
  await expect(call('fractal:models:choose', sender, ref, { model: '' })).rejects.toThrow('Invalid model choice');
  await expect(call('fractal:models:list', sender, { provider: 'bad' })).rejects.toThrow('Invalid conversation reference');
});

test('refuses other senders and removes its handlers on dispose', async () => {
  const { registration, call } = setup();
  await expect(call('fractal:models:list', { mainFrame: {} }, ref)).rejects.toThrow('Unauthorized model sender');
  registration.dispose();
  expect([...electron.handlers.keys()]).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/main/model-ipc.test.ts`
Expected: FAIL, cannot resolve `./model-ipc`.

- [ ] **Step 3: Write the model IPC**

Create `src/main/model-ipc.ts`:

```ts
import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { ModelChoices } from '@/main/model-choices';
import { MODEL_CHANNELS, parseConversationRef, parseModelChoice } from '@/shared/conversation-ipc';

/** The composer's model picker: the agent catalog, the conversation's resolved choice, and saving a pick. */
export function registerModelIpc(choices: Pick<ModelChoices, 'catalog' | 'resolve' | 'choose'>, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const authorize = (event: IpcMainInvokeEvent): void => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized model sender');
  };
  ipcMain.handle(MODEL_CHANNELS.list, async (event, input: unknown) => {
    authorize(event);
    const ref = parseConversationRef(input);
    return { models: choices.catalog(ref.provider), choice: await choices.resolve(ref) };
  });
  ipcMain.handle(MODEL_CHANNELS.choose, async (event, input: unknown, choiceInput: unknown) => {
    authorize(event);
    const ref = parseConversationRef(input);
    const choice = parseModelChoice(choiceInput);
    if (!choice) throw new Error('Invalid model choice');
    choices.choose(ref, choice);
  });
  return {
    dispose() {
      ipcMain.removeHandler(MODEL_CHANNELS.list);
      ipcMain.removeHandler(MODEL_CHANNELS.choose);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/main/model-ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing conversation IPC test**

In `src/main/agent-ipc.test.ts`, add `import type { ModelChoices } from '@/main/model-choices';`, change `function fixture()` to `function fixture(modelChoices?: Pick<ModelChoices, 'seed' | 'recordSend'>)`, and change its `register` to:

```ts
  const register = () => boundary.registerConversationIpc(service as unknown as ConversationService, getWindow, { attachmentsRoot: '/data/attachments', ...(modelChoices ? { modelChoices } : {}) });
```

Then add inside `describe('conversation IPC', …)`:

```ts
  test('seeds a created conversation and records the choice each prompt was sent with', async () => {
    const modelChoices = { seed: vi.fn(), recordSend: vi.fn() };
    const f = fixture(modelChoices);
    f.service.list.mockResolvedValue({ projects: [{ projectPath: '/tmp', displayName: 'tmp', conversations: [] }], providers: [] });
    await f.invoke('create', { provider: 'codex', projectPath: '/tmp' });
    expect(modelChoices.seed).toHaveBeenCalledWith(ref);
    await f.invoke('open', ref, loadId);
    await f.invoke('continue', ref, { text: 'Go', model: 'gpt-5.5', effort: 'high' });
    expect(modelChoices.recordSend).toHaveBeenLastCalledWith(ref, { model: 'gpt-5.5', effort: 'high' });
    await f.invoke('continue', ref, { text: 'Again' });
    expect(modelChoices.recordSend).toHaveBeenLastCalledWith(ref, null);
  });

  test('a failing choice store does not fail creating or sending', async () => {
    const modelChoices = { seed: vi.fn(() => { throw new Error('disk full'); }), recordSend: vi.fn(() => { throw new Error('disk full'); }) };
    const f = fixture(modelChoices);
    f.service.list.mockResolvedValue({ projects: [{ projectPath: '/tmp', displayName: 'tmp', conversations: [] }], providers: [] });
    await expect(f.invoke('create', { provider: 'codex', projectPath: '/tmp' })).resolves.toEqual(ref);
    await f.invoke('open', ref, loadId);
    await expect(f.invoke('continue', ref, { text: 'Go', model: 'gpt-5.5' })).resolves.toBeUndefined();
  });
```

Run: `pnpm exec vitest run src/main/agent-ipc.test.ts`
Expected: the two new tests FAIL (`seed`/`recordSend` never called).

- [ ] **Step 6: Hook choices into create and continue**

In `src/main/agent-ipc.ts`:
- Add `import type { ModelChoices } from '@/main/model-choices';` (`ConversationRef` is already imported).
- Change the options type in `registerConversationIpc` to `options: { attachmentsRoot: string; modelChoices?: Pick<ModelChoices, 'seed' | 'recordSend'> }`.
- Add, inside `registerConversationIpc` before `const registration`, two helpers:

```ts
  // The choice store is a convenience: a failed write leaves the conversation on its agent's default rather than failing it.
  const seedChoice = (ref: ConversationRef): ConversationRef => {
    try { options.modelChoices?.seed(ref); } catch { /* See above. */ }
    return ref;
  };
  const recordChoice = (ref: ConversationRef, model: string | undefined, effort: string | undefined): void => {
    try { options.modelChoices?.recordSend(ref, model ? { model, ...(effort ? { effort } : {}) } : null); } catch { /* See above. */ }
  };
```

- In the `create` handler, wrap both returns of a created ref: `return seedChoice(parseConversationRef(await service.create(provider, projectPath)));` (both branches).
- Replace the `continue` handler's returned function with:

```ts
      return async () => {
        await service.continue(ref, await resolveAttachments(prompt, { root: options.attachmentsRoot, ref }), String(owner.sender.id));
        recordChoice(ref, prompt.model, prompt.effort);
      };
```

Run: `pnpm exec vitest run src/main/agent-ipc.test.ts`
Expected: PASS.

- [ ] **Step 7: Expose the preload namespace**

In `src/preload.test.ts`, change the top-level key assertion to `['attachments', 'conversations', 'models', 'settings', 'terminals']`, widen the `surface` cast type with `models: ModelsApi` (import `ModelsApi` from `@/shared/conversation-contract`), and add:

```ts
  test('exposes the model list and choose calls on their own channels', async () => {
    const { surface } = await preload();
    await surface.models.list(ref);
    await surface.models.choose(ref, { model: 'opus', effort: 'high' });
    expect(mocks.invoke.mock.calls).toEqual([['fractal:models:list', ref], ['fractal:models:choose', ref, { model: 'opus', effort: 'high' }]]);
  });
```

Run: `pnpm exec vitest run src/preload.test.ts`
Expected: FAIL (no `models` key).

In `src/preload.ts`, import `MODEL_CHANNELS` alongside `CONVERSATION_CHANNELS` and `type ModelsApi` alongside `ConversationApi`, then add:

```ts
const models: ModelsApi = {
  list: (ref) => ipcRenderer.invoke(MODEL_CHANNELS.list, ref),
  choose: (ref, choice) => ipcRenderer.invoke(MODEL_CHANNELS.choose, ref, choice),
};
```

and change the expose call to `contextBridge.exposeInMainWorld('fractal', { conversations, models, settings, terminals, attachments });`.

In `src/global.d.ts`, import `ModelsApi` and add `models: ModelsApi;` to `window.fractal`.

Run: `pnpm exec vitest run src/preload.test.ts`
Expected: PASS.

- [ ] **Step 8: Wire startup and shutdown**

In `src/main.ts`:
- Import `ModelChoiceStore` from `@/main/model-choice-store`, `ModelChoices` from `@/main/model-choices`, and `registerModelIpc` from `@/main/model-ipc`.
- Add a module-level `let modelRegistration: { dispose(): void } | undefined;` next to `terminalRegistration`.
- In the `conversationStartup` block, name the two adapters and build the service before registering conversation IPC:

```ts
    const codexAdapter = new CodexAdapter(codexServer, { realpath: canonicalPath });
    const claudeAdapter = new ClaudeAdapter(path.join(homedir(), '.claude', 'projects'), {
      realpath: canonicalPath,
      tempDir: app.getPath('temp'),
      ownedProcesses: claudeOwnedProcesses,
      probe: () => probeClaude(defaultClaudeExec),
      runtime: (ref) => detectClaudeRuntime(ref, { hasOwnedProcess: (candidate) => claudeOwnedProcesses.has(candidate), exec: defaultClaudeExec }),
    });
    const registry = new ConversationRegistry([codexAdapter, claudeAdapter], canonicalPath);
    const modelChoices = new ModelChoices([codexAdapter, claudeAdapter], new ModelChoiceStore(app.getPath('userData')));
    // Once per launch, in the background; until a list arrives the picker shows only the current choice.
    void modelChoices.fetchCatalogs();
    modelRegistration = registerModelIpc(modelChoices, () => mainWindowRef);
    conversationService = new ConversationService(registry, (event) => registration.emit(event));
    const registration = registerConversationIpc(conversationService, () => mainWindowRef, { attachmentsRoot: path.join(app.getPath('userData'), 'attachments'), modelChoices });
```

- In the `before-quit` shutdown block, after `terminalService?.dispose();`, add `modelRegistration?.dispose();`.

- [ ] **Step 9: Full checks and commit**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`
Expected: all pass.

```bash
git add src/main/model-ipc.ts src/main/model-ipc.test.ts src/main/agent-ipc.ts src/main/agent-ipc.test.ts src/preload.ts src/preload.test.ts src/global.d.ts src/main.ts
git commit -m "feat(models): expose model choices over IPC and fetch catalogs at startup"
```

---

### Task 9: Composer picker

**Files:**
- Create: `src/components/conversation/model-choice.ts`, `src/components/conversation/model-picker.tsx`, `src/renderer/use-model-choice.ts`
- Modify: `src/renderer/use-conversation.ts:92-102` (`send`), `src/components/conversation-panel.tsx` (footer, submit)
- Test: `src/components/conversation/model-choice.test.ts`, `src/components/conversation-panel.test.tsx`

**Interfaces:**
- Consumes: `AgentModel`, `ModelChoice`, `ModelsApi`, `conversationKey` (Task 1); `window.fractal.models` (Task 8); `PromptInputSelect*` from `@/components/ai-elements/prompt-input`.
- Produces: `pickerModels(models: AgentModel[], choice: ModelChoice | null): AgentModel[]`; `switchModel(models: AgentModel[], choice: ModelChoice | null, modelId: string): ModelChoice`; `ModelPicker` component; `useModelChoice(ref): { models: AgentModel[]; choice: ModelChoice | null; refresh(): void; choose(choice: ModelChoice): void }`; `useConversation().send(text, attachments?, choice?)`.

- [ ] **Step 1: Write the failing helper test**

Create `src/components/conversation/model-choice.test.ts`:

```ts
import { expect, test } from 'vitest';
import type { AgentModel } from '@/shared/conversation-contract';
import { pickerModels, switchModel } from './model-choice';

const opus: AgentModel = { id: 'opus', label: 'Opus', efforts: ['low', 'high', 'max'] };
const haiku: AgentModel = { id: 'haiku', label: 'Haiku', efforts: [] };
const terra: AgentModel = { id: 'gpt-5.6-terra', label: 'Terra', efforts: ['low', 'medium', 'ultra'], defaultEffort: 'medium' };
const legacy: AgentModel = { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' };

test('lists an off-catalog current model first, under its raw id', () => {
  expect(pickerModels([opus], { model: 'claude-opus-5-5', effort: 'high' })).toEqual([{ id: 'claude-opus-5-5', label: 'claude-opus-5-5', efforts: ['high'] }, opus]);
  expect(pickerModels([opus], { model: 'claude-opus-5-5' })[0].efforts).toEqual([]);
  expect(pickerModels([opus], { model: 'opus' })).toEqual([opus]);
  expect(pickerModels([opus], null)).toEqual([opus]);
});

test('keeps the effort when the new model accepts it', () => {
  expect(switchModel([opus, terra], { model: 'gpt-5.6-terra', effort: 'low' }, 'opus')).toEqual({ model: 'opus', effort: 'low' });
  expect(switchModel([opus], { model: 'claude-opus-5-5', effort: 'max' }, 'opus')).toEqual({ model: 'opus', effort: 'max' });
});

test('otherwise falls back to the new model default effort, or to none', () => {
  expect(switchModel([terra, legacy], { model: 'gpt-5.6-terra', effort: 'ultra' }, 'gpt-5.5')).toEqual({ model: 'gpt-5.5', effort: 'medium' });
  expect(switchModel([opus, haiku], { model: 'opus', effort: 'high' }, 'haiku')).toEqual({ model: 'haiku' });
  expect(switchModel([opus], null, 'opus')).toEqual({ model: 'opus' });
});
```

Run: `pnpm exec vitest run src/components/conversation/model-choice.test.ts`
Expected: FAIL, cannot resolve `./model-choice`.

- [ ] **Step 2: Write the helpers**

Create `src/components/conversation/model-choice.ts`:

```ts
import type { AgentModel, ModelChoice } from '@/shared/conversation-contract';

/** The catalog, with an off-catalog current model listed first under its raw id, so what the picker shows is what runs. */
export function pickerModels(models: AgentModel[], choice: ModelChoice | null): AgentModel[] {
  if (!choice || models.some((model) => model.id === choice.model)) return models;
  return [{ id: choice.model, label: choice.model, efforts: choice.effort ? [choice.effort] : [] }, ...models];
}

/** Moving to another model keeps the effort only when that model accepts it; otherwise its default, or none. */
export function switchModel(models: AgentModel[], choice: ModelChoice | null, modelId: string): ModelChoice {
  const target = models.find((model) => model.id === modelId);
  if (choice?.effort && target?.efforts.includes(choice.effort)) return { model: modelId, effort: choice.effort };
  return target?.defaultEffort ? { model: modelId, effort: target.defaultEffort } : { model: modelId };
}
```

Run: `pnpm exec vitest run src/components/conversation/model-choice.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing panel tests**

In `src/components/conversation-panel.test.tsx`:
- Add `beforeAll` to the vitest import and `AgentModel`, `ModelChoice`, `ModelsApi` to the contract type import.
- Add after the `ready()` helper:

```ts
function installModels(result: { models: AgentModel[]; choice: ModelChoice | null }) {
  const models: ModelsApi = { list: vi.fn(async () => result), choose: vi.fn(async () => undefined) };
  Object.assign(window.fractal, { models });
  return models;
}
// jsdom has no layout; Radix scrolls the selected option into view.
beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: (): void => undefined }); });
const opus: AgentModel = { id: 'opus', label: 'Opus', description: 'Everyday work', efforts: ['low', 'high'] };
const haiku: AgentModel = { id: 'haiku', label: 'Haiku', efforts: [] };
```

- Add these tests:

```ts
test('shows the conversation model and effort and sends them with the prompt', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  const models = installModels({ models: [opus, haiku], choice: { model: 'opus', effort: 'high' } });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const model = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('Opus'));
  expect(screen.getByRole('combobox', { name: 'Effort' }).textContent).toContain('high');
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: 'Go', model: 'opus', effort: 'high' }));
  expect(models.list).toHaveBeenCalledWith(ref);
});

test('switching to a model without effort hides the effort picker and saves the choice', async () => {
  install();
  const models = installModels({ models: [opus, haiku], choice: { model: 'opus', effort: 'high' } });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const model = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('Opus'));
  const user = userEvent.setup();
  model.focus();
  await user.keyboard('{Enter}');
  await user.keyboard('{End}{Enter}');
  await waitFor(() => expect(models.choose).toHaveBeenCalledWith(ref, { model: 'haiku' }));
  expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
  // Opening the picker asks again, in case the startup fetch finished since.
  expect(models.list).toHaveBeenCalledTimes(2);
});

test('lists an off-catalog model the conversation last ran on', async () => {
  install();
  installModels({ models: [opus], choice: { model: 'claude-opus-5-5' } });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const model = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('claude-opus-5-5'));
  expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
});

test('falls back to the agent default when the model list is unavailable', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  expect((await screen.findByRole('combobox', { name: 'Model' })).textContent).toContain('Default');
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: 'Go' }));
});
```

Run: `pnpm exec vitest run src/components/conversation-panel.test.tsx`
Expected: the four new tests FAIL (no Model combobox).

- [ ] **Step 4: Write the hook**

Create `src/renderer/use-model-choice.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { conversationKey, type AgentModel, type ConversationRef, type ModelChoice } from '@/shared/conversation-contract';

interface State { key: string; models: AgentModel[]; choice: ModelChoice | null; picked: boolean }

/** A failed lookup leaves the picker on the agent's default rather than blocking the composer. */
function listModels(ref: ConversationRef): Promise<{ models: AgentModel[]; choice: ModelChoice | null }> {
  return Promise.resolve().then(() => window.fractal.models.list(ref)).catch(() => ({ models: [], choice: null }));
}

/** The conversation's model choice and its agent's catalog. Picks save immediately and apply to the next turn. */
export function useModelChoice(ref: ConversationRef) {
  const key = conversationKey(ref);
  const latest = useRef(ref);
  latest.current = ref;
  const [state, setState] = useState<State>({ key, models: [], choice: null, picked: false });

  useEffect(() => {
    let live = true;
    void listModels(latest.current).then((result) => {
      if (!live) return;
      // A pick made while the lookup was in flight wins over the stored answer.
      setState((prior) => ({ key, models: result.models, choice: prior.key === key && prior.picked ? prior.choice : result.choice, picked: prior.key === key && prior.picked }));
    });
    return () => { live = false; };
  }, [key]);

  const refresh = useCallback(() => {
    void listModels(latest.current).then((result) => setState((prior) => prior.key === key ? { ...prior, models: result.models } : prior));
  }, [key]);

  const choose = useCallback((choice: ModelChoice) => {
    setState((prior) => ({ key, models: prior.key === key ? prior.models : [], choice, picked: true }));
    void Promise.resolve().then(() => window.fractal.models.choose(latest.current, choice)).catch(() => undefined);
  }, [key]);

  const own = state.key === key ? state : { models: [], choice: null };
  return { models: own.models, choice: own.choice, refresh, choose };
}
```

- [ ] **Step 5: Write the picker**

Create `src/components/conversation/model-picker.tsx`:

```tsx
import { PromptInputSelect, PromptInputSelectContent, PromptInputSelectItem, PromptInputSelectTrigger, PromptInputSelectValue } from '@/components/ai-elements/prompt-input';
import type { AgentModel, ModelChoice } from '@/shared/conversation-contract';
import { pickerModels, switchModel } from './model-choice';

interface Props {
  models: AgentModel[];
  choice: ModelChoice | null;
  onChoose(choice: ModelChoice): void;
  /** Called when the model list opens, so a catalog that arrived since can be shown. */
  onOpen(): void;
}

// The description lives inside the item text, so it is hidden when the trigger mirrors the selected item.
const DESCRIPTION = 'text-xs text-muted-foreground [[data-slot=select-trigger]_&]:hidden';

export function ModelPicker({ models, choice, onChoose, onOpen }: Props) {
  const listed = pickerModels(models, choice);
  const selected = choice ? listed.find((model) => model.id === choice.model) : undefined;
  return (
    <div className="flex min-w-0 items-center">
      <PromptInputSelect onOpenChange={(open) => { if (open) onOpen(); }} onValueChange={(id) => onChoose(switchModel(models, choice, id))} value={choice?.model ?? ''}>
        <PromptInputSelectTrigger aria-label="Model" className="h-8 max-w-48 px-2 text-xs" size="sm">
          <PromptInputSelectValue placeholder="Default" />
        </PromptInputSelectTrigger>
        <PromptInputSelectContent>
          {listed.map((model) => (
            <PromptInputSelectItem key={model.id} value={model.id}>
              <span className="flex flex-col">
                <span>{model.label}</span>
                {model.description && <span className={DESCRIPTION}>{model.description}</span>}
              </span>
            </PromptInputSelectItem>
          ))}
        </PromptInputSelectContent>
      </PromptInputSelect>
      {selected && selected.efforts.length > 0 && (
        <PromptInputSelect onValueChange={(effort) => onChoose({ model: selected.id, effort })} value={choice?.effort ?? selected.defaultEffort ?? ''}>
          <PromptInputSelectTrigger aria-label="Effort" className="h-8 px-2 text-xs" size="sm">
            <PromptInputSelectValue placeholder="Default" />
          </PromptInputSelectTrigger>
          <PromptInputSelectContent>
            {selected.efforts.map((effort) => <PromptInputSelectItem key={effort} value={effort}>{effort}</PromptInputSelectItem>)}
          </PromptInputSelectContent>
        </PromptInputSelect>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Send the choice and mount the picker**

In `src/renderer/use-conversation.ts`, add `type ModelChoice` to the contract import and replace `send` with:

```ts
  const send = useCallback((text: string, attachments: PromptAttachment[] = [], choice: ModelChoice | null = null): Promise<void | undefined> | undefined => {
    const active = currentActiveLoad(state.ref, state.loadId);
    if (!canSend || !active || !state.ref) return undefined;
    try {
      const prompt = parsePromptInput({ text, ...(attachments.length > 0 ? { attachments } : {}), ...(choice ?? {}) });
      return containActionSettlement(window.fractal.conversations.continue(state.ref, prompt), active);
    } catch {
      // The bridge never sees malformed renderer input.
      return undefined;
    }
  }, [canSend, containActionSettlement, currentActiveLoad, state.loadId, state.ref]);
```

In `src/components/conversation-panel.tsx`:
- Import `ModelPicker` from `@/components/conversation/model-picker` and `useModelChoice` from `@/renderer/use-model-choice`.
- In `NativeConversationPanel`, after the `useConversation` line, add `const modelChoice = useModelChoice(conversationRef);`.
- In `handleSubmit`, change `send(draft.trim(), attachments)` to `send(draft.trim(), attachments, modelChoice.choice)`.
- Replace `<AttachButton disabled={!eligible || sending} />` in the footer with:

```tsx
            <div className="flex min-w-0 items-center gap-1">
              <AttachButton disabled={!eligible || sending} />
              <ModelPicker choice={modelChoice.choice} models={modelChoice.models} onChoose={modelChoice.choose} onOpen={modelChoice.refresh} />
            </div>
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `pnpm exec vitest run src/components src/renderer`
Expected: PASS, including every existing panel test (they install no `models` API, so the picker reads "Default" and prompts carry no choice).

- [ ] **Step 8: Full checks and commit**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`

```bash
git add src/components/conversation/model-choice.ts src/components/conversation/model-choice.test.ts src/components/conversation/model-picker.tsx src/renderer/use-model-choice.ts src/renderer/use-conversation.ts src/components/conversation-panel.tsx src/components/conversation-panel.test.tsx
git commit -m "feat(composer): pick the model and effort for each conversation"
```

---

### Task 10: Verify in the running app

**Files:** none (verification only; fix anything found in the task that owns it, with its own test).

- [ ] **Step 1: Full checks**

Run: `pnpm lint && pnpm exec tsc --noEmit && pnpm test`
Expected: all pass. Record the test count.

- [ ] **Step 2: Drive the real app**

Launch with the `run` skill (main-process code changed, so a running `pnpm start` needs `rs` or a restart). Then:

1. Open an existing Claude conversation. The Model select shows the transcript's last model (a full id such as `claude-opus-5-5` if it is not in the list), with the matching effort when one was recorded.
2. Open the Model list. It shows Claude's models with descriptions; the trigger shows only the label. Pick Haiku: the Effort select disappears. Pick Opus: Effort reappears reading "Default".
3. Send a short prompt. In `~/.claude/projects/…/<session>.jsonl`, the new assistant record's `message.model` matches the pick, and `effort` matches when one was chosen.
4. Open an existing Codex conversation. Model and Effort show what `thread/resume` reported. Switch from a model on `ultra` (if available) to `gpt-5.5`: effort resets to `medium`.
5. Send a Codex prompt with a non-default effort; confirm the turn runs (and, if visible in Codex's own history, used that model).
6. Start a new conversation for each agent: it starts with the choice last sent with that agent.
7. Scroll through the composer at a narrow window width: the footer does not overflow; long model ids truncate.
8. Check `<userData>/model-choices.json` holds the conversations and `lastUsed` entries.

- [ ] **Step 3: Report**

Report what was observed for each numbered check, including any that failed and what was fixed. Do not delete scratch conversations without the user's say-so.

---

## Notes for the executor

- **Branch:** the scroll-to-bottom change from the same session is uncommitted on `feat/native-conversation-history-continuation`. Ask the user where this plan's branch (`feat/model-effort-picker`) should start before creating the worktree.
- **Unverified, not in scope:** calling `thread/resume` on a Codex thread that another Codex process (the TUI) is actively running. The plan only reads the response; if you observe side effects while verifying, report them rather than changing the design.
- The spec says choices live in `FractalSettings`; this plan stores them in `model-choices.json` instead (see Global Constraints). If the user reverses that, Task 2 changes and Tasks 7–8 do not.
- Radix Select value `''` shows the placeholder; do not pass `undefined`, which flips the select between uncontrolled and controlled.
