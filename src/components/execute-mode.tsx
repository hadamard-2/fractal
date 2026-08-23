import { useState } from 'react';
import { AppSidebar } from '@/components/app-sidebar';
import { ConversationPanel } from '@/components/conversation-panel';
import { Separator } from '@/components/ui/separator';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';

/**
 * Execute mode's shell: the sidebar-07 layout, mounted only while this mode is
 * active so map and explain keep the whole window.
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
export function ExecuteMode() {
  const [conversationId, setConversationId] = useState<string | null>(null);

  return (
    <SidebarProvider className="h-full min-h-0 overflow-hidden">
      <AppSidebar
        style={{
          top: 'var(--titlebar-height)',
          height: 'calc(100svh - var(--titlebar-height))',
        }}
      />
      <SidebarInset className="min-h-0 overflow-hidden">
        <header className="flex h-16 shrink-0 items-center gap-2">
          <div className="flex items-center gap-2 px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator
              orientation="vertical"
              className="mr-2 data-[orientation=vertical]:h-4"
            />
            <h1 className="text-sm font-medium">Execute</h1>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {conversationId ? (
            <ConversationPanel conversationId={conversationId} />
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <button
                className="rounded-md border px-4 py-2 text-sm"
                onClick={async () => {
                  const c = await window.fractal.agent.createConversation();
                  if (c) setConversationId(c.id);
                }}
                type="button"
              >
                New conversation
              </button>
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
