/**
 * Mirrors the color scheme onto the document's `dark` class — the thing
 * Tailwind's `dark:` variant and index.css's tokens key off.
 *
 * The source of truth is `nativeTheme.themeSource` in the main process:
 * Electron projects it into this context's prefers-color-scheme media query,
 * so 'system' tracks the OS live and 'light'/'dark' override it. This module
 * only translates the query into the class; the persisted preference never
 * reaches the renderer as state, and there is no theme IPC event to listen
 * for — the media query change event is the notification.
 *
 * Must run before React mounts (called from renderer.tsx) so the class is
 * already right at first paint.
 */
const QUERY = '(prefers-color-scheme: dark)';

export function initThemeSync(): void {
  const media = window.matchMedia(QUERY);
  const apply = () => {
    document.documentElement.classList.toggle('dark', media.matches);
  };
  media.addEventListener('change', apply);
  apply();
}
