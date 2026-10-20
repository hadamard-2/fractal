// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { initialConversationState, type ConversationState } from '@/renderer/conversation-reducer';
import { conversationKey, type ConversationRef, type ConversationRuntime, type ConversationTurn } from '@/shared/conversation-contract';
import { useSideChatLauncher } from './right-panel/side-chat-launcher';
import { useTerminalLauncher } from './right-panel/terminal-launcher';
import { RightWorkspace } from './right-workspace';

// The selected conversation's state, as Execute's lease keeps it in the hub.
const hub = vi.hoisted(() => {
  const states = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  return {
    states,
    listeners,
    // Unleased, a conversation reads as not yet loaded.
    state: (ref: { provider: string; nativeSessionId: string }) => states.get(`${ref.provider}:${ref.nativeSessionId}`) ?? { history: 'idle', turns: [], runtime: 'unknown' },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
});
vi.mock('@/renderer/conversation-hub', () => ({ conversationHub: () => hub }));

vi.mock('./terminal-view', () => ({
  TerminalView: ({ cwd, focusToken }: { cwd: string | null; focusToken?: number }) => (
    <div data-slot="terminal"><textarea aria-label="Terminal input" data-cwd={cwd ?? ''} data-focus-token={focusToken ?? 0} /></div>
  ),
}));

vi.mock('./right-panel/files/files-pane', () => ({
  FilesPane: ({ selected, docked, dockedTreeOpen, onOpenFile }: {
    selected?: { projectPath: string; path: string | null }; docked: boolean; dockedTreeOpen: boolean;
    onOpenFile: (projectPath: string, path: string, pinned: boolean) => void;
  }) => (
    <div data-docked={docked} data-testid="files-pane" data-tree-open={dockedTreeOpen}>
      {selected && (
        <>
          <button onClick={() => onOpenFile(selected.projectPath, 'src/a.ts', false)} type="button">Click a.ts</button>
          <button onClick={() => onOpenFile(selected.projectPath, 'src/b.ts', false)} type="button">Click b.ts</button>
        </>
      )}
    </div>
  ),
}));

const changesPaneProps: { root: string; active: boolean }[] = [];
vi.mock('./right-panel/changes/changes-pane', () => ({
  ChangesPane: ({ root, active, onOpenFile }: { root: string; active: boolean; onOpenFile: (path: string) => void }) => {
    changesPaneProps.push({ root, active });
    return <button onClick={() => onOpenFile('src/a.ts')} type="button">Open {root} change</button>;
  },
}));

const boundRef: ConversationRef = { provider: 'claude', nativeSessionId: 'bound', projectPath: '/repo' };
vi.mock('./right-panel/side-chat-pane', () => ({
  SideChatPane: ({ root, draft, sideChat, branchPointText, onBound, onGone, focusToken, visible }: {
    root: ConversationRef; draft?: { parent: ConversationRef; afterTurnId: string; text: string }; sideChat: ConversationRef | null; branchPointText?: string;
    onBound: (ref: ConversationRef | null) => void; onGone: () => void; focusToken?: number; visible: boolean;
  }) => (
    <div
      data-after-turn={draft?.afterTurnId}
      data-branch-point={branchPointText}
      data-focus-token={focusToken ?? 0}
      data-launcher={useSideChatLauncher() ? 'yes' : 'no'}
      data-root={root.nativeSessionId}
      data-side-chat={sideChat?.nativeSessionId}
      data-terminal-launcher={useTerminalLauncher() ? 'yes' : 'no'}
      data-testid="side-chat-pane"
      data-visible={visible}
    >
      <textarea aria-label="Side question" defaultValue={draft?.text} />
      <button onClick={() => onBound(boundRef)} type="button">Bind</button>
      <button onClick={onGone} type="button">Gone</button>
    </div>
  ),
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); changesPaneProps.length = 0; hub.states.clear(); hub.listeners.clear(); });

const box = (left: number, width: number) => ({ left, width, x: left, y: 0, top: 0, right: left + width, bottom: 800, height: 800, toJSON: (): void => undefined });

function Harness({ withInset = false, onResizingChange = () => undefined, projectPath = '/repo' as string | null, conversation = null, children }: {
  withInset?: boolean; onResizingChange?: (resizing: boolean) => void; projectPath?: string | null;
  conversation?: { ref: ConversationRef; readOnly: boolean } | null; children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const insetRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <button onClick={() => setOpen(!open)} type="button">{open ? 'Close panel' : 'Open panel'}</button>
      <RightWorkspace conversation={conversation} leftInsetRef={withInset ? insetRef : undefined} onOpenChange={setOpen} onResizingChange={onResizingChange} onWidthChange={setWidth} open={open} projectPath={projectPath} width={width}>
        <div data-inset={withInset || undefined} ref={insetRef}>Content{children}</div>
      </RightWorkspace>
    </>
  );
}

// getByRole's `hidden: true` bypasses the isInaccessible filter but not
// accessible-name computation: with @testing-library/dom 10.4.1 +
// dom-accessibility-api 0.5.16, an aria-hidden element's own name computes to
// "" per the accname spec regardless of aria-label, so a name-based role
// query can never match it. The DOM contract's stable selector does.
const panel = () => document.querySelector('aside[data-slot="right-panel"]') as HTMLElement;
const pressToggle = (target: Element) => fireEvent.keyDown(target, { key: '`', code: 'Backquote', ctrlKey: true });

test('opens empty, creates and closes tabs, and returns to the tool list', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  expect(panel().hasAttribute('inert')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(panel().getAttribute('aria-hidden')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Add tool' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
  expect(screen.getByLabelText('Terminal input').getAttribute('data-cwd')).toBe('/repo');
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  expect(screen.getByRole('menuitem', { name: 'Side chat' }).getAttribute('aria-disabled')).toBe('true');
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: 'Close Terminal 2' }));
  await user.click(screen.getByRole('button', { name: 'Close Terminal' }));
  expect(screen.queryByRole('tab')).toBeNull();
  expect(screen.getByRole('menu', { name: 'Add a tool' })).toBeTruthy();
});

