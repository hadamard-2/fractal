import { ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { absoluteProjectPath } from '@/renderer/file-display';
import { FILTER_RESULT_LIMIT, filterPaths } from '@/renderer/file-filter';
import { useWatchedLoad } from '@/renderer/use-watched-load';
import { FILE_LIST_MAX_ENTRIES, type FileList } from '@/shared/files-contract';

export type OpenFile = (path: string, options: { pinned: boolean }) => void;

const listDirectory = (root: string, path: string) => window.fractal.files.listDirectory(root, path);
const join = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);
const indent = (depth: number): CSSProperties => ({ paddingLeft: 8 + depth * 12 });
const ROW = 'flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left focus-visible:outline-2 focus-visible:outline-ring enabled:hover:bg-sidebar-accent';

type TreeProps = { root: string; expanded: ReadonlySet<string>; onToggle: (path: string) => void; selectedPath: string | null; onOpen: OpenFile };

export function FileTree({ root, selectedPath, onOpen }: { root: string; selectedPath: string | null; onOpen: OpenFile }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const onToggle = (path: string) => setExpanded((previous) => {
    const next = new Set(previous);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 p-2">
        <Input
          aria-label="Filter files"
          className="h-7 text-xs"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') setQuery(''); }}
          placeholder="Filter files…"
          value={query}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2 text-sm">
        {query.trim()
          ? <FilterResults onOpen={onOpen} query={query} root={root} selectedPath={selectedPath} />
          : <FolderNode depth={0} expanded={expanded} onOpen={onOpen} onToggle={onToggle} path="" root={root} selectedPath={selectedPath} />}
      </div>
    </div>
  );
}

// Mounted while its folder is expanded, so the folder is loaded and watched exactly as long as it is shown.
function FolderNode({ path, depth, ...props }: TreeProps & { path: string; depth: number }) {
  const loaded = useWatchedLoad(props.root, path, listDirectory);
  if (loaded.status === 'loading') return depth === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p> : null;
  if (loaded.status === 'failed') return <p className="py-1 text-xs text-muted-foreground" style={indent(depth)}>Couldn&apos;t read this folder</p>;
  return (
    <ul>
      {loaded.value.map((entry) => {
        const childPath = join(path, entry.name);
        if (entry.kind === 'file') {
          return (
            <li key={entry.name}>
              <FileRow depth={depth} ignored={entry.ignored} label={entry.name} onOpen={props.onOpen} outside={entry.outside} path={childPath} root={props.root} selected={childPath === props.selectedPath} />
            </li>
          );
        }
        const open = props.expanded.has(childPath);
        const Icon = open ? FolderOpen : Folder;
        return (
          <li key={entry.name}>
            <button
              aria-expanded={entry.outside ? undefined : open}
              className={cn(ROW, entry.ignored && 'text-muted-foreground', entry.outside && 'cursor-default opacity-60')}
              disabled={entry.outside}
              onClick={() => props.onToggle(childPath)}
              style={indent(depth)}
              title={entry.outside ? 'Outside the project' : undefined}
              type="button"
            >
              <ChevronRight aria-hidden className={cn('size-3.5 shrink-0 transition-transform', open && 'rotate-90')} />
              <Icon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{entry.name}</span>
            </button>
            {open && <FolderNode {...props} depth={depth + 1} path={childPath} />}
          </li>
        );
      })}
    </ul>
  );
}

function FileRow({ root, path, label, depth, ignored = false, outside = false, selected, onOpen }: {
  root: string; path: string; label: string; depth: number; ignored?: boolean; outside?: boolean; selected: boolean; onOpen: OpenFile;
}) {
  const row = (
    <button
      aria-current={selected ? 'true' : undefined}
      className={cn(ROW, selected && 'bg-sidebar-accent text-sidebar-accent-foreground', ignored && 'text-muted-foreground', outside && 'cursor-default opacity-60')}
      disabled={outside}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        onOpen(path, { pinned: true });
      }}
      onClick={() => onOpen(path, { pinned: false })}
      onDoubleClick={() => onOpen(path, { pinned: true })}
      // A middle press would otherwise paste the primary selection on Linux.
      onMouseDown={(event: MouseEvent) => { if (event.button === 1) event.preventDefault(); }}
      style={indent(depth)}
      title={outside ? 'Outside the project' : path}
      type="button"
    >
      <span aria-hidden className="size-3.5 shrink-0" />
      <File aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
  if (outside) return row;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onOpen(path, { pinned: true })}>Open in new tab</ContextMenuItem>
        <ContextMenuItem onSelect={() => { void navigator.clipboard.writeText(absoluteProjectPath(root, path)); }}>Copy path</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// Mounted while the filter has text: the list is fetched each time the filter opens, then filtered locally.
function FilterResults({ root, query, selectedPath, onOpen }: { root: string; query: string; selectedPath: string | null; onOpen: OpenFile }) {
  const [list, setList] = useState<FileList | 'loading' | 'failed'>('loading');
  useEffect(() => {
    let current = true;
    window.fractal.files.listFiles(root).then(
      (value) => { if (current) setList(value); },
      () => { if (current) setList('failed'); },
    );
    return () => { current = false; };
  }, [root]);
  const matches = useMemo(() => (typeof list === 'object' ? filterPaths(list.paths, query, FILTER_RESULT_LIMIT) : []), [list, query]);
  if (list === 'loading') return <p className="px-2 py-1 text-xs text-muted-foreground">Listing files…</p>;
  if (list === 'failed') return <p className="px-2 py-1 text-xs text-muted-foreground">Couldn&apos;t list this project&apos;s files</p>;
  return (
    <>
      {matches.length === 0
        ? <p className="px-2 py-1 text-xs text-muted-foreground">No matching files</p>
        : (
          <ul>
            {matches.map((path) => (
              <li key={path}><FileRow depth={0} label={path} onOpen={onOpen} path={path} root={root} selected={path === selectedPath} /></li>
            ))}
          </ul>
        )}
      {list.truncated && <p className="px-2 pt-2 text-xs text-muted-foreground">Searched the first {FILE_LIST_MAX_ENTRIES.toLocaleString('en-US')} files.</p>}
    </>
  );
}
