import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { ModelChoices } from '@/main/model-choices';
import { MODEL_CHANNELS, parseConversationRef, parseModelChoice } from '@/shared/conversation-ipc';

/** The composer's model picker: the agent catalog, the conversation's resolved choice, and saving a pick. */
export function registerModelIpc(choices: Pick<ModelChoices, 'catalog' | 'resolve' | 'choose'>, getWindow: () => BrowserWindow | null): { dispose(): void } {
  const authorize = (event: IpcMainInvokeEvent): void => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Unauthorized model sender');
  };
  ipcMain.handle(MODEL_CHANNELS.list, async (event, input: unknown) => {
    authorize(event);
    const ref = parseConversationRef(input);
    return { models: choices.catalog(ref.provider), choice: await choices.resolve(ref) };
  });
  ipcMain.handle(MODEL_CHANNELS.choose, async (event, input: unknown, choiceInput: unknown) => {
    authorize(event);
    const ref = parseConversationRef(input);
    const choice = parseModelChoice(choiceInput);
    if (!choice) throw new Error('Invalid model choice');
    choices.choose(ref, choice);
  });
  return {
    dispose() {
      ipcMain.removeHandler(MODEL_CHANNELS.list);
      ipcMain.removeHandler(MODEL_CHANNELS.choose);
    },
  };
}
