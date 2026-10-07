import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';
import { createOwnerTracker } from '@/main/ipc-owners';
import { createRootCheck, UnknownProjectError } from '@/main/project-roots';
import { CHANGES_CHANNELS, parseChangesRequest, type ChangesResult } from '@/shared/changes-contract';
import { readChanges } from './changes-service';

export interface ChangesIpcDeps {
  /** Whether a conversation main knows of is in this project. Only such projects are served. */
  knowsProject(projectPath: string): Promise<boolean>;
  read?: typeof readChanges;
}

export function registerChangesIpc(deps: ChangesIpcDeps, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const owners = createOwnerTracker(getWindow, () => undefined, 'Unauthorized changes sender');
  const checkRoot = createRootCheck(deps.knowsProject);
  const read = deps.read ?? readChanges;

  ipcMain.handle(CHANGES_CHANNELS.invoke, async (event, input: unknown): Promise<ChangesResult> => {
    owners.authorize(event);
    const request = parseChangesRequest(input);
    try {
      await checkRoot(request.root);
      return await read(request.root, request.fingerprint);
    } catch (error) {
      // Only reasons written here cross to the renderer; git and filesystem details stay in main.
      if (error instanceof UnknownProjectError) throw new Error('Unknown project');
      return { kind: 'error', message: "Changes couldn't be read" };
    }
  });

  return {
    dispose() {
      if (owners.disposed) return;
      ipcMain.removeHandler(CHANGES_CHANNELS.invoke);
      owners.dispose();
    },
  };
}
