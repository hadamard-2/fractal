// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ConversationRef, HarnessStatus, ProjectConversationGroup } from '@/shared/conversation-contract';
import type { FractalSettings } from '@/shared/settings-contract';
import { SidebarProvider } from '@/components/ui/sidebar';
import NavMain, { sidebarMoveAtIndices, type NavSelection } from './nav-main';

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
const codex: HarnessStatus = { provider: 'codex', availability: 'available', capabilities: { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false } };

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
  onSelect: (item: NavSelection) => void = vi.fn(),
  onCreated: (ref: ConversationRef) => void = vi.fn()
) {
  return render(
    <SidebarProvider>
      <NavMain groups={groups} onCreated={onCreated} onSelect={onSelect} providers={[codex]} selected={selected} />
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
    expect(screen.getByRole('button', { name: 'Fix parser, Claude Code conversation, Working elsewhere' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review IPC, Codex conversation, Waiting for you' })).toBeTruthy();
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

  test('maps sortable positions to project and chat moves within their own lists', () => {
    expect(sidebarMoveAtIndices([fractalGroup, atlasGroup], 'projects', 1, 0)).toEqual({
      kind: 'project', source: '/work/atlas', target: '/work/fractal',
    });
    expect(sidebarMoveAtIndices([fractalGroup, atlasGroup], 'chat:/work/fractal', 1, 0)).toEqual({
      kind: 'chat', projectPath: '/work/fractal', source: 'codex:codex-thread-1', target: 'claude:claude-session-1',
    });
    expect(sidebarMoveAtIndices([fractalGroup, atlasGroup], 'chat:/work/atlas', 1, 0)).toBeNull();
    expect(sidebarMoveAtIndices([fractalGroup, atlasGroup], 'projects', 0, 0)).toBeNull();
  });

  test('uses the project and chat rows as drag targets without leading handles', async () => {
    render(
      <SidebarProvider>
        <NavMain groups={[fractalGroup, atlasGroup]} onCreated={vi.fn()} onMoveProject={vi.fn()} onMoveChat={vi.fn()} onSelect={vi.fn()} providers={[codex]} selected={null} />
      </SidebarProvider>
    );
    expect(screen.queryByRole('button', { name: /Move Atlas|Move Fractal/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fractal' }));
    expect(screen.queryByRole('button', { name: /Move Review IPC|Move Fix parser/ })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fractal' }));
    expect(screen.getByRole('button', { name: 'Fractal' }).getAttribute('aria-expanded')).toBe('false');
  });

  test('keeps chat titles neutral and uses trailing provider markers without status icons', async () => {
    renderNav();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fractal' }));

    const claudeChat = screen.getByRole('button', { name: 'Fix parser, Claude Code conversation, Working elsewhere' });
    const codexChat = screen.getByRole('button', { name: 'Review IPC, Codex conversation, Waiting for you' });
    expect(claudeChat.textContent).toBe('Fix parser');
    expect(codexChat.textContent).toBe('Review IPC');
    expect(claudeChat.querySelector('[title="Working elsewhere"]')).toBeNull();
    expect(codexChat.querySelector('[title="Waiting for you"]')).toBeNull();
    expect(claudeChat.querySelector('[title="Claude Code"]')).toBeTruthy();
    expect(codexChat.querySelector('[title="Codex"]')).toBeTruthy();
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
          onCreated={vi.fn()}
          selected={null}
          onSelect={vi.fn()}
          providers={[codex]}
        />
      </SidebarProvider>
    );

    expect(screen.queryByText('Fix parser again')).toBeNull();
  });

  test('marks only the selected native conversation as current', () => {
    renderNav([fractalGroup], { ...fractalGroup.conversations[0].ref });
    expect(screen.getByRole('button', { name: /Fix parser/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: /Review IPC/ }).getAttribute('aria-current')).toBeNull();
    expect(screen.getByRole('button', { name: 'Fractal' }).getAttribute('data-active')).toBe('false');
  });

  test('keeps inactive projects closed when one is selected', () => {
    renderNav([atlasGroup, fractalGroup], fractalGroup.conversations[0].ref);
    expect(screen.getByText('Fix parser')).toBeTruthy();
    expect(screen.queryByText('Map routes')).toBeNull();
  });

  test('offers a new chat action on a closed project without expanding it', async () => {
    const user = userEvent.setup();
    const create = vi.fn(async () => fractalGroup.conversations[0].ref);
    const onCreated = vi.fn();
    Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { create }, settings: { get: async (): Promise<FractalSettings> => ({ theme: 'system', defaultCodingAgent: 'ask', sidebarOrder: { projects: [], chatsByProject: {} } }) } } });
    renderNav([fractalGroup], null, vi.fn(), onCreated);

    const project = screen.getByRole('button', { name: 'Fractal' });
    expect(project.getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'New chat in Fractal' }));
    expect(project.getAttribute('aria-expanded')).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Codex' }));
    expect(create).toHaveBeenCalledWith({ provider: 'codex', projectPath: '/work/fractal' });
    expect(onCreated).toHaveBeenCalledWith(fractalGroup.conversations[0].ref);
  });

  test('shows five chats, reveals the rest, and resets after closing the project', async () => {
    const user = userEvent.setup();
    const group: ProjectConversationGroup = {
      ...fractalGroup,
      conversations: Array.from({ length: 7 }, (_, index) => ({
        ...fractalGroup.conversations[0],
        ref: { ...fractalGroup.conversations[0].ref, nativeSessionId: `session-${index + 1}` },
        title: `Chat ${index + 1}`,
      })),
    };
    renderNav([group]);
    await user.click(screen.getByRole('button', { name: 'Fractal' }));
    expect(screen.getByRole('button', { name: /Chat 5/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Chat 6/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show more' }));
    expect(screen.getByRole('button', { name: /Chat 7/ })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Fractal' }));
    await user.click(screen.getByRole('button', { name: 'Fractal' }));
    expect(screen.queryByRole('button', { name: /Chat 6/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show more' })).toBeTruthy();
  });
});
