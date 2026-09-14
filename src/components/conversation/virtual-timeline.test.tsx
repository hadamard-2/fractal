// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ConversationTurn } from '@/shared/conversation-contract';
import { VirtualTimeline } from './virtual-timeline';

const turns = (count: number): ConversationTurn[] => Array.from({ length: count }, (_, index): ConversationTurn => ({ id: `turn-${index}`, nativeId: `turn-${index}`, userMessage: { id: `user-${index}`, text: `User anchor ${index}` }, blocks: [], status: 'completed', captureCompleteness: 'complete' }));
const observers = new Map<ResizeObserverCallback, Set<Element>>();
function resize(element: Element, height: number) {
  act(() => {
    for (const [callback, elements] of observers) if (elements.has(element)) callback([{ target: element, borderBoxSize: [{ blockSize: height, inlineSize: 800 }] } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  });
}

beforeEach(() => {
  observers.clear();
  vi.stubGlobal('ResizeObserver', class {
    elements = new Set<Element>();
    constructor(callback: ResizeObserverCallback) { observers.set(callback, this.elements); }
    observe(element: Element) { this.elements.add(element); }
    unobserve(element: Element) { this.elements.delete(element); }
    disconnect() { this.elements.clear(); }
  });
  // jsdom has no layout; supply viewport/row geometry, preserving the real virtualizer.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: this.hasAttribute('data-index') ? 280 : 560, width: 800, height: this.hasAttribute('data-index') ? 280 : 560, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-index') ? 280 : 560; });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return Number.parseFloat((this.firstElementChild as HTMLElement)?.style.height ?? '0') || 560; });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = Math.max(0, options.top ?? 0); queueMicrotask(() => this.dispatchEvent(new Event('scroll'))); } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('renders a bounded window for large histories, then preserves a reader during append and prepend', async () => {
  const original = turns(1000);
  const { rerender } = render(<VirtualTimeline conversationId="virtual-large" turns={original} onResolve={() => undefined} />);
  const viewport = screen.getByRole('log');
  await waitFor(() => expect(screen.getByText('User anchor 999')).toBeTruthy());
  expect(screen.getAllByRole('article').length).toBeLessThan(20);
  act(() => { viewport.scrollTop = 560; fireEvent.scroll(viewport); });
  await waitFor(() => expect(screen.getByText('User anchor 2')).toBeTruthy());
  rerender(<VirtualTimeline conversationId="virtual-large" turns={turns(1001)} onResolve={() => undefined} />);
  expect(viewport.scrollTop).toBe(560);
  expect(screen.getByRole('button', { name: 'New activity' })).toBeTruthy();
  const prepended = [{ ...original[0], id: 'earlier', userMessage: { id: 'earlier-user', text: 'Earlier message' } }, ...turns(1001)];
  rerender(<VirtualTimeline conversationId="virtual-large" turns={prepended} onResolve={() => undefined} />);
  await waitFor(() => expect(viewport.scrollTop).toBe(840));
  fireEvent.click(screen.getByRole('button', { name: 'New activity' }));
  await waitFor(() => expect(screen.getByText('User anchor 1000')).toBeTruthy());
});

test('restores a conversation reading anchor after switching away and back', async () => {
  const history = turns(100);
  const { rerender } = render(<VirtualTimeline conversationId="restore-a" turns={history} onResolve={() => undefined} />);
  const viewport = screen.getByRole('log');
  act(() => { viewport.scrollTop = 840; fireEvent.scroll(viewport); });
  rerender(<VirtualTimeline conversationId="restore-b" turns={history} onResolve={() => undefined} />);
  rerender(<VirtualTimeline conversationId="restore-a" turns={history} onResolve={() => undefined} />);
  await waitFor(() => expect(screen.getByRole('log').scrollTop).toBe(840));
});

test('waits for a remembered turn to arrive in chunked history before restoring it', async () => {
  const history = turns(100);
  const { rerender } = render(<VirtualTimeline conversationId="chunk-restore" turns={history} onResolve={() => undefined} />);
  await screen.findByText('User anchor 99');
  const viewport = screen.getByRole('log');
  act(() => { viewport.scrollTop = 840; fireEvent.scroll(viewport); });
  rerender(<VirtualTimeline conversationId="other-chunk-session" turns={history} onResolve={() => undefined} />);
  rerender(<VirtualTimeline conversationId="chunk-restore" turns={history.slice(0, 2)} historyComplete={false} onResolve={() => undefined} />);
  rerender(<VirtualTimeline conversationId="chunk-restore" turns={history} historyComplete={true} onResolve={() => undefined} />);
  await waitFor(() => expect(screen.getByRole('log').scrollTop).toBe(840));
});

test('preserves a reader through measured resizes above and inside the anchor', async () => {
  render(<VirtualTimeline conversationId="resize-reader" turns={turns(100)} onResolve={() => undefined} />);
  const viewport = screen.getByRole('log');
  await screen.findByText('User anchor 99');
  act(() => { viewport.scrollTop = 1040; fireEvent.scroll(viewport); });
  const earlier = screen.getByText('User anchor 0').closest('[data-index]');
  if (!earlier) throw new Error('Earlier row did not mount');
  resize(earlier, 400);
  await waitFor(() => expect(viewport.scrollTop).toBe(1160));
  const anchor = screen.getByText('User anchor 3').closest('[data-index]');
  if (!anchor) throw new Error('Anchor row did not mount');
  resize(anchor, 40);
  await waitFor(() => expect(viewport.scrollTop).toBe(999));
});

test('follows content from an empty history and growing final turn only while near bottom', async () => {
  const { rerender } = render(<VirtualTimeline conversationId="empty-growth" turns={[]} onResolve={() => undefined} />);
  const history = turns(100);
  rerender(<VirtualTimeline conversationId="empty-growth" turns={history} onResolve={() => undefined} />);
  const viewport = screen.getByRole('log');
  await waitFor(() => expect(screen.getByText('User anchor 99')).toBeTruthy());
  const last = screen.getByText('User anchor 99').closest('[data-index]');
  if (!last) throw new Error('Latest row did not mount');
  resize(last, 500);
  await waitFor(() => expect(viewport.scrollTop).toBe(27660));
  act(() => { viewport.scrollTop = 560; fireEvent.scroll(viewport); });
  rerender(<VirtualTimeline conversationId="empty-growth" turns={history.map((turn, index) => index === 99 ? { ...turn, userMessage: { ...turn.userMessage, text: 'Updated last turn' } } : turn)} onResolve={() => undefined} />);
  expect(viewport.scrollTop).toBe(560);
  expect(screen.getByRole('button', { name: 'New activity' })).toBeTruthy();
});
