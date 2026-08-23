import { useState } from 'react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning';
import { useConversation } from '@/renderer/use-conversation';

// The reading column. Applied to the transcript and the composer alike so the
// two stay on the same measure — putting a width on only one of them is what
// makes a composer look bolted on. Percentage insets rather than a max-width
// so the column keeps breathing room at the edges instead of pinning to a
// fixed pixel measure and stranding whitespace on a wide window.
const COLUMN = 'px-4 lg:px-[8%] xl:px-[14%] 2xl:px-[20%]';

export function ConversationPanel({ conversationId }: { conversationId: string | null }) {
  const { entries, missedEvents, snapshotError, status, send, cancel, reload } = useConversation(conversationId);
  const [input, setInput] = useState('');

  const handleSubmit = (message: PromptInputMessage) => {
    if (status !== 'ready') {
      cancel();
      return;
    }
    const text = message.text.trim();
    if (!text) return;
    send(text);
    setInput('');
  };

  return (
    <div className="relative flex size-full flex-col overflow-hidden">
      {snapshotError && (
        <div className="shrink-0 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">
          Failed to load this conversation: {snapshotError}{' '}
          <button type="button" onClick={reload} className="underline">
            Reload
          </button>
        </div>
      )}
      {missedEvents && (
        <div className="shrink-0 border-b bg-amber-500/10 px-4 py-2 text-xs text-amber-600 dark:text-amber-400">
          Some events were missed — this transcript may be incomplete.{' '}
          <button type="button" onClick={reload} className="underline">
            Reload
          </button>
        </div>
      )}
      <Conversation className="min-h-0">
        <ConversationContent className={COLUMN} scrollClassName="scrollbar-minimal">
          {entries.length === 0 ? (
            <ConversationEmptyState title="How can I help?" description="Send a message to start." />
          ) : (
            entries.map((entry) => (
              <Message from={entry.author === 'user' ? 'user' : 'assistant'} key={entry.id}>
                <MessageContent>
                  {entry.parts.map((part) => {
                    if (part.kind === 'text') {
                      return <MessageResponse key={part.id}>{part.text}</MessageResponse>;
                    }
                    if (part.kind === 'reasoning') {
                      return (
                        <Reasoning key={part.id} isStreaming={entry.status === 'streaming'}>
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      );
                    }
                    return (
                      <div key={part.id} className="text-xs text-muted-foreground">
                        [{part.kind}
                        {'path' in part ? ` ${part.path}` : ''}] {part.phase}
                      </div>
                    );
                  })}
                  {entry.status === 'error' && entry.error && (
                    <div className="text-xs text-destructive">{entry.error.message}</div>
                  )}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className={`shrink-0 pb-4 ${COLUMN}`}>
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea
              className="scrollbar-minimal"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </PromptInputBody>
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit disabled={!input.trim() && status === 'ready'} status={status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
