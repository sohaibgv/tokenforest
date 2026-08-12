// Procedural dungeon chamber for the Adventure battle arena.
//
// The arena used to be a single fillRect of the world's `ground` colour with
// a vignette over it — a flat green void with two sprites standing in it.
// Nothing said "you have gone somewhere"; the fight read as happening on the
// same lawn as the homestead, only emptier.
//
// The fix is not decoration, it is PERSPECTIVE. This draws a real one-point
// room: a back wall inset from the frame, side walls and a vaulted ceiling
// converging toward it, and a flagstone floor spreading toward the viewer.
// Every edge of the frame is a surface receding into the room, so the wide
// flanks that used to be dead space are now what gives the chamber its
// depth. Props (barrels, crates, rubble, bones) sit along the walls at
// depth-scaled sizes, which reinforces the recession rather than merely
// filling pixels.
//
// It is all procedural — no new sprite arrays, consistent with the project's
// no-binary-assets rule — and every bit of variation is hashed from the
// surface's own coordinates rather than Math.random(), so the stonework does
// not crawl and shimmer from frame to frame. Only the torch flames use the
// clock.
//
// Each world tints its own dungeon: the stone is the world's ground colour
// mixed most of the way to slate, so Greenwood's chamber is faintly mossy
// and Ashfall's faintly rust, while both still read unmistakably as stone.

import { mixHex } from "../economy";

/** Deterministic 0..1 noise from a pair of integer surface coordinates. The
 * whole point is that it is NOT random: the same brick must get the same
 * shade on every frame or the wall boils. Same trick as grid.ts's
 * jitteredFooting, kept local so the two can be tuned independently. */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** The room's one-point cage. `b*` is the back wall's rectangle on screen;
 * the frame of the canvas is the near opening. Every other surface is the
 * quad joining one edge of the frame to the matching edge of the back wall,
 * which is what makes the whole thing consistent instead of four unrelated
 * decorations. */
interface Room {
  bx0: number;
  bx1: number;
  by0: number;
  by1: number;
  w: number;
  h: number;
}

/** Back wall base. The fighters occupy 0.44h-0.55h (dyFrac in game.ts's
 * formations), so the wall sits at 0.36 to leave them clearly standing ON
 * the flagstones in front of it rather than pasted against it — while the
 * near floor below them falls away into FOREGROUND_FADE. Those two numbers
 * are a pair: together they frame a lit band that the fight happens inside.
 * At 0.42 with no fade, the bottom half of the screen was a big empty slab
 * of lit flagstone with nothing on it. */
const FLOOR_LINE = 0.36;
/** Where the near floor starts falling into darkness. Torchlight falling off
 * toward the viewer is both physically right for a dungeon and the thing
 * that stops unused floor reading as unfinished space. */
const FOREGROUND_FADE = 0.6;
/** How far the back wall is inset from the frame. Wider inset = shallower,
 * more theatrical room; narrower = a long tunnel. This much reads as a
 * chamber while still leaving the enemy slot (0.74w) inside the back wall's
 * span, so an enemy never straddles the wall/side-wall seam. */
const WALL_INSET = 0.17;
const CEILING_LINE = 0.1;

export interface DungeonPalette {
  /** Mid stone — the average brick on the back wall. */
  stone: string;
  /** Mortar and shadowed edges. */
  mortar: string;
  /** Floor flagstone base. */
  floor: string;
  /** Torch/arch light. */
  glow: string;
}

/** Derive a chamber palette from a world's ground colour. Mixing rather than
 * hardcoding is what keeps ten worlds from sharing one grey room, while the
 * heavy bias toward slate keeps every one of them reading as stone first and
 * world-flavoured second. */
export function dungeonPalette(groundHex: string): DungeonPalette {
  return {
    stone: mixHex(groundHex, "#3a3a44", 0.78),
    mortar: mixHex(groundHex, "#16161c", 0.88),
    floor: mixHex(groundHex, "#2e2e36", 0.8),
    glow: "#ffb45a",
  };
}

function quad(
  ctx: CanvasRenderingContext2D,
  p: [number, number][],
  fill: string,
): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(p[0][0], p[0][1]);
  for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
  ctx.closePath();
  ctx.fill();
}

const BRICK_H = 5;
const BRICK_W = 14;

