import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { BlockingRequest as BlockingRequestData, UserDecision } from '@/shared/conversation-contract';
import { PlanText } from './plan-block';
import { QuestionRequest, ResolvedQuestions } from './question-request';

type ResolveRequest = (requestId: string, decision: UserDecision) => void | Promise<void>;

function DecisionAudit({ decision }: { decision: UserDecision | undefined }) {
  if (decision === undefined) return null;
  switch (decision.kind) {
    case 'allow-once': return <p>allow-once</p>;
    case 'allow-and-remember': return <><p>allow-and-remember</p><pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">{decision.scope}</pre></>;
    case 'deny': return <><p>deny</p>{decision.reason !== undefined && <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs">{decision.reason}</pre>}</>;
    case 'answer': return null;
  }
}

function ApprovalOperation({ operation }: { operation: string }) {
  return <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-sm">{operation}</pre>;
}

function BlockingRequestContent({ request, onResolve }: { request: BlockingRequestData; onResolve: ResolveRequest }) {
  const submittedFor = useRef<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [denialReason, setDenialReason] = useState('');
  const disabled = submitted || submittedFor.current === request.id || request.status === 'resolved';

  const resolve = (decision: UserDecision) => {
    if (submittedFor.current === request.id || request.status === 'resolved') return;
    submittedFor.current = request.id;
    setSubmitted(true);
    try {
      void Promise.resolve(onResolve(request.id, decision)).catch((): void => undefined);
    } catch {
      // Native resolution remains the only state that clears a submitted request.
    }
  };

  if (request.status === 'resolved') {
    if (request.kind === 'approval') {
      return <section aria-label="Resolved approval request" className="space-y-2 rounded-md border px-3 py-2 text-sm text-muted-foreground"><p className="font-medium text-foreground">{request.title}</p><ApprovalOperation operation={request.operation} /><DecisionAudit decision={request.decision} /></section>;
    }
    return <ResolvedQuestions request={request} />;
  }

  if (request.kind === 'approval' && request.plan !== undefined) {
    const feedback = denialReason.trim();
    return (
      <section className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3" aria-label="Plan review">
        <div>
          <p className="font-medium">{request.title}</p>
          {request.operation !== 'ExitPlanMode' && <p className="truncate font-mono text-xs text-muted-foreground">{request.operation}</p>}
        </div>
        <div className="max-h-[50vh] overflow-y-auto rounded-md border bg-background px-3 py-2">
          {request.plan ? <PlanText text={request.plan} /> : <p className="text-sm text-muted-foreground">The agent asked for approval before writing its plan.</p>}
        </div>
        <label className="block space-y-1 text-sm"><span>What should change?</span><Textarea className="min-h-14" disabled={disabled} onChange={(event) => setDenialReason(event.target.value)} value={denialReason} /></label>
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={() => resolve({ kind: 'allow-once' })} size="sm" type="button">Approve plan</Button>
          <Button disabled={disabled || !feedback} onClick={() => resolve({ kind: 'deny', reason: feedback })} size="sm" type="button" variant="outline">Request changes</Button>
        </div>
      </section>
    );
  }

  if (request.kind === 'approval') {
    return (
      <section className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3" aria-label="Approval request">
        <div><p className="font-medium">{request.title}</p><ApprovalOperation operation={request.operation} /></div>
        <label className="block space-y-1 text-sm"><span>Denial reason</span><Textarea className="min-h-14" disabled={disabled} onChange={(event) => setDenialReason(event.target.value)} value={denialReason} /></label>
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={() => resolve({ kind: 'allow-once' })} size="sm" type="button">Allow once</Button>
          {request.rememberScope !== undefined && <Button disabled={disabled} onClick={() => resolve({ kind: 'allow-and-remember', scope: request.rememberScope })} size="sm" type="button" variant="secondary">Allow and remember</Button>}
          <Button disabled={disabled} onClick={() => resolve(denialReason.trim() ? { kind: 'deny', reason: denialReason.trim() } : { kind: 'deny' })} size="sm" type="button" variant="outline">Deny</Button>
        </div>
      </section>
    );
  }

  return <QuestionRequest disabled={disabled} onResolve={resolve} request={request} />;
}

export function BlockingRequest({ request, onResolve }: { request: BlockingRequestData; onResolve: ResolveRequest }) {
  return <BlockingRequestContent key={request.id} onResolve={onResolve} request={request} />;
}
