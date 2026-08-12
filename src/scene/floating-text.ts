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
    // Ease-out cubic rise: pops up fast, drifts to a hover — reads livelier
    // than the old linear crawl at identical start/end positions.
    const eased = 1 - (1 - this.t) ** 3;
    const y = Math.round(this.y - eased * RISE_PX);
    const x = Math.round(this.x - textWidth(this.text) / 2);
    drawText(ctx, this.text, x + 1, y + 1, "#1d2b21");
    drawText(ctx, this.text, x, y, this.color);
    ctx.globalAlpha = 1;
  }
}

// Suffix ladder, highest tier first — k/M behavior below is byte-identical
// to the original two-tier implementation for the same inputs, just no
// longer hardcoded to stop there. P = peta (10^15), a single-letter tier
// chosen for headroom past B/T without needing more than one extra glyph.
const ABBREV_TIERS: { threshold: number; suffix: string }[] = [
  { threshold: 1_000_000_000_000_000, suffix: "P" },
  { threshold: 1_000_000_000_000, suffix: "T" },
  { threshold: 1_000_000_000, suffix: "B" },
  { threshold: 1_000_000, suffix: "M" },
  { threshold: 1_000, suffix: "k" },
];

export function abbrev(n: number): string {
  for (const { threshold, suffix } of ABBREV_TIERS) {
    if (n >= threshold) {
      const v = n / threshold;
      return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${suffix}`;
    }
  }
  return String(Math.round(n));
}

/** CSS class to layer onto a `.hp-bar-fill` at low/critical HP thresholds —
 * mirrors main.ts's paintBar() red/amber/green budget-meter thresholds
 * (<15% critical, <35% low) so "danger" reads the same way everywhere in
 * the app. Callers toggle the returned class alongside their existing
 * `style.width` assignment, since pure CSS can't branch on an inline width. */
export function hpBarClass(pct: number): "critical" | "low" | "" {
  if (pct < 15) return "critical";
  if (pct < 35) return "low";
  return "";
}
