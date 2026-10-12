# Claude Agent SDK Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run each Claude turn through the Agent SDK's `query()` against the user's own `claude`, answering permission prompts and questions through `canUseTool`, and delete the HTTP permission bridge.

**Architecture:** `runClaudeTurn` keeps its interface (`events`, `completion`, `interrupt`) but replaces hand-built CLI flags and NDJSON parsing with one `query()` call per turn. Fractal still spawns `claude` itself through the SDK's `spawnClaudeCodeProcess` hook, so it keeps the process for the watchdog, for its exit code, and for its stderr (the SDK's process interface has no stderr, so the runner reads it from the process it spawned rather than through the SDK's `stderr` option; the outcome the spec asks for, a bounded and redacting diagnostic, is unchanged). The bridge's decision logic becomes `claude-permissions.ts`, which builds the `canUseTool` function; the adapter creates it per turn and closes it when the turn ends, where it used to start and dispose the bridge.

**Tech Stack:** TypeScript 5.9, Electron 43 main process, Vite 5 main bundle, Vitest, pnpm 11, `@anthropic-ai/claude-agent-sdk` 0.3.296, zod 4.

**Spec:** [docs/superpowers/specs/2026-10-12-claude-agent-sdk-transport-design.md](../specs/2026-10-12-claude-agent-sdk-transport-design.md)

## Global Constraints

- Fractal runs only the user's own `claude`: every `query()` call sets `pathToClaudeCodeExecutable` to the configured executable (a path, or the bare name `claude`). Fractal never sets an API key and never runs or ships the SDK's bundled binary.
- `@anthropic-ai/claude-agent-sdk` is pinned to exactly `0.3.296` (no `^`); its `package.json` `claudeCodeVersion` is `2.1.296`, equal to `TESTED_VERSION_FLOOR.claude` in `src/main/harness/version-floor.ts`.
- One `claude` process per turn, resumed by session ID. No long-lived session, no fallback to the old runner.
- Today's denial messages stay word for word: "Invalid permission request", "Question routing is unavailable", "Approval routing is unavailable", "Multiple questions are not supported", "Permission request timed out", "Permission denied", "Unsupported permission decision". The one change: a prompt abandoned because its turn ended is denied with "Claude turn ended" (it was "Permission bridge closed").
- Codex is untouched.
- Tests sit next to the code as `*.test.ts`; `pnpm test`, `pnpm lint` and `pnpm exec tsc --noEmit` must pass after every task. Lint must stay at the 7 warnings already present on `main`.
- Markdown files are never hard-wrapped (AGENTS.md).

## Review Focus

- A permission prompt is open when the user presses Stop: the SDK aborts the request's signal, and the prompt must resolve as denied "Claude turn ended", with the open request in the UI told so, not left hanging. Pinned in Task 1.
- `AskUserQuestion` options carry a `preview` field, which the SDK's own `AskUserQuestionInput` type declares: the question must still be routed, not denied as an invalid request (the bridge's `.strict()` schema would have rejected it). Pinned in Task 1.
- A permission request arrives after its turn has already ended: it must be denied at once with "Claude turn ended" and must not open a request in the UI. Pinned in Task 1.
- The prompt input closes too early: permission answers and interrupts travel over the same pipe, so the input must stay open until the turn's `result` record arrives (the spike saw `interrupt()` fail with "Query closed before response received" when it closed early). Pinned in Task 2.
- The default executable is the bare name `claude`: it must reach the SDK unchanged and be spawned by Fractal's spawn function (a PATH lookup with the SDK-supplied environment), never replaced by the SDK's own binary. Pinned in Task 2.

---

## File Structure

- Create `src/main/harness/claude/claude-permissions.ts`: builds `canUseTool` from an `onRequest` callback; owns validation, request mapping, timeout and abandonment. Replaces the decision half of `claude-permission-bridge.ts`.
- Create `src/main/harness/claude/claude-permissions.test.ts`.
- Rewrite `src/main/harness/claude/claude-runner.ts`: SDK transport inside the existing `runClaudeTurn` interface.
- Rewrite `src/main/harness/claude/claude-runner.test.ts`: same behaviours, driven through an injected `query` double.
- Modify `src/main/harness/claude/claude-adapter.ts` and its test: create and close permissions instead of starting and disposing a bridge.
- Modify `src/main/harness/claude/claude-probe.ts` and its test: approvals no longer depend on `--mcp-config` or `--permission-prompt-tool`.
- Modify `src/main.ts`: stop passing `tempDir` to the Claude adapter (only the bridge used it).
- Delete `src/main/harness/claude/claude-permission-bridge.ts` and its test; remove `@modelcontextprotocol/express`, `@modelcontextprotocol/node`, `@modelcontextprotocol/server` and `express` from `package.json`.
- Modify `src/main/harness/version-floor.ts` (comment), `package.json`, `pnpm-lock.yaml`.
- Modify `docs/testing/native-conversation-interoperability.md`.

---

### Task 1: Permission module on the SDK's `canUseTool`

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (add the SDK)
- Modify: `src/main/harness/version-floor.ts` (comment only)
- Create: `src/main/harness/claude/claude-permissions.ts`
- Test: `src/main/harness/claude/claude-permissions.test.ts`

**Interfaces:**
- Consumes: `BlockingRequest`, `UserDecision` from `@/shared/conversation-contract`; `CanUseTool`, `PermissionResult` types from `@anthropic-ai/claude-agent-sdk`.
- Produces:
  ```ts
  export interface ClaudePermissions {
    readonly canUseTool: CanUseTool;
    /** Abandons every open request, and denies any later one, with `reason`. */
    close(reason: string): void;
  }
  export function createClaudePermissions(options: {
    onRequest(request: BlockingRequest, signal: AbortSignal): Promise<UserDecision>;
    approvals?: boolean;   // default true
    questions?: boolean;   // default true
    timeoutMs?: number;    // default 600_000
  }): ClaudePermissions;
  export const TURN_ENDED = 'Claude turn ended';
  ```

- [ ] **Step 1: Add the SDK at an exact version**

Run: `pnpm add --save-exact @anthropic-ai/claude-agent-sdk@0.3.296`

