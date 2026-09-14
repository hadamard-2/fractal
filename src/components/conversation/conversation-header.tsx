import { Copy, MoreHorizontal, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ConversationRuntime, ConversationSummary, HarnessCapabilities } from '@/shared/conversation-contract';

function projectName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

export function composerReadOnlyReason(runtime: ConversationRuntime): string | null {
  switch (runtime) {
    case 'active-externally': return 'This session is active outside Fractal, so the composer is read-only.';
    case 'unknown': return 'Fractal cannot verify this session is idle, so the composer is read-only.';
    case 'failed': return 'This session failed, so the composer is read-only.';
    default: return null;
  }
}

function copy(value: string): void {
  try {
    void Promise.resolve(navigator.clipboard?.writeText(value)).catch((): void => undefined);
  } catch {
    // Clipboard access is optional; a rejected browser permission must stay local to this menu.
  }
}

export function ConversationHeader({
  summary,
  capabilities,
  runtime = summary.runtime,
  onInterrupt,
}: {
  summary: ConversationSummary;
  capabilities: HarnessCapabilities | null;
  runtime?: ConversationRuntime;
  onInterrupt?: () => void | Promise<void>;
}) {
  const [interrupting, setInterrupting] = useState(false);
  const canInterrupt = capabilities?.interrupt === true && runtime === 'active-in-fractal' && onInterrupt !== undefined;
  const readOnlyReason = composerReadOnlyReason(runtime);

  useEffect(() => { setInterrupting(false); }, [runtime]);

  const interrupt = () => {
    if (!onInterrupt || interrupting) return;
    setInterrupting(true);
    try {
      void Promise.resolve(onInterrupt()).catch(() => { setInterrupting(false); });
    } catch {
      setInterrupting(false);
    }
  };

  return (
    <header className="flex items-center gap-3 border-b px-4 py-2" aria-label="Conversation details">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">{projectName(summary.ref.projectPath)}</p>
        <h2 className="truncate font-medium text-sm">{summary.title}</h2>
        <p className="text-xs text-muted-foreground">{summary.ref.provider} · {runtime.replaceAll('-', ' ')} · {summary.captureCompleteness} capture</p>
        {readOnlyReason !== null && <p className="mt-1 text-xs text-muted-foreground">{readOnlyReason}</p>}
      </div>
      {canInterrupt && <Button aria-label="Interrupt session" disabled={interrupting} onClick={interrupt} size="icon-sm" type="button" variant="ghost"><Square aria-hidden className="size-3" /></Button>}
      <DropdownMenu>
        <DropdownMenuTrigger asChild><Button aria-label="Conversation details menu" size="icon-sm" type="button" variant="ghost"><MoreHorizontal aria-hidden /></Button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => copy(summary.ref.nativeSessionId)}><Copy aria-hidden />Copy session ID</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => copy(summary.ref.projectPath)}><Copy aria-hidden />Copy project path</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