/** Coursed masonry on the flat back wall: staggered rows, mortar gaps,
 * per-brick shade jitter, and an overall darkening toward the ceiling so the
 * chamber feels enclosed rather than lit from nowhere. */
function drawBackWall(ctx: CanvasRenderingContext2D, room: Room, pal: DungeonPalette): void {
  const { bx0, bx1, by0, by1 } = room;
  ctx.save();
  ctx.beginPath();
  ctx.rect(bx0, by0, bx1 - bx0, by1 - by0);
  ctx.clip();
  ctx.fillStyle = pal.mortar;
  ctx.fillRect(bx0, by0, bx1 - bx0, by1 - by0);

  for (let row = 0, y = by0; y < by1; row++, y += BRICK_H) {
    // Alternate rows shift half a brick — the stagger is most of what makes
    // this read as masonry rather than as a grid.
    const offset = row % 2 === 0 ? 0 : -BRICK_W / 2;
    for (let col = -1, x = bx0 + offset; x < bx1; col++, x += BRICK_W) {
      const n = hash2(col, row);
      const depth = Math.max(0, 1 - (y - by0) / Math.max(1, by1 - by0));
      const shade = mixHex(pal.stone, "#101016", depth * 0.4 + n * 0.22);
      ctx.fillStyle = shade;
      ctx.fillRect(Math.round(x), Math.round(y), BRICK_W - 1, BRICK_H - 1);
      // A single lit pixel-row on the top of roughly a third of the bricks:
      // just enough chisel highlight to catch the eye without turning the
      // wall into noise that competes with the fighters.
      if (n > 0.66) {
        ctx.fillStyle = mixHex(shade, "#8a8a96", 0.3);
        ctx.fillRect(Math.round(x), Math.round(y), BRICK_W - 1, 1);
      }
    }
  }
  ctx.restore();
}

/** One side wall, drawn as real perspective masonry.
 *
 * Depth `d` runs 0 (the near frame edge) to 1 (the back wall). The wall's
 * top and bottom edges both converge on the back wall's corners, so filling
 * the quads between successive courses and successive depth stations gives
 * bricks that genuinely foreshorten. This is the part that turns two dead
 * flanks into the thing carrying the room's volume.
 *
 * `side` is -1 for the left wall, +1 for the right. */
function drawSideWall(ctx: CanvasRenderingContext2D, room: Room, pal: DungeonPalette, side: -1 | 1): void {
  const { w, h, bx0, bx1, by0, by1 } = room;
  const nearX = side < 0 ? 0 : w;
  const farX = side < 0 ? bx0 : bx1;

  const xAt = (d: number): number => lerp(nearX, farX, d);
  const topAt = (d: number): number => lerp(0, by0, d);
  const botAt = (d: number): number => lerp(h, by1, d);

  const STATIONS = 9;
  const COURSES = 11;
  for (let s = 0; s < STATIONS; s++) {
    // Stations bunch toward the back, matching how real recession
    // compresses — evenly spaced ones make the wall look like a folded fan.
    const d0 = Math.pow(s / STATIONS, 0.72);
    const d1 = Math.pow((s + 1) / STATIONS, 0.72);
    const x0 = xAt(d0);
    const x1 = xAt(d1);
    for (let c = 0; c < COURSES; c++) {
      const f0 = c / COURSES;
      const f1 = (c + 1) / COURSES;
      const n = hash2(s * 17 + c * 5 + (side < 0 ? 0 : 91), c * 3 + 2);
      // Darker with depth (light lives near the viewer) and darker toward
      // the ceiling, same logic as the back wall. The per-brick term is
      // deliberately large: with the torch pools washing over these walls, a
      // subtle jitter got completely flattened out and the masonry read as a
      // plain gradient rather than as stone.
      const shade = mixHex(pal.stone, "#0d0d12", 0.14 + d0 * 0.34 + (1 - f0) * 0.16 + n * 0.3);
      quad(
        ctx,
        [
          [x0, lerp(topAt(d0), botAt(d0), f0)],
          [x1, lerp(topAt(d1), botAt(d1), f0)],
          [x1, lerp(topAt(d1), botAt(d1), f1)],
          [x0, lerp(topAt(d0), botAt(d0), f1)],
        ],
        shade,
      );
    }
  }

  // Mortar seams over the top, drawn as strokes so they stay 1px at every
  // depth instead of vanishing where the quads get thin.
  ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < COURSES; c++) {
    const f = c / COURSES;
    ctx.moveTo(nearX, lerp(0, h, f));
    ctx.lineTo(farX, lerp(by0, by1, f));
  }
  for (let s = 1; s < STATIONS; s++) {
    const d = Math.pow(s / STATIONS, 0.72);
    ctx.moveTo(xAt(d), topAt(d));
    ctx.lineTo(xAt(d), botAt(d));
  }
  ctx.stroke();
}

