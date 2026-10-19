import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseMapLayout, type MapLayout } from '@/shared/map-contract';

interface StoredLayouts { conversations: Record<string, MapLayout> }

/**
 * Where the user left each root conversation's map: node positions, widths and the
 * Preview/Full setting. This is Fractal's own convenience state, so an unreadable file
 * or invalid entry reads as absent and is replaced on the next write.
 */
export class MapLayoutStore {
  private readonly filePath: string;

  constructor(rootDir: string) {
    this.filePath = path.join(rootDir, 'map-layouts.json');
    mkdirSync(rootDir, { recursive: true });
  }

  get(conversationKey: string): MapLayout | undefined { return this.load().conversations[conversationKey]; }

  set(conversationKey: string, layout: MapLayout): void {
    const stored = this.load();
    stored.conversations[conversationKey] = layout;
    this.save(stored);
  }

  private load(): StoredLayouts {
    const stored: StoredLayouts = { conversations: {} };
    if (!existsSync(this.filePath)) return stored;
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(this.filePath, 'utf8')); } catch { return stored; }
    for (const [key, value] of Object.entries(objectValue(objectValue(parsed)?.conversations) ?? {})) {
      try { stored.conversations[key] = parseMapLayout(value); } catch { /* Drop the invalid entry, keep its siblings. */ }
    }
    return stored;
  }

  private save(stored: StoredLayouts): void {
    const tmpPath = `${this.filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(stored, null, 2));
    renameSync(tmpPath, this.filePath);
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
