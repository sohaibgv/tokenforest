// Turn-based combat engine — operates on persisted plain data
// (BattleSnapshot), not an in-memory generator, so a mid-fight app restart
// (or simply pausing back to wood-chopping) resumes exactly where it left
// off: nothing here runs off a wall clock, only explicit submitted turns.
// Replaces the old single-shot resolveEncounter statistical race with real,
// individually-visualizable turn events.
//
// ---------------------------------------------------------------------------
// THE RNG RULE
// ---------------------------------------------------------------------------
//
// sim/sim.ts is a SEEDED STREAM test, not a behaviour test. Each scenario
// replays one mulberry32 stream across all of its trials, and every expected
// win-rate band in sim/moves.json is a function of which draw index each roll
// lands on. `w0-stage1-solo-fresh` is asserted at exactly [100,100] on the
// strength of a hand-traced proof in adventure.ts that a 1-ATK attacker always
// deals exactly 1 damage.
//
// Therefore: **rng() is called only when the stat governing that roll is
// non-default.** A dodge roll sits behind `stats.values.dodgePct > 0`; a
// status application with `chance === 1` must not draw at all. Content that
// isn't in play costs no draws, which is what lets a run with no new content
// consume a byte-identical stream — and what lets `SIM_IDENTITY=1` prove an
// engine change was genuinely inert.
//
// An unconditional new rng() call shifts every subsequent draw by one and
// re-bands scenarios that have nothing to do with the change. The failure then
// presents as a balance problem, which is the most expensive possible way to
// discover a refactor bug.
//
// The same reasoning applies to arithmetic. Floating-point multiplication is
// not associative, so the damage expressions below keep their factors in their
// original ORDER and positions; the RunStats refactor was a strict
// factor-for-factor substitution (`boonAtkMult(boons)` -> `stats.values.
// atkMult`) rather than a tidy-up. See run/stats.ts's header for why the two
// snapshot-local factors (charmed, atkSurge) are deliberately still applied
// here instead of being folded into the stat block.

import type { EnemySpec } from "./adventure";
import { DEATH_RATTLE_HP } from "./run/pact";
import { baseRunStats, deriveRunStats, PLAYER_CRIT_CHANCE as BASE_CRIT_CHANCE, type RunStats } from "./run/stats";
import {
  absorbShield,
  applyStatus,
  consumeMark,
  resolvePotency,
  statusMult,
  tickStatuses,
  type StatusApplication,
  type StatusBoard,
} from "./statuses";
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
  kind:
    | "attack"
    | "crit"
    | "miss"
    | "defend"
    | "ability"
    | "heal"
    | "enemyMove"
    | "battleEnd"
    /** A status just landed on a unit — `moveId` carries the StatusId. */
    | "status"
    /** End-of-round damage-over-time or regeneration resolving. */
    | "statusTick";
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
  /** Data Lag: memberId -> skip their next turn.
   *
   * This is also the Glitch mechanism — status-applying content writes here
   * rather than introducing a parallel "stun" status, so there is exactly one
   * way for a unit to lose a turn. */
  skipNext: Record<string, boolean>;
  /** unitId -> active statuses. Sparse and OPTIONAL: absent on any snapshot
   * persisted before statuses existed, and never created until something
   * actually applies one — so a fight with no status content in play adds
   * nothing to the save, the same additive pattern atkSurge/firstAttackDone
   * above already use. Keys are memberIds and EnemyUnit.ids, and the latter
   * are positional, so this must never outlive its battle. */
  statuses?: StatusBoard;
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
  /** The run's derived stat block. Optional so callers with no run in progress
   * (previewBattle at the Muster screen) don't have to fabricate one; absent,
   * a gear-and-class-only block is derived, which is the honest answer for a
   * caller that has no run to hand. */
  stats?: RunStats;
}

const EVENT_CAP = 20;

/** Chance a party member's Attack lands a critical hit, before any bonus.
 *
 * The value itself now lives in run/stats.ts as the base of the `critChance`
 * RunStat — re-exported here because ui/battle.ts surfaces it in the HUD (so
 * it isn't an invisible formula) and importing it from battle.ts is the shape
 * that module already expects. Importing the other direction would make
 * battle.ts and run/stats.ts a runtime cycle. */
export const PLAYER_CRIT_CHANCE = BASE_CRIT_CHANCE;

function livingIds(party: TeamMemberSave[]): string[] {
  return party.filter((m) => m.currentHp > 0).map((m) => m.id);
}