/** Vaulted ceiling: near-black with rib arches picked out along the depth
 * stations. Kept very dark on purpose — it should register as "there is a
 * ceiling and it is far above me" in peripheral vision and never compete
 * with the fight. */
function drawCeiling(ctx: CanvasRenderingContext2D, room: Room, pal: DungeonPalette): void {
  const { w, bx0, bx1, by0 } = room;
  quad(
    ctx,
    [
      [0, 0],
      [w, 0],
      [bx1, by0],
      [bx0, by0],
    ],
    mixHex(pal.stone, "#050508", 0.78),
  );

  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let s = 1; s < 6; s++) {
    const d = Math.pow(s / 6, 0.72);
    ctx.moveTo(lerp(0, bx0, d), lerp(0, by0, d));
    ctx.lineTo(lerp(w, bx1, d), lerp(0, by0, d));
  }
  ctx.stroke();
  ctx.lineWidth = 1;
}

/** A lit archway on the back wall. Reads as the room having a
 * somewhere-else, which is most of what stops a backdrop feeling like a wall
 * you were placed against. Offset toward the enemy side so it sits behind
 * what you're fighting — the way you came in is the way they came from. */
function drawArch(ctx: CanvasRenderingContext2D, room: Room, pal: DungeonPalette): void {
  const { by0, by1 } = room;
  const cx = Math.round(room.w * 0.74);
  const halfW = Math.max(9, Math.round(room.w * 0.045));
  const top = Math.round(lerp(by0, by1, 0.28));

  const grad = ctx.createLinearGradient(0, top, 0, by1);
  grad.addColorStop(0, "#08080c");
  grad.addColorStop(0.72, "#131018");
  grad.addColorStop(1, mixHex("#131018", pal.glow, 0.32));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx - halfW, by1);
  ctx.lineTo(cx - halfW, top + halfW);
  ctx.arc(cx, top + halfW, halfW, Math.PI, 0);
  ctx.lineTo(cx + halfW, by1);
  ctx.closePath();
  ctx.fill();

  // Voussoir ring — the wedge stones around the arch.
  ctx.strokeStyle = mixHex(pal.stone, "#9a9aa6", 0.35);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - halfW, by1);
  ctx.lineTo(cx - halfW, top + halfW);
  ctx.arc(cx, top + halfW, halfW, Math.PI, 0);
  ctx.lineTo(cx + halfW, by1);
  ctx.stroke();
  ctx.lineWidth = 1;
}

/** Flagstones in forced perspective.
 *
 * Two things make this read as a floor rather than as a second wall, and the
 * first attempt at it had neither:
 *
 * 1. VALUE SEPARATION. Tiles in roughly the same shade as the masonry fused
 *    with it — the lower half of the arena came out as one continuous slab
 *    of brick and the chamber had no ground at all. The floor is decidedly
 *    darker and warmer than the walls, with its own front-to-back falloff.
 * 2. CONVERGENCE. Rectangles in rows can only read as a checkerboard stood
 *    on end. The seams running away from the viewer converge toward the back
 *    wall, which is what actually says "this plane is lying down". */
