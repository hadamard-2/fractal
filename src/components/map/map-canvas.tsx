import { Background, BackgroundVariant, ReactFlow, useReactFlow, type Dimensions, type Node, type NodeChange, type OnConnectEnd, type OnNodeDrag, type XYPosition } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { conversationKey, type ConversationRef, type ConversationRuntime, type ModelChoice, type SideChatSummary } from '@/shared/conversation-contract';
import { conversationHub, useConversationStates } from '@/renderer/conversation-hub';
import { initialConversationState } from '@/renderer/conversation-reducer';
import { buildMapGraph, hasUserContent, MAP, type MapNodeData, type SideChatDraft } from '@/renderer/map/map-graph';
import { canBranchFrom, draftFromConnectEnd, draftFromMessage, draftsReducer, handOffNodeId, submitDraft, type HandOff } from '@/renderer/map/side-chat-drafts';
import { useMapLayout } from '@/renderer/map/use-map-layout';
import { sideChatsBelow, useSideChats } from '@/renderer/map/use-side-chats';
import { DeleteSideChatDialog } from './delete-side-chat-dialog';
import { ComposerEnvironmentContext, type ComposerEnvironment } from './composer-node';
import { MapControls } from './map-controls';
import { MAP_NODE_TYPES, MapNodeEnvironmentContext, type MapNodeEnvironment, type SideChatDeletion } from './map-nodes';
import { SelectionMenu, useMessageSelection } from './selection-menu';

type MapNode = Node<MapNodeData>;

/** Where a node is while the user drags or resizes it, until the layout takes over at the end. */
interface Override { position?: XYPosition; width?: number }

/** A side chat in one of these is running or waiting on the user, so it can't be deleted. */
const BUSY_RUNTIMES: ReadonlySet<ConversationRuntime> = new Set(['active-in-fractal', 'active-externally', 'waiting-for-user']);

/** The side chat the user is being asked about, with the side chats inside it as the list had them then. */
interface PendingDeletion { sideChat: SideChatSummary; below: SideChatSummary[] }

const NO_DRAFTS: readonly SideChatDraft[] = [];
const SNAP_GRID: [number, number] = [MAP.grid, MAP.grid];
const PRO_OPTIONS = { hideAttribution: true };
const DEFAULT_EDGE_OPTIONS = { type: 'default' };

function withEntry<V>(map: ReadonlyMap<string, V>, id: string, value: V): ReadonlyMap<string, V> {
  return new Map(map).set(id, value);
}

function withoutEntry<V>(map: ReadonlyMap<string, V>, id: string): ReadonlyMap<string, V> {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}

function CanvasMessage({ children }: { children: ReactNode }) {
  return <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center text-sm text-muted-foreground">{children}</div>;
}

/** The model a side chat's next turn runs with; a failed lookup means the agent's default. */
function modelChoiceOf(ref: ConversationRef): Promise<ModelChoice | null> {
  return Promise.resolve().then(() => window.fractal.models.list(ref)).then((result) => result.choice, (): null => null);
}