/** The status board, created on first write.
 *
 * Lazy rather than initialised in startBattle so that a fight which never
 * touches a status persists `statuses: undefined` instead of an empty object —
 * scheduleSave stringifies the entire save on every action, and this keeps
 * the common case free. */
function statusBoard(battle: BattleSnapshot): StatusBoard {
  battle.statuses = battle.statuses ?? {};
  return battle.statuses;
}

/** Read-only view for the multiplier lookups, which must not conjure a board
 * into existence just by asking whether one exists. */
const EMPTY_BOARD: StatusBoard = {};
function readBoard(battle: BattleSnapshot): StatusBoard {
  return battle.statuses ?? EMPTY_BOARD;
}

/**
 * Applies a list of trigger statuses and pushes an event for each one that
 * lands.
 *
 * `apps` is empty for any run with no status-bearing content, so this returns
 * immediately without consuming a draw — which is what keeps such a run's rng
 * stream identical to one from before statuses existed. See this file's
 * header.
 */
function fireStatuses(
  battle: BattleSnapshot,
  apps: StatusApplication[],
  targetId: string,
  actorId: string,
  attackerAtk: number,
  targetMaxHp: number,
  rng: () => number,
): void {
  if (apps.length === 0) return;
  // Insulated elites cannot be Glitched or Weakened. Control is the strongest
  // lever in a turn-based fight, so the affix that switches it off is the one
  // that most changes how a fight has to be played — and it is checked here,
  // at the single place statuses land, rather than at each of the five
  // triggers that can reach it.
  const insulated = battle.enemies.find((u) => u.id === targetId)?.spec.affix === "insulated";
  for (const app of apps) {
    if (insulated && (app.status === "glitch" || app.status === "weak")) continue;
    // Glitch is virtual: it routes to skipNext rather than onto the board, so
    // "loses a turn" has exactly one implementation — the one the glitchPulse
    // enemy special has always used. See statuses.ts's StatusId comment.
    if (app.status === "glitch") {
      if (app.chance < 1 && rng() >= app.chance) continue;
      battle.skipNext[targetId] = true;
      pushEvent(battle, { kind: "status", actorId, targetId, moveId: "glitch", amount: 1 });
      continue;
    }
    const potency = resolvePotency(app, attackerAtk, targetMaxHp);
    if (applyStatus(statusBoard(battle), targetId, app, potency, actorId, rng)) {
      pushEvent(battle, { kind: "status", actorId, targetId, moveId: app.status, amount: app.stacks });
    }
  }
}

/** Average party ATK, the denominator for statuses applied by the BUILD rather
 * than by a specific attacker (round-start triggers, Rite effects). Using the
 * party average keeps such a status scaled to the run's power without making
 * it depend on whose turn happened to be next. */
function partyAtk(party: TeamMemberSave[], inventory: ItemInstance[], prestigeLevel: number): number {
  const living = party.filter((m) => m.currentHp > 0);
  if (living.length === 0) return 1;
  return living.reduce((sum, m) => sum + effectiveAtk(m, inventory, prestigeLevel), 0) / living.length;
}

/** Magnitudes for the Rite-slot boons, expressed as fractions so they scale
 * with the party rather than the world tier (see run/stats.ts's rule 1). */
const RITE_BARK_PCT = 0.25;
const RITE_HEAL_PCT = 0.3;
const RITE_REGEN_STACKS = 3;
const RITE_BURN_STACKS = 8;

/**
 * Resolves the Rite-slot boon attached to the once-per-run Ability.
 *
 * `riteReroll` is absent here on purpose: returning a reroll charge is a RUN
 * concern, not a battle one, and BattleSnapshot has no business knowing about
 * the offer economy. Game reads the handler id off the same stat block after
 * the turn resolves. That split is the reason `riteHandler` lives on RunStats
 * rather than being passed to this function directly — one source, two
 * consumers, neither reaching into the other's state.
 */
