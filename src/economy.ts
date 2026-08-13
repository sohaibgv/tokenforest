// All balance numbers in one place.
//
// Design invariant: world w multiplies tree HP and wood yield by 10^w, and
// axe tier t deals 10^t damage — so a tier-matched axe makes every world
// play exactly like Greenwood with a Rusty Axe. Each axe costs roughly five
// plots of the world it's farmed in.

export interface AxeSpec {
  name: string;
  damage: number;
  cost: number; // wood; 0 = starter
}

export const AXES: AxeSpec[] = [
  { name: "Rusty Axe", damage: 1, cost: 0 },
  { name: "Iron Axe", damage: 10, cost: 600 },
  { name: "Steel Axe", damage: 100, cost: 6_000 },
  { name: "Mithril Axe", damage: 1_000, cost: 60_000 },
  { name: "Crystal Axe", damage: 10_000, cost: 600_000 },
];

export interface WorldSpec {
  name: string;
  mult: number; // tree HP × and wood yield ×
  travelCost: number; // wood to travel here from the previous world
  plotGate: number; // plots to clear in the PREVIOUS world before travel
  /** Palette overrides for tree sprites (keys of sprites.ts PALETTE). */
  palette: Record<string, string> | null;
  /** Palette overrides for worker sprites (shirt/trim recolor per world). */
  workerPalette: Record<string, string> | null;
  /** Palette overrides for held weapons (see scene/weapons.ts) — mirrors
   * workerPalette exactly, but only ever tints the neutral steel base
   * (`D`/`d`); rarity-accent letters (`N`, `H`/`h`, `Y`/`y`) and the shared
   * `w`/`Q`/`q` letters are never overridden here, so a legendary weapon's
   * glow reads identically in every world. */
  weaponPalette: Record<string, string> | null;
  ground: string;
  tuft: string;
}

/** The hand-authored, per-world part of a WorldSpec — everything except the
 * mult/travelCost/plotGate numbers, which are pure formulas of the world
 * index (see multForWorld/travelCostForWorld/plotGateForWorld below). This
 * split is what lets the world ladder grow without touching every
 * positionally-parallel structure that used to be keyed off WORLDS.length. */
export type WorldTheme = Omit<WorldSpec, "mult" | "travelCost" | "plotGate">;

// Part A.2 warm color-grade: every world's hex values nudged toward warmer,
// softer, cozier tones (slight hue-shift toward orange/yellow, gentler
// saturation, lifted shadows so nothing reads as harsh near-black) while
// keeping each world's own color identity intact — Greenwood still a green
// forest, Autumn Lands still autumnal, Snowreach still icy (just "cozy-cool"
// rather than sterile), Emberwaste still volcanic, Crystal Hollow still
// violet/crystalline, etc. Same 11 worlds, same fields, values-only.
export const CURATED_WORLD_THEMES: WorldTheme[] = [
  {
    name: "Greenwood",
    palette: null,
    workerPalette: null,
    // Baseline/neutral world — weapons keep their own undyed steel tone.
    weaponPalette: null,
    ground: "#427b48",
    tuft: "#3b6e40",
  },
  {
    name: "Autumn Lands",
    palette: { G: "#b7682b", g: "#d88c40" },
    workerPalette: { R: "#9f582e", r: "#824622", V: "#8d5c2c", v: "#6f4820" },
    // Warm bronze-tinted steel, echoing the world's orange/brown canopy.
    weaponPalette: { D: "#9a8a72", d: "#6e6152" },
    ground: "#7e5d32",
    tuft: "#724e23",
  },
  {
    name: "Snowreach",
    palette: { G: "#457d68", g: "#d6ebe0" },
    workerPalette: { R: "#52969f", r: "#3f7275", V: "#52807f", v: "#3d6060" },
    // Pale, cool ice-steel matching the world's icy whites/teals.
    weaponPalette: { D: "#c7d6dc", d: "#94a8ae" },
    ground: "#d2d6d2",
    tuft: "#b2b8b4",
  },
  {
    name: "Emberwaste",
    palette: { G: "#8d412c", g: "#d86840" },
    workerPalette: { R: "#a4412b", r: "#823221", V: "#8d412c", v: "#6a2e1c" },
    // Smoky, sun-scorched steel echoing the world's volcanic red/orange.
    weaponPalette: { D: "#8a6a63", d: "#5c433d" },
    ground: "#54373e",
    tuft: "#492831",
  },
  {
    name: "Crystal Hollow",
    palette: { G: "#7960c9", g: "#c2acee", T: "#51486a", t: "#6e6686" },
    workerPalette: { R: "#7960c9", r: "#563f97", V: "#6b51c8", v: "#47358a" },
    // Violet-tinted steel matching the world's crystalline purples.
    weaponPalette: { D: "#8983ad", d: "#5c5680" },
    ground: "#434061",
    tuft: "#373451",
  },
  {
    name: "Cinderfall Barrens",
    palette: { G: "#69391e", g: "#c85c2f", T: "#2b1c14", t: "#332016" },
    workerPalette: { R: "#823621", r: "#5c2617", V: "#913918", v: "#6d2811" },
    // Charcoal-orange steel matching the world's burnt-ember ground.
    weaponPalette: { D: "#6e5c50", d: "#453931" },
    ground: "#2e1d17",
    tuft: "#4b2c1f",
  },
  {
    name: "Glowfen Depths",
    palette: { G: "#266554", g: "#46deb0" },
    workerPalette: { R: "#346f5b", r: "#25513f", V: "#43a380", v: "#2c6a56" },
    // Teal-tinted steel echoing the world's bioluminescent canopy glow.
    weaponPalette: { D: "#5c8d7c", d: "#3a5c4e" },
    ground: "#143026",
    tuft: "#1f483d",
  },
  {
    name: "Tempest Shoals",
    palette: { G: "#42505d", g: "#82989f" },
    workerPalette: { R: "#526872", r: "#3c5259", V: "#62828a", v: "#486266" },
    // Storm-blue steel matching the world's gray-blue palette.
    weaponPalette: { D: "#7d94a0", d: "#546670" },
    ground: "#303c42",
    tuft: "#26302f",
  },
  {
    name: "Sunscar Dunes",
    palette: { G: "#8d682f", g: "#d8ac50" },
    workerPalette: { R: "#a4753b", r: "#805829", V: "#c8903f", v: "#996d1f" },
    // Warm brass-tinted steel matching the world's sandy gold dunes.
    weaponPalette: { D: "#c2a878", d: "#8f7850" },
    ground: "#c89d5d",
    tuft: "#a27b3f",
  },
  {
    name: "Bonewhite Flats",
    palette: { G: "#635c50", g: "#ddd3bf" },
    workerPalette: { R: "#8e8576", r: "#625a4c", V: "#ada090", v: "#786e5e" },
    // Pale bone-toned steel matching the world's bleached tan/cream ground.
    weaponPalette: { D: "#c9bfae", d: "#948a7a" },
    ground: "#bfb29c",
    tuft: "#918573",
  },
  {
    name: "Nebula's Edge",
    palette: { G: "#46316f", g: "#9770d9", T: "#322351", t: "#463363" },
    workerPalette: { R: "#644e98", r: "#463570", V: "#775fbb", v: "#4f3d8c" },
    // Cosmic purple-tinted steel matching the world's deep-space canopy.
    weaponPalette: { D: "#726a9c", d: "#4a4468" },
    ground: "#2b1f48",
    tuft: "#1c1433",
  },
];

/** Design invariant: world w multiplies tree HP/wood yield by 10^w. */
export function multForWorld(index: number): number {
  return 10 ** index;
}

/** Highest travelable world index at prestige 0 — the ladder's base cap.
 * Lives here (not unlocks.ts, which re-exports it) so pool builders below
 * (see buildItemDef's warCry override) can read it without a module cycle. */
