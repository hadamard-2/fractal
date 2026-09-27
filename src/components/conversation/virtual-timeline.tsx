import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer, type VirtualItem } from '@tanstack/react-virtual';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { nextScrollAction, readingAnchor, restoreAnchor, type ReadingAnchor } from '@/renderer/timeline-scroll';
import type { ConversationTurn as Turn, UserDecision } from '@/shared/conversation-contract';
import { ConversationTurn } from './conversation-turn';

interface Position { anchor: ReadingAnchor | null; distanceFromBottom: number; measurements: VirtualItem[] }
// Reading positions live only for this renderer's lifetime. No transcript is persisted here.
const positions = new Map<string, Position>();

interface Props {
  conversationId: string;
  turns: Turn[];
  onResolve: (requestId: string, decision: UserDecision) => void | Promise<void>;
  columnClassName?: string;
  historyComplete?: boolean;
}

function Timeline({ conversationId, turns, onResolve, columnClassName = 'px-4', historyComplete = true }: Props) {
  const viewport = useRef<HTMLDivElement>(null);
  const [saved] = useState(() => positions.get(conversationId));
  const restoring = useRef(Boolean(saved?.anchor));
  const [initialMeasurements] = useState(() => {
    if (!saved) return [];
    const sizes = new Map(saved.measurements.map((item) => [item.key, item.size]));
    let start = 0;
    return turns.map((turn, index): VirtualItem => {
      const size = sizes.get(turn.id) ?? 280;
      const item = { key: turn.id, index, size, start, end: start + size, lane: 0 };
      start += size;
      return item;
    });
  });
  const position = useRef<Position>(saved ?? { anchor: null, distanceFromBottom: 0, measurements: [] });
  const previous = useRef<{ turns: Turn[]; size: number; height: number } | null>(null);
  const [newActivity, setNewActivity] = useState(false);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: turns.length,
    getScrollElement: () => viewport.current,
    getItemKey: useCallback((index: number) => turns[index].id, [turns]),
    estimateSize: () => 280,
    overscan: 6,
    // Breathing room below the last message, counted in the total size so follow-bottom lands after it.
    paddingEnd: 96,
    initialMeasurementsCache: initialMeasurements,
    initialOffset: () => restoreAnchor(saved?.anchor ?? null, initialMeasurements) ?? 0,
    // Keyed anchors are captured before setOptions changes the turn order and
    // restored after layout. CSS anchoring is disabled to avoid doubling corrections.
    anchorTo: 'end',
    scrollEndThreshold: 96,
    followOnAppend: false,
  });
  // Rows wholly above the reader move the anchor's start. A row spanning the
  // reader can grow below them without moving their reading point.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollOffset ?? 0);

  const remember = useCallback(() => {
    const element = viewport.current;
    if (!element || restoring.current) return;
    position.current = {
      anchor: readingAnchor(virtualizer.measurementsCache, element.scrollTop),
      distanceFromBottom: Math.max(0, virtualizer.getTotalSize() - element.clientHeight - element.scrollTop),
      measurements: [...virtualizer.measurementsCache],
    };
    if (position.current.anchor) positions.set(conversationId, position.current);
  }, [conversationId, virtualizer]);

  const followBottom = useCallback(() => {
    const element = viewport.current;
    if (element && turns.length) element.scrollTo({ top: Math.max(0, virtualizer.getTotalSize() - element.clientHeight), behavior: 'auto' });
    position.current.distanceFromBottom = 0;
    setNewActivity(false);
  }, [turns.length, virtualizer]);

  const size = virtualizer.getTotalSize();
  const height = virtualizer.scrollRect?.height ?? 0;
  useLayoutEffect(() => {
    const old = previous.current;
    previous.current = { turns, size, height };
    if (!turns.length) return;
    const contentChanged = old !== null && old.turns !== turns;
    if (restoring.current) {
      const offset = restoreAnchor(saved?.anchor ?? null, virtualizer.measurementsCache);
      const element = viewport.current;
      if (!element) return;
      // The saved turn can arrive before enough following history exists to
      // put it at the viewport's top. Do not replace the saved anchor with a
      // browser-clamped position while more chunks can still make it reachable.
      const maximumOffset = Math.max(0, element.scrollHeight - element.clientHeight);
      if (!historyComplete && (offset === null || offset > maximumOffset + 0.5)) return;
      if (offset !== null) {
        element.scrollTo({ top: offset, behavior: 'auto' });
      } else followBottom();
      // Reaching the anchor in a partial chunk can also put us at its
      // temporary bottom. Keep the original reading intent until history is
      // complete, so remember() cannot turn the next chunk into a bottom follow.
      if (!historyComplete) return;
      restoring.current = false;
    } else if (!old) {
      if (!saved?.anchor || restoreAnchor(saved.anchor, initialMeasurements) === null) followBottom();
    } else if (nextScrollAction({ distanceFromBottom: position.current.distanceFromBottom, appended: contentChanged, resizedAboveAnchor: old.size !== size || old.height !== height }) === 'follow-bottom') {
      followBottom();
    } else {
      const offset = restoreAnchor(position.current.anchor, virtualizer.measurementsCache);
      if (offset !== null && viewport.current && Math.abs(viewport.current.scrollTop - offset) > 0.5) viewport.current.scrollTo({ top: offset, behavior: 'auto' });
      // Streaming changes to the latest turn count even without a new row.
      if (contentChanged && old.turns.at(-1) !== turns.at(-1)) setNewActivity(true);
    }
    remember();
  }, [turns, size, height, saved, initialMeasurements, followBottom, remember, virtualizer, historyComplete]);

  useLayoutEffect(() => () => remember(), [remember]);

  // Rows are placed with `top`, not a transform: Chromium resolves position: sticky inside a
  // transformed row against the untransformed offset, which pushes sticky content (Streamdown's
  // code-block buttons) to the bottom of its block.
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div aria-label="Conversation transcript" aria-live="off" className="min-h-0 flex-1 overflow-y-auto" onScroll={() => { remember(); if (position.current.distanceFromBottom <= 96) setNewActivity(false); }} ref={viewport} role="log" style={{ overflowAnchor: 'none' }} tabIndex={0}>
        <div className="relative w-full" style={{ height: size }}>
          {virtualizer.getVirtualItems().map((item) => <div className={`absolute left-0 w-full py-4 ${columnClassName}`} data-index={item.index} key={item.key} ref={virtualizer.measureElement} style={{ top: item.start }}>
            <ConversationTurn onResolve={onResolve} turn={turns[item.index]} />
          </div>)}
        </div>
      </div>
      {newActivity && <TooltipProvider><Tooltip><TooltipTrigger asChild><Button aria-label="New activity" className="absolute bottom-4 left-1/2 size-8 -translate-x-1/2 rounded-full border bg-background text-foreground shadow-md hover:bg-muted dark:bg-background dark:hover:bg-muted" onClick={followBottom} size="icon" type="button" variant="outline"><ChevronDown aria-hidden className="size-4" /></Button></TooltipTrigger><TooltipContent>Jump to new activity</TooltipContent></Tooltip></TooltipProvider>}
    </div>
  );
}

export function VirtualTimeline(props: Props) {
  return <Timeline key={props.conversationId} {...props} />;
}