test('hiding the panel keeps its tabs', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await user.click(screen.getByRole('button', { name: 'Close panel' }));
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(screen.getAllByRole('tab', { name: /Terminal/ })).toHaveLength(1);
});

test('fixes the default width on first open and resizes by keyboard', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(panel().style.width).toBe('320px');
  screen.getByRole('separator', { name: 'Resize right panel' }).focus();
  await user.keyboard('{ArrowLeft}');
  expect(panel().style.width).toBe('336px');
});

test('splits beside content right of the left inset and reserves header space', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.inset ? box(300, 1300) : box(0, 1600);
  });
  const user = userEvent.setup();
  render(<Harness withInset />);
  const content = screen.getByText('Content').parentElement as HTMLElement;
  const gap = document.querySelector('[data-slot="right-panel-gap"]') as HTMLElement;
  expect(content.style.getPropertyValue('--app-bar-reserve')).toBe('calc(var(--window-controls-inset) + 52px)');
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(panel().style.width).toBe('520px');
  expect(gap.style.width).toBe('520px');
  expect(content.style.getPropertyValue('--app-bar-reserve')).toBe('1rem');
});

test('Ctrl+` opens and creates, focuses from elsewhere, and closes from inside a terminal', async () => {
  render(<Harness />);
  expect(pressToggle(document.body)).toBe(false);
  expect(panel().getAttribute('aria-hidden')).toBe('false');
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  const input = screen.getByLabelText('Terminal input');
  expect(input.getAttribute('data-focus-token')).toBe('1');

  const elsewhere = screen.getByRole('button', { name: 'Close panel' });
  elsewhere.focus();
  pressToggle(elsewhere);
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  expect(input.getAttribute('data-focus-token')).toBe('2');

  input.focus();
  expect(pressToggle(input)).toBe(false);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  expect(screen.getByRole('button', { name: 'Open panel' })).toBeTruthy();
});

