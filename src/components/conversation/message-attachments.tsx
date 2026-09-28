import { code } from '@streamdown/code';
import { FileIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { AttachmentPreview, UserMessageAttachment } from '@/shared/conversation-contract';
import { useAttachmentPreviews } from './attachment-preview-context';
import { ConversationImages } from './conversation-images';
import { HighlightedCommand } from './highlighted-command';

type Loaded = { status: 'loading' } | { status: 'ready'; preview: AttachmentPreview } | { status: 'failed' };

const basename = (path: string): string => path.split(/[\\/]/).pop() || path;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function languageFor(path: string) {
  const extension = basename(path).split('.').pop()?.toLowerCase() ?? '';
  return extension && code.supportsLanguage(extension as never) ? extension as Parameters<typeof code.supportsLanguage>[0] : undefined;
}

function usePreview(path: string, fresh = false): Loaded {
  const previews = useAttachmentPreviews();
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    setLoaded({ status: 'loading' });
    previews.load(path, fresh).then(
      (preview) => { if (current) setLoaded({ status: 'ready', preview }); },
      () => { if (current) setLoaded({ status: 'failed' }); },
    );
    return () => { current = false; };
  }, [path, fresh, previews]);
  return loaded;
}

/** Attachments on a sent user message: images as thumbnails, everything else as chips that open a preview. */
export function MessageAttachments({ attachments, sentAt }: { attachments: UserMessageAttachment[]; sentAt?: number }) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {attachments.map((attachment) => attachment.kind === 'image'
        ? <AttachmentThumbnail key={attachment.path} path={attachment.path} sentAt={sentAt} />
        : <AttachmentChip key={attachment.path} path={attachment.path} sentAt={sentAt} />)}
    </div>
  );
}

function AttachmentThumbnail({ path, sentAt }: { path: string; sentAt?: number }) {
  const loaded = usePreview(path);
  if (loaded.status === 'loading') return <div aria-hidden className="h-28 w-28 animate-pulse rounded-lg border bg-muted/30" />;
  if (loaded.status === 'ready' && loaded.preview.kind === 'image') return <ConversationImages images={[loaded.preview.image]} />;
  return <AttachmentChip path={path} sentAt={sentAt} />;
}

function AttachmentChip({ path, sentAt }: { path: string; sentAt?: number }) {
  const loaded = usePreview(path);
  const missing = loaded.status === 'ready' && loaded.preview.kind === 'missing';
  const name = basename(path);
  return (
    <Dialog>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger
              aria-label={`Preview ${name}`}
              className={cn('flex h-8 max-w-60 items-center gap-1.5 rounded-md border px-2 text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none', missing && 'opacity-60')}
            >
              <FileIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{name}</span>
              {missing && <span className="shrink-0 text-xs text-muted-foreground">missing</span>}
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent>{path}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogContent className="flex max-h-[88vh] w-[min(56rem,94vw)] max-w-none flex-col gap-3 sm:max-w-none">
        <AttachmentDialogBody path={path} sentAt={sentAt} />
      </DialogContent>
    </Dialog>
  );
}

function AttachmentDialogBody({ path, sentAt }: { path: string; sentAt?: number }) {
  // Opening the dialog re-reads the file so it shows what is on disk now.
  const loaded = usePreview(path, true);
  const previews = useAttachmentPreviews();
  const preview = loaded.status === 'ready' ? loaded.preview : undefined;
  const exists = preview !== undefined && preview.kind !== 'missing';
  const modified = exists && sentAt !== undefined && preview.modifiedAt > sentAt;
  return (
    <>
      <div className="min-w-0 space-y-1">
        <DialogTitle className="truncate text-sm font-medium">{basename(path)}</DialogTitle>
        <DialogDescription className="truncate font-mono text-xs">{path}{exists ? ` · ${formatSize(preview.size)}` : ''}</DialogDescription>
      </div>
      {modified && <p className="text-xs text-amber-600 dark:text-amber-400" role="status">Modified since this message was sent</p>}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/20">
        {loaded.status === 'loading' && <p className="p-4 text-sm text-muted-foreground">Reading file…</p>}
        {loaded.status === 'failed' && <p className="p-4 text-sm text-destructive">This file could not be read.</p>}
        {preview?.kind === 'missing' && <p className="p-4 text-sm text-muted-foreground">This file no longer exists at this path.</p>}
        {preview?.kind === 'binary' && <p className="p-4 text-sm text-muted-foreground">No preview for this file type.</p>}
        {preview?.kind === 'image' && <img alt="" className="mx-auto max-h-[70vh] object-contain" src={`data:${preview.image.mediaType};base64,${preview.image.data}`} />}
        {preview?.kind === 'text' && (languageFor(path)
          ? <HighlightedCommand className="p-4 text-xs leading-5" command={preview.text} language={languageFor(path)} />
          : <pre className="p-4 font-mono text-xs leading-5 whitespace-pre-wrap">{preview.text}</pre>)}
      </div>
      {preview?.kind === 'text' && preview.truncated && <p className="text-xs text-muted-foreground">Showing the first 256 KiB of {formatSize(preview.size)}.</p>}
      <div className="flex justify-end gap-2">
        <Button disabled={!exists} onClick={() => { void previews.open(path, 'reveal'); }} size="sm" type="button" variant="outline">Show in folder</Button>
        <Button disabled={!exists} onClick={() => { void previews.open(path, 'open'); }} size="sm" type="button">Open with default app</Button>
      </div>
    </>
  );
}
