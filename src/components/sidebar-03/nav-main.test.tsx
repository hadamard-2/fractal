// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ProjectConversationGroup } from '@/shared/conversation-contract';
import { SidebarProvider } from '@/components/ui/sidebar';
import NavMain from './nav-main';

const fractalGroup: ProjectConversationGroup = {
  projectPath: '/work/fractal',
  displayName: 'Fractal',
  conversations: [
    {
      ref: {
        provider: 'claude',
        nativeSessionId: 'claude-session-1',
        projectPath: '/work/fractal',
      },
      title: 'Fix parser',
      updatedAt: 2,
      runtime: 'active-externally',
      captureCompleteness: 'complete',
    },
    {
      ref: {
        provider: 'codex',
        nativeSessionId: 'codex-thread-1',
        projectPath: '/work/fractal',
      },
      title: 'Review IPC',
      updatedAt: 1,
      runtime: 'waiting-for-user',
      captureCompleteness: 'complete',
    },
  ],
};

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      media: '',
      onchange: null as MediaQueryList['onchange'],
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

afterEach(cleanup);

function renderNav() {
  return render(
    <SidebarProvider>
      <NavMain groups={[fractalGroup]} selected={null} onSelect={vi.fn()} />
    </SidebarProvider>
  );
}

describe('NavMain', () => {
  test('renders mixed providers beneath one project', () => {
    renderNav();
    expect(screen.getByText('Fix parser')).toBeTruthy();
    expect(screen.getByText('Review IPC')).toBeTruthy();
    expect(screen.getAllByTestId('project-group')).toHaveLength(1);
    expect(screen.getByLabelText('Claude Code conversation')).toBeTruthy();
    expect(screen.getByLabelText('Codex conversation')).toBeTruthy();
  });

  test('filters by project title, conversation title, provider, and native ID', async () => {
    const user = userEvent.setup();
    renderNav();
    await user.type(screen.getByRole('searchbox'), 'claude-session-1');
    expect(screen.getByText('Fix parser')).toBeTruthy();
    expect(screen.queryByText('Review IPC')).toBeNull();
  });
});
