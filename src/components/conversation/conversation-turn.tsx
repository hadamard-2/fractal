import { Check, ChevronRight, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { ConversationTurn as ConversationTurnData, TurnBlock, UserDecision } from '@/shared/conversation-contract';
import { AgentAction, UnsupportedActivity } from './agent-action';
import { BlockingRequest } from './blocking-request';
import { ConversationImages } from './conversation-images';
import { MessageAttachments } from './message-attachments';
import { PlanBlock } from './plan-block';
import { CodeBlockTerminalActions } from './code-block-terminal-actions';
import { WorkPacket, workPacketSummary } from './work-packet';

type ResolveRequest = (requestId: string, decision: UserDecision) => void | Promise<void>;

const concludes = (block: TurnBlock | undefined): boolean => block?.kind === 'assistant-prose' && block.concludesTurn === true;

/** Index of the first block of the last message the provider marked as ending the turn, or -1. */
function answerStart(blocks: TurnBlock[]): number {
  let start = blocks.findLastIndex(concludes);
  while (start > 0 && concludes(blocks[start - 1])) start -= 1;
  return start;
}

/**
 * Splits a finished turn at the start of the message the provider marked as ending it.
 * Without that mark (a running or interrupted turn, or a provider that doesn't report it)
 * nothing is split, since there's no recorded answer to separate the work from.
 * A plan is lifted out of the work into its own fold, ahead of it, and so are questions,
 * whose answers are the user's own words and stay in view.
 */
export function splitTurnWork(turn: ConversationTurnData): { lead: TurnBlock[]; plans: TurnBlock[]; questions: TurnBlock[]; work: TurnBlock[]; answer: TurnBlock[] } {
  // Notices that open a turn say what started it (a background task finishing, a slash command's
  // output), so they stay visible rather than folding into the work.
  let leadEnd = 0;
  while (turn.blocks[leadEnd]?.kind === 'system-notice') leadEnd += 1;
  const start = turn.status === 'active' ? -1 : answerStart(turn.blocks);
  if (start <= leadEnd) return { lead: [], plans: [], questions: [], work: [], answer: turn.blocks };
  const work = turn.blocks.slice(leadEnd, start);
  return {
    lead: turn.blocks.slice(0, leadEnd),
    plans: work.filter((block) => block.kind === 'plan'),
    questions: work.filter((block) => block.kind === 'question'),
    work: work.filter((block) => block.kind !== 'plan' && block.kind !== 'question'),
    answer: turn.blocks.slice(start),
  };
}

const proseOf = (blocks: TurnBlock[]) => blocks.flatMap((block) => block.kind === 'assistant-prose' ? [block.text] : []).join('\n\n');

/** The prose a reply's preview starts from: its answer as Execute shows it, or all its prose without one. */
export function replyPreview(turn: ConversationTurnData): string {
  return proseOf(splitTurnWork(turn).answer) || proseOf(turn.blocks);
}

// A URL, path, or hash with no spaces would otherwise keep its full width and push the transcript sideways.
export const MESSAGE_TEXT = 'max-w-none text-sm leading-6 wrap-anywhere';

function TurnBlockView({ block, onResolve }: { block: TurnBlock; onResolve: ResolveRequest }) {
  switch (block.kind) {
    case 'assistant-prose':
      // The terminal actions wrapper has no box of its own (`contents`), so the margin that spaces
      // blocks apart would be dropped without this one.
      return <div><CodeBlockTerminalActions><MessageResponse className={MESSAGE_TEXT}>{block.text}</MessageResponse></CodeBlockTerminalActions></div>;
    case 'work-packet':
      return <WorkPacket packet={block} />;
    case 'plan':
      return <PlanBlock plan={block} />;
    case 'approval':
    case 'question':
      // A plan approval's outcome is shown by the plan block.
      if (block.request.kind === 'approval' && block.request.plan !== undefined) return null;
      return <BlockingRequest onResolve={onResolve} request={block.request} />;
    case 'system-notice':
      return <p className={`rounded border px-3 py-2 text-sm ${block.tone === 'error' ? 'border-destructive/30 text-destructive' : 'text-muted-foreground'}`}>{block.message}</p>;
    case 'unsupported':
      return <UnsupportedActivity {...block} />;
  }
}

function TurnWork({ blocks, onResolve }: { blocks: TurnBlock[]; onResolve: ResolveRequest }) {
  const [open, setOpen] = useState(false);
  const actions = blocks.flatMap((block) => block.kind === 'work-packet' ? block.actions : []);
  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger className="flex items-center gap-1.5 text-left text-sm text-muted-foreground hover:text-foreground">
        <ChevronRight aria-hidden className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />
        <span>Work{actions.length > 0 && ` · ${workPacketSummary(actions)}`}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 ml-2 space-y-4 border-l pl-4" aria-label="Agent work">
        {blocks.map((block) => <TurnBlockView block={block} key={block.id} onResolve={onResolve} />)}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Copies `text`; it stays transparent until the pointer is over the enclosing `group/copy`, or it has focus. */
function CopyMessage({ className, label, text }: { className?: string; label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <MessageActions className={cn('opacity-0 transition-opacity group-hover/copy:opacity-100 focus-within:opacity-100', className)}>
      <MessageAction className="text-muted-foreground" label={label} onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true)); }} tooltip={copied ? 'Copied' : 'Copy'}>
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </MessageAction>
    </MessageActions>
  );
}

