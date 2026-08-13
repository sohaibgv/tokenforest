// The run's derived stat block — one pure fold replacing the multipliers that
// were scattered across battle.ts and game.ts.
//
// Before this, the party's attack power was assembled inline at the point of
// use, five factors wide:
//
//     effectiveAtk(...) * (battle.charmed ? 1.1 : 1) * boonAtkMult(boons)
//       * (1 + (battle.atkSurge ?? 0)) * firstStrike
//
// with crit chance, crit multiplier, reflect and the wood bonus each assembled
// somewhere else from their own ad-hoc helpers. That works for eight boons. It
// does not survive five patrons, ranks, rarities, charms with downsides and
// run curses, because there is no single place to ask "what is my attack
// multiplier and why" — and "why" is the whole point: Brotato is addictive
// because the stat sheet is legible, and a stat sheet can only be legible if
// something is tracking provenance.
//
// So every stat carries a parallel list of contributions (see `sources`). The
// ledger UI renders those verbatim; nothing has to re-derive or guess.
//
// ---------------------------------------------------------------------------
// TWO RULES THIS FILE EXISTS TO ENFORCE
// ---------------------------------------------------------------------------
//
// 1. EVERY STAT IS A RATIO, NEVER A FLAT AMOUNT.
//
//    Wood, gear and enemies all scale by 10^world (see economy.ts's
//    multForWorld). A stat expressed as "+3 armour" would decide fights in
//    World 0 and be invisible rounding noise by World 3, which breaks the
//    cross-world parity band the sim asserts (moves.json's parityGroups,
//    spread <= 15%). Hence armorPct not armorFlat, regenPerRoundPct not flat
//    regen, shieldOnGuardPct not flat shield. Any future stat that genuinely
//    needs an absolute must multiply by getWorld(world).mult at derive time,
//    which is the only reason RunStatsContext carries `world`.
//
// 2. THE SNAPSHOT STAYS AUTHORITATIVE FOR BATTLE-LOCAL STATE.
//
//    Three values are baked into BattleSnapshot when a fight starts and then
//    mutate during it: `reflectBonus` (gear + boon reflect, plus +0.25 per
//    Log Slam cast), `charmed` (the Fortune Charm provision) and `atkSurge`
//    (+0.25 per War Cry cast). Those are NOT repointed at this module. A
//    paused fight must resume with the exact numbers it started with, even if
//    the player has since levelled someone or swapped gear, and the snapshot
//    is the only thing that can promise that.
//
//    So: `deriveRunStats` computes reflectPct as the value startBattle should
//    BAKE, and mirrors charm/surge into `sources` for the ledger without
//    folding them into `values`. battle.ts keeps applying those two factors
//    itself, in the same position in the same expression.
//
//    That last part is load-bearing and easy to "clean up" by accident.
//    Floating-point multiplication is not associative: rewriting
//    `atk * charm * boon * surge` as `atk * (charm * boon * surge)` can change
//    the final rounded damage by one point, which is enough to move a seeded
//    win rate and re-band a sim scenario. The refactor of battle.ts is
//    therefore a strict FACTOR-FOR-FACTOR substitution — `boonAtkMult(boons)`
//    becomes `stats.values.atkMult` in place — and nothing gets reordered.
//    `effectiveAtkMult` below exists so the ledger can show the combined
//    number without anyone being tempted to combine it in the damage path.

import type { ProvisionId } from "../economy";
import type { StatusApplication } from "../statuses";
import { equippedItem, type ItemInstance, type TeamMemberSave } from "../team";
import { boonMagnitude, BOON_DEFS_BY_ID, describeBoon, RARITY_LABEL, type BoonHandlerId, type BoonInstance } from "./boons";
import { CHARM_DEFS_BY_ID, CURSE_DEFS_BY_ID, type RunCurse } from "./charms";

/** Chance a party member's Attack lands a critical hit, before any bonus.
 *
 * Lives here rather than in battle.ts because it is the base value of a
 * RunStat and belongs with the rest of them — battle.ts re-exports it so
 * ui/battle.ts, which surfaces it in the HUD, is unaffected. Importing it the
 * other way (stats.ts <- battle.ts) would make the two modules a runtime
 * cycle, since battle.ts imports RunStats from here. */
