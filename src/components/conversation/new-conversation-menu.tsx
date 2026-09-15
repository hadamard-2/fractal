import { useState } from 'react';
import { MessageCirclePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { ConversationRef, HarnessStatus, ProviderId } from '@/shared/conversation-contract';

const LABELS: Record<ProviderId, string> = { codex: 'Codex', claude: 'Claude Code' };

export function NewConversationMenu({ providers, onCreated }: { providers: HarnessStatus[]; onCreated(ref: ConversationRef): void }) {
  const [error, setError] = useState<string | null>(null);
  const available = providers.filter((provider) => provider.availability === 'available' && provider.capabilities.create);
  const create = async (provider: ProviderId) => {
    setError(null);
    try {
      const ref = await window.fractal.conversations.create({ provider });
      if (ref) onCreated(ref);
    } catch {
      setError(`${LABELS[provider]} could not create a conversation.`);
    }
  };
  return <>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button aria-label="New conversation" className="h-8 w-full justify-start px-2 font-normal" disabled={available.length === 0} variant="ghost"><MessageCirclePlus /><span>New conversation</span></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">{available.map((provider) => <DropdownMenuItem key={provider.provider} onSelect={() => void create(provider.provider)}>{LABELS[provider.provider]}</DropdownMenuItem>)}</DropdownMenuContent>
    </DropdownMenu>
    {error && <p className="px-2 py-1 text-xs text-muted-foreground" role="status">{error}</p>}
  </>;
}