If pnpm asks to remove and reinstall the modules directory, answer yes, then redo the `chrome-sandbox` fix from `docs/environment-notes.md`. If the install stops with `ERR_PNPM_IGNORED_BUILDS` naming any `@anthropic-ai/claude-agent-sdk*` package, add each named package under `allowBuilds:` in `pnpm-workspace.yaml` set to `false` (Fractal never runs the SDK's binary, so it needs no install script) and rerun the command.

Verify:

```bash
node -p "require('./package.json').dependencies['@anthropic-ai/claude-agent-sdk']"
node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion"
node --input-type=module -e "import('@anthropic-ai/claude-agent-sdk').then((m) => console.log(typeof m.query))"
ls -d node_modules/@anthropic-ai/sdk node_modules/@modelcontextprotocol/sdk
```

Expected: `0.3.296`, `2.1.296`, `function`, and both directories listed (pnpm installs the SDK's peer dependencies). If either directory is missing, add the missing package with `pnpm add` at the range the SDK's `peerDependencies` names (`@anthropic-ai/sdk@>=0.93.0`, `@modelcontextprotocol/sdk@^1.29.0`).

- [ ] **Step 2: Note the floor's coupling to the SDK**

In `src/main/harness/version-floor.ts`, replace the doc comment above `TESTED_VERSION_FLOOR` with:

```ts
/**
 * The oldest agent versions Fractal has been run against. Fractal reads each
 * agent's output and protocol as they were at these versions; an older agent
 * may differ in ways nothing else detects, so it gets a warning rather than a
 * refusal. Raise a floor only after checking Fractal against the new version.
 *
 * Claude runs through `@anthropic-ai/claude-agent-sdk`, pinned exactly in
 * package.json. Its `claudeCodeVersion` must not be above the Claude floor, so
 * updating the SDK and raising this floor happen together, after re-running
 * the checks in docs/testing/native-conversation-interoperability.md.
 */
```

- [ ] **Step 3: Write the failing tests**

Create `src/main/harness/claude/claude-permissions.test.ts`:

```ts
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test, vi } from 'vitest';
import { createClaudePermissions, TURN_ENDED } from './claude-permissions';
import type { BlockingRequest, UserDecision } from '@/shared/conversation-contract';

type Call = Parameters<CanUseTool>[2];

/** What the SDK passes `canUseTool` for one tool call. */
function call(toolUseID: string, signal: AbortSignal = new AbortController().signal): Call {
  return { signal, toolUseID, requestId: `request-${toolUseID}` };
}

/** A request handler that never answers on its own, only when its signal aborts. */
function waitingForAbort() {
  return vi.fn((_request: BlockingRequest, signal: AbortSignal): Promise<UserDecision> => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ kind: 'deny', reason: 'ignored' }), { once: true });
  }));
}

const deployQuestion = {
  questions: [{
    question: 'Where?', header: 'deploy', multiSelect: false,
    options: [{ label: 'Production', description: 'Live' }, { label: 'Staging', description: 'Test' }],
  }],
};

describe('createClaudePermissions', () => {
  test('routes a Bash approval once and returns only the explicit decision', async () => {
    const onRequest = vi.fn(async (): Promise<UserDecision> => ({ kind: 'deny', reason: 'Not allowed' }));
    const { canUseTool } = createClaudePermissions({ onRequest });
    await expect(canUseTool('Bash', { command: 'pnpm test' }, call('tool-1'))).resolves.toEqual({ behavior: 'deny', message: 'Not allowed' });
    expect(onRequest).toHaveBeenCalledOnce();
    expect(onRequest).toHaveBeenCalledWith(
      { id: 'tool-1', kind: 'approval', provider: 'claude', title: 'Allow Bash', operation: 'pnpm test', status: 'open' },
      expect.any(AbortSignal),
    );
  });

  test('allows once with the tool input unchanged, and denies without a reason as "Permission denied"', async () => {
    const decisions: UserDecision[] = [{ kind: 'allow-once' }, { kind: 'deny' }];
    const { canUseTool } = createClaudePermissions({ onRequest: async () => decisions.shift() ?? { kind: 'deny' } });
    await expect(canUseTool('Bash', { command: 'pnpm test', timeout: 5 }, call('a'))).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'pnpm test', timeout: 5 } });
    await expect(canUseTool('Bash', { command: 'pnpm test' }, call('b'))).resolves.toEqual({ behavior: 'deny', message: 'Permission denied' });
  });

  test('summarizes other tools by their target, or by name when they have none', async () => {
    const onRequest = vi.fn(async (): Promise<UserDecision> => ({ kind: 'allow-once' }));
    const { canUseTool } = createClaudePermissions({ onRequest });
    await canUseTool('Edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, call('edit-1'));
    await canUseTool('WebSearch', {}, call('search-1'));
    expect(onRequest.mock.calls.map(([request]) => request)).toEqual([
      { id: 'edit-1', kind: 'approval', provider: 'claude', title: 'Allow Edit', operation: 'Edit: /repo/a.ts', status: 'open' },
      { id: 'search-1', kind: 'approval', provider: 'claude', title: 'Allow WebSearch', operation: 'WebSearch', status: 'open' },
    ]);
  });

  test('routes ExitPlanMode as a plan approval carrying the plan Claude Code read from disk', async () => {
    const onRequest = vi.fn(async (): Promise<UserDecision> => ({ kind: 'deny', reason: 'Add JSDoc.' }));
    const { canUseTool } = createClaudePermissions({ onRequest });
    await expect(canUseTool('ExitPlanMode', { plan: '# Plan', planFilePath: '/plans/x.md' }, call('plan-1'))).resolves.toEqual({ behavior: 'deny', message: 'Add JSDoc.' });
    await canUseTool('ExitPlanMode', {}, call('plan-2'));
    expect(onRequest.mock.calls.map(([request]) => request)).toEqual([
      { id: 'plan-1', kind: 'approval', provider: 'claude', title: 'Review plan', operation: '/plans/x.md', plan: '# Plan', status: 'open' },
      { id: 'plan-2', kind: 'approval', provider: 'claude', title: 'Review plan', operation: 'ExitPlanMode', plan: '', status: 'open' },
    ]);
  });

  test('routes AskUserQuestion as a question and returns the answers as updated input', async () => {
    const onRequest = vi.fn(async (): Promise<UserDecision> => ({ kind: 'answer', answers: { deploy: 'Production' } }));
    const { canUseTool } = createClaudePermissions({ onRequest });
    await expect(canUseTool('AskUserQuestion', deployQuestion, call('question-1'))).resolves.toEqual({
      behavior: 'allow', updatedInput: { ...deployQuestion, answers: { deploy: 'Production' } },
    });
    expect(onRequest).toHaveBeenCalledWith({
      id: 'question-1', kind: 'question', provider: 'claude', prompt: 'Where?', fieldId: 'deploy',
      choices: [{ value: 'Production', label: 'Production' }, { value: 'Staging', label: 'Staging' }],
      allowFreeText: false, status: 'open',
    }, expect.any(AbortSignal));
  });

  test('routes a question whose options carry previews, which the SDK declares', async () => {
    const onRequest = vi.fn(async (): Promise<UserDecision> => ({ kind: 'answer', answers: { layout: 'Grid' } }));
    const { canUseTool } = createClaudePermissions({ onRequest });
    const input = { questions: [{
      question: 'Which layout?', header: 'layout', multiSelect: false,
      options: [{ label: 'Grid', description: 'Cards', preview: '[ ][ ]' }, { label: 'List', description: 'Rows', preview: '[----]' }],
    }] };
    await expect(canUseTool('AskUserQuestion', input, call('question-2'))).resolves.toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { layout: 'Grid' } } });
    expect(onRequest).toHaveBeenCalledOnce();
  });

  test('enforces approval and question routing independently', async () => {
    const approvalsOnly = vi.fn(async (): Promise<UserDecision> => ({ kind: 'allow-once' }));
    const approvals = createClaudePermissions({ onRequest: approvalsOnly, approvals: true, questions: false });
    await expect(approvals.canUseTool('AskUserQuestion', deployQuestion, call('q'))).resolves.toEqual({ behavior: 'deny', message: 'Question routing is unavailable' });
    expect(approvalsOnly).not.toHaveBeenCalled();

    const questionsOnly = vi.fn(async (): Promise<UserDecision> => ({ kind: 'answer', answers: {} }));
    const questions = createClaudePermissions({ onRequest: questionsOnly, approvals: false, questions: true });
    await expect(questions.canUseTool('Bash', { command: 'pnpm test' }, call('b'))).resolves.toEqual({ behavior: 'deny', message: 'Approval routing is unavailable' });
    expect(questionsOnly).not.toHaveBeenCalled();
  });

  test('denies several questions at once without routing any of them', async () => {
    const onRequest = vi.fn(async (): Promise<UserDecision> => ({ kind: 'answer', answers: {} }));
    const { canUseTool } = createClaudePermissions({ onRequest });
    const input = { questions: [
      { question: 'Where?', header: 'deploy', multiSelect: false },
      { question: 'When?', header: 'timing', multiSelect: false },
    ] };
    await expect(canUseTool('AskUserQuestion', input, call('many'))).resolves.toEqual({ behavior: 'deny', message: 'Multiple questions are not supported' });
    expect(onRequest).not.toHaveBeenCalled();
  });

  test('denies input it cannot read without routing it', async () => {
    const onRequest = vi.fn(async (): Promise<UserDecision> => ({ kind: 'allow-once' }));
    const { canUseTool } = createClaudePermissions({ onRequest });
    await expect(canUseTool('Bash', { command: 42 }, call('bad-command'))).resolves.toEqual({ behavior: 'deny', message: 'Invalid permission request' });
    await expect(canUseTool('AskUserQuestion', { questions: [] }, call('no-questions'))).resolves.toEqual({ behavior: 'deny', message: 'Invalid permission request' });
    expect(onRequest).not.toHaveBeenCalled();
  });

  test('denies a request nobody answers before the timeout', async () => {
    const { canUseTool } = createClaudePermissions({ onRequest: waitingForAbort(), timeoutMs: 10 });
    await expect(canUseTool('Bash', { command: 'pnpm test' }, call('slow'))).resolves.toEqual({ behavior: 'deny', message: 'Permission request timed out' });
  });

  test('denies an open prompt and tells the request handler when Claude abandons it, as on Stop', async () => {
    const onRequest = waitingForAbort();
    const { canUseTool } = createClaudePermissions({ onRequest });
    const sdk = new AbortController();
    const decision = canUseTool('Bash', { command: 'pnpm test' }, call('stopped', sdk.signal));
    sdk.abort();
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: TURN_ENDED });
    const handlerSignal = onRequest.mock.calls[0][1];
    expect(handlerSignal.aborted).toBe(true);
    expect(handlerSignal.reason).toBe(TURN_ENDED);
  });

  test('closes open prompts when the turn ends, and denies later ones without asking', async () => {
    const onRequest = waitingForAbort();
    const permissions = createClaudePermissions({ onRequest });
    const open = permissions.canUseTool('Bash', { command: 'pnpm test' }, call('open'));
    permissions.close(TURN_ENDED);
    await expect(open).resolves.toEqual({ behavior: 'deny', message: TURN_ENDED });
    await expect(permissions.canUseTool('Bash', { command: 'ls' }, call('late'))).resolves.toEqual({ behavior: 'deny', message: TURN_ENDED });
    expect(onRequest).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/main/harness/claude/claude-permissions.test.ts`
Expected: FAIL, "Failed to load url ./claude-permissions".

- [ ] **Step 5: Implement the module**

Create `src/main/harness/claude/claude-permissions.ts`:

```ts
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { BlockingRequest, UserDecision } from '@/shared/conversation-contract';

/** The reason a prompt is denied when its turn ends or is stopped before anyone answers. */
export const TURN_ENDED = 'Claude turn ended';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

// passthrough, not strict: Claude Code adds fields over time (options already carry `preview`),
// and an unknown field must not turn a question into an invalid request.
const QUESTION_INPUT = z.object({
  questions: z.array(z.object({
    question: z.string().min(1),
    header: z.string().min(1),
    options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() }).passthrough()).optional(),
    multiSelect: z.boolean().optional(),
  }).passthrough()).min(1),
}).passthrough();

const COMMAND_INPUT = z.object({ command: z.string().min(1) }).passthrough();

export interface ClaudePermissions {
  readonly canUseTool: CanUseTool;
  /** Abandons every open request, and denies any later one, with `reason`. */
  close(reason: string): void;
}

/**
 * Turns Claude's permission prompts and questions into requests for the UI.
 * The SDK calls `canUseTool` only when Claude's own rules would ask the user;
 * what Claude or the permission mode already allows never reaches it.
 */
export function createClaudePermissions(options: {
  onRequest(request: BlockingRequest, signal: AbortSignal): Promise<UserDecision>;
  approvals?: boolean;
  questions?: boolean;
  timeoutMs?: number;
}): ClaudePermissions {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Set<AbortController>();
  let closedReason: string | undefined;

  const canUseTool: CanUseTool = async (toolName, input, { signal, toolUseID }) => {
    if (closedReason) return denial(closedReason);
    if (toolName === 'AskUserQuestion') {
      if (options.questions === false) return denial('Question routing is unavailable');
      const questions = QUESTION_INPUT.safeParse(input);
      if (questions.success && questions.data.questions.length !== 1) return denial('Multiple questions are not supported');
    } else if (options.approvals === false) return denial('Approval routing is unavailable');
    const request = blockingRequest(toolName, toolUseID, input);
    if (!request) return denial('Invalid permission request');

    const controller = new AbortController();
    const onAbandoned = (): void => controller.abort(TURN_ENDED);
    signal.addEventListener('abort', onAbandoned, { once: true });
    pending.add(controller);
    const timer = setTimeout(() => controller.abort('Permission request timed out'), timeoutMs);
    try {
      const decision = await Promise.race([options.onRequest(request, controller.signal), aborted(controller.signal)]);
      if (controller.signal.aborted) return denial(abortReason(controller.signal));
      if (decision.kind === 'allow-once' && request.kind === 'approval') return { behavior: 'allow', updatedInput: input };
      if (decision.kind === 'answer' && request.kind === 'question') return { behavior: 'allow', updatedInput: { ...input, answers: decision.answers } };
      if (decision.kind === 'deny') return denial(decision.reason ?? 'Permission denied');
      return denial('Unsupported permission decision');
    } catch {
      return denial(abortReason(controller.signal));
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbandoned);
      pending.delete(controller);
    }
  };

  return {
    canUseTool,
    close(reason) {
      closedReason ??= reason;
      for (const controller of pending) controller.abort(reason);
      pending.clear();
    },
  };
}

function blockingRequest(toolName: string, id: string, input: Record<string, unknown>): BlockingRequest | undefined {
  if (toolName === 'AskUserQuestion') {
    const question = QUESTION_INPUT.safeParse(input);
    if (!question.success) return undefined;
    const first = question.data.questions[0];
    return {
      id, kind: 'question', provider: 'claude', prompt: first.question, fieldId: first.header,
      ...(first.options ? { choices: first.options.map((option) => ({ value: option.label, label: option.label })) } : {}),
      allowFreeText: !first.options?.length, status: 'open',
    };
  }
  if (toolName === 'ExitPlanMode') {
    // Claude Code reads the plan file into the input; it is missing when the file wasn't written yet.
    const plan = typeof input.plan === 'string' ? input.plan : '';
    const filePath = typeof input.planFilePath === 'string' && input.planFilePath.trim() ? input.planFilePath : 'ExitPlanMode';
    return { id, kind: 'approval', provider: 'claude', title: 'Review plan', operation: filePath, plan, status: 'open' };
  }
  const command = toolName === 'Bash' ? COMMAND_INPUT.safeParse(input) : undefined;
  if (command && !command.success) return undefined;
  const operation = command?.success ? command.data.command : summarizeOperation(toolName, input);
  return { id, kind: 'approval', provider: 'claude', title: `Allow ${toolName}`, operation, status: 'open' };
}

function summarizeOperation(toolName: string, input: Record<string, unknown>): string {
  const likely = input.command ?? input.file_path ?? input.path ?? input.query;
  return typeof likely === 'string' && likely.trim() ? `${toolName}: ${likely}` : toolName;
}

function denial(message: string): PermissionResult { return { behavior: 'deny', message }; }
function abortReason(signal: AbortSignal): string { return typeof signal.reason === 'string' ? signal.reason : TURN_ENDED; }
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Error(abortReason(signal)));
    else signal.addEventListener('abort', () => reject(new Error(abortReason(signal))), { once: true });
  });
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/main/harness/claude/claude-permissions.test.ts`
Expected: PASS, 12 tests.

Then run `pnpm exec tsc --noEmit` and `pnpm lint`. Expected: no type errors; lint still reports 7 warnings.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml pnpm-workspace.yaml src/main/harness/version-floor.ts src/main/harness/claude/claude-permissions.ts src/main/harness/claude/claude-permissions.test.ts
git commit -m "feat(claude): answer permission prompts through the Agent SDK's canUseTool

- Add @anthropic-ai/claude-agent-sdk pinned to 0.3.296, built for Claude Code 2.1.296, the tested floor
- Move the permission bridge's decision logic into claude-permissions.ts, keeping its requests and denial messages
- Accept question fields the SDK declares, such as option previews, instead of denying them as invalid"
```

(`pnpm-workspace.yaml` only if Step 1 changed it.)

---

### Task 2: Runner on the SDK's `query()`

**Files:**
- Modify: `src/main/harness/claude/claude-runner.ts` (rewrite of the transport; buffers and sanitizing unchanged)
- Test: `src/main/harness/claude/claude-runner.test.ts` (rewrite)

**Interfaces:**
- Consumes: `CanUseTool` from Task 1's SDK dependency (the runner takes the function; it does not import `claude-permissions.ts`).
- Produces (later tasks rely on these names):
  ```ts
  export type ClaudeChildProcess = SpawnedProcess & { readonly pid?: number; readonly stderr: AsyncIterable<Uint8Array | string> };
  export interface ClaudeSpawnOptions { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; shell: false; stdio: ['pipe', 'pipe', 'pipe'] }
  export type SpawnClaudeProcess = (command: string, args: string[], options: ClaudeSpawnOptions) => ClaudeChildProcess;
  export type ClaudeQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<unknown> & { interrupt(): Promise<unknown> };
  export interface RunClaudeTurnOptions {
    ref: ConversationRef;
    prompt: { text: string; images?: ConversationImage[] };
    turnId?: string;
    executable: string;
    query?: ClaudeQuery;
    spawnProcess?: SpawnClaudeProcess;
    canUseTool?: CanUseTool;
    newSession?: boolean;
    model?: string;
    effort?: string;
    permissionMode?: string;
    watchdog?: Pick<ProcessWatchdog, 'watch' | 'unwatch'>;
    rereadNative(): Promise<NativeEvent[] | AsyncIterable<NativeEvent>>;
  }
  export function runClaudeTurn(options: RunClaudeTurnOptions): ClaudeTurnRun;   // ClaudeTurnRun and ClaudeRunCompletion unchanged
  export function sdkUserMessage(prompt: RunClaudeTurnOptions['prompt'], turnId: string): SDKUserMessage;
  ```
  `permissionBridge` and `claudeStdinMessage` are removed.

Facts this task relies on (verified 2026-10-12, SDK 0.3.296): `query()` calls `spawnClaudeCodeProcess` synchronously, before it returns; the yielded records have the same shapes as `claude --output-format stream-json` lines; a bare name such as `claude` is treated as a native binary and handed to the spawn function unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the whole of `src/main/harness/claude/claude-runner.test.ts` with:

```ts
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Options, SDKUserMessage, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, test, vi } from 'vitest';
import type { NativeEvent } from '@/main/harness/reconciler';
import { runClaudeTurn, type ClaudeChildProcess, type RunClaudeTurnOptions } from './claude-runner';

const ref = { provider: 'claude' as const, nativeSessionId: 'claude-session-1', projectPath: '/work/fractal' };

type FakeChild = ClaudeChildProcess & {
  stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; signals: NodeJS.Signals[];
  /** claude exits with `code`. */
  finish(code?: number): void;
  /** The process reports an error, as a failed launch does. */
  fail(error: Error): void;
};

function fakeChild(pid: number | undefined = 123): FakeChild {
  const emitter = new EventEmitter();
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  return Object.assign(emitter, {
    pid, stdin, stdout, stderr, signals, killed: false, exitCode: null, signalCode: null,
    kill(signal: NodeJS.Signals) { signals.push(signal); return true; },
    finish(code = 0) { stdout.end(); stderr.end(); emitter.emit('exit', code, null); },
    fail(error: Error) { emitter.emit('error', error); },
  }) as unknown as FakeChild;
}

interface FakeTurn {
  query: NonNullable<RunClaudeTurnOptions['query']>;
  spawnProcess: ReturnType<typeof vi.fn>;
  child: FakeChild;
  /** The options the runner gave the SDK. */
  options(): Options;
  /** Reads the next message from the prompt stream the runner gave the SDK. */
  nextMessage(): Promise<IteratorResult<SDKUserMessage>>;
  /** The SDK yields a record, as claude printed it. */
  push(record: object): void;
  /** The SDK's stream ends. */
  end(): void;
  /** The SDK's stream throws. */
  fail(error: Error): void;
  /** The stream ends and claude exits with `code`. */
  exit(code?: number): void;
  readonly interrupts: number;
}

/** Stands in for the SDK's query(): spawns through the runner's hook the way the SDK does, then yields what the test pushes. */
function fakeTurn(child: FakeChild = fakeChild()): FakeTurn {
  const records: object[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: Error | undefined;
  let interrupts = 0;
  let options!: Options;
  let prompt!: AsyncIterator<SDKUserMessage>;
  const poke = (): void => { wake?.(); wake = undefined; };
  const spawnProcess = vi.fn(() => child);
  const query: FakeTurn['query'] = (params) => {
    options = params.options;
    prompt = params.prompt[Symbol.asyncIterator]();
    // The real SDK spawns claude inside query() itself, before it returns.
    params.options.spawnClaudeCodeProcess?.({ command: 'claude-from-sdk', args: ['--from-sdk'], cwd: params.options.cwd, env: { PATH: '/usr/bin' } } as SpawnOptions);
    const stream = (async function* () {
      while (true) {
        const record = records.shift();
        if (record) { yield record; continue; }
        if (failure) throw failure;
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    })();
    return Object.assign(stream, { interrupt: async () => { interrupts += 1; } });
  };
  return {
    query, spawnProcess, child,
    options: () => options,
    nextMessage: () => prompt.next(),
    push: (record) => { records.push(record); poke(); },
    end: () => { ended = true; poke(); },
    fail: (error) => { failure = error; poke(); },
    exit: (code = 0) => { ended = true; poke(); child.finish(code); },
    get interrupts() { return interrupts; },
  };
}

function start(turn: FakeTurn, overrides: Partial<RunClaudeTurnOptions> = {}) {
  return runClaudeTurn({ ref, prompt: { text: 'go' }, executable: 'claude', query: turn.query, spawnProcess: turn.spawnProcess, rereadNative: async () => [], ...overrides });
}

function recordingWatchdog() {
  const calls: unknown[][] = [];
  return {
    calls,
    watch(pid: number, signal: string) { calls.push(['watch', pid, signal]); },
    unwatch(pid: number) { calls.push(['unwatch', pid]); },
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of iterable) values.push(value); return values; }

const messageStart = { type: 'stream_event', session_id: 'claude-session-1', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg-1', role: 'assistant', content: [] } } };
const textDelta = (text: string) => ({ type: 'stream_event', session_id: 'claude-session-1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const userRecord = (uuid: string, content: string) => ({ type: 'user', uuid, message: { role: 'user', content } });

describe('runClaudeTurn', () => {
  test('gives the SDK the user\'s claude, the project and the session to resume', async () => {
    const turn = fakeTurn();
    const run = start(turn, { executable: '/usr/bin/claude' });
    turn.exit(); await run.completion;
    expect(turn.options()).toMatchObject({ pathToClaudeCodeExecutable: '/usr/bin/claude', cwd: '/work/fractal', resume: 'claude-session-1', includePartialMessages: true });
    expect(turn.options()).not.toHaveProperty('sessionId');
  });

  test('passes the bare name claude through unchanged, never the SDK\'s own binary', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    turn.exit(); await run.completion;
    expect(turn.options().pathToClaudeCodeExecutable).toBe('claude');
  });

  test('spawns exactly what the SDK asks for, in the project, with its environment, without a shell', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    turn.exit(); await run.completion;
    expect(turn.spawnProcess).toHaveBeenCalledWith('claude-from-sdk', ['--from-sdk'], {
      cwd: '/work/fractal', env: { PATH: '/usr/bin' }, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
  });

  test('starts a new session under its own id', async () => {
    const turn = fakeTurn();
    const run = start(turn, { newSession: true });
    turn.exit(); await run.completion;
    expect(turn.options()).toMatchObject({ sessionId: 'claude-session-1' });
    expect(turn.options()).not.toHaveProperty('resume');
  });

  test('passes the chosen model, effort and permission mode, and leaves them to Claude when none is chosen', async () => {
    const chosen = fakeTurn();
    const first = start(chosen, { model: 'opus', effort: 'high', permissionMode: 'plan' });
    chosen.exit(); await first.completion;
    expect(chosen.options()).toMatchObject({ model: 'opus', effort: 'high', permissionMode: 'plan' });

    const unchosen = fakeTurn();
    const second = start(unchosen);
    unchosen.exit(); await second.completion;
    for (const key of ['model', 'effort', 'permissionMode']) expect(unchosen.options()).not.toHaveProperty(key);
  });

  test('hands Claude\'s permission prompts to canUseTool only when given one', async () => {
    const canUseTool = vi.fn();
    const withTool = fakeTurn();
    const first = start(withTool, { canUseTool });
    withTool.exit(); await first.completion;
    expect(withTool.options().canUseTool).toBe(canUseTool);

    const withoutTool = fakeTurn();
    const second = start(withoutTool);
    withoutTool.exit(); await second.completion;
    expect(withoutTool.options()).not.toHaveProperty('canUseTool');
  });

  test('sends the prompt as one user message carrying the turn id', async () => {
    const turn = fakeTurn();
    const run = start(turn, { prompt: { text: 'fix; $(touch /tmp/nope)' }, turnId: 'turn-1' });
    await expect(turn.nextMessage()).resolves.toEqual({ done: false, value: {
      type: 'user', uuid: 'turn-1', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'fix; $(touch /tmp/nope)' }] },
    } });
    turn.exit(); await run.completion;
  });

  test('puts image blocks after the text and drops an empty text block', async () => {
    const image = { mediaType: 'image/png' as const, data: 'iVBORw0KGgo=' };
    const withText = fakeTurn();
    const first = start(withText, { prompt: { text: 'What is this?', images: [image] } });
    expect((await withText.nextMessage()).value?.message.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    ]);
    withText.exit(); await first.completion;

    const imageOnly = fakeTurn();
    const second = start(imageOnly, { prompt: { text: '', images: [image] } });
    const content = (await imageOnly.nextMessage()).value?.message.content as Array<{ type: string }>;
    expect(content.map((block) => block.type)).toEqual(['image']);
    imageOnly.exit(); await second.completion;
  });

  test('keeps the prompt input open until the turn\'s result arrives', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    await turn.nextMessage();
    let closed = false;
    const after = turn.nextMessage().then((step) => { closed = step.done === true; });
    turn.push(messageStart);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    turn.push({ type: 'result', subtype: 'success', is_error: false, session_id: 'claude-session-1' });
    await after;
    expect(closed).toBe(true);
    turn.exit(); await run.completion;
  });

  test('normalizes records and reconciles native history even after a nonzero exit', async () => {
    const turn = fakeTurn();
    const reconciled: NativeEvent = { provider: 'claude', nativeId: 'file-result', nativeType: 'result', observedAt: 3, payload: { kind: 'turn-finished', turnId: 'user-1', status: 'failed' } };
    const run = start(turn, { rereadNative: async () => [reconciled] });
    turn.child.stderr.write('token=secret\u0000 bad\n');
    turn.push(userRecord('user-1', 'go'));
    turn.exit(1);
    const observed: NativeEvent[] = [];
    const reading = (async () => { for await (const event of run.events) observed.push(event); })();
    await expect(reading).rejects.toThrow('Claude process exited with code 1');
    expect(observed.some((event) => event.payload.kind === 'turn-started')).toBe(true);
    expect(observed.at(-1)).toEqual(reconciled);
    await expect(run.completion).rejects.toThrow('Claude process exited with code 1');
  });

  test('interrupt asks the SDK to stop the turn, then SIGTERMs claude if it is still running two seconds later', async () => {
    vi.useFakeTimers();
    try {
      const turn = fakeTurn();
      const run = start(turn);
      const interrupted = run.interrupt();
      expect(turn.interrupts).toBe(1);
      expect(turn.child.signals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_999); expect(turn.child.signals).toEqual([]);
      await vi.advanceTimersByTimeAsync(1); expect(turn.child.signals).toEqual(['SIGTERM']);
      turn.exit(); await interrupted; await run.completion;
    } finally {
      vi.useRealTimers();
    }
  });

  test('ends a stopped turn as interrupted, not failed, when the SDK reports an error result and throws', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    const interrupted = run.interrupt();
    turn.push({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'claude-session-1' });
    turn.fail(new Error('Claude Code returned an error result: [ede_diagnostic] result_type=user'));
    turn.child.finish(0);
    await interrupted;
    await expect(run.completion).resolves.toMatchObject({ exitCode: 0, signal: null });
  });

  test('keeps publishing records that arrive after an interrupt', async () => {
    vi.useFakeTimers();
    try {
      const turn = fakeTurn();
      const run = start(turn);
      const interrupted = run.interrupt();
      turn.push(userRecord('after', 'kept'));
      turn.exit(130);
      await interrupted;
      const observed: NativeEvent[] = [];
      await expect((async () => { for await (const event of run.events) observed.push(event); })()).rejects.toThrow('Claude process exited with code 130');
      expect(observed.map((event) => event.nativeId)).toEqual(['after']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('still fails a turn whose stream breaks when nobody asked it to stop', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    const events = collect(run.events);
    turn.fail(new Error('token=private-value stream broke'));
    turn.child.finish(1);
    await expect(run.completion).rejects.toThrow('token=[redacted] stream broke');
    await expect(events).rejects.toThrow('token=[redacted] stream broke');
  });

  test('stops an owned live child and settles subscribers when the stream fails before claude exits', async () => {
    vi.useFakeTimers();
    try {
      const turn = fakeTurn();
      const run = start(turn);
      const completion = run.completion.then((): undefined => undefined, (error: unknown): unknown => error);
      const events = collect(run.events).then((): undefined => undefined, (error: unknown): unknown => error);
      turn.fail(new Error('secret=never-show pipe failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(turn.child.signals).toEqual(['SIGINT']);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(turn.child.signals).toEqual(['SIGINT', 'SIGTERM']);
      await expect(completion).resolves.toMatchObject({ message: 'secret=[redacted] pipe failed' });
      await expect(events).resolves.toMatchObject({ message: 'secret=[redacted] pipe failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('contains launch errors without signaling the failed child or interrupting the SDK', async () => {
    const turn = fakeTurn();
    const run = start(turn, { executable: 'missing' });
    turn.child.fail(Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' }));
    turn.fail(new Error('Claude Code native binary not found at missing'));
    await expect(run.completion).rejects.toThrow('spawn missing ENOENT');
    await run.interrupt();
    expect(turn.child.signals).toEqual([]);
    expect(turn.interrupts).toBe(0);
    await expect(collect(run.events)).rejects.toThrow('spawn missing ENOENT');
  });

  test('has the watchdog interrupt claude if Fractal dies mid-turn, and withdraws that once claude exits', async () => {
    const watchdog = recordingWatchdog();
    const turn = fakeTurn();
    const run = start(turn, { watchdog });
    expect(watchdog.calls).toEqual([['watch', 123, 'SIGINT']]);
    turn.exit(); await run.completion;
    expect(watchdog.calls).toEqual([['watch', 123, 'SIGINT'], ['unwatch', 123]]);
  });

  test('withdraws the watch when the process fails after launch', async () => {
    const watchdog = recordingWatchdog();
    const turn = fakeTurn();
    const run = start(turn, { watchdog });
    turn.child.fail(new Error('pipe broke'));
    turn.fail(new Error('pipe broke'));
    await run.completion.catch((): void => undefined);
    expect(watchdog.calls).toEqual([['watch', 123, 'SIGINT'], ['unwatch', 123]]);
  });

  test('does not watch a process that never got a pid', async () => {
    const watchdog = recordingWatchdog();
    const turn = fakeTurn(fakeChild(undefined));
    const run = start(turn, { watchdog, executable: 'missing' });
    turn.child.fail(Object.assign(new Error('spawn missing ENOENT'), { code: 'ENOENT' }));
    turn.fail(new Error('Claude Code native binary not found at missing'));
    await run.completion.catch((): void => undefined);
    expect(watchdog.calls).toEqual([]);
  });

  test('authoritative native reread replaces overlapping process observations', async () => {
    const turn = fakeTurn();
    const authoritative: NativeEvent = { provider: 'claude', nativeId: 'user-1', nativeType: 'user', observedAt: 9, payload: { kind: 'turn-started', turnId: 'user-1', userMessageId: 'user-1', text: 'canonical file text' } };
    const run = start(turn, { rereadNative: async () => [authoritative] });
    turn.push(userRecord('user-1', 'stream text'));
    turn.exit();
    const events = await collect(run.events);
    expect(events.filter((event) => event.nativeId === 'user-1')).toEqual([authoritative]);
  });

  test('active subscribers receive changed authoritative replacements but no identical duplicates', async () => {
    const turn = fakeTurn();
    const streamed: NativeEvent = { provider: 'claude', nativeId: 'live', nativeType: 'user', observedAt: 0, payload: { kind: 'turn-started', turnId: 'live', userMessageId: 'live', text: 'stream', createdAt: 0 } };
    const authoritative: NativeEvent = { provider: 'claude', nativeId: 'live', nativeType: 'user', observedAt: 2, payload: { kind: 'turn-started', turnId: 'live', userMessageId: 'live', text: 'file', createdAt: 0 } };
    const run = start(turn, { rereadNative: async () => [authoritative, authoritative] });
    const iterator = run.events[Symbol.asyncIterator]();
    turn.push(userRecord('live', 'stream'));
    await expect(iterator.next()).resolves.toMatchObject({ value: streamed });
    turn.exit();
    await expect(iterator.next()).resolves.toMatchObject({ value: authoritative });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('owns draining and completion when events are never consumed', async () => {
    const turn = fakeTurn();
    const rereadNative = vi.fn(async () => []);
    const run = start(turn, { rereadNative });
    turn.push(userRecord('user-1', 'go'));
    turn.exit();
    await expect(run.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(rereadNative).toHaveBeenCalledOnce();
    expect(await collect(run.events)).toHaveLength(1);
  });

  test('publishes normalized records before claude exits', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    const iterator = run.events[Symbol.asyncIterator]();
    turn.push(userRecord('live', 'live now'));
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { nativeId: 'live' } });
    turn.exit(); await run.completion; await iterator.return?.();
  });

  test('anchors on a composed prompt containing an attachments block', async () => {
    const turn = fakeTurn();
    const composed = 'Compare\n\n<attachments>\n/repo/a.ts\n</attachments>';
    const anchor: NativeEvent = { provider: 'claude', nativeId: 'file-user', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'file-user', userMessageId: 'file-user', text: composed } };
    const run = start(turn, { prompt: { text: composed }, turnId: 'file-user', rereadNative: async () => [anchor] });
    turn.push(messageStart);
    turn.exit();
    expect(await collect(run.events)).toContainEqual(anchor);
  });

  test('anchors the live stream on the record carrying its own turn id, not an earlier turn with the same text', async () => {
    const turn = fakeTurn();
    const earlier: NativeEvent = { provider: 'claude', nativeId: 'earlier', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'earlier', userMessageId: 'earlier', text: 'continue' } };
    const mine: NativeEvent = { provider: 'claude', nativeId: 'turn-2', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'turn-2', userMessageId: 'turn-2', text: 'continue' } };
    const run = start(turn, { prompt: { text: 'continue' }, turnId: 'turn-2', rereadNative: async () => [earlier, mine] });
    const iterator = run.events[Symbol.asyncIterator]();
    turn.push(messageStart);
    turn.push(textDelta('Hi'));
    await expect(iterator.next()).resolves.toMatchObject({ value: mine });
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'assistant-text', turnId: 'turn-2' } } });
    turn.exit();
    await collect({ [Symbol.asyncIterator]: () => iterator });
  });

  test('waits for the persisted user anchor before streaming partials and reconciles by message id', async () => {
    const turn = fakeTurn();
    const anchor: NativeEvent = { provider: 'claude', nativeId: 'file-user', nativeType: 'user', observedAt: Date.now(), payload: { kind: 'turn-started', turnId: 'file-user', userMessageId: 'file-user', text: 'go' } };
    const final: NativeEvent = { provider: 'claude', nativeId: 'msg-1:text:0', nativeType: 'text', observedAt: 3, payload: { kind: 'assistant-text', turnId: 'file-user', blockId: 'msg-1:text:0', text: 'Hello world', final: true } };
    let available = false;
    const run = start(turn, { turnId: 'file-user', rereadNative: async () => available ? [anchor, final] : [] });
    const iterator = run.events[Symbol.asyncIterator]();
    turn.push(messageStart);
    turn.push(textDelta('Hello'));
    await new Promise<void>((resolve) => setImmediate(resolve)); available = true;
    turn.push(textDelta(' world'));
    await expect(iterator.next()).resolves.toMatchObject({ value: anchor });
    await expect(iterator.next()).resolves.toMatchObject({ value: { nativeId: 'msg-1:text:0', payload: { turnId: 'file-user', text: 'Hello world', final: false } } });
    turn.exit();
    await expect(iterator.next()).resolves.toMatchObject({ value: final });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  test('keeps draining and supports late replay after an iterator returns early', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    turn.push(userRecord('one', 'one'));
    turn.push(userRecord('two', 'two'));
    turn.exit();
    for await (const event of run.events) { expect(event.nativeId).toBe('one'); break; }
    await expect(run.completion).resolves.toMatchObject({ exitCode: 0 });
    expect(await collect(run.events)).toHaveLength(2);
  });

  test('bounds and sanitizes stderr diagnostics', async () => {
    const turn = fakeTurn();
    const run = start(turn);
    turn.child.stderr.write(`token=super-secret\u0000 ${'x'.repeat(5_000)}`);
    turn.exit(1);
    await expect(run.completion).rejects.toThrow('token=[redacted]');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/main/harness/claude/claude-runner.test.ts`
Expected: FAIL. The current runner spawns through `spawnProcess` with CLI flags and never calls `query`, so `turn.options()` is undefined; most tests fail on that or on reading `params`.

- [ ] **Step 3: Rewrite the runner**

In `src/main/harness/claude/claude-runner.ts`, replace everything from the first line down to (not including) `type Subscriber = { queue: NativeEvent[]; wake?: () => void };` with the code below. Keep `ReplayEventBuffer`, `DiagnosticBuffer`, `sanitize`, `sanitizedError`, `isLaunchError`, `asAsync` and `delay` exactly as they are.

```ts
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { query as sdkQuery, type CanUseTool, type Options, type SDKUserMessage, type SpawnOptions, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeNormalizationContext, normalizeClaudeRecord, normalizeClaudeStreamRecord } from '@/main/harness/claude/claude-normalizer';
import { nativeEventKey, type NativeEvent } from '@/main/harness/reconciler';
import type { ProcessWatchdog } from '@/main/process-watchdog';
import type { ConversationImage, ConversationRef } from '@/shared/conversation-contract';

/** The claude process for one turn: what the SDK drives, plus the pid and stderr Fractal reads itself. */
export type ClaudeChildProcess = SpawnedProcess & {
  readonly pid?: number;
  readonly stderr: AsyncIterable<Uint8Array | string>;
};

export interface ClaudeSpawnOptions { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; shell: false; stdio: ['pipe', 'pipe', 'pipe'] }
export type SpawnClaudeProcess = (command: string, args: string[], options: ClaudeSpawnOptions) => ClaudeChildProcess;

/** The SDK's query(), narrowed to what the runner uses, so tests can stand in for it. */
export type ClaudeQuery = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<unknown> & { interrupt(): Promise<unknown> };

export interface ClaudeRunCompletion { exitCode: number | null; signal: NodeJS.Signals | null; diagnostic?: string }
export interface ClaudeTurnRun {
  events: AsyncIterable<NativeEvent>;
  completion: Promise<ClaudeRunCompletion>;
  interrupt(): Promise<void>;
}

export interface RunClaudeTurnOptions {
  ref: ConversationRef;
  /** text is the composed prompt (user text plus any attachment block). */
  prompt: { text: string; images?: ConversationImage[] };
  /** The prompt record's uuid, which Claude also uses as the turn's id; generated when absent. */
  turnId?: string;
  /** The user's own claude: a path, or a bare name looked up on PATH. The SDK never runs its own binary. */
  executable: string;
  query?: ClaudeQuery;
  spawnProcess?: SpawnClaudeProcess;
  /** Answers the prompts and questions Claude's own rules would put to the user. */
  canUseTool?: CanUseTool;
  newSession?: boolean;
  /** Absent leaves Claude on its configured default. */
  model?: string;
  /** Only meaningful with a model that takes effort. */
  effort?: string;
  /** Absent leaves Claude on its configured default. */
  permissionMode?: string;
  /** Interrupts claude if Fractal dies mid-turn; claude ends the commands it started when interrupted. */
  watchdog?: Pick<ProcessWatchdog, 'watch' | 'unwatch'>;
  rereadNative(): Promise<NativeEvent[] | AsyncIterable<NativeEvent>>;
}

/**
 * Runs one Claude turn through the Agent SDK. One claude process per turn,
 * resumed by session id; Fractal spawns it through the SDK's hook so it keeps
 * the process for the watchdog, its exit code and its stderr.
 */
export function runClaudeTurn(options: RunClaudeTurnOptions): ClaudeTurnRun {
  const turnId = options.turnId ?? randomUUID();
  const input = new TurnInput(sdkUserMessage(options.prompt, turnId));
  const diagnostic = new DiagnosticBuffer();
  type Terminal = { code: number | null; signal: NodeJS.Signals | null; error?: Error };
  let terminalValue: Terminal | undefined;
  let resolveTerminal!: (result: Terminal) => void;
  const terminal = new Promise<Terminal>((resolve) => { resolveTerminal = resolve; });
  let child: ClaudeChildProcess | undefined;
  let watchedPid: number | undefined;
  let stderrDrain: Promise<void> = Promise.resolve();
  const settleTerminal = (value: Terminal): void => {
    if (terminalValue) return;
    terminalValue = value;
    if (watchedPid !== undefined) options.watchdog?.unwatch(watchedPid);
    resolveTerminal(value);
  };

  const spawnClaudeCodeProcess = (spawnOptions: SpawnOptions): SpawnedProcess => {
    const spawned = (options.spawnProcess ?? spawnClaude)(spawnOptions.command, spawnOptions.args, {
      cwd: spawnOptions.cwd ?? options.ref.projectPath, env: spawnOptions.env,
      ...(spawnOptions.signal ? { signal: spawnOptions.signal } : {}), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = spawned;
    if (options.watchdog && spawned.pid) {
      watchedPid = spawned.pid;
      options.watchdog.watch(watchedPid, 'SIGINT');
    }
    spawned.once('exit', (code, signal) => settleTerminal({ code, signal }));
    spawned.once('error', (error) => settleTerminal({ code: null, signal: null, error }));
    stderrDrain = drainStderr(spawned.stderr, diagnostic).catch((): void => undefined);
    return spawned;
  };

  const sdkOptions: Options = {
    pathToClaudeCodeExecutable: options.executable,
    cwd: options.ref.projectPath,
    ...(options.newSession ? { sessionId: options.ref.nativeSessionId } : { resume: options.ref.nativeSessionId }),
    ...(options.model ? { model: options.model } : {}),
    // Passed through as claude's --effort and --permission-mode; claude validates the values.
    ...(options.effort ? { effort: options.effort as Options['effort'] } : {}),
    ...(options.permissionMode ? { permissionMode: options.permissionMode as Options['permissionMode'] } : {}),
    includePartialMessages: true,
    ...(options.canUseTool ? { canUseTool: options.canUseTool } : {}),
    spawnClaudeCodeProcess,
  };
  // The SDK spawns claude inside this call, through spawnClaudeCodeProcess.
  const turn = (options.query ?? sdkQuery)({ prompt: input.messages(), options: sdkOptions });

  /** SIGINT, then SIGTERM two seconds later if claude is still running: for a turn whose stream broke. */
  let stopping: Promise<void> | undefined;
  const stopOwned = (): Promise<void> => stopping ??= (async () => {
    if (terminalValue || !child) return;
    child.kill('SIGINT');
    await Promise.race([terminal, delay(2_000)]);
    if (!terminalValue) child.kill('SIGTERM');
  })();

  let interruptRequested = false;
  let interrupting: Promise<void> | undefined;
  const interrupt = (): Promise<void> => interrupting ??= (async () => {
    if (terminalValue) return;
    interruptRequested = true;
    void turn.interrupt().catch((): void => undefined);
    await Promise.race([terminal, delay(2_000)]);
    if (!terminalValue) child?.kill('SIGTERM');
  })();

  const eventBuffer = new ReplayEventBuffer();
  let streamError: Error | undefined;
  const streamed = drainRecords(turn, eventBuffer, options.rereadNative, turnId, options.ref.nativeSessionId, () => input.close())
    .catch((error: unknown) => { streamError = sanitizedError(error); })
    .finally(() => input.close());

  const completion = (async (): Promise<ClaudeRunCompletion> => {
    await streamed;
    // After a stop Fractal asked for, the SDK may report the cut-off turn as an error result or throw; neither is a failure.
    if (streamError && !interruptRequested) {
      await Promise.race([terminal, delay(0)]);
      if (!(terminalValue?.error && isLaunchError(terminalValue.error))) {
        await stopOwned();
        throw streamError;
      }
    }
    const result = terminalValue ?? await terminal;
    await stderrDrain;
    if (result.error) throw sanitizedError(result.error);
    for await (const event of asAsync(await options.rereadNative())) eventBuffer.publish(event);
    const combinedDiagnostic = diagnostic.value();
    if (result.signal || result.code !== 0) throw new Error(`Claude process ${result.signal ? `terminated by ${result.signal}` : `exited with code ${result.code}`}${combinedDiagnostic ? `: ${combinedDiagnostic}` : ''}`);
    eventBuffer.close();
    return { exitCode: result.code, signal: result.signal, ...(combinedDiagnostic ? { diagnostic: combinedDiagnostic } : {}) };
  })().catch((error: unknown) => {
    const safeError = sanitizedError(error);
    eventBuffer.fail(safeError);
    throw safeError;
  });
  void completion.catch((): void => undefined);

  const eventStream: AsyncIterable<NativeEvent> = {
    async *[Symbol.asyncIterator](): AsyncGenerator<NativeEvent> {
      yield* eventBuffer.iterate(terminalValue !== undefined);
    },
  };

  return { events: eventStream, completion, interrupt };
}

/** The turn's prompt: the text block (omitted when empty), then base64 image blocks. Claude saves it under `turnId` as its uuid, which is how the runner finds this turn in the transcript. */
export function sdkUserMessage(prompt: RunClaudeTurnOptions['prompt'], turnId: string): SDKUserMessage {
  const content = [
    ...(prompt.text ? [{ type: 'text' as const, text: prompt.text }] : []),
    ...(prompt.images ?? []).map((image) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } })),
  ];
  return { type: 'user', uuid: turnId as SDKUserMessage['uuid'], message: { role: 'user', content }, parent_tool_use_id: null };
}

/**
 * The prompt as the SDK's input stream: one message, then held open until
 * close(). Permission answers and interrupts travel over the same pipe, so
 * closing it before the turn's result would cut them off.
 */
class TurnInput {
  private closed = false;
  private release: (() => void) | undefined;
  constructor(private readonly message: SDKUserMessage) {}

  async *messages(): AsyncGenerator<SDKUserMessage> {
    yield this.message;
    if (!this.closed) await new Promise<void>((resolve) => { this.release = resolve; });
  }

  close(): void {
    this.closed = true;
    this.release?.();
    this.release = undefined;
  }
}

function spawnClaude(command: string, args: string[], options: ClaudeSpawnOptions): ClaudeChildProcess {
  return spawn(command, args, options) as ChildProcessWithoutNullStreams;
}

async function drainRecords(records: AsyncIterable<unknown>, events: ReplayEventBuffer, rereadNative: RunClaudeTurnOptions['rereadNative'], turnId: string, sessionId: string, onResult: () => void): Promise<void> {
  const context = createClaudeNormalizationContext();
  let ordinal = 0;
  let anchoredTurnId: string | undefined;
  for await (const value of records) {
    const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
    if (typeof record?.session_id === 'string' && record.session_id !== sessionId) { ordinal += 1; continue; }
    if (record?.type === 'system' && record.subtype === 'init') { ordinal += 1; continue; }
    if (record?.type === 'result') onResult();
    if (record?.type === 'stream_event' || record?.type === 'assistant' || record?.type === 'result') {
      if (!anchoredTurnId) {
        try {
          for await (const event of asAsync(await rereadNative())) {
            if (event.payload.kind === 'turn-started' && event.payload.turnId === turnId) {
              anchoredTurnId = event.payload.turnId;
              events.publish(event);
            }
          }
        } catch { /* The native user record may not be persisted yet. */ }
      }
      const normalized = record.type === 'stream_event'
        ? normalizeClaudeStreamRecord(record, ordinal++, context, anchoredTurnId ?? '')
        : normalizeClaudeRecord({ ...record, parentUuid: anchoredTurnId }, ordinal++, context);
      if (anchoredTurnId) for (const event of normalized) events.publish(event);
      continue;
    }
    for (const event of normalizeClaudeRecord(value, ordinal++, context)) {
      if (event.payload.kind === 'turn-started' && event.payload.turnId === turnId) anchoredTurnId = turnId;
      events.publish(event);
    }
  }
}

async function drainStderr(stream: AsyncIterable<Uint8Array | string>, diagnostic: DiagnosticBuffer): Promise<void> {
  for await (const chunk of stream) diagnostic.append(chunk);
}
```

`NdjsonDecoder` is no longer imported here; leave `src/main/harness/ndjson-decoder.ts` in place (Codex uses it).

- [ ] **Step 4: Run the runner tests to verify they pass**

Run: `pnpm exec vitest run src/main/harness/claude/claude-runner.test.ts`
Expected: PASS, 28 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: errors only in `src/main/harness/claude/claude-adapter.ts` (it still passes `permissionBridge`), which Task 3 removes. Any error inside `claude-runner.ts` or its test must be fixed now. If TypeScript rejects `spawn(...) as ChildProcessWithoutNullStreams` as a `ClaudeChildProcess`, change the cast to `as unknown as ClaudeChildProcess`; Node's `ChildProcess` satisfies the SDK's `SpawnedProcess` at runtime, as the SDK's documentation states.

- [ ] **Step 6: Commit**

Commit together with Task 3, because the adapter does not compile against the new runner until Task 3 lands. Do not commit at the end of this task.

---

### Task 3: Adapter, probe and wiring; delete the bridge

**Files:**
- Modify: `src/main/harness/claude/claude-adapter.ts:1-30,95-150` (imports, dependencies, permission setup)
- Modify: `src/main/harness/claude/claude-adapter.test.ts` (the five tests that pass `startBridge`)
- Modify: `src/main/harness/claude/claude-probe.ts` (evidence and capabilities)
- Modify: `src/main/harness/claude/claude-probe.test.ts`
- Modify: `src/main.ts:228` (remove `tempDir`)
- Delete: `src/main/harness/claude/claude-permission-bridge.ts`, `src/main/harness/claude/claude-permission-bridge.test.ts`
- Modify: `package.json`, `pnpm-lock.yaml` (remove bridge-only packages)

**Interfaces:**
- Consumes: `createClaudePermissions`, `TURN_ENDED` (Task 1); `RunClaudeTurnOptions.canUseTool` (Task 2).
- Produces: `ClaudeAdapterDependencies` without `startBridge` and `tempDir`; `ClaudeCapabilityEvidence` without `mcpConfig`, `permissionPromptTool`, `permissionPrompts`.

- [ ] **Step 1: Write the failing adapter tests**

In `src/main/harness/claude/claude-adapter.test.ts`:

Add to the imports:

```ts
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
```

Add below the `available` constant:

```ts
/** What the SDK passes canUseTool for one tool call. */
function toolCall(toolUseID: string, signal: AbortSignal = new AbortController().signal): Parameters<CanUseTool>[2] {
  return { signal, toolUseID, requestId: `request-${toolUseID}` };
}

/** A runner whose events stay open until `finish()`; it records the options each turn was given. */
function heldRunner() {
  let finish!: () => void;
  const runTurn = vi.fn((_options: RunClaudeTurnOptions): ClaudeTurnRun => ({
    events: (async function* () { await new Promise<void>((resolve) => { finish = resolve; }); yield* [] as NativeEvent[]; })(),
    completion: Promise.resolve({ exitCode: 0, signal: null }), interrupt: vi.fn(async () => undefined),
  }));
  return { runTurn, finish: () => finish(), canUseTool: () => { const tool = runTurn.mock.calls[0][0].canUseTool; if (!tool) throw new Error('no canUseTool'); return tool; } };
}
```

Replace the test `'routes each bridge request exactly once and keeps resolved decisions in the event stream'` with:

```ts
  test('routes each permission prompt exactly once and keeps resolved decisions in the event stream', async () => {
    const held = heldRunner();
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn: held.runTurn });
    const run = await adapter.continueConversation(ref, { text: 'continue' });
    const iterator = run.events[Symbol.asyncIterator]();
    const opened = iterator.next();
    const decision = held.canUseTool()('Bash', { command: 'pnpm test' }, toolCall('approval-1'));
    await expect(opened).resolves.toMatchObject({ value: { payload: { kind: 'request-opened' } } });
    await run.resolveRequest('approval-1', { kind: 'allow-once' });
    await expect(decision).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'pnpm test' } });
    await expect(run.resolveRequest('approval-1', { kind: 'deny' })).rejects.toThrow('no longer available');
    await expect(iterator.next()).resolves.toMatchObject({ value: { payload: { kind: 'request-resolved' } } });
    held.finish(); await run.dispose();
  });

  test('gives the runner no canUseTool when the probe offers neither approvals nor questions', async () => {
    const held = heldRunner();
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => ({ ...available, capabilities: { ...available.capabilities, approvals: false, questions: false } }), runtime: async () => 'idle', runTurn: held.runTurn });
    const run = await adapter.continueConversation(ref, { text: 'continue' });
    expect(held.runTurn.mock.calls[0][0]).not.toHaveProperty('canUseTool');
    held.finish(); await run.dispose();
  });
