import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';
import { registerAccessIpc } from './access-ipc';

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
const levels = [{ id: 'plan', label: 'Plan', description: 'Reads only', dangerous: false }];
function setup() {
  const choices = {
    levels: vi.fn(() => levels),
    resolve: vi.fn(async () => ({ access: { state: { kind: 'level' as const, level: 'plan' }, picked: true }, observed: { kind: 'level' as const, level: 'default' } })),
    choose: vi.fn(),
    allowDangerous: vi.fn(() => false),
  };
  const registration = registerAccessIpc(choices, () => window);
  const call = (channel: string, source: typeof sender, ...args: unknown[]) => electron.handlers.get(channel)!(event(source), ...args);
  return { choices, registration, call };
}
afterEach(() => { electron.handlers.clear(); });

test('lists the levels with the conversation resolved access and the Settings gate', async () => {
  const { choices, call } = setup();
  await expect(call('fractal:access:list', sender, ref)).resolves.toEqual({
    levels,
    access: { state: { kind: 'level', level: 'plan' }, picked: true },
    observed: { kind: 'level', level: 'default' },
    allowDangerous: false,
  });
  expect(choices.levels).toHaveBeenCalledWith('claude');
  expect(choices.allowDangerous).toHaveBeenCalledWith('claude');
  expect(choices.resolve).toHaveBeenCalledWith(ref);
});

test('saves a level and rejects a malformed reference or level', async () => {
  const { choices, call } = setup();
  await call('fractal:access:choose', sender, ref, 'plan');
  expect(choices.choose).toHaveBeenCalledWith(ref, 'plan');
  await expect(call('fractal:access:choose', sender, ref, 5)).rejects.toThrow('Invalid access');
  await expect(call('fractal:access:list', sender, { provider: 'bad' })).rejects.toThrow('Invalid conversation reference');
  expect(choices.choose).toHaveBeenCalledTimes(1);
});

test('refuses other senders and removes its handlers on dispose', async () => {
  const { choices, registration, call } = setup();
  await expect(call('fractal:access:list', { mainFrame: {} }, ref)).rejects.toThrow('Unauthorized access sender');
  await expect(call('fractal:access:choose', { mainFrame: {} }, ref, 'plan')).rejects.toThrow('Unauthorized access sender');
  expect(choices.choose).not.toHaveBeenCalled();
  registration.dispose();
  expect([...electron.handlers.keys()]).toEqual([]);
});
