// Save-format migrations, extracted out of game-state.ts so they can be
// tested.
//
// game-state.ts imports `invoke` from @tauri-apps/api/core, which makes the
// whole module unimportable from sim/sim.ts — that is why the sim hand-builds
// its own GameSave-shaped literal instead of calling defaultSave(). The
// consequence was that migrations were the one part of the save layer with no
// automated coverage at all, despite being the part most likely to strand a
// player: a migration bug doesn't throw, it silently produces a save that
// looks fine and behaves wrong, and it only ever runs on data that by
// definition no longer exists in the codebase.
//
// Everything here is pure — no DOM, no Tauri, no clock. `migrateSave` takes
// the raw parsed JSON and a freshly-built default save and returns the
// migrated result, so the sim can round-trip a real v3/v4/v5 fixture and
// assert what came out the other side.
//
// Migration philosophy, consistent across every step below: when an in-flight
// structure's SHAPE has changed incompatibly, drop that structure rather than
// half-translating it — but never drop the player's earned resources with it.
// A wrong translation is worse than a missing one, because it survives.

import type { GameSave } from "./game-state";
import { createMember, syncHp, type ItemInstance } from "./team";
import type { HelperId } from "./economy";

/** v3: old saves have no `team`/`inventory`/gacha fields at all — convert the
 * old global axe tier into a starter Woodchopping item (no chop-power loss),
 * and split old global helpers into Power-ups (boots/keenEdge) vs. the still-
 * global gnome system (unchanged). */
export function migrateToV3(save: GameSave, rawParsed: Record<string, unknown>): void {
  if (!Array.isArray(rawParsed.team) || rawParsed.team.length === 0) {
    if (save.team.length === 0) {
      save.team.push(createMember("rook", save.nextMemberSeq++));
    }
    const starter = save.team[0];
    if (typeof rawParsed.ownedAxe === "number") {
      const legacyDefId = `legacy-axe-${rawParsed.ownedAxe}`;
      const inst: ItemInstance = { id: `i-${save.nextItemSeq++}`, defId: legacyDefId };
      save.inventory.push(inst);
      starter.equipped.woodchopping = inst.id;
      syncHp(starter, save.inventory, save.prestigeLevel);
      starter.currentHp = starter.maxHp;
    }
  }

  const legacyHelpers = Array.isArray(rawParsed.helpers) ? (rawParsed.helpers as unknown[]) : [];
  if (legacyHelpers.length > 0) {
    if (legacyHelpers.includes("boots") && !(save.powerups as string[]).includes("swiftBoots")) {
      save.powerups.push("swiftBoots");
    }
    if (legacyHelpers.includes("keenEdge") && !(save.powerups as string[]).includes("keenEdge")) {
      save.powerups.push("keenEdge");
    }
    save.helpers = legacyHelpers.filter(
      (h): h is HelperId => h === "gnome1" || h === "gnome2" || h === "gnomeHaste",
    );
  }
}

/** v4: `AdventureState` gained `battle` (the in-progress turn-based fight,
 * replacing the old instant whole-stage roll) — old saves with a mid-run
 * adventure just have no fight in progress after upgrading; their
 * stage/pendingWood/party are untouched.
 *
 * `prestigeLevel`/`adventureWorldUnlocked` (added in this same bump) need no
 * explicit step — they're flat scalars, and the top-level default-merge in
 * `migrateSave` already fills any field absent from an old save. */
export function migrateToV4(save: GameSave): void {
  if (save.adventure && save.adventure.battle === undefined) {
    save.adventure.battle = null;
  }
}

/** v5: `BattleSnapshot` moved from a single `enemy`/`enemyHp` pair to
 * `enemies: EnemyUnit[]` (multi-enemy battles). An in-progress battle
 * persisted under the old shape has no `enemies` array at all, and the
 * rendering/turn-resolution code can't do anything useful with it — this is
 * exactly what left players stuck in an empty adventure view after resuming a
 * pre-upgrade battle. Same situation as v4's own `battle` migration, so the
 * same fix: drop the incompatible in-progress fight. */