function drawFloor(ctx: CanvasRenderingContext2D, room: Room, pal: DungeonPalette): void {
  const { w, h, bx0, bx1, by1 } = room;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(-4, h + 4);
  ctx.lineTo(bx0, by1);
  ctx.lineTo(bx1, by1);
  ctx.lineTo(w + 4, h + 4);
  ctx.closePath();
  ctx.clip();

  const depth = h - by1;
  const base = ctx.createLinearGradient(0, by1, 0, h);
  base.addColorStop(0, mixHex(pal.floor, "#08070a", 0.52));
  base.addColorStop(0.34, mixHex(pal.floor, "#2a2018", 0.25));
  base.addColorStop(1, mixHex(pal.floor, "#08070a", 0.44));
  ctx.fillStyle = base;
  ctx.fillRect(-4, by1, w + 8, depth + 8);

  const ROWS = 12;
  const rowY = (r: number): number => by1 + depth * Math.pow(r / ROWS, 1.55);

  // Alternating course value + a little per-course grit, so the flagstones
  // don't look machine-cut.
  for (let r = 0; r < ROWS; r++) {
    const y0 = Math.round(rowY(r));
    const y1 = Math.round(rowY(r + 1));
    if (y1 <= y0) continue;
    const n = hash2(r * 13 + 3, 7);
    ctx.fillStyle = `rgba(255, 246, 232, ${0.015 + (r % 2) * 0.022 + n * 0.016})`;
    ctx.fillRect(-4, y0, w + 8, y1 - y0);
  }

  ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let r = 1; r <= ROWS; r++) {
    const y = Math.round(rowY(r)) + 0.5;
    ctx.moveTo(-4, y);
    ctx.lineTo(w + 4, y);
  }
  // Seams running away from the viewer, converging on the back wall's span
  // rather than on a single mathematical point — a true one-point starburst
  // is technically correct but reads as a sunburst decal on a room this
  // wide.
  const COLS = 13;
  for (let c = 0; c <= COLS; c++) {
    const t = c / COLS;
    ctx.moveTo(lerp(bx0, bx1, t), by1);
    ctx.lineTo(lerp(-w * 0.9, w * 1.9, t), h + 4);
  }
  ctx.stroke();
  ctx.restore();
}

/** Wall torch: bracket, and a flame whose height and horizontal lean are
 * driven by two out-of-phase sines so it flickers irregularly instead of
 * pulsing on an obvious loop. `scale` shrinks the whole fixture with depth,
 * which is what makes a row of them read as receding. */
function drawTorch(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, phase: number, scale: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);

  ctx.fillStyle = "#2a2118";
  ctx.fillRect(-1, 0, 3, 7);
  ctx.fillStyle = "#4a3520";
  ctx.fillRect(-2, 6, 5, 2);

  const flick = Math.sin(t * 7.3 + phase) * 0.5 + Math.sin(t * 11.7 + phase * 2.1) * 0.5;
  const fh = 6 + flick * 2;
  const lean = Math.sin(t * 5.1 + phase) * 1.2;

  ctx.fillStyle = "#ff9327";
  ctx.beginPath();
  ctx.moveTo(-2, 0);
  ctx.lineTo(lean, -fh);
  ctx.lineTo(3, 0);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffe07a";
  ctx.beginPath();
  ctx.moveTo(-1, 0);
  ctx.lineTo(lean * 0.6, -fh * 0.6);
  ctx.lineTo(2, 0);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Warm radial pool of torchlight. Drawn with `lighter` so overlapping pools
 * brighten rather than muddy each other, which is what plain alpha
 * compositing does to two warm circles. */
function drawLightPool(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, strength: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
  g.addColorStop(0, `rgba(255, 176, 90, ${strength})`);
  g.addColorStop(0.5, `rgba(255, 150, 70, ${strength * 0.35})`);
  g.addColorStop(1, "rgba(255, 140, 60, 0)");
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  ctx.restore();
}

/** Junk against the walls — barrels, crates, rubble, a stray bone pile.
 * These exist to be read at a glance as "a room somebody uses", and just as
 * importantly to be SIZED by depth: a small crate far back next to a large
 * one up front is a depth cue no amount of wall texture can give. `s` scales
 * the whole prop. */
