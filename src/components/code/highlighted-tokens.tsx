import { code, type HighlightResult } from '@streamdown/code';
import { useEffect, useState, type CSSProperties } from 'react';
import type { HighlightLanguage } from '@/renderer/file-display';

// The same highlighter and themes Streamdown uses for code blocks in messages.
const themes = code.getThemes();

type Token = HighlightResult['tokens'][number][number];

/** `source` as highlighted lines of tokens; null until the highlighter has loaded, or with no language. */
export function useHighlightedTokens(source: string, language: HighlightLanguage | undefined): HighlightResult['tokens'] | null {
  const [result, setResult] = useState<HighlightResult | null>(null);
  useEffect(() => {
    if (!language) { setResult(null); return; }
    let current = true;
    const ready = code.highlight({ code: source, language, themes }, (highlighted) => {
      if (current) setResult(highlighted);
    });
    setResult(ready);
    return () => { current = false; };
  }, [source, language]);
  return result?.tokens ?? null;
}

/** One highlighted line, coloured for the light and dark themes. */
export function TokenLine({ tokens }: { tokens: Token[] }) {
  return (
    <>
      {tokens.map((token, index) => (
        <span
          className="text-[var(--hl-light)] dark:text-[var(--hl-dark)]"
          key={index}
          style={{ '--hl-light': token.htmlStyle?.color ?? token.color, '--hl-dark': token.htmlStyle?.['--shiki-dark'] ?? token.color } as CSSProperties}
        >
          {token.content}
        </span>
      ))}
    </>
  );
}
