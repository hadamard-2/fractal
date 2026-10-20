// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { resetConversationHubForTests } from '@/renderer/conversation-hub';
import { announceSideChats } from '@/renderer/side-chat-events';
import { quoteSelection } from '@/renderer/side-chat-start';
import { conversationKey, type ConversationApi, type ConversationRef, type ConversationRuntime, type ConversationStreamEvent, type ConversationTurn, type HarnessCapabilities, type ModelsApi, type SideChatSummary } from '@/shared/conversation-contract';
import { SideChatLauncherContext, type SideChatLauncher } from './side-chat-launcher';
import { SideChatPane } from './side-chat-pane';

const root: ConversationRef = { provider: 'claude', nativeSessionId: 'root', projectPath: '/work' };
const side: ConversationRef = { provider: 'claude', nativeSessionId: 'side', projectPath: '/work' };
const forked: ConversationRef = { provider: 'claude', nativeSessionId: 'forked', projectPath: '/work' };
const capabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: true };

const turn = (id: string, ask: string, reply: string): ConversationTurn => ({
  id, nativeId: id, userMessage: { id: `${id}-user`, text: ask },
  blocks: [{ id: `${id}-prose`, kind: 'assistant-prose', text: reply, provider: 'claude' }],
  status: 'completed', captureCompleteness: 'complete',
});
const inherited = turn('t1', 'Why is the parser slow?', 'It re-reads every file.');
const own = turn('s1', 'Which file is worst?', 'The lockfile.');
const summaryOf = (ref: ConversationRef): SideChatSummary => ({ ref, parentKey: conversationKey(root), afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 1 });
const draft = { parent: root, afterTurnId: 't1', text: '> It re-reads every file.\n\n' };

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void }
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

interface Fixture {
  conversations: ConversationApi;
  models: ModelsApi;
  /** What the next listing of the root returns, unless a held listing is queued. */
  listing: SideChatSummary[];
  /** Listings that resolve only when the test says so, taken in call order. */
  held: Deferred<SideChatSummary[]>[];
  loads: Map<string, string>;
  listeners: Set<(event: ConversationStreamEvent) => void>;
}

function install({ runtime = 'idle', listing = [] }: { runtime?: ConversationRuntime; listing?: SideChatSummary[] } = {}): Fixture {
  const fixture = { listing, held: [], loads: new Map(), listeners: new Set() } as unknown as Fixture;
  fixture.conversations = {
    list: async () => ({ projects: [], providers: [] }), create: vi.fn(async () => null),
    open: vi.fn<ConversationApi['open']>(async (ref, loadId) => {
      fixture.loads.set(conversationKey(ref), loadId);
      return { summary: { ref, title: 'Side', updatedAt: 1, runtime, captureCompleteness: 'complete' }, capabilities };
    }),
    close: vi.fn(async () => undefined), continue: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined),
    previewAttachment: vi.fn(async () => ({ kind: 'missing' as const })), openAttachment: vi.fn(async () => undefined), rename: vi.fn(async () => undefined),
    fork: vi.fn(async () => forked),
    sideChats: vi.fn(async () => fixture.held.shift()?.promise ?? [...fixture.listing]),
    deleteSideChat: vi.fn(async () => undefined),
    onEvent: (listener) => { fixture.listeners.add(listener); return () => { fixture.listeners.delete(listener); }; },
  };
  fixture.models = {
    list: vi.fn(async (ref: ConversationRef) => ({ models: [], choice: ref.nativeSessionId === 'root' ? { model: 'opus', effort: 'high' } : { model: 'haiku' } })),
    choose: vi.fn(async () => undefined),
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: fixture.conversations, models: fixture.models } });
  resetConversationHubForTests();
  return fixture;
}

/** Delivers a conversation's whole history once it's open. */
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

/** Holds the binding the way a tab does; `keepBound` leaves it bound when the pane hands back null. */
function Tab({ initial, onBound = () => undefined, onGone = () => undefined, keepBound = false, branchPointText, focusToken, visible = true }: {
  initial: ConversationRef | null; onBound?: (ref: ConversationRef | null) => void; onGone?: () => void; keepBound?: boolean; branchPointText?: string; focusToken?: number; visible?: boolean;
}) {
  const [sideChat, setSideChat] = useState(initial);
  return (
    <SideChatPane
      branchPointText={branchPointText}
      draft={initial ? undefined : draft}
      focusToken={focusToken}
      onBound={(ref) => { onBound(ref); if (ref || !keepBound) setSideChat(ref); }}
      onGone={onGone}
      root={root}
      sideChat={sideChat}
      visible={visible}
    />
  );
}

