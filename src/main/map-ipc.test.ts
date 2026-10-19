import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';
import { EMPTY_MAP_LAYOUT } from '@/shared/map-contract';
import { registerMapIpc } from './map-ipc';

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => { electron.handlers.set(channel, handler); },
    removeHandler: (channel: string) => { electron.handlers.delete(channel); },
  },
}));

const ref = { provider: 'claude' as const, nativeSessionId: 'a', projectPath: '/work' };
const sender = { mainFrame: {} };
const window = { webContents: sender, isDestroyed: () => false } as unknown as BrowserWindow;
const event = (source: typeof sender) => ({ sender: source, senderFrame: source.mainFrame }) as unknown as IpcMainInvokeEvent;
const layout = { view: 'full' as const, nodes: { 'claude:b': { x: 1, y: 2, width: 400 } } };
function invoke(channel: string, ipcEvent: IpcMainInvokeEvent, ...args: unknown[]) {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler(ipcEvent, ...args);
}
function setup(stored: typeof layout | undefined = undefined) {
  const store = { get: vi.fn(() => stored), set: vi.fn() };
  const registration = registerMapIpc(store, () => window);
  const call = (channel: string, source: typeof sender, ...args: unknown[]) => invoke(channel, event(source), ...args);
  return { store, registration, call };
}
afterEach(() => { electron.handlers.clear(); });

test('returns the stored layout, or a fresh empty one for a conversation never saved', async () => {
  const saved = setup(layout);
  await expect(saved.call('fractal:map:layout', sender, ref)).resolves.toEqual(layout);
  expect(saved.store.get).toHaveBeenCalledWith('claude:a');
  electron.handlers.clear();
  const empty = setup();
  const result = await empty.call('fractal:map:layout', sender, ref) as typeof EMPTY_MAP_LAYOUT;
  expect(result).toEqual(EMPTY_MAP_LAYOUT);
  expect(result).not.toBe(EMPTY_MAP_LAYOUT);
  expect(result.nodes).not.toBe(EMPTY_MAP_LAYOUT.nodes);
  result.nodes.x = { x: 1, y: 1 };
  expect(EMPTY_MAP_LAYOUT.nodes).toEqual({});
});

test('saves a parsed copy under the conversation key and rejects malformed input before writing', async () => {
  const { store, call } = setup();
  await call('fractal:map:save-layout', sender, ref, { ...layout, extra: true });
  expect(store.set).toHaveBeenCalledWith('claude:a', layout);
  await expect(call('fractal:map:save-layout', sender, ref, { view: 'grid', nodes: {} })).rejects.toThrow('Invalid map layout');
  await expect(call('fractal:map:save-layout', sender, { provider: 'bad' }, layout)).rejects.toThrow('Invalid conversation reference');
  await expect(call('fractal:map:layout', sender, { provider: 'bad' })).rejects.toThrow('Invalid conversation reference');
  expect(store.set).toHaveBeenCalledTimes(1);
});

test('rejects a failed write', async () => {
  const { store, call } = setup();
  store.set.mockImplementation(() => { throw new Error('disk full'); });
  await expect(call('fractal:map:save-layout', sender, ref, layout)).rejects.toThrow('disk full');
});

test('refuses other senders and removes its handlers on dispose', async () => {
  const { store, registration, call } = setup(layout);
  await expect(call('fractal:map:layout', { mainFrame: {} }, ref)).rejects.toThrow('Unauthorized map sender');
  await expect(call('fractal:map:save-layout', { mainFrame: {} }, ref, layout)).rejects.toThrow('Unauthorized map sender');
  const subframe = { sender, senderFrame: {} } as unknown as IpcMainInvokeEvent;
  await expect(invoke('fractal:map:layout', subframe, ref)).rejects.toThrow('Unauthorized map sender');
  expect(store.get).not.toHaveBeenCalled();
  expect(store.set).not.toHaveBeenCalled();
  registration.dispose();
  expect([...electron.handlers.keys()]).toEqual([]);
});
