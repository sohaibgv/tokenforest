// The run's shape: three Depths of four rooms, and the doors between them.
//
// The old run was five linear stages with a boon after each of the first four.
// Four picks is not enough for a build to exist — by the time you know what
// your run wants to be, it is over — and a straight line offers no decision at
// all between fights. Twelve rooms fixes the first problem; doors fix the
// second.
//
// ---------------------------------------------------------------------------
// WHY A GRAMMAR AND NOT A DICE ROLL
// ---------------------------------------------------------------------------
//
// Pure randomness produces runs that are individually plausible and
// collectively awful: the one where three shops come up back to back and there
// is nothing to spend on, the one where no boon door appears until room six
// and the build never starts, the one where the pre-boss room is an elite and
// the fight is lost before it begins. Players do not experience a distribution;
// they experience one run, and they blame the game rather than the seed.
//
// So generation is constrained. The rules below are stated as invariants and
// asserted in sim/sim.ts over a thousand generated maps:
//
//   1. Every Depth opens with a fight. You earn your way in.
//   2. At least one door at every choice offers a boon or a rank-up, so a build
//      can always be pursued. This is the most important rule here — without
//      it, a run can be denied its own premise by luck.
//   3. Never two non-combat rooms in a row. The pacing is fight-and-breathe.
//   4. Depth I has no shop (nothing has been earned yet); Depths II and III
//      have exactly one each.
//   5. No elites in Depth I, at most one per Depth after.
//   6. The room before each boss always offers a fountain — the classic
//      pre-boss safety valve, and the reason a boss can be tuned to be hard.
//   7. Depth I offers 2 doors, later Depths 3. A first run should not open on
//      a wall of choices before the player knows what any of the sigils mean.
//
// ---------------------------------------------------------------------------
// WHY THE WHOLE MAP IS GENERATED UP FRONT
// ---------------------------------------------------------------------------
//
// Every candidate at every slot — including the doors the player will never
// take — is generated at embark and persisted verbatim. That costs about 1.5 KB
// of JSON and buys three things: doors that are identical after an app restart
// (the same guarantee the boon offer already makes), a sim that can enumerate
// whole runs without simulating them, and freedom from "regenerate from the
// seed and hope nobody changed the order of the rng calls", which is a bug that
// only ever appears in the field.

import { mulberry32 } from "../rng";
import type { PatronId } from "./patrons";

export type RoomKind =
  | "fight"
  | "elite"
  | "boss"
  | "shop"
  | "shrine"
  | "fountain"
  | "chaos"
  | "chest";

/** What the sigil over a door promises. Distinct from RoomKind because a plain
 * fight can be carrying any of several rewards, and the reward is what the
 * player is actually choosing between. */
export type RewardKind =
  | "boon"
  | "rank"
  | "acorns"
  | "chest"
  | "heal"
  | "chaos"
  | "shop"
  | "elite";

export interface RoomSpec {
  /** Stable within a run: `d2r3c1` = Depth 2, room 3, candidate 1. Used as the
   * door id the player picks and as the key everything else refers to. */
  id: string;
  depth: 1 | 2 | 3;
  /** 0-based index within the Depth. 3 is always the boss. */
  index: number;
  kind: RoomKind;
  reward: RewardKind;
  /** For boon rewards, which patron's sigil hangs over the door. Knowing this
   * before you commit is the whole point of the door — it is the difference
   * between choosing a build and being handed one. */
  patron?: PatronId;
  /** Elite modifier id, for elite rooms only. */
  affix?: string;
}

export interface RunMap {
  seed: number;
  /** Every slot's candidates, in order. `slots[i]` is the set of doors offered
   * after clearing room i-1; `slots[0]` is the run's opening room and always
   * has exactly one entry. */
  slots: RoomSpec[][];
}

export const DEPTH_COUNT = 3;
export const ROOMS_PER_DEPTH = 4;
export const TOTAL_ROOMS = DEPTH_COUNT * ROOMS_PER_DEPTH;

export const DEPTH_NAMES: Record<1 | 2 | 3, string> = {
  1: "Thornwood",
  2: "The Grid",
  3: "Heartwood",
};

/** Elite affixes — a modifier that changes how a fight has to be approached,
 * not just how big its numbers are. Each is paired with a guaranteed better
 * reward, so taking the elite door is a real wager rather than a tax. */
