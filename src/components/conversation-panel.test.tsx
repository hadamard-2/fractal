// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationPanel } from './conversation-panel';
import { SideChatLauncherContext, type SideChatLauncher } from '@/components/right-panel/side-chat-launcher';
import { ForkLauncherContext, type ForkLauncher } from '@/components/conversation/fork-launcher';
import { forkDraft, setForkDraft } from '@/renderer/forking';
import { quoteSelection } from '@/renderer/side-chat-start';
import { resetConversationHubForTests } from '@/renderer/conversation-hub';
import { accessLevels } from '@/shared/access-levels';
import { conversationKey, type AccessApi, type AccessListing, type AgentModel, type ConversationApi, type ConversationRef, type ConversationRuntime, type ConversationStreamEvent, type ConversationTurn, type HarnessCapabilities, type ModelChoice, type ModelsApi } from '@/shared/conversation-contract';

const ref: ConversationRef = { provider: 'codex', nativeSessionId: 'panel-test', projectPath: '/work/fractal' };
let emit: (event: ConversationStreamEvent) => void;
let loadId = '';
let seq = 0;
const allCapabilities: HarnessCapabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: true, fork: false };
function install(runtime: ConversationRuntime = 'idle', send: ConversationApi['continue'] = async () => undefined, capabilities: HarnessCapabilities = allCapabilities) {
  seq = 0;
  loadId = '';
  const api: ConversationApi = {
    list: async () => ({ projects: [], providers: [] }), create: async () => null,
    open: async (selected, id) => {
      loadId = id;
      return { summary: { ref: selected, title: 'Fix parser', updatedAt: 1, runtime, captureCompleteness: 'complete' }, capabilities };
    },
    close: async () => undefined, continue: send, interrupt: vi.fn(async () => undefined), resolveRequest: vi.fn(async () => undefined), previewAttachment: vi.fn(async () => ({ kind: 'missing' as const })), openAttachment: vi.fn(async () => undefined), rename: vi.fn(async () => undefined), fork: vi.fn(async () => { throw new Error('fork unused'); }), sideChats: vi.fn(async () => []), deleteSideChat: vi.fn(async () => undefined),
    onEvent: (listener) => { emit = listener; return () => undefined; },
  };
  Object.defineProperty(window, 'fractal', { configurable: true, value: { conversations: api } });
  resetConversationHubForTests();
  return api;
}
async function ready(target: ConversationRef = ref) {
  await waitFor(() => expect(loadId).not.toBe(''));
  act(() => emit({ ref: target, loadId, seq: seq++, type: 'history.complete' }));
}
function installModels(result: { models: AgentModel[]; choice: ModelChoice | null }) {
  const models: ModelsApi = { list: vi.fn(async () => result), choose: vi.fn(async () => undefined) };
  Object.assign(window.fractal, { models });
  return models;
}
function installAccess(listing: AccessListing) {
  const access: AccessApi = { list: vi.fn(async () => listing), choose: vi.fn(async () => undefined) };
  Object.assign(window.fractal, { access });
  return access;
}
const claudeRef: ConversationRef = { ...ref, provider: 'claude' };
const level = (id: string, picked = false) => ({ state: { kind: 'level' as const, level: id }, picked });
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
    emit({ ref, loadId, seq: seq++, type: 'request.opened', request: { id: 'question', kind: 'question', provider: 'codex', questions: [{ fieldId: 'choice', prompt: 'Which option?', allowFreeText: true }], status: 'open' } });
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
  const model = await screen.findByRole('button', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('Opus'));
  const effort = screen.getByRole('button', { name: 'Effort' });
  expect(effort.textContent).toContain('high');
  const user = userEvent.setup();
  // Efforts read from the most to the least.
  effort.focus();
  await user.keyboard('{Enter}');
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['high', 'low']);
  await user.keyboard('{Escape}');
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
  const model = await screen.findByRole('button', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('Opus'));
  const user = userEvent.setup();
  model.focus();
  await user.keyboard('{Enter}');
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Opus', 'Haiku']);
  await user.keyboard('{End}{Enter}');
  await waitFor(() => expect(models.choose).toHaveBeenCalledWith(ref, { model: 'haiku' }));
  expect(model.textContent).toBe('Haiku');
  expect(screen.queryByRole('button', { name: 'Effort' })).toBeNull();
  // Opening the picker asks again, in case the startup fetch finished since.
  expect(models.list).toHaveBeenCalledTimes(2);
});

