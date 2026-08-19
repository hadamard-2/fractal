/**
 * The window is created with `titleBarStyle: 'hidden'` + `titleBarOverlay`, so
 * the OS still paints the minimize/maximize/close buttons over the top-right of
 * the viewport. This strip is the draggable region beneath them; sizing to
 * `--titlebar-height` (which wraps `env(titlebar-area-height)`) keeps it
 * exactly as tall as the overlay.
 */
export function TitleBar() {
  return (
    <header
      // `app-region: drag` hands this strip back to the OS for window dragging.
      style={{
        height: 'var(--titlebar-height)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
      className="fixed top-0 right-0 left-0 z-50"
    />
  );
}
