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
