// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ConversationTurn as ConversationTurnData, ForkPoint, TurnBlock } from '@/shared/conversation-contract';
import { ConversationTurn, splitTurnWork, TurnForkContext, type TurnForkActions } from './conversation-turn';

afterEach(cleanup);

const prose = (id: string, concludesTurn = false): TurnBlock => ({ id, kind: 'assistant-prose', text: id, provider: 'claude', ...(concludesTurn ? { concludesTurn: true as const } : {}) });
const packet = (id: string): TurnBlock => ({ id, kind: 'work-packet', status: 'completed', actions: [] });
const turn = (blocks: TurnBlock[], status: ConversationTurnData['status'] = 'completed'): ConversationTurnData => ({
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

  test('keeps notices that open the turn out of the work', () => {
    const notice: TurnBlock = { id: 'n1', kind: 'system-notice', message: 'Background command finished', tone: 'info' };
    const { lead, work, answer } = splitTurnWork(turn([notice, packet('p1'), prose('a1', true)]));
    expect(ids(lead)).toEqual(['n1']);
    expect(ids(work)).toEqual(['p1']);
    expect(ids(answer)).toEqual(['a1']);
    expect(splitTurnWork(turn([notice, prose('a1', true)]))).toMatchObject({ lead: [], work: [], answer: [{ id: 'n1' }, { id: 'a1' }] });
  });

  test('lifts the plan out of the work into its own fold', () => {
    const plan: TurnBlock = { id: 'plan', kind: 'plan', provider: 'claude', proposals: [{ id: 'p1', status: 'approved', text: '# Plan' }] };
    const { plans, work, answer } = splitTurnWork(turn([packet('p1'), plan, packet('p2'), prose('a1', true)]));
    expect(ids(plans)).toEqual(['plan']);
    expect(ids(work)).toEqual(['p1', 'p2']);
    expect(ids(answer)).toEqual(['a1']);
  });

  test('lifts answered questions out of the work so the answers stay in view', () => {
    const question: TurnBlock = { id: 'q1', kind: 'question', request: { id: 'q1', kind: 'question', provider: 'claude', questions: [{ fieldId: 'Size?', prompt: 'Size?', allowFreeText: true }], status: 'resolved', decision: { kind: 'answer', answers: { 'Size?': 'Large' } } } };
    const { questions, work, answer } = splitTurnWork(turn([packet('p1'), question, packet('p2'), prose('a1', true)]));
    expect(ids(questions)).toEqual(['q1']);
    expect(ids(work)).toEqual(['p1', 'p2']);
    expect(ids(answer)).toEqual(['a1']);
  });

  test('leaves running, unmarked, and answer-only turns whole', () => {
    const blocks = [packet('p1'), prose('a1', true)];
    expect(splitTurnWork(turn(blocks, 'active')).work).toEqual([]);
    expect(splitTurnWork(turn([packet('p1'), prose('a1')], 'interrupted')).work).toEqual([]);
    expect(splitTurnWork(turn([prose('a1', true)])).work).toEqual([]);
  });
});

describe('ConversationTurn copy button', () => {
  const copyButton = () => screen.queryByRole('button', { name: /Copy response/ });

  test('appears once an answer is recorded, even while the turn still reads as active', () => {
    render(<ConversationTurn onResolve={() => undefined} turn={turn([packet('p1'), prose('a1', true)], 'active')} />);
    expect(copyButton()).toBeTruthy();
  });

  test('stays hidden on a running turn with no recorded answer', () => {
    render(<ConversationTurn onResolve={() => undefined} turn={turn([packet('p1'), prose('status')], 'active')} />);
    expect(copyButton()).toBeNull();
  });

  test('also copies the user message, and both reveal only on hover or focus', () => {
    render(<ConversationTurn onResolve={() => undefined} turn={turn([prose('a1', true)])} />);
    // jsdom has no hover, so this pins the rule; the reveal itself was checked in the running app.
    for (const button of [screen.getByRole('button', { name: 'Copy message' }), copyButton()]) {
      expect(button?.parentElement?.className).toContain('opacity-0');
      expect(button?.parentElement?.className).toContain('group-hover/copy:opacity-100');
    }
  });
});

