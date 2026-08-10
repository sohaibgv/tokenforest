// Short-lived sprite effects: slash on manual swings, spark on empty-focus
// clicks. Centered on their point, animated over a fixed lifetime.

import { drawSprite, PixelMap, spriteSize } from "./sprites";

export class Effect {
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
