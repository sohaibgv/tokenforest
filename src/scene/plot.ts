// One plot of land: a seeded forest + lake + grass decoration. When a plot
// is clear-cut the woodcutters travel to the next one.

import { mixHex } from "../economy";
import { Forest } from "./forest";
import type { Cell, Grid } from "./grid";
import { Lake } from "./lake";
import { mulberry32 } from "./rng";

export const TREES_PER_PLOT = 28;

/** Ground-cover kinds, in the order they're drawn. Split out because they
 * want genuinely different shapes and colours — 26 identical 2x1 dashes
 * (what this used to be) is not "grass", it's speckle, and on a wide canvas
 * it left the clearing looking like bare paint. */
type CoverKind = "tuft" | "blade" | "flower" | "pebble" | "patch";

interface Cover {
  nx: number;
  ny: number;
  kind: CoverKind;
  /** Per-item variation: flower hue pick, tuft width, patch size. */
  v: number;
}

/** One cover item per this many square logical px. Density, not a fixed
 * count — the whole problem with a fixed count is that it thins out to
 * nothing exactly when the window gets big enough to notice. */
const COVER_PER_PX2 = 1 / 62;
const MAX_COVER = 520;

/** Weighted kind mix. This is overwhelmingly grass on purpose. An even
 * spread across the five kinds turned the clearing into CONFETTI — bright
 * flower and pebble pixels scattered edge to edge at the same frequency as
 * the grass, which is busier than bare ground but reads as noise rather
 * than as a meadow. Accents have to be rare to register as accents. */
const COVER_MIX: { kind: CoverKind; weight: number }[] = [
  { kind: "tuft", weight: 0.4 },
  { kind: "blade", weight: 0.32 },
  { kind: "patch", weight: 0.19 },
  { kind: "flower", weight: 0.055 },
  { kind: "pebble", weight: 0.035 },
];

function pickKind(r: number): CoverKind {
  let acc = 0;
  for (const c of COVER_MIX) {
    acc += c.weight;
    if (r < acc) return c.kind;
  }
  return "tuft";
}

/** Background scenery — bigger than ground cover, purely decorative.
 *
 * These deliberately are NOT trees. Raising TREES_PER_PLOT would fill the
 * clearing too, but trees are the wood supply: more of them per plot is an
 * economy change and would need sim gating before it could ship. Scenery
 * gives the same visual density with zero economic surface — nothing here is
 * clickable, choppable, or saved. */
type SceneryKind = "bush" | "rock" | "stump" | "fern";

interface Scenery {
  nx: number;
  ny: number;
  kind: SceneryKind;
  v: number;
}

const SCENERY_PER_PX2 = 1 / 620;
const MAX_SCENERY = 70;

const SCENERY_MIX: { kind: SceneryKind; weight: number }[] = [
  { kind: "bush", weight: 0.42 },
  { kind: "fern", weight: 0.26 },
  { kind: "rock", weight: 0.19 },
  { kind: "stump", weight: 0.13 },
];

export class Plot {
  forest: Forest;
  lake: Lake;
  private cover: Cover[] = [];
  private scenery: Scenery[] = [];
  private w = 180;
  private groundTop = 30;
  private groundBottom = 113;
  private rand: () => number;

  constructor(seed: number, hpMult: number) {
    const rand = mulberry32(seed);
    this.rand = rand;
    this.lake = new Lake(rand);
    // Avoidance runs in normalized space, close enough to keep trunks dry.
    this.forest = new Forest(rand, TREES_PER_PLOT, hpMult, (nx, ny) =>
      this.lakeAvoidN(nx, ny),
    );
    this.resize(this.w, this.groundTop, this.groundBottom);
  }

  /** Grow or shrink the ground cover to suit the current plot area. Existing
   * items keep their positions, so a resize adds detail rather than
   * reshuffling the whole clearing under the player. */
  private refreshCover(): void {
    const area = Math.max(1, this.w * (this.groundBottom - this.groundTop));
    const want = Math.min(MAX_COVER, Math.round(area * COVER_PER_PX2));
    if (want === this.cover.length) return;
    if (want < this.cover.length) {
      this.cover.length = want;
      return;
    }
    while (this.cover.length < want) {
      const r = this.rand;
      this.cover.push({ nx: r(), ny: r(), kind: pickKind(r()), v: r() });
    }
  }

