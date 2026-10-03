import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';
import { registerModelIpc } from './model-ipc';

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
function setup() {
  const choices = { catalog: vi.fn(() => [{ id: 'opus', label: 'Opus', efforts: ['high'] }]), resolve: vi.fn(async () => ({ model: 'opus' })), choose: vi.fn() };
  const registration = registerModelIpc(choices, () => window);
  const call = (channel: string, source: typeof sender, ...args: unknown[]) => electron.handlers.get(channel)!(event(source), ...args);
  return { choices, registration, call };
}
afterEach(() => { electron.handlers.clear(); });

test('lists the agent catalog with the conversation resolved choice', async () => {
  const { choices, call } = setup();
  await expect(call('fractal:models:list', sender, ref)).resolves.toEqual({ models: [{ id: 'opus', label: 'Opus', efforts: ['high'] }], choice: { model: 'opus' } });
  expect(choices.catalog).toHaveBeenCalledWith('claude');
  expect(choices.resolve).toHaveBeenCalledWith(ref);
});

test('saves a valid choice and rejects an invalid or empty one', async () => {
  const { choices, call } = setup();
  await call('fractal:models:choose', sender, ref, { model: 'opus', effort: 'high' });
  expect(choices.choose).toHaveBeenCalledWith(ref, { model: 'opus', effort: 'high' });
  await expect(call('fractal:models:choose', sender, ref, null)).rejects.toThrow('Invalid model choice');
  await expect(call('fractal:models:choose', sender, ref, { model: '' })).rejects.toThrow('Invalid model choice');
  await expect(call('fractal:models:list', sender, { provider: 'bad' })).rejects.toThrow('Invalid conversation reference');
});

test('refuses other senders and removes its handlers on dispose', async () => {
  const { registration, call } = setup();
  await expect(call('fractal:models:list', { mainFrame: {} }, ref)).rejects.toThrow('Unauthorized model sender');
  registration.dispose();
  expect([...electron.handlers.keys()]).toEqual([]);
});
