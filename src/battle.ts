// Turn-based combat engine — operates on persisted plain data
// (BattleSnapshot), not an in-memory generator, so a mid-fight app restart
// (or simply pausing back to wood-chopping) resumes exactly where it left
// off: nothing here runs off a wall clock, only explicit submitted turns.
// Replaces the old single-shot resolveEncounter statistical race with real,
// individually-visualizable turn events.

import type { EnemySpec } from "./adventure";
import { boonAtkMult, boonCritBonus, boonReflectBonus } from "./boons";
import { effectiveAtk, equippedItem, memberClass, type ItemInstance, type TeamMemberSave } from "./team";

export type SkillGrade = "great" | "good" | "miss";
export type BattleAction = "attack" | "defend" | "ability";

/** One living (or just-defeated) enemy in a battle. `id` is assigned by
 * array index at startBattle time (`enemy-0`, `enemy-1`, ...) and stays
 * stable for the whole fight — it's how TurnEvent/targetEnemyId address a
 * specific enemy, and how the UI (Phase 2) will key per-enemy sprites/HP
 * bars. `spec` is the unchanged per-enemy stat/kind/name/special block;
 * `hp` is this unit's own current HP (was the single battle.enemyHp). */
export interface EnemyUnit {
  id: string;
  spec: EnemySpec;
  hp: number;
}

export interface TurnEvent {
  kind: "attack" | "crit" | "miss" | "defend" | "ability" | "heal" | "enemyMove" | "battleEnd";
  // memberId for party-sourced events; for enemy-sourced attack/enemyMove
  // events, the specific EnemyUnit.id that acted (e.g. "enemy-1") so the UI
  // can show which enemy attacked. Battle-level enemy events that aren't
  // sourced from one particular unit (the lastStand/roped save "heal", and
  // battleEnd) keep the old literal "enemy".
  actorId: string;
  targetId?: string;
  amount?: number; // damage or heal
  grade?: SkillGrade;
  moveId?: string;
  outcome?: "win" | "loss";
}

export interface BattleSnapshot {
  /** Ordered; index is baked into each unit's id at startBattle time. */
  enemies: EnemyUnit[];
  round: number;
  /** Living partyIds, snapshotted at the start of this round. */
  turnOrder: string[];
  /** Index into turnOrder of whose turn is next. */
  turnIndex: number;
  phase: "party" | "enemy" | "done";
  guarding: Record<string, SkillGrade>;
  /** Starts at the party's passive Adventuring reflectPct total (see
   * startBattle), then gains +0.25 more each time the logSlamReflect
   * ability fires — persists for the whole battle either way. */
  reflectBonus: number;
  /** From an equipped lastStand perk — consumed the first time it saves the party. */
  lastStandArmed: boolean;
  /** Fortune Charm carried — flat +10% party damage for the whole run. */
  charmed: boolean;
  /** Emergency Rope carried — a would-be wipe becomes a narrow escape once. */
  roped: boolean;
  narrowEscape: boolean;
  /** How many enemy phases (rounds) have elapsed — shared across every
   * enemy, drives each one's special-move cadence uniformly (unit.spec's
   * own everyNth still gates whether THIS round is that unit's special
   * turn). */
  enemyTurnCount: number;
  /** War Cry ability (prestige-unlocked gear effect): flat party ATK
   * multiplier bonus, +0.25 per cast, for the rest of the fight. Optional so
   * battles persisted before the field existed read as 0 — same additive
   * pattern AdventureState uses throughout. */
  atkSurge?: number;
  /** memberIds that have already landed their first attack this battle —
   * gates the Scout class's first-strike bonus. Optional/additive like
   * atkSurge above. */
  firstAttackDone?: Record<string, boolean>;
  /** Data Lag: memberId -> skip their next turn. */
  skipNext: Record<string, boolean>;
  /** Damage dealt to the enemy per member THIS round — enemy targeting rule. */
  roundDamage: Record<string, number>;
  /** Capped at ~20, newest last — enough for the UI to resume a fresh
   * animation queue after re-opening a paused battle. */
  events: TurnEvent[];
  outcome: "win" | "loss" | null;
}

export interface BattleOpts {
  charmed?: boolean;
  roped?: boolean;
  /** The run's current boon stacks (AdventureState.boons) — read once here
   * for Guardian's Ward's starting reflect contribution (see
   * boonReflectBonus), and again every turn by resolvePartyTurn for
   * Battle Fury/Keen Reflexes. */
  boons?: Record<string, number>;
}

