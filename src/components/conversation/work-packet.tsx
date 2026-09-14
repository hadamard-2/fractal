import { ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AgentActions } from './agent-action';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { AgentAction, TurnBlock } from '@/shared/conversation-contract';

type WorkPacketData = Extract<TurnBlock, { kind: 'work-packet' }>;

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function actionKind(action: AgentAction): [string, string] {
  switch (action.kind) {
    case 'file-read': return ['file read', 'file reads'];
    case 'file-edit': return ['file edit', 'file edits'];
    case 'command': return ['command', 'commands'];
    case 'search': return ['search', 'searches'];
    case 'tool': return ['tool', 'tools'];
    case 'subagent': return ['subagent', 'subagents'];
  }
}

export function workPacketSummary(actions: AgentAction[]): string {
  const kinds = new Map<string, { plural: string; count: number }>();
  const states = new Map<AgentAction['status'], number>();
  for (const action of actions) {
    const [singular, plural] = actionKind(action);
    const existing = kinds.get(singular);
    kinds.set(singular, { plural, count: (existing?.count ?? 0) + 1 });
    states.set(action.status, (states.get(action.status) ?? 0) + 1);
  }
  const work = [...kinds].map(([singular, { plural, count }]) => pluralize(count, singular, plural)).join(', ') || 'No activity';
  if (actions.length > 0 && actions.every((action) => action.status === 'completed')) return `${work} completed`;
  const lifecycle = (['requested', 'awaiting-approval', 'running', 'completed', 'failed', 'denied', 'interrupted'] as const)
    .flatMap((status) => {
      const count = states.get(status) ?? 0;
      return count > 0 ? [`${count} ${status.replace('-', ' ')}`] : [];
    });
  return lifecycle.length > 0 ? `${work}: ${lifecycle.join(', ')}` : work;
}

export function WorkPacket({ packet }: { packet: WorkPacketData }) {
  const [open, setOpen] = useState(packet.status === 'active');
  const previousStatus = useRef(packet.status);
  const hasUserChoice = useRef(false);

  useEffect(() => {
    if (!hasUserChoice.current && previousStatus.current !== packet.status) setOpen(packet.status === 'active');
    previousStatus.current = packet.status;
  }, [packet.status]);

  const summary = workPacketSummary(packet.actions);
  return (
    <Collapsible className="rounded-md border bg-muted/20" onOpenChange={(nextOpen) => { hasUserChoice.current = true; setOpen(nextOpen); }} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/50">
        <ChevronRight aria-hidden className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="space-y-3 border-t px-3 py-3"><AgentActions actions={packet.actions} /></ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
