import { Folder, FolderOpen } from 'lucide-react';
import { useMemo } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { StartTarget } from '@/components/conversation/use-start-conversation';
import type { ProjectConversationGroup } from '@/shared/conversation-contract';

/**
 * Where a new conversation should start, asked when nothing is selected to
 * infer it from. Known projects come first, most recently active on top; the
 * last row hands off to the main process's folder picker for anywhere else.
 */
export function ProjectPickerDialog({
  projects,
  open,
  onOpenChange,
  onPick,
}: {
  projects: ProjectConversationGroup[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (target: StartTarget) => void;
}) {
  const recent = useMemo(() => {
    const lastActive = (project: ProjectConversationGroup) => Math.max(0, ...project.conversations.map((conversation) => conversation.updatedAt));
    return [...projects].sort((left, right) => lastActive(right) - lastActive(left));
  }, [projects]);

  const pick = (target: StartTarget) => {
    onOpenChange(false);
    onPick(target);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex max-h-[min(520px,calc(100svh-3rem))] w-[min(480px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden rounded-xl border border-border/60 bg-popover p-0 shadow-2xl"
        overlayClassName="bg-black/45 backdrop-blur-sm"
        showCloseButton={false}
      >
        <div className="border-b border-border/60 px-5 py-4">
          <DialogTitle className="text-base">New conversation</DialogTitle>
          <DialogDescription>Choose the project to start it in.</DialogDescription>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3">
          {recent.map((project) => (
            <button
              className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              key={project.projectPath}
              onClick={() => pick({ name: project.displayName, path: project.projectPath })}
              type="button"
            >
              <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{project.displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">{project.projectPath}</span>
              </span>
            </button>
          ))}
          <button
            className="flex w-full items-center gap-3 rounded-md px-2.5 py-2.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none"
            onClick={() => pick(null)}
            type="button"
          >
            <FolderOpen aria-hidden className="size-4 shrink-0" />
            Choose another folder…
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
