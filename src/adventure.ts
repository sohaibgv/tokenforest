// Enemy roster + stage/cost economy for Adventure mode — no DOM/canvas
// deps. The actual turn-based fight (per-hit damage, Defend/Ability
// resolution) lives in src/battle.ts; this file is what enters a stage's
// fight, not what happens inside it. Progress is entirely explicit-action-
// driven (see Game.startAdventure/beginStageBattle), never a wall-clock tick.

import {
  ADVENTURE_CONTINUE_BASE,
  ADVENTURE_EMBARK_BASE,
  ADVENTURE_REVIVE_BASE_COST,
  BUILDABLES,
  type BuildableId,
  getWorld,
  type Rarity,
} from "./economy";

export type Stage = 1 | 2 | 3 | 4 | 5;
export type EnemyKind = "protestor" | "scientist" | "mayor";

/** Scientist-only recurring special move — triggers every Nth turn the
 * enemy acts, hits one random living member for dmgMult× normal ATK
 * (bypassing the round-robin spread normal attacks use), with a chance to
 * skip that member's next turn. Consumed by the battle engine (Part A). */
export interface EnemySpecialAbility {
  id: "glitchPulse";
  everyNth: number;
  dmgMult: number;
  skipChance: number;
}

export interface EnemySpec {
  name: string;
  stage: Stage;
  atk: number; // pre-scaled by world mult
  hp: number; // pre-scaled by world mult
  woodReward: number; // pre-scaled by world mult
  kind: EnemyKind;
  characterId: string;
  special?: EnemySpecialAbility;
}

interface EnemyArchetype {
  stage: Stage;
  atk: number;
  hp: number;
  reward: number;
}

// Tuned so a lone World-0 starter (1 atk / 10 hp) reliably clears stage 1 —
// the very first fight any new player will attempt — and each later stage
// requires a proportionally stronger roster (more/leveled members, rarer
// workers, or Item-Gacha gear) to clear reliably.
//
// Stages 1-2 no longer build a single EnemySpec off this table — see
// STAGE1_SWARM/STAGE2_SWARM below, whose worked-math comment supersedes the
// single-enemy reasoning this block used to carry. The `1`/`2` rows here are
// KEPT (not removed) purely as the "what a monolithic stage 1/2 enemy would
// have cost" reference the embarkCost/chestReward doc comments below still
// cite by total (25 wood / 55 wood) — STAGE1_SWARM/STAGE2_SWARM's per-member
// rewards are split to sum to exactly these same totals, so nothing about
// the run's wood economy actually changed, only how many hp pools stand
// between the party and that wood. Stages 3-5 still build directly off this
// table (buildEnemy), unchanged.
const ENEMY_ARCHETYPES: EnemyArchetype[] = [
  { stage: 1, atk: 1, hp: 4, reward: 25 },
  { stage: 2, atk: 3, hp: 10, reward: 55 },
  // Stages 3-5 retuned (Phase 0 sim calibration) once team.ts's gear-carry
  // fix made tier-matched fights world-invariant: the old atk/hp values left
  // a modestly-geared party at a guaranteed (100%) clear, where the design
  // bands in sim/moves.json want these stages reliably-but-not-freely
  // clearable (~60-90%). Rewards unchanged.
  { stage: 3, atk: 15, hp: 52, reward: 110 },
  { stage: 4, atk: 36, hp: 160, reward: 200 },
  { stage: 5, atk: 38, hp: 180, reward: 380 },
];

interface SwarmMemberArchetype {
  atk: number;
  hp: number;
  reward: number;
}

