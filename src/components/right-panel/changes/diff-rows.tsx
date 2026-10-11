import { ChevronDown, ChevronRight, FolderOpen } from 'lucide-react';
import { TokenLine, type Token } from '@/components/code/highlighted-tokens';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { countsText, statusLetter, type ChangeRow } from '@/renderer/changes-rows';
import type { ChangedFile } from '@/shared/changes-contract';
import { OpenMenu } from '../files/open-menu';

// Row content that must stay in view while the stream scrolls sideways is as wide as the scroller.
const PINNED = 'sticky left-0 w-[100cqw]';
const MARKERS = { added: '+', removed: '-', context: ' ', 'no-newline': '' } as const;

export const displayPath = (file: ChangedFile) => (file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);

export function FileHeader({ file, root, collapsed, line, onToggle, onOpenFile }: {
  file: ChangedFile;
  root: string;
  collapsed: boolean;
  line?: number;
  onToggle: () => void;
  onOpenFile: (path: string) => void;
}) {
  const actionable = file.status !== 'deleted' && file.body.kind !== 'folder';
  return (
    <div className="flex h-9 items-center gap-2 border-b border-sidebar-border bg-sidebar px-2 font-sans text-xs">
      <button
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${file.path}`}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        onClick={onToggle}
        type="button"
      >
        {collapsed ? <ChevronRight aria-hidden className="size-3.5" /> : <ChevronDown aria-hidden className="size-3.5" />}
      </button>
      <span aria-hidden className="w-3 shrink-0 text-center font-mono text-muted-foreground">{statusLetter(file.status)}</span>
      {file.status === 'conflicted' && <span className="shrink-0 rounded border border-sidebar-border px-1.5 text-muted-foreground">Conflicted</span>}
      <span className="min-w-0 flex-1 truncate">{displayPath(file)}</span>
      <span className="shrink-0 text-muted-foreground">{countsText(file.added, file.removed)}</span>
      {actionable && (
        <>
          <OpenMenu line={line} path={file.path} root={root} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button aria-label="Open in Files" className="size-7 shrink-0" onClick={() => onOpenFile(file.path)} size="icon" type="button" variant="ghost">
                <FolderOpen aria-hidden className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open in Files</TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}

export function BodyRow({ row, gutter, tokens, current, onLine }: {
  row: Exclude<ChangeRow, { kind: 'file' }>;
  /** Width, in characters, of each line-number column. */
  gutter: number;
  tokens: Token[] | null;
  current: boolean;
  onLine: () => void;
}) {
  if (row.kind === 'hunk') return <div className={cn(PINNED, 'h-full truncate bg-muted/40 px-3 text-muted-foreground')}>{row.header}</div>;
  if (row.kind === 'message') return <div className={cn(PINNED, 'truncate px-3 font-sans text-muted-foreground')}>{row.text}</div>;
  const { line } = row;
  if (line.kind === 'no-newline') return <div className={cn(PINNED, 'truncate px-3 text-muted-foreground')}>{line.text.trim()}</div>;
  const tint = line.kind === 'added' ? 'bg-green-500/10' : line.kind === 'removed' ? 'bg-red-500/10' : undefined;
  return (
    <div
      aria-current={current ? 'true' : undefined}
      className={cn('flex w-full whitespace-pre', current ? 'bg-sidebar-accent' : tint)}
      onClick={onLine}
    >
      <span aria-hidden className={cn('sticky left-0 flex shrink-0 text-muted-foreground select-none', current ? 'bg-sidebar-accent' : 'bg-sidebar')} style={{ width: `${gutter * 2}ch` }}>
        <span className={cn('flex h-full w-full', !current && tint)}>
          <span className="pr-2 text-right" style={{ width: `${gutter}ch` }}>{line.oldNumber}</span>
          <span className="pr-2 text-right" style={{ width: `${gutter}ch` }}>{line.newNumber}</span>
        </span>
      </span>
      <span aria-hidden className="w-[2ch] shrink-0 text-center select-none">{MARKERS[line.kind]}</span>
      <span className="pr-4">{tokens ? <TokenLine tokens={tokens} /> : line.text}</span>
    </div>
  );
}
