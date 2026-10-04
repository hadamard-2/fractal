import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { FILES_CHANNELS, type OpenResult } from '@/shared/files-contract';
import { FileWatchService } from './file-watch-service';
import { registerFilesIpc } from './files-ipc';

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>>() }));
vi.mock('electron', () => ({ ipcMain: {
  handle: (name: string, handler: (event: IpcMainInvokeEvent, request: unknown) => Promise<unknown>) => electron.handlers.set(name, handler),
  removeHandler: (name: string) => electron.handlers.delete(name),
} }));

class Sender extends EventEmitter {
  mainFrame = {};
  send = vi.fn();
  destroyed = false;
  isDestroyed() { return this.destroyed; }
}

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'fractal-files-ipc-')));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'a.ts'), 'a');
});
afterEach(async () => {
  electron.handlers.clear();
  await rm(root, { recursive: true, force: true });
});

function fixture() {
  const sender = new Sender();
  const watched: Array<{ onChange: (name: string | null) => void; closed: boolean }> = [];
  const watches = new FileWatchService((_directory, onChange) => {
    const entry = { onChange, closed: false };
    watched.push(entry);
    return { close: () => { entry.closed = true; } };
  }, 0);
  const knowsProject = vi.fn(async (projectPath: string) => projectPath === root);
  const open = vi.fn(async (): Promise<OpenResult> => ({ ok: true }));
  const editors = vi.fn(async () => [{ id: 'zed' as const, label: 'Zed', executable: '/bin/zed' }]);
  const registration = registerFilesIpc({ knowsProject, watches, editors, open }, () => ({ webContents: sender, isDestroyed: () => sender.destroyed }) as unknown as BrowserWindow);
  const invoke = (request: unknown, source: Sender = sender, frame: object = source.mainFrame) => {
    const handler = electron.handlers.get(FILES_CHANNELS.invoke);
    if (!handler) throw new Error('Missing files handler');
    return handler({ sender: source, senderFrame: frame } as unknown as IpcMainInvokeEvent, request);
  };
  return { sender, watched, knowsProject, open, registration, invoke };
}

test('serves a known project, asking about each root once', async () => {
  const f = fixture();
  expect(await f.invoke({ method: 'readFile', root, path: 'src/a.ts' })).toEqual({ kind: 'text', content: 'a', size: 1 });
  expect(await f.invoke({ method: 'listDirectory', root, path: '' })).toMatchObject([{ name: 'src', kind: 'directory' }]);
  expect(await f.invoke({ method: 'listFiles', root })).toMatchObject({ paths: ['src/a.ts'], truncated: false });
  expect(f.knowsProject).toHaveBeenCalledTimes(1);
  f.registration.dispose();
});

test('refuses unknown projects, escaping paths, malformed requests, and foreign senders', async () => {
  const f = fixture();
  await expect(f.invoke({ method: 'listDirectory', root: '/', path: '' })).rejects.toThrow('Unknown project');
  await expect(f.invoke({ method: 'readFile', root, path: '../x' })).rejects.toThrow('Path is outside the project');
  await expect(f.invoke({ method: 'readFile', root, path: '/etc/passwd' })).rejects.toThrow('Invalid files request');
  await expect(f.invoke({ method: 'readFile', root, path: 'src/a.ts' }, new Sender())).rejects.toThrow('Unauthorized files sender');
  await expect(f.invoke({ method: 'readFile', root, path: 'src/a.ts' }, f.sender, {})).rejects.toThrow('Unauthorized files sender');
  f.registration.dispose();
});

test('sends change events to the owner and closes its watches when it navigates away', async () => {
  const f = fixture();
  await f.invoke({ method: 'watch', watchId: 'w1', root, path: 'src' });
  f.watched[0].onChange('a.ts');
  await vi.waitFor(() => expect(f.sender.send).toHaveBeenCalledWith(FILES_CHANNELS.event, { type: 'changed', watchId: 'w1' }));
  f.sender.emit('did-start-navigation', {}, 'x', false, true);
  expect(f.watched[0].closed).toBe(true);
  f.registration.dispose();
});

test('opens with the real root and the file inside it, and reports a vanished file', async () => {
  const f = fixture();
  expect(await f.invoke({ method: 'open', action: 'zed', root, path: 'src/a.ts', line: 3 })).toEqual({ ok: true });
  expect(f.open).toHaveBeenCalledWith('zed', { root, file: join(root, 'src', 'a.ts'), line: 3 });
  expect(await f.invoke({ method: 'open', action: 'zed', root, path: 'src/gone.ts' })).toEqual({ ok: false, message: 'This file no longer exists' });
  f.registration.dispose();
});

test('lists editors without their executables, and dispose removes the handler and every watch', async () => {
  const f = fixture();
  expect(await f.invoke({ method: 'editors' })).toEqual([{ id: 'zed', label: 'Zed' }]);
  await f.invoke({ method: 'watch', watchId: 'w1', root, path: '' });
  f.registration.dispose();
  f.registration.dispose();
  expect(f.watched[0].closed).toBe(true);
  expect(electron.handlers.has(FILES_CHANNELS.invoke)).toBe(false);
});
