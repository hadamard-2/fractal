// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from 'electron';
import type { ConversationApi } from '@/shared/conversation-contract';
import { TERMINAL_CHANNELS, parseTerminalEvent, type TerminalApi } from '@/shared/terminal-contract';
import { CONVERSATION_CHANNELS as CHANNELS, parseConversationStreamEvent } from '@/shared/conversation-ipc';
import {
  SETTINGS_INVOKE_CHANNEL,
  type FractalSettingsApi,
  type SettingsInvokeRequest,
} from '@/shared/settings-contract';

const invokeSettings = (req: SettingsInvokeRequest) => ipcRenderer.invoke(SETTINGS_INVOKE_CHANNEL, req);

const conversations: ConversationApi = {
  list: () => ipcRenderer.invoke(CHANNELS.list),
  open: (ref, loadId) => ipcRenderer.invoke(CHANNELS.open, ref, loadId),
  close: (ref) => ipcRenderer.invoke(CHANNELS.close, ref),
  create: (input) => ipcRenderer.invoke(CHANNELS.create, input),
  continue: (ref, prompt) => ipcRenderer.invoke(CHANNELS.continue, ref, prompt),
  interrupt: (ref) => ipcRenderer.invoke(CHANNELS.interrupt, ref),
  resolveRequest: (id, decision) => ipcRenderer.invoke(CHANNELS.resolveRequest, id, decision),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      let event;
      try { event = parseConversationStreamEvent(payload); } catch { return; }
      listener(event);
    };
    ipcRenderer.on(CHANNELS.event, handler);
    return () => { ipcRenderer.removeListener(CHANNELS.event, handler); };
  },
};

const settings: FractalSettingsApi = {
  get: () => invokeSettings({ method: 'get' }),
  set: (patch) => invokeSettings({ method: 'set', patch }),
  openDataFolder: () => invokeSettings({ method: 'openDataFolder' }),
};

const terminals: TerminalApi = {
  create: (input) => ipcRenderer.invoke(TERMINAL_CHANNELS.invoke, { method: 'create', ...input }),
  write: (id, data) => ipcRenderer.invoke(TERMINAL_CHANNELS.invoke, { method: 'write', id, data }),
  resize: (id, cols, rows) => ipcRenderer.invoke(TERMINAL_CHANNELS.invoke, { method: 'resize', id, cols, rows }),
  close: (id) => ipcRenderer.invoke(TERMINAL_CHANNELS.invoke, { method: 'close', id }),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      try { listener(parseTerminalEvent(payload)); } catch { /* Drop invalid native events. */ }
    };
    ipcRenderer.on(TERMINAL_CHANNELS.event, handler);
    return () => { ipcRenderer.removeListener(TERMINAL_CHANNELS.event, handler); };
  },
};

contextBridge.exposeInMainWorld('fractal', { conversations, settings, terminals });
