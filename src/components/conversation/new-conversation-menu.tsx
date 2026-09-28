import { Plus } from 'lucide-react';
import { SidebarMenuAction } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ConversationRef, HarnessStatus } from '@/shared/conversation-contract';
import { useStartConversation } from '@/components/conversation/use-start-conversation';

export function NewConversationMenu({ projectName, projectPath, providers, onCreated }: { projectName: string; projectPath: string; providers: HarnessStatus[]; onCreated(ref: ConversationRef): void }) {
  const { start, canStart, busy, status, chooser } = useStartConversation({ providers, onCreated });
  return <>
    <Tooltip>
      <TooltipTrigger asChild>
        <SidebarMenuAction aria-busy={busy} aria-label={`New chat in ${projectName}`} className="text-sidebar-foreground/45 hover:text-sidebar-foreground" disabled={!canStart || busy} onClick={() => void start({ name: projectName, path: projectPath })} showOnHover><Plus /></SidebarMenuAction>
      </TooltipTrigger>
      <TooltipContent side="right">New chat in {projectName}</TooltipContent>
    </Tooltip>
    {chooser}
    {status && <p className="px-2 py-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden" role="status">{status}</p>}
  </>;
}
