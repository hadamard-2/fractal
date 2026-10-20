import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';

/** Text selected inside one message node, and where it sits on screen. */
export interface MessageSelection {
  nodeId: string;
  text: string;
  /** Viewport coordinates of the selection's bounds. */
  left: number;
  bottom: number;
}

const MENU_OFFSET = 6;

/** The message body an endpoint of the selection sits in, if any. */
function messageOf(node: Node | null): Element | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  return element?.closest('[data-map-message]') ?? null;
}

function readSelection(accepts: (nodeId: string) => boolean): MessageSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const message = messageOf(selection.anchorNode);
  if (!message || message !== messageOf(selection.focusNode)) return null;
  const nodeId = message.closest('.react-flow__node')?.getAttribute('data-id');
  if (!nodeId || !accepts(nodeId)) return null;
  const range = selection.getRangeAt(0);
  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  return { nodeId, text, left: rect?.left ?? 0, bottom: rect?.bottom ?? 0 };
}

/**
 * Text the user has selected inside a single message node that `accepts`
 * takes, or null; `accepts` null offers nothing. The selection is read again
 * whenever it changes, and dropped on any scroll or on `dismiss()`, since its
 * place on screen has moved.
 */
export function useMessageSelection(accepts: ((nodeId: string) => boolean) | null): { selection: MessageSelection | null; dismiss(): void } {
  const [selection, setSelection] = useState<MessageSelection | null>(null);
  const latest = useRef(accepts);
  latest.current = accepts;
  const enabled = accepts !== null;

  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const current = latest.current;
      setSelection(current ? readSelection(current) : null);
    };
    const hide = () => setSelection(null);
    document.addEventListener('selectionchange', read);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('selectionchange', read);
      window.removeEventListener('scroll', hide, true);
    };
  }, [enabled]);

  const dismiss = useCallback(() => setSelection(null), []);
  return { selection: enabled ? selection : null, dismiss };
}

/** The floating "Side chat" entry under a selection, fixed to the window so the canvas's zoom never scales it. */
export function SelectionMenu({ selection, onChoose }: { selection: MessageSelection; onChoose(): void }) {
  return createPortal(
    <div
      className="z-50 rounded-md border bg-popover p-0.5 text-popover-foreground shadow-md"
      data-slot="selection-menu"
      style={{ position: 'fixed', left: selection.left, top: selection.bottom + MENU_OFFSET }}
    >
      {/* Pressing the button must not clear the selection it acts on. */}
      <Button onClick={onChoose} onMouseDown={(event) => event.preventDefault()} size="sm" type="button" variant="ghost">Side chat</Button>
    </div>,
    document.body,
  );
}