/** The map of one root conversation and its side chats. Mount it inside a ReactFlowProvider, one per root, so unsent drafts go with the root. */
export function MapCanvas({ root, readOnly }: { root: ConversationRef; readOnly: boolean }) {
  const { sideChats, refresh: refreshSideChats } = useSideChats(root);
  const { layout, moveNode, resizeNode, setView, dropNodesOf } = useMapLayout(root);
  const refs = useMemo(() => [root, ...sideChats.map((summary) => summary.ref)], [root, sideChats]);
  const states = useConversationStates(refs);
  const rootState = states.get(conversationKey(root)) ?? initialConversationState;
  const sideChatStates = useMemo(
    () => sideChats.map((summary) => ({ summary, state: states.get(conversationKey(summary.ref)) ?? initialConversationState })),
    [sideChats, states],
  );

  // React Flow measures each node; heights feed the automatic layout, and both go back on the nodes so React Flow keeps them.
  const [measured, setMeasured] = useState<ReadonlyMap<string, Dimensions>>(new Map());
  const heights = useMemo(() => new Map([...measured].map(([id, size]) => [id, size.height])), [measured]);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(new Map());
  const [drafts, dispatchDraft] = useReducer(draftsReducer, NO_DRAFTS);
  const [handOffs, setHandOffs] = useState<readonly HandOff[]>([]);

  const graph = useMemo(
    () => buildMapGraph({ root: { ref: root, state: rootState }, sideChats: sideChatStates, drafts, layout, heights, readOnly }),
    [root, rootState, sideChatStates, drafts, layout, heights, readOnly],
  );
  const nodes = useMemo(() => graph.nodes.map((node): MapNode => {
    const override = overrides.get(node.id);
    const size = measured.get(node.id);
    return {
      ...node,
      dragHandle: '.map-node-drag',
      ...(override?.position ? { position: override.position } : {}),
      ...(override?.width !== undefined ? { width: override.width } : {}),
      ...(size ? { measured: size } : {}),
    };
  }), [graph.nodes, overrides, measured]);

  const onNodesChange = useCallback((changes: NodeChange<MapNode>[]) => {
    const sizes: [string, Dimensions][] = [];
    const moved: [string, Override][] = [];
    for (const change of changes) {
      if (change.type === 'position' && change.position) moved.push([change.id, { position: change.position }]);
      if (change.type === 'dimensions' && change.dimensions) {
        sizes.push([change.id, change.dimensions]);
        if (change.resizing) moved.push([change.id, { width: change.dimensions.width }]);
      }
    }
    if (sizes.length > 0) {
      // Only a size that actually changed updates state, so a re-render that re-measures the same sizes settles.
      setMeasured((prior) => sizes.reduce((next, [id, size]) => {
        const old = next.get(id);
        return old?.width === size.width && old.height === size.height ? next : withEntry(next, id, size);
      }, prior));
    }
    if (moved.length > 0) {
      setOverrides((prior) => moved.reduce((next, [id, change]) => withEntry(next, id, { ...next.get(id), ...change }), prior));
    }
  }, []);

  const onNodeDragStop: OnNodeDrag<MapNode> = useCallback((_, node) => {
    // An unsent draft keeps its spot itself; it passes to the layout once sent.
    if (node.data.kind === 'composer') dispatchDraft({ type: 'move', id: node.data.draft.id, position: node.position });
    else moveNode(node.id, node.position);
    setOverrides((prior) => withoutEntry(prior, node.id));
  }, [moveNode]);

  const { fitView, screenToFlowPosition } = useReactFlow();
  const onConnectEnd: OnConnectEnd = useCallback((event, connection) => {
    if (readOnly) return;
    const point = 'changedTouches' in event ? event.changedTouches[0] : event;
    if (!point) return;
    // Every node on this canvas carries map data.
    const fromNode = connection.fromNode && { data: connection.fromNode.data as MapNodeData };
    const draft = draftFromConnectEnd({ ...connection, fromNode }, { clientX: point.clientX, clientY: point.clientY, target: event.target }, screenToFlowPosition, crypto.randomUUID());
    if (draft) dispatchDraft({ type: 'add', draft });
  }, [readOnly, screenToFlowPosition]);

  const nodeData = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node.data])), [graph.nodes]);
  const branchable = useCallback((id: string) => {
    const data = nodeData.get(id);
    return data !== undefined && canBranchFrom(data);
  }, [nodeData]);
  const { selection, dismiss } = useMessageSelection(readOnly ? null : branchable);
  const chooseSideChat = () => {
    const data = selection && nodeData.get(selection.nodeId);
    const draft = data && draftFromMessage(data, selection.text, crypto.randomUUID());
    if (draft) dispatchDraft({ type: 'add', draft });
    window.getSelection()?.removeAllRanges();
    dismiss();
  };

  // A send that settles after the canvas has gone leaves the side chat on the map, but no draft or hand-off to update.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const latestStates = useRef(states);
  latestStates.current = states;
  const composerEnvironment = useMemo((): ComposerEnvironment => ({
    submit: async (draft, text) => {
      const continued = draft.continues ? latestStates.current.get(conversationKey(draft.continues)) : undefined;
      const before = draft.continues ? new Set((continued?.turns ?? []).map((turn) => turn.id)) : null;
      const ref = await submitDraft({ ...draft, text }, {
        hub: conversationHub(),
        fork: (...args) => window.fractal.conversations.fork(...args),
        deleteSideChat: (sideChat) => window.fractal.conversations.deleteSideChat(sideChat),
        modelChoice: modelChoiceOf,
        refreshSideChats,
      });
      if (!mounted.current) return;
      const { position } = draft;
      if (position) setHandOffs((prior) => [...prior, { ref, position, before }]);
      dispatchDraft({ type: 'remove', id: draft.id });
    },
    remove: (id) => dispatchDraft({ type: 'remove', id }),
  }), [refreshSideChats]);

  // A placed draft's spot passes to the first user node of what it sent, before that node is painted at its automatic spot.
  useLayoutEffect(() => {
    if (handOffs.length === 0) return;
    const done = new Set<HandOff>();
    for (const handOff of handOffs) {
      const key = conversationKey(handOff.ref);
      const state = states.get(key);
      const id = state && handOffNodeId(handOff, state, sideChats.find((summary) => conversationKey(summary.ref) === key));
      if (!id) continue;
      moveNode(id, handOff.position);
      done.add(handOff);
    }
    if (done.size > 0) setHandOffs((prior) => prior.filter((handOff) => !done.has(handOff)));
  }, [handOffs, states, sideChats, moveNode]);

  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null);
  const deletions = useMemo(() => {
    const offered = new Map<string, SideChatDeletion>();
    for (const { summary, state } of sideChatStates) {
      const below = sideChatsBelow(sideChats, summary.ref);
      const busy = [state, ...below.map((nested) => states.get(conversationKey(nested.ref)))].some((own) => own !== undefined && BUSY_RUNTIMES.has(own.runtime));
      if (busy) continue;
      const firstTurnId = state.turns.slice(summary.inheritedTurnCount).find(hasUserContent)?.id;
      offered.set(conversationKey(summary.ref), { firstTurnId, request: () => setPendingDeletion({ sideChat: summary, below }) });
    }
    return offered;
  }, [sideChatStates, sideChats, states]);
  const deleted = async ({ sideChat, below }: PendingDeletion) => {
    dropNodesOf([sideChat, ...below].map((gone) => conversationKey(gone.ref)));
    await refreshSideChats();
  };

  const environment = useMemo((): MapNodeEnvironment => ({
    view: layout.view,
    deletions,
    onResizeEnd: (id, { x, y, width }) => {
      // Listing the node pins its position too, which a resize from the left edge has also moved.
      moveNode(id, { x, y });
      resizeNode(id, width);
      setOverrides((prior) => withoutEntry(prior, id));
    },
  }), [layout.view, deletions, moveNode, resizeNode]);

  // Fit once per root, when its history first finishes loading; later rebuilds keep the user's viewport.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || rootState.history !== 'complete') return;
    fitted.current = true;
    void fitView();
  }, [fitView, rootState.history]);

  const { history } = rootState;
  const empty = nodes.length === 0;
  return (
    <MapNodeEnvironmentContext.Provider value={environment}>
      <ComposerEnvironmentContext.Provider value={composerEnvironment}>
        <ReactFlow<MapNode>
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          deleteKeyCode={null}
          edges={graph.edges}
          elementsSelectable={false}
          maxZoom={MAP.maxZoom}
          minZoom={MAP.minZoom}
          nodeTypes={MAP_NODE_TYPES}
          nodes={nodes}
          nodesConnectable
          onConnectEnd={onConnectEnd}
          onMoveStart={dismiss}
          onNodeDragStart={dismiss}
          onNodeDragStop={onNodeDragStop}
          onNodesChange={onNodesChange}
          panOnScroll
          proOptions={PRO_OPTIONS}
          snapGrid={SNAP_GRID}
          snapToGrid
        >
          <Background gap={MAP.grid} size={1.5} variant={BackgroundVariant.Dots} />
          <MapControls onViewChange={setView} view={layout.view} />
        </ReactFlow>
        {empty && (history === 'idle' || history === 'loading') && <CanvasMessage><Shimmer className="text-sm">Reading history…</Shimmer></CanvasMessage>}
        {empty && history === 'complete' && <CanvasMessage>No messages yet.</CanvasMessage>}
        {empty && history === 'failed' && <CanvasMessage>History unavailable</CanvasMessage>}
        {selection && <SelectionMenu onChoose={chooseSideChat} selection={selection} />}
        {pendingDeletion && (
          <DeleteSideChatDialog
            nested={pendingDeletion.below.length}
            onClose={() => setPendingDeletion(null)}
            onDeleted={() => deleted(pendingDeletion)}
            sideChat={pendingDeletion.sideChat}
          />
        )}
      </ComposerEnvironmentContext.Provider>
    </MapNodeEnvironmentContext.Provider>
  );
}
