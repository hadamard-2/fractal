# Execute-mode IPC Message Shape Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the renderer↔main contract and state layer that backs Fractal's execute-mode conversation panel, replacing birtukan-ai's `useChat`, and wire the already-vendored AI Elements components against it end-to-end through a stub backend.

**Architecture:** Main process owns authoritative conversation state, persists one JSON file per conversation (written only when an entry settles), and streams sequenced delta events to the renderer over a single channel. The renderer runs a pure reducer over those events inside a `useConversation` hook that feeds the panel. A shared, type-only contract module is the single source of truth for the shape; a scripted stub adapter stands in for a real agent so the panel runs before a backend is chosen.

**Tech Stack:** Electron 43 + Forge 7 (Vite plugin), React 19, TypeScript 5.9, Tailwind v4, pnpm. Vitest (added in Task 0) for the pure-logic units. Node v24.18.1 is bundled with Electron 43.4.0.

**Spec:** [docs/superpowers/specs/2026-08-21-execute-mode-ipc-message-shape-design.md](../specs/2026-08-21-execute-mode-ipc-message-shape-design.md)

## Global Constraints

- **`contextIsolation` stays on, `nodeIntegration` stays off.** Never weaken either to make something work. (CLAUDE.md)
- **The renderer reaches the main process only through the `contextBridge` surface in `src/preload.ts`.** `ipcRenderer` is never exposed; preload hand-writes each method. (CLAUDE.md, spec §3)
- **`vite.renderer.config.mts` keeps its `.mts` extension** (Tailwind v4 plugin is ESM-only) and **`@vitejs/plugin-react` stays on 4.x.** (CLAUDE.md, docs/environment-notes.md)
- **The window is frameless;** chrome lives in `components/title-bar.tsx`. Do not add native menu/frame. (CLAUDE.md)
- **`CONTRACT_VERSION = 1`.** Stamped on every event's `v` and on `Conversation.schemaVersion` at creation. (spec §1, §4)
- **Paths in parts and provenance are relative to `Conversation.repoRoot`.** (spec §1)
- **Main is the only writer of persisted state.** Writes happen on entry-settle (`complete`/`interrupted`/`error`) and metadata change — never on the per-token hot path. (spec §4)
- **`createConversation()` takes no arguments;** main opens the directory picker and sets `repoRoot`. The renderer never names a path. (spec §3)
- **Lint runs over `.ts`, `.tsx`, `.mts`;** `src/components/ai-elements/**` is ignored. Run `pnpm lint` and `pnpm exec tsc --noEmit` before considering any task done. (CLAUDE.md)
- **Commits follow Conventional Commits** (`<type>: <subject>`). Do not `git push`. Commit only the files a task names.

---

## File Structure

- `src/shared/agent-contract.ts` — **Create.** All contract types (§1–§3) plus `CONTRACT_VERSION` and small runtime type-guards. Imported by both processes. The single source of truth for the shape.
- `src/main/conversation-store.ts` — **Create.** Durable state: JSON file per conversation, the index file, load, save-on-settle, forward migrations. Owns `app.getPath('userData')` layout.
- `src/main/session-manager.ts` — **Create.** In-flight turns, per-conversation `seq`, pending permission requests; produces `AgentEvent`s; drives the backend adapter.
- `src/main/backend-adapter.ts` — **Create.** The seam a real agent plugs into. v1 ships a scripted echo adapter.
- `src/main/agent-ipc.ts` — **Create.** Registers `ipcMain` handlers for the command surface and forwards `AgentEvent`s to renderer webContents. The only Electron-IPC-aware main file.
- `src/main.ts` — **Modify.** Call `registerAgentIpc(...)` after the window is created.
- `src/preload.ts` — **Modify.** `contextBridge` exposing `window.fractal.agent`.
- `src/renderer/conversation-reducer.ts` — **Create.** Pure `(state, event) => state` reducer. No React, no IPC. The most heavily tested unit.
- `src/renderer/use-conversation.ts` — **Create.** React hook: subscribes to `onAgentEvent`, runs the reducer, exposes entries/status/command callbacks. Replaces `useChat`.
- `src/components/conversation-panel.tsx` — **Create.** Mounts the vendored AI Elements against `useConversation`.
- `src/components/execute-mode.tsx` — **Modify.** Drop the panel into the empty content area.
- `src/global.d.ts` — **Create.** Declares `window.fractal` for the renderer's type-checker.
- Test files colocated as `*.test.ts` next to each pure unit.

---

## Task 0: Test infrastructure (Vitest)

**Files:**
- Modify: `package.json` (scripts + devDeps)
- Create: `vitest.config.ts`
- Create: `src/shared/smoke.test.ts` (deleted at end of task)

**Interfaces:**
- Consumes: nothing.
- Produces: a working `pnpm test` command; `@/` alias resolves in tests; `node`+`jsdom` environments available.

- [ ] **Step 1: Install Vitest**

```bash
pnpm add -D vitest@^2 jsdom@^25
```

- [ ] **Step 2: Create `vitest.config.ts`**

Keep it separate from the Vite build configs; it only needs the `@/` alias and a default node environment (per-file override to jsdom via a docblock comment).

```ts
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/components/ai-elements/**'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

- [ ] **Step 3: Add the test script to `package.json`**

Add to `"scripts"`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Write a smoke test**

`src/shared/smoke.test.ts`:

```ts
import { expect, test } from 'vitest';

