import { describe, expect, test } from 'vitest';
import { parseConversationStreamEvent, parseLoadId } from '@/shared/conversation-ipc';

const loadId = 'abcdef12-3456-4abc-8def-1234567890ab';
const ref = { provider: 'codex' as const, nativeSessionId: 'session-1', projectPath: '/work/fractal' };

const action = {
  id: 'action-1',
  nativeId: 'native-action-1',
  provider: 'codex' as const,
  status: 'completed' as const,
  captureCompleteness: 'complete' as const,
  kind: 'command' as const,
  command: 'pnpm test',
  cwd: '/work/fractal',
  output: 'passed',
  exitCode: 0,
};

const turn = {
  id: 'turn-1',
  nativeId: 'native-turn-1',
  userMessage: { id: 'message-1', text: 'Run the tests', createdAt: 1 },
  blocks: [
    { id: 'prose-1', kind: 'assistant-prose' as const, text: 'I will run them.', provider: 'codex' as const },
    { id: 'packet-1', kind: 'work-packet' as const, status: 'completed' as const, actions: [action], startedAt: 1, completedAt: 2 },
    { id: 'prose-2', kind: 'assistant-prose' as const, text: 'Done.', provider: 'codex' as const, concludesTurn: true as const },
  ],
  status: 'completed' as const,
  captureCompleteness: 'complete' as const,
};

const summary = {
  ref,
  title: 'Test session',
  updatedAt: 2,
  createdAt: 1,
  runtime: 'idle' as const,
  captureCompleteness: 'complete' as const,
};

describe('native conversation event validation', () => {
  test('accepts and clones a complete history chunk', () => {
    const input = { loadId, seq: 1, ref, type: 'history.chunk' as const, chunkIndex: 0, turns: [turn] };
    const parsed = parseConversationStreamEvent(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(parsed.ref).not.toBe(ref);
    expect(parsed.type).toBe('history.chunk');
  });

  test('rejects malformed envelopes and unknown event kinds', () => {
    expect(() => parseConversationStreamEvent({ loadId, seq: -1, ref, type: 'history.complete' })).toThrow('Invalid conversation stream event');
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'history.unknown' })).toThrow('Invalid conversation stream event');
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'assistant.delta', turnId: 'turn-1', blockId: 'block-1', delta: 'x'.repeat(1_000_001) })).toThrow('Invalid conversation stream event');
  });

  test('validates nested requests and actions instead of trusting a cast', () => {
    expect(() => parseConversationStreamEvent({
      loadId,
      seq: 1,
      ref,
      type: 'request.opened',
      request: { id: 'request-1', kind: 'approval', provider: 'codex', title: 'Run command', operation: 'pnpm test', status: 'open' },
    })).not.toThrow();

    expect(() => parseConversationStreamEvent({
      loadId,
      seq: 1,
      ref,
      type: 'request.opened',
      request: { id: 'request-1', kind: 'approval', provider: 'codex', title: 'Run command', operation: 'pnpm test', status: 'open', decision: { kind: 'allow-forever' } },
    })).toThrow('Invalid conversation stream event');

    expect(() => parseConversationStreamEvent({
      loadId,
      seq: 1,
      ref,
      type: 'action.upserted',
      turnId: 'turn-1',
      packetId: 'packet-1',
      action: { ...action, kind: 'not-an-action' },
    })).toThrow('Invalid conversation stream event');
  });

  test('caps a history chunk at fifty turns', () => {
    const turns = Array.from({ length: 51 }, (_, index) => ({ ...turn, id: `turn-${index}` }));
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'history.chunk', chunkIndex: 0, turns })).toThrow('Invalid conversation stream event');
  });

  test('accepts only canonical random UUID load ids', () => {
    expect(parseLoadId(loadId)).toBe(loadId);
    expect(() => parseLoadId('00000000-0000-0000-8000-000000000000')).toThrow('Invalid load id');
    expect(() => parseLoadId(loadId.toUpperCase())).toThrow('Invalid load id');
  });

  test('validates summary and resolved request variants', () => {
    expect(parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'summary.updated', summary })).toEqual({
      loadId,
      seq: 1,
      ref,
      type: 'summary.updated',
      summary,
    });
    const child = { ...summary, parentId: 'parent-session' };
    expect(parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'summary.updated', summary: child })).toMatchObject({ summary: child });
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'summary.updated', summary: { ...summary, parentId: ' ' } })).toThrow('Invalid conversation stream event');
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'request.resolved', requestId: 'request-1', decision: { kind: 'answer', answers: { field: 'ok' } } })).not.toThrow();
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'request.resolved', requestId: 'request-1', decision: { kind: 'answer', answers: { field: 'x'.repeat(100_001) } } })).toThrow('Invalid conversation stream event');
  });

  test('rejects sparse history chunk turns', () => {
    const sparseTurns = new Array(1);
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'history.chunk', chunkIndex: 0, turns: sparseTurns })).toThrow('Invalid conversation stream event');
  });

  test('rejects sparse turn blocks', () => {
    const sparseBlocks = new Array(1);
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'turn.upserted', turn: { ...turn, blocks: sparseBlocks } })).toThrow('Invalid conversation stream event');
  });

  test('rejects sparse subagent actions', () => {
    const sparseActions = new Array(1);
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'turn.upserted', turn: { ...turn, blocks: [{ ...turn.blocks[1], actions: sparseActions }] } })).toThrow('Invalid conversation stream event');
  });

  test('rejects sparse question choices', () => {
    const sparseChoices = new Array(1);
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'request.opened', request: { id: 'request-1', kind: 'question', provider: 'codex', prompt: 'Choose', fieldId: 'choice', choices: sparseChoices, allowFreeText: false, status: 'open' } })).toThrow('Invalid conversation stream event');
  });

  test('accepts user message attachments and rejects relative paths or unknown kinds', () => {
    const attachments = [{ path: '/repo/notes.md', kind: 'file' as const }, { path: '/tmp/shot.png', kind: 'image' as const }];
    const withAttachments = { ...turn, userMessage: { ...turn.userMessage, attachments } };
    expect(parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'turn.upserted', turn: withAttachments })).toMatchObject({ turn: withAttachments });
    for (const bad of [[{ path: 'notes.md', kind: 'file' }], [{ path: '/repo/a', kind: 'video' }], { path: '/repo/a', kind: 'file' }]) {
      const turnWithBad = { ...turn, userMessage: { ...turn.userMessage, attachments: bad } };
      expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'turn.upserted', turn: turnWithBad })).toThrow('Invalid conversation stream event');
    }
  });

  test('accepts inline images on user messages and actions, and rejects unknown image types', () => {
    const images = [{ mediaType: 'image/png' as const, data: 'AAA' }];
    const withImages = { ...turn, userMessage: { ...turn.userMessage, images }, blocks: [{ ...turn.blocks[1], actions: [{ ...action, images }] }] };
    expect(parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'turn.upserted', turn: withImages })).toMatchObject({ turn: withImages });
    const svg = { ...turn, userMessage: { ...turn.userMessage, images: [{ mediaType: 'image/svg+xml', data: 'AAA' }] } };
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'turn.upserted', turn: svg })).toThrow('Invalid conversation stream event');
  });
});