```

Replace the test `'denies and audits a pending bridge request before closing a naturally ended turn'` with:

```ts
  test('denies and audits an open permission prompt before closing a naturally ended turn', async () => {
    const held = heldRunner();
    const adapter = new ClaudeAdapter(root, { realpath, probe: async () => available, runtime: async () => 'idle', runTurn: held.runTurn });
    const run = await adapter.continueConversation(ref, { text: 'continue' });
    const decision = held.canUseTool()('Bash', { command: 'pnpm test' }, toolCall('pending'));
    held.finish();
    const events = await collect(run.events);
    await expect(decision).resolves.toEqual({ behavior: 'deny', message: 'Claude turn ended' });
    expect(events.map((event) => event.payload.kind)).toEqual(['request-opened', 'request-resolved']);
    expect(events[1]?.payload).toMatchObject({ decision: { kind: 'deny', reason: 'Claude turn ended' } });
  });
```

In the four remaining tests that pass `startBridge` (`'tracks owned processes before spawn and clears ownership on success and failure'`, `'propagates a failed runner completion even when its event stream closes cleanly'`, `'retains ownership after interrupt and during disposal until the process stream settles'`, `'creates UUID drafts in memory, uses session-id once, and later resumes the exact native session'`): delete the `const startBridge = …;` line where there is one, and delete `startBridge` (or `startBridge: async () => (…)`) from the `new ClaudeAdapter(…)` dependencies. Change nothing else in them.

- [ ] **Step 2: Write the failing probe tests**

In `src/main/harness/claude/claude-probe.test.ts`, in the test `'derives each capability independently and accepts only documented noninteractive authentication evidence'`, change the expected `evidence` to:

```ts
      evidence: { resume: true, sessionId: true, streamJson: true, partialMessages: false, askUserQuestion: true, authenticated: true },
