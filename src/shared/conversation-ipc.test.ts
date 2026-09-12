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
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'request.resolved', requestId: 'request-1', decision: { kind: 'answer', answers: { field: 'ok' } } })).not.toThrow();
    expect(() => parseConversationStreamEvent({ loadId, seq: 1, ref, type: 'request.resolved', requestId: 'request-1', decision: { kind: 'answer', answers: { field: 'x'.repeat(100_001) } } })).toThrow('Invalid conversation stream event');
  });
});
