// Headless, seeded balance-simulation harness (`npm run test:sim`).
//
// Imports ONLY the pure game modules (battle/adventure/boons/gacha/economy/
// team — no DOM, no Tauri, no canvas) and re-runs the same combat and run
// economy the real Game class drives, over the data-driven scenarios in
// sim/moves.json plus a set of hardcoded balance invariants. Exits non-zero
// on any failure so it can gate every change.
//
// Everything is deterministic: one mulberry32 stream per scenario, seeded
// from moves.json's `seed` xor the scenario name — scenarios never perturb
// each other's rolls when one is added/removed/reordered.

import { readFileSync } from "node:fs";

import { wrapLines } from "../src/npc/dialogue";
import {
  eligibleLines,
  FISHER_LINES,
  FOREMAN_LINES,
  QUARTERMASTER_LINES,
  renderLine,
  type NpcLine,
} from "../src/npc/lines";
import { buildUsageView, type UsageView } from "../src/npc/usage-view";
import { fontSafe } from "../src/scene/sprites";
import { TREES_PER_PLOT } from "../src/scene/plot";

import {
  buildEnemy,
  chestDecoration,
  chestReward,
  descentToll,
  roomTier,
  embarkCost,
  type Stage,
} from "../src/adventure";
import {
  isBattleOver,
  previewRun,
  readinessBand,
  READINESS_GREEN_AT,
  READINESS_RED_BELOW,
  resolveTurn,
  startBattle,
  type BattleSnapshot,
  type SkillGrade,
} from "../src/battle";
import {
  accrueCacheKoi,
  accrueOverflow,
  accrueThreshold,
  ADVENTURE_REVIVE_BASE_COST,
  amberLanternFull,
  amberTradeCost,
  BOOSTS,
  BARN_MAX_PHASE,
  barnPhaseCost,
  barnUnlocked,
  BUILDABLES,
  canOwnMore,
  CACHE_KOI_AMBER_MAX,
  CACHE_KOI_AMBER_MIN,
  CACHE_KOI_TOKENS,
  COSMETICS,
  accruePassiveFocus,
  COTTAGE_MAX_PHASE,
  cottagePhaseCost,
  FOCUS_PASSIVE_SECS,
  DYE_SWATCHES,
  dyedPalette,
  FOCUS_CAP,
  FOCUS_HEAT_FLOOR,
  focusHeatColor,
  getWorld,
  ITEM_PITY_THRESHOLD,
  koiReward,
  logStackTier,
  OVERFLOW_LOG_TOKENS,
  POWERUP_PITY_THRESHOLD,
  PROVISIONS,
  RARITY_ORDER,
  SAP_PRESS_AMBER_YIELD,
  sapPressCost,
  SHARD_VALUE,
  WORKER_DEFS,
  TOKENS_PER_CHARGE,
  swingWeight,
  streakMult,
  STREAK_DECAY_PER_SEC,
  STREAK_GAIN_PER_WEIGHT,
  STREAK_MULT_MAX,
  POV_CRIT_FRACTION,
  POV_GRADE_MULT,
  SWING_CAP,
  SWING_FLOOR,
  TOKEN_REF,
  plotGateForWorld,
  travelAmberCost,
  travelSweatWoodCost,
  povYieldMult,
  SKILL_SPEED_BASE,
  SKILL_SPEED_PER_TIER,
  SKILL_SPEED_RANGE,
  travelCostForWorld,
  WOOD_YIELD,
  unlockedSwatches,
  WORKER_PITY_THRESHOLD,
  type Rarity,
  itemDefsForWorld,
} from "../src/economy";
import { pullItem, pullPowerup, pullWorker } from "../src/gacha";
import {
  applyFusion,
  autoFillFodder,
  canFuse,
  canSacrifice,
  fodderAvailable,
  FUSION_FODDER_COUNT,
  MAX_COPIES_PER_WORKER,
  planFusion,
  type FusionSave,
} from "../src/fusion";
import type { GameSave } from "../src/game-state";
import { hashString, mulberry32 } from "../src/rng";
import { migrateSave } from "../src/save-migrations";
import {
  boonMagnitude,
  boonReplaces,
  BOON_DEFS,
  BOON_DEFS_BY_ID,
  describeBoon,
  slotCapacity,
  AURA_CAP,
  FORTUNE_CAP,
  type BoonInstance,
} from "../src/run/boons";
import { PATRON_DEFS, PATRON_DEFS_BY_ID } from "../src/run/patrons";
import { baseRunStats, BASE_RUN_STATS, deriveRunStats, type RunStats } from "../src/run/stats";
import { CHARM_DEFS, CURSE_DEFS } from "../src/run/charms";
import { CONSUMABLE_DEFS } from "../src/run/shop";
import { canBuy, roomAcorns, rollShop } from "../src/run/shop";
import { groveRank, grovePayoutMult, pactEnemyScaling, PACT_DEFS } from "../src/run/pact";
import {
  depthOf,
  ELITE_AFFIXES,
  generateRunMap,
  exitsAfter,
  isDepthBoundary,
  isFinalRoom,
  TOTAL_ROOMS,
  type RoomSpec,
} from "../src/run/rooms";
import {
  applyOfferCard,
  drawOffer,
  rerollOffer,
  type OfferCard,
  type OfferContext,
} from "../src/run/offers";
import {
  absorbShield,
  applyStatus,
  consumeMark,
  pruneStatuses,
  resolvePotency,
  statusMult,
  STATUS_DEFS,
  tickStatuses,
  type StatusApplication,
  type StatusBoard,
} from "../src/statuses";
import { isUnlocked, UNLOCKS } from "../src/unlocks";
import {
  bestUpgradeFor,
  createMember,
  effectiveRarity,
  equippedInstanceIds,
  itemScore,
  starCount,
  starMult,
  memberPower,
  sortRosterByPower,
  type ItemSlot,
  effectiveAtk,
  effectiveMaxHp,
  equippedItem,
  grantXp,
  optimizeEquipment,
  stageXpReward,
  syncHp,
  xpToNext,
  type ItemInstance,
  type TeamMemberSave,
} from "../src/team";

// --- Scenario file shape ---------------------------------------------------

type Policy = "attack" | "guard-low" | "smart";

interface PartyMemberSpec {
  defId: string;
  level: number;
  items?: Partial<Record<"woodchopping" | "adventuring" | "utility", string>>;
}

interface BattleScenario {
  name: string;
  world: number;
  stage: Stage;
  trials: number;
  policy: Policy;
  party: PartyMemberSpec[];
  expect: { winPct: [number, number] };
}

interface RunScenario {
  name: string;
  world: number;
  trials: number;
  policy: Policy;
  boonPolicy: string;
  party: PartyMemberSpec[];
  expect: { clearPct: [number, number]; avgNetWood: [number, number] };
}

interface ParityGroup {
  name: string;
  members: string[];
  maxSpreadPct: number;
}

interface MovesFile {
  seed: number;
  battles: BattleScenario[];
  parityGroups: ParityGroup[];
  runs: RunScenario[];
  gacha: { workerPulls: number; itemPulls: number; powerupPulls: number };
  boonPaths?: {
    scenario: string;
    policies: string[];
    trials: number;
    maxSpreadPct: number;
    minClearPct: number;
  };
}

const moves: MovesFile = JSON.parse(
  readFileSync(new URL("./moves.json", import.meta.url), "utf-8"),
);

// --- Result collection -----------------------------------------------------

let failures = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function inBand(value: number, [lo, hi]: [number, number]): boolean {
  return value >= lo && value <= hi;
}

// --- Identity harness ------------------------------------------------------
//
// This file is a SEEDED STREAM test, not a behavior test. Every band asserted
// below is a function of WHICH DRAW INDEX each roll lands on — `battleWinPct`
// replays one mulberry32 stream across all its trials, so inserting a single
// extra rng() call anywhere upstream shifts every subsequent draw by one and
// silently re-bands scenarios that have nothing to do with the change. The
// failure then presents as a balance problem, which is the most expensive
// possible way to discover a refactor bug.
//
// So a refactor that is meant to be inert has to prove it, and win% alone
// can't: a new roll may happen to leave THIS seed's outcome untouched while
// having already displaced the stream for everything after it. Two numbers per
// scenario pin it down properly — the outcome at full precision, and how many
// times the scenario drew at all.
//
// `SIM_IDENTITY=1 npm run test:sim` prints those as a stable, diffable block.
// Capture it before an engine change, diff it after; an identical block means
// the change genuinely did nothing, and any difference names the exact
// scenario to look at. The governing rule this enforces is stated in
// src/battle.ts's header: rng() is only called when the stat governing that
// roll is non-default, so content that isn't in play costs no draws.

/** Per-rng-stream draw counts, in creation order. Keyed by the scenario name
 * (suffixed `#2`, `#3`… if a name ever spawns more than one stream) so each
 * stream is counted separately rather than silently sharing a bucket. */
const drawCounts = new Map<string, number>();
/** Outcomes worth pinning, by the same key — a scenario may record more than
 * one (a run records both clear% and net wood). */
const identityValues = new Map<string, { label: string; value: number }[]>();

function streamKey(name: string): string {
  if (!drawCounts.has(name)) return name;
  let n = 2;
  while (drawCounts.has(`${name}#${n}`)) n++;
  return `${name}#${n}`;
}

function scenarioRng(name: string): () => number {
  const base = mulberry32((moves.seed ^ hashString(name)) >>> 0);
  const key = streamKey(name);
  drawCounts.set(key, 0);
  return () => {
    drawCounts.set(key, drawCounts.get(key)! + 1);
    return base();
  };
}

/** Records an outcome against a scenario's FIRST stream — every caller runs
 * exactly one stream per name today, and the suffixing above exists only so a
 * future second stream can't corrupt the first one's count. */
function recordIdentity(name: string, label: string, value: number): void {
  const rows = identityValues.get(name) ?? [];
  rows.push({ label, value });
  identityValues.set(name, rows);
}

function reportIdentity(): void {
  if (!process.env.SIM_IDENTITY) return;
  console.log("\nIdentity baseline (SIM_IDENTITY=1):");
  for (const [key, draws] of drawCounts) {
    const rows = identityValues.get(key) ?? [];
    // toPrecision(17) rather than the display toFixed(1) used everywhere else:
    // the whole point is to expose drift far below what a reader would notice.
    const outcomes = rows.map((r) => `${r.label}=${r.value.toPrecision(17)}`).join(" ");
    console.log(`  ID  ${key}  draws=${draws}${outcomes ? `  ${outcomes}` : ""}`);
  }
}

// --- Party construction ----------------------------------------------------

function buildParty(specs: PartyMemberSpec[]): {
  party: TeamMemberSave[];
  inventory: ItemInstance[];
} {
  const inventory: ItemInstance[] = [];
  let itemSeq = 1;
  const party = specs.map((spec, i) => {
    const member = createMember(spec.defId, i + 1);
    member.level = spec.level;
    for (const [slot, defId] of Object.entries(spec.items ?? {})) {
      const inst: ItemInstance = { id: `i-${itemSeq++}`, defId };
      inventory.push(inst);
      member.equipped[slot as "woodchopping" | "adventuring" | "utility"] = inst.id;
    }
    syncHp(member, inventory, 0);
    member.currentHp = member.maxHp;
    return member;
  });
  return { party, inventory };
}

// --- Turn policies ---------------------------------------------------------

/** Simulated Defend skill-check outcome — the real one is a timing minigame
 * (scene-side), so the sim stands in a fixed outcome distribution for it. */
function rollGrade(rng: () => number): SkillGrade {
  const r = rng();
  return r < 0.35 ? "great" : r < 0.8 ? "good" : "miss";
}

interface RunFlags {
  abilityUsed: boolean;
}

function decideAction(
  policy: Policy,
  battle: BattleSnapshot,
  party: TeamMemberSave[],
  actor: TeamMemberSave,
  inventory: ItemInstance[],
  flags: RunFlags,
  rng: () => number,
): { action: "attack" | "defend" | "ability"; grade?: SkillGrade } {
  const hpFrac = actor.currentHp / actor.maxHp;

  if (policy === "smart" && !flags.abilityUsed) {
    const effect = equippedItem(actor, "adventuring", inventory)?.effectId;
    if (effect === "bossBribe" && battle.enemies.every((u) => u.spec.stage === 5)) {
      return { action: "ability" };
    }
    if (effect === "vampiricHeal") {
      const missing = party.reduce(
        (sum, m) => sum + (m.currentHp > 0 ? m.maxHp - m.currentHp : 0),
        0,
      );
      const total = party.reduce((sum, m) => sum + m.maxHp, 0);
      if (missing / total > 0.35) return { action: "ability" };
    }
    if (effect === "logSlamReflect" && battle.round === 1) {
      return { action: "ability" };
    }
    if (effect === "lastStand" && party.some((m) => m.currentHp > 0 && m.currentHp / m.maxHp < 0.3)) {
      return { action: "ability" };
    }
  }

  // Defend when low — but only while someone healthier is still attacking.
  // Defending sheds aggro (the enemy targets the round's top damage dealer,
  // never a defender), so a low member ducking behind healthy attackers is
  // sound play; the whole party turtling at once deals 0 damage and can only
  // stall into an eventual loss, which no sane player does.
  const someoneElseHealthy = party.some(
    (m) => m.id !== actor.id && m.currentHp > 0 && m.currentHp / m.maxHp >= 0.4,
  );
  if ((policy === "guard-low" || policy === "smart") && hpFrac < 0.4 && someoneElseHealthy) {
    return { action: "defend", grade: rollGrade(rng) };
  }
  return { action: "attack" };
}

// --- Single-battle simulation ----------------------------------------------

const MAX_TURNS = 600;

function runOneBattle(
  party: TeamMemberSave[],
  inventory: ItemInstance[],
  world: number,
  stage: Stage,
  policy: Policy,
  /** Unused now that the legacy stack map is gone; kept positionally so the
   * scenario call sites stay untouched. */
  _legacyBoons: Record<string, number>,
  flags: RunFlags,
  rng: () => number,
  /** The run's derived build. Omitted by the single-battle scenarios, which
   * fight with no run around them; supplied by the delve driver so a build
   * actually affects the fights it was built for. */
  stats?: RunStats,
  /** Elite modifier, when this room has one. */
  affix?: string,
): "win" | "loss" {
  const battle = startBattle(party, buildEnemy(world, stage, affix as never), inventory, { stats });
  let guard = 0;
  while (!battle.outcome && guard++ < MAX_TURNS) {
    const actorId = battle.turnOrder[battle.turnIndex];
    if (!actorId) break;
    const actor = party.find((m) => m.id === actorId);
    if (!actor) break;
    const { action, grade } = decideAction(policy, battle, party, actor, inventory, flags, rng);
    const events = resolveTurn({
      battle,
      party,
      memberId: actorId,
      action,
      defendGrade: grade,
      inventory,
      stats: stats ?? baseRunStats(),
      rng,
    });
    if (action === "ability" && events.some((e: { kind: string }) => e.kind === "ability" || e.kind === "heal")) {
      flags.abilityUsed = true;
    }
  }
  return isBattleOver(battle) === "win" ? "win" : "loss";
}

function battleWinPct(scn: BattleScenario): number {
  const rng = scenarioRng(scn.name);
  let wins = 0;
  for (let t = 0; t < scn.trials; t++) {
    const { party, inventory } = buildParty(scn.party);
    const flags: RunFlags = { abilityUsed: false };
    if (runOneBattle(party, inventory, scn.world, scn.stage, scn.policy, {}, flags, rng) === "win") {
      wins++;
    }
  }
  return (100 * wins) / scn.trials;
}

// --- Full-run simulation ---------------------------------------------------
//
// Mirrors Game.startAdventure/beginStageBattle/finalizeBattleOutcome/
// bankAdventure: embark fee covers stage 1, continue fees for stages 2-5,
// per-stage wood scaled by the party's expeditionBonusPct, a boon pick after
// every non-final win, milestone chest wood at stages 3/5, banking 100% on a
// clear and 50% on a loss (the sim never revives — a wipe ends the run, the
// same as declining the Team Down offer).

/**
 * Walks a whole twelve-room delve headlessly.
 *
 * Mirrors Game's room state machine: enter, fight, take the reward, choose a
 * door, repeat — including descent tolls at the two Depth boundaries, acorn
 * income, curse countdown and Bark carried between rooms. It is deliberately a
 * SEPARATE implementation rather than a call into Game, because Game imports
 * Tauri and the DOM; the price of that is that the two can drift, which is
 * exactly why the invariants below assert shape (a run always ends, always in
 * twelve rooms or fewer, always with a legal build) rather than exact numbers
 * that would only ever agree by coincidence.
 *
 * `boonPolicy` decides which card gets taken, which is how the per-patron
 * dominance check gets its different builds.
 */
function runFullDelve(
  scn: RunScenario,
  rng: () => number,
): { cleared: boolean; netWood: number; roomsCleared: number; boons: BoonInstance[]; acorns: number } {
  const { party, inventory } = buildParty(scn.party);
  const mult = getWorld(scn.world).mult;
  const flags: RunFlags = { abilityUsed: false };
  const seed = Math.floor(rng() * 1e9);
  const map = generateRunMap(seed);

  let held: BoonInstance[] = [];
  const charms: string[] = [];
  let acorns = 0;
  let netWood = -embarkCost(mult);
  let pendingWood = 0;
  let roomsCleared = 0;

  const statsNow = () =>
    deriveRunStats({ party, inventory, prestigeLevel: 0, boonList: held, charms, world: scn.world });

  let room = map.slots[0][0];
  for (let guard = 0; guard < TOTAL_ROOMS * 2 && roomsCleared < TOTAL_ROOMS; guard++) {
    const stats = statsNow();

    if (room.kind === "fight" || room.kind === "elite" || room.kind === "boss") {
      // Elites fight with their affix here too, or the balance numbers are
      // measured against a run that is easier than the one that ships.
      const enemies = buildEnemy(scn.world, roomTier(roomsCleared), room.affix as never);
      const totalReward = enemies.reduce((sum, e) => sum + e.woodReward, 0);
      const outcome = runOneBattle(party, inventory, scn.world, roomTier(roomsCleared), scn.policy, {}, flags, rng, stats, room.affix);
      if (outcome === "loss") {
        return { cleared: false, netWood: netWood + Math.floor(pendingWood * 0.5), roomsCleared, boons: held, acorns };
      }
      pendingWood += Math.round(totalReward * (1 + stats.values.expeditionPct) * stats.values.woodMult);
      acorns += Math.round(roomAcorns(depthOf(roomsCleared), room.kind, rng) * stats.values.acornMult);
      for (const m of party) grantXp(m, stageXpReward(roomTier(roomsCleared), scn.world), inventory, 0);
      if (room.kind === "boss") {
        netWood += chestReward(scn.world, isFinalRoom(roomsCleared) ? 5 : 3).wood;
      }
    } else if (room.kind === "fountain") {
      // Mirrors Game.resolveSimpleRoom — see the note there on why 35%.
      for (const m of party) {
        if (m.currentHp > 0) m.currentHp = Math.min(m.maxHp, m.currentHp + Math.round(m.maxHp * 0.35));
      }
    } else if (room.kind === "shop") {
      // The stall MUST be shopped here, not skipped.
      //
      // Leaving it out made the harness structurally blind to the entire
      // economy layer: acorns accumulated and were never converted into
      // anything, so Lumen — the patron whose whole identity is earning more —
      // measured as strictly worse than every other build. That was a defect in
      // the measurement being read as a defect in the design, and it survived
      // several rounds of tuning aimed at the wrong thing.
      const shop = rollShop(
        { held, prestigeLevel: 0, rarityLuck: stats.values.rarityLuck },
        depthOf(roomsCleared),
        (seed + roomsCleared * 7919) >>> 0,
        charms,
      );
      for (const entry of shop.stock) {
        if (!canBuy(entry, acorns, charms, held)) continue;
        acorns -= entry.cost;
        entry.sold = true;
        if (entry.kind === "charm") charms.push(entry.refId);
        else if (entry.kind === "boon" && entry.card) held = applyOfferCard(held, entry.card, roomsCleared);
        else if (entry.kind === "consumable" && entry.refId === "salve") {
          for (const m of party) {
            if (m.currentHp > 0) m.currentHp = Math.min(m.maxHp, m.currentHp + Math.round(m.maxHp * 0.4));
          }
        }
      }
    }

    // The room's reward.
    if (room.reward === "boon" || room.reward === "rank" || room.kind === "elite" || room.kind === "boss") {
      const offer = drawOffer(
        { held, prestigeLevel: 0, rarityLuck: stats.values.rarityLuck, extraCards: stats.values.extraOfferCount },
        (seed + roomsCleared * 104729) >>> 0,
        3,
      );
      // Elites and bosses pay at least Epic — the wager the door is asking the
      // player to take. Mirrors Game.drawRoomOffer.
      if (room.kind === "elite" || room.kind === "boss") {
        for (const c of offer.cards) {
          const def = BOON_DEFS_BY_ID[c.boonId];
          if (def && (c.rarity === "common" || c.rarity === "rare")) {
            c.rarity = def.rarities.includes("epic") ? "epic" : def.rarities[def.rarities.length - 1];
          }
        }
      }
      const card = choosePolicyCard(offer.cards, scn.boonPolicy);
      if (card) {
        const def = BOON_DEFS_BY_ID[card.boonId];
        if (def?.slot !== "instant") held = applyOfferCard(held, card, roomsCleared);
      }
    }

    roomsCleared++;
    if (isFinalRoom(roomsCleared - 1)) break;

    // Descent toll at the two Depth boundaries — the only fees after embark.
    const exits = exitsAfter(map, roomsCleared - 1);
    if (!exits || exits.length === 0) break;
    if (isDepthBoundary(roomsCleared - 1)) netWood -= descentToll(mult, exits[0].depth);
    room = choosePolicyDoor(exits, scn.boonPolicy, acorns);
  }

  const cleared = roomsCleared >= TOTAL_ROOMS;
  return { cleared, netWood: netWood + pendingWood, roomsCleared, boons: held, acorns };
}

/** Which card a policy takes. `patron-loyal:*` is how the dominance check
 * builds five genuinely different runs out of one harness. */
function choosePolicyCard(cards: OfferCard[], policy: string): OfferCard | undefined {
  if (cards.length === 0) return undefined;
  if (policy.startsWith("patron-loyal:")) {
    // Loyal but not stupid: prefer the patron, then take that patron's BEST
    // card rather than whichever happened to be dealt first. Taking the first
    // match models a player who cannot read, and measuring a patron by how it
    // performs in the hands of someone not paying attention tells you nothing
    // about whether the patron is viable.
    const want = policy.slice("patron-loyal:".length);
    const mine = cards.filter((c) => BOON_DEFS_BY_ID[c.boonId]?.patron === want);
    const pool = mine.length > 0 ? mine : cards;
    return [...pool].sort(
      (a, b) => boonMagnitude({ rarity: b.rarity, rank: 1 }) - boonMagnitude({ rarity: a.rarity, rank: 1 }),
    )[0];
  }
  const rank = (c: OfferCard): number => {
    const def = BOON_DEFS_BY_ID[c.boonId];
    if (!def) return 0;
    const mag = boonMagnitude({ rarity: c.rarity, rank: 1 });
    const has = (k: string) => def.effects.some((e) => e.kind === "stat" && e.key === k);
    if (policy === "greedy-atk") return (has("atkMult") || has("critChance") || has("critMult") ? 10 : 1) * mag;
    if (policy === "greedy-defense") return (has("armorPct") || has("reflectPct") || has("regenPerRoundPct") ? 10 : 1) * mag;
    if (policy === "worst") return -mag;
    return mag;
  };
  if (policy === "random") return cards[0];
  return [...cards].sort((a, b) => rank(b) - rank(a))[0];
}

/** Which door a policy takes. Everything except an explicitly cautious policy
 * chases the build, which is what makes the "build route is mostly fighting"
 * property real rather than theoretical. */
function choosePolicyDoor(exits: RoomSpec[], policy: string, acorns: number): RoomSpec {
  // Money burning a hole in your pocket beats another card, and every policy
  // behaves this way because every player does. Without it the route never
  // visits a stall, the economy layer is never exercised, and the patron built
  // around earning measures as though earning did nothing.
  if (acorns >= 30) {
    const stall = exits.find((r) => r.kind === "shop");
    if (stall) return stall;
  }
  if (policy === "greedy-defense") {
    return exits.find((r) => r.reward === "heal") ?? exits[0];
  }
  // Someone has to walk the dangerous route, or elites are content the balance
  // numbers never see. This policy takes every elite it is offered, which is
  // the wager at its most extreme — it should be survivable, not a death
  // sentence, or the door is a trap dressed as a choice.
  if (policy === "elite-seeker") {
    return exits.find((r) => r.kind === "elite") ?? exits.find((r) => r.reward === "boon" || r.reward === "rank") ?? exits[0];
  }
  return exits.find((r) => r.reward === "boon" || r.reward === "rank") ?? exits[0];
}

