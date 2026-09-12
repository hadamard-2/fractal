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
    expect(() => parseConversationRef({
      provider: 'codex',
      nativeSessionId: '   ',
      projectPath: '/work/fractal',
    })).toThrow('Invalid conversation reference');
    expect(() => parseConversationRef({
      provider: 'codex',
      nativeSessionId: 'session-1',
      projectPath: 'relative/path',
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
    expect(parseUserDecision({ kind: 'allow-and-remember', scope: 'command:git status' })).toEqual({
      kind: 'allow-and-remember',
      scope: 'command:git status',
    });
    expect(() => parseUserDecision({ kind: 'allow-forever' })).toThrow('Invalid decision');
    expect(() => parseUserDecision({ kind: 'allow-and-remember', scope: '  ' })).toThrow('Invalid decision');
    expect(() => parseUserDecision({ kind: 'answer', answers: { answer: 'x'.repeat(100_001) } })).toThrow('Invalid decision');
  });

  test('returns fresh values and preserves submitted prompt text', () => {
    const input = { text: '  keep these spaces  ' };
    const parsed = parsePromptInput(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);

    const ref = { provider: 'codex' as const, nativeSessionId: 'session-1', projectPath: '/work/fractal' };
    const parsedRef = parseConversationRef(ref);
    expect(parsedRef).toEqual(ref);
    expect(parsedRef).not.toBe(ref);
  });
});
