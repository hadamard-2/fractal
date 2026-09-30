'use client';

import { PointerActivationConstraints, PointerSensor } from '@dnd-kit/dom';
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react';
import { isSortable, useSortable, type UseSortableInput } from '@dnd-kit/react/sortable';
import { Archive, ArchiveRestore, Folder, FolderOpen, FolderX, Pencil } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
import { conversationKey, type ConversationRef, type ConversationRuntime, type ConversationSummary, type HarnessStatus, type ProjectConversationGroup } from '@/shared/conversation-contract';
import { MAX_CONVERSATION_TITLE_LENGTH } from '@/shared/conversation-ipc';
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

// A turn in flight may be writing the chat's history, so renaming waits for it.
const BUSY_RUNTIMES: ReadonlySet<ConversationRuntime> = new Set(['active-in-fractal', 'active-externally', 'waiting-for-user']);

function canRename(conversation: ConversationSummary, providers: HarnessStatus[]) {
  return conversation.parentId === undefined
    && !BUSY_RUNTIMES.has(conversation.runtime)
    && providers.some((status) => status.provider === conversation.ref.provider && status.availability === 'available');
}

/** Inline title field for a chat row. Enter saves; Escape or leaving the field cancels. */
function ChatTitleEditor({ title, onSave, onDone }: { title: string; onSave: (title: string) => Promise<void>; onDone: () => void }) {
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  useEffect(() => { inputRef.current?.select(); }, []);

  const commit = async () => {
    const next = value.trim();
    if (!next || next === title) { onDone(); return; }
    setSaving(true);
    setFailed(false);
    try {
      await onSave(next);
      onDone();
    } catch {
      // Keep the field open with what was typed, so a retry is one Enter away.
      setFailed(true);
      setSaving(false);
    }
  };

  return (
    <div>
      <input
        aria-describedby={failed ? errorId : undefined}
        aria-invalid={failed || undefined}
        aria-label="Chat name"
        autoFocus
        className={cn('h-7 w-full rounded-md bg-sidebar-accent px-4 text-foreground text-sm outline-none ring-1 ring-sidebar-ring', failed && 'ring-destructive')}
        disabled={saving}
        maxLength={MAX_CONVERSATION_TITLE_LENGTH}
        onBlur={() => { if (!saving) onDone(); }}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Keep typing inside the field: no row activation, drag, or app shortcut sees it.
          event.stopPropagation();
          if (event.key === 'Enter') { event.preventDefault(); void commit(); }
          else if (event.key === 'Escape') { event.preventDefault(); onDone(); }
        }}
        ref={inputRef}
        value={value}
      />
      {failed && <p className="px-4 pt-1 text-destructive text-xs" id={errorId} role="alert">Couldn't rename. Press Enter to retry.</p>}
    </div>
  );
}

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
  onRenameChat,
  showAgentColorTags = true,
}: {
  groups: ProjectConversationGroup[];
  providers: HarnessStatus[];
  selected: ConversationRef | null;
  onSelect: (item: NavSelection) => void;
  onCreated: (ref: ConversationRef) => void;
  onMoveProject?: (source: string, target: string) => void;
  onMoveChat?: (projectPath: string, source: string, target: string) => void;
  projectMenu?: ProjectMenuActions;
  // Renames a chat in its agent's history and refreshes; rejects to keep the
  // editor open. Absent, chat rows have no right-click menu.
  onRenameChat?: (ref: ConversationRef, title: string) => Promise<void>;
  // Off hides the dot only; the row's accessible name still carries the agent.
  showAgentColorTags?: boolean;
}) {
  const { state } = useSidebar();
  const [openProjects, setOpenProjects] = useState<Set<string>>(() =>
    new Set(selected ? [selected.projectPath] : [])
  );
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  // The row whose right-click menu is open, highlighted like a hover. Tracked
  // here because a project row's data-state belongs to its Collapsible.
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const [editingChat, setEditingChat] = useState<string | null>(null);
  // Set when Rename is picked, so the closing menu doesn't pull focus back
  // to the row and blur the field that just opened.
  const renamePicked = useRef(false);
  const trackMenu = (row: string) => (open: boolean) => setMenuRow((current) => open ? row : current === row ? null : current);
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
              <ContextMenu onOpenChange={trackMenu(`project:${group.projectPath}`)}>
              <ContextMenuTrigger asChild disabled={!projectMenu}>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton
                  className={cn('pr-20 transition-[width,height,padding,background-color,box-shadow,scale] duration-150 ease-out motion-reduce:transition-none', onMoveProject && !isOpen && 'touch-none', (isDragging || isDropTarget) && 'bg-sidebar-accent shadow-lg ring-1 ring-sidebar-ring', isDragging && 'scale-[1.02]', menuRow === `project:${group.projectPath}` && 'bg-sidebar-accent text-sidebar-accent-foreground')}
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
                    const isEditing = editingChat === chatId;
                    return (
                      <SortableRow disabled={!onMoveChat || isEditing} group={`chat:${group.projectPath}`} id={`chat:${group.projectPath}:${chatId}`} index={chatIndex} key={chatId}>
                      {({ ref: chatRef, handleRef: chatHandleRef, isDragging: isChatDragging, isDropTarget: isChatDropTarget }) => (
                      <SidebarMenuSubItem
                        className={cn('h-auto', isChatDragging && 'z-20')}
                        ref={chatRef}
                      >
                        {isEditing && onRenameChat ? (
                          <ChatTitleEditor
                            onDone={() => setEditingChat(null)}
                            onSave={(title) => onRenameChat(conversation.ref, title)}
                            title={conversation.title}
                          />
                        ) : (
                        <ContextMenu onOpenChange={trackMenu(`chat:${chatId}`)}>
                        <ContextMenuTrigger asChild disabled={!onRenameChat}>
                        <SidebarMenuSubButton asChild isActive={isSelected}>
                          <button
                            className={cn('flex w-full items-center rounded-md py-1.5 pr-2.5 pl-4 text-left font-normal text-muted-foreground text-sm transition-[background-color,box-shadow,scale] duration-150 ease-out hover:bg-sidebar-accent hover:text-foreground motion-reduce:transition-none', onMoveChat && 'touch-none', (isChatDragging || isChatDropTarget) && 'bg-sidebar-accent shadow-lg ring-1 ring-sidebar-ring', isChatDragging && 'scale-[1.02]', menuRow === `chat:${chatId}` && 'bg-sidebar-accent text-foreground')}
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
                            {showAgentColorTags && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${conversation.ref.provider === 'claude' ? 'bg-[#D97757]' : 'bg-[#3941FF]'}`} />
                                </TooltipTrigger>
                                <TooltipContent side="right">{providerName(conversation.ref.provider)}</TooltipContent>
                              </Tooltip>
                            )}
                          </button>
                        </SidebarMenuSubButton>
                        </ContextMenuTrigger>
                        <ContextMenuContent
                          className="min-w-44"
                          onCloseAutoFocus={(event) => {
                            if (renamePicked.current) event.preventDefault();
                            renamePicked.current = false;
                          }}
                        >
                          <ContextMenuItem
                            disabled={!canRename(conversation, providers)}
                            onSelect={() => { renamePicked.current = true; setEditingChat(chatId); }}
                          >
                            <Pencil />Rename
                          </ContextMenuItem>
                        </ContextMenuContent>
                        </ContextMenu>
                        )}
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
