// Isaac-style permanent unlock registry, gated by prestige level. Each
// prestige "beats a run" (reaches the current ladder cap — see
// maxWorldIndex/Game.prestigeStatus) and permanently widens the content
// pools: new boons join drawBoonOffer's pool, new workers join the Worker
// Gacha, new power-ups join the Power-up Gacha, a new item effect arrives on
// high-world Adventuring gear, and the travelable world ladder itself grows
// one world per prestige beyond the base cap.
//
// Pure data + predicates — no DOM. Pool wiring lives at each pool's own
// draw site (boons.ts's offerableBoons, gacha.ts's pullWorker/pullPowerup,
// Game.travelStatus/prestigeStatus); reveal/list UI lives in ui/unlocks.ts.
// Anything NOT named in UNLOCKS is unlocked from the start — the registry
// enumerates the gated additions, not the whole content catalog.

import { BASE_WORLD_CAP, CURATED_WORLD_THEMES } from "./economy";

export { BASE_WORLD_CAP };

export type UnlockKind = "boon" | "worker" | "powerup" | "itemEffect" | "world";

export interface UnlockEntry {
  kind: UnlockKind;
  /** BoonId / worker defId / PowerupId / ItemEffectId / world index as a
   * string — what the gate at the pool's draw site matches against. */
  refId: string;
  name: string;
  blurb: string;
  /** Prestige level at which this entry joins its pool. */
  prestige: number;
}

/** Highest travelable world index for a given prestige level — also the
 * prestige-eligibility point: reaching this cap is what "beats the run". */
export function maxWorldIndex(prestigeLevel: number): number {
  return Math.min(BASE_WORLD_CAP + prestigeLevel, CURATED_WORLD_THEMES.length - 1);
}

const WORLD_UNLOCKS: UnlockEntry[] = CURATED_WORLD_THEMES.slice(BASE_WORLD_CAP + 1).map(
  (theme, i) => ({
    kind: "world",
    refId: String(BASE_WORLD_CAP + 1 + i),
    name: theme.name,
    blurb: `A new world joins the travel ladder: ${theme.name}.`,
    prestige: i + 1,
  }),
);

export const UNLOCKS: UnlockEntry[] = [
  {
    kind: "boon",
    refId: "lumberBlessing",
    name: "Lumber Blessing",
    blurb: "New boon: +20% wood from every stage cleared this run, per stack.",
    prestige: 1,
  },
  {
    kind: "worker",
    refId: "moss",
    name: "Moss",
    blurb: "New Rare worker joins the Worker Gacha pool.",
    prestige: 1,
  },
  {
    kind: "itemEffect",
    refId: "warCry",
    name: "War Cry",
    blurb: "New ability on Epic Adventuring gear from the newly-opened worlds: +25% party ATK for the rest of the fight.",
    prestige: 1,
  },
  {
    kind: "boon",
    refId: "battleTrance",
    name: "Battle Trance",
    blurb: "New boon: +5% party ATK and +5% crit chance per stack.",
    prestige: 2,
  },
  {
    kind: "worker",
    refId: "ember",
    name: "Ember",
    blurb: "New Epic worker joins the Worker Gacha pool.",
    prestige: 2,
  },
  {
    kind: "powerup",
    refId: "packMule",
    name: "Pack Mule",
    blurb: "New Epic power-up: carry 3 provisions on a run instead of 2.",
    prestige: 2,
  },
  {
    kind: "worker",
    refId: "sylva",
    name: "Sylva",
    blurb: "New Legendary worker joins the Worker Gacha pool.",
    prestige: 3,
  },
  ...WORLD_UNLOCKS,
];

const GATED_BY_KIND = new Map<UnlockKind, Map<string, number>>();
for (const entry of UNLOCKS) {
  let byRef = GATED_BY_KIND.get(entry.kind);
  if (!byRef) {
    byRef = new Map();
    GATED_BY_KIND.set(entry.kind, byRef);
  }
  byRef.set(entry.refId, entry.prestige);
}

/** True when this (kind, refId) may appear in its pool at this prestige
 * level. Entries absent from the registry are always unlocked. */
export function isUnlocked(kind: UnlockKind, refId: string, prestigeLevel: number): boolean {
  const needed = GATED_BY_KIND.get(kind)?.get(refId);
  return needed === undefined || prestigeLevel >= needed;
}

/** What a single prestige level's ding just opened — the reveal cards. */
export function unlocksAtLevel(prestigeLevel: number): UnlockEntry[] {
  return UNLOCKS.filter((u) => u.prestige === prestigeLevel);
}
