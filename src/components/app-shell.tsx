import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { useConversationHistory, type ConversationHistory } from '@/renderer/use-conversation-history';
import { DashboardSidebar } from '@/components/sidebar-03/app-sidebar';
import { providerName, runtimeLabel, type NavSelection } from '@/components/sidebar-03/nav-main';
import { conversationKey, type ConversationRef } from '@/shared/conversation-contract';
import { ProjectPickerDialog } from '@/components/conversation/project-picker-dialog';
import { useStartConversation } from '@/components/conversation/use-start-conversation';
import { isAppShortcut } from '@/renderer/shortcuts';
import { visibleProjects } from '@/renderer/project-visibility';
import { useProjectVisibility } from '@/renderer/use-project-visibility';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Separator } from '@/components/ui/separator';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';

/** The shell's app-wide actions, bound to Mod+N, Mod+K, and Mod+O. */
export type ShellActions = {
  newConversation: () => void;
  search: () => void;
  addProject: () => void;
  // False when no available agent can create a conversation.
  canStart: boolean;
};

/** What the shell hands the modes it frames. */
export type ShellContext = {
  selectedRef: ConversationRef | null;
  history: ConversationHistory;
  actions: ShellActions;
};

/**
 * The app shell every mode renders inside: the blocks-so sidebar-03 sidebar,
 * its toggle, and the header row with the selection's breadcrumb. Selection
 * lives here because it is shared across modes; the modes themselves are
 * `children`, given the selection and loaded history.
 *
 * The sidebar sits *below* the title bar rather than running to the top edge.
 * That needs an override: `Sidebar`'s desktop container is `position: fixed`
 * with `inset-y-0 h-svh`, so it escapes the padding App applies to make room
 * for the title bar and would otherwise slide underneath it. Re-anchoring the
 * top and shortening the height by the same amount puts it back in the flow
 * visually. These go through `style` rather than `className` on purpose: a
 * `top-*` class would not displace the container's own `inset-y-0`, leaving two
 * equal-specificity `top` rules whose winner depends on stylesheet order.
 */
