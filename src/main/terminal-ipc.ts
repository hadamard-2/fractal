import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createOwnerTracker } from '@/main/ipc-owners';
import { TERMINAL_CHANNELS, parseTerminalRequest } from '@/shared/terminal-contract';
import type { TerminalService } from './terminal-service';

export function registerTerminalIpc(service: TerminalService, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const owners = createOwnerTracker(getWindow, (owner) => service.closeOwner(owner), 'Unauthorized terminal sender');

  ipcMain.handle(TERMINAL_CHANNELS.invoke, async (event, input: unknown) => {
    const owner = owners.authorize(event);
    const request = parseTerminalRequest(input);
    if (request.method === 'create') {
      let cwd: string;
      try {
        if (!isAbsolute(request.cwd) || !(await stat(request.cwd)).isDirectory()) throw new Error('Not a directory');
        cwd = await realpath(request.cwd);
      } catch { throw new Error('Terminal could not start in this folder'); }
      if (owners.disposed || owner.closed) throw new Error('Terminal operation failed');
      try {
        return service.create(owner, request, cwd, (payload) => {
          if (owner.closed || owner.sender.isDestroyed()) return;
          try { owner.sender.send(TERMINAL_CHANNELS.event, payload); } catch { owners.release(owner); }
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
      if (owners.disposed) return;
      ipcMain.removeHandler(TERMINAL_CHANNELS.invoke);
      owners.dispose();
    },
  };
}
