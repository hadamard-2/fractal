'use client';

import { motion } from 'motion/react';
import { FolderPlus, Funnel, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavSettings } from '@/components/nav-settings';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';
import { FractalMark } from '@/components/fractal-mark';
import { AGENT_DOT_CLASS, providerName, type NavSelection } from '@/components/sidebar-03/nav-main';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { visibleProjects, withoutAgents } from '@/renderer/project-visibility';
import type { ProjectVisibilityState } from '@/renderer/use-project-visibility';
import type { ProjectFilter } from '@/shared/settings-contract';
import NavMain from '@/components/sidebar-03/nav-main';
import { useConversationHistory } from '@/renderer/use-conversation-history';
import type { ConversationRef, ProjectConversationGroup, ProviderId } from '@/shared/conversation-contract';
import { SearchDialog } from '@/components/conversation/search-dialog';
import { useSidebarOrder } from '@/components/sidebar-03/use-sidebar-order';

/*
 * Widths for the drag-to-resize handle, in px. The sidebar's own geometry is
 * CSS-var driven (`--sidebar-width`, 18.4rem default), so a chosen size is
 * injected as a pixel value and every consumer — gap, fixed container, inset
 * margin — follows.
 */
const SIDEBAR_DEFAULT_WIDTH = 294.4;
const SIDEBAR_MAX_WIDTH = 480;
// Released narrower than this, the drag ends in a collapse instead of a size.
const SIDEBAR_COLLAPSE_BELOW = 200;
// Hard floor while actively dragging so the panel stays visible and grabbable.
const SIDEBAR_DRAG_FLOOR = 120;

const clampSidebarWidth = (width: number) =>
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_DRAG_FLOOR, width));

// Varied so the placeholder reads as a list of names rather than a grid.
const PLACEHOLDER_WIDTHS = ['w-32', 'w-24', 'w-40', 'w-28', 'w-20'];

const FILTER_LABELS: Record<ProjectFilter, string> = { active: 'Active', archived: 'Archived', all: 'All' };
const EMPTY_FILTER_TEXT: Partial<Record<ProjectFilter, string>> = { active: 'No active projects.', archived: 'No archived projects.' };
// Same order as the settings dialog's agent list.
const FILTER_AGENTS: readonly ProviderId[] = ['claude', 'codex'];

/** The filter button's accessible name: the status, plus which agents show when some are hidden. */
function filterSummary(filter: ProjectFilter, hiddenAgents: readonly ProviderId[]): string {
  if (hiddenAgents.length === 0) return FILTER_LABELS[filter];
  const shown = FILTER_AGENTS.filter((agent) => !hiddenAgents.includes(agent));
  return `${FILTER_LABELS[filter]}, ${shown.length === 0 ? 'no agents' : `${shown.map(providerName).join(' and ')} only`}`;
}

/**
 * A grab strip on the sidebar's right edge. Lives inside the fixed sidebar
 * container (its nearest positioned ancestor), so it tracks that container's
 * true right side — including the floating variant's outer padding gutter.
 *
 * While dragging it reports sizes upward live and flags resizing via
 * `onResizingChange`; ExecuteMode hangs a data attribute off the provider
 * from that flag to suspend the width transitions, which would otherwise
 * lag 200ms behind the cursor.
 */