const composer = () => screen.getByRole('textbox', { name: 'Side question' }) as HTMLTextAreaElement;

beforeEach(() => {
  // jsdom has no layout; the transcript only renders rows it thinks are in view.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; } });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-index') ? 280 : 560; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('an unsent pane shows where it branches from and the quoted draft, and leaves nothing native behind', () => {
  const fixture = install();
  const { unmount } = render(<Tab branchPointText="It re-reads every file." initial={null} />);
  expect(screen.getByText('Branched from')).toBeTruthy();
  expect(screen.getByText('It re-reads every file.')).toBeTruthy();
  expect(composer().value).toBe(draft.text);
  expect(composer().placeholder).toBe('Ask a side question');
  expect(screen.getByText("Side chats can read files but can't change them.")).toBeTruthy();
  unmount();
  const { conversations, models } = fixture;
  for (const call of [conversations.open, conversations.close, conversations.sideChats, conversations.fork, conversations.continue, conversations.deleteSideChat, models.list]) expect(call).not.toHaveBeenCalled();
});

test('without branch-point text there is no header', () => {
  install();
  render(<Tab initial={null} />);
  expect(screen.queryByText('Branched from')).toBeNull();
});

test('Enter forks after the turn, binds the tab, then sends with the parent model and no access setting', async () => {
  const fixture = install({ listing: [summaryOf(forked)] });
  const onBound = vi.fn();
  render(<Tab initial={null} onBound={onBound} />);
  const user = userEvent.setup();
  await user.click(composer());
  await user.keyboard('Why?{Enter}');

  await waitFor(() => expect(fixture.conversations.fork).toHaveBeenCalledWith(root, { turnId: 't1', position: 'after' }, 'side-chat'));
  await waitFor(() => expect(onBound).toHaveBeenCalledWith(forked));
  await loadHistory(fixture, forked, [inherited]);
  const text = `${draft.text}Why?`.trim();
  await waitFor(() => expect(fixture.conversations.continue).toHaveBeenCalledWith(forked, { text, model: 'opus', effort: 'high' }));
  expect(vi.mocked(fixture.conversations.continue).mock.calls[0][1]).not.toHaveProperty('access');
  expect(onBound.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fixture.conversations.continue).mock.invocationCallOrder[0]);
  await waitFor(() => expect(composer().value).toBe(''));
  expect(onBound).toHaveBeenCalledTimes(1);
});

test('Shift+Enter adds a newline and sends nothing', async () => {
  const fixture = install();
  render(<Tab initial={null} />);
  const user = userEvent.setup();
  await user.click(composer());
  await user.keyboard('one{Shift>}{Enter}{/Shift}two');
  expect(composer().value).toBe(`${draft.text}one\ntwo`);
  expect(fixture.conversations.fork).not.toHaveBeenCalled();
});

test('a failed first send deletes the side chat, unbinds, keeps the text, and a retry forks afresh', async () => {
  const fixture = install({ listing: [summaryOf(forked)] });
  vi.mocked(fixture.conversations.continue).mockRejectedValueOnce(new Error('Send failed'));
  vi.mocked(fixture.conversations.deleteSideChat).mockImplementation(async () => { fixture.listing = []; });
  const onBound = vi.fn();
  const onGone = vi.fn();
  render(<Tab initial={null} onBound={onBound} onGone={onGone} />);
  const user = userEvent.setup();
  await user.click(composer());
  await user.keyboard('Why?{Enter}');
  await loadHistory(fixture, forked, [inherited]);

  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't start the side chat.");
  expect(fixture.conversations.deleteSideChat).toHaveBeenCalledWith(forked);
  expect(onBound.mock.calls).toEqual([[forked], [null]]);
  expect(composer().value).toBe(`${draft.text}Why?`);
  expect(onGone).not.toHaveBeenCalled();

  fixture.listing = [summaryOf(forked)];
  await user.click(composer());
  await user.keyboard('{Enter}');
  await waitFor(() => expect(fixture.conversations.fork).toHaveBeenCalledTimes(2));
  await loadHistory(fixture, forked, [inherited]);
  await waitFor(() => expect(composer().value).toBe(''));
  expect(onGone).not.toHaveBeenCalled();
});

