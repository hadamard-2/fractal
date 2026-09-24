'use client';

import { CircleAlert, CircleHelp, CirclePause, Folder, FolderOpen, Radio } from 'lucide-react';
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
import { conversationKey, type ConversationRef, type ConversationRuntime, type ProjectConversationGroup } from '@/shared/conversation-contract';

export type NavSelection = {
  ref: ConversationRef;
  title: string;
  section: string;
};

const providerName = (provider: ConversationRef['provider']) =>
  provider === 'claude' ? 'Claude Code' : 'Codex';

function RuntimeMark({ runtime }: { runtime: ConversationRuntime }) {
  if (runtime === 'active-externally') {
    return <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Radio aria-hidden className="size-3" />Working elsewhere</span>;
  }
  if (runtime === 'waiting-for-user') {
    return <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><CirclePause aria-hidden className="size-3" />Waiting for you</span>;
  }
  if (runtime === 'unknown') {
    return <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><CircleHelp aria-hidden className="size-3" />Status unknown</span>;
  }
  if (runtime === 'failed') {
    return <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-destructive"><CircleAlert aria-hidden className="size-3" />Failed</span>;
  }
  return null;
}

export default function NavMain({
  groups,
  selected,
  onSelect,
}: {
  groups: ProjectConversationGroup[];
  selected: ConversationRef | null;
  onSelect: (item: NavSelection) => void;
}) {
  const { state } = useSidebar();
  const [openProjects, setOpenProjects] = useState<Set<string>>(() =>
    new Set(selected ? [selected.projectPath] : [])
  );
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
        const isSelectedProject = selected?.projectPath === group.projectPath;

        return (
          <SidebarMenuItem data-testid="project-group" key={group.projectPath}>
            <Collapsible
              className="w-full"
              onOpenChange={(open) => setOpenProjects((previous) => {
                const next = new Set(previous);
                if (open) next.add(group.projectPath);
                else next.delete(group.projectPath);
                return next;
              })}
              open={isOpen}
            >
              <CollapsibleTrigger asChild>
                <SidebarMenuButton isActive={isSelectedProject} type="button">
                  {isOpen ? <FolderOpen /> : <Folder />}
                  <span>{group.displayName}</span>
                </SidebarMenuButton>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarMenuSub className="my-1 ml-3.5">
                  {group.conversations.map((conversation) => {
                    const isSelected = selected !== null && conversationKey(selected) === conversationKey(conversation.ref);
                    return (
                      <SidebarMenuSubItem className="h-auto" key={conversationKey(conversation.ref)}>
                        <SidebarMenuSubButton asChild isActive={isSelected}>
                          <button
                            className="flex w-full items-center rounded-md px-4 py-1.5 text-left font-normal text-muted-foreground text-sm hover:bg-sidebar-accent hover:text-foreground"
                            aria-current={isSelected ? 'page' : undefined}
                            onClick={() => onSelect({
                              ref: conversation.ref,
                              title: conversation.title,
                              section: group.displayName,
                            })}
                            type="button"
                          >
                            <span aria-label={`${providerName(conversation.ref.provider)} conversation`} className="mr-2 shrink-0 text-xs" role="img">
                              {conversation.ref.provider === 'claude' ? 'CC' : 'CX'}
                            </span>
                            <span className="min-w-0 truncate">{conversation.title}</span>
                            <RuntimeMark runtime={conversation.runtime} />
                          </button>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    );
                  })}
                </SidebarMenuSub>
              </CollapsibleContent>
            </Collapsible>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}
