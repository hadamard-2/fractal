// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ShellContext } from '@/components/app-shell';
import { resetConversationHubForTests } from '@/renderer/conversation-hub';
import { conversationKey, type ConversationApi, type ConversationRef, type ConversationStreamEvent, type ConversationSummary, type ConversationTurn, type SideChatSummary } from '@/shared/conversation-contract';
import { EMPTY_MAP_LAYOUT, type MapApi, type MapLayout } from '@/shared/map-contract';
import { MapMode } from './map-mode';

const root: ConversationRef = { provider: 'claude', nativeSessionId: 'root', projectPath: '/work' };
const side: ConversationRef = { provider: 'claude', nativeSessionId: 'side', projectPath: '/work' };

const turn = (id: string, ask: string, reply: string): ConversationTurn => ({
  id, nativeId: id, userMessage: { id: `${id}-user`, text: ask },
  blocks: [{ id: `${id}-prose`, kind: 'assistant-prose', text: reply, provider: 'claude' }],
  status: 'completed', captureCompleteness: 'complete',
});

const sideChat: SideChatSummary = { ref: side, parentKey: conversationKey(root), afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 1 };

interface Fixture { listeners: Set<(event: ConversationStreamEvent) => void>; loads: Map<string, string>; map: MapApi; conversations: ConversationApi }

function install({ sideChats = [], layout = EMPTY_MAP_LAYOUT }: { sideChats?: SideChatSummary[]; layout?: MapLayout } = {}): Fixture {
  const listeners = new Set<(event: ConversationStreamEvent) => void>();
  const loads = new Map<string, string>();
  let saved = layout;
  const conversations: ConversationApi = {
    list: async () => ({ projects: [], providers: [] }), create: async () => null,
    open: async (ref, loadId) => {
      loads.set(conversationKey(ref), loadId);
      return { summary: { ref, title: 'Map', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete' }, capabilities: { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: true } };
    },
    close: async () => undefined, continue: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined),
    previewAttachment: vi.fn(async () => ({ kind: 'missing' as const })), openAttachment: vi.fn(async () => undefined), rename: vi.fn(async () => undefined),
    fork: vi.fn(async () => { throw new Error('fork unused'); }), sideChats: vi.fn(async () => [...sideChats]), deleteSideChat: vi.fn(async () => undefined),
    onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const map: MapApi = {
    layout: vi.fn(async () => saved),
    saveLayout: vi.fn(async (_ref, next) => { saved = next; }),
  };
  const models = { list: vi.fn(async () => ({ models: [], choice: { model: 'opus' } })), choose: vi.fn(async () => undefined) };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations, map, models } });
  resetConversationHubForTests();
  return { listeners, loads, map, conversations };
}

/** Delivers a conversation's whole history as the service would stream it. */
async function loadHistory(fixture: Fixture, ref: ConversationRef, turns: ConversationTurn[]) {
  const key = conversationKey(ref);
  await waitFor(() => expect(fixture.loads.get(key)).toBeDefined());
  const loadId = fixture.loads.get(key) ?? '';
  act(() => {
    for (const listener of fixture.listeners) {
      listener({ ref, loadId, seq: 0, type: 'history.chunk', chunkIndex: 0, turns });
      listener({ ref, loadId, seq: 1, type: 'history.complete' });
    }
  });
}

function shell(selectedRef: ConversationRef | null, conversations: ConversationSummary[] = []): ShellContext {
  return {
    selectedRef,
    history: { projects: [{ projectPath: '/work', displayName: 'work', conversations }], providers: [], loading: false, loaded: true, error: null, refresh: async () => undefined },
    actions: { newConversation: () => undefined, search: () => undefined, addProject: () => undefined, canStart: true },
    onRuntimeChange: () => undefined,
    refreshSignal: 0,
  };
}

const nodeOf = (text: string) => {
  const node = screen.getByText(text).closest('.react-flow__node');
  if (!(node instanceof HTMLElement)) throw new Error(`No node holds ${text}`);
  return node;
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('with nothing selected, it asks for a conversation', () => {
  install();
  render(<MapMode {...shell(null)} />);
  expect(screen.getByText('Pick a conversation to see its map.')).toBeTruthy();
});

test('a conversation with no messages says so', async () => {
  const fixture = install();
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, []);
  expect(await screen.findByText('No messages yet.')).toBeTruthy();
});