describe('ConversationTurn fork button', () => {
  const forkButtons = () => screen.queryAllByRole('button', { name: 'Fork from here' });
  const renderWith = (actions: TurnForkActions | null, data: ConversationTurnData) => render(
    <TurnForkContext.Provider value={actions}><ConversationTurn onResolve={() => undefined} turn={data} /></TurnForkContext.Provider>,
  );

  test('forks before the user message and after the reply', () => {
    const fork = vi.fn<TurnForkActions['fork']>();
    const data = turn([prose('a1', true)]);
    renderWith({ can: () => true, fork }, data);
    const message = screen.getByRole('button', { name: 'Copy message' }).closest('.group\\/copy') as HTMLElement;
    const reply = screen.getByLabelText('Agent response');
    const [before, after] = forkButtons();
    expect(message.contains(before)).toBe(true);
    expect(reply.contains(after)).toBe(true);
    fireEvent.click(before);
    expect(fork).toHaveBeenLastCalledWith(data, 'before');
    fireEvent.click(after);
    expect(fork).toHaveBeenLastCalledWith(data, 'after');
  });

  test('leaves out the button at a point the context refuses', () => {
    const allow = (allowed: ForkPoint['position']): TurnForkActions => ({ can: (_turn, position) => position === allowed, fork: vi.fn() });
    renderWith(allow('after'), turn([prose('a1', true)]));
    expect(forkButtons()).toHaveLength(1);
    expect(screen.getByLabelText('Agent response').contains(forkButtons()[0])).toBe(true);
    cleanup();
    renderWith(allow('before'), turn([prose('a1', true)]));
    expect(forkButtons()).toHaveLength(1);
    expect(screen.getByLabelText('Agent response').contains(forkButtons()[0])).toBe(false);
  });

  test('is absent without a context, as on the map', () => {
    render(<ConversationTurn onResolve={() => undefined} turn={turn([prose('a1', true)])} />);
    expect(forkButtons()).toHaveLength(0);
  });

  test('shows on a reply with no copyable text', () => {
    renderWith({ can: () => true, fork: vi.fn() }, turn([packet('p1')]));
    expect(screen.queryByRole('button', { name: 'Copy response' })).toBeNull();
    expect(screen.getByLabelText('Agent response').contains(forkButtons().at(-1) ?? null)).toBe(true);
  });
});

describe('ConversationTurn plan', () => {
  test('folds the plan under its outcome and hides the approval it replaces', () => {
    const plan: TurnBlock = { id: 'plan', kind: 'plan', provider: 'claude', proposals: [
      { id: 'p1', status: 'rejected', text: '# Draft', feedback: 'Add JSDoc' },
      { id: 'p2', status: 'approved', text: '# Final' },
    ] };
    const approval: TurnBlock = { id: 'p2', kind: 'approval', request: { id: 'p2', kind: 'approval', provider: 'claude', title: 'Review plan', operation: 'ExitPlanMode', plan: '# Final', status: 'resolved', decision: { kind: 'allow-once' } } };
    render(<ConversationTurn onResolve={() => undefined} turn={turn([packet('p1'), plan, approval, prose('a1', true)])} />);
    expect(screen.getByRole('button', { name: 'Plan · Approved after 1 revision' })).toBeTruthy();
    expect(screen.queryByText('Review plan')).toBeNull();
  });
});

describe('ConversationTurn message text', () => {
  // jsdom has no layout, so this pins the rule; the wrapping itself was checked in the running app.
  test('lets an unbroken run wrap in both the user and the agent message', () => {
    const run = 'x'.repeat(400);
    const answer: TurnBlock = { id: 'answer', kind: 'assistant-prose', text: `agent ${run}`, provider: 'claude', concludesTurn: true };
    render(<ConversationTurn onResolve={() => undefined} turn={{ ...turn([answer]), userMessage: { id: 'u', text: `user ${run}` } }} />);
    expect(screen.getByText(`user ${run}`).closest('.wrap-anywhere')).not.toBeNull();
    expect(screen.getByText(`agent ${run}`).closest('.wrap-anywhere')).not.toBeNull();
  });
});

describe('ConversationTurn spacing', () => {
  // `space-y-*` spaces blocks with a margin on each one, which an element without its own box
  // (`display: contents`) drops, so every block must render inside a box.
  test('renders each block of the response in a box of its own', () => {
    const unsupported: TurnBlock = { id: 'u1', kind: 'unsupported', provider: 'claude', nativeType: 'system', summary: 'Unsupported Claude activity: system', captureCompleteness: 'partial' };
    render(<ConversationTurn onResolve={() => undefined} turn={turn([prose('answer', true), unsupported])} />);
    const blocks = [...screen.getByLabelText('Agent response').children];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) expect(block.classList.contains('contents')).toBe(false);
  });
});