const EVENT_CAP = 20;

/** Chance a party member's Attack lands a 1.5× critical hit — surfaced in
 * the battle HUD (see ui/battle.ts) so it isn't an invisible formula. */
export const PLAYER_CRIT_CHANCE = 0.1;

function livingIds(party: TeamMemberSave[]): string[] {
  return party.filter((m) => m.currentHp > 0).map((m) => m.id);
}

function pushEvent(battle: BattleSnapshot, ev: TurnEvent): void {
  battle.events.push(ev);
  if (battle.events.length > EVENT_CAP) battle.events.shift();
}

/** Fraction of incoming damage that still gets through after a Defend,
 * by skill-check grade — exported so the UI can show the numeric
 * equivalent of "Great/Good/Fumbled" instead of just the categorical text. */
export function mitigationFor(grade: SkillGrade): number {
  return grade === "great" ? 0.3 : grade === "good" ? 0.6 : 0.9;
}

function rollDmg(
  base: number,
  rng: () => number,
  critChance = 0,
  critMult = 1.5,
  /** Skips the random crit roll entirely and uses this value instead — the
   * Attack timing minigame's "great"/"miss" grades (see resolvePartyTurn's
   * attackGrade param) force a guaranteed crit or guaranteed non-crit rather
   * than just nudging the odds. Omitted (every existing caller, including
   * the sim) falls through to the original random roll unchanged. */
  forcedCrit?: boolean,
): { amount: number; crit: boolean } {
  const roll = 0.85 + rng() * 0.3;
  const crit = forcedCrit ?? (critChance > 0 && rng() < critChance);
  return { amount: Math.round(base * roll * (crit ? critMult : 1)), crit };
}

export function startBattle(
  party: TeamMemberSave[],
  enemies: EnemySpec[],
  inventory: ItemInstance[],
  opts: BattleOpts,
): BattleSnapshot {
  // Passive reflect: sum of every living party member's equipped
  // Adventuring reflectPct (epic/legendary gear only) — a collective
  // "thorns" ward that applies to every hit the party takes, independent of
  // who's actually defending. Capped at 0.6 so a fully epic/legendary-geared
  // trio can't get too close to the 0.9 ceiling shared with the
  // logSlamReflect ABILITY below, which still stacks an additional flat
  // +0.25 on top of this passive base rather than replacing it.
  const passiveReflect = party.reduce((sum, m) => {
    const item = equippedItem(m, "adventuring", inventory);
    return sum + (item?.adventuring?.reflectPct ?? 0);
  }, 0);
  return {
    enemies: enemies.map((spec, index) => ({ id: `enemy-${index}`, spec, hp: spec.hp })),
    round: 1,
    turnOrder: livingIds(party),
    turnIndex: 0,
    phase: "party",
    guarding: {},
    // Guardian's Ward stacks on top of the passive-gear reflect pool (itself
    // capped at 0.6) the same way logSlamReflect's ability +0.25 does below
    // — both share the overall 0.9 ceiling.
    reflectBonus: Math.min(0.9, Math.min(0.6, passiveReflect) + boonReflectBonus(opts.boons)),
    lastStandArmed: false,
    charmed: !!opts.charmed,
    roped: !!opts.roped,
    narrowEscape: false,
    atkSurge: 0,
    firstAttackDone: {},
    enemyTurnCount: 0,
    skipNext: {},
    roundDamage: {},
    events: [],
    outcome: null,
  };
}

export function isBattleOver(battle: BattleSnapshot): "win" | "loss" | null {
  return battle.outcome;
}

/** Lowest-index living enemy — the implicit target for callers that don't
 * (or can't) pick one explicitly, e.g. previewBattle's auto-fight sim, or
 * resolvePartyTurn when no targetEnemyId is given. */
function firstLivingEnemy(battle: BattleSnapshot): EnemyUnit | null {
  return battle.enemies.find((u) => u.hp > 0) ?? null;
}

/** Most-damage-dealt this round, or lowest-HP% living member if nobody
 * attacked (the whole party defended/abilitied instead). */
