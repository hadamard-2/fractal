// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import type { ConversationTurn, TurnBlock } from '@/shared/conversation-contract';
import { splitTurnWork } from './conversation-turn';

const prose = (id: string, concludesTurn = false): TurnBlock => ({ id, kind: 'assistant-prose', text: id, provider: 'claude', ...(concludesTurn ? { concludesTurn: true as const } : {}) });
const packet = (id: string): TurnBlock => ({ id, kind: 'work-packet', status: 'completed', actions: [] });
const turn = (blocks: TurnBlock[], status: ConversationTurn['status'] = 'completed'): ConversationTurn => ({
  id: 't', nativeId: 't', userMessage: { id: 'u', text: 'Go' }, blocks, status, captureCompleteness: 'complete',
});
const ids = (blocks: TurnBlock[]) => blocks.map((block) => block.id);

describe('splitTurnWork', () => {
  test('separates everything before the concluding message as work', () => {
    const { work, answer } = splitTurnWork(turn([packet('p1'), prose('status'), packet('p2'), prose('a1', true), prose('a2', true)]));
    expect(ids(work)).toEqual(['p1', 'status', 'p2']);
    expect(ids(answer)).toEqual(['a1', 'a2']);
  });

  test('uses the last concluding message when a turn continued past an earlier one', () => {
    const { work, answer } = splitTurnWork(turn([prose('first', true), packet('p1'), prose('second', true)]));
    expect(ids(work)).toEqual(['first', 'p1']);
    expect(ids(answer)).toEqual(['second']);
  });

  test('leaves running, unmarked, and answer-only turns whole', () => {
    const blocks = [packet('p1'), prose('a1', true)];
    expect(splitTurnWork(turn(blocks, 'active')).work).toEqual([]);
    expect(splitTurnWork(turn([packet('p1'), prose('a1')], 'interrupted')).work).toEqual([]);
    expect(splitTurnWork(turn([prose('a1', true)])).work).toEqual([]);
  });
});