// Product direction: stages 1-2 field 2-3 WEAKER enemies instead of 1
// stronger one — separate hp pools to grind through instead of one bar.
// Redistributed against the exact same worked-math discipline as the old
// single-enemy table above (world mult ×1, battle.ts's rollDmg: round(base ×
// roll), roll ∈ [0.85, 1.15], no enemy crit):
//
//   - Per-enemy atk is floored at 1, never split below it. Below 1, round()
//     starts landing on 0 for part of the [0.85, 1.15] roll range, which
//     trades the old table's prized determinism (atk 1 is ALWAYS exactly 1
//     dmg, worst roll or best) for genuine RNG — not worth it just to shave
//     total swarm atk down to the old single-enemy total. hp is the only
//     dial we split freely, since more/smaller hp pools (not less atk) is
//     the whole point of a swarm.
//
//   - Stage 1 MUST stay solo-clearable (it's still the very first fight any
//     new player attempts) — STAGE1_SWARM is 2 members, hp 2 each (sums to
//     the old table's hp 4), atk 1 each (floor, so total atk-while-both-
//     alive is 2, not the old table's 1 — the one real departure). Traced
//     solo (atk 1 / hp 10 starter, always acts first, focus-fires the
//     lowest-index living member):
//       r1: hit enemy-0 (hp 2→1); both enemies reply (1+1=2 dmg) → 10→8
//       r2: hit enemy-0 (hp 1→0, dead); enemy-1 replies alone (1 dmg) → 8→7
//       r3: hit enemy-1 (hp 2→1); enemy-1 replies (1 dmg) → 7→6
//       r4: hit enemy-1 (hp 1→0, dead) — wins mid-round, no reply
//     GUARANTEED win, 6/10 hp left (was 7/10 solo against the old single
//     enemy) — one hp worse, still nowhere near a nail-biter, and still
//     fully deterministic at these numbers (no RNG branch anywhere above).
//     A trio of level-1 commons does even better than before: enemy-0 dies
//     to the first 2 of the round's 3 attacks, enemy-1 to the 3rd — only
//     ONE living enemy is ever left to reply, and only for 1 round, so the
//     trio finishes at 9/10, 10/10, 10/10 (matches the old single-enemy
//     trio result exactly).
//
//   - Stage 2 was already explicitly out of solo reach (see the old
//     comment this replaces), so widening it to 3 members doesn't cross any
//     existing difficulty line — it only needs to stay "roughly comparable,
//     not wildly harder" for a roster that could already beat the old
//     single stage-2 enemy. STAGE2_SWARM is hp 4/3/3 (sums to the old
//     table's hp 10) at atk 1 each (floor) — total atk while all 3 are
//     alive is 3, exactly matching the old table's atk 3, and it only goes
//     DOWN from there as members die, whereas the old monolithic enemy kept
//     dealing its full atk 3 every round until it alone died — so this
//     swarm is never harder than the old single enemy for an equal-strength
//     roster, and is usually a bit easier as the fight goes on. It still
//     reliably beats a solo level-1 common at the same failure point the
//     old table did: solo dies on round 4's enemy reply (hp 10→7→4→1→dead)
//     with 2 enemies still standing — same "needs a stronger roster" gate,
//     just against 3 pools instead of 1.
const STAGE1_SWARM: SwarmMemberArchetype[] = [
  { atk: 1, hp: 2, reward: 13 },
  { atk: 1, hp: 2, reward: 12 },
];
const STAGE2_SWARM: SwarmMemberArchetype[] = [
  { atk: 1, hp: 4, reward: 19 },
  { atk: 1, hp: 3, reward: 18 },
  { atk: 1, hp: 3, reward: 18 },
];

export interface EnemyCharacterDef {
  id: string;
  name: string;
  kind: EnemyKind;
  blurb: string;
  /** Per-character palette overlay (bandana/hair tint), same withPalette
   * mechanism as cosmetic caps — individuality without a bespoke silhouette
   * per name. */
  accent: Record<string, string>;
}

const PROTESTOR_CHARACTERS: EnemyCharacterDef[] = [
  { id: "karen", name: "Keyboard Karen", kind: "protestor", blurb: "Picket-line regular, aggressively normal.", accent: { U: "#c2703a" } },
  { id: "doomsayer", name: "Digital Doomsayer", kind: "protestor", blurb: "Sandwich-board prophet of the singularity.", accent: { U: "#7a4a2e" } },
  { id: "vinny", name: "Vinyl Vinny", kind: "protestor", blurb: "Analog purist, will not elaborate.", accent: { U: "#3a5a3a" } },
  { id: "ludd", name: "Captain Ludd", kind: "protestor", blurb: "Self-appointed lead organizer.", accent: { U: "#9c2e2e" } },
  { id: "gramma", name: "Gramma Unplugged", kind: "protestor", blurb: "Somehow the loudest one here.", accent: { U: "#a0709c" } },
];