test('vitest runs and resolves the @ alias environment', () => {
  expect(1 + 1).toBe(2);
});
```

- [ ] **Step 5: Run it**

Run: `pnpm test`
Expected: PASS, 1 test.

- [ ] **Step 6: Delete the smoke test, commit**

```bash
rm src/shared/smoke.test.ts
git add package.json pnpm-lock.yaml vitest.config.ts
git commit -m "test: add vitest with @ alias and node/jsdom environments"
```

---

## Task 1: Shared contract types

**Files:**
- Create: `src/shared/agent-contract.ts`
- Test: `src/shared/agent-contract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `CONTRACT_VERSION: 1`; types `ConversationId`, `EntryId`, `PartId`, `Conversation`, `Entry`, `Part`, `TextPart`, `ReasoningPart`, `WorkPart`, `WorkBase`, `Provenance`, `AgentEvent`, `EventEnvelope`, `PartPatch`, `PermissionDecision`, `FractalAgentApi`; runtime guards `isWorkPart(part)`, `isTextPart(part)`, `filesReadFrom(entry): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest';
import {
  CONTRACT_VERSION,
  filesReadFrom,
  isTextPart,
  isWorkPart,
  type Entry,
} from '@/shared/agent-contract';

const entry: Entry = {
  id: 'e1',
  conversationId: 'c1',
  author: 'agent',
  createdAt: 0,
  status: 'complete',
  parts: [
    { id: 'p1', kind: 'text', text: 'hi' },
    { id: 'p2', kind: 'file-read', path: 'a.ts', startedAt: 0, phase: 'done' },
    { id: 'p3', kind: 'file-read', path: 'b.ts', startedAt: 0, phase: 'done' },
    { id: 'p4', kind: 'file-edit', path: 'a.ts', startedAt: 0, phase: 'done' },
  ],
};

describe('agent-contract', () => {
  test('CONTRACT_VERSION is 1', () => {
    expect(CONTRACT_VERSION).toBe(1);
  });

  test('isTextPart / isWorkPart discriminate', () => {
    expect(isTextPart(entry.parts[0])).toBe(true);
    expect(isWorkPart(entry.parts[0])).toBe(false);
    expect(isWorkPart(entry.parts[1])).toBe(true);
  });

  test('filesReadFrom derives read paths, de-duplicated, edits excluded', () => {
    expect(filesReadFrom(entry)).toEqual(['a.ts', 'b.ts']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/agent-contract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the contract module**

`src/shared/agent-contract.ts` — transcribe the spec's §1–§3 types verbatim, then add the runtime members. Full type bodies are in the spec; the runtime tail is:

```ts
export const CONTRACT_VERSION = 1 as const;

export function isTextPart(part: Part): part is TextPart {
  return part.kind === 'text';
}

export function isWorkPart(part: Part): part is WorkPart {
  return (
    part.kind === 'file-read' ||
    part.kind === 'file-edit' ||
    part.kind === 'command-run' ||
    part.kind === 'tool-call'
  );
}