/** The user's side of a turn as execute shows it, or nothing when the message has no content. */
export function UserMessageBody({ turn }: { turn: ConversationTurnData }) {
  const { images, attachments, text } = turn.userMessage;
  if (!images && !attachments && !text) return null;
  return (
    <Message className="group/copy" from="user">
      {images && <ConversationImages className="justify-end" images={images} />}
      {attachments && <MessageAttachments attachments={attachments} sentAt={turn.userMessage.createdAt} />}
      {text && <MessageContent><CodeBlockTerminalActions><MessageResponse className={MESSAGE_TEXT}>{text}</MessageResponse></CodeBlockTerminalActions></MessageContent>}
      {text && <CopyMessage className="justify-end" label="Copy message" text={text} />}
    </Message>
  );
}

/** The agent's side of a turn as execute shows it: its prose, with the work before the answer folded away. */
export function AgentReplyBody({ turn, onResolve }: { turn: ConversationTurnData; onResolve: ResolveRequest }) {
  const { lead, plans, questions, work, answer } = splitTurnWork(turn);
  // The recorded answer's markdown source, even while the turn still reads as active (a transcript
  // never records a turn ending); without an answer, a finished turn copies all of its prose.
  const start = answerStart(turn.blocks);
  const copied = start !== -1 ? turn.blocks.slice(start) : turn.status === 'active' ? [] : turn.blocks;
  const responseText = copied.flatMap((block) => block.kind === 'assistant-prose' ? [block.text] : []).join('\n\n');
  return (
    <div className="group/copy space-y-4" aria-label="Agent response">
      {lead.map((block) => <TurnBlockView block={block} key={block.id} onResolve={onResolve} />)}
      {plans.map((block) => <TurnBlockView block={block} key={block.id} onResolve={onResolve} />)}
      {questions.map((block) => <TurnBlockView block={block} key={block.id} onResolve={onResolve} />)}
      {work.length > 0 && <TurnWork blocks={work} onResolve={onResolve} />}
      {answer.map((block) => <TurnBlockView block={block} key={block.id} onResolve={onResolve} />)}
      {responseText && <CopyMessage label="Copy response" text={responseText} />}
    </div>
  );
}

export function ConversationTurn({ turn, onResolve }: { turn: ConversationTurnData; onResolve: ResolveRequest }) {
  return (
    <article aria-label="Conversation turn" className="space-y-4" data-selection-source={turn.id}>
      <UserMessageBody turn={turn} />
      <AgentReplyBody onResolve={onResolve} turn={turn} />
    </article>
  );
}

export { AgentAction };
