import { useCallback, useEffect, useRef, useState } from 'react';
import { codePlugin } from '@/components/code/fractal-theme';
import type { Token } from '@/components/code/highlighted-tokens';
import { languageFor } from '@/renderer/file-display';
import type { ChangedFile } from '@/shared/changes-contract';
import { FILE_HIGHLIGHT_MAX_BYTES } from '@/shared/files-contract';

type Side = 'old' | 'new';
type Highlighted = Partial<Record<Side, Token[][]>>;

const themes = codePlugin.getThemes();
// Files from a new read are new objects, so they are highlighted afresh.
const cache = new WeakMap<ChangedFile, Highlighted>();
const requested = new WeakMap<ChangedFile, Set<Side>>();
const encoder = new TextEncoder();

/** The lines of one side across all hunks, joined by '\n'; a token array's index is the row's `sideIndex`. */
function sideText(file: ChangedFile, side: Side): string {
  if (file.body.kind !== 'hunks') return '';
  const lines: string[] = [];
  for (const hunk of file.body.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'context' || line.kind === (side === 'old' ? 'removed' : 'added')) lines.push(line.text);
    }
  }
  return lines.join('\n');
}

const fits = (text: string) => text.length <= FILE_HIGHLIGHT_MAX_BYTES && encoder.encode(text).length <= FILE_HIGHLIGHT_MAX_BYTES;

/**
 * Highlights each visible file as two texts, its old and its new side, and
 * returns a lookup of the tokens for a row; null until the highlighter has
 * loaded, or for a file that has no language or is over the size bound.
 */
export function useDiffHighlights(files: ChangedFile[], visibleFileIndexes: number[]): (fileIndex: number, side: Side, sideIndex: number) => Token[] | null {
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const visible = visibleFileIndexes.join(',');

  useEffect(() => {
    for (const index of visible ? visible.split(',').map(Number) : []) {
      const file = files[index];
      const language = file && file.body.kind === 'hunks' ? languageFor(file.path) : undefined;
      if (!file || !language) continue;
      const done = requested.get(file) ?? new Set<Side>();
      if (done.size === 2) continue;
      requested.set(file, done);
      const texts = { old: sideText(file, 'old'), new: sideText(file, 'new') };
      if (!fits(texts.old) || !fits(texts.new)) {
        done.add('old').add('new');
        continue;
      }
      for (const side of ['old', 'new'] as const) {
        if (done.has(side)) continue;
        done.add(side);
        if (!texts[side]) continue;
        const store = (result: { tokens: Token[][] }) => {
          cache.set(file, { ...cache.get(file), [side]: result.tokens });
          if (mounted.current) setVersion((count) => count + 1);
        };
        const ready = codePlugin.highlight({ code: texts[side], language, themes }, store);
        if (ready) store(ready);
      }
    }
  }, [files, visible]);

  return useCallback((fileIndex, side, sideIndex) => {
    const file = files[fileIndex];
    return (file && cache.get(file)?.[side]?.[sideIndex]) || null;
    // The lookup changes with each landed result so rows that use it render again.
  }, [files, version]);
}
