// Hades-style temporary in-run power-ups ("boons"). Offered one-of-three
// after every non-final stage win (see Game.finalizeBattleOutcome), picked
// exactly once per offer (no skip), and stacked for the rest of the current
// Adventure run only — persisted on AdventureState.boons, which lives and
// dies with the run exactly like pendingWood/log/stage already do (cleared
// by Game.bankAdventure on a full clear, a loss, or an explicit retreat;
// untouched by simply closing/reopening the battle view mid-run).
//
// Most boons are read every turn by battle.ts's resolvePartyTurn/startBattle
// (see boonAtkMult/boonCritBonus/boonReflectBonus below) rather than baked
// into any persistent per-member stat — they're pure combat-math multipliers
// for exactly as long as `boons` stays non-empty. The two exceptions
// (Iron Skin, Second Wind) touch actual HP pools once, at pick time, the
// same way equipping gear calls team.ts's syncHp — see Game.pickBoon.

import { equippedItem, type ItemInstance, type TeamMemberSave } from "./team";
import { isUnlocked } from "./unlocks";

export type BoonId =
  | "battleFury"
  | "ironSkin"
  | "secondWind"
  | "keenReflexes"
  | "guardiansWard"
  | "vengefulSpirit"
  | "lumberBlessing"
  | "battleTrance";

export interface BoonDef {
  id: BoonId;
  name: string;
  /** Shown verbatim on the offer card — always includes the concrete number. */
  description: string;
  /** True for a one-time-effect boon (heal now / recharge the Ability) —
   * still recorded in AdventureState.boons (so the HUD tally and the
   * "don't offer a no-op pick again" filters below both see it), but
   * battle.ts's per-turn multiplier readers never look at its stack count. */
  instant: boolean;
}

// Magnitudes, chosen against battle.ts's actual formulas rather than
// picked in a vacuum:
//   - PLAYER_CRIT_CHANCE (battle.ts) is 0.10 — Keen Reflexes matches that
//     exactly per stack, so one stack DOUBLES crit odds (a clean, readable
//     milestone) rather than some odd fraction of it.
//   - The passive Adventuring-gear reflect pool is capped at 0.6, and
//     logSlamReflect's ability adds a flat +0.25 on top, up to a shared 0.9
//     ceiling (see battle.ts's startBattle/resolvePartyTurn) — Guardian's
//     Ward reuses that same +0.25-per-stack order of magnitude, just
//     slightly smaller (0.15) since it can be picked repeatedly across a
//     5-stage run where the ability is only a single one-time +0.25.
//   - Battle Fury/Iron Skin at 15%/20% are deliberately close to a single
//     epic Adventuring item's own atk/hp bonus (see economy.ts
//     RARITY_ITEM_MULT), so a run that picks 2-3 of either feels roughly
//     like gaining a whole extra piece of gear for free, without dwarfing
//     actual gear progression.
export const BOON_ATK_PCT = 0.15; // Battle Fury: +15% party ATK per stack
export const BOON_HP_PCT = 0.2; // Iron Skin: +20% party max HP per stack
export const BOON_HEAL_PCT = 0.25; // Second Wind: heal 25% of max HP, once
export const BOON_CRIT_PCT = 0.1; // Keen Reflexes: +10% crit chance per stack
export const BOON_REFLECT_PCT = 0.15; // Guardian's Ward: +15% reflect per stack
// Prestige-unlocked boons (see src/unlocks.ts). Lumber Blessing is a pure
// economy boon (no combat math at all) — 20% matches a single epic item's
// expeditionBonusPct×2, meaningful without doubling a run's income at one
// stack. Battle Trance deliberately splits its power across two small dials
// (each 1/3 of the dedicated boon's magnitude, 5% vs Fury's 15% ATK /
// Reflexes' 10% crit) so it's a flexible generalist pick, not a strict
// upgrade over either specialist.
export const BOON_WOOD_PCT = 0.2; // Lumber Blessing: +20% stage wood per stack
export const BOON_TRANCE_ATK_PCT = 0.05; // Battle Trance: +5% ATK per stack
export const BOON_TRANCE_CRIT_PCT = 0.05; // Battle Trance: +5% crit per stack

