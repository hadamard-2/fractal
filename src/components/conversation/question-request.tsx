import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { MOD_KEY_LABEL } from '@/renderer/shortcuts';
import type { BlockingRequest, QuestionField, UserDecision } from '@/shared/conversation-contract';

type QuestionRequestData = Extract<BlockingRequest, { kind: 'question' }>;

/** What the user has picked for one question so far. `other` is whether the typed answer counts. */
interface Draft { picked: string[]; other: boolean; otherText: string }

const EMPTY_DRAFT: Draft = { picked: [], other: false, otherText: '' };

export const SKIPPED_ALL = 'The user skipped the questions';
export const DISMISSED = 'The user dismissed the question';

/** The answer a draft gives, or undefined when it gives none. Several picks join with ", ". */
function answerFor(question: QuestionField, draft: Draft): string | undefined {
  const typed = draft.other ? draft.otherText.trim() : '';
  const parts = [...(question.choices ?? []).filter((choice) => draft.picked.includes(choice.value)).map((choice) => choice.value), ...(typed ? [typed] : [])];
  return parts.length ? parts.join(', ') : undefined;
}

function Kbd({ children, className }: { children: string; className?: string }) {
  return <kbd className={cn('rounded border border-border px-1.5 py-px font-mono text-[11px] font-medium text-subtle-foreground', className)}>{children}</kbd>;
}

function OptionRow({ checked, description, disabled, label, multiSelect, number, onSelect }: {
  checked: boolean; description?: string; disabled: boolean; label: string; multiSelect: boolean; number: number; onSelect(): void;
}) {
  return (
    <button
      aria-checked={checked}
      className={cn(
        'flex w-full items-center gap-3 rounded-md border border-transparent bg-muted/60 px-3 py-2 text-left transition-colors hover:bg-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60',
        checked && 'border-primary/40 bg-primary/10 hover:bg-primary/15',
      )}
      disabled={disabled}
      onClick={onSelect}
      role={multiSelect ? 'checkbox' : 'radio'}
      type="button"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block text-xs text-muted-foreground">{description}</span>}
      </span>
      {checked ? <Check aria-hidden className="size-3.5 text-primary-text" /> : null}
      <Kbd>{String(number)}</Kbd>
    </button>
  );
}

