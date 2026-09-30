import { Loader2, Plus } from 'lucide-react';
import { ConversationPanel } from '@/components/conversation-panel';
import { providerName } from '@/components/sidebar-03/nav-main';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ShellContext } from '@/components/app-shell';
import { MOD_KEY_LABEL } from '@/renderer/shortcuts';
import type { HarnessStatus } from '@/shared/conversation-contract';

const AVAILABILITY_TEXT: Record<Exclude<HarnessStatus['availability'], 'available'>, string> = {
  unavailable: "isn't available",
  unauthenticated: "isn't signed in",
  unsupported: "isn't a supported version",
};

function Kbd({ children }: { children: string }) {
  return <kbd className="rounded border border-border px-1.5 py-px font-mono text-[11px] font-medium text-muted-foreground">{children}</kbd>;
}

/** A quiet one-line notice under the empty state; `detail` goes in a tooltip. */
function Notice({ children, detail }: { children: string; detail?: string }) {
  const notice = (
    <p className="flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground" role="status">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-amber-500" />
      {children}
    </p>
  );
  if (!detail) return notice;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{notice}</TooltipTrigger>
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Execute mode: the selected conversation, or the home screen when nothing is
 * selected. App keeps it mounted but hidden in other modes so a running
 * session isn't torn down by a mode switch.
 */
export function ExecuteMode({ active = true, selectedRef, history, actions }: ShellContext & { active?: boolean }) {
  const { providers, loaded, error } = history;
  const shortcuts = [
    ['Search conversations', `${MOD_KEY_LABEL} K`],
    ['Add a project', `${MOD_KEY_LABEL} O`],
  ] as const;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ display: active ? undefined : 'none' }}>
      {selectedRef ? (
        <ConversationPanel conversationRef={selectedRef} />
      ) : (
        /*
          The home screen: one action, the shortcuts that reach the rest, and
          any provider trouble as a quiet notice rather than raw status text.
        */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8 text-center">
          <h2 className="text-base font-medium">Pick up a thread</h2>
          <p className="mt-1 text-sm text-muted-foreground">Choose a conversation from the sidebar, or start one in a project.</p>
          {/* Until history loads, which agents can start one isn't known yet; the button waits visibly. */}
          <Button aria-busy={!loaded || undefined} className="mt-5" disabled={!loaded || !actions.canStart} onClick={actions.newConversation}>
            {loaded ? <Plus aria-hidden /> : <Loader2 aria-hidden className="animate-spin" />}
            New conversation
            <kbd className="ml-1 font-mono text-[11px] font-medium opacity-60">{MOD_KEY_LABEL} N</kbd>
          </Button>
          <dl className="mt-6 grid grid-cols-[auto_auto] gap-x-8 gap-y-2.5 text-left text-sm text-muted-foreground">
            {shortcuts.map(([label, keys]) => (
              <div className="contents" key={label}>
                <dt>{label}</dt>
                <dd className="text-right"><Kbd>{keys}</Kbd></dd>
              </div>
            ))}
          </dl>
          <div className="mt-7 flex flex-col items-center gap-2">
            {error && <Notice detail={error.message}>Your conversations couldn't be loaded</Notice>}
            {providers.filter((provider) => provider.availability !== 'available').map((provider) => (
              <Notice detail={provider.message} key={provider.provider}>
                {`${providerName(provider.provider)} ${AVAILABILITY_TEXT[provider.availability as keyof typeof AVAILABILITY_TEXT]}, so its conversations are hidden`}
              </Notice>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