function drawProp(ctx: CanvasRenderingContext2D, kind: number, x: number, y: number, s: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  if (kind === 0) {
    // Barrel: staves with two iron hoops.
    ctx.fillStyle = "#4a3520";
    ctx.fillRect(-5, -13, 10, 13);
    ctx.fillStyle = "#5e452a";
    ctx.fillRect(-4, -13, 3, 13);
    ctx.fillRect(1, -13, 2, 13);
    ctx.fillStyle = "#2b2118";
    ctx.fillRect(-5, -11, 10, 1);
    ctx.fillRect(-5, -4, 10, 1);
  } else if (kind === 1) {
    // Crate: planks with a diagonal brace.
    ctx.fillStyle = "#4e3a22";
    ctx.fillRect(-6, -11, 12, 11);
    ctx.fillStyle = "#63492b";
    ctx.fillRect(-6, -11, 12, 2);
    ctx.fillRect(-6, -6, 12, 2);
    ctx.fillStyle = "#2e2216";
    ctx.fillRect(-6, -11, 1, 11);
    ctx.fillRect(5, -11, 1, 11);
  } else if (kind === 2) {
    // Rubble: a few fallen stones.
    ctx.fillStyle = "#4a4a54";
    ctx.fillRect(-7, -4, 6, 4);
    ctx.fillRect(0, -6, 5, 6);
    ctx.fillStyle = "#5c5c68";
    ctx.fillRect(-7, -4, 6, 1);
    ctx.fillRect(0, -6, 5, 1);
    ctx.fillStyle = "#3a3a44";
    ctx.fillRect(4, -3, 4, 3);
  } else {
    // Bones — a skull and a ribcage. Every dungeon needs the previous guy.
    //
    // The first version read as a KEY, and deserved to: a small blob of a
    // head attached to one long horizontal bar with notches in it is a key,
    // whatever you meant it to be. Two changes fix the silhouette — the
    // skull gets a proper domed cranium with paired sockets and a toothed
    // jaw below it (so the head is legible as a face, not as a bow), and
    // the ribs become several SHORT parallel strokes off a vertical spine
    // instead of one long shaft (so there is no key-shaft shape left to
    // misread).
    ctx.fillStyle = "#d8d0bd";
    ctx.fillRect(-5, -8, 9, 5);
    ctx.fillRect(-4, -3, 7, 2);
    ctx.fillStyle = "#26221c";
    ctx.fillRect(-4, -7, 3, 3);
    ctx.fillRect(1, -7, 3, 3);
    ctx.fillRect(-1, -3, 1, 1);
    ctx.fillRect(-3, -2, 1, 1);
    ctx.fillRect(-1, -2, 1, 1);
    ctx.fillRect(1, -2, 1, 1);

    ctx.fillStyle = "#c4bca9";
    ctx.fillRect(7, -8, 1, 7);
    ctx.fillRect(8, -8, 3, 1);
    ctx.fillRect(8, -6, 4, 1);
    ctx.fillRect(8, -4, 4, 1);
    ctx.fillRect(8, -2, 3, 1);
  }
  ctx.restore();
}

/** Soft contact shadow under a fighter. Without one the sprites hover a few
 * pixels off a floor that now has real depth cues, which reads worse than it
 * did over the old flat fill — the better the ground, the more obvious an
 * unanchored character becomes. Call at the unit's foot position, before
 * drawing the unit. */
