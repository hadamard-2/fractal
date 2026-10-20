import { Handle, NodeResizeControl, Position, ResizeControlVariant, type Node, type NodeProps, type NodeTypes, type ResizeParams } from '@xyflow/react';
import { Trash2 } from 'lucide-react';
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { MessageResponse } from '@/components/ai-elements/message';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { AttachmentPreviewProvider } from '@/components/conversation/attachment-preview-context';
import { AgentReplyBody, MESSAGE_TEXT, splitTurnWork, UserMessageBody } from '@/components/conversation/conversation-turn';
import { providerName } from '@/components/sidebar-03/nav-main';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { conversationHub } from '@/renderer/conversation-hub';
import { MAP, type MapNodeData } from '@/renderer/map/map-graph';
import { conversationKey, type ConversationRef, type ConversationTurn, type TurnBlock } from '@/shared/conversation-contract';
import type { MapView } from '@/shared/map-contract';
import { ComposerNode } from './composer-node';

/** A side chat the canvas can delete now, with the node that offers the action. */
export interface SideChatDeletion {
  /** The user node of the side chat's first own message, which carries the action beside its detached marker. */
  firstTurnId: string | undefined;
  request(): void;
}

/** What every node on the canvas reads from the canvas around it. */
export interface MapNodeEnvironment {
  view: MapView;
  /** By conversationKey() of the side chat; a side chat that can't be deleted right now isn't listed. */
  deletions: ReadonlyMap<string, SideChatDeletion>;
  /** A width resize from this edge ended; only a resize from the left edge moves the node's position too. */
  onResizeEnd(id: string, frame: { x: number; y: number; width: number }, edge: 'left' | 'right'): void;
}

export const MapNodeEnvironmentContext = createContext<MapNodeEnvironment>({ view: 'preview', deletions: new Map(), onResizeEnd: () => undefined });

type DataOf<K extends MapNodeData['kind']> = Extract<MapNodeData, { kind: K }>;
type MapNodeProps<K extends MapNodeData['kind']> = NodeProps<Node<DataOf<K>>>;

const proseOf = (blocks: TurnBlock[]) => blocks.flatMap((block) => block.kind === 'assistant-prose' ? [block.text] : []).join('\n\n');

/** The prose Preview starts from: the reply's answer as execute shows it, or all its prose when it has no answer yet. */
function replyPreview(turn: ConversationTurn): string {
  return proseOf(splitTurnWork(turn).answer) || proseOf(turn.blocks);
}

/** Preview's cut: the start of a message, clamped to three lines. */
function Clamped({ text }: { text: string }) {
  return <div className="line-clamp-3"><MessageResponse className={MESSAGE_TEXT}>{text}</MessageResponse></div>;
}