test('draws a node per message of the conversation and its side chat, clamped in Preview and whole in Full', async () => {
  const fixture = install({ sideChats: [sideChat] });
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Why is the parser slow?', 'It re-reads every file.')]);
  await loadHistory(fixture, side, [turn('t1', 'Why is the parser slow?', 'It re-reads every file.'), turn('s1', 'Which file is worst?', 'The lockfile.')]);

  const messages = ['Why is the parser slow?', 'It re-reads every file.', 'Which file is worst?', 'The lockfile.'];
  for (const text of messages) expect(await screen.findByText(text)).toBeTruthy();
  // The side chat's inherited turn is drawn once, on the main line.
  expect(screen.getAllByText('Why is the parser slow?')).toHaveLength(1);
  expect(document.querySelectorAll('.react-flow__node')).toHaveLength(4);
  for (const text of messages) expect(nodeOf(text).querySelector('.line-clamp-3')).not.toBeNull();

  await userEvent.setup().click(screen.getByRole('radio', { name: 'Full' }));
  for (const text of messages) {
    expect(nodeOf(text).querySelector('.line-clamp-3')).toBeNull();
    expect(within(nodeOf(text)).getByText(text)).toBeTruthy();
  }
});

test('the Preview / Full choice is saved and comes back on a remount', async () => {
  const fixture = install();
  const view = render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  await userEvent.setup().click(screen.getByRole('radio', { name: 'Full' }));
  view.unmount();
  await waitFor(() => expect(fixture.map.saveLayout).toHaveBeenCalledWith(root, { view: 'full', nodes: {} }));

  render(<MapMode {...shell(root)} />);
  await waitFor(() => expect(screen.getByRole('radio', { name: 'Full' }).getAttribute('aria-checked')).toBe('true'));
});

test('zoom and fit are buttons with tooltips, and nothing on the canvas has a native title', async () => {
  const fixture = install({ sideChats: [sideChat] });
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await loadHistory(fixture, side, [turn('t1', 'Hello', 'Hi there.'), turn('s1', 'And?', 'More.')]);
  await screen.findByText('More.');

  for (const label of ['Zoom in', 'Zoom out', 'Fit to view']) {
    const button = screen.getByRole('button', { name: label });
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('data-variant')).toBe('ghost');
    act(() => { button.focus(); });
    expect((await screen.findByRole('tooltip')).textContent).toBe(label);
    act(() => { button.blur(); });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  }
  expect(document.querySelectorAll('[title]')).toHaveLength(0);
});

const branchHandle = (text: string) => nodeOf(text).querySelector('[data-handleid="branch"]');