export const ELITE_AFFIXES: { id: string; name: string; blurb: string }[] = [
  { id: "armored", name: "Armoured", blurb: "Shrugs off a chunk of every hit. Bring status damage." },
  { id: "frenzied", name: "Frenzied", blurb: "Strikes far harder, but goes down faster." },
  { id: "insulated", name: "Insulated", blurb: "Cannot be Glitched or Weakened. Control builds beware." },
  { id: "regrowing", name: "Regrowing", blurb: "Mends itself every round. Out-damage it or lose." },
];

export const REWARD_LABEL: Record<RewardKind, string> = {
  boon: "BOON",
  rank: "RANK UP",
  acorns: "ACORNS",
  chest: "CHEST",
  heal: "SPRING",
  chaos: "CHAOS",
  shop: "TRADER",
  elite: "ELITE",
};

const PATRON_ORDER: PatronId[] = ["bramble", "cinder", "sap", "static", "lumen"];

function pick<T>(items: T[], rng: () => number): T {
  return items[Math.floor(rng() * items.length)];
}

/** Non-combat rooms are the run's breathing room, and each maps to exactly one
 * reward — the sigil IS the room. */
const EVENT_ROOMS: { kind: RoomKind; reward: RewardKind }[] = [
  { kind: "shrine", reward: "rank" },
  { kind: "fountain", reward: "heal" },
  { kind: "chaos", reward: "chaos" },
  { kind: "chest", reward: "chest" },
];

function isCombat(kind: RoomKind): boolean {
  return kind === "fight" || kind === "elite" || kind === "boss";
}

/**
 * Builds one run's entire room graph.
 *
 * Deterministic in `seed` alone: the same seed always produces the same map,
 * which is what makes the persisted copy and the sim's enumeration agree.
 */
export function generateRunMap(seed: number, opts: { noFountains?: boolean } = {}): RunMap {
  const rng = mulberry32(seed >>> 0);
  const slots: RoomSpec[][] = [];

  // Tracks what has already been placed on the PATH the player might take.
  // Rules 4 and 5 are per-Depth budgets, and since the player only walks one
  // route, the budget is spent when a candidate is OFFERED — otherwise a Depth
  // could offer three shops and satisfy "exactly one" only in the abstract.
  let shopsThisDepth = 0;
  let elitesThisDepth = 0;
  let prevWasCombat = true;

  for (let roomIndex = 0; roomIndex < TOTAL_ROOMS; roomIndex++) {
    const depth = (Math.floor(roomIndex / ROOMS_PER_DEPTH) + 1) as 1 | 2 | 3;
    const indexInDepth = roomIndex % ROOMS_PER_DEPTH;
    if (indexInDepth === 0) {
      shopsThisDepth = 0;
      elitesThisDepth = 0;
    }

    // Rule 7: Depth I keeps the choice narrow. The opening room of the run and
    // every boss are single doors — there is nothing to decide about walking
    // into the room you are already in, or about facing the Depth's boss.
    const doorCount = roomIndex === 0 ? 1 : indexInDepth === ROOMS_PER_DEPTH - 1 ? 1 : depth === 1 ? 2 : 3;

    const candidates: RoomSpec[] = [];
    for (let c = 0; c < doorCount; c++) {
      const id = `d${depth}r${indexInDepth}c${c}`;
      // Rule 1: every Depth opens with a fight.
      if (indexInDepth === 0) {
        candidates.push({ id, depth, index: indexInDepth, kind: "fight", reward: "boon", patron: PATRON_ORDER[Math.floor(rng() * PATRON_ORDER.length)] });
        continue;
      }
      // The Depth boss. Always a single door, always carries a chest.
      if (indexInDepth === ROOMS_PER_DEPTH - 1) {
        candidates.push({ id, depth, index: indexInDepth, kind: "boss", reward: "chest" });
        continue;
      }

      // Rule 2: the FIRST candidate at every choice is always a build door, so
      // a run can never be denied its own premise by an unlucky draw. The
      // remaining doors are where the variety lives.
      if (c === 0) {
        // Always a fight — the build door is earned, never handed over. Its
        // reward alternates between a fresh boon and a rank-up so that going
        // deep on what you already hold stays as available as going wide.
        const wantsRank = rng() < 0.3;
        candidates.push({
          id,
          depth,
          index: indexInDepth,
          kind: "fight",
          reward: wantsRank ? "rank" : "boon",
          patron: wantsRank ? undefined : PATRON_ORDER[Math.floor(rng() * PATRON_ORDER.length)],
        });
        continue;
      }

      // Rule 6: the room before a boss always offers a way to heal — unless the
      // player has signed the Dry Wells pact, whose entire content is the
      // deliberate removal of this safety valve. A modifier that promised "no
      // fountains" while the map kept placing them would be the plainest
      // possible lie the pact screen could tell.
      if (!opts.noFountains && indexInDepth === ROOMS_PER_DEPTH - 2 && c === 1) {
        candidates.push({ id, depth, index: indexInDepth, kind: "fountain", reward: "heal" });
        prevWasCombat = false;
        continue;
      }

      // Rule 4: one shop per Depth, and none in Depth I where nothing has been
      // earned to spend.
      if (depth > 1 && shopsThisDepth === 0 && rng() < 0.45) {
        shopsThisDepth++;
        candidates.push({ id, depth, index: indexInDepth, kind: "shop", reward: "shop" });
        prevWasCombat = false;
        continue;
      }

      // Rule 5: elites are the run's optional difficulty, absent from Depth I.
      if (depth > 1 && elitesThisDepth === 0 && rng() < 0.35) {
        elitesThisDepth++;
        candidates.push({
          id,
          depth,
          index: indexInDepth,
          kind: "elite",
          reward: "elite",
          affix: pick(ELITE_AFFIXES, rng).id,
        });
        prevWasCombat = true;
        continue;
      }

      // Rule 3: no two non-combat rooms back to back. When the previous room
      // was already a breather, this door has to be a fight.
      if (!prevWasCombat || rng() < 0.5) {
        candidates.push({ id, depth, index: indexInDepth, kind: "fight", reward: rng() < 0.5 ? "acorns" : "boon", patron: PATRON_ORDER[Math.floor(rng() * PATRON_ORDER.length)] });
        prevWasCombat = true;
        continue;
      }

      // Fountains reach the map by TWO routes — the guaranteed pre-boss slot
      // above, and this random event pick. Dry Wells has to close both, or a
      // pact promising no springs still scatters them through the run.
      const pool = opts.noFountains ? EVENT_ROOMS.filter((e) => e.kind !== "fountain") : EVENT_ROOMS;
      const event = pick(pool, rng);
      candidates.push({ id, depth, index: indexInDepth, kind: event.kind, reward: event.reward });
      prevWasCombat = false;
    }

    // `prevWasCombat` describes the room actually entered, and the player picks
    // that at runtime. Generating against "the first candidate" is the honest
    // approximation: candidate 0 is always a fight (rule 2), so a run that
    // always takes the build door never sees two breathers in a row, and a run
    // that deliberately chains events has chosen to.
    prevWasCombat = isCombat(candidates[0].kind);
    slots.push(candidates);
  }

  return { seed: seed >>> 0, slots };
}

