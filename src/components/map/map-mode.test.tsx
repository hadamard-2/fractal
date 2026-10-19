// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
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
    fork: vi.fn(async () => { throw new Error('fork unused'); }), sideChats: vi.fn(async () => sideChats), deleteSideChat: vi.fn(async () => undefined),
    onEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const map: MapApi = {
    layout: vi.fn(async () => saved),
    saveLayout: vi.fn(async (_ref, next) => { saved = next; }),
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations, map } });
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

test('a reply offers the branch handle, except in a subagent conversation', async () => {
  const fixture = install();
  const view = render(<MapMode {...shell(root)} />);
  await loadHistory(fixture, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  expect(nodeOf('Hi there.').querySelector('[data-handleid="branch"]')).not.toBeNull();
  expect(nodeOf('Hello').querySelector('[data-handleid="branch"]')).toBeNull();
  view.unmount();

  const subagent: ConversationSummary = { ref: root, title: 'Delegated', updatedAt: 1, runtime: 'idle', captureCompleteness: 'complete', parentId: 'parent' };
  const again = install();
  render(<MapMode {...shell(root, [subagent])} />);
  await loadHistory(again, root, [turn('t1', 'Hello', 'Hi there.')]);
  await screen.findByText('Hi there.');
  expect(nodeOf('Hi there.').querySelector('[data-handleid="branch"]')).toBeNull();
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
