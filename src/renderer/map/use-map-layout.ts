import type { XYPosition } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isNodeOf, MAP } from '@/renderer/map/map-graph';
import { conversationKey, type ConversationRef } from '@/shared/conversation-contract';
import { EMPTY_MAP_LAYOUT, type MapLayout, type MapView } from '@/shared/map-contract';

const SAVE_DELAY_MS = 300;

type Edit = (layout: MapLayout) => MapLayout;

/** One root's layout from the moment it's asked for until the hook moves on to another root. */
interface Session {
  key: string;
  ref: ConversationRef;
  layout: MapLayout;
  loaded: boolean;
  /** Edits made before the stored layout arrived, replayed on top of it. */
  early: Edit[];
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Settles once `layout` holds the stored layout (or the empty one, if it couldn't be read). */
  ready: Promise<void>;
}

/** Saves the session's latest layout now, or as soon as its stored layout has arrived. A rejected save keeps the in-memory layout. */
function flush(session: Session): void {
  if (session.timer !== null) clearTimeout(session.timer);
  session.timer = null;
  void session.ready.then(() => {
    if (!session.dirty) return;
    session.dirty = false;
    void Promise.resolve()
      .then(() => window.fractal.map.saveLayout(session.ref, session.layout))
      .catch((): void => undefined);
  });
}

/**
 * The map layout of `root`: where the user has put nodes, their widths, and the
 * Preview / Full choice. Edits apply at once and are saved 300 ms after the
 * last one; a pending save is flushed when the root changes or on unmount.
 */
export function useMapLayout(root: ConversationRef | null): {
  layout: MapLayout;
  moveNode(id: string, position: XYPosition): void;
  /** Sets the width of a node the layout lists; the canvas lists a node it resizes with moveNode first. */
  resizeNode(id: string, width: number): void;
  setView(view: MapView): void;
  /** Forgets every spot and width kept for the nodes of the conversations with these keys. */
  dropNodesOf(keys: readonly string[]): void;
} {
  const key = root ? conversationKey(root) : null;
  const latestRoot = useRef(root);
  latestRoot.current = root;
  const session = useRef<Session | null>(null);
  const [shown, setShown] = useState<{ key: string | null; layout: MapLayout }>({ key: null, layout: EMPTY_MAP_LAYOUT });

  useEffect(() => {
    const ref = latestRoot.current;
    if (key === null || !ref) return;
    let markReady: () => void = () => undefined;
    const current: Session = {
      key, ref, layout: EMPTY_MAP_LAYOUT, loaded: false, early: [], dirty: false, timer: null,
      ready: new Promise((resolve) => { markReady = resolve; }),
    };
    session.current = current;
    void Promise.resolve()
      .then(() => window.fractal.map.layout(ref))
      .catch(() => EMPTY_MAP_LAYOUT)
      .then((stored) => {
        current.layout = current.early.reduce((layout, edit) => edit(layout), stored);
        current.early = [];
        current.loaded = true;
        markReady();
        if (session.current === current) setShown({ key, layout: current.layout });
      });
    return () => {
      flush(current);
      if (session.current === current) session.current = null;
    };
  }, [key]);

  const edit = useCallback((change: Edit) => {
    const current = session.current;
    if (!current) return;
    const next = change(current.layout);
    if (next === current.layout) return;
    current.layout = next;
    if (!current.loaded) current.early.push(change);
    current.dirty = true;
    setShown({ key: current.key, layout: next });
    if (current.timer !== null) clearTimeout(current.timer);
    current.timer = setTimeout(() => flush(current), SAVE_DELAY_MS);
  }, []);

  const moveNode = useCallback((id: string, position: XYPosition) => {
    edit((layout) => ({ ...layout, nodes: { ...layout.nodes, [id]: { ...layout.nodes[id], x: position.x, y: position.y } } }));
  }, [edit]);

  const resizeNode = useCallback((id: string, width: number) => {
    edit((layout) => {
      const node = layout.nodes[id];
      if (!node) return layout;
      return { ...layout, nodes: { ...layout.nodes, [id]: { ...node, width: Math.min(MAP.maxWidth, Math.max(MAP.minWidth, width)) } } };
    });
  }, [edit]);

  const setView = useCallback((view: MapView) => {
    edit((layout) => layout.view === view ? layout : { ...layout, view });
  }, [edit]);

  const dropNodesOf = useCallback((keys: readonly string[]) => {
    edit((layout) => {
      const ids = Object.keys(layout.nodes).filter((id) => keys.some((key) => isNodeOf(key, id)));
      if (ids.length === 0) return layout;
      const nodes = { ...layout.nodes };
      for (const id of ids) delete nodes[id];
      return { ...layout, nodes };
    });
  }, [edit]);

  return { layout: shown.key === key && key !== null ? shown.layout : EMPTY_MAP_LAYOUT, moveNode, resizeNode, setView, dropNodesOf };
}
