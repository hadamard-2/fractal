// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentAction, TurnBlock } from '@/shared/conversation-contract';
import { WorkPacket } from './work-packet';

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

    expect(screen.getByText('pnpm lint')).toBeTruthy();

    rerender(<WorkPacket packet={completedPacket} />);

    expect(screen.getByText('1 command completed')).toBeTruthy();
    expect(screen.queryByText('pnpm lint')).toBeNull();
  });

  test('a packet opens when its status becomes active', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<WorkPacket packet={completedPacket} />);

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
});
