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
  /** The river the bridge crosses, in logical px. */
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
    draw: () => drawRiver(ctx, rav.x0, rav.x1, rav.top, rav.bottom, v.animT),
  });

  drawables.push({
    y: v.railY + 0.15,
    draw: () => drawSpan(ctx, rav.x0, rav.x1, v.railY, built),
  });
}

/** The river the bridge crosses.
 *
 * This was a black chasm, and a black chasm is a VOID: there is nothing in
 * it to look at, nothing to explain why you cannot simply walk across, and
 * no reason for a bridge to be the answer. Water solves all three at once —
 * it reads instantly, it belongs in a forest, and the game already speaks
 * this visual language at the lake, so the two read as the same world.
 *
 * Deliberately shares the lake's palette and its shimmer trick (a moving
 * modulo stripe) rather than inventing a second water look. The difference
 * is direction: the lake shimmers in place, the river's highlights march
 * downstream, which is what makes it read as flowing rather than as a
 * long thin pond. */
function drawRiver(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  top: number,
  bottom: number,
  t: number,
): void {
  const flow = Math.floor(t * 6);
  for (let y = top; y < bottom; y++) {
    // Banks wander a little so the channel is not a rectangle.
    const wob = Math.round(Math.sin(y * 0.21) * 1.5 + Math.sin(y * 0.07) * 1.5);
    const lx = x0 + wob;
    const rx = x1 + Math.round(Math.sin(y * 0.17 + 2) * 1.5);

    // Wet sand at each edge, then the water.
    ctx.fillStyle = "#6e5a3e";
    ctx.fillRect(lx - 2, y, 2, 1);
    ctx.fillRect(rx, y, 2, 1);

    for (let x = lx; x < rx; x++) {
      const edge = x < lx + 2 || x >= rx - 2;
      // The stripe scrolls with `flow`, and the y term slants it, so the
      // highlights travel diagonally downstream.
      const shimmer = (x * 3 + y * 5 - flow * 4) % 13 === 0;
      ctx.fillStyle = edge ? "#2d6299" : shimmer ? "#5a9bd8" : "#3a7bbf";
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** The crossing: a timber bridge on posts standing in the water.
 *
 * `built` is 0 (needs repair) to 1 (whole). The broken state deliberately
 * keeps MOST of the bridge standing — both approaches, every post, both
 * railings up to the break — and takes out only a section of the middle.
 * The previous version removed nearly everything, which read as "there is
 * no bridge here" rather than "this bridge needs repair", and a repair job
 * you cannot recognise as a repair job is not an invitation to pay for one. */
function drawSpan(
  ctx: CanvasRenderingContext2D,
  x0: number,
  x1: number,
  y: number,
  built: number,
): void {
  const w = x1 - x0;
  const deckTop = y - 3;
  // Overhang the banks so the deck visibly LANDS on solid ground at both
  // ends instead of stopping at the waterline.
  const bx0 = x0 - 5;
  const bx1 = x1 + 5;

  // Support posts, standing in the water with a reflection-ish shadow.
  for (const f of [0.3, 0.7]) {
    const px = Math.round(x0 + w * f);
    ctx.fillStyle = "#2b2118";
    ctx.fillRect(px - 1, y, 3, 14);
    ctx.fillStyle = "#4a3520";
    ctx.fillRect(px - 1, y, 2, 14);
    // Cross-brace under the deck.
    ctx.fillStyle = "#5e452a";
    ctx.fillRect(px - 4, y + 3, 9, 1);
  }

  // The damaged section: a hole in the MIDDLE, closing up as it's rebuilt.
  const gapHalf = Math.round((1 - built) * w * 0.18);
  const mid = Math.round((bx0 + bx1) / 2);
  const gap0 = mid - gapHalf;
  const gap1 = mid + gapHalf;
  const inGap = (x: number): boolean => gapHalf > 0 && x >= gap0 && x < gap1;

  // Deck planks.
  for (let x = bx0; x < bx1; x++) {
    if (inGap(x)) continue;
    ctx.fillStyle = (x - bx0) % 4 === 0 ? "#6e4c30" : "#8a6440";
    ctx.fillRect(x, deckTop, 1, 3);
    ctx.fillStyle = "#a07a4e";
    ctx.fillRect(x, deckTop, 1, 1);
  }

  // Railings: posts and a top rail, skipping the damaged run.
  ctx.fillStyle = "#5e452a";
  for (let x = bx0; x < bx1; x += 5) {
    if (inGap(x)) continue;
    ctx.fillRect(x, deckTop - 5, 1, 5);
  }
  for (let x = bx0; x < bx1; x++) {
    if (inGap(x)) continue;
    ctx.fillStyle = "#7a5f3e";
    ctx.fillRect(x, deckTop - 5, 1, 1);
    ctx.fillStyle = "#5e452a";
    ctx.fillRect(x, deckTop - 3, 1, 1);
  }

  // Damage detail at the break: splintered plank ends and one board hanging
  // into the water. Only while there is still a gap to repair.
  if (gapHalf > 0) {
    ctx.fillStyle = "#5c4026";
    ctx.fillRect(gap0 - 1, deckTop + 1, 1, 2);
    ctx.fillRect(gap1, deckTop + 1, 1, 2);
    // A snapped railing post leaning over the gap.
    ctx.fillStyle = "#5e452a";
    ctx.fillRect(gap0 - 2, deckTop - 4, 1, 2);
    ctx.fillRect(gap1 + 1, deckTop - 3, 1, 2);
    // Dangling board.
    ctx.fillStyle = "#6e4c30";
    ctx.fillRect(gap0 - 1, deckTop + 3, 1, 5);
    ctx.fillRect(gap0 - 1, deckTop + 8, 2, 1);
  }
}
