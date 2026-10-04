import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { createOwnerTracker, type IpcOwner } from '@/main/ipc-owners';
import { FILES_CHANNELS, parseFilesRequest, type FilesEvent, type FilesRequest, type OpenAction, type OpenResult } from '@/shared/files-contract';
import type { DetectedEditor } from './editors';
import { listDirectory, listProjectFiles, readProjectFile } from './file-service';
import type { FileWatchService } from './file-watch-service';
import { isMissing, OutsideProjectError, resolveInProject } from './project-paths';

export interface FilesIpcDeps {
  /** Whether a conversation main knows of is in this project. Only such projects are served. */
  knowsProject(projectPath: string): Promise<boolean>;
  watches: FileWatchService;
  editors(): Promise<DetectedEditor[]>;
  open(action: OpenAction, target: { root: string; file: string; line?: number }): Promise<OpenResult>;
}

class UnknownProjectError extends Error {
  override name = 'UnknownProjectError';
}

export function registerFilesIpc(deps: FilesIpcDeps, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const owners = createOwnerTracker(getWindow, (owner) => deps.watches.closeOwner(owner), 'Unauthorized files sender');
  const knownRoots = new Set<string>();

  const checkRoot = async (root: string) => {
    if (knownRoots.has(root)) return;
    if (!(await deps.knowsProject(root))) throw new UnknownProjectError('Unknown project');
    knownRoots.add(root);
  };

  const sendTo = (owner: IpcOwner) => (event: FilesEvent) => {
    if (owner.closed || owner.sender.isDestroyed()) return;
    try { owner.sender.send(FILES_CHANNELS.event, event); } catch { owners.release(owner); }
  };

  const handle = async (owner: IpcOwner, request: FilesRequest): Promise<unknown> => {
    if (request.method === 'editors') return (await deps.editors()).map(({ id, label }) => ({ id, label }));
    if (request.method === 'unwatch') { deps.watches.unwatch(owner, request.watchId); return undefined; }
    await checkRoot(request.root);
    if (request.method === 'listDirectory') return listDirectory(request.root, request.path);
    if (request.method === 'readFile') return readProjectFile(request.root, request.path);
    if (request.method === 'listFiles') return listProjectFiles(request.root);
    if (request.method === 'watch') {
      await deps.watches.watch(owner, request.watchId, request.root, request.path, sendTo(owner));
      return undefined;
    }
    let target;
    try {
      target = await resolveInProject(request.root, request.path);
    } catch (error) {
      if (isMissing(error)) return { ok: false, message: 'This file no longer exists' } satisfies OpenResult;
      throw error;
    }
    return deps.open(request.action, { root: target.realRoot, file: target.lexical, ...(request.line === undefined ? {} : { line: request.line }) });
  };

  ipcMain.handle(FILES_CHANNELS.invoke, async (event, input: unknown) => {
    const owner = owners.authorize(event);
    const request = parseFilesRequest(input);
    try {
      return await handle(owner, request);
    } catch (error) {
      // Only reasons written here cross to the renderer; filesystem details stay in main.
      if (error instanceof OutsideProjectError) throw new Error('Path is outside the project');
      if (error instanceof UnknownProjectError) throw new Error('Unknown project');
      throw new Error('File operation failed');
    }
  });

  return {
    dispose() {
      if (owners.disposed) return;
      ipcMain.removeHandler(FILES_CHANNELS.invoke);
      owners.dispose();
    },
  };
}