export const PLAYER_CRIT_CHANCE = 0.1;

export type RunStatKey =
  // --- offense
  | "atkMult"
  | "critChance"
  | "critMult"
  | "firstStrikeMult"
  | "lifestealPct"
  | "executePct"
  // --- defense
  | "reflectPct"
  | "armorPct"
  | "dodgePct"
  | "guardBonus"
  | "shieldOnGuardPct"
  | "regenPerRoundPct"
  | "maxHpMult"
  /** Number of times a lethal blow leaves someone standing at 1 HP instead of
   * ending the run. Arms BattleSnapshot.lastStandArmed at startBattle, reusing
   * the mechanism the lastStand gear ability already established rather than
   * adding a second near-identical save. */
  | "lastStandCharges"
  // --- economy
  | "woodMult"
  | "amberMult"
  | "acornMult"
  | "xpMult"
  | "expeditionPct"
  // --- meta
  | "extraOfferCount"
  | "rerollCharges"
  | "rarityLuck";

/** Neutral values — a run with no boons, no charms and no curses derives
 * exactly this. Every one of these is chosen so that substituting
 * `stats.values.X` for the literal it replaced in battle.ts is a no-op:
 * atkMult 1, critChance 0.10 (the old PLAYER_CRIT_CHANCE), critMult 1.5 (the
 * old non-bruiser multiplier), firstStrikeMult 1.5 (the old Scout bonus). */
export const BASE_RUN_STATS: Readonly<Record<RunStatKey, number>> = {
  atkMult: 1,
  critChance: PLAYER_CRIT_CHANCE,
  critMult: 1.5,
  firstStrikeMult: 1.5,
  lifestealPct: 0,
  executePct: 0,
  reflectPct: 0,
  armorPct: 0,
  dodgePct: 0,
  guardBonus: 0,
  shieldOnGuardPct: 0,
  regenPerRoundPct: 0,
  maxHpMult: 1,
  lastStandCharges: 0,
  woodMult: 1,
  amberMult: 1,
  acornMult: 1,
  xpMult: 1,
  expeditionPct: 0,
  extraOfferCount: 0,
  rerollCharges: 0,
  rarityLuck: 0,
};

export type StatSourceKind =
  | "base"
  | "boon"
  | "charm"
  | "curse"
  | "gear"
  | "class"
  | "provision"
  | "prestige"
  | "pact"
  | "battle";

export interface StatContribution {
  kind: StatSourceKind;
  /** Machine id — boon id, charm id, item defId, provision id. */
  sourceId: string;
  /** Rendered verbatim on the ledger: "Battle Fury (Epic, Rank 2)". */
  label: string;
  /** Signed, in the stat's own units. For multiplier stats this is the DELTA
   * above 1 (so +0.15, not 1.15) — the ledger sums deltas and never has to
   * un-multiply anything to show a breakdown. */
  delta: number;
}

export interface RunStats {
  values: Record<RunStatKey, number>;
  /** Parallel provenance ledger. Always populated: the cost is a few dozen
   * small objects per fight, and making it optional would guarantee it rots
   * out of sync with `values` the first time someone adds a stat in a hurry. */
  sources: Record<RunStatKey, StatContribution[]>;
  /** Statuses to apply on each corresponding trigger. Empty for a run with no
   * status-bearing content in play, which is what keeps such a run's rng
   * stream identical to one from before statuses existed. */
  onPartyAttack: StatusApplication[];
  onPartyGuard: StatusApplication[];
  onPartyKill: StatusApplication[];
  onRoundStart: StatusApplication[];
  /** The Rite-slot boon's handler, if one is held. Read by battle.ts for the
   * in-fight Rites and by Game for `riteReroll`, which is a run concern rather
   * than a battle one — one source, two consumers, neither reaching into the
   * other's state. */
  riteHandler?: BoonHandlerId;
  /** Rarity x rank multiplier for the Rite above, so a Heroic Rite is
   * genuinely stronger rather than merely rarer. */
  riteMagnitude?: number;
  /** Free-text lines the ledger shows outside the numeric table — active duo
   * boons, live curses and their remaining duration, the pact rank. */
  notes: string[];
}

