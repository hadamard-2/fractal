/**
 * App-wide keyboard shortcuts: Cmd on macOS, Ctrl elsewhere — either is
 * accepted, like the settings shortcut in App. Matched on `code` rather than
 * `key` so they survive keyboard layouts that put the character elsewhere.
 */
export const MOD_KEY_LABEL = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent) ? '⌘' : 'Ctrl';

/**
 * True when `event` is Mod+`code` with no Shift or Alt, and it did not come
 * from inside a terminal. A shell owns its own control keys (Ctrl+K kills to
 * end of line, Ctrl+N and Ctrl+O walk history), so the app never takes them
 * from one.
 */
export function isAppShortcut(event: KeyboardEvent, code: string): boolean {
  if (event.code !== code || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false;
  return !(event.target instanceof Element && event.target.closest('[data-slot="terminal"]'));
}
