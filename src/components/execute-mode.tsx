import { useEffect, useState, type CSSProperties, type Ref } from 'react';
import { Blocks } from 'lucide-react';
import { ConversationPanel } from '@/components/conversation-panel';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { useConversationHistory } from '@/renderer/use-conversation-history';
import { DashboardSidebar } from '@/components/sidebar-03/app-sidebar';
import { providerName, runtimeLabel, type NavSelection } from '@/components/sidebar-03/nav-main';
import { conversationKey, type ConversationRef } from '@/shared/conversation-contract';
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

/**
 * Execute mode's shell: the blocks-so sidebar-03 sidebar. It stays mounted
 * while another mode is visible so native history and the selected session
 * remain loaded when the user returns.
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
export function ExecuteMode({
  active = true,
  sidebarOpen,
  onSidebarOpenChange,
  sidebarWidth,
  onSidebarWidthChange,
  onOpenSettings,
  insetRef,
  onProjectPathChange,
}: {
  active?: boolean;
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
}) {
  const [selectedRef, setSelectedRef] = useState<ConversationRef | null>(null);
  const { projects, providers, loading, error } = useConversationHistory();
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
          display: active ? undefined : 'none',
        } as CSSProperties
      }
    >
      <DashboardSidebar
        onCollapse={() => onSidebarOpenChange?.(false)}
        onConversationCreated={(ref) => {
          setSelectedRef(ref);
          setSelectedItem(null);
        }}
        onOpenSettings={onOpenSettings}
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
          {selectedItem && (
            <>
              <SidebarTrigger className="-ml-1" />
              <Separator
                orientation="vertical"
                className="mr-2 data-[orientation=vertical]:h-4"
              />
              <Breadcrumb className="min-w-0">
                <BreadcrumbList className="min-w-0 flex-nowrap">
                  {selectedItem.section && (
                    <>
                      <BreadcrumbItem>{selectedItem.section}</BreadcrumbItem>
                      <BreadcrumbSeparator />
                    </>
                  )}
                  <BreadcrumbItem className="min-w-0">
                    <BreadcrumbPage className="min-w-0 truncate font-medium">
                      {selectedItem.title}
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
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {selectedRef ? (
            <ConversationPanel conversationRef={selectedRef} />
          ) : (
            /*
              No conversation yet. The mark is the same Blocks glyph the
              sidebar's wordmark uses — a quiet centrepiece rather than a
              call to action; starting one lives on a project's plus action.
            */
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
              <ConversationEmptyState className="h-auto" icon={<Blocks aria-hidden className="size-10 text-muted-foreground/50" />} title="Select a conversation" description="Open native conversation history from the sidebar to read the transcript and see its session status." />
              {loading && <p className="text-sm text-muted-foreground" role="status">Loading conversation history…</p>}
              {error && <p className="px-4 text-sm text-muted-foreground" role="status">Conversation history could not be loaded: {error.message}</p>}
              {providers.filter((provider) => provider.availability !== 'available').map((provider) => <p className="max-w-xl px-4 py-1 text-sm text-muted-foreground" key={provider.provider} role="status">{provider.provider}: {provider.availability}.{provider.message ? ` ${provider.message}` : ''}</p>)}
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
