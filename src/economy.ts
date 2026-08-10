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
  ground: string;
  tuft: string;
}

export const WORLDS: WorldSpec[] = [
  {
    name: "Greenwood",
    mult: 1,
    travelCost: 0,
    plotGate: 0,
    palette: null,
    ground: "#3e7c4a",
    tuft: "#356b40",
  },
  {
    name: "Autumn Lands",
    mult: 10,
    travelCost: 800,
    plotGate: 3,
    palette: { G: "#b8622a", g: "#d98c3f" },
    ground: "#7a5c30",
    tuft: "#68491f",
  },
  {
    name: "Snowreach",
    mult: 100,
    travelCost: 8_000,
    plotGate: 3,
    palette: { G: "#3e7c6e", g: "#cfe8e2" },
    ground: "#c9d4d8",
    tuft: "#a8b8bf",
  },
  {
    name: "Emberwaste",
    mult: 1_000,
    travelCost: 80_000,
    plotGate: 4,
    palette: { G: "#8a3a2a", g: "#d9603f" },
    ground: "#4a3038",
    tuft: "#3a2028",
  },
  {
    name: "Crystal Hollow",
    mult: 10_000,
    travelCost: 800_000,
    plotGate: 4,
    palette: { G: "#6a5acf", g: "#b9a8f2", T: "#4a4468", t: "#6a6488" },
    ground: "#3a3a5c",
    tuft: "#2c2c48",
  },
];

/** Wood paid when a tree of this kind falls (× world mult). */
export const WOOD_YIELD: Record<string, number> = {
  small: 1,
  medium: 3,
  large: 5,
  elder: 50,
};

export type HelperId = "boots" | "keenEdge" | "gnome1" | "gnome2" | "gnomeHaste";

export interface HelperSpec {
  id: HelperId;
  name: string;
  blurb: string;
  cost: number;
  /** Helper that must be owned first (upgrade chains). */
  requires?: HelperId;
}

export const HELPERS: HelperSpec[] = [
  { id: "boots", name: "Swift Boots", blurb: "Walk 50% faster", cost: 300 },
  { id: "keenEdge", name: "Keen Edge", blurb: "Chop 25% faster", cost: 1_500 },
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
export const FOCUS_CAP = 100;
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
    cost: 100,
  },
];

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
}

export const COSMETICS: CosmeticSpec[] = [
  { id: "capBlue", name: "Blue Cap", kind: "cap", cost: 50, palette: { C: "#3a6ea5" } },
  { id: "capBlack", name: "Black Cap", kind: "cap", cost: 100, palette: { C: "#2a2a2e" } },
  { id: "capGold", name: "Gold Cap", kind: "cap", cost: 200, palette: { C: "#e6b93c" } },
  {
    id: "treeSakura",
    name: "Sakura Grove",
    kind: "treeSkin",
    cost: 500,
    palette: { G: "#d98cb8", g: "#f2c2dc" },
  },
  {
    id: "treeBirch",
    name: "Silver Birch",
    kind: "treeSkin",
    cost: 500,
    palette: { T: "#d8d8d0", t: "#f0f0e8" },
  },
];