test('ignores other modifier combinations', () => {
  render(<Harness />);
  fireEvent.keyDown(document.body, { key: '`', code: 'Backquote', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(document.body, { key: '`', code: 'Backquote' });
  expect(panel().getAttribute('aria-hidden')).toBe('true');
});

const pressFiles = (target: Element) => fireEvent.keyDown(target, { key: 'F', code: 'KeyF', ctrlKey: true, shiftKey: true });

test('Ctrl+Shift+F opens the panel on Files and reuses the Files tab', () => {
  render(<Harness />);
  pressFiles(document.body);
  expect(panel().getAttribute('aria-hidden')).toBe('false');
  expect(screen.getByRole('tab', { name: 'Files (preview)' })).toBeTruthy();
  expect(pressFiles(document.body)).toBe(false);
  expect(screen.getAllByRole('tab')).toHaveLength(1);
});

test('Ctrl+Shift+F does nothing without a project', () => {
  render(<Harness projectPath={null} />);
  pressFiles(document.body);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
});

test('Ctrl+` does nothing without a project or an open terminal', () => {
  render(<Harness projectPath={null} />);
  pressToggle(document.body);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('tab')).toBeNull();
});

test('Ctrl+` does nothing without a project, even with a terminal already open', () => {
  const view = render(<Harness />);
  pressToggle(document.body);
  const input = screen.getByLabelText('Terminal input');
  input.focus();
  pressToggle(input);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  view.rerender(<Harness projectPath={null} />);
  pressToggle(document.body);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  expect(input.getAttribute('data-focus-token')).toBe('1');
});

test('Terminal and Files are unavailable without a project', async () => {
  const user = userEvent.setup();
  render(<Harness projectPath={null} />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  expect(screen.getByRole('menuitem', { name: 'Terminal' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('menuitem', { name: 'Files' }).hasAttribute('disabled')).toBe(true);
});

test('opens Files, fills and replaces the preview tab, pins it, and reuses the most recent file tab', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(screen.getByRole('tab', { name: 'Files (preview)' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  expect(screen.getByRole('tab', { name: 'a.ts (preview)' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Click b.ts' }));
  expect(screen.getAllByRole('tab')).toHaveLength(1);
  await user.dblClick(screen.getByRole('tab', { name: 'b.ts (preview)' }));
  expect(screen.getByRole('tab', { name: 'b.ts' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['b.ts', 'a.ts (preview)']);
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  expect(screen.getAllByRole('tab')).toHaveLength(3);
  expect(screen.getByRole('tab', { name: 'a.ts (preview)' }).getAttribute('aria-selected')).toBe('true');
});

test('shows the tree toggle only on file tabs, and Ctrl+` returns to the last terminal', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(screen.queryByRole('button', { name: /file tree/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  // Narrow, a tab with no file yet always shows the tree.
  expect(screen.getByRole('button', { name: 'Hide file tree' }).getAttribute('aria-pressed')).toBe('true');
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  const toggle = screen.getByRole('button', { name: 'Show file tree' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  await user.click(toggle);
  expect(screen.getByRole('button', { name: 'Hide file tree' }).getAttribute('aria-pressed')).toBe('true');
  pressToggle(document.body);
  expect(screen.getByRole('tab', { name: 'Terminal' }).getAttribute('aria-selected')).toBe('true');
});

test('another project starts with its own tree state', async () => {
  const user = userEvent.setup();
  const view = render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  await user.click(screen.getByRole('button', { name: 'Show file tree' }));
  expect(screen.getByRole('button', { name: 'Hide file tree' })).toBeTruthy();
  view.rerender(<Harness projectPath="/other" />);
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Files' }));
  await user.click(screen.getByRole('button', { name: 'Click a.ts' }));
  expect(screen.getByRole('button', { name: 'Show file tree' })).toBeTruthy();
});

const pressChanges = (target: Element) => fireEvent.keyDown(target, { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true });
const lastActive = () => changesPaneProps[changesPaneProps.length - 1]?.active;

test('Ctrl+Shift+D opens the panel on Changes and reuses the tab', () => {
  render(<Harness />);
  pressChanges(document.body);
  expect(panel().getAttribute('aria-hidden')).toBe('false');
  expect(screen.getByRole('tab', { name: 'Changes' }).getAttribute('aria-selected')).toBe('true');
  expect(pressChanges(document.body)).toBe(false);
  expect(screen.getAllByRole('tab')).toHaveLength(1);
});

test('Ctrl+Shift+D does nothing without a project', () => {
  render(<Harness projectPath={null} />);
  pressChanges(document.body);
  expect(panel().getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('tab')).toBeNull();
});

test('Open file from Changes opens a Files preview tab for that file', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  pressChanges(document.body);
  await user.click(screen.getByRole('button', { name: 'Open /repo change' }));
  expect(screen.getByRole('tab', { name: 'a.ts (preview)' }).getAttribute('aria-selected')).toBe('true');
});

test('only the selected Changes tab is active', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Open panel' }));
  await user.click(screen.getByRole('menuitem', { name: 'Changes' }));
  expect(lastActive()).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Add tool' }));
  await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
  expect(lastActive()).toBe(false);
  await user.click(screen.getByRole('tab', { name: 'Changes' }));
  expect(lastActive()).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Close panel' }));
  expect(lastActive()).toBe(false);
});

describe('side chats', () => {
  const ref: ConversationRef = { provider: 'claude', nativeSessionId: 'root', projectPath: '/repo' };
  const turn = (id: string, status: ConversationTurn['status'], reply: string): ConversationTurn => ({
    id, nativeId: id, userMessage: { id: `${id}-user`, text: 'Ask' }, status, captureCompleteness: 'complete',
    blocks: [{ id: `${id}-reply`, kind: 'assistant-prose', text: reply, provider: 'claude' }],
  });
  const setState = (turns: ConversationTurn[], runtime: ConversationRuntime = 'idle', history: ConversationState['history'] = 'complete') => {
    hub.states.set(conversationKey(ref), { ...initialConversationState, ref, turns, runtime, history });
    act(() => { for (const listener of hub.listeners) listener(); });
  };
  const sideChatEntry = () => screen.getByRole('menuitem', { name: 'Side chat' });
  // The selected tab's pane; the others stay mounted, hidden.
  const pane = () => within(screen.getByRole('tabpanel')).getByTestId('side-chat-pane');
  const panes = () => screen.queryAllByTestId('side-chat-pane');

  function Child() {
    const launcher = useSideChatLauncher();
    if (!launcher) return <p>No launcher</p>;
    return (
      <>
        <button onClick={() => launcher.start({ root: ref, parent: ref, turn: turn('t1', 'completed', 'The reply'), text: '> quoted' })} type="button">Start from child</button>
        <button onClick={() => launcher.open({ root: ref, sideChat: boundRef, branchPointText: 'Earlier' })} type="button">Open from child</button>
      </>
    );
  }

  test('Side chat is unavailable with nothing selected, in a subagent chat, and with no reply to branch from', async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open panel' }));
    expect(sideChatEntry().hasAttribute('disabled')).toBe(true);
    expect(sideChatEntry().textContent).toBe('Side chatOpen a conversation first');
    setState([turn('t1', 'completed', 'Done')]);
    view.rerender(<Harness conversation={{ ref, readOnly: true }} />);
    expect(sideChatEntry().textContent).toBe('Side chatNot available in subagent chats');
    setState([turn('t1', 'active', 'Working')], 'active-in-fractal');
    view.rerender(<Harness conversation={{ ref, readOnly: false }} />);
    expect(sideChatEntry().hasAttribute('disabled')).toBe(true);
    expect(sideChatEntry().textContent).toBe('Side chatNo reply to branch from yet');
    setState([turn('t1', 'completed', 'Done')], 'idle', 'loading');
    expect(sideChatEntry().textContent).toBe('Side chatNo reply to branch from yet');
    setState([turn('t1', 'completed', 'Done')]);
    expect(sideChatEntry().hasAttribute('disabled')).toBe(false);
    expect(sideChatEntry().textContent).toBe('Side chat');
  });

  test('branches from the latest finished reply while the latest turn is still running, from the list and the + menu', async () => {
    setState([turn('t1', 'completed', 'First answer'), turn('t2', 'active', 'Still going')], 'active-in-fractal');
    const user = userEvent.setup();
    render(<Harness conversation={{ ref, readOnly: false }} />);
    await user.click(screen.getByRole('button', { name: 'Open panel' }));
    await user.click(sideChatEntry());
    expect(screen.getByRole('tab', { name: 'Side chat' }).getAttribute('aria-selected')).toBe('true');
    expect(pane().dataset).toMatchObject({ afterTurn: 't1', branchPoint: 'First answer', root: 'root' });
    expect(pane().dataset.sideChat).toBeUndefined();
    setState([turn('t1', 'completed', 'First answer'), turn('t2', 'completed', 'Second answer')]);
    await user.click(screen.getByRole('button', { name: 'Add tool' }));
    await user.click(sideChatEntry());
    expect(screen.getAllByRole('tab', { name: 'Side chat' })).toHaveLength(2);
    expect(pane().dataset).toMatchObject({ afterTurn: 't2', branchPoint: 'Second answer' });
    // The same reply again, with nothing typed in its starting text, reselects that tab.
    await user.click(screen.getByRole('tab', { name: 'Side chat', selected: false }));
    await user.click(screen.getByRole('button', { name: 'Add tool' }));
    await user.click(sideChatEntry());
    expect(screen.getAllByRole('tab', { name: 'Side chat' })).toHaveLength(2);
    expect(pane().dataset.afterTurn).toBe('t2');
  });

  test('a child starts and opens side chats, opening the panel and selecting the tab', async () => {
    const user = userEvent.setup();
    render(<Harness conversation={{ ref, readOnly: false }}><Child /></Harness>);
    await user.click(screen.getByRole('button', { name: 'Start from child' }));
    expect(panel().getAttribute('aria-hidden')).toBe('false');
    expect(screen.getByRole('tab', { name: 'Side chat' }).getAttribute('aria-selected')).toBe('true');
    expect(pane().dataset).toMatchObject({ afterTurn: 't1', branchPoint: 'The reply', launcher: 'yes' });
    expect((screen.getByRole('textbox', { name: 'Side question' }) as HTMLTextAreaElement).value).toBe('> quoted');
    await user.click(screen.getByRole('button', { name: 'Bind' }));
    expect(pane().dataset.sideChat).toBe('bound');
    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    await user.click(screen.getByRole('button', { name: 'Open from child' }));
    expect(panel().getAttribute('aria-hidden')).toBe('false');
    expect(screen.getAllByRole('tab', { name: 'Side chat' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Add tool' }));
    await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
    await user.click(screen.getByRole('button', { name: 'Open from child' }));
    expect(screen.getByRole('tab', { name: 'Side chat' }).getAttribute('aria-selected')).toBe('true');
    expect(pane().dataset.sideChat).toBe('bound');
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  test('a child opens a side chat with no tab yet in a new tab', async () => {
    const user = userEvent.setup();
    render(<Harness conversation={{ ref, readOnly: false }}><Child /></Harness>);
    await user.click(screen.getByRole('button', { name: 'Open from child' }));
    expect(screen.getByRole('tab', { name: 'Side chat' }).getAttribute('aria-selected')).toBe('true');
    expect(pane().dataset).toMatchObject({ sideChat: 'bound', branchPoint: 'Earlier', root: 'root' });
    expect(pane().dataset.afterTurn).toBeUndefined();
  });

  test('a started or opened side chat asks its pane for focus, also when it lands on a tab already open', async () => {
    setState([turn('t1', 'completed', 'First answer')]);
    const user = userEvent.setup();
    render(<Harness conversation={{ ref, readOnly: false }}><Child /></Harness>);
    const token = () => Number(pane().dataset.focusToken);
    await user.click(screen.getByRole('button', { name: 'Start from child' }));
    expect(pane().dataset.visible).toBe('true');
    const started = token();
    expect(started).toBeGreaterThan(0);

    // From the tool list, onto a new tab; the earlier one keeps the token it had.
    await user.click(screen.getByRole('button', { name: 'Add tool' }));
    await user.click(sideChatEntry());
    expect(screen.getAllByRole('tab', { name: 'Side chat' })).toHaveLength(2);
    const fromTool = token();
    expect(fromTool).toBeGreaterThan(started);
    expect(panes().filter((each) => Number(each.dataset.focusToken) > 0)).toHaveLength(1);

    // The same reply with nothing typed reselects that tab, and asks again.
    await user.click(screen.getByRole('tab', { name: 'Side chat', selected: false }));
    await user.click(screen.getByRole('button', { name: 'Add tool' }));
    await user.click(sideChatEntry());
    expect(screen.getAllByRole('tab', { name: 'Side chat' })).toHaveLength(2);
    expect(token()).toBeGreaterThan(fromTool);

    // Opening a bound side chat: a new tab, then the same tab again.
    await user.click(screen.getByRole('button', { name: 'Open from child' }));
    const opened = token();
    expect(pane().dataset.sideChat).toBe('bound');
    await user.click(screen.getAllByRole('tab', { name: 'Side chat' })[0]);
    await user.click(screen.getByRole('button', { name: 'Open from child' }));
    expect(pane().dataset.sideChat).toBe('bound');
    expect(token()).toBeGreaterThan(opened);
    expect(screen.getAllByRole('tab', { name: 'Side chat' })).toHaveLength(3);
  });

  test('a side-chat pane is visible only while its tab is selected in the open panel', async () => {
    const user = userEvent.setup();
    render(<Harness conversation={{ ref, readOnly: false }}><Child /></Harness>);
    await user.click(screen.getByRole('button', { name: 'Start from child' }));
    expect(panes()[0].dataset.visible).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Close panel' }));
    expect(panes()[0].dataset.visible).toBe('false');
    await user.click(screen.getByRole('button', { name: 'Open panel' }));
    await user.click(screen.getByRole('button', { name: 'Add tool' }));
    await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
    expect(panes()[0].dataset.visible).toBe('false');
  });

  test('a side-chat pane can open terminals and start nested side chats', async () => {
    const user = userEvent.setup();
    render(<Harness conversation={{ ref, readOnly: false }}><Child /></Harness>);
    await user.click(screen.getByRole('button', { name: 'Start from child' }));
    expect(pane().dataset).toMatchObject({ launcher: 'yes', terminalLauncher: 'yes' });
  });

  test('there is no launcher without a project', () => {
    render(<Harness conversation={{ ref, readOnly: false }} projectPath={null}><Child /></Harness>);
    expect(screen.getByText('No launcher')).toBeTruthy();
  });

  test('a pane whose side chat is gone closes its tab', async () => {
    const user = userEvent.setup();
    render(<Harness conversation={{ ref, readOnly: false }}><Child /></Harness>);
    await user.click(screen.getByRole('button', { name: 'Start from child' }));
    await user.click(screen.getByRole('button', { name: 'Gone' }));
    expect(screen.queryByRole('tab')).toBeNull();
    expect(panes()).toHaveLength(0);
    expect(screen.getByRole('menu', { name: 'Add a tool' })).toBeTruthy();
  });

  test('a side-chat pane stays mounted while another tab is selected', async () => {
    const user = userEvent.setup();
    render(<Harness conversation={{ ref, readOnly: false }}><Child /></Harness>);
    await user.click(screen.getByRole('button', { name: 'Start from child' }));
    const question = screen.getByRole('textbox', { name: 'Side question' });
    await user.type(question, ' and more');
    await user.click(screen.getByRole('button', { name: 'Add tool' }));
    await user.click(screen.getByRole('menuitem', { name: 'Terminal' }));
    expect(screen.queryByRole('textbox', { name: 'Side question' })).toBeNull();
    expect(panes()).toHaveLength(1);
    await user.click(screen.getByRole('tab', { name: 'Side chat' }));
    expect(screen.getByRole('textbox', { name: 'Side question' })).toBe(question);
    expect((question as HTMLTextAreaElement).value).toBe('> quoted and more');
  });

  test('side-chat tabs stay when the selected conversation changes', async () => {
    const user = userEvent.setup();
    const view = render(<Harness conversation={{ ref, readOnly: false }}><Child /></Harness>);
    await user.click(screen.getByRole('button', { name: 'Start from child' }));
    view.rerender(<Harness conversation={null}><Child /></Harness>);
    expect(screen.getByRole('tab', { name: 'Side chat' })).toBeTruthy();
  });
});
