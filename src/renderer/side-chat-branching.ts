import type { ConversationState } from '@/renderer/conversation-reducer';
import { BUSY_RUNTIMES, type ConversationRuntime, type ConversationTurn } from '@/shared/conversation-contract';

/** Whether a side chat can branch from this turn. A history may never record a turn's end, so an active turn is only in progress while its conversation is busy. */
export function canBranchTurn(turn: ConversationTurn, runtime: ConversationRuntime, readOnly: boolean): boolean {
  return !readOnly && !(turn.status === 'active' && BUSY_RUNTIMES.has(runtime));
}

/** The latest turn a side chat can branch from, or null; null too until the history is complete. */
export function latestBranchableTurn(state: ConversationState, readOnly: boolean): ConversationTurn | null {
  if (state.history !== 'complete') return null;
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = state.turns[index];
    if (canBranchTurn(turn, state.runtime, readOnly)) return turn;
  }
  return null;
}
