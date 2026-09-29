import path from 'node:path';

/**
 * The executable to launch for an agent: the user's configured location when
 * there is one (with a leading `~` expanded, since no shell is involved in the
 * launch), otherwise the bare name, which is looked up on PATH.
 */
export function configuredExecutable(configured: string, bareName: string, home: string): string {
  if (!configured) return bareName;
  if (configured === '~') return home;
  if (configured.startsWith('~/')) return path.join(home, configured.slice(2));
  return configured;
}

/** Status text for an executable that the OS reported as not existing. */
export function executableNotFoundMessage(executable: string): string {
  return /[/\\]/.test(executable)
    ? `Couldn't find ${executable}. Check its location in Settings.`
    : `Couldn't find "${executable}" on the PATH Fractal searches. Set its location in Settings.`;
}
