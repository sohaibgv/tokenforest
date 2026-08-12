// Where everything stands in a battle: formation tables, slot positions,
// per-slot zoom, and the two small deformations (idle bob, death collapse).
//
// Lifted out of scene/game.ts as pure functions of (index, count, canvas
// size, clock). None of it touched Game state beyond `w`/`h`/`animT`, so it
// was never really part of the class — it was a lookup table and some
// arithmetic that happened to live in a 6,000-line file. Pulling it out first
// is also what makes the battle RENDERER extractable: a third of that
// renderer's coupling to Game was calls to these six methods.

/** Party formation (front, backLeft, backRight) — front sits nearest the
 * enemy's own 0.5h engagement line (conventional JRPG framing: the front line
 * engages closest, back-liners hang back toward the viewer), centred and
 * offset to either side for the two back slots. Front and the enemy sit on
 * opposite horizontal thirds (party x ~= 0.24w, enemy x ~= 0.74w), so sharing
 * a near-identical dyFrac risks no overlap despite front being the biggest
 * party sprite next to the biggest sprite in the scene. Ratios echo Muster's
 * `.adv-formation` back/front size split. */
export const BATTLE_FORMATION: { dx: number; dyFrac: number }[] = [
  { dx: 0, dyFrac: 0.5 }, // front
  { dx: -0.1, dyFrac: 0.72 }, // backLeft
  { dx: 0.1, dyFrac: 0.72 }, // backRight
];

/** Per-slot zoom, used both to draw the sprite and to size/place the
 * turn-glow above it — front full size, back slots ~0.67x, matching
 * BATTLE_FORMATION's ratio. */
export const BATTLE_ZOOM = [3, 2, 2];

/** Idle "breathing" bob — a small sine offset applied to a unit's draw
 * position only while it is genuinely idle, never touching hit/attack timing. */
export const BATTLE_IDLE_BOB_AMP = 1.5;
export const BATTLE_IDLE_BOB_FREQ = (Math.PI * 2) / 1.6; // ~1.6s period

/** Enemy-side formation, indexed by enemy COUNT rather than by slot, because
 * the ideal spread genuinely differs by how many are sharing the space. A
 * solo enemy reproduces the original single-enemy slot and zoom exactly, so
 * the overwhelmingly common 1-enemy stage renders unchanged. A count beyond
 * what's defined falls back to the widest tier and crowds its outer slots.
 *
 * Zooms are INTEGERS on purpose: drawSprite renders 1px fillRects under
 * ctx.scale, and a fractional scale lands those on fractional device pixels,
 * where Chromium anti-aliases every sprite edge into a blur (verified in
 * headless screenshots at the old 3.4/2.9 values). */
export const BATTLE_ENEMY_FORMATIONS: {
  dx: number;
  dyFrac: number;
  zoom: number;
}[][] = [
  [], // 0 enemies — never actually rendered
  [{ dx: 0, dyFrac: 0.5, zoom: 4 }],
  [
    { dx: -0.1, dyFrac: 0.48, zoom: 3 },
    { dx: 0.1, dyFrac: 0.52, zoom: 3 },
  ],
  [
    { dx: 0, dyFrac: 0.44, zoom: 3 },
    { dx: -0.15, dyFrac: 0.55, zoom: 3 },
    { dx: 0.15, dyFrac: 0.55, zoom: 3 },
  ],
];

export interface Canvas {
  w: number;
  h: number;
}

export function battlePartySlot(index: number, c: Canvas): { x: number; y: number } {
  const slot = BATTLE_FORMATION[index] ?? BATTLE_FORMATION[BATTLE_FORMATION.length - 1];
  return {
    x: Math.round(c.w * (0.24 + slot.dx)),
    y: Math.round(c.h * slot.dyFrac),
  };
}

export function battleEnemyFormation(count: number): { dx: number; dyFrac: number; zoom: number }[] {
  return BATTLE_ENEMY_FORMATIONS[count] ?? BATTLE_ENEMY_FORMATIONS[BATTLE_ENEMY_FORMATIONS.length - 1];
}

export function battleEnemySlot(index: number, count: number, c: Canvas): { x: number; y: number } {
  const formation = battleEnemyFormation(count);
  const slot = formation[index] ?? formation[formation.length - 1] ?? { dx: 0, dyFrac: 0.5 };
  return {
    x: Math.round(c.w * (0.74 + slot.dx)),
    y: Math.round(c.h * slot.dyFrac),
  };
}

export function battleEnemyZoom(index: number, count: number): number {
  const formation = battleEnemyFormation(count);
  return (formation[index] ?? formation[formation.length - 1])?.zoom ?? 4;
}

export function battleIdleBob(poseName: string, animT: number): number {
  if (poseName !== "idle") return 0;
  return Math.round(Math.sin(animT * BATTLE_IDLE_BOB_FREQ) * BATTLE_IDLE_BOB_AMP);
}

/** Vertical squash for a unit mid-collapse: a quick stretch as it drops, a
 * hard squash at impact, then an ease back to rest. 1 = no deformation.
 *
 * The settle matters: holding the squash until the timer expired and then
 * snapping back to 1 popped the corpse upright in a single frame. */
export function deathSquash(t: number | undefined, deathSecs: number): number {
  if (t === undefined) return 1;
  const p = Math.min(1, t / deathSecs);
  // Stretch on the way down, squash hard at impact, then settle back to rest.
  if (p < 0.3) return 1 + 0.12 * (p / 0.3);
  if (p < 0.55) return 1.12 - 0.5 * ((p - 0.3) / 0.25);
  const settle = (p - 0.55) / 0.45;
  return 0.62 + 0.38 * settle * settle; // ease-in back to 1, no pop
}