export function migrateToV5(save: GameSave): void {
  const battle = save.adventure?.battle as unknown as { enemies?: unknown } | null | undefined;
  if (save.adventure && battle && !Array.isArray(battle.enemies)) {
    save.adventure.battle = null;
  }
}

/** v6: Adventure became a twelve-room graph with doors, so `stage: 0..5` no
 * longer describes anything. A v5 run cannot be translated — there is no honest
 * answer to "which of the twelve rooms was stage 3" — so the run is dropped,
 * following the precedent v4 and v5 both set for in-flight state whose shape
 * changed incompatibly.
 *
 * But the run's EARNINGS are credited rather than confiscated. `pendingWood`
 * represents rooms the player actually fought and won; taking it away because
 * the game was updated underneath them is the kind of thing that makes people
 * stop trusting an update. Dropping the run costs them the rest of the delve,
 * which is unavoidable; it should not also cost them what they had banked
 * toward.
 *
 * `reconcileTeamStatus` below un-sticks the party — that invariant check was
 * built for exactly this, so no status loop is needed here. */
export function migrateToV6(save: GameSave): void {
  const adv = save.adventure as (GameSave["adventure"] & { map?: unknown }) | null;
  if (!adv || adv.map) return;
  save.wood += adv.pendingWood ?? 0;
  save.amber += adv.pendingAmber ?? 0;
  save.totalWoodEarned += adv.pendingWood ?? 0;
  save.stats.woodFromAdventures += adv.pendingWood ?? 0;
  save.adventure = null;
}

/** Self-healing invariant check, run on every load (not version-gated): a team
 * member should only ever be "adventuring" while genuinely part of the current
 * `adventure.partyIds`. If that's ever out of sync — e.g. an earlier bug
 * cleared `adventure` through a path that skipped the status-release loop in
 * Game.bankAdventure — the member would be permanently unselectable for a new
 * adventure with no in-game way to recover. Reconciling here repairs any save
 * left in that state and makes the desync structurally impossible to get stuck
 * in going forward, regardless of how it happened.
 *
 * This is also what lets every migration above simply null out `save.adventure`
 * without writing its own party-release loop. */
export function reconcileTeamStatus(save: GameSave): void {
  const partyIds = new Set(save.adventure?.partyIds ?? []);
  for (const member of save.team) {
    if (member.status === "adventuring" && !partyIds.has(member.id)) {
      member.status = member.currentHp > 0 ? "available" : "resting";
    }
  }
}

/**
 * The whole load-time transform, pure: default-merge, then every version step
 * the save is behind, then the invariant pass.
 *
 * `fresh` is passed in rather than imported so this module never takes a value
 * dependency on game-state.ts (which would be a cycle, since game-state.ts
 * imports this one). Callers hand it `defaultSave()`.
 *
 * The spread-merge is deliberately shallow-plus-explicit: nested objects each
 * get their own merge so an old save GAINS new sub-fields rather than having
 * a partial object clobber the defaults wholesale.
 */
export function migrateSave(
  rawParsed: Record<string, unknown>,
  fresh: GameSave,
  saveVersion: number,
): GameSave {
  const parsed = rawParsed as Partial<GameSave>;
  const merged: GameSave = {
    ...fresh,
    ...parsed,
    stats: { ...fresh.stats, ...parsed.stats },
    shards: { ...fresh.shards, ...parsed.shards },
    provisions: { ...fresh.provisions, ...parsed.provisions },
    pity: {
      worker: parsed.pity?.worker ?? fresh.pity.worker,
      item: parsed.pity?.item ?? fresh.pity.item,
      powerup: parsed.pity?.powerup ?? fresh.pity.powerup,
    },
    version: saveVersion,
  };

  const prevVersion = typeof rawParsed.version === "number" ? rawParsed.version : 0;
  if (prevVersion < 3) migrateToV3(merged, rawParsed);
  if (prevVersion < 4) migrateToV4(merged);
  if (prevVersion < 5) migrateToV5(merged);
  if (prevVersion < 6) migrateToV6(merged);
  reconcileTeamStatus(merged);

  return merged;
}
