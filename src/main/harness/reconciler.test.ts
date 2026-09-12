import { describe, expect, test } from 'vitest';
import { nativeEventKey, reconcileNativeEvents, type NativeEvent } from '@/main/harness/reconciler';

const assistantEvent = (nativeId: string, text: string, observedAt: number): NativeEvent => ({
  provider: 'claude',
  nativeId,
  nativeType: 'assistant',
  observedAt,
  payload: { kind: 'assistant-text', turnId: 'turn-1', text, final: false },
});

describe('reconcileNativeEvents', () => {
  test('deduplicates two observations of one native event without reordering later work', () => {
    const first: NativeEvent = { provider: 'claude', nativeId: 'a', nativeType: 'assistant', observedAt: 1, payload: { kind: 'assistant-text', turnId: 't', text: 'Hi', final: true } };
    const next: NativeEvent = { provider: 'claude', nativeId: 'b', nativeType: 'tool_use', observedAt: 2, payload: { kind: 'action-requested', turnId: 't', actionId: 'tool-1', actionKind: 'file-read', label: 'a.ts' } };

    expect(reconcileNativeEvents([first], [first, next])).toEqual([first, next]);
  });

  test('keeps an incoming replacement in the existing event slot', () => {
    const partial = assistantEvent('a', 'Hi', 1);
    const later = assistantEvent('a', 'Hi there', 3);
    const second = assistantEvent('b', 'Next', 2);

    expect(reconcileNativeEvents([partial, second], [later])).toEqual([later, second]);
  });

  test('appends new events in incoming order and replaces duplicate incoming observations in place', () => {
    const first = assistantEvent('a', 'first', 1);
    const second = assistantEvent('b', 'second', 2);
    const finalFirst = assistantEvent('a', 'final', 3);
    const third = assistantEvent('c', 'third', 4);

    expect(reconcileNativeEvents([], [first, second, finalFirst, third])).toEqual([
      finalFirst,
      second,
      third,
    ]);
  });

  test('qualifies native identity with provider', () => {
    const event = assistantEvent('session-event', 'Hi', 1);

    expect(nativeEventKey(event)).toBe('claude:session-event');
  });
});
