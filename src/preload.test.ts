import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ConversationApi } from '@/shared/conversation-contract';
import type { TerminalApi } from '@/shared/terminal-contract';

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), getPathForFile: vi.fn(() => '/tmp/pasted.png') }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener }, webUtils: { getPathForFile: mocks.getPathForFile } }));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
async function preload() {
  const events = new EventEmitter();
  mocks.on.mockImplementation(events.on.bind(events)); mocks.removeListener.mockImplementation(events.removeListener.bind(events));
  await import('@/preload');
  return { events, surface: mocks.expose.mock.calls[0][1] as { conversations: ConversationApi; terminals: TerminalApi; attachments: { pathFor: (file: File) => string } } };
}
const ref = { provider: 'codex' as const, nativeSessionId: 'session', projectPath: '/repo' };
const loadId = '00000000-0000-4000-8000-000000000001';
describe('preload conversation surface', () => {
  test('exposes only settings and the hand-written conversation API, with no legacy authority', async () => {
    const { surface } = await preload();
    expect(mocks.expose.mock.calls[0][0]).toBe('fractal');
    expect(Object.keys(surface).sort()).toEqual(['attachments', 'conversations', 'settings', 'terminals']);
    expect(Object.keys(surface.conversations).sort()).toEqual(['list', 'open', 'close', 'create', 'continue', 'interrupt', 'resolveRequest', 'previewAttachment', 'openAttachment', 'onEvent'].sort());
    await surface.conversations.list(); await surface.conversations.open(ref, loadId); await surface.conversations.close(ref);
    await surface.conversations.create({ provider: 'claude' }); await surface.conversations.continue(ref, { text: 'hi' });
    await surface.conversations.interrupt(ref); await surface.conversations.resolveRequest('request', { kind: 'deny' });
    expect(mocks.invoke.mock.calls).toEqual([
      ['fractal:conversations:list'], ['fractal:conversations:open', ref, loadId], ['fractal:conversations:close', ref],
      ['fractal:conversations:create', { provider: 'claude' }], ['fractal:conversations:continue', ref, { text: 'hi' }],
      ['fractal:conversations:interrupt', ref], ['fractal:conversations:resolve-request', 'request', { kind: 'deny' }],
    ]);
    expect(surface.attachments.pathFor({} as File)).toBe('/tmp/pasted.png');
    expect(mocks.getPathForFile).toHaveBeenCalledWith({});
  });
  test('validates and strips event payloads, hides Electron events, and removes only its own listener', async () => {
    const { surface, events } = await preload();
    const one = vi.fn(), two = vi.fn(); const off = surface.conversations.onEvent(one); surface.conversations.onEvent(two);
    const payload = { type: 'history.complete', ref, loadId, seq: 0 };
    const nativeEvent = { sender: 'must not escape' };
    events.emit('fractal:conversations:event', nativeEvent, { ...payload, nativeFile: '/private' });
    expect(one.mock.calls).toEqual([[payload]]); expect(two.mock.calls).toEqual([[payload]]);
    events.emit('fractal:conversations:event', nativeEvent, { ...payload, seq: -1 });
    expect(one).toHaveBeenCalledTimes(1); expect(two).toHaveBeenCalledTimes(1);
    off(); off(); events.emit('fractal:conversations:event', nativeEvent, payload);
    expect(one).toHaveBeenCalledTimes(1); expect(two).toHaveBeenCalledTimes(2);
    expect(events.listenerCount('fractal:conversations:event')).toBe(1);
  });
});

test('terminal preload filters native event fields and removes its listener', async () => {
  const { surface, events } = await preload();
  const listener = vi.fn();
  const off = surface.terminals.onEvent(listener);
  events.emit('fractal:terminal:event', { sender: 'native' }, { type: 'data', id: 'terminal-one', data: 'ready', privateField: 'strip' });
  expect(listener).toHaveBeenCalledWith({ type: 'data', id: 'terminal-one', data: 'ready' });
  off();
  expect(events.listenerCount('fractal:terminal:event')).toBe(0);
});
