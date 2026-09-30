// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { ConversationPanel } from './conversation-panel';
import type { AgentModel, ConversationApi, ConversationRef, ConversationRuntime, ConversationStreamEvent, ModelChoice, ModelsApi } from '@/shared/conversation-contract';

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
    close: async () => undefined, continue: send, interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), previewAttachment: vi.fn(async () => ({ kind: 'missing' as const })), openAttachment: vi.fn(async () => undefined), rename: vi.fn(async () => undefined),
    onEvent: (listener) => { emit = listener; return () => undefined; },
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api } });
  return api;
}
async function ready() {
  await waitFor(() => expect(loadId).not.toBe(''));
  act(() => emit({ ref, loadId, seq: seq++, type: 'history.complete' }));
}
function installModels(result: { models: AgentModel[]; choice: ModelChoice | null }) {
  const models: ModelsApi = { list: vi.fn(async () => result), choose: vi.fn(async () => undefined) };
  Object.assign(window.fractal, { models });
  return models;
}
// jsdom has no layout; Radix scrolls the selected option into view.
beforeAll(() => { Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: (): void => undefined }); });
const opus: AgentModel = { id: 'opus', label: 'Opus', description: 'Everyday work', efforts: ['low', 'high'] };
const haiku: AgentModel = { id: 'haiku', label: 'Haiku', efforts: [] };
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

test('attaches a picked file, sends it by path with no text, and clears it after sending', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  Object.assign(window.fractal, { attachments: { pathFor: () => '/work/fractal/notes.md' } });
  URL.createObjectURL = vi.fn(() => 'blob:notes');
  URL.revokeObjectURL = vi.fn();
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  await userEvent.upload(screen.getByLabelText('Upload files'), new File(['# Notes'], 'notes.md', { type: 'text/markdown' }));
  expect(screen.getByText('notes.md')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: '', attachments: [{ kind: 'path', path: '/work/fractal/notes.md' }] }));
  await waitFor(() => expect(screen.queryByText('notes.md')).toBeNull());
});

test('keeps attachments when the send fails', async () => {
  install('idle', async () => { throw new Error('Error invoking remote method: /work/fractal/notes.md no longer exists or cannot be read'); });
  Object.assign(window.fractal, { attachments: { pathFor: () => '/work/fractal/notes.md' } });
  URL.createObjectURL = vi.fn(() => 'blob:notes');
  URL.revokeObjectURL = vi.fn();
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  await userEvent.upload(screen.getByLabelText('Upload files'), new File(['# Notes'], 'notes.md', { type: 'text/markdown' }));
  await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no longer exists'));
  expect(screen.getByText('notes.md')).toBeTruthy();
});

test('attaches a pasted pathless image as a chip and sends it as bytes', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  Object.assign(window.fractal, { attachments: { pathFor: () => '' } });
  URL.createObjectURL = vi.fn(() => 'blob:shot');
  URL.revokeObjectURL = vi.fn();
  const png = new File(['fake-png-bytes'], 'shot.png', { type: 'image/png' });
  const originalFileReader = globalThis.FileReader;
  class StubFileReader {
    onloadend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    result: string | null = null;
    readAsDataURL() {
      this.result = 'data:image/png;base64,ZmFrZS1wbmctYnl0ZXM=';
      this.onloadend?.();
    }
  }
  // @ts-expect-error stubbing the global for jsdom, which has no real blob-to-data-URL pipeline
  globalThis.FileReader = StubFileReader;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async () => ({ blob: async () => new Blob(['fake-png-bytes'], { type: 'image/png' }) })) as unknown as typeof fetch;
  try {
    render(<ConversationPanel conversationRef={ref} />);
    await ready();
    const textarea = screen.getByLabelText('Message');
    const clipboardData = { items: [{ kind: 'file', getAsFile: () => png }] } as unknown as DataTransfer;
    fireEvent.paste(textarea, { clipboardData });
    expect(await screen.findByText('shot.png')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: '', attachments: [{ kind: 'bytes', name: 'shot.png', mediaType: 'image/png', data: 'ZmFrZS1wbmctYnl0ZXM=' }] }));
  } finally {
    globalThis.FileReader = originalFileReader;
    globalThis.fetch = originalFetch;
  }
});

test('attaches a dropped file and sends it by path', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  Object.assign(window.fractal, { attachments: { pathFor: () => '/work/fractal/notes.md' } });
  URL.createObjectURL = vi.fn(() => 'blob:notes');
  URL.revokeObjectURL = vi.fn();
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const file = new File(['# Notes'], 'notes.md', { type: 'text/markdown' });
  const dataTransfer = { types: ['Files'], files: [file] } as unknown as DataTransfer;
  const form = screen.getByLabelText('Message').closest('form') as HTMLFormElement;
  fireEvent.drop(form, { dataTransfer });
  expect(await screen.findByText('notes.md')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: '', attachments: [{ kind: 'path', path: '/work/fractal/notes.md' }] }));
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

test('shows the conversation model and effort and sends them with the prompt', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  const models = installModels({ models: [opus, haiku], choice: { model: 'opus', effort: 'high' } });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const model = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('Opus'));
  expect(screen.getByRole('combobox', { name: 'Effort' }).textContent).toContain('high');
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: 'Go', model: 'opus', effort: 'high' }));
  expect(models.list).toHaveBeenCalledWith(ref);
});

test('switching to a model without effort hides the effort picker and saves the choice', async () => {
  install();
  const models = installModels({ models: [opus, haiku], choice: { model: 'opus', effort: 'high' } });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const model = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('Opus'));
  const user = userEvent.setup();
  model.focus();
  await user.keyboard('{Enter}');
  await user.keyboard('{End}{Enter}');
  await waitFor(() => expect(models.choose).toHaveBeenCalledWith(ref, { model: 'haiku' }));
  expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
  // Opening the picker asks again, in case the startup fetch finished since.
  expect(models.list).toHaveBeenCalledTimes(2);
});

test('lists an off-catalog model the conversation last ran on', async () => {
  install();
  installModels({ models: [opus], choice: { model: 'claude-opus-5-5' } });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const model = await screen.findByRole('combobox', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('claude-opus-5-5'));
  expect(screen.queryByRole('combobox', { name: 'Effort' })).toBeNull();
});

test('blocks submit until the model choice has loaded, then sends it', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  let settle: (result: { models: AgentModel[]; choice: ModelChoice | null }) => void = () => undefined;
  const models: ModelsApi = { list: vi.fn(() => new Promise<{ models: AgentModel[]; choice: ModelChoice | null }>((resolve) => { settle = resolve; })), choose: vi.fn(async () => undefined) };
  Object.assign(window.fractal, { models });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  expect(send).not.toHaveBeenCalled();
  act(() => settle({ models: [], choice: { model: 'opus' } }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Submit' }).hasAttribute('disabled')).toBe(false));
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: 'Go', model: 'opus' }));
});

test('falls back to the agent default when the model list is unavailable', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  expect((await screen.findByRole('combobox', { name: 'Model' })).textContent).toContain('Default');
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: 'Go' }));
});
