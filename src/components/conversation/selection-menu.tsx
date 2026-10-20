import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';

/** Text selected inside one source element, and where it sits on screen. */
export interface MessageSelection {
  sourceId: string;
  text: string;
  /** Viewport coordinates of the selection's bounds. */
  left: number;
  bottom: number;
}

const MENU_OFFSET = 6;
const TEXT_FIELD = 'textarea, input';

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

/** The source element an endpoint of the selection sits in, if any. */
function sourceOf(node: Node | null): Element | null {
  return elementOf(node)?.closest('[data-selection-source]') ?? null;
}

/** Whether the selection belongs to a text field, which browsers report with endpoints around the field rather than in it. */
function inTextField(selection: Selection): boolean {
  if (elementOf(selection.anchorNode)?.closest(TEXT_FIELD) || elementOf(selection.focusNode)?.closest(TEXT_FIELD)) return true;
  const active = document.activeElement;
  return (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) && active.selectionStart !== active.selectionEnd;
}

function readSelection(container: HTMLElement, accepts: (sourceId: string) => boolean): MessageSelection | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim() || inTextField(selection)) return null;
  const source = sourceOf(selection.anchorNode);
  if (!source || source !== sourceOf(selection.focusNode) || !container.contains(source)) return null;
  const sourceId = source.getAttribute('data-selection-source');
  if (!sourceId || !accepts(sourceId)) return null;
  const range = selection.getRangeAt(0);
  const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
  return { sourceId, text, left: rect?.left ?? 0, bottom: rect?.bottom ?? 0 };
}

/**
 * Text the user has selected inside a single `[data-selection-source]` element
 * within `container` that `accepts` takes, or null; `accepts` null offers
 * nothing. Sources outside `container` are never seen, so two transcripts on
 * screen keep their selections apart. The selection is read again whenever it
 * changes, and dropped on any scroll or on `dismiss()`, since its place on
 * screen has moved.
 */
export function useMessageSelection(
  container: RefObject<HTMLElement | null>,
  accepts: ((sourceId: string) => boolean) | null,
): { selection: MessageSelection | null; dismiss(): void } {
  const [selection, setSelection] = useState<MessageSelection | null>(null);
  const latest = useRef(accepts);
  latest.current = accepts;
  const enabled = accepts !== null;

  useEffect(() => {
    if (!enabled) return;
    const read = () => {
      const current = latest.current;
      const root = container.current;
      setSelection(current && root ? readSelection(root, current) : null);
    };
    const hide = () => setSelection(null);
    document.addEventListener('selectionchange', read);
    window.addEventListener('scroll', hide, true);
    return () => {
      document.removeEventListener('selectionchange', read);
      window.removeEventListener('scroll', hide, true);
    };
  }, [enabled, container]);

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
