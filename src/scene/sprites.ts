// Procedural pixel art: sprites are string maps, one char per pixel,
// drawn as 1x1 rects on the low-res canvas. No image assets.

// Type-only, so it erases at build time. economy.ts has no imports of its own,
// so this cannot form a cycle.
import type { CosmeticId } from "../economy";

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
  A: "#b8bcc4", // manual-swing slash/spark accent (SLASH1/SLASH2/SPARK) — no
  // longer the axe head; that's `D` in weapons.ts since Part D
  w: "#8c603a", // axe handle
  K: "#1d2b21", // outline/dark
  Y: "#ffd75e", // golden glow rim
  y: "#fff2b8", // golden glow core
  N: "#3ab6a0", // rare scarf
  H: "#5a3a7a", // epic hood
  h: "#42295c", // epic hood shade
  // --- Weapon visual identity (Part D) ---
  D: "#aab0ba", // weapon steel base — cool gray-blue, distinct from warm `w`
  d: "#767c88", // weapon steel shade
  Q: "#b8874a", // utility charm frame — warm bronze/pewter
  q: "#8a6535", // utility charm frame shade
  // --- Protestor (Adventure enemy) ---
  V: "#5c6b3a", // vest
  v: "#414c2a", // vest shade
  U: "#c2703a", // bandana/headwear — identity color, never world-tinted
  I: "#7a5a34", // sign post
  W: "#ece7d6", // sign face
  Z: "#c9403a", // sign "no" ring + slash
  X: "#242322", // sign glyph ink
  // --- Scientist (Adventure enemy) ---
  L: "#e6e8e2", // lab coat — never world-tinted
  l: "#c7cabe", // lab coat shade
  J: "#33312c", // goggle frame
  E: "#7fe6df", // goggle lens / tech glow
  M: "#4a3628", // hair — per-character override
  O: "#bff6ff", // data-beam core
  o: "#2a86a8", // data-beam edge
  F: "#e85ee0", // glitch chromatic-aberration fringe
  // --- Mayor (Adventure enemy) ---
  S: "#38415c", // suit — per-character accent, never world-tinted (each
  // MAYOR_CHARACTERS entry overrides this, same role as protestor `U`/
  // scientist `M`)
  n: "#262c40", // suit shade
  B: "#d4af37", // ceremonial sash — fixed kind signature, never world- OR
  // character-tinted (no accent overrides it, no workerPalette entry
  // targets it), same "always this exact color" role as the lab coat `L`
  // --- Cache Koi (lake mechanic, see scene/lake.ts / Game koi fields) ---
  // --- Environmental resource props (Iteration 5) ---
  e: "#8a8f98", // whetstone grinding wheel — overridden per-frame with the
  // focus heat ramp (economy.ts focusHeatColor), so this is only the "cold"
  // resting tone; kept distinct from weapon steel `D` so heating the wheel
  // never accidentally recolors a held axe.
  a: "#cfe4ee", // lantern glass pane — pale and cool so the warm amber fill
  // drawn over it (a plain fillRect, see Game.drawLantern) reads clearly.
  // --- The Timber Line (rail travel between worlds) ---
  m: "#5a6472", // bridge-wright's work overalls. Deliberately NOT `R`/`r` (the
  // woodcutter shirt) and NOT `V`/`v` (the protestor vest): every world's
  // workerPalette re-tints all four, and the wright should look like the same
  // person wherever you meet him — he travels the line, he isn't local to a
  // world. His hard hat reuses `U`, which carries the same never-tinted
  // guarantee for the protestor's bandana.
  j: "#ff8a2b", // safety orange — the hard hat. Its own letter rather than
  // the protestor's `U` bandana, which is a duller burnt orange and belongs
  // to a different character; a hard hat wants to be the brightest thing on
  // the person wearing it.
  z: "#e8e04a", // hi-vis. The single most legible "this person works on a
  // construction site" signal there is, and nothing else in the world uses
  // it — which is the point: the foreman has to be identifiable at 10px
  // among a crowd of woodcutters in world-tinted shirts.
  f: "#5d6b4a", // fisher's oilskin — weathered olive. Its own letter rather
  // than the woodcutter shirt `R` or the protestor vest `V` because both of
  // those are re-tinted by every world's workerPalette, and a travelling
  // character should look like the same person wherever you meet him.
  i: "#e8823a", // koi body — warm orange, distinct from every world's water
  // palette so it always reads clearly against the lake. Its tail/fin glow
  // and catch-ripple both deliberately reuse `O`/`o` (the scientist's
  // data-beam colors) rather than new letters — "cache" reuse visually
  // rhymes with data/tech, and it's the same "reuse an existing accent
  // color for a thematically-related new asset" move already used
  // elsewhere (vengefulSpirit's boon icon reusing SPARK verbatim).
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

// Sap Press: a physical world object sitting at the forest's edge (see
// Game's sapPress field/handleClick) — click the lever to squeeze wood into
// amber, replacing the old flat Boosts-tab shop card. Two frames (idle
// lever raised, pressed lever pushed flat with an amber drip at the spout)
// swap during a short press animation, same "small map, own palette,
// timed frame-swap" trick TREE_SM's fall/STUMP already use.
// Two frames that actually differ below the lever. Previously rows 3-10 were
// byte-identical between them, so the only motion was a 3px lever and one drip
// pixel — the press read as a static box. Now the screw plate visibly drives
// down into the barrel, the barrel staves compress, and sap runs from the
// spout, so a press looks like something being crushed.
export const SAP_PRESS_IDLE: PixelMap = [
  ".....ww..",
  "....ww...",
  "...ww....",
  "..K....K.",
  "..KKKKKK.",
  ".KQQQQQQK",
  ".KqttttqK",
  ".KqttttqK",
  ".KqttttqK",
  ".KKKKKKKK",
  "..K.KK.K.",
];

export const SAP_PRESS_DOWN: PixelMap = [
  ".........",
  ".........",
  "..wwwwww.",
  "..K....K.",
  "..KKKKKK.",
  ".KQQQQQQK",
  ".KQQQQQQK",
  ".KqttttqK",
  ".KqttttqK",
  ".KKKKKKKK",
  "..K.yy.K.",
];

