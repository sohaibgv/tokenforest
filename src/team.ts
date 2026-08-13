// Persistent gacha-pulled team roster: per-member stats, equipment, and
// leveling. Replaces the old single global ownedAxe/helpers economy.

import {
  itemDefById,
  multForWorld,
  RARITY_ORDER,
  WORKER_DEFS_BY_ID,
  WORKER_RARITY_MULT,
  type ItemDef,
  type ItemSlot,
  type Rarity,
  type WorkerClass,
} from "./economy";

export type { ItemSlot, Rarity, WorkerClass };

export interface ItemInstance {
  id: string; // unique instance id, e.g. "i-7"
  defId: string; // -> ItemDef in economy.ts
}

export type TeamMemberStatus = "available" | "resting" | "adventuring";

export interface TeamMemberSave {
  id: string; // "m-3"
  defId: string; // -> WorkerDef in economy.ts
  level: number; // 1..MAX_LEVEL
  /** Battle XP toward the next level (see grantXp/xpToNext). Optional so
   * pre-XP saves read as 0 — same additive pattern as equipped.utility2. */
  xp?: number;
  currentHp: number;
  maxHp: number;
  status: TeamMemberStatus;
  equipped: {
    woodchopping: string | null; // ItemInstance id
    adventuring: string | null;
    utility: string | null;
    /** Second Utility slot, usable only once the extraUtility Power-up is
     * owned (see Game.hasPowerup/equipItem) — optional so every save from
     * before this field existed just reads as "not equipped" with no
     * migration needed (same additive pattern as AdventureLogEntry.amberGained
     * in game-state.ts). */
    utility2?: string | null;
  };
  /** Merges applied at the Fusion Altar. 0 (or absent) = as pulled.
   *
   * Optional so every save written before fusion existed reads as 0 with no
   * migration step — the same additive pattern `xp` above uses.
   *
   * This is a SEPARATE AXIS from `level`. Level is what a member earns by
   * fighting; stars are what you spend other members to buy. Conflating them
   * was considered and rejected: a merge that also reset or raised the level
   * cap would make the two currencies interchangeable, and then only one of
   * them would matter. */
  starRank?: number;
}

export const DEFAULT_WORKER_ATK = 1;
export const DEFAULT_WORKER_HP = 10;
export const MAX_LEVEL = 20;
export const LEVEL_STAT_STEP = 0.05; // +5%/level, multiplicative
/** Base atk/hp gain per merge, ON TOP of the tier jump the merge also grants.
 * The tier jump is the big number (common->rare is x3 atk); this is the small
 * one that makes a merged Rare worth slightly more than a pulled Rare, so
 * investment is never strictly worse than luck. */
export const STAR_STAT_BONUS = 0.2;

export function levelMult(level: number): number {
  return 1 + (level - 1) * LEVEL_STAT_STEP;
}

/** A member's rarity AFTER merges — the single source of truth for anything
 * that asks "how good is this worker".
 *
 * Nothing outside this file should read `WORKER_DEFS_BY_ID[defId].rarity` for
 * a LIVE member again; that field is now only the starting point. The def's
 * rarity still governs anything about the character rather than the instance
 * (gacha pool membership, sprite tier, prestige unlocks).
 *
 * This lives here rather than in fusion.ts on purpose: `baseStats` below needs
 * it, and fusion.ts needs `TeamMemberSave` from here. Putting it there would
 * make team.ts <-> fusion.ts a value cycle — the same trap that moved
 * PLAYER_CRIT_CHANCE out of battle.ts. Dependencies run one way: fusion.ts
 * imports team.ts, never the reverse. */
export function effectiveRarity(member: TeamMemberSave): Rarity {
  const def = WORKER_DEFS_BY_ID[member.defId];
  const base = RARITY_ORDER.indexOf(def?.rarity ?? "common");
  const idx = Math.min(base + (member.starRank ?? 0), RARITY_ORDER.length - 1);
  return RARITY_ORDER[idx];
}

/** Stars to draw, 1-based. Stars encode the TIER, not the history: a pulled
 * Legendary and a Common merged three times both show four stars, because
 * they are the same thing and a badge that claimed otherwise would be lying
 * about power the member does not have. */
