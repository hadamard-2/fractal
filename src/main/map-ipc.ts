import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { MapLayoutStore } from '@/main/map-layout-store';
import { conversationKey } from '@/shared/conversation-contract';
import { parseConversationRef } from '@/shared/conversation-ipc';
import { EMPTY_MAP_LAYOUT, MAP_CHANNELS, parseMapLayout, type MapLayout } from '@/shared/map-contract';

/** Reading and saving where the user left a conversation's map. */
export function registerMapIpc(store: Pick<MapLayoutStore, 'get' | 'set'>, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const authorize = (event: IpcMainInvokeEvent): void => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized map sender');
  };
  ipcMain.handle(MAP_CHANNELS.layout, async (event, input: unknown): Promise<MapLayout> => {
    authorize(event);
    return store.get(conversationKey(parseConversationRef(input))) ?? { view: EMPTY_MAP_LAYOUT.view, nodes: {} };
  });
  ipcMain.handle(MAP_CHANNELS.saveLayout, async (event, input: unknown, layoutInput: unknown): Promise<void> => {
    authorize(event);
    store.set(conversationKey(parseConversationRef(input)), parseMapLayout(layoutInput));
  });
  return {
    dispose() {
      ipcMain.removeHandler(MAP_CHANNELS.layout);
      ipcMain.removeHandler(MAP_CHANNELS.saveLayout);
    },
  };
}