const SCIENTIST_CHARACTERS: EnemyCharacterDef[] = [
  { id: "glitch", name: "Dr. Glitch", kind: "scientist", blurb: "Researcher, mildly unstable prototype.", accent: { M: "#241f2e" } },
  { id: "baroness", name: "Byte Baroness", kind: "scientist", blurb: "Runs the lab, hates being interrupted.", accent: { M: "#1c1c1c" } },
  { id: "intern", name: "The Intern (Overclocked)", kind: "scientist", blurb: "Nobody trained her on the beam yet.", accent: { M: "#6a4a2a" } },
  { id: "nullpointer", name: "Professor Nullpointer", kind: "scientist", blurb: "Cites a paper for everything.", accent: { M: "#8a8a8a" } },
  { id: "recursion", name: "Dr. Recursion", kind: "scientist", blurb: "Head of R&D. Calls the beam 'iterative.'", accent: { M: "#c9c9c9" } },
];

// Mixed randomly into the protestor pool (stages 1-2) and the scientist pool
// (stage 4) — NOT a third fixed checkpoint like Ludd/Recursion (see
// PROTESTOR_OR_MAYOR/SCIENTIST_OR_MAYOR below). Suit color (`S`) is the
// per-character accent letter here, same role bandana `U`/hair `M` play for
// the other two casts; the sash (`B`) is a fixed kind signature that never
// varies, see scene/sprites.ts's mayor palette block.
const MAYOR_CHARACTERS: EnemyCharacterDef[] = [
  { id: "ribbon", name: "Mayor Ribbon-Cutter", kind: "mayor", blurb: "Here for the photo op, gone before the Q&A.", accent: { S: "#3a5f8a" } },
  { id: "zelda", name: "Zoning Board Zelda", kind: "mayor", blurb: "Denies your permit as a matter of principle.", accent: { S: "#5a3a4a" } },
  { id: "notyouagain", name: "Alderman ‘Not You Again’", kind: "mayor", blurb: "Remembers your face from last quarter's hearing.", accent: { S: "#3a4a3a" } },
  { id: "quinn", name: "Quorum Quinn", kind: "mayor", blurb: "Motions to table the robot uprising.", accent: { S: "#4a3a5a" } },
];

/** Every fightable enemy individual — three named-cast pools sharing one
 * hand-drawn silhouette per kind (see scene/sprites.ts ENEMY_KIND_SPRITES),
 * distinguished by a small palette accent rather than bespoke frames. */
export const ENEMY_CHARACTERS: EnemyCharacterDef[] = [...PROTESTOR_CHARACTERS, ...SCIENTIST_CHARACTERS, ...MAYOR_CHARACTERS];
export const ENEMY_CHARACTERS_BY_ID: Record<string, EnemyCharacterDef> = Object.fromEntries(
  ENEMY_CHARACTERS.map((c) => [c.id, c]),
);

const GLITCH_PULSE: EnemySpecialAbility = { id: "glitchPulse", everyNth: 3, dmgMult: 1.5, skipChance: 0.3 };

// Stage 1-2 swarms and the stage-4 single fight draw from these mixed pools
// (protestor+mayor, scientist+mayor respectively) rather than a
// kind-exclusive one — the mayor is meant to turn up mixed into the existing
// rotation, not own a slot of its own.
const PROTESTOR_OR_MAYOR: EnemyCharacterDef[] = [...PROTESTOR_CHARACTERS, ...MAYOR_CHARACTERS];
const SCIENTIST_OR_MAYOR: EnemyCharacterDef[] = [...SCIENTIST_CHARACTERS, ...MAYOR_CHARACTERS];