test('a reply offers the branch handle, except in a subagent conversation', async () => {
  const fixture = install();
  const view = render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  expect(branchHandle('Hi there.')?.classList.contains('connectable')).toBe(true);
  expect(branchHandle('Hi there.')?.getAttribute('data-can-branch')).toBe('true');
  expect(branchHandle('Hello')).toBeNull();
  view.unmount();

  const subagent: ConversationSummary = { ref: root, title: 'Delegated', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete', parentId: 'parent' };
  const again = install();
  render(<MapMode {...shell(root, [subagent])} />);
  await loadHistory(again, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  expect(branchHandle('Hi there.')?.classList.contains('connectable')).toBe(false);
  expect(branchHandle('Hi there.')?.getAttribute('data-can-branch')).toBe('false');
});

test('a reply that can\'t branch keeps a closed branch handle, so a side chat cut from it stays attached', async () => {
  const fixture = install({ sideChats: [sideChat] });
  render(<MapMode {...shell(root)} />);
  // A reloaded transcript can leave the latest turn active, and that turn is where the side chat was cut.
  await loadHistory(fixture, root, [{ ...turn('t1', 'Hello', 'Hi there.'), status: 'active' }]);
  await loadHistory(fixture, side, [turn('t1', 'Hello', 'Hi there.'), turn('s1', 'And?', 'More.')]);
  await screen.findByText('More.');
  const handle = branchHandle('Hi there.');
  expect(handle?.classList.contains('source')).toBe(true);
  expect(handle?.classList.contains('connectable')).toBe(false);
  expect(handle?.getAttribute('data-can-branch')).toBe('false');
});

test('a side chat whose branch point is gone hangs off a detached marker with the stored text', async () => {
  const fixture = install({ sideChats: [{ ...sideChat, afterTurnId: 'gone', branchPointText: 'The old answer' }] });
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await loadHistory(fixture, side, [turn('t1', 'Hello', 'Hi there.'), turn('s1', 'And?', 'More.')]);
  expect(await screen.findByText('Branch point no longer in the conversation')).toBeTruthy();
  expect(screen.getByText('The old answer').classList.contains('line-clamp-3')).toBe(true);
});

test('leases the root and its side chats only while mounted', async () => {
  const fixture = install({ sideChats: [sideChat] });
  const close = vi.spyOn(fixture.conversations, 'close');
  const view = render(<MapMode {...shell(root)} />);
  await waitFor(() => expect(fixture.loads.has(conversationKey(side))).toBe(true));
  expect(fixture.loads.has(conversationKey(root))).toBe(true);
  view.unmount();
  await waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  expect(close.mock.calls.map(([ref]) => ref.nativeSessionId).sort()).toEqual(['root', 'side']);
});

/** Selects a node's whole message text and lets the canvas hear about it, as a mouse selection would. */
function selectText(text: string) {
  const target = screen.getByText(text).firstChild;
  if (!target) throw new Error(`No text node for ${text}`);
  const range = document.createRange();
  range.selectNodeContents(target);
  act(() => {
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
}

const composer = () => screen.queryByPlaceholderText('Ask a side question') as HTMLTextAreaElement | null;

beforeEach(() => {
  Range.prototype.getBoundingClientRect = () => DOMRect.fromRect({ x: 10, y: 10, width: 50, height: 20 });
});
afterEach(() => {
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
  window.getSelection()?.removeAllRanges();
});

test('Side chat on selected text drops a quoted composer beside the message, and nothing native happens until it is sent', async () => {
  const fixture = install();
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');

  selectText('Hi there.');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Side chat' }));
  expect(composer()?.value).toBe('> Hi there.\n\n');
  expect(document.querySelectorAll('.react-flow__node-composer')).toHaveLength(1);
  // Choosing it clears the selection, so the menu goes.
  expect(screen.queryByRole('button', { name: 'Side chat' })).toBeNull();
  expect(fixture.conversations.fork).not.toHaveBeenCalled();
  expect(fixture.conversations.continue).not.toHaveBeenCalled();
});

test('Escape on an emptied composer removes it, and nothing native happens', async () => {
  const fixture = install();
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  selectText('Hello');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Side chat' }));
  const textarea = composer();
  if (!textarea) throw new Error('No composer');
  await user.clear(textarea);
  await user.keyboard('{Escape}');
  expect(composer()).toBeNull();
  expect(fixture.conversations.fork).not.toHaveBeenCalled();
  expect(fixture.conversations.continue).not.toHaveBeenCalled();
});

test('switching to another conversation drops its drafts', async () => {
  const other: ConversationRef = { provider: 'claude', nativeSessionId: 'other', projectPath: '/work' };
  const fixture = install();
  const view = render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  selectText('Hi there.');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Side chat' }));
  expect(composer()).not.toBeNull();

  view.rerender(<MapMode {...shell(other)} />);
  expect(composer()).toBeNull();
  view.rerender(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  expect(composer()).toBeNull();
  expect(fixture.conversations.fork).not.toHaveBeenCalled();
  expect(fixture.conversations.continue).not.toHaveBeenCalled();
});

test('no Side chat in a subagent conversation', async () => {
  const subagent: ConversationSummary = { ref: root, title: 'Delegated', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete', parentId: 'parent' };
  const fixture = install();
  render(<MapMode {...shell(root, [subagent])} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  selectText('Hi there.');
  expect(screen.queryByRole('button', { name: 'Side chat' })).toBeNull();
});

test('sending a composer forks a side chat, sends the text, and hands over to the side chat\'s own nodes', async () => {
  const sideChats: SideChatSummary[] = [];
  const fixture = install({ sideChats });
  vi.mocked(fixture.conversations.fork).mockImplementation(async () => {
    sideChats.push({ ...sideChat, createdAt: 2 });
    return side;
  });
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  selectText('Hi there.');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Side chat' }));
  await user.type(composer() ?? document.body, 'Why?');
  await user.keyboard('{Control>}{Enter}{/Control}');

  await waitFor(() => expect(fixture.conversations.fork).toHaveBeenCalledWith(root, { turnId: 't1', position: 'after' }, 'side-chat'));
  await loadHistory(fixture, side, [turn('t1', 'Hello', 'Hi there.')]);
  await waitFor(() => expect(fixture.conversations.continue).toHaveBeenCalledWith(side, { text: '> Hi there.\n\nWhy?', model: 'opus' }));
  await waitFor(() => expect(composer()).toBeNull());

  const loadId = fixture.loads.get(conversationKey(side)) ?? '';
  act(() => {
    for (const listener of fixture.listeners) {
      listener({ ref: side, loadId, seq: 2, type: 'runtime.changed', runtime: 'active-in-fractal' });
      listener({ ref: side, loadId, seq: 3, type: 'turn.upserted', turn: { ...turn('s1', '> Hi there.\n\nWhy?', ''), blocks: [], status: 'active' } });
    }
  });
  // The reply streams in from the side chat's own state; until it has text it shimmers.
  expect(await screen.findByText('Thinking…')).toBeTruthy();
  expect(document.querySelectorAll('.react-flow__node')).toHaveLength(4);
});

test('a failed send keeps the composer and its text, with the copy', async () => {
  const fixture = install();
  vi.mocked(fixture.conversations.fork).mockRejectedValue(new Error('no fork'));
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  selectText('Hi there.');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Side chat' }));
  await user.type(composer() ?? document.body, 'Why?');
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(await screen.findByText("Couldn't start the side chat.")).toBeTruthy();
  expect(composer()?.value).toBe('> Hi there.\n\nWhy?');
});

test('a reply a transcript left active, with nothing running, doesn\'t shimmer', async () => {
  const fixture = install();
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.'), { ...turn('t2', 'And?', ''), blocks: [], status: 'active' }]);
  await screen.findByText('And?');
  expect(screen.queryByText('Thinking…')).toBeNull();
});

// By label: React Flow keeps a node hidden until it is measured, which jsdom never does, and a hidden element has no accessible name.
const deleteAction = (text: string) => within(nodeOf(text)).queryByLabelText('Delete side chat');

/** Delivers a runtime change for a conversation whose history was loaded with loadHistory; `seq` follows the events delivered so far. */
function setRuntime(fixture: Fixture, ref: ConversationRef, runtime: ConversationSummary['runtime'], seq = 2) {
  const loadId = fixture.loads.get(conversationKey(ref)) ?? '';
  act(() => {
    for (const listener of fixture.listeners) listener({ ref, loadId, seq, type: 'runtime.changed', runtime });
  });
}

const nestedRef: ConversationRef = { provider: 'claude', nativeSessionId: 'nested', projectPath: '/work' };
const nested: SideChatSummary = { ref: nestedRef, parentKey: conversationKey(side), afterTurnId: 's1', inheritedTurnCount: 2, createdAt: 2 };

test('only a side chat\'s first message offers deleting it, as a ghost button with a tooltip', async () => {
  const fixture = install({ sideChats: [sideChat] });
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await loadHistory(fixture, side, [turn('t1', 'Hello', 'Hi there.'), turn('s1', 'And?', 'More.'), turn('s2', 'Again?', 'Again.')]);
  await screen.findByText('Again.');

  for (const text of ['Hello', 'Hi there.', 'More.', 'Again?', 'Again.']) expect(deleteAction(text)).toBeNull();
  const button = deleteAction('And?');
  if (!button) throw new Error('No delete action');
  expect(button.tagName).toBe('BUTTON');
  expect(button.getAttribute('data-variant')).toBe('ghost');
  act(() => { button.focus(); });
  expect((await screen.findByRole('tooltip')).textContent).toBe('Delete side chat');
  act(() => { button.blur(); });
  expect(document.querySelectorAll('[title]')).toHaveLength(0);
});

test('a side chat whose branch point is gone offers deleting on its detached marker', async () => {
  const fixture = install({ sideChats: [{ ...sideChat, afterTurnId: 'gone' }] });
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await loadHistory(fixture, side, [turn('t1', 'Hello', 'Hi there.'), turn('s1', 'And?', 'More.')]);
  await screen.findByText('Branch point no longer in the conversation');
  expect(deleteAction('Branch point no longer in the conversation')).not.toBeNull();
  await userEvent.setup().click(deleteAction('Branch point no longer in the conversation') ?? document.body);
  expect(await screen.findByRole('dialog', { name: 'Delete side chat?' })).toBeTruthy();
});

test('no delete action while the side chat, or one inside it, is running', async () => {
  const fixture = install({ sideChats: [sideChat, nested] });
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await loadHistory(fixture, side, [turn('t1', 'Hello', 'Hi there.'), turn('s1', 'And?', 'More.')]);
  await loadHistory(fixture, nestedRef, []);
  await screen.findByText('More.');
  expect(deleteAction('And?')).not.toBeNull();

  setRuntime(fixture, nestedRef, 'active-in-fractal');
  await waitFor(() => expect(deleteAction('And?')).toBeNull());
  setRuntime(fixture, nestedRef, 'idle', 3);
  await waitFor(() => expect(deleteAction('And?')).not.toBeNull());
  setRuntime(fixture, side, 'waiting-for-user');
  await waitFor(() => expect(deleteAction('And?')).toBeNull());
});

test('Delete removes the side chat and the side chats inside it from the map and the saved layout', async () => {
  let listed = [sideChat, nested];
  const layout: MapLayout = {
    view: 'preview',
    nodes: { 'claude:root|t1|user': { x: 0, y: 0 }, 'claude:side|s1|user': { x: 400, y: 0 }, 'claude:nested|n1|reply': { x: 800, y: 0 } },
  };
  const fixture = install({ sideChats: listed, layout });
  vi.mocked(fixture.conversations.sideChats).mockImplementation(async () => [...listed]);
  vi.mocked(fixture.conversations.deleteSideChat).mockImplementation(async () => { listed = []; });
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await loadHistory(fixture, side, [turn('t1', 'Hello', 'Hi there.'), turn('s1', 'And?', 'More.')]);
  await loadHistory(fixture, nestedRef, [turn('t1', 'Hello', 'Hi there.'), turn('s1', 'And?', 'More.'), turn('n1', 'Deeper?', 'Deeper.')]);
  await screen.findByText('Deeper.');

  const user = userEvent.setup();
  await user.click(deleteAction('And?') ?? document.body);
  expect((await screen.findByRole('dialog')).textContent).toContain('This deletes the side chat and the 1 side chat inside it from the map and from Claude Code\'s own history.');
  await user.click(screen.getByRole('button', { name: 'Delete' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fixture.conversations.deleteSideChat).toHaveBeenCalledTimes(1);
  expect(fixture.conversations.deleteSideChat).toHaveBeenCalledWith(side);
  expect(screen.queryByText('More.')).toBeNull();
  expect(screen.queryByText('Deeper.')).toBeNull();
  expect(screen.getByText('Hi there.')).toBeTruthy();
  await waitFor(() => expect(fixture.map.saveLayout).toHaveBeenCalledWith(root, { view: 'preview', nodes: { 'claude:root|t1|user': { x: 0, y: 0 } } }));
});

test('a failed delete leaves the side chat on the map, and Cancel leaves it alone', async () => {
  const fixture = install({ sideChats: [sideChat] });
  vi.mocked(fixture.conversations.deleteSideChat).mockRejectedValue(new Error('Error invoking remote method'));
  render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await loadHistory(fixture, side, [turn('t1', 'Hello', 'Hi there.'), turn('s1', 'And?', 'More.')]);
  await screen.findByText('More.');

  const user = userEvent.setup();
  await user.click(deleteAction('And?') ?? document.body);
  await user.click(await screen.findByRole('button', { name: 'Delete' }));
  expect(await screen.findByText('Couldn\'t delete the side chat.')).toBeTruthy();
  expect(screen.getByRole('dialog')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(fixture.conversations.deleteSideChat).toHaveBeenCalledTimes(1);
  expect(screen.getByText('More.')).toBeTruthy();
  expect(fixture.map.saveLayout).not.toHaveBeenCalled();
});
