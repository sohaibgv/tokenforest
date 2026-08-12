// Persistent idle-game state, owned by the frontend. Rust stores it as
// opaque JSON at ~/.config/tokenforest/save.json.

import { invoke } from "@tauri-apps/api/core";
import type { BattleSnapshot } from "./battle";
import type { BoonId } from "./boons";
import { getWorld, type CosmeticId, type HelperId, type PowerupId, type ProvisionId, type Rarity } from "./economy";
import { createMember, syncHp, type ItemInstance, type TeamMemberSave } from "./team";

export const SAVE_VERSION = 5;

export interface AdventureLogEntry {
  stage: number;
  enemyName: string;
  outcome: "win" | "loss";
  woodGained: number;
  /** Optional: added after woodGained (v4.1-ish, no version bump needed) —
   * old log entries on disk simply lack this field; every read site treats
   * it as `?? 0` / falsy-safe, so no migration is required. */
  amberGained?: number;
  narrowEscape: boolean;
}

export interface AdventureState {
  world: number;
  /** 1-3 roster member ids, snapshotted at embark. */
  partyIds: string[];
  /** 0 = about to attempt stage 1; N = stages 1..N cleared. */
  stage: number;
  pendingWood: number;
  pendingAmber: number;
  carried: ProvisionId[];
  /** Once-per-run Ability charge. */
  abilityUsed: boolean;
  startedAt: string;
  /** Capped at 8, newest last. */
  log: AdventureLogEntry[];
  /** The current stage's in-progress turn-based fight, if any — persisted
   * so pausing back to wood-chopping (or an app restart) resumes exactly
   * where it left off. Null between stages / before a fight starts. */
  battle: BattleSnapshot | null;
  /** Boon id -> stack count. Temporary, run-only power-ups picked after
   * stage wins (see src/boons.ts) — read every turn by battle.ts's
   * resolvePartyTurn/startBattle for the stacking-passive boons, applied
   * once directly to member HP for Iron Skin/Second Wind. Lives and dies
   * with the run exactly like pendingWood/log/stage: cleared by
   * Game.bankAdventure (full clear, loss, or explicit retreat), untouched
   * by simply closing/reopening the battle view mid-run. Optional/absent on
   * saves from before this field existed — every read site treats a
   * missing entry as 0 (same additive pattern as AdventureLogEntry.
   * amberGained above), so no migration is required. */
  boons?: Record<string, number>;
  /** Exactly 3 boon ids offered after the most recent stage win, awaiting a
   * pick — null once nothing is pending. Persisted (never re-rolled) so a
   * pause-then-resume of an in-progress pick — even across an app restart —
   * shows the exact same 3 options the player was originally offered,
   * rather than a fresh random draw (see Game.finalizeBattleOutcome/
   * pickBoon). Optional/absent on old saves reads as "nothing pending",
   * same additive pattern as `boons` above. */
  pendingBoonOffer?: BoonId[] | null;
  /** A "Team Down" revive offer, awaiting a decision — set either when a
   * stage win (1-4) leaves 1+ party members at <=0 HP without wiping the
   * whole party, OR when a stage is lost outright (a genuine full party
   * wipe — see battle.ts's party.every(currentHp<=0) gate). `afterWipe`
   * discriminates the two, since they resolve very differently (see
   * Game.resolveRevival): a win-case decline just continues the run with a
   * downed member; a wipe-case decline finalizes the loss for real
   * (banking, resting marks, adventuresFailed — deferred until this
   * resolves, see Game.finalizeBattleOutcome's loss branch), while a
   * wipe-case revive discards the old battle and retries the same stage
   * instead of ending the run. `free` records whether the free-revive roll
   * succeeded (guaranteed if only one member survived for a win-case offer;
   * always the plain per-downed-member chance for a wipe-case offer, since
   * a wipe has 0 survivors and guaranteeing it would remove the stakes from
   * losing); `cost` is the always-available paid option's amber price,
   * fixed at offer time. Null once resolved (Game.resolveRevival). Checked
   * by beginStageBattle's guard exactly like pendingBoonOffer, and shown
   * ahead of a pending boon offer in ui/battle.ts's finishRewardFlow (a
   * downed teammate is more urgent than a boon pick). Optional/absent on
   * old saves reads as "nothing pending", same additive pattern as
   * `boons`/`pendingBoonOffer` above — no migration needed. */
  pendingRevival?: { free: boolean; cost: number; afterWipe: boolean } | null;
  /** Whether this run's single free "Team Down" revive has already been
   * spent (see Game.resolveRevival's validated-"free" path, which is the
   * only place this ever flips true). Gates both free-revive roll sites in
   * Game.finalizeBattleOutcome (the win-with-deaths branch and the
   * loss/full-wipe branch) so a run can only ever grant one free revive,
   * no matter how many times deadCount > 0 comes up afterward — the paid
   * option stays available regardless. Optional/absent on old saves reads
   * as `undefined`, falsy-safe everywhere it's checked (`!freeReviveUsed`),
   * same additive pattern as `boons`/`pendingBoonOffer`/`pendingRevival`
   * above — no migration needed. */
  freeReviveUsed?: boolean;
}