export function starCount(member: TeamMemberSave): number {
  return RARITY_ORDER.indexOf(effectiveRarity(member)) + 1;
}

/** Exactly 1 at rank 0 — which is bit-exact in IEEE 754, so folding this into
 * baseStats cannot perturb a single existing save's arithmetic. That is what
 * makes the SIM_IDENTITY baseline a real proof rather than a formality. */
export function starMult(member: TeamMemberSave): number {
  return 1 + STAR_STAT_BONUS * (member.starRank ?? 0);
}

export function levelUpCost(member: TeamMemberSave): number {
  return member.level * 10;
}

/** The member's combat class (see economy.ts WORKER_CLASS_INFO for the
 * hooks) — falls back to bruiser for an unknown defId, same defensive
 * default baseStats uses for rarity. */
export function memberClass(member: TeamMemberSave): WorkerClass {
  return WORKER_DEFS_BY_ID[member.defId]?.class ?? "bruiser";
}

// --- Battle XP -------------------------------------------------------------
//
// Won fights grant XP (see stageXpReward + Game.finalizeBattleOutcome / the
// sim's run driver); levels gained this way run through the exact same
// `level`/`levelMult` math as shard leveling — the two are complementary
// sinks, XP from fighting and shards from gacha dupes.

/** XP needed to go from `level` to `level + 1`. Linear ramp: one full
 * World-0 clear (~180 XP, see stageXpReward) takes a fresh member to level
 * 3 — meaningful early momentum — while later levels each demand multiple
 * clears, so battle XP never outpaces the shard sink. */
export function xpToNext(level: number): number {
  return 40 * level;
}

/** Per-member XP for winning a stage fight: scales with the stage number
 * and, gently, the world tier (higher worlds are equally hard tier-matched
 * fights — see team.ts's gear-carry — so the world term is mild catch-up,
 * not a farming multiplier). Deliberately below xpToNext(1) for a stage-1
 * win, so farming the first stage can't level anyone past the stage-2
 * roster gate (sim-asserted). */
export function stageXpReward(stage: number, world: number): number {
  return Math.round(stage * 12 * (1 + 0.25 * world));
}

/** Adds XP and auto-levels through the standard level math (capped at
 * MAX_LEVEL; leftover XP is kept toward the next level). Returns levels
 * gained so callers can surface a "level up!" beat. */
export function grantXp(
  member: TeamMemberSave,
  amount: number,
  inventory: ItemInstance[],
  prestigeLevel = 0,
): number {
  member.xp = (member.xp ?? 0) + amount;
  let gained = 0;
  while (member.level < MAX_LEVEL && member.xp >= xpToNext(member.level)) {
    member.xp -= xpToNext(member.level);
    member.level += 1;
    gained += 1;
  }
  if (member.level >= MAX_LEVEL) member.xp = 0; // nothing left to level into
  if (gained > 0) syncHp(member, inventory, prestigeLevel);
  return gained;
}

export function createMember(defId: string, seq: number, prestigeLevel = 0): TeamMemberSave {
  const member: TeamMemberSave = {
    id: `m-${seq}`,
    defId,
    level: 1,
    currentHp: 0,
    maxHp: 0,
    status: "available",
    equipped: { woodchopping: null, adventuring: null, utility: null, utility2: null },
  };
  syncHp(member, [], prestigeLevel);
  member.currentHp = member.maxHp;
  return member;
}

/** Base rarity/level stats, "carried" to the tier of the member's equipped
 * Adventuring gear: the gear's own world mult (10^world) scales the wearer's
 * base atk/hp along with it. Without this, base stats are flat while both
 * gear and enemies scale ×10^world, so the base-stat cushion that dominates
 * World-0 fights vanishes at higher worlds and tier-matched win rates drift
 * far apart (the sim's cross-world parity check). With it, a tier-matched
 * loadout makes every world's fight play out exactly like World 0 — the
 * combat version of the axe/tree invariant in economy.ts's header — while a
 * gearless member still can't punch above World 0. */
