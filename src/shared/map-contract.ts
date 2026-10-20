import type { ConversationRef } from '@/shared/conversation-contract';

export type MapView = 'preview' | 'full';

/** x and y are both present or both absent, and at least one field is: a moved node has its spot, a resized one its width. */
export interface MapNodeLayout { x?: number; y?: number; width?: number }

/** Per root conversation. A node is listed only once the user has moved or resized it; one without a spot, and every unlisted one, is placed automatically. */
export interface MapLayout { view: MapView; nodes: Record<string, MapNodeLayout> }

export const MAP_CHANNELS = { layout: 'fractal:map:layout', saveLayout: 'fractal:map:save-layout' } as const;

export interface MapApi {
  layout(ref: ConversationRef): Promise<MapLayout>;
  saveLayout(ref: ConversationRef, layout: MapLayout): Promise<void>;
}

export const EMPTY_MAP_LAYOUT: MapLayout = { view: 'preview', nodes: {} };

const MAX_NODES = 5000;
const MAX_NODE_ID_LENGTH = 600;
const MAX_COORDINATE = 10_000_000;
const MIN_WIDTH = 240;
const MAX_WIDTH = 960;

function invalidLayout(): never {
  throw new Error('Invalid map layout');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function numberWithin(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) invalidLayout();
  return value;
}

function parseNode(value: unknown): MapNodeLayout {
  if (!plainObject(value)) invalidLayout();
  const placed = value.x !== undefined || value.y !== undefined;
  if (!placed && value.width === undefined) invalidLayout();
  const position = placed ? { x: numberWithin(value.x, -MAX_COORDINATE, MAX_COORDINATE), y: numberWithin(value.y, -MAX_COORDINATE, MAX_COORDINATE) } : {};
  return value.width === undefined ? position : { ...position, width: numberWithin(value.width, MIN_WIDTH, MAX_WIDTH) };
}

/** Validates an untrusted layout and returns a copy holding only the known fields. */
export function parseMapLayout(value: unknown): MapLayout {
  if (!plainObject(value) || (value.view !== 'preview' && value.view !== 'full') || !plainObject(value.nodes)) invalidLayout();
  const entries = Object.entries(value.nodes);
  if (entries.length > MAX_NODES) invalidLayout();
  const nodes = entries.map(([id, node]): [string, MapNodeLayout] => {
    if (id.length > MAX_NODE_ID_LENGTH) invalidLayout();
    return [id, parseNode(node)];
  });
  return { view: value.view, nodes: Object.fromEntries(nodes) };
}
