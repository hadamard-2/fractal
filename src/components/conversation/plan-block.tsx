import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { MessageResponse } from '@/components/ai-elements/message';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { PlanProposal, TurnBlock } from '@/shared/conversation-contract';

type PlanBlockData = Extract<TurnBlock, { kind: 'plan' }>;

const STATUS_LABEL: Record<PlanProposal['status'], string> = {
  proposed: 'Waiting for review',
  approved: 'Approved',
  rejected: 'Not approved',
  interrupted: 'Not reviewed',
};

export function planSummary(proposals: PlanProposal[]): string {
  const latest = proposals.at(-1);
  if (!latest) return 'Plan';
  const revisions = proposals.length - 1;
  if (revisions === 0) return `Plan · ${STATUS_LABEL[latest.status]}`;
  return latest.status === 'approved'
    ? `Plan · Approved after ${revisions} ${revisions === 1 ? 'revision' : 'revisions'}`
    : `Plan · ${STATUS_LABEL[latest.status]} · draft ${proposals.length}`;
}

// Plans lead with document-level headings; at chat size they'd outweigh the turn around them.
const PLAN_TEXT = 'max-w-none text-sm leading-6 wrap-anywhere [&_:is(h1,h2,h3,h4,h5,h6)]:mt-4 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&_:is(h1,h2,h3,h4,h5,h6)]:text-sm [&_:is(h1,h2,h3,h4,h5,h6)]:leading-6 [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_h1]:text-base';

export function PlanText({ text }: { text: string | undefined }) {
  return text
    ? <MessageResponse className={PLAN_TEXT}>{text}</MessageResponse>
    : <p className="text-sm text-muted-foreground">The plan text wasn't recorded.</p>;
}

function Feedback({ text }: { text: string }) {
  return (
    <div className="space-y-1 text-sm">
      <p className="text-muted-foreground">Feedback</p>
      <p className="whitespace-pre-wrap wrap-anywhere">{text}</p>
    </div>
  );
}

function EarlierDraft({ proposal, number }: { proposal: PlanProposal; number: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground">
        <ChevronRight aria-hidden className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="truncate">Draft {number}{proposal.feedback ? `: ${proposal.feedback}` : ` · ${STATUS_LABEL[proposal.status]}`}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 ml-2 space-y-3 border-l pl-4">
        <PlanText text={proposal.text} />
        {proposal.feedback && <Feedback text={proposal.feedback} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

export function PlanBlock({ plan }: { plan: PlanBlockData }) {
  const [open, setOpen] = useState(false);
  const latest = plan.proposals.at(-1);
  const earlier = plan.proposals.slice(0, -1);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground">
        <ChevronRight aria-hidden className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />
        <span>{planSummary(plan.proposals)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 ml-2 space-y-4 border-l pl-4" aria-label="Agent plan">
        <PlanText text={latest?.text} />
        {latest?.status !== 'approved' && latest?.feedback && <Feedback text={latest.feedback} />}
        {earlier.length > 0 && (
          <div className="space-y-2">
            {earlier.map((proposal, index) => <EarlierDraft key={proposal.id} number={index + 1} proposal={proposal} />)}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