  private refreshScenery(): void {
    const area = Math.max(1, this.w * (this.groundBottom - this.groundTop));
    const want = Math.min(MAX_SCENERY, Math.round(area * SCENERY_PER_PX2));
    if (want === this.scenery.length) return;
    if (want < this.scenery.length) {
      this.scenery.length = want;
      return;
    }
    while (this.scenery.length < want) {
      const r = this.rand;
      const roll = r();
      let acc = 0;
      let kind: SceneryKind = "bush";
      for (const s of SCENERY_MIX) {
        acc += s.weight;
        if (roll < acc) {
          kind = s.kind;
          break;
        }
      }
      this.scenery.push({ nx: r(), ny: r(), kind, v: r() });
    }
  }

  /** Distant treeline along the back of the plot.
   *
   * The horizon used to be a flat band of colour meeting a flat band of
   * ground — a hard seam with nothing behind it, which is a large part of
   * why the world read as a stage rather than as a place. A silhouetted
   * treeline gives the clearing an edge and implies a forest continuing past
   * it. Drawn in two layers (far/near) at different values so the far ridge
   * sits behind the near one. */
  renderTreeline(ctx: CanvasRenderingContext2D, dx: number): void {
    const baseY = this.groundTop;
    // THREE layers, each with its own step, value and crown shape. Two
    // layers of same-width blobs on a regular step read as a garden hedge,
    // not a forest — the giveaway is a silhouette with one repeating
    // rhythm. Varying step, height range AND crown shape per layer, and
    // jittering each trunk off its slot, is what breaks the pattern.
    const layers = [
      { fill: "rgba(18, 36, 25, 0.5)", step: 5, hMin: 3, hVar: 4, wMin: 3, wVar: 2, drop: 0 },
      { fill: "rgba(24, 47, 31, 0.72)", step: 8, hMin: 5, hVar: 6, wMin: 4, wVar: 3, drop: 1 },
      { fill: "rgba(30, 58, 37, 0.9)", step: 12, hMin: 6, hVar: 8, wMin: 5, wVar: 4, drop: 2 },
    ];
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      ctx.fillStyle = L.fill;
      for (let i = -1; i * L.step < this.w + L.step; i++) {
        // Two decorrelated hashes per trunk: one for size, one for the
        // horizontal jitter, so tall trees aren't always the shifted ones.
        const n = Math.abs(Math.sin(i * 12.9898 + li * 41.7) * 43758.5453) % 1;
        const j = Math.abs(Math.sin(i * 78.233 + li * 19.3) * 24634.6345) % 1;
        // A gap now and then. A continuous wall of crowns reads as a hedge.
        if (n < 0.12) continue;
        const x = Math.round(i * L.step + (j - 0.5) * L.step * 0.8) + dx;
        const th = L.hMin + Math.round(n * L.hVar);
        const tw = L.wMin + Math.round(j * L.wVar);
        // Crowns run a few px BELOW the horizon line so the treeline sinks
        // into the grass instead of sitting on it like a cutout.
        const bottom = baseY + L.drop;
        const top = bottom - th;

        // Silhouettes are built ROW BY ROW with a varying width, because a
        // flat-topped rectangle of varying height is a BUILDING — a row of
        // them is a city skyline, which is exactly what the first version
        // looked like. What makes a shape read as a tree at this size is the
        // outline: a deciduous crown bulges and tapers at both ends, a
        // conifer narrows to a point.
        if (n > 0.7) {
          // Conifer: a spire, widening steadily toward the base.
          for (let r = 0; r < th; r++) {
            const f = th > 1 ? r / (th - 1) : 1;
            const rw = Math.max(1, Math.round(1 + (tw - 1) * f));
            ctx.fillRect(x + Math.round((tw - rw) / 2), top + r, rw, 1);
          }
        } else {
          // Deciduous: widest around 60% down, tapering to a rounded top and
          // pulling back in at the base where the trunk would be.
          for (let r = 0; r < th; r++) {
            const f = th > 1 ? r / (th - 1) : 0.5;
            const bulge = Math.sin(Math.min(1, f * 1.1) * Math.PI * 0.9);
            const rw = Math.max(1, Math.round(tw * (0.3 + 0.7 * bulge)));
            ctx.fillRect(x + Math.round((tw - rw) / 2), top + r, rw, 1);
          }
        }
        // Nearest layer gets a visible trunk under the crown — the detail
        // that confirms "tree" once the shapes are big enough to carry it.
        if (li === layers.length - 1 && th > 6) {
          ctx.fillRect(x + Math.floor(tw / 2), bottom - 1, 1, 2);
        }
      }
    }
  }

  /** Background scenery: bushes, ferns, rocks, stumps. Drawn after ground
   * cover and before the depth-sorted pass, so a woodcutter walks in front
   * of them. They're backdrop, not obstacles — nothing collides with these. */
  renderScenery(ctx: CanvasRenderingContext2D, dx: number, tuftColor: string): void {
    // WorldSpec carries only `ground` and `tuft` — tree colours live in the
    // sprite PALETTE, not the world. Deriving the foliage from the world's
    // own grass colour keeps scenery inside each world's palette without
    // adding fields that would have to be hand-authored for every world.
    const canopy = mixHex(tuftColor, "#1d3a24", 0.5);
    const trunk = "#5a3e26";
    const depth = this.groundBottom - this.groundTop;
    for (const s of this.scenery) {
      const gx = Math.round(2 + s.nx * (this.w - 8)) + dx;
      const gy = Math.round(this.groundTop + 6 + s.ny * (depth - 8));
      if (this.lake.contains(gx - dx, gy)) continue;

      switch (s.kind) {
        case "bush": {
          const bw = 5 + Math.round(s.v * 3);
          ctx.fillStyle = canopy;
          ctx.fillRect(gx, gy - 3, bw, 3);
          ctx.fillRect(gx + 1, gy - 4, bw - 2, 1);
          ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
          ctx.fillRect(gx, gy - 1, bw, 1);
          break;
        }
        case "fern": {
          // Three fronds splaying off a short stem.
          ctx.fillStyle = canopy;
          ctx.fillRect(gx + 2, gy - 3, 1, 3);
          ctx.fillRect(gx, gy - 4, 2, 1);
          ctx.fillRect(gx + 3, gy - 4, 2, 1);
          ctx.fillRect(gx + 2, gy - 5, 1, 1);
          break;
        }
        case "rock": {
          const rw = 3 + Math.round(s.v * 3);
          ctx.fillStyle = "#6e6a60";
          ctx.fillRect(gx, gy - 2, rw, 2);
          ctx.fillStyle = "#87837a";
          ctx.fillRect(gx, gy - 3, rw - 1, 1);
          ctx.fillStyle = "rgba(0, 0, 0, 0.25)";
          ctx.fillRect(gx, gy - 1, rw, 1);
          break;
        }
        case "stump": {
          // A felled trunk with a pale cut face — reads as history, which is
          // exactly right in a world whose whole premise is logging.
          ctx.fillStyle = trunk;
          ctx.fillRect(gx, gy - 3, 4, 3);
          ctx.fillStyle = "rgba(220, 200, 160, 0.5)";
          ctx.fillRect(gx, gy - 4, 4, 1);
          break;
        }
      }
    }
  }

  private lakeAvoidN(nx: number, ny: number): boolean {
    // Mirror the resize mapping cheaply: compare in current absolute space.
    const x = 2 + nx * (this.w - 17);
    const y = this.groundTop + 10 + ny * (this.groundBottom - this.groundTop - 12);
    return this.lake.contains(x, y);
  }

  resize(
    w: number,
    groundTop: number,
    groundBottom: number,
    /** Cells the homestead sits on — trees will not grow there. Only the
     * ACTIVE plot passes this; the incoming plot during a travel slide has
     * no homestead on it yet. */
    reservedCells?: (grid: Grid) => Iterable<Cell>,
  ): void {
    this.w = w;
    this.groundTop = groundTop;
    this.groundBottom = groundBottom;
    this.lake.resize(w, groundTop, groundBottom);
    this.forest.resize(w, groundTop, groundBottom, reservedCells);
    this.refreshCover();
    this.refreshScenery();
  }

  update(dt: number): void {
    this.forest.update(dt);
    this.lake.update(dt);
  }

  setLakeLevel(density: number): void {
    this.lake.setLevel(density);
  }

  /** Ground decoration + lake; trees are painter-sorted by the caller.
   *
   * `tuftColor` stays the world's grass accent and everything green is
   * derived from it, so a world's ground cover always belongs to that
   * world's palette. Flowers and pebbles deliberately step outside it —
   * they're the bits of contrast that make a clearing read as inhabited
   * rather than as textured paint. */
  renderGroundLayer(ctx: CanvasRenderingContext2D, dx: number, tuftColor: string): void {
    const depth = this.groundBottom - this.groundTop;
    for (const c of this.cover) {
      const gx = Math.round(2 + c.nx * (this.w - 4)) + dx;
      const gy = Math.round(this.groundTop + 3 + c.ny * (depth - 4));
      // Nothing grows in the lake.
      if (this.lake.contains(gx - dx, gy)) continue;

      switch (c.kind) {
        case "tuft": {
          // Per-item alpha. At full opacity every blade carried the same
          // weight and the grass read as a uniform stipple pattern; varying
          // it lets the ground recede in places and come forward in others,
          // which is what texture actually is.
          ctx.globalAlpha = 0.35 + c.v * 0.5;
          ctx.fillStyle = tuftColor;
          ctx.fillRect(gx, gy, c.v > 0.5 ? 2 : 1, 1);
          ctx.globalAlpha = 1;
          break;
        }
        case "blade": {
          // A little sprig: two stems of unequal height off a base pixel.
          // Having ANY vertical extent is what separates grass from speckle.
          ctx.globalAlpha = 0.45 + c.v * 0.45;
          ctx.fillStyle = tuftColor;
          ctx.fillRect(gx, gy, 3, 1);
          ctx.fillRect(gx, gy - 1, 1, 1);
          ctx.fillRect(gx + 2, gy - (c.v > 0.5 ? 2 : 1), 1, c.v > 0.5 ? 2 : 1);
          ctx.globalAlpha = 1;
          break;
        }
        case "patch": {
          // Slightly darker turf. Broad, low-contrast shapes are what stop a
          // large ground plane reading as one flat fill — and unlike bright
          // speckle they do it without drawing the eye.
          ctx.fillStyle = "rgba(0, 0, 0, 0.1)";
          const pw = 4 + Math.round(c.v * 7);
          ctx.fillRect(gx, gy, pw, 1 + Math.round(c.v * 2));
          break;
        }
        case "flower": {
          // Muted, not primary. Saturated petals at this frequency were the
          // single biggest contributor to the confetti read.
          const petals = ["#c9b86a", "#c08fa6", "#b9c4d6", "#c98f74"];
          ctx.fillStyle = tuftColor;
          ctx.globalAlpha = 0.7;
          ctx.fillRect(gx + 1, gy, 1, 2);
          ctx.globalAlpha = 0.85;
          ctx.fillStyle = petals[Math.floor(c.v * petals.length)] ?? petals[0];
          ctx.fillRect(gx + 1, gy - 1, 1, 1);
          ctx.globalAlpha = 1;
          break;
        }
        case "pebble": {
          ctx.globalAlpha = 0.65;
          ctx.fillStyle = c.v > 0.5 ? "#7d7a70" : "#66635b";
          ctx.fillRect(gx, gy, 2, 1);
          ctx.globalAlpha = 1;
          break;
        }
      }
    }
    this.lake.render(ctx, dx);
  }
}
