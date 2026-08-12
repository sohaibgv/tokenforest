// The cast list: who exists, what they look like, and what they can say.
//
// Deliberately holds NO positions. Where an NPC stands depends on the plot's
// grid, the lake's seeded position and the homestead's footprint — all of
// which live on Game — so Game owns the id → position mapping and this file
// stays a pure, testable description of the characters themselves.

import {
  FISHER_IDLE,
  FISHER_TUG,
  FOREMAN_HAMMER_DOWN,
  FOREMAN_HAMMER_UP,
  FOREMAN_IDLE,
  QUARTERMASTER_IDLE,
  type PixelMap,
} from "../scene/sprites";
import { eligibleLines, FISHER_LINES, FOREMAN_LINES, QUARTERMASTER_LINES, type NpcLine } from "./lines";
import type { UsageView } from "./usage-view";

export type NpcId = "fisher" | "foreman" | "quartermaster";

export interface NpcDef {
  id: NpcId;
  name: string;
  lines: NpcLine[];
  /** Resting frame, plus an optional second frame for a slow idle. */
  idle: PixelMap;
  alt?: PixelMap;
  /** Radians/sec for the idle frame swap. Low — these are people standing
   * about, not machines; a fast swap reads as a glitch. */
  altRate?: number;
}

export const NPCS: Record<NpcId, NpcDef> = {
  fisher: {
    id: "fisher",
    name: "THE FISHER",
    lines: FISHER_LINES,
    idle: FISHER_IDLE,
    alt: FISHER_TUG,
    altRate: 0.9,
  },
  foreman: {
    id: "foreman",
    name: "THE FOREMAN",
    lines: FOREMAN_LINES,
    idle: FOREMAN_IDLE,
    // His hammer frames double as the idle twitch when he isn't working.
    alt: FOREMAN_HAMMER_UP,
    altRate: 0.5,
  },
  quartermaster: {
    id: "quartermaster",
    name: "THE QUARTERMASTER",
    lines: QUARTERMASTER_LINES,
    idle: QUARTERMASTER_IDLE,
  },
};

export const NPC_IDS: NpcId[] = ["fisher", "foreman", "quartermaster"];

/** The foreman's working frames, for the trestle rebuild beat. Kept here so
 * game.ts imports the cast from one place. */
export const FOREMAN_WORK_FRAMES = { up: FOREMAN_HAMMER_UP, down: FOREMAN_HAMMER_DOWN };

/** Pick a line at random, never repeating `previous`.
 *
 * The no-repeat rule matters more than it looks: with a pool this size, plain
 * uniform sampling says the same thing twice in a row often enough to make a
 * character feel broken rather than random. Falls back to allowing the repeat
 * only when the eligible pool has literally one entry.
 *
 * `rand` is injected so the content gates can drive it deterministically. */
export function pickLine(
  pool: NpcLine[],
  u: UsageView,
  opts: { ambient?: boolean; previous?: NpcLine | null; rand?: () => number } = {},
): NpcLine | null {
  const rand = opts.rand ?? Math.random;
  const all = eligibleLines(pool, u, opts.ambient === true);
  if (all.length === 0) return null;
  const fresh = all.length > 1 && opts.previous ? all.filter((l) => l !== opts.previous) : all;
  return fresh[Math.floor(rand() * fresh.length)] ?? fresh[0];
}