export interface GameSave {
  version: number;
  wood: number;
  totalWoodEarned: number;
  /** Click energy, charged by token usage (1 per 1k counted, cap 100). */
  focus: number;
  /** Instant per-token currency (1 per 1k counted), spent on boosts. */
  amber: number;
  worldIndex: number;
  plotIndex: number;
  plotsClearedInWorld: number;
  helpers: HelperId[];
  cosmetics: CosmeticId[];
  equippedCap: CosmeticId | null;
  equippedTreeSkin: CosmeticId | null;
  /** Player-chosen dye per owned cosmetic. A missing id means "use the
   * cosmetic's own shipped palette", so pre-dye saves render pixel-identically
   * and no migration is needed — same additive-optional-field convention as
   * AdventureLogEntry.amberGained. Values are validated against DYE_SWATCHES
   * on write (see Game.setCosmeticColor); never trust a hex straight from the
   * DOM into a palette. */
  cosmeticColors?: Partial<Record<CosmeticId, string>>;
  /** Homestead build progress, 0 (bare site) to COTTAGE_MAX_PHASE. Optional and
   * additively read — absent means 0, so pre-cottage saves open on a bare plot
   * with no migration. */
  cottagePhase?: number;
  /** Barn build progress, 0..BARN_MAX_PHASE. Optional/additive like cottagePhase. */
  barnPhase?: number;
  /** Whether the Sap Press has been bought. Optional/additive: absent reads as
   * false, so existing saves simply start without one. */
  sapPressBuilt?: boolean;
  /** World indices whose onward bridge has been repaired. Repairing is what
   * pays the travel cost, so crossing afterwards is free and re-crossing a
   * bridge you already fixed doesn't charge twice. Optional/additive. */
  bridgesRepaired?: number[];
  /** Decorations won from chests and not yet placed, by buildable id ->
   * count. Spent before wood when placing, so a won item is free. Optional/
   * additive like every other homestead field. */
  decorStock?: Record<string, number>;
  /** Buildables the player has placed, by grid cell. Cells are stored rather
   * than pixel coords so a placement survives every window resize — the grid is
   * rebuilt from the canvas size, but (cx, cy) means the same tile either way. */
  placed?: { id: string; cx: number; cy: number }[];
  /** HP per tree slot of the current plot; <= 0 means stump. Null = fresh. */
  currentPlotHp: number[] | null;
  /** Ordered priority-list roster. Index 0 = first assigned to a live session. */
  team: TeamMemberSave[];
  inventory: ItemInstance[];
  /** Duplicate-pull sink, by rarity, spent on leveling. */
  shards: Record<Rarity, number>;
  /** Pity counters. `item` is one counter per World (index = worldIndex). */
  pity: { worker: number; item: number[]; powerup: number };
  powerups: PowerupId[];
  nextMemberSeq: number;
  nextItemSeq: number;
  adventure: AdventureState | null;
  /** Purchased-and-carried provision counts (Trail Rations is instant-use,
   * never stored here — see Game.useTrailRations). */
  provisions: Record<ProvisionId, number>;
  /** Times the wood-chopping world ladder has been reset via Game.prestige().
   * Each level grants a permanent +10% wood yield / +10% party ATK+HP. */
  prestigeLevel: number;
  /** Highest world ever reached for Adventure purposes — tracked separately
   * from `worldIndex` (which resets to 0 on prestige) so adventure progress
   * survives a prestige reset, per the "adventure map persists" design. */
  adventureWorldUnlocked: number;
  stats: {
    treesFelled: number;
    eldersFelled: number;
    chops: number;
    tokensSeen: number;
    clicks: number;
    goldenSpotsHit: number;
    startedAt: string;
    adventuresEmbarked: number;
    adventuresCleared: number;
    adventuresFailed: number;
    woodFromAdventures: number;
  };
}

