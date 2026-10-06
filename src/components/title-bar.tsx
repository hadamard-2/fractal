/**
 * The window is created with `titleBarStyle: 'hidden'` + `titleBarOverlay`, so
 * the OS still paints the minimize/maximize/close buttons over the viewport.
 * This strip is the draggable region across the whole app-bar band — over the
 * sidebar, the content's header, and the right panel alike.
 *
 * It sits *behind* the band's contents: it is first in the document and has
 * no z-index, so the header and the toggles paint over it and get its clicks.
 * The drag region is geometric rather than hit-tested, though, so each control
 * in the band still needs `app-region-no-drag` (index.css) to be clickable.
 */
export function TitleBar() {
  // Deliberately empty: the sidebar header carries the mark and wordmark, and
  // there is no application menu to show here.
  return (
    <header
      // `app-region: drag` hands this strip back to the OS for window dragging.
      style={{
        height: 'var(--app-bar-height)',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
      className="fixed top-0 right-0 left-0"
    />
  );
}
