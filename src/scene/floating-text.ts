// "-1.2k" labels that rise from the axe impact and fade out.

import { drawText, textWidth } from "./sprites";

const LIFE_SECS = 1.5;
const RISE_PX = 12;

export class FloatingText {
  private t = 0;

  constructor(
    private x: number,
    private y: number,
    private text: string,
    private color = "#ffe9a8",
  ) {}

  update(dt: number): void {
    this.t += dt / LIFE_SECS;
  }

  get done(): boolean {
    return this.t >= 1;
  }

  render(ctx: CanvasRenderingContext2D): void {
    const alpha = this.t < 0.6 ? 1 : 1 - (this.t - 0.6) / 0.4;
    ctx.globalAlpha = Math.max(0, alpha);
    const y = Math.round(this.y - this.t * RISE_PX);
    const x = Math.round(this.x - textWidth(this.text) / 2);
    drawText(ctx, this.text, x + 1, y + 1, "#1d2b21");
    drawText(ctx, this.text, x, y, this.color);
    ctx.globalAlpha = 1;
  }
}

export function abbrev(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : Math.round(m * 10) / 10}M`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${k >= 10 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return String(n);
}