function applyRite(
  battle: BattleSnapshot,
  party: TeamMemberSave[],
  stats: RunStats,
  memberId: string,
  inventory: ItemInstance[],
  prestigeLevel: number,
  rng: () => number,
): void {
  const mult = stats.riteMagnitude ?? 1;
  switch (stats.riteHandler) {
    case "riteBark": {
      for (const m of party) {
        if (m.currentHp <= 0) continue;
        const shield = Math.max(1, Math.round(m.maxHp * RITE_BARK_PCT * mult));
        applyStatus(
          statusBoard(battle),
          m.id,
          { status: "bark", stacks: shield, rounds: 0, chance: 1, potencyPct: 0 },
          1,
          memberId,
          rng,
        );
        pushEvent(battle, { kind: "status", actorId: memberId, targetId: m.id, moveId: "bark", amount: shield });
      }
      break;
    }
    case "riteBurnAll": {
      const atk = partyAtk(party, inventory, prestigeLevel);
      const app: StatusApplication = {
        status: "burn",
        stacks: Math.max(1, Math.round(RITE_BURN_STACKS * mult)),
        rounds: 1,
        chance: 1,
        potencyPct: 0.3,
      };
      for (const unit of battle.enemies) {
        if (unit.hp <= 0) continue;
        fireStatuses(battle, [app], unit.id, memberId, atk, unit.spec.hp, rng);
      }
      break;
    }
    case "riteHealRegen": {
      for (const m of party) {
        if (m.currentHp <= 0) continue;
        const heal = Math.max(1, Math.round(m.maxHp * RITE_HEAL_PCT * mult));
        const before = m.currentHp;
        m.currentHp = Math.min(m.maxHp, m.currentHp + heal);
        if (m.currentHp > before) {
          pushEvent(battle, { kind: "heal", actorId: memberId, targetId: m.id, amount: m.currentHp - before });
        }
        applyStatus(
          statusBoard(battle),
          m.id,
          { status: "regen", stacks: 1, rounds: Math.max(1, Math.round(RITE_REGEN_STACKS * mult)), chance: 1, potencyPct: 0.04 },
          Math.max(1, Math.round(m.maxHp * 0.04)),
          memberId,
          rng,
        );
      }
      break;
    }
    case "riteGlitchAll": {
      for (const unit of battle.enemies) {
        if (unit.hp <= 0) continue;
        battle.skipNext[unit.id] = true;
        pushEvent(battle, { kind: "status", actorId: memberId, targetId: unit.id, moveId: "glitch", amount: 1 });
      }
      break;
    }
    default:
      break;
  }
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


/** Death Rattle (Pact of the Grove): the first time every enemy is down, any
 * unit marked `revives` gets back up at a fraction of its health, once.
 *
 * Returns true when the fight continues. Consuming the flag on the spec itself
 * is safe because specs are built fresh per battle and persisted inside the
 * snapshot, so the "already used" state survives a mid-fight app restart
 * exactly like every other battle field. */
function tryDeathRattle(battle: BattleSnapshot): boolean {
  const riser = battle.enemies.find((u) => u.hp <= 0 && u.spec.revives);
  if (!riser) return false;
  riser.spec.revives = false;
  riser.hp = Math.max(1, Math.round(riser.spec.hp * DEATH_RATTLE_HP));
  pushEvent(battle, { kind: "heal", actorId: riser.id, targetId: riser.id, amount: riser.hp });
  return true;
}

export function startBattle(
  party: TeamMemberSave[],
  enemies: EnemySpec[],
  inventory: ItemInstance[],
  opts: BattleOpts,
): BattleSnapshot {
  // Reflect is BAKED here, once, and the snapshot owns it from then on (the
  // Log Slam ability adds a further +0.25 per cast during the fight). The
  // composition rule — gear pool capped at 0.6 on its own, Guardian's Ward
  // stacking on top of that cap, both under a shared 0.9 ceiling — now lives
  // in deriveRunStats so the ledger can show the same breakdown the fight
  // uses. See run/stats.ts's rule 2 for why baking rather than re-deriving is
  // load-bearing: a fight paused across an app restart must resume with the
  // number it started with, not with a number recomputed from gear the player
  // may have swapped in the meantime.
  const stats = opts.stats ?? deriveRunStats({ party, inventory });
  return {
    enemies: enemies.map((spec, index) => ({ id: `enemy-${index}`, spec, hp: spec.hp })),
    round: 1,
    turnOrder: livingIds(party),
    turnIndex: 0,
    phase: "party",
    guarding: {},
    reflectBonus: stats.values.reflectPct,
    // Second Ring and World Tree arm the same one-time save the lastStand gear
    // ability arms mid-fight, rather than adding a second near-identical
    // mechanism. False at the neutral 0, exactly as before.
    lastStandArmed: stats.values.lastStandCharges > 0,
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
function applyEnemyTurn(
  battle: BattleSnapshot,
  party: TeamMemberSave[],
  stats: RunStats,
  inventory: ItemInstance[],
  prestigeLevel: number,
  rng: () => number,
): void {
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
  // guardBonus (from Guard-slot boons and charms) scales every defender's
  // passthrough down before the round's best is taken — at its neutral 0 this
  // multiplies by exactly 1, which is why substituting it here cannot perturb
  // a run that has no such content.
  const passthroughs = Object.entries(battle.guarding).map(([memberId, grade]) => {
    const defender = party.find((m) => m.id === memberId);
    const wardenMult = defender && memberClass(defender) === "warden" ? 0.75 : 1;
    return mitigationFor(grade) * wardenMult * (1 - stats.values.guardBonus);
  });
  const guardPassthrough = passthroughs.length > 0 ? Math.min(...passthroughs) : 1;

  for (const unit of battle.enemies) {
    if (unit.hp <= 0) continue;
    const living = party.filter((m) => m.currentHp > 0);
    if (living.length === 0) break;

    // Glitched enemies lose their turn. Nothing writes skipNext for an enemy
    // id unless status content is in play, so this branch is unreachable — and
    // therefore free — on a run without it.
    if (battle.skipNext[unit.id]) {
      battle.skipNext[unit.id] = false;
      pushEvent(battle, { kind: "miss", actorId: unit.id, moveId: "glitch" });
      continue;
    }

    const special = unit.spec.special;
    const isSpecialTurn = !!special && battle.enemyTurnCount % special.everyNth === 0;

    const target = isSpecialTurn
      ? living[Math.floor(rng() * living.length)]
      : pickEnemyTarget(party, battle.roundDamage);
    if (!target) continue;

    // Weak reduces what the AFFLICTED ENEMY deals. statusMult returns exactly
    // 1.0 with no stacks, so this factor is a true no-op on a fight with no
    // status content — multiplying by exact 1 cannot perturb a float.
    const rawAtk = isSpecialTurn && special ? unit.spec.atk * special.dmgMult : unit.spec.atk;
    const base = rawAtk * statusMult(readBoard(battle), unit.id, "weak", -1);
    const { amount } = rollDmg(base, rng);
    const mitigated = amount * guardPassthrough;
    let final = Math.max(0, Math.round(mitigated * (1 - battle.reflectBonus)));

    // Armour, dodge and Bark all apply to the ALREADY-ROUNDED value, and each
    // is skipped outright at its neutral setting — so the base pipeline still
    // rounds bit-for-bit as it always did, and the dodge roll in particular
    // consumes no draw unless something actually granted dodge.
    if (stats.values.armorPct > 0) {
      final = Math.round(final * (1 - stats.values.armorPct));
    }
    const dodged = stats.values.dodgePct > 0 && rng() < stats.values.dodgePct;
    if (dodged) final = 0;
    let absorbed = 0;
    if (!dodged && final > 0 && battle.statuses) {
      const soak = absorbShield(battle.statuses, target.id, final);
      final = soak.through;
      absorbed = soak.absorbed;
    }

    target.currentHp = Math.max(0, target.currentHp - final);

    if (dodged) {
      // Reported as a miss so the existing "attack that did nothing" visual
      // covers it, rather than a 0-damage hit that reads as a rendering bug.
      pushEvent(battle, { kind: "miss", actorId: unit.id, targetId: target.id });
    } else if (isSpecialTurn && special) {
      pushEvent(battle, { kind: "enemyMove", actorId: unit.id, targetId: target.id, amount: final, moveId: special.id });
      if (rng() < special.skipChance) battle.skipNext[target.id] = true;
    } else {
      pushEvent(battle, { kind: "attack", actorId: unit.id, targetId: target.id, amount: final });
    }
    if (absorbed > 0) {
      pushEvent(battle, { kind: "status", actorId: target.id, targetId: target.id, moveId: "bark", amount: absorbed });
    }
  }

  resolveRoundEnd(battle, party, stats, inventory, prestigeLevel, rng);

  battle.guarding = {};
  battle.roundDamage = {};
}

/**
 * End-of-round upkeep: damage-over-time, regeneration, and stack decay.
 *
 * Runs after every living enemy has acted and before the round-scoped guard
 * and damage maps are cleared, so a Defend still covers the whole round and a
 * DoT tick lands in the round that applied it.
 *
 * Iteration order is fixed — party in turn order, then enemies by array index
 * — rather than left to object key order, because a seeded run has to be
 * reproducible and key order is not a language guarantee worth betting a
 * balance harness on.
 *
 * Party deaths from a tick fall through to resolveTurn's existing wipe check,
 * so lastStand and the Emergency Rope cover a death-by-burn for free. Enemy
 * deaths need an extra win check at the call site — see resolveTurn.
 */
function resolveRoundEnd(
  battle: BattleSnapshot,
  party: TeamMemberSave[],
  stats: RunStats,
  inventory: ItemInstance[],
  prestigeLevel: number,
  rng: () => number,
): void {
  // Round-start triggers fire here rather than at the top of the next round:
  // this is the same instant, and doing it here means a status applied by the
  // build ticks on the same schedule as one applied by an attack, instead of
  // getting a free round of grace.
  if (stats.onRoundStart.length > 0) {
    const atk = partyAtk(party, inventory, prestigeLevel);
    for (const unit of battle.enemies) {
      if (unit.hp <= 0) continue;
      fireStatuses(battle, stats.onRoundStart, unit.id, "party", atk, unit.spec.hp, rng);
    }
  }
  resolveTicks(battle, party, stats);
}

function resolveTicks(battle: BattleSnapshot, party: TeamMemberSave[], stats: RunStats): void {
  const board = battle.statuses;
  if (board && Object.keys(board).length > 0) {
    const order = [...battle.turnOrder, ...battle.enemies.map((u) => u.id)];
    for (const tick of tickStatuses(board, order)) {
      const member = party.find((m) => m.id === tick.unitId);
      const enemy = battle.enemies.find((u) => u.id === tick.unitId);
      if (member) {
        if (member.currentHp <= 0) continue;
        if (tick.damage > 0) member.currentHp = Math.max(0, member.currentHp - tick.damage);
        if (tick.heal > 0) member.currentHp = Math.min(member.maxHp, member.currentHp + tick.heal);
      } else if (enemy) {
        if (enemy.hp <= 0) continue;
        if (tick.damage > 0) enemy.hp = Math.max(0, enemy.hp - tick.damage);
      } else {
        continue;
      }
      pushEvent(battle, {
        kind: "statusTick",
        actorId: tick.unitId,
        targetId: tick.unitId,
        amount: tick.damage > 0 ? tick.damage : tick.heal,
        moveId: tick.damage > 0 ? "dot" : "regen",
      });
    }
  }

  // Regrowing elites mend at round end. Applied AFTER the party's damage-over-
  // time has ticked, so a burn build races the regeneration rather than being
  // silently cancelled by it before its own numbers land.
  for (const unit of battle.enemies) {
    if (unit.hp <= 0 || unit.spec.affix !== "regrowing") continue;
    const mend = Math.max(1, Math.round(unit.spec.hp * 0.08));
    const before = unit.hp;
    unit.hp = Math.min(unit.spec.hp, unit.hp + mend);
    if (unit.hp > before) {
      pushEvent(battle, { kind: "heal", actorId: unit.id, targetId: unit.id, amount: unit.hp - before });
    }
  }

  // Flat-rate party regeneration from the build itself (Sap's Verdant Pulse
  // and friends), as distinct from a Regen status somebody applied. Skipped
  // entirely at its neutral 0.
  if (stats.values.regenPerRoundPct > 0) {
    for (const m of party) {
      if (m.currentHp <= 0 || m.currentHp >= m.maxHp) continue;
      const heal = Math.max(1, Math.round(m.maxHp * stats.values.regenPerRoundPct));
      m.currentHp = Math.min(m.maxHp, m.currentHp + heal);
      pushEvent(battle, { kind: "heal", actorId: m.id, targetId: m.id, amount: heal });
    }
  }
}

/** Everything one party turn needs. Object form because the positional
 * signature below had already reached twelve parameters, half of them
 * optional — adding a thirteenth for the stat block would have been the point
 * where call sites started passing `undefined` placeholders to reach the
 * argument they cared about. New parameters go here; the positional function
 * is frozen. */
export interface TurnRequest {
  battle: BattleSnapshot;
  party: TeamMemberSave[];
  memberId: string;
  action: BattleAction;
  inventory: ItemInstance[];
  /** The run's derived build. Callers that run many turns (previewBattle, the
   * sim) should derive this ONCE and reuse it — it is immutable for the
   * duration of a fight. */
  stats: RunStats;
  defendGrade?: SkillGrade;
  /** Result of the Attack timing minigame (ui/battle.ts's floating-bubble
   * flow) — "great" forces a guaranteed crit, "miss" forces no crit,
   * "good"/omitted leaves the normal random crit-chance roll untouched. */
  attackGrade?: SkillGrade;
  /** Which EnemyUnit.id an "attack" should hit. Omitted (or pointing at an
   * already-defeated unit) falls back to the lowest-index living enemy. */
  targetEnemyId?: string;
  prestigeLevel?: number;
  rng?: () => number;
}

/**
 * Positional shim over `resolveTurn`, kept at exactly its original twelve
 * parameters in their original order.
 *
 * Two callers pass positionally (Game.applyTurnAction and the sim's turn
 * driver) and both are load-bearing for the seeded balance harness, so this
 * signature does not move. It derives a RunStats from `boons` on each call,
 * which is the wasteful-but-correct path; anything running turns in bulk
 * should call `resolveTurn` with a hoisted block instead.
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
  /** Unused. Held as a positional placeholder so the two callers that pass
   * this signature positionally — Game.applyTurnAction and the sim's turn
   * driver — keep working without edits; both are load-bearing for the seeded
   * balance harness. New parameters go on TurnRequest instead. */
  _legacyBoons: Record<string, number> = {},
  targetEnemyId?: string,
  attackGrade?: SkillGrade,
): TurnEvent[] {
  return resolveTurn({
    battle,
    party,
    memberId,
    action,
    defendGrade,
    inventory,
    prestigeLevel,
    rng,
    stats: deriveRunStats({ party, inventory, prestigeLevel }),
    targetEnemyId,
    attackGrade,
  });
}

/**
 * Resolves one living party member's turn. If this was the last living
 * member to act this round, also resolves the enemy's reply and opens the
 * next round. Returns every TurnEvent produced (this turn, and possibly the
 * enemy's reply + next-round opening) for the UI to animate in sequence —
 * mutates `battle`/`party` in place, so a caller re-rendering from the
 * already-updated state never needs to poll across frames.
 */
export function resolveTurn(req: TurnRequest): TurnEvent[] {
  const {
    battle,
    party,
    memberId,
    action,
    defendGrade,
    inventory,
    stats,
    targetEnemyId,
    attackGrade,
    prestigeLevel = 0,
    rng = Math.random,
  } = req;
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
      const firstStrike =
        cls === "scout" && !battle.firstAttackDone[memberId] ? stats.values.firstStrikeMult : 1;
      battle.firstAttackDone[memberId] = true;
      // FACTOR ORDER IS LOAD-BEARING — see this file's header. `charmed` and
      // `atkSurge` stay as snapshot reads in their original positions rather
      // than being folded into stats.values.atkMult, both because the snapshot
      // is authoritative for them across a resume and because collapsing the
      // product would change float association and move seeded sim results.
      const board = readBoard(battle);
      const ownAtk = effectiveAtk(actor, inventory, prestigeLevel);
      const base =
        ownAtk *
        (battle.charmed ? 1.1 : 1) *
        stats.values.atkMult *
        (1 + (battle.atkSurge ?? 0)) *
        firstStrike *
        // Returns exactly 1 with no stacks — Vulnerable is the target's
        // damage-taken debuff.
        statusMult(board, targetUnit.id, "vulnerable", 1);
      const forcedCrit =
        attackGrade === "great" ? true : attackGrade === "miss" ? false : undefined;
      // Mark is read (not yet consumed) so it can raise the odds of the very
      // roll it is about to be spent on.
      const markBonus = board[targetUnit.id]?.mark
        ? board[targetUnit.id]!.mark!.stacks * board[targetUnit.id]!.mark!.potency
        : 0;
      const { amount, crit } = rollDmg(
        base,
        rng,
        stats.values.critChance + markBonus,
        // Bruiser's x2 stays a literal: it REPLACES the stat rather than
        // adding to it, and turning it into `critMult + 0.5` would be a real
        // balance change dressed up as a refactor.
        cls === "bruiser" ? 2 : stats.values.critMult,
        forcedCrit,
      );
      // Armoured shrugs off direct hits — but NOT status ticks, which resolve
      // in resolveTicks without passing through here. That asymmetry is the
      // whole affix: the door tells you to bring status damage, and bringing
      // it genuinely answers the fight.
      const dealt =
        targetUnit.spec.affix === "armored" ? Math.max(1, Math.round(amount * 0.6)) : amount;
      targetUnit.hp = Math.max(0, targetUnit.hp - dealt);
      // Execute: anything left below the threshold simply goes out. Checked
      // AFTER the hit lands so it reads as a finisher rather than as a
      // pre-emptive deletion, and skipped entirely at its neutral 0.
      if (
        stats.values.executePct > 0 &&
        targetUnit.hp > 0 &&
        targetUnit.hp / targetUnit.spec.hp < stats.values.executePct
      ) {
        targetUnit.hp = 0;
      }
      battle.roundDamage[memberId] = (battle.roundDamage[memberId] ?? 0) + dealt;
      pushEvent(battle, { kind: crit ? "crit" : "attack", actorId: memberId, targetId: targetUnit.id, amount: dealt });
      if (markBonus > 0) consumeMark(statusBoard(battle), targetUnit.id);

      // Lifesteal, then on-hit statuses, then on-kill statuses — in that order
      // so a killing blow still heals, and so an on-kill trigger can't land a
      // status on a unit the on-hit trigger just removed from play.
      if (stats.values.lifestealPct > 0 && actor.currentHp > 0) {
        const heal = Math.max(1, Math.round(dealt * stats.values.lifestealPct));
        const before = actor.currentHp;
        actor.currentHp = Math.min(actor.maxHp, actor.currentHp + heal);
        if (actor.currentHp > before) {
          pushEvent(battle, { kind: "heal", actorId: memberId, targetId: memberId, amount: actor.currentHp - before });
        }
      }
      if (targetUnit.hp > 0) {
        fireStatuses(battle, stats.onPartyAttack, targetUnit.id, memberId, ownAtk, targetUnit.spec.hp, rng);
      } else if (stats.onPartyKill.length > 0) {
        for (const other of battle.enemies) {
          if (other.hp <= 0) continue;
          fireStatuses(battle, stats.onPartyKill, other.id, memberId, ownAtk, other.spec.hp, rng);
        }
      }
    }
  } else if (action === "defend" && defendGrade) {
    battle.guarding[memberId] = defendGrade;
    pushEvent(battle, { kind: "defend", actorId: memberId, grade: defendGrade });
    // Bark from Guard-slot boons: a shield sized as a fraction of the
    // defender's own max HP, so it scales with the party rather than with the
    // world tier. Skipped entirely at its neutral 0.
    if (stats.values.shieldOnGuardPct > 0) {
      const shield = Math.max(1, Math.round(actor.maxHp * stats.values.shieldOnGuardPct));
      applyStatus(
        statusBoard(battle),
        memberId,
        { status: "bark", stacks: shield, rounds: 0, chance: 1, potencyPct: 0 },
        1,
        memberId,
        rng,
      );
      pushEvent(battle, { kind: "status", actorId: memberId, targetId: memberId, moveId: "bark", amount: shield });
    }
    // Guard-triggered statuses land on every living enemy — the fiction is a
    // retaliatory ward, not a counterattack aimed at one unit.
    if (stats.onPartyGuard.length > 0) {
      for (const unit of battle.enemies) {
        if (unit.hp <= 0) continue;
        fireStatuses(
          battle,
          stats.onPartyGuard,
          unit.id,
          memberId,
          effectiveAtk(actor, inventory, prestigeLevel),
          unit.spec.hp,
          rng,
        );
      }
    }
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
    } else if (!stats.riteHandler) {
      pushEvent(battle, { kind: "miss", actorId: memberId }); // no ability equipped
    }
    // Rite-slot boons ride ALONGSIDE the equipped item's effect rather than
    // replacing it — the fiction is that a patron blesses the Ability you
    // already have. That also means a Rite boon is worth taking even with no
    // Adventuring gear equipped, which matters early on when the party has
    // none: without this, the whole slot would read as dead weight for the
    // first several runs.
    if (stats.riteHandler) {
      applyRite(battle, party, stats, memberId, inventory, prestigeLevel, rng);
    }
  }

  if (battle.enemies.every((u) => u.hp <= 0) && !tryDeathRattle(battle)) {
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
  applyEnemyTurn(battle, party, stats, inventory, prestigeLevel, rng);

  // Second win check. The one above runs BEFORE the enemy phase, so without
  // this a damage-over-time tick that kills the last enemy at round end would
  // go unnoticed until somebody took another turn — and if the same tick also
  // wiped the party, the fight would be scored as a loss the party had already
  // won. Unreachable when nothing is applying DoT, which is why it doesn't
  // perturb a status-free run.
  if (battle.enemies.every((u) => u.hp <= 0) && !tryDeathRattle(battle)) {
    battle.outcome = "win";
    battle.phase = "done";
    pushEvent(battle, { kind: "battleEnd", actorId: "enemy", outcome: "win" });
    return battle.events.slice(before);
  }

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
  /** The run's build, if there is one. Defaults to a neutral block, which is
   * the honest answer at the Muster screen: this preview runs BEFORE embark,
   * so no boons, charms or curses exist yet. */
  stats: RunStats = baseRunStats(),
): { winPct: number; avgWoodOnWin: number } {
  let wins = 0;
  let woodSum = 0;
  const totalWoodReward = enemies.reduce((sum, e) => sum + e.woodReward, 0);
  for (let i = 0; i < trials; i++) {
    const clone = party.map((m) => ({ ...m, equipped: { ...m.equipped } }));
    const battle = startBattle(clone, enemies, inventory, { stats });
    let guard = 0;
    while (!battle.outcome && guard < 200) {
      guard++;
      const actorId = battle.turnOrder[battle.turnIndex];
      if (!actorId) break;
      // No explicit targetEnemyId — defaults to focus-firing the lowest-
      // index living enemy (see resolveTurn), same sequential-kill behaviour
      // a single-enemy preview always had. Calls resolveTurn rather than the
      // positional shim specifically so the stat block is derived once, above
      // this loop, instead of 200 x N times inside it.
      resolveTurn({
        battle,
        party: clone,
        memberId: actorId,
        action: "attack",
        inventory,
        stats,
        prestigeLevel,
      });
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

/** How deep a run is expected to get, simulated room by room.
 *
 * `previewBattle` above answers "can this party win ONE fight", which is not
 * the question the Muster screen is actually asking. A party can hold a 90%
 * win rate against the first room of a world it has no business entering:
 * room 1 is tier 1, and the twelve-room ladder climbs to tier 5. Reporting
 * that 90% as the run's outlook is how a player ends up embarking into a
 * world that eats them at room four, having been shown nothing but green.
 *
 * So this walks the real tier ladder (`tiers`, from roomTier) with **HP
 * carrying over between rooms** — the single fact that makes attrition
 * visible and that a per-room win% structurally cannot express.
 *
 * Deliberately pessimistic, in three named ways:
 *   - no boons, charms or curses (`baseRunStats`) — a real run compounds
 *     upgrades as it descends,
 *   - no fountains, shop heals or carried provisions,
 *   - always Attack, never Defend or an ability.
 * It is therefore a FLOOR: the honest reading of a result is "this run goes
 * at least this deep". A floor is the right bias for a warning indicator —
 * over-promising is what makes an estimate worth removing.
 */
/** The three readiness bands, as a share of the twelve-room ladder the party
 * is expected to clear on previewRun's pessimistic floor.
 *
 * Lives here, beside the model that feeds it, rather than in Game — Game
 * imports the Tauri bridge and so cannot be imported by the sim at all, and
 * these two numbers are exactly the kind of thing that needs a gate on it
 * (a band set where "green" is unreachable, or where every party reads red,
 * is a worse indicator than none). See readinessChecks in sim/sim.ts. */
export const READINESS_RED_BELOW = 1 / 3;
export const READINESS_GREEN_AT = 3 / 4;

export function readinessBand(avgRoomsCleared: number, roomsTotal: number): "red" | "amber" | "green" {
  const frac = roomsTotal > 0 ? avgRoomsCleared / roomsTotal : 0;
  if (frac < READINESS_RED_BELOW) return "red";
  return frac < READINESS_GREEN_AT ? "amber" : "green";
}

export function previewRun(
  party: TeamMemberSave[],
  tiers: EnemySpec[][],
  inventory: ItemInstance[],
  prestigeLevel = 0,
  trials = 40,
): { avgRoomsCleared: number; fullClearPct: number; roomsTotal: number } {
  let roomsSum = 0;
  let fullClears = 0;
  for (let t = 0; t < trials; t++) {
    // Cloned ONCE per trial, not per room — this array is the run's party,
    // and its currentHp is what carries the attrition forward.
    const clone = party.map((m) => ({ ...m, equipped: { ...m.equipped } }));
    const stats = baseRunStats();
    let cleared = 0;
    for (const enemies of tiers) {
      const battle = startBattle(clone, enemies, inventory, { stats });
      let guard = 0;
      while (!battle.outcome && guard < 200) {
        guard++;
        const actorId = battle.turnOrder[battle.turnIndex];
        if (!actorId) break;
        resolveTurn({ battle, party: clone, memberId: actorId, action: "attack", inventory, stats, prestigeLevel });
      }
      if (battle.outcome !== "win") break;
      cleared++;
    }
    roomsSum += cleared;
    if (cleared === tiers.length) fullClears++;
  }
  return {
    avgRoomsCleared: roomsSum / trials,
    fullClearPct: Math.round((100 * fullClears) / trials),
    roomsTotal: tiers.length,
  };
}