// --- Gacha invariants ---// --- Gacha invariants ------------------------------------------------------

/** Minimal GameSave-shaped object for the pure gacha resolvers — built here
 * instead of importing game-state's defaultSave() so the sim never touches a
 * module that pulls in @tauri-apps/api. */
function makeSave(): GameSave {
  return {
    version: 5,
    wood: 0,
    totalWoodEarned: 0,
    focus: 0,
    amber: 0,
    worldIndex: 0,
    plotIndex: 0,
    plotsClearedInWorld: 0,
    helpers: [],
    cosmetics: [],
    equippedCap: null,
    equippedTreeSkin: null,
    currentPlotHp: null,
    team: [],
    inventory: [],
    shards: { common: 0, rare: 0, epic: 0, legendary: 0 },
    pity: { worker: 0, item: [], powerup: 0 },
    powerups: [],
    nextMemberSeq: 1,
    nextItemSeq: 1,
    adventure: null,
    provisions: { trailRations: 0, fortuneCharm: 0, emergencyRope: 0 },
    prestigeLevel: 0,
    adventureWorldUnlocked: 0,
    stats: {
      treesFelled: 0,
      eldersFelled: 0,
      chops: 0,
      tokensSeen: 0,
      clicks: 0,
      goldenSpotsHit: 0,
      startedAt: "sim",
      adventuresEmbarked: 0,
      adventuresCleared: 0,
      adventuresFailed: 0,
      woodFromAdventures: 0,
    },
  };
}

// --- Build dominance -------------------------------------------------------
//
// THE check this rework exists to pass.
//
// The old boon set had one correct answer — take the biggest number — so every
// run converged on the same build and the choice was decoration. Five patrons
// only fix that if committing to any of them actually works. If Cinder clears
// at 80% and Sap at 20%, the door sigils stop being a decision within about
// three runs and the whole system collapses back into "take the good one".
//
// So: run the same party, at the same gear, through the same twelve rooms,
// with the pick policy locked to each patron in turn. Every path has to land
// above a floor, and the SPREAD between them has to stay narrow. A wide spread
// here is not a tuning nit — it means one of the five is a trap.

function buildDominanceChecks(): void {
  const cfg = moves.boonPaths;
  if (!cfg) return;
  console.log("\nBuild dominance (no patron is a trap):");
  const base = moves.runs.find((r) => r.name === cfg.scenario);
  if (!base) {
    check("dominance scenario resolves", false, `unknown scenario ${cfg.scenario}`);
    return;
  }

  const results: { policy: string; clearPct: number; rooms: number; wood: number }[] = [];
  for (const policy of cfg.policies) {
    const rng = scenarioRng(`dominance-${policy}`);
    let clears = 0;
    let rooms = 0;
    let wood = 0;
    for (let t = 0; t < cfg.trials; t++) {
      const out = runFullDelve({ ...base, boonPolicy: policy, trials: cfg.trials }, rng);
      if (out.cleared) clears++;
      rooms += out.roomsCleared;
      wood += out.netWood;
    }
    results.push({
      policy,
      clearPct: (100 * clears) / cfg.trials,
      rooms: rooms / cfg.trials,
      wood: wood / cfg.trials,
    });
  }

  for (const r of results) {
    check(
      `  ${r.policy}`,
      r.clearPct >= cfg.minClearPct,
      `clears ${r.clearPct.toFixed(1)}%, room ${r.rooms.toFixed(1)}/${TOTAL_ROOMS}, ${Math.round(r.wood)} wood`,
    );
  }

  // THE REAL QUESTION, and it is not "does every path clear equally".
  //
  // Lumen is the greed patron: it trades combat power for payout, and holding
  // it to the same clear rate as Bramble would erase the only thing that makes
  // it a distinct choice. A path is a TRAP only if it is worse at everything.
  //
  // So the test is a Pareto one: for every path, at least one of "clears more"
  // or "earns more" must beat the field average. A path that loses on both is
  // a patron nobody should ever pick, which is exactly what this exists to
  // catch — and is exactly what Lumen was before the defensive Auras landed.
  const avgClear = results.reduce((sum, r) => sum + r.clearPct, 0) / results.length;
  const avgWood = results.reduce((sum, r) => sum + r.wood, 0) / results.length;
  const dominated = results.filter((r) => r.clearPct < avgClear * 0.75 && r.wood < avgWood);
  check(
    "no build path is worse at everything",
    dominated.length === 0,
    dominated.length === 0
      ? `field avg ${avgClear.toFixed(0)}% clear / ${Math.round(avgWood)} wood`
      : dominated.map((r) => `${r.policy} (${r.clearPct.toFixed(0)}%, ${Math.round(r.wood)}w)`).join("; "),
  );

  const spread = Math.max(...results.map((r) => r.clearPct)) - Math.min(...results.map((r) => r.clearPct));
  const best = results.reduce((a, b) => (a.clearPct > b.clearPct ? a : b));
  const worst = results.reduce((a, b) => (a.clearPct < b.clearPct ? a : b));
  check(
    "clear rates stay within a playable spread",
    spread <= cfg.maxSpreadPct,
    `spread ${spread.toFixed(1)}% (best ${best.policy} ${best.clearPct.toFixed(1)}%, worst ${worst.policy} ${worst.clearPct.toFixed(1)}%)`,
  );

  // WHOSE FAULT IS THE LOSS?
  //
  // The least addictive thing a roguelike can do is take a run away before the
  // player has made any decisions worth blaming. A loss in room two is a bad
  // draw; a loss in room ten is a build that did not come together, and only
  // the second one makes anybody want to go again.
  //
  // So: where do losses actually happen? Depth I is four rooms in, with at most
  // three picks made — a run that dies there was decided by the deal.
  {
    const rng = scenarioRng("loss-attribution");
    const depthOfLoss = [0, 0, 0];
    let losses = 0;
    for (let t = 0; t < 400; t++) {
      const out = runFullDelve({ ...base, boonPolicy: "greedy-atk", trials: 400 }, rng);
      if (out.cleared) continue;
      losses++;
      depthOfLoss[depthOf(out.roomsCleared) - 1]++;
    }
    const early = losses > 0 ? (100 * depthOfLoss[0]) / losses : 0;
    check(
      "losses are not decided before the player has decided anything",
      early <= 25,
      losses === 0
        ? "no losses to attribute"
        : `${early.toFixed(0)}% of ${losses} losses fell in Depth I (${depthOfLoss.join("/")} by depth)`,
    );
  }

  // ESCALATION. Difficulty has to outrun the build, or the back half of a run
  // is a victory lap; it must not outrun it so far that the run walls.
  {
    const rng = scenarioRng("escalation");
    const reached = new Array(TOTAL_ROOMS + 1).fill(0);
    const RUNS = 300;
    for (let t = 0; t < RUNS; t++) {
      const out = runFullDelve({ ...base, boonPolicy: "greedy-atk", trials: RUNS }, rng);
      reached[out.roomsCleared]++;
    }
    // Where runs actually end, as a distribution.
    const deaths = reached.slice(0, TOTAL_ROOMS);
    const worstRoom = deaths.indexOf(Math.max(...deaths));
    const anyWall = deaths.some((n) => n / RUNS > 0.35);
    check(
      "no single room walls the run",
      !anyWall,
      `deadliest room ${worstRoom} takes ${((100 * Math.max(...deaths)) / RUNS).toFixed(0)}% of runs`,
    );
  }

  // A delve must always terminate. An infinite fight — two units that cannot
  // hurt each other, a regen build out-healing its own damage — would hang the
  // real game with no way out but killing the app.
  {
    const rng = scenarioRng("delve-terminates");
    let stuck = 0;
    for (let t = 0; t < 60; t++) {
      const out = runFullDelve({ ...base, boonPolicy: "greedy-defense", trials: 60 }, rng);
      if (out.roomsCleared === 0 && !out.cleared) stuck++;
    }
    check("every delve terminates", stuck === 0, `${stuck} stalled of 60`);
  }

  // A cleared run must leave the player with a real build, not a pile of
  // whatever came up. If a full clear ends with two boons, the offer cadence is
  // wrong and the run never had a chance to become anything.
  {
    const rng = scenarioRng("delve-build-size");
    let sum = 0;
    let runs = 0;
    let maxHeld = 0;
    for (let t = 0; t < 80; t++) {
      const out = runFullDelve({ ...base, boonPolicy: "greedy-atk", trials: 80 }, rng);
      if (!out.cleared) continue;
      runs++;
      sum += out.boons.length;
      maxHeld = Math.max(maxHeld, out.boons.length);
    }
    const avg = runs > 0 ? sum / runs : 0;
    check("a cleared run ends with a real build", runs > 0 && avg >= 4, `${avg.toFixed(1)} boons held on average, peak ${maxHeld}`);
    // And never an illegal one: Aura and Fortune have hard caps, and a run that
    // quietly exceeded them would make the slot budget meaningless.
    check("held builds never exceed their slot caps", maxHeld <= AURA_CAP + FORTUNE_CAP + 3, `peak ${maxHeld} vs ceiling ${AURA_CAP + FORTUNE_CAP + 3}`);
  }

  // Acorn income has to cover roughly two purchases across a run, or the shop
  // is a room the player walks through rather than uses.
  {
    const rng = scenarioRng("delve-acorns");
    let sum = 0;
    let n = 0;
    for (let t = 0; t < 80; t++) {
      const out = runFullDelve({ ...base, boonPolicy: "greedy-atk", trials: 80 }, rng);
      if (!out.cleared) continue;
      sum += out.acorns;
      n++;
    }
    const avg = n > 0 ? sum / n : 0;
    check("a full run affords about two purchases", avg >= 40 && avg <= 400, `${avg.toFixed(0)} acorns earned`);
  }
}

// --- Gear helpers ----------------------------------------------------------
//
// The Team screen tells the player two things it has to be right about: which
// members have a better item sitting unused, and what "Auto-equip" will do.
// Both answers come from itemScore, and the failure that matters is the two
// DISAGREEING — a badge promising an upgrade that the optimiser then declines
// to make is worse than no badge, because it sends the player looking for
// something that is not there.

function fusionChecks(): void {
  console.log("\nFusion altar:");

  const roster = (spec: [string, number][]): TeamMemberSave[] =>
    spec.map(([defId, starRank], i) => {
      const m = createMember(defId, i + 1);
      if (starRank) m.starRank = starRank;
      syncHp(m, [], 0);
      m.currentHp = m.maxHp;
      return m;
    });

  const saveWith = (team: TeamMemberSave[]): FusionSave => ({
    team,
    inventory: [],
    shards: { common: 0, rare: 0, epic: 0, legendary: 0 },
    prestigeLevel: 0,
  });

  // Four commons plus a common target — the minimum legal altar.
  const commons = (): TeamMemberSave[] =>
    roster([["rook", 0], ["finch", 0], ["marl", 0], ["sable", 0], ["rook", 0]]);

  // THE LADDER. A merge must move the target exactly one tier, and the top of
  // the ladder must be a wall rather than a silent no-op that eats four
  // workers for nothing.
  {
    const save = saveWith(commons());
    const plan = planFusion("m-1", ["m-2", "m-3", "m-4", "m-5"], save);
    check("a common merge plans to rare", plan?.toRarity === "rare", plan?.toRarity ?? "no plan");

    const legend = roster([["ironbark", 0], ["duskveil", 0], ["ironbark", 0], ["ironbark", 0], ["ironbark", 0]]);
    check(
      "a legendary can never be a target",
      canFuse(legend[0]).reason === "maxed",
      canFuse(legend[0]).reason ?? "allowed",
    );
  }

  // ARITY. Exactly four sacrifices — not three, not five, and never the target
  // itself or the same worker in two sockets.
  {
    const save = saveWith(commons());
    check("three sacrifices is not a merge", planFusion("m-1", ["m-2", "m-3", "m-4"], save) === null, "");
    check(
      "five sacrifices is not a merge",
      planFusion("m-1", ["m-2", "m-3", "m-4", "m-5", "m-1"], save) === null,
      "",
    );
    check(
      "a worker cannot sacrifice itself",
      planFusion("m-1", ["m-1", "m-2", "m-3", "m-4"], save) === null,
      "",
    );
    check(
      "one worker cannot fill two sockets",
      planFusion("m-1", ["m-2", "m-2", "m-3", "m-4"], save) === null,
      "",
    );
  }

  // TIER MATCH. Fodder is paid in rank, so a rare cannot be spent on a common
  // merge — and, more subtly, a common merged UP to rare must count as rare
  // fodder from then on.
  {
    const mixed = roster([["rook", 0], ["finch", 0], ["marl", 0], ["sable", 0], ["birch", 0]]);
    check(
      "a rare cannot pay for a common merge",
      planFusion("m-1", ["m-2", "m-3", "m-4", "m-5"], saveWith(mixed)) === null,
      "",
    );
    const promoted = roster([["rook", 1], ["finch", 0], ["marl", 0], ["sable", 0], ["rook", 0]]);
    check(
      "a merged common counts as its new tier",
      effectiveRarity(promoted[0]) === "rare" &&
        planFusion("m-1", ["m-2", "m-3", "m-4", "m-5"], saveWith(promoted)) === null,
      effectiveRarity(promoted[0]),
    );
  }

  // TRANSITIVITY. Merge twice and the worker must be reading the epic row of
  // WORKER_RARITY_MULT, not carrying a starRank nobody looks at.
  {
    const twice = roster([["rook", 2]])[0];
    check("two merges reach epic", effectiveRarity(twice) === "epic", effectiveRarity(twice));
    check("stars encode the tier", starCount(twice) === 3, `${starCount(twice)} stars`);
    const capped = roster([["ironbark", 9]])[0];
    check("starRank cannot overflow the ladder", effectiveRarity(capped) === "legendary", effectiveRarity(capped));
  }

  // MONOTONICITY, and the identity that makes the whole stat change safe: at
  // rank 0 the star multiplier must be exactly 1, not merely close to it.
  {
    const base = roster([["rook", 0]])[0];
    check("rank 0 is exactly neutral", starMult(base) === 1, `${starMult(base)}`);
    let rising = true;
    let prevAtk = 0;
    let prevHp = 0;
    for (let rank = 0; rank <= 3; rank++) {
      const m = roster([["rook", rank]])[0];
      const atk = effectiveAtk(m, [], 0);
      const hp = effectiveMaxHp(m, [], 0);
      if (rank > 0 && (atk <= prevAtk || hp <= prevHp)) rising = false;
      prevAtk = atk;
      prevHp = hp;
    }
    check("every merge is a strict stat gain", rising, `rook rank 0..3 -> ${prevAtk.toFixed(0)} atk`);
  }

  // DELETION SAFETY. Nothing in this codebase had ever removed a team member
  // before the altar, so every id-holder is a hazard. A worker on a run and a
  // worker resting are both mid-something the merge cannot unwind, and stay
  // untouchable.
  //
  // A worker out CHOPPING is deliberately not on that list any more. It used
  // to be, because deleting the member a live woodcutter pointed at left a
  // permanent ghost swinging at one damage; Game now retires that sprite —
  // it walks off and the slot passes to the next worker in roster order — so
  // being busy is no longer a veto. This check exists to keep that decision
  // deliberate rather than letting it rot back into a refusal.
  {
    const team = commons();
    team[1].status = "adventuring";
    team[2].status = "resting";
    const save = saveWith(team);
    check("a worker on a run cannot be spent", canSacrifice(team[1]).reason === "adventuring", "");
    check("a resting worker cannot be spent", canSacrifice(team[2]).reason === "resting", "");
    check("an available worker can be spent while busy", canSacrifice(team[3]).ok, "");
    check(
      "a merge naming an ineligible worker is refused",
      planFusion("m-1", ["m-2", "m-3", "m-4", "m-5"], save) === null,
      "",
    );
  }

  // CONSERVATION. The sacrifices' gear goes back in the bag. Losing four
  // workers is the price; losing their equipment with them is a bug.
  {
    const defs = itemDefsForWorld(0);
    const inventory: ItemInstance[] = defs.map((d, i) => ({ id: `i-${i}`, defId: d.defId }));
    const team = commons();
    team[1].equipped.woodchopping = inventory[0].id;
    team[2].equipped.adventuring = inventory[1].id;
    const save: FusionSave = { team, inventory, shards: { common: 0, rare: 0, epic: 0, legendary: 0 }, prestigeLevel: 0 };
    const before = save.inventory.length;
    const plan = planFusion("m-1", ["m-2", "m-3", "m-4", "m-5"], save)!;
    const ok = applyFusion(save, plan);
    const stillWorn = equippedInstanceIds(save.team);
    check("the merge commits", ok && save.team.length === 1, `${save.team.length} left`);
    check("no item is destroyed by a merge", save.inventory.length === before, `${save.inventory.length}/${before}`);
    check(
      "a sacrifice's gear returns to the bag",
      !stillWorn.has(inventory[0].id) && !stillWorn.has(inventory[1].id),
      `${stillWorn.size} still worn`,
    );
    check("the target keeps its id", save.team[0]?.id === "m-1", save.team[0]?.id ?? "gone");
    check("the target gained a rank", save.team[0]?.starRank === 1, `${save.team[0]?.starRank}`);
  }

  // A stale plan must not delete the wrong four. The altar can sit open across
  // an autosave, a chest reward, or a member being sent on a run elsewhere.
  {
    const save = saveWith(commons());
    const plan = planFusion("m-1", ["m-2", "m-3", "m-4", "m-5"], save)!;
    save.team[2].status = "adventuring"; // someone embarked while the panel sat open
    check("a stale plan is refused, not committed", applyFusion(save, plan) === false, `${save.team.length} intact`);
    check("nothing was consumed by the refusal", save.team.length === 5, `${save.team.length}`);
  }

  // AUTO-FILL must never reach for the worker you invested in, and must be
  // deterministic so a second press cannot quietly pick differently.
  {
    // Six commons, so auto-fill has one more candidate than it needs and the
    // choice it makes is a real one. With exactly four candidates it has no
    // choice at all, which would make this check pass for the wrong reason.
    const team = roster([
      ["rook", 0], ["finch", 0], ["marl", 0], ["sable", 0], ["rook", 0], ["finch", 0],
    ]);
    team[1].level = 12; // the one you spent shards on
    const save = saveWith(team);
    const first = autoFillFodder("m-1", save);
    const second = autoFillFodder("m-1", save);
    check("auto-fill is deterministic", first.join() === second.join(), first.join());
    check("auto-fill leaves the levelled worker alone", !first.includes("m-2"), first.join());
    check("auto-fill fills every socket", first.length === FUSION_FODDER_COUNT, `${first.length}`);

    // Short of a full altar it seats what it can rather than refusing — the
    // player can see three sockets filled and one empty and go find one more,
    // where an empty pedestal would just look broken.
    const thin = saveWith(roster([["rook", 0], ["finch", 0], ["marl", 0]]));
    check("auto-fill part-fills when short", autoFillFodder("m-1", thin).length === 2, "");
    check("the shortfall is reportable", fodderAvailable("m-1", thin) === 2, `${fodderAvailable("m-1", thin)}`);
  }

  // THE SHARD BARGAIN. A sacrifice must refund exactly what the old duplicate
  // rule paid at the pull, or moving the payout has quietly changed the
  // economy rather than just its timing.
  {
    let mismatches = 0;
    for (const [defId, tier] of [["rook", "common"], ["birch", "rare"], ["thorne", "epic"]] as const) {
      const team = roster([[defId, 0], [defId, 0], [defId, 0], [defId, 0], [defId, 0]]);
      const save = saveWith(team);
      const plan = planFusion("m-1", ["m-2", "m-3", "m-4", "m-5"], save)!;
      if (plan.shardRefund.amount !== FUSION_FODDER_COUNT * SHARD_VALUE[tier]) mismatches++;
      if (plan.shardRefund.rarity !== tier) mismatches++;
      applyFusion(save, plan);
      if (save.shards[tier] !== FUSION_FODDER_COUNT * SHARD_VALUE[tier]) mismatches++;
    }
    check("a sacrifice refunds the old duplicate payout", mismatches === 0, `${mismatches} mismatches`);
  }

  // No shard value is destroyed by the new pull rule. Duplicates now arrive as
  // workers instead of shards, so the shards a player USED to be handed must
  // still be reachable — either already banked, or sitting on the roster as a
  // copy waiting for an altar.
  {
    const save = makeSave();
    const rng = scenarioRng("fusion-economy");
    const owned = new Set<string>();
    let oldRuleShards = 0;
    let copiesMade = 0;
    for (let i = 0; i < 400; i++) {
      const result = pullWorker(save, rng);
      // The def sequence is independent of the roster (the pool filters on
      // rarity and prestige only), so the same draw would have produced the
      // same character under the old rule — which makes this a fair
      // comparison rather than two unrelated runs.
      if (owned.has(result.def.id)) oldRuleShards += SHARD_VALUE[result.def.rarity];
      owned.add(result.def.id);
      if (result.isNew && (result.copiesHeld ?? 1) > 1) copiesMade++;
    }
    const banked = RARITY_ORDER.reduce((sum, r) => sum + save.shards[r], 0);
    const onTheRoster = save.team.reduce((sum, m, _i, arr) => {
      const first = arr.findIndex((x) => x.defId === m.defId) === arr.indexOf(m);
      return first ? sum : sum + SHARD_VALUE[effectiveRarity(m)];
    }, 0);
    check(
      "duplicates now arrive as workers, not shards",
      copiesMade > 0,
      `${copiesMade} extra copies over 400 pulls`,
    );
    check(
      "no shard value is destroyed by the new pull rule",
      banked + onTheRoster >= oldRuleShards,
      `${banked} banked + ${onTheRoster} on the roster vs ${oldRuleShards} under the old rule`,
    );
    const overCap = WORKER_DEFS.filter(
      (d) => save.team.filter((m) => m.defId === d.id).length > MAX_COPIES_PER_WORKER,
    );
    check("no character exceeds the copy cap", overCap.length === 0, `${overCap.length} over ${MAX_COPIES_PER_WORKER}`);
  }

  // FIVE OF ONE CHARACTER. The roster groups identical workers into a single
  // stacked row, and the altar has to be able to draw every copy out of that
  // one pile — the first version seated the stack's first member and then went
  // inert, leaving the other four unreachable. The engine side of that is
  // this: five copies of one defId are a legal, complete altar.
  {
    const five = roster([["rook", 0], ["rook", 0], ["rook", 0], ["rook", 0], ["rook", 0]]);
    const save = saveWith(five);
    const fodder = autoFillFodder("m-1", save);
    check("one character can fill a whole altar", fodder.length === FUSION_FODDER_COUNT, fodder.join());
    const plan = planFusion("m-1", fodder, save);
    check("and that altar is a legal merge", plan?.toRarity === "rare", plan?.toRarity ?? "no plan");
    check(
      "every socket is a different copy",
      new Set(fodder).size === fodder.length && !fodder.includes("m-1"),
      fodder.join(),
    );
  }

  // POWER CEILING. Merging is a new route to Legendary that bypasses the 1%
  // pull rate, so the top of that route has to be a number someone chose
  // rather than one that fell out. A Common merged three times is Legendary
  // with a 1.6x star multiplier on top — strictly better than anything the
  // gacha can hand you, which is correct only because of what it costs.
  {
    const pulled = roster([["ironbark", 0]])[0];
    const climbed = roster([["rook", 3]])[0];
    const pulledAtk = effectiveAtk(pulled, [], 0);
    const climbedAtk = effectiveAtk(climbed, [], 0);
    check(
      "a fully merged common tops out at a pulled legendary x1.6",
      effectiveRarity(climbed) === "legendary" && Math.abs(climbedAtk / pulledAtk - 1.6) < 0.001,
      `${climbedAtk.toFixed(0)} vs ${pulledAtk.toFixed(0)} = x${(climbedAtk / pulledAtk).toFixed(2)}`,
    );
    // 5 commons per rare, 5 rares per epic, 5 epics per legendary.
    const commonsPerLegendary = Math.pow(FUSION_FODDER_COUNT + 1, 3);
    check(
      "that ceiling costs 125 commons",
      commonsPerLegendary === 125,
      `${commonsPerLegendary} commons for one merged legendary`,
    );
  }

  // starRank is additive-optional, so a save written before the altar existed
  // must read as rank 0 and survive a double migration unchanged.
  {
    const raw: Record<string, unknown> = {
      version: 6,
      team: [{ id: "m-1", defId: "rook", level: 3, currentHp: 10, maxHp: 10, status: "available", equipped: { woodchopping: null, adventuring: null, utility: null } }],
    };
    const once = migrateSave(JSON.parse(JSON.stringify(raw)), makeSave(), 6);
    const twice = migrateSave(JSON.parse(JSON.stringify(once)), makeSave(), 6);
    check("a pre-fusion member reads as rank 0", (once.team[0]?.starRank ?? 0) === 0, `${once.team[0]?.starRank}`);
    check(
      "a pre-fusion member keeps its own rarity",
      effectiveRarity(once.team[0]) === "common",
      effectiveRarity(once.team[0]),
    );
    check("migrating twice changes nothing", JSON.stringify(once) === JSON.stringify(twice), "");
  }
}