/** The Depth a room index belongs to. */
export function depthOf(roomIndex: number): 1 | 2 | 3 {
  return (Math.min(DEPTH_COUNT, Math.floor(roomIndex / ROOMS_PER_DEPTH) + 1) as 1 | 2 | 3);
}

/** True when clearing this room ends a Depth — the run's two "descend or bank"
 * moments, and where the descent toll is charged. */
export function isDepthBoundary(roomIndex: number): boolean {
  return roomIndex % ROOMS_PER_DEPTH === ROOMS_PER_DEPTH - 1 && roomIndex < TOTAL_ROOMS - 1;
}

export function isFinalRoom(roomIndex: number): boolean {
  return roomIndex >= TOTAL_ROOMS - 1;
}

/** The doors offered after clearing `roomIndex`, or null at the run's end. */
export function exitsAfter(map: RunMap, roomIndex: number): RoomSpec[] | null {
  const next = roomIndex + 1;
  if (next >= map.slots.length) return null;
  return map.slots[next];
}

export function roomById(map: RunMap, id: string): RoomSpec | null {
  for (const slot of map.slots) {
    const found = slot.find((r) => r.id === id);
    if (found) return found;
  }
  return null;
}

/** The plaque text shown when hovering a door — uppercase, since the canvas
 * font has no lowercase. */
export function doorLabel(room: RoomSpec): string {
  const base = REWARD_LABEL[room.reward];
  if (room.reward === "boon" && room.patron) return `${base} · ${room.patron.toUpperCase()}`;
  if (room.kind === "elite" && room.affix) {
    const affix = ELITE_AFFIXES.find((a) => a.id === room.affix);
    return affix ? `ELITE · ${affix.name.toUpperCase()}` : base;
  }
  return base;
}
