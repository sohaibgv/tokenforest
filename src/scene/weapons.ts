// Weapon visual identity (Part D): rarity+slot-scoped pixel-art weapons,
// composited "held in hand" on top of the existing body sprites (field/POV
// woodcutting, Battle party members), plus icon-only Utility charms.
//
// Held weapons are NOT baked into the body PixelMaps anymore (see
// sprites.ts's WC_STAND/WC_CHOP_UP/WC_CHOP_DOWN, which used to bake a
// generic axe in via the `A`/`w` letters) — they're drawn as a separate
// small PixelMap snapped onto the body's hand via HAND_ANCHOR + the
// weapon's own `grip` offset, the same "small map + own palette,
// composited over the base sprite" trick GLOW_SM/SIGN_NO_AI/DATA_BEAM
// already use elsewhere in sprites.ts.

import {
  drawSprite,
  spriteSize,
  withPalette,
  type PixelMap,
} from "./sprites";
import type { Rarity } from "../economy";

export type WeaponPoseName = "idle" | "attackWindup" | "attackStrike";

/** The fixed width every worker/enemy body sprite shares (see sprites.ts's
 * "Woodcutter, 10 wide" comment) — drawSprite's flip mirrors a sprite's own
 * pixels within its own width, so a hand-anchor x position must be mirrored
 * against THIS constant (not the weapon's own width) to land on the
 * flipped body's actual hand. */
export const BODY_SPRITE_W = 10;

/** Where the woodcutter's/party-member's hand sits for each pose, expressed
 * as an offset from the character's own ground-anchor point — the same
 * point every body draw call already anchors on: Woodcutter.render() draws
 * the body at (this.x, this.y - h), so "ground" is (this.x, this.y); the
 * POV close-up and Battle both ctx.translate to that same point before
 * drawing the body at local (-w/2, -h) or (x, -h), so ground is local
 * (0, 0) there. drawHeldWeapon takes that ground point explicitly (see its
 * doc comment for why) so it works identically across all 3 draw sites.
 *
 * Derived from the REAL pre-Part-D pixel positions of the generic axe's `w`
 * (handle) pixels in WC_STAND/WC_CHOP_UP/WC_CHOP_DOWN, before those pixels
 * were extracted into this file (see sprites.ts's comment above WC_STAND):
 *   - idle:         WC_STAND    row 4, col 7  -> screen (x+7, y-8+4) = (x+7, y-4)
 *   - attackWindup: WC_CHOP_UP  row 4, col 5  -> screen (x+5, y-8+4) = (x+5, y-4)
 *   - attackStrike: WC_CHOP_DOWN row 3, col 5 -> screen (x+5, y-8+3) = (x+5, y-5)
 * (h=8 for the common/rare/epic 8-row frames.)
 *
 * One shared table works for all 4 rarity tiers — verified against the
 * actual sprite data, not assumed: legendary's STAND/CHOP_UP/CHOP_DOWN
 * frames are 9 rows tall (one extra crown row up top) with the same `w`
 * pixels shifted down exactly one row (e.g. LEGENDARY_STAND row 5 col 7
 * instead of WC_STAND's row 4 col 7), so `screenY = groundY - h + row`
 * lands on the SAME absolute screen row either way (groundY-9+5 ===
 * groundY-8+4). Anchoring HAND_ANCHOR to the ground point (rather than each
 * map's own top-left) is exactly what makes one shared table correct
 * across all 4 tiers, including legendary's taller frame — confirmed by
 * checking every rarity's STAND/CHOP_UP/CHOP_DOWN `w` position by hand.
 *
 * Also shared by the Battle render path: battleUnitPose's idle/
 * attackWindup/attackStrike frames are literally the same stand/chopUp/
 * chopDown maps (see game.ts's renderBattle), just drawn at a different
 * zoom/position, so this table applies there unchanged too. */
export const HAND_ANCHOR: Record<WeaponPoseName, { x: number; y: number }> = {
  idle: { x: 7, y: -4 },
  attackWindup: { x: 5, y: -4 },
  attackStrike: { x: 5, y: -5 },
};

