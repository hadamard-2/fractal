// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';
import type { AgentEvent, FractalAgentApi } from '@/shared/agent-contract';
import { AGENT_EVENT_CHANNEL, AGENT_INVOKE_CHANNEL } from '@/shared/agent-ipc-channels';

const invoke = (req: unknown) => ipcRenderer.invoke(AGENT_INVOKE_CHANNEL, req);

const agent: FractalAgentApi = {
  listConversations: () => invoke({ method: 'listConversations' }),
  getConversation: (id) => invoke({ method: 'getConversation', id }),
  createConversation: () => invoke({ method: 'createConversation' }),
  sendMessage: (input) => invoke({ method: 'sendMessage', input }),
  cancelTurn: (input) => invoke({ method: 'cancelTurn', input }),
  respondToPermission: (input) => invoke({ method: 'respondToPermission', input }),
  onAgentEvent: (listener) => {
    const handler = (_e: unknown, event: AgentEvent) => listener(event);
    ipcRenderer.on(AGENT_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(AGENT_EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld('fractal', { agent });