export function QuestionRequest({ request, disabled, onResolve }: { request: QuestionRequestData; disabled: boolean; onResolve(decision: UserDecision): void }) {
  const { questions } = request;
  const [step, setStep] = useState(0);
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => EMPTY_DRAFT));
  const [collapsed, setCollapsed] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);

  // The card takes focus when it opens so its number keys and Ctrl+Enter work straight away.
  useEffect(() => { cardRef.current?.focus({ preventScroll: true }); }, []);

  const question = questions[step];
  const draft = drafts[step] ?? EMPTY_DRAFT;
  const choices = question.choices ?? [];
  const multiSelect = question.multiSelect === true;
  const last = step === questions.length - 1;
  const answered = answerFor(question, draft) !== undefined;

  const update = (change: (current: Draft) => Draft) => setDrafts((current) => current.map((item, index) => index === step ? change(item) : item));

  const pick = (value: string) => update((current) => multiSelect
    ? { ...current, picked: current.picked.includes(value) ? current.picked.filter((item) => item !== value) : [...current.picked, value] }
    : { ...current, picked: [value], other: false });

  const pickOther = () => {
    update((current) => multiSelect ? { ...current, other: !current.other } : { ...current, picked: [], other: true });
    otherRef.current?.focus();
  };

  const finish = (final: Draft[]) => {
    const answers = Object.fromEntries(questions.flatMap((item, index) => {
      const answer = answerFor(item, final[index] ?? EMPTY_DRAFT);
      return answer === undefined ? [] : [[item.fieldId, answer]];
    }));
    onResolve(Object.keys(answers).length ? { kind: 'answer', answers } : { kind: 'deny', reason: SKIPPED_ALL });
  };

  const advance = (final = drafts) => {
    if (last) finish(final);
    else setStep(step + 1);
  };

  const skip = () => {
    const final = drafts.map((item, index) => index === step ? EMPTY_DRAFT : item);
    setDrafts(final);
    advance(final);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled || collapsed) return;
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (answered) advance();
      return;
    }
    if (event.target instanceof HTMLInputElement || event.ctrlKey || event.metaKey || event.altKey) return;
    const number = Number(event.key);
    if (!Number.isInteger(number) || number < 1) return;
    if (number <= choices.length) { event.preventDefault(); pick(choices[number - 1].value); }
    else if (number === choices.length + 1 && question.allowFreeText && choices.length) { event.preventDefault(); pickOther(); }
  };

  const otherNumber = choices.length + 1;

  return (
    <section
      aria-label="Question request"
      className="overflow-hidden rounded-lg border bg-card shadow-sm outline-none"
      onKeyDown={onKeyDown}
      ref={cardRef}
      tabIndex={-1}
    >
      <header className="flex items-start gap-2 px-3 py-2.5">
        {questions.length > 1 && <span className="mt-px shrink-0 rounded bg-primary/15 px-1.5 py-px font-mono text-[11px] font-medium text-primary-text">{step + 1}/{questions.length}</span>}
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm font-medium">{question.prompt}</p>
        <Button aria-expanded={!collapsed} aria-label={collapsed ? 'Expand question' : 'Collapse question'} className="text-muted-foreground" onClick={() => setCollapsed(!collapsed)} size="icon-xs" type="button" variant="ghost">
          <ChevronDown aria-hidden className={cn('transition-transform', collapsed && 'rotate-180')} />
        </Button>
        <Button aria-label="Dismiss question" className="text-muted-foreground" disabled={disabled} onClick={() => onResolve({ kind: 'deny', reason: DISMISSED })} size="icon-xs" type="button" variant="ghost">
          <X aria-hidden />
        </Button>
      </header>
      {!collapsed && (
        <div className="space-y-1.5 px-3 pb-3">
          {choices.length > 0 && (
            <div aria-label={question.prompt} className="space-y-1.5" role={multiSelect ? 'group' : 'radiogroup'}>
              {choices.map((choice, index) => (
                <OptionRow checked={draft.picked.includes(choice.value)} description={choice.description} disabled={disabled} key={choice.value} label={choice.label} multiSelect={multiSelect} number={index + 1} onSelect={() => pick(choice.value)} />
              ))}
              {question.allowFreeText && <OptionRow checked={draft.other} disabled={disabled} label="Other" multiSelect={multiSelect} number={otherNumber} onSelect={pickOther} />}
            </div>
          )}
          {question.allowFreeText && (
            <Input
              aria-label={choices.length ? 'Other answer' : 'Answer'}
              className="h-8 text-sm"
              disabled={disabled}
              onChange={(event) => {
                const otherText = event.target.value;
                update((current) => multiSelect ? { ...current, otherText, other: otherText.trim() ? true : current.other } : { ...current, otherText, ...(otherText.trim() ? { other: true, picked: [] } : {}) });
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.shiftKey) return;
                event.preventDefault();
                if (answered) advance();
              }}
              placeholder="Type your own answer"
              ref={otherRef}
              value={draft.otherText}
            />
          )}
          <div className="flex items-center gap-2 pt-1.5">
            {step > 0 && <Button disabled={disabled} onClick={() => setStep(step - 1)} size="sm" type="button" variant="ghost">Back</Button>}
            <div className="ml-auto flex items-center gap-2">
              <Button disabled={disabled} onClick={skip} size="sm" type="button" variant="ghost">Skip</Button>
              <Button disabled={disabled || !answered} onClick={() => advance()} size="sm" type="button">
                {last ? 'Submit' : 'Next'}
                <Kbd className="border-primary-foreground/30 text-primary-foreground/70">{`${MOD_KEY_LABEL} ↵`}</Kbd>
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

/** The record of an answered, skipped or dismissed question request, kept in the conversation. */
export function ResolvedQuestions({ request }: { request: QuestionRequestData }) {
  const { decision } = request;
  if (decision?.kind === 'deny') {
    return (
      <section aria-label="Resolved question request" className="space-y-1 rounded-lg border px-3 py-2 text-sm text-muted-foreground">
        {request.questions.map((question) => <p className="whitespace-pre-wrap text-foreground" key={question.fieldId}>{question.prompt}</p>)}
        <p>{decision.reason ?? 'Declined'}</p>
      </section>
    );
  }
  const answers = decision?.kind === 'answer' ? decision.answers : {};
  return (
    <section aria-label="Resolved question request" className="rounded-lg border px-3 py-2 text-sm">
      <dl className="space-y-1.5">
        {request.questions.map((question) => {
          const answer = Object.hasOwn(answers, question.fieldId) ? answers[question.fieldId] : undefined;
          return (
            <div key={question.fieldId}>
              <dt className="whitespace-pre-wrap text-muted-foreground">{question.prompt}</dt>
              <dd className={cn('whitespace-pre-wrap', answer === undefined && 'text-subtle-foreground')}>{answer ?? 'Skipped'}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}
