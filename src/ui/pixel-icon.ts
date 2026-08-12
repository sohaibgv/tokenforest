// Shared cached-raster icon pipeline: draws a PixelMap once onto a
// throwaway offscreen canvas via sprites.ts's existing, unmodified
// drawSprite/withPalette, reads it back as a data: URL, and caches the
// result. Every subsequent call for the same (map, palette) pair is a
// cache lookup, not a redraw — Team/Gacha panels rebuild on a 1s refresh
// timer, so this matters at instance count.

import { drawSprite, spriteSize, withPalette, type PixelMap } from "../scene/sprites";

// Outer key: the PixelMap's own object identity (every icon is a
// module-level const, so identity is stable and free to key off of).
// Inner key: a stringified palette signature, so the same shape drawn with
// different recolors (per-rarity, per-world, per-context tint) caches
// distinctly instead of colliding on one shared URL.
const urlCache = new WeakMap<PixelMap, Map<string, string>>();

export function pixelIconUrl(map: PixelMap, palette?: Record<string, string>): string {
  const sig = JSON.stringify(palette ?? {});
  let byPalette = urlCache.get(map);
  if (!byPalette) {
    byPalette = new Map();
    urlCache.set(map, byPalette);
  }
  const cached = byPalette.get(sig);
  if (cached) return cached;

  const { w, h } = spriteSize(map);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  withPalette(palette ?? null, () => {
    drawSprite(ctx, map, 0, 0);
  });
  const url = canvas.toDataURL("image/png");
  byPalette.set(sig, url);
  return url;
}

export function pixelIcon(
  map: PixelMap,
  opts?: { palette?: Record<string, string>; scale?: number; className?: string },
): HTMLImageElement {
  const { w, h } = spriteSize(map);
  const scale = opts?.scale ?? 1;
  const img = document.createElement("img");
  img.src = pixelIconUrl(map, opts?.palette);
  img.width = w * scale;
  img.height = h * scale;
  img.className = opts?.className ? `pixel-icon ${opts.className}` : "pixel-icon";
  return img;
}

// --- Composite icons (multi-layer, e.g. body + separately hand-anchored
// held weapon) -------------------------------------------------------------
//
// pixelIconUrl/pixelIcon above only ever draw ONE (map, palette) pair at
// (0, 0) — fine for every plain glyph, but Team roster portraits (Part C.2)
// need a worker's body sprite AND its held weapon (weapons.ts's
// drawHeldWeapon, Part D) composited onto ONE flattened icon, and the
// weapon's own position isn't a simple (map, palette) pair — it's computed
// via drawHeldWeapon's hand-anchor/grip math, which already knows how to
// call drawSprite/withPalette itself. Rather than duplicate that
// positioning math here as a declarative layer list, this takes a plain
// draw callback and lets the caller (and whatever positioning helper it
// calls, e.g. drawHeldWeapon) own the ctx directly — this module still owns
// the shared canvas + the cache, exactly like pixelIconUrl does above.
const compositeCache = new Map<string, string>();

export function pixelIconCompositeUrl(
  key: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
): string {
  const cached = compositeCache.get(key);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  draw(ctx);
  const url = canvas.toDataURL("image/png");
  compositeCache.set(key, url);
  return url;
}

export function pixelIconComposite(
  key: string,
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D) => void,
  opts?: { scale?: number; className?: string },
): HTMLImageElement {
  const scale = opts?.scale ?? 1;
  const img = document.createElement("img");
  img.src = pixelIconCompositeUrl(key, width, height, draw);
  img.width = width * scale;
  img.height = height * scale;
  img.className = opts?.className ? `pixel-icon ${opts.className}` : "pixel-icon";
  return img;
}
