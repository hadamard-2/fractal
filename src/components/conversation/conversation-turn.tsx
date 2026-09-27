import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { ConversationTurn as ConversationTurnData, TurnBlock, UserDecision } from '@/shared/conversation-contract';
import { AgentAction, UnsupportedActivity } from './agent-action';
import { BlockingRequest } from './blocking-request';
import { ConversationImages } from './conversation-images';
import { WorkPacket, workPacketSummary } from './work-packet';

type ResolveRequest = (requestId: string, decision: UserDecision) => void | Promise<void>;

const concludes = (block: TurnBlock | undefined): boolean => block?.kind === 'assistant-prose' && block.concludesTurn === true;

/**
 * Splits a finished turn at the start of the message the provider marked as ending it.
 * Without that mark (a running or interrupted turn, or a provider that doesn't report it)
 * nothing is split, since there's no recorded answer to separate the work from.
 */
export function splitTurnWork(turn: ConversationTurnData): { work: TurnBlock[]; answer: TurnBlock[] } {
  let start = -1;
  if (turn.status !== 'active') {
    const last = turn.blocks.findLastIndex(concludes);
    if (last !== -1) {
      start = last;
      while (concludes(turn.blocks[start - 1])) start -= 1;
    }
  }
  return start > 0
    ? { work: turn.blocks.slice(0, start), answer: turn.blocks.slice(start) }
    : { work: [], answer: turn.blocks };
}

function TurnBlockView({ block, onResolve }: { block: TurnBlock; onResolve: ResolveRequest }) {
  switch (block.kind) {
    case 'assistant-prose':
      return <MessageResponse className="max-w-none text-sm leading-6">{block.text}</MessageResponse>;
    case 'work-packet':
      return <WorkPacket packet={block} />;
    case 'approval':
    case 'question':
      return <BlockingRequest onResolve={onResolve} request={block.request} />;
    case 'system-notice':
      return <p className={`rounded border px-3 py-2 text-sm ${block.tone === 'error' ? 'border-destructive/30 text-destructive' : 'text-muted-foreground'}`}>{block.message}</p>;
    case 'unsupported':
      return <UnsupportedActivity {...block} />;
  }
}

function TurnWork({ blocks, onResolve }: { blocks: TurnBlock[]; onResolve: ResolveRequest }) {
  const [open, setOpen] = useState(false);
  const actions = blocks.flatMap((block) => block.kind === 'work-packet' ? block.actions : []);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground">
        <ChevronRight aria-hidden className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />
        <span>Work{actions.length > 0 && ` · ${workPacketSummary(actions)}`}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 ml-2 space-y-4 border-l pl-4" aria-label="Agent work">
        {blocks.map((block) => <TurnBlockView block={block} key={block.id} onResolve={onResolve} />)}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ConversationTurn({ turn, onResolve }: { turn: ConversationTurnData; onResolve: ResolveRequest }) {
  const { work, answer } = splitTurnWork(turn);
  return (
    <article aria-label="Conversation turn" className="space-y-4">
      <Message from="user">
        {turn.userMessage.images && <ConversationImages className="justify-end" images={turn.userMessage.images} />}
        {turn.userMessage.text && <MessageContent className="font-medium leading-6">{turn.userMessage.text}</MessageContent>}
      </Message>
      <div className="space-y-4" aria-label="Agent response">
        {work.length > 0 && <TurnWork blocks={work} onResolve={onResolve} />}
        {answer.map((block) => <TurnBlockView block={block} key={block.id} onResolve={onResolve} />)}
      </div>
    </article>
  );
}

export { AgentAction };
