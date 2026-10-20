import { Handle, Position, useStore, type Node, type NodeProps } from '@xyflow/react';
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Textarea } from '@/components/ui/textarea';
import type { SideChatDraft } from '@/renderer/map/map-graph';

/** What a composer node asks of the canvas that holds its draft. */
export interface ComposerEnvironment {
  /** Sends the draft with this text; rejects with the copy to show. */
  submit(draft: SideChatDraft, text: string): Promise<void>;
  remove(id: string): void;
}

export const ComposerEnvironmentContext = createContext<ComposerEnvironment>({
  submit: () => Promise.reject(new Error('No canvas')),
  remove: () => undefined,
});

/** An unsent side-chat message, typed into the canvas itself. */
export function ComposerNode({ id, data }: NodeProps<Node<{ kind: 'composer'; draft: SideChatDraft }>>) {
  const { submit, remove } = useContext(ComposerEnvironmentContext);
  const { draft } = data;
  const [text, setText] = useState(draft.text);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // React Flow keeps a node hidden until it has measured it, and a hidden textarea can't take focus, so it's focused once shown.
  const textarea = useRef<HTMLTextAreaElement>(null);
  const measured = useStore((state) => state.nodeLookup.get(id)?.measured.height !== undefined);
  useEffect(() => {
    if (measured) textarea.current?.focus();
  }, [measured]);
  // A failed send disables the textarea while it runs, which drops focus; the user is back to editing.
  useEffect(() => {
    if (!sending && error) textarea.current?.focus();
  }, [sending, error]);

  const send = async () => {
    if (sending || !text.trim()) return;
    setSending(true);
    setError(null);
    try {
      await submit(draft, text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    // Cmd on macOS, Ctrl elsewhere; plain Enter stays a newline.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    } else if (event.key === 'Escape' && !text.trim()) {
      event.preventDefault();
      remove(draft.id);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground shadow-xs">
      <div className="map-node-drag cursor-grab px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground select-none">You</div>
      <div className="px-3 pb-3">
        <Textarea
          aria-label="Side question"
          className="nodrag nowheel nopan max-h-64 min-h-20 resize-none"
          disabled={sending}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Ask a side question"
          ref={textarea}
          value={text}
        />
        <p className="pt-1.5 text-xs text-muted-foreground">Ctrl+Enter to send</p>
        {error && <p className="pt-1 text-xs text-destructive" role="alert">{error}</p>}
      </div>
      {/* The edge from the reply it branches from, or the reply it continues, attaches here. */}
      <Handle className="map-handle-anchor" isConnectable={false} position={Position.Top} type="target" />
    </div>
  );
}
