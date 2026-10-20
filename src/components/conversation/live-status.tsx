import { useEffect, useState } from 'react';
import { Shimmer } from '@/components/ai-elements/shimmer';
import type { AgentAction, ConversationTurn } from '@/shared/conversation-contract';

/** What the agent is doing right now; `key` changes when a new activity starts, even under the same label. */
export interface LiveActivity {
  key: string;
  label: string;
}

// The statuses the turn projector counts as unfinished. Claude reports none between a tool call
// and its result, so its calls stay requested while they run.
const IN_PROGRESS = new Set<AgentAction['status']>(['requested', 'awaiting-approval', 'running']);

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

function actionLabel(action: AgentAction): string {
  switch (action.kind) {
    case 'command': return 'Running a command';
    case 'file-read': return `Reading ${baseName(action.path)}`;
    case 'file-edit': return `Editing ${baseName(action.path)}`;
    case 'search': return 'Searching';
    case 'tool': return `Using ${action.name}`;
    case 'subagent': return 'Running a subagent';
  }
}

/**
 * A run's activity from its own turn (undefined until that turn arrives): the most recent
 * unfinished action, else writing while prose is the latest block, else thinking. Once the turn
 * has finished there is none, though the agent can take a few seconds more to wind down.
 */
export function turnActivity(turn: ConversationTurn | undefined): LiveActivity | null {
  if (!turn) return { key: 'Thinking', label: 'Thinking' };
  if (turn.status !== 'active') return null;
  const current = turn.blocks
    .flatMap((block) => block.kind === 'work-packet' ? block.actions : [])
    .findLast((action) => IN_PROGRESS.has(action.status));
  if (current) return { key: current.id, label: actionLabel(current) };
  // Activity Fractal can't read says nothing about whether the agent is writing.
  const label = turn.blocks.findLast((block) => block.kind !== 'unsupported')?.kind === 'assistant-prose' ? 'Writing' : 'Thinking';
  return { key: label, label };
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * The activity line shown where a running reply continues. It times from when it mounted, so mount it
 * with the activity's `key`. (A live record can arrive without a timestamp, so the action's own
 * start time can't be trusted.)
 */
export function LiveStatus({ activity }: { activity: LiveActivity }) {
  const [mountedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div aria-label="Agent status" className="flex items-center text-sm text-muted-foreground" role="status">
      <Shimmer as="span">{activity.label}</Shimmer>
      {/* Hidden from assistive tech: a polite live region would otherwise announce every tick. */}
      <span aria-hidden className="whitespace-pre tabular-nums"> · {formatElapsed(now - mountedAt)}</span>
    </div>
  );
}