function SidebarResizeHandle({
  width,
  onWidthChange,
  onCollapse,
  onResizingChange,
}: {
  width?: number | null;
  onWidthChange?: (width: number | null) => void;
  onCollapse?: () => void;
  onResizingChange?: (resizing: boolean) => void;
}) {
  const { state, isMobile, setOpen } = useSidebar();
  // Set on pointerdown, read on move/up; also the "is a drag active" marker.
  const dragOrigin = useRef<{ x: number; width: number } | null>(null);

  // The mobile sidebar is a sheet, so its edge is not a meaningful resize
  // target. The collapsed desktop rail keeps the handle: starting a resize
  // from it expands the rail before applying the drag delta below.
  if (isMobile) return null;

  const currentWidth = width ?? SIDEBAR_DEFAULT_WIDTH;
  const isCollapsed = state === 'collapsed';

  return (
    <div
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize touch-none select-none"
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          if (isCollapsed) setOpen(true);
          onWidthChange?.(clampSidebarWidth(currentWidth - 16));
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          if (isCollapsed) setOpen(true);
          onWidthChange?.(clampSidebarWidth(currentWidth + 16));
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const container = event.currentTarget.closest(
          '[data-slot="sidebar-container"]'
        );
        // The icon rail's bounding box is intentionally narrow. Its stored
        // expanded width, rather than that box, is the stable baseline for a
        // drag that begins from the collapsed state.
        const originWidth = isCollapsed
          ? currentWidth
          : (container?.getBoundingClientRect().width ?? SIDEBAR_DEFAULT_WIDTH);
        dragOrigin.current = {
          x: event.clientX,
          width: originWidth,
        };
        if (isCollapsed) setOpen(true);
        // Keep move/up events flowing to this element even when the cursor
        // leaves the strip.
        event.currentTarget.setPointerCapture(event.pointerId);
        onResizingChange?.(true);
      }}
      onPointerMove={(event) => {
        const origin = dragOrigin.current;
        if (!origin) return;
        onWidthChange?.(
          clampSidebarWidth(origin.width + event.clientX - origin.x)
        );
      }}
      onPointerUp={(event) => {
        const origin = dragOrigin.current;
        if (!origin) return;
        dragOrigin.current = null;
        onResizingChange?.(false);
        const finalWidth = origin.width + event.clientX - origin.x;
        // Below the threshold the drag ends in a collapse, and the stored
        // size is cleared rather than kept: the live-dragged value down here
        // is the too-small width that caused the collapse, and re-expanding
        // should land on the default, not on that.
        if (finalWidth < SIDEBAR_COLLAPSE_BELOW) {
          onWidthChange?.(null);
          onCollapse?.();
        } else {
          onWidthChange?.(clampSidebarWidth(finalWidth));
        }
      }}
      role="separator"
      tabIndex={0}
    />
  );
}