// --- Environmental resource props ------------------------------------------
//
// The three props that replaced the old top-left canvas HUD (wood / amber /
// focus). Each is a physical object standing in the clearing rather than a
// readout floating over it — see Game.drawLogStack/drawLantern/drawWhetstone.

// One log seen end-on. The Log Stack is NOT three static pile sprites: it
// stamps this single map in a pyramid, count driven by economy.ts's
// logStackTier(), so the pile visibly grows log-by-log instead of snapping
// between silhouettes.
// One log seen end-on. Three tones rather than two: a dark bark rim (`K`), the
// pale sapwood face (`t`), and a heartwood ring (`T`) offset up-left so every
// log in the pile catches light from the same direction. The old two-tone
// version read as a flat brown smudge — at 4x3 there simply isn't enough
// contrast to suggest a cylinder without a real outline.
// Lit from above: pale sapwood along the top edge, heartwood through the
// middle, dark bark shadow underneath. A FULL dark rim was tried first and is
// wrong at this size — 4x3 leaves only two pixels for the face, so the outline
// swallows the log and a stack of them reads as a dark chain rather than wood.
export const LOG_END: PixelMap = [
  ".tt.",
  "tTtt",
  "tTTt",
  ".KK.",
];

// Retaining stake — a pair bracket the Log Cord tier so a tall pile reads as
// stacked cordwood rather than a loose heap. Two tones so it reads as a post
// rather than a 1px scratch.
export const LOG_STAKE: PixelMap = ["Kt", "Kt", "Kt", "Kt", "Kt", "Kt", "KK"];

// Whetstone: the Focus meter's fixed home. Focus needs a prop that is always
// on screen — the axe-blade heat alone would vanish whenever the woodcutters
// despawn (which is most of an idle game, see Game.applySnapshot), and the
// exact count has to stay readable at all times.
export const WHETSTONE: PixelMap = [
  "...eeeee.Q.",
  "..eeeeeeeQ.",
  ".eeeKKKeeQ.",
  ".eeKKKKKee.",
  ".eeeKKKeee.",
  "..eeeeeee..",
  "...eeeee...",
  "..w.....w..",
  ".ww.....ww.",
  "TTTTTTTTTTT",
  "KKKKKKKKKKK",
];

// Shepherd's-crook post the amber Lantern hangs from. `K` marks the hook
// pixel; LANTERN_HOOK below records its coordinates so the lantern's position
// is derived from the art rather than re-guessed at the call site.
export const LANTERN_POST: PixelMap = [
  "..TTTTTT.",
  "..T.....K",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  "..T......",
  ".TTTTT...",
  "TTTTTTT..",
];

/** The hook pixel (`K`) in LANTERN_POST's own local coords. */
export const LANTERN_HOOK = { x: 8, y: 1 };

// Brass lantern housing. The interior (`a` glass, cols 1-3 / rows 2-5) is
// deliberately hollow so the amber level can be painted over it bottom-up as
// a plain fillRect scaled by amber / amberLanternFull().
export const LANTERN_FRAME: PixelMap = [
  "..q..",
  ".QQQ.",
  "QaaaQ",
  "QaaaQ",
  "QaaaQ",
  "QaaaQ",
  ".QQQ.",
];

/** Interior rect of LANTERN_FRAME, in the frame's own local pixel coords —
 * kept beside the map so the two can't drift apart. */
export const LANTERN_GLASS = { x: 1, y: 2, w: 3, h: 4 };

// Crossroads Signpost: the in-world entrance to Settings, standing in the
// clearing instead of a gear button floating over the art. Three carved
// arrow-boards on a post, pointing off toward the things settings reach.
// Two frames give it a slow idle sway so it reads as interactive.
export const SIGNPOST_IDLE: PixelMap = [
  ".wwwwwww..",
  ".wKKKKKw..",
  ".wwwwwww..",
  "....TT....",
  "..wwwwwww.",
  "..wKKKKKw.",
  "..wwwwwww.",
  "....TT....",
  ".wwwwwww..",
  ".wKKKKKw..",
  ".wwwwwww..",
  "....TT....",
  "....TT....",
  "....TT....",
  "...tTTt...",
  "..KKKKKK..",
];

export const SIGNPOST_SWAY: PixelMap = [
  "..wwwwwww.",
  "..wKKKKKw.",
  "..wwwwwww.",
  "....TT....",
  ".wwwwwww..",
  ".wKKKKKw..",
  ".wwwwwww..",
  "....TT....",
  "..wwwwwww.",
  "..wKKKKKw.",
  "..wwwwwww.",
  "....TT....",
  "....TT....",
  "....TT....",
  "...tTTt...",
  "..KKKKKK..",
];

// Log-flume raft, moored at the lake's near bank — the in-world replacement
// for the flat "Travel to …" pill that used to float over the canvas. Lashed
// logs with a steering pole; the "tied" frame shows the mooring rope still
// knotted, which is how an unaffordable or gate-locked crossing reads.
export const RAFT_TIED: PixelMap = [
  ".....w.....",
  ".....w.....",
  "TtTtTtTtTtT",
  "TtTtTtTtTtT",
  ".KKKKKKKKK.",
];

export const RAFT_READY: PixelMap = [
  ".......w...",
  "......w....",
  "TtTtTtTtTtT",
  "TtTtTtTtTtT",
  "...........",
];

/** Mooring post on the bank; the rope loops to it while travel is locked. */
export const MOORING_POST: PixelMap = ["T", "T", "T", "T", "T", "T", "T"];

// Brass gramophone on a stump — the audio controls. The crank is a separate
// 4-frame layer so it can spin with the volume, and the tone-arm has an
// up/down pair for the muted/unmuted read.
export const GRAMOPHONE_BODY: PixelMap = [
  "...QQQQq...",
  "..QqqqqqQ..",
  ".QqqQQQqqQ.",
  ".QqqQQQqqQ.",
  "..QqqqqqQ..",
  "...QQQQq...",
  "....TTT....",
  "...TTTTT...",
  "..TTTTTTT..",
  "..TTTTTTT..",
];

export const GRAMO_ARM_DOWN: PixelMap = ["KK.", ".KK", "..K"];
export const GRAMO_ARM_UP: PixelMap = ["..K", ".KK", "KK."];

