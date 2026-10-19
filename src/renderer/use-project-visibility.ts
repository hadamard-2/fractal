import { useEffect, useRef, useState } from 'react';
import { conversationKey, type ConversationRef, type ProviderId } from '@/shared/conversation-contract';
import type { FractalSettings, ProjectFilter, ProjectVisibility } from '@/shared/settings-contract';
import { projectStatus, withProjectStatus, type ProjectStatus } from './project-visibility';

const emptyVisibility = (): ProjectVisibility => ({ archived: [], removed: [] });

/**
 * The archived/removed project lists, the archived chats, and the sidebar's status and agent
 * filters, loaded from settings and saved back on every change. One instance
 * lives in the app shell so the sidebar, search, and the new-conversation
 * picker agree.
 */
export function useProjectVisibility() {
  const [visibility, setVisibility] = useState<ProjectVisibility>(emptyVisibility);
  const [filter, setFilterState] = useState<ProjectFilter>('active');
  const [hiddenAgents, setHiddenAgentsState] = useState<ProviderId[]>([]);
  const [archivedChats, setArchivedChatsState] = useState<string[]>([]);
  const [error, setError] = useState(false);
  const visibilityRef = useRef(visibility);
  const hiddenAgentsRef = useRef(hiddenAgents);
  const archivedChatsRef = useRef(archivedChats);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let active = true;
    window.fractal.settings.get().then((settings) => {
      if (!active) return;
      // Older settings payloads (and test doubles) may predate these fields.
      const loaded = settings.projectVisibility ?? emptyVisibility();
      visibilityRef.current = loaded;
      setVisibility(loaded);
      setFilterState(settings.projectFilter ?? 'active');
      const hidden = settings.hiddenAgents ?? [];
      hiddenAgentsRef.current = hidden;
      setHiddenAgentsState(hidden);
      const archived = settings.archivedChats ?? [];
      archivedChatsRef.current = archived;
      setArchivedChatsState(archived);
    }).catch(() => {
      if (active) setError(true);
    });
    return () => { active = false; };
  }, []);

  // Saves run in order so a quick archive-then-remove can't land reversed.
  const save = (patch: Partial<FractalSettings>) => {
    saveQueue.current = saveQueue.current
      .then(async () => { await window.fractal.settings.set(patch); })
      .then(() => { setError(false); })
      .catch(() => { setError(true); });
  };

  const setStatus = (projectPath: string, status: ProjectStatus) => {
    const next = withProjectStatus(visibilityRef.current, projectPath, status);
    if (next === visibilityRef.current) return;
    visibilityRef.current = next;
    setVisibility(next);
    save({ projectVisibility: next });
  };

  const setAgentShown = (agent: ProviderId, shown: boolean) => {
    const current = hiddenAgentsRef.current;
    if (current.includes(agent) !== shown) return;
    const next = shown ? current.filter((item) => item !== agent) : [...current, agent];
    hiddenAgentsRef.current = next;
    setHiddenAgentsState(next);
    save({ hiddenAgents: next });
  };

  const setChatArchived = (ref: ConversationRef, archived: boolean) => {
    const key = conversationKey(ref);
    const current = archivedChatsRef.current;
    if (current.includes(key) === archived) return;
    const next = archived ? [...current, key] : current.filter((item) => item !== key);
    archivedChatsRef.current = next;
    setArchivedChatsState(next);
    save({ archivedChats: next });
  };

  return {
    visibility,
    archivedChats,
    filter,
    hiddenAgents,
    error,
    statusOf: (projectPath: string) => projectStatus(visibility, projectPath),
    setFilter: (next: ProjectFilter) => {
      setFilterState(next);
      save({ projectFilter: next });
    },
    setAgentShown,
    setStatus,
    isChatArchived: (ref: ConversationRef) => archivedChats.includes(conversationKey(ref)),
    setChatArchived,
  };
}

export type ProjectVisibilityState = ReturnType<typeof useProjectVisibility>;