export const BOON_DEFS: BoonDef[] = [
  {
    id: "battleFury",
    name: "Battle Fury",
    description: `+${Math.round(BOON_ATK_PCT * 100)}% party ATK for the rest of this run.`,
    instant: false,
  },
  {
    id: "ironSkin",
    name: "Iron Skin",
    description: `+${Math.round(BOON_HP_PCT * 100)}% party Max HP for the rest of this run — heals the party for the HP gained.`,
    instant: false,
  },
  {
    id: "secondWind",
    name: "Second Wind",
    description: `Instantly heals the whole party for ${Math.round(BOON_HEAL_PCT * 100)}% of their max HP.`,
    instant: true,
  },
  {
    id: "keenReflexes",
    name: "Keen Reflexes",
    description: `+${Math.round(BOON_CRIT_PCT * 100)}% critical hit chance for the rest of this run.`,
    instant: false,
  },
  {
    id: "guardiansWard",
    name: "Guardian's Ward",
    description: `+${Math.round(BOON_REFLECT_PCT * 100)}% damage reflect for the rest of this run.`,
    instant: false,
  },
  {
    id: "vengefulSpirit",
    name: "Vengeful Spirit",
    description: "Instantly recharges your once-per-run Ability.",
    instant: true,
  },
  {
    id: "lumberBlessing",
    name: "Lumber Blessing",
    description: `+${Math.round(BOON_WOOD_PCT * 100)}% wood from every stage cleared this run.`,
    instant: false,
  },
  {
    id: "battleTrance",
    name: "Battle Trance",
    description: `+${Math.round(BOON_TRANCE_ATK_PCT * 100)}% party ATK and +${Math.round(BOON_TRANCE_CRIT_PCT * 100)}% crit chance for the rest of this run.`,
    instant: false,
  },
];

export const BOON_DEFS_BY_ID: Record<BoonId, BoonDef> = Object.fromEntries(
  BOON_DEFS.map((d) => [d.id, d]),
) as Record<BoonId, BoonDef>;

/** Party-wide ATK multiplier from stacked Battle Fury — folded into
 * effectiveAtk's output in battle.ts's resolvePartyTurn, the same spot the
 * Fortune Charm `charmed` flag's +10% is already applied. */
export function boonAtkMult(boons: Record<string, number> | undefined): number {
  return 1 + BOON_ATK_PCT * (boons?.battleFury ?? 0) + BOON_TRANCE_ATK_PCT * (boons?.battleTrance ?? 0);
}

/** Added on top of PLAYER_CRIT_CHANCE — see battle.ts's rollDmg call in
 * resolvePartyTurn's "attack" branch. */
export function boonCritBonus(boons: Record<string, number> | undefined): number {
  return BOON_CRIT_PCT * (boons?.keenReflexes ?? 0) + BOON_TRANCE_CRIT_PCT * (boons?.battleTrance ?? 0);
}

/** Multiplier on each cleared stage's wood reward from stacked Lumber
 * Blessing — applied where stageWood is computed (Game.finalizeBattleOutcome
 * and the sim's run driver), alongside expeditionBonusPct. */
export function boonWoodMult(boons: Record<string, number> | undefined): number {
  return 1 + BOON_WOOD_PCT * (boons?.lumberBlessing ?? 0);
}

/** Folded into the battle's starting reflectBonus alongside passive gear
 * reflect — see battle.ts's startBattle. Composes additively with both the
 * passive Adventuring-gear reflect pool and the logSlamReflect ability's
 * +0.25, exactly like those two already compose with each other. */
export function boonReflectBonus(boons: Record<string, number> | undefined): number {
  return BOON_REFLECT_PCT * (boons?.guardiansWard ?? 0);
}

/** Which boons make sense to offer right now — filters out picks that
 * would be a pure no-op: Second Wind when nobody's missing HP, Vengeful
 * Spirit when there's no equipped ability to recharge OR the once-per-run
 * charge hasn't even been spent yet (resetting an already-unused charge
 * does nothing). The remaining four stacking passives are always offerable
 * — there's a floor of 4 "always offerable" boons, so a 3-of-N draw never
 * runs short regardless of party HP/ability state. */
export function offerableBoons(
  party: TeamMemberSave[],
  inventory: ItemInstance[],
  abilityUsed: boolean,
  prestigeLevel = 0,
): BoonDef[] {
  const anyHurt = party.some((m) => m.currentHp > 0 && m.currentHp < m.maxHp);
  const hasAbilityEquipped = party.some((m) => !!equippedItem(m, "adventuring", inventory)?.effectId);
  const vengefulUseful = abilityUsed && hasAbilityEquipped;
  return BOON_DEFS.filter((d) => {
    if (!isUnlocked("boon", d.id, prestigeLevel)) return false;
    if (d.id === "secondWind") return anyHurt;
    if (d.id === "vengefulSpirit") return vengefulUseful;
    return true;
  });
}

/** Draws exactly 3 offerable boons without replacement. Called once per
 * offer and the result persisted verbatim on AdventureState.pendingBoonOffer
 * (see game-state.ts) — never re-rolled on resume, so a paused pick (even
 * across an app restart) always shows the same 3 options it started with. */
export function drawBoonOffer(
  party: TeamMemberSave[],
  inventory: ItemInstance[],
  abilityUsed: boolean,
  rng: () => number = Math.random,
  prestigeLevel = 0,
): BoonId[] {
  const pool = offerableBoons(party, inventory, abilityUsed, prestigeLevel).map((d) => d.id);
  const picks: BoonId[] = [];
  while (picks.length < 3 && pool.length > 0) {
    const idx = Math.floor(rng() * pool.length);
    picks.push(pool.splice(idx, 1)[0]);
  }
  return picks;
}