export interface HeldWeaponPoses {
  idle: PixelMap;
  attackWindup: PixelMap;
  attackStrike: PixelMap;
  /** The local pixel — SAME (x, y) across all 3 pose maps above — that
   * snaps to HAND_ANCHOR[pose]. Since a PixelMap can't have negative row/col
   * indices, poses whose hand sits deep inside their own silhouette (e.g. a
   * raised windup with several rows of blade above the hand) force the
   * OTHER poses of that same weapon to be padded with leading blank rows/
   * cols so their grip pixel lands at that identical local index too — see
   * each weapon's block comment below for the concrete padding. */
  grip: { x: number; y: number };
}

export interface WeaponVisual {
  slot: "woodchopping" | "adventuring" | "utility";
  rarity: Rarity;
  /** Woodchopping + Adventuring only — Utility is never held in-hand. */
  held?: HeldWeaponPoses;
  /** All 3 slots; callers fall back to `held.idle` when this is omitted
   * (Woodchopping/Adventuring reuse the same asset at a different draw
   * scale for DOM icons / the gacha reel — one asset, multiple draw sites).
   * Utility defines its own since it has no held pose. */
  icon?: PixelMap;
}

/** Draws `poses[pose]` so its `grip` pixel lands exactly on
 * `HAND_ANCHOR[pose]`, relative to the character's own ground-anchor point
 * `(groundX, groundY)` — the same point the caller's own body drawSprite
 * call was just positioned from (see HAND_ANCHOR's doc comment). Mirrors
 * the anchor x against BODY_SPRITE_W when `bodyFlip` is true, matching how
 * the body's own `drawSprite(..., flip)` call already mirrors its content
 * in place within its own width — so a flipped weapon mirrors along with
 * the flipped hand instead of drifting off it.
 *
 * Deviation from the originally-sketched signature: this takes the
 * character's ground anchor (`groundX`, `groundY`) as two extra explicit
 * params. Every call site draws the body via an explicit (x, y) — not a
 * ctx.translate to the origin — so drawHeldWeapon has no other way to know
 * where "the hand" is without either reimplementing that positioning logic
 * per call site or requiring an extra save/translate/restore around the
 * body draw (which the brief explicitly ruled out for Woodcutter.render()).
 * Passing the two numbers is the smallest change that keeps this reusable
 * across all 3 render paths (field/POV/Battle) without touching ctx state. */
export function drawHeldWeapon(
  ctx: CanvasRenderingContext2D,
  poses: HeldWeaponPoses,
  pose: WeaponPoseName,
  weaponPalette: Record<string, string> | null,
  bodyFlip: boolean,
  groundX: number,
  groundY: number,
): void {
  const map = poses[pose];
  const mapW = spriteSize(map).w;
  const anchor = HAND_ANCHOR[pose];
  const anchorX = bodyFlip ? BODY_SPRITE_W - 1 - anchor.x : anchor.x;
  const screenAnchorX = groundX + anchorX;
  const screenAnchorY = groundY + anchor.y;
  const drawX = bodyFlip
    ? screenAnchorX - (mapW - 1 - poses.grip.x)
    : screenAnchorX - poses.grip.x;
  const drawY = screenAnchorY - poses.grip.y;
  withPalette(weaponPalette, () => {
    drawSprite(ctx, map, Math.round(drawX), Math.round(drawY), bodyFlip);
  });
}

// --- Woodchopping: axe family ----------------------------------------------
// Common reproduces the pre-Part-D baked-in generic axe 1:1 (verified
// pixel-exact against the old `A`/`w` positions above — same silhouette,
// re-encoded with the new `D` steel letter). Grip pixels reuse the existing
// `w` handle-brown letter. Rarity accent reuses the exact letters the
// worker rarity tiers already use for that tier (rare `N` teal, epic `H`/
// `h` purple, legendary `Y`/`y` gold) — a legendary axe glows with the
// literal same pixels as a legendary worker's crown.
//
// Every weapon below pads its idle/attackStrike maps with leading blank
// rows so their grip lands on the same local (x, y) as attackWindup's,
// which always needs the deepest reach above the hand (the raised swing).

