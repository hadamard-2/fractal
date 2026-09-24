import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { SidebarMenuAction } from '@/components/ui/sidebar';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ConversationRef, HarnessStatus, ProviderId } from '@/shared/conversation-contract';

const LABELS: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code' };

export function NewConversationMenu({ projectName, projectPath, providers, onCreated }: { projectName: string; projectPath: string; providers: HarnessStatus[]; onCreated(ref: ConversationRef): void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ProviderId | null>(null);
  const pendingRequest = useRef<symbol | null>(null);
  const mounted = useRef(true);
  const available = providers.filter((provider) => provider.availability === 'available' && provider.capabilities.create);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const create = async (provider: ProviderId) => {
    if (pendingRequest.current) return;
    const request = Symbol(provider);
    pendingRequest.current = request;
    setPending(provider);
    setError(null);
    try {
      const ref = await window.fractal.conversations.create({ provider, projectPath });
      if (mounted.current && pendingRequest.current === request && ref) onCreated(ref);
    } catch {
      if (mounted.current && pendingRequest.current === request) setError(`${LABELS[provider]} could not create a conversation.`);
    } finally {
      if (pendingRequest.current === request) pendingRequest.current = null;
      if (mounted.current) setPending(null);
    }
  };
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><SidebarMenuAction aria-busy={pending !== null} aria-label={`New chat in ${projectName}`} className="text-sidebar-foreground/45 hover:text-sidebar-foreground" disabled={available.length === 0 || pending !== null} showOnHover title={`New chat in ${projectName}`}><Plus /></SidebarMenuAction></DropdownMenuTrigger>
      <DropdownMenuContent align="end">{available.map((provider) => <DropdownMenuItem disabled={pending !== null} key={provider.provider} onSelect={() => void create(provider.provider)}>{LABELS[provider.provider]}</DropdownMenuItem>)}</DropdownMenuContent>
    </DropdownMenu>
    {pending && <p className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden" role="status">Creating {LABELS[pending]} conversation…</p>}
    {error && <p className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden" role="status">{error}</p>}
  </>;
}