export const BASE_WORLD_CAP = 5;

/** travelCost = 80 × mult for world ≥ 1 (World 0 is free) — reproduces the
 * exact 800/8,000/80,000/800,000 costs of the original hand-authored table. */
export function travelCostForWorld(index: number): number {
  return index === 0 ? 0 : Math.round(80 * multForWorld(index));
}

// --- POV chopping: what a swing is worth ------------------------------------
//
// The timing bar used to report its result as a bare multiplier ("x1.5"),
// which told you the grade twice and never told you the thing you actually
// wanted to know: how much wood that swing just earned. The number shown is
// now the wood itself, and the multiplier below is what produces it.
//
// Three inputs, in descending order of how much control you have over them:
//
//   GRADE   great/good/miss — pure timing, the skill part.
//   SPEED   how fast the needle was sweeping. A fast sweep is a harder
//           target, so it pays more. Normalised against the tier's own speed
//           range (see rollSkillCheck), NOT against the raw number — raw
//           speed climbs with world index, so paying on it directly would
//           quietly hand out a second world multiplier on top of the real
//           one.
//   JITTER  a little noise, so two identical swings don't read as a fixed
//           table. Small enough that it never reorders the grades.
export const SKILL_SPEED_BASE = 55;
export const SKILL_SPEED_RANGE = 40;
export const SKILL_SPEED_PER_TIER = 8;

export const POV_GRADE_MULT: Record<"great" | "good" | "miss", number> = {
  great: 1.5,
  good: 1.15,
  miss: 0.5,
};
/** Multiplier at the slowest and fastest sweep a tier can roll. */
export const POV_SPEED_MULT_MIN = 0.8;
export const POV_SPEED_MULT_MAX = 1.3;
/** Plus or minus this fraction, uniformly.
 *
 * Bounded by the grade gap, not chosen for feel. The tightest gap is
 * good -> great (1.15 -> 1.5, a ratio of 1.304), and jitter spans
 * (1+j)/(1-j); at the 0.15 this started as that span was 1.35, so a lucky
 * GOOD out-earned an unlucky GREAT at the same sweep speed and timing
 * stopped being what the timing bar rewarded. 0.10 spans 1.22 and stays
 * inside the gap with room over. */
export const POV_JITTER = 0.1;

/** Where a rolled sweep speed sits within its own tier's range, 0..1.
 * World-invariant by construction: the tier term cancels. */
export function povSpeedNorm(speed: number, tier: number): number {
  const min = SKILL_SPEED_BASE + tier * SKILL_SPEED_PER_TIER;
  const t = (speed - min) / SKILL_SPEED_RANGE;
  return Math.max(0, Math.min(1, t));
}

/** Wood multiplier for one POV swing. `rand` is injected so the sim can
 * sweep the jitter deterministically instead of sampling it. */
export function povYieldMult(
  grade: "great" | "good" | "miss",
  speed: number,
  tier: number,
  rand: () => number = Math.random,
): number {
  const norm = povSpeedNorm(speed, tier);
  const speedMult = POV_SPEED_MULT_MIN + (POV_SPEED_MULT_MAX - POV_SPEED_MULT_MIN) * norm;
  const jitter = 1 + (rand() * 2 - 1) * POV_JITTER;
  return POV_GRADE_MULT[grade] * speedMult * jitter;
}

// --- Settling the foreman's bill -------------------------------------------
//
// The trestle can be paid for three ways (see the foreman's dialogue). All
// three build the identical bridge; they differ only in which store they drain,
// so the choice is "what am I short of right now", not "which is best".
//
//   TIMBER  travelCostForWorld(w) in wood — the baseline, unchanged.
//   COIN    travelAmberCost — he sources the materials himself, at a premium.
//   SWEAT   you labour alongside him: your whole Focus bar AND a reduced
//           amount of wood.
//
// Two balance facts drove the numbers, and both are sim-gated:
//
// 1. SWEAT CANNOT BE A FREE PASS. Focus caps at FOCUS_CAP and refills for
//    nothing (FOCUS_PASSIVE_SECS), and a bridge is a ONE-TIME purchase per
//    world — roughly ten in an entire run. If a full Focus bar alone bought a
//    crossing, travel would be permanently free and the world gate, which is
//    the game's main progression sink, would stop existing. So Sweat still
//    charges most of the wood; it is a discount for banking Focus, never a
//    substitute for the sink.
//
// 2. COIN HAS TO SCALE WITH THE WORLD. Most amber prices in this file are flat
//    while wood scales 10^world, which is fine for consumables but fatal for a
//    progression gate: a flat amber price would make late-game travel free.
//    amberTradeCost already sets the precedent of scaling an amber price by
//    mult "or the trade ratio explodes at high worlds" — travel needs the same
//    treatment, for a stronger reason.
//
// The amber figure is anchored between this file's two deliberately-lossy
// conversions — the Sap Press pays 6×mult wood per amber, Amber Trade returns
// 0.25×mult wood per amber — whose geometric mean puts amber at ~1.2×mult wood.
// At that rate the 80×mult wood crossing is worth ~65 amber; 100 carries a
// ~1.5x convenience premium for not spending your timber.
export const TRAVEL_AMBER_BASE = 100; // amber, × world mult
/** Share of the wood price still owed on the Sweat route. */
export const TRAVEL_SWEAT_WOOD_FRACTION = 0.55;

export function travelAmberCost(worldMult: number): number {
  return Math.round(TRAVEL_AMBER_BASE * worldMult);
}

/** Wood still owed when you work alongside him. Derived from the full price
 * rather than re-deriving from the world, so the two can never drift. */
export function travelSweatWoodCost(fullWoodCost: number): number {
  return Math.round(fullWoodCost * TRAVEL_SWEAT_WOOD_FRACTION);
}

/** plotGate = 3 + floor((i-1)/2) for i ≥ 1, 0 at World 0 — reproduces the
 * exact 0/3/3/4/4 sequence of the original hand-authored table and keeps
 * creeping slowly (one more plot every 2 worlds) beyond it. */
export function plotGateForWorld(index: number): number {
  return index === 0 ? 0 : 3 + Math.floor((index - 1) / 2);
}

const worldCache = new Map<number, WorldSpec>();

/** Assembles a full WorldSpec for any world index: curated theme (falling
 * back to the last curated theme if index is out of curated range — should
 * never happen in practice while travel() is gated to CURATED_WORLD_THEMES.
 * length, but degrades gracefully rather than crashing) + the three
 * formula-derived numbers. Memoized since this is read every render frame. */
export function getWorld(index: number): WorldSpec {
  const cached = worldCache.get(index);
  if (cached) return cached;
  const theme = CURATED_WORLD_THEMES[index] ?? CURATED_WORLD_THEMES[CURATED_WORLD_THEMES.length - 1];
  const spec: WorldSpec = {
    ...theme,
    mult: multForWorld(index),
    travelCost: travelCostForWorld(index),
    plotGate: plotGateForWorld(index),
  };
  worldCache.set(index, spec);
  return spec;
}

/** Wood paid when a tree of this kind falls (× world mult). */
/** Wood a felled tree pays, by kind (x world mult).
 *
 * The non-elder values carry a x67/49 uplift over the original 1/3/5. That
 * factor is exactly what keeps a plot's total payout identical after
 * TREES_PER_PLOT dropped from 28 to 20 (see scene/plot.ts): at 28 the
 * non-elder trees summed to 67 units, at 20 they sum to 49. The elder is
 * untouched — there is still exactly one per plot, so its contribution never
 * needed rescaling. */
const NON_ELDER_UPLIFT = 67 / 49;

