// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { ConversationRef, ConversationSummary, HarnessStatus, ProjectConversationGroup } from '@/shared/conversation-contract';
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
    const claudeMarker = claudeChat.querySelector('[data-slot="tooltip-trigger"]');
    expect(claudeMarker).toBeTruthy();
    expect(codexChat.querySelector('[data-slot="tooltip-trigger"]')).toBeTruthy();
    fireEvent.pointerMove(claudeMarker as Element);
    expect((await screen.findByRole('tooltip')).textContent).toBe('Claude Code');
  });

  test('hides provider markers when agent color tags are off but keeps the agent in the name', async () => {
    render(
      <SidebarProvider>
        <NavMain groups={[fractalGroup]} onCreated={vi.fn()} onSelect={vi.fn()} providers={[codex]} selected={null} showAgentColorTags={false} />
      </SidebarProvider>
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Fractal' }));
    const claudeChat = screen.getByRole('button', { name: 'Fix parser, Claude Code conversation, Working elsewhere' });
    expect(claudeChat.querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
    expect(screen.getByRole('button', { name: /Review IPC, Codex conversation/ }).querySelector('[data-slot="tooltip-trigger"]')).toBeNull();
  });

  test('highlights a project or chat row while its right-click menu is open', async () => {
    render(
      <SidebarProvider>
        <NavMain groups={[atlasGroup]} onCreated={vi.fn()} onRenameChat={vi.fn()} onSelect={vi.fn()} projectMenu={{ statusOf: () => 'active', onToggleArchive: vi.fn(), onRemove: vi.fn() }} providers={[codex]} selected={null} />
      </SidebarProvider>
    );
    const project = screen.getByRole('button', { name: 'Atlas' });
    fireEvent.contextMenu(project);
    expect(await screen.findByRole('menuitem', { name: 'Archive' })).toBeTruthy();
    expect(project.classList.contains('bg-sidebar-accent')).toBe(true);
    await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(project.classList.contains('bg-sidebar-accent')).toBe(false));

    await userEvent.setup().click(project);
    const chat = screen.getByRole('button', { name: /Map routes/ });
    fireEvent.contextMenu(chat);
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeTruthy();
    expect(chat.classList.contains('bg-sidebar-accent')).toBe(true);
  });

  test('marks archived projects and chats with the archive icon, and lays out both menus alike', async () => {
    render(
      <SidebarProvider>
        <NavMain chatMenu={{ isArchived: () => true, onToggleArchive: vi.fn() }} groups={[atlasGroup]} onCreated={vi.fn()} onRenameChat={vi.fn()} onSelect={vi.fn()} projectMenu={{ statusOf: () => 'archived', onToggleArchive: vi.fn(), onRemove: vi.fn() }} providers={[codex]} selected={null} />
      </SidebarProvider>
    );
    const project = screen.getByRole('button', { name: 'Atlas' });
    expect(project.querySelector('.lucide-archive')).not.toBeNull();
    expect(project.querySelector('.lucide-folder')).toBeNull();
    expect(project.className).toContain('text-muted-foreground');
    fireEvent.contextMenu(project);
    const projectItems = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
    expect(projectItems).toEqual(['Unarchive', 'Remove']);
    // Neither menu splits its items with a divider.
    expect(screen.queryByRole('separator')).toBeNull();
    await userEvent.setup().keyboard('{Escape}');

    await userEvent.setup().click(project);
    const chat = screen.getByRole('button', { name: /Map routes, Codex conversation, Archived/ });
    expect(chat.querySelector('.lucide-archive')).not.toBeNull();
    fireEvent.contextMenu(chat);
    await waitFor(() => expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename', 'Unarchive']));
  });

  describe('renaming a chat', () => {
    async function openRename(onRenameChat: (ref: ConversationRef, title: string) => Promise<void>) {
      const user = userEvent.setup();
      render(
        <SidebarProvider>
          <NavMain groups={[atlasGroup]} onCreated={vi.fn()} onRenameChat={onRenameChat} onSelect={vi.fn()} providers={[codex]} selected={null} />
        </SidebarProvider>
      );
      await user.click(screen.getByRole('button', { name: 'Atlas' }));
      fireEvent.contextMenu(screen.getByRole('button', { name: /Map routes/ }));
      await user.click(await screen.findByRole('menuitem', { name: 'Rename' }));
      const field = await screen.findByRole('textbox', { name: 'Chat name' });
      await waitFor(() => expect(document.activeElement).toBe(field));
      return { user, field: field as HTMLInputElement };
    }

    test('saves the trimmed name on Enter and closes the field', async () => {
      const onRenameChat = vi.fn(async () => undefined);
      const { user, field } = await openRename(onRenameChat);
      expect(field.value).toBe('Map routes');
      await user.clear(field);
      await user.type(field, '  Route map {Enter}');
      expect(onRenameChat).toHaveBeenCalledWith(atlasGroup.conversations[0].ref, 'Route map');
      await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Chat name' })).toBeNull());
    });

    test('cancels on Escape, on a blank name, and on an unchanged name', async () => {
      const onRenameChat = vi.fn(async () => undefined);
      let { user, field } = await openRename(onRenameChat);
      await user.type(field, 'x{Escape}');
      expect(screen.queryByRole('textbox', { name: 'Chat name' })).toBeNull();
      cleanup();

      ({ user, field } = await openRename(onRenameChat));
      await user.clear(field);
      await user.type(field, '   {Enter}');
      expect(screen.queryByRole('textbox', { name: 'Chat name' })).toBeNull();
      cleanup();

      ({ user, field } = await openRename(onRenameChat));
      await user.type(field, '{Enter}');
      expect(screen.queryByRole('textbox', { name: 'Chat name' })).toBeNull();
      expect(onRenameChat).not.toHaveBeenCalled();
    });

    test('keeps the typed name and shows an error when the rename fails', async () => {
      const onRenameChat = vi.fn(async () => { throw new Error('busy'); });
      const { user, field } = await openRename(onRenameChat);
      await user.clear(field);
      await user.type(field, 'Route map{Enter}');
      expect((await screen.findByRole('alert')).textContent).toContain("Couldn't rename");
      expect((screen.getByRole('textbox', { name: 'Chat name' }) as HTMLInputElement).value).toBe('Route map');
    });

    test('disables Rename for a busy chat', async () => {
      render(
        <SidebarProvider>
          <NavMain groups={[fractalGroup]} onCreated={vi.fn()} onRenameChat={vi.fn()} onSelect={vi.fn()} providers={[codex]} selected={null} />
        </SidebarProvider>
      );
      await userEvent.setup().click(screen.getByRole('button', { name: 'Fractal' }));
      fireEvent.contextMenu(screen.getByRole('button', { name: /Review IPC/ }));
      expect((await screen.findByRole('menuitem', { name: 'Rename' })).getAttribute('aria-disabled')).toBe('true');
    });
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

  test('draws unselected chat titles muted, without the sidebar text colour competing', () => {
    renderNav([fractalGroup], { ...fractalGroup.conversations[0].ref });
    // Both colour utilities on one element leave the winner to stylesheet
    // order, so the muted one has to be the only base text colour.
    const unselected = screen.getByRole('button', { name: /Review IPC/ });
    expect(unselected.classList.contains('text-muted-foreground')).toBe(true);
    expect(unselected.classList.contains('text-sidebar-foreground')).toBe(false);
    expect(screen.getByRole('button', { name: /Fix parser/ }).classList.contains('data-[active=true]:text-sidebar-accent-foreground')).toBe(true);
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
    Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: { create }, settings: { get: async (): Promise<FractalSettings> => ({ theme: 'system', defaultCodingAgent: 'ask', sidebarOrder: { projects: [], chatsByProject: {} }, projectVisibility: { archived: [], removed: [] }, projectFilter: 'active', archivedChats: [], hiddenAgents: [], showAgentColorTags: true, agentExecutables: { claude: '', codex: '' }, fileOpener: null, allowDangerousAccess: {} }) } } });
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

  describe('forks', () => {
    const fork = (nativeSessionId: string, title: string, parent: ConversationSummary): ConversationSummary => ({
      ...parent,
      ref: { ...parent.ref, nativeSessionId },
      title,
      runtime: 'idle',
      forkedFrom: { parentKey: `${parent.ref.provider}:${parent.ref.nativeSessionId}` },
    });
    const [fixParser, reviewIpc] = fractalGroup.conversations;
    const parserFork = fork('claude-fork-1', 'Try a lexer', fixParser);
    const forked: ProjectConversationGroup = { ...fractalGroup, conversations: [fixParser, parserFork, reviewIpc] };

    test('nests a fork under its parent row and selects it like any chat', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      renderNav([forked], null, onSelect);
      await user.click(screen.getByRole('button', { name: 'Fractal' }));

      const forks = screen.getByRole('group', { name: 'Forks of Fix parser' });
      const parentRow = screen.getByRole('button', { name: /^Fix parser,/ }).closest('li');
      expect(parentRow?.contains(forks)).toBe(true);
      const forkRow = within(forks).getByRole('button', { name: 'Try a lexer, Claude Code conversation, Idle' });
      expect(within(forks).queryByRole('button', { name: /Review IPC/ })).toBeNull();

      await user.click(forkRow);
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ ref: parserFork.ref, title: 'Try a lexer', section: 'Fractal' }));
    });

    test('counts only top-level rows toward Show more', async () => {
      const user = userEvent.setup();
      const chats = Array.from({ length: 5 }, (_, index) => ({ ...fixParser, ref: { ...fixParser.ref, nativeSessionId: `session-${index + 1}` }, title: `Chat ${index + 1}` }));
      const forks = Array.from({ length: 3 }, (_, index) => fork(`fork-${index + 1}`, `Fork ${index + 1}`, chats[0]));
      renderNav([{ ...fractalGroup, conversations: [...chats, ...forks] }]);
      await user.click(screen.getByRole('button', { name: 'Fractal' }));
      expect(screen.getByRole('button', { name: /Chat 5/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: /Fork 3/ })).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
      cleanup();

      const sixth = { ...fixParser, ref: { ...fixParser.ref, nativeSessionId: 'session-6' }, title: 'Chat 6' };
      renderNav([{ ...fractalGroup, conversations: [...chats, ...forks, sixth] }]);
      await user.click(screen.getByRole('button', { name: 'Fractal' }));
      expect(screen.queryByRole('button', { name: /Chat 6/ })).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Show more' }));
      expect(screen.getByRole('button', { name: /Chat 6/ })).toBeTruthy();
    });

    test('maps sortable positions to top-level rows', () => {
      expect(sidebarMoveAtIndices([forked], 'chat:/work/fractal', 1, 0)).toEqual({
        kind: 'chat', projectPath: '/work/fractal', source: 'codex:codex-thread-1', target: 'claude:claude-session-1',
      });
      expect(sidebarMoveAtIndices([forked], 'chat:/work/fractal', 2, 0)).toBeNull();
    });

    test('gives a fork row the same right-click menu as any chat', async () => {
      const user = userEvent.setup();
      const onToggleArchive = vi.fn();
      render(
        <SidebarProvider>
          <NavMain chatMenu={{ isArchived: () => false, onToggleArchive }} groups={[forked]} onCreated={vi.fn()} onRenameChat={vi.fn()} onSelect={vi.fn()} providers={[codex]} selected={null} />
        </SidebarProvider>
      );
      await user.click(screen.getByRole('button', { name: 'Fractal' }));
      fireEvent.contextMenu(screen.getByRole('button', { name: /Try a lexer/ }));
      await waitFor(() => expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename', 'Archive']));
      await user.click(screen.getByRole('menuitem', { name: 'Archive' }));
      expect(onToggleArchive).toHaveBeenCalledWith(parserFork.ref);
    });
  });
});