function pickEnemyTarget(party: TeamMemberSave[], roundDamage: Record<string, number>): TeamMemberSave | null {
  const living = party.filter((m) => m.currentHp > 0);
  if (living.length === 0) return null;
  const dealt = living
    .map((m) => [m, roundDamage[m.id] ?? 0] as const)
    .filter(([, dmg]) => dmg > 0)
    .sort((a, b) => b[1] - a[1]);
  if (dealt.length > 0) return dealt[0][0];
  return living.reduce((lowest, m) => (m.currentHp / m.maxHp < lowest.currentHp / lowest.maxHp ? m : lowest));
}

/** Enemy phase: every currently-living EnemyUnit independently takes its own
 * turn (own special-move check, own pickEnemyTarget call, own attack event)
 * — a round with 3 living enemies produces 3 enemy attack events in
 * sequence. Guard mitigation (battle.guarding) and roundDamage are round-
 * scoped, not per-enemy, so they're only cleared once after every living
 * enemy has acted — a single Defend still mitigates every hit the party
 * takes this round, no matter how many enemies land one. If the party wipes
 * partway through (an earlier enemy's hit kills the last living member),
 * remaining enemies simply have no one left to swing at. */
function applyEnemyTurn(battle: BattleSnapshot, party: TeamMemberSave[], rng: () => number): void {
  battle.phase = "enemy";
  battle.enemyTurnCount += 1;

  // Party-wide shield wall: the best Defend grade rolled this round
  // mitigates EVERY hit the party takes this round, whoever the target is —
  // the semantic the round-scoped-guarding comment above has always
  // described. (Per-defender-only mitigation made Defend nearly dead
  // weight: the enemy targets the round's top damage dealer, and a defender
  // deals 0, so the mitigation could never apply to the hits actually
  // landing.) The per-member `guarding` map is kept — it records who rolled
  // what, which per-member combat hooks can build on.
  // Warden class hook: a Warden's Defend lets 25% less through — each
  // defender's passthrough is scaled by their class before taking the
  // round's best.
  const passthroughs = Object.entries(battle.guarding).map(([memberId, grade]) => {
    const defender = party.find((m) => m.id === memberId);
    const wardenMult = defender && memberClass(defender) === "warden" ? 0.75 : 1;
    return mitigationFor(grade) * wardenMult;
  });
  const guardPassthrough = passthroughs.length > 0 ? Math.min(...passthroughs) : 1;

  for (const unit of battle.enemies) {
    if (unit.hp <= 0) continue;
    const living = party.filter((m) => m.currentHp > 0);
    if (living.length === 0) break;

    const special = unit.spec.special;
    const isSpecialTurn = !!special && battle.enemyTurnCount % special.everyNth === 0;

    const target = isSpecialTurn
      ? living[Math.floor(rng() * living.length)]
      : pickEnemyTarget(party, battle.roundDamage);
    if (!target) continue;

    const base = isSpecialTurn && special ? unit.spec.atk * special.dmgMult : unit.spec.atk;
    const { amount } = rollDmg(base, rng);
    const mitigated = amount * guardPassthrough;
    const final = Math.max(0, Math.round(mitigated * (1 - battle.reflectBonus)));
    target.currentHp = Math.max(0, target.currentHp - final);

    if (isSpecialTurn && special) {
      pushEvent(battle, { kind: "enemyMove", actorId: unit.id, targetId: target.id, amount: final, moveId: special.id });
      if (rng() < special.skipChance) battle.skipNext[target.id] = true;
    } else {
      pushEvent(battle, { kind: "attack", actorId: unit.id, targetId: target.id, amount: final });
    }
  }

  battle.guarding = {};
  battle.roundDamage = {};
}

/**
 * Resolves one living party member's turn. If this was the last living
 * member to act this round, also resolves the enemy's reply and opens the
 * next round. Returns every TurnEvent produced (this turn, and possibly the
 * enemy's reply + next-round opening) for the UI to animate in sequence —
 * mutates `battle`/`party` in place, so a caller re-rendering from the
 * already-updated state never needs to poll across frames.
 */