export const WOOD_YIELD: Record<string, number> = {
  small: 1 * NON_ELDER_UPLIFT,
  medium: 3 * NON_ELDER_UPLIFT,
  large: 5 * NON_ELDER_UPLIFT,
  elder: 50,
};

// v3: boots/keenEdge became Power-up gacha unlocks (see POWERUPS below).
// Gnomes stay here — they're autonomous timer-based extra choppers, not
// stat modifiers, and don't map onto a rarity pull.
export type HelperId = "gnome1" | "gnome2" | "gnomeHaste";

export interface HelperSpec {
  id: HelperId;
  name: string;
  blurb: string;
  cost: number;
  /** Helper that must be owned first (upgrade chains). */
  requires?: HelperId;
}

export const HELPERS: HelperSpec[] = [
  {
    id: "gnome1",
    name: "Gnome Chopper",
    blurb: "A gnome chops every 30s, even while you rest",
    cost: 2_500,
  },
  {
    id: "gnome2",
    name: "Second Gnome",
    blurb: "One more gnome",
    cost: 25_000,
    requires: "gnome1",
  },
  {
    id: "gnomeHaste",
    name: "Gnome Haste",
    blurb: "Gnomes chop every 15s",
    cost: 50_000,
    requires: "gnome1",
  },
];

export const GNOME_CHOP_SECS = 30;
export const GNOME_HASTE_SECS = 15;

// --- Interaction layer ---

/** Counted tokens per +1 Focus and +1 Amber. */
export const TOKENS_PER_CHARGE = 1_000;

// --- Swing weight: how hard one API turn hits ------------------------------
//
// A chop used to be worth exactly 1 damage and 1 wood chip no matter what
// produced it, because the frontend counted EVENTS (`buf.hits += 1`) and the
// backend emits exactly one `tf:chop` per usage record. A 400-token turn and
// a 50,000-token turn felled a tree at the same speed and paid the same wood.
// Token volume — the one number this whole app is about, and the number shown
// on every "-1k" float — was economically inert.
//
// Now volume sets the weight of the swing. The shape is deliberate:
//
// SQUARE ROOT, not linear. Real turn sizes are heavily skewed — measured over
// ~7,900 real assistant turns, the median is ~1.35k while the mean is ~4k and
// the top 10% of turns carry 67% of all tokens. Paying linearly would put
// two thirds of all wood into one turn in ten and make a single outlier
// (the largest observed was 971k) worth ~700 median turns. sqrt compresses
// that tail into something a forest can absorb while still making a big turn
// feel unmistakably bigger.
//
// TOKEN_REF is CALIBRATED, not chosen for looks: it is set so the mean weight
// over that real distribution is 1.0, which means the same total usage pays
// the same total wood as before. This is a redistribution, not a raise — big
// turns gain exactly what small turns give up. See the swing-weight gate in
// sim/sim.ts, which asserts that multiplier stays inside ±5%.
export const TOKEN_REF = 1_800;
/** Below this a turn would round to nothing; every turn should move the tree. */
export const SWING_FLOOR = 0.25;
/** Caps the outlier tail. At 8, a ~115k-token turn is already maxed — enough
 * to stagger an elder (30 HP) but never to erase a plot in one event. */
export const SWING_CAP = 8;

export function swingWeight(tokens: number): number {
  if (tokens <= 0) return 0;
  return Math.min(SWING_CAP, Math.max(SWING_FLOOR, Math.sqrt(tokens / TOKEN_REF)));
}
export const FOCUS_CAP = 100;

/** Seconds of real time per +1 Focus, independent of token usage.
 *
 * Manual chopping spends 1 Focus per swing, and Focus used to regenerate ONLY
 * from counted tokens — so with no Claude Code session running it drained to
 * zero and clicking stopped felling trees entirely. That made clicking a way to
 * SPEND token-earned Focus rather than a genuine alternative to it.
 *
 * A slow real-time trickle makes the axe always eventually usable while keeping
 * a hard rate limit, so an auto-clicker can't mint wood: at this rate the cap
 * refills in FOCUS_CAP * FOCUS_PASSIVE_SECS seconds, whereas a single ordinary
 * turn of token usage can hand over dozens of charges instantly. Tokens stay
 * the fast path by a wide margin — see the sim gate. */
export const FOCUS_PASSIVE_SECS = 4;

/** Focus earned by `secs` of real time, plus the leftover fraction to carry.
 * Split-invariant like every other accrual here: chunking the same elapsed time
 * differently must never change the total earned. */
export function accruePassiveFocus(
  carrySecs: number,
  secs: number,
): { carry: number; focus: number } {
  const total = carrySecs + secs;
  const focus = Math.floor(total / FOCUS_PASSIVE_SECS);
  return { carry: total - focus * FOCUS_PASSIVE_SECS, focus };
}
/** A single usage event above this drops a clickable Golden Log. */
export const GOLDEN_LOG_THRESHOLD = 30_000;
export const GOLDEN_LOG_AMBER = 25;
export const GOLDEN_LOG_TTL = 8;
export const FRENZY_SECS = 5;
export const ESPRESSO_DURATION = 60;
export const GNOME_ESPRESSO_SECS = 5;

export interface BoostSpec {
  id: "focusPotion" | "espresso" | "amberWood";
  name: string;
  blurb: string;
  cost: number; // amber
}

export const BOOSTS: BoostSpec[] = [
  {
    id: "focusPotion",
    name: "Focus Potion",
    blurb: "Refill Focus to 100",
    cost: 300,
  },
  {
    id: "espresso",
    name: "Gnome Espresso",
    blurb: "Gnomes chop every 5s for 60s",
    cost: 150,
  },
  {
    id: "amberWood",
    name: "Amber Trade",
    blurb: "Convert to 25 wood × world",
    cost: 100, // base cost at World 0 — see amberTradeCost()
  },
];

/** Amber Trade's wood payout scales 25×mult like every other world-tiered
 * value in the game — its amber cost must scale identically, or the trade
 * ratio (wood out per amber in) explodes at high worlds instead of staying
 * fixed at the World-0 rate. `BoostSpec.cost` above is the base (World-0)
 * cost; every read/charge site for "amberWood" specifically should use this
 * function instead of the raw `spec.cost`. */
export function amberTradeCost(worldMult: number): number {
  const base = BOOSTS.find((b) => b.id === "amberWood")!.cost;
  return Math.round(base * worldMult);
}

// --- Sap Press: wood → amber ----------------------------------------------
//
// The reverse of Amber Trade — a wood sink feeding the amber economy, whose
// costs (revive/provisions/boosts) are all flat while wood income scales
// 10^world. Wood cost scales ×mult (constant relative price at every
// world); the amber yield is flat, like every other amber amount in the
// game. Priced so a Sap-Press→Amber-Trade round trip is always a heavy
// loss (sim-asserted): 6×mult wood per amber in vs 0.25×mult wood per
// amber back out.

/** One-off wood price to build the Sap Press itself. It used to simply exist in
 * every clearing for free, which made "wood → amber" a permanent ambient
 * ability rather than something you choose to invest in. Priced between the
 * cottage's first and second phases: a real decision early, trivial later. */
export const SAP_PRESS_BUILD_COST = 900;

export function sapPressBuildCost(worldMult: number): number {
  return Math.round(SAP_PRESS_BUILD_COST * worldMult);
}

export const SAP_PRESS_WOOD_BASE = 60; // wood, × world mult
export const SAP_PRESS_AMBER_YIELD = 10; // flat amber

export function sapPressCost(worldMult: number): number {
  return Math.round(SAP_PRESS_WOOD_BASE * worldMult);
}

