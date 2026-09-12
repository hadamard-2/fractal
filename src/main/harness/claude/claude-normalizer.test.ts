import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { createClaudeNormalizationContext, normalizeClaudeRecord, type ClaudeHistoryRecord } from '@/main/harness/claude/claude-normalizer';

const completeFixturePath = path.join(import.meta.dirname, '__fixtures__', 'complete-session.jsonl');

async function completeRecords(): Promise<ClaudeHistoryRecord[]> {
  return (await readFile(completeFixturePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ClaudeHistoryRecord);
}

describe('normalizeClaudeRecord', () => {
  test('preserves content block ordering and stable IDs across a user, prose, thinking, and tool use', async () => {
    const records = await completeRecords();
    const events = records.slice(0, 2).flatMap((record, ordinal) => normalizeClaudeRecord(record, ordinal));

    expect(events.map((event) => event.nativeId)).toEqual([
      'user-1',
      'assistant-1:text:0',
      'assistant-1:thinking:1',
      'tool-parent',
    ]);
    expect(events.map((event) => event.payload.kind)).toEqual([
      'turn-started',
      'assistant-text',
      'assistant-text',
      'action-requested',
    ]);
    expect(events[2].payload).toMatchObject({ text: 'Provider-supplied thinking: I should trace the decoder first.' });
    expect(events[3].payload).toMatchObject({ actionId: 'tool-parent', actionKind: 'subagent', label: 'Inspect decoder' });
  });

  test('links sidechain work and tool results to their native parent action', async () => {
    const records = await completeRecords();
    const context = createClaudeNormalizationContext();
    records.slice(0, 2).flatMap((record, ordinal) => normalizeClaudeRecord(record, ordinal, context));
    const events = records.slice(2, 4).flatMap((record, ordinal) => normalizeClaudeRecord(record, ordinal + 2, context));

    expect(events[0]).toMatchObject({
      nativeId: 'tool-child',
      payload: { kind: 'action-requested', turnId: 'user-1', actionId: 'tool-child', actionKind: 'subagent', parentActionId: 'tool-parent' },
    });
    expect(events[1]).toMatchObject({
      nativeId: 'tool-result-1:tool-child:0',
      payload: { kind: 'action-updated', turnId: 'user-1', actionId: 'tool-child', status: 'completed' },
    });
  });

  test('normalizes resolved questions only when all documented request fields are present', async () => {
    const records = await completeRecords();
    const question = records[4];
    const context = createClaudeNormalizationContext();
    records.slice(0, 4).flatMap((record, ordinal) => normalizeClaudeRecord(record, ordinal, context));

    expect(normalizeClaudeRecord(question, 4, context).map((event) => event.payload)).toEqual([
      {
        kind: 'request-opened',
        turnId: 'user-1',
        request: {
          id: 'question-1',
          kind: 'question',
          provider: 'claude',
          prompt: 'Continue?',
          fieldId: 'continue',
          choices: [{ value: 'yes', label: 'Yes' }],
          allowFreeText: false,
          status: 'open',
        },
      },
      { kind: 'request-resolved', turnId: 'user-1', requestId: 'question-1', decision: { kind: 'answer', answers: { continue: 'yes' } } },
    ]);
  });

  test('keeps unknown and image activity visible without exposing raw payloads', () => {
    const unknown = normalizeClaudeRecord({ type: 'future_event', uuid: 'future-1', secret: 'never expose' }, 7);
    const image = normalizeClaudeRecord({ type: 'assistant', uuid: 'image-1', message: { role: 'assistant', content: [{ type: 'image', source: 'never expose' }] } }, 8);

    expect(unknown[0]).toMatchObject({ nativeId: 'future-1', nativeType: 'future_event', payload: { kind: 'unsupported', summary: 'Unsupported Claude activity: future_event (fields: secret, type, uuid)', captureCompleteness: 'partial' } });
    expect(JSON.stringify(unknown[0])).not.toContain('never expose');
    expect(image[0]).toMatchObject({ nativeType: 'image', payload: { kind: 'unsupported', captureCompleteness: 'partial' } });
    expect(JSON.stringify(image[0])).not.toContain('never expose');
  });

  test('preserves user and tool-result array activity in order', () => {
    const context = createClaudeNormalizationContext();
    const user = normalizeClaudeRecord({
      type: 'user', uuid: 'array-user', message: { id: 'array-user-message', role: 'user', content: [
        { type: 'text', text: 'Show ' },
        { type: 'image', source: 'never expose' },
        { type: 'future_block', secret: 'never expose' },
      ] },
    }, 1, context);
    const result = normalizeClaudeRecord({
      type: 'user', uuid: 'array-result', parentUuid: 'array-user', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'text', text: 'first' }, { type: 'image', source: 'never expose' }, { type: 'text', text: 'second' }] },
      ] },
    }, 2, context);

    expect(user.map((event) => event.payload.kind)).toEqual(['turn-started', 'unsupported', 'unsupported']);
    expect(result.map((event) => event.payload.kind)).toEqual(['action-updated', 'unsupported', 'action-updated']);
    expect(result.map((event) => event.nativeType)).toEqual(['tool_result', 'image', 'tool_result']);
    expect(result.at(-1)?.payload).toMatchObject({ output: 'first\nsecond' });
    expect(JSON.stringify([...user, ...result])).not.toContain('never expose');
  });

  test('uses message IDs before ordinal fallbacks and refuses unknown terminal states', () => {
    const record = { type: 'assistant', message: { id: 'message-only', role: 'assistant', content: [{ type: 'text', text: 'Stable' }] } };

    expect(normalizeClaudeRecord(record, 3)[0]?.nativeId).toBe('message-only:text:0');
    expect(normalizeClaudeRecord(record, 99)[0]?.nativeId).toBe('message-only:text:0');
    expect(normalizeClaudeRecord({ type: 'result', uuid: 'unknown-result', subtype: 'future-state' }, 4)[0]).toMatchObject({
      nativeType: 'result',
      payload: { kind: 'unsupported', captureCompleteness: 'partial' },
    });
  });

  test('keeps assistant and tool-result block events in source order and quarantines malformed text blocks', () => {
    const context = createClaudeNormalizationContext();
    const assistant = normalizeClaudeRecord({
      type: 'assistant', uuid: 'ordered-assistant', message: { role: 'assistant', content: [
        { type: 'text', text: 'first' }, { type: 'image', source: 'hidden' }, { type: 'text', text: 'second' },
      ] },
    }, 1, context);
    const result = normalizeClaudeRecord({
      type: 'user', uuid: 'ordered-result', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'tool-order', content: [{ type: 'text', text: 'first' }, { type: 'image', source: 'hidden' }, { type: 'text', text: 'second' }] },
      ] },
    }, 2, context);
    const malformedUser = normalizeClaudeRecord({
      type: 'user', uuid: 'bad-user', message: { role: 'user', content: [{ type: 'text', text: 123 }] },
    }, 3, context);

    expect(assistant.map((event) => event.nativeType)).toEqual(['text', 'image', 'text']);
    expect(result.map((event) => event.nativeType)).toEqual(['tool_result', 'image', 'tool_result']);
    expect(result.map((event) => event.payload.kind)).toEqual(['action-updated', 'unsupported', 'action-updated']);
    expect(malformedUser.map((event) => event.payload.kind)).toEqual(['turn-started', 'unsupported']);
    expect(malformedUser[1]?.payload).toMatchObject({ captureCompleteness: 'partial' });
  });

  test.each([
    {
      name: 'text separated by an image',
      content: [{ type: 'text', text: 'first' }, { type: 'image', source: 'hidden' }, { type: 'text', text: 'second' }],
      text: 'first\nsecond',
      unsupportedIds: ['ordered-user:image:1'],
      unsupportedTypes: ['image'],
    },
    {
      name: 'an image before the first text',
      content: [{ type: 'image', source: 'hidden' }, { type: 'text', text: 'after' }],
      text: 'after',
      unsupportedIds: ['ordered-user:image:0'],
      unsupportedTypes: ['image'],
    },
    {
      name: 'multiple unsupported blocks around text',
      content: [
        { type: 'future_block', secret: 'hidden' }, { type: 'text', text: 'first' },
        { type: 'image', source: 'hidden' }, { type: 'text', text: '' },
        { type: 'text', text: 123 }, null, { type: 'text', text: ' last ' },
      ],
      text: 'first\n\n last ',
      unsupportedIds: ['ordered-user:future_block:0', 'ordered-user:image:2', 'ordered-user:text:4', 'ordered-user:unknown-content:5'],
      unsupportedTypes: ['future_block', 'image', 'text', 'unknown-content'],
    },
    {
      name: 'no valid text',
      content: [{ type: 'image', source: 'hidden' }, { type: 'text', text: 123 }, null, { type: 'future_block', secret: 'hidden' }],
      text: '',
      unsupportedIds: ['ordered-user:image:0', 'ordered-user:text:1', 'ordered-user:unknown-content:2', 'ordered-user:future_block:3'],
      unsupportedTypes: ['image', 'text', 'unknown-content', 'future_block'],
    },
  ])('keeps user authorship and an atomic anchor with $name', ({ content, text, unsupportedIds, unsupportedTypes }) => {
    const record = {
      type: 'user', uuid: 'ordered-user', timestamp: '2026-09-12T00:00:00Z',
      message: { id: 'user-message', role: 'user', content },
    };
    const events = normalizeClaudeRecord(record, 1, createClaudeNormalizationContext());

    expect(events.some((event) => event.payload.kind === 'assistant-text')).toBe(false);
    expect(events.filter((event) => event.payload.kind === 'turn-started')).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'claude', nativeId: 'ordered-user', nativeType: 'user',
      payload: { kind: 'turn-started', userMessageId: 'user-message', text, turnId: 'ordered-user' },
    });
    expect(events.slice(1).map((event) => event.nativeId)).toEqual(unsupportedIds);
    expect(events.slice(1).map((event) => event.nativeType)).toEqual(unsupportedTypes);
    for (const event of events.slice(1)) {
      expect(event).toMatchObject({
        provider: 'claude',
        payload: { kind: 'unsupported', turnId: 'ordered-user', captureCompleteness: 'partial' },
      });
      expect(event.payload).toHaveProperty('summary', expect.stringContaining(event.nativeType));
    }
    expect(JSON.stringify(events)).not.toContain('hidden');
    expect(normalizeClaudeRecord(record, 99, createClaudeNormalizationContext())).toEqual(events);
  });

  test('quarantines user-authored carrier siblings without changing tool-result updates', () => {
    const record = {
      type: 'user', uuid: 'carrier', parentUuid: 'user-turn', message: { role: 'user', content: [
        { type: 'text', text: 'hidden user text' },
        { type: 'tool_result', tool_use_id: 'tool-1', content: 'Tool output' },
        { type: 'thinking', thinking: 'hidden user thinking' },
        { type: 'image', source: 'hidden image' },
      ] },
    };
    const events = normalizeClaudeRecord(record, 1, createClaudeNormalizationContext());

    expect(events.some((event) => event.payload.kind === 'assistant-text')).toBe(false);
    expect(events.map((event) => event.payload.kind)).toEqual(['unsupported', 'action-updated', 'unsupported', 'unsupported']);
    expect(events.map((event) => event.nativeId)).toEqual(['carrier:text:0', 'carrier:tool-1:1', 'carrier:thinking:2', 'carrier:image:3']);
    expect(events[1].payload).toMatchObject({ kind: 'action-updated', turnId: 'user-turn', actionId: 'tool-1', output: 'Tool output', status: 'completed' });
    for (const event of [events[0], events[2], events[3]]) {
      expect(event).toMatchObject({ provider: 'claude', payload: { kind: 'unsupported', turnId: 'user-turn', captureCompleteness: 'partial' } });
    }
    expect(JSON.stringify(events)).not.toContain('hidden');
    expect(normalizeClaudeRecord(record, 99, createClaudeNormalizationContext()).map((event) => event.nativeId)).toEqual(events.map((event) => event.nativeId));
  });
});