const AXE_COMMON: HeldWeaponPoses = {
  // Padded from [".w","w."] (grip was row 1) so grip lands at row 4.
  idle: ["..", "..", "..", ".w", "w."],
  attackWindup: [".D.", ".DD", ".w.", ".w.", "w.."],
  // Padded from ["wwDD","..DD"] (grip was row 0) so grip lands at row 4.
  attackStrike: ["....", "....", "....", "....", "wwDD", "..DD"],
  grip: { x: 0, y: 4 },
};

const AXE_RARE: HeldWeaponPoses = {
  idle: ["...", "...", "...", ".wN", "w.."],
  attackWindup: [".DD.", ".DDN", ".w..", ".w..", "w..."],
  attackStrike: [".....", ".....", ".....", ".....", "wwDDN", "..DD."],
  grip: { x: 0, y: 4 },
};

// Bearded-axe flare (wider/hooked head), two-tone D/d shading, one row
// longer haft than rare (6-row windup vs. rare's 5).
const AXE_EPIC: HeldWeaponPoses = {
  idle: ["...", "...", "...", "...", ".wH", "w.d"],
  attackWindup: [".DD.", ".DdH", ".dw.", ".w..", ".w..", "w..."],
  attackStrike: ["......", "......", "......", "......", "......", "wwwDD.", "..dDH.", "...D.."],
  grip: { x: 0, y: 5 },
};

// Double-bladed silhouette (a second head mirrored on the other side of the
// grip), fully rimmed `Y`, with a detached `y` glow-halo pixel floating just
// outside the silhouette on each side (same "isolated highlight pixel next
// to the sprite" trick GLOW_SM/SPARK already use) — baked into every pose
// including idle, so it reads as glowing even at rest.
const AXE_LEGENDARY: HeldWeaponPoses = {
  // Padded from ["y...y","YDwDY","..w.."] (grip was row 2) so grip lands at
  // row 3, matching attackWindup's deeper reach.
  idle: [".....", "y...y", "YDwDY", "..w.."],
  attackWindup: ["y...y", "YDwDY", "..w..", "..w.."],
  // Padded from ["y.....y","YDwwwDY","....y.."] (grip was row 1) so grip
  // lands at row 3.
  attackStrike: [".......", ".......", "y.....y", "YDwwwDY", "....y.."],
  grip: { x: 2, y: 3 },
};

export const WEAPON_AXES: Record<Rarity, HeldWeaponPoses> = {
  common: AXE_COMMON,
  rare: AXE_RARE,
  epic: AXE_EPIC,
  legendary: AXE_LEGENDARY,
};

// --- Adventuring: blade family ---------------------------------------------
// Visually smaller than the axe family at common tier (a dagger, not a
// hatchet) so the two slots never read as the same glyph even though they
// share steel-color letters. Legendary is the longest silhouette of the
// whole 12-design set, with a glowing accent CORE line running down the
// center of the blade (`Y` rim / `y` core) — deliberately a different
// "glow" trick than the axe's detached halo pixels, so the two legendary
// weapons read as distinct effects rather than reskins of each other.

const BLADE_COMMON: HeldWeaponPoses = {
  // Padded from ["w","D"] (grip was row 0) so grip lands at row 2.
  idle: [".", ".", "w", "D"],
  attackWindup: ["D", "D", "w"],
  // Padded from ["wDD"] (grip was row 0) so grip lands at row 2.
  attackStrike: ["...", "...", "wDD"],
  grip: { x: 0, y: 2 },
};

const BLADE_RARE: HeldWeaponPoses = {
  idle: [".", ".", ".", "w", "D", "N"],
  attackWindup: ["D", "N", "D", "w"],
  attackStrike: ["....", "....", "....", "wDND"],
  grip: { x: 0, y: 3 },
};