export function resolvePartyTurn(
  battle: BattleSnapshot,
  party: TeamMemberSave[],
  memberId: string,
  action: BattleAction,
  defendGrade: SkillGrade | undefined,
  inventory: ItemInstance[],
  prestigeLevel = 0,
  rng: () => number = Math.random,
  /** The run's current boon stacks — see BattleOpts.boons. Defaults to
   * empty so previewBattle's pre-embark simulation (no run/boons exist yet)
   * doesn't need to pass anything. */
  boons: Record<string, number> = {},
  /** Which EnemyUnit.id an "attack" should hit. Omitted (or pointing at an
   * already-defeated unit) falls back to the lowest-index living enemy —
   * keeps single-enemy callers (previewBattle, any not-yet-updated caller)
   * working exactly as before without having to know about targeting. */
  targetEnemyId?: string,
  /** Result of the Attack timing minigame (ui/battle.ts's floating-bubble
   * flow) — "great" forces a guaranteed crit, "miss" forces no crit,
   * "good"/omitted leaves the normal random crit-chance roll untouched.
   * Every existing caller (including the sim, which never plays a timing
   * minigame) omits this, so behavior is byte-for-byte unchanged for them —
   * this is a pure bonus layered on top of, not a replacement for, the base
   * crit-chance math. */
  attackGrade?: SkillGrade,
): TurnEvent[] {
  if (battle.outcome) return [];
  if (battle.turnOrder[battle.turnIndex] !== memberId) return []; // not this member's turn
  const before = battle.events.length;
  const actor = party.find((m) => m.id === memberId);
  if (!actor || actor.currentHp <= 0) return [];

  if (battle.skipNext[memberId]) {
    battle.skipNext[memberId] = false;
    pushEvent(battle, { kind: "miss", actorId: memberId });
  } else if (action === "attack") {
    const targetUnit =
      (targetEnemyId ? battle.enemies.find((u) => u.id === targetEnemyId && u.hp > 0) : undefined) ??
      firstLivingEnemy(battle);
    if (targetUnit) {
      // Class hooks (see economy.ts WORKER_CLASS_INFO): Scout's first
      // attack of the battle hits +50%; Bruiser crits are ×2 not ×1.5.
      const cls = memberClass(actor);
      battle.firstAttackDone = battle.firstAttackDone ?? {};
      const firstStrike = cls === "scout" && !battle.firstAttackDone[memberId] ? 1.5 : 1;
      battle.firstAttackDone[memberId] = true;
      const base =
        effectiveAtk(actor, inventory, prestigeLevel) *
        (battle.charmed ? 1.1 : 1) *
        boonAtkMult(boons) *
        (1 + (battle.atkSurge ?? 0)) *
        firstStrike;
      const forcedCrit =
        attackGrade === "great" ? true : attackGrade === "miss" ? false : undefined;
      const { amount, crit } = rollDmg(
        base,
        rng,
        PLAYER_CRIT_CHANCE + boonCritBonus(boons),
        cls === "bruiser" ? 2 : 1.5,
        forcedCrit,
      );
      targetUnit.hp = Math.max(0, targetUnit.hp - amount);
      battle.roundDamage[memberId] = (battle.roundDamage[memberId] ?? 0) + amount;
      pushEvent(battle, { kind: crit ? "crit" : "attack", actorId: memberId, targetId: targetUnit.id, amount });
    }
  } else if (action === "defend" && defendGrade) {
    battle.guarding[memberId] = defendGrade;
    pushEvent(battle, { kind: "defend", actorId: memberId, grade: defendGrade });
  } else if (action === "ability") {
    const effect = equippedItem(actor, "adventuring", inventory)?.effectId;
    if (effect === "logSlamReflect") {
      battle.reflectBonus = Math.min(0.9, battle.reflectBonus + 0.25);
      pushEvent(battle, { kind: "ability", actorId: memberId, moveId: effect });
    } else if (effect === "vampiricHeal") {
      // 30% of the enemy side's total max HP, summed across every enemy in
      // the battle (was just the single enemy's max HP pre-multi-enemy).
      const totalMaxHp = battle.enemies.reduce((sum, u) => sum + u.spec.hp, 0);
      let healRemaining = Math.round(totalMaxHp * 0.3);
      for (const m of party) {
        if (healRemaining <= 0 || m.currentHp <= 0) continue;
        const room = m.maxHp - m.currentHp;
        const heal = Math.min(room, Math.ceil(healRemaining / party.length));
        if (heal <= 0) continue;
        m.currentHp += heal;
        healRemaining -= heal;
        pushEvent(battle, { kind: "heal", actorId: memberId, targetId: m.id, amount: heal });
      }
    } else if (effect === "lastStand") {
      battle.lastStandArmed = true;
      pushEvent(battle, { kind: "ability", actorId: memberId, moveId: effect });
    } else if (effect === "warCry") {
      battle.atkSurge = (battle.atkSurge ?? 0) + 0.25;
      pushEvent(battle, { kind: "ability", actorId: memberId, moveId: effect });
    } else if (effect === "bossBribe" && battle.enemies.every((u) => u.spec.stage === 5)) {
      // Bribes the whole stage-5 encounter at once (was just the single
      // boss's HP pre-multi-enemy) — every enemy in a stage-5 fight is
      // assumed to share the same .stage, so this still only fires on the
      // final-boss stage, not partway through an earlier one.
      for (const u of battle.enemies) u.hp = 0;
      pushEvent(battle, { kind: "ability", actorId: memberId, moveId: effect });
    } else {
      pushEvent(battle, { kind: "miss", actorId: memberId }); // no ability equipped
    }
  }

  if (battle.enemies.every((u) => u.hp <= 0)) {
    battle.outcome = "win";
    battle.phase = "done";
    pushEvent(battle, { kind: "battleEnd", actorId: "enemy", outcome: "win" });
    return battle.events.slice(before);
  }

  // Next living member this round, if any.
  let nextIndex = battle.turnIndex + 1;
  while (nextIndex < battle.turnOrder.length) {
    const m = party.find((p) => p.id === battle.turnOrder[nextIndex]);
    if (m && m.currentHp > 0) break;
    nextIndex++;
  }
  if (nextIndex < battle.turnOrder.length) {
    battle.turnIndex = nextIndex;
    return battle.events.slice(before);
  }

  // Last living member acted this round — the enemy replies.
  applyEnemyTurn(battle, party, rng);

  if (party.every((m) => m.currentHp <= 0)) {
    if (battle.lastStandArmed) {
      // A lethal wipe is instead one member left standing at 1 HP — a
      // one-time save, the fight continues rather than ending.
      battle.lastStandArmed = false;
      const survivor = party[Math.floor(rng() * party.length)];
      survivor.currentHp = 1;
      pushEvent(battle, { kind: "heal", actorId: "enemy", targetId: survivor.id, amount: 1 });
    } else if (battle.roped && !battle.narrowEscape) {
      battle.narrowEscape = true;
      for (const m of party) m.currentHp = Math.max(m.currentHp, 1);
      pushEvent(battle, { kind: "heal", actorId: "enemy", targetId: "party", amount: 1 });
    } else {
      battle.outcome = "loss";
      battle.phase = "done";
      pushEvent(battle, { kind: "battleEnd", actorId: "enemy", outcome: "loss" });
      return battle.events.slice(before);
    }
  }

  battle.round += 1;
  battle.turnOrder = livingIds(party);
  battle.turnIndex = 0;
  battle.phase = "party";
  return battle.events.slice(before);
}

