import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as boundary from '@/main/agent-ipc';
import { ConversationService } from '@/main/conversation-service';
import { ConversationRegistry } from '@/main/conversation-registry';
import type { HarnessAdapter } from '@/main/harness/types';
import type { AccessChoices } from '@/main/access-choices';
import type { ModelChoices } from '@/main/model-choices';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  picker: vi.fn(),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {}, BrowserWindow: {}, dialog: { showOpenDialog: electron.picker },
  shell: { openPath: electron.openPath, showItemInFolder: electron.showItemInFolder },
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      if (electron.handlers.has(channel)) throw new Error('Duplicate handler');
      electron.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => electron.handlers.delete(channel),
  },
}));

const attachments = vi.hoisted(() => ({
  resolve: vi.fn(async (prompt: { text: string }) => ({ text: prompt.text })),
  preview: vi.fn(async () => ({ kind: 'missing' as const })),
}));
vi.mock('@/main/attachments/resolve', async (actual) => ({ ...(await actual<typeof import('@/main/attachments/resolve')>()), resolveAttachments: attachments.resolve }));
vi.mock('@/main/attachments/preview', () => ({ readAttachmentPreview: attachments.preview }));

const ref = { provider: 'codex' as const, nativeSessionId: 'session', projectPath: '/repo' };
const loadId = '00000000-0000-4000-8000-000000000001';
const nextId = '00000000-0000-4000-8000-000000000002';
const complete = { type: 'history.complete', ref, loadId, seq: 0 };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
class Sender extends EventEmitter {
  id = 41;
  mainFrame = {};
  destroyed = false;
  send = vi.fn();
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('destroyed'); }
}
function fixture(modelChoices?: Pick<ModelChoices, 'seed' | 'recordSend'>, accessChoices?: Pick<AccessChoices, 'validateSend' | 'recordSend' | 'forget' | 'inherit'>) {
  const service = {
    list: vi.fn(async () => ({ projects: [], providers: [] })),
    open: vi.fn(async () => ({ summary: { ref }, capabilities: {} })), close: vi.fn(async () => undefined),
    create: vi.fn(async () => ref), continue: vi.fn(async () => undefined), interrupt: vi.fn(async () => undefined), rename: vi.fn(async () => undefined),
    fork: vi.fn(async () => ({ ...ref, nativeSessionId: 'forked' })), sideChats: vi.fn((): unknown[] => []), deleteSideChat: vi.fn(async (): Promise<unknown[]> => []), branchKind: vi.fn((): 'side-chat' | 'fork' | undefined => undefined), mainConversationOf: vi.fn((input: typeof ref) => input),
    resolveRequest: vi.fn(async () => undefined), denyRequestsForOwner: vi.fn(async () => undefined),
    attachmentAllowed: vi.fn((_ref: unknown, path: string) => path === '/repo/notes.md'),
  };
  const sender = new Sender();
  let current = sender;
  const getWindow = () => ({ webContents: current, isDestroyed: () => current.destroyed }) as unknown as BrowserWindow;
  const register = () => boundary.registerConversationIpc(service as unknown as ConversationService, getWindow, { attachmentsRoot: '/data/attachments', ...(modelChoices ? { modelChoices } : {}), ...(accessChoices ? { accessChoices } : {}) });
  const registration = register();
  const invokeAs = async (source: Sender, channel: string, ...args: unknown[]) => {
    const handler = electron.handlers.get(`fractal:conversations:${channel}`);
    if (!handler) throw new Error('Missing channel');
    return handler({ sender: source, senderFrame: source.mainFrame } as unknown as IpcMainInvokeEvent, ...args);
  };
  return { service, sender, registration, register, invokeAs,
    useSender: (source: Sender) => { current = source; },
    invoke: (channel: string, ...args: unknown[]) => invokeAs(sender, channel, ...args),
  };
}
beforeEach(() => { electron.handlers.clear(); electron.picker.mockReset(); });
afterEach(async () => { await boundary.disposeConversationIpc?.(); });

