/**
 * The window is created with `titleBarStyle: 'hidden'` + `titleBarOverlay`, so
 * the OS still paints the minimize/maximize/close buttons over the viewport.
 * This strip is the draggable region beneath them; sizing to
 * `--titlebar-height` (which wraps `env(titlebar-area-height)`) keeps it
 * exactly as tall as the overlay.
 */
export function TitleBar() {
  return (
    <header
      // `app-region: drag` hands this strip back to the OS for window dragging.
      style={{
        height: 'var(--titlebar-height)',
        paddingLeft: 'calc(env(titlebar-area-x, 0px) + 1rem)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
      className="fixed top-0 right-0 left-0 z-50 flex items-center pr-4"
    >
      <div aria-hidden="true" className="pointer-events-none flex select-none items-center gap-5 text-sm text-muted-foreground">
        <span>File</span><span>Edit</span><span>View</span><span>Help</span>
      </div>
    </header>
  );
}
