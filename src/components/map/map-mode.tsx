import { ReactFlowProvider } from '@xyflow/react';
import type { ShellContext } from '@/components/app-shell';
import { conversationKey } from '@/shared/conversation-contract';
import { MapCanvas } from './map-canvas';

/** Map mode: the selected conversation and its side chats on a canvas. */
export function MapMode({ selectedRef, history }: ShellContext) {
  if (!selectedRef) {
    return <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Pick a conversation to see its map.</main>;
  }
  const key = conversationKey(selectedRef);
  // A subagent conversation is the agent's own record of work it delegated, so nothing branches from it.
  const summary = history.projects.flatMap((project) => project.conversations).find((conversation) => conversationKey(conversation.ref) === key);
  return (
    <main className="relative flex min-h-0 flex-1">
      {/* One provider per root, so a new root starts with a fresh viewport and fits again. */}
      <ReactFlowProvider key={key}>
        <MapCanvas readOnly={summary?.parentId !== undefined} root={selectedRef} />
      </ReactFlowProvider>
    </main>
  );
}
