import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { AccessChoices } from '@/main/access-choices';
import type { AccessListing } from '@/shared/conversation-contract';
import { ACCESS_CHANNELS, parseAccessLevelId, parseConversationRef } from '@/shared/conversation-ipc';

/** The composer's access picker: the agent's levels, the conversation's resolved access, and saving a pick. */
export function registerAccessIpc(choices: Pick<AccessChoices, 'levels' | 'resolve' | 'choose' | 'allowDangerous'>, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const authorize = (event: IpcMainInvokeEvent): void => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized access sender');
  };
  ipcMain.handle(ACCESS_CHANNELS.list, async (event, input: unknown): Promise<AccessListing> => {
    authorize(event);
    const ref = parseConversationRef(input);
    const { access, observed } = await choices.resolve(ref);
    return { levels: choices.levels(ref.provider), access, ...(observed ? { observed } : {}), allowDangerous: choices.allowDangerous(ref.provider) };
  });
  ipcMain.handle(ACCESS_CHANNELS.choose, async (event, input: unknown, levelInput: unknown) => {
    authorize(event);
    choices.choose(parseConversationRef(input), parseAccessLevelId(levelInput));
  });
  return {
    dispose() {
      ipcMain.removeHandler(ACCESS_CHANNELS.list);
      ipcMain.removeHandler(ACCESS_CHANNELS.choose);
    },
  };
}
