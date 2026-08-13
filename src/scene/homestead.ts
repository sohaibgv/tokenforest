// Rendering for the homestead: the fence, the cottage, the barn, and every
// buildable you have placed in the yard.
//
// Lifted out of scene/game.ts behind an explicit HomesteadView, the same
// pattern as scene/travel.ts and scene/battle-render.ts. Nine dependencies,
// all of them either the plot itself or a piece of yard geometry — which is
// what made this one of the cleanest blocks in the file to move.

import type { GameSave } from "../game-state";
import { CELL } from "./grid";
import {
  BARN_PHASE_SPRITES,
  BUILDABLE_SPRITES,
  COTTAGE_PHASE_SPRITES,
  drawSprite,
  drawText,
  ENCAMPMENT,
  spriteSize,
  textWidth,
  TRAIL_PATCH,
} from "./sprites";
import type { Plot } from "./plot";

export interface HomesteadView {
  plot: Plot;
  save: GameSave;
  yardRect(): { cx: number; cy: number; cols: number; rows: number };
  cottagePos(): { x: number; y: number };
  cottagePhase(): number;
  barnPos(): { x: number; y: number };
  barnPhase(): number;
  barnAvailable(): boolean;
  encampmentPos(): { x: number; y: number };
}

/** Queues the homestead into the caller's depth-sorted pass, so a worker
 * walking past the cottage is occluded by it exactly like a tree. */
export function pushHomesteadDrawables(
  ctx: CanvasRenderingContext2D,
  drawables: { y: number; draw: () => void }[],
  v: HomesteadView,
): void {
  const grid = v.plot.forest.gridRef();
  const yard = v.yardRect();

  const left = grid.footing({ cx: yard.cx, cy: yard.cy }).x - CELL / 2;
  const right =
    grid.footing({ cx: yard.cx + yard.cols - 1, cy: yard.cy }).x + CELL / 2;
  // The rail sits one row IN FRONT of the last content row, not on it. Sharing
  // a baseline with the front-row props drew the rail straight through the
  // woodpile and the whetstone.
  const frontY = grid.footing({ cx: yard.cx, cy: yard.cy + yard.rows }).y;
  const backY = grid.footing({ cx: yard.cx, cy: yard.cy }).y - CELL;

  const rail = (x0: number, y0: number, x1: number, y1: number): void => {
    ctx.strokeStyle = "#8a6440";
    ctx.lineWidth = 1;
    for (const dy of [-4.5, -2.5]) {
      ctx.beginPath();
      ctx.moveTo(x0, y0 + dy);
      ctx.lineTo(x1, y1 + dy);
      ctx.stroke();
    }
    const steps = Math.max(
      1,
      Math.round(Math.hypot(x1 - x0, y1 - y0) / CELL),
    );
    ctx.fillStyle = "#6e4c30";
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      ctx.fillRect(x, y - 6, 1, 6);
    }
  };

  // Side returns sort at the back; the front rail sorts in front, so props
  // inside the yard stand behind it. The back edge is left open so a rail
  // doesn't cut across the cottage and the trees behind it.
  drawables.push({
    y: backY + 0.05,
    draw: () => {
      rail(left, frontY, left, backY);
      rail(right, frontY, right, backY);
    },
  });
  drawables.push({
    y: frontY + 0.2,
    draw: () => rail(left, frontY, right, frontY),
  });

  {
    const camp = v.encampmentPos();
    const size = spriteSize(ENCAMPMENT);
    // Trail first, at its own baseline so it lies flat under everything.
    drawables.push({
      y: camp.y - size.h - 0.2,
      draw: () => {
        const patch = spriteSize(TRAIL_PATCH);
        for (let i = 0; i < 5; i++) {
          const px = camp.x + Math.round(Math.sin(i * 1.7) * 3) - patch.w / 2;
          drawSprite(
            ctx,
            TRAIL_PATCH,
            Math.round(px),
            camp.y - size.h - 3 - i * 4,
          );
        }
      },
    });
    drawables.push({
      y: camp.y,
      draw: () => {
        drawSprite(
          ctx,
          ENCAMPMENT,
          Math.round(camp.x - size.w / 2),
          camp.y - size.h,
        );
        // Party-away marker sits on the tent itself rather than in a corner.
        const adv = v.save.adventure;
        if (adv) {
          const label = `${adv.partyIds.length}/${adv.roomsCleared}`;
          const lx2 = Math.round(camp.x - textWidth(label) / 2);
          ctx.fillStyle = "#2a1e12";
          ctx.fillRect(lx2 - 2, camp.y - size.h - 8, textWidth(label) + 4, 7);
          drawText(ctx, label, lx2, camp.y - size.h - 7, "#e6a23c");
        }
      },
    });
  }

  if (v.barnAvailable()) {
    const barn = v.barnPos();
    drawables.push({
      y: barn.y,
      draw: () => {
        const frame = BARN_PHASE_SPRITES[v.barnPhase()];
        const size = spriteSize(frame);
        drawSprite(
          ctx,
          frame,
          Math.round(barn.x - size.w / 2),
          barn.y - size.h,
        );
      },
    });
  }

  const cottage = v.cottagePos();
  drawables.push({
    y: cottage.y,
    draw: () => {
      const frame = COTTAGE_PHASE_SPRITES[v.cottagePhase()];
      const size = spriteSize(frame);
      drawSprite(
        ctx,
        frame,
        Math.round(cottage.x - size.w / 2),
        cottage.y - size.h,
      );
    },
  });

  for (const p of v.save.placed ?? []) {
    const map = BUILDABLE_SPRITES[p.id];
    if (!map) continue;
    const foot = grid.footing({ cx: p.cx, cy: p.cy });
    drawables.push({
      y: foot.y,
      draw: () => {
        const size = spriteSize(map);
        drawSprite(
          ctx,
          map,
          Math.round(foot.x - size.w / 2),
          foot.y - size.h,
        );
      },
    });
  }
}
