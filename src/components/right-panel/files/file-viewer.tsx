import { useVirtualizer } from '@tanstack/react-virtual';
import { Check, Copy } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TokenLine, useHighlightedTokens } from '@/components/code/highlighted-tokens';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { absoluteProjectPath, basename, formatSize, languageFor } from '@/renderer/file-display';
import { useWatchedLoad } from '@/renderer/use-watched-load';
import { FILE_HIGHLIGHT_MAX_BYTES, type FileContent } from '@/shared/files-contract';
import { OpenMenu } from './open-menu';

const readFile = (root: string, path: string) => window.fractal.files.readFile(root, path);
// text-xs with leading-5: every line is 20px, so rows never need measuring.
const LINE_HEIGHT = 20;
const TAB_WIDTH = 8;

export function FileViewer({ root, path }: { root: string; path: string }) {
  const loaded = useWatchedLoad(root, path, readFile);
  const [line, setLine] = useState<number | undefined>();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
        <Breadcrumb path={path} root={root} />
        <CopyPath path={absoluteProjectPath(root, path)} />
        <OpenMenu line={line} path={path} root={root} />
      </div>
      <div className="min-h-0 flex-1">
        {loaded.status === 'loading' && <Message>Reading file…</Message>}
        {loaded.status === 'failed' && <Message>This file cannot be read</Message>}
        {loaded.status === 'ready' && <Content content={loaded.value} line={line} onLine={setLine} path={path} root={root} />}
      </div>
    </div>
  );
}

function Breadcrumb({ root, path }: { root: string; path: string }) {
  const segments = [basename(root), ...path.split('/')];
  return (
    <nav aria-label="File path" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden className="mx-1">›</span>}
          <span className={index === segments.length - 1 ? 'text-foreground' : undefined}>{segment}</span>
        </Fragment>
      ))}
    </nav>
  );
}

function CopyPath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      aria-label="Copy path"
      className="size-7 shrink-0"
      onClick={() => { navigator.clipboard.writeText(path).then(() => setCopied(true), (): void => undefined); }}
      size="icon"
      type="button"
      variant="ghost"
    >
      {copied ? <Check aria-hidden className="size-3.5" /> : <Copy aria-hidden className="size-3.5" />}
    </Button>
  );
}

function Message({ children }: { children: ReactNode }) {
  return <p className="p-6 text-center text-sm text-muted-foreground">{children}</p>;
}

function Content({ content, root, path, line, onLine }: { content: FileContent; root: string; path: string; line?: number; onLine: (line: number) => void }) {
  switch (content.kind) {
    case 'text': return <Lines line={line} onLine={onLine} path={path} size={content.size} text={content.content} />;
    case 'binary': return <Unshown path={path} root={root} text={`Binary file · ${formatSize(content.size)}`} />;
    case 'too-large': return <Unshown path={path} root={root} text={`Too large to preview · ${formatSize(content.size)}`} />;
    case 'missing': return <Message>This file no longer exists</Message>;
    case 'unreadable': return <Message>This file cannot be read</Message>;
  }
}

function Unshown({ root, path, text }: { root: string; path: string; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 p-6 text-sm text-muted-foreground">
      <p>{text}</p>
      <OpenMenu path={path} root={root} />
    </div>
  );
}

/** Columns in the longest line, with tabs at their CSS default width, so the content can scroll sideways. */
const longestLine = (lines: string[]) => lines.reduce((longest, text) => Math.max(longest, text.length + (TAB_WIDTH - 1) * (text.split('\t').length - 1)), 0);

function Lines({ text, size, path, line, onLine }: { text: string; size: number; path: string; line?: number; onLine: (line: number) => void }) {
  const lines = useMemo(() => text.split(/\r?\n/), [text]);
  const tokens = useHighlightedTokens(text, size <= FILE_HIGHLIGHT_MAX_BYTES ? languageFor(path) : undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({ count: lines.length, getScrollElement: () => scroller.current, estimateSize: () => LINE_HEIGHT, overscan: 20 });
  const gutter = `${String(lines.length).length + 2}ch`;
  // Rows are absolutely positioned, so the content's width has to be set rather than measured.
  const width = `calc(${longestLine(lines)}ch + ${gutter} + 2rem)`;
  return (
    <div aria-label={`${basename(path)} contents`} className="h-full overflow-auto font-mono text-xs leading-5" ref={scroller} role="region">
      <div className="relative min-w-full" style={{ height: virtualizer.getTotalSize(), width }}>
        {virtualizer.getVirtualItems().map((item) => {
          const number = item.index + 1;
          const current = number === line;
          return (
            <div
              aria-current={current ? 'true' : undefined}
              className={cn('absolute left-0 flex w-full whitespace-pre', current && 'bg-sidebar-accent')}
              data-line={number}
              key={item.key}
              onClick={() => onLine(number)}
              style={{ top: item.start, height: LINE_HEIGHT }}
            >
              <span aria-hidden className={cn('sticky left-0 shrink-0 pr-3 pl-2 text-right text-muted-foreground select-none', current ? 'bg-sidebar-accent' : 'bg-sidebar')} style={{ width: gutter }}>{number}</span>
              <span className="pr-4">{tokens?.[item.index] ? <TokenLine tokens={tokens[item.index]} /> : lines[item.index]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
