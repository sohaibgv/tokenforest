// Frameless (decorations: false) windows don't get a native resize cursor
// at their edges on Linux/GTK — this is a window-manager limitation, not
// something Tauri config can fix. WebKitGTK renders its own CSS cursor
// though, so we hand-roll edge-hover detection + Tauri's resize-drag API.

import { getCurrentWindow } from "@tauri-apps/api/window";

// Not exported by @tauri-apps/api/window, so redeclared here to match
// Window.startResizeDragging's parameter type exactly.
type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const MARGIN = 6;

const CURSOR: Record<ResizeDirection, string> = {
  North: "ns-resize",
  South: "ns-resize",
  East: "ew-resize",
  West: "ew-resize",
  NorthEast: "nesw-resize",
  SouthWest: "nesw-resize",
  NorthWest: "nwse-resize",
  SouthEast: "nwse-resize",
};

function edgeFor(x: number, y: number, w: number, h: number): ResizeDirection | null {
  const n = y <= MARGIN;
  const s = y >= h - MARGIN;
  const west = x <= MARGIN;
  const east = x >= w - MARGIN;
  if (n && west) return "NorthWest";
  if (n && east) return "NorthEast";
  if (s && west) return "SouthWest";
  if (s && east) return "SouthEast";
  if (n) return "North";
  if (s) return "South";
  if (west) return "West";
  if (east) return "East";
  return null;
}

export function initResizeEdges(): void {
  // No Tauri bridge (plain-browser dev): edge resize is meaningless there
  // — skip wiring instead of letting getCurrentWindow()'s sync throw kill
  // the rest of boot.
  let appWindow: ReturnType<typeof getCurrentWindow>;
  try {
    appWindow = getCurrentWindow();
  } catch {
    return;
  }

  window.addEventListener(
    "mousemove",
    (e) => {
      const dir = edgeFor(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
      document.body.style.cursor = dir ? CURSOR[dir] : "";
    },
    { passive: true },
  );
  window.addEventListener("mouseleave", () => {
    document.body.style.cursor = "";
  });

  window.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      const dir = edgeFor(e.clientX, e.clientY, window.innerWidth, window.innerHeight);
      if (!dir) return;
      const target = e.target as HTMLElement;
      if (target.closest("button, input, #shop, #settings, #adventure")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void appWindow.startResizeDragging(dir);
    },
    { capture: true },
  );
}