test('older versions of a family sit under More models', async () => {
  install();
  const latest: AgentModel = { id: 'opus', label: 'Opus 5.5', efforts: ['high'] };
  const older: AgentModel = { id: 'claude-opus-5', label: 'Opus 5', efforts: ['high'] };
  const models = installModels({ models: [latest, older], choice: { model: 'opus', effort: 'high' } });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const model = await screen.findByRole('button', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('Opus 5.5'));
  const user = userEvent.setup();
  model.focus();
  await user.keyboard('{Enter}');
  expect((await screen.findAllByRole('menuitem')).map((item) => item.textContent)).toEqual(['Opus 5.5', 'More models']);
  screen.getByRole('menuitem', { name: 'More models' }).focus();
  await user.keyboard('{ArrowRight}');
  await user.click(await screen.findByRole('menuitem', { name: 'Opus 5' }));
  await waitFor(() => expect(models.choose).toHaveBeenCalledWith(ref, { model: 'claude-opus-5', effort: 'high' }));
  expect(model.textContent).toBe('Opus 5');
});

test('lists an off-catalog model the conversation last ran on', async () => {
  install();
  installModels({ models: [opus], choice: { model: 'claude-opus-5-5' } });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const model = await screen.findByRole('button', { name: 'Model' });
  await waitFor(() => expect(model.textContent).toContain('claude-opus-5-5'));
  expect(screen.queryByRole('button', { name: 'Effort' })).toBeNull();
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
  expect((await screen.findByRole('button', { name: 'Model' })).textContent).toContain('Default');
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: 'Go' }));
});

test('the send button becomes the stop button while the agent works', async () => {
  install('active-in-fractal');
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const form = screen.getByRole('textbox', { name: 'Message' }).closest('form');
  expect(screen.getByRole('button', { name: 'Interrupt session' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  expect(Array.from(form?.querySelectorAll('button') ?? []).at(-1)?.getAttribute('aria-label')).toBe('Interrupt session');
});

test('the footer reads Attach files, Access, Model, Effort, then Send', async () => {
  install();
  installAccess({ levels: accessLevels('codex'), access: level('auto'), allowDangerous: false });
  installModels({ models: [opus], choice: { model: 'opus', effort: 'high' } });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  await screen.findByRole('button', { name: 'Effort' });
  const names = Array.from(screen.getByRole('textbox', { name: 'Message' }).closest('form')?.querySelectorAll('button') ?? []).map((button) => button.getAttribute('aria-label'));
  expect(names).toEqual(['Attach files', 'Access', 'Model', 'Effort', 'Submit']);
});

test('sends the access it shows, and none when nothing is known', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  installAccess({ levels: accessLevels('codex'), access: level('auto'), allowDangerous: false });
  const { unmount } = render(<ConversationPanel conversationRef={ref} />);
  await ready();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Auto'));
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: 'Go', access: level('auto') }));
  unmount();

  const second = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', second);
  installAccess({ levels: accessLevels('codex'), access: null, allowDangerous: false });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe("Codex's default"));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(second).toHaveBeenCalledWith(ref, { text: 'Go' }));
});

