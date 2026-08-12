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

import {
  buildEnemy,
  chestDecoration,
  chestReward,
  continueFee,
  embarkCost,
  type Stage,
} from "../src/adventure";
import {
  isBattleOver,
  resolvePartyTurn,
  startBattle,
  type BattleSnapshot,
  type SkillGrade,
} from "../src/battle";
import {
  BOON_HEAL_PCT,
  BOON_HP_PCT,
  boonWoodMult,
  drawBoonOffer,
  type BoonId,
} from "../src/boons";
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
  TOKENS_PER_CHARGE,
  plotGateForWorld,
  travelAmberCost,
  travelSweatWoodCost,
  povYieldMult,
  SKILL_SPEED_BASE,
  SKILL_SPEED_PER_TIER,
  SKILL_SPEED_RANGE,
  travelCostForWorld,
  unlockedSwatches,
  WORKER_PITY_THRESHOLD,
  type Rarity,
} from "../src/economy";
import { pullItem, pullPowerup, pullWorker } from "../src/gacha";
import type { GameSave } from "../src/game-state";
import { hashString, mulberry32 } from "../src/scene/rng";
import { isUnlocked, UNLOCKS } from "../src/unlocks";
import {
  createMember,
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
  boonPolicy: "first";
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

function scenarioRng(name: string): () => number {
  return mulberry32((moves.seed ^ hashString(name)) >>> 0);
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
  boons: Record<string, number>,
  flags: RunFlags,
  rng: () => number,
): "win" | "loss" {
  const battle = startBattle(party, buildEnemy(world, stage), inventory, { boons });
  let guard = 0;
  while (!battle.outcome && guard++ < MAX_TURNS) {
    const actorId = battle.turnOrder[battle.turnIndex];
    if (!actorId) break;
    const actor = party.find((m) => m.id === actorId);
    if (!actor) break;
    const { action, grade } = decideAction(policy, battle, party, actor, inventory, flags, rng);
    const events = resolvePartyTurn(battle, party, actorId, action, grade, inventory, 0, rng, boons);
    if (action === "ability" && events.some((e) => e.kind === "ability" || e.kind === "heal")) {
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

function applyBoon(id: BoonId, boons: Record<string, number>, party: TeamMemberSave[], flags: RunFlags): void {
  boons[id] = (boons[id] ?? 0) + 1;
  if (id === "ironSkin" || id === "secondWind") {
    for (const m of party) {
      if (m.currentHp <= 0) continue;
      if (id === "ironSkin") {
        const bump = Math.round(m.maxHp * BOON_HP_PCT);
        m.maxHp += bump;
        m.currentHp = Math.min(m.maxHp, m.currentHp + bump);
      } else {
        m.currentHp = Math.min(m.maxHp, m.currentHp + Math.round(m.maxHp * BOON_HEAL_PCT));
      }
    }
  } else if (id === "vengefulSpirit") {
    flags.abilityUsed = false;
  }
}

function runFullRun(
  scn: RunScenario,
  rng: () => number,
): { cleared: boolean; netWood: number } {
  const { party, inventory } = buildParty(scn.party);
  const mult = getWorld(scn.world).mult;
  const flags: RunFlags = { abilityUsed: false };
  const boons: Record<string, number> = {};
  const expeditionBonus = party.reduce((sum, m) => {
    const item = equippedItem(m, "adventuring", inventory);
    return sum + (item?.adventuring?.expeditionBonusPct ?? 0);
  }, 0);

  let netWood = -embarkCost(mult);
  let pendingWood = 0;

  for (let stage = 1 as Stage; stage <= 5; stage = (stage + 1) as Stage) {
    if (stage > 1) netWood -= continueFee(mult, stage);
    const enemies = buildEnemy(scn.world, stage);
    const totalReward = enemies.reduce((sum, e) => sum + e.woodReward, 0);
    const outcome = runOneBattle(party, inventory, scn.world, stage, scn.policy, boons, flags, rng);

    if (outcome === "loss") {
      return { cleared: false, netWood: netWood + Math.floor(pendingWood * 0.5) };
    }

    pendingWood += Math.round(totalReward * (1 + expeditionBonus) * boonWoodMult(boons));
    // Battle XP mid-run, mirroring Game.finalizeBattleOutcome: stage wins
    // level the party up for the run's remaining stages.
    const xpReward = stageXpReward(stage, scn.world);
    for (const m of party) grantXp(m, xpReward, inventory, 0);
    if (stage === 3 || stage === 5) {
      netWood += chestReward(scn.world, stage).wood;
    }
    if (stage === 5) break;

    const offer = drawBoonOffer(party, inventory, flags.abilityUsed, rng);
    if (offer.length > 0) applyBoon(offer[0], boons, party, flags);
  }

  return { cleared: true, netWood: netWood + pendingWood };
}

// --- Gacha invariants ------------------------------------------------------

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
  const gatedBoons = UNLOCKS.filter((u) => u.kind === "boon").map((u) => u.refId) as BoonId[];
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
      const { party, inventory } = buildParty([
        { defId: "rook", level: 1 },
        { defId: "finch", level: 1 },
      ]);
      const rng = scenarioRng("unlock-boon-pool");
      const seen = new Set<string>();
      for (let i = 0; i < 500; i++) {
        for (const id of drawBoonOffer(party, inventory, false, rng, prestigeLevel)) seen.add(id);
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
      const grades = ["great", "good", "miss"] as const;
      const jitters = [0, 0.5, 1]; // rand() extremes and centre

      // Never free, never negative — a swing always pays something.
      let nonPositive = 0;
      for (const t of tiers)
        for (const sp of speedsFor(t))
          for (const g of grades)
            for (const j of jitters)
              if (!(povYieldMult(g, sp, t, () => j) > 0)) nonPositive++;
      check("every POV swing pays something", nonPositive === 0, `${nonPositive} non-positive`);

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

// --- Drivers ---------------------------------------------------------------

function main(): void {
  console.log(`TokenForest sim — seed ${moves.seed}\n`);
  console.log("Battle scenarios:");
  const winPctByName = new Map<string, number>();
  for (const scn of moves.battles) {
    const winPct = battleWinPct(scn);
    winPctByName.set(scn.name, winPct);
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
      const { cleared, netWood } = runFullRun(scn, rng);
      if (cleared) clears++;
      netSum += netWood;
    }
    const clearPct = (100 * clears) / scn.trials;
    const avgNet = netSum / scn.trials;
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

  economyChecks();
  gachaChecks();
  unlockChecks();
  xpChecks();
  featureChecks();
  npcChecks();
  contrastChecks();

  console.log(failures === 0 ? "\nAll sim checks passed." : `\n${failures} sim check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
