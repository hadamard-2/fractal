import { useEffect, useMemo, useRef, useState } from 'react';
import { conversationKey, type ProjectConversationGroup } from '@/shared/conversation-contract';
import type { SidebarOrder } from '@/shared/settings-contract';
import { applySidebarOrder, moveInOrder, topLevelConversations } from './sidebar-order';

const emptyOrder = (): SidebarOrder => ({ projects: [], chatsByProject: {} });

export function useSidebarOrder(projects: ProjectConversationGroup[]) {
  const [order, setOrder] = useState<SidebarOrder>(emptyOrder);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const orderRef = useRef(order);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let active = true;
    window.fractal.settings.get().then((settings) => {
      if (!active) return;
      orderRef.current = settings.sidebarOrder;
      setOrder(settings.sidebarOrder);
      setReady(true);
    }).catch(() => {
      if (!active) return;
      setError(true);
      setReady(true);
    });
    return () => { active = false; };
  }, []);

  const orderedProjects = useMemo(() => applySidebarOrder(topLevelConversations(projects), order), [projects, order]);

  const save = (next: SidebarOrder) => {
    orderRef.current = next;
    setOrder(next);
    setError(false);
    saveQueue.current = saveQueue.current
      .then(async () => { await window.fractal.settings.set({ sidebarOrder: next }); })
      .then(() => { setError(false); })
      .catch(() => { setError(true); });
  };

  const moveProject = (source: string, target: string) => {
    const current = orderedProjects.map((group) => group.projectPath);
    const nextProjects = moveInOrder(current, source, target);
    if (nextProjects !== current) save({ ...orderRef.current, projects: nextProjects });
  };

  const moveChat = (projectPath: string, source: string, target: string) => {
    const group = orderedProjects.find((item) => item.projectPath === projectPath);
    if (!group) return;
    const current = group.conversations.map((item) => conversationKey(item.ref));
    const chats = moveInOrder(current, source, target);
    if (chats !== current) save({ ...orderRef.current, chatsByProject: { ...orderRef.current.chatsByProject, [projectPath]: chats } });
  };

  return { orderedProjects, ready, error, moveProject, moveChat };
}