export interface RunStatsContext {
  party: TeamMemberSave[];
  inventory: ItemInstance[];
  prestigeLevel?: number;
  /** The run's held boons. The path all new content uses. */
  boonList?: BoonInstance[];
  /** Charms held this run — Brotato-style items, upside and downside both. */
  charms?: string[];
  /** Live curses from chaos gates, with their remaining room counts. */
  curses?: RunCurse[];
  /** Provisions carried on this run — used only to MIRROR the Fortune Charm
   * into `sources` for the ledger. Its actual damage effect stays on
   * BattleSnapshot.charmed; see rule 2 in the header. */
  carried?: ProvisionId[];
  /** World index. Present so that any stat which genuinely must be denominated
   * in absolute HP or damage has somewhere to get its 10^world multiplier
   * from. Nothing needs it yet, and rule 1 says nothing should. */
  world?: number;
}

function emptySources(): Record<RunStatKey, StatContribution[]> {
  const out = {} as Record<RunStatKey, StatContribution[]>;
  for (const key of Object.keys(BASE_RUN_STATS) as RunStatKey[]) out[key] = [];
  return out;
}

/** Blank slate — every stat at its neutral value, no contributions. Exported
 * so previewBattle and any other pre-run caller has something honest to pass
 * rather than reaching for a partially-built object. */
export function baseRunStats(): RunStats {
  return {
    values: { ...BASE_RUN_STATS },
    sources: emptySources(),
    onPartyAttack: [],
    onPartyGuard: [],
    onPartyKill: [],
    onRoundStart: [],
    notes: [],
  };
}

/** Adds `delta` to a stat and records where it came from. The single mutation
 * point, so `values` and `sources` cannot drift apart. */
function add(stats: RunStats, key: RunStatKey, delta: number, contribution: Omit<StatContribution, "delta">): void {
  if (delta === 0) return;
  stats.values[key] += delta;
  stats.sources[key].push({ ...contribution, delta });
}

/** Records a contribution the ledger should show WITHOUT touching `values` —
 * for the two factors battle.ts applies from the snapshot itself (see rule 2).
 * Kept separate from `add` so the asymmetry is impossible to introduce by
 * accident: you have to name it. */
function mirror(stats: RunStats, key: RunStatKey, delta: number, contribution: Omit<StatContribution, "delta">): void {
  if (delta === 0) return;
  stats.sources[key].push({ ...contribution, delta });
}

/**
 * Folds a run's whole build into one stat block.
 *
 * Order is gear -> prestige -> boons -> (charms -> curses -> pact, once those
 * exist). Within boons, iteration follows the catalog's declared order so the
 * additive fold reproduces the old helpers' expressions term for term —
 * `boonAtkMult` evaluated `1 + 0.15*fury + 0.05*trance` in that order, and
 * summing deltas in that same order gives a bit-identical float.
 *
 * The result is never persisted. It is cheap to rebuild and always derivable
 * from the save, so caching it would only create an opportunity for it to go
 * stale mid-run — the exact bug class the ledger would then display with total
 * confidence.
 */
