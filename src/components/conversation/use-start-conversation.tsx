import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ConversationRef, HarnessStatus, ProviderId } from '@/shared/conversation-contract';
import { DEFAULT_CODING_AGENT } from '@/shared/settings-contract';

const LABELS: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code' };

/** Where a new conversation starts: a known project, or null to have the main process ask for a folder. */
export type StartTarget = { name: string; path: string } | null;

/**
 * Starting a conversation: the saved default agent when it can create one,
 * otherwise a chooser dialog. Shared by every entry point — a project's plus
 * action, the empty state, and the keyboard shortcuts — so they all resolve the
 * agent the same way. `chooser` is the dialog to render; `pending` and `error`
 * are for the caller's own status line.
 */
export function useStartConversation({ providers, onCreated }: { providers: HarnessStatus[]; onCreated(ref: ConversationRef): void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ProviderId | null>(null);
  const [resolvingDefault, setResolvingDefault] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  // Kept apart from `chooserOpen` so the description doesn't blank out while
  // the dialog animates closed.
  const [chooserTarget, setChooserTarget] = useState<StartTarget>(null);
  const pendingRequest = useRef<symbol | null>(null);
  const resolvingRequest = useRef(false);
  const mounted = useRef(true);
  const available = providers.filter((provider) => provider.availability === 'available' && provider.capabilities.create);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const create = async (provider: ProviderId, target: StartTarget) => {
    if (pendingRequest.current) return;
    const request = Symbol(provider);
    pendingRequest.current = request;
    setPending(provider);
    setError(null);
    try {
      const ref = await window.fractal.conversations.create(target ? { provider, projectPath: target.path } : { provider });
      if (mounted.current && pendingRequest.current === request && ref) onCreated(ref);
    } catch {
      if (mounted.current && pendingRequest.current === request) setError(`${LABELS[provider]} could not create a conversation.`);
    } finally {
      if (pendingRequest.current === request) pendingRequest.current = null;
      if (mounted.current) setPending(null);
    }
  };

  const start = async (target: StartTarget) => {
    if (available.length === 0 || resolvingRequest.current || pendingRequest.current) return;
    resolvingRequest.current = true;
    setResolvingDefault(true);
    try {
      const { defaultCodingAgent: savedAgent } = await window.fractal.settings.get();
      const defaultCodingAgent = savedAgent ?? DEFAULT_CODING_AGENT;
      if (!mounted.current) return;
      if (defaultCodingAgent === 'ask' || !available.some((provider) => provider.provider === defaultCodingAgent)) {
        setChooserTarget(target);
        setChooserOpen(true);
      } else {
        await create(defaultCodingAgent, target);
      }
    } catch {
      if (mounted.current) {
        setChooserTarget(target);
        setChooserOpen(true);
      }
    } finally {
      resolvingRequest.current = false;
      if (mounted.current) setResolvingDefault(false);
    }
  };

  const chooser = (
    <Dialog open={chooserOpen} onOpenChange={setChooserOpen}>
      <DialogContent className="rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-2xl sm:max-w-sm" overlayClassName="bg-black/45 backdrop-blur-sm">
        <DialogHeader>
          <DialogTitle>Choose a coding agent</DialogTitle>
          <DialogDescription>{chooserTarget ? `Start a new chat in ${chooserTarget.name}.` : 'Start a new chat in a folder you choose.'}</DialogDescription>
        </DialogHeader>
        <DialogFooter>{available.map((provider) => <Button disabled={pending !== null} key={provider.provider} onClick={() => { setChooserOpen(false); void create(provider.provider, chooserTarget); }} variant="outline">{LABELS[provider.provider]}</Button>)}</DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return {
    start,
    canStart: available.length > 0,
    busy: pending !== null || resolvingDefault,
    status: pending ? `Creating ${LABELS[pending]} conversation…` : error,
    chooser,
  };
}