// --- Homestead: the cottage and its buildables ------------------------------
//
// A wood sink you build toward in three visible stages, plus decorative props
// you buy and place on the grid around it.
//
// Costs scale ×worldMult, the same convention sapPressCost/travelCostForWorld
// already use. That's deliberate: wood income scales 10^world, so a flat price
// would be a real goal at World 0 and pocket change by World 2 — scaling keeps
// the cottage a comparable commitment whenever you choose to build it.
//
// NOTE: buildables are purely decorative right now. None of them touch chop
// rates, yields, or any other multiplier, which is what keeps this whole
// feature outside the balance sim's blast radius — the only economic effect is
// wood leaving the player's pocket.

export type CottagePhase = 0 | 1 | 2 | 3;
export const COTTAGE_MAX_PHASE = 3;

/** Wood for the NEXT phase, i.e. cost to go from `phase` to `phase + 1`.
 * Returns null once the cottage is finished. Steeply increasing so the roof is
 * a genuine milestone rather than a formality. */
const COTTAGE_PHASE_BASE = [400, 1600, 6400];

export function cottagePhaseCost(phase: number, worldMult: number): number | null {
  if (phase < 0 || phase >= COTTAGE_MAX_PHASE) return null;
  return Math.round(COTTAGE_PHASE_BASE[phase] * worldMult);
}

/** Short label for the stage you're paying for, shown on the build prompt. */
export const COTTAGE_PHASE_NAME = ["FOUNDATION", "WALLS", "ROOF"] as const;

/** The Barn — a second permanent structure, unlocked once the cottage is
 * finished so the homestead grows in a readable order rather than offering two
 * half-built shells at once. Two phases, priced above the whole cottage: it's
 * the thing you work toward after your house is done. */
export const BARN_MAX_PHASE = 2;
const BARN_PHASE_BASE = [12_000, 30_000];

export function barnPhaseCost(phase: number, worldMult: number): number | null {
  if (phase < 0 || phase >= BARN_MAX_PHASE) return null;
  return Math.round(BARN_PHASE_BASE[phase] * worldMult);
}

export const BARN_PHASE_NAME = ["FRAME", "ROOF"] as const;

/** The Barn only becomes available once the cottage is complete. */
export function barnUnlocked(cottagePhase: number): boolean {
  return cottagePhase >= COTTAGE_MAX_PHASE;
}

export type BuildableId = "flowerbed" | "bench" | "well" | "scarecrow" | "lamppost";

export interface BuildableSpec {
  id: BuildableId;
  name: string;
  /** Wood, ×worldMult. */
  cost: number;
  blurb: string;
  /** How many of this you may own at once.
   *
   * Split by what the object IS, not by price. A yard reads as a place someone
   * lives, and that breaks the moment there are six wells in it — landmarks are
   * things you have ONE of. Repeat decorations are the opposite: a row of
   * lamp posts along a path or a bed of flowers under a window is the whole
   * point of them, so they get a generous cap that exists only to stop the
   * grid being carpeted with a single item. */
  maxOwned: number;
  /** Landmarks are announced as one-off builds in the shop rather than showing
   * a running count. */
  unique: boolean;
}

/** Every buildable is priced below the cottage's first phase (400) on purpose,
 * and sim-gated to stay that way: decorating the yard should never be a
 * competing choice against actually building the cottage. */
export const BUILDABLES: BuildableSpec[] = [
  // Repeat decorations — these are meant to be arranged in rows and clusters.
  { id: "flowerbed", name: "Flower Bed", cost: 40, blurb: "A patch of colour by the path.", maxOwned: 12, unique: false },
  { id: "bench", name: "Bench", cost: 80, blurb: "Somewhere to sit and watch the trees.", maxOwned: 6, unique: false },
  { id: "lamppost", name: "Lamp Post", cost: 140, blurb: "Warm light over the yard at night.", maxOwned: 8, unique: false },
  // Landmarks — one to a homestead. A yard with three wells in it stops
  // reading as somewhere a person lives.
  { id: "scarecrow", name: "Scarecrow", cost: 220, blurb: "Keeps the crows off the woodpile.", maxOwned: 1, unique: true },
  { id: "well", name: "Stone Well", cost: 340, blurb: "Deep, cold, and faintly echoing.", maxOwned: 1, unique: true },
];

/** How many of `id` are already standing in the yard. */
export function ownedCount(placed: { id: string }[] | undefined, id: string): number {
  return (placed ?? []).filter((p) => p.id === id).length;
}

/** Whether another of this buildable may be bought/placed. */
export function canOwnMore(placed: { id: string }[] | undefined, spec: BuildableSpec): boolean {
  return ownedCount(placed, spec.id) < spec.maxOwned;
}

export function buildableCost(spec: BuildableSpec, worldMult: number): number {
  return Math.round(spec.cost * worldMult);
}

export function buildableById(id: string): BuildableSpec | undefined {
  return BUILDABLES.find((b) => b.id === id);
}

// --- Environmental resource props ------------------------------------------
//
// Pure read-only view functions backing the in-world props that replaced the
// old top-left canvas HUD (see scene/game.ts). They only *describe* existing
// save values as a visual tier/ratio — nothing here spends, grants, or scales
// any currency, so the balance sim's bands are structurally untouched.

export type LogStackTier = "kindling" | "cord" | "wall";

/** Log Stack readout: which pile silhouette to draw, and how far through that
 * tier we are (0..1) so the pile can grow log-by-log instead of snapping
 * between three static images.
 *
 * Thresholds are expressed as a fraction of the NEXT world's travel cost
 * rather than absolute wood, because wood income scales 10^world — any fixed
 * threshold would peg at "wall" forever from about World 2 onward. Deriving
 * from travelCostForWorld also means the tiers keep working untouched if the
 * travel ladder is ever re-priced, and it gives the stack a real meaning:
 * a full Timber Wall is "half a travel ticket saved". */
export function logStackTier(
  wood: number,
  worldIndex: number,
): { tier: LogStackTier; within: number } {
  // World 0 travels for free, so fall through to World 1's cost as the yardstick.
  const goal = travelCostForWorld(worldIndex + 1) || travelCostForWorld(1);
  const p = goal > 0 ? wood / goal : 0;
  if (p < 0.05) return { tier: "kindling", within: clamp01(p / 0.05) };
  if (p < 0.5) return { tier: "cord", within: clamp01((p - 0.05) / 0.45) };
  return { tier: "wall", within: clamp01((p - 0.5) / 0.5) };
}

/** Amber level the hanging Lantern reads as "full". Derived from the price
 * table rather than hardcoded, so a full lantern always means "you can afford
 * anything amber buys" and can never drift out of sync with a repricing.
 *
 * Computed lazily rather than as a top-level const because
 * ADVENTURE_REVIVE_BASE_COST and PROVISIONS are declared far below this point
 * in the file — reading them at module-init time would hit the temporal dead
 * zone and throw. Memoized, so the per-frame lantern render pays for it once. */
let lanternFullMemo: number | null = null;

export function amberLanternFull(): number {
  if (lanternFullMemo === null) {
    lanternFullMemo = Math.max(
      ADVENTURE_REVIVE_BASE_COST,
      ...BOOSTS.filter((b) => b.id !== "amberWood").map((b) => b.cost),
      ...PROVISIONS.filter((p) => p.currency === "amber").map((p) => p.cost),
    );
  }
  return lanternFullMemo;
}

/** Focus heat ramp for the Whetstone wheel and the active woodcutter's axe
 * blade: cold steel below FOCUS_HEAT_FLOOR (returns null = leave the base
 * palette alone), then dull red → ember → white-hot. */
export const FOCUS_HEAT_FLOOR = 0.15;

const HEAT_STOPS = ["#6e2318", "#c9403a", "#e8823a", "#ffd75e", "#fff6e0"];