export function DashboardSidebar({
  onOpenSettings,
  selected,
  onItemSelect,
  onConversationCreated,
  onNewProject,
  searchOpen = false,
  onSearchOpenChange,
  projectVisibility,
  onRemoveProject,
  onConversationRenamed,
  refreshSignal = 0,
  showAgentColorTags,
  width,
  onWidthChange,
  onResizingChange,
  onCollapse,
  className,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  // The one Fractal-specific wiring: the footer's entry point into the global
  // settings dialog, passed down from App via ExecuteMode.
  onOpenSettings: () => void;
  // Which nav item is currently picked, owned by ExecuteMode so the header
  // can show its title.
  selected?: ConversationRef | null;
  // Not named `onSelect`: that would collide with the native DOM prop the
  // `...props` spread hands to <Sidebar>.
  onItemSelect?: (item: NavSelection) => void;
  // Creates a conversation and switches this mode to it; ExecuteMode owns
  // the conversationId state.
  onConversationCreated?: (ref: ConversationRef) => void;
  // Starts a conversation in a folder the user picks; AppShell owns the flow.
  onNewProject?: () => void;
  // Owned by AppShell so its keyboard shortcut and the empty state can open it.
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  // Archived/removed projects and the status filter, owned by AppShell so
  // search and the new-conversation picker agree with the sidebar. Absent,
  // every project shows and the project menu is off.
  projectVisibility?: ProjectVisibilityState;
  // Hides a project after the user confirms; AppShell also closes its open
  // conversation.
  onRemoveProject?: (projectPath: string) => void;
  // Called after a chat rename lands, so AppShell can refresh its own copy of
  // the history (the header shows the selected chat's title from it).
  onConversationRenamed?: () => Promise<void>;
  // Changes when AppShell refreshes its history on request; the sidebar
  // refreshes its own copy to match.
  refreshSignal?: number;
  // Whether chat rows show their agent's color dot. Defaults to shown.
  showAgentColorTags?: boolean;
  // Chosen sidebar width in px, owned by App for the same reason as the
  // open/collapsed state. Null means the 16rem default.
  width?: number | null;
  onWidthChange?: (width: number | null) => void;
  onResizingChange?: (resizing: boolean) => void;
  onCollapse?: () => void;
}) {
  const { state } = useSidebar();
  const { projects, providers, loaded, error, refresh } = useConversationHistory();
  useEffect(() => {
    if (refreshSignal > 0) void refresh();
  }, [refreshSignal, refresh]);
  const renameChat = async (ref: ConversationRef, title: string) => {
    await window.fractal.conversations.rename(ref, title);
    await Promise.all([refresh(), onConversationRenamed?.()]);
  };
  const { orderedProjects, ready: orderReady, error: orderError, moveProject, moveChat } = useSidebarOrder(projects);
  const isCollapsed = state === 'collapsed';
  const [pendingRemoval, setPendingRemoval] = useState<ProjectConversationGroup | null>(null);
  const filter = projectVisibility?.filter ?? 'all';
  const hiddenAgents = projectVisibility?.hiddenAgents ?? [];
  const statusShownProjects = projectVisibility ? visibleProjects(orderedProjects, projectVisibility.visibility, filter) : orderedProjects;
  const shownProjects = withoutAgents(statusShownProjects, hiddenAgents);
  const searchableProjects = projectVisibility ? visibleProjects(orderedProjects, projectVisibility.visibility, 'searchable') : orderedProjects;
  const emptyFilterText = orderReady && projects.length > 0 && shownProjects.length === 0
    ? (statusShownProjects.length === 0 ? EMPTY_FILTER_TEXT[filter] : 'No chats from the selected agents.')
    : undefined;

  return (
    <Sidebar
      className={className}
      collapsible="icon"
      variant="floating"
      {...props}
    >
      <SidebarHeader
        className={cn(
          'flex md:pt-3.5',
          // Collapsed rail: keep the logo where the expanded header puts it —
          // that header's 14px top padding plus half its 36px row, less half
          // the logo's 20px height.
          //
          // Expanded: the header's own p-2 gives 8px, but the nav icons below
          // sit at 16px (SidebarContent px-2 + button px-2), so bump the
          // header to pl-4 to line the logo mark up with them.
          isCollapsed
            ? 'flex-row items-center justify-center gap-y-6 md:flex-col md:pt-[22px]'
            : 'flex-row items-center justify-between pl-4'
        )}
      >
        <a className="flex items-center gap-2" href="#">
          <FractalMark className="size-5" />
          <span
            className={cn(
              'font-semibold text-foreground',
              isCollapsed && 'hidden'
            )}
          >
            Fractal
          </span>
        </a>

        <motion.div
          animate={{ opacity: 1 }}
          className={cn(
            'flex items-center gap-2',
            isCollapsed ? 'flex-row md:flex-col-reverse' : 'flex-row'
          )}
          initial={{ opacity: 0 }}
          key={isCollapsed ? 'header-collapsed' : 'header-expanded'}
          transition={{ duration: 0.8 }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Search"
                className="rounded-full"
                onClick={() => onSearchOpenChange?.(true)}
                size="icon"
                variant="ghost"
              >
                <Search className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Search</TooltipContent>
          </Tooltip>
        </motion.div>
      </SidebarHeader>
      <SidebarContent className="gap-4 overflow-hidden px-2 py-4 group-data-[collapsible=icon]:pt-2.5">
        <SidebarMenu className="shrink-0">
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onNewProject} tooltip="New project">
              <FolderPlus />
              <span>New project</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        {/*
          px-0: the group's own p-2 would stack on SidebarContent's px-2 and
          push the item icons past the 16px inset the logo header matches.
        */}
        <SidebarGroup className="min-h-0 flex-1 px-0 py-0">
          <SidebarGroupLabel>Projects</SidebarGroupLabel>
          {projectVisibility && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    {/* Tinted away from the default view (Active, every agent), so a different list reads as filtered. */}
                    <SidebarGroupAction
                      aria-label={`Filter projects: ${filterSummary(filter, hiddenAgents)}`}
                      className={cn('top-1.5 right-2 text-sidebar-foreground/60', (filter !== 'active' || hiddenAgents.length > 0) && 'text-primary-text')}
                    >
                      <Funnel />
                    </SidebarGroupAction>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="right">Filter</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="start" className="min-w-36" side="right">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Status</DropdownMenuLabel>
                <DropdownMenuRadioGroup onValueChange={(value) => projectVisibility.setFilter(value as ProjectFilter)} value={filter}>
                  {(['active', 'archived', 'all'] as const).map((value) => (
                    <DropdownMenuRadioItem key={value} value={value}>{FILTER_LABELS[value]}</DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">Agent</DropdownMenuLabel>
                {FILTER_AGENTS.map((agent) => (
                  <DropdownMenuCheckboxItem
                    checked={!hiddenAgents.includes(agent)}
                    key={agent}
                    onCheckedChange={(checked) => projectVisibility.setAgentShown(agent, checked)}
                    // Stay open so several agents can be toggled in one visit.
                    onSelect={(event) => event.preventDefault()}
                  >
                    <span className="flex-1">{providerName(agent)}</span>
                    {showAgentColorTags !== false && <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', AGENT_DOT_CLASS[agent])} />}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <SidebarGroupContent className="sidebar-projects-fade min-h-0 w-[calc(100%+0.5rem)] flex-1 overflow-x-hidden overflow-y-auto pb-10 pr-1">
            {/*
              Placeholder rows until the first history list and the saved
              order are in. Later refreshes keep the real rows on screen.
            */}
            {!(loaded && orderReady) && (
              <div aria-label="Loading projects" className="space-y-1 group-data-[collapsible=icon]:hidden" role="status">
                {PLACEHOLDER_WIDTHS.map((width) => (
                  <div className="flex h-8 items-center gap-2 px-2" key={width}>
                    <Skeleton className="size-4 shrink-0 rounded-sm" />
                    <Skeleton className={cn('h-3', width)} />
                  </div>
                ))}
              </div>
            )}
            {orderReady && <NavMain
              onCreated={(ref) => onConversationCreated?.(ref)}
              onMoveChat={moveChat}
              onMoveProject={moveProject}
              onSelect={onItemSelect}
              groups={shownProjects}
              projectMenu={projectVisibility && {
                statusOf: projectVisibility.statusOf,
                onToggleArchive: (projectPath) => projectVisibility.setStatus(projectPath, projectVisibility.statusOf(projectPath) === 'archived' ? 'active' : 'archived'),
                onRemove: setPendingRemoval,
              }}
              providers={providers}
              selected={selected ?? null}
              onRenameChat={renameChat}
              showAgentColorTags={showAgentColorTags}
            />}
            {emptyFilterText && <p className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">{emptyFilterText}</p>}
            {projectVisibility?.error && <p className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden" role="status">Project status could not be loaded or saved.</p>}
            {orderError && <p className="px-2 py-1 text-xs text-muted-foreground" role="status">Sidebar order could not be loaded or saved.</p>}
            {error && projects.length === 0 && (
              <p className="px-2 py-1 text-muted-foreground text-xs">
                Could not load conversation history.
              </p>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-2 pt-1">
        <NavSettings onOpenSettings={onOpenSettings} />
      </SidebarFooter>
      <SidebarResizeHandle
        onCollapse={onCollapse}
        onResizingChange={onResizingChange}
        onWidthChange={onWidthChange}
        width={width}
      />
      <Dialog onOpenChange={(open) => { if (!open) setPendingRemoval(null); }} open={pendingRemoval !== null}>
        <DialogContent className="rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-2xl sm:max-w-md" overlayClassName="bg-black/45 backdrop-blur-sm">
          <DialogHeader>
            <DialogTitle>Remove {pendingRemoval?.displayName} from Fractal?</DialogTitle>
            <DialogDescription>
              Its Claude Code and Codex history stays on disk. To bring it back, start a conversation in that folder with New project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setPendingRemoval(null)} variant="outline">Cancel</Button>
            <Button
              onClick={() => {
                if (pendingRemoval) onRemoveProject?.(pendingRemoval.projectPath);
                setPendingRemoval(null);
              }}
              variant="destructive"
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <SearchDialog
        groups={searchableProjects}
        onOpenChange={(open) => onSearchOpenChange?.(open)}
        onSelect={(item) => onItemSelect?.(item)}
        open={searchOpen}
      />
    </Sidebar>
  );
}