describe('conversation IPC', () => {
  test.each([
    ['continue', [{ provider: 'bad' }, { text: 'hi' }], 'Invalid conversation reference'],
    ['continue', [ref, { text: '' }], 'Prompt cannot be empty'],
    ['open', [ref, 'not-a-uuid'], 'Invalid load id'],
    ['close', [null], 'Invalid conversation reference'],
    ['interrupt', [{ ...ref, projectPath: 'relative' }], 'Invalid conversation reference'],
    ['create', [{ provider: 'bad' }], 'Invalid conversation provider'],
    ['create', [{ provider: 'codex', projectPath: 42 }], 'Invalid conversation project'],
    ['create', [{ provider: 'codex', projectPath: '/repo', extra: true }], 'Invalid conversation provider'],
    ['resolve-request', ['', { kind: 'allow-once' }], 'Invalid request id'],
    ['resolve-request', ['request', { kind: 'allow-always' }], 'Invalid decision'],
    ['list', ['unexpected'], 'Invalid conversation arguments'],
    ['rename', [ref, '  '], 'Invalid conversation title'],
    ['rename', [{ ...ref, projectPath: 'relative' }, 'Name'], 'Invalid conversation reference'],
    ['fork', [{ ...ref, projectPath: 'relative' }, { turnId: 't1', position: 'after' }, 'fork'], 'Invalid conversation reference'],
    ['fork', [ref, { turnId: '', position: 'after' }, 'fork'], 'Invalid fork point'],
    ['fork', [ref, { turnId: 't1', position: 'beside' }, 'fork'], 'Invalid fork point'],
    ['fork', [ref, { turnId: 't1', position: 'after' }, 'branch'], 'Invalid branch kind'],
    ['fork', [ref, { turnId: 't1', position: 'after' }], 'Invalid conversation arguments'],
    ['side-chats', [{ ...ref, projectPath: 'relative' }], 'Invalid conversation reference'],
    ['side-chats', [ref, ref], 'Invalid conversation arguments'],
    ['side-chats', [], 'Invalid conversation arguments'],
    ['delete-side-chat', [{ ...ref, projectPath: 'relative' }], 'Invalid conversation reference'],
    ['delete-side-chat', [ref, ref], 'Invalid conversation arguments'],
    ['delete-side-chat', [], 'Invalid conversation arguments'],
  ])('rejects invalid %s inputs before dispatch', async (channel, args, message) => {
    const f = fixture();
    await expect(f.invoke(channel, ...args)).rejects.toThrow(message);
    for (const method of Object.values(f.service)) expect(method).not.toHaveBeenCalled();
    expect(electron.picker).not.toHaveBeenCalled();
  });

  test('registers only the conversation invoke handlers, is idempotent, and preserves unrelated handlers', async () => {
    const unrelated = vi.fn(); electron.handlers.set('unrelated', unrelated);
    const f = fixture();
    expect(f.register()).toBe(f.registration);
    expect([...electron.handlers.keys()].sort()).toEqual(['unrelated', ...['list', 'open', 'close', 'create', 'continue', 'interrupt', 'resolve-request', 'preview-attachment', 'open-attachment', 'rename', 'fork', 'side-chats', 'delete-side-chat'].map((name) => `fractal:conversations:${name}`)].sort());
    await f.invoke('list');
    await boundary.disposeConversationIpc(); await boundary.disposeConversationIpc();
    expect([...electron.handlers.keys()]).toEqual(['unrelated']);
    expect(electron.handlers.get('unrelated')).toBe(unrelated);
  });

  test('rejects foreign webContents, subframes, and destroyed senders', async () => {
    const f = fixture();
    await expect(f.invokeAs(new Sender(), 'list')).rejects.toThrow('Unauthorized conversation sender');
    const handler = electron.handlers.get('fractal:conversations:list');
    if (!handler) throw new Error('Missing list handler');
    await expect(handler({ sender: f.sender, senderFrame: {} } as unknown as IpcMainInvokeEvent)).rejects.toThrow('Unauthorized conversation sender');
    f.sender.destroy();
    await expect(f.invoke('list')).rejects.toThrow('Unauthorized conversation sender');
    expect(f.service.list).not.toHaveBeenCalled();
  });

  test('routes sanitized events only to the owner with a matching ref and generation', async () => {
    const f = fixture();
    await f.invoke('open', { ...ref, nativeFile: '/private' }, loadId);
    expect(f.service.open).toHaveBeenCalledWith(ref, loadId);
    f.registration.emit({ ...complete, nativeFile: '/private' });
    f.registration.emit({ ...complete, loadId: nextId });
    f.registration.emit({ ...complete, ref: { ...ref, projectPath: '/wrong' } });
    f.registration.emit({ ...complete, seq: -1 });
    expect(f.sender.send.mock.calls).toEqual([['fractal:conversations:event', complete]]);
    await f.invoke('close', ref);
    f.registration.emit(complete);
    expect(f.sender.send).toHaveBeenCalledTimes(1);
  });

  test('renames without an open load, passing the trimmed title', async () => {
    const f = fixture();
    await f.invoke('rename', ref, ' New name ');
    expect(f.service.rename).toHaveBeenCalledWith(ref, 'New name');
  });

  test('passes transport-owned renderer identity to continuation', async () => {
    const f = fixture(); await f.invoke('open', ref, loadId);
    await f.invoke('continue', ref, { text: 'Go' });
    expect(f.service.continue).toHaveBeenCalledWith(ref, { text: 'Go' }, '41');
  });

  test('denies another sender taking a load, closing a load, or answering its request', async () => {
    const f = fixture(); await f.invoke('open', ref, loadId);
    f.registration.emit({ ...complete, type: 'request.opened', request: { id: 'request', provider: 'codex', kind: 'approval', title: 'Run', operation: 'ls', status: 'open' } });
    const other = new Sender(); other.id = 42; f.useSender(other);
    for (const [channel, args] of [['open', [ref, nextId]], ['close', [ref]], ['continue', [ref, { text: 'hi' }]], ['interrupt', [ref]], ['resolve-request', ['request', { kind: 'allow-once' }]]] as const) {
      await expect(f.invokeAs(other, channel, ...args)).rejects.toThrow('Conversation is not owned by this renderer');
    }
    expect(f.service.open).toHaveBeenCalledTimes(1);
    expect(f.service.close).not.toHaveBeenCalled(); expect(f.service.resolveRequest).not.toHaveBeenCalled();
    f.useSender(f.sender);
    await f.invoke('resolve-request', 'request', { kind: 'deny', reason: 'No', native: 'secret' });
    expect(f.service.resolveRequest).toHaveBeenCalledWith('request', { kind: 'deny', reason: 'No' });
    await expect(f.invoke('resolve-request', 'request', { kind: 'allow-once' })).rejects.toThrow('Conversation is not owned by this renderer');
  });

  test('closes loads and denies pending ownership once on destruction without removing unrelated listeners', async () => {
    const f = fixture(); const unrelated = vi.fn(); f.sender.on('destroyed', unrelated);
    const pending = deferred<{ summary: { ref: typeof ref }; capabilities: Record<string, never> }>();
    f.service.open.mockReturnValue(pending.promise);
    const opening = f.invoke('open', ref, loadId);
    const failed = expect(opening).rejects.toThrow('Conversation operation failed');
    f.sender.destroy();
    pending.resolve({ summary: { ref }, capabilities: {} }); await failed;
    f.registration.emit(complete);
    expect(f.service.close.mock.calls).toEqual([[ref]]);
    expect(f.service.denyRequestsForOwner.mock.calls).toEqual([['41', 'Fractal window closed']]);
    expect(f.sender.send).not.toHaveBeenCalled();
    await boundary.disposeConversationIpc();
    expect(f.sender.listeners('destroyed')).toEqual([unrelated]);
  });

  test('reload releases the old generation and a stale open cannot remove the new load', async () => {
    const f = fixture(); const pending = deferred<{ summary: { ref: typeof ref }; capabilities: Record<string, never> }>();
    f.service.open.mockReturnValueOnce(pending.promise);
    const old = f.invoke('open', ref, loadId); const failed = expect(old).rejects.toThrow();
    f.sender.emit('did-start-navigation', {}, 'file:///index.html', false, true);
    await f.invoke('open', ref, nextId);
    pending.resolve({ summary: { ref }, capabilities: {} }); await failed;
    f.registration.emit(complete); f.registration.emit({ ...complete, loadId: nextId });
    expect(f.sender.send.mock.calls).toEqual([['fractal:conversations:event', { ...complete, loadId: nextId }]]);
    expect(f.service.close).toHaveBeenCalledTimes(1);
  });

  test('create uses only the canonical directory picker path and stops after cancellation or owner loss', async () => {
    const f = fixture();
    electron.picker.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(f.invoke('create', { provider: 'codex' })).resolves.toBeNull();
    electron.picker.mockResolvedValueOnce({ canceled: false, filePaths: ['/tmp/../tmp'] });
    await f.invoke('create', { provider: 'codex' });
    expect(f.service.create.mock.calls).toEqual([['codex', '/tmp']]);
    const pending = deferred<{ canceled: boolean; filePaths: string[] }>(); electron.picker.mockReturnValue(pending.promise);
    const creating = f.invoke('create', { provider: 'codex' }); const failed = expect(creating).rejects.toThrow('Conversation operation failed');
    f.sender.destroy(); pending.resolve({ canceled: false, filePaths: ['/tmp'] }); await failed;
    expect(f.service.create).toHaveBeenCalledTimes(1);
  });

  test('creates directly in a listed project and rejects a path outside the project list', async () => {
    const f = fixture();
    f.service.list.mockResolvedValue({ projects: [{ projectPath: '/tmp', displayName: 'tmp', conversations: [] }], providers: [] });
    await f.invoke('create', { provider: 'codex', projectPath: '/tmp/../tmp' });
    expect(f.service.create).toHaveBeenCalledWith('codex', '/tmp');
    expect(electron.picker).not.toHaveBeenCalled();

    await expect(f.invoke('create', { provider: 'codex', projectPath: '/other' })).rejects.toThrow('Conversation operation failed');
    expect(f.service.create).toHaveBeenCalledTimes(1);
  });

  test('returns the adapter native identity through the production creation boundary without wrapper storage', async () => {
    const sender = new Sender();
    const nativeRef = { provider: 'codex' as const, nativeSessionId: 'app-server-thread-42', projectPath: '/tmp' };
    const capabilities = { create: true, partialStreaming: true, approvals: true, questions: true, interrupt: true, steerWhileRunning: false, fork: false };
    const adapter: HarnessAdapter = {
      provider: 'codex', capabilities: () => capabilities,
      probe: vi.fn(async () => ({ provider: 'codex' as const, availability: 'available' as const, capabilities })),
      listConversations: vi.fn(async () => []),
      createConversation: vi.fn(async () => nativeRef),
      loadConversation: vi.fn(), watchConversation: vi.fn(), continueConversation: vi.fn(),
    };
    const service = new ConversationService(new ConversationRegistry([adapter], async (value) => value), () => undefined);
    boundary.registerConversationIpc(service, () => ({ webContents: sender, isDestroyed: () => false }) as unknown as BrowserWindow, { attachmentsRoot: '/data/attachments' });
    electron.picker.mockResolvedValue({ canceled: false, filePaths: ['/tmp/../tmp'] });
    const handler = electron.handlers.get('fractal:conversations:create');
    if (!handler) throw new Error('Missing create handler');

    const result = await handler({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent, { provider: 'codex' });

    expect(adapter.createConversation).toHaveBeenCalledWith('/tmp');
    expect(result).toEqual(nativeRef);
    expect(Object.keys(result as object).sort()).toEqual(['nativeSessionId', 'projectPath', 'provider']);
    expect(adapter.loadConversation).not.toHaveBeenCalled();
    expect(adapter.watchConversation).not.toHaveBeenCalled();
    await service.dispose();
  });

  test('service and picker exceptions never expose native details', async () => {
    const f = fixture(); f.service.list.mockRejectedValue(new Error('/secret/native.json TOKEN=hidden'));
    await expect(f.invoke('list')).rejects.toThrow(/^Conversation operation failed$/);
    electron.picker.mockRejectedValue(new Error('/secret/native.json TOKEN=hidden'));
    await expect(f.invoke('create', { provider: 'claude' })).rejects.toThrow(/^Conversation operation failed$/);
  });

  test('real service releases a native watch that arrives after renderer destruction', async () => {
    const sender = new Sender();
    const pending = deferred<() => void>(); const unsubscribe = vi.fn();
    const capabilities = { create: false, partialStreaming: true, approvals: false, questions: false, interrupt: false, steerWhileRunning: false, fork: false };
    const summary = { ref, title: 'Session', updatedAt: 1, runtime: 'idle' as const, captureCompleteness: 'complete' as const };
    const adapter: HarnessAdapter = {
      provider: 'codex', capabilities: () => capabilities,
      probe: async () => ({ provider: 'codex', availability: 'available', capabilities }),
      listConversations: async () => [summary],
      watchConversation: vi.fn(() => pending.promise),
      loadConversation: vi.fn(), createConversation: vi.fn(), continueConversation: vi.fn(),
    };
    const service = new ConversationService(new ConversationRegistry([adapter], async (path) => path), (event) => registration.emit(event));
    const registration = boundary.registerConversationIpc(service, () => ({ webContents: sender, isDestroyed: () => false }) as unknown as BrowserWindow, { attachmentsRoot: '/data/attachments' });
    const handler = electron.handlers.get('fractal:conversations:open'); if (!handler) throw new Error('Missing open handler');
    const opening = handler({ sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent, ref, loadId);
    const failed = expect(opening).rejects.toThrow('Conversation operation failed');
    await vi.waitFor(() => expect(adapter.watchConversation).toHaveBeenCalledTimes(1));
    sender.destroy(); pending.resolve(unsubscribe); await failed;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(adapter.loadConversation).not.toHaveBeenCalled(); expect(sender.send).not.toHaveBeenCalled();
    await service.dispose();
  });

  test('does not remove a pre-existing channel when registration fails midway', async () => {
    const unrelated = vi.fn(); electron.handlers.set('fractal:conversations:open', unrelated);
    expect(() => fixture()).toThrow('Duplicate handler');
    expect([...electron.handlers.entries()]).toEqual([['fractal:conversations:open', unrelated]]);
  });

  test('send failure detaches the owner and prevents later events from reaching it', async () => {
    const f = fixture(); await f.invoke('open', ref, loadId);
    f.sender.send.mockImplementation(() => { throw new Error('Destroyed recipient'); });
    expect(() => f.registration.emit(complete)).not.toThrow();
    f.registration.emit(complete);
    expect(f.sender.send).toHaveBeenCalledTimes(1);
    expect(f.service.close.mock.calls).toEqual([[ref]]);
    expect(f.service.denyRequestsForOwner.mock.calls).toEqual([['41', 'Fractal window closed']]);
  });

  test('resolves attachments before continuing and surfaces attachment errors by name', async () => {
    const f = fixture();
    await f.invoke('open', ref, loadId);
    attachments.resolve.mockResolvedValueOnce({ text: 'Go', attachments: [{ path: '/repo/a.ts' }] } as never);
    await f.invoke('continue', ref, { text: 'Go', attachments: [{ kind: 'path', path: '/repo/a.ts' }] });
    expect(attachments.resolve).toHaveBeenLastCalledWith({ text: 'Go', attachments: [{ kind: 'path', path: '/repo/a.ts' }] }, { root: '/data/attachments', ref });
    expect(f.service.continue).toHaveBeenLastCalledWith(ref, { text: 'Go', attachments: [{ path: '/repo/a.ts' }] }, '41');
    const { AttachmentError } = await import('@/main/attachments/resolve');
    attachments.resolve.mockRejectedValueOnce(new AttachmentError('/repo/gone.ts no longer exists or cannot be read'));
    await expect(f.invoke('continue', ref, { text: 'Go', attachments: [{ kind: 'path', path: '/repo/gone.ts' }] })).rejects.toThrow('/repo/gone.ts no longer exists or cannot be read');
    attachments.resolve.mockRejectedValueOnce(new Error('EACCES secret detail'));
    await expect(f.invoke('continue', ref, { text: 'Go', attachments: [{ kind: 'path', path: '/repo/x.ts' }] })).rejects.toThrow('Conversation operation failed');
  });

  test('previews and opens only attachments of an owned conversation', async () => {
    const f = fixture();
    await expect(f.invoke('preview-attachment', ref, '/repo/notes.md')).rejects.toThrow('Conversation is not owned by this renderer');
    await f.invoke('open', ref, loadId);
    await expect(f.invoke('preview-attachment', ref, '/repo/notes.md')).resolves.toEqual({ kind: 'missing' });
    expect(attachments.preview).toHaveBeenLastCalledWith('/repo/notes.md');
    await expect(f.invoke('preview-attachment', ref, '/etc/passwd')).rejects.toThrow('Attachment is not part of this conversation');
    await expect(f.invoke('preview-attachment', ref, 'relative.md')).rejects.toThrow('Invalid attachment path');
    await f.invoke('open-attachment', ref, '/repo/notes.md', 'reveal');
    expect(electron.showItemInFolder).toHaveBeenCalledWith('/repo/notes.md');
    await f.invoke('open-attachment', ref, '/repo/notes.md', 'open');
    expect(electron.openPath).toHaveBeenCalledWith('/repo/notes.md');
    await expect(f.invoke('open-attachment', ref, '/etc/passwd', 'open')).rejects.toThrow('Attachment is not part of this conversation');
    await expect(f.invoke('open-attachment', ref, '/repo/notes.md', 'delete')).rejects.toThrow('Invalid attachment action');
  });

  test('seeds a created conversation and records the choice each prompt was sent with', async () => {
    const modelChoices = { seed: vi.fn(), recordSend: vi.fn() };
    const f = fixture(modelChoices);
    f.service.list.mockResolvedValue({ projects: [{ projectPath: '/tmp', displayName: 'tmp', conversations: [] }], providers: [] });
    await f.invoke('create', { provider: 'codex', projectPath: '/tmp' });
    expect(modelChoices.seed).toHaveBeenCalledWith(ref);
    await f.invoke('open', ref, loadId);
    await f.invoke('continue', ref, { text: 'Go', model: 'gpt-5.5', effort: 'high' });
    expect(modelChoices.recordSend).toHaveBeenLastCalledWith(ref, { model: 'gpt-5.5', effort: 'high' });
    await f.invoke('continue', ref, { text: 'Again' });
    expect(modelChoices.recordSend).toHaveBeenLastCalledWith(ref, null);
  });

  test('a failing choice store does not fail creating or sending', async () => {
    const modelChoices = { seed: vi.fn(() => { throw new Error('disk full'); }), recordSend: vi.fn(() => { throw new Error('disk full'); }) };
    const f = fixture(modelChoices);
    f.service.list.mockResolvedValue({ projects: [{ projectPath: '/tmp', displayName: 'tmp', conversations: [] }], providers: [] });
    await expect(f.invoke('create', { provider: 'codex', projectPath: '/tmp' })).resolves.toEqual(ref);
    await f.invoke('open', ref, loadId);
    await expect(f.invoke('continue', ref, { text: 'Go', model: 'gpt-5.5' })).resolves.toBeUndefined();
  });
  describe('fork', () => {
    const point = { turnId: 't1', position: 'after' as const };
    test('forks a conversation this renderer has loaded and returns the new reference', async () => {
      const f = fixture();
      await f.invoke('open', ref, loadId);
      await expect(f.invoke('fork', ref, point, 'side-chat')).resolves.toEqual({ ...ref, nativeSessionId: 'forked' });
      expect(f.service.fork).toHaveBeenCalledWith(ref, point, 'side-chat');
    });

    test('refuses a conversation that renderer has not loaded', async () => {
      const f = fixture();
      await expect(f.invoke('fork', ref, point, 'fork')).rejects.toThrow('Conversation is not owned by this renderer');
      expect(f.service.fork).not.toHaveBeenCalled();
    });

    describe('access', () => {
      const main = { ...ref, nativeSessionId: 'main' };
      const forked = { ...ref, nativeSessionId: 'forked' };
      const accessChoices = () => ({ validateSend: vi.fn(), recordSend: vi.fn(), forget: vi.fn(), inherit: vi.fn(async (): Promise<void> => undefined) });

      test('gives a fork of a side chat the access of its main conversation', async () => {
        const choices = accessChoices();
        const f = fixture(undefined, choices);
        f.service.mainConversationOf.mockReturnValue(main);
        await f.invoke('open', ref, loadId);
        await expect(f.invoke('fork', ref, point, 'fork')).resolves.toEqual(forked);
        expect(f.service.mainConversationOf).toHaveBeenCalledWith(ref);
        expect(choices.inherit).toHaveBeenCalledWith(forked, main);
      });

      test('inherits nothing for a fork of a main conversation, or for a side chat', async () => {
        const choices = accessChoices();
        const f = fixture(undefined, choices);
        await f.invoke('open', ref, loadId);
        await f.invoke('fork', ref, point, 'fork');
        f.service.mainConversationOf.mockReturnValue(main);
        await f.invoke('fork', ref, point, 'side-chat');
        expect(choices.inherit).not.toHaveBeenCalled();
      });

      test('still returns the fork when the access cannot be inherited', async () => {
        const choices = accessChoices();
        choices.inherit.mockRejectedValue(new Error('disk full'));
        const f = fixture(undefined, choices);
        f.service.mainConversationOf.mockReturnValue(main);
        await f.invoke('open', ref, loadId);
        await expect(f.invoke('fork', ref, point, 'fork')).resolves.toEqual(forked);
      });
    });

    test('hides why a fork failed', async () => {
      const f = fixture();
      f.service.fork.mockRejectedValue(new Error('/private/path'));
      await f.invoke('open', ref, loadId);
      await expect(f.invoke('fork', ref, point, 'fork')).rejects.toThrow('Conversation operation failed');
    });
  });

  describe('side chats', () => {
    const child = { ...ref, nativeSessionId: 'side-chat' };
    const grandchild = { ...ref, nativeSessionId: 'nested' };
    const summaries = [{ ref: child, parentKey: 'codex:session', afterTurnId: 't1', inheritedTurnCount: 1, createdAt: 1 }];

    test('lists the side chats of a conversation without it being loaded', async () => {
      const f = fixture();
      f.service.sideChats.mockReturnValue(summaries);
      await expect(f.invoke('side-chats', ref)).resolves.toEqual(summaries);
      expect(f.service.sideChats).toHaveBeenCalledWith(ref);
    });

    test('deletes a side chat without it being loaded', async () => {
      const f = fixture();
      await expect(f.invoke('delete-side-chat', child)).resolves.toBeUndefined();
      expect(f.service.deleteSideChat).toHaveBeenCalledWith(child);
    });

    test('forgets this renderer\'s loads of the deleted side chats and keeps its other loads', async () => {
      const f = fixture();
      await f.invoke('open', child, loadId); await f.invoke('open', grandchild, nextId); await f.invoke('open', ref, '00000000-0000-4000-8000-000000000003');
      f.service.deleteSideChat.mockResolvedValue([grandchild, child]);
      await f.invoke('delete-side-chat', child);
      f.sender.send.mockClear();
      f.registration.emit({ ...complete, ref: child });
      f.registration.emit({ ...complete, ref: grandchild, loadId: nextId });
      expect(f.sender.send).not.toHaveBeenCalled();
      await expect(f.invoke('close', child)).rejects.toThrow('Conversation is not owned by this renderer');
      await expect(f.invoke('close', grandchild)).rejects.toThrow('Conversation is not owned by this renderer');
      await expect(f.invoke('close', ref)).resolves.toBeUndefined();
    });

    test('does not forget a load another renderer holds', async () => {
      const f = fixture();
      await f.invoke('open', child, loadId);
      const other = new Sender(); other.id = 42; f.useSender(other);
      f.service.deleteSideChat.mockResolvedValue([child]);
      await f.invokeAs(other, 'delete-side-chat', child);
      f.useSender(f.sender);
      await expect(f.invoke('close', child)).resolves.toBeUndefined();
    });

    test('rejects a subframe or foreign sender on both channels', async () => {
      const f = fixture();
      for (const [channel, arg] of [['side-chats', ref], ['delete-side-chat', child]] as const) {
        await expect(f.invokeAs(new Sender(), channel, arg)).rejects.toThrow('Unauthorized conversation sender');
        const handler = electron.handlers.get(`fractal:conversations:${channel}`);
        if (!handler) throw new Error('Missing handler');
        await expect(handler({ sender: f.sender, senderFrame: {} } as unknown as IpcMainInvokeEvent, arg)).rejects.toThrow('Unauthorized conversation sender');
      }
      expect(f.service.sideChats).not.toHaveBeenCalled();
      expect(f.service.deleteSideChat).not.toHaveBeenCalled();
    });

    test('hides why a listing or deletion failed', async () => {
      const f = fixture();
      f.service.sideChats.mockImplementation(() => { throw new Error('/private/path'); });
      f.service.deleteSideChat.mockRejectedValue(new Error('Side chat is busy'));
      await expect(f.invoke('side-chats', ref)).rejects.toThrow('Conversation operation failed');
      await expect(f.invoke('delete-side-chat', child)).rejects.toThrow('Conversation operation failed');
    });
  });

  describe('access on send', () => {
    const access = { state: { kind: 'level' as const, level: 'plan' }, picked: true };
    test('validates before sending and records after', async () => {
      const order: string[] = [];
      const accessChoices = { validateSend: vi.fn(() => { order.push('validate'); }), recordSend: vi.fn(() => { order.push('record'); }), inherit: vi.fn(async () => undefined), forget: vi.fn() };
      const f = fixture(undefined, accessChoices);
      f.service.continue.mockImplementation(async () => { order.push('continue'); });
      await f.invoke('open', ref, loadId);
      await f.invoke('continue', ref, { text: 'Go', access });
      expect(accessChoices.validateSend).toHaveBeenCalledWith(ref, access);
      expect(accessChoices.recordSend).toHaveBeenCalledWith(ref, access);
      expect(order).toEqual(['validate', 'continue', 'record']);
      await f.invoke('continue', ref, { text: 'Again' });
      expect(accessChoices.recordSend).toHaveBeenLastCalledWith(ref, undefined);
    });

    test('a side chat neither validates nor remembers the access choice', async () => {
      const accessChoices = { validateSend: vi.fn(() => { throw new Error('Bypass is turned off in Settings'); }), recordSend: vi.fn(), inherit: vi.fn(async () => undefined), forget: vi.fn() };
      const f = fixture(undefined, accessChoices);
      f.service.branchKind.mockReturnValue('side-chat');
      await f.invoke('open', ref, loadId);
      await expect(f.invoke('continue', ref, { text: 'Go', access })).resolves.toBeUndefined();
      expect(f.service.continue).toHaveBeenCalled();
      expect(accessChoices.validateSend).not.toHaveBeenCalled();
      expect(accessChoices.recordSend).not.toHaveBeenCalled();
    });

    test('a rejected access reaches the renderer verbatim and nothing is sent', async () => {
      const accessChoices = { validateSend: vi.fn(() => { throw new Error('Bypass is turned off in Settings'); }), recordSend: vi.fn(), inherit: vi.fn(async () => undefined), forget: vi.fn() };
      const f = fixture(undefined, accessChoices);
      await f.invoke('open', ref, loadId);
      await expect(f.invoke('continue', ref, { text: 'Go', access })).rejects.toThrow('Bypass is turned off in Settings');
      expect(f.service.continue).not.toHaveBeenCalled();
      expect(accessChoices.recordSend).not.toHaveBeenCalled();
    });

    test('a failing record does not fail the send', async () => {
      const accessChoices = { validateSend: vi.fn(), recordSend: vi.fn(() => { throw new Error('disk full'); }), inherit: vi.fn(async () => undefined), forget: vi.fn() };
      const f = fixture(undefined, accessChoices);
      await f.invoke('open', ref, loadId);
      await expect(f.invoke('continue', ref, { text: 'Go', access })).resolves.toBeUndefined();
      expect(f.service.continue).toHaveBeenCalled();
    });

    test('drops the read-back before passing on history that loaded or gained a turn', async () => {
      const order: string[] = [];
      const accessChoices = { validateSend: vi.fn(), recordSend: vi.fn(), inherit: vi.fn(async () => undefined), forget: vi.fn(() => { order.push('forget'); }) };
      const f = fixture(undefined, accessChoices);
      f.sender.send.mockImplementation((_channel: string, event: { type: string }) => { order.push(event.type); });
      await f.invoke('open', ref, loadId);
      const turn = { id: 't1', nativeId: 'n1', userMessage: { id: 'u1', text: 'Go' }, blocks: [] as unknown[], status: 'active', captureCompleteness: 'complete' };
      f.registration.emit(complete);
      f.registration.emit({ type: 'turn.upserted', ref, loadId, seq: 1, turn });
      f.registration.emit({ type: 'runtime.changed', ref, loadId, seq: 2, runtime: 'idle' });
      expect(order).toEqual(['forget', 'history.complete', 'forget', 'turn.upserted', 'runtime.changed']);
      expect(accessChoices.forget).toHaveBeenCalledWith(ref);
    });

    test('a failing forget still passes the event on', async () => {
      const accessChoices = { validateSend: vi.fn(), recordSend: vi.fn(), inherit: vi.fn(async () => undefined), forget: vi.fn(() => { throw new Error('boom'); }) };
      const f = fixture(undefined, accessChoices);
      await f.invoke('open', ref, loadId);
      f.registration.emit(complete);
      expect(f.sender.send).toHaveBeenCalledWith('fractal:conversations:event', complete);
    });
  });
});