test('listings around a failed first send never close the tab, even while it is still bound', async () => {
  const fixture = install();
  vi.mocked(fixture.conversations.continue).mockRejectedValueOnce(new Error('Send failed'));
  // The listing the bind starts, held until the send is under way.
  const duringSend = deferred<SideChatSummary[]>();
  fixture.held.push(duringSend);
  // The re-list submitDraft announces after deleting, held until the failure has reached the pane.
  const afterDelete = deferred<SideChatSummary[]>();
  vi.mocked(fixture.conversations.deleteSideChat).mockImplementation(async () => { fixture.held.push(afterDelete); });
  const onGone = vi.fn();
  render(<Tab initial={null} keepBound onGone={onGone} />);
  const user = userEvent.setup();
  await user.click(composer());
  await user.keyboard('Why?{Enter}');
  await waitFor(() => expect(fixture.conversations.sideChats).toHaveBeenCalledTimes(1));
  await act(async () => duringSend.resolve([]));
  expect(onGone).not.toHaveBeenCalled();

  await loadHistory(fixture, forked, [inherited]);
  await screen.findByRole('alert');
  await act(async () => afterDelete.resolve([]));
  expect(onGone).not.toHaveBeenCalled();
  // Nor does one that starts after the failure, before the tab has re-rendered unbound.
  await act(async () => announceSideChats(conversationKey(root)));
  expect(onGone).not.toHaveBeenCalled();
  expect(composer().value).toBe(`${draft.text}Why?`);
});

test('a bound pane shows only its own turns and continues the side chat with its own model', async () => {
  const fixture = install();
  const listing = deferred<SideChatSummary[]>();
  fixture.held.push(listing);
  render(<Tab initial={side} />);
  await loadHistory(fixture, side, [inherited, own]);
  expect(screen.getByText('Reading history…')).toBeTruthy();

  await act(async () => listing.resolve([summaryOf(side)]));
  expect(await screen.findByText('The lockfile.')).toBeTruthy();
  expect(screen.getByText('Which file is worst?')).toBeTruthy();
  expect(screen.queryByText('Why is the parser slow?')).toBeNull();
  expect(screen.getByText("Side chats can read files but can't change them.")).toBeTruthy();

  const user = userEvent.setup();
  await user.click(composer());
  await user.keyboard('And the next?{Enter}');
  await waitFor(() => expect(fixture.conversations.continue).toHaveBeenCalledWith(side, { text: 'And the next?', model: 'haiku' }));
  expect(fixture.conversations.fork).not.toHaveBeenCalled();
  await waitFor(() => expect(composer().value).toBe(''));
});

test('a failed send to a bound side chat says so and keeps it bound', async () => {
  const fixture = install({ listing: [summaryOf(side)] });
  vi.mocked(fixture.conversations.continue).mockRejectedValueOnce(new Error('Send failed'));
  const onBound = vi.fn();
  render(<Tab initial={side} onBound={onBound} />);
  await loadHistory(fixture, side, [inherited, own]);
  const user = userEvent.setup();
  await user.click(composer());
  await user.keyboard('And the next?{Enter}');
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't send to the side chat.");
  expect(composer().value).toBe('And the next?');
  expect(onBound).not.toHaveBeenCalled();
});

test('the tab is gone once a listing that started after binding no longer has the side chat', async () => {
  const fixture = install({ listing: [summaryOf(side)] });
  const onGone = vi.fn();
  render(<Tab initial={side} onGone={onGone} />);
  await loadHistory(fixture, side, [inherited, own]);
  await screen.findByText('The lockfile.');
  expect(onGone).not.toHaveBeenCalled();

  fixture.listing = [];
  await act(async () => announceSideChats(conversationKey(root)));
  await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
  await act(async () => announceSideChats(conversationKey(root)));
  expect(onGone).toHaveBeenCalledTimes(1);
});

