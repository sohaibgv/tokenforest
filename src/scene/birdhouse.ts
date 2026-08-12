// Birdhouse art for the save-slot picker: three houses mounted on one post,
// one per slot. An occupied slot has a bluebird asleep inside, an empty one
// shows a bundle of nesting twigs, and a slot armed for deletion swings its
// hatch open with the bird gone — so the destructive state is visible in the
// art, not only in a button's label.
//
// Structured exactly like scene/gacha-machine.ts: large flat regions are
// ctx.fillRect panels (hand-authoring a 36x40 PixelMap would be ~1400
// characters of ASCII for no gain over a filled rect) with small PixelMap
// detail layers composited on top via drawSprite/withPalette.
//
// Deliberately imports nothing from ui/*: the picker renders at BOOT, before
// the game and its canvas exist (main.ts awaits pickSlot before `new Game`).
// It is drawn through pixel-icon.ts's pixelIconComposite, which builds its own
// throwaway offscreen canvas, so nothing here needs the live scene.

import { drawSprite, withPalette, type PixelMap } from "./sprites";

export const BIRDHOUSE_W = 36;
export const BIRDHOUSE_H = 40;

export type BirdhouseState = "occupied" | "empty" | "clearing";

/** Local palette, in the same warm-wood family as the rest of the UI art. */
const PAL: Record<string, string> = {
  K: "#2a1e12", // outline / hole shadow
  T: "#6e4c30", // post + roof shade
  t: "#8a6440", // box face
  w: "#a37a4e", // box highlight
  B: "#4a76ab", // bluebird body
  b: "#345680", // bluebird shade
  W: "#fdf6e8", // bird cheek / highlight
  Y: "#e0a33c", // beak
  // Twigs sit inside the near-black entrance hole, so they have to be well
  // clear of it in value or the nest reads as an empty void.
  g: "#a8935a", // twig bundle
  G: "#d4bf85", // twig highlight
};

/** Sleeping bluebird — closed eye is a single dark dash, which at this scale
 * reads as "asleep" far better than any attempt at a lid. */
const BIRD_SLEEP: PixelMap = [
  ".BBBB..",
  "BBWBBB.",
  "BKBBBBY",
  "BBBBBB.",
  ".bbbb..",
];

/** Nesting twigs for an empty house — an invitation rather than a void. */
const TWIGS: PixelMap = [
  "..g.G..",
  ".gGggG.",
  "gGgggGg",
  ".ggggg.",
];

/** Perch below the entrance hole. */
const PERCH: PixelMap = ["KKK", ".K."];

export function drawBirdhouse(
  ctx: CanvasRenderingContext2D,
  state: BirdhouseState,
  opts: { active: boolean },
): void {
  withPalette(PAL, () => {
    // Mounting post — runs the FULL height at a fixed x so three stacked cards
    // visually form one continuous post without any CSS alignment trickery.
    ctx.fillStyle = PAL.T;
    ctx.fillRect(4, 0, 4, BIRDHOUSE_H);
    ctx.fillStyle = PAL.K;
    ctx.fillRect(4, 0, 1, BIRDHOUSE_H);

    const boxX = 9;
    const boxY = 8;
    const boxW = 24;
    const boxH = 24;

    // Roof: a stack of rects that WIDEN downward, so the pitch reads as an
    // apex over the box. (Narrowing downward instead draws an upside-down
    // funnel — the shape has to grow toward the eaves, not away from them.)
    const roofRows = 6;
    ctx.fillStyle = PAL.T;
    for (let i = 0; i < roofRows; i++) {
      const inset = roofRows - 1 - i;
      ctx.fillRect(boxX + inset, boxY - roofRows + i, boxW - inset * 2, 1);
    }
    ctx.fillStyle = PAL.K;
    ctx.fillRect(boxX - 1, boxY, boxW + 2, 1);

    // Box body + a highlight band so it doesn't read as a flat slab.
    ctx.fillStyle = PAL.t;
    ctx.fillRect(boxX, boxY + 1, boxW, boxH);
    ctx.fillStyle = PAL.w;
    ctx.fillRect(boxX + 1, boxY + 2, boxW - 2, 3);
    ctx.fillStyle = PAL.K;
    ctx.strokeStyle = PAL.K;
    ctx.fillRect(boxX, boxY + boxH, boxW, 1);
    ctx.fillRect(boxX, boxY + 1, 1, boxH);
    ctx.fillRect(boxX + boxW - 1, boxY + 1, 1, boxH);

    // Entrance. When armed for deletion the hatch swings open — a wider, paler
    // opening with the nest gone — so "about to be cleared" is legible at a
    // glance rather than only in the button text.
    const holeCx = boxX + boxW / 2;
    const holeCy = boxY + 13;
    const open = state === "clearing";
    const rx = open ? 9 : 6;
    const ry = open ? 8 : 6;
    ctx.fillStyle = PAL.K;
    ctx.beginPath();
    ctx.ellipse(holeCx, holeCy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    if (state === "occupied") {
      drawSprite(ctx, BIRD_SLEEP, Math.round(holeCx - 3.5), Math.round(holeCy - 2.5));
    } else if (state === "empty") {
      drawSprite(ctx, TWIGS, Math.round(holeCx - 3.5), Math.round(holeCy - 1));
    }

    drawSprite(ctx, PERCH, Math.round(holeCx - 1.5), boxY + 20);

    // Active slot gets a small gold ribbon on the post — the picker also says
    // "· current" in text, this just makes it findable without reading.
    if (opts.active) {
      ctx.fillStyle = "#e0a33c";
      ctx.fillRect(2, BIRDHOUSE_H - 12, 8, 3);
      ctx.fillRect(2, BIRDHOUSE_H - 8, 5, 2);
    }
  });
}
