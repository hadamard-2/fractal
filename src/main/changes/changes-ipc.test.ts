import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';
import { CHANGES_CHANNELS, type ChangesResult } from '@/shared/changes-contract';
import { registerChangesIpc } from './changes-ipc';

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (name: string, handler: (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>) => electron.handlers.set(name, handler),
  removeHandler: (name: string) => electron.handlers.delete(name),
} }));

class Sender extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  isDestroyed() { return this.destroyed; }
}

const root = '/projects/app';
const unchanged: ChangesResult = { kind: 'unchanged', fingerprint: 'f1' };

afterEach(() => { electron.handlers.clear(); });

function fixture(read = vi.fn(async (): Promise<ChangesResult> => unchanged)) {
  const sender = new Sender();
  const knowsProject = vi.fn(async (projectPath: string) => projectPath === root);
  const registration = registerChangesIpc({ knowsProject, read }, () => ({ webContents: sender, isDestroyed: () => sender.destroyed }) as unknown as BrowserWindow);
  const invoke = (request: unknown, source: Sender = sender, frame: object = source.mainFrame) => {
    const handler = electron.handlers.get(CHANGES_CHANNELS.invoke);
    if (!handler) throw new Error('Missing changes handler');
    return handler({ sender: source, senderFrame: frame } as unknown as IpcMainInvokeEvent, request);
  };
  return { sender, knowsProject, read, registration, invoke };
}

test('reads a known project and passes the fingerprint through', async () => {
  const f = fixture();
  expect(await f.invoke({ method: 'read', root })).toEqual(unchanged);
  expect(f.read).toHaveBeenLastCalledWith(root, undefined);
  await f.invoke({ method: 'read', root, fingerprint: 'f1' });
  expect(f.read).toHaveBeenLastCalledWith(root, 'f1');
  expect(f.knowsProject).toHaveBeenCalledTimes(1);
  f.registration.dispose();
});

test('refuses foreign senders, unknown projects, and malformed requests without reading', async () => {
  const f = fixture();
  await expect(f.invoke({ method: 'read', root }, new Sender())).rejects.toThrow('Unauthorized changes sender');
  await expect(f.invoke({ method: 'read', root }, f.sender, {})).rejects.toThrow('Unauthorized changes sender');
  await expect(f.invoke({ method: 'read', root: '/elsewhere' })).rejects.toThrow('Unknown project');
  await expect(f.invoke({ method: 'read', root: 'relative' })).rejects.toThrow('Invalid changes request');
  await expect(f.invoke({ method: 'write', root })).rejects.toThrow('Invalid changes request');
  expect(f.read).not.toHaveBeenCalled();
  f.registration.dispose();
});

test('returns a fixed error result when the read throws', async () => {
  const f = fixture(vi.fn(async (): Promise<ChangesResult> => { throw new Error('fatal: /secret/path'); }));
  expect(await f.invoke({ method: 'read', root })).toEqual({ kind: 'error', message: "Changes couldn't be read" });
  f.registration.dispose();
});

test('dispose removes the handler', () => {
  const f = fixture();
  expect(electron.handlers.has(CHANGES_CHANNELS.invoke)).toBe(true);
  f.registration.dispose();
  expect(electron.handlers.has(CHANGES_CHANNELS.invoke)).toBe(false);
});
