# Native Conversation History and Continuation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Fractal discover, render, watch, create, and safely continue native Codex and Claude Code conversations while keeping each harness as the authoritative transcript owner.

**Architecture:** Electron main owns provider discovery, native filesystem/process access, JSON-RPC/JSONL parsing, runtime ownership, and approval routing behind thin Codex and Claude adapters. A normalized, provider-provenance-preserving event ledger projects into incrementally streamed turns for a project-first React sidebar and a virtualized agentic transcript; no Fractal transcript database is introduced.

**Tech Stack:** Electron 43, Forge 7, Vite 5, React 19, TypeScript 5.9, Tailwind v4, shadcn/ui, Vitest 2, `@tanstack/react-virtual`, Codex App Server stable JSON-RPC bindings, the user-installed unmodified Claude Code CLI, and the official TypeScript MCP server packages for Claude permission prompts.

**Spec:** [docs/superpowers/specs/2026-09-12-native-conversation-history-and-continuation-design.md](../specs/2026-09-12-native-conversation-history-and-continuation-design.md)

## Global Constraints

- Codex and Claude Code native histories are authoritative. Do not write a parallel Fractal transcript or index database.
- A conversation identity is `{ provider, nativeSessionId, projectPath }`; canonicalize project paths in Electron main before grouping or comparison.
- `contextIsolation` stays on and `nodeIntegration` stays off. Renderer access is limited to explicit `contextBridge` methods; never expose `ipcRenderer`.
- Native filesystem access, file watching, subprocesses, App Server requests, MCP permission routing, and credential-adjacent checks stay in Electron main.
- Use the Codex App Server stable API only. Generate and check in its TypeScript bindings so packaged builds do not need the generator.
- Invoke the user's unmodified `claude` executable directly with an argument array and explicit `cwd`; never interpolate prompts, IDs, or paths into a shell command.
- Fractal never reads, copies, intermediates, or logs provider credentials, prompts, source text, command output, or raw provider events by default.
- A session is writable only when the adapter proves it is idle or Fractal owns the active run. `active-externally` and `unknown` are read-only.
- Approvals fail closed. Never use `--dangerously-skip-permissions`, never convert allow-once into a remembered rule, and deny or interrupt if request routing fails.
- Unknown or malformed native events remain visible as provenance-bearing unsupported activity and cannot prevent later valid activity from loading.
- Preserve provider-native ordering and IDs. Deduplicate process, App Server, and file-watch observations by native identity before projection.
- Do not create a branch unless the user explicitly requests one. Commits are also skipped by default; each commit step below runs only after explicit user authorization.
- Do not use a browser merely to confirm planned UI edits. Verify with focused tests, `pnpm lint`, and `pnpm exec tsc --noEmit`.
- Before changing Vite or Forge configuration, reread `docs/environment-notes.md`; keep `vite.renderer.config.mts` and `@vitejs/plugin-react` 4.x.

---

## File Structure

### Shared contract

- `src/shared/conversation-contract.ts` — provider IDs, native references, summaries, capabilities, runtime states, projected turns/actions, blocking requests, stream events, command inputs, API surface, and runtime guards.
- `src/shared/conversation-ipc.ts` — channel constants and strict runtime parsing for every renderer-to-main input.
- `src/shared/agent-contract.ts` — removed after all consumers migrate; it must not remain as a second conversation model.
- `src/shared/agent-ipc-channels.ts` — removed with the old contract.

### Provider-neutral main-process core

- `src/main/harness/types.ts` — `HarnessAdapter`, `NativeEvent`, `NativeEventSink`, `ConversationRun`, and injected process/filesystem seams.
- `src/main/harness/ndjson-decoder.ts` — incremental newline-delimited JSON decoder that tolerates chunk boundaries and quarantines malformed records.
- `src/main/harness/project-path.ts` — canonical project-path identity and project-first grouping helpers.
- `src/main/harness/turn-projector.ts` — incremental ordered normalized-ledger-to-turn projection, action/result pairing, partial merge, work-packet grouping, subagent nesting, and completeness propagation.
- `src/main/harness/reconciler.ts` — provider-native identity deduplication across historical, watch, and live streams.
- `src/main/conversation-registry.ts` — probes adapters, merges project/session summaries, validates native references, and resolves adapters.
- `src/main/conversation-service.ts` — open-load lifecycles, chunk emission, watcher ownership, run ownership, event sequencing, pending requests, reconnection, and disposal.

### Claude adapter

- `src/main/harness/claude/claude-history.ts` — native `~/.claude/projects` discovery, streaming JSONL reads, tail watching, summary extraction, and truncated-line retry.
- `src/main/harness/claude/claude-normalizer.ts` — Claude JSONL and stream-json records to provider-neutral native events.
- `src/main/harness/claude/claude-probe.ts` — executable/version/auth availability plus `claude agents --json` and permission/question capability checks.
- `src/main/harness/claude/claude-runner.ts` — one directly spawned CLI process per turn, stdout/stderr parsing, cancellation, and native transcript reconciliation.
- `src/main/harness/claude/claude-permission-bridge.ts` — ephemeral loopback MCP server, per-run secret, approval/question forwarding, timeout/renderer-loss denial, and cleanup.
- `src/main/harness/claude/claude-adapter.ts` — composes history, probe, runner, normalizer, and bridge behind `HarnessAdapter`.
- `src/main/harness/claude/__fixtures__/*.jsonl` — sanitized history, partial, malformed, unknown, tool, subagent, approval, question, interruption, and failure fixtures.

### Codex adapter

- `src/main/harness/codex/generated/**` — checked-in stable App Server TypeScript bindings generated by the installed Codex CLI.
- `src/main/harness/codex/json-rpc-peer.ts` — framed stdio JSON-RPC request/response/notification/server-request transport.
- `src/main/harness/codex/codex-app-server.ts` — persistent process lifecycle, initialization, typed stable requests, reconnect, and disposal.
- `src/main/harness/codex/codex-normalizer.ts` — App Server threads, turns, items, deltas, statuses, and requests to provider-neutral native events.
- `src/main/harness/codex/codex-adapter.ts` — read/watch/create/resume/interrupt/approval behavior behind `HarnessAdapter`.
- `src/main/harness/codex/__fixtures__/*.json` — sanitized JSON-RPC thread/read, notifications, approvals, failures, and unknown-event fixtures.

### IPC and renderer state

- `src/main/agent-ipc.ts` — rewritten as the sole Electron IPC registration boundary for `ConversationService`.
- `src/preload.ts` — explicit `window.fractal.conversations` methods and one validated event subscription.
- `src/global.d.ts` — browser declaration matching `ConversationApi` exactly.
- `src/renderer/conversation-reducer.ts` — generation/sequence-aware incremental history and live-event reducer.
- `src/renderer/use-conversation.ts` — one selected conversation's load, watch, continue, interrupt, and request-resolution hook.
- `src/renderer/use-conversation-history.ts` — provider status and project-first summary loading/refresh hook.
- `src/renderer/timeline-scroll.ts` — pure near-bottom and scroll-anchor decisions used by the virtualized timeline.

### Execute UI

- `src/components/conversation/conversation-header.tsx` — project, native title, provider, runtime, capture completeness, and capability-gated controls.
- `src/components/conversation/conversation-turn.tsx` — user anchor plus ordered turn blocks.
- `src/components/conversation/work-packet.tsx` — active-expanded/completed-collapsed packet behavior and summary.
- `src/components/conversation/agent-action.tsx` — action lifecycle, file/command/tool/search/subagent detail, and safe unsupported activity.
- `src/components/conversation/blocking-request.tsx` — approval and question UI with exact decision semantics.
- `src/components/conversation/virtual-timeline.tsx` — variable-height virtualized turns and stable scroll anchoring.
- `src/components/conversation/new-conversation-menu.tsx` — explicit Codex/Claude selection followed by the main-owned directory picker.
- `src/components/conversation-panel.tsx` — slim composition root for header, timeline, blocking requests, and composer.
- `src/components/execute-mode.tsx` — selected native `ConversationRef` state and empty/error/read-only states.
- `src/components/sidebar-03/app-sidebar.tsx` — real project groups, loading/provider states, and new-conversation entry point.
- `src/components/sidebar-03/nav-main.tsx` — native conversation row identity, provider mark, runtime state, selection, and filtering.

### Retired first-generation Execute files

- `src/main/conversation-store.ts` and `src/main/conversation-store.test.ts` — delete after native history is wired.
- `src/main/backend-adapter.ts` and `src/main/backend-adapter.test.ts` — delete after both native adapters satisfy `HarnessAdapter`.
- `src/main/session-manager.ts` and `src/main/session-manager.test.ts` — delete after `ConversationService` owns runtime state.

---

### Task 1: Native conversation contract and validated command inputs

**Files:**
- Create: `src/shared/conversation-contract.ts`
- Create: `src/shared/conversation-ipc.ts`
- Test: `src/shared/conversation-contract.test.ts`
- Test: `src/shared/conversation-ipc.test.ts`

**Interfaces:**
- Consumes: no new interfaces.
- Produces: `ConversationRef`, `ConversationSummary`, `ProjectConversationGroup`, `HarnessCapabilities`, `HarnessStatus`, `ConversationRuntime`, `CaptureCompleteness`, `ConversationTurn`, `TurnBlock`, `AgentAction`, `BlockingRequest`, `ConversationStreamEvent`, `ConversationApi`, `conversationKey(ref)`, `parseConversationRef(value)`, `parseLoadId(value)`, `parsePromptInput(value)`, `parseUserDecision(value)`, and `parseConversationStreamEvent(value)`.

- [ ] **Step 1: Write failing contract and hostile-input tests**

```ts
import { describe, expect, test } from 'vitest';
import { conversationKey } from '@/shared/conversation-contract';
import {
  parseConversationRef,
  parsePromptInput,
  parseUserDecision,
} from '@/shared/conversation-ipc';

describe('native conversation IPC contract', () => {
  test('derives a provider-qualified stable key', () => {
    expect(conversationKey({
      provider: 'claude',
      nativeSessionId: 'session-1',
      projectPath: '/work/fractal',
    })).toBe('claude:session-1');
  });

  test('rejects unknown providers and empty identity fields', () => {
    expect(() => parseConversationRef({
      provider: 'other',
      nativeSessionId: '',
      projectPath: '/work/fractal',
    })).toThrow('Invalid conversation reference');
  });

  test('rejects blank and oversized prompts', () => {
    expect(() => parsePromptInput({ text: '   ' })).toThrow('Prompt cannot be empty');
    expect(() => parsePromptInput({ text: 'x'.repeat(1_000_001) })).toThrow('Prompt is too large');
  });

  test('accepts only explicit request decisions', () => {
    expect(parseUserDecision({ kind: 'deny', reason: 'Not this command' })).toEqual({
      kind: 'deny',
      reason: 'Not this command',
    });
    expect(() => parseUserDecision({ kind: 'allow-forever' })).toThrow('Invalid decision');
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `pnpm test src/shared/conversation-contract.test.ts src/shared/conversation-ipc.test.ts`

Expected: FAIL because the new modules do not exist.

- [ ] **Step 3: Implement the complete shared model**

Use these exact roots and discriminants; keep provider-native payloads out of the renderer contract:

```ts
export type ProviderId = 'codex' | 'claude';
export type ConversationRuntime =
  | 'idle'
  | 'active-in-fractal'
  | 'waiting-for-user'
  | 'active-externally'
  | 'unknown'
  | 'failed';
