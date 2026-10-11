import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { countsText, statusLetter, summaryText } from '@/renderer/changes-rows';
import { useChanges } from '@/renderer/use-changes';
import type { ChangedFile, ChangesHead } from '@/shared/changes-contract';
import { DiffStream } from './diff-stream';
import { displayPath } from './diff-rows';

function Message({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center gap-3 p-6 text-center text-sm text-muted-foreground">{children}</div>;
}

const branchLabel = (head: ChangesHead) => head.branch ?? head.commit?.slice(0, 7);

export function ChangesPane({ root, active, onOpenFile }: { root: string; active: boolean; onOpenFile: (path: string) => void }) {
  const { snapshot, failed, checkedAt, refresh } = useChanges(root, active);
  const [listOpen, setListOpen] = useState(true);
  const [jumpTo, setJumpTo] = useState<{ path: string; token: number } | null>(null);

  if (!snapshot) {
    return failed
      ? <Message><p>Changes couldn&apos;t be read</p><Button onClick={refresh} size="sm" type="button" variant="outline">Retry</Button></Message>
      : <Message>Reading changes…</Message>;
  }
  if (snapshot.kind === 'not-a-repo') return <Message>Not a git repository</Message>;
  if (snapshot.kind === 'git-unavailable') return <Message>Git isn&apos;t available</Message>;
  if (snapshot.files.length === 0) return <Message>No uncommitted changes</Message>;

  const { files, head } = snapshot;
  const branch = branchLabel(head);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-sidebar-border px-3 text-xs">
        <span className="shrink-0">{summaryText(files)}</span>
        {branch && <span className="min-w-0 truncate text-muted-foreground">{branch}</span>}
        <span className="ml-auto shrink-0 text-muted-foreground">{failed ? 'Changes couldn\'t be read' : <Checked checkedAt={checkedAt} />}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button aria-label="Refresh changes" className="size-7 shrink-0" onClick={refresh} size="icon" type="button" variant="ghost">
              <RefreshCw aria-hidden className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Refresh changes</TooltipContent>
        </Tooltip>
      </div>
      <div className="shrink-0 border-b border-sidebar-border">
        <button
          aria-expanded={listOpen}
          className="flex h-7 w-full items-center gap-1.5 px-3 text-left text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring hover:text-foreground"
          onClick={() => setListOpen((open) => !open)}
          type="button"
        >
          {listOpen ? <ChevronDown aria-hidden className="size-3.5" /> : <ChevronRight aria-hidden className="size-3.5" />}
          Changed files
        </button>
        {listOpen && <FileList files={files} onJump={(path) => setJumpTo((previous) => ({ path, token: (previous?.token ?? 0) + 1 }))} />}
      </div>
      <div className="min-h-0 flex-1">
        <DiffStream files={files} jumpTo={jumpTo} onOpenFile={onOpenFile} root={root} />
      </div>
    </div>
  );
}

function FileList({ files, onJump }: { files: ChangedFile[]; onJump: (path: string) => void }) {
  return (
    <ul aria-label="Changed files" className="max-h-40 overflow-auto px-1 pb-1 text-xs">
      {files.map((file) => (
        <li key={file.path}>
          <button
            className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left focus-visible:outline-2 focus-visible:outline-ring hover:bg-sidebar-accent"
            onClick={() => onJump(file.path)}
            type="button"
          >
            <span aria-hidden className="w-3 shrink-0 text-center font-mono text-muted-foreground">{statusLetter(file.status)}</span>
            <span className="min-w-0 flex-1 truncate">{displayPath(file)}</span>
            <span className="shrink-0 text-muted-foreground">{countsText(file.added, file.removed)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "Checked Ns ago", counted from the last read that finished, redrawn each second. */
function Checked({ checkedAt }: { checkedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [checkedAt]);
  if (checkedAt === null) return null;
  const seconds = Math.max(0, Math.floor((now - checkedAt) / 1000));
  return <>{seconds < 1 ? 'Checked just now' : `Checked ${seconds}s ago`}</>;
}
