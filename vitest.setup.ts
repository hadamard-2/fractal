// dnd-kit reads ResizeObserver as its module loads; jsdom does not provide it.
if (typeof window !== 'undefined') {
  globalThis.ResizeObserver ??= class {
    observe() { /* jsdom has no layout */ }
    unobserve() { /* jsdom has no layout */ }
    disconnect() { /* jsdom has no layout */ }
  };
  globalThis.PointerEvent ??= MouseEvent as typeof PointerEvent;
}
