import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { afterEach, expect, test, vi } from 'vitest';
import { TerminalService, type PtyLike } from './terminal-service';
import { registerTerminalIpc } from './terminal-ipc';
import { TERMINAL_CHANNELS } from '@/shared/terminal-contract';

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
  destroy() { this.destroyed = true; this.emit('destroyed'); }
}

const dirs: string[] = [];
function fixture(factory?: () => PtyLike) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'fractal-terminal-ipc-')); dirs.push(cwd);
  const sender = new Sender();
  const kill = vi.fn();
  const pty: PtyLike = { onData: () => ({ dispose() { return undefined; } }), onExit: () => ({ dispose() { return undefined; } }), write: vi.fn(), resize: vi.fn(), kill };
  const service = new TerminalService(factory ?? (() => pty));
  const registration = registerTerminalIpc(service, () => ({ webContents: sender, isDestroyed: () => sender.destroyed }) as unknown as BrowserWindow);
  const invoke = (request: unknown, source: Sender = sender, frame: object = source.mainFrame) => {
    const handler = electron.handlers.get(TERMINAL_CHANNELS.invoke);
    if (!handler) throw new Error('Missing terminal handler');
    return handler({ sender: source, senderFrame: frame } as unknown as IpcMainInvokeEvent, request);
  };
  return { cwd, sender, pty, kill, service, registration, invoke };
}
afterEach(() => { electron.handlers.clear(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('creates in an existing directory, forwards output only to owner, and rejects foreign frames', async () => {
  const f = fixture();
  expect(await f.invoke({ method: 'create', id: 'one', cwd: f.cwd, cols: 80, rows: 24 })).toMatchObject({ cwd: f.cwd });
  await f.invoke({ method: 'write', id: 'one', data: 'pwd\r' });
  expect(f.pty.write).toHaveBeenCalledWith('pwd\r');
  await expect(f.invoke({ method: 'write', id: 'one', data: 'bad' }, new Sender())).rejects.toThrow('Unauthorized terminal sender');
  await expect(f.invoke({ method: 'write', id: 'one', data: 'bad' }, f.sender, {})).rejects.toThrow('Unauthorized terminal sender');
  f.registration.dispose();
});

test('rejects missing or non-directory projects before spawning a shell', async () => {
  const spawn = vi.fn(() => { throw new Error('should not spawn'); });
  const f = fixture(spawn);
  writeFileSync(path.join(f.cwd, 'file'), 'x');
  for (const cwd of [path.join(f.cwd, 'missing'), path.join(f.cwd, 'file')]) {
    await expect(f.invoke({ method: 'create', id: 'one', cwd, cols: 80, rows: 24 })).rejects.toThrow('Terminal could not start in this folder');
  }
  await expect(f.invoke({ method: 'create', id: 'one', cwd: 'relative', cols: 80, rows: 24 })).rejects.toThrow('Invalid terminal request');
  expect(spawn).not.toHaveBeenCalled();
  f.registration.dispose();
});

test('sanitizes a native spawn error and defaults to process cwd', async () => {
  const f = fixture(() => { throw new Error('private native details'); });
  await expect(f.invoke({ method: 'create', id: 'one', cols: 80, rows: 24 })).rejects.toThrow('Terminal could not start');
  f.registration.dispose();
});

test('navigation releases all shells and prevents writes to stale IDs', async () => {
  const f = fixture();
  await f.invoke({ method: 'create', id: 'one', cwd: f.cwd, cols: 80, rows: 24 });
  f.sender.emit('did-start-navigation', {}, 'file:///next', false, true);
  expect(f.kill).toHaveBeenCalledTimes(1);
  await expect(f.invoke({ method: 'write', id: 'one', data: 'bad' })).rejects.toThrow('Terminal operation failed');
  f.registration.dispose(); f.registration.dispose();
  expect(electron.handlers.has(TERMINAL_CHANNELS.invoke)).toBe(false);
});
