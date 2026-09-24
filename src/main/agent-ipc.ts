import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ConversationService } from '@/main/conversation-service';
import { canonicalizeProjectPath } from '@/main/harness/project-path';
import { conversationKey, type ConversationRef, type ProviderId } from '@/shared/conversation-contract';
import { CONVERSATION_CHANNELS as CHANNELS, parseConversationRef, parseConversationStreamEvent, parseLoadId, parsePromptInput, parseUserDecision } from '@/shared/conversation-ipc';

type Owner = { sender: WebContents; closed: boolean; detach: () => void };
type OwnedLoad = { owner: Owner; ref: ConversationRef; loadId: string };
type Registration = { emit: (payload: unknown) => void; dispose: () => Promise<void> };
let activeRegistration: { service: ConversationService; registration: Registration } | undefined;

export function registerConversationIpc(service: ConversationService, getWindow: () => BrowserWindow | null): Registration {
  if (activeRegistration) {
    if (activeRegistration.service !== service) throw new Error('Conversation IPC is already registered');
    return activeRegistration.registration;
  }
  const owners = new Map<WebContents, Owner>();
  const loads = new Map<string, OwnedLoad>();
  const loadIds = new Map<string, OwnedLoad>();
  const requests = new Map<string, OwnedLoad>();
  const cleanup = new Set<Promise<unknown>>();
  const channels: string[] = [];
  let disposed = false;
  let disposal: Promise<void> | undefined;

  const track = (promise: Promise<unknown>) => {
    const safe = promise.catch((): void => undefined).finally(() => cleanup.delete(safe));
    cleanup.add(safe);
  };
  const forget = (load: OwnedLoad) => {
    if (loads.get(conversationKey(load.ref)) !== load) return;
    loads.delete(conversationKey(load.ref)); loadIds.delete(load.loadId);
    for (const [id, request] of requests) if (request === load) requests.delete(id);
  };
  const releaseOwner = (owner: Owner) => {
    if (owner.closed) return;
    owner.closed = true; owner.detach(); owners.delete(owner.sender);
    for (const load of loads.values()) {
      if (load.owner !== owner) continue;
      forget(load); track(service.close(load.ref));
    }
    track(service.denyRequestsForOwner(String(owner.sender.id), 'Fractal window closed'));
  };
  const authorize = (event: IpcMainInvokeEvent) => {
    const window = getWindow();
    if (disposed || !window || window.isDestroyed() || event.sender !== window.webContents || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Unauthorized conversation sender');
    }
    return window;
  };
  const ownerFor = (sender: WebContents): Owner => {
    const known = owners.get(sender); if (known) return known;
    const owner: Owner = { sender, closed: false, detach: () => undefined };
    const destroyed = () => releaseOwner(owner);
    const navigated = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) releaseOwner(owner);
    };
    const crashed = () => releaseOwner(owner);
    sender.on('destroyed', destroyed); sender.on('did-start-navigation', navigated); sender.on('render-process-gone', crashed);
    owner.detach = () => {
      sender.removeListener('destroyed', destroyed); sender.removeListener('did-start-navigation', navigated); sender.removeListener('render-process-gone', crashed);
    };
    owners.set(sender, owner); return owner;
  };
  const assertLive = (owner: Owner) => {
    if (disposed || owner.closed || owner.sender.isDestroyed()) throw new Error('Conversation operation failed');
  };
  const requireLoad = (owner: Owner, ref: ConversationRef) => {
    const load = loads.get(conversationKey(ref));
    if (!load || load.owner !== owner || load.ref.projectPath !== ref.projectPath) throw new Error('Conversation is not owned by this renderer');
    return load;
  };
  const invoke = (channel: string, arity: number, prepare: (args: unknown[], owner: Owner, window: BrowserWindow) => () => Promise<unknown>) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const window = authorize(event);
      if (args.length !== arity) throw new Error('Invalid conversation arguments');
      // Parsing and ownership errors are locally authored; native failures are hidden.
      const owner = ownerFor(event.sender);
      const run = prepare(args, owner, window);
      try { assertLive(owner); const result = await run(); assertLive(owner); return result; }
      catch { throw new Error('Conversation operation failed'); }
    });
    channels.push(channel);
  };
  const registration: Registration = {
    emit(payload) {
      if (disposed) return;
      let event;
      try { event = parseConversationStreamEvent(payload); } catch { return; }
      const load = loadIds.get(event.loadId);
      if (!load || conversationKey(event.ref) !== conversationKey(load.ref) || event.ref.projectPath !== load.ref.projectPath || load.owner.closed) return;
      if (load.owner.sender.isDestroyed()) { releaseOwner(load.owner); return; }
      if (event.type === 'request.opened') {
        const previous = requests.get(event.request.id);
        if (previous && previous !== load) return;
        if (event.request.status === 'open') requests.set(event.request.id, load);
      } else if (event.type === 'request.resolved' && requests.get(event.requestId) === load) requests.delete(event.requestId);
      try { load.owner.sender.send(CHANNELS.event, event); }
      catch { releaseOwner(load.owner); }
      if (event.type === 'load.failed') forget(load);
    },
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      for (const channel of channels) ipcMain.removeHandler(channel);
      for (const owner of owners.values()) releaseOwner(owner);
      if (activeRegistration?.registration === registration) activeRegistration = undefined;
      disposal = Promise.all([...cleanup]).then((): void => undefined);
      return disposal;
    },
  };
  try {
    invoke(CHANNELS.list, 0, () => () => service.list());
    invoke(CHANNELS.open, 2, ([input, id], owner) => {
      const ref = parseConversationRef(input), loadId = parseLoadId(id);
      const prior = loads.get(conversationKey(ref));
      const duplicate = loadIds.get(loadId);
      if ((prior && (prior.owner !== owner || prior.ref.projectPath !== ref.projectPath)) || (duplicate && duplicate !== prior)) throw new Error('Conversation is not owned by this renderer');
      return async () => {
        const load = prior?.loadId === loadId ? prior : { owner, ref, loadId };
        if (prior && prior !== load) forget(prior);
        loads.set(conversationKey(ref), load); loadIds.set(loadId, load);
        try {
          const result = await service.open(ref, loadId);
          if (loads.get(conversationKey(ref)) !== load) throw new Error('Conversation load ended');
          return result;
        } catch (error) { forget(load); throw error; }
      };
    });
    invoke(CHANNELS.close, 1, ([input], owner) => {
      const ref = parseConversationRef(input), load = requireLoad(owner, ref);
      return async () => { forget(load); await service.close(ref); };
    });
    invoke(CHANNELS.create, 1, ([input], owner, window) => {
      const { provider, projectPath: requestedProjectPath } = parseCreateInput(input);
      return async () => {
        if (requestedProjectPath !== undefined) {
          const projectPath = await canonicalizeProjectPath(requestedProjectPath, realpath);
          assertLive(owner);
          const { projects } = await service.list();
          assertLive(owner);
          if (!projects.some((project) => project.projectPath === projectPath)) throw new Error('Project is not available');
          return parseConversationRef(await service.create(provider, projectPath));
        }
        const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
        assertLive(owner);
        if (result.canceled || !result.filePaths[0]) return null;
        const projectPath = await canonicalizeProjectPath(result.filePaths[0], realpath);
        assertLive(owner);
        return parseConversationRef(await service.create(provider, projectPath));
      };
    });
    invoke(CHANNELS.continue, 2, ([input, promptInput], owner) => {
      const ref = parseConversationRef(input), prompt = parsePromptInput(promptInput); requireLoad(owner, ref);
      return () => service.continue(ref, prompt, String(owner.sender.id));
    });
    invoke(CHANNELS.interrupt, 1, ([input], owner) => {
      const ref = parseConversationRef(input); requireLoad(owner, ref);
      return () => service.interrupt(ref);
    });
    invoke(CHANNELS.resolveRequest, 2, ([input, decisionInput], owner) => {
      const id = parseRequestId(input), decision = parseUserDecision(decisionInput);
      const load = requests.get(id);
      if (!load || load.owner !== owner) throw new Error('Conversation is not owned by this renderer');
      return async () => { requests.delete(id); await service.resolveRequest(id, decision); };
    });
  } catch (error) { void registration.dispose(); throw error; }
  activeRegistration = { service, registration };
  return registration;
}

export async function disposeConversationIpc(): Promise<void> { await activeRegistration?.registration.dispose(); }

function parseCreateInput(input: unknown): { provider: ProviderId; projectPath?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input)) || !('provider' in input) || (input.provider !== 'codex' && input.provider !== 'claude')) throw new Error('Invalid conversation provider');
  const keys = Object.keys(input);
  if (!keys.every((key) => key === 'provider' || key === 'projectPath') || keys.length < 1 || keys.length > 2) throw new Error('Invalid conversation provider');
  if (!('projectPath' in input)) return { provider: input.provider };
  if (typeof input.projectPath !== 'string' || input.projectPath.trim().length === 0 || input.projectPath.length > 32_768 || !isAbsolute(input.projectPath)) throw new Error('Invalid conversation project');
  return { provider: input.provider, projectPath: input.projectPath };
}

function parseRequestId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 1_000_000) throw new Error('Invalid request id');
  return input;
}