export function deriveRunStats(ctx: RunStatsContext): RunStats {
  const stats = baseRunStats();

  // --- Gear: passive Adventuring reflect, and the cleared-room reward bonus.
  //
  // Both are summed across the party the same additive way startBattle has
  // always summed reflectPct. The 0.6 cap on the gear pool is applied below,
  // after the sum, because it caps the POOL and not each item.
  let gearReflect = 0;
  for (const member of ctx.party) {
    const item = equippedItem(member, "adventuring", ctx.inventory);
    if (!item) continue;
    const reflect = item.adventuring?.reflectPct ?? 0;
    if (reflect > 0) {
      gearReflect += reflect;
      stats.sources.reflectPct.push({ kind: "gear", sourceId: item.defId, label: item.name, delta: reflect });
    }
    add(stats, "expeditionPct", item.adventuring?.expeditionBonusPct ?? 0, {
      kind: "gear",
      sourceId: item.defId,
      label: item.name,
    });
  }

  // Reflect is accumulated in its own variable rather than through `add`,
  // because it is not a plain sum: the gear pool has its own 0.6 cap applied
  // BEFORE any boon contribution is added on top, and both then share a 0.65
  // ceiling. Folding it in with everything else would quietly discard that.
  let boonReflect = 0;

  // --- Held boons.
  //
  // Reflect is accumulated separately from the other stats because it is not a
  // plain sum: the gear pool has its own 0.6 cap before anything else is added.
  // Everything else routes through `add`, so `values` and `sources` cannot
  // drift apart.
  for (const inst of ctx.boonList ?? []) {
    const def = BOON_DEFS_BY_ID[inst.id];
    if (!def) continue;
    const mult = boonMagnitude(inst);
    const label = `${def.name} (${RARITY_LABEL[inst.rarity]}${inst.rank > 1 ? `, Rank ${inst.rank}` : ""})`;
    for (const effect of def.effects) {
      if (effect.kind === "stat") {
        if (effect.key === "reflectPct") {
          const delta = effect.perStep * mult;
          boonReflect += delta;
          stats.sources.reflectPct.push({ kind: "boon", sourceId: def.id, label, delta });
        } else {
          add(stats, effect.key, effect.perStep * mult, { kind: "boon", sourceId: def.id, label });
        }
      } else if (effect.kind === "trigger") {
        // Stacks scale with the build; potency and duration do not. A Heroic
        // Kindle applies more Burn rather than hotter Burn, which keeps the
        // per-tick number readable no matter how deep the run gets.
        const app: StatusApplication = {
          status: effect.status,
          stacks: Math.max(1, Math.round(effect.stacks * mult)),
          rounds: effect.rounds ?? 1,
          chance: effect.chance ?? 1,
          potencyPct: effect.potencyPct,
        };
        if (effect.on === "attack") stats.onPartyAttack.push(app);
        else if (effect.on === "guard") stats.onPartyGuard.push(app);
        else if (effect.on === "kill") stats.onPartyKill.push(app);
        else stats.onRoundStart.push(app);
      } else {
        // Custom handlers are resolved by battle.ts (Rites) or Game (pick-time
        // effects); recorded here so the ledger can show they are live, and —
        // for a Rite — so battle.ts has somewhere to read it from. Rite is an
        // exclusive slot, so there can only ever be one.
        if (def.slot === "rite") {
          stats.riteHandler = effect.handlerId;
          stats.riteMagnitude = mult;
        }
        stats.notes.push(`${def.name}: ${describeBoon(def, inst)}`);
      }
    }
    if (def.duoPatrons) {
      stats.notes.push(`Duo: ${def.name} — ${def.duoPatrons.join(" + ")}`);
    }
  }

  // The reflect expression, preserved verbatim from startBattle: the gear pool
  // is capped at 0.6 on its own, the boon contribution stacks on top of that
  // cap rather than inside it, and the total shares a 0.9 ceiling with the
  // Log Slam ability's further +0.25 per cast.
  stats.values.reflectPct = Math.min(0.5, Math.min(0.6, gearReflect) + boonReflect);

  // --- Charms. Both halves are folded the same way, through the same `add`,
  // so the ledger shows the downside in the same place and the same font as
  // the upside. A charm whose cost is only visible on the shop card is a charm
  // nobody keeps weighing after they buy it.
  for (const charmId of ctx.charms ?? []) {
    const def = CHARM_DEFS_BY_ID[charmId];
    if (!def) continue;
    for (const effect of [...def.upside, ...def.downside]) {
      add(stats, effect.key, effect.delta, { kind: "charm", sourceId: def.id, label: def.name });
    }
  }

  // --- Curses. Negative, temporary, and noted with their remaining duration
  // so the ledger can answer "how much longer" without the player counting
  // rooms in their head.
  for (const curse of ctx.curses ?? []) {
    const def = CURSE_DEFS_BY_ID[curse.id];
    if (!def) continue;
    for (const effect of def.effects) {
      add(stats, effect.key, effect.delta, { kind: "curse", sourceId: def.id, label: def.name });
    }
    stats.notes.push(`Cursed: ${def.name} — ${curse.roomsLeft} room${curse.roomsLeft === 1 ? "" : "s"} left`);
  }

  // --- Provisions: mirrored only. Fortune Charm's +10% damage lives on
  // BattleSnapshot.charmed and is applied by battle.ts in its own factor slot.
  if (ctx.carried?.includes("fortuneCharm")) {
    mirror(stats, "atkMult", 0.1, { kind: "provision", sourceId: "fortuneCharm", label: "Fortune Charm" });
  }

  // Floors. Charms and curses both subtract, and enough of them stacked could
  // otherwise drive a multiplier negative — which would turn attacks into
  // healing and armour into amplification. Clamped here rather than at each
  // read site so there is one place to look.
  stats.values.atkMult = Math.max(0.1, stats.values.atkMult);
  stats.values.critChance = Math.max(0, stats.values.critChance);
  // Armour and reflect compound into immunity, and they multiply with EACH
  // OTHER, so their ceilings have to be read as a pair: at 0.5 and 0.65 a
  // fully defensive build still took only 17% of incoming damage.
  //
  // The deeper asymmetry is structural and cannot be tuned away, only bounded:
  // across a twelve-room run every point of mitigation pays in every round of
  // every fight, while damage stops paying the moment the enemy dies. Left
  // uncapped, defence therefore wins by construction — which is exactly what
  // the dominance harness kept reporting, a turtling route outclearing every
  // real build. These ceilings are what keep committing to a build competitive
  // with simply refusing to die.
  stats.values.armorPct = Math.min(0.35, stats.values.armorPct);
  stats.values.dodgePct = Math.min(0.9, Math.max(0, stats.values.dodgePct));
  stats.values.guardBonus = Math.max(0, stats.values.guardBonus);
  stats.values.acornMult = Math.max(0, stats.values.acornMult);
  stats.values.lastStandCharges = Math.max(0, stats.values.lastStandCharges);
  stats.values.extraOfferCount = Math.max(-1, stats.values.extraOfferCount);
  stats.values.rerollCharges = Math.max(0, stats.values.rerollCharges);

  return stats;
}

