// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { ExecuteMode } from './execute-mode';

vi.mock('@/components/sidebar-03/app-sidebar', () => ({
  DashboardSidebar({ onItemSelect }: {
    onItemSelect?: (item: {
      ref: { provider: 'claude'; nativeSessionId: string; projectPath: string };
      title: string;
      section: string;
    }) => void;
  }) {
    const ref = { provider: 'claude' as const, nativeSessionId: 'claude-session-1', projectPath: '/work/fractal' };
    return <div>
      <button type="button" onClick={() => onItemSelect?.({ ref, title: 'Fix parser', section: 'Fractal' })}>Select original</button>
      <button type="button" onClick={() => onItemSelect?.({ ref, title: 'Fix parser again', section: 'Fractal next' })}>Select refreshed</button>
    </div>;
  },
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, media: '', onchange: null as MediaQueryList['onchange'], addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }),
  });
});

afterEach(cleanup);

describe('ExecuteMode', () => {
  test('refreshes breadcrumb metadata when the same native ref is selected again', async () => {
    const user = userEvent.setup();
    render(<ExecuteMode onOpenSettings={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Select original' }));
    await user.click(screen.getByRole('button', { name: 'Select refreshed' }));

    expect(screen.getByText('Fractal next')).toBeTruthy();
    expect(screen.getByText('Fix parser again')).toBeTruthy();
    expect(screen.queryByText('Fix parser')).toBeNull();
  });
});
