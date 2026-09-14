import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import type { ConversationTurn as ConversationTurnData, UserDecision } from '@/shared/conversation-contract';
import { AgentAction, UnsupportedActivity } from './agent-action';
import { BlockingRequest } from './blocking-request';
import { WorkPacket } from './work-packet';

type ResolveRequest = (requestId: string, decision: UserDecision) => void | Promise<void>;

export function ConversationTurn({ turn, onResolve }: { turn: ConversationTurnData; onResolve: ResolveRequest }) {
  return (
    <article aria-label="Conversation turn" className="space-y-4">
      <Message from="user">
        <MessageContent className="font-medium leading-6">{turn.userMessage.text}</MessageContent>
      </Message>
      <div className="space-y-4" aria-label="Agent response">
        {turn.blocks.map((block) => {
          switch (block.kind) {
            case 'assistant-prose':
              return <MessageResponse className="max-w-none text-sm leading-6" key={block.id}>{block.text}</MessageResponse>;
            case 'work-packet':
              return <WorkPacket key={block.id} packet={block} />;
            case 'approval':
            case 'question':
              return <BlockingRequest key={block.id} onResolve={onResolve} request={block.request} />;
            case 'system-notice':
              return <p className={`rounded border px-3 py-2 text-sm ${block.tone === 'error' ? 'border-destructive/30 text-destructive' : 'text-muted-foreground'}`} key={block.id}>{block.message}</p>;
            case 'unsupported':
              return <UnsupportedActivity key={block.id} {...block} />;
          }
        })}
      </div>
    </article>
  );
}

export { AgentAction };
