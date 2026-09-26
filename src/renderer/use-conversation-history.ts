import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  HarnessStatus,
  ProjectConversationGroup,
} from '@/shared/conversation-contract';

export function useConversationHistory() {
  const [projects, setProjects] = useState<ProjectConversationGroup[]>([]);
  const [providers, setProviders] = useState<HarnessStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mounted = useRef(false);
  const latestRequest = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    if (mounted.current) setLoading(true);

    try {
      const history = await window.fractal.conversations.list();
      if (!mounted.current || request !== latestRequest.current) return;
      setProjects(history.projects);
      setProviders(history.providers);
      setError(null);
    } catch (cause) {
      if (!mounted.current || request !== latestRequest.current) return;
      setError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      if (mounted.current && request === latestRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = window.fractal.conversations.onEvent((event) => {
      if (event.type === 'summary.updated') void refresh();
    });

    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [refresh]);

  return { projects, providers, loading, error, refresh };
}

export type ConversationHistory = ReturnType<typeof useConversationHistory>;
