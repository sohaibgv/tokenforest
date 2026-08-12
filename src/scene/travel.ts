// Rendering for the Timber Line — the narrow-gauge railway that carries you
// between worlds. Lifted out of scene/game.ts, which had passed 6,700 lines.
//
// Takes an explicit TimberLineView rather than the Game instance. That costs
// one small interface and buys the thing that matters: this file cannot
// reach into Game's internals, so the coupling is visible in the signature
// instead of hidden in a dozen `this.` calls. It also makes the renderer
// drivable from a test with a hand-built view and no canvas, no save and no
// backend.

import {
  DEPARTURE_BOARD,
  drawSprite,
  HANDCAR_DOWN,
  HANDCAR_UP,
  PLATFORM,
  RAIL_TILE,
  spriteSize,
} from "./sprites";

export interface TimberLineView {
  /** Canvas width in logical px. */
  w: number;
  /** Renderer clock, for the handcar pump and the rebuild beat. */
  animT: number;
  /** Footing y of the track's row. */
  railY: number;
  halt: { x: number; y: number };
  handcar: { x: number; y: number };
  trestle: { x: number; y: number };
  /** The chasm the bridge crosses, in logical px. */
  ravine: { x0: number; x1: number; top: number; bottom: number };
  /** Is there an onward world at all? No trestle on the last one. */
  hasTrestle: boolean;
  /** Is there anywhere to go back to? No halt on the first world. */
  hasWayBack: boolean;
  bridgeRepaired: boolean;
  /** Counts down while the foreman rebuilds; 0 when idle. */
  trestleBuildT: number;
  trestleBuildSecs: number;
  /** Counts down while the handcar pulls out; 0 when parked. */
  handcarDepartT: number;
  handcarDepartSecs: number;
}

/** Queues the Timber Line into the caller's depth-sorted pass: track across
 * the back of the plot, the halt and its handcar at the left end, the trestle
 * at the right.
 *
 * The track is one unbroken run edge to edge on purpose. The single biggest
 * reason the old road-stub and plank-bridge didn't read as travel was that
 * they were two disconnected objects with nothing between them; a continuous
 * line is what makes "these are the two ends of one route" self-evident
 * without a word of text.
 *
 * The foreman is NOT drawn here — he is one of the cast (see src/npc/) and
 * goes through the NPC pass with everyone else. */
export function pushTimberLineDrawables(
  ctx: CanvasRenderingContext2D,
  drawables: { y: number; draw: () => void }[],
  v: TimberLineView,
): void {
  const railY = v.railY;
  const trestle = v.trestle;
  const hasTrestle = v.hasTrestle;
  // Where the buildable span begins. With no onward world at all the track
  // simply runs to the edge rather than ending in a ruin that can never be
  // repaired.
  const spanX = hasTrestle ? trestle.x - 4 : v.w + 8;

  drawables.push({
    y: railY,
    draw: () => {
      const tile = spriteSize(RAIL_TILE);
      for (let x = -tile.w; x < spanX; x += tile.w) {
        drawSprite(ctx, RAIL_TILE, x, railY - tile.h);
      }
    },
  });

  // Halt: platform + departures board, only where there IS somewhere back.
  if (v.hasWayBack) {
    const halt = v.halt;
    drawables.push({
      y: halt.y + 0.1,
      draw: () => {
        const plat = spriteSize(PLATFORM);
        drawSprite(ctx, PLATFORM, halt.x - 6, halt.y - plat.h + 3);
        const board = spriteSize(DEPARTURE_BOARD);
        drawSprite(
          ctx,
          DEPARTURE_BOARD,
          halt.x - 4,
          halt.y - board.h - plat.h + 5,
        );
      },
    });

    const car = v.handcar;
    drawables.push({
      y: car.y + 0.2,
      draw: () => {
        // Pumping animation: idle rocks slowly so the car advertises itself
        // as a vehicle rather than scenery; departing rocks fast and slides
        // off the left edge.
        const departing = v.handcarDepartT > 0;
        const rate = departing ? 18 : 2.2;
        const frame =
          Math.sin(v.animT * rate) > 0 ? HANDCAR_UP : HANDCAR_DOWN;
        const slid = departing
          ? Math.round(
              (1 - v.handcarDepartT / v.handcarDepartSecs) * -40,
            )
          : 0;
        const size = spriteSize(frame);
        drawSprite(
          ctx,
          frame,
          car.x - Math.floor(size.w / 2) + slid,
          car.y - size.h,
        );
      },
    });
  }

  if (!hasTrestle) return;

  // The crossing. Drawn as ONE composition rather than tiled sprites,
  // because the old version was tiled sprites and that is exactly why it
  // failed to read: a row of X-braced bents marching off the right edge with
  // no deck on them is a fence, not a bridge. Three things had to be true
  // before it looked like a crossing at all — there has to be a visible GAP
  // being spanned, the deck needs RAILINGS (the single strongest "bridge"
  // signal at any resolution), and both banks have to be on screen so the
  // eye can see the span start and finish.
  const rav = v.ravine;
  const built = v.bridgeRepaired
    ? v.trestleBuildT > 0
      ? 1 - v.trestleBuildT / v.trestleBuildSecs
      : 1
    : 0;

  // The chasm itself, behind everything, at the very back of the depth sort.
  drawables.push({
    y: -1,
    draw: () => drawRavine(ctx, rav.x0, rav.x1, rav.top, rav.bottom),
  });

  drawables.push({
    y: v.railY + 0.15,
    draw: () => drawSpan(ctx, rav.x0, rav.x1, v.railY, built),
  });
}

