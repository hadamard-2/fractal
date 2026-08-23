import { useState, type ReactNode } from 'react';
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
export function ExecuteMode({ modeToggle }: { modeToggle?: ReactNode }) {
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
        {/*
          One row, `items-center`: the trigger/title cluster and the mode
          toggle share a baseline because they are siblings in the same flex
          line, not because two heights were tuned to agree. The toggle is
          passed in rather than owned here — App decides where it goes, since
          the modes without a header still need it as a fixed overlay.

          `h-14` is the floor, not a taste call: the toggle is 40px tall, so
          this leaves it 8px of breathing room top and bottom.
        */}
        <header className="relative z-10 flex h-14 shrink-0 items-center gap-2 px-4">
          <SidebarTrigger className="-ml-1" />
          <Separator
            orientation="vertical"
            className="mr-2 data-[orientation=vertical]:h-4"
          />
          <h1 className="text-sm font-medium">Execute</h1>
          {modeToggle && <div className="ml-auto">{modeToggle}</div>}

          {/*
            The header's soft bottom edge, hung just below it. Fades a faint
            tint out rather than fading `background` out: the content beneath
            is also `background`, so a background-to-transparent gradient here
            would compute to no visible change at all.

            The header carries `z-10` so this paints over the content that
            follows it in the flow.
          */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-full h-3 bg-linear-to-b from-border to-transparent"
          />
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
