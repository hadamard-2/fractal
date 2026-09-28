'use client';

import { PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react';
import { isSortable, useSortable, type UseSortableInput } from '@dnd-kit/react/sortable';
import { Archive, ArchiveRestore, Folder, FolderOpen, FolderX } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
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
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { conversationKey, type ConversationRef, type ConversationRuntime, type HarnessStatus, type ProjectConversationGroup } from '@/shared/conversation-contract';
import { NewConversationMenu } from '@/components/conversation/new-conversation-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import type { ProjectStatus } from '@/renderer/project-visibility';
import { cn } from '@/lib/utils';

/** The right-click actions on a project row. */
export type ProjectMenuActions = {
  statusOf: (projectPath: string) => ProjectStatus;
  onToggleArchive: (projectPath: string) => void;
  onRemove: (group: ProjectConversationGroup) => void;
};

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

const sortableTransition = {
  duration: 190,
  easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
  idle: true,
};

function SortableRow({
  id,
  index,
  group,
  disabled,
  children,
}: {
  id: string;
  index: number;
  group: string;
  disabled: UseSortableInput['disabled'];
  children: (sortable: ReturnType<typeof useSortable>) => ReactNode;
}) {
  const sortable = useSortable({ id, index, group, type: group, accept: group, disabled, transition: sortableTransition });
  return children(sortable);
}

export function sidebarMoveAtIndices(groups: ProjectConversationGroup[], groupId: string, fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return null;
  if (groupId === 'projects') {
    const from = groups[fromIndex];
    const to = groups[toIndex];
    return from && to ? { kind: 'project' as const, source: from.projectPath, target: to.projectPath } : null;
  }

  const group = groups.find((item) => `chat:${item.projectPath}` === groupId);
  const from = group?.conversations[fromIndex];
  const to = group?.conversations[toIndex];
  return group && from && to
    ? { kind: 'chat' as const, projectPath: group.projectPath, source: conversationKey(from.ref), target: conversationKey(to.ref) }
    : null;
}

export default function NavMain({
  groups,
  providers,
  selected,
  onSelect,
  onCreated,
  onMoveProject,
  onMoveChat,
  projectMenu,
}: {
  groups: ProjectConversationGroup[];
  providers: HarnessStatus[];
  selected: ConversationRef | null;
  onSelect: (item: NavSelection) => void;
  onCreated: (ref: ConversationRef) => void;
  onMoveProject?: (source: string, target: string) => void;
  onMoveChat?: (projectPath: string, source: string, target: string) => void;
  projectMenu?: ProjectMenuActions;
}) {
  const { state } = useSidebar();
  const [openProjects, setOpenProjects] = useState<Set<string>>(() =>
    new Set(selected ? [selected.projectPath] : [])
  );
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const isCollapsed = state === 'collapsed';

  const handleDragEnd = ({ canceled, operation }: DragEndEvent) => {
    const source = operation.source;
    if (canceled || !isSortable(source) || source.initialGroup !== source.group || source.initialIndex === source.index) return;
    const move = sidebarMoveAtIndices(groups, String(source.group), source.initialIndex, source.index);
    if (move?.kind === 'project') onMoveProject?.(move.source, move.target);
    if (move?.kind === 'chat') onMoveChat?.(move.projectPath, move.source, move.target);
  };

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
    <DragDropProvider
      onDragEnd={handleDragEnd}
      sensors={(defaults) => [
        ...defaults.filter((sensor) => sensor !== PointerSensor),
        PointerSensor.configure({
          activationConstraints: (event) => event.pointerType === 'touch'
            ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
            : [new PointerActivationConstraints.Distance({ value: 5 })],
        }),
      ]}
    >
    <SidebarMenu>
      {groups.map((group, projectIndex) => {
        const isOpen = openProjects.has(group.projectPath);
        const showAll = expandedProjects.has(group.projectPath);
        const visibleConversations = showAll ? group.conversations : group.conversations.slice(0, 5);

        return (
          <SortableRow disabled={!onMoveProject || (isOpen && { draggable: true })} group="projects" id={`project:${group.projectPath}`} index={projectIndex} key={group.projectPath}>
          {({ ref, handleRef, isDragging, isDropTarget }) => (
          <SidebarMenuItem
            data-testid="project-group"
            ref={ref}
            className={cn(isDragging && 'z-20')}
          >
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
              <ContextMenu>
              <ContextMenuTrigger asChild disabled={!projectMenu}>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton
                  className={cn('pr-20 transition-[width,height,padding,background-color,box-shadow,scale] duration-150 ease-out motion-reduce:transition-none', onMoveProject && !isOpen && 'touch-none', (isDragging || isDropTarget) && 'bg-sidebar-accent shadow-lg ring-1 ring-sidebar-ring', isDragging && 'scale-[1.02]')}
                  ref={onMoveProject && !isOpen ? handleRef : undefined}
                  type="button"
                >
                  {isOpen ? <FolderOpen /> : <Folder />}
                  <span>{group.displayName}</span>
                </SidebarMenuButton>
              </CollapsibleTrigger>
              </ContextMenuTrigger>
              {projectMenu && (
                <ContextMenuContent className="min-w-44">
                  <ContextMenuItem onSelect={() => projectMenu.onToggleArchive(group.projectPath)}>
                    {projectMenu.statusOf(group.projectPath) === 'archived'
                      ? <><ArchiveRestore />Unarchive project</>
                      : <><Archive />Archive project</>}
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem onSelect={() => projectMenu.onRemove(group)} variant="destructive">
                    <FolderX />Remove project…
                  </ContextMenuItem>
                </ContextMenuContent>
              )}
              </ContextMenu>
              <CollapsibleContent>
                <SidebarMenuSub className="my-1 ml-3.5 mr-0 pr-0">
                  {visibleConversations.map((conversation, chatIndex) => {
                    const isSelected = selected !== null && conversationKey(selected) === conversationKey(conversation.ref);
                    const chatId = conversationKey(conversation.ref);
                    return (
                      <SortableRow disabled={!onMoveChat} group={`chat:${group.projectPath}`} id={`chat:${group.projectPath}:${chatId}`} index={chatIndex} key={chatId}>
                      {({ ref: chatRef, handleRef: chatHandleRef, isDragging: isChatDragging, isDropTarget: isChatDropTarget }) => (
                      <SidebarMenuSubItem
                        className={cn('h-auto', isChatDragging && 'z-20')}
                        ref={chatRef}
                      >
                        <SidebarMenuSubButton asChild isActive={isSelected}>
                          <button
                            className={cn('flex w-full items-center rounded-md py-1.5 pr-2.5 pl-4 text-left font-normal text-muted-foreground text-sm transition-[background-color,box-shadow,scale] duration-150 ease-out hover:bg-sidebar-accent hover:text-foreground motion-reduce:transition-none', onMoveChat && 'touch-none', (isChatDragging || isChatDropTarget) && 'bg-sidebar-accent shadow-lg ring-1 ring-sidebar-ring', isChatDragging && 'scale-[1.02]')}
                            aria-label={[conversation.title, `${providerName(conversation.ref.provider)} conversation`, runtimeLabel(conversation.runtime)].filter(Boolean).join(', ')}
                            aria-current={isSelected ? 'page' : undefined}
                            ref={chatHandleRef}
                            onClick={() => onSelect({
                              ref: conversation.ref,
                              title: conversation.title,
                              section: group.displayName,
                              runtime: conversation.runtime,
                            })}
                            type="button"
                          >
                            <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${conversation.ref.provider === 'claude' ? 'bg-[#D97757]' : 'bg-[#3941FF]'}`} />
                              </TooltipTrigger>
                              <TooltipContent side="right">{providerName(conversation.ref.provider)}</TooltipContent>
                            </Tooltip>
                          </button>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                      )}
                      </SortableRow>
                    );
                  })}
                  {!showAll && group.conversations.length > 5 && (
                    <SidebarMenuSubItem>
                      <SidebarMenuSubButton asChild className="hover:bg-transparent">
                        <button
                          className="w-full px-4 py-1.5 text-left text-sidebar-foreground/55 text-sm hover:text-sidebar-foreground focus-visible:text-sidebar-foreground"
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
            {/* A disabled sortable handle gets aria-disabled, which blocks clicks on SidebarMenuButton. */}
            {(!onMoveProject || isOpen) && <span aria-hidden="true" className="hidden" ref={handleRef} />}
            <NewConversationMenu
              onCreated={onCreated}
              projectName={group.displayName}
              projectPath={group.projectPath}
              providers={providers}
            />
          </SidebarMenuItem>
          )}
          </SortableRow>
        );
      })}
    </SidebarMenu>
    </DragDropProvider>
  );
}
