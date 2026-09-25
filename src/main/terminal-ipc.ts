import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TERMINAL_CHANNELS, parseTerminalRequest } from '@/shared/terminal-contract';
import type { TerminalService } from './terminal-service';

type Owner = { sender: WebContents; closed: boolean; detach: () => void };

export function registerTerminalIpc(service: TerminalService, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const owners = new Map<WebContents, Owner>();
  let disposed = false;

  const release = (owner: Owner) => {
    if (owner.closed) return;
    owner.closed = true;
    owner.detach();
    owners.delete(owner.sender);
    service.closeOwner(owner);
  };

  const ownerFor = (sender: WebContents): Owner => {
    const known = owners.get(sender);
    if (known) return known;
    const owner: Owner = { sender, closed: false, detach: () => undefined };
    const destroyed = () => release(owner);
    const navigated = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) release(owner);
    };
    const crashed = () => release(owner);
    sender.on('destroyed', destroyed);
    sender.on('did-start-navigation', navigated);
    sender.on('render-process-gone', crashed);
    owner.detach = () => {
      sender.removeListener('destroyed', destroyed);
      sender.removeListener('did-start-navigation', navigated);
      sender.removeListener('render-process-gone', crashed);
    };
    owners.set(sender, owner);
    return owner;
  };

  const authorize = (event: IpcMainInvokeEvent): Owner => {
    const window = getWindow();
    if (disposed || !window || window.isDestroyed() || event.sender !== window.webContents || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Unauthorized terminal sender');
    }
    return ownerFor(event.sender);
  };

  ipcMain.handle(TERMINAL_CHANNELS.invoke, async (event, input: unknown) => {
    const owner = authorize(event);
    const request = parseTerminalRequest(input);
    if (request.method === 'create') {
      const inputCwd = request.cwd ?? process.cwd();
      let cwd: string;
      try {
        if (!isAbsolute(inputCwd) || !(await stat(inputCwd)).isDirectory()) throw new Error('Not a directory');
        cwd = await realpath(inputCwd);
      } catch { throw new Error('Terminal could not start in this folder'); }
      if (disposed || owner.closed) throw new Error('Terminal operation failed');
      try {
        return service.create(owner, request, cwd, (payload) => {
          if (owner.closed || owner.sender.isDestroyed()) return;
          try { owner.sender.send(TERMINAL_CHANNELS.event, payload); } catch { release(owner); }
        });
      } catch { throw new Error('Terminal could not start'); }
    }
    if (owner.closed) throw new Error('Terminal operation failed');
    try {
      if (request.method === 'write') service.write(owner, request.id, request.data);
      else if (request.method === 'resize') service.resize(owner, request.id, request.cols, request.rows);
      else service.close(owner, request.id);
    } catch { throw new Error('Terminal operation failed'); }
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      ipcMain.removeHandler(TERMINAL_CHANNELS.invoke);
      for (const owner of [...owners.values()]) release(owner);
    },
  };
}