/** Four crank rotations; the drawn frame follows the current volume. */
export const GRAMO_CRANK: PixelMap[] = [
  [".Y.", "YQY", ".Y."],
  ["Y..", "YQY", "..Y"],
  [".Y.", "YQY", ".Y."],
  ["..Y", "YQY", "Y.."],
];

// --- Homestead ---------------------------------------------------------------
//
// The cottage builds in three visible stages, so progress reads at a glance
// from across the clearing: stakes and a footing, then framed walls, then a
// finished roof with a lit window and a chimney.

/** Phase 0 — the bare site: corner stakes and a string line. */
export const COTTAGE_SITE: PixelMap = [
  "T.........T",
  "T.........T",
  "T.........T",
  "ttttttttttt",
];

/** Phase 1 — foundation laid, floor beams down. */
export const COTTAGE_P1: PixelMap = [
  "T.........T",
  "T.........T",
  "TtttttttttT",
  "TTTTTTTTTTT",
  "ttttttttttt",
];

/** Phase 2 — walls framed up, doorway cut, still open to the sky. */
export const COTTAGE_P2: PixelMap = [
  "T.........T",
  "TwwwwwwwwwT",
  "TwKKwwwKKwT",
  "TwKKwwwKKwT",
  "TwwwwKKKwwT",
  "TwwwwKKKwwT",
  "TTTTTTTTTTT",
  "ttttttttttt",
];

/** Phase 3 — finished: pitched roof, chimney, lit window, front door. */
export const COTTAGE_P3: PixelMap = [
  "....K......",
  "....C......",
  "...TTTTT...",
  "..TTTTTTT..",
  ".TTTTTTTTT.",
  "TTTTTTTTTTT",
  "tKKKKKKKKKt",
  "TwKYYKwKKwT",
  "TwKYYKwKKwT",
  "TwwwwwwKKwT",
  "TKKKKKKKKKT",
  "ttttttttttt",
];

/** Road heading off the LEFT edge — the way back to a world you've already
 * cleared. Worn ruts between grass verges, drawn as a horizontal run. */
/* ── The Timber Line ──────────────────────────────────────────────────────
   Travel between worlds used to be two unrelated objects at opposite screen
   edges — a stub of dirt road with a tiny signpost on the left, a 9px plank
   bridge on the right — that shared no visual language and so never read as
   "the two ends of one route".
   They are now one narrow-gauge logging railway running along the back of
   the clearing: a halt with a handcar at the left end, and a timber trestle
   over the ravine at the right end that a bridge-wright rebuilds for you.
   Paying WOOD to rebuild a TIMBER trestle also makes the travel cost make
   sense in-world, rather than reading as an abstract toll. */

/** Track, tiled horizontally. Sleepers between two steel rails — the two
 * long unbroken lines are what make it read as track at a glance rather
 * than as a fence lying down. */
export const RAIL_TILE: PixelMap = [
  "T..T..T.",
  "DDDDDDDD",
  "T..T..T.",
  "DDDDDDDD",
  "t..t..t.",
];

/** Loading platform at the halt — a plank deck on stub posts. */
export const PLATFORM: PixelMap = [
  "wwwwwwwwwwwwww",
  "tttttttttttttt",
  "TTTTTTTTTTTTTT",
  "K.K........K.K",
  "K.K........K.K",
  "KKK........KKK",
];

/** Departures board on its post. The "writing" is deliberately illegible
 * texture — the real destination list is the dialogue board that opens on
 * click (see scene/dialogue.ts), and fake readable text on the prop would
 * compete with it. */
export const DEPARTURE_BOARD: PixelMap = [
  "IIIIIIIIIIIII",
  "IWWWWWWWWWWWI",
  "IWXXXWXXXXWWI",
  "IWWWWWWWWWWWI",
  "IWXXWXXXWXXWI",
  "IWWWWWWWWWWWI",
  "IWXXXXWXXWWWI",
  "IIIIIIIIIIIII",
  "......I......",
  "......I......",
  "......I......",
  ".....III.....",
];

/** Handcar — the pump trolley you ride back down the line. Two frames: the
 * see-saw beam rocks between them, which is the whole reason it reads as a
 * vehicle you work rather than a crate on wheels. */
export const HANDCAR_UP: PixelMap = [
  ".......DD..",
  "....DDDD...",
  "....D......",
  "....D......",
  "wwwwwwwwwww",
  "ttttttttttt",
  "K.........K",
  ".KK.....KK.",
  ".KK.....KK.",
];

export const HANDCAR_DOWN: PixelMap = [
  "..DD.......",
  "...DDDD....",
  "......D....",
  "......D....",
  "wwwwwwwwwww",
  "ttttttttttt",
  "K.........K",
  ".KK.....KK.",
  ".KK.....KK.",
];

/** One X-braced timber bent (the vertical support a trestle stands on).
 * Repeated across the ravine — a row of these receding is what says
 * "trestle" rather than "footbridge". */
export const TRESTLE_BENT: PixelMap = [
  "T.....T",
  "T.....T",
  "TT...TT",
  ".T...T.",
  ".TT.TT.",
  "..TTT..",
  ".TT.TT.",
  ".T...T.",
  "TT...TT",
  "KKKKKKK",
];

/** Deck + rail segment laid across the bents, tiled horizontally. */
export const TRESTLE_DECK: PixelMap = [
  "DDDDDDDD",
  "wwwwwwww",
  "tttttttt",
  "TTTTTTTT",
];

/** The ragged end of the deck where the span gave way. Drawn once at the
 * break so a missing span reads as damage rather than as unfinished art. */
export const TRESTLE_BREAK: PixelMap = [
  "DD......",
  "ww......",
  "tt.t....",
  "TT......",
];

/* ── The cast ─────────────────────────────────────────────────────────────
   All three are built on WC_STAND's proportions (the same head / body / leg
   row split) so they read as the same species of person as your woodcutters,
   each distinguished by silhouette and by palette letters that no world
   re-tints. */

/** The foreman: white hard hat, hi-vis over slate work clothes, hammer. He
 * used to be a generic "bridge-wright" in plain overalls; the hi-vis is what
 * makes him legible as a CONSTRUCTION man at 10px, which is the read his
 * whole rate-card routine depends on. */
export const FOREMAN_IDLE: PixelMap = [
  "....jjj....",
  "...jjjjj...",
  "....ss.....",
  "...zzzzz...",
  "...zWWWz...",
  "...zzzzz.D.",
  "....mmm..w.",
  "....m.m..w.",
  "....b.b....",
  "...bb.bb...",
];