export function drawFloorShadow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number): void {
  ctx.save();
  ctx.translate(x, y);
  // Squashed to an ellipse: a circle reads as a hole in the floor. The
  // gradient is built at the ORIGIN, after the translate — building it at
  // (x, y) and then translating there too puts its centre at double the
  // intended position.
  ctx.scale(1, 0.34);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
  g.addColorStop(0, "rgba(0, 0, 0, 0.5)");
  g.addColorStop(0.6, "rgba(0, 0, 0, 0.22)");
  g.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Full arena backdrop. Call once at the top of renderBattle, before any unit
 * is drawn — everything here is background and must not paint over the
 * fighters. `t` is the renderer's animation clock (Game.animT); it drives
 * only the torch flicker, so a frozen clock yields a perfectly still but
 * still correct chamber. */
export function drawDungeonArena(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  groundHex: string,
  t: number,
): void {
  const pal = dungeonPalette(groundHex);
  const room: Room = {
    w,
    h,
    bx0: Math.round(w * WALL_INSET),
    bx1: Math.round(w * (1 - WALL_INSET)),
    by0: Math.round(h * CEILING_LINE),
    by1: Math.round(h * FLOOR_LINE),
  };

  ctx.fillStyle = "#07070b";
  ctx.fillRect(-4, -4, w + 8, h + 8);

  drawBackWall(ctx, room, pal);
  drawArch(ctx, room, pal);
  drawCeiling(ctx, room, pal);
  drawSideWall(ctx, room, pal, -1);
  drawSideWall(ctx, room, pal, 1);
  drawFloor(ctx, room, pal);

  // Props tucked into the wall/floor join on both sides, sized and placed by
  // depth so they read as receding into the room. Deterministic kinds/jitter
  // from hash2 — a barrel must not turn into a skull between frames.
  for (const side of [-1, 1] as const) {
    for (let i = 0; i < 6; i++) {
      const d = 0.1 + i * 0.15;
      const nearX = side < 0 ? 0 : w;
      const farX = side < 0 ? room.bx0 : room.bx1;
      const n = hash2(i * 31 + (side < 0 ? 0 : 77), 13);
      const wallX = lerp(nearX, farX, d);
      // Nudge off the wall face and into the room a little, more so up front
      // where there is more floor to stand on.
      const x = wallX + side * -1 * lerp(18, 4, d) * (0.6 + n * 0.8);
      const y = lerp(h, room.by1, d);
      // Never furnish the ground a fighter is standing on. The party and
      // enemy slots are fixed fractions of the canvas (see game.ts's
      // formations), so a prop that drifts into one clips through the
      // character's feet — which looks like a z-order bug, not scenery.
      const clashes = [0.24, 0.74].some(
        (fx) => Math.abs(x - w * fx) < w * 0.09 && Math.abs(y - h * 0.5) < h * 0.14,
      );
      if (clashes) continue;
      const scale = lerp(1.5, 0.5, d);
      drawFloorShadow(ctx, x, y, 9 * scale);
      // Kind comes from its OWN hash, not from `n`. Reusing the position
      // jitter's hash correlated the two: props that happened to sit at a
      // given offset all picked the same kind, and the chamber came out
      // furnished almost entirely with skeletons.
      const kind = Math.floor(hash2(i * 7 + 3, side < 0 ? 41 : 58) * 4) % 4;
      drawProp(ctx, kind, x, y, scale);
    }
  }

  // Torches down BOTH side walls at matching depths plus the back corners.
  // A receding row of lights is the single strongest depth cue available
  // here, and it lights the flanks that used to be dead space.
  const torchDepths = [0.24, 0.56, 0.86];
  for (const side of [-1, 1] as const) {
    const nearX = side < 0 ? 0 : w;
    const farX = side < 0 ? room.bx0 : room.bx1;
    torchDepths.forEach((d, i) => {
      const x = lerp(nearX, farX, d) + side * -1 * lerp(10, 3, d);
      const y = lerp(lerp(0, room.by0, d), lerp(h, room.by1, d), 0.42);
      const scale = lerp(1.6, 0.7, d);
      drawLightPool(ctx, x, y + 4, Math.max(34, w * 0.13) * scale, 0.26);
      drawTorch(ctx, x, y, t, i * 1.7 + (side < 0 ? 0 : 0.9), scale);
    });
  }

  // Pools on the floor where the fighters stand, so the party and enemy
  // slots sit in light rather than in the general gloom.
  drawLightPool(ctx, Math.round(w * 0.24), Math.round(h * 0.56), Math.max(50, w * 0.2), 0.14);
  drawLightPool(ctx, Math.round(w * 0.74), Math.round(h * 0.52), Math.max(50, w * 0.2), 0.14);

  // Shadowed skirting where the back wall meets the floor — without it the
  // two planes butt together and the floor reads as a second wall.
  ctx.fillStyle = "rgba(6, 6, 10, 0.55)";
  ctx.fillRect(room.bx0, room.by1, room.bx1 - room.bx0, 3);

  // Foreground falloff. The torches are back with the fighters, so the floor
  // between them and the viewer is simply out of the light. This is the
  // difference between "the bottom of the screen is unused" and "the bottom
  // of the screen is dark", and it costs one gradient. Drawn LAST so it
  // dims props, seams and light pools alike — anything it fails to cover
  // pops out of the dark and looks like a mistake.
  const fade = ctx.createLinearGradient(0, h * FOREGROUND_FADE, 0, h);
  fade.addColorStop(0, "rgba(4, 4, 7, 0)");
  fade.addColorStop(0.55, "rgba(4, 4, 7, 0.5)");
  fade.addColorStop(1, "rgba(4, 4, 7, 0.94)");
  ctx.fillStyle = fade;
  ctx.fillRect(-4, h * FOREGROUND_FADE, w + 8, h * (1 - FOREGROUND_FADE) + 8);
}
