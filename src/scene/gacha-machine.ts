// Gacha machine illustration (Part E): a squat, wide "counter machine"
// cabinet, hand-authored as a layered composite drawn with a handful of
// ctx.fillRect calls (flat wood/brass panels — the pragmatic choice for
// large rectangular regions, since hand-authoring a 104x92 PixelMap
// character-by-character would be ~9500 characters of ASCII art for no
// visual benefit over a filled rect) plus several small PixelMap detail
// layers (rivets, header icon, glass shine) composited via drawSprite —
// the exact "small map + own palette, stacked over a base layer" technique
// sprites.ts's GLOW_SM/SIGN_NO_AI/DATA_BEAM and weapons.ts's
// drawHeldWeapon already use elsewhere in this codebase.
//
// This module only owns the pure canvas-drawing primitives (scene/* never
// imports ui/*, see weapons.ts/sprites.ts for the same convention) — the
// caller (ui/gacha.ts) hands drawMachine() a ctx via pixel-icon.ts's
// composite pipeline (pixelIconComposite/pixelIconCompositeUrl), which
// draws it once onto an offscreen canvas, caches the raster as a data URL,
// and reuses it — so the "expensive" part (this draw pass) really is only
// re-run when the (kind, brass-tint) cache key changes, matching the "not
// redrawn every frame" requirement without a second bespoke cache.

import { drawSprite, spriteSize, withPalette, type PixelMap } from "./sprites";

export const MACHINE_W = 104;
export const MACHINE_H = 92;

/** The transparent glass-window rectangle, in native pixel coordinates —
 * every layer below is drawn either entirely outside this rect, or the rect
 * is punched back out to fully transparent via ctx.clearRect after the body
 * fill (see drawMachine's first two calls). Whatever DOM element sits
 * BEHIND this illustration's <img> (ui/gacha.ts mounts the case-opening
 * reel there) shows through at exactly this rectangle.
 *
 * MACHINE_WINDOW_PCT is the same rectangle as a percentage of the full
 * MACHINE_W x MACHINE_H canvas — ui/gacha.ts's .gacha-machine-window CSS
 * rule positions the reel-hosting overlay div using these exact numbers
 * (hardcoded into styles.css since CSS can't import JS constants; keep the
 * two in lockstep by hand if this rect ever moves), so the reel stays
 * aligned to the glass regardless of how large the slot renders. */
export const MACHINE_WINDOW = { x: 10, y: 21, w: 84, h: 47 };
export const MACHINE_WINDOW_PCT = {
  left: (MACHINE_WINDOW.x / MACHINE_W) * 100,
  top: (MACHINE_WINDOW.y / MACHINE_H) * 100,
  width: (MACHINE_WINDOW.w / MACHINE_W) * 100,
  height: (MACHINE_WINDOW.h / MACHINE_H) * 100,
};

export type MachineKind = "worker" | "item" | "powerup";

// Self-contained letter->color table (same convention as scene/ui-icons.ts's
// UI_PALETTE) rather than reaching into sprites.ts's own PALETTE, so this
// module's letters can never collide with an unrelated scene meaning.
const MACHINE_PALETTE: Record<string, string> = {
  T: "#8c603a", // dark wood cabinet body (matches sprites.ts's `w` axe-handle brown)
  t: "#6e4c30", // wood shade / side posts (matches sprites.ts's `T` trunk brown)
  K: "#2a1e12", // ink outline (matches UI_PALETTE's K / --text-bright)
  C: "#fdf6e8", // header plaque parchment fill (matches UI_PALETTE's W)
  P: "#c98f1c", // brass/gold trim — remapped per-world for the Item machine (see drawMachine)
  p: "#8a6535", // brass trim shade — remapped per-world for the Item machine
  G: "#3f2c1a", // dispense-tray dark slot
  Y: "#f2cf6b", // glass-shine highlight tint, drawn at reduced alpha
};

// --- Detail layers (small PixelMaps, composited via drawSprite) -----------

const RIVET: PixelMap = ["Pp", "pP"];

/** Corners of the header plaque + the glass window, in native px — where
 * RIVET gets stamped. */
const RIVET_SPOTS: [number, number][] = [
  [10, 3],
  [92, 3],
  [10, 16],
  [92, 16],
  [7, 19],
  [95, 19],
  [7, 69],
  [95, 69],
];

// Crossed-axes silhouette (Worker machine).
const HEADER_AXES: PixelMap = [
  "P.......P",
  "KP.....PK",
  ".KP...PK.",
  "..KP.PK..",
  "...KPK...",
  "..PK.KP..",
  ".PK...KP.",
  "PK.....KP",
  "K.......K",
];

// Sword-and-crossguard silhouette (Item machine).
const HEADER_SWORD: PixelMap = [
  "...K...",
  "...P...",
  "...P...",
  "...P...",
  ".KPPPK.",
  "...P...",
  "..KKK..",
  "...P...",
  "..PPP..",
];

// Lightning-bolt silhouette (Power-up machine).
const HEADER_SPARK: PixelMap = [
  "...PP..",
  "..PP...",
  ".PP....",
  "PPPPP..",
  "...PP..",
  "..PP...",
  ".PP....",
  "PP.....",
  "....K..",
];