/** Stages 1-2 draw from the protestor+mayor cast, 4 from the scientist+mayor
 * cast, rotating by world (and, for a swarm slot, by `offset` too — each
 * swarm member of a battle passes its own index so a 2-3-member fight never
 * repeats the same named character within itself) so the same fight doesn't
 * feel identical every loop — stage 3 is always Captain Ludd (protestor
 * mini-boss) and stage 5 is always Dr. Recursion (scientist final boss), two
 * consistent, recognizable checkpoints at the same spot in every world,
 * untouched by the mayor mix-in. Deterministic (world + stage [+ offset]) %
 * pool.length indexing on purpose, same as before — no Math.random() here,
 * so a given world/stage (/slot) always fields the same character, which is
 * what lets previewBattle/the Muster "Next up" label show the real upcoming
 * fight rather than a random guess. Every pool used here comfortably
 * outsizes the largest swarm (3 members), so distinct `offset`s are
 * guaranteed to land on distinct characters within one battle. */
function pickCharacter(world: number, stage: Stage, offset = 0): EnemyCharacterDef {
  if (stage === 3) return ENEMY_CHARACTERS_BY_ID.ludd;
  if (stage === 5) return ENEMY_CHARACTERS_BY_ID.recursion;
  if (stage <= 2) {
    return PROTESTOR_OR_MAYOR[(world + stage + offset) % PROTESTOR_OR_MAYOR.length];
  }
  return SCIENTIST_OR_MAYOR[(world + stage + offset) % SCIENTIST_OR_MAYOR.length];
}

function specialFor(character: EnemyCharacterDef): EnemySpecialAbility | undefined {
  return character.kind === "scientist" ? GLITCH_PULSE : undefined;
}

/** Builds the full enemy line-up for a stage's fight. Stages 1-2 are a
 * 2-3-member "swarm" (see STAGE1_SWARM/STAGE2_SWARM's worked-math comment
 * above); stages 3-5 stay a single strong enemy, wrapped in a 1-element
 * array purely for a uniform return type — no behavior change there beyond
 * the type. */
export function buildEnemy(world: number, stageIn: Stage): EnemySpec[] {
  const mult = getWorld(world).mult;
  // Clamp into the real 1-5 range before anything indexes off it.
  //
  // `Stage` is a 1|2|3|4|5 union, but it is a COMPILE-time promise over data
  // that comes back off disk. A saved run that ended in a loss before
  // clearing anything carries `adventure.stage === 0`, and callers cast it
  // straight to Stage (see Game's pendingRevival resume path) — at which
  // point `ENEMY_ARCHETYPES[stage - 1]` indexes [-1], returns undefined, and
  // reading `.atk` throws. That throw happened inside the Game CONSTRUCTOR,
  // so boot() died before the first frame: blank canvas, and the status bar
  // stuck on its initial "waiting for data…" placeholder with no error
  // anywhere a player could see.
  //
  // Clamping here rather than only at that one call site is deliberate: the
  // cast is the kind of thing that gets written again, and this function has
  // no business trusting an out-of-range index from any caller.
  const stage = Math.min(5, Math.max(1, Math.round(stageIn))) as Stage;
  if (stage === 1 || stage === 2) {
    const swarm = stage === 1 ? STAGE1_SWARM : STAGE2_SWARM;
    return swarm.map((member, i) => {
      const character = pickCharacter(world, stage, i);
      return {
        name: character.name,
        stage,
        atk: member.atk * mult,
        hp: member.hp * mult,
        woodReward: member.reward * mult,
        kind: character.kind,
        characterId: character.id,
        special: specialFor(character),
      };
    });
  }
  const arch = ENEMY_ARCHETYPES[stage - 1];
  const character = pickCharacter(world, stage);
  return [{
    name: character.name,
    stage,
    atk: arch.atk * mult,
    hp: arch.hp * mult,
    woodReward: arch.reward * mult,
    kind: character.kind,
    characterId: character.id,
    special: specialFor(character),
  }];
}

/** Embark pays a flat, world-scaled fee (NOT scaled by party size — bringing
 * 1, 2, or 3 members costs the same) and immediately resolves stage 1 — no
 * separate fee for the first attempt. Pushing further costs a smaller,
 * stage-scaled fee each time (see Game.continueAdventure). Kept below the
 * flat stage-1 reward (25×mult, see ENEMY_ARCHETYPES) at every party size so
 * winning stage 1 is always a net wood gain, even with a full 3-member
 * party — party size is already a real tactical tradeoff (spreads a limited
 * roster thinner, exposes more members to death risk) without also needing
 * an extra wood tax that a full-party win can't pay for itself. */