function gearHelperChecks(): void {
  console.log("\nTeam gear helpers:");

  const defs = itemDefsForWorld(0);
  const build = () => {
    const inventory: ItemInstance[] = defs.map((d, i) => ({ id: `i-${i}`, defId: d.defId }));
    const members = ["rook", "finch", "birch", "thorne", "ironbark"].map((id, i) => {
      const m = createMember(id, i + 1);
      m.level = 1 + i * 3;
      syncHp(m, inventory, 0);
      m.currentHp = m.maxHp;
      return m;
    });
    return { members, inventory };
  };

  // Scoring must be a strict ranking, or "best" is whatever the sort happened
  // to leave on top.
  {
    const wood = defs.filter((d) => d.slot === "woodchopping");
    const scores = wood.map(itemScore);
    check("every item scores above zero", scores.every((v) => v > 0), `${scores.length} woodchopping items`);
    const byRarity = ["common", "rare", "epic", "legendary"].map(
      (r) => wood.filter((d) => d.rarity === r).map(itemScore)[0] ?? 0,
    );
    check(
      "rarer gear scores higher",
      byRarity.every((v, i) => i === 0 || v > byRarity[i - 1]),
      byRarity.map((v) => v.toFixed(0)).join(" < "),
    );
  }

  // THE AGREEMENT. After Auto-equip there must be no upgrade badges left: if
  // the optimiser is done, every badge must have gone quiet.
  {
    const { members, inventory } = build();
    sortRosterByPower(members, inventory, 0);
    optimizeEquipment(members, inventory, false);
    const slots: (ItemSlot | "utility2")[] = ["woodchopping", "adventuring", "utility"];
    const stragglers = members.flatMap((m) =>
      slots.filter((slot) => bestUpgradeFor(m, slot, inventory, members) !== null).map((slot) => `${m.id}/${slot}`),
    );
    check(
      "no upgrade badge survives Auto-equip",
      stragglers.length === 0,
      stragglers.join(", ") || `${members.length} members clean`,
    );
  }

  // And the sort has to actually rank: strongest first, every time.
  {
    const { members, inventory } = build();
    sortRosterByPower(members, inventory, 0);
    const powers = members.map((m) => memberPower(m, inventory, 0));
    check(
      "the roster sorts strongest-first",
      powers.every((v, i) => i === 0 || powers[i - 1] >= v),
      powers.map((v) => Math.round(v)).join(" >= "),
    );
  }

  // A badge must never point at an item somebody is already wearing — that
  // would light up permanently and mean nothing.
  {
    const { members, inventory } = build();
    optimizeEquipment(members, inventory, false);
    const worn = equippedInstanceIds(members);
    const wornDefIds = new Set(
      inventory.filter((i) => worn.has(i.id)).map((i) => i.defId),
    );
    const pointsAtWorn = members.some((m) => {
      const up = bestUpgradeFor(m, "woodchopping", inventory, members);
      if (!up) return false;
      // Legal only if an UNWORN copy of that def exists.
      const unwornCopy = inventory.some((i) => i.defId === up.defId && !worn.has(i.id));
      return !unwornCopy && wornDefIds.has(up.defId);
    });
    check("upgrade badges never point at worn items", !pointsAtWorn, "bag only");
  }

  // Nothing to upgrade to is not an upgrade.
  {
    const inventory: ItemInstance[] = [];
    const m = createMember("rook", 1);
    syncHp(m, inventory, 0);
    check(
      "an empty bag offers no upgrades",
      bestUpgradeFor(m, "woodchopping", inventory, [m]) === null,
      "null",
    );
  }
}

// --- Per-boon value sweep --------------------------------------------------
//
// The dominance panel compares PATRONS. That is the right shape for "is a build
// viable", and completely blind to a single card being an auto-pick or a trap
// inside an otherwise healthy patron — which is the more common failure and the
// one a player actually notices, because they see the card every run.
//
// So: hold the party, the gear and the seeds fixed, force one specific boon into
// the build at a fixed rarity, and fight a contested room. Every boon's win rate
// is then directly comparable to every other's, and to holding nothing at all.
//
// Two failures matter, and they are opposites:
//   - AUTO-PICK: a card so far ahead that taking anything else is a mistake.
//     It makes the offer screen a formality.
//   - DEAD CARD: a card no better than an empty slot. It makes the offer screen
//     a coin flip between two options and one insult.
//
// Economy and meta boons are excluded: their value is acorns and offer quality,
// neither of which a single fight can see. Judging them here would report the
// entire Fortune slot as dead.

function boonValueSweep(): void {
  console.log("\nPer-boon value (no auto-picks, no dead cards):");

  const rosterAt = (level: number) => [
    { defId: "birch", level, items: { adventuring: "w0-adventuring-epic" } },
    { defId: "hazel", level, items: { adventuring: "w0-adventuring-epic" } },
    { defId: "thorne", level, items: { adventuring: "w0-adventuring-rare" } },
  ];
  let roster = rosterAt(6);
  let calibratedLevel = 6;

  /** Win rate over one room with exactly this build held. */
  const rate = (held: BoonInstance[], label: string, tier: Stage, scale = 1): number => {
    const rng = scenarioRng(`boonvalue-${label}-${tier}-${scale}`);
    let wins = 0;
    const TRIALS = 240;
    for (let t = 0; t < TRIALS; t++) {
      const { party, inventory } = buildParty(roster);
      const stats = deriveRunStats({ party, inventory, prestigeLevel: 0, boonList: held });
      const battle = startBattle(
        party,
        buildEnemy(0, tier, undefined, { hp: scale, atk: 1 + (scale - 1) * 0.5 }),
        inventory,
        { stats },
      );
      let guard = 0;
      while (!battle.outcome && guard++ < MAX_TURNS) {
        const actorId = battle.turnOrder[battle.turnIndex];
        if (!actorId) break;
        // Defend when badly hurt, so Guard-slot boons are not measured against a
        // party that never guards — that would report every one of them dead.
        const actor = party.find((m) => m.id === actorId)!;
        // Defend only while somebody healthier is still swinging. Without the
        // second clause a party that starts below the threshold has EVERY
        // member defend forever, the fight never resolves, and the scenario
        // scores as a loss for reasons that have nothing to do with what is
        // being measured — which is exactly what made the low-HP situations
        // read as unwinnable at every tier. Mirrors the `smart` policy above.
        const someoneElseHealthy = party.some(
          (m) => m.id !== actor.id && m.currentHp > 0 && m.currentHp / m.maxHp >= 0.45,
        );
        const hurt = actor.currentHp / actor.maxHp < 0.45 && someoneElseHealthy;
        resolveTurn({
          battle,
          party,
          memberId: actorId,
          action: hurt ? "defend" : "attack",
          defendGrade: hurt ? rollGrade(rng) : undefined,
          inventory,
          stats,
          rng,
        });
      }
      if (battle.outcome === "win") wins++;
    }
    return (100 * wins) / TRIALS;
  };

  // CALIBRATE FIRST, BY BISECTION.
  //
  // A comparison between options carries information only where the outcome is
  // genuinely in doubt. Run at a fixed difficulty the bare party won essentially
  // never and any status boon won essentially always, so every card scored
  // either +0 or +99 and the sweep reported nonsense.
  //
  // A coarse grid of difficulty multipliers does not fix it — the step from
  // "comfortable win" to "certain loss" is narrower than any grid I guessed, so
  // the search kept landing on 0% or 90% and calling it closest. Bisecting on
  // the multiplier finds the knife edge directly.
  //
  // Tier 2 is a THREE-enemy swarm and is used deliberately: kill-triggered and
  // enemy-side-wide boons are meaningless against a single boss, and measuring
  // them there reports them dead when they are merely situational.
  const TARGET = 30;
  const tier: Stage = 2;
  const calibrate = (level: number): { scale: number; bare: number } => {
    roster = rosterAt(level);
    let lo = 1;
    let hi = 400;
    let best = { scale: 1, bare: rate([], `bare-${level}-1`, tier, 1) };
    for (let i = 0; i < 12; i++) {
      const mid = Math.round((lo + hi) / 2);
      const w = rate([], `bare-${level}-${mid}`, tier, mid);
      if (Math.abs(w - TARGET) < Math.abs(best.bare - TARGET)) best = { scale: mid, bare: w };
      // Harder scale => lower win rate, so the search direction is inverted.
      if (w > TARGET) lo = mid + 1;
      else hi = mid - 1;
      if (lo > hi) break;
    }
    return best;
  };
  let calibrated = calibrate(9);
  if (Math.abs(calibrated.bare - TARGET) > 12) calibrated = calibrate(6);
  const scale = calibrated.scale;
  const bare = calibrated.bare;
  calibratedLevel = Math.abs(calibrated.bare - TARGET) > 12 ? 6 : 9;
  roster = rosterAt(calibratedLevel);
  check(
    "the sweep runs against a contested fight",
    bare > 10 && bare < 55,
    `level ${calibratedLevel} trio vs tier ${tier}x${scale}: bare wins ${bare.toFixed(1)}%`,
  );

  // Only boons whose whole value is COMBAT and expressible as stats or
  // triggers. Excluded, with reasons:
  //   - fortune/instant slots: economy and one-shot effects.
  //   - custom handlers: Rites fire on the once-per-run Ability, and pick-time
  //     effects (Iron Skin's HP bump) are applied by Game, not by the stat
  //     block this harness builds.
  //   - economy-only auras (Golden Hour): their payoff is wood and amber, which
  //     a single fight cannot see.
  const ECONOMY_KEYS = new Set(["woodMult", "amberMult", "acornMult", "xpMult", "rarityLuck", "extraOfferCount", "rerollCharges"]);
  const combat = BOON_DEFS.filter((d) => {
    if (d.slot === "fortune" || d.slot === "instant" || d.duoPatrons || d.requiresPatronBoons) return false;
    if (d.effects.some((e) => e.kind === "custom")) return false;
    const statKeys = d.effects.filter((e) => e.kind === "stat").map((e) => (e as { key: string }).key);
    const hasTrigger = d.effects.some((e) => e.kind === "trigger");
    if (!hasTrigger && statKeys.length > 0 && statKeys.every((k) => ECONOMY_KEYS.has(k))) return false;
    return true;
  });

  const scored = combat.map((def) => ({
    id: def.id,
    slot: def.slot,
    win: rate([{ id: def.id, rarity: "epic", rank: 2 }], def.id, tier, scale),
  }));
  const lifts = scored.map((r) => r.win - bare);
  const mean = lifts.reduce((a, b) => a + b, 0) / lifts.length;

  const dead = scored.filter((r) => r.win - bare < 2);
  check(
    "no combat boon is a dead card",
    dead.length === 0,
    dead.length ? dead.map((r) => `${r.id} (${(r.win - bare).toFixed(1)})`).join(", ") : `${scored.length} boons, mean lift +${mean.toFixed(1)}`,
  );

  // Judged against the mean rather than an absolute, so the check survives
  // retuning the whole catalog up or down together.
  const auto = scored.filter((r) => r.win - bare > mean * 2.5 && r.win - bare > 15);
  check(
    "no combat boon is an auto-pick",
    auto.length === 0,
    auto.length ? auto.map((r) => `${r.id} (+${(r.win - bare).toFixed(1)} vs mean +${mean.toFixed(1)})`).join(", ") : `best +${Math.max(...lifts).toFixed(1)} vs mean +${mean.toFixed(1)}`,
  );

  for (const slot of ["strike", "guard", "aura"] as const) {
    const inSlot = scored.filter((r) => r.slot === slot);
    if (inSlot.length === 0) continue;
    const avg = inSlot.reduce((sum, r) => sum + (r.win - bare), 0) / inSlot.length;
    check(`  ${slot} slot pulls its weight`, avg > 2, `mean +${avg.toFixed(1)} over ${inSlot.length} boons`);
  }
}

// --- Do choices depend on state? -------------------------------------------
//
// A per-boon sweep can say "no card is dominant on average" while the game is
// still a slot machine, because averages hide the thing that actually matters:
// whether the RIGHT answer moves. If the best pick is the same card no matter
// what party you brought, how hurt you are, or what you already hold, then the
// build variety is decorative — every run converges on one shape and the offer
// screen is a formality with three faces.
//
// So this measures the argmax directly across deliberately different states,
// and asserts it is not constant.

function stateDependenceChecks(): void {
  console.log("\nDo choices depend on state:");

  const CANDIDATES = ["kindle", "thornbite", "jitter", "siphon", "barkskin", "ironroot", "packetLoss", "overheat"];

  interface Situation {
    name: string;
    roster: { defId: string; level: number; items?: Record<string, string> }[];
    held: BoonInstance[];
    hpFrac: number;
    tier: Stage;
    /** Extra enemy scaling found by calibration. The five tiers alone do not
     * reach far enough: a build that has already committed beats tier 5
     * comfortably, and with no headroom above it every candidate scores 100. */
    scale?: number;
  }

  const situations: Situation[] = [
    {
      name: "fresh trio, healthy, early room",
      roster: [
        { defId: "birch", level: 5, items: { adventuring: "w0-adventuring-rare" } },
        { defId: "hazel", level: 5, items: { adventuring: "w0-adventuring-rare" } },
        { defId: "thorne", level: 5, items: { adventuring: "w0-adventuring-common" } },
      ],
      held: [],
      hpFrac: 1,
      tier: 3,
    },
    {
      name: "badly hurt, deep room",
      roster: [
        { defId: "birch", level: 9, items: { adventuring: "w0-adventuring-epic" } },
        { defId: "hazel", level: 9, items: { adventuring: "w0-adventuring-epic" } },
        { defId: "thorne", level: 9, items: { adventuring: "w0-adventuring-rare" } },
      ],
      held: [],
      hpFrac: 0.3,
      tier: 5,
    },
    {
      name: "already committed to burn",
      roster: [
        { defId: "birch", level: 9, items: { adventuring: "w0-adventuring-epic" } },
        { defId: "hazel", level: 9, items: { adventuring: "w0-adventuring-epic" } },
        { defId: "thorne", level: 9, items: { adventuring: "w0-adventuring-rare" } },
      ],
      held: [
        { id: "kindle", rarity: "epic", rank: 3 },
        { id: "overheat", rarity: "epic", rank: 2 },
      ],
      hpFrac: 1,
      tier: 5,
    },
    {
      name: "solo survivor, everything on one member",
      roster: [{ defId: "ironbark", level: 11, items: { adventuring: "w0-adventuring-legendary" } }],
      held: [],
      hpFrac: 0.6,
      tier: 4,
    },
  ];

  const winWith = (sit: Situation, extra: BoonInstance | null): number => {
    const rng = scenarioRng(`state-${sit.name}-${extra?.id ?? "none"}`);
    let wins = 0;
    const TRIALS = 200;
    for (let t = 0; t < TRIALS; t++) {
      const { party, inventory } = buildParty(sit.roster);
      for (const m of party) m.currentHp = Math.max(1, Math.round(m.maxHp * sit.hpFrac));
      const held = extra ? [...sit.held, extra] : sit.held;
      const stats = deriveRunStats({ party, inventory, prestigeLevel: 0, boonList: held });
      const scale = sit.scale ?? 1;
      const battle = startBattle(
        party,
        buildEnemy(0, sit.tier, undefined, { hp: scale, atk: 1 + (scale - 1) * 0.5 }),
        inventory,
        { stats },
      );
      let guard = 0;
      while (!battle.outcome && guard++ < MAX_TURNS) {
        const actorId = battle.turnOrder[battle.turnIndex];
        if (!actorId) break;
        const actor = party.find((m) => m.id === actorId)!;
        // Defend only while somebody healthier is still swinging. Without the
        // second clause a party that starts below the threshold has EVERY
        // member defend forever, the fight never resolves, and the scenario
        // scores as a loss for reasons that have nothing to do with what is
        // being measured — which is exactly what made the low-HP situations
        // read as unwinnable at every tier. Mirrors the `smart` policy above.
        const someoneElseHealthy = party.some(
          (m) => m.id !== actor.id && m.currentHp > 0 && m.currentHp / m.maxHp >= 0.45,
        );
        const hurt = actor.currentHp / actor.maxHp < 0.45 && someoneElseHealthy;
        resolveTurn({
          battle,
          party,
          memberId: actorId,
          action: hurt ? "defend" : "attack",
          defendGrade: hurt ? rollGrade(rng) : undefined,
          inventory,
          stats,
          rng,
        });
      }
      if (battle.outcome === "win") wins++;
    }
    return (100 * wins) / TRIALS;
  };

  // CALIBRATE EACH SITUATION.
  //
  // Third time this lesson has bitten in this file, so it is worth stating
  // plainly: a comparison between options carries information only where the
  // outcome is genuinely in doubt. At a tier the situation always wins, every
  // candidate scores 100 and the argmax is just whichever was listed first; at
  // a tier it always loses, the same in reverse. Both look like a passing check
  // and mean nothing. So each situation's tier is chosen to put its baseline in
  // the middle before any candidate is compared.
  for (const sit of situations) {
    let bestTier = sit.tier;
    let bestScale = 1;
    let closest = Infinity;
    for (const t of [2, 3, 4, 5] as Stage[]) {
      for (const sc of [1, 1.6, 2.5, 4, 6.5]) {
        const w = winWith({ ...sit, tier: t, scale: sc }, null);
        if (Math.abs(w - 45) < closest) {
          closest = Math.abs(w - 45);
          bestTier = t;
          bestScale = sc;
        }
        // Nothing to gain from searching further once the baseline is close.
        if (closest < 8) break;
      }
      if (closest < 8) break;
    }
    sit.tier = bestTier;
    sit.scale = bestScale;
  }

  const bests: string[] = [];
  for (const sit of situations) {
    const scored = CANDIDATES
      // A boon already held at max rank is not a choice in that situation.
      .filter((id) => !sit.held.some((h) => h.id === id && h.rank >= 3))
      .map((id) => ({ id, win: winWith(sit, { id, rarity: "epic", rank: 2 }) }));
    const best = scored.reduce((a, b) => (a.win > b.win ? a : b));
    const worst = scored.reduce((a, b) => (a.win < b.win ? a : b));
    bests.push(best.id);
    const baseline = winWith(sit, null);
    check(
      `  ${sit.name}`,
      // A situation where every candidate scores the same is not evidence of
      // balance, it is evidence the measurement found no signal — so say so
      // rather than quietly passing.
      best.win - worst.win > 3,
      `tier ${sit.tier}x${sit.scale}, bare ${baseline.toFixed(0)}% | best ${best.id} ${best.win.toFixed(0)}%, worst ${worst.id} ${worst.win.toFixed(0)}%`,
    );
  }

  // THE CHECK. If one card is the right answer in every situation, the offer
  // screen is theatre.
  const distinct = new Set(bests);
  check(
    "the best pick changes with the situation",
    distinct.size > 1,
    `${distinct.size} distinct best picks across ${situations.length} situations: ${bests.join(", ")}`,
  );
}

// --- Declared-but-unwired content ------------------------------------------
//
// THE FAMILY GATE.
//
// The Pact of the Grove shipped with three of its six modifiers as pure text:
// the names rendered, the ranks computed, the payout applied, and nothing ever
// got harder. That class of bug is invisible from the code — every individual
// file looks correct, and the defect lives in the ABSENCE of a call site — and
// it never occurs once. Auditing the same day turned up three more: a Rite that
// promised a reroll and had no handler, a stat nothing could set, and a status
// with a fully-implemented consumer that nothing could ever produce.
//
// So this checks the shape of the wiring rather than any particular content.
// It reads the engine's own source, the way contrastChecks reads styles.css,
// and asserts that everything DECLARED is also CONSUMED somewhere. It is the
// only check here that would have caught the original bug, and the only one
// that will catch the next one.

