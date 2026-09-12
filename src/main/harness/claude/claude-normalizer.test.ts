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
});
