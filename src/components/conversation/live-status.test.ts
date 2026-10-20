import { describe, expect, test } from 'vitest';
import { formatElapsed, turnActivity } from './live-status';
import type { AgentAction, ConversationTurn, TurnBlock } from '@/shared/conversation-contract';

const base = { nativeId: 'n', provider: 'claude' as const, captureCompleteness: 'complete' as const };
const turn = (blocks: TurnBlock[], status: ConversationTurn['status'] = 'active'): ConversationTurn => ({
  id: 't1', nativeId: 't1', userMessage: { id: 'u1', text: 'Go' }, blocks, status, captureCompleteness: 'complete',
});
const packet = (...actions: AgentAction[]): TurnBlock => ({ id: 'p1', kind: 'work-packet', status: 'active', actions });
const command = (id: string, status: AgentAction['status']): AgentAction => ({ ...base, id, kind: 'command', command: 'pnpm test', status });

describe('turnActivity', () => {
  test('is thinking before the run has a turn, and gone once the turn has finished', () => {
    expect(turnActivity(undefined)).toEqual({ key: 'Thinking', label: 'Thinking' });
    expect(turnActivity(turn([packet(command('a1', 'running'))], 'completed'))).toBeNull();
    expect(turnActivity(turn([], 'failed'))).toBeNull();
  });

  test('is thinking while nothing runs and nothing is being written', () => {
    expect(turnActivity(turn([]))?.label).toBe('Thinking');
    expect(turnActivity(turn([packet(command('a1', 'completed'))]))?.label).toBe('Thinking');
  });

  test('is writing while the latest block is prose', () => {
    expect(turnActivity(turn([{ id: 'x', kind: 'assistant-prose', text: 'Looking', provider: 'claude' }]))?.label).toBe('Writing');
    expect(turnActivity(turn([
      { id: 'x', kind: 'assistant-prose', text: 'Looking', provider: 'claude' },
      { id: 'y', kind: 'unsupported', provider: 'claude', nativeType: 'system', summary: 'Unsupported Claude activity: system', captureCompleteness: 'partial' },
    ]))?.label).toBe('Writing');
  });

  test('names the latest action still in progress, keyed by the action so each one is timed on its own', () => {
    const read: AgentAction = { ...base, id: 'a1', kind: 'file-read', path: '/repo/src/app.tsx', status: 'requested' };
    expect(turnActivity(turn([packet(read)]))).toEqual({ key: 'a1', label: 'Reading app.tsx' });
    expect(turnActivity(turn([{ id: 'x', kind: 'assistant-prose', text: 'First', provider: 'claude' }, packet(read, command('a2', 'running'))]))).toEqual({ key: 'a2', label: 'Running a command' });
    expect(turnActivity(turn([packet(command('a3', 'awaiting-approval'), command('a4', 'completed'))]))?.key).toBe('a3');
  });

  test('labels each kind of action', () => {
    const running = (action: { kind: AgentAction['kind'] } & Record<string, unknown>) => turnActivity(turn([packet({ ...base, id: 'a', status: 'running', ...action } as AgentAction)]))?.label;
    expect(running({ kind: 'file-edit', path: 'C:\\repo\\notes.md' })).toBe('Editing notes.md');
    expect(running({ kind: 'search', query: 'TODO' })).toBe('Searching');
    expect(running({ kind: 'tool', name: 'WebFetch', inputSummary: 'https://example.com' })).toBe('Using WebFetch');
    expect(running({ kind: 'subagent', label: 'Explore', actions: [] })).toBe('Running a subagent');
  });
});

describe('formatElapsed', () => {
  test('counts seconds, then minutes and seconds', () => {
    expect(formatElapsed(-500)).toBe('0s');
    expect(formatElapsed(59_900)).toBe('59s');
    expect(formatElapsed(65_000)).toBe('1m 5s');
    expect(formatElapsed(3_600_000)).toBe('60m 0s');
  });
});