export function focusHeatColor(focus: number): string | null {
  const t = clamp01(focus / FOCUS_CAP);
  if (t < FOCUS_HEAT_FLOOR) return null;
  const u = (t - FOCUS_HEAT_FLOOR) / (1 - FOCUS_HEAT_FLOOR);
  const span = HEAT_STOPS.length - 1;
  const i = Math.min(span - 1, Math.floor(u * span));
  return mixHex(HEAT_STOPS[i], HEAT_STOPS[i + 1], u * span - i);
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Linear blend between two "#rrggbb" strings. Also used to derive the axe
 * blade's shade tone from its heat color. */
export function mixHex(a: string, b: string, t: number): string {
  const k = clamp01(t);
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number): number => {
    const va = (pa >> shift) & 255;
    const vb = (pb >> shift) & 255;
    return Math.round(va + (vb - va) * k);
  };
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

// --- Focus Overflow logs ---------------------------------------------------
//
// Counted tokens that arrive while Focus sits at FOCUS_CAP used to be
// silently discarded. They now feed an overflow meter; every
// OVERFLOW_LOG_TOKENS spawns a clickable Golden Log (game-side, when none
// is already up). Threshold sits below GOLDEN_LOG_THRESHOLD's single-turn
// 30k so sustained capped usage produces logs a bit faster than one giant
// turn would, without showering them (25k ≈ 25 Focus charges' worth).

export const OVERFLOW_LOG_TOKENS = 25_000;

/** Pure threshold accrual: fold `amount` into a carry meter, returning the
 * new carry and how many whole `threshold`-sized units that earns.
 * Split-invariant (sim-asserted): any chunking of N total yields exactly
 * floor(N / threshold), independent of how it was chunked — shared by
 * Focus Overflow (accrueOverflow) and Cache Koi (accrueCacheKoi) below. */
export function accrueThreshold(carry: number, amount: number, threshold: number): { carry: number; units: number } {
  const total = carry + amount;
  return { carry: total % threshold, units: Math.floor(total / threshold) };
}

/** Fold `counted` capped-Focus tokens into the overflow meter, returning
 * the new carry and how many Golden Logs that earns. */
export function accrueOverflow(carry: number, counted: number): { carry: number; logs: number } {
  const r = accrueThreshold(carry, counted, OVERFLOW_LOG_TOKENS);
  return { carry: r.carry, logs: r.units };
}

// --- Cache Koi ---------------------------------------------------------
//
// A small fish that swims in the Lake (see scene/lake.ts), fed by
// cache-read tokens — the "efficient reuse" side of usage, distinct from
// the counted tokens Focus/Amber/Golden-Logs already track (see
// ChopEvent.cacheRead in bridge.ts, previously unused). Click to catch for
// an amber reward that scales with the lake's current freshness (density):
// a fuller lake (fresher budget) pays out more, without ever gating catch
// availability on it — render()'s water floor (0.18) means there's always
// at least a puddle to swim in, at every budget level.

export const CACHE_KOI_TOKENS = 40_000; // cache-read tokens per koi spawn
export const CACHE_KOI_TTL = 10; // seconds a spawned koi stays catchable
export const CACHE_KOI_AMBER_MIN = 10;
export const CACHE_KOI_AMBER_MAX = 22;

/** Fold `cacheRead` tokens into the koi meter, returning the new carry and
 * how many koi that earns (almost always 0 or 1 — see accrueThreshold). */
export function accrueCacheKoi(carry: number, cacheRead: number): { carry: number; koi: number } {
  const r = accrueThreshold(carry, cacheRead, CACHE_KOI_TOKENS);
  return { carry: r.carry, koi: r.units };
}

/** Amber reward for a caught koi — linear in lake density (0..1), never
 * below CACHE_KOI_AMBER_MIN so a catch always feels worthwhile even at a
 * near-drained lake. */
export function koiReward(density: number): number {
  const clamped = Math.max(0, Math.min(1, density));
  return Math.round(CACHE_KOI_AMBER_MIN + (CACHE_KOI_AMBER_MAX - CACHE_KOI_AMBER_MIN) * clamped);
}

export type CosmeticId =
  | "capBlue"
  | "capBlack"
  | "capGold"
  | "treeSakura"
  | "treeBirch";

export interface CosmeticSpec {
  id: CosmeticId;
  name: string;
  kind: "cap" | "treeSkin";
  cost: number;
  /** Palette override applied when equipped. */
  palette: Record<string, string>;
  /** Which palette letters a player-chosen dye repaints, and how much lighter
   * each is than the chosen base. Two-letter cosmetics (canopy G/g, trunk T/t)
   * ship as a base plus a lightened highlight, so a single chosen hex has to
   * reproduce that relationship — see dyedPalette(). */
  dyeKeys: { key: string; lighten: number }[];
}

export const COSMETICS: CosmeticSpec[] = [
  {
    id: "capBlue",
    name: "Blue Cap",
    kind: "cap",
    cost: 50,
    palette: { C: "#3a6ea5" },
    dyeKeys: [{ key: "C", lighten: 0 }],
  },
  {
    id: "capBlack",
    name: "Black Cap",
    kind: "cap",
    cost: 100,
    palette: { C: "#2a2a2e" },
    dyeKeys: [{ key: "C", lighten: 0 }],
  },
  {
    id: "capGold",
    name: "Gold Cap",
    kind: "cap",
    cost: 200,
    palette: { C: "#e6b93c" },
    dyeKeys: [{ key: "C", lighten: 0 }],
  },
  {
    id: "treeSakura",
    name: "Sakura Grove",
    kind: "treeSkin",
    cost: 500,
    palette: { G: "#d98cb8", g: "#f2c2dc" },
    // Canopy: base + a clearly lighter highlight, matching the shipped pair.
    dyeKeys: [
      { key: "G", lighten: 0 },
      { key: "g", lighten: 0.35 },
    ],
  },
  {
    id: "treeBirch",
    name: "Silver Birch",
    kind: "treeSkin",
    cost: 500,
    palette: { T: "#d8d8d0", t: "#f0f0e8" },
    // Trunk: already a pale pair, so a gentler highlight step than the canopy.
    dyeKeys: [
      { key: "T", lighten: 0 },
      { key: "t", lighten: 0.25 },
    ],
  },
];

// --- Cosmetic dyes ---------------------------------------------------------
//
// Every owned cosmetic can be recolored from a curated swatch grid. The
// swatches are drawn from colors already used elsewhere in the game's palette
// so a dyed cap never looks foreign against the forest.
//
// Swatch availability is TIERED BY PRICE RANK, which is how the three caps
// stay meaningfully different without touching a single price. Rank is derived
// from the existing cost table (cheapest = rank 0), so it cannot drift out of
// sync: the ladder now buys palette *breadth* rather than one fixed color.
// (The caps were already mechanically identical before dyes existed — all three
// are pure cosmetics with no stats — so this differentiates them rather than
// flattening them.)

export interface DyeSwatch {
  id: string;
  name: string;
  hex: string;
  /** Minimum cosmetic price-rank required to use this dye. */
  tier: 0 | 1 | 2;
}

export const DYE_SWATCHES: DyeSwatch[] = [
  { id: "forest", name: "Forest", hex: "#2e8642", tier: 0 },
  { id: "moss", name: "Moss", hex: "#48a85a", tier: 0 },
  { id: "oak", name: "Oak", hex: "#6e4c30", tier: 0 },
  { id: "bark", name: "Bark", hex: "#8a6440", tier: 0 },
  { id: "ash", name: "Ash", hex: "#8a8f98", tier: 0 },
  { id: "charcoal", name: "Charcoal", hex: "#2a2a2e", tier: 0 },
  { id: "ember", name: "Ember", hex: "#c9403a", tier: 1 },
  { id: "rust", name: "Rust", hex: "#e8823a", tier: 1 },
  { id: "sky", name: "Sky", hex: "#3a6ea5", tier: 1 },
  { id: "teal", name: "Teal", hex: "#3ab6a0", tier: 1 },
  { id: "plum", name: "Plum", hex: "#5a3a7a", tier: 1 },
  { id: "bone", name: "Bone", hex: "#ece7d6", tier: 2 },
  { id: "amber", name: "Amber", hex: "#ffd75e", tier: 2 },
  { id: "sakura", name: "Sakura", hex: "#d98cb8", tier: 2 },
  { id: "glacier", name: "Glacier", hex: "#bff6ff", tier: 2 },
  { id: "orchid", name: "Orchid", hex: "#e85ee0", tier: 2 },
];

/** A cosmetic's price rank among others of its own kind, cheapest first. */
export function cosmeticRank(spec: CosmeticSpec): number {
  const sameKind = COSMETICS.filter((c) => c.kind === spec.kind).sort((a, b) => a.cost - b.cost);
  return sameKind.findIndex((c) => c.id === spec.id);
}

/** Dyes this cosmetic can use. Tree skins get the full grid regardless of rank:
 * there are only two of them, they cost the same, and they're already
 * differentiated structurally (canopy vs trunk) rather than by price. */
export function unlockedSwatches(spec: CosmeticSpec): DyeSwatch[] {
  if (spec.kind === "treeSkin") return DYE_SWATCHES;
  const rank = cosmeticRank(spec);
  return DYE_SWATCHES.filter((s) => s.tier <= rank);
}

/** The palette to render a cosmetic with. Returns the shipped palette
 * unchanged when no dye is chosen — that identity is what guarantees every
 * pre-dye save keeps rendering exactly as it did. */
export function dyedPalette(
  spec: CosmeticSpec,
  hex: string | undefined,
): Record<string, string> {
  if (!hex) return spec.palette;
  const out: Record<string, string> = { ...spec.palette };
  for (const { key, lighten } of spec.dyeKeys) {
    out[key] = lighten > 0 ? mixHex(hex, "#ffffff", lighten) : hex;
  }
  return out;
}

// --- Team + Gacha economy (v3) ------------------------------------------
//
// Three gacha pools, single currency (wood): Worker (persistent team
// members), Item (per-member equipment, one pool per World), Power-up
// (account-wide permanent unlocks). See src/team.ts for per-member stat
// math and src/gacha.ts for the pull resolvers.

export type Rarity = "common" | "rare" | "epic" | "legendary";
export type ItemSlot = "woodchopping" | "adventuring" | "utility";

export const RARITY_ORDER: Rarity[] = ["common", "rare", "epic", "legendary"];
export const RARITY_WEIGHTS: Record<Rarity, number> = {
  common: 700,
  rare: 220,
  epic: 70,
  legendary: 10,
};
/** Duplicate-pull sink: shards of a rarity, spent on leveling. */
export const SHARD_VALUE: Record<Rarity, number> = {
  common: 1,
  rare: 5,
  epic: 25,
  legendary: 150,
};

// --- Worker Gacha ---------------------------------------------------------

/** Member combat class — a small, readable per-worker combat hook, wired
 * through battle.ts (see memberClass call sites there):
 *   - Bruiser: critical hits deal ×2 instead of the base ×1.5.
 *   - Warden: their Defend's party-wide mitigation lets 25% less through.
 *   - Scout: their first attack each battle deals +50% (first strike). */
export type WorkerClass = "bruiser" | "warden" | "scout";

export const WORKER_CLASS_INFO: Record<WorkerClass, { name: string; blurb: string }> = {
  bruiser: { name: "Bruiser", blurb: "Crits deal ×2 damage (base ×1.5)" },
  warden: { name: "Warden", blurb: "Their Defend blocks 25% more damage" },
  scout: { name: "Scout", blurb: "First attack each battle deals +50%" },
};

export interface WorkerDef {
  id: string;
  name: string;
  rarity: Rarity;
  class: WorkerClass;
  /** Small per-character palette overlay distinguishing this worker from
   * others in the same rarity tier — same accent mechanism as
   * adventure.ts's ENEMY_CHARACTERS (`accent: Record<string,string>`,
   * composed via sprites.ts's withPalette at every render site). Tweaks
   * that tier's own accent letter (rare `N` scarf, epic `H`/`h` hood,
   * legendary `Y`/`y` crown); common workers have no rarity-accent letter
   * of their own, so they instead get a subtle `C` cap-tint variation.
   * Deliberately a 10-15% hue/lightness nudge off the tier's base color —
   * reads as "distinct individual", not a re-theme. */
  accent?: Record<string, string>;
}

// Classes are spread so every rarity tier fields all three — no comp is
// locked out of a class by gacha luck at any spend level.
export const WORKER_DEFS: WorkerDef[] = [
  { id: "rook", name: "Rook", rarity: "common", class: "bruiser", accent: { C: "#c4453a" } },
  { id: "finch", name: "Finch", rarity: "common", class: "scout", accent: { C: "#b9403f" } },
  { id: "marl", name: "Marl", rarity: "common", class: "warden", accent: { C: "#c14a3a" } },
  { id: "sable", name: "Sable", rarity: "common", class: "bruiser", accent: { C: "#a83a42" } },
  { id: "birch", name: "Birch", rarity: "rare", class: "warden", accent: { N: "#34a998" } },
  { id: "hazel", name: "Hazel", rarity: "rare", class: "scout", accent: { N: "#3fbfa0" } },
  { id: "flint", name: "Flint", rarity: "rare", class: "bruiser", accent: { N: "#2fa3ac" } },
  { id: "wren", name: "Wren", rarity: "rare", class: "scout", accent: { N: "#45b18f" } },
  { id: "thorne", name: "Thorne", rarity: "epic", class: "bruiser", accent: { H: "#5f3672", h: "#47274f" } },
  { id: "ashgrove", name: "Ashgrove", rarity: "epic", class: "warden", accent: { H: "#4f3d82", h: "#392c60" } },
  { id: "cael", name: "Cael", rarity: "epic", class: "scout", accent: { H: "#653a74", h: "#4a2b57" } },
  { id: "ironbark", name: "Ironbark", rarity: "legendary", class: "warden", accent: { Y: "#f0c94e", y: "#f7e7a0" } },
  { id: "duskveil", name: "Duskveil", rarity: "legendary", class: "scout", accent: { Y: "#ffdb70", y: "#fff5c4" } },
  // Prestige-gated additions (see src/unlocks.ts) — full WorkerDef entries
  // like any other so every render/stat site works unchanged; they simply
  // don't enter pullWorker's pool until their unlock's prestige level.
  { id: "moss", name: "Moss", rarity: "rare", class: "warden", accent: { N: "#5aa63e" } },
  { id: "ember", name: "Ember", rarity: "epic", class: "bruiser", accent: { H: "#8a3a2e", h: "#642a20" } },
  { id: "sylva", name: "Sylva", rarity: "legendary", class: "bruiser", accent: { Y: "#c9e05a", y: "#eef7bc" } },
];
export const WORKER_DEFS_BY_ID: Record<string, WorkerDef> = Object.fromEntries(
  WORKER_DEFS.map((w) => [w.id, w]),
);

/** Multipliers over DEFAULT_WORKER_ATK/HP (see team.ts), by rarity. */
export const WORKER_RARITY_MULT: Record<Rarity, { atk: number; hp: number }> = {
  common: { atk: 1, hp: 1 },
  rare: { atk: 3, hp: 2 },
  epic: { atk: 10, hp: 5 },
  legendary: { atk: 30, hp: 12 },
};

export const WORKER_GACHA_COST = 100;
export const WORKER_GACHA_COST_10X = 900;
export const WORKER_PITY_THRESHOLD = 10; // guarantees Rare+

// --- Item Gacha (world-bound pools, 3 slots) ------------------------------

export interface WoodchoppingStats {
  atk?: number;
  yieldPct?: number;
  focusEfficiencyPct?: number;
  skillCheckWindowPct?: number;
}

export interface AdventuringStats {
  atk?: number;
  hp?: number;
  reflectPct?: number;
  expeditionBonusPct?: number;
}

export type UtilityPerkId = "fastRest" | "amberIncome" | "rareMapSpawn";

export interface UtilityStats {
  perk: UtilityPerkId;
  magnitude: number;
}

/** Mechanical perk hooks carried by epic/legendary items — data only, not
 * executed here. Consumed by the POV skill-check system (chainsawExecution)
 * and the Adventure combat resolver (the rest). */
export type ItemEffectId =
  | "chainsawExecution"
  | "timberSplash"
  | "frenzyBurst"
  | "logSlamReflect"
  | "vampiricHeal"
  | "bossBribe"
  | "lastStand"
  | "warCry";

export interface ItemDef {
  defId: string;
  slot: ItemSlot;
  world: number;
  rarity: Rarity;
  name: string;
  woodchopping?: WoodchoppingStats;
  adventuring?: AdventuringStats;
  utility?: UtilityStats;
  effectId?: ItemEffectId;
  effectMagnitude?: number;
}

/** atk(world, rarity) = 10^world × mult — cross-world parity: World N
 * Legendary (15×10^N) sits between World N+1 Common (10×10^N) and World
 * N+1 Rare (25×10^N), so a new world's pool is immediately useful without
 * obsoleting your best previous-world gear. */
export const RARITY_ITEM_MULT: Record<Rarity, number> = {
  common: 1,
  rare: 2.5,
  epic: 6,
  legendary: 15,
};

const UTILITY_RARITY_MAGNITUDE: Record<Rarity, number> = {
  common: 0.05,
  rare: 0.12,
  epic: 0.25,
  legendary: 0.45,
};

const UTILITY_PERKS: UtilityPerkId[] = ["fastRest", "amberIncome", "rareMapSpawn"];
const WOODCHOPPING_EFFECTS: ItemEffectId[] = ["chainsawExecution", "timberSplash", "frenzyBurst"];
const ADVENTURING_EFFECTS: ItemEffectId[] = [
  "logSlamReflect",
  "vampiricHeal",
  "bossBribe",
  "lastStand",
];

const ITEM_NAME_PREFIX: Record<Rarity, string> = {
  common: "Worn",
  rare: "Fine",
  epic: "Masterwork",
  legendary: "Mythic",
};

const SLOT_NOUN: Record<ItemSlot, string> = {
  woodchopping: "Axe",
  adventuring: "Blade",
  utility: "Charm",
};

const ITEM_SLOTS: ItemSlot[] = ["woodchopping", "adventuring", "utility"];

/** Secondary highRarity-only stats (yieldPct/focusEfficiencyPct/
 * skillCheckWindowPct on Woodchopping gear, expeditionBonusPct alongside
 * reflectPct on Adventuring gear) all stack together on one item rather
 * than rotating like effectId does — halved off the shared rarity
 * magnitude so a legendary item carrying all of them at once doesn't
 * approach the headline per-stat numbers a Pass-3-era single-stat item
 * would have implied. */
const SECONDARY_STAT_SCALE = 0.5;

/** Human-readable labels/blurbs for every ItemEffectId, shared by the item
 * picker (ui/team.ts), gacha reveal cards (ui/gacha.ts), and battle
 * narration (ui/battle.ts keeps its own copy for the Adventuring ones,
 * since it already existed pre-Pass-4 and reads fine standalone). */
export const ITEM_EFFECT_LABELS: Record<ItemEffectId, string> = {
  chainsawExecution: "Chainsaw Execution",
  timberSplash: "Timber Splash",
  frenzyBurst: "Frenzy Burst",
  logSlamReflect: "Log-Slam Reflect",
  vampiricHeal: "Vampiric Heal",
  bossBribe: "Boss Bribe",
  lastStand: "Last Stand",
  warCry: "War Cry",
};

export const ITEM_EFFECT_BLURBS: Record<ItemEffectId, string> = {
  chainsawExecution: "Great chop: chance to instantly fell the tree",
  timberSplash: "Chop damage splashes to 2 nearby trees",
  frenzyBurst: "Great chop: temporary faster swings",
  logSlamReflect: "Ability: reflects 25% of incoming damage for the rest of the fight",
  vampiricHeal: "Ability: heals the party for 30% of the enemy's max HP",
  bossBribe: "Ability: instantly defeats the boss (stage 5 only)",
  lastStand: "Ability: arms a one-time save against an otherwise-lethal hit",
  warCry: "Ability: +25% party ATK for the rest of the fight",
};

function buildItemDef(world: number, rarity: Rarity, slot: ItemSlot, _index: number): ItemDef {
  const worldMult = multForWorld(world);
  const rarityMult = RARITY_ITEM_MULT[rarity];
  const defId = `w${world}-${slot}-${rarity}`;
  const name = `${ITEM_NAME_PREFIX[rarity]} ${getWorld(world).name} ${SLOT_NOUN[slot]}`;
  const highRarity = rarity === "epic" || rarity === "legendary";
  // Which effect/perk an item gets used to be a pure function of `index`,
  // which — per itemDefsForWorld's loop — is itself a pure function of
  // (rarity, slot) alone: every world builds the exact same pool ordering,
  // so `index % N` always landed on the same array element for a given
  // (rarity, slot), making most of WOODCHOPPING_EFFECTS/ADVENTURING_EFFECTS/
  // UTILITY_PERKS permanently unobtainable (e.g. every Utility item in the
  // game was "rareMapSpawn", forever). Folding `world` into the rotation
  // spreads every entry across the world ladder instead, while staying
  // fully deterministic from (world, rarity, slot) — itemDefById already
  // reconstructs all three from a defId, so this needs no new persisted
  // state. `index` is kept only to satisfy existing callers.
  const rot = world + RARITY_ORDER.indexOf(rarity);

  if (slot === "woodchopping") {
    const secondary = highRarity ? UTILITY_RARITY_MAGNITUDE[rarity] * SECONDARY_STAT_SCALE : undefined;
    const def: ItemDef = {
      defId,
      slot,
      world,
      rarity,
      name,
      woodchopping: {
        atk: worldMult * rarityMult,
        yieldPct: secondary,
        focusEfficiencyPct: secondary,
        skillCheckWindowPct: secondary,
      },
    };
    if (highRarity) {
      def.effectId = WOODCHOPPING_EFFECTS[rot % WOODCHOPPING_EFFECTS.length];
      def.effectMagnitude = UTILITY_RARITY_MAGNITUDE[rarity];
    }
    return def;
  }

  if (slot === "adventuring") {
    const secondary = highRarity ? UTILITY_RARITY_MAGNITUDE[rarity] * 0.4 : undefined;
    const def: ItemDef = {
      defId,
      slot,
      world,
      rarity,
      name,
      adventuring: {
        atk: worldMult * rarityMult,
        hp: worldMult * rarityMult * 5,
        reflectPct: secondary,
        expeditionBonusPct: secondary,
      },
    };
    if (highRarity) {
      // warCry (prestige-content, see unlocks.ts): every EPIC Adventuring
      // item from the worlds beyond the base ladder cap carries the new
      // ability instead of its rotation slot — those worlds are themselves
      // prestige-gated, so the effect's availability rides the world
      // unlock. An explicit override (not an append to ADVENTURING_EFFECTS)
      // so no defId below the cap ever remaps. Legendaries keep rotating.
      def.effectId =
        rarity === "epic" && world > BASE_WORLD_CAP
          ? "warCry"
          : ADVENTURING_EFFECTS[rot % ADVENTURING_EFFECTS.length];
      def.effectMagnitude = UTILITY_RARITY_MAGNITUDE[rarity];
    }
    return def;
  }

  // utility: no atk/hp, a passive perk + rarity-scaled magnitude.
  return {
    defId,
    slot,
    world,
    rarity,
    name,
    utility: { perk: UTILITY_PERKS[rot % UTILITY_PERKS.length], magnitude: UTILITY_RARITY_MAGNITUDE[rarity] },
  };
}

/** Legacy axes (pre-v3 saves) kept as static Woodchopping items so
 * migration preserves exact old chop damage — see game-state.ts. */
export const LEGACY_AXE_ITEMS: ItemDef[] = AXES.map((axe, i) => ({
  defId: `legacy-axe-${i}`,
  slot: "woodchopping" as ItemSlot,
  world: 0,
  rarity: "common" as Rarity,
  name: axe.name,
  woodchopping: { atk: axe.damage },
}));
const LEGACY_AXE_ITEMS_BY_ID: Record<string, ItemDef> = Object.fromEntries(
  LEGACY_AXE_ITEMS.map((d) => [d.defId, d]),
);

const itemPoolCache = new Map<number, ItemDef[]>();

/** One 12-item pool (4 rarities × 3 slots) per World, unlocked as the player
 * reaches that world via the existing travel gate. Built lazily on first
 * access per world instead of eagerly for every world at module load. */
export function itemDefsForWorld(world: number): ItemDef[] {
  const cached = itemPoolCache.get(world);
  if (cached) return cached;
  const defs: ItemDef[] = [];
  let i = 0;
  for (const rarity of RARITY_ORDER) {
    for (const slot of ITEM_SLOTS) {
      defs.push(buildItemDef(world, rarity, slot, i));
      i++;
    }
  }
  itemPoolCache.set(world, defs);
  return defs;
}

const ITEM_DEF_ID_RE = /^w(\d+)-(woodchopping|adventuring|utility)-(common|rare|epic|legendary)$/;

/** Reconstructs an ItemDef from its id deterministically — no precomputed
 * table needed, so this works for any world index without pre-sizing
 * anything. Legacy `legacy-axe-N` ids are checked first (unchanged from the
 * old static-table behavior). */
export function itemDefById(defId: string): ItemDef | null {
  const legacy = LEGACY_AXE_ITEMS_BY_ID[defId];
  if (legacy) return legacy;
  const match = ITEM_DEF_ID_RE.exec(defId);
  if (!match) return null;
  const world = Number(match[1]);
  const slot = match[2] as ItemSlot;
  const rarity = match[3] as Rarity;
  // Reproduces the exact index assignment of itemDefsForWorld's double loop:
  // i = RARITY_ORDER.indexOf(rarity) * ITEM_SLOTS.length + ITEM_SLOTS.indexOf(slot).
  const index = RARITY_ORDER.indexOf(rarity) * ITEM_SLOTS.length + ITEM_SLOTS.indexOf(slot);
  return buildItemDef(world, rarity, slot, index);
}

export const ITEM_GACHA_BASE_COST = 150; // wood, × 10^world
export const ITEM_PITY_THRESHOLD = 15; // guarantees Epic+, tracked per world pool

export function itemGachaCost(world: number): number {
  return ITEM_GACHA_BASE_COST * multForWorld(world);
}

export function itemGachaCost10x(world: number): number {
  return Math.round(itemGachaCost(world) * 9); // 10% off a straight 10x
}

// --- Power-up Gacha (account-wide, closed pool) ---------------------------

export type PowerupId =
  | "swiftBoots"
  | "keenEdge"
  | "amberVein"
  | "luckyCharm"
  | "extraUtility"
  | "travelDiscount"
  | "goldenSense"
  | "forestBlessing"
  | "packMule";

export interface PowerupSpec {
  id: PowerupId;
  rarity: Rarity;
  name: string;
  blurb: string;
}

export const POWERUPS: PowerupSpec[] = [
  { id: "swiftBoots", rarity: "common", name: "Swift Boots", blurb: "+50% woodcutter walk speed" },
  { id: "keenEdge", rarity: "common", name: "Keen Edge", blurb: "+25% chop speed" },
  { id: "amberVein", rarity: "rare", name: "Amber Vein", blurb: "+20% Amber income" },
  { id: "luckyCharm", rarity: "rare", name: "Lucky Charm", blurb: "-2 pulls to all pity counters" },
  { id: "extraUtility", rarity: "epic", name: "Extra Utility", blurb: "+1 Utility slot per member" },
  { id: "travelDiscount", rarity: "epic", name: "Travel Discount", blurb: "-25% world travel cost" },
  { id: "goldenSense", rarity: "legendary", name: "Golden Sense", blurb: "+50% Golden Log spawn rate" },
  { id: "forestBlessing", rarity: "legendary", name: "Forest Blessing", blurb: "+15% global wood yield" },
  // Prestige-gated (see unlocks.ts) — absent from pullPowerup's pool until
  // its unlock's prestige level.
  { id: "packMule", rarity: "epic", name: "Pack Mule", blurb: "Carry 3 provisions on a run (was 2)" },
];

export const POWERUP_GACHA_COST = 500;
export const POWERUP_GACHA_COST_10X = 4500;
export const POWERUP_PITY_THRESHOLD = 20; // guarantees Epic+

// --- Adventure mode: provisions + cost constants ---------------------------
//
// Combat math itself lives in src/adventure.ts (pure, no DOM). Provisions
// are shop-purchasable items the team can carry on a run — distinct from
// Adventuring-slot equipment, which comes from the Item Gacha above.

// Priced against the (rebalanced) stage-1 reward of 25 wood so a starter's
// first win is clearly profitable (embark -> 25 back) at ANY party size, not
// just solo — flat per run, not per member, so a bigger party (already a
// real tactical tradeoff: thinner roster, more members exposed to death
// risk) doesn't also eat an extra wood tax that a full-party stage-1 win
// can't pay back.
export const ADVENTURE_EMBARK_BASE = 15; // wood, × world mult (flat, no party-size scaling)
export const ADVENTURE_CONTINUE_BASE = 8; // wood, × nextStage × world mult
// Flat amber cost, no world-mult scaling — unlike embarkCost/continueFee's
// wood fees, amber's actual income sources (ambient chop-based accrual,
// chest amber, in-run combat amber) barely scale with world tier, so a
// mult-scaled revive quickly becomes unaffordable at every tier past the
// first (it was ballooning to the billions by world 6). Priced flat instead,
// matching how every other amber cost in BOOSTS/PROVISIONS already works:
// between espresso's 150 and emergencyRope's 200 (PROVISIONS below) — a
// full-party revive-to-full is stronger than either of those, but shouldn't
// be priced wildly outside the amber costs a player already sees on the same
// reward screens.
export const ADVENTURE_REVIVE_BASE_COST = 175; // amber, flat — no world-mult scaling

export type ProvisionId = "trailRations" | "fortuneCharm" | "emergencyRope";

export interface ProvisionSpec {
  id: ProvisionId;
  name: string;
  blurb: string;
  cost: number;
  currency: "wood" | "amber";
  /** Trail Rations: bought and used immediately, never carried in inventory. */
  instant?: boolean;
}

export const PROVISIONS: ProvisionSpec[] = [
  {
    id: "trailRations",
    name: "Trail Rations",
    blurb: "Heal your whole roster to full HP",
    cost: 150,
    currency: "wood",
    instant: true,
  },
  {
    id: "fortuneCharm",
    name: "Fortune Charm",
    blurb: "Carry: +10% party damage for the whole run",
    cost: 120,
    currency: "amber",
  },
  {
    id: "emergencyRope",
    name: "Emergency Rope",
    blurb: "Carry: turns one loss into a narrow escape",
    cost: 200,
    currency: "amber",
  },
];
