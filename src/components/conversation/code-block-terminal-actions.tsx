import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Terminal } from 'lucide-react';
import { useTerminalLauncher } from '@/components/right-panel/terminal-launcher';

/**
 * Adds an "Open in terminal" button to each Streamdown code block inside
 * `children`, ahead of Copy. It opens a new terminal with the code waiting at
 * the prompt, unrun.
 *
 * Streamdown 2.5 offers no slot for extra code-block actions, so the button is
 * portalled into its `code-block-actions` element. That attribute is
 * Streamdown's markup, not its API: if an upgrade renames it, the button
 * silently disappears.
 */
export function CodeBlockTerminalActions({ children }: { children: ReactNode }) {
  const openTerminalWith = useTerminalLauncher();
  const root = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<HTMLElement[]>([]);
  // One host per actions element, placed ahead of Streamdown's own buttons so
  // this one comes first. Kept by element so a re-scan reuses it.
  const hosts = useRef(new WeakMap<HTMLElement, HTMLElement>());
  const hostFor = (slot: HTMLElement) => {
    let host = hosts.current.get(slot);
    if (!host) {
      host = document.createElement('span');
      host.className = 'contents';
      hosts.current.set(slot, host);
    }
    if (slot.firstChild !== host) slot.prepend(host);
    return host;
  };

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !openTerminalWith) return;
    const scan = () => {
      const found = [...element.querySelectorAll<HTMLElement>('[data-streamdown="code-block-actions"]')];
      setSlots((previous) => (previous.length === found.length && previous.every((slot, index) => slot === found[index]) ? previous : found));
    };
    scan();
    // Code blocks appear and are replaced as a message streams in.
    const observer = new MutationObserver(scan);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [openTerminalWith]);

  return (
    <div className="contents" ref={root}>
      {children}
      {openTerminalWith && slots.map((slot, index) => createPortal(<OpenInTerminal onOpen={openTerminalWith} slot={slot} />, hostFor(slot), String(index)))}
    </div>
  );
}

function OpenInTerminal({ slot, onOpen }: { slot: HTMLElement; onOpen: (text: string) => void }) {
  const open = () => {
    const code = slot.closest('[data-streamdown="code-block"]')?.querySelector('[data-streamdown="code-block-body"] code');
    if (!code) return;
    // Each line is its own block element and line numbers are CSS counters,
    // so the lines are read one by one rather than as one textContent.
    const lines = code.children.length ? [...code.children].map((line) => line.textContent ?? '') : [code.textContent ?? ''];
    const text = lines.join('\n').replace(/\n+$/, '');
    if (text) onOpen(text);
  };
  return (
    // Matches Streamdown's own action buttons beside it; its icons render at 16px.
    <button aria-label="Open in terminal" className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground" onClick={open} title="Open in terminal" type="button">
      <Terminal aria-hidden size={16} />
    </button>
  );
}