export function defaultSave(): GameSave {
  const save: GameSave = {
    version: SAVE_VERSION,
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
    cosmeticColors: {},
    cottagePhase: 0,
    barnPhase: 0,
    sapPressBuilt: false,
    bridgesRepaired: [],
    decorStock: {},
    placed: [],
    currentPlotHp: null,
    team: [],
    inventory: [],
    shards: { common: 0, rare: 0, epic: 0, legendary: 0 },
    // item[world] grows lazily — every read site uses `?? 0` and every
    // write site is plain index-assignment, which auto-extends a JS array —
    // so no pre-sizing or migration is needed as new worlds are added.
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
      startedAt: new Date().toISOString(),
      adventuresEmbarked: 0,
      adventuresCleared: 0,
      adventuresFailed: 0,
      woodFromAdventures: 0,
    },
  };
  // A fresh save is never empty-rostered.
  save.team.push(createMember("rook", save.nextMemberSeq++));
  return save;
}

/** v3 migration: old saves have no `team`/`inventory`/gacha fields at all —
 * convert the old global axe tier into a starter Woodchopping item (no
 * chop-power loss), and split old global helpers into Power-ups (boots/
 * keenEdge) vs. the still-global gnome system (unchanged). */
function migrateToV3(save: GameSave, rawParsed: Record<string, unknown>): void {
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

/** v4 migration: `AdventureState` gained `battle` (the in-progress
 * turn-based fight, replacing the old instant whole-stage roll) — old saves
 * with a mid-run adventure just have no fight in progress after upgrading;
 * their stage/pendingWood/party are untouched, "Push On" starts the first
 * turn-based fight for whatever stage they were on.
 *
 * `prestigeLevel`/`adventureWorldUnlocked` (added alongside `battle` in this
 * same v4 bump) need no explicit migration step here — they're flat scalar
 * fields, and `loadSave`'s top-level `{...d, ...parsed}` spread already
 * defaults any field absent from an old save to `defaultSave()`'s value. */
function migrateToV4(save: GameSave): void {
  if (save.adventure && save.adventure.battle === undefined) {
    save.adventure.battle = null;
  }
}

/** v5 migration: `BattleSnapshot` moved from a single `enemy`/`enemyHp` pair
 * to `enemies: EnemyUnit[]` (multi-enemy battles). An in-progress battle
 * persisted under the old shape has no `enemies` array at all, and the new
 * rendering/turn-resolution code can't do anything useful with it (this is
 * exactly what left players "stuck in adventure... empty text area... cannot
 * do anything" after resuming a pre-upgrade battle) — same situation as the
 * v4 bump's own `battle` migration, so the fix is the same: drop the
 * incompatible in-progress fight. `stage`/`pendingWood`/`partyIds` are
 * untouched, "Push On" starts a fresh (now multi-enemy-capable) battle for
 * whatever stage the player was on. */
function migrateToV5(save: GameSave): void {
  const battle = save.adventure?.battle as unknown as { enemies?: unknown } | null | undefined;
  if (save.adventure && battle && !Array.isArray(battle.enemies)) {
    save.adventure.battle = null;
  }
}

/** Self-healing invariant check, run on every load (not version-gated): a
 * team member should only ever be "adventuring" while genuinely part of the
 * current `adventure.partyIds` — if that's ever out of sync (e.g. an earlier
 * bug cleared `adventure` through a path that skipped the status-release
 * loop in `Game.bankAdventure`), the member would be permanently unselectable
 * for a new adventure with no in-game way to recover. Reconciling here
 * repairs any save left in that state and makes the desync structurally
 * impossible to get stuck in going forward, regardless of how it happened. */
function reconcileTeamStatus(save: GameSave): void {
  const partyIds = new Set(save.adventure?.partyIds ?? []);
  for (const member of save.team) {
    if (member.status === "adventuring" && !partyIds.has(member.id)) {
      member.status = member.currentHp > 0 ? "available" : "resting";
    }
  }
}

// --- 3-slot persistence ----------------------------------------------------
//
// Rust stores each slot at ~/.config/tokenforest/save-slot{1,2,3}.json (a
// legacy save.json is renamed to slot 1 on first touch — see save.rs). The
// active slot is chosen at boot (see main.ts's slot-picker flow) and every
// scheduleSave/flush writes to it; the last-used slot number itself lives in
// config.json so restarts skip the picker.

export const SLOT_COUNT = 3;

let activeSlot = 1;

export function currentSlot(): number {
  return activeSlot;
}

/** What the boot-time picker shows per slot — parsed out of the raw slot
 * JSON here (Rust deliberately treats the payload as opaque). */
export interface SlotSummary {
  slot: number;
  empty: boolean;
  worldName: string;
  wood: number;
  prestigeLevel: number;
  lastPlayedMs: number | null;
}

interface RawSlotEntry {
  slot: number;
  json: string | null;
  modifiedMs: number | null;
}

export async function listSlotSummaries(): Promise<SlotSummary[]> {
  const empty = (slot: number): SlotSummary => ({
    slot,
    empty: true,
    worldName: "",
    wood: 0,
    prestigeLevel: 0,
    lastPlayedMs: null,
  });
  try {
    const entries = await invoke<RawSlotEntry[]>("list_slots");
    return entries.map((e) => {
      if (!e.json) return empty(e.slot);
      try {
        const parsed = JSON.parse(e.json) as Partial<GameSave>;
        return {
          slot: e.slot,
          empty: false,
          worldName: getWorld(parsed.worldIndex ?? 0).name,
          wood: parsed.wood ?? 0,
          prestigeLevel: parsed.prestigeLevel ?? 0,
          lastPlayedMs: e.modifiedMs ?? null,
        };
      } catch {
        return empty(e.slot);
      }
    });
  } catch {
    return Array.from({ length: SLOT_COUNT }, (_, i) => empty(i + 1));
  }
}

export async function deleteSlot(slot: number): Promise<void> {
  try {
    await invoke("delete_slot", { slot });
  } catch {
    /* no bridge (browser dev) */
  }
}

export async function getCurrentSlot(): Promise<number | null> {
  try {
    const slot = await invoke<number | null>("get_current_slot");
    return typeof slot === "number" && slot >= 1 && slot <= SLOT_COUNT ? slot : null;
  } catch {
    return null;
  }
}

export async function setCurrentSlot(slot: number): Promise<void> {
  try {
    await invoke("set_current_slot", { slot });
  } catch {
    /* no bridge (browser dev) */
  }
}

export async function loadSave(slot: number): Promise<GameSave> {
  activeSlot = slot;
  try {
    const raw = await invoke<string | null>("load_game", { slot });
    if (!raw) return defaultSave();
    const rawParsed = JSON.parse(raw) as Record<string, unknown>;
    const parsed = rawParsed as Partial<GameSave>;
    // Spread-merge is shallow: nested objects need their own merge so old
    // saves gain new fields instead of clobbering the defaults.
    const d = defaultSave();
    const merged: GameSave = {
      ...d,
      ...parsed,
      stats: { ...d.stats, ...parsed.stats },
      shards: { ...d.shards, ...parsed.shards },
      provisions: { ...d.provisions, ...parsed.provisions },
      pity: {
        worker: parsed.pity?.worker ?? d.pity.worker,
        item: parsed.pity?.item ?? d.pity.item,
        powerup: parsed.pity?.powerup ?? d.pity.powerup,
      },
      version: SAVE_VERSION,
    };

    const prevVersion = typeof rawParsed.version === "number" ? rawParsed.version : 0;
    if (prevVersion < 3) {
      migrateToV3(merged, rawParsed);
    }
    if (prevVersion < 4) {
      migrateToV4(merged);
    }
    if (prevVersion < 5) {
      migrateToV5(merged);
    }
    reconcileTeamStatus(merged);

    return merged;
  } catch {
    return defaultSave();
  }
}

let pending: GameSave | null = null;
let timer: number | null = null;

function flush(): void {
  if (pending) {
    try {
      void invoke("save_game", { slot: activeSlot, json: JSON.stringify(pending) });
    } catch {
      /* no bridge (browser dev) — progress is session-only there */
    }
    pending = null;
  }
  timer = null;
}

/** Awaitable flush for "about to reload the webview" moments (slot switch)
 * — the fire-and-forget flush() above may not survive a navigation. */
export async function flushSaveNow(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (pending) {
    const json = JSON.stringify(pending);
    pending = null;
    try {
      await invoke("save_game", { slot: activeSlot, json });
    } catch {
      /* no bridge (browser dev) */
    }
  }
}

/** Debounced (2s); pass immediate=true on fells/purchases/travel. */
export function scheduleSave(save: GameSave, immediate = false): void {
  pending = save;
  if (immediate) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
    return;
  }
  if (timer === null) {
    timer = window.setTimeout(flush, 2000);
  }
}
