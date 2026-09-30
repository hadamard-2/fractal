import { useCallback, useEffect, useRef, useState } from 'react';
import { conversationKey, type AgentModel, type ConversationRef, type ModelChoice } from '@/shared/conversation-contract';

interface State { key: string; models: AgentModel[]; choice: ModelChoice | null; picked: boolean; loaded: boolean }

/** A failed lookup leaves the picker on the agent's default rather than blocking the composer. */
function listModels(ref: ConversationRef): Promise<{ models: AgentModel[]; choice: ModelChoice | null }> {
  return Promise.resolve().then(() => window.fractal.models.list(ref)).catch((): { models: AgentModel[]; choice: ModelChoice | null } => ({ models: [], choice: null }));
}

/** The conversation's model choice and its agent's catalog. Picks save immediately and apply to the next turn. */
export function useModelChoice(ref: ConversationRef) {
  const key = conversationKey(ref);
  const latest = useRef(ref);
  latest.current = ref;
  const [state, setState] = useState<State>({ key, models: [], choice: null, picked: false, loaded: false });

  useEffect(() => {
    let live = true;
    void listModels(latest.current).then((result) => {
      if (!live) return;
      // A pick made while the lookup was in flight wins over the stored answer.
      setState((prior) => ({ key, models: result.models, choice: prior.key === key && prior.picked ? prior.choice : result.choice, picked: prior.key === key && prior.picked, loaded: true }));
    });
    return () => { live = false; };
  }, [key]);

  const refresh = useCallback(() => {
    void listModels(latest.current).then((result) => setState((prior) => prior.key === key ? { ...prior, models: result.models } : prior));
  }, [key]);

  const choose = useCallback((choice: ModelChoice) => {
    setState((prior) => ({ key, models: prior.key === key ? prior.models : [], choice, picked: true, loaded: true }));
    void Promise.resolve().then(() => window.fractal.models.choose(latest.current, choice)).catch((): void => undefined);
  }, [key]);

  const own: { models: AgentModel[]; choice: ModelChoice | null; loaded: boolean } = state.key === key ? state : { models: [], choice: null, loaded: false };
  return { models: own.models, choice: own.choice, loaded: own.loaded, refresh, choose };
}
