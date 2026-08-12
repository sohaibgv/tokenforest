// Minimal enemy-sprite rendering groundwork for Part B — a pure draw helper,
// not a stateful entity. The turn-based battle screen (a later part) owns
// its own battle-unit state machine and is expected to call into
// ENEMY_KIND_SPRITES/ENEMY_CHARACTERS_BY_ID directly rather than through
// this file if it needs richer control; this just proves the sprite set
// composes correctly (kind silhouette + per-character accent + the
// protestor's composited sign) before that larger piece lands.

import { ENEMY_CHARACTERS_BY_ID } from "../adventure";
import {
  drawSprite,
  ENEMY_KIND_SPRITES,
  SIGN_NO_AI,
  spriteSize,
  withPalette,
  type EnemyFrameSet,
} from "./sprites";

export type EnemyAnimState = keyof EnemyFrameSet;

/** Draws one enemy character in the given animation state, composing the
 * kind's shared silhouette with the character's palette accent (and the
 * current world's workerPalette, if any, for protestor vest reskinning) —
 * plus, for protestors outside the "defeated" state, the picket sign
 * composited above the raised hand. */
export function renderEnemy(
  ctx: CanvasRenderingContext2D,
  characterId: string,
  state: EnemyAnimState,
  x: number,
  y: number,
  worldPalette: Record<string, string> | null = null,
  flip = false,
): void {
  const character = ENEMY_CHARACTERS_BY_ID[characterId];
  if (!character) return;
  const frames = ENEMY_KIND_SPRITES[character.kind];
  const map = frames[state] ?? frames.idle;
  const { h } = spriteSize(map);
  const palette = { ...(worldPalette ?? {}), ...character.accent };

  withPalette(palette, () => {
    drawSprite(ctx, map, Math.round(x), Math.round(y - h), flip);
    if (character.kind === "protestor" && state !== "defeated") {
      const signSize = spriteSize(SIGN_NO_AI);
      const signX = flip ? x - signSize.w + 2 : x + spriteSize(map).w - 2;
      drawSprite(ctx, SIGN_NO_AI, Math.round(signX), Math.round(y - h - signSize.h + 1), flip);
    }
  });
}
