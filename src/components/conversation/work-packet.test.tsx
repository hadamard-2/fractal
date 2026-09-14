// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentAction, TurnBlock } from '@/shared/conversation-contract';
import { WorkPacket, workPacketSummary } from './work-packet';

afterEach(cleanup);

const command = (status: AgentAction['status']): AgentAction => ({
  id: 'command-1', nativeId: 'command-1', provider: 'codex', kind: 'command',
  status, captureCompleteness: 'complete', command: 'pnpm lint', cwd: '/work/fractal',
  output: 'All files pass.', exitCode: 0,
});

const activePacket: Extract<TurnBlock, { kind: 'work-packet' }> = {
  id: 'packet-1', kind: 'work-packet', status: 'active', actions: [command('running')],
};

const completedPacket: Extract<TurnBlock, { kind: 'work-packet' }> = {
  id: 'packet-1', kind: 'work-packet', status: 'completed', actions: [command('completed')],
};

describe('WorkPacket', () => {
  test('active packets are open while completed packets start compact', () => {
    const { rerender } = render(<WorkPacket packet={activePacket} />);

    expect(screen.getByRole('button', { name: '1 command: 1 running' })).toBeTruthy();
    expect(screen.getByText('pnpm lint')).toBeTruthy();

    rerender(<WorkPacket packet={completedPacket} />);

    expect(screen.getByText('1 command completed')).toBeTruthy();
    expect(screen.queryByText('pnpm lint')).toBeNull();
  });

  test('a packet keeps an explicit disclosure choice across status changes', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<WorkPacket packet={activePacket} />);

    await user.click(screen.getByRole('button', { name: '1 command: 1 running' }));
    expect(screen.queryByText('pnpm lint')).toBeNull();

    rerender(<WorkPacket packet={completedPacket} />);
    expect(screen.queryByText('pnpm lint')).toBeNull();

    await user.click(screen.getByRole('button', { name: '1 command completed' }));
    expect(screen.getByText('pnpm lint')).toBeTruthy();

    rerender(<WorkPacket packet={activePacket} />);
    expect(screen.getByText('pnpm lint')).toBeTruthy();
  });

  test('summarizes failed, denied, and interrupted activity exactly', () => {
    const packet: Extract<TurnBlock, { kind: 'work-packet' }> = {
      id: 'packet-2', kind: 'work-packet', status: 'failed', actions: [
        { ...command('failed'), id: 'failed' },
        { ...command('denied'), id: 'denied' },
        { ...command('interrupted'), id: 'interrupted' },
      ],
    };

    render(<WorkPacket packet={packet} />);

    expect(screen.getByText('3 commands: 1 failed, 1 denied, 1 interrupted')).toBeTruthy();
  });

  test('summarizes every action kind and lifecycle state without pluralizing states', () => {
    const action = (kind: AgentAction['kind'], status: AgentAction['status'], id: string): AgentAction => {
      const base = { id, nativeId: id, provider: 'codex' as const, status, captureCompleteness: 'complete' as const };
      switch (kind) {
        case 'file-read': return { ...base, kind, path: '/work/a.ts' };
        case 'file-edit': return { ...base, kind, path: '/work/b.ts' };
        case 'command': return { ...base, kind, command: 'pnpm lint' };
        case 'search': return { ...base, kind, query: 'TODO' };
        case 'tool': return { ...base, kind, name: 'fetch', inputSummary: 'url' };
        case 'subagent': return { ...base, kind, label: 'reviewer', actions: [] };
      }
    };
    const actions = [
      action('file-read', 'requested', 'read'), action('file-edit', 'awaiting-approval', 'edit'),
      action('command', 'running', 'run'), action('command', 'completed', 'done'),
      action('search', 'failed', 'search-1'), action('search', 'failed', 'search-2'),
      action('tool', 'denied', 'tool'), action('subagent', 'interrupted', 'subagent'),
    ];

    expect(workPacketSummary(actions)).toBe('1 file read, 1 file edit, 2 commands, 2 searches, 1 tool, 1 subagent: 1 requested, 1 awaiting approval, 1 running, 1 completed, 2 failed, 1 denied, 1 interrupted');
  });
});
