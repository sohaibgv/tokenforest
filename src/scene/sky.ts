// Day/night cycle driven by the local clock: sky palette blends through
// dawn/day/dusk/night, the sun (6:00–18:00) or moon (18:00–6:00) travels an
// arc, and stars twinkle after dark.

import { mulberry32 } from "./rng";

type Rgb = [number, number, number];

interface Key {
  h: number;
  top: Rgb;
  bottom: Rgb;
  dark: number; // ground-darkening overlay strength
}

const KEYS: Key[] = [
  { h: 0, top: [11, 16, 38], bottom: [26, 35, 64], dark: 0.4 },
  { h: 5, top: [11, 16, 38], bottom: [26, 35, 64], dark: 0.4 },
  { h: 6.5, top: [74, 90, 138], bottom: [232, 160, 106], dark: 0.18 },
  { h: 8.5, top: [142, 202, 230], bottom: [166, 216, 239], dark: 0 },
  { h: 17, top: [142, 202, 230], bottom: [166, 216, 239], dark: 0 },
  { h: 19, top: [106, 74, 122], bottom: [232, 138, 90], dark: 0.18 },
  { h: 21, top: [11, 16, 38], bottom: [26, 35, 64], dark: 0.4 },
  { h: 24, top: [11, 16, 38], bottom: [26, 35, 64], dark: 0.4 },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): string {
  return `rgb(${Math.round(lerp(a[0], b[0], t))},${Math.round(
    lerp(a[1], b[1], t),
  )},${Math.round(lerp(a[2], b[2], t))})`;
}

const SUN: string[] = ["..##..", ".####.", "######", "######", ".####.", "..##.."];
const MOON: string[] = ["..##..", ".###..", "####..", "####..", ".###..", "..##.."];

export class Sky {
  private t = 0;
  private starSeeds: { nx: number; ny: number; phase: number }[] = [];
  darkness = 0;

  constructor() {
    const rand = mulberry32(777);
    for (let i = 0; i < 26; i++) {
      this.starSeeds.push({ nx: rand(), ny: rand(), phase: Math.floor(rand() * 5) });
    }
  }

  update(dt: number): void {
    this.t += dt;
  }

  render(ctx: CanvasRenderingContext2D, w: number, skyH: number, now: Date): void {
    const hour = now.getHours() + now.getMinutes() / 60;

    let a = KEYS[0];
    let b = KEYS[KEYS.length - 1];
    for (let i = 0; i < KEYS.length - 1; i++) {
      if (hour >= KEYS[i].h && hour <= KEYS[i + 1].h) {
        a = KEYS[i];
        b = KEYS[i + 1];
        break;
      }
    }
    const span = b.h - a.h || 1;
    const t = (hour - a.h) / span;
    this.darkness = lerp(a.dark, b.dark, t);

    const bandH = Math.max(6, Math.round(skyH * 0.3));
    ctx.fillStyle = lerpRgb(a.top, b.top, t);
    ctx.fillRect(0, 0, w, skyH - bandH);
    ctx.fillStyle = lerpRgb(a.bottom, b.bottom, t);
    ctx.fillRect(0, skyH - bandH, w, bandH);

    // Stars fade in with darkness.
    if (this.darkness > 0.2) {
      ctx.fillStyle = "#e8ecff";
      const twinkle = Math.floor(this.t * 1.5);
      for (let i = 0; i < this.starSeeds.length; i++) {
        const s = this.starSeeds[i];
        if ((i + twinkle + s.phase) % 5 === 0) continue;
        ctx.fillRect(
          Math.round(s.nx * (w - 2)),
          Math.round(s.ny * (skyH - 8)),
          1,
          1,
        );
      }
    }

    // Sun 6:00–18:00, moon 18:00–6:00, both arcing left → right.
    const isDay = hour >= 6 && hour < 18;
    const f = isDay ? (hour - 6) / 12 : hour >= 18 ? (hour - 18) / 12 : (hour + 6) / 12;
    const bodyX = Math.round(8 + f * (w - 22));
    const bodyY = Math.round(3 + (skyH - 14) * (1 - Math.sin(Math.PI * f)));
    const map = isDay ? SUN : MOON;
    const color = isDay ? "#ffe9a8" : "#d8dcee";
    ctx.fillStyle = color;
    for (let row = 0; row < map.length; row++) {
      for (let col = 0; col < map[row].length; col++) {
        if (map[row][col] === "#") {
          ctx.fillRect(bodyX + col, bodyY + row, 1, 1);
        }
      }
    }
  }
}
