import { Handle, NodeResizeControl, Position, ResizeControlVariant, type Node, type NodeProps, type NodeTypes, type ResizeParams } from '@xyflow/react';
import { createContext, useContext, type ReactNode } from 'react';
import { MessageResponse } from '@/components/ai-elements/message';
import { AttachmentPreviewProvider } from '@/components/conversation/attachment-preview-context';
import { AgentReplyBody, MESSAGE_TEXT, splitTurnWork, UserMessageBody } from '@/components/conversation/conversation-turn';
import { providerName } from '@/components/sidebar-03/nav-main';
import { cn } from '@/lib/utils';
import { conversationHub } from '@/renderer/conversation-hub';
import { MAP, type MapNodeData } from '@/renderer/map/map-graph';
import type { ConversationTurn, TurnBlock } from '@/shared/conversation-contract';
import type { MapView } from '@/shared/map-contract';

/** What every node on the canvas reads from the canvas around it. */
export interface MapNodeEnvironment {
  view: MapView;
  /** A width resize ended; the node's position moves too when it was resized from the left edge. */
  onResizeEnd(id: string, frame: { x: number; y: number; width: number }): void;
}

export const MapNodeEnvironmentContext = createContext<MapNodeEnvironment>({ view: 'preview', onResizeEnd: () => undefined });

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

function NodeFrame({ id, line, label, canBranch = false, className, children }: {
  id: string;
  line: 'main' | 'side';
  label: string;
  canBranch?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const { onResizeEnd } = useContext(MapNodeEnvironmentContext);
  const resizeEnd = (_: unknown, { x, y, width }: ResizeParams) => onResizeEnd(id, { x, y, width });
  return (
    <div className={cn('rounded-lg border bg-card text-card-foreground shadow-xs', line === 'main' ? 'border-primary' : 'border-border', className)}>
      {(['left', 'right'] as const).map((position) => (
        <NodeResizeControl
          className="map-node-resize"
          key={position}
          maxWidth={MAP.maxWidth}
          minWidth={MAP.minWidth}
          onResizeEnd={resizeEnd}
          position={position}
          resizeDirection="horizontal"
          variant={ResizeControlVariant.Line}
        />
      ))}
      <div className="map-node-drag cursor-grab px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground select-none">{label}</div>
      <div className="nodrag nopan cursor-text px-3 pb-3 select-text">{children}</div>
      {/* Main-line and side-chat edges attach here; only the branch handle starts a connection. */}
      <Handle className="map-handle-anchor" isConnectable={false} position={Position.Top} type="target" />
      <Handle className="map-handle-anchor" isConnectable={false} position={Position.Bottom} type="source" />
      {canBranch && <Handle className="map-branch-handle" id="branch" position={Position.Right} type="source" />}
    </div>
  );
}

export function UserNode({ id, data }: MapNodeProps<'user'>) {
  const { view } = useContext(MapNodeEnvironmentContext);
  const { text } = data.turn.userMessage;
  return (
    <NodeFrame id={id} label="You" line={data.line}>
      <AttachmentPreviewProvider conversationRef={data.owner}>
        {view === 'preview' && text ? <Clamped text={text} /> : <UserMessageBody turn={data.turn} />}
      </AttachmentPreviewProvider>
    </NodeFrame>
  );
}

export function ReplyNode({ id, data }: MapNodeProps<'reply'>) {
  const { view } = useContext(MapNodeEnvironmentContext);
  const preview = view === 'preview' ? replyPreview(data.turn) : '';
  return (
    <NodeFrame canBranch={data.canBranch} id={id} label={providerName(data.owner.provider)} line={data.line}>
      {preview
        ? <Clamped text={preview} />
        : <AgentReplyBody onResolve={(requestId, decision) => conversationHub().resolveRequest(data.owner, requestId, decision)} turn={data.turn} />}
    </NodeFrame>
  );
}

/** Stands in for a side chat's branch point once the parent no longer has that turn. */
export function DetachedNode({ id, data }: MapNodeProps<'detached'>) {
  const { branchPointText } = data.sideChat;
  return (
    <NodeFrame className="border-dashed" id={id} label="Branch point no longer in the conversation" line="side">
      {branchPointText && <p className="line-clamp-3 text-sm leading-6 wrap-anywhere text-muted-foreground">{branchPointText}</p>}
    </NodeFrame>
  );
}

export const MAP_NODE_TYPES = { user: UserNode, reply: ReplyNode, detached: DetachedNode } satisfies NodeTypes;
