import { code, type HighlightOptions, type HighlightResult } from '@streamdown/code';
import { useEffect, useState, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';

// The same highlighter and themes Streamdown uses for code blocks in messages.
const themes = code.getThemes();

/** Code syntax-highlighted once the highlighter loads; plain text until then. Defaults to a shell command. */
export function HighlightedCommand({ command, language = 'bash', className }: { command: string; language?: HighlightOptions['language']; className?: string }) {
  const [result, setResult] = useState<HighlightResult | null>(null);

  useEffect(() => {
    let current = true;
    const ready = code.highlight({ code: command, language, themes }, (highlighted) => {
      if (current) setResult(highlighted);
    });
    setResult(ready);
    return () => { current = false; };
  }, [command, language]);

  return (
    <pre className={cn('font-mono', className)}>
      {result
        ? result.tokens.map((line, lineIndex) => (
          <span key={lineIndex}>
            {lineIndex > 0 && '\n'}
            {line.map((token, tokenIndex) => (
              <span
                className="text-[var(--hl-light)] dark:text-[var(--hl-dark)]"
                key={tokenIndex}
                style={{ '--hl-light': token.htmlStyle?.color ?? token.color, '--hl-dark': token.htmlStyle?.['--shiki-dark'] ?? token.color } as CSSProperties}
              >
                {token.content}
              </span>
            ))}
          </span>
        ))
        : command}
    </pre>
  );
}
