import { describe, expect, test } from 'vitest';
import { conversationKey, MAX_ATTACHMENT_IMAGE_DATA_LENGTH } from '@/shared/conversation-contract';
import {
  parseAttachmentOpenAction,
  parseAttachmentPath,
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

  test('accepts attachments with or without text and rejects malformed ones', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
    expect(parsePromptInput({ text: 'Look', attachments: [{ kind: 'path', path: '/repo/a.ts' }] })).toEqual({ text: 'Look', attachments: [{ kind: 'path', path: '/repo/a.ts' }] });
    expect(parsePromptInput({ text: '', attachments: [{ kind: 'bytes', name: 'shot.png', mediaType: 'image/png', data: png }] })).toEqual({ text: '', attachments: [{ kind: 'bytes', name: 'shot.png', mediaType: 'image/png', data: png }] });
    expect(parsePromptInput({ text: 'Plain' })).toEqual({ text: 'Plain' });
    expect(() => parsePromptInput({ text: ' ', attachments: [] })).toThrow('Prompt cannot be empty');
    expect(() => parsePromptInput({ text: 'x', attachments: [{ kind: 'path', path: 'relative/a.ts' }] })).toThrow('Invalid prompt');
    expect(() => parsePromptInput({ text: 'x', attachments: [{ kind: 'bytes', name: 'a.svg', mediaType: 'image/svg+xml', data: png }] })).toThrow('Invalid prompt');
    expect(() => parsePromptInput({ text: 'x', attachments: [{ kind: 'bytes', name: 'a.png', mediaType: 'image/png', data: 'not base64!' }] })).toThrow('Invalid prompt');
    expect(() => parsePromptInput({ text: 'x', attachments: Array.from({ length: 11 }, () => ({ kind: 'path', path: '/repo/a.ts' })) })).toThrow('at most 10 attachments');
    expect(() => parsePromptInput({ text: 'x', attachments: [{ kind: 'bytes', name: 'big.png', mediaType: 'image/png', data: 'A'.repeat(MAX_ATTACHMENT_IMAGE_DATA_LENGTH + 4) }] })).toThrow('larger than 20 MiB');
  });

  test('parses attachment paths and open actions', () => {
    expect(parseAttachmentPath('/repo/a.ts')).toBe('/repo/a.ts');
    expect(() => parseAttachmentPath('a.ts')).toThrow('Invalid attachment path');
    expect(parseAttachmentOpenAction('reveal')).toBe('reveal');
    expect(() => parseAttachmentOpenAction('delete')).toThrow('Invalid attachment action');
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