// Wider (two-pixel-thick) blade, a crossguard pixel (`H`) added at the grip,
// two-tone D/d shading.
const BLADE_EPIC: HeldWeaponPoses = {
  idle: ["...", "...", "HwH", "DdD", "DdD"],
  attackWindup: ["DdD", "DdD", "HwH", ".w."],
  attackStrike: ["......", "......", "HwDDdd", ".wDDdd"],
  grip: { x: 1, y: 2 },
};

const BLADE_LEGENDARY: HeldWeaponPoses = {
  idle: ["...", "...", "...", ".w.", "YyY", "YyY", "YyY"],
  attackWindup: ["YyY", "YyY", "YyY", ".w."],
  attackStrike: ["......", "......", "......", ".wYyYy"],
  grip: { x: 1, y: 3 },
};

export const WEAPON_BLADES: Record<Rarity, HeldWeaponPoses> = {
  common: BLADE_COMMON,
  rare: BLADE_RARE,
  epic: BLADE_EPIC,
  legendary: BLADE_LEGENDARY,
};

// --- Utility: charm family (icon-only, never held) -------------------------
// Frame reuses the new `Q`/`q` bronze/pewter letters throughout; rarity
// accent again reuses the exact worker-tier letters (rare `N`, epic `H`/
// `h`, legendary `Y`/`y`).

const CHARM_COMMON: PixelMap = [
  ".QQQ.",
  "Qq.qQ",
  "Qq.qQ",
  "Qq.qQ",
  ".QQQ.",
];

// Same frame, an accent-colored gem center + one facet-highlight pixel.
const CHARM_RARE: PixelMap = [
  ".QQN.",
  "Qq.qQ",
  "QqNqQ",
  "Qq.qQ",
  ".QQQ.",
];

// Second outer ring + small flourish points at the corners, two-tone
// accent-colored center.
const CHARM_EPIC: PixelMap = [
  "H.Q.H",
  ".QqQ.",
  "QqHhQ",
  ".QqQ.",
  "H.Q.H",
];

// Glowing accent core, with a detached halo pixel outside the frame (same
// glow trick as the legendary axe).
const CHARM_LEGENDARY: PixelMap = [
  "y.....",
  ".QQQQ.",
  ".QyYQ.",
  ".QYyQ.",
  ".QQQQ.",
];

export const WEAPON_CHARMS: Record<Rarity, PixelMap> = {
  common: CHARM_COMMON,
  rare: CHARM_RARE,
  epic: CHARM_EPIC,
  legendary: CHARM_LEGENDARY,
};

export const WEAPON_APPEARANCE: Record<
  "woodchopping" | "adventuring" | "utility",
  Record<Rarity, WeaponVisual>
> = {
  woodchopping: {
    common: { slot: "woodchopping", rarity: "common", held: WEAPON_AXES.common },
    rare: { slot: "woodchopping", rarity: "rare", held: WEAPON_AXES.rare },
    epic: { slot: "woodchopping", rarity: "epic", held: WEAPON_AXES.epic },
    legendary: { slot: "woodchopping", rarity: "legendary", held: WEAPON_AXES.legendary },
  },
  adventuring: {
    common: { slot: "adventuring", rarity: "common", held: WEAPON_BLADES.common },
    rare: { slot: "adventuring", rarity: "rare", held: WEAPON_BLADES.rare },
    epic: { slot: "adventuring", rarity: "epic", held: WEAPON_BLADES.epic },
    legendary: { slot: "adventuring", rarity: "legendary", held: WEAPON_BLADES.legendary },
  },
  utility: {
    common: { slot: "utility", rarity: "common", icon: WEAPON_CHARMS.common },
    rare: { slot: "utility", rarity: "rare", icon: WEAPON_CHARMS.rare },
    epic: { slot: "utility", rarity: "epic", icon: WEAPON_CHARMS.epic },
    legendary: { slot: "utility", rarity: "legendary", icon: WEAPON_CHARMS.legendary },
  },
};
