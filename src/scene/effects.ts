// Short-lived sprite effects: slash on manual swings, spark on empty-focus
// clicks. Centered on their point, animated over a fixed lifetime.

import { drawSprite, PixelMap, spriteSize } from "./sprites";

/** Anything the Game's transient-effects list can hold. */
export interface SceneEffect {
  update(dt: number): void;
  readonly done: boolean;
  render(ctx: CanvasRenderingContext2D): void;
}

export class Effect implements SceneEffect {
  private t = 0;

  constructor(
    private x: number,
    private y: number,
    private frames: PixelMap[],
    private secs: number,
  ) {}

  update(dt: number): void {
    this.t += dt / this.secs;
  }

  get done(): boolean {
    return this.t >= 1;
  }

  render(ctx: CanvasRenderingContext2D): void {
    const frame = this.frames[
      Math.min(this.frames.length - 1, Math.floor(this.t * this.frames.length))
    ];
    const { w, h } = spriteSize(frame);
    drawSprite(ctx, frame, Math.round(this.x - w / 2), Math.round(this.y - h / 2));
  }
}

/** Leaf-particle burst on a tree fell: a handful of 1-2px "leaves" thrown
 * up and outward from the canopy, drifting down with a little sway before
 * fading. Colors come from the felled tree's own canopy palette so the
 * burst matches every world's re-themed foliage. */
export class LeafBurst implements SceneEffect {
  private t = 0;
  private particles: { x: number; y: number; vx: number; vy: number; size: number; color: string; sway: number }[];

  constructor(x: number, y: number, colors: string[], count = 10, private secs = 0.9) {
    this.particles = Array.from({ length: count }, () => ({
      x: x + (Math.random() - 0.5) * 8,
      y: y + (Math.random() - 0.5) * 6,
      vx: (Math.random() - 0.5) * 28,
      vy: -14 - Math.random() * 22,
      size: Math.random() < 0.35 ? 2 : 1,
      color: colors[Math.floor(Math.random() * colors.length)] ?? "#4a9e5c",
      sway: 2 + Math.random() * 4,
    }));
  }

  update(dt: number): void {
    this.t += dt / this.secs;
    for (const p of this.particles) {
      p.vy += 70 * dt; // gravity
      p.x += (p.vx + Math.sin(this.t * 12) * p.sway) * dt;
      p.y += p.vy * dt;
    }
  }

  get done(): boolean {
    return this.t >= 1;
  }

  render(ctx: CanvasRenderingContext2D): void {
    ctx.globalAlpha = Math.max(0, 1 - this.t * this.t);
    for (const p of this.particles) {
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }
}

/** A wisp of steam lifting off a hot surface — the Whetstone (and the active
 * woodcutter's axe) once Focus runs hot enough to glow.
 *
 * Deliberately its own class rather than a LeafBurst variant: LeafBurst
 * applies downward gravity and its particles arc and fall, which is exactly
 * wrong for steam. Here the drift is upward, decelerating, with a sideways
 * sway and a fade that thins as the wisp rises.
 */
export class SteamWisp implements SceneEffect {
  private t = 0;
  private particles: { x: number; y: number; vy: number; sway: number; phase: number }[];

  constructor(
    x: number,
    y: number,
    count = 3,
    private secs = 1.1,
  ) {
    this.particles = Array.from({ length: count }, () => ({
      x: x + (Math.random() - 0.5) * 3,
      y,
      vy: -6 - Math.random() * 5,
      sway: 1.5 + Math.random() * 2,
      phase: Math.random() * Math.PI * 2,
    }));
  }

  update(dt: number): void {
    this.t += dt / this.secs;
    for (const p of this.particles) {
      p.vy += 4 * dt; // slight deceleration, so wisps stall as they cool
      p.y += p.vy * dt;
      p.x += Math.sin(this.t * 5 + p.phase) * p.sway * dt;
    }
  }

  get done(): boolean {
    return this.t >= 1;
  }

  render(ctx: CanvasRenderingContext2D): void {
    ctx.globalAlpha = Math.max(0, 0.55 * (1 - this.t));
    ctx.fillStyle = "#e8eef2";
    for (const p of this.particles) {
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
    ctx.globalAlpha = 1;
  }
}
