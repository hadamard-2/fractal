import { Copy, MoreHorizontal, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { conversationKey, type ConversationRuntime, type ConversationSummary, type HarnessCapabilities } from '@/shared/conversation-contract';

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

function claudeCapabilityGap(summary: ConversationSummary, capabilities: HarnessCapabilities | null): string | null {
  if (summary.ref.provider !== 'claude' || capabilities === null) return null;
  const missing: string[] = [];
  if (!capabilities.approvals) missing.push('approval');
  if (!capabilities.questions) missing.push('question');
  if (missing.length === 0) return null;
  const subject = missing.length === 2 ? 'approval and question routing are' : `${missing[0]} routing is`;
  return `Claude ${subject} unavailable. Fractal will not bypass native permissions.`;
}

function copy(value: string): void {
  try {
    void Promise.resolve(navigator.clipboard?.writeText(value)).catch((): void => undefined);
  } catch {
    // Clipboard access is optional; a rejected browser permission must stay local to this menu.
  }
}

type InterruptAttempt = { conversationId: string; token: number };

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
  const conversationId = conversationKey(summary.ref);
  const [interruptAttempt, setInterruptAttempt] = useState<InterruptAttempt | null>(null);
  const nextInterruptToken = useRef(0);
  const previousNativeState = useRef({ conversationId, runtime });
  const canInterrupt = capabilities?.interrupt === true && runtime === 'active-in-fractal' && onInterrupt !== undefined;
  const readOnlyReason = composerReadOnlyReason(runtime);
  const capabilityGap = claudeCapabilityGap(summary, capabilities);
  const interrupting = interruptAttempt?.conversationId === conversationId;

  useEffect(() => {
    const previous = previousNativeState.current;
    if (previous.conversationId === conversationId && previous.runtime !== runtime) {
      setInterruptAttempt((current) => current?.conversationId === conversationId ? null : current);
    }
    previousNativeState.current = { conversationId, runtime };
  }, [conversationId, runtime]);

  const interrupt = () => {
    if (!onInterrupt || interrupting) return;
    const attempt = { conversationId, token: ++nextInterruptToken.current };
    setInterruptAttempt(attempt);
    const clearRejectedAttempt = () => {
      setInterruptAttempt((current) => current?.conversationId === attempt.conversationId && current.token === attempt.token ? null : current);
    };
    try {
      void Promise.resolve(onInterrupt()).catch(clearRejectedAttempt);
    } catch {
      clearRejectedAttempt();
    }
  };

  return (
    <header className="flex items-center gap-3 border-b px-4 py-2" aria-label="Conversation details">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">{projectName(summary.ref.projectPath)}</p>
        <h2 className="truncate font-medium text-sm">{summary.title}</h2>
        <p className="text-xs text-muted-foreground">{summary.ref.provider} · {runtime.replaceAll('-', ' ')} · {summary.captureCompleteness} capture</p>
        {readOnlyReason !== null && <p className="mt-1 text-xs text-muted-foreground">{readOnlyReason}</p>}
        {capabilityGap !== null && <p className="mt-1 text-xs text-muted-foreground" role="status">{capabilityGap}</p>}
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
