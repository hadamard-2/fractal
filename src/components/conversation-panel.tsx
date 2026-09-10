import { useState } from 'react';
import { Blocks } from 'lucide-react';
import {
  Conversation,
  ConversationContent,
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

  /*
    The composer, shared by the landing and transcript layouts so the two
    can't drift apart in behaviour. Only one renders at a time.
  */
  const composer = (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputBody>
        <PromptInputTextarea
          className="scrollbar-minimal"
          placeholder="Ask anything"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </PromptInputBody>
      <PromptInputFooter className="justify-end">
        <PromptInputSubmit disabled={!input.trim() && status === 'ready'} status={status} />
      </PromptInputFooter>
    </PromptInput>
  );

  const isEmpty = entries.length === 0;

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
      {isEmpty ? (
        /*
          Landing state, Claude-style: the mark and the greeting on one
          line, the composer directly beneath, the pair centred in the
          panel. No transcript chrome yet — nothing to stick to, nothing
          for the top gradient to dissolve. Sending the first message
          flips the panel to the transcript layout below.
        */
        <div
          className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-6 ${COLUMN}`}
        >
          <div className="flex items-center gap-3">
            <Blocks className="size-7" />
            <h2 className="font-medium text-3xl tracking-tight">
              How can I help?
            </h2>
          </div>
          {composer}
        </div>
      ) : (
        <>
          <Conversation className="min-h-0">
            {/*
              Dissolves messages as they scroll up under the header instead of
              letting them hit a hard cut-off. It reads because it sits over the
              transcript: the same gradient over empty space would be background
              fading into an identical background, i.e. nothing.
            */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-linear-to-b from-background to-transparent"
            />
            <ConversationContent
              className={`pt-8 ${COLUMN}`}
              scrollClassName="scrollbar-minimal"
            >
              {entries.map((entry) => (
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
              ))}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
          {/*
            pb-2, not pb-4: the floating sidebar's container insets itself
            by p-2, so 8px here lines the composer's bottom edge up with the
            sidebar card's instead of leaving it floating higher.
          */}
          <div className={`shrink-0 pb-2 ${COLUMN}`}>{composer}</div>
        </>
      )}
    </div>
  );
}