/** N simulated "always Attack" auto-fights against a cloned party — the
 * Muster screen's win% / expected-reward preview, built on this same engine
 * instead of a second, driftable formula. */
export function previewBattle(
  party: TeamMemberSave[],
  enemies: EnemySpec[],
  inventory: ItemInstance[],
  prestigeLevel = 0,
  trials = 200,
): { winPct: number; avgWoodOnWin: number } {
  let wins = 0;
  let woodSum = 0;
  const totalWoodReward = enemies.reduce((sum, e) => sum + e.woodReward, 0);
  for (let i = 0; i < trials; i++) {
    const clone = party.map((m) => ({ ...m, equipped: { ...m.equipped } }));
    const battle = startBattle(clone, enemies, inventory, {});
    let guard = 0;
    while (!battle.outcome && guard < 200) {
      guard++;
      const actorId = battle.turnOrder[battle.turnIndex];
      if (!actorId) break;
      // No explicit targetEnemyId — defaults to focus-firing the lowest-
      // index living enemy (see resolvePartyTurn), same sequential-kill
      // behavior a single-enemy preview always had.
      resolvePartyTurn(battle, clone, actorId, "attack", undefined, inventory, prestigeLevel);
    }
    if (battle.outcome === "win") {
      wins++;
      woodSum += totalWoodReward;
    }
  }
  return {
    winPct: Math.round((100 * wins) / trials),
    avgWoodOnWin: wins > 0 ? Math.round(woodSum / wins) : 0,
  };
}
