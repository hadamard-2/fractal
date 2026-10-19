import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { conversationReducer, initialConversationState, type ConversationAction, type ConversationState } from '@/renderer/conversation-reducer';
import { parseUserDecision } from '@/shared/conversation-ipc';
import { conversationKey, type ConversationApi, type ConversationRef, type PromptInput, type UserDecision } from '@/shared/conversation-contract';

type HubApi = Pick<ConversationApi, 'open' | 'close' | 'continue' | 'interrupt' | 'resolveRequest' | 'onEvent'>;
type ActiveLoad = { ref: ConversationRef; loadId: string };
type Entry = { leases: number; load: ActiveLoad; state: ConversationState; recoveredLoadId: string | null };

function ignoreRejection(promise: Promise<unknown> | undefined): void {
  void Promise.resolve(promise).catch((): void => undefined);
}

function sameRef(left: ConversationRef, right: ConversationRef): boolean {
  return left.provider === right.provider
    && left.nativeSessionId === right.nativeSessionId
    && left.projectPath === right.projectPath;
}

function canSendIn(state: ConversationState): boolean {
  return state.ref !== null
    && state.history === 'complete'
    && state.sync === 'current'
    && (state.runtime === 'idle' || (state.runtime === 'active-in-fractal' && state.capabilities?.steerWhileRunning === true));
}

/**
 * The renderer's one load per conversation, shared by every view that shows
 * it, so showing a conversation in a second view never opens it a second time
 * under the first view.
 */
export class ConversationHub {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private subscribedToEvents = false;

  constructor(private readonly api: HubApi) {}

