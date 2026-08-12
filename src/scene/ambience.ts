// Ambient life for the overworld clearing.
//
// The plot had trees, a lake, and woodcutters, and nothing else ever moved.
// Static scenery reads as empty no matter how much of it you add — a forest
// feels alive because things are crossing it, not because the ground is
// busy. This adds the crossings: birds tracking over the treeline,
// butterflies bobbing across the grass, fireflies after dark, and leaves
// coming off the canopy on the breeze.
//
// Design constraints this works within:
//   * Everything is procedural fillRect work in the world palette — no new
//     sprite arrays, no binary assets.
//   * Everything is PASSIVE. Nothing here is clickable, nothing consumes or
//     produces resources, and nothing touches the save. That keeps it clear
//     of the economy entirely, so it needs no sim gating.
//   * Population scales with plot area, for the same reason the ground cover
//     does: a fixed count thins out to nothing exactly when the window gets
//     big enough for the emptiness to show.
//   * Motion is driven off a clock plus a per-critter phase, not Math.random
//     per frame, so nothing jitters.

/** Time of day drives which critters are out — butterflies by day,
 * fireflies at night, birds mostly at the edges of the day. */
export type DayPhase = "day" | "dusk" | "night";

interface Critter {
  /** Position in plot space (logical px). */
  x: number;
  y: number;
  vx: number;
  /** Per-critter animation phase so wingbeats/bobs never sync up. */
  phase: number;
  /** Small per-critter size/colour variation. */
  v: number;
}

const BIRD_PER_PX2 = 1 / 5200;
const BUTTERFLY_PER_PX2 = 1 / 3400;
const FIREFLY_PER_PX2 = 1 / 2600;
const LEAF_PER_PX2 = 1 / 4200;

function populate(
  list: Critter[],
  want: number,
  rand: () => number,
  spawn: (rand: () => number) => Critter,
): void {
  if (want < list.length) {
    list.length = Math.max(0, want);
    return;
  }
  while (list.length < want) list.push(spawn(rand));
}

/** Ambient critter layer for one plot. Owned by Game, ticked from update()
 * and drawn between the ground layer and the depth-sorted sprite pass (birds
 * excepted — they belong over the treeline, see renderSky). */
export class Ambience {
  private birds: Critter[] = [];
  private butterflies: Critter[] = [];
  private fireflies: Critter[] = [];
  private leaves: Critter[] = [];
  private t = 0;
  private w = 180;
  private top = 30;
  private bottom = 113;
  private skyTop = 4;

  constructor(private rand: () => number) {}

  resize(w: number, skyH: number, groundTop: number, groundBottom: number): void {
    this.w = w;
    this.skyTop = Math.max(2, Math.round(skyH * 0.15));
    this.top = groundTop;
    this.bottom = groundBottom;

    const area = Math.max(1, w * Math.max(1, groundBottom - groundTop));
    const skyArea = Math.max(1, w * Math.max(1, skyH));
    const r = this.rand;

    populate(this.birds, Math.min(9, Math.round(skyArea * BIRD_PER_PX2)), r, (rd) => ({
      x: rd() * w,
      y: this.skyTop + rd() * Math.max(4, skyH * 0.6),
      vx: (rd() > 0.5 ? 1 : -1) * (7 + rd() * 8),
      phase: rd() * Math.PI * 2,
      v: rd(),
    }));
    populate(this.butterflies, Math.min(16, Math.round(area * BUTTERFLY_PER_PX2)), r, (rd) => ({
      x: rd() * w,
      y: groundTop + rd() * Math.max(1, groundBottom - groundTop),
      vx: (rd() > 0.5 ? 1 : -1) * (3 + rd() * 4),
      phase: rd() * Math.PI * 2,
      v: rd(),
    }));
    populate(this.fireflies, Math.min(26, Math.round(area * FIREFLY_PER_PX2)), r, (rd) => ({
      x: rd() * w,
      y: groundTop + rd() * Math.max(1, groundBottom - groundTop),
      vx: (rd() > 0.5 ? 1 : -1) * (1.5 + rd() * 2),
      phase: rd() * Math.PI * 2,
      v: rd(),
    }));
    populate(this.leaves, Math.min(18, Math.round(area * LEAF_PER_PX2)), r, (rd) => ({
      x: rd() * w,
      y: groundTop + rd() * Math.max(1, groundBottom - groundTop),
      vx: 2 + rd() * 3,
      phase: rd() * Math.PI * 2,
      v: rd(),
    }));
  }