export const FOREMAN_HAMMER_UP: PixelMap = [
  "....jjj..D.",
  "...jjjjj.w.",
  "....ss...w.",
  "...zzzzzw..",
  "...zWWWz...",
  "...zzzzz...",
  "....mmm....",
  "....m.m....",
  "....b.b....",
  "...bb.bb...",
];

export const FOREMAN_HAMMER_DOWN: PixelMap = [
  "....jjj....",
  "...jjjjj...",
  "....ss.....",
  "...zzzzz...",
  "...zWWWz...",
  "...zzzzz.w.",
  "....mmm..w.",
  "....m.m.DD.",
  "....b.b....",
  "...bb.bb...",
];

/** The fisher, SEATED on the shore — the one character who isn't standing,
 * which is most of what makes him readable as a different person from across
 * the plot. The rod angles up and to the right; the line itself is drawn
 * procedurally out to the water (see Game.drawFisherLine) so it always
 * reaches the lake wherever the lake happens to be on this plot. */
export const FISHER_IDLE: PixelMap = [
  "..CCC.......",
  "..CsC.......",
  "...ss....w..",
  "..ffff..w...",
  "..ffff.w....",
  "..ffPP......",
  "...PPP......",
  "...bb.......",
];

/** A bite: the rod whips down and the brim tips up. */
export const FISHER_TUG: PixelMap = [
  "..CCC.......",
  "..CsC.......",
  "...ss...w...",
  "..ffff.w....",
  "..ffffw.....",
  "..ffPP......",
  "...PPP......",
  "...bb.......",
];

/** The quartermaster: dark cap, bronze bandolier over slate, ledger in hand.
 * The ledger is the tell — he is the one who writes your people down. */
export const QUARTERMASTER_IDLE: PixelMap = [
  "..KKKK....",
  "...ss.....",
  "..QmmQ.WW.",
  "..mmmm.WX.",
  "..QmmQ.WW.",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];

/** Adventure encampment: a canvas tent with a banner and a campfire, standing
 * at the mouth of a trail leading off into the trees. Adventuring used to be
 * reachable only via a small gold badge in the corner, which said nothing about
 * what it was — this makes "you set out from here" a place on the map. */
export const ENCAMPMENT: PixelMap = [
  "......Z......",
  "......I......",
  ".....III.....",
  "....WWIWW....",
  "...WWWIWWW...",
  "..WWWWIWWWW..",
  ".WWWWWIWWWWW.",
  "WWWWWWIWWWWWW",
  "WWWWKKKKKWWWW",
  "WWWKKKKKKKWWW",
  "KKKKKKKKKKKKK",
];

/** A worn trail of dirt patches, tiled toward the treeline behind the camp. */
export const TRAIL_PATCH: PixelMap = [
  ".TT.",
  "TttT",
];

/** Barn — wider and plainer than the cottage, with big doors. */
export const BARN_SITE: PixelMap = [
  "T...........T",
  "T...........T",
  "ttttttttttttt",
];

/* Phase 1 is the raised TIMBER FRAME, and it has to read as one. The
   previous version was corner posts plus a top and bottom plate with a
   hollow middle, which at this size just drew a rectangle outline — on the
   yard it looked like a mis-rendered box rather than a building underway.
   A centre post and a pair of angled corner braces are what actually say
   "frame": they're the members a real frame needs and the eye recognises
   the shape immediately. Same 13x7 footprint as before, so nothing in the
   yard layout shifts. */
export const BARN_P1: PixelMap = [
  "T...........T",
  "TTTTTTTTTTTTT",
  "Tw....w....wT",
  "T.w...w...w.T",
  "T..w..w..w..T",
  "TTTTTTTTTTTTT",
  "ttttttttttttt",
];

export const BARN_P2: PixelMap = [
  "......C......",
  "...TTTTTTT...",
  ".TTTTTTTTTTT.",
  "TTTTTTTTTTTTT",
  "TwwwwwwwwwwwT",
  "Twwww.K.wwwwT",
  "TwwwwKKKwwwwT",
  "TwwwwKKKwwwwT",
  "TTTTTTTTTTTTT",
  "ttttttttttttt",
];

export const BARN_PHASE_SPRITES: PixelMap[] = [BARN_SITE, BARN_P1, BARN_P2];

export const COTTAGE_PHASE_SPRITES: PixelMap[] = [
  COTTAGE_SITE,
  COTTAGE_P1,
  COTTAGE_P2,
  COTTAGE_P3,
];

/** Yard fence post + rail, tiled along the homestead boundary. */
export const FENCE_POST: PixelMap = ["T", "T", "T", "T"];
export const FENCE_RAIL: PixelMap = ["ttttttttttt", "...........", "ttttttttttt"];

// --- Buildables (bought in the shop, placed on grid cells) -------------------

export const BUILD_FLOWERBED: PixelMap = [
  ".C.y.C.",
  "yCyCyCy",
  "GGGGGGG",
  "TTTTTTT",
];

export const BUILD_BENCH: PixelMap = [
  "ttttttt",
  "TTTTTTT",
  "T.....T",
  "T.....T",
];

export const BUILD_LAMPPOST: PixelMap = [
  ".QQQ.",
  "QYYYQ",
  "QYyYQ",
  "QYYYQ",
  ".QQQ.",
  "..T..",
  "..T..",
  "..T..",
  ".TTT.",
];

export const BUILD_SCARECROW: PixelMap = [
  "..yyy..",
  ".yssssy",
  "..yyy..",
  "TTTTTTT",
  "..RRR..",
  "..RRR..",
  "...T...",
  "...T...",
];

export const BUILD_WELL: PixelMap = [
  "T.......T",
  "T.ttttt.T",
  "TtttttttT",
  ".AAAAAAA.",
  ".AoooooA.",
  ".AAAAAAA.",
  ".AAAAAAA.",
];

export const BUILDABLE_SPRITES: Record<string, PixelMap> = {
  flowerbed: BUILD_FLOWERBED,
  bench: BUILD_BENCH,
  lamppost: BUILD_LAMPPOST,
  scarecrow: BUILD_SCARECROW,
  well: BUILD_WELL,
};

