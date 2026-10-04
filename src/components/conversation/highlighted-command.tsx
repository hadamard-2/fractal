import { useHighlightedTokens, TokenLine } from '@/components/code/highlighted-tokens';
import { cn } from '@/lib/utils';
import type { HighlightLanguage } from '@/renderer/file-display';

/** Code syntax-highlighted once the highlighter loads; plain text until then. Defaults to a shell command. */
export function HighlightedCommand({ command, language = 'bash', className }: { command: string; language?: HighlightLanguage; className?: string }) {
  const tokens = useHighlightedTokens(command, language);
  return (
    <pre className={cn('font-mono', className)}>
      {tokens
        ? tokens.map((line, lineIndex) => (
          <span key={lineIndex}>
            {lineIndex > 0 && '\n'}
            <TokenLine tokens={line} />
          </span>
        ))
        : command}
    </pre>
  );
}
