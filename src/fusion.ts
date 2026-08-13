// The Fusion Altar — spend four workers of a tier to push a fifth up to the
// next one.
//
// PURE. No DOM, no Tauri, no clock. Everything here is a function of the save
// it is handed, which is what lets sim/sim.ts test the whole mechanic headless
// (see src/save-migrations.ts's header for why that constraint exists).
//
// Two design rules run through the whole file:
//
//   1. THE TARGET IS UPGRADED IN PLACE. It keeps its id, level, xp, gear and
//      current HP; only `starRank` moves. Nothing in this codebase has ever
//      removed a TeamMemberSave from save.team, so every id that survives a
//      merge is an id nobody has to go and re-point. The four sacrifices are
//      the only deletions, and canFuse refuses to nominate any member that
//      something else is currently holding by id.
//
//   2. planFusion DECIDES, applyFusion MUTATES. The UI renders a plan and then
//      hands the same object back to commit it, so what the stat preview
//      promised and what the roster ends up with cannot drift apart — they are
//      computed once, from the same numbers.

import {
  RARITY_ORDER,
  SHARD_VALUE,
  type Rarity,
} from "./economy";
import {
  effectiveAtk,
  effectiveMaxHp,
  effectiveRarity,
  starCount,
  type ItemInstance,
  type TeamMemberSave,
} from "./team";

/** Sacrifices per merge. Four, plus the target, is the five of the brief. */
export const FUSION_FODDER_COUNT = 4;

/** Roster safety valve. Duplicate pulls now become real members rather than
 * shards (see gacha.ts), which is what makes fodder exist at all — but with no
 * roster cap anywhere in the codebase that would otherwise grow without bound.
 * Past this many copies of one character a pull pays shards again, exactly as
 * it used to. Five is deliberately one full merge's worth: you can always
 * assemble a fusion out of a single character, and never hoard past the point
 * where the extra copies do anything. */
export const MAX_COPIES_PER_WORKER = 5;

/** Why a member cannot be used. These strings are shown to the player, so they
 * name the fix rather than the rule. */
export type FusionBlocker =
  | "maxed"
  | "adventuring"
  | "resting"
  | "working"
  | "missing";

export const FUSION_BLOCKER_COPY: Record<FusionBlocker, string> = {
  maxed: "Already Legendary — there is nothing above it.",
  adventuring: "Out on a run. Bank or finish the adventure first.",
  resting: "Hurt and resting. Heal them first.",
  working: "Currently out chopping. They'll be free when the session ends.",
  missing: "No longer on the roster.",
};

export interface FusionCheck {
  ok: boolean;
  reason?: FusionBlocker;
}

export interface FusionStatLine {
  atk: number;
  hp: number;
  stars: number;
  rarity: Rarity;
}

export interface FusionPlan {
  targetId: string;
  fodderIds: string[];
  fromRarity: Rarity;
  toRarity: Rarity;
  /** Shards handed back for the sacrifices. This is not a bonus — it is the
   * payout the duplicate pull used to give at the moment it was pulled, moved
   * to the moment it is actually spent, so lifetime shard income is unchanged
   * by the whole feature. sim/sim.ts asserts that equality. */
  shardRefund: { rarity: Rarity; amount: number };
  before: FusionStatLine;
  after: FusionStatLine;
}

/** The subset of GameSave fusion touches. Declared structurally rather than
 * importing GameSave, because game-state.ts imports Tauri's `invoke` and would
 * drag the whole module out of the sim's reach. */
export interface FusionSave {
  team: TeamMemberSave[];
  inventory: ItemInstance[];
  shards: Record<Rarity, number>;
  prestigeLevel: number;
}

/** Ids the caller knows are pinned by something transient — today, the members
 * backing live woodcutter sprites (Game.slotAssignment). That map never
 * self-heals: deleting a member it points at leaves a permanent ghost worker
 * at common/1-atk for the rest of the session, and there is no existing guard
 * anywhere for it. Passing the set in keeps this module pure while still
 * letting it refuse. */
export type PinnedIds = ReadonlySet<string>;

const EMPTY_PINS: PinnedIds = new Set();

function isTop(member: TeamMemberSave): boolean {
  return effectiveRarity(member) === RARITY_ORDER[RARITY_ORDER.length - 1];
}

/** Whether a member may be consumed as fodder. Stricter than `canFuse` — a
 * Legendary is a perfectly good sacrifice, it just cannot be a target. */
export function canSacrifice(member: TeamMemberSave, pinned: PinnedIds = EMPTY_PINS): FusionCheck {
  if (member.status === "adventuring") return { ok: false, reason: "adventuring" };
  if (member.status === "resting") return { ok: false, reason: "resting" };
  if (pinned.has(member.id)) return { ok: false, reason: "working" };
  return { ok: true };
}

/** Whether a member may sit on the target socket. */
export function canFuse(member: TeamMemberSave, pinned: PinnedIds = EMPTY_PINS): FusionCheck {
  if (isTop(member)) return { ok: false, reason: "maxed" };
  return canSacrifice(member, pinned);
}

function statLine(
  member: TeamMemberSave,
  save: FusionSave,
  starRankOverride?: number,
): FusionStatLine {
  // Stats are read through the real team.ts functions against a shallow copy,
  // never re-derived here. A preview that computed its own numbers would be a
  // second formula to keep in sync with baseStats, and it would be wrong the
  // first time either one changed.
  const probe: TeamMemberSave =
    starRankOverride === undefined ? member : { ...member, starRank: starRankOverride };
  return {
    atk: Math.round(effectiveAtk(probe, save.inventory, save.prestigeLevel)),
    hp: effectiveMaxHp(probe, save.inventory, save.prestigeLevel),
    stars: starCount(probe),
    rarity: effectiveRarity(probe),
  };
}

