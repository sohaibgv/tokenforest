// Persistent idle-game state, owned by the frontend. Rust stores it as
// opaque JSON at ~/.config/tokenforest/save.json.

import { invoke } from "@tauri-apps/api/core";
import type { BattleSnapshot } from "./battle";
import type { BoonInstance } from "./run/boons";
import type { RunCurse } from "./run/charms";
import type { RunOffer } from "./run/offers";
import type { PactId } from "./run/pact";
import type { PatronId } from "./run/patrons";
import type { RunMap } from "./run/rooms";
import type { ShopState } from "./run/shop";
import { getWorld, type CosmeticId, type HelperId, type PowerupId, type ProvisionId, type Rarity } from "./economy";
import { migrateSave } from "./save-migrations";
import { createMember, type ItemInstance, type TeamMemberSave } from "./team";

export const SAVE_VERSION = 6;

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
  /** How many rooms have been CLEARED. Also the index of the room currently
   * being fought, since `map.slots[n]` is entered after clearing n rooms.
   *
   * Replaces the old `stage: 0..5`. The rename is deliberate rather than
   * cosmetic: `stage` implied a fixed ladder, and every read site that still
   * thinks in stages is a read site that has not been updated for the room
   * graph. Letting the compiler find them all was worth the churn. */
  roomsCleared: number;
  /** The run's RNG seed. Everything generated during the run — the map, every
   * offer, every stall — derives from this, so a run is reproducible from a
   * single number. */
  seed: number;
  /** The full room graph, generated once at embark and persisted VERBATIM,
   * including the doors that will never be taken.
   *
   * Regenerating from the seed on load would be smaller, but it would mean a
   * player's doors could silently change the moment anyone touched the order of
   * an rng call in generateRunMap — a bug that only ever appears in the field,
   * on someone's saved run. 1.5 KB is a cheap price for that not being
   * possible. */
  map: RunMap;
  /** The room the party is standing in. Null only between clearing a room and
   * picking a door. */
  currentRoomId: string | null;
  /** Doors awaiting a choice — RoomSpec ids into `map`, never fresh rolls.
   * Persisted so a pause-and-resume shows the same doors, the same rule the
   * boon offer has always followed. */
  pendingExits: string[] | null;
  /** A non-combat room mid-resolution (a stall part-shopped, a chaos gate
   * unanswered). The Dialogue object itself is never persisted — it is rebuilt
   * from this on resume, exactly as the boon panel is rebuilt from its offer. */
  pendingRoom: { roomId: string; kind: string } | null;
  /** The run-local currency. Deleted with the run — that is the whole point:
   * an acorn not spent is an acorn wasted. */
  acorns: number;
  /** Held boons, at their rolled rarity and earned rank. */
  boonList: BoonInstance[];
  /** Charms bought or found this run — upside and downside both. */
  charms: string[];
  /** Live curses from chaos gates, counting down. */
  curses: RunCurse[];
  /** Bark shields carried BETWEEN rooms (memberId -> remaining shield). The
   * only status that outlives a battle, which is why it lives here rather than
   * on the snapshot. */
  bark: Record<string, number>;
  /** Reroll charges in hand. */
  rerollsLeft: number;
  /** The trader's stall, if the party is standing in one. */
  shop: ShopState | null;
  /** Patron token chosen at Muster — steers the first card of each offer. */
  keepsake: PatronId | null;
  /** Grove Rank this run was embarked at, snapshotted so changing the pact
   * mid-run cannot retroactively change what this run pays out. */
  groveRank: number;
  /** The pact modifiers this run embarked under — snapshotted for the same
   * reason as `groveRank`, and separately from it because the enemy scaling
   * needs to know WHICH modifiers, not just what they were worth. */
  pact?: PactId[];
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
  /** The offer awaiting a pick, if any. Drawn once and persisted VERBATIM —
   * never re-rolled on resume, so closing the app mid-decision can never
   * become a way to fish for better cards. */
  pendingOffer: RunOffer | null;
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
  /** Per-patron favour, earned by picking that patron's boons and clearing
   * Depths with them. Raises its rarity odds and opens its later boons — the
   * between-runs reason to commit to a patron rather than taking whatever is
   * in front of you. Optional/additive: absent reads as no favour anywhere. */
  patronFavor?: Partial<Record<PatronId, number>>;
  /** Keepsakes earned at favour milestones and available to equip at Muster. */
  keepsakes?: PatronId[];
  /** Pact of the Grove modifiers currently switched on — opt-in difficulty for
   * a proportionally better payout. Optional/additive. */
  pact?: PactId[];
  /** Every boon, charm and curse the player has ever been shown, for the Fated
   * List. Discovery is permanent; seeing a thing once is the reward. */
  codex?: string[];
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
    patronFavor: {},
    keepsakes: [],
    pact: [],
    codex: [],
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

// Migrations live in src/save-migrations.ts — pure, so sim/sim.ts can test
// them (this module can't be imported headlessly: it pulls in Tauri's
// `invoke` below).

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
    // Everything after the parse is pure and lives in save-migrations.ts —
    // `defaultSave()` is handed in rather than imported there so that module
    // never takes a value dependency back on this one.
    return migrateSave(rawParsed, defaultSave(), SAVE_VERSION);
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
