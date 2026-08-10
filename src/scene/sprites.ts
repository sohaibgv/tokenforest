// Procedural pixel art: sprites are string maps, one char per pixel,
// drawn as 1x1 rects on the low-res canvas. No image assets.

export type PixelMap = string[];

const PALETTE: Record<string, string> = {
  G: "#2e8642", // canopy
  g: "#48a85a", // canopy light
  T: "#6e4c30", // trunk
  t: "#8a6440", // trunk light / rings
  C: "#c9403a", // cap
  s: "#e8b48c", // skin
  R: "#3a6ea5", // shirt
  r: "#2d5680", // shirt shade
  P: "#7a5230", // pants
  b: "#3a2e22", // boots
  A: "#b8bcc4", // axe head
  w: "#8c603a", // axe handle
  K: "#1d2b21", // outline/dark
  Y: "#ffd75e", // golden glow rim
  y: "#fff2b8", // golden glow core
};

// Scoped palette overrides: world themes, cosmetic caps, tree skins.
// Nested calls merge, so a cap color composes with a world palette.
let OVERRIDE: Record<string, string> | null = null;

export function withPalette(
  p: Record<string, string> | null,
  fn: () => void,
): void {
  const prev = OVERRIDE;
  if (p) {
    OVERRIDE = { ...prev, ...p };
  }
  fn();
  OVERRIDE = prev;
}

export function drawSprite(
  ctx: CanvasRenderingContext2D,
  map: PixelMap,
  x: number,
  y: number,
  flip = false,
): void {
  const w = map[0].length;
  for (let row = 0; row < map.length; row++) {
    const line = map[row];
    for (let col = 0; col < line.length; col++) {
      const c = line[col];
      const color = (OVERRIDE && OVERRIDE[c]) || PALETTE[c];
      if (!color) continue;
      ctx.fillStyle = color;
      const px = flip ? w - 1 - col : col;
      ctx.fillRect(x + px, y + row, 1, 1);
    }
  }
}

export function spriteSize(map: PixelMap): { w: number; h: number } {
  return { w: map[0].length, h: map.length };
}

// Small tree: 1 chop.
export const TREE_SM: PixelMap = [
  "..ggg..",
  ".gGGGg.",
  "gGGGGGg",
  "gGGgGGg",
  ".gGGGg.",
  "...T...",
  "...T...",
  "..TTT..",
];

// Medium tree: 3 chops.
export const TREE: PixelMap = [
  "....ggg....",
  "...gGGGg...",
  "..gGGGGGg..",
  ".gGGgGGGGg.",
  ".GGGGGGgGG.",
  "gGGgGGGGGGg",
  "gGGGGGgGGGg",
  ".GGgGGGGGG.",
  "..gGGGGGg..",
  "...gGGg....",
  "....TT.....",
  "....TT.....",
  "....TT.....",
  "...TTTT....",
];

export const TREE_SMALL: PixelMap = [
  "..ggg..",
  ".gGGGg.",
  "gGGGGGg",
  ".gGGGg.",
  "...T...",
  "...T...",
];

// Large tree: 5 chops.
export const TREE_LG: PixelMap = [
  ".....ggg.....",
  "....gGGGg....",
  "...gGGGGGg...",
  "...GGgGGGG...",
  "..gGGGGGgGg..",
  "..GGgGGGGGG..",
  ".gGGGGgGGGGg.",
  ".GGgGGGGGgGG.",
  ".gGGGGGGGGGg.",
  "..GGgGGGGGG..",
  "..gGGGGGgGg..",
  "...gGGGGGg...",
  "....gGGg.....",
  ".....TT......",
  ".....TT......",
  ".....TT......",
  ".....TT......",
  "....TTTT.....",
];

