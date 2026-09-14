import { ChevronRight, CircleAlert, CircleCheck, CirclePause, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { AgentAction as AgentActionData, CaptureCompleteness, ProviderId } from '@/shared/conversation-contract';

const actionLabel = (action: AgentActionData): string => {
  switch (action.kind) {
    case 'file-read': return `Read ${action.path}`;
    case 'file-edit': return `Edited ${action.path}`;
    case 'command': return action.command;
    case 'search': return `Searched ${action.query}`;
    case 'tool': return action.name;
    case 'subagent': return action.label;
  }
};

const actionState = (action: AgentActionData): string => {
  switch (action.status) {
    case 'requested': return 'requested';
    case 'awaiting-approval': return 'awaiting approval';
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'denied': return 'denied';
    case 'interrupted': return 'interrupted';
  }
};

function StatusIcon({ status }: { status: AgentActionData['status'] }) {
  if (status === 'running') return <LoaderCircle aria-hidden className="size-3.5 animate-spin" />;
  if (status === 'failed' || status === 'denied') return <CircleAlert aria-hidden className="size-3.5 text-destructive" />;
  if (status === 'interrupted') return <CirclePause aria-hidden className="size-3.5" />;
  if (status === 'completed') return <CircleCheck aria-hidden className="size-3.5" />;
  return <span aria-hidden className="size-3.5 rounded-full border" />;
}

function CompletenessNotice({ completeness }: { completeness: CaptureCompleteness }) {
  if (completeness === 'complete') return null;
  return <p className="text-xs text-muted-foreground">Capture is {completeness}; details may be incomplete.</p>;
}

function ActionDetails({ action }: { action: AgentActionData }) {
  switch (action.kind) {
    case 'file-read':
      return <p className="font-mono text-xs text-muted-foreground">{action.path}</p>;
    case 'file-edit':
      return <>
        <p className="font-mono text-xs text-muted-foreground">{action.path}</p>
        {action.patch !== undefined && <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{action.patch}</pre>}
      </>;
    case 'command':
      return <>
        {action.cwd !== undefined && <p className="font-mono text-xs text-muted-foreground">{action.cwd}</p>}
        {action.output !== undefined && <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{action.output}</pre>}
        {action.exitCode !== undefined && <p className="text-xs text-muted-foreground">Exit status: {action.exitCode}</p>}
      </>;
    case 'search':
      return <>
        {action.scope !== undefined && <p className="text-xs text-muted-foreground">Scope: {action.scope}</p>}
        {action.resultSummary !== undefined && <p className="text-sm">{action.resultSummary}</p>}
      </>;
    case 'tool':
      return <>
        <p className="text-sm">{action.inputSummary}</p>
        {action.outputSummary !== undefined && <p className="text-sm text-muted-foreground">{action.outputSummary}</p>}
      </>;
    case 'subagent':
      return action.actions.length > 0
        ? <ol className="ml-2 space-y-2 border-l pl-3"><AgentActions actions={action.actions} /></ol>
        : null;
  }
}

export function AgentAction({ action }: { action: AgentActionData }) {
  return (
    <li className={cn('space-y-1', (action.status === 'failed' || action.status === 'denied') && 'text-destructive')}>
      <div className="flex items-start gap-2">
        <StatusIcon status={action.status} />
        <div className="min-w-0 flex-1">
          <p className="break-words font-mono text-sm">{actionLabel(action)}</p>
          <p className="text-xs text-muted-foreground">{actionState(action)}</p>
        </div>
      </div>
      <div className="ml-5 space-y-2">
        <ActionDetails action={action} />
        <CompletenessNotice completeness={action.captureCompleteness} />
      </div>
    </li>
  );
}

export function AgentActions({ actions }: { actions: AgentActionData[] }) {
  return <>{actions.map((action) => <AgentAction key={action.id} action={action} />)}</>;
}

export function UnsupportedActivity({
  provider,
  nativeType,
  summary,
  captureCompleteness,
}: {
  provider: ProviderId;
  nativeType: string;
  summary: string;
  captureCompleteness: CaptureCompleteness;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible className="rounded border border-dashed px-3 py-2 text-muted-foreground" onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 text-left text-xs">
        <ChevronRight aria-hidden className={cn('size-3 transition-transform', open && 'rotate-90')} />
        Unsupported {provider} activity: {nativeType}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1 pt-2 text-xs">
        <p>{summary}</p>
        <CompletenessNotice completeness={captureCompleteness} />
      </CollapsibleContent>
    </Collapsible>
  );
}
