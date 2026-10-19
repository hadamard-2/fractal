import { Background, BackgroundVariant, ReactFlow, useReactFlow, type Dimensions, type Node, type NodeChange, type OnNodeDrag, type XYPosition } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { conversationKey, type ConversationRef } from '@/shared/conversation-contract';
import { useConversationStates } from '@/renderer/conversation-hub';
import { initialConversationState } from '@/renderer/conversation-reducer';
import { buildMapGraph, MAP, type MapNodeData, type SideChatDraft } from '@/renderer/map/map-graph';
import { useMapLayout } from '@/renderer/map/use-map-layout';
import { useSideChats } from '@/renderer/map/use-side-chats';
import { MapControls } from './map-controls';
import { MAP_NODE_TYPES, MapNodeEnvironmentContext, type MapNodeEnvironment } from './map-nodes';

type MapNode = Node<MapNodeData>;

/** Where a node is while the user drags or resizes it, until the layout takes over at the end. */
interface Override { position?: XYPosition; width?: number }

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

/** The map of one root conversation and its side chats. Mount it inside a ReactFlowProvider, one per root. */
export function MapCanvas({ root, readOnly }: { root: ConversationRef; readOnly: boolean }) {
  const { sideChats } = useSideChats(root);
  const { layout, moveNode, resizeNode, setView } = useMapLayout(root);
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

  const graph = useMemo(
    () => buildMapGraph({ root: { ref: root, state: rootState }, sideChats: sideChatStates, drafts: NO_DRAFTS, layout, heights, readOnly }),
    [root, rootState, sideChatStates, layout, heights, readOnly],
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
    moveNode(node.id, node.position);
    setOverrides((prior) => withoutEntry(prior, node.id));
  }, [moveNode]);

  const environment = useMemo((): MapNodeEnvironment => ({
    view: layout.view,
    onResizeEnd: (id, { x, y, width }) => {
      // Listing the node pins its position too, which a resize from the left edge has also moved.
      moveNode(id, { x, y });
      resizeNode(id, width);
      setOverrides((prior) => withoutEntry(prior, id));
    },
  }), [layout.view, moveNode, resizeNode]);

  // Fit once per root, when its history first finishes loading; later rebuilds keep the user's viewport.
  const { fitView } = useReactFlow();
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
    </MapNodeEnvironmentContext.Provider>
  );
}
