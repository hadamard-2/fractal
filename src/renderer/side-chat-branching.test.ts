import { describe, expect, test } from 'vitest';
import { initialConversationState, type ConversationState } from '@/renderer/conversation-reducer';
import { canBranchTurn, latestBranchableTurn } from '@/renderer/side-chat-branching';
import type { ConversationRuntime, ConversationTurn } from '@/shared/conversation-contract';

const turn = (id: string, status: ConversationTurn['status'] = 'completed'): ConversationTurn => ({
  id, nativeId: id, userMessage: { id: `${id}-user`, text: 'Ask' }, blocks: [], status, captureCompleteness: 'complete',
});
const state = (turns: ConversationTurn[], runtime: ConversationRuntime = 'idle', history: ConversationState['history'] = 'complete'): ConversationState => ({ ...initialConversationState, turns, runtime, history });

describe('canBranchTurn', () => {
  test('a read-only conversation never branches', () => {
    expect(canBranchTurn(turn('t1'), 'idle', true)).toBe(false);
  });

  test('a completed turn branches whatever the runtime', () => {
    expect(canBranchTurn(turn('t1'), 'idle', false)).toBe(true);
    expect(canBranchTurn(turn('t1'), 'active-in-fractal', false)).toBe(true);
  });

  test.each(['active-in-fractal', 'active-externally', 'waiting-for-user'] as const)('an active turn does not branch while the runtime is %s', (runtime) => {
    expect(canBranchTurn(turn('t1', 'active'), runtime, false)).toBe(false);
  });

  test('an active turn branches while idle, since a history may never record the turn\'s end', () => {
    expect(canBranchTurn(turn('t1', 'active'), 'idle', false)).toBe(true);
  });
});

describe('latestBranchableTurn', () => {
  test('is null until the history is complete', () => {
    expect(latestBranchableTurn(state([turn('t1')], 'idle', 'loading'), false)).toBeNull();
    expect(latestBranchableTurn(state([turn('t1')], 'idle', 'failed'), false)).toBeNull();
  });

  test('is null with no turns', () => {
    expect(latestBranchableTurn(state([]), false)).toBeNull();
  });

  test('is the last turn when it can branch', () => {
    expect(latestBranchableTurn(state([turn('t1'), turn('t2')]), false)?.id).toBe('t2');
  });

  test('skips an active last turn while the runtime is busy', () => {
    expect(latestBranchableTurn(state([turn('t1'), turn('t2', 'active')], 'active-in-fractal'), false)?.id).toBe('t1');
  });

  test('is null when the busy active turn was the only one', () => {
    expect(latestBranchableTurn(state([turn('t1', 'active')], 'waiting-for-user'), false)).toBeNull();
  });

  test('is null when read-only', () => {
    expect(latestBranchableTurn(state([turn('t1')]), true)).toBeNull();
  });
});