export type CaptureCompleteness = 'complete' | 'partial' | 'unknown';

export interface ConversationRef {
  provider: ProviderId;
  nativeSessionId: string;
  projectPath: string;
}

export interface HarnessCapabilities {
  create: boolean;
  partialStreaming: boolean;
  approvals: boolean;
  questions: boolean;
  interrupt: boolean;
  steerWhileRunning: boolean;
  fork: boolean;
}

export interface HarnessStatus {
  provider: ProviderId;
  availability: 'available' | 'unavailable' | 'unsupported' | 'unauthenticated';
  version?: string;
  message?: string;
  capabilities: HarnessCapabilities;
}

export interface ConversationSummary {
  ref: ConversationRef;
  title: string;
  updatedAt: number;
  createdAt?: number;
  runtime: ConversationRuntime;
  captureCompleteness: CaptureCompleteness;
}

export interface ProjectConversationGroup {
  projectPath: string;
  displayName: string;
  conversations: ConversationSummary[];
}

export type ActionStatus =
  | 'requested'
  | 'awaiting-approval'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'interrupted';

export interface ActionBase {
  id: string;
  nativeId: string;
  provider: ProviderId;
  status: ActionStatus;
  startedAt?: number;
  completedAt?: number;
  captureCompleteness: CaptureCompleteness;
}

export type AgentAction =
  | (ActionBase & { kind: 'file-read'; path: string })
  | (ActionBase & { kind: 'file-edit'; path: string; patch?: string })
  | (ActionBase & { kind: 'command'; command: string; cwd?: string; output?: string; exitCode?: number })
  | (ActionBase & { kind: 'search'; query: string; scope?: string; resultSummary?: string })
  | (ActionBase & { kind: 'tool'; name: string; inputSummary: string; outputSummary?: string })
  | (ActionBase & { kind: 'subagent'; label: string; parentNativeId?: string; actions: AgentAction[] });

export type UserDecision =
  | { kind: 'allow-once' }
  | { kind: 'allow-and-remember'; scope: string }
  | { kind: 'deny'; reason?: string }
  | { kind: 'answer'; answers: Record<string, string> };

export type BlockingRequest =
  | { id: string; kind: 'approval'; provider: ProviderId; title: string; operation: string; rememberScope?: string; status: 'open' | 'resolved'; decision?: UserDecision }
  | { id: string; kind: 'question'; provider: ProviderId; prompt: string; fieldId: string; choices?: Array<{ value: string; label: string }>; allowFreeText: boolean; status: 'open' | 'resolved'; decision?: UserDecision };

export type TurnBlock =
  | { id: string; kind: 'assistant-prose'; text: string; provider: ProviderId }
  | { id: string; kind: 'work-packet'; status: 'active' | 'completed' | 'failed'; actions: AgentAction[]; startedAt?: number; completedAt?: number }
  | { id: string; kind: 'approval'; request: BlockingRequest }
  | { id: string; kind: 'question'; request: BlockingRequest }
  | { id: string; kind: 'system-notice'; message: string; tone: 'info' | 'warning' | 'error' }
  | { id: string; kind: 'unsupported'; provider: ProviderId; nativeType: string; summary: string; captureCompleteness: CaptureCompleteness };

export interface ConversationTurn {
  id: string;
  nativeId: string;
  userMessage: { id: string; text: string; createdAt?: number };
  blocks: TurnBlock[];
  status: 'active' | 'completed' | 'interrupted' | 'failed';
  captureCompleteness: CaptureCompleteness;
}

export type ConversationStreamEvent = {
  loadId: string;
  seq: number;
  ref: ConversationRef;
} & (
  | { type: 'history.chunk'; chunkIndex: number; turns: ConversationTurn[] }
  | { type: 'history.complete' }
  | { type: 'turn.upserted'; turn: ConversationTurn }
  | { type: 'assistant.delta'; turnId: string; blockId: string; delta: string }
  | { type: 'action.upserted'; turnId: string; packetId: string; action: AgentAction }
  | { type: 'runtime.changed'; runtime: ConversationRuntime }
  | { type: 'request.opened'; request: BlockingRequest }
  | { type: 'request.resolved'; requestId: string; decision: UserDecision }
  | { type: 'summary.updated'; summary: ConversationSummary }
  | { type: 'load.failed'; message: string }
);
```

Define `ConversationApi` with these exact methods:

```ts
export interface ConversationApi {
  list(): Promise<{ projects: ProjectConversationGroup[]; providers: HarnessStatus[] }>;
  open(ref: ConversationRef, loadId: string): Promise<{ summary: ConversationSummary; capabilities: HarnessCapabilities }>;
  close(ref: ConversationRef): Promise<void>;
  create(input: { provider: ProviderId }): Promise<ConversationRef | null>;
  continue(ref: ConversationRef, prompt: { text: string }): Promise<void>;
  interrupt(ref: ConversationRef): Promise<void>;
  resolveRequest(requestId: string, decision: UserDecision): Promise<void>;
  onEvent(listener: (event: ConversationStreamEvent) => void): () => void;
}
```

`parseConversationRef` accepts plain objects only, validates the provider, limits `nativeSessionId` to 512 nonblank characters, requires an absolute nonblank path of at most 32,768 characters, and returns a fresh object. `parseLoadId` accepts only a canonical UUID string generated by `crypto.randomUUID()`. `parsePromptInput` trims only for the emptiness test but preserves the submitted text; limit it to 1,000,000 UTF-16 code units. `parseUserDecision` accepts only the four discriminated variants above, requires a nonblank scope for allow-and-remember, limits free-form values to 100,000 code units, and returns a fresh object. `ConversationService.resolveRequest` later compares that scope byte-for-byte with the pending request's `rememberScope`. `parseConversationStreamEvent` validates the envelope and every discriminated nested block/action/request, rejects unknown event kinds, limits any single text field to 1,000,000 code units, caps one history chunk at 50 turns, and returns a fresh object rather than trusting an IPC cast.

- [ ] **Step 4: Run focused tests, lint, and typecheck**

Run: `pnpm test src/shared/conversation-contract.test.ts src/shared/conversation-ipc.test.ts && pnpm lint && pnpm exec tsc --noEmit`

Expected: all commands exit 0 while the old contract remains intact for existing consumers.

- [ ] **Step 5: Commit only if the user explicitly authorizes commits**

```bash
git add src/shared/conversation-contract.ts src/shared/conversation-contract.test.ts src/shared/conversation-ipc.ts src/shared/conversation-ipc.test.ts
git commit -m "feat: define native conversation contract"
```

---

### Task 2: Incremental NDJSON decoding and provider-event reconciliation

**Files:**
- Create: `src/main/harness/ndjson-decoder.ts`
- Create: `src/main/harness/reconciler.ts`
- Test: `src/main/harness/ndjson-decoder.test.ts`
- Test: `src/main/harness/reconciler.test.ts`

**Interfaces:**
- Consumes: `ProviderId` and `CaptureCompleteness` from Task 1.
- Produces: `NdjsonDecoder.push(chunk)`, `NdjsonDecoder.finish()`, `DecodedLine<T>`, `NativeEvent`, `nativeEventKey(event)`, and `reconcileNativeEvents(existing, incoming)`.

- [ ] **Step 1: Write failing fragmented-stream and deduplication tests**

```ts
import { describe, expect, test } from 'vitest';
import { NdjsonDecoder } from '@/main/harness/ndjson-decoder';
import { reconcileNativeEvents, type NativeEvent } from '@/main/harness/reconciler';

describe('NdjsonDecoder', () => {
  test('decodes split and batched records in order', () => {
    const decoder = new NdjsonDecoder<Record<string, unknown>>();
    expect(decoder.push('{"id":1}\n{"id"')).toEqual([{ ok: true, value: { id: 1 } }]);
    expect(decoder.push(':2}\n')).toEqual([{ ok: true, value: { id: 2 } }]);
  });

  test('quarantines malformed lines and marks an incomplete tail for retry', () => {
    const decoder = new NdjsonDecoder<Record<string, unknown>>();
    expect(decoder.push('{bad}\n')).toEqual([{ ok: false, raw: '{bad}', error: 'Invalid JSON record' }]);
    decoder.push('{"id":3');
    expect(decoder.finish()).toEqual({ kind: 'incomplete', raw: '{"id":3' });
  });
});

describe('reconcileNativeEvents', () => {
  test('deduplicates two observations of one native event without reordering later work', () => {
    const first: NativeEvent = { provider: 'claude', nativeId: 'a', nativeType: 'assistant', observedAt: 1, payload: { kind: 'assistant-text', turnId: 't', text: 'Hi', final: true } };
    const next: NativeEvent = { provider: 'claude', nativeId: 'b', nativeType: 'tool_use', observedAt: 2, payload: { kind: 'action-requested', turnId: 't', actionId: 'tool-1', actionKind: 'file-read', label: 'a.ts' } };
    expect(reconcileNativeEvents([first], [first, next])).toEqual([first, next]);
  });
});
```

- [ ] **Step 2: Run the focused tests and confirm they fail**

Run: `pnpm test src/main/harness/ndjson-decoder.test.ts src/main/harness/reconciler.test.ts`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement the decoder and canonical native-event union**

Use `StringDecoder('utf8')` so split multibyte characters are preserved. Emit one result per nonblank completed line, never log the raw line, retain an unfinished tail across `push`, and let `finish` distinguish empty from incomplete.

```ts
export type DecodedLine<T> =
  | { ok: true; value: T }
  | { ok: false; raw: string; error: 'Invalid JSON record' };

export type NativeEventPayload =
  | { kind: 'turn-started'; turnId: string; userMessageId: string; text: string; createdAt?: number }
  | { kind: 'assistant-text'; turnId: string; blockId?: string; text: string; final: boolean }
  | { kind: 'action-requested'; turnId: string; actionId: string; actionKind: 'file-read' | 'file-edit' | 'command' | 'search' | 'tool' | 'subagent'; label: string; parentActionId?: string; detail?: string }
  | { kind: 'action-updated'; turnId: string; actionId: string; status: ActionStatus; output?: string; exitCode?: number; patch?: string }
  | { kind: 'request-opened'; turnId: string; request: BlockingRequest }
  | { kind: 'request-resolved'; turnId: string; requestId: string; decision: UserDecision }
  | { kind: 'turn-finished'; turnId: string; status: 'completed' | 'interrupted' | 'failed' }
  | { kind: 'system-notice'; turnId: string; message: string; tone: 'info' | 'warning' | 'error' }
  | { kind: 'unsupported'; turnId?: string; summary: string; captureCompleteness: CaptureCompleteness };

