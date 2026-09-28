// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { ConversationPanel } from './conversation-panel';
import type { ConversationApi, ConversationRef, ConversationRuntime, ConversationStreamEvent } from '@/shared/conversation-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'panel-test', projectPath: '/work/fractal' };
let emit: (event: ConversationStreamEvent) => void;
let loadId = '';
let seq = 0;
function install(runtime: ConversationRuntime = 'idle', send: ConversationApi['continue'] = async () => undefined) {
  seq = 0;
  loadId = '';
  const api: ConversationApi = {
    list: async () => ({ projects: [], providers: [] }), create: async () => null,
    open: async (selected, id) => {
      loadId = id;
      return { summary: { ref: selected, title: 'Fix parser', updatedAt: 1, runtime, captureCompleteness: 'complete' }, capabilities: { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: false } };
    },
    close: async () => undefined, continue: send, interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), previewAttachment: vi.fn(async () => ({ kind: 'missing' as const })), openAttachment: vi.fn(async () => undefined),
    onEvent: (listener) => { emit = listener; return () => undefined; },
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api } });
  return api;
}
async function ready() {
  await waitFor(() => expect(loadId).not.toBe(''));
  act(() => emit({ ref, loadId, seq: seq++, type: 'history.complete' }));
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test('uses native loading state, then enables the empty conversation composer', async () => {
  install();
  render(<ConversationPanel conversationRef={ref} />);
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(true);
  await ready();
  expect(screen.queryByLabelText('Conversation details')).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(false);
  expect(screen.getByText('No messages yet')).toBeTruthy();
});

test('keeps a failed send draft and clears only after a successful dispatch', async () => {
  const send = vi.fn<ConversationApi['continue']>().mockRejectedValueOnce(new Error('Dispatch failed')).mockResolvedValueOnce();
  install('idle', send);
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const user = userEvent.setup();
  const input = screen.getByRole('textbox', { name: 'Message' });
  await user.type(input, 'Please continue');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await screen.findByRole('alert');
  expect((input as HTMLTextAreaElement).value).toBe('Please continue');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
  expect(send).toHaveBeenLastCalledWith(ref, { text: 'Please continue' });
});

test('does not erase the draft when a dispatch from the previous load settles after reload', async () => {
  let settle: () => void = () => undefined;
  install('idle', () => new Promise<void>((resolve) => { settle = resolve; }));
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const user = userEvent.setup();
  const input = screen.getByRole('textbox', { name: 'Message' });
  await user.type(input, 'Keep this draft');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  act(() => emit({ ref, loadId, seq: seq++, type: 'load.failed', message: 'Connection lost' }));
  await user.click(screen.getByRole('button', { name: 'Reload' }));
  seq = 0;
  await ready();
  await act(async () => settle());
  expect((input as HTMLTextAreaElement).value).toBe('Keep this draft');
});

test.each(['active-externally', 'unknown', 'failed', 'waiting-for-user'] as const)('disables the composer for %s', async (runtime) => {
  install(runtime);
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(true);
});

test('shows requests read-only when the session is active externally', async () => {
  const api = install('active-externally');
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  act(() => emit({ ref, loadId, seq: seq++, type: 'request.opened', request: { id: 'external-request', kind: 'approval', provider: 'codex', title: 'Run command?', operation: 'pnpm lint', status: 'open' } }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Allow once' }));
  expect(api.resolveRequest).not.toHaveBeenCalled();
});

test('pins the highest-priority unresolved request and forwards decisions and interruption from the composer', async () => {
  const api = install('active-in-fractal');
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  act(() => {
    emit({ ref, loadId, seq: seq++, type: 'request.opened', request: { id: 'question', kind: 'question', provider: 'codex', prompt: 'Which option?', fieldId: 'choice', allowFreeText: true, status: 'open' } });
    emit({ ref, loadId, seq: seq++, type: 'request.opened', request: { id: 'approval', kind: 'approval', provider: 'codex', title: 'Run command?', operation: 'pnpm lint', status: 'open' } });
  });
  expect(screen.getByRole('region', { name: 'Approval request' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Question request' })).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
  expect(api.resolveRequest).toHaveBeenCalledWith('approval', { kind: 'allow-once' });
  fireEvent.click(screen.getByRole('button', { name: 'Interrupt session' }));
  expect(api.interrupt).toHaveBeenCalledWith(ref);
  act(() => emit({ ref, loadId, seq: seq++, type: 'request.resolved', requestId: 'approval', decision: { kind: 'allow-once' } }));
  expect(screen.getByRole('region', { name: 'Question request' })).toBeTruthy();
});

test('resolves an imported historical request into audit history without a separate request-opened event', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; } });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-index') ? 280 : 560; });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  install('waiting-for-user');
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  act(() => emit({ ref, loadId, seq: seq++, type: 'history.chunk', chunkIndex: 0, turns: [{ id: 'turn', nativeId: 'turn', userMessage: { id: 'message', text: 'Run tests' }, blocks: [{ id: 'approval-block', kind: 'approval', request: { id: 'historical-approval', kind: 'approval', provider: 'codex', title: 'Run tests?', operation: 'pnpm test', status: 'open' } }], status: 'active', captureCompleteness: 'complete' }] }));
  expect(screen.getByRole('region', { name: 'Approval request' })).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(true);
  act(() => {
    emit({ ref, loadId, seq: seq++, type: 'request.resolved', requestId: 'historical-approval', decision: { kind: 'allow-once' } });
    emit({ ref, loadId, seq: seq++, type: 'runtime.changed', runtime: 'idle' });
  });
  expect(screen.queryByRole('region', { name: 'Approval request' })).toBeNull();
  expect(await screen.findByRole('region', { name: 'Resolved approval request' })).toBeTruthy();
  expect(screen.getByText('allow-once')).toBeTruthy();
  expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(false);
});
