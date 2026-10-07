import { useCallback, useEffect, useRef, useState } from 'react';
import { conversationKey, type AccessListing, type ConversationRef, type ConversationRuntime, type TurnAccess } from '@/shared/conversation-contract';

type Own = Pick<AccessListing, 'levels' | 'access' | 'observed' | 'allowDangerous'> & { loaded: boolean };
interface State extends Own { key: string; picked: boolean }

const NONE: Own = { levels: [], access: null, observed: undefined, allowDangerous: false, loaded: false };

/** A failed lookup resolves to null; the picker then shows the agent's default rather than blocking the composer. */
function listAccess(ref: ConversationRef): Promise<AccessListing | null> {
  return Promise.resolve().then(() => window.fractal.access.list(ref)).catch((): null => null);
}

/** The conversation's access choice and its agent's levels. Picks save immediately and apply to the next turn. */
export function useAccessChoice(ref: ConversationRef, runtime: ConversationRuntime) {
  const key = conversationKey(ref);
  const latest = useRef(ref);
  latest.current = ref;
  const [state, setState] = useState<State>({ key, ...NONE, picked: false });

  useEffect(() => {
    let live = true;
    void listAccess(latest.current).then((result) => {
      if (!live) return;
      // A pick made while the lookup was in flight wins over the stored answer.
      setState((prior) => {
        const kept = prior.key === key && prior.picked;
        return { key, levels: result?.levels ?? [], access: kept ? prior.access : result?.access ?? null, observed: result?.observed, allowDangerous: result?.allowDangerous ?? false, loaded: true, picked: kept };
      });
    });
    return () => { live = false; };
  }, [key]);

  const refresh = useCallback(() => {
    void listAccess(latest.current).then((result) => {
      if (!result) return;
      setState((prior) => prior.key === key ? { ...prior, levels: result.levels, observed: result.observed, allowDangerous: result.allowDangerous, access: prior.picked ? prior.access : result.access } : prior);
    });
  }, [key]);

  // A turn that just ended may have changed what the agent reports.
  const previous = useRef(runtime);
  useEffect(() => {
    if (previous.current === 'active-in-fractal' && runtime !== 'active-in-fractal') refresh();
    previous.current = runtime;
  }, [runtime, refresh]);

  const choose = useCallback((level: string) => {
    const access: TurnAccess = { state: { kind: 'level', level }, picked: true };
    setState((prior) => prior.key === key ? { ...prior, access, picked: true, loaded: true } : { key, ...NONE, access, picked: true, loaded: true });
    void Promise.resolve().then(() => window.fractal.access.choose(latest.current, level)).catch((): void => undefined);
  }, [key]);

  const own: Own = state.key === key ? state : NONE;
  return { levels: own.levels, access: own.access, observed: own.observed, allowDangerous: own.allowDangerous, loaded: own.loaded, refresh, choose };
}