/** A chasm cutting the plot's right edge, with a lit rocky lip on each side
 * so the ground reads as breaking off rather than as a painted dark stripe. */
function drawRavine(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number, bottom: number): void {
  const g = ctx.createLinearGradient(0, top, 0, bottom);
  g.addColorStop(0, "#0d0b12");
  g.addColorStop(0.45, "#171320");
  g.addColorStop(1, "#080610");
  ctx.fillStyle = g;
  ctx.fillRect(x0, top, x1 - x0, bottom - top);

  // Crumbling edges: a bright lip pixel then a dark inner face, jittered per
  // row so the break looks torn rather than cut.
  for (let y = top; y < bottom; y++) {
    const j = Math.abs(Math.sin(y * 12.9898) * 43758.5453) % 1;
    const l = Math.round(j * 2);
    const r = Math.round((1 - j) * 2);
    ctx.fillStyle = "#6b6257";
    ctx.fillRect(x0 - l, y, 1, 1);
    ctx.fillRect(x1 + r - 1, y, 1, 1);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(x0 - l + 1, y, 2, 1);
    ctx.fillRect(x1 + r - 3, y, 2, 1);
  }
}

/** The span: piers into the chasm, a plank deck, and railings.
 * `built` is 0 (collapsed) to 1 (whole); intermediate values fill the deck
 * left-to-right so the wood you just paid visibly becomes the bridge. */
function drawSpan(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number, built: number): void {
  const w = x1 - x0;
  const deckTop = y - 3;

  // Piers, always present — they are what survived the collapse, and they
  // give the eye something to read the gap's depth against.
  for (const t of [0.28, 0.72]) {
    const px = Math.round(x0 + w * t);
    ctx.fillStyle = "#4a3520";
    ctx.fillRect(px - 1, y, 3, 16);
    ctx.fillStyle = "#2b2118";
    ctx.fillRect(px + 1, y, 1, 16);
    // Cross-brace between the pier and the deck.
    ctx.fillStyle = "#5e452a";
    ctx.fillRect(px - 4, y + 4, 9, 1);
  }

  const laid = Math.round(w * built);

  // Deck planks.
  for (let x = 0; x < laid; x++) {
    const gx = x0 + x;
    ctx.fillStyle = x % 4 === 0 ? "#6e4c30" : "#8a6440";
    ctx.fillRect(gx, deckTop, 1, 3);
  }
  ctx.fillStyle = "#a07a4e";
  ctx.fillRect(x0, deckTop, laid, 1);

  // RAILINGS — posts and a top rail, on the built section only. This is the
  // detail that makes it a bridge instead of a plank.
  ctx.fillStyle = "#5e452a";
  for (let x = 0; x < laid; x += 5) {
    ctx.fillRect(x0 + x, deckTop - 5, 1, 5);
  }
  if (laid > 0) {
    ctx.fillStyle = "#7a5f3e";
    ctx.fillRect(x0, deckTop - 5, laid, 1);
    ctx.fillStyle = "#5e452a";
    ctx.fillRect(x0, deckTop - 3, laid, 1);
  }

  // The broken end: a ragged stub and one plank hanging off it.
  if (built < 1) {
    const bx = x0 + laid;
    ctx.fillStyle = "#6e4c30";
    ctx.fillRect(bx, deckTop, 2, 2);
    ctx.fillRect(bx + 2, deckTop + 1, 1, 1);
    ctx.fillStyle = "#5e452a";
    ctx.fillRect(bx + 1, deckTop + 3, 1, 4); // dangling plank
    ctx.fillRect(bx + 1, deckTop + 7, 2, 1);
    // Far side stub, so the gap reads as a break in a whole rather than as
    // an unfinished build running off the edge.
    ctx.fillStyle = "#6e4c30";
    ctx.fillRect(x1 - 3, deckTop, 3, 3);
    ctx.fillStyle = "#5e452a";
    ctx.fillRect(x1 - 1, deckTop - 5, 1, 5);
  }
}
