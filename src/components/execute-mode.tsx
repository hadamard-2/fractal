import { Blocks } from 'lucide-react';
import { ConversationPanel } from '@/components/conversation-panel';
import { ConversationEmptyState } from '@/components/ai-elements/conversation';
import type { ShellContext } from '@/components/app-shell';

/**
 * Execute mode: the selected conversation, or an empty state explaining how to
 * pick one. App keeps it mounted but hidden in other modes so a running
 * session isn't torn down by a mode switch.
 */
export function ExecuteMode({ active = true, selectedRef, history }: ShellContext & { active?: boolean }) {
  const { providers, loading, error } = history;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" style={{ display: active ? undefined : 'none' }}>
      {selectedRef ? (
        <ConversationPanel conversationRef={selectedRef} />
      ) : (
        /*
          No conversation yet. The mark is the same Blocks glyph the
          sidebar's wordmark uses — a quiet centrepiece rather than a
          call to action; starting one lives on a project's plus action.
        */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
          <ConversationEmptyState className="h-auto" icon={<Blocks aria-hidden className="size-10 text-muted-foreground/50" />} title="Select a conversation" description="Open native conversation history from the sidebar to read the transcript and see its session status." />
          {loading && <p className="text-sm text-muted-foreground" role="status">Loading conversation history…</p>}
          {error && <p className="px-4 text-sm text-muted-foreground" role="status">Conversation history could not be loaded: {error.message}</p>}
          {providers.filter((provider) => provider.availability !== 'available').map((provider) => <p className="max-w-xl px-4 py-1 text-sm text-muted-foreground" key={provider.provider} role="status">{provider.provider}: {provider.availability}.{provider.message ? ` ${provider.message}` : ''}</p>)}
        </div>
      )}
    </div>
  );
}