test('a side chat its first send created closes its tab once it is deleted', async () => {
  const fixture = install({ listing: [summaryOf(forked)] });
  const onGone = vi.fn();
  render(<Tab initial={null} onGone={onGone} />);
  const user = userEvent.setup();
  await user.click(composer());
  await user.keyboard('Why?{Enter}');
  await loadHistory(fixture, forked, [inherited]);
  await waitFor(() => expect(fixture.conversations.continue).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(composer().value).toBe(''));
  expect(onGone).not.toHaveBeenCalled();

  fixture.listing = [];
  await act(async () => announceSideChats(conversationKey(root)));
  await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
  await act(async () => announceSideChats(conversationKey(root)));
  expect(onGone).toHaveBeenCalledTimes(1);
});

test('a listing from before the side chat was bound never counts', async () => {
  const fixture = install({ listing: [summaryOf(side)] });
  const onGone = vi.fn();
  const pane = (sideChat: ConversationRef | null) => <SideChatPane branchPointText={undefined} draft={undefined} onBound={() => undefined} onGone={onGone} root={root} sideChat={sideChat} visible />;
  const { rerender } = render(pane(side));
  await waitFor(() => expect(fixture.conversations.sideChats).toHaveBeenCalledTimes(1));
  await act(async () => undefined);

  // Bound to another side chat, the last listing (which doesn't have it) is still on hand.
  const relisted = deferred<SideChatSummary[]>();
  fixture.held.push(relisted);
  rerender(pane(null));
  rerender(pane(forked));
  await act(async () => undefined);
  expect(onGone).not.toHaveBeenCalled();
  await act(async () => relisted.resolve([summaryOf(side), summaryOf(forked)]));
  expect(onGone).not.toHaveBeenCalled();

  fixture.listing = [summaryOf(side)];
  await act(async () => announceSideChats(conversationKey(root)));
  await waitFor(() => expect(onGone).toHaveBeenCalledTimes(1));
});

test('a running side chat turns the send button into a stop button', async () => {
  const fixture = install({ runtime: 'active-in-fractal', listing: [summaryOf(side)] });
  render(<Tab initial={side} />);
  await loadHistory(fixture, side, [inherited, own]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Interrupt session' }));
  expect(fixture.conversations.interrupt).toHaveBeenCalledWith(side);
});

test('text selected in one of its own replies starts a nested side chat through the launcher', async () => {
  const fixture = install({ listing: [summaryOf(side)] });
  const launcher: SideChatLauncher = { start: vi.fn(), open: vi.fn() };
  Range.prototype.getBoundingClientRect = () => DOMRect.fromRect({ x: 10, y: 10, width: 50, height: 20 });
  try {
    render(<SideChatLauncherContext.Provider value={launcher}><Tab initial={side} /></SideChatLauncherContext.Provider>);
    await loadHistory(fixture, side, [inherited, own]);
    const target = (await screen.findByText('The lockfile.')).firstChild;
    if (!target) throw new Error('No reply text');
    const range = document.createRange();
    range.selectNodeContents(target);
    act(() => {
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Side chat' }));
    expect(launcher.start).toHaveBeenCalledWith({ root, parent: side, turn: own, text: quoteSelection('The lockfile.') });
    expect(screen.queryByRole('button', { name: 'Side chat' })).toBeNull();
  } finally {
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    window.getSelection()?.removeAllRanges();
  }
});

test('a side chat whose history can\'t be read says so, and Reload reads it again', async () => {
  const fixture = install({ listing: [summaryOf(side)] });
  vi.mocked(fixture.conversations.open).mockRejectedValueOnce(new Error('No such session'));
  render(<Tab initial={side} />);
  expect(await screen.findByText('History unavailable')).toBeTruthy();
  expect(screen.getByText('Reload to try reading this conversation again.')).toBeTruthy();
  expect(screen.queryByText('Reading history…')).toBeNull();
  expect(composer().disabled).toBe(true);

  await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
  await loadHistory(fixture, side, [inherited, own]);
  expect(await screen.findByText('The lockfile.')).toBeTruthy();
  expect(screen.queryByText('History unavailable')).toBeNull();
  expect(composer().disabled).toBe(false);
});

test('a deleted side chat whose history fails closes its tab without saying it is unavailable', async () => {
  const fixture = install();
  const listing = deferred<SideChatSummary[]>();
  fixture.held.push(listing);
  vi.mocked(fixture.conversations.open).mockRejectedValueOnce(new Error('No such session'));
  const onGone = vi.fn();
  render(<Tab initial={side} onGone={onGone} />);
  await waitFor(() => expect(fixture.conversations.open).toHaveBeenCalledTimes(1));
  await act(async () => undefined);
  expect(screen.queryByText('History unavailable')).toBeNull();
  expect(screen.getByText('Reading history…')).toBeTruthy();

  await act(async () => listing.resolve([]));
  expect(onGone).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('History unavailable')).toBeNull();
});

test('a listing that fails doesn\'t leave the pane reading forever, and Reload lists again', async () => {
  const fixture = install({ listing: [summaryOf(side)] });
  vi.mocked(fixture.conversations.sideChats).mockRejectedValueOnce(new Error('Listing failed'));
  const onGone = vi.fn();
  render(<Tab initial={side} onGone={onGone} />);
  await loadHistory(fixture, side, [inherited, own]);
  expect(await screen.findByText('History unavailable')).toBeTruthy();
  expect(screen.queryByText('Reading history…')).toBeNull();

  await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('The lockfile.')).toBeTruthy();
  expect(fixture.conversations.sideChats).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('History unavailable')).toBeNull();
  expect(onGone).not.toHaveBeenCalled();
});

