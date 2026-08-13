// The merge animation.
//
// Four workers dissolve into light, the light converges on the fifth, and the
// fifth comes back brighter. About 1.4 seconds, and SKIPPABLE BY A CLICK —
// this is a thing players will watch hundreds of times, and an unskippable
// flourish stops being a reward on roughly the fourth viewing.
//
// Built out of what already exists rather than a new effects system:
//
//   - the sparkle chips are ui/case-opening.ts's spawnSparkles pattern with
//     the vectors inverted (that one scatters outward from a revealed card;
//     this one falls inward toward the pedestal),
//   - the white flash is `.flash-pulse`, the house idiom for "state changed",
//   - the shake is a DOM transform on the panel. The brief asked for a canvas
//     camera shake, but the roster is DOM and the canvas is behind the shop
//     overlay and not visible while this plays — shaking it would be a shake
//     nobody sees.
//
// The commit fires at the moment of impact, not at the end, so a player who
// clicks through never waits on the animation to get their worker.

import type { FusionPlan } from "../fusion";
import { playSfx } from "../sfx";

/** Sparkles per sacrifice. Enough to read as a stream, few enough that four
 * of them at once stay under a hundred nodes on a tray-sized window. */
const TRAIL_PER_SOCKET = 10;
const CHARGE_MS = 620;
const IMPACT_MS = 420;

function centreOf(el: Element, origin: DOMRect): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 - origin.left, y: r.top + r.height / 2 - origin.top };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs the sequence over an already-rendered altar panel.
 *
 * `commit` is invoked exactly once, at impact, whether or not the animation
 * was skipped — the merge is not allowed to depend on the flourish completing.
 */
export async function playFusion(
  panel: HTMLElement,
  plan: FusionPlan,
  commit: () => void,
): Promise<void> {
  const pedestal = panel.querySelector<HTMLElement>(".fusion-pedestal");
  const target = panel.querySelector<HTMLElement>(".fusion-socket-target");
  if (!pedestal || !target) {
    commit();
    return;
  }

  let skipped = false;
  const skip = (): void => {
    skipped = true;
  };
  panel.addEventListener("click", skip, { once: true });
  panel.classList.add("fusing");

  const origin = pedestal.getBoundingClientRect();
  const dest = centreOf(target, origin);
  const layer = document.createElement("div");
  layer.className = "fusion-fx-layer";
  pedestal.append(layer);

  const rarityClass = `fusion-spark-${plan.toRarity}`;
  const sockets = [...panel.querySelectorAll<HTMLElement>(".fusion-socket-sacrifice.filled")];

  playSfx("fusionCharge");
  for (const s of sockets) s.classList.add("dissolving");

  // Each sacrifice throws a stream of chips at the centre. The chips are
  // positioned at the socket and animated to the pedestal's middle with the
  // same --dx/--dy custom-property trick the gacha sparkles use, so the
  // keyframes stay static and only the vector is per-chip.
  for (const s of sockets) {
    const from = centreOf(s, origin);
    for (let i = 0; i < TRAIL_PER_SOCKET; i++) {
      const chip = document.createElement("span");
      chip.className = `fusion-spark ${rarityClass}`;
      // A little scatter on the launch point, so ten chips read as a stream
      // rather than one thick line.
      const jitterX = (i % 5) * 3 - 6;
      const jitterY = (i % 3) * 3 - 3;
      chip.style.left = `${from.x + jitterX}px`;
      chip.style.top = `${from.y + jitterY}px`;
      chip.style.setProperty("--dx", `${dest.x - from.x - jitterX}px`);
      chip.style.setProperty("--dy", `${dest.y - from.y - jitterY}px`);
      chip.style.animationDelay = `${i * 26}ms`;
      layer.append(chip);
    }
  }

  if (!skipped) await sleep(CHARGE_MS);

  // Impact. Commit here so the save is written at the beat the player reads
  // as "it happened".
  commit();
  playSfx("fusionBurst", { rarity: plan.toRarity });
  target.classList.add("flash-pulse", "fusion-impact");
  panel.classList.add("fusion-shake");

  if (!skipped) await sleep(IMPACT_MS);

  panel.removeEventListener("click", skip);
  panel.classList.remove("fusing", "fusion-shake");
  layer.remove();
}