export function embarkCost(worldMult: number): number {
  return Math.round(ADVENTURE_EMBARK_BASE * worldMult);
}

/** Wood cost to push into the next stage's fight — see Game.beginStageBattle. */
export function continueFee(worldMult: number, nextStage: number): number {
  return Math.round(ADVENTURE_CONTINUE_BASE * nextStage * worldMult);
}

/** Amber cost of the paid option on a "Team Down" revive offer (see
 * Game.finalizeBattleOutcome/resolveRevival) — a FLAT amber cost, not scaled
 * by world mult (unlike embarkCost/continueFee's wood fees). Amber's actual
 * income sources (ambient chop-based accrual, chest amber, in-run combat
 * amber) barely scale with world tier, so a mult-scaled revive would
 * quickly become unaffordable — worse than an entire run's total amber
 * income — at every world tier past the first. Flat, matching how every
 * other amber cost in BOOSTS/PROVISIONS already works. */
export function reviveCost(): number {
  return ADVENTURE_REVIVE_BASE_COST;
}

// --- Milestone chests -------------------------------------------------
//
// Real, permanent-progress rewards opened on clearing stage 3 (mid-run
// checkpoint) and stage 5 (full clear) — separate from, and not reduced by,
// the run's own bankable pendingWood/pendingAmber (a chest is applied to
// the save directly the instant it's granted — see Game.grantChest — so
// even a loss or retreat immediately afterward can't take it back).

export interface ChestReward {
  wood: number;
  amber: number;
  shardRarity: Rarity;
  shardAmount: number;
}

// Stage-3 base wood roughly matches that stage's own clear reward (110, see
// ENEMY_ARCHETYPES above) — a chest at the run's midpoint effectively
// doubles that stage's payout, a clear "you hit a checkpoint" spike without
// dwarfing the run's own economy. Stage-5's base is set to notably exceed
// stage-4's clear reward (200) so the run's final chest is unambiguously
// the biggest single reward in the whole run, matching a "grand finale"
// feel. Shard amounts are picked against SHARD_VALUE (economy.ts): a rare
// shard is worth 5, so 10 rare shards from a stage-3 chest is worth exactly
// two level-ups at that rarity; 15 epic shards (25 each) from stage-5 is a
// similarly meaningful chunk of epic leveling, not a token amount.
const CHEST_BASE: Record<3 | 5, { wood: number; amber: number; shardRarity: Rarity; shardAmount: number }> = {
  3: { wood: 110, amber: 15, shardRarity: "rare", shardAmount: 10 },
  5: { wood: 260, amber: 40, shardRarity: "epic", shardAmount: 15 },
};

/** World-mult-scaled chest payout (wood/amber only — shards are a flat
 * rarity-keyed currency, same treatment as every other shard payout in the
 * game, none of which scale by world mult either). */
export function chestReward(world: number, stage: 3 | 5): ChestReward {
  const mult = getWorld(world).mult;
  const base = CHEST_BASE[stage];
  return {
    wood: Math.round(base.wood * mult),
    amber: Math.round(base.amber * mult),
    shardRarity: base.shardRarity,
    shardAmount: base.shardAmount,
  };
}

/** A decoration a chest may carry home for the homestead.
 *
 * Deliberately a FREE copy of something you could also buy, not a new item
 * class: it lands straight in the build inventory as a credit, so the reward is
 * "you can place one more of these" rather than a parallel currency. Only ever
 * offers repeatable decorations — handing out a second unique landmark would
 * collide with its own one-per-homestead cap.
 *
 * `roll` is 0..1 from the caller's own RNG stream so this stays a pure
 * function and the sim can drive it deterministically. */
export function chestDecoration(stage: 3 | 5, roll: number): BuildableId | null {
  const pool = BUILDABLES.filter((b) => !b.unique);
  if (pool.length === 0) return null;
  // Stage 5 always carries one; stage 3 only sometimes, so the finale chest
  // stays the more exciting open.
  const chance = stage === 5 ? 1 : 0.5;
  if (roll >= chance) return null;
  const pick = Math.floor((roll / chance) * pool.length);
  return pool[Math.min(pool.length - 1, pick)].id;
}