function baseStats(member: TeamMemberSave, inventory: ItemInstance[]): { atk: number; hp: number } {
  // Reads the member's EFFECTIVE rarity, so a merge moves them along the same
  // WORKER_RARITY_MULT ladder a luckier pull would have put them on. This one
  // lookup is the whole stat integration — effectiveAtk, effectiveMaxHp,
  // syncHp, the battle engine, the adventure preview and the sim all inherit
  // it without a line of their own.
  const mult = WORKER_RARITY_MULT[effectiveRarity(member)];
  const carry = multForWorld(equippedItem(member, "adventuring", inventory)?.world ?? 0);
  // `stars` is appended rather than woven into the existing product: at rank 0
  // it is exactly 1.0, and multiplying by 1.0 is exact, so the factor order
  // this file's callers depend on is untouched for every pre-fusion save.
  const stars = starMult(member);
  return {
    atk: DEFAULT_WORKER_ATK * mult.atk * carry * stars,
    hp: DEFAULT_WORKER_HP * mult.hp * carry * stars,
  };
}

export function equippedItem(
  member: TeamMemberSave,
  slot: ItemSlot | "utility2",
  inventory: ItemInstance[],
): ItemDef | null {
  const instId = slot === "utility2" ? (member.equipped.utility2 ?? null) : member.equipped[slot];
  if (!instId) return null;
  const inst = inventory.find((i) => i.id === instId);
  if (!inst) return null;
  return itemDefById(inst.defId);
}

/** Tree-damage ATK: base rarity stat × level, plus equipped Woodchopping/
 * Adventuring item ATK, plus a permanent +10%/level Prestige bonus. */
export function effectiveAtk(
  member: TeamMemberSave,
  inventory: ItemInstance[],
  prestigeLevel = 0,
): number {
  const { atk } = baseStats(member, inventory);
  const wood = equippedItem(member, "woodchopping", inventory);
  const adv = equippedItem(member, "adventuring", inventory);
  const itemAtk = (wood?.woodchopping?.atk ?? 0) + (adv?.adventuring?.atk ?? 0);
  return (atk * levelMult(member.level) + itemAtk) * (1 + 0.1 * prestigeLevel);
}

export function effectiveMaxHp(
  member: TeamMemberSave,
  inventory: ItemInstance[],
  prestigeLevel = 0,
): number {
  const { hp } = baseStats(member, inventory);
  const adv = equippedItem(member, "adventuring", inventory);
  const itemHp = adv?.adventuring?.hp ?? 0;
  return Math.max(1, Math.round((hp * levelMult(member.level) + itemHp) * (1 + 0.1 * prestigeLevel)));
}

/** Resync maxHp after level/equip changes; clamps currentHp down if maxHp shrank. */
export function syncHp(member: TeamMemberSave, inventory: ItemInstance[], prestigeLevel = 0): void {
  const maxHp = effectiveMaxHp(member, inventory, prestigeLevel);
  member.maxHp = maxHp;
  member.currentHp = Math.max(0, Math.min(member.currentHp, maxHp));
}

// --- Item comparison -------------------------------------------------------
//
// One scoring function per slot, shared by everything that has to rank gear:
// the auto-equip pass, the "there is something better in your bag" badges, and
// the item picker's ordering. They were previously three separate inline
// expressions, which is how a picker ends up disagreeing with the optimiser
// about which sword is the good one.

export function itemScore(def: ItemDef): number {
  if (def.slot === "woodchopping") return def.woodchopping?.atk ?? 0;
  if (def.slot === "adventuring") {
    // hp is 5x atk on every generated item (see economy.ts's buildItemDef), so
    // dividing by five weighs the two stats evenly rather than letting hp
    // dominate the ranking purely by being numerically larger.
    return (def.adventuring?.atk ?? 0) + (def.adventuring?.hp ?? 0) / 5;
  }
  return def.utility?.magnitude ?? 0;
}

/** Item instance ids that some member is currently wearing. */
export function equippedInstanceIds(members: TeamMemberSave[]): Set<string> {
  const used = new Set<string>();
  for (const m of members) {
    for (const id of [m.equipped.woodchopping, m.equipped.adventuring, m.equipped.utility, m.equipped.utility2]) {
      if (id) used.add(id);
    }
  }
  return used;
}