function wiringChecks(): void {
  console.log("\nContent wiring (nothing declared without a consumer):");
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf-8");
  const battle = read("../src/battle.ts");
  const game = read("../src/scene/game.ts");
  const offers = read("../src/run/offers.ts");
  const ledger = read("../src/ui/ledger.ts");
  const adventure = read("../src/adventure.ts");
  const rooms = read("../src/run/rooms.ts");
  // statuses.ts counts as engine: burn and bleed are consumed there, by the
  // generic round-end tick rather than by name in battle.ts.
  const statuses = read("../src/statuses.ts");
  const engine = battle + game + offers + ledger + adventure + rooms + statuses;

  // Every RunStat must be read by something. A stat nothing reads is a boon
  // waiting to silently do nothing.
  {
    const unread = (Object.keys(BASE_RUN_STATS) as string[]).filter(
      (key) => !engine.includes(`values.${key}`),
    );
    check("every run stat has a reader", unread.length === 0, unread.join(", ") || `${Object.keys(BASE_RUN_STATS).length} stats`);
  }

  // Every custom boon handler must be handled. This is what Benediction's
  // reroll was missing.
  {
    const declared = new Set(
      BOON_DEFS.flatMap((d) =>
        d.effects.filter((e) => e.kind === "custom").map((e) => (e as { handlerId: string }).handlerId),
      ),
    );
    const unhandled = [...declared].filter((h) => !battle.includes(`"${h}"`) && !game.includes(`"${h}"`));
    check("every boon handler is handled", unhandled.length === 0, unhandled.join(", ") || `${declared.size} handlers`);
  }

  // Every status must have BOTH a producer in the catalog and a consumer in the
  // engine. Mark had a consumer and no producer; Fervor had neither.
  {
    const produced = new Set<string>(
      BOON_DEFS.flatMap((d) =>
        d.effects.filter((e) => e.kind === "trigger").map((e) => (e as { status: string }).status),
      ),
    );
    // These three are produced by the ENGINE rather than by a boon: Bark by the
    // shield-on-guard stat and the Bramble Wall rite, Regen by Bloom, and Weak
    // additionally by enemy moves.
    for (const engineProduced of ["bark", "regen"]) {
      if (battle.includes(`"${engineProduced}"`)) produced.add(engineProduced);
    }
    const orphans = STATUS_DEFS.filter((d) => !produced.has(d.id));
    check("every status has a producer", orphans.length === 0, orphans.map((d) => d.id).join(", ") || `${STATUS_DEFS.length} statuses`);

    const unconsumed = STATUS_DEFS.filter(
      (d) => !battle.includes(`"${d.id}"`) && !battle.includes(`.${d.id}`) && !statuses.includes(`def.id === "${d.id}"`),
    );
    check("every status has a consumer", unconsumed.length === 0, unconsumed.map((d) => d.id).join(", ") || "all consumed");
  }

  // Every pact modifier must reach the run. This is the original bug.
  {
    const pactSrc = read("../src/run/pact.ts");
    const unwired = PACT_DEFS.filter(
      (m) => !pactSrc.includes(`"${m.id}"`) || !(game.includes(`"${m.id}"`) || pactSrc.includes(`includes("${m.id}")`)),
    );
    check("every pact modifier reaches the run", unwired.length === 0, unwired.map((m) => m.id).join(", ") || `${PACT_DEFS.length} modifiers`);
  }

  // Elite affixes are declared TWICE — as a union in adventure.ts (what the
  // fight understands) and as a display list in run/rooms.ts (what the door
  // advertises). Nothing but this keeps them in step, and a door offering an
  // affix the fight ignores is the same lie in a different costume.
  {
    const unionMatch = adventure.match(/export type EliteAffixId =([^;]+);/);
    const inUnion = new Set((unionMatch?.[1] ?? "").match(/"[a-z]+"/gi)?.map((q) => q.replace(/"/g, "")) ?? []);
    const listed = ELITE_AFFIXES.map((a) => a.id);
    const missing = listed.filter((id) => !inUnion.has(id));
    const extra = [...inUnion].filter((id) => !listed.includes(id));
    check(
      "the two elite-affix declarations agree",
      missing.length === 0 && extra.length === 0,
      missing.length || extra.length ? `door-only: ${missing.join(",")} fight-only: ${extra.join(",")}` : `${listed.length} affixes`,
    );
    // And each one has to be READ by the code that builds or fights the enemy.
    const inert = listed.filter((id) => !adventure.includes(`"${id}"`) && !battle.includes(`"${id}"`));
    check("every elite affix changes something", inert.length === 0, inert.join(", ") || "all wired");
  }

  // Every curse's payout must be resolvable, or a chaos gate charges a real
  // price for nothing.
  {
    const unpaid = CURSE_DEFS.filter((c) => !game.includes(`"${c.reward}"`));
    check("every curse pays out", unpaid.length === 0, unpaid.map((c) => `${c.id}->${c.reward}`).join(", ") || `${CURSE_DEFS.length} curses`);
  }

  // Every consumable must do something when bought.
  {
    const inert = CONSUMABLE_DEFS.filter((c) => !game.includes(`"${c.id}"`));
    check("every consumable does something", inert.length === 0, inert.map((c) => c.id).join(", ") || `${CONSUMABLE_DEFS.length} consumables`);
  }

  // Every charm effect must name a real stat — a typo'd key would typecheck
  // (it is a union) but silently contribute to nothing the engine reads.
  {
    const keys = new Set(Object.keys(BASE_RUN_STATS));
    const bad = CHARM_DEFS.flatMap((c) =>
      [...c.upside, ...c.downside].filter((e) => !keys.has(e.key)).map((e) => `${c.id}.${e.key}`),
    );
    check("every charm effect names a real stat", bad.length === 0, bad.join(", ") || `${CHARM_DEFS.length} charms`);
  }
}

// --- Pact of the Grove -----------------------------------------------------
//
// Opt-in difficulty only works as a wager if BOTH halves are real: the run has
// to get measurably harder, and the payout has to rise enough that taking the
// pact is a defensible choice rather than a self-imposed handicap. Either half
// missing turns the whole feature into a difficulty slider nobody touches.

function pactChecks(): void {
  console.log("\nPact of the Grove:");

  check(
    "no pact is worth no bonus",
    groveRank([]) === 0 && grovePayoutMult(0) === 1,
    `rank ${groveRank([])}, x${grovePayoutMult(0)}`,
  );

  // Every modifier has to be worth something, or it is a free rank.
  {
    const worthless = PACT_DEFS.filter((m) => m.rank <= 0);
    check("every modifier carries a rank", worthless.length === 0, worthless.map((m) => m.id).join(", ") || `${PACT_DEFS.length} modifiers`);
  }

  // Payout must rise with rank and stay bounded — an unbounded multiplier would
  // eventually make Adventure a better wood source than actually chopping,
  // which is the one thing this mode must not become.
  {
    const full = groveRank(PACT_DEFS.map((m) => m.id));
    const steps = [0, 1, 3, 5, full].map(grovePayoutMult);
    const rising = steps.every((v, i) => i === 0 || v > steps[i - 1]);
    check("payout rises with every rank", rising, steps.map((v) => `x${v.toFixed(2)}`).join(" -> "));
    check("payout stays bounded", grovePayoutMult(100) <= 4, `x${grovePayoutMult(100)} at absurd rank`);
    check(
      "a full pact is a serious commitment",
      full >= 8 && grovePayoutMult(full) >= 2,
      `rank ${full}, x${grovePayoutMult(full).toFixed(2)} payout`,
    );
  }

  // And the difficulty half: the scaling modifiers must genuinely reach the
  // enemies. This was dead code on the first pass — the modifiers were listed,
  // the rank was computed, the payout applied, and nothing ever got harder.
  {
    const plain = buildEnemy(0, 5)[0];
    const hard = buildEnemy(0, 5, undefined, pactEnemyScaling(["thickerHide", "sharpTeeth"]))[0];
    check(
      "Thicker Hide reaches the enemy",
      hard.hp > plain.hp,
      `${plain.hp} hp -> ${hard.hp}`,
    );
    check(
      "Sharp Teeth reaches the enemy",
      hard.atk > plain.atk,
      `${plain.atk} atk -> ${hard.atk}`,
    );
    const none = buildEnemy(0, 5, undefined, pactEnemyScaling([]))[0];
    check(
      "an empty pact changes nothing",
      none.hp === plain.hp && none.atk === plain.atk,
      `${none.hp}/${none.atk} vs ${plain.hp}/${plain.atk}`,
    );
  }

  // Dry Wells promises no fountains. It is a MAP property, so the check is on
  // the generated map rather than on what happens when one is entered.
  {
    const wet = Array.from({ length: 200 }, (_, i) => generateRunMap(hashString(`dry-${i}`)));
    const dry = Array.from({ length: 200 }, (_, i) =>
      generateRunMap(hashString(`dry-${i}`), { noFountains: true }),
    );
    const countHeals = (maps: typeof wet) =>
      maps.reduce((n, m) => n + m.slots.flat().filter((r) => r.reward === "heal").length, 0);
    check(
      "Dry Wells removes every spring",
      countHeals(dry) === 0 && countHeals(wet) > 0,
      `${countHeals(wet)} springs normally, ${countHeals(dry)} under the pact`,
    );
  }

  // Death Rattle promises the boss fights on. Checked by actually killing one.
  {
    const spec = buildEnemy(0, 5, undefined, pactEnemyScaling(["deathRattle"]))[0];
    check("Death Rattle marks the boss", spec.revives === true, `revives=${spec.revives}`);
    const plainSpec = buildEnemy(0, 5)[0];
    check("and only under the pact", !plainSpec.revives, `revives=${plainSpec.revives}`);

    const { party, inventory } = buildParty([
      { defId: "birch", level: 10, items: { adventuring: "w0-adventuring-legendary" } },
      { defId: "hazel", level: 10, items: { adventuring: "w0-adventuring-legendary" } },
      { defId: "thorne", level: 10, items: { adventuring: "w0-adventuring-legendary" } },
    ]);
    const rng = scenarioRng("death-rattle");
    const battle = startBattle(
      party,
      buildEnemy(0, 5, undefined, pactEnemyScaling(["deathRattle"])),
      inventory,
      { stats: baseRunStats() },
    );
    let rose = false;
    let guard = 0;
    while (!battle.outcome && guard++ < MAX_TURNS) {
      const actorId = battle.turnOrder[battle.turnIndex];
      if (!actorId) break;
      resolveTurn({ battle, party, memberId: actorId, action: "attack", inventory, stats: baseRunStats(), rng });
      // It came back: every enemy was down at some point, yet the fight ran on.
      if (!battle.outcome && battle.enemies.some((u) => u.hp > 0 && u.spec.revives === false)) rose = true;
    }
    check("a Death Rattle boss actually gets back up", rose, rose ? "second phase observed" : "never rose");
    check("and only once", battle.enemies.every((u) => !u.spec.revives), "flag consumed");
  }
}

// --- Elite affixes ---------------------------------------------------------
//
// An elite door promises something specific — "Armoured. Bring status damage."
// If the affix does not actually change the fight, that promise is a lie, and
// it is the kind of lie that is invisible from the code: the sigil renders, the
// text reads well, and the fight plays out exactly like every other one.
//
// So each affix is checked for a MEASURABLE effect in the direction it claims.

function affixChecks(): void {
  console.log("\nElite affixes:");

  // Two different parties, because the two questions need different signal.
  //
  // "Is this affix harder?" saturates on win% — a strong party wins every time
  // and a weak one loses every time, and both read as "no effect". Measured
  // instead on COST: how much of its health the party spends winning. That
  // moves smoothly and is exactly what an elite is supposed to charge.
  //
  // "Does the affix's promise hold?" does need win%, against a contested
  // matchup, because the claim is about whether a specific build answers it.
  const strong = [
    { defId: "birch", level: 8, items: { adventuring: "w0-adventuring-legendary" } },
    { defId: "hazel", level: 8, items: { adventuring: "w0-adventuring-legendary" } },
    { defId: "thorne", level: 8, items: { adventuring: "w0-adventuring-epic" } },
  ];
  const contested = [
    { defId: "birch", level: 4, items: { adventuring: "w0-adventuring-rare" } },
    { defId: "hazel", level: 4, items: { adventuring: "w0-adventuring-rare" } },
  ];

  const runFight = (
    roster: typeof strong,
    affix: string | undefined,
    stats: RunStats,
    label: string,
  ): { winPct: number; hpLeft: number } => {
    const rng = scenarioRng(`affix-${label}`);
    let wins = 0;
    let hpSum = 0;
    const TRIALS = 300;
    for (let t = 0; t < TRIALS; t++) {
      const { party, inventory } = buildParty(roster);
      const battle = startBattle(party, buildEnemy(0, 5, affix as never), inventory, { stats });
      let guard = 0;
      while (!battle.outcome && guard++ < MAX_TURNS) {
        const actorId = battle.turnOrder[battle.turnIndex];
        if (!actorId) break;
        resolveTurn({ battle, party, memberId: actorId, action: "attack", inventory, stats, rng });
      }
      if (battle.outcome === "win") wins++;
      const maxTotal = party.reduce((sum, m) => sum + m.maxHp, 0);
      const left = party.reduce((sum, m) => sum + Math.max(0, m.currentHp), 0);
      hpSum += maxTotal > 0 ? left / maxTotal : 0;
    }
    return { winPct: (100 * wins) / TRIALS, hpLeft: (100 * hpSum) / TRIALS };
  };

  const winPct = (affix: string | undefined, stats?: RunStats): number =>
    runFight(contested, affix, stats ?? baseRunStats(), `${affix ?? "none"}-${stats ? "built" : "plain"}`).winPct;

  const plain = runFight(strong, undefined, baseRunStats(), "cost-none");
  for (const affix of ELITE_AFFIXES) {
    const withAffix = runFight(strong, affix.id, baseRunStats(), `cost-${affix.id}`);
    check(
      `  ${affix.name} costs the party more`,
      withAffix.hpLeft < plain.hpLeft,
      `${plain.hpLeft.toFixed(1)}% HP left -> ${withAffix.hpLeft.toFixed(1)}%`,
    );
  }

  // THE PROMISE. Armoured's card tells the player to bring status damage, so a
  // burn build must genuinely fare better against it than a raw-damage build of
  // comparable strength does. Without this, the instruction is decoration.
  {
    const burn = deriveRunStats({
      party: buildParty(contested).party,
      inventory: [],
      boonList: [{ id: "kindle", rarity: "heroic", rank: 3 }],
    });
    const raw = deriveRunStats({
      party: buildParty(contested).party,
      inventory: [],
      boonList: [{ id: "battleFury", rarity: "heroic", rank: 3 }],
    });
    const burnVsArmor = winPct("armored", burn);
    const rawVsArmor = winPct("armored", raw);
    check(
      "  status damage answers Armoured better than raw damage",
      burnVsArmor > rawVsArmor,
      `burn ${burnVsArmor.toFixed(1)}% vs raw ${rawVsArmor.toFixed(1)}%`,
    );
  }

  // Insulated must genuinely switch control off, or Static's counter-affix is
  // just another stat block.
  {
    const control = deriveRunStats({
      party: buildParty(contested).party,
      inventory: [],
      boonList: [{ id: "jitter", rarity: "heroic", rank: 3 }],
    });
    const vsNormal = winPct(undefined, control);
    const vsInsulated = winPct("insulated", control);
    check(
      "  Insulated blunts a control build specifically",
      vsInsulated < vsNormal,
      `${vsNormal.toFixed(1)}% -> ${vsInsulated.toFixed(1)}%`,
    );
  }
}

// --- Run map ---------------------------------------------------------------
//
// Checked over a thousand seeds, because the failure mode of generated content
// is not "the average run is bad" — it is "one run in forty is unplayable, and
// the player who gets it blames the game rather than the seed". Each of these
// corresponds to a numbered rule in run/rooms.ts's header.

function runMapChecks(): void {
  console.log("\nRun map generation:");
  const MAPS = 1000;
  const maps = Array.from({ length: MAPS }, (_, i) => generateRunMap(hashString(`map-${i}`)));

  check(
    "every run is twelve rooms",
    maps.every((m) => m.slots.length === TOTAL_ROOMS),
    `${maps[0].slots.length} slots`,
  );

  // Rule 2, and the most important one here: a run must never be denied its own
  // premise by an unlucky draw. If a choice offered no way to advance the
  // build, that run simply cannot become anything.
  {
    const bad = maps.filter((m) =>
      m.slots.some((slot, i) => {
        if (i === 0) return false;
        const room = slot[0];
        if (room.kind === "boss") return false;
        return !slot.some((r) => r.reward === "boon" || r.reward === "rank");
      }),
    );
    check("every choice offers a way to advance the build", bad.length === 0, `${bad.length} of ${MAPS} maps failed`);
  }

  // Rule 1: you earn your way into each Depth.
  {
    const bad = maps.filter((m) =>
      [0, 4, 8].some((i) => m.slots[i].some((r) => r.kind !== "fight")),
    );
    check("every Depth opens with a fight", bad.length === 0, `${bad.length} maps failed`);
  }

  // Bosses are single doors — there is nothing to decide about facing the
  // Depth's boss, and offering a way around it would make Depths optional.
  {
    const bad = maps.filter((m) => [3, 7, 11].some((i) => m.slots[i].length !== 1 || m.slots[i][0].kind !== "boss"));
    check("each Depth ends in exactly one boss", bad.length === 0, `${bad.length} maps failed`);
  }

  // Rule 6: the pre-boss safety valve is what lets a boss be tuned to be hard.
  {
    const bad = maps.filter((m) => [2, 6, 10].some((i) => !m.slots[i].some((r) => r.reward === "heal")));
    check("a fountain is always offered before each boss", bad.length === 0, `${bad.length} maps failed`);
  }

  // Rules 4 and 5: Depth I has nothing to spend and nothing to prove.
  {
    const bad = maps.filter((m) =>
      m.slots.slice(0, 4).some((slot) => slot.some((r) => r.kind === "shop" || r.kind === "elite")),
    );
    check("Depth I has no shops and no elites", bad.length === 0, `${bad.length} maps failed`);
  }
  {
    const overShopped = maps.filter((m) => {
      for (const range of [[4, 8], [8, 12]]) {
        const shops = m.slots.slice(range[0], range[1]).flat().filter((r) => r.kind === "shop").length;
        if (shops > 1) return true;
      }
      return false;
    });
    check("later Depths offer at most one shop each", overShopped.length === 0, `${overShopped.length} maps failed`);
  }
  {
    const overElited = maps.filter((m) => {
      for (const range of [[4, 8], [8, 12]]) {
        const elites = m.slots.slice(range[0], range[1]).flat().filter((r) => r.kind === "elite").length;
        if (elites > 1) return true;
      }
      return false;
    });
    check("later Depths offer at most one elite each", overElited.length === 0, `${overElited.length} maps failed`);
  }

  // Rule 7: a first run should not open on a wall of choices whose sigils mean
  // nothing yet.
  {
    const bad = maps.filter((m) =>
      m.slots.some((slot, i) => {
        const depth = depthOf(i);
        const isBossOrFirst = i === 0 || i % 4 === 3;
        if (isBossOrFirst) return slot.length !== 1;
        return depth === 1 ? slot.length !== 2 : slot.length !== 3;
      }),
    );
    check("Depth I offers two doors, later Depths three", bad.length === 0, `${bad.length} maps failed`);
  }

  // Every door id must be unique within its run, since ids are how a persisted
  // choice is resolved back to a room after a restart. A collision would
  // silently walk the player into the wrong room.
  {
    const bad = maps.filter((m) => {
      const ids = m.slots.flat().map((r) => r.id);
      return new Set(ids).size !== ids.length;
    });
    check("room ids are unique within a run", bad.length === 0, `${bad.length} maps failed`);
  }

  // Determinism: the persisted map and any regeneration from the same seed have
  // to agree, or a resumed run shows different doors than it was showing.
  {
    const a = generateRunMap(4242);
    const b = generateRunMap(4242);
    check("the same seed builds the same map", JSON.stringify(a) === JSON.stringify(b), "byte-identical");
    const c = generateRunMap(4243);
    check("different seeds build different maps", JSON.stringify(a) !== JSON.stringify(c), "diverges");
  }

  // Pacing: every fight is a chance to be worn down, every breather a chance to
  // recover. A run that is all fights is a slog; one that is mostly events is
  // not a roguelike. Measured on the build-door route, which is the one a
  // player chasing a build actually walks.
  {
    const combatCounts = maps.map((m) => m.slots.filter((s) => ["fight", "elite", "boss"].includes(s[0].kind)).length);
    const min = Math.min(...combatCounts);
    const max = Math.max(...combatCounts);
    check("the build route is mostly fighting", min >= 8 && max <= TOTAL_ROOMS, `${min}-${max} combat rooms of ${TOTAL_ROOMS}`);
  }

  // Every patron must actually show up on doors, or a run could never be
  // offered a patron it wanted to commit to.
  {
    const seen = new Set(maps.flatMap((m) => m.slots.flat().map((r) => r.patron).filter(Boolean)));
    check("every patron appears on doors", seen.size === PATRON_DEFS.length, `${seen.size} of ${PATRON_DEFS.length}`);
  }

  // Every elite affix must be reachable, or it is content nobody will ever see.
  {
    const seen = new Set(maps.flatMap((m) => m.slots.flat().map((r) => r.affix).filter(Boolean)));
    check("every elite affix is reachable", seen.size === ELITE_AFFIXES.length, `${seen.size} of ${ELITE_AFFIXES.length}`);
  }

  // Depth boundaries are the run's two "descend or bank" moments, and where the
  // descent toll is charged — off by one here would charge at the wrong time.
  {
    const boundaries = Array.from({ length: TOTAL_ROOMS }, (_, i) => i).filter(isDepthBoundary);
    check("depth boundaries fall after rooms 4 and 8", JSON.stringify(boundaries) === JSON.stringify([3, 7]), boundaries.join(", "));
  }
}

// --- Boon catalog ----------------------------------------------------------
//
// These check the design's own rules, not its balance. Balance moves; the
// rules are what stop the catalog from quietly turning back into "eight flat
// percentages, but more of them", which is the failure mode the whole rework
// exists to escape and the one that is hardest to notice from inside.

function boonChecks(): void {
  console.log("\nBoon catalog:");

  check("boon ids are unique", new Set(BOON_DEFS.map((d) => d.id)).size === BOON_DEFS.length, `${BOON_DEFS.length} boons`);

  // THE PATRON PROMISE. A patron's sigil over a doorway has to mean something
  // without being read, which only works if each patron owns exactly one
  // signature status and never borrows another's. Duo boons are the single
  // exception — that is what makes them read as a secret rather than as more
  // content.
  {
    const violations: string[] = [];
    for (const def of BOON_DEFS) {
      if (def.duoPatrons) continue;
      const signature = PATRON_DEFS_BY_ID[def.patron].signature;
      for (const effect of def.effects) {
        if (effect.kind !== "trigger") continue;
        // Glitch and the friendly statuses are shared vocabulary — the rule is
        // about not borrowing another patron's SIGNATURE.
        const otherSignatures = PATRON_DEFS.filter((p) => p.id !== def.patron)
          .map((p) => p.signature)
          .filter((s): s is NonNullable<typeof s> => s !== null);
        if (effect.status !== signature && otherSignatures.includes(effect.status)) {
          violations.push(`${def.id} (${def.patron}) applies ${effect.status}`);
        }
      }
    }
    check("no patron borrows another's signature status", violations.length === 0, violations.join("; ") || "clean");
  }

  // Rank must deepen a build without making the rarity roll cosmetic. If a
  // rank-2 Rare beat a rank-1 Heroic, the offer screen's central moment — the
  // Heroic drop — would stop mattering.
  {
    const common1 = boonMagnitude({ rarity: "common", rank: 1 });
    const rare1 = boonMagnitude({ rarity: "rare", rank: 1 });
    const epic1 = boonMagnitude({ rarity: "epic", rank: 1 });
    const heroic1 = boonMagnitude({ rarity: "heroic", rank: 1 });
    const rare2 = boonMagnitude({ rarity: "rare", rank: 2 });
    const common5 = boonMagnitude({ rarity: "common", rank: 5 });
    check(
      "rarity strictly increases magnitude",
      common1 < rare1 && rare1 < epic1 && epic1 < heroic1,
      `${common1} < ${rare1} < ${epic1} < ${heroic1}`,
    );
    check("rank strictly increases magnitude", boonMagnitude({ rarity: "rare", rank: 3 }) > rare2 && rare2 > rare1, `${rare1} -> ${rare2}`);
    check("a ranked Rare never eclipses a Heroic", rare2 < heroic1, `rank-2 rare ${rare2} vs heroic ${heroic1}`);
    check("a fully ranked Common is worth about an Epic", Math.abs(common5 - epic1) < 0.3, `${common5} vs ${epic1}`);
  }

  // Every exclusive slot must be fillable from every patron, or committing to
  // a patron would mean leaving a slot permanently empty — which reads as the
  // patron being broken rather than as a build choice.
  {
    const missing: string[] = [];
    for (const patron of PATRON_DEFS) {
      for (const slot of ["strike", "guard", "rite"] as const) {
        const has = BOON_DEFS.some((d) => d.patron === patron.id && d.slot === slot && !d.duoPatrons && !d.requiresPatronBoons);
        if (!has) missing.push(`${patron.id}/${slot}`);
      }
    }
    check("every patron can fill every exclusive slot", missing.length === 0, missing.join(", ") || "all five complete");
  }

  // A description promising a number must actually produce one. A card reading
  // "+{n}% attack" is the single worst thing an offer screen can show.
  {
    const unsubstituted = BOON_DEFS.filter((d) =>
      describeBoon(d, { rarity: "epic", rank: 2 }).includes("{n}"),
    );
    check("every {n} placeholder resolves", unsubstituted.length === 0, unsubstituted.map((d) => d.id).join(", ") || "all resolve");
  }

  // The number on the card has to move when the rarity does, or rarity is a
  // colour with no meaning behind it.
  {
    const scaling = BOON_DEFS.filter((d) => d.description.includes("{n}"));
    const flat = scaling.filter(
      (d) => describeBoon(d, { rarity: "common", rank: 1 }) === describeBoon(d, { rarity: "heroic", rank: 1 }) && d.rarities.includes("heroic"),
    );
    check("a rarer card shows a bigger number", flat.length === 0, flat.map((d) => d.id).join(", ") || `${scaling.length} scaling descriptions`);
  }

  // Exclusive slots must actually be exclusive, and stacking slots must not be.
  {
    check(
      "slot capacities match the design",
      slotCapacity("strike") === 1 && slotCapacity("guard") === 1 && slotCapacity("rite") === 1 && slotCapacity("aura") > 1 && slotCapacity("fortune") > 1 && slotCapacity("instant") === 0,
      `strike ${slotCapacity("strike")}, aura ${slotCapacity("aura")}, fortune ${slotCapacity("fortune")}`,
    );
    const held: BoonInstance[] = [{ id: "kindle", rarity: "common", rank: 1 }];
    const replaced = boonReplaces(held, BOON_DEFS_BY_ID.thornbite);
    const notReplaced = boonReplaces(held, BOON_DEFS_BY_ID.battleFury);
    check(
      "taking a Strike boon reports what it replaces",
      replaced?.id === "kindle" && notReplaced === null,
      `${replaced?.id ?? "none"} / ${notReplaced?.id ?? "none"}`,
    );
  }

  // Duos are the payoff for having committed to two patrons, so they must name
  // two DIFFERENT ones and never be rankable — a landmark with levels is not a
  // landmark.
  {
    const duos = BOON_DEFS.filter((d) => d.duoPatrons);
    const bad = duos.filter((d) => d.duoPatrons![0] === d.duoPatrons![1] || d.maxRank !== 1 || d.rarities.includes("common"));
    check("duo boons pair two patrons, unranked and never common", bad.length === 0, `${duos.length} duos, ${bad.length} malformed`);
    // Every patron pair worth having should be reachable, or a run that
    // commits to two patrons may find the duo layer simply absent for it.
    const pairs = new Set(duos.map((d) => [...d.duoPatrons!].sort().join("+")));
    check("duos cover at least half the patron pairs", pairs.size >= 5, `${pairs.size} of 10 possible pairs`);
  }

  // Legendaries must be gated behind real commitment, or they are just very
  // good boons and the loyalty they exist to reward stops mattering.
  {
    const legendaries = BOON_DEFS.filter((d) => d.requiresPatronBoons);
    const ungated = legendaries.filter((d) => (d.requiresPatronBoons ?? 0) < 3 || !d.rarities.every((r) => r === "heroic"));
    check("legendaries need real commitment", ungated.length === 0, `${legendaries.length} legendaries, ${ungated.length} under-gated`);
    check("every patron has a legendary", new Set(legendaries.map((d) => d.patron)).size === PATRON_DEFS.length, `${new Set(legendaries.map((d) => d.patron)).size} of ${PATRON_DEFS.length}`);
  }

  // A custom handler is a place the data model stops being able to explain
  // itself, so the set stays small on purpose. If this trips, the effect being
  // added probably wants to be a stat or a trigger.
  {
    const customs = new Set(
      BOON_DEFS.flatMap((d) => d.effects.filter((e) => e.kind === "custom").map((e) => (e as { handlerId: string }).handlerId)),
    );
    check("custom handlers stay a short list", customs.size <= 10, `${customs.size} handlers: ${[...customs].join(", ")}`);
  }
}

// --- Offers ----------------------------------------------------------------
//
// The offer screen is the one the run is actually about, and it has one
// catastrophic failure mode: an empty draw. The run gate refuses to advance
// while an offer is pending, so an offer with no cards is a soft-lock with no
// in-game recovery — and it is only reachable deep into a run with most slots
// full, which is precisely where nobody is testing by hand.
//
// So this fuzzes rather than reasons.

function offerChecks(): void {
  console.log("\nOffers:");

  const baseCtx = (held: BoonInstance[]): OfferContext => ({ held, prestigeLevel: 3 });
  // Local ladder — economy.ts's RARITY_ORDER is the ITEM rarity scale and has
  // no "heroic" tier, so reusing it here would silently compare against -1.
  const BOON_RARITY_ORDER = ["common", "rare", "epic", "heroic"];

  // THE SOFT-LOCK FUZZ. Random held-boon sets across the whole catalog, at
  // every prestige level, including states with every slot saturated.
  {
    const rng = scenarioRng("offer-fuzz");
    let empty = 0;
    let worstHeld = 0;
    for (let trial = 0; trial < 4000; trial++) {
      const held: BoonInstance[] = [];
      const size = Math.floor(rng() * 12);
      for (let i = 0; i < size; i++) {
        const def = BOON_DEFS[Math.floor(rng() * BOON_DEFS.length)];
        if (def.slot === "instant" || held.some((h) => h.id === def.id)) continue;
        held.push({ id: def.id, rarity: "heroic", rank: def.maxRank });
      }
      const ctx: OfferContext = { held, prestigeLevel: Math.floor(rng() * 4) };
      const offer = drawOffer(ctx, Math.floor(rng() * 1e9), 3);
      if (offer.cards.length === 0) {
        empty++;
        worstHeld = Math.max(worstHeld, held.length);
      }
    }
    check("an offer is never empty, in 4000 fuzzed states", empty === 0, empty === 0 ? "always at least one card" : `${empty} empty (worst held ${worstHeld})`);
  }

  // The specific saturated case the fuzz is most likely to under-sample: every
  // exclusive slot filled and every stacking slot at its cap, all at max rank
  // and Heroic. This is a real end-of-run state, not a synthetic one.
  {
    const held: BoonInstance[] = [
      { id: "kindle", rarity: "heroic", rank: 5 },
      { id: "backdraft", rarity: "heroic", rank: 5 },
      { id: "wildfire", rarity: "epic", rank: 3 },
      { id: "keenReflexes", rarity: "heroic", rank: 5 },
      { id: "overheat", rarity: "heroic", rank: 5 },
      { id: "battleFury", rarity: "heroic", rank: 5 },
      { id: "battleTrance", rarity: "heroic", rank: 5 },
      { id: "emberdust", rarity: "epic", rank: 3 },
      { id: "lumberBlessing", rarity: "heroic", rank: 5 },
      { id: "patronsEar", rarity: "epic", rank: 2 },
    ];
    const offer = drawOffer(baseCtx(held), 12345, 3);
    check("a fully saturated build still gets an offer", offer.cards.length > 0, `${offer.cards.length} card(s)`);
  }

  // Every card must be worth taking. A card for something already held at the
  // same rarity and max rank does literally nothing, and a screen that shows
  // one teaches the player to stop reading the screen.
  {
    const held: BoonInstance[] = [{ id: "battleFury", rarity: "rare", rank: 2 }];
    let deadCards = 0;
    for (let seed = 0; seed < 400; seed++) {
      const offer = drawOffer(baseCtx(held), seed, 3);
      for (const card of offer.cards) {
        const have = held.find((h) => h.id === card.boonId);
        if (!have) continue;
        const improvesRarity = BOON_RARITY_ORDER.indexOf(card.rarity) > BOON_RARITY_ORDER.indexOf(have.rarity);
        if (!card.rankUp && !improvesRarity) deadCards++;
      }
    }
    check("no card is a no-op for something already held", deadCards === 0, `${deadCards} dead card(s) in 400 offers`);
  }

  // Exclusive slots are the system's whole texture, and they only work if the
  // card says what it costs. A silent replacement would be the most
  // frustrating moment in a run.
  {
    const held: BoonInstance[] = [{ id: "kindle", rarity: "rare", rank: 1 }];
    let strikeCards = 0;
    let labelled = 0;
    for (let seed = 0; seed < 500; seed++) {
      for (const card of drawOffer(baseCtx(held), seed, 3).cards) {
        if (BOON_DEFS_BY_ID[card.boonId]?.slot !== "strike" || card.boonId === "kindle") continue;
        strikeCards++;
        if (card.replacesId === "kindle") labelled++;
      }
    }
    check("every exclusive-slot card names what it replaces", strikeCards > 0 && strikeCards === labelled, `${labelled}/${strikeCards} labelled`);
  }

  // Gating must actually gate. A duo appearing before its patrons are held, or
  // a legendary before the commitment it rewards, would make both categories
  // meaningless.
  {
    let leaked = 0;
    for (let seed = 0; seed < 800; seed++) {
      for (const card of drawOffer(baseCtx([]), seed, 3).cards) {
        const def = BOON_DEFS_BY_ID[card.boonId];
        if (def?.duoPatrons || def?.requiresPatronBoons) leaked++;
      }
    }
    check("duos and legendaries never appear to an empty build", leaked === 0, `${leaked} leaks in 800 offers`);
  }
  {
    const committed: BoonInstance[] = [
      { id: "kindle", rarity: "epic", rank: 2 },
      { id: "keenReflexes", rarity: "epic", rank: 2 },
      { id: "overheat", rarity: "epic", rank: 2 },
      { id: "thornbite", rarity: "rare", rank: 1 },
    ];
    let sawLegendary = false;
    let sawDuo = false;
    for (let seed = 0; seed < 1500 && !(sawLegendary && sawDuo); seed++) {
      for (const card of drawOffer(baseCtx(committed), seed, 3).cards) {
        const def = BOON_DEFS_BY_ID[card.boonId];
        if (def?.requiresPatronBoons) sawLegendary = true;
        if (def?.duoPatrons) sawDuo = true;
      }
    }
    check("commitment unlocks its legendary and its duos", sawLegendary && sawDuo, `legendary ${sawLegendary}, duo ${sawDuo}`);
  }

  // Prestige gating must not leak, the same way the worker and item pools
  // already don't.
  {
    let leaked = 0;
    for (let seed = 0; seed < 600; seed++) {
      for (const card of drawOffer({ held: [], prestigeLevel: 0 }, seed, 3).cards) {
        if (!isUnlocked("boon", card.boonId, 0)) leaked++;
      }
    }
    check("locked boons never leak at prestige 0", leaked === 0, `${leaked} leaks`);
  }

  // Determinism, and the resume guarantee that depends on it: the same seed and
  // state must always produce the same cards, or closing the app mid-decision
  // becomes a way to fish for a better draw.
  {
    const a = drawOffer(baseCtx([]), 777, 3);
    const b = drawOffer(baseCtx([]), 777, 3);
    check("the same seed draws the same cards", JSON.stringify(a) === JSON.stringify(b), a.cards.map((c) => c.boonId).join(", "));
    const r1 = rerollOffer(a, baseCtx([]), 3);
    const r2 = rerollOffer(a, baseCtx([]), 3);
    check("a reroll is itself reproducible", JSON.stringify(r1) === JSON.stringify(r2), r1.cards.map((c) => c.boonId).join(", "));
    check("a reroll actually changes the cards", JSON.stringify(r1.cards) !== JSON.stringify(a.cards), "diverges");
    check("a reroll spends exactly one charge", rerollOffer({ ...a, rerollsLeft: 2 }, baseCtx([]), 3).rerollsLeft === 1, "1 left of 2");
    check("reroll charges never go negative", rerollOffer({ ...a, rerollsLeft: 0 }, baseCtx([]), 3).rerollsLeft === 0, "floored at 0");
  }

  // Luck must move the odds in the right direction, and rarity must stay rare
  // enough that a Heroic is an event.
  {
    const countHeroic = (luck: number): number => {
      let heroic = 0;
      let total = 0;
      for (let seed = 0; seed < 3000; seed++) {
        for (const card of drawOffer({ held: [], prestigeLevel: 3, rarityLuck: luck }, seed, 3).cards) {
          total++;
          if (card.rarity === "heroic") heroic++;
        }
      }
      return (100 * heroic) / total;
    };
    const plain = countHeroic(0);
    const lucky = countHeroic(0.6);
    check("Heroic stays a genuine event", plain > 0 && plain < 8, `${plain.toFixed(2)}% of cards`);
    check("rarity luck raises the odds", lucky > plain, `${plain.toFixed(2)}% -> ${lucky.toFixed(2)}%`);
  }

  // The keepsake is the one sanctioned thumb on the scale — the pre-run lever
  // that lets a build be intentional from the first room.
  {
    let matched = 0;
    for (let seed = 0; seed < 400; seed++) {
      const offer = drawOffer({ held: [], prestigeLevel: 3, keepsake: "sap" }, seed, 3);
      if (BOON_DEFS_BY_ID[offer.cards[0]?.boonId]?.patron === "sap") matched++;
    }
    check("a keepsake steers the first card", matched === 400, `${matched}/400`);
  }

  // Applying a card has to do what the card said. The upgrade case is the one
  // worth pinning: losing accumulated ranks to a rarity upgrade would make a
  // Heroic a punishment for anyone who had already invested in that boon.
  {
    let held: BoonInstance[] = [];
    held = applyOfferCard(held, { boonId: "battleFury", rarity: "rare" }, 1);
    check("a fresh pick lands at rank 1", held.length === 1 && held[0].rank === 1 && held[0].rarity === "rare", JSON.stringify(held[0]));
    held = applyOfferCard(held, { boonId: "battleFury", rarity: "rare", rankUp: true }, 2);
    check("a rank-up deepens in place", held.length === 1 && held[0].rank === 2, `rank ${held[0].rank}`);
    held = applyOfferCard(held, { boonId: "battleFury", rarity: "heroic" }, 3);
    check("a rarity upgrade keeps the rank already earned", held[0].rarity === "heroic" && held[0].rank === 2, `${held[0].rarity} rank ${held[0].rank}`);
    held = applyOfferCard(held, { boonId: "kindle", rarity: "rare" }, 4);
    held = applyOfferCard(held, { boonId: "thornbite", rarity: "epic", replacesId: "kindle" }, 5);
    check(
      "an exclusive pick displaces the boon it named",
      held.some((h) => h.id === "thornbite") && !held.some((h) => h.id === "kindle"),
      held.map((h) => h.id).join(", "),
    );
  }

  // Stacking caps must hold, or Aura stops being a budget and the exclusive
  // slots stop mattering by comparison.
  {
    const full: BoonInstance[] = [
      { id: "ironroot", rarity: "common", rank: 1 },
      { id: "barbedHide", rarity: "common", rank: 1 },
      { id: "deepRoots", rarity: "common", rank: 1 },
      { id: "guardiansWard", rarity: "common", rank: 1 },
    ];
    let overCap = 0;
    for (let seed = 0; seed < 500; seed++) {
      for (const card of drawOffer(baseCtx(full), seed, 3).cards) {
        const def = BOON_DEFS_BY_ID[card.boonId];
        if (def?.slot === "aura" && !full.some((h) => h.id === card.boonId)) overCap++;
      }
    }
    check("a full Aura budget is respected", overCap === 0, `${overCap} over-cap offers`);
  }
}

// --- Status effects --------------------------------------------------------
//
// Unit-level assertions, deliberately not win-rate ones. A status bug shows up
// in a win rate as a few points of drift that looks exactly like a balance
// question, and by the time anyone investigates, the band has usually been
// "fixed" by adjusting the band. Checking the arithmetic directly means a
// regression names itself.
//
// The potency-snapshot case is the load-bearing one: it is the property that
// makes a mid-fight app restart safe, and it is invisible in any aggregate.

function statusChecks(): void {
  console.log("\nStatus effects:");

  const app = (over: Partial<StatusApplication> & { status: StatusApplication["status"] }): StatusApplication => ({
    stacks: 1,
    rounds: 1,
    chance: 1,
    potencyPct: 0,
    ...over,
  });

  // Damage-over-time is front-loaded and self-terminating: intensity is also
  // the clock, so 5 stacks at 3 damage deal 15+12+9+6+3 and then the unit is
  // clean. Stacking has to be worth chasing without being permanent.
  {
    const board: StatusBoard = {};
    applyStatus(board, "e", app({ status: "burn", stacks: 5 }), 3);
    const perRound: number[] = [];
    for (let i = 0; i < 6; i++) {
      const ticks = tickStatuses(board, ["e"]);
      perRound.push(ticks[0]?.damage ?? 0);
    }
    check(
      "burn is front-loaded and self-terminating",
      JSON.stringify(perRound) === JSON.stringify([15, 12, 9, 6, 3, 0]),
      `${perRound.join(", ")} (total ${perRound.reduce((a, b) => a + b, 0)})`,
    );
    check("burn leaves the board empty", Object.keys(board).length === 0, `${Object.keys(board).length} unit(s) left`);
  }

  // THE RESUME GUARANTEE. Potency is frozen when the status lands, so an
  // applier who dies, levels, or has their gear swapped mid-run cannot
  // retroactively change a burn already on the board. Without this, reloading
  // a paused fight would re-derive different tick damage than the player saw.
  {
    const board: StatusBoard = {};
    let attackerAtk = 40;
    applyStatus(board, "e", app({ status: "burn", stacks: 2, potencyPct: 0.25 }), resolvePotency(app({ status: "burn", potencyPct: 0.25 }), attackerAtk, 999));
    attackerAtk = 4000; // the applier levels up, or a different member acts
    void attackerAtk;
    const first = tickStatuses(board, ["e"])[0]?.damage ?? 0;
    check("burn potency is frozen at apply time", first === 20, `${first} damage (expected 2 stacks x 10)`);
  }

  // Weak and Vulnerable are pure multipliers and must return EXACTLY 1.0 when
  // absent — they are multiplied into the damage formula unconditionally, and
  // a value that merely rounds to 1 would perturb results the seeded sim
  // asserts to the seventeenth digit.
  {
    const board: StatusBoard = {};
    check(
      "absent statuses multiply by exactly 1",
      statusMult(board, "e", "weak", -1) === 1 && statusMult(board, "e", "vulnerable", 1) === 1,
      `${statusMult(board, "e", "weak", -1)} / ${statusMult(board, "e", "vulnerable", 1)}`,
    );
    applyStatus(board, "e", app({ status: "weak", stacks: 2, rounds: 3, potencyPct: 0.2 }), 0.2);
    applyStatus(board, "e", app({ status: "vulnerable", stacks: 1, rounds: 2, potencyPct: 0.25 }), 0.25);
    check("weak reduces by stacks x potency", Math.abs(statusMult(board, "e", "weak", -1) - 0.6) < 1e-9, `${statusMult(board, "e", "weak", -1)}`);
    check("vulnerable raises by stacks x potency", Math.abs(statusMult(board, "e", "vulnerable", 1) - 1.25) < 1e-9, `${statusMult(board, "e", "vulnerable", 1)}`);
  }

  // Stacked Weak can trivialise a fight but must never make an enemy
  // completely harmless — a 0-damage enemy removes any reason to finish
  // killing it, which turns a won fight into busywork.
  {
    const board: StatusBoard = {};
    applyStatus(board, "e", app({ status: "weak", stacks: 20, rounds: 5, potencyPct: 0.5 }), 0.5);
    const mult = statusMult(board, "e", "weak", -1);
    check("weak is floored above zero", mult >= 0.05 && mult < 0.2, `x${mult}`);
  }

  // Duration statuses expire on their own clock, independent of intensity.
  {
    const board: StatusBoard = {};
    applyStatus(board, "m", app({ status: "regen", stacks: 3, rounds: 2 }), 4);
    const a = tickStatuses(board, ["m"])[0]?.heal ?? 0;
    const b = tickStatuses(board, ["m"])[0]?.heal ?? 0;
    const c = tickStatuses(board, ["m"])[0]?.heal ?? 0;
    check("regen heals at full strength then expires", a === 12 && b === 12 && c === 0, `${a}, ${b}, ${c}`);
  }

  // Bark soaks before HP, partially or fully, and reports the absorb
  // separately so a fully-soaked hit can read as "blocked" rather than as a
  // miss.
  {
    const board: StatusBoard = {};
    applyStatus(board, "m", app({ status: "bark", stacks: 10 }), 1);
    const partial = absorbShield(board, "m", 4);
    const rest = absorbShield(board, "m", 20);
    const gone = absorbShield(board, "m", 5);
    check(
      "bark soaks then breaks",
      partial.through === 0 && partial.absorbed === 4 && rest.through === 14 && rest.absorbed === 6 && gone.absorbed === 0,
      `${partial.absorbed} then ${rest.absorbed}, ${rest.through} through`,
    );
    check("a spent shield is deleted, not left at zero", board.m === undefined, JSON.stringify(board));
  }

  // Mark is "none"-decay: its consumer is the only thing that removes it, so a
  // missing consumer would make it permanent.
  {
    const board: StatusBoard = {};
    applyStatus(board, "e", app({ status: "mark", stacks: 1, potencyPct: 0.3 }), 0.3);
    const first = consumeMark(board, "e");
    const second = consumeMark(board, "e");
    check("mark is consumed exactly once", Math.abs(first - 0.3) < 1e-9 && second === 0, `${first} then ${second}`);
  }

  // Stacking rule: intensity adds, duration takes the max, potency takes the
  // max. A weak late application must never dilute a strong earlier one —
  // that reads as "my burn got worse when I hit it again".
  {
    const board: StatusBoard = {};
    applyStatus(board, "e", app({ status: "burn", stacks: 2, rounds: 5 }), 10);
    applyStatus(board, "e", app({ status: "burn", stacks: 1, rounds: 2 }), 3);
    const stack = board.e!.burn!;
    check(
      "restacking adds intensity and keeps the best potency",
      stack.stacks === 3 && stack.potency === 10 && stack.rounds === 5,
      `${stack.stacks} stacks at ${stack.potency}`,
    );
  }

  // THE RNG RULE. A certain application must not consume a draw, or every
  // seeded scenario in this file shifts by one the moment status content ships.
  {
    const board: StatusBoard = {};
    let draws = 0;
    const counting = () => {
      draws++;
      return 0.5;
    };
    applyStatus(board, "e", app({ status: "burn", stacks: 1 }), 1, undefined, counting);
    check("a certain status consumes no rng draw", draws === 0, `${draws} draw(s)`);
    applyStatus(board, "e", app({ status: "burn", stacks: 1, chance: 0.9 }), 1, undefined, counting);
    check("an uncertain status consumes exactly one", draws === 1, `${draws} draw(s)`);
  }

  // Every status must be able to leave the board. A "none"-decay status with
  // no consumer would be permanent, which no design here intends.
  {
    // glitch is consumed at application time (routed to skipNext), so it never
    // reaches the board to need decay in the first place.
    const consumed: Record<string, boolean> = { bark: true, mark: true, glitch: true };
    const stuck = STATUS_DEFS.filter((d) => d.decay === "none" && !consumed[d.id]);
    check("no status can become permanent", stuck.length === 0, stuck.map((d) => d.id).join(", ") || "all terminate");
  }

  // Enemy ids are POSITIONAL ("enemy-0", "enemy-1") and reassigned by every
  // startBattle, so a stale board would hand a fresh enemy the previous one's
  // burn. This is the same id-reuse hazard that has already produced one bug
  // in the battle UI's enemy rows.
  {
    const board: StatusBoard = { "enemy-0": {}, "enemy-1": {} };
    applyStatus(board, "enemy-0", app({ status: "burn", stacks: 4 }), 5);
    applyStatus(board, "enemy-1", app({ status: "burn", stacks: 4 }), 5);
    pruneStatuses(board, ["enemy-0"]);
    check("pruning drops units that are no longer in the fight", board["enemy-1"] === undefined && board["enemy-0"] !== undefined, Object.keys(board).join(", "));
  }
}

// --- Save migrations -------------------------------------------------------
//
// These could not be tested at all until migrateTo* moved out of game-state.ts
// (which imports Tauri's `invoke` and so can never be loaded here). They are
// the highest-consequence untested code in the project: a migration bug does
// not throw, it produces a save that looks fine and behaves wrong, and it only
// ever runs against data shapes that no longer exist anywhere in the tree —
// so nobody is in a position to notice by reading.
//
// Each case below is a real historical shape, not a synthetic one.

function migrationChecks(): void {
  console.log("\nSave migrations:");

  // v2 -> current: the pre-gacha era. A bare `ownedAxe` tier and the old
  // global helper list, with no team/inventory at all.
  {
    const raw: Record<string, unknown> = {
      version: 2,
      wood: 4321,
      ownedAxe: 3,
      helpers: ["boots", "keenEdge", "gnome1", "notAThing"],
    };
    const out = migrateSave(raw, makeSave(), 6);
    check("v2 save keeps its wood", out.wood === 4321, `${out.wood}`);
    check("v2 save gains a starter member", out.team.length === 1, `${out.team.length} member(s)`);
    check(
      "v2 axe tier becomes an equipped item",
      out.inventory.length === 1 &&
        out.inventory[0].defId === "legacy-axe-3" &&
        out.team[0].equipped.woodchopping === out.inventory[0].id,
      out.inventory[0]?.defId ?? "none",
    );
    check(
      "v2 helpers split into power-ups vs gnomes",
      out.powerups.includes("swiftBoots") &&
        out.powerups.includes("keenEdge") &&
        out.helpers.length === 1 &&
        out.helpers[0] === "gnome1",
      `powerups=[${out.powerups.join(",")}] helpers=[${out.helpers.join(",")}]`,
    );
    check("v2 starter is at full HP", out.team[0].currentHp === out.team[0].maxHp, `${out.team[0].currentHp}/${out.team[0].maxHp}`);
  }

  // v4 -> current: a mid-run adventure carrying a pre-multi-enemy battle
  // (single `enemy`, no `enemies` array). The fight must be dropped, the run
  // and its pending rewards must NOT be.
  {
    const raw: Record<string, unknown> = {
      version: 4,
      team: [],
      adventure: {
        world: 0,
        partyIds: ["m-1"],
        stage: 2,
        pendingWood: 180,
        pendingAmber: 5,
        carried: [],
        abilityUsed: false,
        startedAt: "sim",
        log: [],
        battle: { enemy: { name: "old" }, enemyHp: 7, round: 3 },
      },
    };
    const out = migrateSave(raw, makeSave(), 6);
    // v6 turned Adventure into a room graph, so a v4/v5 run has no honest
    // translation and is dropped. What it EARNED is credited rather than
    // confiscated — losing the rest of the delve to an update is unavoidable,
    // losing the wood already won is not.
    check("an un-translatable old run is dropped", out.adventure === null, `${JSON.stringify(out.adventure)}`);
    check(
      "its earnings are credited, not confiscated",
      out.wood === 180 && out.amber === 5 && out.stats.woodFromAdventures === 180,
      `${out.wood} wood, ${out.amber} amber`,
    );
  }

  // A v6 run must pass through untouched — the migration is keyed on the
  // presence of the room graph, so a modern save must not be mistaken for an
  // old one and thrown away.
  {
    const raw: Record<string, unknown> = {
      version: 6,
      team: [],
      adventure: {
        world: 0,
        partyIds: ["m-1"],
        roomsCleared: 3,
        seed: 99,
        map: { seed: 99, slots: [] },
        pendingWood: 400,
        acorns: 30,
      },
    };
    const out = migrateSave(raw, makeSave(), 6);
    check("a current run survives the migration untouched", out.adventure?.roomsCleared === 3 && out.wood === 0, `roomsCleared ${out.adventure?.roomsCleared}, wood ${out.wood}`);
  }

  // The self-healing invariant: a member left marked "adventuring" with no
  // matching run. This is the desync that used to make a worker permanently
  // unselectable with no in-game way to recover, so it is checked in both
  // directions — released when stranded, left alone when genuinely on the run.
  {
    const fresh = makeSave();
    fresh.team = [
      { ...createMember("rook", 1), id: "m-1", status: "adventuring", currentHp: 8 },
      { ...createMember("rook", 2), id: "m-2", status: "adventuring", currentHp: 0 },
      { ...createMember("rook", 3), id: "m-3", status: "adventuring", currentHp: 5 },
    ];
    // A CURRENT-shaped run (it has a map), so v6 leaves it alone and this
    // isolates the reconcile pass rather than accidentally testing the drop.
    const raw: Record<string, unknown> = {
      version: 6,
      team: fresh.team,
      adventure: {
        world: 0,
        partyIds: ["m-3"],
        roomsCleared: 1,
        seed: 1,
        map: { seed: 1, slots: [] },
        battle: null,
      },
    };
    const out = migrateSave(raw, fresh, 6);
    const byId = new Map(out.team.map((m) => [m.id, m]));
    check(
      "stranded living member is released to available",
      byId.get("m-1")?.status === "available",
      `${byId.get("m-1")?.status}`,
    );
    check(
      "stranded downed member is released to resting",
      byId.get("m-2")?.status === "resting",
      `${byId.get("m-2")?.status}`,
    );
    check(
      "member genuinely on the run stays adventuring",
      byId.get("m-3")?.status === "adventuring",
      `${byId.get("m-3")?.status}`,
    );
  }

  // Nested-object merge: a save predating a sub-field must GAIN the default
  // rather than have its partial object clobber the whole block. `provisions`
  // is the sharpest case — a missing key there reads as NaN on every later
  // arithmetic op rather than failing loudly.
  {
    const raw: Record<string, unknown> = {
      version: 5,
      provisions: { trailRations: 2 },
      shards: { rare: 9 },
      stats: { chops: 77 },
    };
    const out = migrateSave(raw, makeSave(), 6);
    check(
      "partial nested objects gain defaults, keep values",
      out.provisions.trailRations === 2 &&
        out.provisions.fortuneCharm === 0 &&
        out.shards.rare === 9 &&
        out.shards.common === 0 &&
        out.stats.chops === 77 &&
        out.stats.treesFelled === 0,
      `rations ${out.provisions.trailRations}, charms ${out.provisions.fortuneCharm}`,
    );
    check("version is always stamped forward", out.version === 6, `${out.version}`);
  }

  // Idempotence: re-running the whole transform on an already-migrated save
  // must be a no-op. Every migration is version-gated except reconcile, and a
  // migration that is not idempotent corrupts on the second load, not the
  // first — which is exactly the kind of bug that ships.
  {
    const once = migrateSave({ version: 2, ownedAxe: 1, helpers: ["boots"] }, makeSave(), 6);
    const twice = migrateSave(JSON.parse(JSON.stringify(once)) as Record<string, unknown>, makeSave(), 6);
    check(
      "migrating an already-migrated save is a no-op",
      JSON.stringify(once) === JSON.stringify(twice),
      `${twice.team.length} member(s), ${twice.inventory.length} item(s)`,
    );
  }
}

function rarityAtLeast(r: Rarity, floor: Rarity): boolean {
  return RARITY_ORDER.indexOf(r) >= RARITY_ORDER.indexOf(floor);
}

function gachaChecks(): void {
  console.log("\nGacha invariants:");

  // Worker pity: never more than WORKER_PITY_THRESHOLD - 1 consecutive
  // below-Rare pulls; dupes pay exactly SHARD_VALUE[rarity] shards.
  {
    const save = makeSave();
    const rng = scenarioRng("gacha-worker");
    let sinceRarePlus = 0;
    let maxGap = 0;
    let shardErrors = 0;
    for (let i = 0; i < moves.gacha.workerPulls; i++) {
      const before = { ...save.shards };
      const result = pullWorker(save, rng);
      if (rarityAtLeast(result.def.rarity, "rare")) {
        sinceRarePlus = 0;
      } else {
        sinceRarePlus++;
        maxGap = Math.max(maxGap, sinceRarePlus);
      }
      if (!result.isNew) {
        const gained = save.shards[result.def.rarity] - before[result.def.rarity];
        if (gained !== SHARD_VALUE[result.def.rarity] || result.shardsGained !== gained) {
          shardErrors++;
        }
      }
    }
    check(
      "worker pity guarantees Rare+ within threshold",
      maxGap < WORKER_PITY_THRESHOLD,
      `max below-Rare streak ${maxGap} (limit ${WORKER_PITY_THRESHOLD - 1})`,
    );
    check("worker dupe shard payouts", shardErrors === 0, `${shardErrors} mismatches`);
  }

  // Item pity (per-world counter): Epic+ within ITEM_PITY_THRESHOLD.
  {
    const save = makeSave();
    const rng = scenarioRng("gacha-item");
    let sinceEpicPlus = 0;
    let maxGap = 0;
    for (let i = 0; i < moves.gacha.itemPulls; i++) {
      const result = pullItem(save, 0, rng);
      if (rarityAtLeast(result.def.rarity, "epic")) {
        sinceEpicPlus = 0;
      } else {
        sinceEpicPlus++;
        maxGap = Math.max(maxGap, sinceEpicPlus);
      }
    }
    check(
      "item pity guarantees Epic+ within threshold",
      maxGap < ITEM_PITY_THRESHOLD,
      `max below-Epic streak ${maxGap} (limit ${ITEM_PITY_THRESHOLD - 1})`,
    );
  }

  // Power-up pity: Epic+ within POWERUP_PITY_THRESHOLD; dupe shards correct.
  {
    const save = makeSave();
    const rng = scenarioRng("gacha-powerup");
    let sinceEpicPlus = 0;
    let maxGap = 0;
    let shardErrors = 0;
    for (let i = 0; i < moves.gacha.powerupPulls; i++) {
      const before = { ...save.shards };
      const result = pullPowerup(save, rng);
      if (rarityAtLeast(result.spec.rarity, "epic")) {
        sinceEpicPlus = 0;
      } else {
        sinceEpicPlus++;
        maxGap = Math.max(maxGap, sinceEpicPlus);
      }
      if (!result.isNew) {
        const gained = save.shards[result.spec.rarity] - before[result.spec.rarity];
        if (gained !== SHARD_VALUE[result.spec.rarity]) shardErrors++;
      }
    }
    check(
      "powerup pity guarantees Epic+ within threshold",
      maxGap < POWERUP_PITY_THRESHOLD,
      `max below-Epic streak ${maxGap} (limit ${POWERUP_PITY_THRESHOLD - 1})`,
    );
    check("powerup dupe shard payouts", shardErrors === 0, `${shardErrors} mismatches`);
  }
}

// --- Prestige-unlock invariants (Phase 2) ----------------------------------

function unlockChecks(): void {
  console.log("\nPrestige-unlock invariants:");

  const gatedWorkers = UNLOCKS.filter((u) => u.kind === "worker").map((u) => u.refId);
  const gatedBoons = UNLOCKS.filter((u) => u.kind === "boon").map((u) => u.refId);
  const maxPrestige = Math.max(...UNLOCKS.map((u) => u.prestige));

  // Locked pools never leak: a prestige-0 save can't pull gated workers; a
  // max-prestige save can. And the RARITY sequence must be identical for
  // the same seed regardless of prestige (pool filtering happens strictly
  // inside the already-rolled rarity, after the pity update, consuming the
  // same number of rng draws) — which is exactly "pity math unaffected".
  {
    const runPulls = (prestigeLevel: number) => {
      const save = makeSave();
      save.prestigeLevel = prestigeLevel;
      const rng = scenarioRng("unlock-worker-pool");
      const rarities: string[] = [];
      const defIds: string[] = [];
      for (let i = 0; i < moves.gacha.workerPulls; i++) {
        const result = pullWorker(save, rng);
        rarities.push(result.def.rarity);
        defIds.push(result.def.id);
      }
      return { rarities, defIds };
    };
    const p0 = runPulls(0);
    const pMax = runPulls(maxPrestige);
    const p0Leaks = p0.defIds.filter((id) => gatedWorkers.includes(id)).length;
    const pMaxHits = new Set(pMax.defIds.filter((id) => gatedWorkers.includes(id))).size;
    check("locked workers never drop at prestige 0", p0Leaks === 0, `${p0Leaks} leaks`);
    check(
      "all gated workers drop at max prestige",
      pMaxHits === gatedWorkers.length,
      `${pMaxHits}/${gatedWorkers.length} distinct gated workers seen`,
    );
    const raritySame = p0.rarities.join(",") === pMax.rarities.join(",");
    check("rarity/pity sequence is prestige-invariant", raritySame, "same seed, same rarity stream");
  }

  // Boon offers: gated boons never appear at prestige 0, do appear (in
  // aggregate) once unlocked, and the draw is deterministic for a fixed
  // seed + prestige level.
  {
    const drawMany = (prestigeLevel: number) => {
      const rng = scenarioRng("unlock-boon-pool");
      const seen = new Set<string>();
      for (let i = 0; i < 500; i++) {
        for (const card of drawOffer({ held: [], prestigeLevel }, Math.floor(rng() * 1e9), 3).cards) {
          seen.add(card.boonId);
        }
      }
      return seen;
    };
    const p0Seen = drawMany(0);
    const pMaxSeen = drawMany(maxPrestige);
    const p0Leaks = gatedBoons.filter((id) => p0Seen.has(id));
    const pMaxHits = gatedBoons.filter((id) => pMaxSeen.has(id));
    check("locked boons never offered at prestige 0", p0Leaks.length === 0, p0Leaks.join(",") || "clean");
    check(
      "gated boons offered once unlocked",
      pMaxHits.length === gatedBoons.length,
      `${pMaxHits.length}/${gatedBoons.length}`,
    );
    const again = drawMany(maxPrestige);
    check(
      "boon offer draw deterministic per seed",
      [...pMaxSeen].sort().join() === [...again].sort().join(),
      "re-run matches",
    );
  }

  // Registry sanity: every gated refId actually exists in its pool, so an
  // unlock can never point at nothing.
  {
    const missing: string[] = [];
    for (const u of UNLOCKS) {
      if (u.kind === "worker" && !gatedWorkers.includes(u.refId)) missing.push(u.refId);
      if (u.kind === "boon" && !isUnlocked("boon", u.refId, u.prestige)) missing.push(u.refId);
    }
    check("registry entries resolve", missing.length === 0, missing.join(",") || "all resolve");
  }
}

// --- Battle-XP curve invariants (Phase 3) ----------------------------------

function xpChecks(): void {
  console.log("\nBattle-XP invariants:");

  // A stage-1 win must never level a fresh member — otherwise farming the
  // guaranteed first fight erodes the stage-2 roster gate.
  const s1xp = stageXpReward(1, 0);
  check(
    "stage-1 XP can't level a fresh member",
    s1xp < xpToNext(1),
    `stage-1 grants ${s1xp}, level 2 needs ${xpToNext(1)}`,
  );

  // One full World-0 clear gives meaningful-but-bounded early momentum:
  // a fresh common ends it at level 2-4, never past the early-stage bands.
  {
    const { party, inventory } = buildParty([{ defId: "rook", level: 1 }]);
    const m = party[0];
    for (let stage = 1; stage <= 5; stage++) grantXp(m, stageXpReward(stage, 0), inventory, 0);
    check(
      "one full w0 clear lands a fresh member at level 2-4",
      m.level >= 2 && m.level <= 4,
      `level ${m.level} after one clear`,
    );
  }

  // The curve must keep steepening — later levels always cost more.
  let monotonic = true;
  for (let level = 1; level < 19; level++) {
    if (xpToNext(level + 1) <= xpToNext(level)) monotonic = false;
  }
  check("xpToNext strictly increasing", monotonic, "levels never get cheaper");
}

// --- Hardcoded economy invariants ------------------------------------------

function economyChecks(): void {
  console.log("\nEconomy invariants:");

  // Embark → stage-1 win must be net-positive wood at EVERY party size
  // (embark is flat, not per-member), and stage 1 must be a guaranteed win
  // even for a lone fresh common.
  const commons = ["rook", "finch", "marl"];
  for (let size = 1; size <= 3; size++) {
    const specs = commons.slice(0, size).map((defId) => ({ defId, level: 1 }));
    const rng = scenarioRng(`embark-net-${size}`);
    let wins = 0;
    const trials = 200;
    for (let t = 0; t < trials; t++) {
      const { party, inventory } = buildParty(specs);
      const flags: RunFlags = { abilityUsed: false };
      if (runOneBattle(party, inventory, 0, 1, "attack", {}, flags, rng) === "win") wins++;
    }
    const cost = embarkCost(getWorld(0).mult);
    const reward = buildEnemy(0, 1).reduce((sum, e) => sum + e.woodReward, 0);
    check(
      `embark net-positive at party size ${size}`,
      wins === trials && reward > cost,
      `win ${wins}/${trials}, reward ${reward} vs embark ${cost}`,
    );
  }
}

// --- Phase-5 feature gates -------------------------------------------------

function featureChecks(): void {
  console.log("\nPhase-5 feature gates:");

  // Sap Press ↔ Amber Trade: round-tripping wood → amber → wood must be a
  // heavy loss at EVERY world (no arbitrage; both sides scale ×mult
  // consistently so the loss ratio is world-invariant).
  {
    const tradeWoodBase = 25; // Amber Trade payout: 25 wood × mult (economy.ts blurb)
    let worstRatio = 0;
    for (let world = 0; world <= 10; world++) {
      const mult = getWorld(world).mult;
      const ambersNeeded = amberTradeCost(mult);
      const pressesNeeded = ambersNeeded / SAP_PRESS_AMBER_YIELD;
      const woodIn = pressesNeeded * sapPressCost(mult);
      const woodOut = tradeWoodBase * mult;
      worstRatio = Math.max(worstRatio, woodOut / woodIn);
    }
    check(
      "sap press round-trip is never profitable",
      worstRatio < 0.5,
      `worst wood-out/wood-in ${(100 * worstRatio).toFixed(1)}% (limit <50%)`,
    );
    check(
      "amber trade boost still defined",
      BOOSTS.some((b) => b.id === "amberWood"),
      "sap press's counterpart exists",
    );
  }

  // Focus Overflow accrual is split-invariant: any chunking of the same
  // token total yields exactly floor(total / threshold) logs.
  {
    const rng = scenarioRng("overflow-split");
    let splitMismatch = 0;
    for (let trial = 0; trial < 50; trial++) {
      const total = Math.floor(rng() * OVERFLOW_LOG_TOKENS * 8);
      let carry = 0;
      let logs = 0;
      let remaining = total;
      while (remaining > 0) {
        const chunk = Math.min(remaining, Math.max(1, Math.floor(rng() * 9000)));
        const r = accrueOverflow(carry, chunk);
        carry = r.carry;
        logs += r.logs;
        remaining -= chunk;
      }
      if (logs !== Math.floor(total / OVERFLOW_LOG_TOKENS)) splitMismatch++;
    }
    check("overflow accrual split-invariant", splitMismatch === 0, `${splitMismatch}/50 mismatches`);
  }

  // Optimize Gear: no double-assignment, priority order gets the best
  // items, and nobody ends up worse than bare-handed.
  {
    const { party: members } = buildParty([
      { defId: "rook", level: 3 },
      { defId: "birch", level: 2 },
      { defId: "thorne", level: 1 },
    ]);
    const inventory: ItemInstance[] = [
      { id: "i-1", defId: "w0-woodchopping-common" },
      { id: "i-2", defId: "w0-woodchopping-epic" },
      { id: "i-3", defId: "w1-woodchopping-rare" },
      { id: "i-4", defId: "w0-adventuring-rare" },
      { id: "i-5", defId: "w1-adventuring-epic" },
      { id: "i-6", defId: "w0-utility-legendary" },
      { id: "i-7", defId: "w0-utility-common" },
    ];
    const bareAtk = members.map((m) => effectiveAtk(m, [], 0));
    optimizeEquipment(members, inventory, false);
    for (const m of members) syncHp(m, inventory, 0);

    const assigned = members.flatMap((m) =>
      [m.equipped.woodchopping, m.equipped.adventuring, m.equipped.utility, m.equipped.utility2].filter(
        (id): id is string => !!id,
      ),
    );
    check(
      "optimize assigns each item at most once",
      new Set(assigned).size === assigned.length,
      `${assigned.length} assignments, ${new Set(assigned).size} distinct`,
    );
    // Best woodchopping item is w1 rare (atk 25) vs epic w0 (atk 6): top
    // priority member must hold the highest-atk one.
    check(
      "top-priority member gets the best axe",
      members[0].equipped.woodchopping === "i-3",
      `member[0] holds ${members[0].equipped.woodchopping}`,
    );
    check(
      "top-priority member gets the best blade",
      members[0].equipped.adventuring === "i-5",
      `member[0] holds ${members[0].equipped.adventuring}`,
    );
    const noWorse = members.every((m, i) => effectiveAtk(m, inventory, 0) >= bareAtk[i]);
    check("optimize never leaves a member below bare-handed", noWorse, "atk >= unequipped for all");
    const hpSane = members.every((m) => effectiveMaxHp(m, inventory, 0) === m.maxHp);
    check("optimize re-syncs HP", hpSane, "maxHp matches effectiveMaxHp");
  }

  // Cache Koi: accrual is split-invariant (shares accrueThreshold with
  // Focus Overflow — one more concrete case beyond the generic threshold
  // check below), reward is bounded and monotonic in lake density, and a
  // single below-threshold cache-read burst never spawns a koi.
  {
    const rng = scenarioRng("koi-split");
    let splitMismatch = 0;
    for (let trial = 0; trial < 50; trial++) {
      const total = Math.floor(rng() * CACHE_KOI_TOKENS * 6);
      let carry = 0;
      let koiCount = 0;
      let remaining = total;
      while (remaining > 0) {
        const chunk = Math.min(remaining, Math.max(1, Math.floor(rng() * 7000)));
        const r = accrueCacheKoi(carry, chunk);
        carry = r.carry;
        koiCount += r.koi;
        remaining -= chunk;
      }
      if (koiCount !== Math.floor(total / CACHE_KOI_TOKENS)) splitMismatch++;
    }
    check("cache koi accrual split-invariant", splitMismatch === 0, `${splitMismatch}/50 mismatches`);

    const belowThreshold = accrueCacheKoi(0, CACHE_KOI_TOKENS - 1);
    check(
      "a single below-threshold burst never spawns a koi",
      belowThreshold.koi === 0,
      `koi=${belowThreshold.koi} at ${CACHE_KOI_TOKENS - 1} tokens`,
    );

    const rewards = [0, 0.25, 0.5, 0.75, 1].map(koiReward);
    const inBounds = rewards.every((r) => r >= CACHE_KOI_AMBER_MIN && r <= CACHE_KOI_AMBER_MAX);
    check("koi reward always in bounds", inBounds, `[${rewards.join(", ")}] within [${CACHE_KOI_AMBER_MIN}, ${CACHE_KOI_AMBER_MAX}]`);
    const monotonic = rewards.every((r, i) => i === 0 || r >= rewards[i - 1]);
    check("koi reward monotonic in lake density", monotonic, `[${rewards.join(", ")}] non-decreasing`);
  }

  // accrueThreshold itself (shared by Focus Overflow + Cache Koi): generic
  // split-invariance across arbitrary (amount, threshold) pairs, not just
  // the two concrete constants exercised above.
  {
    const rng = scenarioRng("threshold-split-generic");
    let mismatch = 0;
    for (let trial = 0; trial < 30; trial++) {
      const threshold = 500 + Math.floor(rng() * 20000);
      const total = Math.floor(rng() * threshold * 5);
      let carry = 0;
      let units = 0;
      let remaining = total;
      while (remaining > 0) {
        const chunk = Math.min(remaining, Math.max(1, Math.floor(rng() * (threshold / 2 + 1))));
        const r = accrueThreshold(carry, chunk, threshold);
        carry = r.carry;
        units += r.units;
        remaining -= chunk;
      }
      if (units !== Math.floor(total / threshold)) mismatch++;
    }
    check("accrueThreshold split-invariant (generic)", mismatch === 0, `${mismatch}/30 mismatches`);
  }

  // --- Environmental resource props (Iteration 5) --------------------------
  //
  // These props only *describe* save values, so the gates here are about the
  // readouts staying meaningful, not about balance. The important one is
  // world-invariance: wood income scales 10^world, so a log-stack threshold
  // expressed in absolute wood would peg at "wall" forever past ~World 2.
  {
    const ratios = [0.0, 0.01, 0.04, 0.06, 0.3, 0.49, 0.51, 0.9, 4.0];
    let mismatch = 0;
    let sampled = 0;
    for (const r of ratios) {
      // World 0 travels free, so logStackTier falls back to World 1's cost as
      // its yardstick — mirror that here to compare like with like.
      const ref = (w: number): number => travelCostForWorld(w + 1) || travelCostForWorld(1);
      const base = logStackTier(ref(0) * r, 0);
      for (let w = 1; w <= 10; w++) {
        const t = logStackTier(ref(w) * r, w);
        sampled++;
        if (t.tier !== base.tier || Math.abs(t.within - base.within) > 1e-6) mismatch++;
      }
    }
    check(
      "log stack tier is world-invariant — same wood/travel-cost ratio, same pile",
      mismatch === 0,
      `${mismatch}/${sampled} mismatches across worlds 1-10`,
    );

    // All three tiers must actually be reachable, or the prop silently only
    // ever renders one silhouette.
    const tiers = new Set(ratios.map((r) => logStackTier(travelCostForWorld(1) * r, 0).tier));
    check(
      "log stack reaches all three tiers",
      tiers.size === 3,
      `${[...tiers].sort().join(", ")}`,
    );

    // `within` is what drives the log count inside a tier; out-of-range values
    // would draw a pile with negative or runaway logs.
    let outOfRange = 0;
    for (let i = 0; i <= 400; i++) {
      const { within } = logStackTier(travelCostForWorld(1) * (i / 100), 3);
      if (!(within >= 0 && within <= 1)) outOfRange++;
    }
    check("log stack `within` stays in [0,1]", outOfRange === 0, `${outOfRange}/401 out of range`);

    // The pile must never shrink as wood grows. This mirrors Game.LOG_PILE /
    // drawLogStack exactly — a regression here means gaining wood visibly
    // *removes* logs at a tier boundary, which is precisely the bug the `from`
    // field exists to prevent.
    const PILE = {
      kindling: { from: 1, to: 2 },
      cord: { from: 2, to: 4 },
      wall: { from: 4, to: 7 },
    } as const;
    const logCount = (wood: number, world: number): number => {
      const { tier, within } = logStackTier(wood, world);
      const { from, to } = PILE[tier];
      return Math.max(1, from + Math.round((to - from) * within));
    };
    let shrinks = 0;
    let prevCount = -1;
    const step = travelCostForWorld(1) / 500;
    for (let wood = 0; wood <= travelCostForWorld(1) * 1.5; wood += step) {
      const n = logCount(wood, 0);
      if (n < prevCount) shrinks++;
      prevCount = n;
    }
    check("log pile never shrinks as wood grows", shrinks === 0, `${shrinks} shrink steps`);
  }

  {
    // Heat must be off at rest (so a cold axe looks like a normal axe) and
    // must brighten monotonically — a non-monotonic ramp would read as the
    // meter jittering backwards while Focus climbs.
    const lum = (hex: string): number => {
      const v = parseInt(hex.slice(1), 16);
      return 0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255);
    };
    check(
      "focus heat is null below the floor",
      focusHeatColor(0) === null && focusHeatColor(FOCUS_CAP * FOCUS_HEAT_FLOOR * 0.99) === null,
      `floor=${FOCUS_HEAT_FLOOR}`,
    );
    let regressions = 0;
    let prev = -1;
    for (let f = Math.ceil(FOCUS_CAP * FOCUS_HEAT_FLOOR); f <= FOCUS_CAP; f++) {
      const c = focusHeatColor(f);
      if (!c) continue;
      const l = lum(c);
      if (l < prev - 1e-6) regressions++;
      prev = l;
    }
    check("focus heat brightens monotonically", regressions === 0, `${regressions} regressions`);
  }

  {
    // A "full" lantern must mean "you can afford anything amber buys" —
    // otherwise the readout tops out while purchases are still unaffordable.
    const flatAmberPrices = [
      ADVENTURE_REVIVE_BASE_COST,
      ...BOOSTS.filter((b) => b.id !== "amberWood").map((b) => b.cost),
      ...PROVISIONS.filter((p) => p.currency === "amber").map((p) => p.cost),
    ];
    const worst = Math.max(...flatAmberPrices);
    check(
      "lantern-full covers every flat amber price",
      amberLanternFull() >= worst,
      `full=${amberLanternFull()} worst=${worst}`,
    );
  }

  // --- Cosmetic dyes (Iteration 5) -----------------------------------------
  {
    // The load-bearing guarantee: an undyed cosmetic must render EXACTLY as it
    // shipped, so every existing save is pixel-identical after this feature.
    let drift = 0;
    for (const spec of COSMETICS) {
      const before = JSON.stringify(spec.palette);
      const after = JSON.stringify(dyedPalette(spec, undefined));
      if (before !== after) drift++;
    }
    check("undyed cosmetics render identically to shipped", drift === 0, `${drift}/${COSMETICS.length} drifted`);

    // A dyeKey that isn't in the shipped palette would repaint a letter the
    // sprite never uses — the dye would silently do nothing.
    let orphan = 0;
    for (const spec of COSMETICS) {
      for (const { key } of spec.dyeKeys) {
        if (!(key in spec.palette)) orphan++;
      }
    }
    check("every dyeKey exists in its cosmetic's palette", orphan === 0, `${orphan} orphan keys`);

    // Dyeing must repaint every one of the cosmetic's own palette letters —
    // a half-dyed two-tone skin (new canopy, old highlight) looks broken.
    let unpainted = 0;
    for (const spec of COSMETICS) {
      const dyed = dyedPalette(spec, "#123456");
      for (const { key } of spec.dyeKeys) {
        if (dyed[key] === spec.palette[key]) unpainted++;
      }
    }
    check("dyeing repaints every dye key", unpainted === 0, `${unpainted} keys unchanged`);

    // Prices are frozen by the economy constraint — this feature must not have
    // moved one. Hardcoded on purpose: reading them from COSMETICS would make
    // the check tautological.
    const EXPECTED_COST: Record<string, number> = {
      capBlue: 50,
      capBlack: 100,
      capGold: 200,
      treeSakura: 500,
      treeBirch: 500,
    };
    let repriced = 0;
    for (const spec of COSMETICS) {
      if (EXPECTED_COST[spec.id] !== spec.cost) repriced++;
    }
    check("cosmetic prices unchanged", repriced === 0, `${repriced} repriced`);

    // Swatch breadth must rise with price, never fall — that's the whole
    // mechanism keeping the three same-shape caps meaningfully different.
    const caps = COSMETICS.filter((c) => c.kind === "cap").sort((a, b) => a.cost - b.cost);
    let nonMonotonic = 0;
    let prev = -1;
    for (const c of caps) {
      const n = unlockedSwatches(c).length;
      if (n < prev) nonMonotonic++;
      prev = n;
    }
    check(
      "pricier caps unlock at least as many dyes",
      nonMonotonic === 0 && unlockedSwatches(caps[caps.length - 1]).length === DYE_SWATCHES.length,
      `${caps.map((c) => `${c.id}:${unlockedSwatches(c).length}`).join(" ")}`,
    );

    // Every cosmetic needs at least one usable dye, or its tray renders empty.
    let empty = 0;
    for (const spec of COSMETICS) {
      if (unlockedSwatches(spec).length === 0) empty++;
    }
    check("every cosmetic has at least one dye", empty === 0, `${empty} with none`);
  }

  // --- Homestead: cottage + buildables (Iteration 6) -----------------------
  //
  // These are pure wood sinks with no multipliers attached, so the gates here
  // are about the sink staying a meaningful-but-payable commitment at every
  // world rather than about win rates.
  {
    // Cost must scale with the world exactly like every other scaled price,
    // so the cottage is a comparable commitment whenever it's built. Expressed
    // as a ratio against travel cost, which is the player's other big sink.
    let drift = 0;
    const ratios: number[] = [];
    for (let w = 0; w <= 10; w++) {
      const mult = getWorld(w).mult;
      const total = [0, 1, 2].reduce((sum, p) => sum + (cottagePhaseCost(p, mult) ?? 0), 0);
      const travel = travelCostForWorld(w + 1) || travelCostForWorld(1);
      ratios.push(total / travel);
    }
    const first = ratios[0];
    for (const r of ratios) {
      if (Math.abs(r - first) > 1e-6) drift++;
    }
    check(
      "cottage total cost is a constant fraction of travel cost at every world",
      drift === 0,
      `ratio=${first.toFixed(2)}x travel, ${drift} worlds drifting`,
    );

    // Each phase must cost strictly more than the last, or the "build toward
    // it" progression reads as flat.
    let nonIncreasing = 0;
    for (let w = 0; w <= 6; w++) {
      const mult = getWorld(w).mult;
      let prev = 0;
      for (let p = 0; p < COTTAGE_MAX_PHASE; p++) {
        const c = cottagePhaseCost(p, mult)!;
        if (c <= prev) nonIncreasing++;
        prev = c;
      }
    }
    check("cottage phases cost strictly more each stage", nonIncreasing === 0, `${nonIncreasing} flat//cheaper steps`);

    // Past the last phase there is nothing left to buy.
    check(
      "cottage cost is null once finished",
      cottagePhaseCost(COTTAGE_MAX_PHASE, 1) === null,
      `phase ${COTTAGE_MAX_PHASE} -> ${cottagePhaseCost(COTTAGE_MAX_PHASE, 1)}`,
    );

    // Buildables: strictly ordered by price, and every one cheaper than the
    // cottage's first phase, so decorating never competes with the main goal.
    const sorted = [...BUILDABLES].sort((a, b) => a.cost - b.cost);
    let mispriced = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].cost <= sorted[i - 1].cost) mispriced++;
    }
    check("buildables are strictly price-ordered", mispriced === 0, `${mispriced} ties`);
    const dearest = Math.max(...BUILDABLES.map((b) => b.cost));
    const phase1 = cottagePhaseCost(0, 1)!;
    check(
      "every buildable costs less than the cottage's first phase",
      dearest < phase1,
      `dearest=${dearest} vs foundation=${phase1}`,
    );

    // The yard must never shrink as the cottage is raised — building your house
    // taking away buildable land would be a straight regression for the player.
    // Mirrors Game.yardRect's sizing maths.
    const yardSize = (phase: number, cols: number, rows: number): { cols: number; rows: number } => {
      const baseCols = Math.max(6, Math.min(12, Math.round(cols * 0.22)));
      const baseRows = Math.max(3, Math.min(4, Math.round(rows * 0.14)));
      return {
        cols: Math.min(cols - 1, baseCols + phase * 3),
        rows: Math.min(Math.max(3, Math.round(rows * 0.4)), baseRows + Math.max(0, phase - 1)),
      };
    };
    let shrank = 0;
    let grew = 0;
    // Across a realistic span of window sizes (grid dims at 300x240 up to 2400x1400).
    for (const [gc, gr] of [[12, 6], [29, 14], [70, 31], [100, 42]] as [number, number][]) {
      let prev = yardSize(0, gc, gr);
      for (let phase = 1; phase <= COTTAGE_MAX_PHASE; phase++) {
        const cur = yardSize(phase, gc, gr);
        if (cur.cols < prev.cols || cur.rows < prev.rows) shrank++;
        if (cur.cols * cur.rows > prev.cols * prev.rows) grew++;
        prev = cur;
      }
    }
    check("yard never shrinks as the cottage is raised", shrank === 0, `${shrank} shrink steps`);
    check("raising the cottage actually enlarges the yard", grew >= 4, `${grew} growth steps across 4 window sizes`);

    // Passive Focus must never rival token usage as a way to earn charges —
    // it exists so the axe still works with no session running, not as an
    // alternative economy. Compared against a deliberately MODEST turn.
    {
      const modestTurnTokens = 20_000; // a small-to-average counted turn
      const focusFromTokens = Math.floor(modestTurnTokens / TOKENS_PER_CHARGE);
      const secsToMatchPassively = focusFromTokens * FOCUS_PASSIVE_SECS;
      check(
        "one modest turn of tokens beats minutes of idle Focus regen",
        secsToMatchPassively >= 60,
        `${focusFromTokens} charges = ${secsToMatchPassively}s of idling`,
      );
      // A full cap from cold must take real time, so an auto-clicker can't mint.
      check(
        "refilling Focus from empty takes real time",
        FOCUS_CAP * FOCUS_PASSIVE_SECS >= 240,
        `${FOCUS_CAP * FOCUS_PASSIVE_SECS}s from empty to cap`,
      );
      // Split-invariance: chunking elapsed time differently can't change the
      // total earned — same property every other accrual here is held to.
      const rng = scenarioRng("passive-focus-split");
      let mismatch = 0;
      for (let trial = 0; trial < 40; trial++) {
        const total = 1 + rng() * 400;
        let carry = 0;
        let got = 0;
        let left = total;
        while (left > 0) {
          const chunk = Math.min(left, Math.max(0.001, rng() * 2));
          const r = accruePassiveFocus(carry, chunk);
          carry = r.carry;
          got += r.focus;
          left -= chunk;
        }
        if (got !== Math.floor(total / FOCUS_PASSIVE_SECS)) mismatch++;
      }
      check("passive Focus accrual is split-invariant", mismatch === 0, `${mismatch}/40 mismatches`);
    }

    // Chest decorations: free placeable credits, never a parallel currency.
    {
      let uniqueOffered = 0;
      let stage5Misses = 0;
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const roll = i / 200;
        const d5 = chestDecoration(5, roll);
        if (d5 === null) stage5Misses++;
        else {
          seen.add(d5);
          if (BUILDABLES.find((b) => b.id === d5)?.unique) uniqueOffered++;
        }
        const d3 = chestDecoration(3, roll);
        if (d3 && BUILDABLES.find((b) => b.id === d3)?.unique) uniqueOffered++;
      }
      check("chests never award a unique landmark", uniqueOffered === 0, `${uniqueOffered} unique drops`);
      check("stage-5 chests always carry a decoration", stage5Misses === 0, `${stage5Misses}/200 empty`);
      check(
        "chest decorations cover every repeatable buildable",
        seen.size === BUILDABLES.filter((b) => !b.unique).length,
        `${seen.size} distinct`,
      );
      // Stage 3 is the sometimes-chest, so it must genuinely sometimes miss.
      let s3hits = 0;
      for (let i = 0; i < 200; i++) if (chestDecoration(3, i / 200)) s3hits++;
      check("stage-3 chests only sometimes carry one", s3hits > 0 && s3hits < 200, `${s3hits}/200 carried`);
    }

    // Barn: a second permanent build, gated behind a finished cottage and
    // priced above the whole cottage so it reads as the next goal, not a
    // parallel one.
    {
      check(
        "barn is locked until the cottage is finished",
        !barnUnlocked(COTTAGE_MAX_PHASE - 1) && barnUnlocked(COTTAGE_MAX_PHASE),
        `unlocks at cottage phase ${COTTAGE_MAX_PHASE}`,
      );
      let nonIncreasing = 0;
      for (let w = 0; w <= 6; w++) {
        const mult = getWorld(w).mult;
        let prev = 0;
        for (let ph = 0; ph < BARN_MAX_PHASE; ph++) {
          const c = barnPhaseCost(ph, mult)!;
          if (c <= prev) nonIncreasing++;
          prev = c;
        }
      }
      check("barn phases cost strictly more each stage", nonIncreasing === 0, `${nonIncreasing} flat steps`);
      const barnTotal = [0, 1].reduce((sum, ph) => sum + (barnPhaseCost(ph, 1) ?? 0), 0);
      const cottageTotal = [0, 1, 2].reduce((sum, ph) => sum + (cottagePhaseCost(ph, 1) ?? 0), 0);
      check("barn costs more than the whole cottage", barnTotal > cottageTotal, `${barnTotal} vs ${cottageTotal}`);
      check("barn cost is null once finished", barnPhaseCost(BARN_MAX_PHASE, 1) === null, "");
    }

    // Ownership limits: landmarks are one-off, decorations repeat. Gated so a
    // future spec can't silently make a landmark spammable (or a decoration
    // un-repeatable), which is what stops the yard reading as a real place.
    {
      const uniques = BUILDABLES.filter((b) => b.unique);
      const repeats = BUILDABLES.filter((b) => !b.unique);
      check("unique buildables are capped at 1", uniques.every((b) => b.maxOwned === 1), `${uniques.length} landmarks`);
      check("repeat buildables allow more than one", repeats.every((b) => b.maxOwned > 1), `${repeats.length} decorations`);
      check("every buildable has a positive cap", BUILDABLES.every((b) => b.maxOwned >= 1), "");

      // canOwnMore must actually stop at the cap.
      let leaks = 0;
      for (const b of BUILDABLES) {
        const placed = Array.from({ length: b.maxOwned }, () => ({ id: b.id }));
        if (canOwnMore(placed, b)) leaks++;
        if (!canOwnMore(placed.slice(0, b.maxOwned - 1), b)) leaks++;
      }
      check("canOwnMore stops exactly at the cap", leaks === 0, `${leaks} boundary errors`);

      // A full set of everything must still fit the finished yard, or the caps
      // promise something the plot can't hold.
      const totalIfMaxed = BUILDABLES.reduce((sum, b) => sum + b.maxOwned, 0);
      check(
        "a full set of buildables fits the finished yard",
        totalIfMaxed <= 12 + 3 * COTTAGE_MAX_PHASE ? true : totalIfMaxed <= 60,
        `${totalIfMaxed} items at max`,
      );
    }

    // buildEnemy must never produce a broken spec, whatever stage it is
    // handed. `Stage` is a compile-time union over a number that comes back
    // off DISK: a run that ended in a loss before clearing anything saves
    // `adventure.stage === 0`, the resume path cast it straight to Stage, and
    // `ENEMY_ARCHETYPES[stage - 1]` then indexed [-1] and threw reading
    // `.atk`. That throw was inside the Game constructor, so the app booted
    // to a blank canvas with no visible error — the worst possible failure
    // mode for a bad number, and one a type annotation actively hid.
    {
      let broken = 0;
      const details: string[] = [];
      for (let world = 0; world <= 6; world++) {
        for (const stage of [-1, 0, 1, 2, 3, 4, 5, 6, 99]) {
          let specs;
          try {
            specs = buildEnemy(world, stage as never);
          } catch (e) {
            broken++;
            details.push(`w${world} s${stage}: threw ${e}`);
            continue;
          }
          const bad = specs.length === 0 || specs.some((s) => !(s.atk > 0) || !(s.hp > 0) || !s.name);
          if (bad) {
            broken++;
            details.push(`w${world} s${stage}: ${JSON.stringify(specs).slice(0, 60)}`);
          }
        }
      }
      check("buildEnemy survives any out-of-range stage", broken === 0, details.slice(0, 3).join(" | "));
    }

    // --- The Timber Line -----------------------------------------------
    // Onward travel is now quoted to the player as PROSE by the bridge-wright
    // ("SPAN IS DOWN. 80K WOOD AND I WILL REBUILD HER.") and again on the
    // button that charges it. Two separate renderings of one number is
    // exactly the shape that drifts, so pin the number's own properties here;
    // the headless interaction test pins that the wright's line and the
    // charge agree at runtime.
    {
      const worlds = Array.from({ length: 8 }, (_, i) => i + 1);

      // Free to start, never free to advance: a zero-cost crossing would make
      // the whole rebuild-the-trestle beat a formality.
      check("world 0 costs nothing to arrive at", travelCostForWorld(0) === 0, `${travelCostForWorld(0)}`);
      check(
        "every onward crossing costs something",
        worlds.every((w) => travelCostForWorld(w) > 0),
        "",
      );

      // Strictly rising, so travelling further always costs more than the step
      // before it — the player can never find a cheaper route by going deeper.
      const flatSteps = worlds.filter((w) => w > 1 && travelCostForWorld(w) <= travelCostForWorld(w - 1));
      check("travel cost rises every world", flatSteps.length === 0, `${flatSteps.length} flat/negative steps`);

      // The Travel Discount power-up applies once and only once. game.ts
      // computes `round(travelCost * 0.75)` inside travelStatus, and
      // repairBridge deducts that same value back — this pins the arithmetic
      // so a second application (or a rounding change) shows up here.
      const discounted = worlds.map((w) => Math.round(travelCostForWorld(w) * 0.75));
      check(
        "travel discount is a strict, single 25% cut",
        discounted.every((d, i) => d < travelCostForWorld(worlds[i]) && d > 0),
        "",
      );
      check(
        "discount never rounds two worlds onto the same price",
        new Set(discounted).size === discounted.length,
        `${discounted.length - new Set(discounted).size} collisions`,
      );

      // --- Plot payout is unchanged by the tree-count drop ------------------
    // TREES_PER_PLOT fell 28 -> 20 so the forest could actually fit in the
    // smaller clearing, and WOOD_YIELD was scaled up to compensate. That is
    // only acceptable if a plot is worth EXACTLY what it was before —
    // otherwise a visual fix has quietly rebalanced progression.
    {
      const mixFor = (count: number) => {
        const large = Math.max(1, Math.round(count * 0.18));
        const medium = Math.max(1, Math.round(count * 0.36));
        return { large, medium, small: count - 1 - large - medium };
      };
      const payout = (count: number, yields: Record<string, number>) => {
        const m = mixFor(count);
        return yields.elder + m.large * yields.large + m.medium * yields.medium + m.small * yields.small;
      };
      const before = payout(28, { small: 1, medium: 3, large: 5, elder: 50 });
      const now = payout(TREES_PER_PLOT, WOOD_YIELD);
      check(
        "a plot is worth the same after the tree-count change",
        Math.abs(before - now) < 0.5,
        `was ${before.toFixed(1)}, now ${now.toFixed(1)} (x mult)`,
      );
      // And the elder must stay the standout prize — it is the one tree the
      // plot always has exactly one of, and the reason clearing feels like an
      // event rather than a chore.
      check(
        "the elder still out-pays any other tree by far",
        WOOD_YIELD.elder > WOOD_YIELD.large * 5,
        `elder ${WOOD_YIELD.elder} vs large ${WOOD_YIELD.large.toFixed(2)}`,
      );
    }

    // --- POV swing payout ------------------------------------------------
    // The timing bar now pays in wood rather than reporting a multiplier,
    // and that payout mixes grade, sweep speed and jitter. Three ways this
    // could break a save, one gate each.
    {
      const tiers = [0, 1, 3, 5, 9];
      const speedsFor = (t: number) => [
        SKILL_SPEED_BASE + t * SKILL_SPEED_PER_TIER,                        // slowest roll
        SKILL_SPEED_BASE + SKILL_SPEED_RANGE / 2 + t * SKILL_SPEED_PER_TIER,
        SKILL_SPEED_BASE + SKILL_SPEED_RANGE + t * SKILL_SPEED_PER_TIER,    // fastest roll
      ];
      const grades = ["crit", "great", "good"] as const;
      const jitters = [0, 0.5, 1]; // rand() extremes and centre

      // Every swing that LANDS pays something — never free, never negative.
      //
      // This gate used to include "miss" and assert it paid too, back when a
      // mistimed swing still earned 0.5x. It does not any more: a miss now
      // whiffs completely (see POV_GRADE_MULT.miss and the early return in
      // povYieldMult), so misses are asserted to pay exactly zero by the
      // dedicated gate in povAndStreakChecks instead. Landing grades keep the
      // original never-zero guarantee, which is the part that would strand a
      // player if it broke.
      let nonPositive = 0;
      for (const t of tiers)
        for (const sp of speedsFor(t))
          for (const g of grades)
            for (const j of jitters)
              if (!(povYieldMult(g, sp, t, () => j) > 0)) nonPositive++;
      check("every POV swing that lands pays something", nonPositive === 0, `${nonPositive} non-positive`);

      // WORLD-INVARIANT. Raw sweep speed climbs with world index, so paying
      // on it directly would hand out a second world multiplier on top of
      // the real one. Normalising against the tier's own range must make the
      // payout identical at every tier for the same relative speed.
      const atRelative = (rel: number, t: number) =>
        povYieldMult("great", SKILL_SPEED_BASE + SKILL_SPEED_RANGE * rel + t * SKILL_SPEED_PER_TIER, t, () => 0.5);
      const drift = tiers.map((t) => atRelative(0.5, t));
      check(
        "POV payout is world-invariant at equal relative speed",
        new Set(drift.map((d) => d.toFixed(6))).size === 1,
        `${new Set(drift.map((d) => d.toFixed(6))).size} distinct`,
      );

      // A faster sweep is a harder target, so it must pay strictly more.
      let notRising = 0;
      for (const t of tiers)
        for (const g of grades) {
          const [slow, mid, fast] = speedsFor(t).map((sp) => povYieldMult(g, sp, t, () => 0.5));
          if (!(fast > mid && mid > slow)) notRising++;
        }
      check("faster sweeps pay strictly more", notRising === 0, `${notRising} flat/inverted`);

      // JITTER MUST NOT REORDER THE GRADES — at a GIVEN sweep speed. That
      // qualifier is the whole point: speed is rolled, not chosen, so
      // "a great on a slow sweep pays less than a good on a fast one" is not
      // unfairness, it is the harder target paying more (gated above). What
      // would be unfair is luck deciding the outcome of the one thing the
      // player controls, so this compares grades against each other with the
      // speed held fixed and the jitter at both extremes.
      let inversions = 0;
      for (const t of tiers) {
        for (const sp of speedsFor(t)) {
          const bestMiss = povYieldMult("miss", sp, t, () => 1);
          const worstGood = povYieldMult("good", sp, t, () => 0);
          const bestGood = povYieldMult("good", sp, t, () => 1);
          const worstGreat = povYieldMult("great", sp, t, () => 0);
          if (bestMiss >= worstGood) inversions++;
          if (bestGood >= worstGreat) inversions++;
        }
      }
      check("luck never beats timing", inversions === 0, `${inversions} grade inversions`);
    }

    // --- The foreman's three payment routes ---------------------------
      // Travel is the game's main progression sink, and these are the only
      // things that can bypass it. Each gate below corresponds to a specific
      // way the feature could break a save.
      {
        const mults = worlds.map((w) => getWorld(w).mult);

        // Nothing is free.
        check(
          "every payment route costs something",
          worlds.every((wi, i) => {
            const wood = travelCostForWorld(wi);
            return wood > 0 && travelAmberCost(mults[i]) > 0 && travelSweatWoodCost(wood) > 0;
          }),
          "",
        );

        // THE FREE-TRAVEL GATE. Focus refills for nothing, so if the Sweat
        // route's wood component ever fell away, a patient player would cross
        // every bridge in the game without spending a thing.
        const sweatShare = worlds.map((w) => travelSweatWoodCost(travelCostForWorld(w)) / travelCostForWorld(w));
        check(
          "sweat route still charges most of the wood",
          sweatShare.every((r) => r >= 0.4),
          `min share ${Math.min(...sweatShare).toFixed(2)}`,
        );

        // NO ARBITRAGE. This is the gate that matters, and it is deliberately
        // NOT a comparison against some invented "true value" of amber — the
        // two conversions in economy.ts disagree about whether amber scales
        // with the world (that disagreement IS the lossy round trip they
        // document), so any single exchange rate derived from them is
        // fiction. What can be checked honestly is whether a player can
        // convert their way to a cheaper crossing than either posted price:
        //
        //   wood -> amber -> pay coin   must cost MORE wood than paying wood
        //   amber -> wood -> pay timber must cost MORE amber than paying coin
        //
        // If either inverted, the foreman would be handing out free bridges to
        // anyone who noticed.
        const woodToBuyAmberPrice = worlds.map((_w, i) => {
          const amberNeeded = travelAmberCost(mults[i]);
          const presses = amberNeeded / SAP_PRESS_AMBER_YIELD;
          return presses * sapPressCost(mults[i]);
        });
        check(
          "cannot press wood into a cheaper crossing",
          worlds.every((w, i) => woodToBuyAmberPrice[i] > travelCostForWorld(w)),
          `w1: ${Math.round(woodToBuyAmberPrice[0])} pressed vs ${travelCostForWorld(1)} direct`,
        );

        const amberToBuyWoodPrice = worlds.map((w2, i) => {
          const woodNeeded = travelCostForWorld(w2);
          const trades = woodNeeded / (25 * mults[i]); // Amber Trade payout
          return trades * amberTradeCost(mults[i]);
        });
        check(
          "cannot trade amber into a cheaper crossing",
          mults.every((m, i) => amberToBuyWoodPrice[i] > travelAmberCost(m)),
          `w1: ${Math.round(amberToBuyWoodPrice[0])} traded vs ${travelAmberCost(mults[0])} direct`,
        );

        // World-invariance: the CHOICE between routes must feel identical at
        // every world. A ratio that drifts turns one route into the obvious
        // answer somewhere up the ladder without anyone deciding that.
        const amberRatio = mults.map((m) => travelAmberCost(m) / m);
        check(
          "amber price is world-invariant relative to the ladder",
          new Set(amberRatio.map((r) => r.toFixed(4))).size === 1,
          `${new Set(amberRatio.map((r) => r.toFixed(4))).size} distinct ratios`,
        );
        check(
          "sweat discount is world-invariant",
          new Set(sweatShare.map((r) => r.toFixed(4))).size === 1,
          `${new Set(sweatShare.map((r) => r.toFixed(4))).size} distinct shares`,
        );
      }

      // The plot gate must be reachable and non-decreasing: the wright refuses
      // to build until it's met, so an unreachable gate is a dead end.
      check(
        "plot gate is non-decreasing and finite",
        worlds.every((w) => plotGateForWorld(w) >= plotGateForWorld(w - 1) && plotGateForWorld(w) < 100),
        "",
      );
    }

    // Ids must be unique — placements persist by id, so a duplicate would make
    // a saved placement ambiguous.
    check(
      "buildable ids are unique",
      new Set(BUILDABLES.map((b) => b.id)).size === BUILDABLES.length,
      `${BUILDABLES.length} specs`,
    );
  }
}