export interface NativeEvent {
  provider: ProviderId;
  nativeId: string;
  nativeType: string;
  observedAt: number;
  payload: NativeEventPayload;
}
```

`nativeEventKey` returns `${provider}:${nativeId}`. When a key exists in both arrays, keep the later incoming value in the original slot so a final event can replace a partial observation without shifting chronology; append only new keys in incoming order.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm test src/main/harness/ndjson-decoder.test.ts src/main/harness/reconciler.test.ts && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit only if explicitly authorized**

```bash
git add src/main/harness/ndjson-decoder.ts src/main/harness/ndjson-decoder.test.ts src/main/harness/reconciler.ts src/main/harness/reconciler.test.ts
git commit -m "feat: add provider stream reconciliation"
```

---

### Task 3: Canonical project grouping

**Files:**
- Create: `src/main/harness/project-path.ts`
- Test: `src/main/harness/project-path.test.ts`

**Interfaces:**
- Consumes: `ConversationSummary` and `ProjectConversationGroup` from Task 1.
- Produces: `canonicalizeProjectPath(input, realpath)`, `projectDisplayName(path)`, and `groupConversationsByProject(summaries, realpath)`.

- [ ] **Step 1: Write the failing grouping tests**

```ts
import { describe, expect, test } from 'vitest';
import { groupConversationsByProject } from '@/main/harness/project-path';
import type { ConversationSummary } from '@/shared/conversation-contract';

const summary = (provider: 'codex' | 'claude', id: string, path: string, updatedAt: number): ConversationSummary => ({
  ref: { provider, nativeSessionId: id, projectPath: path },
  title: id,
  updatedAt,
  runtime: 'idle',
  captureCompleteness: 'complete',
});

describe('groupConversationsByProject', () => {
  test('merges providers by real path and sorts projects and sessions by recency', async () => {
    const groups = await groupConversationsByProject([
      summary('claude', 'c1', '/link/fractal', 20),
      summary('codex', 'x1', '/work/fractal', 30),
      summary('codex', 'x2', '/work/other', 10),
    ], async (path) => path === '/link/fractal' ? '/work/fractal' : path);
    expect(groups.map((group) => [group.projectPath, group.conversations.map((item) => item.ref.nativeSessionId)])).toEqual([
      ['/work/fractal', ['x1', 'c1']],
      ['/work/other', ['x2']],
    ]);
  });
});
```

- [ ] **Step 2: Run and confirm the missing-module failure**

Run: `pnpm test src/main/harness/project-path.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement canonicalization and deterministic grouping**

```ts
export type Realpath = (path: string) => Promise<string>;

export async function canonicalizeProjectPath(input: string, realpath: Realpath): Promise<string>;
export function projectDisplayName(projectPath: string): string;
export async function groupConversationsByProject(
  summaries: ConversationSummary[],
  realpath: Realpath,
): Promise<ProjectConversationGroup[]>;
```

Resolve every path through injected `realpath`, normalize separators through `node:path.normalize`, replace the summary reference with the canonical path, use `basename` for display, sort conversations descending by `updatedAt` with `conversationKey` as the tie-breaker, and sort groups by their newest conversation followed by canonical path.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `pnpm test src/main/harness/project-path.test.ts && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit only if explicitly authorized**

```bash
git add src/main/harness/project-path.ts src/main/harness/project-path.test.ts
git commit -m "feat: group native sessions by project"
```

---

### Task 4: Ordered turn projection and work packets

**Files:**
- Create: `src/main/harness/types.ts`
- Create: `src/main/harness/turn-projector.ts`
- Test: `src/main/harness/turn-projector.test.ts`

**Interfaces:**
- Consumes: `NativeEvent` from Task 2 and renderer contract types from Task 1.
- Produces: `NativeEventSink`, `LoadedConversation`, `ConversationRun`, `HarnessAdapter`, `TurnProjector.push(event)`, `TurnProjector.finish()`, and the test convenience `projectTurns(events)`.

- [ ] **Step 1: Write failing projection tests**

```ts
import { describe, expect, test } from 'vitest';
import { projectTurns } from '@/main/harness/turn-projector';
import type { NativeEvent } from '@/main/harness/reconciler';

describe('projectTurns', () => {
  test('keeps prose and consecutive actions in source order', () => {
    const events: NativeEvent[] = [
      { provider: 'codex', nativeId: 'u1', nativeType: 'userMessage', observedAt: 1, payload: { kind: 'turn-started', turnId: 't1', userMessageId: 'u1', text: 'Inspect it' } },
      { provider: 'codex', nativeId: 'm1', nativeType: 'agentMessage', observedAt: 2, payload: { kind: 'assistant-text', turnId: 't1', text: 'I will inspect it.', final: true } },
      { provider: 'codex', nativeId: 'a1', nativeType: 'commandExecution', observedAt: 3, payload: { kind: 'action-requested', turnId: 't1', actionId: 'a1', actionKind: 'command', label: 'pnpm lint' } },
      { provider: 'codex', nativeId: 'a1:done', nativeType: 'commandExecution', observedAt: 4, payload: { kind: 'action-updated', turnId: 't1', actionId: 'a1', status: 'completed', exitCode: 0 } },
      { provider: 'codex', nativeId: 'm2', nativeType: 'agentMessage', observedAt: 5, payload: { kind: 'assistant-text', turnId: 't1', text: 'It passes.', final: true } },
      { provider: 'codex', nativeId: 't1:done', nativeType: 'turnCompleted', observedAt: 6, payload: { kind: 'turn-finished', turnId: 't1', status: 'completed' } },
    ];
    const [turn] = projectTurns(events);
    expect(turn.blocks.map((block) => block.kind)).toEqual(['assistant-prose', 'work-packet', 'assistant-prose']);
    expect(turn.status).toBe('completed');
  });

  test('nests subagent activity and preserves unsupported records', () => {
    const events: NativeEvent[] = [
      { provider: 'claude', nativeId: 'u2', nativeType: 'user', observedAt: 1, payload: { kind: 'turn-started', turnId: 't2', userMessageId: 'u2', text: 'Delegate this' } },
      { provider: 'claude', nativeId: 'parent', nativeType: 'tool_use', observedAt: 2, payload: { kind: 'action-requested', turnId: 't2', actionId: 'parent', actionKind: 'subagent', label: 'Explore agent' } },
      { provider: 'claude', nativeId: 'child', nativeType: 'tool_use', observedAt: 3, payload: { kind: 'action-requested', turnId: 't2', actionId: 'child', actionKind: 'file-read', label: 'src/App.tsx', parentActionId: 'parent' } },
      { provider: 'claude', nativeId: 'child:done', nativeType: 'tool_result', observedAt: 4, payload: { kind: 'action-updated', turnId: 't2', actionId: 'child', status: 'completed' } },
      { provider: 'claude', nativeId: 'future', nativeType: 'future_event', observedAt: 5, payload: { kind: 'unsupported', turnId: 't2', summary: 'Unsupported Claude activity: future_event', captureCompleteness: 'partial' } },
      { provider: 'claude', nativeId: 't2:done', nativeType: 'result', observedAt: 6, payload: { kind: 'turn-finished', turnId: 't2', status: 'completed' } },
    ];
    const [turn] = projectTurns(events);
    const packet = turn.blocks.find((block) => block.kind === 'work-packet');
    const parent = packet?.kind === 'work-packet' ? packet.actions.find((action) => action.nativeId === 'parent') : undefined;
    expect(turn.blocks.some((block) => block.kind === 'unsupported')).toBe(true);
    expect(parent?.kind).toBe('subagent');
    expect(parent?.kind === 'subagent' ? parent.actions[0].nativeId : null).toBe('child');
    expect(turn.captureCompleteness).toBe('partial');
  });
});
```

- [ ] **Step 2: Run the projector test and confirm it fails**

Run: `pnpm test src/main/harness/turn-projector.test.ts`

Expected: FAIL.

- [ ] **Step 3: Define the provider adapter interfaces**

```ts
export type NativeEventSink = (event: NativeEvent) => void;
export type Unsubscribe = () => void;

export interface LoadedConversation {
  summary: ConversationSummary;
  events: AsyncIterable<NativeEvent>;
}

export interface ConversationRun {
  events: AsyncIterable<NativeEvent>;
  interrupt(): Promise<void>;
  resolveRequest(requestId: string, decision: UserDecision): Promise<void>;
  dispose(): Promise<void>;
}

export interface HarnessAdapter {
  readonly provider: ProviderId;
  probe(): Promise<HarnessStatus>;
  capabilities(): HarnessCapabilities;
  listConversations(): Promise<ConversationSummary[]>;
  loadConversation(ref: ConversationRef): Promise<LoadedConversation>;
  watchConversation(ref: ConversationRef, sink: NativeEventSink): Promise<Unsubscribe>;
  createConversation(projectPath: string): Promise<ConversationRef>;
  continueConversation(ref: ConversationRef, prompt: { text: string }): Promise<ConversationRun>;
}
```

- [ ] **Step 4: Implement the deterministic projector**

Apply this complete projection table:

| Native payload | Projection |
|---|---|
| `turn-started` | Create one turn and its user anchor. |
| `assistant-text final:false` | Upsert one prose block by `blockId ?? nativeId`; replace its accumulated text. |
| `assistant-text final:true` | Upsert/finalize the same block; never append a duplicate. |
| `action-requested` | Append to the current adjacent work packet or create one; set `requested`. |
| `action-updated` | Replace the action by `actionId`, copy output/patch/exit code, and derive packet state. |
| `request-opened` | Set action `awaiting-approval` when IDs match, then append approval/question block. |
| `request-resolved` | Retain the historical block with decision and `resolved`. |
| `turn-finished` | Set the turn status and finalize remaining active packets consistently. |
| `system-notice` | Append a notice at that exact ledger position. |
| `unsupported` | Append collapsed unsupported activity; lower turn completeness from `complete` to `partial` or `unknown`. |

Subagent actions with `parentActionId` attach below the matching `subagent` action; if no parent can be found, keep them as top-level actions and mark capture completeness `partial`. A result arriving before its request creates a tool action labeled with its native ID and completeness `partial`, so no record disappears.

Implement projection incrementally rather than requiring a complete transcript in memory:

```ts
export type TurnProjectionUpdate = { turn: ConversationTurn; finalized: boolean };

export class TurnProjector {
  push(event: NativeEvent): TurnProjectionUpdate[];
  finish(): TurnProjectionUpdate[];
}

export function projectTurns(events: NativeEvent[]): ConversationTurn[];
```

`push` yields the prior turn with `finalized: true` when the next `turn-started` arrives, and yields a turn immediately when `turn-finished` arrives. It retains only the current turn plus lookup maps for unresolved action/request IDs. `finish` yields any remaining current turn once but retains its lookup state so an externally active final turn can receive later watch events. The array helper feeds a new projector and is used only by bounded fixture tests.

- [ ] **Step 5: Run tests, lint, and typecheck**

Run: `pnpm test src/main/harness/turn-projector.test.ts && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/main/harness/types.ts src/main/harness/turn-projector.ts src/main/harness/turn-projector.test.ts
git commit -m "feat: project native activity into agentic turns"
```

---

### Task 5: Claude native-history discovery and normalization

**Files:**
- Create: `src/main/harness/claude/claude-history.ts`
- Create: `src/main/harness/claude/claude-normalizer.ts`
- Create: `src/main/harness/claude/__fixtures__/complete-session.jsonl`
- Create: `src/main/harness/claude/__fixtures__/partial-and-unknown.jsonl`
- Test: `src/main/harness/claude/claude-history.test.ts`
- Test: `src/main/harness/claude/claude-normalizer.test.ts`

**Interfaces:**
- Consumes: `NdjsonDecoder`, `NativeEvent`, and conversation summary types.
- Produces: `discoverClaudeConversations(rootDir)`, `readClaudeConversation(filePath)`, `watchClaudeConversation(filePath, sink)`, `normalizeClaudeRecord(record, ordinal)`, and `ClaudeHistoryRecord`.

- [ ] **Step 1: Add sanitized fixtures and failing tests**

The complete fixture contains one user message, assistant prose, `tool_use`, matching `tool_result`, a child sidechain with `parent_tool_use_id`, a resolved question, and final assistant prose. The partial fixture contains one malformed complete line, one unknown `future_event`, and one truncated final line.

```ts
import { describe, expect, test } from 'vitest';
import { discoverClaudeConversations, readClaudeConversation } from '@/main/harness/claude/claude-history';

