import { Handle, NodeResizeControl, Position, ResizeControlVariant, type Node, type NodeProps, type NodeTypes, type ResizeParams } from '@xyflow/react';
import { GitFork, PanelRight, Trash2 } from 'lucide-react';
import { createContext, useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { MessageResponse } from '@/components/ai-elements/message';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { AttachmentPreviewProvider } from '@/components/conversation/attachment-preview-context';
import { AgentReplyBody, MESSAGE_TEXT, replyPreview, UserMessageBody } from '@/components/conversation/conversation-turn';
import { providerName } from '@/components/sidebar-03/nav-main';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { conversationHub } from '@/renderer/conversation-hub';
import { MAP, type MapNodeData } from '@/renderer/map/map-graph';
import { conversationKey, type ConversationRef, type ConversationTurn, type ForkPoint, type TurnBlock } from '@/shared/conversation-contract';
import type { MapView } from '@/shared/map-contract';
import { ComposerNode } from './composer-node';

/** What the canvas offers for one side chat, on the node that carries its actions. */
export interface SideChatActions {
  /** The user node of the side chat's first own message, which carries the actions beside its detached marker. */
  firstTurnId: string | undefined;
  /** Set when the right panel can show side chats. */
  open?: () => void;
  /** Set when the side chat, and none inside it, is running. */
  requestDelete?: () => void;
}

/** What every node on the canvas reads from the canvas around it. */
export interface MapNodeEnvironment {
  view: MapView;
  /** By conversationKey() of the side chat. */
  sideChats: ReadonlyMap<string, SideChatActions>;
  /** A width resize from this edge ended; only a resize from the left edge moves the node's position too. */
  onResizeEnd(id: string, frame: { x: number; y: number; width: number }, edge: 'left' | 'right'): void;
  /** "Fork from here" on user and reply nodes; unset where the map offers no forks. */
  fork?: {
    can(owner: ConversationRef, turn: ConversationTurn, position: ForkPoint['position']): boolean;
    start(owner: ConversationRef, turn: ConversationTurn, position: ForkPoint['position']): void;
  };
}

export const MapNodeEnvironmentContext = createContext<MapNodeEnvironment>({ view: 'preview', sideChats: new Map(), onResizeEnd: () => undefined });

type DataOf<K extends MapNodeData['kind']> = Extract<MapNodeData, { kind: K }>;
type MapNodeProps<K extends MapNodeData['kind']> = NodeProps<Node<DataOf<K>>>;

/** Starts a fork at this node's point, when the canvas offers one there. */
function useForkAt(owner: ConversationRef, turn: ConversationTurn, position: ForkPoint['position']): (() => void) | undefined {
  const { fork } = useContext(MapNodeEnvironmentContext);
  return fork?.can(owner, turn, position) ? () => fork.start(owner, turn, position) : undefined;
}

const proseOf = (blocks: TurnBlock[]) => blocks.flatMap((block) => block.kind === 'assistant-prose' ? [block.text] : []).join('\n\n');

/** Preview's cut: the start of a message, clamped to three lines. */
function Clamped({ text }: { text: string }) {
  return <div className="line-clamp-3"><MessageResponse className={MESSAGE_TEXT}>{text}</MessageResponse></div>;
}

function OpenAction({ onOpen }: { onOpen: () => void }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button aria-label="Open in panel" className="nodrag nopan text-muted-foreground" onClick={onOpen} size="icon-xs" type="button" variant="ghost">
            <PanelRight aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Open in panel</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ForkAction({ onFork }: { onFork: () => void }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button aria-label="Fork from here" className="nodrag nopan text-muted-foreground" onClick={onFork} size="icon-xs" type="button" variant="ghost">
            <GitFork aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Fork from here</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function DeleteAction({ onDelete }: { onDelete: () => void }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button aria-label="Delete side chat" className="nodrag nopan text-muted-foreground" onClick={onDelete} size="icon-xs" type="button" variant="ghost">
            <Trash2 aria-hidden />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete side chat</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function NodeFrame({ id, line, label, branch, onFork, onOpen, onDelete, className, children }: {
  id: string;
  line: 'main' | 'side';
  label: string;
  /** Set on the message nodes that can be forked from. */
  onFork?: () => void;
  /** Set on the nodes that offer opening their side chat in the panel. */
  onOpen?: () => void;
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
        {(onFork || onOpen || onDelete) && (
          <div className="mt-1 mr-1.5 flex gap-0.5">
            {onFork && <ForkAction onFork={onFork} />}
            {onOpen && <OpenAction onOpen={onOpen} />}
            {onDelete && <DeleteAction onDelete={onDelete} />}
          </div>
        )}
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
  const { view, sideChats } = useContext(MapNodeEnvironmentContext);
  const { text } = data.turn.userMessage;
  const actions = data.line === 'side' ? sideChats.get(conversationKey(data.owner)) : undefined;
  const carries = actions?.firstTurnId === data.turn.id;
  const onFork = useForkAt(data.owner, data.turn, 'before');
  return (
    <NodeFrame id={id} label="You" line={data.line} onDelete={carries ? actions.requestDelete : undefined} onFork={onFork} onOpen={carries ? actions.open : undefined}>
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
  const onFork = useForkAt(data.owner, turn, 'after');
  const preview = view === 'preview' ? replyPreview(turn) : '';
  // The reply being streamed, with no text yet; Full shows any work it has already done instead. A transcript
  // never records a turn ending, so an active turn alone doesn't mean anything is on its way.
  const waiting = running && data.latest && turn.status === 'active' && !proseOf(turn.blocks) && (view === 'preview' || turn.blocks.length === 0);
  return (
    <NodeFrame branch={data.canBranch ? 'open' : 'closed'} id={id} label={providerName(data.owner.provider)} line={data.line} onFork={onFork}>
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
  const { sideChats } = useContext(MapNodeEnvironmentContext);
  const actions = sideChats.get(conversationKey(data.sideChat.ref));
  return (
    <NodeFrame className="border-dashed" id={id} label="Branch point no longer in the conversation" line="side" onDelete={actions?.requestDelete} onOpen={actions?.open}>
      {branchPointText && <p className="line-clamp-3 text-sm leading-6 wrap-anywhere text-muted-foreground">{branchPointText}</p>}
    </NodeFrame>
  );
}

export const MAP_NODE_TYPES = { user: UserNode, reply: ReplyNode, composer: ComposerNode, detached: DetachedNode } satisfies NodeTypes;