```

Replace the test `'does not confuse permission-tool routing with ordinary permission prompt support'` with:

```ts
  test('offers approvals with stream-json alone, and questions only when AskUserQuestion is listed', async () => {
    const statusFor = (help: string) => probeClaude(fakeExec({
      '--version': { exitCode: 0, stdout: '2.1.296' },
      '--help': { exitCode: 0, stdout: help },
      'auth status --json': { exitCode: 0, stdout: '{"loggedIn":true}' },
    }));
    await expect(statusFor('--output-format stream-json')).resolves.toMatchObject({ capabilities: { approvals: true, questions: false } });
    await expect(statusFor('--output-format stream-json\nAskUserQuestion')).resolves.toMatchObject({ capabilities: { approvals: true, questions: true } });
    await expect(statusFor('--mcp-config --permission-prompt-tool <name>\nAskUserQuestion')).resolves.toMatchObject({ capabilities: { approvals: false, questions: false } });
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/main/harness/claude/claude-adapter.test.ts src/main/harness/claude/claude-probe.test.ts`
Expected: FAIL. The adapter still starts a bridge (`'Claude permission bridge temp path is unavailable'`), and the probe still requires `--mcp-config` for approvals.

- [ ] **Step 4: Change the adapter**

In `src/main/harness/claude/claude-adapter.ts`:

Replace the import of `ClaudePermissionBridge` with:

```ts
import { createClaudePermissions, TURN_ENDED } from '@/main/harness/claude/claude-permissions';
```

Delete the `BridgeHandle` and `BridgeStartOptions` interfaces, and delete `startBridge` and `tempDir` from `ClaudeAdapterDependencies`.

Replace the block from `let bridge: BridgeHandle | undefined;` through `const disposeBridge = (): Promise<void> => bridgeDisposal ??= bridge?.dispose() ?? Promise.resolve();` with:

```ts
    const permissions = status.capabilities.approvals || status.capabilities.questions
      ? createClaudePermissions({ onRequest, approvals: status.capabilities.approvals, questions: status.capabilities.questions })
      : undefined;
    const closePermissions = (): void => permissions?.close(TURN_ENDED);
```

In the `runTurn` call, replace `...(bridge ? { permissionBridge: bridge } : {}),` with `...(permissions ? { canUseTool: permissions.canUseTool } : {}),`.

Replace each of the three `await disposeBridge();` calls (in the `catch` around `runTurn`, in the pump's `finally`, and in `dispose`) with `closePermissions();`.

- [ ] **Step 5: Change the probe**

In `src/main/harness/claude/claude-probe.ts`, remove `mcpConfig`, `permissionPromptTool` and `permissionPrompts` from `ClaudeCapabilityEvidence` and from the `evidence` object, and replace the `approvals` and `questions` lines of `capabilities` with:

```ts
    // Through the Agent SDK, prompts and questions travel over the same stream-json pipe as the turn.
    approvals: evidence.streamJson,
    questions: evidence.streamJson && evidence.askUserQuestion,
```

- [ ] **Step 6: Stop passing tempDir**

In `src/main.ts`, delete the line `tempDir: app.getPath('temp'),` from the `ClaudeAdapter` dependencies.

- [ ] **Step 7: Delete the bridge and its packages**

```bash
git rm src/main/harness/claude/claude-permission-bridge.ts src/main/harness/claude/claude-permission-bridge.test.ts
grep -rn "@modelcontextprotocol/express\|@modelcontextprotocol/node\|@modelcontextprotocol/server\|from 'express'" src || echo "no remaining users"
```

Expected: `no remaining users`. Then:

```bash
pnpm remove @modelcontextprotocol/express @modelcontextprotocol/node @modelcontextprotocol/server express
```

Do not remove `@modelcontextprotocol/sdk` or `zod`: the Agent SDK declares both as peer dependencies, and `claude-permissions.ts` uses zod.

- [ ] **Step 8: Run everything**

```bash
pnpm exec vitest run src/main/harness/claude/
pnpm test
pnpm exec tsc --noEmit
pnpm lint
```

Expected: all Claude harness tests pass; the full suite passes; no type errors; lint reports the same 7 warnings as `main`.

- [ ] **Step 9: Commit Tasks 2 and 3**

```bash
git add -A src/main/harness/claude src/main.ts package.json pnpm-lock.yaml
git commit -m "feat(claude): run each turn through the Agent SDK against the user's claude

- Replace hand-built CLI flags and NDJSON parsing with one query() per turn, still one claude process per turn
- Spawn claude through the SDK's hook so Fractal keeps the process for the watchdog, its exit code and its stderr
- Keep the prompt input open until the turn's result so permission answers and interrupts reach claude
- Stop a turn with the SDK's interrupt, then SIGTERM after two seconds; report a stopped turn as interrupted, not failed
- Answer prompts through canUseTool and delete the HTTP permission bridge and its packages
- Offer approvals with stream-json support alone, since they no longer need --mcp-config or --permission-prompt-tool"
```

---

### Task 4: Smoke-test procedure, packaging and end-to-end checks

**Files:**
- Modify: `docs/testing/native-conversation-interoperability.md` (Claude Code section)

**Interfaces:**
- Consumes: the finished transport from Tasks 1 to 3.
- Produces: an updated manual procedure, and the verification record below.

- [ ] **Step 1: Update the smoke-test procedure**

In `docs/testing/native-conversation-interoperability.md`, under `## Claude Code`, insert after step 1 (renumbering the steps that follow):

```markdown
2. Confirm that `claude --version` is at or above the Claude floor in `src/main/harness/version-floor.ts`, and that Fractal's home screen shows no version warning for Claude. Fractal runs Claude through the Agent SDK pinned in `package.json`, against this installed `claude`.
```

Then append, before `### Claude external-ownership check`, these numbered steps (continuing the numbering):

```markdown
- Interrupt and continue: send a prompt that takes a while, press Stop while Claude is working, and confirm the turn ends as interrupted, not failed. Send a follow-up in the same conversation and confirm it continues the same native session.
- Conversation from before the SDK switch: open a Claude conversation last continued by a Fractal build before the Agent SDK change, send a turn, and confirm it continues the same native session with the history shown once.
- Repeated text: send the same short prompt (for example `continue`) twice in a row, and confirm each reply appears under its own turn.
```

Add three rows to the `## Safe test record` block, after `question exercised`:

```text
interrupt then continue: pass | fail
pre-SDK conversation continued: pass | fail
repeated prompt attributed: pass | fail
```

- [ ] **Step 2: Verify the packaged app ships no claude binary**

```bash
pnpm package
find out -type f \( -name claude -o -name 'claude.exe' \) | head
find out -path '*claude-agent-sdk*' | head
```

Expected: `pnpm package` succeeds, and both `find` commands print nothing. If the build fails on the SDK's ESM (for example a top-level await or an `import.meta` error), apply the spec's fallback: add `'@anthropic-ai/claude-agent-sdk'` to `external` in `vite.main.config.ts`, extend the `ignore` filter in `forge.config.ts` to keep `/node_modules/@anthropic-ai/claude-agent-sdk` and its peer dependencies but not `/node_modules/@anthropic-ai/claude-agent-sdk-*` (the platform binary packages), rebuild, and repeat both `find` checks (the second must then list only the SDK's JavaScript package, never a `claude-agent-sdk-<platform>` directory).

- [ ] **Step 3: Repeat the watchdog checks with claude spawned through the SDK**

Create a throwaway harness outside the repository (in your scratch directory), at `e2e-entry.ts`, with this content, and bundle it from the repository root:

```ts
// Throwaway: Fractal's real Claude runner and watchdog in a real Electron main process.
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { startProcessWatchdog } from '@/main/process-watchdog';
import { runClaudeTurn } from '@/main/harness/claude/claude-runner';

const [workDir, claudeBin, mode] = process.argv.slice(-3);
app.whenReady().then(async () => {
  const watchdog = startProcessWatchdog();
  if (!watchdog) throw new Error('no watchdog');
  const run = runClaudeTurn({
    ref: { provider: 'claude', nativeSessionId: randomUUID(), projectPath: workDir }, newSession: true, model: 'haiku', permissionMode: 'bypassPermissions',
    prompt: { text: 'Use Bash in the foreground to run exactly: python3 -c "import time; time.sleep(421)"' },
    executable: claudeBin, watchdog, rereadNative: async () => [],
  });
  void run.completion.catch(() => undefined);
  console.log(`E2E_READY electron=${process.pid}`);
  if (mode === 'quit') {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    await run.interrupt();
    console.log('E2E_INTERRUPTED');
    setTimeout(() => app.exit(0), 3_000);
  }
});
```

```bash
node -e "require('esbuild').build({ entryPoints: ['<scratch>/e2e-entry.ts'], bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: '<scratch>/e2e.js', tsconfig: 'tsconfig.json' })"
```

For each mode, `crash` and `quit`: start `node_modules/electron/dist/electron --no-sandbox <scratch>/e2e.js <scratch>/work ~/.local/bin/claude <mode>` in the background with `DISPLAY`, `XAUTHORITY`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` passed through; wait until `pgrep -f '^python3 -c import time; time.sleep[(]421[)]$'` finds the command. In `crash` mode, `kill -KILL` the Electron process; in `quit` mode, wait for it to exit. Ten seconds later check that no `claude` started by the harness, no `time.sleep(421)` command and no `fractal-watchdog 5` process remains. Expected: all gone in both modes. Remove any leftover by PID before moving on.

- [ ] **Step 4: Hand over the checks that need a person**

Report what Steps 2 and 3 showed, and ask the user to:

1. Run the updated Claude Code section of `docs/testing/native-conversation-interoperability.md` (opt-in: it uses their login and plan usage).
2. Complete one Claude turn from the packaged app built in Step 2, including one approval prompt.

- [ ] **Step 5: Commit the procedure**

```bash
git add docs/testing/native-conversation-interoperability.md
git commit -m "docs(testing): cover the Agent SDK path in the Claude smoke test"
```
