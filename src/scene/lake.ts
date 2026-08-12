// A pond that drains as the token budget is spent: full water at full
// budget, cracked mud at zero. Geometry is seeded per plot and normalized,
// so it survives window resizes.

const BED = "#8a7350";
const BED_DARK = "#6e5a3e";
const WATER = "#3a7bbf";
const WATER_LIGHT = "#5a9bd8";
const WATER_EDGE = "#2d6299";

export class Lake {
  private level = 1;
  private t = 0;
  // Normalized center within the ground area + radius as width fraction.
  private ncx: number;
  private ncy: number;
  private nrx: number;
  // Absolute geometry, recomputed on resize.
  cx = 0;
  cy = 0;
  rx = 20;
  ry = 8;

  constructor(rand: () => number) {
    this.ncx = 0.2 + 0.6 * rand();
    this.ncy = 0.3 + 0.5 * rand();
    this.nrx = 0.12 + 0.07 * rand();
  }

  resize(w: number, groundTop: number, groundBottom: number): void {
    this.rx = Math.round(Math.min(46, Math.max(16, this.nrx * w)));
    this.ry = Math.max(6, Math.round(this.rx * 0.38));
    const gh = groundBottom - groundTop;
    this.cx = Math.round(this.rx + 2 + this.ncx * (w - 2 * this.rx - 4));
    this.cy = Math.round(groundTop + this.ry + 2 + this.ncy * (gh - 2 * this.ry - 4));
  }

  /** Nudge the pond clear of a rectangle — in practice the homestead yard.
   *
   * The lake's position is seeded per plot and the yard is always anchored
   * bottom-left, so sooner or later the two land on each other: the fence
   * runs through the shallows and the lantern stands in the water. Biasing
   * the seed away from that corner instead would make every plot's pond sit
   * in the same place, which costs more than it buys — a nudge only moves
   * the ponds that actually conflict.
   *
   * Moves RIGHT by preference, since the homestead hugs the left edge, and
   * falls back to moving UP when there isn't room to the right. Both are
   * clamped to keep the pond on the plot. */
  avoidRect(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    w: number,
    groundTop: number,
    groundBottom: number,
  ): void {
    const mx = this.rx + 5;
    const my = this.ry + 4;
    if (this.cx + mx <= x0 || this.cx - mx >= x1 || this.cy + my <= y0 || this.cy - my >= y1) return;

    const wantCx = x1 + mx + 1;
    if (wantCx <= w - this.rx - 2) {
      this.cx = wantCx;
      return;
    }
    const wantCy = y0 - my - 1;
    this.cy = Math.max(groundTop + this.ry + 2, Math.min(groundBottom - this.ry - 2, wantCy));
  }

  private dist2(x: number, y: number, rx: number, ry: number): number {
    const dx = (x - this.cx) / rx;
    const dy = (y - this.cy) / ry;
    return dx * dx + dy * dy;
  }

  /** True if a point is on the lake (bed + margin) — keeps trees out. */
  contains(x: number, y: number): boolean {
    return this.dist2(x, y, this.rx + 5, this.ry + 4) <= 1;
  }

  setLevel(density: number): void {
    this.level = density;
  }

  update(dt: number): void {
    this.t += dt;
  }

  /** Position along a swim path inside the CURRENT water body, for the
   * Cache Koi mechanic (see Game's koi fields) — `phase` is an angle in
   * radians, animated by the caller once per frame. Scales with `level`
   * exactly like render()'s own water ellipse, so the koi is always
   * visually swimming in water, never drawn over dry bed, at any budget
   * level (render()'s scale floors at 0.18, so there's always at least a
   * small puddle to swim in). Inset further (0.62) from the water's own
   * edge so the koi never clips the shoreline. */
  koiPosition(phase: number): { x: number; y: number } {
    const scale = (0.18 + 0.82 * this.level) * 0.62;
    return {
      x: Math.round(this.cx + Math.cos(phase) * this.rx * scale),
      y: Math.round(this.cy + Math.sin(phase) * this.ry * scale),
    };
  }

  render(ctx: CanvasRenderingContext2D, dx: number): void {
    const scale = 0.18 + 0.82 * this.level;
    const wrx = this.rx * scale;
    const wry = this.ry * scale;
    const shimmerPhase = Math.floor(this.t * 3);

    for (let y = this.cy - this.ry - 1; y <= this.cy + this.ry + 1; y++) {
      for (let x = this.cx - this.rx - 1; x <= this.cx + this.rx + 1; x++) {
        const bed = this.dist2(x, y, this.rx, this.ry);
        if (bed > 1) continue;
        if (this.level > 0.03 && this.dist2(x, y, wrx, wry) <= 1) {
          const edge = this.dist2(x, y, wrx, wry) > 0.72;
          const shimmer = (x * 3 + y * 5 + shimmerPhase) % 11 === 0;
          ctx.fillStyle = edge ? WATER_EDGE : shimmer ? WATER_LIGHT : WATER;
        } else {
          const crack =
            this.level < 0.5 &&
            (x * 7 + y * 13) % Math.max(4, Math.round(9 * this.level + 4)) === 0;
          ctx.fillStyle = crack || bed > 0.82 ? BED_DARK : BED;
        }
        ctx.fillRect(x + dx, y, 1, 1);
      }
    }
  }
}
