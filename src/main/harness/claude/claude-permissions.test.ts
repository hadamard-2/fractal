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
    const onRequest = vi.fn<(request: BlockingRequest) => Promise<UserDecision>>(async () => ({ kind: 'allow-once' }));
    const { canUseTool } = createClaudePermissions({ onRequest });
    await canUseTool('Edit',{ file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, call('edit-1'));
    await canUseTool('WebSearch', {}, call('search-1'));
    expect(onRequest.mock.calls.map(([request]) => request)).toEqual([
      { id: 'edit-1', kind: 'approval', provider: 'claude', title: 'Allow Edit', operation: 'Edit: /repo/a.ts', status: 'open' },
      { id: 'search-1', kind: 'approval', provider: 'claude', title: 'Allow WebSearch', operation: 'WebSearch', status: 'open' },
    ]);
  });

  test('routes ExitPlanMode as a plan approval carrying the plan Claude Code read from disk', async () => {
    const onRequest = vi.fn<(request: BlockingRequest) => Promise<UserDecision>>(async () => ({ kind: 'deny', reason: 'Add JSDoc.' }));
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
