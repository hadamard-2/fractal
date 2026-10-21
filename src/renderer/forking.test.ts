import { describe, expect, test } from 'vitest';
import { promptAttachments } from '@/components/conversation/prompt-attachments';
import { canForkAt, clearForkDraft, forkDraft, forkDraftOf, setForkDraft, type ForkDraft } from '@/renderer/forking';
import { initialConversationState, type ConversationState } from '@/renderer/conversation-reducer';
import type { ConversationTurn, HarnessCapabilities } from '@/shared/conversation-contract';

const capabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: true };

const turn = (id: string, status: ConversationTurn['status'] = 'completed'): ConversationTurn => ({
  id, nativeId: `native-${id}`, userMessage: { id: `message-${id}`, text: id }, blocks: [], status, captureCompleteness: 'complete',
});

const stateOf = (overrides: Partial<ConversationState> = {}): ConversationState => ({
  ...initialConversationState,
  history: 'complete',
  capabilities,
  runtime: 'idle',
  turns: [turn('one'), turn('two')],
  ...overrides,
});

describe('canForkAt', () => {
  test('is false when read-only, while history is incomplete, without fork support, and for an unknown turn', () => {
    expect(canForkAt(stateOf(), 'one', 'after', true)).toBe(false);
    expect(canForkAt(stateOf({ history: 'loading' }), 'one', 'after', false)).toBe(false);
    expect(canForkAt(stateOf({ capabilities: { ...capabilities, fork: false } }), 'one', 'after', false)).toBe(false);
    expect(canForkAt(stateOf({ capabilities: null }), 'one', 'after', false)).toBe(false);
    expect(canForkAt(stateOf(), 'missing', 'after', false)).toBe(false);
  });

  test('forks after a completed turn, but not after the last turn while it is still running', () => {
    const running = stateOf({ turns: [turn('one'), turn('two', 'active')], runtime: 'active-in-fractal' });

    expect(canForkAt(stateOf(), 'one', 'after', false)).toBe(true);
    expect(canForkAt(running, 'two', 'after', false)).toBe(false);
    expect(canForkAt({ ...running, runtime: 'idle' }, 'two', 'after', false)).toBe(true);
  });

  test('forks before a message when the turn ahead of it is finished, and before the first turn', () => {
    const running = stateOf({ turns: [turn('one'), turn('two', 'active')], runtime: 'active-in-fractal' });

    expect(canForkAt(running, 'two', 'before', false)).toBe(true);
    expect(canForkAt(running, 'one', 'before', false)).toBe(true);
    expect(canForkAt(stateOf({ turns: [turn('one', 'active'), turn('two')], runtime: 'active-in-fractal' }), 'two', 'before', false)).toBe(false);
  });
});

describe('forkDraftOf', () => {
  const message: ConversationTurn = {
    ...turn('one'),
    userMessage: {
      id: 'message-one',
      text: 'Try again',
      images: [{ mediaType: 'image/png', data: 'AAA' }],
      attachments: [{ path: '/p/a.ts', kind: 'file' }, { path: '/p/b.png', kind: 'image' }],
    },
  };

  test('carries the text, inline images as data URLs and attachments by path', () => {
    expect(forkDraftOf(message)).toEqual({
      text: 'Try again',
      files: [
        { filename: 'image.png', mediaType: 'image/png', url: 'data:image/png;base64,AAA' },
        { filename: 'a.ts', mediaType: 'application/octet-stream', url: '', path: '/p/a.ts' },
        { filename: 'b.png', mediaType: 'application/octet-stream', url: '', path: '/p/b.png' },
      ],
    });
  });

  test('sends back as it was: inline images as bytes and attachments by path', () => {
    const files = forkDraftOf(message).files.map((file) => ({ ...file, type: 'file' as const, id: file.filename }));

    expect(promptAttachments(files)).toEqual([
      { kind: 'bytes', name: 'image.png', mediaType: 'image/png', data: 'AAA' },
      { kind: 'path', path: '/p/a.ts' },
      { kind: 'path', path: '/p/b.png' },
    ]);
  });

  test('names a Windows path\'s attachment after its last segment', () => {
    const windows: ConversationTurn = { ...message, userMessage: { ...message.userMessage, images: [], attachments: [{ path: 'C:\\p\\a.ts', kind: 'file' }] } };
    expect(forkDraftOf(windows).files).toEqual([{ filename: 'a.ts', mediaType: 'application/octet-stream', url: '', path: 'C:\\p\\a.ts' }]);
  });

  test('is just the text for a plain message', () => {
    expect(forkDraftOf(turn('one'))).toEqual({ text: 'one', files: [] });
  });
});

describe('fork draft store', () => {
  test('keeps a conversation\'s draft until it is cleared', () => {
    const draft: ForkDraft = { text: 'Try again', files: [] };
    setForkDraft('key-1', draft);

    expect(forkDraft('key-1')).toBe(draft);
    expect(forkDraft('key-2')).toBeUndefined();

    clearForkDraft('key-1');
    expect(forkDraft('key-1')).toBeUndefined();
  });
});
