// One plot of land: a seeded forest + lake + grass decoration. When a plot
// is clear-cut the woodcutters travel to the next one.

import { Forest } from "./forest";
import { Lake } from "./lake";
import { mulberry32 } from "./rng";

export const TREES_PER_PLOT = 28;

export class Plot {
  forest: Forest;
  lake: Lake;
  private tufts: { nx: number; ny: number }[] = [];
  private w = 180;
  private groundTop = 30;
  private groundBottom = 113;

  constructor(seed: number, hpMult: number) {
    const rand = mulberry32(seed);
    this.lake = new Lake(rand);
    // Avoidance runs in normalized space, close enough to keep trunks dry.
    this.forest = new Forest(rand, TREES_PER_PLOT, hpMult, (nx, ny) =>
      this.lakeAvoidN(nx, ny),
    );
    for (let i = 0; i < 26; i++) {
      this.tufts.push({ nx: rand(), ny: rand() });
    }
    this.resize(this.w, this.groundTop, this.groundBottom);
  }

  private lakeAvoidN(nx: number, ny: number): boolean {
    // Mirror the resize mapping cheaply: compare in current absolute space.
    const x = 2 + nx * (this.w - 17);
    const y = this.groundTop + 10 + ny * (this.groundBottom - this.groundTop - 12);
    return this.lake.contains(x, y);
  }

  resize(w: number, groundTop: number, groundBottom: number): void {
    this.w = w;
    this.groundTop = groundTop;
    this.groundBottom = groundBottom;
    this.lake.resize(w, groundTop, groundBottom);
    this.forest.resize(w, groundTop, groundBottom);
  }

  update(dt: number): void {
    this.forest.update(dt);
    this.lake.update(dt);
  }

  setLakeLevel(density: number): void {
    this.lake.setLevel(density);
  }

  /** Ground decoration + lake; trees are painter-sorted by the caller. */
  renderGroundLayer(ctx: CanvasRenderingContext2D, dx: number, tuftColor: string): void {
    ctx.fillStyle = tuftColor;
    for (const t of this.tufts) {
      const gx = Math.round(2 + t.nx * (this.w - 4));
      const gy = Math.round(this.groundTop + 3 + t.ny * (this.groundBottom - this.groundTop - 4));
      ctx.fillRect(gx + dx, gy, 2, 1);
    }
    this.lake.render(ctx, dx);
  }
}
