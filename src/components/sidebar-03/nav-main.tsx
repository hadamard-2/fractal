'use client';

import { Folder, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuItem as SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { conversationKey, type ConversationRef, type ConversationRuntime, type HarnessStatus, type ProjectConversationGroup } from '@/shared/conversation-contract';
import { NewConversationMenu } from '@/components/conversation/new-conversation-menu';

export type NavSelection = {
  ref: ConversationRef;
  title: string;
  section: string;
  runtime: ConversationRuntime;
};

export const providerName = (provider: ConversationRef['provider']) =>
  provider === 'claude' ? 'Claude Code' : 'Codex';

export function runtimeLabel(runtime: ConversationRuntime): string {
  switch (runtime) {
    case 'idle': return 'Idle';
    case 'active-in-fractal': return 'Working here';
    case 'active-externally': return 'Working elsewhere';
    case 'waiting-for-user': return 'Waiting for you';
    case 'unknown': return 'Status unknown';
    case 'failed': return 'Failed';
  }
}

export default function NavMain({
  groups,
  providers,
  selected,
  onSelect,
  onCreated,
}: {
  groups: ProjectConversationGroup[];
  providers: HarnessStatus[];
  selected: ConversationRef | null;
  onSelect: (item: NavSelection) => void;
  onCreated: (ref: ConversationRef) => void;
}) {
  const { state } = useSidebar();
  const [openProjects, setOpenProjects] = useState<Set<string>>(() =>
    new Set(selected ? [selected.projectPath] : [])
  );
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const isCollapsed = state === 'collapsed';

  useEffect(() => {
    const projectPaths = new Set(groups.map((group) => group.projectPath));
    setOpenProjects((open) => new Set([...open].filter((path) => projectPaths.has(path))));
  }, [groups]);

  useEffect(() => {
    if (selected) {
      setOpenProjects((open) => new Set(open).add(selected.projectPath));
    }
  }, [selected]);

  if (isCollapsed) return null;

  return (
    <SidebarMenu>
      {groups.map((group) => {
        const isOpen = openProjects.has(group.projectPath);
        const showAll = expandedProjects.has(group.projectPath);
        const visibleConversations = showAll ? group.conversations : group.conversations.slice(0, 5);

        return (
          <SidebarMenuItem data-testid="project-group" key={group.projectPath}>
            <Collapsible
              className="w-full"
              onOpenChange={(open) => {
                setOpenProjects((previous) => {
                  const next = new Set(previous);
                  if (open) next.add(group.projectPath);
                  else next.delete(group.projectPath);
                  return next;
                });
                if (!open) {
                  setExpandedProjects((expanded) => {
                    const remaining = new Set(expanded);
                    remaining.delete(group.projectPath);
                    return remaining;
                  });
                }
              }}
              open={isOpen}
            >
              <CollapsibleTrigger asChild>
                <SidebarMenuButton className="pr-9" type="button">
                  {isOpen ? <FolderOpen /> : <Folder />}
                  <span>{group.displayName}</span>
                </SidebarMenuButton>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub className="my-1 ml-3.5 mr-0 pr-0">
                  {visibleConversations.map((conversation) => {
                    const isSelected = selected !== null && conversationKey(selected) === conversationKey(conversation.ref);
                    return (
                      <SidebarMenuSubItem className="h-auto" key={conversationKey(conversation.ref)}>
                        <SidebarMenuSubButton asChild isActive={isSelected}>
                          <button
                            className="flex w-full items-center rounded-md py-1.5 pr-2.5 pl-4 text-left font-normal text-muted-foreground text-sm hover:bg-sidebar-accent hover:text-foreground"
                            aria-label={[conversation.title, `${providerName(conversation.ref.provider)} conversation`, runtimeLabel(conversation.runtime)].filter(Boolean).join(', ')}
                            aria-current={isSelected ? 'page' : undefined}
                            onClick={() => onSelect({
                              ref: conversation.ref,
                              title: conversation.title,
                              section: group.displayName,
                              runtime: conversation.runtime,
                            })}
                            type="button"
                          >
                            <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                            <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${conversation.ref.provider === 'claude' ? 'bg-[#D97757]' : 'bg-[#3941FF]'}`} title={providerName(conversation.ref.provider)} />
                          </button>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    );
                  })}
                  {!showAll && group.conversations.length > 5 && (
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton asChild>
                        <button
                          className="w-full px-4 py-1.5 text-left text-sidebar-foreground/55 text-sm hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:text-sidebar-foreground"
                          onClick={() => setExpandedProjects((expanded) => new Set(expanded).add(group.projectPath))}
                          type="button"
                        >
                          <span>Show more</span>
                        </button>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  )}
                </SidebarMenuSub>
              </CollapsibleContent>
            </Collapsible>
            <NewConversationMenu
              onCreated={onCreated}
              projectName={group.displayName}
              projectPath={group.projectPath}
              providers={providers}
            />
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