const HEADER_ICON: Record<MachineKind, PixelMap> = {
  worker: HEADER_AXES,
  item: HEADER_SWORD,
  powerup: HEADER_SPARK,
};

// Diagonal glass-glint streak, drawn last at reduced alpha inside the
// window rect — a cheap "amber glass" shine.
const GLASS_SHINE: PixelMap = [
  "Y......",
  "YY.....",
  ".YY....",
  "..YY...",
  "...YY..",
  "....YY.",
  ".....YY",
  "......Y",
];

const PLAQUE = { x: 12, y: 5, w: MACHINE_W - 24, h: 12 };
const POST_W = 5;
const TRAY = { w: 36, h: 6 };

/** Draws one full machine illustration onto `ctx` (expected to already be
 * sized MACHINE_W x MACHINE_H — see MACHINE_W/MACHINE_H above). `kind`
 * swaps only the header-plaque icon; `brassPalette`, when given, remaps the
 * brass trim letters (`P`/`p`) — used by the Item machine to tint per-world
 * (see ui/gacha.ts, which remaps CURATED_WORLD_THEMES[world].workerPalette's
 * existing R/r values onto P/p here, per the Part E brief). Worker/Power-up
 * machines pass null (default, untinted brass) since neither pool is
 * world-scoped. */
export function drawMachine(
  ctx: CanvasRenderingContext2D,
  kind: MachineKind,
  brassPalette: Record<string, string> | null = null,
): void {
  const col = (letter: string): string => brassPalette?.[letter] ?? MACHINE_PALETTE[letter];

  // 1-2. Cabinet body fill, then punch the glass window back out to fully
  // transparent — every layer after this carefully avoids redrawing over
  // that rect (see MACHINE_WINDOW above).
  ctx.fillStyle = col("T");
  ctx.fillRect(0, 0, MACHINE_W, MACHINE_H);
  ctx.clearRect(MACHINE_WINDOW.x, MACHINE_WINDOW.y, MACHINE_WINDOW.w, MACHINE_WINDOW.h);

  // 3. Carved-log side posts, full height.
  ctx.fillStyle = col("t");
  ctx.fillRect(2, 2, POST_W, MACHINE_H - 4);
  ctx.fillRect(MACHINE_W - POST_W - 2, 2, POST_W, MACHINE_H - 4);

  // 4. Brass top cap.
  ctx.fillStyle = col("P");
  ctx.fillRect(0, 0, MACHINE_W, 4);

  // 5. Header plaque: ink border + parchment fill.
  ctx.fillStyle = col("K");
  ctx.fillRect(PLAQUE.x - 1, PLAQUE.y - 1, PLAQUE.w + 2, PLAQUE.h + 2);
  ctx.fillStyle = col("C");
  ctx.fillRect(PLAQUE.x, PLAQUE.y, PLAQUE.w, PLAQUE.h);

  // 6-7. Brass trim strips bracketing the window, top and bottom.
  ctx.fillStyle = col("P");
  ctx.fillRect(0, MACHINE_WINDOW.y - 3, MACHINE_W, 3);
  ctx.fillRect(0, MACHINE_WINDOW.y + MACHINE_WINDOW.h, MACHINE_W, 3);

  // 8. Base cabinet band + dispense-tray notch.
  const baseY = MACHINE_WINDOW.y + MACHINE_WINDOW.h + 3;
  ctx.fillStyle = col("T");
  ctx.fillRect(0, baseY, MACHINE_W, MACHINE_H - baseY);
  const trayX = (MACHINE_W - TRAY.w) / 2;
  const trayY = MACHINE_H - 10;
  ctx.fillStyle = col("G");
  ctx.fillRect(trayX, trayY, TRAY.w, TRAY.h);
  ctx.fillStyle = col("K");
  ctx.fillRect(trayX, trayY, TRAY.w, 1);

  // 9. Brass corner rivets.
  withPalette({ P: col("P"), p: col("p") }, () => {
    for (const [rx, ry] of RIVET_SPOTS) drawSprite(ctx, RIVET, rx, ry);
  });

  // 10. Header icon, centered in the plaque.
  const icon = HEADER_ICON[kind];
  const iconSize = spriteSize(icon);
  withPalette({ K: col("K"), P: col("P") }, () => {
    drawSprite(
      ctx,
      icon,
      PLAQUE.x + Math.floor((PLAQUE.w - iconSize.w) / 2),
      PLAQUE.y + Math.floor((PLAQUE.h - iconSize.h) / 2),
    );
  });

  // 11. Diagonal glass-shine glint, drawn last at reduced alpha so the
  // window underneath (whatever DOM sits behind this <img>) stays legible
  // through it — restored to full opacity immediately after.
  ctx.save();
  ctx.globalAlpha = 0.25;
  withPalette({ Y: col("Y") }, () => {
    drawSprite(ctx, GLASS_SHINE, MACHINE_WINDOW.x + 6, MACHINE_WINDOW.y + 4);
  });
  ctx.restore();
}