test('a pick made just before sending is sent as picked', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  const access = installAccess({ levels: accessLevels('claude'), access: level('default'), allowDangerous: false });
  vi.mocked(access.choose).mockImplementation(() => new Promise<void>(() => undefined));
  render(<ConversationPanel conversationRef={claudeRef} />);
  await ready(claudeRef);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Ask'));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Access' }));
  await user.click(await screen.findByRole('menuitem', { name: /Plan/ }));
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  await waitFor(() => expect(send).toHaveBeenCalledWith(claudeRef, { text: 'Go', access: level('plan', true) }));
});

test('Shift+Tab in the message box cycles the access while idle and keeps focus', async () => {
  install('idle');
  const access = installAccess({ levels: accessLevels('claude'), access: level('default'), allowDangerous: false });
  render(<ConversationPanel conversationRef={claudeRef} />);
  await ready(claudeRef);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Ask'));
  const user = userEvent.setup();
  const input = screen.getByRole('textbox', { name: 'Message' });
  await user.click(input);
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(access.choose).toHaveBeenCalledWith(claudeRef, 'acceptEdits');
  expect(document.activeElement).toBe(input);
  expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Accept edits');
});

test('Shift+Tab does nothing while the agent is working', async () => {
  install('active-in-fractal');
  const access = installAccess({ levels: accessLevels('claude'), access: level('default'), allowDangerous: false });
  render(<ConversationPanel conversationRef={claudeRef} />);
  await ready(claudeRef);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Ask'));
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message' }), { key: 'Tab', shiftKey: true });
  expect(access.choose).not.toHaveBeenCalled();
});

test('Enter still sends from the message box', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  installAccess({ levels: accessLevels('codex'), access: level('auto'), allowDangerous: false });
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Auto'));
  await userEvent.type(screen.getByRole('textbox', { name: 'Message' }), 'Go{Enter}');
  await waitFor(() => expect(send).toHaveBeenCalledWith(ref, { text: 'Go', access: level('auto') }));
});

test('submit waits for the access listing', async () => {
  const send = vi.fn<ConversationApi['continue']>(async () => undefined);
  install('idle', send);
  // Listed on mount and again once the history loads; both stay pending until released.
  const pending: Array<(value: AccessListing) => void> = [];
  const access = installAccess({ levels: [], access: null, allowDangerous: false });
  vi.mocked(access.list).mockImplementation(() => new Promise<AccessListing>((r) => { pending.push(r); }));
  render(<ConversationPanel conversationRef={ref} />);
  await ready();
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Go');
  expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { for (const resolve of pending) resolve({ levels: accessLevels('codex'), access: level('auto'), allowDangerous: false }); });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Submit' }) as HTMLButtonElement).disabled).toBe(false));
});