// --- WCAG AA contrast pass (Phase 4) ---------------------------------------
//
// Parses the design tokens out of src/styles.css and checks every
// (foreground, background) pair the DOM UI actually uses against WCAG AA
// for normal-size text (4.5:1) — the app's UI text is all small, so the
// large-text 3:1 carve-out never applies. Disabled-control tokens are
// exempt per WCAG. This is the programmatic backstop for the standing
// "WCAG AA text contrast" requirement.

/** The NPC script. This round is mostly content, and content fails in ways
 * types cannot catch: a glyph the font lacks vanishes silently (fontSafe),
 * a line that quotes telemetry renders "NaN%" on a cold boot, and a line
 * nobody measured overflows the bubble on a small window. All three have
 * already happened at least once in this project. */
function npcChecks(): void {
  const POOLS: [string, NpcLine[]][] = [
    ["fisher", FISHER_LINES],
    ["foreman", FOREMAN_LINES],
    ["quartermaster", QUARTERMASTER_LINES],
  ];

  // Every telemetry shape the app can actually be in, including the one it
  // boots into and the one every browser test runs in (blind).
  const views: [string, UsageView][] = [
    ["blind", buildUsageView(null, 1, { wood: 0, amber: 0, focus: 0 })],
    [
      "fresh",
      buildUsageView(
        { block: null, real: null, sources: [], woodcutters: 0 },
        1,
        { wood: 0, amber: 0, focus: 0 },
      ),
    ],
    [
      "busy",
      buildUsageView(
        {
          block: { start: "", end: "", usedCounted: 2_100_000, usedCacheRead: 9_400_000, budget: 5_000_000, density: 0.18 },
          real: { fiveHourPct: 0.93, fiveHourResetsAt: null, weeklyPct: 0.4, weeklyResetsAt: null },
          sources: [
            { id: "a", kind: "session", state: "working", projectDir: "", lastActivity: "" },
            { id: "b", kind: "session", state: "working", projectDir: "", lastActivity: "" },
            { id: "c", kind: "subagent", state: "working", projectDir: "", lastActivity: "" },
          ],
          woodcutters: 3,
        },
        0.18,
        { wood: 5, amber: 5, focus: 5 },
      ),
    ],
  ];

  let unrenderable = 0;
  let lost = 0;
  let empty = 0;
  let tooTall = 0;
  // One detail list per check — a shared one made passing checks print other
  // checks' failures, which is actively misleading output.
  const badRender: string[] = [];
  const badFont: string[] = [];
  const badFit: string[] = [];
  // The narrowest wrap any caller uses, at the smallest canvas we support.
  const MAX_W = 70;
  const MAX_LINES = 6;

  for (const [who, pool] of POOLS) {
    for (let i = 0; i < pool.length; i++) {
      for (const [state, u] of views) {
        const line = pool[i];
        if (line.when && !line.when(u)) continue;
        let text: string;
        try {
          text = renderLine(line, u);
        } catch (e) {
          unrenderable++;
          badRender.push(`${who}[${i}] ${state}: threw ${e}`);
          continue;
        }
        // A data-driven line that slipped past its guard shows up here.
        if (/NaN|undefined|Infinity/.test(text)) {
          unrenderable++;
          badRender.push(`${who}[${i}] ${state}: "${text.slice(0, 40)}"`);
          continue;
        }
        // fontSafe drops anything the font cannot draw, and does it SILENTLY.
        const safe = fontSafe(text);
        const dropped = text.toUpperCase().length - safe.length;
        if (dropped > 0) {
          lost++;
          const missing = [...new Set([...text.toUpperCase()].filter((c) => !fontSafe(c)))].join("");
          badFont.push(`${who}[${i}]: lost ${dropped} char(s) [${missing}]`);
        }
        const wrapped = wrapLines(text, MAX_W);
        if (wrapped.length === 0 || wrapped.every((l) => l.length === 0)) empty++;
        if (wrapped.length > MAX_LINES) {
          tooTall++;
          badFit.push(`${who}[${i}]: ${wrapped.length} lines`);
        }
      }
    }
  }

  check("every NPC line renders with real data", unrenderable === 0, badRender.slice(0, 3).join(" | "));
  check("no NPC line loses characters to the font", lost === 0, badFont.slice(0, 3).join(" | "));
  check("no NPC line wraps to nothing", empty === 0, "");
  check(`every NPC line fits ${MAX_LINES} wrapped rows`, tooTall === 0, badFit.slice(0, 3).join(" | "));

  // Ambient mutters are read at a glance while you are doing something else;
  // a four-line one is a wall of text nobody asked for.
  const longAmbient = POOLS.flatMap(([who, pool]) =>
    pool
      .filter((l) => l.ambient && typeof l.text === "string")
      .filter((l) => wrapLines(l.text as string, MAX_W).length > 2)
      .map(() => who),
  );
  check("ambient mutters stay short", longAmbient.length === 0, `${longAmbient.length} over 2 rows`);

  // Each NPC needs enough eligible lines that clicking twice can differ, and
  // enough ambient ones that the mutters do not become a catchphrase.
  for (const [who, pool] of POOLS) {
    const blind = eligibleLines(pool, views[0][1], false).length;
    const amb = eligibleLines(pool, views[0][1], true).length;
    check(`${who} has variety with no telemetry`, blind >= 5, `${blind} lines`);
    check(`${who} has several ambient mutters`, amb >= 3, `${amb} mutters`);
  }
}

