// Pure gacha pull resolvers — operate on GameSave, no DOM/canvas deps.

import {
  itemDefsForWorld,
  ITEM_PITY_THRESHOLD,
  POWERUP_PITY_THRESHOLD,
  POWERUPS,
  RARITY_ORDER,
  RARITY_WEIGHTS,
  SHARD_VALUE,
  WORKER_DEFS,
  WORKER_PITY_THRESHOLD,
  type ItemDef,
  type PowerupSpec,
  type Rarity,
  type WorkerDef,
} from "./economy";
import type { GameSave } from "./game-state";
import { createMember, type ItemInstance } from "./team";
import { isUnlocked } from "./unlocks";

function floorIndex(floor: Rarity): number {
  return RARITY_ORDER.indexOf(floor);
}

function meetsFloor(rarity: Rarity, floor: Rarity): boolean {
  return RARITY_ORDER.indexOf(rarity) >= floorIndex(floor);
}

/** Weighted rarity roll; once `pity` reaches `pityAt` the roll is forced to
 * be at least `floor` rarity (weights renormalized among floor..legendary). */
function rollRarity(
  rng: () => number,
  pity: number,
  pityAt: number,
  floor: Rarity,
): { rarity: Rarity; pityUsed: boolean } {
  const forced = pity + 1 >= pityAt;
  const idx = floorIndex(floor);
  const weights: Record<Rarity, number> = forced
    ? (Object.fromEntries(
        RARITY_ORDER.map((r, i) => [r, i >= idx ? RARITY_WEIGHTS[r] : 0]),
      ) as Record<Rarity, number>)
    : RARITY_WEIGHTS;
  const total = RARITY_ORDER.reduce((sum, r) => sum + weights[r], 0);
  let roll = rng() * total;
  for (const r of RARITY_ORDER) {
    roll -= weights[r];
    if (roll <= 0) return { rarity: r, pityUsed: forced };
  }
  return { rarity: RARITY_ORDER[RARITY_ORDER.length - 1], pityUsed: forced };
}

export interface WorkerPullResult {
  def: WorkerDef;
  isNew: boolean;
  memberId?: string;
  shardsGained?: number;
}

export function pullWorker(save: GameSave, rng: () => number = Math.random): WorkerPullResult {
  const { rarity, pityUsed } = rollRarity(rng, save.pity.worker, WORKER_PITY_THRESHOLD, "rare");
  save.pity.worker = pityUsed || meetsFloor(rarity, "rare") ? 0 : save.pity.worker + 1;

  // Prestige-gated workers (see unlocks.ts) only join their rarity's pool
  // once unlocked. This filters WITHIN the already-rolled rarity, after the
  // pity update above — locked content can never shift rarity odds or pity
  // math (the sim asserts the rarity sequence is prestige-invariant).
  const pool = WORKER_DEFS.filter(
    (w) => w.rarity === rarity && isUnlocked("worker", w.id, save.prestigeLevel),
  );
  const def = pool[Math.floor(rng() * pool.length)] ?? pool[0];
  const owned = save.team.some((m) => m.defId === def.id);
  if (owned) {
    const shards = SHARD_VALUE[rarity];
    save.shards[rarity] += shards;
    return { def, isNew: false, shardsGained: shards };
  }
  const member = createMember(def.id, save.nextMemberSeq++, save.prestigeLevel);
  save.team.push(member);
  return { def, isNew: true, memberId: member.id };
}

export interface ItemPullResult {
  def: ItemDef;
  instanceId: string;
}

export function pullItem(
  save: GameSave,
  world: number,
  rng: () => number = Math.random,
): ItemPullResult {
  const pity = save.pity.item[world] ?? 0;
  const { rarity, pityUsed } = rollRarity(rng, pity, ITEM_PITY_THRESHOLD, "epic");
  save.pity.item[world] = pityUsed || meetsFloor(rarity, "epic") ? 0 : pity + 1;

  const pool = itemDefsForWorld(world).filter((d) => d.rarity === rarity);
  const def = pool[Math.floor(rng() * pool.length)] ?? pool[0];
  const inst: ItemInstance = { id: `i-${save.nextItemSeq++}`, defId: def.defId };
  save.inventory.push(inst);
  return { def, instanceId: inst.id };
}

export interface PowerupPullResult {
  spec: PowerupSpec;
  isNew: boolean;
  shardsGained?: number;
}

export function pullPowerup(save: GameSave, rng: () => number = Math.random): PowerupPullResult {
  const { rarity, pityUsed } = rollRarity(rng, save.pity.powerup, POWERUP_PITY_THRESHOLD, "epic");
  save.pity.powerup = pityUsed || meetsFloor(rarity, "epic") ? 0 : save.pity.powerup + 1;

  // Same prestige-gate-within-rarity treatment as pullWorker above.
  const pool = POWERUPS.filter(
    (p) => p.rarity === rarity && isUnlocked("powerup", p.id, save.prestigeLevel),
  );
  const spec = pool[Math.floor(rng() * pool.length)] ?? pool[0];
  const owned = (save.powerups as string[]).includes(spec.id);
  if (owned) {
    const shards = SHARD_VALUE[rarity];
    save.shards[rarity] += shards;
    return { spec, isNew: false, shardsGained: shards };
  }
  save.powerups.push(spec.id);
  if (spec.id === "luckyCharm") {
    // Lucky Charm's own blurb ("-2 pulls to all pity counters") reads as an
    // instant, one-time nudge — unlike every other Power-up here, it's not
    // an ongoing passive, so it's applied once, right here, the moment it's
    // newly obtained (never on a duplicate pull, handled above).
    save.pity.worker = Math.max(0, save.pity.worker - 2);
    save.pity.powerup = Math.max(0, save.pity.powerup - 2);
    for (let w = 0; w < save.pity.item.length; w++) {
      save.pity.item[w] = Math.max(0, (save.pity.item[w] ?? 0) - 2);
    }
  }
  return { spec, isNew: true };
}
