// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AttachmentsApi, ConversationApi, ModelsApi } from '@/shared/conversation-contract';
import { FILES_CHANNELS, parseFilesEvent, type FilesApi } from '@/shared/files-contract';
import { TERMINAL_CHANNELS, parseTerminalEvent, type TerminalApi } from '@/shared/terminal-contract';
import { CONVERSATION_CHANNELS as CHANNELS, MODEL_CHANNELS, parseConversationStreamEvent } from '@/shared/conversation-ipc';
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
  previewAttachment: (ref, path) => ipcRenderer.invoke(CHANNELS.previewAttachment, ref, path),
  openAttachment: (ref, path, action) => ipcRenderer.invoke(CHANNELS.openAttachment, ref, path, action),
  rename: (ref, title) => ipcRenderer.invoke(CHANNELS.rename, ref, title),
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

const models: ModelsApi = {
  list: (ref) => ipcRenderer.invoke(MODEL_CHANNELS.list, ref),
  choose: (ref, choice) => ipcRenderer.invoke(MODEL_CHANNELS.choose, ref, choice),
};

const settings: FractalSettingsApi = {
  get: () => invokeSettings({ method: 'get' }),
  set: (patch) => invokeSettings({ method: 'set', patch }),
  openDataFolder: () => invokeSettings({ method: 'openDataFolder' }),
  agentEnvironment: () => invokeSettings({ method: 'agentEnvironment' }),
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

const attachments: AttachmentsApi = {
  pathFor: (file) => webUtils.getPathForFile(file),
};

const invokeFiles = (request: Record<string, unknown>) => ipcRenderer.invoke(FILES_CHANNELS.invoke, request);

const files: FilesApi = {
  listDirectory: (root, path) => invokeFiles({ method: 'listDirectory', root, path }),
  readFile: (root, path) => invokeFiles({ method: 'readFile', root, path }),
  listFiles: (root) => invokeFiles({ method: 'listFiles', root }),
  watch: (watchId, root, path) => invokeFiles({ method: 'watch', watchId, root, path }),
  unwatch: (watchId) => invokeFiles({ method: 'unwatch', watchId }),
  editors: () => invokeFiles({ method: 'editors' }),
  open: (action, root, path, line) => invokeFiles({ method: 'open', action, root, path, ...(line === undefined ? {} : { line }) }),
  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      try { listener(parseFilesEvent(payload)); } catch { /* Drop invalid native events. */ }
    };
    ipcRenderer.on(FILES_CHANNELS.event, handler);
    return () => { ipcRenderer.removeListener(FILES_CHANNELS.event, handler); };
  },
};

contextBridge.exposeInMainWorld('fractal', { conversations, models, settings, terminals, attachments, files });
