import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { BlockingRequest as BlockingRequestData, UserDecision } from '@/shared/conversation-contract';

type ResolveRequest = (requestId: string, decision: UserDecision) => void | Promise<void>;

export function BlockingRequest({ request, onResolve }: { request: BlockingRequestData; onResolve: ResolveRequest }) {
  const submittedFor = useRef<string | null>(null);
  const [, setSubmitted] = useState(false);
  const [denialReason, setDenialReason] = useState('');
  const [freeText, setFreeText] = useState('');
  const disabled = submittedFor.current === request.id || request.status === 'resolved';

  const resolve = (decision: UserDecision) => {
    if (submittedFor.current === request.id || request.status === 'resolved') return;
    submittedFor.current = request.id;
    setSubmitted(true);
    void Promise.resolve(onResolve(request.id, decision)).catch((): void => undefined);
  };

  if (request.status === 'resolved') {
    return <section className="rounded-md border px-3 py-2 text-sm text-muted-foreground" aria-label="Resolved request">Decision received</section>;
  }

  if (request.kind === 'approval') {
    return (
      <section className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3" aria-label="Approval request">
        <div>
          <p className="font-medium">{request.title}</p>
          <p className="mt-1 break-words font-mono text-sm">{request.operation}</p>
        </div>
        <label className="block space-y-1 text-sm">
          <span>Denial reason</span>
          <Textarea className="min-h-14" disabled={disabled} onChange={(event) => setDenialReason(event.target.value)} value={denialReason} />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={() => resolve({ kind: 'allow-once' })} size="sm" type="button">Allow once</Button>
          {request.rememberScope !== undefined && <Button disabled={disabled} onClick={() => resolve({ kind: 'allow-and-remember', scope: request.rememberScope })} size="sm" type="button" variant="secondary">Allow and remember</Button>}
          <Button disabled={disabled} onClick={() => resolve(denialReason.trim() ? { kind: 'deny', reason: denialReason.trim() } : { kind: 'deny' })} size="sm" type="button" variant="outline">Deny</Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-3" aria-label="Question request">
      <p className="font-medium">{request.prompt}</p>
      {request.choices !== undefined && request.choices.length > 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Choices">
          {request.choices.map((choice) => <Button disabled={disabled} key={choice.value} onClick={() => resolve({ kind: 'answer', answers: { [request.fieldId]: choice.value } })} size="sm" type="button" variant="secondary">{choice.label}</Button>)}
        </div>
      )}
      {request.allowFreeText && (
        <form className="flex gap-2" onSubmit={(event) => {
          event.preventDefault();
          const answer = freeText.trim();
          if (answer) resolve({ kind: 'answer', answers: { [request.fieldId]: answer } });
        }}>
          <label className="sr-only" htmlFor={`request-${request.id}-answer`}>Other answer</label>
          <Textarea className="min-h-14 flex-1" disabled={disabled} id={`request-${request.id}-answer`} onChange={(event) => setFreeText(event.target.value)} value={freeText} />
          <Button disabled={disabled || !freeText.trim()} size="sm" type="submit">Submit answer</Button>
        </form>
      )}
    </section>
  );
}
