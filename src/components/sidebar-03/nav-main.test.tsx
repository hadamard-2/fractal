// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ConversationRef, ProjectConversationGroup } from '@/shared/conversation-contract';
import { SidebarProvider } from '@/components/ui/sidebar';
import NavMain, { type NavSelection } from './nav-main';

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

const atlasGroup: ProjectConversationGroup = {
  projectPath: '/work/atlas',
  displayName: 'Atlas',
  conversations: [{
    ref: {
      provider: 'codex',
      nativeSessionId: 'codex-thread-2',
      projectPath: '/work/atlas',
    },
    title: 'Map routes',
    updatedAt: 0,
    runtime: 'idle',
    captureCompleteness: 'complete',
  }],
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

function renderNav(
  groups: ProjectConversationGroup[] = [fractalGroup],
  selected: ConversationRef | null = null,
  onSelect: (item: NavSelection) => void = vi.fn()
) {
  return render(
    <SidebarProvider>
      <NavMain groups={groups} selected={selected} onSelect={onSelect} />
    </SidebarProvider>
  );
}

describe('NavMain', () => {
  test('starts projects closed and opens one when clicked', async () => {
    renderNav();
    expect(screen.queryByText('Fix parser')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fractal' }));
    expect(screen.getByText('Fix parser')).toBeTruthy();
    expect(screen.getByText('Review IPC')).toBeTruthy();
    expect(screen.getAllByTestId('project-group')).toHaveLength(1);
    expect(screen.getByLabelText('Claude Code conversation')).toBeTruthy();
    expect(screen.getByLabelText('Codex conversation')).toBeTruthy();
  });

  test('preserves main ordering and returns the exact native ref on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderNav([atlasGroup, fractalGroup], null, onSelect);
    expect(screen.getAllByTestId('project-group').map((group) => group.textContent)).toEqual([
      expect.stringContaining('Atlas'),
      expect.stringContaining('Fractal'),
    ]);

    await user.click(screen.getByRole('button', { name: 'Fractal' }));
    await user.click(screen.getByRole('button', { name: /Fix parser/ }));
    expect(onSelect.mock.calls[0][0].ref).toBe(fractalGroup.conversations[0].ref);
  });

  test('keeps an explicitly collapsed project closed when its summaries refresh', async () => {
    const user = userEvent.setup();
    const view = renderNav();
    const refreshedGroup = {
      ...fractalGroup,
      conversations: [
        { ...fractalGroup.conversations[0], title: 'Fix parser again' },
        fractalGroup.conversations[1],
      ],
    };
    await user.click(screen.getByRole('button', { name: 'Fractal' }));
    await user.click(screen.getByRole('button', { name: 'Fractal' }));
    expect(screen.queryByText('Fix parser')).toBeNull();

    view.rerender(
      <SidebarProvider>
        <NavMain
          groups={[refreshedGroup]}
          selected={null}
          onSelect={vi.fn()}
        />
      </SidebarProvider>
    );

    expect(screen.queryByText('Fix parser again')).toBeNull();
  });

  test('marks only the selected native conversation as current', () => {
    renderNav([fractalGroup], { ...fractalGroup.conversations[0].ref });
    expect(screen.getByRole('button', { name: /Fix parser/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /Review IPC/ }).getAttribute('aria-current')).toBeNull();
  });

  test('keeps inactive projects closed when one is selected', () => {
    renderNav([atlasGroup, fractalGroup], fractalGroup.conversations[0].ref);
    expect(screen.getByText('Fix parser')).toBeTruthy();
    expect(screen.queryByText('Map routes')).toBeNull();
  });
});
