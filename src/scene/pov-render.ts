// The first-person chopping view — a full-canvas close-up of one woodcutter.
//
// Lifted out of scene/game.ts behind an explicit PovView, the same pattern as
// the other renderers in this directory. The world keeps simulating behind
// this: it is only ever a different way of drawing the current frame, never a
// pause.

import { getWorld } from "../economy";
import {
  drawSprite,
  RARITY_WOODCUTTER_SPRITES,
  spriteSize,
  TREE,
  TREE_ELDER,
  TREE_LG,
  TREE_SM,
  withPalette,
  type PixelMap,
} from "./sprites";
import type { TreeKind } from "./forest";
import { drawHeldWeapon, WEAPON_APPEARANCE } from "./weapons";
import type { Woodcutter } from "./woodcutter";

export interface PovView {
  w: number;
  h: number;
  plotWorld: number;
  povTarget: Woodcutter | null;
  /** Counts UP while the chopper walks into frame. */
  povWalkT: number;
  povWalkSecs: number;
  renderSkillCheck(ctx: CanvasRenderingContext2D, w: number, h: number): void;
  treePalette(world: number): Record<string, string> | null;
  workerPalette(world: number): Record<string, string> | null;
  weaponPalette(world: number): Record<string, string> | null;
}

/** Which tree sprite fills the POV frame, by kind. Moved here with the
 * renderer — it had no other caller. */
const POV_TREE_SPRITE: Record<TreeKind, PixelMap> = {
  small: TREE_SM,
  medium: TREE,
  large: TREE_LG,
  elder: TREE_ELDER,
};

export function renderPovScene(ctx: CanvasRenderingContext2D, v: PovView): void {
  const wc = v.povTarget;
  if (!wc) return;
  const w = v.w;
  const h = v.h;
  const world = getWorld(v.plotWorld);

  ctx.fillStyle = world.ground;
  ctx.fillRect(0, 0, w, h);
  const vignette = ctx.createRadialGradient(
    w / 2,
    h * 0.55,
    Math.min(w, h) * 0.15,
    w / 2,
    h * 0.55,
    Math.max(w, h) * 0.75,
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.5)");
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  const cx = Math.round(w / 2);
  const cy = Math.round(h * 0.62);
  const zoom = 6;

  // How far through the approach the worker is (0 = just arrived at the edge
  // of frame, 1 = standing at the trunk). Drives both his position and which
  // frames he uses, so POV shows him actually walking up rather than snapping
  // into place the instant the view opens.
  const approach = Math.min(1, v.povWalkT / v.povWalkSecs);
  const eased = 1 - (1 - approach) ** 2;

  const tree = wc.currentTree;
  if (tree) {
    const treeSprite = POV_TREE_SPRITE[tree.kind];
    const tSize = spriteSize(treeSprite);
    withPalette(v.treePalette(v.plotWorld), () => {
      ctx.save();
      ctx.translate(cx, cy - 2);
      ctx.scale(zoom, zoom);
      // The tree used to be drawn as a static sprite regardless of its state,
      // so felling one in POV just made it vanish. Mirror the world's own
      // fall: stretch as it goes over, then squash at impact, pivoting about
      // the trunk base.
      if (tree.state === "falling") {
        const t = Math.min(1, tree.t);
        const dir = wc.facing === -1 ? -1 : 1;
        ctx.translate(0, 0);
        ctx.rotate(dir * t * t * (Math.PI / 2) * 0.95);
        const stretch =
          t < 0.85 ? 1 + 0.08 * (t / 0.85) : 1 - 0.18 * ((t - 0.85) / 0.15);
        ctx.scale(1 / Math.sqrt(stretch), stretch);
        ctx.globalAlpha = 1 - Math.max(0, (t - 0.8) / 0.2) * 0.35;
      } else if (tree.shake > 0) {
        // Hit wobble, same cue the world view gives on a landed chop.
        ctx.translate(Math.sin(tree.shake * 40) * 0.4, 0);
      }
      drawSprite(ctx, treeSprite, -Math.floor(tSize.w / 2), -tSize.h);
      ctx.restore();
    });
  }

  // Walking in: start off to the side and close the distance. Uses the same
  // walk frames the world view uses, so the two views agree about what he's
  // doing at any moment.
  const walking = approach < 1;
  const frames = RARITY_WOODCUTTER_SPRITES[wc.rarity];
  const frame = walking
    ? Math.floor(v.povWalkT * 8) % 2 === 0
      ? frames.walk1
      : frames.walk2
    : wc.currentFrame();
  const wSize = spriteSize(frame);
  const povFlip = wc.facing === -1;
  const weaponPose = walking ? null : wc.currentWeaponPose();
  const approachDx = Math.round((1 - eased) * (wc.facing === -1 ? 26 : -26));
  withPalette(wc.paletteOverride(v.workerPalette(v.plotWorld)), () => {
    ctx.save();
    ctx.translate(cx + approachDx, cy);
    ctx.scale(zoom, zoom);
    drawSprite(ctx, frame, -Math.floor(wSize.w / 2), -wSize.h, povFlip);
    if (weaponPose) {
      const held =
        WEAPON_APPEARANCE.woodchopping[wc.resolvedWeaponRarity()].held;
      if (held) {
        drawHeldWeapon(
          ctx,
          held,
          weaponPose,
          v.weaponPalette(v.plotWorld),
          povFlip,
          -Math.floor(wSize.w / 2),
          0,
        );
      }
    }
    ctx.restore();
  });

  v.renderSkillCheck(ctx, w, h);
}