test('a focus request focuses the composer with the caret after the quote', () => {
  install();
  render(<Tab focusToken={1} initial={null} />);
  expect(document.activeElement).toBe(composer());
  expect([composer().selectionStart, composer().selectionEnd]).toEqual([draft.text.length, draft.text.length]);
});

test('a focus request waits until the pane is shown, and each one is honoured once', () => {
  install();
  const view = render(<Tab focusToken={1} initial={null} visible={false} />);
  expect(document.activeElement).not.toBe(composer());
  view.rerender(<Tab focusToken={1} initial={null} visible />);
  expect(document.activeElement).toBe(composer());

  act(() => composer().blur());
  view.rerender(<Tab focusToken={1} initial={null} visible={false} />);
  view.rerender(<Tab focusToken={1} initial={null} visible />);
  expect(document.activeElement).not.toBe(composer());
  view.rerender(<Tab focusToken={2} initial={null} visible />);
  expect(document.activeElement).toBe(composer());
});

test('a focus request on a bound side chat waits for it to load, and lapses while it is running', async () => {
  const fixture = install({ listing: [summaryOf(side)] });
  render(<Tab focusToken={1} initial={side} />);
  expect(document.activeElement).not.toBe(composer());
  await loadHistory(fixture, side, [inherited, own]);
  await waitFor(() => expect(document.activeElement).toBe(composer()));
  expect(composer().selectionStart).toBe(0);
  cleanup();

  const running = install({ runtime: 'active-in-fractal', listing: [summaryOf(side)] });
  render(<Tab focusToken={1} initial={side} />);
  await loadHistory(running, side, [inherited, own]);
  await screen.findByRole('button', { name: 'Interrupt session' });
  expect(document.activeElement).not.toBe(composer());
  // Once it finishes, the composer takes messages again, and the lapsed request stays lapsed.
  const loadId = running.loads.get(conversationKey(side)) ?? '';
  act(() => {
    for (const listener of running.listeners) listener({ ref: side, loadId, seq: 2, type: 'summary.updated', summary: { ref: side, title: 'Side', updatedAt: 2, runtime: 'idle', captureCompleteness: 'complete' } });
  });
  await waitFor(() => expect(composer().disabled).toBe(false));
  expect(document.activeElement).not.toBe(composer());
});

test('a pasted file isn\'t attached, and the pane says why', async () => {
  install();
  URL.createObjectURL = vi.fn(() => 'blob:shot');
  render(<Tab initial={null} />);
  const png = new File(['fake-png-bytes'], 'shot.png', { type: 'image/png' });
  fireEvent.paste(composer(), { clipboardData: { items: [{ kind: 'file', getAsFile: () => png }] } as unknown as DataTransfer });
  expect((await screen.findByRole('alert')).textContent).toBe('Too many files. Some were not added.');
  expect(screen.queryByText('shot.png')).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

test('a dropped file isn\'t attached, and the pane says why', async () => {
  install();
  render(<Tab initial={null} />);
  const file = new File(['# Notes'], 'notes.md', { type: 'text/markdown' });
  fireEvent.drop(composer().closest('form') as HTMLFormElement, { dataTransfer: { types: ['Files'], files: [file] } as unknown as DataTransfer });
  expect((await screen.findByRole('alert')).textContent).toBe('Too many files. Some were not added.');
  expect(screen.queryByText('notes.md')).toBeNull();
});