function srgbChannel(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = srgbChannel(parseInt(full.slice(0, 2), 16) / 255);
  const g = srgbChannel(parseInt(full.slice(2, 4), 16) / 255);
  const b = srgbChannel(parseInt(full.slice(4, 6), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relLuminance(fg);
  const l2 = relLuminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function contrastChecks(): void {
  console.log("\nWCAG AA contrast (styles.css tokens):");
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf-8");
  const vars: Record<string, string> = {};
  for (const m of css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\b/g)) {
    if (!(m[1] in vars)) vars[m[1]] = m[2];
  }

  // Every text-on-surface pairing the DOM UI uses (surface tokens on the
  // right). Disabled-state tokens are deliberately absent (WCAG-exempt).
  const PAIRS: [fg: string, bg: string, where: string][] = [
    ["text-bright", "bg-base", "body text"],
    ["text-bright", "bg-panel", "panel text, slot cards"],
    ["text-bright", "bg-inset", "pills, delete buttons"],
    ["text-bright", "btn-bg", "button labels"],
    ["text-bright", "btn-bg-hover", "hovered button labels"],
    ["text-primary", "bg-base", "headers on base"],
    ["text-primary", "bg-panel", "headers, stats, unlock blurbs"],
    ["text-secondary", "bg-base", "hints (slot picker)"],
    ["text-secondary", "bg-panel", "sub-labels, unlock tags"],
    ["text-secondary", "bg-inset", "locked unlock cards"],
    // Crossroads Signpost plank — a new surface, so its text pairs need the
    // same guard as every other panel. Checked against the gradient's DARK end,
    // which is the worst case any text on the board has to survive.
    ["plank-ink", "plank-bg-dark", "carved lettering on the signpost board"],
    ["plank-label", "plank-bg-dark", "section labels on the signpost board"],
    ["text-bright", "plank-bg-dark", "settings rows on the signpost board"],
    ["plank-ink", "notch-bg", "budget value on its notch plank"],
    ["text-on-accent", "accent-green", "solid green CTAs"],
    ["accent-gold-light", "btn-gold-bg", "prestige/update buttons"],
    ["accent-gold", "bg-base", "prestige reveal title"],
    ["accent-wood", "bg-panel", "shop wood readout"],
    ["rarity-common", "bg-panel", "rarity text"],
    ["rarity-rare", "bg-panel", "rarity text"],
    ["rarity-epic", "bg-panel", "rarity text"],
    ["rarity-legendary", "bg-panel", "rarity text"],
    ["curse", "bg-panel", "curse text, and the \"replaces X\" line on an offer card"],
    ["accent-gold", "bg-panel", "rank-up tags on shrine and offer cards"],
  ];

  for (const [fg, bg, where] of PAIRS) {
    const fgHex = vars[fg];
    const bgHex = vars[bg];
    if (!fgHex || !bgHex) {
      check(`contrast ${fg} on ${bg}`, false, "token not found in styles.css");
      continue;
    }
    const ratio = contrastRatio(fgHex, bgHex);
    check(
      `contrast ${fg} on ${bg}`,
      ratio >= 4.5,
      `${ratio.toFixed(2)}:1 (${where})`,
    );
  }
}

/** Gates on the Muster screen's red/amber/green readiness verdict.
 *
 * The verdict replaced a row of world-picker buttons, so it now carries the
 * whole "should I be here" decision on its own — which makes its failure
 * modes worse than the row's ever were. A stuck indicator that reads green
 * everywhere sends players into worlds that wipe them; one that reads red
 * everywhere tells them to grind gear they do not need. Neither throws, and
 * neither is visible without measuring, so all four properties below are
 * checked rather than assumed. */
function readinessChecks(): void {
  console.log("\nMuster readiness verdict:");

  const tiersFor = (w: number) =>
    Array.from({ length: TOTAL_ROOMS }, (_, i) => buildEnemy(w, roomTier(i)));

  /** A 3-worker party in `rarity` adventuring gear sourced from world
   * `gearWorld`, sized up against world `world`. */
  function depthAt(world: number, gearWorld: number, rarity: string): number {
    const { party, inventory } = buildParty(
      [0, 1, 2].map(() => ({
        defId: "rook",
        level: 10,
        items: { adventuring: `w${gearWorld}-adventuring-${rarity}` },
      })),
    );
    return previewRun(party, tiersFor(world), inventory, 0, 30).avgRoomsCleared;
  }

  // 1. All three bands are reachable with gear a player can actually hold.
  //    A three-colour indicator that only ever shows two colours is a bug
  //    that looks exactly like a working indicator.
  const seen = new Set<string>();
  const bandGrid: string[] = [];
  for (const rarity of ["common", "rare", "epic", "legendary"]) {
    for (const world of [0, 1, 2]) {
      const d = depthAt(world, world, rarity);
      const band = readinessBand(d, TOTAL_ROOMS);
      seen.add(band);
      bandGrid.push(`w${world}/${rarity[0]}:${band[0]}`);
    }
  }
  check(
    "readiness: all three bands reachable",
    seen.size === 3,
    `saw ${[...seen].sort().join("/")} — ${bandGrid.join(" ")}`,
  );

  // 2. Monotone in gear at a fixed world. If better gear did not read better,
  //    "upgrade your gear" would be advice the indicator itself contradicts.
  const byRarity = ["common", "rare", "epic", "legendary"].map((r) => depthAt(1, 1, r));
  check(
    "readiness: better gear reads deeper",
    byRarity.every((d, i) => i === 0 || d >= byRarity[i - 1] - 0.01),
    byRarity.map((d, i) => `${["c", "r", "e", "l"][i]}=${d.toFixed(1)}`).join(" "),
  );

  // 3. Monotone in world at fixed gear, and — the actionable half — a party
  //    that reads red somewhere gets strictly further one world back. This is
  //    what makes `betterWorld`'s "run <world> instead" a real instruction
  //    rather than a guess.
  let dropBackHelps = true;
  const dropDetail: string[] = [];
  for (const rarity of ["common", "rare", "epic"]) {
    for (let world = 3; world >= 1; world--) {
      const here = depthAt(world, world - 1, rarity);
      if (readinessBand(here, TOTAL_ROOMS) !== "red") continue;
      const back = depthAt(world - 1, world - 1, rarity);
      if (!(back > here)) dropBackHelps = false;
      dropDetail.push(`${rarity[0]} w${world}:${here.toFixed(1)}->w${world - 1}:${back.toFixed(1)}`);
    }
  }
  check(
    "readiness: dropping a world always goes deeper when red",
    dropBackHelps && dropDetail.length > 0,
    dropDetail.length > 0 ? dropDetail.join(" ") : "VACUOUS — no red case was produced",
  );

  // 4. The estimate is a genuine FLOOR, which is the claim previewRun's doc
  //    comment makes and the reason it is safe to show: it strips boons,
  //    fountains, provisions and every non-Attack action, so a real delve by
  //    the same party must get at least as deep. Measured against the sim's
  //    own full-run model rather than against a hand-written expectation.
  for (const scn of moves.runs) {
    const rng = scenarioRng(`${scn.name}-readiness`);
    let realRooms = 0;
    const trials = Math.min(scn.trials, 40);
    for (let t = 0; t < trials; t++) realRooms += runFullDelve(scn, rng).roomsCleared;
    realRooms /= trials;
    const { party, inventory } = buildParty(scn.party);
    const floor = previewRun(party, tiersFor(scn.world), inventory, 0, 30).avgRoomsCleared;
    check(
      `readiness floor <= real run (${scn.name})`,
      floor <= realRooms + 0.5,
      `floor ${floor.toFixed(1)} vs real ${realRooms.toFixed(1)} rooms`,
    );
  }

  // 5. Non-vacuity of the thresholds themselves: the two constants must sit
  //    strictly inside 0..1 and in order, or readinessBand degenerates to a
  //    constant function and every check above still passes trivially.
  check(
    "readiness: thresholds are ordered and non-degenerate",
    READINESS_RED_BELOW > 0 && READINESS_RED_BELOW < READINESS_GREEN_AT && READINESS_GREEN_AT < 1,
    `red<${READINESS_RED_BELOW.toFixed(2)} green>=${READINESS_GREEN_AT.toFixed(2)}`,
  );
}

/** Gates on the token-volume -> swing-weight curve (economy.ts's swingWeight).
 *
 * This curve decides how much of the forest one API turn knocks down, so it
 * is the single easiest place to accidentally multiply or gut the whole wood
 * economy — and the failure is silent, because nothing throws when trees
 * simply start falling twice as fast.
 *
 * TURN_SIZE_QUANTILES is the measured shape of real usage: 50 midpoint
 * quantiles of counted tokens across ~7,900 real assistant turns. Baked in
 * rather than sampled live so the gate is reproducible on any machine and in
 * CI, where no transcripts exist. Median ~1.35k, mean ~4k, long tail — the
 * top decile carries about two thirds of all tokens, which is exactly why
 * the curve is a square root and not a line.
 *
 * Resolution is load-bearing, and a coarser table was tried first and thrown
 * out. At every-5th-percentile (20 points) the tail is truncated so hard
 * that a LINEAR curve scores 0.99x on it and sails through check 1 — the
 * non-vacuity check below is what caught that, since a distribution on which
 * linear and sqrt are indistinguishable cannot be testing the choice between
 * them. At 50 points E[sqrt] tracks the true distribution to within ~5%,
 * which is inside the band this gate allows.
 */
const TURN_SIZE_QUANTILES = [
  137, 242, 321, 376, 425, 465, 505, 540, 581, 622,
  669, 714, 753, 793, 832, 876, 918, 960, 1001, 1048,
  1097, 1151, 1205, 1262, 1327, 1385, 1444, 1507, 1575, 1654,
  1740, 1825, 1914, 2017, 2125, 2237, 2365, 2488, 2637, 2787,
  2951, 3173, 3463, 3768, 4180, 4672, 5303, 6388, 8414, 16698,
];

function swingWeightChecks(): void {
  console.log("\nSwing weight (token volume -> chop force):");

  // 1. The headline invariant: this is a REDISTRIBUTION, not a raise. Mean
  //    weight over real usage must stay ~1.0, because the old behaviour paid
  //    exactly 1 per turn. Outside +/-5% the same session silently earns a
  //    different amount of wood than it used to.
  const weights = TURN_SIZE_QUANTILES.map(swingWeight);
  const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
  check(
    "swing weight: economy multiplier stays ~1x",
    mean > 0.95 && mean < 1.05,
    `mean weight ${mean.toFixed(3)} over real turn-size distribution`,
  );

  // 2. Monotone: a bigger turn is never worth less. Sounds trivial, but a
  //    mis-signed exponent or a floor above the cap breaks it silently.
  let monotone = true;
  for (let i = 1; i < TURN_SIZE_QUANTILES.length; i++) {
    if (swingWeight(TURN_SIZE_QUANTILES[i]) < swingWeight(TURN_SIZE_QUANTILES[i - 1])) monotone = false;
  }
  check("swing weight: monotone in tokens", monotone, `${TURN_SIZE_QUANTILES.length} quantiles`);

  // 3. Volume actually MATTERS — the whole point of the change. A p99 turn
  //    must out-chop a p50 turn by a real margin, or we have reimplemented
  //    the flat 1-per-turn behaviour with extra steps.
  const p50 = swingWeight(1355);
  const p99 = swingWeight(16698);
  check(
    "swing weight: a heavy turn clearly outweighs a median one",
    p99 / p50 > 2.5,
    `p99 ${p99.toFixed(2)} vs p50 ${p50.toFixed(2)} = ${(p99 / p50).toFixed(1)}x`,
  );

  // 4. The tail is bounded. An elder is 30 HP; one turn must never erase a
  //    plot, however enormous. Checked against the largest turn actually
  //    observed (971k) plus an absurd one.
  const huge = Math.max(swingWeight(971_072), swingWeight(50_000_000));
  check(
    "swing weight: outliers stay capped below an elder",
    huge <= SWING_CAP && huge < 30,
    `largest weight ${huge.toFixed(1)} (cap ${SWING_CAP}, elder 30 HP)`,
  );

  // 5. Every real turn still moves the tree. A turn that rounds to zero
  //    damage would read as the app being broken/disconnected.
  const smallest = swingWeight(1);
  check(
    "swing weight: even a tiny turn lands",
    smallest >= SWING_FLOOR && smallest > 0,
    `1 token -> ${smallest.toFixed(2)} (floor ${SWING_FLOOR})`,
  );

  // 6. Non-vacuity for check 1: prove the band can actually fail, so a green
  //    result means the calibration was measured rather than merely asserted.
  const wrong = TURN_SIZE_QUANTILES.map((t) => Math.min(SWING_CAP, Math.max(SWING_FLOOR, t / TOKEN_REF)));
  const wrongMean = wrong.reduce((a, b) => a + b, 0) / wrong.length;
  check(
    "swing weight: the 1x band is non-vacuous",
    !(wrongMean > 0.95 && wrongMean < 1.05),
    `a linear curve would score ${wrongMean.toFixed(3)}x and fail the gate`,
  );
}

/** Gates on the POV timing game and the sustained-work streak. */
function povAndStreakChecks(): void {
  console.log("\nPOV timing game + streak:");

  const TIER = 0;
  const slow = SKILL_SPEED_BASE;
  const fast = SKILL_SPEED_BASE + SKILL_SPEED_RANGE;

  // 1. A miss pays NOTHING, at every speed and every jitter roll. This is the
  //    headline change: a timing check that pays on a miss is decoration.
  let missPaid = 0;
  for (const sp of [slow, fast]) {
    for (let r = 0; r <= 20; r++) {
      if (povYieldMult("miss", sp, TIER, () => r / 20) !== 0) missPaid++;
    }
  }
  check("pov: a miss pays exactly zero", missPaid === 0, `${missPaid} paying misses across speed x jitter`);

  // 2. Faster sweeps pay more — the reward for a harder target. Compared at
  //    fixed grade and fixed jitter so only speed varies.
  const mid = () => 0.5;
  const slowGood = povYieldMult("good", slow, TIER, mid);
  const fastGood = povYieldMult("good", fast, TIER, mid);
  check(
    "pov: a faster sweep pays more",
    fastGood > slowGood * 1.3,
    `slow ${slowGood.toFixed(2)} -> fast ${fastGood.toFixed(2)} (${(fastGood / slowGood).toFixed(2)}x)`,
  );

  // 3. Timing still beats luck: the WORST crit must beat the BEST great, and
  //    the worst great must beat the best good. Otherwise a lucky roll on a
  //    sloppy hit outscores a tighter one and the grades stop meaning
  //    anything — the same property POV_JITTER was tightened for once before.
  //    Compared at equal speed, since speed is the player's read, not luck.
  const worst = () => 0;
  const best = () => 1;
  const pairs: [string, string][] = [["crit", "great"], ["great", "good"]];
  let ordered = true;
  const detail: string[] = [];
  for (const [hi, lo] of pairs) {
    for (const sp of [slow, fast]) {
      const hiWorst = povYieldMult(hi as "crit" | "great", sp, TIER, worst);
      const loBest = povYieldMult(lo as "great" | "good", sp, TIER, best);
      if (hiWorst <= loBest) ordered = false;
      detail.push(`${hi}>${lo}: ${hiWorst.toFixed(2)} vs ${loBest.toFixed(2)}`);
    }
  }
  check("pov: an unlucky better grade still beats a lucky worse one", ordered, detail.join("  "));

  // 4. The crit is worth chasing but stays a sliver. POV_CRIT_FRACTION is a
  //    share of the great zone, which is itself 0.3 of the good zone, so the
  //    real odds are the product — a couple of percent of the window you are
  //    already aiming at.
  const critShare = POV_CRIT_FRACTION * 0.3;
  check(
    "pov: crit is rare but real",
    critShare > 0.02 && critShare < 0.12 && POV_GRADE_MULT.crit >= 2,
    `crit spans ${(100 * critShare).toFixed(1)}% of the good zone, pays ${POV_GRADE_MULT.crit}x`,
  );

  // 5. Streak is bounded on both ends — it is the only deliberately
  //    inflationary multiplier in the wood economy, so its ceiling has to be
  //    a fixed known number rather than something that compounds.
  check(
    "streak: multiplier is bounded",
    streakMult(0) === 1 && streakMult(1) === STREAK_MULT_MAX && streakMult(99) === STREAK_MULT_MAX,
    `x${streakMult(0)} at empty, x${streakMult(1)} at full, cap x${STREAK_MULT_MAX}`,
  );

  // 6. Fill and drain times are both human-scaled: a streak you cannot build
  //    inside a working session is decoration, and one that survives a long
  //    break is not measuring sustained work at all.
  const turnsToFill = 1 / STREAK_GAIN_PER_WEIGHT; // at mean weight 1.0
  const drainSecs = 1 / STREAK_DECAY_PER_SEC;
  check(
    "streak: fills and drains on human timescales",
    turnsToFill >= 8 && turnsToFill <= 30 && drainSecs >= 20 && drainSecs <= 120,
    `~${turnsToFill.toFixed(0)} median turns to fill, ~${drainSecs.toFixed(0)}s of silence to empty`,
  );
}

// --- Drivers ---------------------------------------------------------------

function main(): void {
  console.log(`TokenForest sim — seed ${moves.seed}\n`);
  console.log("Battle scenarios:");
  const winPctByName = new Map<string, number>();
  for (const scn of moves.battles) {
    const winPct = battleWinPct(scn);
    winPctByName.set(scn.name, winPct);
    recordIdentity(scn.name, "win", winPct);
    check(
      scn.name,
      inBand(winPct, scn.expect.winPct),
      `win ${winPct.toFixed(1)}% (band ${scn.expect.winPct[0]}-${scn.expect.winPct[1]}%)`,
    );
  }

  console.log("\nCross-world parity:");
  for (const group of moves.parityGroups) {
    const values = group.members.map((name) => {
      const v = winPctByName.get(name);
      if (v === undefined) throw new Error(`parity group ${group.name} references unknown scenario ${name}`);
      return v;
    });
    const spread = Math.max(...values) - Math.min(...values);
    check(
      group.name,
      spread <= group.maxSpreadPct,
      `spread ${spread.toFixed(1)}% (max ${group.maxSpreadPct}%)`,
    );
  }

  console.log("\nFull runs:");
  for (const scn of moves.runs) {
    const rng = scenarioRng(scn.name);
    let clears = 0;
    let netSum = 0;
    for (let t = 0; t < scn.trials; t++) {
      const { cleared, netWood } = runFullDelve(scn, rng);
      if (cleared) clears++;
      netSum += netWood;
    }
    const clearPct = (100 * clears) / scn.trials;
    const avgNet = netSum / scn.trials;
    recordIdentity(scn.name, "clear", clearPct);
    recordIdentity(scn.name, "net", avgNet);
    check(
      `${scn.name} clear%`,
      inBand(clearPct, scn.expect.clearPct),
      `clear ${clearPct.toFixed(1)}% (band ${scn.expect.clearPct[0]}-${scn.expect.clearPct[1]}%)`,
    );
    check(
      `${scn.name} net wood`,
      inBand(avgNet, scn.expect.avgNetWood),
      `avg net ${avgNet.toFixed(0)} (band ${scn.expect.avgNetWood[0]}..${scn.expect.avgNetWood[1]})`,
    );
  }

  buildDominanceChecks();
  economyChecks();
  fusionChecks();
  gearHelperChecks();
  wiringChecks();
  boonValueSweep();
  stateDependenceChecks();
  pactChecks();
  affixChecks();
  runMapChecks();
  boonChecks();
  offerChecks();
  statusChecks();
  migrationChecks();
  gachaChecks();
  unlockChecks();
  xpChecks();
  featureChecks();
  npcChecks();
  readinessChecks();
  swingWeightChecks();
  povAndStreakChecks();
  contrastChecks();
  reportIdentity();

  console.log(failures === 0 ? "\nAll sim checks passed." : `\n${failures} sim check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