export function AppShell({
  sidebarOpen,
  onSidebarOpenChange,
  sidebarWidth,
  onSidebarWidthChange,
  onOpenSettings,
  insetRef,
  onProjectPathChange,
  showAgentColorTags,
  children,
}: {
  // Controlled by App so the open/collapsed state remains stable.
  sidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
  // Same outlives-the-mode treatment for the chosen width. Null = default.
  sidebarWidth?: number | null;
  onSidebarWidthChange?: (width: number | null) => void;
  onOpenSettings: () => void;
  // Attached to the content beside the left sidebar, so the app-level right
  // panel can tell where the space beside that sidebar begins.
  insetRef?: Ref<HTMLElement>;
  // The selected conversation's project, where new terminals start.
  onProjectPathChange?: (path: string | null) => void;
  // The agent-color-tags setting, held by App beside the settings dialog.
  showAgentColorTags?: boolean;
  children: (context: ShellContext) => ReactNode;
}) {
  const [selectedRef, setSelectedRef] = useState<ConversationRef | null>(null);
  const history = useConversationHistory();
  const { projects } = history;
  // Selection lives here, not in the sidebar: the header below shows the
  // picked item's title, and only this component renders both.
  const [selectedItem, setSelectedItem] = useState<NavSelection | null>(null);
  /*
    True while the resize handle is being dragged. Hung on the provider as a
    data attribute so index.css can suspend the width transitions on the
    sidebar's gap and container — without that, the panel trails the cursor
    by the length of its own transition.
  */
  const [resizing, setResizing] = useState(false);
  // Lifted out of the sidebar so Mod+K and the empty state can open it.
  const [searchOpen, setSearchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const projectVisibility = useProjectVisibility();
  // Every conversation Fractal starts makes its folder active again: that is
  // how an archived project is unarchived by use, and how a removed one comes
  // back when it is re-added through New project.
  const selectCreated = (ref: ConversationRef) => {
    projectVisibility.setStatus(ref.projectPath, 'active');
    setSelectedRef(ref);
    setSelectedItem(null);
  };
  const removeProject = (projectPath: string) => {
    projectVisibility.setStatus(projectPath, 'removed');
    if (selectedRef?.projectPath === projectPath) {
      setSelectedRef(null);
      setSelectedItem(null);
    }
  };
  const starter = useStartConversation({ providers: history.providers, onCreated: selectCreated });
  const selectedProject = selectedRef && projects.find((project) => project.projectPath === selectedRef.projectPath);
  const actions: ShellActions = {
    // With a conversation open, its project is the obvious place for the next
    // one; with nothing selected, ask.
    newConversation: () => {
      if (!starter.canStart) return;
      if (selectedRef) void starter.start({ name: selectedProject?.displayName ?? selectedRef.projectPath, path: selectedRef.projectPath });
      else setPickerOpen(true);
    },
    search: () => setSearchOpen(true),
    // A project exists here only through its conversations, so adding one is
    // starting a conversation in a folder the main process asks for.
    addProject: () => void starter.start(null),
    canStart: starter.canStart,
  };
  // Read by the listener below, which subscribes once.
  const actionsRef = useRef(actions);
  actionsRef.current = actions;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const action =
        isAppShortcut(event, 'KeyN') ? actionsRef.current.newConversation
        : isAppShortcut(event, 'KeyK') ? actionsRef.current.search
        : isAppShortcut(event, 'KeyO') ? actionsRef.current.addProject
        : null;
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  const currentSummary = selectedRef && projects
    .flatMap((project) => project.conversations)
    .find((conversation) => conversationKey(conversation.ref) === conversationKey(selectedRef));
  const selectedRuntime = currentSummary?.runtime ?? selectedItem?.runtime;

  useEffect(() => {
    onProjectPathChange?.(selectedRef?.projectPath ?? null);
  }, [selectedRef?.projectPath, onProjectPathChange]);

  return (
    <SidebarProvider
      className="h-full min-h-0 overflow-hidden"
      data-sidebar-resizing={resizing || undefined}
      open={sidebarOpen}
      onOpenChange={onSidebarOpenChange}
      style={
        {
          ...(sidebarWidth ? { '--sidebar-width': `${sidebarWidth}px` } : {}),
        } as CSSProperties
      }
    >
      <DashboardSidebar
        onCollapse={() => onSidebarOpenChange?.(false)}
        onConversationCreated={selectCreated}
        onNewProject={actions.addProject}
        onOpenSettings={onOpenSettings}
        onRemoveProject={removeProject}
        onConversationRenamed={history.refresh}
        onSearchOpenChange={setSearchOpen}
        projectVisibility={projectVisibility}
        showAgentColorTags={showAgentColorTags}
        onResizingChange={setResizing}
        onWidthChange={onSidebarWidthChange}
        onItemSelect={(item) => {
          setSelectedRef((previous) =>
            previous && conversationKey(previous) === conversationKey(item.ref)
              ? previous
              : item.ref
          );
          setSelectedItem(item);
        }}
        searchOpen={searchOpen}
        selected={selectedRef}
        style={{
          top: 'var(--titlebar-height)',
          height: 'calc(100svh - var(--titlebar-height))',
        }}
        width={sidebarWidth}
      />
      <SidebarInset className="min-h-0 overflow-hidden" ref={insetRef}>
        {/*
          The row's height comes from `--app-bar-height`, the same token App's
          corner strip uses, so the mode and panel toggles float over this
          row's right-hand side already on its baseline. `--app-bar-reserve`,
          set by the right panel, is how much of that side they cover; the
          title ellipsizes before it. index.css animates the padding on the
          toggles' curve so the two never meet mid-slide.
        */}
        <header
          className="flex shrink-0 items-center gap-2 pl-4"
          data-slot="app-bar-reserve"
          style={{
            height: 'var(--app-bar-height)',
            marginTop: 'var(--app-bar-offset)',
            paddingRight: 'var(--app-bar-reserve, 1rem)',
          }}
        >
          {/*
            The picked chat as a breadcrumb: its project as the muted
            ancestor, the chat itself as the current page. Projects are pure
            folders (never selectable), so a selection always arrives with a
            section — but standalone leaves without one render fine too,
            just pageless of an ancestor. The sidebar trigger belongs to this
            navigation context, so it appears with the breadcrumb rather than
            alone in an otherwise empty app bar.
          */}
          <SidebarTrigger className="-ml-1" />
          {selectedItem && (
            <>
              <Separator
                orientation="vertical"
                className="mr-2 data-[orientation=vertical]:h-4"
              />
              <Breadcrumb className="min-w-0">
                <BreadcrumbList className="min-w-0 flex-nowrap">
                  {selectedItem.section && (
                    <>
                      <BreadcrumbItem className="shrink-0 whitespace-nowrap">{selectedItem.section}</BreadcrumbItem>
                      <BreadcrumbSeparator />
                    </>
                  )}
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="min-w-0 truncate font-medium">
                      {currentSummary?.title ?? selectedItem.title}
                    </BreadcrumbPage>
                    {selectedRuntime && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        ({providerName(selectedItem.ref.provider)} · {runtimeLabel(selectedRuntime)})
                      </span>
                    )}
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
            </>
          )}
          {starter.status && <span className="ml-auto shrink-0 text-xs text-muted-foreground" role="status">{starter.status}</span>}
        </header>
        {children({ selectedRef, history, actions })}
      </SidebarInset>
      <ProjectPickerDialog onOpenChange={setPickerOpen} onPick={(target) => void starter.start(target)} open={pickerOpen} projects={visibleProjects(projects, projectVisibility.visibility, 'startable')} />
      {starter.chooser}
    </SidebarProvider>
  );
}