// --- Cosmetic item icons ---------------------------------------------------
//
// The shop's Style tab used to preview a cap by drawing an ENTIRE woodcutter
// wearing it, and a tree skin by drawing an entire tree. That buries the thing
// you're actually buying: a cap is 2 pixels of `C` in WC_STAND's top row, so
// 90% of the icon was irrelevant body, and Silver Birch (a trunk-only recolor)
// previewed with a full green canopy that the skin never touches.
//
// These are standalone item portraits instead — just the object, at a size
// where it actually reads. They live here rather than ui-icons.ts because
// UI_PALETTE rebinds `C` to a pale cream, which would fight the cap's dye.

/** A flat cap in profile: dome (`C`, the dyed pixels) over a dark brim. */
export const CAP_ICON: PixelMap = [
  "..CCCC....",
  ".CCCCCC...",
  "CCCCCCCC..",
  "CCCCCCCC..",
  "KKKKKKKKKK",
];

/** A length of birch timber — pale bark (`t`) with darker lenticel dashes
 * (`T`), the two letters a trunk skin actually recolors. */
export const TRUNK_ICON: PixelMap = [
  ".ttt.",
  "ttttt",
  "tTTtt",
  "ttttt",
  "tttTT",
  "ttttt",
  "TTttt",
  "ttttt",
  ".ttt.",
];

/** Per-cosmetic item portrait. `crop` limits the drawn height, used to show a
 * canopy skin as canopy alone rather than a whole tree. */
export const COSMETIC_ITEM_ICON: Record<CosmeticId, { map: PixelMap; crop?: number }> = {
  capBlue: { map: CAP_ICON },
  capBlack: { map: CAP_ICON },
  capGold: { map: CAP_ICON },
  // TREE_SM rows 0-4 are the canopy (`G`/`g`) — exactly what Sakura recolors.
  treeSakura: { map: TREE_SM, crop: 5 },
  treeBirch: { map: TRUNK_ICON },
};

// Cache Koi: a small fish that swims in the lake, fed by cache-read tokens
// (see Game.applyChop/economy.ts's accrueCacheKoi) — click to catch for a
// lake-freshness-scaled amber reward. Facing right; drawSprite flips it for
// left-swimming, same convention as the woodcutter sprites below.
export const CACHE_KOI: PixelMap = [
  ".iii.",
  "oiiiK",
  ".iii.",
];

// Catch ripple: 2-frame expanding ring (see Effect in scene/effects.ts),
// same "small map + own palette, animated via frame index" trick as
// SLASH1/SLASH2. Reuses the data-beam O/o colors, echoing CACHE_KOI's tail.
export const RIPPLE1: PixelMap = [
  ".ooo.",
  "o...o",
  "o...o",
  "o...o",
  ".ooo.",
];

export const RIPPLE2: PixelMap = [
  "..OoO..",
  ".o...o.",
  "O.....O",
  "o.....o",
  "O.....O",
  ".o...o.",
  "..OoO..",
];