  /** Opens on the first lease and closes after the last is released (deferred one microtask, so a release-then-acquire in one commit keeps the load). */
  acquire(ref: ConversationRef): () => void {
    // Subscribed before any open, so an event emitted during open is kept.
    // The reducer drops events for every other load, so one subscription
    // covers the hub's whole lifetime.
    if (!this.subscribedToEvents) {
      this.subscribedToEvents = true;
      this.api.onEvent((event) => {
        const key = conversationKey(event.ref);
        const entry = this.entries.get(key);
        if (entry) this.dispatch(key, entry, event);
      });
    }

    const key = conversationKey(ref);
    let entry = this.entries.get(key);
    if (entry) {
      entry.leases += 1;
      if (entry.leases === 1) this.notify();
    } else {
      entry = { leases: 1, load: { ref, loadId: '' }, state: initialConversationState, recoveredLoadId: null };
      this.entries.set(key, entry);
      this.open(key, entry, ref);
    }

    const leased = entry;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      leased.leases -= 1;
      if (leased.leases > 0) return;
      this.notify();
      queueMicrotask(() => {
        if (leased.leases > 0 || this.entries.get(key) !== leased) return;
        this.entries.delete(key);
        ignoreRejection(this.api.close(leased.load.ref));
      });
    };
  }

  /** initialConversationState when not acquired. */
  state(ref: ConversationRef): ConversationState {
    return this.held(ref)?.state ?? initialConversationState;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  canSend(ref: ConversationRef): boolean {
    const entry = this.held(ref);
    return entry !== undefined && canSendIn(entry.state);
  }

  send(ref: ConversationRef, prompt: PromptInput): Promise<void | undefined> | undefined {
    const entry = this.held(ref);
    if (!entry || !canSendIn(entry.state)) return undefined;
    return this.containActionSettlement(this.api.continue(entry.load.ref, prompt), ref, entry.load);
  }

  interrupt(ref: ConversationRef): Promise<void | undefined> | undefined {
    const entry = this.held(ref);
    if (!entry) return undefined;
    return this.containActionSettlement(this.api.interrupt(entry.load.ref), ref, entry.load);
  }

  resolveRequest(ref: ConversationRef, requestId: string, decision: UserDecision): Promise<void | undefined> | undefined {
    const entry = this.held(ref);
    if (!entry) return undefined;
    try {
      return this.containActionSettlement(this.api.resolveRequest(requestId, parseUserDecision(decision)), ref, entry.load);
    } catch {
      // The bridge never sees malformed renderer input.
      return undefined;
    }
  }

  /** Closes and reopens a held conversation under a fresh load. */
  reload(ref: ConversationRef): void {
    const entry = this.held(ref);
    if (entry) this.reopen(conversationKey(ref), entry);
  }

  private held(ref: ConversationRef): Entry | undefined {
    const entry = this.entries.get(conversationKey(ref));
    return entry && entry.leases > 0 && sameRef(entry.load.ref, ref) ? entry : undefined;
  }

  private open(key: string, entry: Entry, ref: ConversationRef): void {
    const load: ActiveLoad = { ref, loadId: crypto.randomUUID() };
    entry.load = load;
    this.dispatch(key, entry, { type: 'opened', ref, loadId: load.loadId });
    const isCurrent = () => this.entries.get(key) === entry && entry.load === load;

    ignoreRejection(this.api.open(ref, load.loadId).then(
      (result) => {
        if (!isCurrent()) return;
        this.dispatch(key, entry, { type: 'open.succeeded', ref, loadId: load.loadId, ...result });
      },
      (cause: unknown) => {
        if (!isCurrent()) return;
        this.dispatch(key, entry, {
          type: 'open.failed',
          ref,
          loadId: load.loadId,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      },
    ));
  }

  private reopen(key: string, entry: Entry): void {
    ignoreRejection(this.api.close(entry.load.ref));
    this.open(key, entry, entry.load.ref);
  }

  private dispatch(key: string, entry: Entry, action: ConversationAction): void {
    const next = conversationReducer(entry.state, action);
    if (next === entry.state) return;
    entry.state = next;
    // A hole means there is no safe interpretation for later events. Reopen
    // once for that load, allowing native history to become the baseline.
    if (entry.leases > 0 && next.sync === 'gap' && next.loadId && entry.recoveredLoadId !== next.loadId) {
      entry.recoveredLoadId = next.loadId;
      this.reopen(key, entry);
      return;
    }
    this.notify();
  }

  /** A rejection reaches the caller only while the load it was sent on is still the held one. */
  private containActionSettlement(promise: Promise<void>, ref: ConversationRef, load: ActiveLoad): Promise<void | undefined> {
    return promise.then(undefined, (cause: unknown) => {
      if (this.held(ref)?.load === load) throw cause;
    });
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

let hub: ConversationHub | null = null;

/** The app's single hub over window.fractal.conversations. */
export function conversationHub(): ConversationHub {
  hub ??= new ConversationHub(window.fractal.conversations);
  return hub;
}

/** Drops the app's hub, so the next conversationHub() binds to the window.fractal a test installed. */
export function resetConversationHubForTests(): void {
  hub = null;
}

/** Leases each ref while mounted; the map is keyed by conversationKey and changes only when one of its states does. */
export function useConversationStates(refs: readonly ConversationRef[]): ReadonlyMap<string, ConversationState> {
  const shared = conversationHub();
  const identity = JSON.stringify(refs.map((ref) => [ref.provider, ref.nativeSessionId, ref.projectPath]));
  // Keyed on what the refs say, so a new array of the same refs keeps its leases.
  const leased = useMemo(() => refs.map((ref) => ({ ...ref })), [identity]);

  useEffect(() => {
    const releases = leased.map((ref) => shared.acquire(ref));
    return () => { for (const release of releases) release(); };
  }, [leased, shared]);

  const snapshot = useMemo(() => {
    let previous: { states: ConversationState[]; map: ReadonlyMap<string, ConversationState> } | null = null;
    return (): ReadonlyMap<string, ConversationState> => {
      const states = leased.map((ref) => shared.state(ref));
      if (previous && previous.states.every((state, index) => state === states[index])) return previous.map;
      previous = { states, map: new Map(leased.map((ref, index) => [conversationKey(ref), states[index]])) };
      return previous.map;
    };
  }, [leased, shared]);

  return useSyncExternalStore(shared.subscribe, snapshot);
}