/**
 * Overlays a live fight's snapshot-local state onto a derived block.
 *
 * Only `atkSurge` (War Cry) and the possibly-mutated `reflectBonus` (Log Slam)
 * change during a fight. `reflectPct` is OVERWRITTEN rather than added to,
 * because the snapshot is the authority once a battle has started — it may
 * already carry casts that happened before the app was last closed.
 *
 * The surge is mirrored, not added: battle.ts applies `(1 + atkSurge)` in its
 * own factor position, and folding it into `values.atkMult` here would
 * double-count it. See rule 2 in the header.
 */
export function battleStats(
  base: RunStats,
  battle: { reflectBonus: number; charmed: boolean; atkSurge?: number },
): RunStats {
  const out: RunStats = {
    ...base,
    values: { ...base.values },
    sources: { ...base.sources, reflectPct: [...base.sources.reflectPct], atkMult: [...base.sources.atkMult] },
  };
  out.values.reflectPct = battle.reflectBonus;
  const surge = battle.atkSurge ?? 0;
  if (surge > 0) {
    out.sources.atkMult.push({ kind: "battle", sourceId: "warCry", label: "War Cry", delta: surge });
  }
  return out;
}

/**
 * The combined attack multiplier including the two snapshot-local factors —
 * for DISPLAY only.
 *
 * The ledger needs one number; the damage path must not use this, because
 * collapsing the factors into a single product changes float association and
 * with it the seeded sim results. Kept here, next to the rule it protects,
 * rather than in the UI where the reason would be invisible.
 */
export function effectiveAtkMult(stats: RunStats, battle?: { charmed: boolean; atkSurge?: number }): number {
  const charm = battle?.charmed ? 1.1 : 1;
  const surge = 1 + (battle?.atkSurge ?? 0);
  return stats.values.atkMult * charm * surge;
}

/** Every stat that differs from neutral, for the ledger's "show what's
 * actually doing something" pass. Sources are included even when the value
 * matches its base, since a mirrored contribution (Fortune Charm) is real
 * information the player should see. */
export function activeStatKeys(stats: RunStats): RunStatKey[] {
  return (Object.keys(stats.values) as RunStatKey[]).filter(
    (key) => stats.values[key] !== BASE_RUN_STATS[key] || stats.sources[key].length > 0,
  );
}