  update(dt: number): void {
    this.t += dt;
    const wrap = (c: Critter): void => {
      // Wrap a margin outside the plot so nothing pops in or out at the edge.
      if (c.x < -8) c.x = this.w + 8;
      else if (c.x > this.w + 8) c.x = -8;
    };
    for (const b of this.birds) {
      b.x += b.vx * dt;
      wrap(b);
    }
    for (const b of this.butterflies) {
      b.x += b.vx * dt;
      wrap(b);
    }
    for (const f of this.fireflies) {
      f.x += f.vx * dt;
      wrap(f);
    }
    for (const l of this.leaves) {
      l.x += l.vx * dt;
      // Leaves fall, then respawn at the canopy line — a one-way drift, so
      // unlike the others they wrap vertically rather than horizontally.
      l.y += (4 + l.v * 3) * dt;
      if (l.y > this.bottom) {
        l.y = this.top;
        l.x = this.rand() * this.w;
      }
      if (l.x > this.w + 8) l.x = -8;
    }
  }

  /** Birds, drawn over the sky band before the ground layer so they read as
   * distant. `dx` is the plot's scroll offset, same as renderGroundLayer. */
  renderSky(ctx: CanvasRenderingContext2D, dx: number, phase: DayPhase): void {
    ctx.fillStyle = phase === "night" ? "rgba(20, 22, 34, 0.75)" : "rgba(38, 34, 30, 0.7)";
    for (const b of this.birds) {
      const x = Math.round(b.x) + dx;
      // A slow vertical drift plus a wingbeat, both off the same clock: the
      // classic two-pixel "M" bird, flapping between a shallow and a deep V.
      const y = Math.round(b.y + Math.sin(this.t * 0.7 + b.phase) * 2);
      const up = Math.sin(this.t * 7 + b.phase) > 0;
      const dir = b.vx < 0 ? -1 : 1;
      ctx.fillRect(x, y, 1, 1);
      ctx.fillRect(x + dir, y - (up ? 1 : 0), 1, 1);
      ctx.fillRect(x + dir * 2, y, 1, 1);
      if (b.v > 0.6) ctx.fillRect(x - dir, y - (up ? 1 : 0), 1, 1);
    }
  }

  /** Ground-level life. Drawn after the ground layer and before the sorted
   * sprite pass, so critters read as being in the grass rather than on top
   * of the woodcutters. */
  renderGround(ctx: CanvasRenderingContext2D, dx: number, phase: DayPhase): void {
    if (phase !== "night") {
      const wings = ["#e9dc8a", "#e3a6c8", "#dcecf5"];
      for (const b of this.butterflies) {
        const x = Math.round(b.x) + dx;
        // Butterflies bob much harder than they travel — the flutter IS the
        // silhouette at this size.
        const y = Math.round(b.y + Math.sin(this.t * 3.4 + b.phase) * 2.5);
        const open = Math.sin(this.t * 12 + b.phase) > 0;
        ctx.fillStyle = wings[Math.floor(b.v * wings.length)] ?? wings[0];
        ctx.fillRect(x, y, 1, 1);
        if (open) {
          ctx.fillRect(x - 1, y - 1, 1, 1);
          ctx.fillRect(x + 1, y - 1, 1, 1);
        } else {
          ctx.fillRect(x, y - 1, 1, 1);
        }
      }
    }

    if (phase !== "day") {
      for (const f of this.fireflies) {
        const x = Math.round(f.x) + dx;
        const y = Math.round(f.y + Math.sin(this.t * 1.6 + f.phase) * 3);
        // Slow asymmetric pulse — a plain sine reads as a blinking LED.
        const pulse = Math.pow(Math.max(0, Math.sin(this.t * 2.1 + f.phase)), 3);
        if (pulse < 0.04) continue;
        ctx.fillStyle = `rgba(255, 236, 140, ${0.25 + pulse * 0.75})`;
        ctx.fillRect(x, y, 1, 1);
        if (pulse > 0.55) {
          ctx.fillStyle = `rgba(255, 236, 140, ${pulse * 0.28})`;
          ctx.fillRect(x - 1, y, 3, 1);
          ctx.fillRect(x, y - 1, 1, 3);
        }
      }
    }

    for (const l of this.leaves) {
      // Drifting sideways as it falls, and tumbling: the leaf alternates
      // between a 2x1 and a 1x2 as it turns over.
      const x = Math.round(l.x + Math.sin(this.t * 1.9 + l.phase) * 4) + dx;
      const y = Math.round(l.y);
      const flat = Math.sin(this.t * 4.5 + l.phase) > 0;
      ctx.fillStyle = l.v > 0.55 ? "rgba(198, 142, 62, 0.85)" : "rgba(164, 174, 78, 0.85)";
      if (flat) ctx.fillRect(x, y, 2, 1);
      else ctx.fillRect(x, y, 1, 2);
    }
  }
}
