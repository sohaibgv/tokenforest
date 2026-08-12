// Tiny shared registry so opening one panel (Shop / Adventure / Settings)
// closes the others — this is a tray-widget window, not real estate for
// multiple overlays stacked on top of each other.

type CloseFn = () => void;

const closers = new Map<string, CloseFn>();

export function registerOverlay(id: string, close: CloseFn): void {
  closers.set(id, close);
}

export function closeOtherOverlays(exceptId: string): void {
  for (const [id, close] of closers) {
    if (id !== exceptId) close();
  }
}

/** True if any registered overlay is currently showing — assumes each
 * registered id matches a real DOM element's id, toggled via the shared
 * `.hidden` class convention every overlay module already follows. Used by
 * Escape-key handling to close an open menu before falling back to hiding
 * the whole window. */
export function anyOverlayOpen(): boolean {
  for (const id of closers.keys()) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains("hidden")) return true;
  }
  return false;
}

export function closeAllOverlays(): void {
  for (const close of closers.values()) close();
}
