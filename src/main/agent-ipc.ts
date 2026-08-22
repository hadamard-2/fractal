import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { ConversationStore } from '@/main/conversation-store';
import { SessionManager } from '@/main/session-manager';
import { createEchoAdapter } from '@/main/backend-adapter';
import type { AgentEvent } from '@/shared/agent-contract';
import { AGENT_EVENT_CHANNEL, AGENT_INVOKE_CHANNEL, type AgentInvokeRequest } from '@/shared/agent-ipc-channels';

export function registerAgentIpc(getWindow: () => BrowserWindow | null): void {
  const store = new ConversationStore(app.getPath('userData'));
  const emit = (event: AgentEvent) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.webContents.send(AGENT_EVENT_CHANNEL, event);
  };
  const manager = new SessionManager({ store, adapter: createEchoAdapter(), emit });

  ipcMain.handle(AGENT_INVOKE_CHANNEL, async (_e, req: AgentInvokeRequest) => {
    switch (req.method) {
      case 'listConversations':
        return store.list();
      case 'getConversation':
        return manager.snapshot(req.id);
      case 'createConversation': {
        const win = getWindow();
        const result = win
          ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
          : await dialog.showOpenDialog({ properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) return null;
        return store.create(result.filePaths[0]);
      }
      case 'sendMessage':
        return manager.sendMessage(req.input);
      case 'cancelTurn':
        return manager.cancelTurn(req.input);
      case 'respondToPermission':
        return manager.respondToPermission(req.input);
      default: {
        const unreachable: never = req;
        throw new Error(`Unrecognized agent invoke method: ${(unreachable as AgentInvokeRequest).method}`);
      }
    }
  });
}