/**
 * The best UNEQUIPPED item that would beat what this member has in `slot`, or
 * null if nothing in the bag is an improvement.
 *
 * Deliberately ignores items other members are wearing. "You could take Rook's
 * axe" is true but useless as a badge — it would light up half the roster
 * permanently and mean nothing. This answers the question the player is
 * actually asking: is there something sitting unused that I should put on?
 */
export function bestUpgradeFor(
  member: TeamMemberSave,
  slot: ItemSlot | "utility2",
  inventory: ItemInstance[],
  members: TeamMemberSave[],
): ItemDef | null {
  const baseSlot: ItemSlot = slot === "utility2" ? "utility" : slot;
  const currentDef = equippedItem(member, slot, inventory);
  const currentScore = currentDef ? itemScore(currentDef) : 0;
  const used = equippedInstanceIds(members);

  let best: ItemDef | null = null;
  let bestScore = currentScore;
  for (const inst of inventory) {
    if (used.has(inst.id)) continue;
    const def = itemDefById(inst.defId);
    if (!def || def.slot !== baseSlot) continue;
    const score = itemScore(def);
    if (score > bestScore) {
      bestScore = score;
      best = def;
    }
  }
  return best;
}

/** How strong a member is overall, for ranking the roster.
 *
 * Attack and health folded into one number the same way item scoring folds
 * them, so "strongest" means the same thing in both places. */
export function memberPower(
  member: TeamMemberSave,
  inventory: ItemInstance[],
  prestigeLevel = 0,
): number {
  return effectiveAtk(member, inventory, prestigeLevel) + effectiveMaxHp(member, inventory, prestigeLevel) / 5;
}

/**
 * Sorts the roster strongest-first, IN PLACE.
 *
 * Roster order is not cosmetic: index 0 is the first member assigned to a live
 * chopping session, and it is the priority order optimizeEquipment hands gear
 * out in. Before this the order was whatever sequence members happened to be
 * pulled in, so auto-equipping could hand a legendary axe to the weakest
 * member on the list — the helper looked like it had done something and had in
 * fact made things worse.
 */
export function sortRosterByPower(
  members: TeamMemberSave[],
  inventory: ItemInstance[],
  prestigeLevel = 0,
): void {
  members.sort((a, b) => memberPower(b, inventory, prestigeLevel) - memberPower(a, inventory, prestigeLevel));
}

// --- Optimize Gear (QoL) ---------------------------------------------------

/** Greedy whole-roster re-equip, by roster priority order (index 0 first —
 * the same "first assigned to a live session" priority the roster already
 * encodes): each member takes the best still-unassigned item per slot.
 * Rankings: Woodchopping by atk; Adventuring by atk + hp/5 (hp is 5× atk on
 * every generated item, so this weighs the two stats equally); Utility by
 * perk magnitude. Pure — mutates only `members`' equipped maps; callers
 * re-syncHp and persist. `allowUtility2` mirrors the extraUtility Power-up
 * gate. */
export function optimizeEquipment(
  members: TeamMemberSave[],
  inventory: ItemInstance[],
  allowUtility2 = false,
): void {
  const defs = new Map<string, ItemDef>();
  for (const inst of inventory) {
    const def = itemDefById(inst.defId);
    if (def) defs.set(inst.id, def);
  }
  const ranked = (score: (d: ItemDef) => number, slot: ItemSlot): string[] =>
    inventory
      .filter((i) => defs.get(i.id)?.slot === slot && score(defs.get(i.id)!) > 0)
      .sort((a, b) => score(defs.get(b.id)!) - score(defs.get(a.id)!))
      .map((i) => i.id);

  // itemScore, not three separate inline expressions — the upgrade badges rank
  // gear with the same function, and a picker that disagrees with the
  // optimiser about which sword is better is worse than having neither.
  const woodPool = ranked(itemScore, "woodchopping");
  const advPool = ranked(itemScore, "adventuring");
  const utilPool = ranked(itemScore, "utility");

  for (const member of members) {
    member.equipped.woodchopping = woodPool.shift() ?? null;
    member.equipped.adventuring = advPool.shift() ?? null;
    member.equipped.utility = utilPool.shift() ?? null;
    member.equipped.utility2 = allowUtility2 ? (utilPool.shift() ?? null) : null;
  }
}
