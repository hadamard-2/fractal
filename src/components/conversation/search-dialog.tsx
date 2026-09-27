import { Search, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { NavSelection } from '@/components/sidebar-03/nav-main';
import type { ProjectConversationGroup } from '@/shared/conversation-contract';

export function SearchDialog({
  groups,
  open,
  onOpenChange,
  onSelect,
}: {
  groups: ProjectConversationGroup[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (item: NavSelection) => void;
}) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return groups.flatMap((group) => group.conversations
      .filter((conversation) => !needle || [
        conversation.title,
        group.displayName,
        group.projectPath,
        conversation.ref.provider === 'claude' ? 'Claude Code' : 'Codex',
        conversation.ref.nativeSessionId,
      ].some((value) => value.toLowerCase().includes(needle)))
      .map((conversation) => ({ group, conversation })))
      .sort((left, right) => right.conversation.updatedAt - left.conversation.updatedAt);
  }, [groups, query]);

  const changeOpen = (next: boolean) => {
    if (!next) setQuery('');
    onOpenChange(next);
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogContent
        className="flex h-[min(600px,calc(100svh-3rem))] w-[min(680px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-xl border border-border/60 bg-popover p-0 shadow-2xl"
        overlayClassName="bg-black/45 backdrop-blur-sm"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Search conversations</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border/60 px-4">
          <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            aria-label="Search conversations"
            autoFocus
            className="h-14 min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search…"
            ref={inputRef}
            role="searchbox"
            type="text"
            value={query}
          />
          {query && (
            <button
              aria-label="Clear search"
              className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              type="button"
            >
              <X aria-hidden className="size-4" />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <p className="px-2 pb-2.5 text-sm text-muted-foreground">{query.trim() ? 'Results' : 'Recent chats'}</p>
          {results.length === 0 ? (
            <p className="px-2 py-7 text-center text-sm text-muted-foreground" role="status">No conversations found.</p>
          ) : (
            <div className="space-y-1">
              {results.map(({ group, conversation }) => (
                <button
                  className="flex w-full items-center gap-3 rounded-md px-2.5 py-2.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  key={`${conversation.ref.provider}:${conversation.ref.nativeSessionId}:${conversation.ref.projectPath}`}
                  onClick={() => {
                    onSelect({ ref: conversation.ref, title: conversation.title, section: group.displayName, runtime: conversation.runtime });
                    changeOpen(false);
                  }}
                  type="button"
                >
                  <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                  <span className="max-w-[35%] truncate text-xs text-muted-foreground">{group.displayName}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
