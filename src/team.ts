// Persistent gacha-pulled team roster: per-member stats, equipment, and
// leveling. Replaces the old single global ownedAxe/helpers economy.

import {
  itemDefById,
  multForWorld,
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
}

export const DEFAULT_WORKER_ATK = 1;
export const DEFAULT_WORKER_HP = 10;
export const MAX_LEVEL = 20;
export const LEVEL_STAT_STEP = 0.05; // +5%/level, multiplicative

export function levelMult(level: number): number {
  return 1 + (level - 1) * LEVEL_STAT_STEP;
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
  const def = WORKER_DEFS_BY_ID[member.defId];
  const mult = def ? WORKER_RARITY_MULT[def.rarity] : WORKER_RARITY_MULT.common;
  const carry = multForWorld(equippedItem(member, "adventuring", inventory)?.world ?? 0);
  return { atk: DEFAULT_WORKER_ATK * mult.atk * carry, hp: DEFAULT_WORKER_HP * mult.hp * carry };
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