test('a turn that arrives from outside Fractal lists the access again', async () => {
  install('idle');
  const access = installAccess({ levels: accessLevels('claude'), access: level('auto'), allowDangerous: false });
  render(<ConversationPanel conversationRef={claudeRef} />);
  await ready(claudeRef);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Auto'));
  const listed = vi.mocked(access.list).mock.calls.length;
  vi.mocked(access.list).mockResolvedValue({ levels: accessLevels('claude'), access: level('plan'), allowDangerous: false });
  const turn: ConversationTurn = { id: 'external', nativeId: 'external', userMessage: { id: 'u', text: 'From the terminal' }, blocks: [], status: 'completed', captureCompleteness: 'complete' };
  act(() => emit({ ref: claudeRef, loadId, seq: seq++, type: 'turn.upserted', turn }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Plan'));
  expect(vi.mocked(access.list).mock.calls.length).toBe(listed + 1);
});

test('a send refused for its access shows the reason and keeps the draft', async () => {
  install('idle', async () => { throw new Error('Bypass is turned off in Settings'); });
  installAccess({ levels: accessLevels('claude'), access: level('bypassPermissions'), allowDangerous: false });
  render(<ConversationPanel conversationRef={claudeRef} />);
  await ready(claudeRef);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Access' }).textContent).toBe('Bypass'));
  const user = userEvent.setup();
  const input = screen.getByRole('textbox', { name: 'Message' });
  await user.type(input, 'Go');
  await user.click(screen.getByRole('button', { name: 'Submit' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Bypass is turned off in Settings');
  expect((input as HTMLTextAreaElement).value).toBe('Go');
});

test('reports the runtime it loads, not the placeholder before the open settles, and follows later changes', async () => {
  install('active-externally');
  const onRuntimeChange = vi.fn();
  render(<ConversationPanel conversationRef={claudeRef} onRuntimeChange={onRuntimeChange} />);
  await ready(claudeRef);
  await waitFor(() => expect(onRuntimeChange).toHaveBeenLastCalledWith(claudeRef, 'active-externally'));
  expect(onRuntimeChange).not.toHaveBeenCalledWith(claudeRef, 'unknown');
  act(() => emit({ ref: claudeRef, loadId, seq: seq++, type: 'runtime.changed', runtime: 'idle' }));
  await waitFor(() => expect(onRuntimeChange).toHaveBeenLastCalledWith(claudeRef, 'idle'));
});

test.each([
  [{ approvals: true, questions: false }, 'Claude Code question routing is unavailable. Fractal will not bypass native permissions.'],
  [{ approvals: false, questions: true }, 'Claude Code approval routing is unavailable. Fractal will not bypass native permissions.'],
  [{ approvals: false, questions: false }, 'Claude Code approval and question routing are unavailable. Fractal will not bypass native permissions.'],
])('names the routing the agent cannot do (%o)', async (routing, message) => {
  install('idle', undefined, { ...allCapabilities, ...routing });
  render(<ConversationPanel conversationRef={claudeRef} />);
  await ready(claudeRef);
  expect((await screen.findByText(message)).getAttribute('role')).toBe('status');
});

test('shows no routing notice when the agent can route approvals and questions', async () => {
  install('idle');
  render(<ConversationPanel conversationRef={claudeRef} />);
  await ready(claudeRef);
  await waitFor(() => expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).disabled).toBe(false));
  expect(screen.queryByText(/routing (is|are) unavailable/)).toBeNull();
});

describe('the side-chat selection menu', () => {
  const turn = (id: string, ask: string, reply: string, status: ConversationTurn['status'] = 'completed'): ConversationTurn => ({
    id, nativeId: id, userMessage: { id: `${id}-user`, text: ask },
    blocks: [{ id: `${id}-prose`, kind: 'assistant-prose', text: reply, provider: 'codex' }],
    status, captureCompleteness: 'complete',
  });
  const first = turn('t1', 'Why is the parser slow?', 'It re-reads every file.');
  const second = turn('t2', 'Which file is worst?', 'The lockfile.');

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; } });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-index') ? 120 : 560; });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
    Range.prototype.getBoundingClientRect = () => DOMRect.fromRect({ x: 120, y: 200, width: 80, height: 20 });
  });
  afterEach(() => {
    Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
    window.getSelection()?.removeAllRanges();
  });

  async function open(props: { active?: boolean; readOnly?: boolean; launcher?: SideChatLauncher | null; runtime?: ConversationRuntime; turns?: ConversationTurn[] } = {}) {
    const launcher = props.launcher === undefined ? { start: vi.fn(), open: vi.fn() } : props.launcher;
    install(props.runtime ?? 'idle');
    render(
      <SideChatLauncherContext.Provider value={launcher}>
        <ConversationPanel active={props.active} conversationRef={ref} readOnly={props.readOnly} />
      </SideChatLauncherContext.Provider>,
    );
    await ready();
    act(() => emit({ ref, loadId, seq: seq++, type: 'history.chunk', chunkIndex: 0, turns: props.turns ?? [first, second] }));
    await screen.findByText(second.blocks[0].kind === 'assistant-prose' ? second.blocks[0].text : '');
    return launcher;
  }

  /** Selects from `start` to `end` as a drag across the page would; elements are found by their text. */
  function select(start: string | HTMLElement, end: string | HTMLElement = start, offsets?: [number, number]) {
    const from = (typeof start === 'string' ? screen.getByText(start) : start).firstChild;
    const to = (typeof end === 'string' ? screen.getByText(end) : end).firstChild;
    if (!from || !to) throw new Error('No text to select');
    const range = document.createRange();
    range.setStart(from, offsets?.[0] ?? 0);
    range.setEnd(to, offsets?.[1] ?? to.textContent?.length ?? 0);
    act(() => {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
  }
  const menu = () => screen.queryByRole('button', { name: 'Side chat' });

  test('choosing it starts a side chat after that reply with the selection quoted, and clears the selection', async () => {
    const launcher = await open();
    select('It re-reads every file.', 'It re-reads every file.', [3, 18]);
    const entry = menu();
    if (!entry) throw new Error('No menu');
    await userEvent.setup().click(entry);
    expect(launcher?.start).toHaveBeenCalledWith({ root: ref, parent: ref, turn: first, text: quoteSelection('re-reads every') });
    expect(window.getSelection()?.isCollapsed).toBe(true);
    expect(menu()).toBeNull();
  });

  test('text selected in a user message branches after that same turn', async () => {
    const launcher = await open();
    select('Which file is worst?');
    const entry = menu();
    if (!entry) throw new Error('No menu');
    await userEvent.setup().click(entry);
    expect(launcher?.start).toHaveBeenCalledWith({ root: ref, parent: ref, turn: second, text: quoteSelection('Which file is worst?') });
  });

  test('offers nothing for a subagent conversation', async () => {
    await open({ readOnly: true });
    select('It re-reads every file.');
    expect(menu()).toBeNull();
  });

  test('offers nothing in the turn that is still running, but still in the finished one before it', async () => {
    await open({ runtime: 'active-in-fractal', turns: [first, turn('t2', 'Which file is worst?', 'The lockfile.', 'active')] });
    select('The lockfile.');
    expect(menu()).toBeNull();
    select('It re-reads every file.');
    expect(menu()).toBeTruthy();
  });

  test('offers nothing for text in the composer', async () => {
    await open();
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    await userEvent.setup().type(input, 'Draft question');
    input.setSelectionRange(0, 5);
    act(() => { document.dispatchEvent(new Event('selectionchange')); });
    expect(menu()).toBeNull();
  });

  test('offers nothing for a selection across two turns', async () => {
    await open();
    select('It re-reads every file.', 'Which file is worst?');
    expect(menu()).toBeNull();
  });

  test('offers nothing until the history has finished loading', async () => {
    install();
    render(
      <SideChatLauncherContext.Provider value={{ start: vi.fn(), open: vi.fn() }}>
        <ConversationPanel conversationRef={ref} />
      </SideChatLauncherContext.Provider>,
    );
    await waitFor(() => expect(loadId).not.toBe(''));
    act(() => emit({ ref, loadId, seq: seq++, type: 'history.chunk', chunkIndex: 0, turns: [first, second] }));
    await screen.findByText('The lockfile.');
    select('It re-reads every file.');
    expect(menu()).toBeNull();

    act(() => emit({ ref, loadId, seq: seq++, type: 'history.complete' }));
    select('It re-reads every file.');
    expect(menu()).toBeTruthy();
  });

  test('offers nothing without a launcher, or while the panel is not active', async () => {
    await open({ launcher: null });
    select('It re-reads every file.');
    expect(menu()).toBeNull();
    cleanup();
    await open({ active: false });
    select('It re-reads every file.');
    expect(menu()).toBeNull();
  });
});