// The elder: 30 chops, one per plot, always felled last.
export const TREE_ELDER: PixelMap = [
  "......ggggggg......",
  "....ggGGGGGGGgg....",
  "...gGGgGGGGGgGGg...",
  "..gGGGGGGgGGGGGGg..",
  ".gGGgGGGGGGGGgGGGg.",
  ".GGGGGGgGGGGGGGGGG.",
  "gGGgGGGGGGgGGGGgGGg",
  "gGGGGGGgGGGGGGGGGGg",
  ".GGgGGGGGGGGgGGGGG.",
  ".gGGGGGgGGGGGGGgGg.",
  "..gGGGGGGgGGGGGg...",
  "...gGGgGGGGGgGG....",
  "....ggGGGGGgg......",
  "......ggggg........",
  ".......TTtTT.......",
  ".......TTtTT.......",
  ".......TTtTT.......",
  ".......TTtTT.......",
  ".......TTtTT.......",
  "......TTTtTTT......",
  ".....TTTTTTTTT.....",
];

export const STUMP: PixelMap = [
  ".tTTt.",
  "TTtTTT",
  ".TTTT.",
];

export const STUMP_LG: PixelMap = [
  ".tTTTTt.",
  "TTtTTTTT",
  ".TTTTTT.",
];

export const STUMP_XL: PixelMap = [
  "..tTTTTTTt..",
  ".TTtTTTTtTT.",
  "TTTTtTTTTTTT",
  ".TTTTTTTTTT.",
];

// Woodcutter, 10 wide. Facing right; drawSprite flips for left.
export const WC_STAND: PixelMap = [
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..RRRR..w.",
  "..rRRr.w..",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];

export const WC_WALK1: PixelMap = [
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..RRRR..w.",
  "..rRRr.w..",
  "..P..P....",
  ".P....P...",
  ".b....b...",
];

export const WC_WALK2: PixelMap = [
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..RRRR..w.",
  "..rRRr.w..",
  "...PP.....",
  "...PP.....",
  "...bb.....",
];

export const WC_CHOP_UP: PixelMap = [
  "......A...",
  "...CC.AA..",
  "...ss.w...",
  "..RRRRw...",
  "..RRRw....",
  "..rRRr....",
  "..P..P....",
  "..b..b....",
];

export const WC_CHOP_DOWN: PixelMap = [
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..RRRwwAA.",
  "..rRRr.AA.",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];

export const WC_SIT: PixelMap = [
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..rRRr....",
  "..PPPP....",
  "..b..b....",
];

// Manual-swing slash frames, 0-focus spark, golden spot glow, amber gem.
export const SLASH1: PixelMap = [
  "....A",
  "...A.",
  "..A..",
  ".A...",
  "A....",
];

export const SLASH2: PixelMap = [
  "A...A",
  ".A.A.",
  "..A..",
  ".A.A.",
  "A...A",
];

export const SPARK: PixelMap = [
  ".A.",
  "AtA",
  ".A.",
];

export const GLOW_SM: PixelMap = [
  ".Y.",
  "YyY",
  ".Y.",
];

export const GLOW_LG: PixelMap = [
  "..Y..",
  ".YyY.",
  "YyyyY",
  ".YyY.",
  "..Y..",
];

export const AMBER_GEM: PixelMap = [
  ".Y..",
  "YyY.",
  ".YY.",
  "..Y.",
];

// Wood-log icon for the HUD counter.
export const LOG: PixelMap = [
  ".tttttt.",
  "tTTtTTTt",
  "tTTtTTTt",
  ".tttttt.",
];

// 3x5 bitmap font for crisp labels at pixel scale.
const FONT: Record<string, string[]> = {
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", "###", "..#", "###"],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"],
  "-": ["...", "...", "###", "...", "..."],
  "+": ["...", ".#.", "###", ".#.", "..."],
  ".": ["...", "...", "...", "...", ".#."],
  k: ["#..", "#.#", "##.", "#.#", "#.#"],
  M: ["#.#", "###", "#.#", "#.#", "#.#"],
  x: ["...", "#.#", ".#.", "#.#", "..."],
  " ": ["...", "...", "...", "...", "..."],
};

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.fillStyle = color;
  let cx = x;
  for (const ch of text) {
    const glyph = FONT[ch];
    if (!glyph) {
      cx += 4;
      continue;
    }
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row][col] === "#") {
          ctx.fillRect(cx + col, y + row, 1, 1);
        }
      }
    }
    cx += 4;
  }
}

export function textWidth(text: string): number {
  return text.length * 4 - 1;
}