/**
 * Validates a target + fodder selection and returns what the merge would do,
 * or null if the selection is not legal.
 *
 * Returning null rather than throwing is deliberate: the Altar calls this on
 * every socket change to decide whether the Merge button lights up, so an
 * incomplete selection is the normal case, not an error.
 */
export function planFusion(
  targetId: string,
  fodderIds: string[],
  save: FusionSave,
  pinned: PinnedIds = EMPTY_PINS,
): FusionPlan | null {
  if (fodderIds.length !== FUSION_FODDER_COUNT) return null;
  // A member cannot be its own sacrifice, and no member may fill two sockets.
  const unique = new Set(fodderIds);
  if (unique.size !== fodderIds.length || unique.has(targetId)) return null;

  const target = save.team.find((m) => m.id === targetId);
  if (!target || !canFuse(target, pinned).ok) return null;

  const fromRarity = effectiveRarity(target);
  const fodder: TeamMemberSave[] = [];
  for (const id of fodderIds) {
    const m = save.team.find((x) => x.id === id);
    if (!m) return null;
    if (!canSacrifice(m, pinned).ok) return null;
    // Same TIER, not same character — a merge is paid for in rank, and which
    // faces you spend is the player's call.
    if (effectiveRarity(m) !== fromRarity) return null;
    fodder.push(m);
  }

  const nextRank = (target.starRank ?? 0) + 1;
  const before = statLine(target, save);
  const after = statLine(target, save, nextRank);
  const refund = fodder.reduce((sum, m) => sum + SHARD_VALUE[effectiveRarity(m)], 0);

  return {
    targetId,
    fodderIds: [...fodderIds],
    fromRarity,
    toRarity: after.rarity,
    shardRefund: { rarity: fromRarity, amount: refund },
    before,
    after,
  };
}

/**
 * Commits a plan. THE ONLY PLACE a TeamMemberSave is removed from a roster.
 *
 * Re-validates rather than trusting the plan it is handed: the Altar can sit
 * open across an autosave tick, a chest reward, or a member being sent on a
 * run from another screen, and committing a stale plan would delete the wrong
 * four workers. Returns false and touches nothing if the plan no longer holds.
 */
export function applyFusion(
  save: FusionSave,
  plan: FusionPlan,
  pinned: PinnedIds = EMPTY_PINS,
): boolean {
  const fresh = planFusion(plan.targetId, plan.fodderIds, save, pinned);
  if (!fresh) return false;

  const target = save.team.find((m) => m.id === plan.targetId);
  if (!target) return false;

  const doomed = new Set(plan.fodderIds);
  // Unequip before deleting. Item instances live in save.inventory and are
  // only ever referenced member -> item, so a deleted member's gear is not
  // destroyed — but leaving the reference behind means `equippedInstanceIds`
  // would keep counting those items as worn by a member who no longer exists,
  // and they would be silently unavailable forever.
  for (const m of save.team) {
    if (!doomed.has(m.id)) continue;
    m.equipped.woodchopping = null;
    m.equipped.adventuring = null;
    m.equipped.utility = null;
    m.equipped.utility2 = null;
  }

  save.team = save.team.filter((m) => !doomed.has(m.id));
  target.starRank = (target.starRank ?? 0) + 1;
  save.shards[fresh.shardRefund.rarity] += fresh.shardRefund.amount;
  return true;
}

/**
 * Picks the four cheapest legal sacrifices for a target — the [Auto-Fill]
 * button.
 *
 * "Cheapest" means lowest level first, then least gear, then oldest id. That
 * order matters: the one thing a player must never do by accident is feed the
 * Altar the Lv15 worker they spent shards on, and a naive first-four-matches
 * pick would do exactly that roughly as often as not.
 *
 * Deterministic — same save in, same ids out — so the sim can assert it and so
 * the button never surprises the player with a different answer on a second
 * press.
 */
export function autoFillFodder(
  targetId: string,
  save: FusionSave,
  pinned: PinnedIds = EMPTY_PINS,
): string[] {
  const target = save.team.find((m) => m.id === targetId);
  if (!target || !canFuse(target, pinned).ok) return [];
  const tier = effectiveRarity(target);

  const gearCount = (m: TeamMemberSave): number =>
    [m.equipped.woodchopping, m.equipped.adventuring, m.equipped.utility, m.equipped.utility2]
      .filter(Boolean).length;
  const seq = (m: TeamMemberSave): number => Number(m.id.replace(/^m-/, "")) || 0;

  return save.team
    .filter((m) => m.id !== targetId && effectiveRarity(m) === tier && canSacrifice(m, pinned).ok)
    .sort((a, b) => a.level - b.level || gearCount(a) - gearCount(b) || seq(a) - seq(b))
    .slice(0, FUSION_FODDER_COUNT)
    .map((m) => m.id);
}

/** How many legal sacrifices of a target's tier are available — drives the
 * "3 of 4 ready" readout, so the Altar can say what is missing instead of just
 * refusing to light up. */
export function fodderAvailable(
  targetId: string,
  save: FusionSave,
  pinned: PinnedIds = EMPTY_PINS,
): number {
  const target = save.team.find((m) => m.id === targetId);
  if (!target) return 0;
  const tier = effectiveRarity(target);
  return save.team.filter(
    (m) => m.id !== targetId && effectiveRarity(m) === tier && canSacrifice(m, pinned).ok,
  ).length;
}