describe('Claude native history', () => {
  test('discovers summaries without loading full transcripts', async () => {
    const result = await discoverClaudeConversations(fixtureRoot);
    expect(result).toMatchObject([{ ref: { provider: 'claude', nativeSessionId: 'claude-session-1', projectPath: '/work/fractal' }, title: 'Inspect the parser' }]);
  });

  test('continues after malformed lines and retries a truncated tail', async () => {
    const result = readClaudeConversation(partialFixturePath);
    const events: NativeEvent[] = [];
    for await (const event of result.events) events.push(event);
    const completion = await result.completion;
    expect(events.some((event) => event.payload.kind === 'unsupported')).toBe(true);
    expect(completion.incompleteTail).toBe(true);
    expect(completion.captureCompleteness).toBe('partial');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/main/harness/claude/claude-history.test.ts src/main/harness/claude/claude-normalizer.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement Claude discovery without transcript loading**

Walk only `*.jsonl` files below the injected Claude projects root. For each file, use filename/session metadata plus a bounded first/last record scan to produce title, project path, created time, updated time, and capture completeness. Do not retain message content after summary extraction. Sort output descending by updated time.

```ts
export interface ClaudeConversationFile {
  ref: ConversationRef;
  filePath: string;
  summary: ConversationSummary;
}

export async function discoverClaudeConversations(rootDir: string): Promise<ClaudeConversationFile[]>;
export interface ClaudeHistoryRead {
  events: AsyncIterable<NativeEvent>;
  completion: Promise<{ incompleteTail: boolean; captureCompleteness: CaptureCompleteness }>;
}
export function readClaudeConversation(filePath: string): ClaudeHistoryRead;
export async function watchClaudeConversation(filePath: string, sink: NativeEventSink): Promise<Unsubscribe>;
```

Implement `events` as an async generator over `createReadStream` so records reach the service while the file is still being read; resolve `completion` only after EOF. The watcher records byte offset and inode. On append, read only new bytes. On truncate/replace, reread and let the reconciler deduplicate. A truncated last line stays buffered until another change; a malformed completed line becomes one unsupported event and parsing continues.

- [ ] **Step 4: Implement the Claude mapping**

Map explicit content blocks in array order: `text` → assistant text, `thinking` → assistant prose labeled provider-supplied thinking, `tool_use` → action request, `tool_result` → action update, `image` → unsupported partial activity. Map user records to turn starts unless they are tool-result carriers. Use `uuid`, `message.id`, `tool_use.id`, and `parentUuid`/`parent_tool_use_id` to build stable native IDs and nesting. Map `isSidechain` activity to `subagent`; map permission/question records only when their documented fields are present. All unrecognized top-level or content types become `unsupported` with `nativeType`, a one-line field-name summary, and no raw payload.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run: `pnpm test src/main/harness/claude && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS; fixture contents never appear in application logs.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/main/harness/claude
git commit -m "feat: read native Claude conversation history"
```

---

### Task 6: Codex App Server transport and checked-in stable bindings

**Files:**
- Create: `src/main/harness/codex/generated/**`
- Create: `src/main/harness/codex/json-rpc-peer.ts`
- Create: `src/main/harness/codex/codex-app-server.ts`
- Test: `src/main/harness/codex/json-rpc-peer.test.ts`
- Test: `src/main/harness/codex/codex-app-server.test.ts`

**Interfaces:**
- Consumes: `NdjsonDecoder` from Task 2.
- Produces: `JsonRpcPeer`, `CodexAppServer.start()`, typed `request`, notification/server-request subscriptions, `status`, `restart()`, and `dispose()`.

- [ ] **Step 1: Write failing transport tests against a fake duplex process**

```ts
import { describe, expect, test, vi } from 'vitest';
import { JsonRpcPeer } from '@/main/harness/codex/json-rpc-peer';

describe('JsonRpcPeer', () => {
  test('correlates out-of-order responses and forwards notifications', async () => {
    const process = createFakeCodexProcess();
    const peer = new JsonRpcPeer(process);
    const notice = vi.fn();
    peer.onNotification(notice);
    const first = peer.request('thread/read', { threadId: 'one', includeTurns: true });
    const second = peer.request('thread/read', { threadId: 'two', includeTurns: true });
    process.emitStdout('{"id":2,"result":{"thread":{"id":"two"}}}\n{"method":"thread/status/changed","params":{"threadId":"one","status":{"type":"idle"}}}\n{"id":1,"result":{"thread":{"id":"one"}}}\n');
    await expect(first).resolves.toMatchObject({ thread: { id: 'one' } });
    await expect(second).resolves.toMatchObject({ thread: { id: 'two' } });
    expect(notice).toHaveBeenCalledOnce();
  });

  test('surfaces server requests separately and rejects pending calls on exit', async () => {
    const process = createFakeCodexProcess();
    const peer = new JsonRpcPeer(process);
    const requests: unknown[] = [];
    peer.onServerRequest((request) => requests.push(request));
    process.emitStdout('{"id":90,"method":"item/commandExecution/requestApproval","params":{"threadId":"one"}}\n');
    expect(requests).toHaveLength(1);
    const pending = peer.request('thread/list', {});
    process.exit(1);
    await expect(pending).rejects.toThrow('Codex App Server exited');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/main/harness/codex/json-rpc-peer.test.ts src/main/harness/codex/codex-app-server.test.ts`

Expected: FAIL because the transport is missing.

- [ ] **Step 3: Generate the stable bindings**

Run:

```bash
codex app-server generate-ts --out src/main/harness/codex/generated
```

Expected: generated `ClientRequest`, `ClientNotification`, `ServerNotification`, `ServerRequest`, response, and `v2` files marked as generated. Do not hand-edit them and do not generate experimental APIs.

- [ ] **Step 4: Implement direct stdio JSON-RPC and App Server initialization**

Spawn `codex` with `['app-server', '--stdio']`, `shell: false`, piped stdio, and no prompt/source logging. `JsonRpcPeer` writes one compact JSON object plus newline, allocates monotonically increasing numeric IDs, routes results/errors, routes ID-bearing server requests separately from notifications, and rejects all pending promises when the process exits.

```ts
export interface CodexRequestMap {
  initialize: { params: InitializeParams; result: InitializeResponse };
  'thread/list': { params: ThreadListParams; result: ThreadListResponse };
  'thread/read': { params: ThreadReadParams; result: ThreadReadResponse };
  'thread/start': { params: ThreadStartParams; result: ThreadStartResponse };
  'thread/resume': { params: ThreadResumeParams; result: ThreadResumeResponse };
  'turn/start': { params: TurnStartParams; result: TurnStartResponse };
  'turn/interrupt': { params: TurnInterruptParams; result: TurnInterruptResponse };
}

export interface CodexProcess {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null) => void): this;
}

export class CodexAppServer {
  static start(spawnProcess: () => CodexProcess): Promise<CodexAppServer>;
  request<M extends keyof CodexRequestMap>(method: M, params: CodexRequestMap[M]['params']): Promise<CodexRequestMap[M]['result']>;
  onNotification(listener: (notification: ServerNotification) => void): Unsubscribe;
  onServerRequest(listener: (request: ServerRequestEnvelope) => void): Unsubscribe;
  respond(id: number | string, result: unknown): void;
  respondError(id: number | string, code: number, message: string): void;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}
```

After spawning, send `initialize` with client info `{ name: 'fractal', title: 'Fractal', version: app.getVersion() }`, `capabilities: null`, await success, then send `initialized`. Make start/restart idempotent and expose a targeted unavailable status when the executable is missing or initialization fails.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm test src/main/harness/codex/json-rpc-peer.test.ts src/main/harness/codex/codex-app-server.test.ts && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/main/harness/codex/generated src/main/harness/codex/json-rpc-peer.ts src/main/harness/codex/json-rpc-peer.test.ts src/main/harness/codex/codex-app-server.ts src/main/harness/codex/codex-app-server.test.ts
git commit -m "feat: add Codex App Server transport"
```

---

### Task 7: Codex read-only discovery, history, and live normalization

**Files:**
- Create: `src/main/harness/codex/codex-normalizer.ts`
- Create: `src/main/harness/codex/codex-adapter.ts`
- Create: `src/main/harness/codex/__fixtures__/thread-read.json`
- Create: `src/main/harness/codex/__fixtures__/notifications.json`
- Test: `src/main/harness/codex/codex-normalizer.test.ts`
- Test: `src/main/harness/codex/codex-adapter.test.ts`

**Interfaces:**
- Consumes: `CodexAppServer`, official generated types, `HarnessAdapter`, and `NativeEvent`.
- Produces: `normalizeCodexThread(thread)`, `normalizeCodexNotification(notification)`, and a read-capable `CodexAdapter`.

- [ ] **Step 1: Add sanitized App Server fixtures and failing tests**

```ts
import { describe, expect, test } from 'vitest';
import { CodexAdapter } from '@/main/harness/codex/codex-adapter';
import { normalizeCodexThread } from '@/main/harness/codex/codex-normalizer';
import threadRead from '@/main/harness/codex/__fixtures__/thread-read.json';

describe('Codex read adapter', () => {
  test('normalizes prose and tool work in native order', () => {
    const events = normalizeCodexThread(threadRead.thread);
    expect(events.map((event) => event.payload.kind)).toEqual([
      'turn-started',
      'assistant-text',
      'action-requested',
      'action-updated',
      'assistant-text',
      'turn-finished',
    ]);
  });

  test('paginates thread/list and filters archived threads', async () => {
    const server = createFakeAppServer(twoPageThreadListFixture);
    const summaries = await new CodexAdapter(server).listConversations();
    expect(server.requests.map((request) => request.method)).toEqual(['thread/list', 'thread/list']);
    expect(summaries.map((summary) => summary.ref.nativeSessionId)).toEqual(['newer', 'older']);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/main/harness/codex/codex-normalizer.test.ts src/main/harness/codex/codex-adapter.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement stable read requests and mapping**

Use `thread/list` with `{ archived: false, sortKey: 'updated_at', sortDirection: 'desc', limit: 100 }`, following every returned cursor. Use `thread/read` with `{ threadId, includeTurns: true }`. Derive the project from the thread `cwd`, title from native name/title or first meaningful user text, and runtime from native thread status. Reject a requested reference if its provider, thread ID, and canonical project path do not match the discovered thread.

Map these stable item kinds explicitly: user message → turn start; agent message/deltas → assistant text; command execution → command action; file change → file-edit action with provider patch only when supplied; MCP tool call → tool/search/file-read as identifiable; collaboration/subagent item → subagent action; turn status → turn finish; server approval request → request opened. Reasoning summaries are rendered only when present. Every other generated item/notification becomes unsupported activity with the generated discriminant and no raw JSON.

- [ ] **Step 4: Implement live notification routing**

Subscribe once to App Server notifications, filter by exact `threadId`, normalize item/delta/status events, and deduplicate against `thread/read` output through `reconcileNativeEvents`. `watchConversation` unsubscribes its filter without stopping the shared App Server.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run: `pnpm test src/main/harness/codex && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/main/harness/codex
git commit -m "feat: read native Codex conversation history"
```

---

### Task 8: Provider registry and incremental conversation service

**Files:**
- Create: `src/main/conversation-registry.ts`
- Create: `src/main/conversation-service.ts`
- Test: `src/main/conversation-registry.test.ts`
- Test: `src/main/conversation-service.test.ts`

**Interfaces:**
- Consumes: both adapters, project grouping, projection, reconciliation, and shared event types.
- Produces: `ConversationRegistry.list()`, `resolve(ref)`, `validate(ref)`, and `ConversationService` methods matching the non-Electron portion of `ConversationApi`.

- [ ] **Step 1: Write failing registry/load tests**

```ts
import { describe, expect, test, vi } from 'vitest';
import { ConversationRegistry } from '@/main/conversation-registry';
import { ConversationService } from '@/main/conversation-service';

describe('ConversationRegistry', () => {
  test('merges available adapters into project-first groups and keeps provider failures local', async () => {
    const registry = new ConversationRegistry([workingCodexAdapter, unavailableClaudeAdapter], realpath);
    const result = await registry.list();
    expect(result.projects[0].conversations[0].ref.provider).toBe('codex');
    expect(result.providers.find((item) => item.provider === 'claude')?.availability).toBe('unavailable');
  });
});

describe('ConversationService', () => {
  test('buffers watch events while emitting bounded ordered chunks', async () => {
    const emitted = vi.fn();
    const service = new ConversationService(registryWith205Turns, emitted, { historyChunkSize: 50 });
    const loadId = '00000000-0000-4000-8000-000000000001';
    await service.open(nativeRef, loadId);
    const events = emitted.mock.calls.map(([event]) => event).filter((event) => event.loadId === loadId);
    expect(events.filter((event) => event.type === 'history.chunk').map((event) => event.turns.length)).toEqual([50, 50, 50, 50, 5]);
    expect(events.at(-1)?.type).toBe('history.complete');
    expect(watchConversation.mock.invocationCallOrder[0]).toBeLessThan(loadConversation.mock.invocationCallOrder[0]);
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/main/conversation-registry.test.ts src/main/conversation-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement registry validation and provider isolation**

Probe and list adapters concurrently. Preserve an unavailable/unsupported status per provider rather than rejecting the whole list. Canonicalize returned project paths, cache only lightweight summaries and file/thread locators, and require `validate(ref)` to match a currently discovered provider/session/project tuple.

```ts
export class ConversationRegistry {
  constructor(adapters: HarnessAdapter[], realpath: Realpath);
  list(): Promise<{ projects: ProjectConversationGroup[]; providers: HarnessStatus[] }>;
  resolve(ref: ConversationRef): HarnessAdapter;
  validate(ref: ConversationRef): Promise<ConversationSummary>;
  refreshProvider(provider: ProviderId): Promise<void>;
}
```

- [ ] **Step 4: Implement generation-scoped incremental loads**

Each `open` accepts the renderer-generated, validated `loadId`, resets `seq` to zero for that open generation, starts the native watcher into a private buffer, and then consumes the adapter's `AsyncIterable<NativeEvent>` through one `TurnProjector`. Emit a `history.chunk` whenever 50 finalized turns are ready, flush the remainder at EOF, reconcile and drain buffered watch events, emit `history.complete`, and then switch the watcher to direct live delivery. Feed live events through the retained projector and emit `assistant.delta` or `action.upserted` when the native event is an unambiguous delta/action update; otherwise emit `turn.upserted`. Yield to the event loop after each chunk. This ordering prevents an external append from falling between history EOF and watcher setup. A new open of the same ref closes the previous watch. `close` disposes the watcher but does not interrupt an owned run. Every outbound event gets the next contiguous sequence number. A load error emits `load.failed` with a sanitized message.

```ts
export class ConversationService {
  constructor(registry: ConversationRegistry, emit: (event: ConversationStreamEvent) => void, options?: { historyChunkSize?: number });
  list(): Promise<{ projects: ProjectConversationGroup[]; providers: HarnessStatus[] }>;
  open(ref: ConversationRef, loadId: string): Promise<{ summary: ConversationSummary; capabilities: HarnessCapabilities }>;
  close(ref: ConversationRef): Promise<void>;
  create(provider: ProviderId, projectPath: string): Promise<ConversationRef>;
  continue(ref: ConversationRef, prompt: { text: string }): Promise<void>;
  interrupt(ref: ConversationRef): Promise<void>;
  resolveRequest(requestId: string, decision: UserDecision): Promise<void>;
  denyRequestsForOwner(rendererId: string, reason: string): Promise<void>;
  dispose(): Promise<void>;
}
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm test src/main/conversation-registry.test.ts src/main/conversation-service.test.ts && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/main/conversation-registry.ts src/main/conversation-registry.test.ts src/main/conversation-service.ts src/main/conversation-service.test.ts
git commit -m "feat: stream native conversations through a shared service"
```

---

### Task 9: IPC registration and preload migration

**Files:**
- Modify: `src/main/agent-ipc.ts`
- Modify: `src/main.ts`
- Modify: `src/preload.ts`
- Modify: `src/global.d.ts`
- Test: `src/main/agent-ipc.test.ts`
- Test: `src/preload.test.ts`

**Interfaces:**
- Consumes: `ConversationService`, `ConversationApi`, and Task 1 parsers.
- Produces: `registerConversationIpc`, `disposeConversationIpc`, and `window.fractal.conversations`.

- [ ] **Step 1: Write failing IPC validation tests**

```ts
import { describe, expect, test, vi } from 'vitest';
import { registerConversationIpc } from '@/main/agent-ipc';

describe('conversation IPC', () => {
  test('validates commands before service dispatch', async () => {
    const { invoke } = registerWithFakeElectron(registerConversationIpc, service);
    await expect(invoke('fractal:conversations:continue', { provider: 'bad' }, { text: 'hi' })).rejects.toThrow('Invalid conversation reference');
    expect(service.continue).not.toHaveBeenCalled();
  });

  test('does not implicitly allow a pending request after renderer destruction', async () => {
    const registration = registerWithFakeElectron(registerConversationIpc, serviceWithPendingRequest);
    registration.destroySender();
    expect(serviceWithPendingRequest.denyRequestsForOwner).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/main/agent-ipc.test.ts src/preload.test.ts`

Expected: FAIL because the native surface is not registered.

- [ ] **Step 3: Rewrite the IPC boundary**

Register exactly these channels: `list`, `open`, `close`, `create`, `continue`, `interrupt`, `resolve-request`, and `event`. Parse every renderer argument—including the `open` call's UUID `loadId`—before service use. `create` accepts only a provider; main opens the Electron directory picker, returns `null` on cancellation, canonicalizes the selected directory, and passes it to `service.create`. Scope events and pending requests to the creating `webContents`; on its destruction, call `denyRequestsForOwner(rendererId, 'Fractal window closed')` and detach its watches.

- [ ] **Step 4: Expose the hand-written preload surface**

```ts
contextBridge.exposeInMainWorld('fractal', {
  settings: settingsApi,
  conversations: {
    list: () => ipcRenderer.invoke(CHANNELS.list),
    open: (ref, loadId) => ipcRenderer.invoke(CHANNELS.open, ref, loadId),
    close: (ref) => ipcRenderer.invoke(CHANNELS.close, ref),
    create: (input) => ipcRenderer.invoke(CHANNELS.create, input),
    continue: (ref, prompt) => ipcRenderer.invoke(CHANNELS.continue, ref, prompt),
    interrupt: (ref) => ipcRenderer.invoke(CHANNELS.interrupt, ref),
    resolveRequest: (requestId, decision) => ipcRenderer.invoke(CHANNELS.resolveRequest, requestId, decision),
    onEvent: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(parseConversationStreamEvent(payload));
      ipcRenderer.on(CHANNELS.event, wrapped);
      return () => ipcRenderer.removeListener(CHANNELS.event, wrapped);
    },
  } satisfies ConversationApi,
});
```

Import `parseConversationStreamEvent` from the shared runtime-validation module. Declare the same `ConversationApi` in `src/global.d.ts`; do not duplicate method types. Construct both adapters, registry, and service once after the BrowserWindow exists, and dispose them during app shutdown.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run: `pnpm test src/main/agent-ipc.test.ts src/preload.test.ts && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS while the renderer can still compile before its migration.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/main/agent-ipc.ts src/main/agent-ipc.test.ts src/main.ts src/preload.ts src/preload.test.ts src/global.d.ts
git commit -m "feat: expose native conversation IPC"
```

---

### Task 10: Project-first history state and sidebar

**Files:**
- Create: `src/renderer/use-conversation-history.ts`
- Modify: `src/components/sidebar-03/app-sidebar.tsx`
- Modify: `src/components/sidebar-03/nav-main.tsx`
- Modify: `src/components/execute-mode.tsx`
- Test: `src/renderer/use-conversation-history.test.tsx`
- Test: `src/components/sidebar-03/nav-main.test.tsx`

**Interfaces:**
- Consumes: `window.fractal.conversations.list`, project groups, provider status, and `ConversationRef`.
- Produces: `useConversationHistory()` and `NavSelection` carrying a native `ConversationRef`.

- [ ] **Step 1: Write failing sidebar tests**

Add `// @vitest-environment jsdom` at the top of both tests. The first run is expected to fail on the missing test dependency or missing hook/component interface.

```tsx
test('renders mixed providers beneath one project', () => {
  render(<NavMain groups={[fractalGroup]} selected={null} onSelect={vi.fn()} />);
  expect(screen.getByText('Fix parser')).toBeTruthy();
  expect(screen.getByText('Review IPC')).toBeTruthy();
  expect(screen.getAllByTestId('project-group')).toHaveLength(1);
  expect(screen.getByLabelText('Claude Code conversation')).toBeTruthy();
  expect(screen.getByLabelText('Codex conversation')).toBeTruthy();
});

test('filters by project title, conversation title, provider, and native ID', async () => {
  const user = userEvent.setup();
  render(<NavMain groups={[fractalGroup]} selected={null} onSelect={vi.fn()} />);
  await user.type(screen.getByRole('searchbox'), 'claude-session-1');
  expect(screen.getByText('Fix parser')).toBeTruthy();
  expect(screen.queryByText('Review IPC')).toBeNull();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/renderer/use-conversation-history.test.tsx src/components/sidebar-03/nav-main.test.tsx`

Expected: FAIL because the hook and dynamic sidebar props are missing.

- [ ] **Step 3: Install renderer test dependencies**

Run:

```bash
pnpm add -D @testing-library/react@^16 @testing-library/user-event@^14 jsdom@^26
```

- [ ] **Step 4: Implement history loading and refresh**

`useConversationHistory` calls `list` on mount, exposes `{ projects, providers, loading, error, refresh }`, ignores completion after unmount, and refreshes when a `summary.updated` event arrives. Preserve the last successful groups during a refresh error.

- [ ] **Step 5: Replace static sidebar data with project groups**

Render provider as a restrained accessible row mark, not a provider hierarchy. Render runtime icons/text for external activity, waiting, unknown, and failure. Give the group containing `selectedRef.projectPath` the existing prominent selected-project treatment. Search the lowercase project display name/path, native title, provider name, and native session ID. Sort/group order comes from main; do not resort in React. `ExecuteMode` owns `selectedRef: ConversationRef | null` and compares with `conversationKey`.

- [ ] **Step 6: Run focused tests, lint, and typecheck**

Run: `pnpm test src/renderer/use-conversation-history.test.tsx src/components/sidebar-03/nav-main.test.tsx && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 7: Commit only if explicitly authorized**

```bash
git add package.json pnpm-lock.yaml src/renderer/use-conversation-history.ts src/renderer/use-conversation-history.test.tsx src/components/sidebar-03/app-sidebar.tsx src/components/sidebar-03/nav-main.tsx src/components/sidebar-03/nav-main.test.tsx src/components/execute-mode.tsx
git commit -m "feat: render project-first conversation history"
```

---

### Task 11: Incremental renderer reducer and conversation hook

**Files:**
- Rewrite: `src/renderer/conversation-reducer.ts`
- Rewrite: `src/renderer/conversation-reducer.test.ts`
- Rewrite: `src/renderer/use-conversation.ts`
- Test: `src/renderer/use-conversation.test.tsx`

**Interfaces:**
- Consumes: `ConversationStreamEvent`, `ConversationRef`, and the preload API.
- Produces: `ConversationState`, `conversationReducer`, and `useConversation(ref)`.

- [ ] **Step 1: Write failing generation, sequence, chunk, and delta tests**

```ts
describe('conversationReducer', () => {
  test('accepts ordered chunks for the active load only', () => {
    let state = initialConversationState;
    state = conversationReducer(state, opened('load-2', nativeRef));
    state = conversationReducer(state, historyChunk('load-1', 1, [oldTurn]));
    state = conversationReducer(state, historyChunk('load-2', 1, [firstTurn]));
    expect(state.turns).toEqual([firstTurn]);
  });

  test('marks a sequence gap instead of applying ambiguous live state', () => {
    let state = loadedState({ loadId: 'load-2', lastSeq: 4, turns: [activeTurn] });
    state = conversationReducer(state, runtimeChanged('load-2', 6, 'idle'));
    expect(state.sync).toBe('gap');
    expect(state.runtime).toBe('unknown');
  });

  test('merges assistant deltas and action lifecycle updates by stable IDs', () => {
    const state = reduceEvents(loadedState(), [assistantDelta('Hello'), assistantDelta(' world'), actionUpsert(completedCommand)]);
    expect(findProse(state, 'prose-1').text).toBe('Hello world');
    expect(findAction(state, 'command-1').status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/renderer/conversation-reducer.test.ts src/renderer/use-conversation.test.tsx`

Expected: FAIL against the old entry/part reducer.

- [ ] **Step 3: Implement generation-aware reducer semantics**

```ts
export interface ConversationState {
  ref: ConversationRef | null;
  loadId: string | null;
  lastSeq: number;
  turns: ConversationTurn[];
  summary: ConversationSummary | null;
  capabilities: HarnessCapabilities | null;
  runtime: ConversationRuntime;
  requests: BlockingRequest[];
  history: 'idle' | 'loading' | 'complete' | 'failed';
  sync: 'current' | 'gap';
  error: string | null;
}
```

Ignore events for another ref or load generation. Ignore duplicate/lower sequences. On a gap, stop applying the event, set `sync: 'gap'`, force runtime `unknown`, and have the hook close/reopen that ref once to rebuild from native history. Upsert turns, blocks, actions, and requests by stable ID without changing source order. Append history chunks by `chunkIndex`; duplicate chunks do not duplicate turns.

- [ ] **Step 4: Rewrite `useConversation` around the native API**

Subscribe once on mount. On selection, create `loadId = crypto.randomUUID()`, dispatch the local opened action with that ID, and then call `open(ref, loadId)`, so history events are safe even if they arrive before the invoke promise resolves. Close the previous ref during selection change/unmount. Expose `send`, `interrupt`, and `resolveRequest`; each delegates only and lets provider events drive visible state. Do not optimistically mark actions complete or approvals allowed. Disable `send` unless history is complete, sync is current, and runtime is `idle` or `active-in-fractal` with provider steering capability.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run: `pnpm test src/renderer/conversation-reducer.test.ts src/renderer/use-conversation.test.tsx && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/renderer/conversation-reducer.ts src/renderer/conversation-reducer.test.ts src/renderer/use-conversation.ts src/renderer/use-conversation.test.tsx
git commit -m "feat: stream native turns into renderer state"
```

---

### Task 12: Agentic conversation blocks and blocking-request UI

**Files:**
- Create: `src/components/conversation/conversation-header.tsx`
- Create: `src/components/conversation/conversation-turn.tsx`
- Create: `src/components/conversation/work-packet.tsx`
- Create: `src/components/conversation/agent-action.tsx`
- Create: `src/components/conversation/blocking-request.tsx`
- Test: `src/components/conversation/work-packet.test.tsx`
- Test: `src/components/conversation/blocking-request.test.tsx`

**Interfaces:**
- Consumes: projected turns, actions, runtime/capability state, and `resolveRequest`.
- Produces: focused transcript components used by Task 13.

- [ ] **Step 1: Write failing expansion and decision tests**

```tsx
test('active packets are open while completed packets start compact', () => {
  const { rerender } = render(<WorkPacket packet={activePacket} />);
  expect(screen.getByText('pnpm lint')).toBeTruthy();
  rerender(<WorkPacket packet={completedPacket} />);
  expect(screen.getByText('1 command completed')).toBeTruthy();
  expect(screen.queryByText('pnpm lint')).toBeNull();
});

test('approval decisions stay explicit and one-shot', async () => {
  const resolve = vi.fn();
  render(<BlockingRequest request={approvalRequest} onResolve={resolve} />);
  await userEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  expect(resolve).toHaveBeenCalledWith('request-1', { kind: 'allow-once' });
  expect(screen.queryByRole('button', { name: /always/i })).toBeNull();
});

test('questions return the provider-supplied choice by field ID', async () => {
  const resolve = vi.fn();
  render(<BlockingRequest request={questionRequest} onResolve={resolve} />);
  await userEvent.click(screen.getByRole('button', { name: 'Use option B' }));
  expect(resolve).toHaveBeenCalledWith('question-1', { kind: 'answer', answers: { answer: 'option-b' } });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/components/conversation/work-packet.test.tsx src/components/conversation/blocking-request.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement the approved visual hierarchy**

Render user prompts as clear anchors and assistant prose with the existing Markdown renderer. Render consecutive actions inside one ordered packet. Summaries pluralize exact counts by action kind and include failed/denied/interrupted state. Expanded actions show only provider-supplied command, path, patch, output, exit status, tool summaries, and nested subagent work. Do not invent diffs or hidden reasoning. Unsupported activity renders a subdued collapsed row containing provider, native type, summary, and completeness warning—never raw JSON.

- [ ] **Step 4: Implement blocking requests and header state**

Approval blocks show the exact operation, `Allow once`, and `Deny`; add a denial-reason text field without making it mandatory. Render `Allow and remember` only when `rememberScope` is present, and submit `{ kind: 'allow-and-remember', scope: request.rememberScope }` without broadening that scope. Question blocks render the provider's `{ value, label }` choices keyed by `fieldId`, plus free text only when `allowFreeText` is true. Disable controls after submission until the native resolution event arrives. Header shows project, native title, provider, runtime, completeness, and capability-gated interrupt. Its details menu may copy the native session ID and canonical project path but offers no rename/archive/delete action in this slice; external/unknown states explain why the composer is read-only.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run: `pnpm test src/components/conversation/work-packet.test.tsx src/components/conversation/blocking-request.test.tsx && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/components/conversation
git commit -m "feat: render agentic conversation activity"
```

---

### Task 13: Virtualized timeline, stable reading position, and panel composition

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/renderer/timeline-scroll.ts`
- Test: `src/renderer/timeline-scroll.test.ts`
- Create: `src/components/conversation/virtual-timeline.tsx`
- Modify: `src/components/conversation-panel.tsx`
- Modify: `src/components/execute-mode.tsx`

**Interfaces:**
- Consumes: Task 11 hook and Task 12 components.
- Produces: variable-height `VirtualTimeline`, near-bottom auto-scroll, and the complete read-only panel.

- [ ] **Step 1: Write failing scroll-policy tests**

```ts
import { describe, expect, test } from 'vitest';
import { nextScrollAction } from '@/renderer/timeline-scroll';

describe('nextScrollAction', () => {
  test('follows new content only when already near the bottom', () => {
    expect(nextScrollAction({ distanceFromBottom: 24, appended: true, resizedAboveAnchor: false })).toBe('follow-bottom');
    expect(nextScrollAction({ distanceFromBottom: 320, appended: true, resizedAboveAnchor: false })).toBe('preserve-anchor');
  });

  test('preserves the reading anchor when an earlier row changes height', () => {
    expect(nextScrollAction({ distanceFromBottom: 500, appended: false, resizedAboveAnchor: true })).toBe('preserve-anchor');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/renderer/timeline-scroll.test.ts`

Expected: FAIL.

- [ ] **Step 3: Install virtualization**

Run:

```bash
pnpm add @tanstack/react-virtual@^3
```

- [ ] **Step 4: Implement scroll decisions and variable-height virtualization**

Use `useVirtualizer` with the panel scroll element, `count: turns.length`, stable `getItemKey: index => turns[index].id`, `estimateSize: () => 280`, `overscan: 6`, and element measurement. Treat 96px as near-bottom. Before turn updates, record the first visible turn ID and offset. After measurement, follow bottom only when previously near bottom; otherwise restore that ID/offset. Store the last visible turn ID in a module-level `Map<conversationKey, string>` and restore it for the current app lifetime.

- [ ] **Step 5: Compose the panel and empty/read-only states**

`ConversationPanel` renders header, virtual timeline, the highest-priority unresolved blocking request, and composer. Keep the composer text when send fails; clear it only after `continue` dispatch succeeds. Disable it while loading, sequence-gapped, active externally, unknown, failed, or waiting for user. `ExecuteMode` renders a useful no-selection state and provider-specific unavailable state without claiming native auth status it did not verify.

- [ ] **Step 6: Run focused tests, lint, and typecheck**

Run: `pnpm test src/renderer/timeline-scroll.test.ts src/components/conversation src/renderer && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS. Do not open a browser solely to verify the layout.

- [ ] **Step 7: Commit only if explicitly authorized**

```bash
git add package.json pnpm-lock.yaml src/renderer/timeline-scroll.ts src/renderer/timeline-scroll.test.ts src/components/conversation/virtual-timeline.tsx src/components/conversation-panel.tsx src/components/execute-mode.tsx
git commit -m "feat: virtualize native conversation timelines"
```

---

### Task 14: Runtime ownership state machine and fail-closed request lifecycle

**Files:**
- Create: `src/main/conversation-runtime.ts`
- Test: `src/main/conversation-runtime.test.ts`
- Modify: `src/main/conversation-service.ts`
- Modify: `src/main/conversation-service.test.ts`

**Interfaces:**
- Consumes: adapter runtime signals, pending request events, and active runs.
- Produces: `ConversationRuntimeController`, single-writer enforcement, request ownership, timeout, and renderer-loss denial.

- [ ] **Step 1: Write failing state-machine tests**

```ts
describe('ConversationRuntimeController', () => {
  test('permits continuation only when idle is proven', () => {
    const runtime = new ConversationRuntimeController();
    expect(runtime.canContinue('idle')).toBe(true);
    expect(runtime.canContinue('active-externally')).toBe(false);
    expect(runtime.canContinue('unknown')).toBe(false);
  });

  test('moves internal runs through waiting and back without surrendering ownership', () => {
    const runtime = new ConversationRuntimeController();
    runtime.startOwnedRun('run-1');
    runtime.openRequest('request-1', 'renderer-1');
    expect(runtime.state).toBe('waiting-for-user');
    runtime.resolveRequest('request-1');
    expect(runtime.state).toBe('active-in-fractal');
  });

  test('denies unresolved requests when their renderer disappears', async () => {
    const deny = vi.fn();
    const runtime = new ConversationRuntimeController({ deny });
    runtime.openRequest('request-1', 'renderer-1');
    await runtime.releaseRenderer('renderer-1');
    expect(deny).toHaveBeenCalledWith('request-1', 'Fractal window closed');
  });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/main/conversation-runtime.test.ts src/main/conversation-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement explicit transitions and request ownership**

Allow transitions `unknown→idle|active-externally|failed`, `idle→active-in-fractal|active-externally|unknown|failed`, `active-in-fractal→waiting-for-user|idle|failed`, `waiting-for-user→active-in-fractal|failed`, and `active-externally→idle|unknown|failed`. Reject other transitions with a sanitized error. Associate every request with conversation key, run ID, renderer ID, and adapter resolver. A duplicate or late resolution is rejected. For `allow-and-remember`, require the submitted scope to match the pending request's `rememberScope` byte-for-byte; otherwise deny. A 10-minute unresolved timeout denies the operation; renderer loss denies immediately.

- [ ] **Step 4: Enforce ownership in the service**

Call `canContinue` immediately before adapter continuation, then atomically claim ownership. If a provider status changes to external or unknown before claim, reject without spawning. Keep owned runs in a keyed map until their event stream settles and `dispose` completes. On failure, emit `failed`, reread native history, and return to idle only when the adapter proves it.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run: `pnpm test src/main/conversation-runtime.test.ts src/main/conversation-service.test.ts && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/main/conversation-runtime.ts src/main/conversation-runtime.test.ts src/main/conversation-service.ts src/main/conversation-service.test.ts
git commit -m "feat: enforce native session ownership"
```

---

### Task 15: Codex native create/resume, approvals, interrupt, and reconnect

**Files:**
- Modify: `src/main/harness/codex/codex-adapter.ts`
- Modify: `src/main/harness/codex/codex-normalizer.ts`
- Modify: `src/main/harness/codex/codex-app-server.ts`
- Modify: `src/main/harness/codex/__fixtures__/notifications.json`
- Modify: `src/main/harness/codex/codex-adapter.test.ts`
- Modify: `src/main/harness/codex/codex-app-server.test.ts`

**Interfaces:**
- Consumes: runtime controller and the stable App Server operations `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`, notifications, and server requests.
- Produces: complete Codex `HarnessAdapter` continuation behavior.

- [ ] **Step 1: Write failing native-continuation tests**

```ts
test('resumes the same native thread before starting a turn', async () => {
  const adapter = new CodexAdapter(fakeServer);
  const run = await adapter.continueConversation(codexRef, { text: 'Continue the fix' });
  expect(fakeServer.requests.slice(0, 2)).toEqual([
    { method: 'thread/resume', params: expect.objectContaining({ threadId: 'thread-1' }) },
    { method: 'turn/start', params: expect.objectContaining({ threadId: 'thread-1', input: [{ type: 'text', text: 'Continue the fix', text_elements: [] }] }) },
  ]);
  await drain(run.events);
});

test('routes approval exactly once and interrupts the active native turn', async () => {
  const run = await adapter.continueConversation(codexRef, { text: 'Run it' });
  fakeServer.emitServerRequest(commandApprovalRequest);
  await run.resolveRequest('approval-1', { kind: 'deny', reason: 'Do not delete it' });
  await run.interrupt();
  expect(fakeServer.responses).toContainEqual(expect.objectContaining({ id: commandApprovalRequest.id }));
  expect(fakeServer.requests).toContainEqual({ method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/main/harness/codex/codex-adapter.test.ts src/main/harness/codex/codex-app-server.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement create and resume through stable typed requests**

For creation, call `thread/start` with the selected `cwd` and return the server thread ID plus canonical project path. For continuation, call `thread/resume`, use the returned thread, then call `turn/start` with one text input. Record returned turn ID before exposing interrupt. Normalize all item/delta/status notifications for that exact thread/turn into the run's async iterable.

- [ ] **Step 4: Implement approvals and interruption fail closed**

Map generated server requests to approval blocks. `allow-once` returns the provider's one-turn accepted decision; `deny` returns the provider's denied decision with supplied reason only where the generated response permits it. Expose remembered scope only when the generated request/response explicitly supports a persistent permission update. If the renderer vanishes or the adapter cannot form a valid response, return denial/error rather than approval. `interrupt` calls `turn/interrupt` once and waits for the native completion status.

- [ ] **Step 5: Implement disconnect reconciliation**

On unexpected App Server exit, mark affected sessions unknown, reject pending approvals, restart with bounded delays of 250ms, 1s, then 3s, initialize again, reread each open thread, reconcile by native IDs, and emit replacement upserts. Composer enablement waits for a native idle status after reconciliation. Stop after three failures and expose a targeted provider failure until an explicit refresh.

- [ ] **Step 6: Run focused tests, lint, and typecheck**

Run: `pnpm test src/main/harness/codex src/main/conversation-runtime.test.ts && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 7: Commit only if explicitly authorized**

```bash
git add src/main/harness/codex
git commit -m "feat: continue native Codex threads"
```

---

### Task 16: Claude capability probe and safe one-turn process runner

**Files:**
- Create: `src/main/harness/claude/claude-probe.ts`
- Create: `src/main/harness/claude/claude-runner.ts`
- Test: `src/main/harness/claude/claude-probe.test.ts`
- Test: `src/main/harness/claude/claude-runner.test.ts`

**Interfaces:**
- Consumes: `NdjsonDecoder`, Claude normalizer, and injected process spawning.
- Produces: `probeClaude`, `detectClaudeRuntime`, `runClaudeTurn`, and capability evidence for approvals/questions.

- [ ] **Step 1: Write failing probe and argument-safety tests**

```ts
test('reports unavailable rather than inspecting credential files', async () => {
  const status = await probeClaude(fakeExec({ versionExit: 127 }));
  expect(status).toMatchObject({ provider: 'claude', availability: 'unavailable' });
  expect(fakeFs.readFile).not.toHaveBeenCalled();
});

test('spawns resume as an argument array without a shell', async () => {
  const process = fakeClaudeProcess(streamJsonFixture);
  const spawnProcess = vi.fn(() => process);
  await drain(runClaudeTurn({
    ref: claudeRef,
    prompt: { text: 'fix; $(touch /tmp/nope)' },
    executable: '/usr/bin/claude',
    spawnProcess,
    permissionBridge: fakeBridge,
  }).events);
  expect(spawnProcess).toHaveBeenCalledWith('/usr/bin/claude', [
    '--resume', 'claude-session-1',
    '--print', 'fix; $(touch /tmp/nope)',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config', fakeBridge.configPath,
    '--permission-prompt-tool', fakeBridge.toolName,
  ], expect.objectContaining({ cwd: '/work/fractal', shell: false }));
});

test('cannot prove idle when agent discovery is unsupported', async () => {
  await expect(detectClaudeRuntime(claudeRef, fakeExec({ agentsUnsupported: true }))).resolves.toBe('unknown');
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/main/harness/claude/claude-probe.test.ts src/main/harness/claude/claude-runner.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the compatibility probe**

Run `claude --version`, `claude --help`, and `claude agents --json` through the same injected direct-exec seam with 5-second timeouts. Determine support for `--resume`, `--session-id`, `--output-format stream-json`, `--include-partial-messages`, `--mcp-config`, `--permission-prompt-tool`, ordinary permission prompts, and `AskUserQuestion` independently. Authentication is established only by a documented noninteractive provider result; never read credential files and never attempt login. Persist no probe output beyond the capability/status fields.

Runtime detection combines Fractal's owned-process registry, supported `agents --json` output, and transcript growth. If another matching agent is reported, return `active-externally`; if no owned process exists and supported native status proves inactivity, return `idle`; otherwise return `unknown`.

- [ ] **Step 4: Implement one process per turn**

Build the exact resume argument array asserted above. For a new Claude session, replace the two `--resume` arguments with `['--session-id', ref.nativeSessionId]`; the ID must be the UUID allocated by `createConversation`. Parse stdout as NDJSON, drain parsable records after cancellation/nonzero exit, keep stderr only as a bounded sanitized diagnostic without logging it, and normalize stdout live. `interrupt` sends `SIGINT`, waits 2 seconds, then `SIGTERM`; it never signals a process that is not recorded as this run's child. After exit, reread the native JSONL and reconcile file/process observations before settling.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run: `pnpm test src/main/harness/claude/claude-probe.test.ts src/main/harness/claude/claude-runner.test.ts && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/main/harness/claude/claude-probe.ts src/main/harness/claude/claude-probe.test.ts src/main/harness/claude/claude-runner.ts src/main/harness/claude/claude-runner.test.ts
git commit -m "feat: safely run native Claude turns"
```

---

### Task 17: Claude MCP permission bridge and complete adapter

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/main/harness/claude/claude-permission-bridge.ts`
- Test: `src/main/harness/claude/claude-permission-bridge.test.ts`
- Create: `src/main/harness/claude/claude-adapter.ts`
- Test: `src/main/harness/claude/claude-adapter.test.ts`

**Interfaces:**
- Consumes: Claude history, probe, runner, runtime controller, and official MCP server packages.
- Produces: complete Claude `HarnessAdapter` with native read/watch/create/continue/interrupt/approval/question behavior.

- [ ] **Step 1: Write failing bridge security and routing tests**

```ts
test('rejects wrong hosts and per-run secrets', async () => {
  const bridge = await ClaudePermissionBridge.start({ onRequest: vi.fn() });
  await expect(callBridge(bridge, { host: 'attacker.example', token: bridge.token })).rejects.toMatchObject({ status: 403 });
  await expect(callBridge(bridge, { host: '127.0.0.1', token: 'wrong' })).rejects.toMatchObject({ status: 401 });
  await bridge.dispose();
});

test('returns only an explicit renderer decision', async () => {
  const onRequest = vi.fn(async () => ({ kind: 'deny', reason: 'Not allowed' } as const));
  const bridge = await ClaudePermissionBridge.start({ onRequest });
  await expect(callPermissionTool(bridge, commandPermissionInput)).resolves.toEqual(expectedClaudeDenial);
  expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approval', operation: commandPermissionInput.command }));
  await bridge.dispose();
});

test('denies pending work on timeout or bridge disposal', async () => {
  const bridge = await ClaudePermissionBridge.start({ onRequest: () => new Promise(() => undefined), timeoutMs: 20 });
  await expect(callPermissionTool(bridge, commandPermissionInput)).resolves.toEqual(expectedClaudeDenial);
  await bridge.dispose();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/main/harness/claude/claude-permission-bridge.test.ts src/main/harness/claude/claude-adapter.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add the official MCP server dependencies**

Run:

```bash
pnpm add @modelcontextprotocol/server @modelcontextprotocol/node @modelcontextprotocol/express express zod
pnpm add -D @types/express
```

Use the packages' installed type declarations as the API authority. Bind an HTTP transport to `127.0.0.1` only; do not expose it to the LAN.

- [ ] **Step 4: Implement an ephemeral, fail-closed bridge**

Start one official MCP server per Claude turn on a random loopback port. Register a uniquely named permission-prompt tool, validate MCP inputs with Zod, require an unguessable 32-byte per-run bearer secret, validate `Host` as `127.0.0.1:<port>` or `localhost:<port>`, cap request bodies at 64 KiB, and allow no browser CORS origin. Write the temporary MCP config with mode `0600` in `app.getPath('temp')`; include only the loopback URL, tool name, and token. Delete it and close the server on success, failure, cancellation, renderer loss, or app shutdown. Unknown input, timeout, and disconnect return provider-valid denial, never approval.

- [ ] **Step 5: Compose the Claude adapter**

`probe` reports approval and question capabilities separately from the compatibility evidence. `list/load/watch` delegate to native history. `continue` refuses `active-externally` and `unknown`, starts the bridge only when supported, then starts one runner. Route permission input to approval blocks and `AskUserQuestion` input to question blocks; resolve each exactly once. `createConversation` allocates a UUID accepted by Claude's `--session-id`, returns it as the native reference, and keeps that unsent draft in memory only; the first turn uses `--session-id` rather than `--resume`, then validates that Claude emitted the same session ID and project path. If approval support is absent, advertise it as false and refuse turns whose selected permission mode would require unavailable routing.

- [ ] **Step 6: Run focused tests, lint, and typecheck**

Run: `pnpm test src/main/harness/claude src/main/conversation-runtime.test.ts && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 7: Commit only if explicitly authorized**

```bash
git add package.json pnpm-lock.yaml src/main/harness/claude
git commit -m "feat: continue native Claude conversations"
```

---

### Task 18: Explicit new-conversation menu and native creation flow

**Files:**
- Create: `src/components/conversation/new-conversation-menu.tsx`
- Test: `src/components/conversation/new-conversation-menu.test.tsx`
- Modify: `src/components/sidebar-03/app-sidebar.tsx`
- Modify: `src/components/execute-mode.tsx`
- Modify: `src/main/conversation-service.ts`
- Modify: `src/main/conversation-service.test.ts`

**Interfaces:**
- Consumes: provider availability and `ConversationApi.create`.
- Produces: explicit Codex/Claude creation selection, main-owned directory choice, native selection after creation.

- [ ] **Step 1: Write failing provider-choice tests**

```tsx
test('offers only available native harnesses and selects the created reference', async () => {
  const onCreated = vi.fn();
  window.fractal.conversations.create = vi.fn().mockResolvedValue(codexRef);
  render(<NewConversationMenu providers={[availableCodex, unavailableClaude]} onCreated={onCreated} />);
  await userEvent.click(screen.getByRole('button', { name: 'New conversation' }));
  expect(screen.getByRole('menuitem', { name: 'Codex' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Claude Code' })).toBeNull();
  await userEvent.click(screen.getByRole('menuitem', { name: 'Codex' }));
  expect(window.fractal.conversations.create).toHaveBeenCalledWith({ provider: 'codex' });
  expect(onCreated).toHaveBeenCalledWith(codexRef);
});

test('does nothing when directory selection is cancelled', async () => {
  window.fractal.conversations.create = vi.fn().mockResolvedValue(null);
  render(<NewConversationMenu providers={[availableCodex]} onCreated={vi.fn()} />);
  await chooseCodex();
  expect(onCreated).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `pnpm test src/components/conversation/new-conversation-menu.test.tsx src/main/conversation-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement explicit provider then project selection**

Use the existing shadcn dropdown. Show only providers whose status is available and `capabilities.create` is true. After the user selects Codex or Claude, call the preload method; main owns the directory picker and canonicalization. On success select/open the returned native ref and refresh history after its first native turn. `ConversationService` registers a Claude ref with no transcript as an in-memory unsent draft, lets `open` return an empty summary titled `New Claude conversation`, and removes the draft after the first native JSONL reconciliation. An unused draft disappears harmlessly if Fractal closes and is not shown in history. On cancellation keep the existing selection. On provider failure show its sanitized status inline without changing selection.

- [ ] **Step 4: Verify creation remains native**

Extend service tests so Codex creation returns the App Server thread ID and Claude creation's preallocated UUID is the same ID later emitted and persisted by Claude. Assert no file appears below Fractal `userData/conversations` and no second Fractal conversation ID wraps either native ID.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

Run: `pnpm test src/components/conversation/new-conversation-menu.test.tsx src/main/conversation-service.test.ts && pnpm lint && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit only if explicitly authorized**

```bash
git add src/components/conversation/new-conversation-menu.tsx src/components/conversation/new-conversation-menu.test.tsx src/components/sidebar-03/app-sidebar.tsx src/components/execute-mode.tsx src/main/conversation-service.ts src/main/conversation-service.test.ts
git commit -m "feat: create native provider conversations"
```

---

### Task 19: Remove the Fractal-owned transcript pipeline and harden recovery

**Files:**
- Delete: `src/main/conversation-store.ts`
- Delete: `src/main/conversation-store.test.ts`
- Delete: `src/main/backend-adapter.ts`
- Delete: `src/main/backend-adapter.test.ts`
- Delete: `src/main/session-manager.ts`
- Delete: `src/main/session-manager.test.ts`
- Delete: `src/shared/agent-contract.ts`
- Delete: `src/shared/agent-contract.test.ts`
- Delete: `src/shared/agent-ipc-channels.ts`
- Modify: `src/main/conversation-service.ts`
- Modify: `src/main/conversation-service.test.ts`
- Test: `src/main/native-continuity.integration.test.ts`

**Interfaces:**
- Consumes: complete native adapters, service, and renderer surface.
- Produces: one authoritative pipeline and fake-harness integration coverage for recovery/deduplication.

- [ ] **Step 1: Write failing native-continuity integration tests**

```ts
describe('native continuity', () => {
  test.each(['codex', 'claude'] as const)('%s starts external, continues in Fractal, and remains natively resumable', async (provider) => {
    const harness = createFakeNativeHarness(provider);
    harness.createExternalConversation('native-1', '/work/fractal', 'First prompt');
    const app = await createTestConversationService(harness);
    const listed = await app.list();
    const ref = listed.projects[0].conversations[0].ref;
    await app.open(ref, '00000000-0000-4000-8000-000000000010');
    await app.continue(ref, { text: 'Second prompt' });
    await harness.waitForIdle('native-1');
    expect(harness.readNativeMessages('native-1')).toEqual(['First prompt', 'Second prompt']);
    expect(app.inspectFractalTranscriptFiles()).toEqual([]);
  });

  test('reconciles a crash without duplicating streamed work', async () => {
    const harness = createCrashingHarnessWithPersistedFinalEvent();
    const app = await createTestConversationService(harness);
    await app.open(harness.ref, '00000000-0000-4000-8000-000000000011');
    await expect(app.continue(harness.ref, { text: 'Continue' })).rejects.toThrow('Provider process exited');
    await harness.recover();
    expect(app.eventsForNativeId('tool-1')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the integration test and confirm the old pipeline still violates the target architecture**

Run: `pnpm test src/main/native-continuity.integration.test.ts`

Expected: FAIL until the fake native harness and cleanup are complete.

- [ ] **Step 3: Delete old persistence/runtime files and remove every import**

Run read-only searches before deletion:

```bash
rg -n "ConversationStore|SessionManager|EchoBackendAdapter|FractalAgentApi|agent-ipc-channels|window\.fractal\.agent" src
```

Remove every matched old-pipeline import/use, then delete the named files with `apply_patch`. The only renderer surface after this step is `window.fractal.conversations`; the only durable histories are provider-owned.

- [ ] **Step 4: Complete recovery and shutdown semantics**

On provider/process error: drain parseable buffered output, mark the turn interrupted/failed, reject/deny pending requests, reread native history, reconcile by native ID, and advertise read-only until idle is proven. During app shutdown: stop accepting new continuations, deny unresolved requests, interrupt owned Claude children, dispose watches/permission bridges, terminate App Server, and do not modify native transcript files directly.

- [ ] **Step 5: Run the full automated suite**

Run: `pnpm test`

Expected: all tests pass with no live model calls, native credentials, or network access.

- [ ] **Step 6: Run repository completion gates**

Run: `pnpm lint && pnpm exec tsc --noEmit`

Expected: both exit 0.

- [ ] **Step 7: Confirm no parallel transcript model remains**

Run:

```bash
rg -n "ConversationStore|SessionManager|EchoBackendAdapter|FractalAgentApi|window\.fractal\.agent|userData.*conversations" src
```

Expected: no matches.

- [ ] **Step 8: Commit only if explicitly authorized**

```bash
git add -A src
git commit -m "refactor: retire Fractal-owned conversation storage"
```

---

### Task 20: Opt-in native interoperability smoke tests and documentation

**Files:**
- Create: `docs/testing/native-conversation-interoperability.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: completed feature and installed harnesses.
- Produces: a credential-safe manual verification procedure and user-facing setup/limitations.

- [ ] **Step 1: Document the exact opt-in Codex smoke test**

Record these steps: start a harmless conversation in Codex CLI inside a temporary Git repository; wait for idle; open the same native ID under that project in Fractal; send a prompt that only reads a named fixture file; wait for idle; exit Fractal; run native Codex resume for the same ID; verify both user prompts and agent responses are present once. Record provider version, native session ID, pass/fail, and whether approval was exercised; never paste prompt/source contents into a bug log.

- [ ] **Step 2: Document the exact opt-in Claude smoke test**

Record the analogous flow with the installed Claude CLI, including one harmless read approval and one `AskUserQuestion` when those capabilities are reported. Verify Fractal stays read-only while a separately launched Claude process owns the session. Verify the native CLI can resume Fractal's completed turn. If permission or question routing is unsupported, verify the UI reports that exact capability gap and does not offer a bypass.

- [ ] **Step 3: Add concise README setup and limitations**

State that Fractal uses installed, user-authenticated Codex and Claude Code harnesses; does not provide provider login; keeps native histories authoritative; currently disables continuation for active/unknown external sessions; and does not yet support full-text transcript search, attachments, forks, deletion, archival, or Claude mid-turn steering.

- [ ] **Step 4: Run automated completion gates again**

Run: `pnpm test && pnpm lint && pnpm exec tsc --noEmit`

Expected: all commands exit 0.

- [ ] **Step 5: Inspect the final diff without modifying it**

Run: `git status --short && git diff --check && git diff --stat`

Expected: only planned source, dependency, fixture, and documentation changes; `git diff --check` exits 0. Existing unrelated user changes remain untouched.

- [ ] **Step 6: Perform manual smoke tests only with explicit opt-in**

Do not invoke either live harness, consume model usage, or access provider accounts unless the user explicitly asks. When authorized, follow `docs/testing/native-conversation-interoperability.md` and report provider/version and pass/fail without exposing transcript contents.

- [ ] **Step 7: Commit only if explicitly authorized**

```bash
git add README.md docs/testing/native-conversation-interoperability.md
git commit -m "docs: add native conversation interoperability guide"
```
