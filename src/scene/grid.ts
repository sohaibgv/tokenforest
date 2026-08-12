// Tile grid over the ground area — the spatial model the world is built on,
// and the foundation for placeable/buildable objects (cottage, yard props,
// shop buildables).
//
// The grid is the DATA model, not the visual one. Trees and scenery snap to a
// cell but render at a deterministic jittered offset INSIDE that cell, so the
// forest still reads as organically scattered rather than as a chessboard.
// Buildables, by contrast, sit dead-centre in their cell — that's what makes
// a placed row of objects line up the way a player expects when building.
//
// Everything here works in the canvas's logical pixel space (see Game.w/h),
// and the grid is rebuilt on resize since the canvas is as wide as the
// player's window.

/** Logical pixels per cell. Chosen so a cell comfortably holds a small tree
 * (7x8) or a prop, and so even the minimum 140px-wide canvas still gets a
 * usable ~11 columns to build on. */
export const CELL = 12;

export interface Cell {
  cx: number;
  cy: number;
}

/** Deterministic per-cell hash in [0,1). Same cell always yields the same
 * jitter, so trees don't shimmer between frames or jump on resize — but two
 * neighbouring cells look unrelated, which is what sells the scatter. */
function cellNoise(cx: number, cy: number, salt: number): number {
  let h = (cx * 374761393 + cy * 668265263 + salt * 1442695040888963407) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}

export class Grid {
  /** Playable bounds in logical px. */
  private x0 = 0;
  private y0 = 0;
  cols = 0;
  rows = 0;

  resize(w: number, groundTop: number, groundBottom: number): void {
    this.x0 = 0;
    this.y0 = groundTop;
    this.cols = Math.max(1, Math.floor(w / CELL));
    this.rows = Math.max(1, Math.floor((groundBottom - groundTop) / CELL));
  }

  inBounds(c: Cell): boolean {
    return c.cx >= 0 && c.cy >= 0 && c.cx < this.cols && c.cy < this.rows;
  }

  /** Cell containing a logical point (may be out of bounds — check separately). */
  cellAt(x: number, y: number): Cell {
    return {
      cx: Math.floor((x - this.x0) / CELL),
      cy: Math.floor((y - this.y0) / CELL),
    };
  }

  /** Exact centre of a cell. Buildables anchor here, so placed objects align. */
  center(c: Cell): { x: number; y: number } {
    return {
      x: this.x0 + c.cx * CELL + CELL / 2,
      y: this.y0 + c.cy * CELL + CELL / 2,
    };
  }

  /** Bottom-centre of a cell — the natural footing for anything that stands on
   * the ground (trees, props), since sprites are drawn upward from their base. */
  footing(c: Cell): { x: number; y: number } {
    return {
      x: this.x0 + c.cx * CELL + CELL / 2,
      y: this.y0 + (c.cy + 1) * CELL,
    };
  }

  /** Footing nudged by a stable per-cell offset, kept inside the cell with a
   * small margin. This is what stops a fully tiled world looking rigid: the
   * grid decides WHICH cell a tree occupies, this decides where in that cell it
   * actually stands. */
  jitteredFooting(c: Cell, margin = 3): { x: number; y: number } {
    const span = Math.max(0, CELL - margin * 2);
    const jx = (cellNoise(c.cx, c.cy, 1) - 0.5) * span;
    // Vertical jitter is deliberately smaller and biased downward: y doubles as
    // draw order, so large vertical scatter would visibly break depth sorting
    // against neighbouring cells.
    const jy = (cellNoise(c.cx, c.cy, 2) - 0.5) * (span * 0.5);
    const base = this.footing(c);
    return { x: Math.round(base.x + jx), y: Math.round(base.y + jy) };
  }

  /** Iterates every in-bounds cell. */
  *cells(): Generator<Cell> {
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        yield { cx, cy };
      }
    }
  }

  /** Stable string key for maps/sets of occupied cells. */
  static key(c: Cell): string {
    return `${c.cx},${c.cy}`;
  }

  static parseKey(k: string): Cell {
    const [cx, cy] = k.split(",").map(Number);
    return { cx, cy };
  }
}