function DeleteAction({ onDelete }: { onDelete: () => void }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button aria-label="Delete side chat" className="nodrag nopan mt-1 mr-1.5 text-muted-foreground" onClick={onDelete} size="icon-xs" type="button" variant="ghost">
            <Trash2 aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete side chat</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function NodeFrame({ id, line, label, branch, onDelete, className, children }: {
  id: string;
  line: 'main' | 'side';
  label: string;
  /** Set on the nodes that offer deleting their side chat. */
  onDelete?: () => void;
  /** Replies only. A reply that can't branch still has the handle, closed, because its side-chat edges leave from it. */
  branch?: 'open' | 'closed';
  className?: string;
  children: ReactNode;
}) {
  const { onResizeEnd } = useContext(MapNodeEnvironmentContext);
  return (
    <div className={cn('rounded-lg border bg-card text-card-foreground shadow-xs', line === 'main' ? 'border-primary' : 'border-border', className)}>
      {(['left', 'right'] as const).map((position) => (
        <NodeResizeControl
          className="map-node-resize"
          key={position}
          maxWidth={MAP.maxWidth}
          minWidth={MAP.minWidth}
          onResizeEnd={(_: unknown, { x, y, width }: ResizeParams) => onResizeEnd(id, { x, y, width }, position)}
          position={position}
          resizeDirection="horizontal"
          variant={ResizeControlVariant.Line}
        />
      ))}
      <div className="flex items-start">
        <div className="map-node-drag flex-1 cursor-grab px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground select-none">{label}</div>
        {onDelete && <DeleteAction onDelete={onDelete} />}
      </div>
      {/* The message itself: text selected in here can start a side chat. */}
      <div className="nodrag nopan cursor-text px-3 pb-3 select-text" data-selection-source={id}>{children}</div>
      {/* Main-line and side-chat edges attach here; only the branch handle starts a connection. */}
      <Handle className="map-handle-anchor" isConnectable={false} position={Position.Top} type="target" />
      <Handle className="map-handle-anchor" isConnectable={false} position={Position.Bottom} type="source" />
      {branch && <Handle className="map-branch-handle" data-can-branch={branch === 'open'} id="branch" isConnectable={branch === 'open'} position={Position.Right} type="source" />}
    </div>
  );
}

export function UserNode({ id, data }: MapNodeProps<'user'>) {
  const { view, deletions } = useContext(MapNodeEnvironmentContext);
  const { text } = data.turn.userMessage;
  const deletion = data.line === 'side' ? deletions.get(conversationKey(data.owner)) : undefined;
  return (
    <NodeFrame id={id} label="You" line={data.line} onDelete={deletion?.firstTurnId === data.turn.id ? deletion.request : undefined}>
      <AttachmentPreviewProvider conversationRef={data.owner}>
        {view === 'preview' && text ? <Clamped text={text} /> : <UserMessageBody turn={data.turn} />}
      </AttachmentPreviewProvider>
    </NodeFrame>
  );
}

/** Whether the conversation is running a turn Fractal started, as the hub has it now. */
function useRunningInFractal(owner: ConversationRef): boolean {
  const hub = conversationHub();
  const running = useCallback(() => hub.state(owner).runtime === 'active-in-fractal', [hub, owner]);
  return useSyncExternalStore(hub.subscribe, running);
}

export function ReplyNode({ id, data }: MapNodeProps<'reply'>) {
  const { view } = useContext(MapNodeEnvironmentContext);
  const { turn } = data;
  const running = useRunningInFractal(data.owner);
  const preview = view === 'preview' ? replyPreview(turn) : '';
  // The reply being streamed, with no text yet; Full shows any work it has already done instead. A transcript
  // never records a turn ending, so an active turn alone doesn't mean anything is on its way.
  const waiting = running && data.latest && turn.status === 'active' && !proseOf(turn.blocks) && (view === 'preview' || turn.blocks.length === 0);
  return (
    <NodeFrame branch={data.canBranch ? 'open' : 'closed'} id={id} label={providerName(data.owner.provider)} line={data.line}>
      {waiting
        ? <Shimmer className="text-sm">Thinking…</Shimmer>
        : preview
          ? <Clamped text={preview} />
          : <AgentReplyBody onResolve={(requestId, decision) => conversationHub().resolveRequest(data.owner, requestId, decision)} turn={turn} />}
    </NodeFrame>
  );
}

/** Stands in for a side chat's branch point once the parent no longer has that turn. */
export function DetachedNode({ id, data }: MapNodeProps<'detached'>) {
  const { branchPointText } = data.sideChat;
  const { deletions } = useContext(MapNodeEnvironmentContext);
  return (
    <NodeFrame className="border-dashed" id={id} label="Branch point no longer in the conversation" line="side" onDelete={deletions.get(conversationKey(data.sideChat.ref))?.request}>
      {branchPointText && <p className="line-clamp-3 text-sm leading-6 wrap-anywhere text-muted-foreground">{branchPointText}</p>}
    </NodeFrame>
  );
}

export const MAP_NODE_TYPES = { user: UserNode, reply: ReplyNode, composer: ComposerNode, detached: DetachedNode } satisfies NodeTypes;
