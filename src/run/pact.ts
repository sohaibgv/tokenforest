// The Pact of the Grove — opt-in difficulty, and the reason the mode still has
// something to offer after it has been beaten.
//
// Every roguelike eventually runs out of content for the player who has seen
// all of it, and the usual answer — more content — only postpones the problem.
// Hades' answer was to let the player make the game harder on purpose, in named
// increments, for better rewards. That converts "I have solved this" from an
// ending into a starting position, and it costs a fraction of what new content
// costs.
//
// Two rules keep it honest:
//
//   1. EVERY MODIFIER IS LEGIBLE. "Enemies have 25% more health" is a decision.
//      "Difficulty: Hard" is not. Each modifier says exactly what it does and
//      exactly what it is worth.
//
//   2. THE REWARD IS PROPORTIONAL AND VISIBLE BEFORE COMMITTING. Grove Rank
//      multiplies the run's wood, amber and shard payout, and the multiplier is
//      shown at Muster next to the modifiers producing it. A player should be
//      able to price the risk before taking it.
//
// Unlocked after a first full clear: offering difficulty modifiers to someone
// who has not yet finished a run is offering them a way to lose faster.

export type PactId =
  | "thickerHide"
  | "leanOfferings"
  | "dryWells"
  | "deathRattle"
  | "sharpTeeth"
  | "thinPurse";

export interface PactDef {
  id: PactId;
  name: string;
  /** Reads as a plain statement of fact — see rule 1. */
  blurb: string;
  /** Grove Rank this modifier is worth. Higher for the ones that change how a
   * run must be PLAYED rather than how long it takes. */
  rank: number;
}

export const PACT_DEFS: PactDef[] = [
  { id: "thickerHide", name: "Thicker Hide", blurb: "Every enemy has 25% more health.", rank: 1 },
  { id: "sharpTeeth", name: "Sharp Teeth", blurb: "Every enemy deals 20% more damage.", rank: 1 },
  { id: "leanOfferings", name: "Lean Offerings", blurb: "Every boon offer shows one card fewer.", rank: 2 },
  { id: "dryWells", name: "Dry Wells", blurb: "No fountains. Nothing will heal you between rooms.", rank: 2 },
  { id: "thinPurse", name: "Thin Purse", blurb: "Half acorns. The trader will not be waiting for you.", rank: 1 },
  { id: "deathRattle", name: "Death Rattle", blurb: "Every Depth boss fights on after it falls.", rank: 3 },
];

export const PACT_DEFS_BY_ID: Record<PactId, PactDef> = Object.fromEntries(
  PACT_DEFS.map((p) => [p.id, p]),
) as Record<PactId, PactDef>;

export function groveRank(active: PactId[]): number {
  return active.reduce((sum, id) => sum + (PACT_DEFS_BY_ID[id]?.rank ?? 0), 0);
}

/** Payout multiplier for a given Grove Rank.
 *
 * Deliberately superlinear: each rank is worth slightly more than the last, so
 * stacking modifiers is rewarded rather than merely tolerated. Capped so that
 * no amount of self-punishment turns Adventure into a better wood source than
 * actually chopping — the mode is meant to complement the idle economy, not
 * replace it. */
export function grovePayoutMult(rank: number): number {
  return Math.min(4, 1 + 0.18 * rank + 0.02 * rank * rank);
}

/** Enemy HP and damage scaling from the active pact. Returned as a pair so
 * enemy construction has one place to ask. */
export function pactEnemyScaling(active: PactId[]): {
  hp: number;
  atk: number;
  bossRevives: boolean;
} {
  return {
    hp: active.includes("thickerHide") ? 1.25 : 1,
    atk: active.includes("sharpTeeth") ? 1.2 : 1,
    bossRevives: active.includes("deathRattle"),
  };
}

/** Fraction of its health a Death Rattle boss returns with. Enough that the
 * second phase is a real fight, low enough that it is a sting rather than a
 * repeat of the whole encounter. */
export const DEATH_RATTLE_HP = 0.4;