describe('the live status line', () => {
  const status = () => screen.queryByRole('status', { name: 'Agent status' });
  const transcript = () => screen.getByRole('log', { name: 'Conversation transcript' });
  // jsdom has no layout: give the timeline a viewport and its rows a height so it renders them.
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: (): void => undefined });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-index') ? 120 : 560; });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  });

  test('says the agent is thinking as soon as a run starts, in place of an empty transcript', async () => {
    install('active-in-fractal');
    render(<ConversationPanel conversationRef={ref} />);
    await ready();
    expect(status()?.textContent).toMatch(/^Thinking · 0s$/);
    expect(screen.queryByText('No messages yet')).toBeNull();
    expect(screen.queryByText(/The agent is working/)).toBeNull();
  });

  test('sits in the transcript after the last turn, where the reply continues', async () => {
    install('active-in-fractal');
    render(<ConversationPanel conversationRef={ref} />);
    await ready();
    const running: ConversationTurn = {
      id: 't1', nativeId: 't1', userMessage: { id: 'u1', text: 'Run the tests' }, status: 'active', captureCompleteness: 'complete',
      blocks: [{ id: 'p1', kind: 'work-packet', status: 'active', actions: [{ id: 'a1', nativeId: 'a1', provider: 'codex', captureCompleteness: 'complete', kind: 'command', command: 'pnpm test', status: 'running', startedAt: Date.now() }] }],
    };
    act(() => emit({ ref, loadId, seq: seq++, type: 'turn.upserted', turn: running }));
    await waitFor(() => expect(status()?.textContent).toMatch(/^Running a command · \d+s$/));
    const line = within(transcript()).getByRole('status', { name: 'Agent status' });
    const turn = within(transcript()).getByRole('article', { name: 'Conversation turn' });
    expect(turn.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('does not read a previous turn its transcript left active as the run it just started', async () => {
    install('idle', () => new Promise<void>(() => undefined));
    render(<ConversationPanel conversationRef={ref} />);
    await ready();
    const previous: ConversationTurn = { id: 't0', nativeId: 't0', userMessage: { id: 'u0', text: 'Hi' }, status: 'active', captureCompleteness: 'complete', blocks: [{ id: 'x', kind: 'assistant-prose', text: 'Hello there.', provider: 'codex' }] };
    act(() => emit({ ref, loadId, seq: seq++, type: 'history.chunk', chunkIndex: 0, turns: [previous] }));
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Next question');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(within(transcript()).getByRole('status', { name: 'Agent status' }).textContent).toMatch(/^Thinking · 0s$/));
  });

  test('is absent while the agent is idle, and while it waits on a request', async () => {
    install('idle');
    render(<ConversationPanel conversationRef={ref} />);
    await ready();
    expect(status()).toBeNull();
    cleanup();
    install('active-in-fractal');
    render(<ConversationPanel conversationRef={ref} />);
    await ready();
    act(() => emit({ ref, loadId, seq: seq++, type: 'request.opened', request: { id: 'approval', kind: 'approval', provider: 'codex', title: 'Run command?', operation: 'pnpm lint', status: 'open' } }));
    expect(status()).toBeNull();
  });
});

describe('forking from Execute', () => {
  const turn = (id: string, ask: string, reply: string): ConversationTurn => ({
    id, nativeId: id, userMessage: { id: `${id}-user`, text: ask },
    blocks: [{ id: `${id}-prose`, kind: 'assistant-prose', text: reply, provider: 'claude', concludesTurn: true }],
    status: 'completed', captureCompleteness: 'complete',
  });
  const first = turn('t1', 'Why is the parser slow?', 'It re-reads every file.');
  const second = turn('t2', 'Cache it', 'Cached.');
  const forkButtons = () => screen.queryAllByRole('button', { name: 'Fork from here' });

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; } });
    // Rows measure at the timeline's estimate, so mounting them resizes nothing.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.hasAttribute('data-index') ? 280 : 560; });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(560);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  });

  async function open(launcher: ForkLauncher | null, options: { readOnly?: boolean; inheritedTurnCount?: number } = {}) {
    const api = install('idle', async () => undefined, { ...allCapabilities, fork: true });
    const opened = api.open;
    api.open = async (selected, id) => ({ ...await opened(selected, id), ...(options.inheritedTurnCount === undefined ? {} : { forkedFrom: { parentKey: 'claude:parent', inheritedTurnCount: options.inheritedTurnCount } }) });
    render(<ForkLauncherContext.Provider value={launcher}><ConversationPanel conversationRef={claudeRef} readOnly={options.readOnly} /></ForkLauncherContext.Provider>);
    await ready(claudeRef);
    act(() => emit({ ref: claudeRef, loadId, seq: seq++, type: 'history.chunk', chunkIndex: 0, turns: [first, second] }));
    await screen.findByText('Cached.');
  }

  test('forks from a message or a reply with the conversation it is in', async () => {
    const launcher: ForkLauncher = { fork: vi.fn(async () => undefined), pending: false };
    await open(launcher);
    // Before and after each of the two turns.
    expect(forkButtons()).toHaveLength(4);
    fireEvent.click(forkButtons()[0]);
    expect(launcher.fork).toHaveBeenLastCalledWith(claudeRef, expect.objectContaining({ id: 't1' }), 'before');
    fireEvent.click(forkButtons()[3]);
    expect(launcher.fork).toHaveBeenLastCalledWith(claudeRef, expect.objectContaining({ id: 't2' }), 'after');
  });

  test('shows the agent\'s error when a fork fails', async () => {
    await open({ fork: vi.fn(async () => { throw new Error('Claude could not fork this session'); }), pending: false });
    fireEvent.click(forkButtons()[1]);
    expect((await screen.findByRole('alert')).textContent).toBe('Claude could not fork this session');
  });

  test('offers no fork while one is being made, without a launcher, or in a subagent conversation', async () => {
    await open({ fork: vi.fn(), pending: true });
    expect(forkButtons()).toHaveLength(0);
    cleanup();
    await open(null);
    expect(forkButtons()).toHaveLength(0);
    cleanup();
    await open({ fork: vi.fn(), pending: false }, { readOnly: true });
    expect(forkButtons()).toHaveLength(0);
  });

  test('marks where a fork\'s own turns begin', async () => {
    await open(null, { inheritedTurnCount: 1 });
    const divider = screen.getByRole('separator', { name: 'Forked here' });
    const [inherited, own] = screen.getAllByRole('article');
    expect(inherited.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(own) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('starts a fork made before a message with that message in its composer, once', async () => {
    const key = conversationKey(claudeRef);
    setForkDraft(key, { text: 'Why is the parser slow?', files: [{ filename: 'notes.md', mediaType: 'application/octet-stream', url: '', path: '/work/fractal/notes.md' }] });
    await open(null);
    expect((screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement).value).toBe('Why is the parser slow?');
    expect(screen.getByText('notes.md')).toBeTruthy();
    expect(forkDraft(key)).toBeUndefined();
  });

  test('sends a fork\'s pre-filled message as it was: its text, its image as bytes and its file by path', async () => {
    URL.revokeObjectURL = vi.fn();
    const send = vi.fn<ConversationApi['continue']>(async () => undefined);
    install('idle', send, { ...allCapabilities, fork: true });
    setForkDraft(conversationKey(claudeRef), { text: 'Why is the parser slow?', files: [
      { filename: 'image.png', mediaType: 'image/png', url: 'data:image/png;base64,AAA' },
      { filename: 'notes.md', mediaType: 'application/octet-stream', url: '', path: '/work/fractal/notes.md' },
    ] });
    render(<ConversationPanel conversationRef={claudeRef} />);
    await ready(claudeRef);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith(claudeRef, expect.objectContaining({
      text: 'Why is the parser slow?',
      attachments: [{ kind: 'bytes', name: 'image.png', mediaType: 'image/png', data: 'AAA' }, { kind: 'path', path: '/work/fractal/notes.md' }],
    }));
  });
});
