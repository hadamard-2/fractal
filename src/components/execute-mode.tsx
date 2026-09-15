import { useState, type CSSProperties } from 'react';
import { Blocks } from 'lucide-react';
import { ConversationPanel } from '@/components/conversation-panel';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import { useConversationHistory } from '@/renderer/use-conversation-history';
import { DashboardSidebar } from '@/components/sidebar-03/app-sidebar';
import type { NavSelection } from '@/components/sidebar-03/nav-main';
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
 * Execute mode's shell: the blocks-so sidebar-03 sidebar, mounted only while
 * this mode is active so map and explain keep the whole window.
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
  sidebarOpen,
  onSidebarOpenChange,
  sidebarWidth,
  onSidebarWidthChange,
  onOpenSettings,
}: {
  // Controlled by App so the open/collapsed state outlives this component,
  // which unmounts entirely whenever another mode is showing.
  sidebarOpen?: boolean;
  onSidebarOpenChange?: (open: boolean) => void;
  // Same outlives-the-mode treatment for the chosen width. Null = default.
  sidebarWidth?: number | null;
  onSidebarWidthChange?: (width: number | null) => void;
  onOpenSettings: () => void;
}) {
  const [selectedRef, setSelectedRef] = useState<ConversationRef | null>(null);
  const { providers, loading, error } = useConversationHistory();
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

  return (
    <SidebarProvider
      className="h-full min-h-0 overflow-hidden"
      data-sidebar-resizing={resizing || undefined}
      open={sidebarOpen}
      onOpenChange={onSidebarOpenChange}
      style={
        (sidebarWidth
          ? { '--sidebar-width': `${sidebarWidth}px` }
          : {}) as CSSProperties
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
      <SidebarInset className="min-h-0 overflow-hidden">
        {/*
          The row's height comes from `--app-bar-height`, the same token the
          mode toggle's strip uses. App renders that toggle once and never
          moves it, so it floats over this row's right-hand side already on
          this row's baseline — `items-center` on both, one height between
          them, no offset to keep in sync.

          That right-hand space is spoken for: anything added here needs to
          leave room for the toggle, or move it into the flow and accept that
          it will then remount on every mode change.
        */}
        <header
          className="flex shrink-0 items-center gap-2 px-4"
          style={{
            height: 'var(--app-bar-height)',
            marginTop: 'var(--app-bar-offset)',
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
              <Breadcrumb>
                <BreadcrumbList>
                  {selectedItem.section && (
                    <>
                      <BreadcrumbItem>{selectedItem.section}</BreadcrumbItem>
                      <BreadcrumbSeparator />
                    </>
                  )}
                  <BreadcrumbItem>
                    <BreadcrumbPage className="font-medium">
                      {selectedItem.title}
                    </BreadcrumbPage>
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
              call to action; starting one lives on the sidebar's New Chat.
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