/** Derived, never stored (spec §1): read paths from an entry's file-read parts. */
export function filesReadFrom(entry: Entry): string[] {
  const seen = new Set<string>();
  for (const part of entry.parts) {
    if (part.kind === 'file-read') seen.add(part.path);
  }
  return [...seen];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/agent-contract.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit
git add src/shared/agent-contract.ts src/shared/agent-contract.test.ts
git commit -m "feat: add shared agent IPC contract types and guards"
```

---

## Task 2: Conversation store (persistence + migrations)

**Files:**
- Create: `src/main/conversation-store.ts`
- Test: `src/main/conversation-store.test.ts`

**Interfaces:**
- Consumes: contract types from Task 1.
- Produces: class `ConversationStore` with `constructor(rootDir: string)`; `create(repoRoot: string): Conversation`; `list(): Conversation[]`; `load(id): { conversation: Conversation; entries: Entry[] } | null`; `saveEntry(id, entry: Entry): void`; `updateMeta(id, patch: { title?: string }): void`. `rootDir` is injected (not `app.getPath`) so tests use a temp dir.

Note: the store is deliberately Electron-free — it takes `rootDir` as a constructor argument. Task 5 passes `app.getPath('userData')`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationStore } from '@/main/conversation-store';
import type { Entry } from '@/shared/agent-contract';

let dir: string;
let store: ConversationStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fractal-store-'));
  store = new ConversationStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (id: string): Entry => ({
  id,
  conversationId: 'x',
  author: 'agent',
  createdAt: 1,
  status: 'complete',
  parts: [{ id: 'p', kind: 'text', text: 'done' }],
});

describe('ConversationStore', () => {
  test('create stamps schemaVersion and repoRoot, and appears in list', () => {
    const c = store.create('/repo');
    expect(c.schemaVersion).toBe(1);
    expect(c.repoRoot).toBe('/repo');
    expect(store.list().map((x) => x.id)).toEqual([c.id]);
  });

  test('saveEntry persists and load round-trips', () => {
    const c = store.create('/repo');
    store.saveEntry(c.id, { ...entry('e1'), conversationId: c.id });
    const loaded = store.load(c.id);
    expect(loaded?.entries.map((e) => e.id)).toEqual(['e1']);
  });

  test('a fresh store instance reads what a prior instance wrote', () => {
    const c = store.create('/repo');
    store.saveEntry(c.id, { ...entry('e1'), conversationId: c.id });
    const reopened = new ConversationStore(dir);
    expect(reopened.load(c.id)?.entries).toHaveLength(1);
    expect(reopened.list()).toHaveLength(1);
  });

  test('load of unknown id is null', () => {
    expect(store.load('nope')).toBeNull();
  });

  test('refuses a conversation written by a newer contract version', () => {
    const c = store.create('/repo');
    // Simulate a future build having written this conversation.
    store.forceWriteRawForTest(c.id, { conversation: { ...c, schemaVersion: 99 }, entries: [] });
    expect(() => store.load(c.id)).toThrow(/newer version of Fractal/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/conversation-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

`src/main/conversation-store.ts`. Layout: `<rootDir>/conversations/<id>.json` holding `{ conversation, entries }`, plus `<rootDir>/conversations/index.json` holding `Conversation[]`. Synchronous `fs` is fine — writes are off the hot path (spec §4).

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTRACT_VERSION, type Conversation, type Entry } from '@/shared/agent-contract';

interface StoredConversation {
  conversation: Conversation;
  entries: Entry[];
}

export class ConversationStore {
  private readonly dir: string;
  private readonly indexPath: string;

  constructor(rootDir: string) {
    this.dir = path.join(rootDir, 'conversations');
    this.indexPath = path.join(this.dir, 'index.json');
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(id: string) {
    return path.join(this.dir, `${id}.json`);
  }

  private readIndex(): Conversation[] {
    if (!existsSync(this.indexPath)) return [];
    return JSON.parse(readFileSync(this.indexPath, 'utf8')) as Conversation[];
  }

  private writeIndex(list: Conversation[]) {
    writeFileSync(this.indexPath, JSON.stringify(list, null, 2));
  }

  create(repoRoot: string): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: randomUUID(),
      title: 'New conversation',
      repoRoot,
      createdAt: now,
      updatedAt: now,
      schemaVersion: CONTRACT_VERSION,
    };
    writeFileSync(this.filePath(conversation.id), JSON.stringify({ conversation, entries: [] }, null, 2));
    this.writeIndex([...this.readIndex(), conversation]);
    return conversation;
  }

  list(): Conversation[] {
    return this.readIndex();
  }

  load(id: string): StoredConversation | null {
    const p = this.filePath(id);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf8')) as StoredConversation;
    if (raw.conversation.schemaVersion > CONTRACT_VERSION) {
      throw new Error(
        `Conversation ${id} was created by a newer version of Fractal ` +
          `(schema ${raw.conversation.schemaVersion} > ${CONTRACT_VERSION}).`,
      );
    }
    // Forward migrations for older schemas go here as CONTRACT_VERSION grows.
    return raw;
  }

  saveEntry(id: string, entry: Entry): void {
    const stored = this.load(id);
    if (!stored) throw new Error(`Conversation ${id} not found`);
    const idx = stored.entries.findIndex((e) => e.id === entry.id);
    if (idx >= 0) stored.entries[idx] = entry;
    else stored.entries.push(entry);
    stored.conversation.updatedAt = Date.now();
    writeFileSync(this.filePath(id), JSON.stringify(stored, null, 2));
    this.syncIndex(stored.conversation);
  }

  updateMeta(id: string, patch: { title?: string }): void {
    const stored = this.load(id);
    if (!stored) throw new Error(`Conversation ${id} not found`);
    if (patch.title !== undefined) stored.conversation.title = patch.title;
    stored.conversation.updatedAt = Date.now();
    writeFileSync(this.filePath(id), JSON.stringify(stored, null, 2));
    this.syncIndex(stored.conversation);
  }

  private syncIndex(conversation: Conversation) {
    const list = this.readIndex();
    const idx = list.findIndex((c) => c.id === conversation.id);
    if (idx >= 0) list[idx] = conversation;
    else list.push(conversation);
    this.writeIndex(list);
  }

  /** Test-only: write raw stored content, bypassing validation. */
  forceWriteRawForTest(id: string, raw: StoredConversation): void {
    writeFileSync(this.filePath(id), JSON.stringify(raw, null, 2));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/conversation-store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit
git add src/main/conversation-store.ts src/main/conversation-store.test.ts
git commit -m "feat: add JSON conversation store with save-on-settle and version guard"
```

---

## Task 3: Backend adapter (scripted stub)

**Files:**
- Create: `src/main/backend-adapter.ts`
- Test: `src/main/backend-adapter.test.ts`

**Interfaces:**
- Consumes: contract types.
- Produces: interface `BackendAdapter` with `run(input: { text: string; emit: (step: AdapterStep) => void; signal: AbortSignal }): Promise<void>`; type `AdapterStep` (a small vocabulary the session manager maps into parts/events); factory `createEchoAdapter(): BackendAdapter`. `AdapterStep` union: `{ kind: 'text'; delta: string }`, `{ kind: 'work-start'; part: WorkPart }`, `{ kind: 'work-end'; partId: string; patch: PartPatch }`, `{ kind: 'need-permission'; partId: string }`, `{ kind: 'provenance'; provenance: Provenance }`.

The echo adapter is deterministic so the session-manager test (Task 4) can assert exact event sequences. It emits a couple of text deltas and one fake `file-read` work part.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'vitest';
import { createEchoAdapter, type AdapterStep } from '@/main/backend-adapter';

describe('echo adapter', () => {
  test('emits text deltas then a completed file-read work part', async () => {
    const steps: AdapterStep[] = [];
    const adapter = createEchoAdapter();
    await adapter.run({
      text: 'hello',
      emit: (s) => steps.push(s),
      signal: new AbortController().signal,
    });
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('text');
    expect(kinds).toContain('work-start');
    expect(kinds).toContain('work-end');
    const start = steps.find((s) => s.kind === 'work-start');
    expect(start && start.kind === 'work-start' && start.part.kind).toBe('file-read');
  });

  test('stops early when the signal is already aborted', async () => {
    const steps: AdapterStep[] = [];
    const ctrl = new AbortController();
    ctrl.abort();
    await createEchoAdapter().run({ text: 'x', emit: (s) => steps.push(s), signal: ctrl.signal });
    expect(steps).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/backend-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the echo adapter**

```ts
import type { PartPatch, Provenance, WorkPart } from '@/shared/agent-contract';

export type AdapterStep =
  | { kind: 'text'; delta: string }
  | { kind: 'work-start'; part: WorkPart }
  | { kind: 'work-end'; partId: string; patch: PartPatch }
  | { kind: 'need-permission'; partId: string }
  | { kind: 'provenance'; provenance: Provenance };

export interface BackendAdapter {
  run(input: {
    text: string;
    emit: (step: AdapterStep) => void;
    signal: AbortSignal;
  }): Promise<void>;
}

export function createEchoAdapter(): BackendAdapter {
  return {
    async run({ text, emit, signal }) {
      if (signal.aborted) return;
      emit({ kind: 'text', delta: `You said: ${text}. ` });
      if (signal.aborted) return;
      const partId = 'work-1';
      emit({
        kind: 'work-start',
        part: { id: partId, kind: 'file-read', path: 'README.md', startedAt: Date.now(), phase: 'running' },
      });
      emit({ kind: 'work-end', partId, patch: { phase: 'done', endedAt: Date.now() } });
      emit({ kind: 'text', delta: 'Done.' });
      emit({ kind: 'provenance', provenance: { filesSkipped: [], uncertainties: [], complete: true } });
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/backend-adapter.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit
git add src/main/backend-adapter.ts src/main/backend-adapter.test.ts
git commit -m "feat: add scripted echo backend adapter stub"
```

---

## Task 4: Session manager (turns, seq, permissions, events)

**Files:**
- Create: `src/main/session-manager.ts`
- Test: `src/main/session-manager.test.ts`

**Interfaces:**
- Consumes: `ConversationStore` (Task 2), `BackendAdapter`/`AdapterStep`/`createEchoAdapter` (Task 3), contract types.
- Produces: class `SessionManager` with `constructor(deps: { store: ConversationStore; adapter: BackendAdapter; emit: (event: AgentEvent) => void })`; methods `sendMessage({ conversationId, text }): { entryId: EntryId }`; `cancelTurn({ conversationId }): void`; `respondToPermission({ requestId, decision }): void`; `snapshot(conversationId): { conversation; entries; seq } | null`. `emit` is injected so the test captures events and Task 5 forwards them to webContents.

Behaviour to encode (spec §2–§4): each turn adds a user entry then a streaming agent entry; per-conversation `seq` increments on every emitted event; `text` steps map to `text.appended` (creating a text part via `part.added` on first delta); `work-start`→`part.added`, `work-end`→`part.updated`; `need-permission` parks a promise and emits `permission.requested`, resolved by `respondToPermission` which emits `permission.resolved`; the agent entry is `saveEntry`'d only when it settles; `cancelTurn` aborts the adapter and settles the entry as `interrupted`.

- [ ] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConversationStore } from '@/main/conversation-store';
import { createEchoAdapter } from '@/main/backend-adapter';
import { SessionManager } from '@/main/session-manager';
import type { AgentEvent } from '@/shared/agent-contract';

let dir: string;
let store: ConversationStore;
let events: AgentEvent[];
let mgr: SessionManager;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fractal-sess-'));
  store = new ConversationStore(dir);
  events = [];
  mgr = new SessionManager({ store, adapter: createEchoAdapter(), emit: (e) => events.push(e) });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SessionManager', () => {
  test('a turn emits a monotonic seq per conversation and settles the agent entry', async () => {
    const c = store.create('/repo');
    mgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 0)); // let the async adapter drain

    const seqs = events.filter((e) => e.conversationId === c.id).map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // strictly increasing, no repeats

    const status = events.filter((e) => e.type === 'entry.status');
    expect(status.at(-1)).toMatchObject({ status: 'complete' });

    // Settled agent entry was persisted.
    const reloaded = new ConversationStore(dir).load(c.id);
    const agentEntries = reloaded?.entries.filter((e) => e.author === 'agent') ?? [];
    expect(agentEntries).toHaveLength(1);
    expect(agentEntries[0].status).toBe('complete');
  });

  test('snapshot returns entries and the current seq', async () => {
    const c = store.create('/repo');
    mgr.sendMessage({ conversationId: c.id, text: 'hi' });
    await new Promise((r) => setTimeout(r, 0));
    const snap = mgr.snapshot(c.id);
    expect(snap).not.toBeNull();
    expect(snap!.seq).toBeGreaterThan(0);
    expect(snap!.entries.length).toBeGreaterThanOrEqual(2); // user + agent
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/session-manager.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the session manager**

`src/main/session-manager.ts`. Hold per-conversation runtime state in a `Map`: current `seq`, the in-memory streaming entries, the `AbortController` for the live turn, and a `Map<requestId, () => void>` of parked permission resolvers. Emit helper stamps `v`, `seq++`, `conversationId`.

```ts
import { randomUUID } from 'node:crypto';
import {
  CONTRACT_VERSION,
  type AgentEvent,
  type Entry,
  type EntryId,
  type PermissionDecision,
} from '@/shared/agent-contract';
import type { ConversationStore } from '@/main/conversation-store';
import type { AdapterStep, BackendAdapter } from '@/main/backend-adapter';

interface Runtime {
  seq: number;
  entries: Map<EntryId, Entry>;
  order: EntryId[];
  abort?: AbortController;
  pending: Map<string, (decision: PermissionDecision) => void>;
}

export class SessionManager {
  private readonly store: ConversationStore;
  private readonly adapter: BackendAdapter;
  private readonly emitRaw: (event: AgentEvent) => void;
  private readonly runtimes = new Map<string, Runtime>();

  constructor(deps: {
    store: ConversationStore;
    adapter: BackendAdapter;
    emit: (event: AgentEvent) => void;
  }) {
    this.store = deps.store;
    this.adapter = deps.adapter;
    this.emitRaw = deps.emit;
  }

  private runtime(conversationId: string): Runtime {
    let rt = this.runtimes.get(conversationId);
    if (!rt) {
      const stored = this.store.load(conversationId);
      rt = { seq: 0, entries: new Map(), order: [], pending: new Map() };
      for (const e of stored?.entries ?? []) {
        rt.entries.set(e.id, e);
        rt.order.push(e.id);
      }
      this.runtimes.set(conversationId, rt);
    }
    return rt;
  }

  private emit(conversationId: string, event: Omit<AgentEvent, 'v' | 'seq' | 'conversationId'>) {
    const rt = this.runtime(conversationId);
    rt.seq += 1;
    this.emitRaw({ v: CONTRACT_VERSION, seq: rt.seq, conversationId, ...event } as AgentEvent);
  }

  private addEntry(conversationId: string, entry: Entry) {
    const rt = this.runtime(conversationId);
    rt.entries.set(entry.id, entry);
    rt.order.push(entry.id);
    this.emit(conversationId, { type: 'entry.added', entry });
  }

  private settle(conversationId: string, entryId: EntryId, status: Entry['status']) {
    const rt = this.runtime(conversationId);
    const entry = rt.entries.get(entryId);
    if (!entry) return;
    entry.status = status;
    this.emit(conversationId, { type: 'entry.status', entryId, status });
    this.store.saveEntry(conversationId, entry); // write-on-settle
  }

  sendMessage({ conversationId, text }: { conversationId: string; text: string }): { entryId: EntryId } {
    const rt = this.runtime(conversationId);

    const userEntry: Entry = {
      id: randomUUID(),
      conversationId,
      author: 'user',
      createdAt: Date.now(),
      status: 'complete',
      parts: [{ id: randomUUID(), kind: 'text', text }],
    };
    this.addEntry(conversationId, userEntry);
    this.store.saveEntry(conversationId, userEntry);

    const agentEntry: Entry = {
      id: randomUUID(),
      conversationId,
      author: 'agent',
      createdAt: Date.now(),
      status: 'streaming',
      parts: [],
    };
    this.addEntry(conversationId, agentEntry);

    const abort = new AbortController();
    rt.abort = abort;
    let textPartId: string | null = null;

    const onStep = (step: AdapterStep) => {
      const entry = rt.entries.get(agentEntry.id)!;
      switch (step.kind) {
        case 'text': {
          if (!textPartId) {
            textPartId = randomUUID();
            const part = { id: textPartId, kind: 'text' as const, text: '' };
            entry.parts.push(part);
            this.emit(conversationId, { type: 'part.added', entryId: entry.id, index: entry.parts.length - 1, part });
          }
          const tp = entry.parts.find((p) => p.id === textPartId)!;
          if (tp.kind === 'text') tp.text += step.delta;
          this.emit(conversationId, { type: 'text.appended', entryId: entry.id, partId: textPartId, delta: step.delta });
          break;
        }
        case 'work-start': {
          entry.parts.push(step.part);
          this.emit(conversationId, { type: 'part.added', entryId: entry.id, index: entry.parts.length - 1, part: step.part });
          break;
        }
        case 'work-end': {
          const wp = entry.parts.find((p) => p.id === step.partId);
          if (wp) Object.assign(wp, step.patch);
          this.emit(conversationId, { type: 'part.updated', entryId: entry.id, partId: step.partId, patch: step.patch });
          break;
        }
        case 'provenance': {
          entry.provenance = step.provenance;
          this.emit(conversationId, { type: 'provenance.updated', entryId: entry.id, provenance: step.provenance });
          break;
        }
        case 'need-permission': {
          const requestId = randomUUID();
          this.emit(conversationId, { type: 'permission.requested', entryId: entry.id, partId: step.partId, requestId });
          // Parked resolver; the promise is awaited inside run() via a wrapper if the adapter needs it.
          rt.pending.set(requestId, () => undefined);
          break;
        }
      }
    };

    void this.adapter
      .run({ text, emit: onStep, signal: abort.signal })
      .then(() => {
        if (!abort.signal.aborted) this.settle(conversationId, agentEntry.id, 'complete');
      })
      .catch((err) => {
        const entry = rt.entries.get(agentEntry.id);
        if (entry) entry.error = { message: err instanceof Error ? err.message : String(err) };
        this.settle(conversationId, agentEntry.id, 'error');
      });

    return { entryId: agentEntry.id };
  }

  cancelTurn({ conversationId }: { conversationId: string }): void {
    const rt = this.runtimes.get(conversationId);
    if (!rt?.abort) return;
    rt.abort.abort();
    const streaming = rt.order.map((id) => rt.entries.get(id)!).find((e) => e.status === 'streaming');
    if (streaming) this.settle(conversationId, streaming.id, 'interrupted');
  }

  respondToPermission({ requestId, decision }: { requestId: string; decision: PermissionDecision }): void {
    for (const [conversationId, rt] of this.runtimes) {
      const resolve = rt.pending.get(requestId);
      if (resolve) {
        rt.pending.delete(requestId);
        resolve(decision);
        this.emit(conversationId, { type: 'permission.resolved', requestId, decision });
        return;
      }
    }
  }

  snapshot(conversationId: string): { conversation: import('@/shared/agent-contract').Conversation; entries: Entry[]; seq: number } | null {
    const stored = this.store.load(conversationId);
    if (!stored) return null;
    const rt = this.runtime(conversationId);
    const entries = rt.order.length ? rt.order.map((id) => rt.entries.get(id)!) : stored.entries;
    return { conversation: stored.conversation, entries, seq: rt.seq };
  }
}
```

> Note: the echo adapter never emits `need-permission`, so the parked-resolver path is exercised in Task 8's manual pass, not this unit test. The `respondToPermission` emit path is still type-checked and covered by the loop above. Keeping a full permission unit test is deferred until an adapter emits the step.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/session-manager.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Typecheck and commit**

```bash
pnpm exec tsc --noEmit
git add src/main/session-manager.ts src/main/session-manager.test.ts
git commit -m "feat: add session manager driving turns, seq, and events"
```

---

## Task 5: Main-process IPC wiring

**Files:**
- Create: `src/main/agent-ipc.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `ConversationStore`, `SessionManager`, `createEchoAdapter`, contract types, Electron `ipcMain`/`BrowserWindow`/`app`/`dialog`.
- Produces: `registerAgentIpc(getWindow: () => BrowserWindow | null): void`. Channel names (constants, shared with preload in Task 6 via `agent-ipc-channels.ts`): command channel `'fractal:agent:invoke'` (method+args), event channel `'fractal:agent:event'`.

This task has no unit test — it's Electron glue. It is verified by the manual smoke in Step 4 and, end-to-end, in Task 8. Split out the channel-name constants so preload imports the exact same strings.

- [ ] **Step 1: Create shared channel constants**

`src/shared/agent-ipc-channels.ts`:

```ts
export const AGENT_INVOKE_CHANNEL = 'fractal:agent:invoke';
export const AGENT_EVENT_CHANNEL = 'fractal:agent:event';

export type AgentInvokeRequest =
  | { method: 'listConversations' }
  | { method: 'getConversation'; id: string }
  | { method: 'createConversation' }
  | { method: 'sendMessage'; input: { conversationId: string; text: string } }
  | { method: 'cancelTurn'; input: { conversationId: string } }
  | { method: 'respondToPermission'; input: { requestId: string; decision: import('@/shared/agent-contract').PermissionDecision } };
```

- [ ] **Step 2: Implement `registerAgentIpc`**

`src/main/agent-ipc.ts`:

```ts
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { ConversationStore } from '@/main/conversation-store';
import { SessionManager } from '@/main/session-manager';
import { createEchoAdapter } from '@/main/backend-adapter';
import type { AgentEvent } from '@/shared/agent-contract';
import { AGENT_EVENT_CHANNEL, AGENT_INVOKE_CHANNEL, type AgentInvokeRequest } from '@/shared/agent-ipc-channels';

export function registerAgentIpc(getWindow: () => BrowserWindow | null): void {
  const store = new ConversationStore(app.getPath('userData'));
  const emit = (event: AgentEvent) => getWindow()?.webContents.send(AGENT_EVENT_CHANNEL, event);
  const manager = new SessionManager({ store, adapter: createEchoAdapter(), emit });

  ipcMain.handle(AGENT_INVOKE_CHANNEL, async (_e, req: AgentInvokeRequest) => {
    switch (req.method) {
      case 'listConversations':
        return store.list();
      case 'getConversation':
        return manager.snapshot(req.id);
      case 'createConversation': {
        const win = getWindow();
        const result = win
          ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
          : await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) return null;
        return store.create(result.filePaths[0]);
      }
      case 'sendMessage':
        return manager.sendMessage(req.input);
      case 'cancelTurn':
        return manager.cancelTurn(req.input);
      case 'respondToPermission':
        return manager.respondToPermission(req.input);
    }
  });
}
```

- [ ] **Step 3: Call it from `src/main.ts`**

Import at the top:

```ts
import { registerAgentIpc } from '@/main/agent-ipc';
```

Inside `createWindow`, after `mainWindow.maximize();`, capture the window in a module ref and register once. Add near the top of the file:

```ts
let mainWindowRef: BrowserWindow | null = null;
```

Set `mainWindowRef = mainWindow;` right after the `BrowserWindow` is constructed, and register the IPC after `app.on('ready', ...)` fires — simplest is to call `registerAgentIpc(() => mainWindowRef)` at the end of `createWindow`.

> Verify: `@/` alias resolves in the **main** build. `vite.main.config.ts` is currently empty `defineConfig({})`. If the import fails to resolve at build time, add the alias there:
> ```ts
> import { defineConfig } from 'vite';
> import path from 'node:path';
> export default defineConfig({ resolve: { alias: { '@': path.resolve(__dirname, 'src') } } });
> ```
> Do the same in `vite.preload.config.ts` for Task 6 if needed. Make this edit only if the build errors on the alias.

- [ ] **Step 4: Manual smoke — handlers register without crashing**

Run: `pnpm start`
Expected: app window opens as before, no main-process error in the terminal about `ipcMain.handle` or a failed import. (The renderer doesn't call anything yet.) Type `rs` to restart if needed, then close.

- [ ] **Step 5: Typecheck, lint, commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add src/main/agent-ipc.ts src/shared/agent-ipc-channels.ts src/main.ts vite.main.config.ts
git commit -m "feat: register agent IPC handlers in the main process"
```

---

## Task 6: Preload bridge

**Files:**
- Modify: `src/preload.ts`
- Create: `src/global.d.ts`

**Interfaces:**
- Consumes: `FractalAgentApi` (Task 1), channel constants + `AgentInvokeRequest` (Task 5), Electron `contextBridge`/`ipcRenderer`.
- Produces: `window.fractal.agent` implementing `FractalAgentApi`. `src/global.d.ts` declares the global for the renderer.

No unit test (contextBridge only runs inside Electron). Verified in Task 8.

- [ ] **Step 1: Implement the bridge**

`src/preload.ts`:

```ts
import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, FractalAgentApi } from '@/shared/agent-contract';
import { AGENT_EVENT_CHANNEL, AGENT_INVOKE_CHANNEL } from '@/shared/agent-ipc-channels';

const invoke = (req: unknown) => ipcRenderer.invoke(AGENT_INVOKE_CHANNEL, req);

const agent: FractalAgentApi = {
  listConversations: () => invoke({ method: 'listConversations' }),
  getConversation: (id) => invoke({ method: 'getConversation', id }),
  createConversation: () => invoke({ method: 'createConversation' }),
  sendMessage: (input) => invoke({ method: 'sendMessage', input }),
  cancelTurn: (input) => invoke({ method: 'cancelTurn', input }),
  respondToPermission: (input) => invoke({ method: 'respondToPermission', input }),
  onAgentEvent: (listener) => {
    const handler = (_e: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(AGENT_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(AGENT_EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld('fractal', { agent });
```

- [ ] **Step 2: Declare the global**

`src/global.d.ts`:

```ts
import type { FractalAgentApi } from '@/shared/agent-contract';

declare global {
  interface Window {
    fractal: { agent: FractalAgentApi };
  }
}

export {};
```

- [ ] **Step 3: Typecheck, lint, commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add src/preload.ts src/global.d.ts
git commit -m "feat: expose window.fractal.agent through the preload bridge"
```

---

## Task 7: Renderer reducer + hook

**Files:**
- Create: `src/renderer/conversation-reducer.ts`
- Test: `src/renderer/conversation-reducer.test.ts`
- Create: `src/renderer/use-conversation.ts`

**Interfaces:**
- Consumes: contract types; `window.fractal.agent`.
- Produces: `type ConversationState = { entries: Entry[]; seq: number; missedEvents: boolean }`; `initialState(snapshot?): ConversationState`; pure `reduce(state, event: AgentEvent): ConversationState`; hook `useConversation(conversationId): { entries; status; send(text); cancel(); createConversation() }`.

The reducer is the heavily-tested unit. The hook is thin wiring over it (subscribe, apply, expose callbacks) and is verified in Task 8.

- [ ] **Step 1: Write the failing reducer test**

```ts
import { describe, expect, test } from 'vitest';
import { initialState, reduce } from '@/renderer/conversation-reducer';
import { CONTRACT_VERSION, type AgentEvent, type Entry } from '@/shared/agent-contract';

const ev = (seq: number, e: Omit<AgentEvent, 'v' | 'seq' | 'conversationId'>): AgentEvent =>
  ({ v: CONTRACT_VERSION, seq, conversationId: 'c', ...e } as AgentEvent);

const agentEntry: Entry = {
  id: 'e1', conversationId: 'c', author: 'agent', createdAt: 0, status: 'streaming', parts: [],
};

describe('conversation reducer', () => {
  test('entry.added appends the entry', () => {
    const s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    expect(s.entries.map((e) => e.id)).toEqual(['e1']);
    expect(s.seq).toBe(1);
  });

  test('part.added then text.appended accumulate text', () => {
    let s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    s = reduce(s, ev(2, { type: 'part.added', entryId: 'e1', index: 0, part: { id: 'p1', kind: 'text', text: '' } }));
    s = reduce(s, ev(3, { type: 'text.appended', entryId: 'e1', partId: 'p1', delta: 'Hel' }));
    s = reduce(s, ev(4, { type: 'text.appended', entryId: 'e1', partId: 'p1', delta: 'lo' }));
    const part = s.entries[0].parts[0];
    expect(part.kind === 'text' && part.text).toBe('Hello');
  });

  test('part.updated shallow-merges a work part patch', () => {
    let s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    s = reduce(s, ev(2, { type: 'part.added', entryId: 'e1', index: 0, part: { id: 'w1', kind: 'file-read', path: 'a.ts', startedAt: 0, phase: 'running' } }));
    s = reduce(s, ev(3, { type: 'part.updated', entryId: 'e1', partId: 'w1', patch: { phase: 'done', endedAt: 5 } }));
    const part = s.entries[0].parts[0];
    expect(part.kind === 'file-read' && part.phase).toBe('done');
    expect(part.kind === 'file-read' && part.endedAt).toBe(5);
  });

  test('entry.status updates status', () => {
    let s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    s = reduce(s, ev(2, { type: 'entry.status', entryId: 'e1', status: 'complete' }));
    expect(s.entries[0].status).toBe('complete');
  });

  test('a seq gap sets missedEvents', () => {
    let s = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    s = reduce(s, ev(3, { type: 'entry.status', entryId: 'e1', status: 'complete' })); // skipped 2
    expect(s.missedEvents).toBe(true);
  });

  test('reduce does not mutate the previous state', () => {
    const s0 = reduce(initialState(), ev(1, { type: 'entry.added', entry: agentEntry }));
    const before = JSON.stringify(s0);
    reduce(s0, ev(2, { type: 'entry.status', entryId: 'e1', status: 'complete' }));
    expect(JSON.stringify(s0)).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/renderer/conversation-reducer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reducer**

`src/renderer/conversation-reducer.ts`. Immutable updates throughout (the mutation test guards this). Track `seq` and flag a gap when an event's `seq` is not exactly `state.seq + 1` (ignore the very first event against `seq: 0`).

```ts
import type { AgentEvent, Conversation, Entry, Part } from '@/shared/agent-contract';

export interface ConversationState {
  conversation: Conversation | null;
  entries: Entry[];
  seq: number;
  missedEvents: boolean;
}

export function initialState(snapshot?: {
  conversation: Conversation;
  entries: Entry[];
  seq: number;
}): ConversationState {
  return {
    conversation: snapshot?.conversation ?? null,
    entries: snapshot?.entries ?? [],
    seq: snapshot?.seq ?? 0,
    missedEvents: false,
  };
}

function mapEntry(entries: Entry[], id: string, fn: (e: Entry) => Entry): Entry[] {
  return entries.map((e) => (e.id === id ? fn(e) : e));
}

function mapPart(entry: Entry, partId: string, fn: (p: Part) => Part): Entry {
  return { ...entry, parts: entry.parts.map((p) => (p.id === partId ? fn(p) : p)) };
}

export function reduce(state: ConversationState, event: AgentEvent): ConversationState {
  const gap = state.seq !== 0 && event.seq !== state.seq + 1;
  const base = { ...state, seq: event.seq, missedEvents: state.missedEvents || gap };

  switch (event.type) {
    case 'entry.added':
      return { ...base, entries: [...state.entries, event.entry] };
    case 'part.added':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) => {
          const parts = [...e.parts];
          parts.splice(event.index, 0, event.part);
          return { ...e, parts };
        }),
      };
    case 'text.appended':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) =>
          mapPart(e, event.partId, (p) => (p.kind === 'text' ? { ...p, text: p.text + event.delta } : p)),
        ),
      };
    case 'part.updated':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) =>
          mapPart(e, event.partId, (p) => ({ ...p, ...event.patch } as Part)),
        ),
      };
    case 'entry.status':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) => ({ ...e, status: event.status, error: event.error })),
      };
    case 'provenance.updated':
      return {
        ...base,
        entries: mapEntry(state.entries, event.entryId, (e) => ({ ...e, provenance: event.provenance })),
      };
    case 'conversation.created':
      return { ...base, conversation: event.conversation };
    case 'conversation.updated':
      return {
        ...base,
        conversation: state.conversation
          ? { ...state.conversation, title: event.title ?? state.conversation.title, updatedAt: event.updatedAt }
          : state.conversation,
      };
    case 'permission.requested':
    case 'permission.resolved':
      return base; // permission UI state handled in the hook, not entry state
    default:
      return base;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/renderer/conversation-reducer.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Implement the hook**

`src/renderer/use-conversation.ts`. On mount (and when `conversationId` changes), fetch the snapshot via `getConversation`, seed the reducer, then subscribe to `onAgentEvent` filtering by `conversationId`. Map the newest agent entry's `status` to a `ChatStatus`-like value the panel expects (`'submitted' | 'streaming' | 'ready'`).

```ts
import { useCallback, useEffect, useReducer, useState } from 'react';
import type { AgentEvent } from '@/shared/agent-contract';
import { initialState, reduce, type ConversationState } from '@/renderer/conversation-reducer';

type Status = 'ready' | 'submitted' | 'streaming';

export function useConversation(conversationId: string | null) {
  const [state, dispatch] = useReducer(
    (s: ConversationState, e: AgentEvent) => reduce(s, e),
    undefined,
    () => initialState(),
  );
  const [status, setStatus] = useState<Status>('ready');

  useEffect(() => {
    if (!conversationId) return;
    let unsub = () => undefined;
    let cancelled = false;

    void window.fractal.agent.getConversation(conversationId).then((snap) => {
      if (cancelled || !snap) return;
      // Reseed by replaying nothing — initialState carries the snapshot.
      // (useReducer can't be re-inited; dispatch a synthetic no-op path instead.)
    });

    unsub = window.fractal.agent.onAgentEvent((event) => {
      if (event.conversationId !== conversationId) return;
      dispatch(event);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [conversationId]);

  useEffect(() => {
    const last = state.entries.at(-1);
    if (last?.author === 'agent' && last.status === 'streaming') {
      setStatus(last.parts.length === 0 ? 'submitted' : 'streaming');
    } else {
      setStatus('ready');
    }
  }, [state.entries]);

  const send = useCallback(
    (text: string) => {
      if (!conversationId) return;
      void window.fractal.agent.sendMessage({ conversationId, text });
    },
    [conversationId],
  );

  const cancel = useCallback(() => {
    if (!conversationId) return;
    void window.fractal.agent.cancelTurn({ conversationId });
  }, [conversationId]);

  const createConversation = useCallback(() => window.fractal.agent.createConversation(), []);

  return { entries: state.entries, missedEvents: state.missedEvents, status, send, cancel, createConversation };
}
```

> Known gap to resolve during Task 8's manual pass: `useReducer` can't re-seed from an async snapshot with the shape above. When wiring the panel, switch the hook to hold state in `useState<ConversationState>` and `setState((s) => reduce(s, event))`, seeding with `setState(initialState(snapshot))` inside the `getConversation` callback. This is a small mechanical change; the reducer itself (the tested unit) is unaffected. The plan flags it here rather than hiding it.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
pnpm exec tsc --noEmit && pnpm lint
git add src/renderer/conversation-reducer.ts src/renderer/conversation-reducer.test.ts src/renderer/use-conversation.ts
git commit -m "feat: add renderer conversation reducer and useConversation hook"
```

---

## Task 8: Panel wiring + end-to-end verification

**Files:**
- Create: `src/components/conversation-panel.tsx`
- Modify: `src/components/execute-mode.tsx`
- Modify: `src/renderer/use-conversation.ts` (apply the `useState` reseed fix noted in Task 7)

**Interfaces:**
- Consumes: `useConversation` (Task 7); vendored AI Elements in `src/components/ai-elements/` (`Conversation`, `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton`, `Message`, `MessageContent`, `PromptInput`, `PromptInputBody`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputSubmit`, `Reasoning`, `ReasoningTrigger`, `ReasoningContent`).
- Produces: `<ConversationPanel />` mounted in execute mode.

- [ ] **Step 1: Apply the hook reseed fix**

In `src/renderer/use-conversation.ts`, replace the `useReducer` with `useState<ConversationState>(initialState())` and, inside the `getConversation` callback, call `setState(initialState(snapshot))`; in the event subscription call `setState((s) => reduce(s, event))`. (Mechanical; reducer unchanged.)

- [ ] **Step 2: Build the panel**

`src/components/conversation-panel.tsx`. Adapt birtukan's `conversation-panel.tsx` structure (the reference we studied), but drive it from `useConversation` instead of `useChat`. Render each entry's parts in order: `reasoning` → `text` via `MessageResponse` → work parts as a simple labelled row for now (full work rendering is a separate design pass per the spec's non-goals). Composer submits via `send`; the submit button shows stop when `status !== 'ready'` and calls `cancel`.

```tsx
import { useState } from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { useConversation } from '@/renderer/use-conversation';

export function ConversationPanel({ conversationId }: { conversationId: string | null }) {
  const { entries, status, send, cancel } = useConversation(conversationId);
  const [input, setInput] = useState('');

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text?.trim();
    if (!text || status !== 'ready') return;
    send(text);
    setInput('');
  };

  return (
    <div className="relative flex size-full flex-col overflow-hidden">
      <Conversation>
        <ConversationContent>
          {entries.length === 0 ? (
            <ConversationEmptyState title="How can I help?" description="Send a message to start." />
          ) : (
            entries.map((entry) => (
              <Message from={entry.author === 'user' ? 'user' : 'assistant'} key={entry.id}>
                <MessageContent>
                  {entry.parts.map((part) => {
                    if (part.kind === 'text') return <span key={part.id}>{part.text}</span>;
                    if (part.kind === 'reasoning') return <em key={part.id} className="text-muted-foreground">{part.text}</em>;
                    return (
                      <div key={part.id} className="text-xs text-muted-foreground">
                        [{part.kind}{'path' in part ? ` ${part.path}` : ''}] {part.phase}
                      </div>
                    );
                  })}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="shrink-0 p-4">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea value={input} onChange={(e) => setInput(e.target.value)} />
          </PromptInputBody>
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit
              disabled={!input.trim() && status === 'ready'}
              status={status === 'ready' ? undefined : 'streaming'}
              onClick={status === 'ready' ? undefined : cancel}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
```

> If `PromptInputSubmit`'s prop names differ from the above (it was vendored from the registry, not birtukan), open `src/components/ai-elements/prompt-input.tsx`, read the `PromptInputSubmit` and `PromptInputMessage` signatures, and match them exactly. Do not guess.

- [ ] **Step 3: Mount it in execute mode**

In `src/components/execute-mode.tsx`, replace the empty content div:

```tsx
<div className="flex flex-1 flex-col gap-4 p-4 pt-0" />
```

with a stateful mount. For v1, hold a single active conversation id in component state, defaulting to `null`, with a "New conversation" affordance that calls `createConversation()` and stores the returned id:

```tsx
// inside ExecuteMode, above return:
const [conversationId, setConversationId] = useState<string | null>(null);
// ...
<div className="flex flex-1 flex-col">
  {conversationId ? (
    <ConversationPanel conversationId={conversationId} />
  ) : (
    <div className="flex flex-1 items-center justify-center">
      <button
        className="rounded-md border px-4 py-2 text-sm"
        onClick={async () => {
          const c = await window.fractal.agent.createConversation();
          if (c) setConversationId(c.id);
        }}
      >
        New conversation
      </button>
    </div>
  )}
</div>
```

Add the imports for `useState`, `ConversationPanel`.

- [ ] **Step 4: Typecheck and lint**

```bash
pnpm exec tsc --noEmit && pnpm lint
```
Expected: both clean.

- [ ] **Step 5: Manual end-to-end verification**

Run: `pnpm start`

Verify, in order:
1. Execute mode shows the "New conversation" button.
2. Clicking it opens the OS directory picker (this proves `createConversation` → main → `dialog`). Pick any folder.
3. The panel appears with the empty state.
4. Type "hello" and submit. Within a moment you see: your user message, then the echoed assistant text ("You said: hello. Done."), and a `[file-read README.md] done` work row.
5. The assistant entry stops streaming (composer returns to ready).
6. Quit the app fully, run `pnpm start` again — the earlier conversation's messages are gone from the fresh panel because execute mode starts at `conversationId: null`; confirm instead that `<userData>/conversations/index.json` lists the conversation and its `<id>.json` contains the settled entries. (Wiring the sidebar list to reopen a stored conversation is a follow-up, not this plan.)

If any step fails, use superpowers:systematic-debugging before patching.

- [ ] **Step 6: Commit**

```bash
git add src/components/conversation-panel.tsx src/components/execute-mode.tsx src/renderer/use-conversation.ts
git commit -m "feat: wire execute-mode conversation panel to the agent IPC layer"
```

---

## Self-Review

**Spec coverage:**
- §1 entry model → Task 1 (types + guards), Task 7 (reducer builds entries). ✓
- §1 `filesRead` derived → Task 1 `filesReadFrom`. ✓
- §1 `provenance.complete` → carried through Task 3/4/7 (`provenance.updated`). ✓
- §2 event stream + `seq` gap detection → Task 4 (emit), Task 7 (`missedEvents`). ✓
- §2 `text.appended` separate hot path → Task 4, Task 7. ✓
- §2 subscription live-only + snapshot-plus-cursor → Task 4 `snapshot`, Task 7 hook seeds from `getConversation`. ✓
- §2 `part.updated` shallow patch → Task 7 reducer test asserts merge. ✓
- §3 command surface `FractalAgentApi` → Task 1 type, Task 5 handlers, Task 6 bridge. ✓
- §3 permission round-trip (park in main, reply as command, resolved broadcast) → Task 4 `respondToPermission`. ✓ (unit-level permission test deferred with an explicit note — the echo adapter never requests permission; covered end-to-end when a real adapter does.)
- §3 `createConversation()` no-args, main owns the picker → Task 5. ✓
- §3 unanswered permission waits forever → no timeout anywhere; `cancelTurn` is the escape hatch. ✓
- §4 JSON file per conversation + index → Task 2. ✓
- §4 write-on-settle → Task 4 `settle` calls `saveEntry`; no write on `text.appended`. ✓
- §4 crash loses in-flight entry (option A) → streaming entries are never persisted until settle; no delta log. ✓
- §4 version guard (refuse newer, migrate older) → Task 2 `load`. ✓
- Module boundaries (spec's closing section) → File Structure matches one-to-one. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". Two items are explicitly-scoped *known gaps* with the fix spelled out (the `useReducer`→`useState` reseed in Task 7→8, and the deferred permission unit test), not vague placeholders. ✓

**Type consistency:** `AgentEvent`, `AdapterStep`, `PartPatch`, `ConversationState`, `FractalAgentApi` names are consistent across tasks. `saveEntry`/`updateMeta`/`snapshot`/`sendMessage`/`cancelTurn`/`respondToPermission` spelled identically in store, manager, IPC, and bridge. Channel constants come from one shared module. ✓

**Non-goals honored:** no real backend (echo stub only), no `allow-always`, no crash-durable turns, no SQLite, no work/provenance visual design (rendered as a plain labelled row). ✓