// Woodcutter, 10 wide. Facing right; drawSprite flips for left.
// Note: the axe itself is no longer baked into these frames — it's composited
// separately, per-rarity/per-equipped-item, by src/scene/weapons.ts's
// drawHeldWeapon (see Woodcutter.render()). HAND_ANCHOR in weapons.ts was
// derived from this exact axe-free geometry (arm/torso positions), so the
// held weapon lands exactly where the old baked `A`/`w` pixels used to be.
export const WC_STAND: PixelMap = [
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..RRRR....",
  "..rRRr....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];

export const WC_WALK1: PixelMap = [
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..RRRR....",
  "..rRRr....",
  "..P..P....",
  ".P....P...",
  ".b....b...",
];

export const WC_WALK2: PixelMap = [
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..RRRR....",
  "..rRRr....",
  "...PP.....",
  "...PP.....",
  "...bb.....",
];

export const WC_CHOP_UP: PixelMap = [
  "..........",
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..RRR.....",
  "..rRRr....",
  "..P..P....",
  "..b..b....",
];

export const WC_CHOP_DOWN: PixelMap = [
  "...CC.....",
  "...ss.....",
  "..RRRR....",
  "..RRR.....",
  "..rRRr....",
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

// --- Rarity-tiered worker sprite sets -------------------------------------
// Gacha-pulled team members get a distinct silhouette per rarity (not just
// a recolor): rare adds a scarf, epic a wider hood, legendary a crown
// silhouette (an extra row above the head). Recolored per-world via
// WorldSpec.workerPalette (economy.ts), same withPalette() mechanism as
// tree skins. "Common" reuses the base WC_* frames above unchanged.

export interface WorkerFrameSet {
  stand: PixelMap;
  walk1: PixelMap;
  walk2: PixelMap;
  chopUp: PixelMap;
  chopDown: PixelMap;
  sit: PixelMap;
  /** Battle-only: staggered/off-balance pose shown the instant this member
   * takes a hit — leaning off-center with a flailing arm and crossed,
   * stumbling legs, distinct from the calm, symmetric `sit` idle. */
  hurt: PixelMap;
  /** Battle-only: KO'd, lying flat on the ground — shorter and wider than
   * every other frame (a splayed "starfish" silhouette: arms flung to both
   * sides, legs apart, headwear knocked askew) and drawn in shade colors
   * throughout so it reads as dim/lifeless rather than merely resting. */
  defeated: PixelMap;
}

export type WorkerRarity = "common" | "rare" | "epic" | "legendary";

const RARE_STAND: PixelMap = [
  "...CC.....",
  "..Nss.....",
  "..NRRR....",
  "..RRRR....",
  "..rRRr....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const RARE_WALK1: PixelMap = [
  "...CC.....",
  "..Nss.....",
  "..NRRR....",
  "..RRRR....",
  "..rRRr....",
  "..P..P....",
  ".P....P...",
  ".b....b...",
];
const RARE_WALK2: PixelMap = [
  "...CC.....",
  "..Nss.....",
  "..NRRR....",
  "..RRRR....",
  "..rRRr....",
  "...PP.....",
  "...PP.....",
  "...bb.....",
];
const RARE_CHOP_UP: PixelMap = [
  "..........",
  "...CC.....",
  "..Nss.....",
  "..NRRR....",
  "..RRR.....",
  "..rRRr....",
  "..P..P....",
  "..b..b....",
];
const RARE_CHOP_DOWN: PixelMap = [
  "...CC.....",
  "..Nss.....",
  "..NRRR....",
  "..RRR.....",
  "..rRRr....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const RARE_SIT: PixelMap = [
  "...CC.....",
  "..Nss.....",
  "..NRRR....",
  "..rRRr....",
  "..PPPP....",
  "..b..b....",
];

// --- Battle hurt/defeated poses, per rarity -------------------------------
// `hurt` reuses the 10-wide standing footprint but leans the torso off-
// center with a flailing arm (an isolated skin pixel flung out past the
// silhouette) and crossed, stumbling legs — never symmetric like `sit`.
// `defeated` drops to a short, wide (13-wide, 5-tall) splayed silhouette:
// headwear knocked to one side, both arms flung out, legs apart, drawn
// entirely in shade colors (r/h/y instead of R/H/Y) so it reads as dim and
// motionless rather than a recolored sit/rest pose.

const COMMON_HURT: PixelMap = [
  "..CC......",
  "..ss......",
  ".RRRR.....",
  ".RRRR.....",
  ".rRRr....s",
  "..P.P.....",
  ".P...P....",
  ".b....b...",
];
const COMMON_DEFEATED: PixelMap = [
  ".C...........",
  "s.ss........s",
  "..rRRRr......",
  ".P..rr..P....",
  "b....P....b..",
];

const RARE_HURT: PixelMap = [
  "..CC......",
  ".Nss......",
  ".NRRR.....",
  ".RRRR.....",
  ".rRRr....s",
  "..P.P.....",
  ".P...P....",
  ".b....b...",
];
const RARE_DEFEATED: PixelMap = [
  ".NC..........",
  "s.ss........s",
  "..rRRRr......",
  ".P..rr..P....",
  "b....P....b..",
];

const EPIC_HURT: PixelMap = [
  ".HHHH.....",
  ".HssH.....",
  ".RRRR.....",
  ".RRRR.....",
  ".hRRh....s",
  "..P.P.....",
  ".P...P....",
  ".b....b...",
];
const EPIC_DEFEATED: PixelMap = [
  ".hH..........",
  "s.HssH......s",
  "..hRRRh......",
  ".P..rr..P....",
  "b....P....b..",
];

const LEGENDARY_HURT: PixelMap = [
  "..y.y.....",
  "..YY......",
  ".ss.......",
  ".RRRR.....",
  ".RRRR....s",
  ".yRRy.....",
  "..P.P.....",
  ".b...b....",
];
const LEGENDARY_DEFEATED: PixelMap = [
  ".y...........",
  "s.ss........s",
  "..yRRRy......",
  ".P..rr..P....",
  "b....P....b..",
];

const EPIC_STAND: PixelMap = [
  "..HHHH....",
  "..HssH....",
  "..RRRR....",
  "..RRRR....",
  "..hRRh....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const EPIC_WALK1: PixelMap = [
  "..HHHH....",
  "..HssH....",
  "..RRRR....",
  "..RRRR....",
  "..hRRh....",
  "..P..P....",
  ".P....P...",
  ".b....b...",
];
const EPIC_WALK2: PixelMap = [
  "..HHHH....",
  "..HssH....",
  "..RRRR....",
  "..RRRR....",
  "..hRRh....",
  "...PP.....",
  "...PP.....",
  "...bb.....",
];
const EPIC_CHOP_UP: PixelMap = [
  "..........",
  "..HHHH....",
  "..Hss.....",
  "..hRRR....",
  "..RRR.....",
  "..rRRr....",
  "..P..P....",
  "..b..b....",
];
const EPIC_CHOP_DOWN: PixelMap = [
  "..HHHH....",
  "..HssH....",
  "..hRRR....",
  "..RRR.....",
  "..hRRh....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const EPIC_SIT: PixelMap = [
  "..HHHH....",
  "..HssH....",
  "..hRRR....",
  "..hRRh....",
  "..PPPP....",
  "..b..b....",
];

const LEGENDARY_STAND: PixelMap = [
  "...y.y....",
  "...YY.....",
  "...ss.....",
  "..RRRR....",
  "..RRRR....",
  "..yRRy....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const LEGENDARY_WALK1: PixelMap = [
  "...y.y....",
  "...YY.....",
  "...ss.....",
  "..RRRR....",
  "..RRRR....",
  "..yRRy....",
  "..P..P....",
  ".P....P...",
  ".b....b...",
];
const LEGENDARY_WALK2: PixelMap = [
  "...y.y....",
  "...YY.....",
  "...ss.....",
  "..RRRR....",
  "..RRRR....",
  "..yRRy....",
  "...PP.....",
  "...PP.....",
  "...bb.....",
];
const LEGENDARY_CHOP_UP: PixelMap = [
  "...y.y....",
  "..........",
  "...YY.....",
  "...ss.....",
  "..RRRR....",
  "..RRR.....",
  "..yRRy....",
  "..P..P....",
  "..b..b....",
];
const LEGENDARY_CHOP_DOWN: PixelMap = [
  "...y.y....",
  "...YY.....",
  "...ss.....",
  "..RRRR....",
  "..RRR.....",
  "..yRRy....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const LEGENDARY_SIT: PixelMap = [
  "...y.y....",
  "...YY.....",
  "...ss.....",
  "..RRRR....",
  "..yRRy....",
  "..PPPP....",
  "..b..b....",
];

export const RARITY_WOODCUTTER_SPRITES: Record<WorkerRarity, WorkerFrameSet> = {
  common: {
    stand: WC_STAND,
    walk1: WC_WALK1,
    walk2: WC_WALK2,
    chopUp: WC_CHOP_UP,
    chopDown: WC_CHOP_DOWN,
    sit: WC_SIT,
    hurt: COMMON_HURT,
    defeated: COMMON_DEFEATED,
  },
  rare: {
    stand: RARE_STAND,
    walk1: RARE_WALK1,
    walk2: RARE_WALK2,
    chopUp: RARE_CHOP_UP,
    chopDown: RARE_CHOP_DOWN,
    sit: RARE_SIT,
    hurt: RARE_HURT,
    defeated: RARE_DEFEATED,
  },
  epic: {
    stand: EPIC_STAND,
    walk1: EPIC_WALK1,
    walk2: EPIC_WALK2,
    chopUp: EPIC_CHOP_UP,
    chopDown: EPIC_CHOP_DOWN,
    sit: EPIC_SIT,
    hurt: EPIC_HURT,
    defeated: EPIC_DEFEATED,
  },
  legendary: {
    stand: LEGENDARY_STAND,
    walk1: LEGENDARY_WALK1,
    walk2: LEGENDARY_WALK2,
    chopUp: LEGENDARY_CHOP_UP,
    chopDown: LEGENDARY_CHOP_DOWN,
    sit: LEGENDARY_SIT,
    hurt: LEGENDARY_HURT,
    defeated: LEGENDARY_DEFEATED,
  },
};

// --- Adventure enemy sprites -----------------------------------------------
// Three enemy kinds (protestor, scientist, mayor), one hand-drawn silhouette
// each — individuality between named characters comes from a small per-
// character palette accent (see adventure.ts ENEMY_CHARACTERS), not bespoke
// frames. Same 10-wide footprint as the woodcutter frames above.

export interface EnemyFrameSet {
  idle: PixelMap;
  attackWindup: PixelMap;
  attackStrike: PixelMap;
  hurt: PixelMap;
  defeated: PixelMap;
  /** Scientist-only: Glitch Pulse cast pose. */
  special?: PixelMap;
}

/** The protestor's picket sign — composited as its own drawSprite call above
 * the raised hand (like GLOW_SM next to a chop impact), not baked into body
 * frames, so it stays fixed while arm/post frames animate around it. A red
 * prohibition ring, a diagonal slash, and a hand-drawn "A" then "I" glyph —
 * the whole joke is the traffic "no entry" sign standing in for "NO AI".
 * Omitted entirely in the `defeated` frame (implied dropped). */
export const SIGN_NO_AI: PixelMap = [
  "....ZZZ....",
  "..ZZWWWZZ..",
  ".ZZWWWWWZZ.",
  "ZZWXWWXZXZZ",
  "ZZXWXWZXWZZ",
  "ZZXXXZWXWZZ",
  "ZZXWZWWXWZZ",
  "ZZXZXWXXXZZ",
  ".ZZWWWWWZZ.",
  "..ZZWWWZZ..",
  "....ZZZ....",
];

/** Scientist's Glitch Pulse projectile — a cyan beam with a single magenta
 * glitch-fringe pixel, composited the same way SLASH1/SLASH2 are. */
export const DATA_BEAM: PixelMap = [
  "oOOOo",
  "OOFOO",
  "oOOOo",
];

const PROTESTOR_IDLE: PixelMap = [
  "...UU.....",
  "...ss....I",
  "..VVVV...I",
  "..VvVs..I.",
  "..vVVv....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const PROTESTOR_WINDUP: PixelMap = [
  "...UU..I..",
  "...ss..I..",
  "..VVVVsI..",
  "..VvVV....",
  "..vVVv....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const PROTESTOR_STRIKE: PixelMap = [
  "...UU.....",
  "...ss.....",
  "..VVVV....",
  "..VvVVIII.",
  "..vVVv....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const PROTESTOR_HURT: PixelMap = [
  "....UU....",
  "....ss....",
  "...VVVV...",
  "...VvVs...",
  "...vVVv...",
  "...P..P...",
  "...P..P...",
  "....b.b...",
];
const PROTESTOR_DEFEATED: PixelMap = [
  "...UU.....",
  "...ss.....",
  "..VVVV....",
  "..vVVv....",
  "..PPPP....",
  "..b..b....",
];

const SCIENTIST_IDLE: PixelMap = [
  "...MM.....",
  "..JEEJ....",
  "..LLLL....",
  "..LLLL..O.",
  "..lLLl....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const SCIENTIST_WINDUP: PixelMap = [
  "...MM.....",
  "..JEEJ....",
  "..LLLL...o",
  "..LLLL....",
  "..lLLl....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const SCIENTIST_STRIKE: PixelMap = [
  "...MM.....",
  "..JEEJ....",
  "..LLLL....",
  "..LLLLLo..",
  "..lLlL....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const SCIENTIST_HURT: PixelMap = [
  "....MM....",
  "...JJEJ...",
  "...LLLL...",
  "...LLLL...",
  "...lLLl...",
  "...P..P...",
  "...P..P...",
  "....b.b...",
];
const SCIENTIST_DEFEATED: PixelMap = [
  "...MM.....",
  "..JEEJ....",
  "..lLLl....",
  "..llll....",
  "..PPPP....",
  "..b..b....",
];
const SCIENTIST_SPECIAL: PixelMap = [
  "....O.....",
  "...oOo....",
  "..EE......",
  "..LLLL....",
  "..LLLLO...",
  "..lLLl....",
  "..P..P....",
  "..b..b....",
];

// Mayor: suit + a diagonal sash (the clearest silhouette read for "mayoral
// figure" at this resolution) — no sign/beam prop, no `special` move, so it
// reads as distinct purely off its own body sprite. The sash (`B`) shifts
// one column to the left each row (rows 2-4, cols 5→4→3) to draw the
// diagonal band across the suit's torso block; legs/boots reuse the same
// plain `P`/`b` pants letters every other kind uses (only the head/torso
// rows vary per kind — see protestor/scientist above).
const MAYOR_IDLE: PixelMap = [
  "...MM.....",
  "...ss.....",
  "..SSSB....",
  "..SSBs....",
  "..nBnn....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const MAYOR_WINDUP: PixelMap = [
  "...MM.....",
  "...ss.....",
  "..SSSBs...",
  "..SSBs....",
  "..nBnn....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const MAYOR_STRIKE: PixelMap = [
  "...MM.....",
  "...ss.....",
  "..SSSB....",
  "..SSBsss..",
  "..nBnn....",
  "..P..P....",
  "..P..P....",
  "..b..b....",
];
const MAYOR_HURT: PixelMap = [
  "....MM....",
  "....ss....",
  "...SSSB...",
  "...SSBs...",
  "...nBnn...",
  "...P..P...",
  "...P..P...",
  "....b.b...",
];
const MAYOR_DEFEATED: PixelMap = [
  "...MM.....",
  "...ss.....",
  "..SSSB....",
  "..nBnn....",
  "..PPPP....",
  "..b..b....",
];

export const ENEMY_KIND_SPRITES: Record<"protestor" | "scientist" | "mayor", EnemyFrameSet> = {
  protestor: {
    idle: PROTESTOR_IDLE,
    attackWindup: PROTESTOR_WINDUP,
    attackStrike: PROTESTOR_STRIKE,
    hurt: PROTESTOR_HURT,
    defeated: PROTESTOR_DEFEATED,
  },
  scientist: {
    idle: SCIENTIST_IDLE,
    attackWindup: SCIENTIST_WINDUP,
    attackStrike: SCIENTIST_STRIKE,
    hurt: SCIENTIST_HURT,
    defeated: SCIENTIST_DEFEATED,
    special: SCIENTIST_SPECIAL,
  },
  mayor: {
    idle: MAYOR_IDLE,
    attackWindup: MAYOR_WINDUP,
    attackStrike: MAYOR_STRIKE,
    hurt: MAYOR_HURT,
    defeated: MAYOR_DEFEATED,
  },
};

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
  // The font had no slash, and drawText SKIPS an unknown character while
  // still advancing the cursor — so every ratio in the game rendered as two
  // numbers with a hole between them ("0/4" came out as "0 4", which reads
  // as two separate values). Ratios are exactly the place a missing
  // separator changes the meaning rather than just looking wrong.
  "/": ["..#", "..#", ".#.", "#..", "#.."],
  // Dialogue punctuation. Without these, fontSafe silently drops them and
  // "I'M" renders as "IM" — which is why the bridge-wright's whole script had
  // to be written free of contractions last round. That does not scale to a
  // talking cast, and a comma-less, question-mark-less voice reads as a
  // telegram rather than as a person. The apostrophe and quote sit high, the
  // comma hangs below the baseline row, and "!"/"?" both keep a one-row gap
  // above their dot so the mark is legible at 5px.
  "'": [".#.", ".#.", "...", "...", "..."],
  '"': ["#.#", "#.#", "...", "...", "..."],
  ",": ["...", "...", "...", ".#.", "#.."],
  "!": [".#.", ".#.", ".#.", "...", ".#."],
  "?": ["##.", "..#", ".#.", "...", ".#."],
  ":": ["...", ".#.", "...", ".#.", "..."],
  // Percent. Added because the NPC content gate caught every "LAKE'S AT 31%"
  // line quietly rendering as "LAKE'S AT 31" — the sign is the whole point of
  // quoting a percentage, and losing it turns a figure into a bare number.
  "%": ["#.#", "..#", ".#.", "#..", "#.#"],
  k: ["#..", "#.#", "##.", "#.#", "#.#"],
  M: ["#..#", "####", "#.##", "#..#", "#..#"],
  x: ["...", "#.#", ".#.", "#.#", "..."],
  " ": ["...", "...", "...", "...", "..."],
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  // K and N used to differ only by which single row held the "##." diagonal
  // (row 2 vs row 1), which at 3x5 is not a readable distinction — Ns read as
  // Ks. K now gets its real silhouette: two arms meeting the stem at a vertex,
  // so the pair differs by shape rather than by one pixel's row.
  K: ["#..#", "#.#.", "##..", "#.#.", "#..#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  // N, M, W and K are 4 COLUMNS WIDE while everything else is 3 (glyphs are
  // variable width — see drawText/textWidth). This is not decoration: at 3px
  // the outer columns are the two stems and the middle column is the only free
  // space, so "both stems straight plus something in the middle" IS the letter
  // H. There is physically nowhere to put a diagonal. A fourth column buys the
  // room for one, so N keeps a straight stem on BOTH sides with an empty
  // top-middle and bottom-middle and a real diagonal falling between them.
  N: ["#..#", "##.#", "####", "#.##", "#..#"],
  O: ["###", "#.#", "#.#", "#.#", "###"],
  Q: ["###", "#.#", "#.#", "#.#", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: ["###", "#..", "###", "..#", "###"],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", ".#.", ".#."],
  W: ["#..#", "#..#", "##.#", "####", "#..#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
};

/** Fold a string into what FONT can actually draw: upper-case, with anything
 * still unmapped removed.
 *
 * FONT is upper-case only (plus `k`/`x`, which exist purely for abbrev()'s
 * "80k"/"2x" suffixes) and drawText SKIPS an unknown character while still
 * advancing the cursor. That combination fails silently and expensively: a
 * mixed-case sentence renders as a scatter of capitals separated by gaps —
 * which is exactly what the bridge-wright's first speech bubble did. Any
 * text assembled from prose rather than from a hand-written all-caps literal
 * should come through here first. */
export function fontSafe(text: string): string {
  let out = "";
  for (const ch of text.toUpperCase()) {
    if (FONT[ch]) out += ch;
  }
  return out;
}

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
      cx += 4; // 3px default glyph + 1px gap
      continue;
    }
    const gw = glyph[0].length;
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < gw; col++) {
        if (glyph[row][col] === "#") {
          ctx.fillRect(cx + col, y + row, 1, 1);
        }
      }
    }
    cx += gw + 1; // 1px inter-glyph gap
  }
}

/** Glyphs are VARIABLE width (3px for most, 4px for the few letters that need
 * a real diagonal — see FONT), each followed by a 1px gap, so this has to sum
 * rather than multiply. Every caller that centres or right-aligns text goes
 * through here, so widening a glyph can't desync a layout from its label. */
export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const glyph = FONT[ch];
    w += (glyph ? glyph[0].length : 3) + 1;
  }
  return Math.max(0, w - 1);
}

/** Text that reads as *carved into* a surface rather than floating over it —
 * a light highlight offset down-right, with the dark ink laid on top. That is
 * the inverse of the drop-shadow FloatingText uses (dark below, light above),
 * which is exactly what flips the perceived depth from raised to incised.
 *
 * Used for the resource props' etched counts, so the exact numbers stay
 * always-visible without a hover (there is no canvas hover infrastructure)
 * while still looking like part of the wood/brass they sit on.
 *
 * NOTE: FONT carries only uppercase A-Z, digits and `. + - k M x`. Lowercase
 * letters silently draw nothing while still advancing the cursor — pass
 * uppercase. */
export function drawEngraved(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  ink: string,
  highlight: string,
): void {
  drawText(ctx, text, x + 1, y + 1, highlight);
  drawText(ctx, text, x, y, ink);
}
