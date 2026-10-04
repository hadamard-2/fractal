import { code } from '@streamdown/code';

export type HighlightLanguage = Parameters<typeof code.supportsLanguage>[0];

export const basename = (path: string): string => path.split(/[\\/]/).pop() || path;

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** The highlighter language for a file: its extension, or for a file with none its name; undefined when unsupported. */
export function languageFor(path: string): HighlightLanguage | undefined {
  const extension = basename(path).split('.').pop()?.toLowerCase() ?? '';
  return extension && code.supportsLanguage(extension as HighlightLanguage) ? extension as HighlightLanguage : undefined;
}

/** A project-relative, '/'-separated path joined onto its project root, using the root's own separator. */
export function absoluteProjectPath(root: string, path: string): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${separator}${path.split('/').join(separator)}`;
}
