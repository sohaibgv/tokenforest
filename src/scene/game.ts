// Idle-game orchestration. Token usage drives chops; chops deal axe damage;
// felled trees pay wood; wood buys upgrades and travel to harder worlds.
// The 5h budget survives only as a meter (lake level, strip, tray icon).

import { reportFell, type ChopEvent, type Snapshot } from "../bridge";
import {
  BASE_REROLLS,
  buildEnemy,
  chestDecoration,
  chestReward,
  descentToll,
  embarkCost,
  reviveCost,
  roomTier,
  type ChestReward,
  type EliteAffixId,
} from "../adventure";
import {
  isBattleOver,
  previewBattle,
  previewRun,
  readinessBand,
  resolvePartyTurn,
  startBattle,
  type BattleAction,
  type BattleSnapshot,
  type TurnEvent,
} from "../battle";
import {
  BOON_DEFS_BY_ID,
  BOON_HEAL_PCT,
  BOON_HP_PCT,
  describeBoon,
  RARITY_LABEL,
  type BoonInstance,
} from "../run/boons";
import { CHARM_DEFS, CHARM_DEFS_BY_ID, CURSE_DEFS, type CurseDef } from "../run/charms";
import { applyOfferCard, drawOffer, rerollOffer, type OfferContext, type RunOffer } from "../run/offers";
import { groveRank, grovePayoutMult, pactEnemyScaling } from "../run/pact";
import { MAX_PATRON_FAVOR, type PatronId } from "../run/patrons";
import {
  depthOf,
  exitsAfter,
  generateRunMap,
  isDepthBoundary,
  isFinalRoom,
  roomById,
  TOTAL_ROOMS,
  type RoomSpec,
} from "../run/rooms";
import { doorRects, hitDoor, type DoorRect } from "./dungeon";
import {
  canBuy,
  CONSUMABLE_DEFS_BY_ID,
  rerollShop,
  rollShop,
  roomAcorns,
  shopRerollCost,
  type ShopEntry,
  type ShopState,
} from "../run/shop";
import { baseRunStats, deriveRunStats, type RunStats } from "../run/stats";
import { maxWorldIndex } from "../unlocks";
import {
  amberTradeCost,
  BOOSTS,
  COSMETICS,
  ESPRESSO_DURATION,
  FOCUS_CAP,
  FRENZY_SECS,
  GNOME_CHOP_SECS,
  GNOME_ESPRESSO_SECS,
  GNOME_HASTE_SECS,
  GOLDEN_LOG_AMBER,
  GOLDEN_LOG_THRESHOLD,
  GOLDEN_LOG_TTL,
  HELPERS,
  accrueCacheKoi,
  accrueOverflow,
  accruePassiveFocus,
  amberLanternFull,
  BARN_MAX_PHASE,
  BARN_PHASE_NAME,
  barnPhaseCost,
  barnUnlocked,
  buildableById,
  buildableCost,
  CACHE_KOI_TTL,
  COTTAGE_MAX_PHASE,
  COTTAGE_PHASE_NAME,
  cottagePhaseCost,
  dyedPalette,
  travelAmberCost,
  travelSweatWoodCost,
  POV_GRADE_MULT,
  povYieldMult,
  SKILL_SPEED_BASE,
  SKILL_SPEED_PER_TIER,
  SKILL_SPEED_RANGE,
  BUILDABLES,
  ownedCount,
  focusHeatColor,
  getWorld,
  logStackTier,
  mixHex,
  itemDefById,
  itemGachaCost,
  itemGachaCost10x,
  koiReward,
  POWERUP_GACHA_COST,
  POWERUP_GACHA_COST_10X,
  PROVISIONS,
  SAP_PRESS_AMBER_YIELD,
  sapPressBuildCost,
  sapPressCost,
  TOKENS_PER_CHARGE,
  swingWeight,
  unlockedSwatches,
  WOOD_YIELD,
  WORKER_DEFS_BY_ID,
  WORKER_GACHA_COST,
  WORKER_GACHA_COST_10X,
  type CosmeticId,
  type ItemDef,
  type ItemEffectId,
  type ItemSlot,
  type PowerupId,
  type ProvisionId,
  type Rarity,
  type UtilityPerkId,
} from "../economy";
import { pullItem, pullPowerup, pullWorker } from "../gacha";

const HELPER_BY_ID = Object.fromEntries(HELPERS.map((h) => [h.id, h]));

/** Concrete numbers behind a just-decided fight's outcome — see
 * Game.lastOutcomeSummary()/finalizeBattleOutcome(). */
export interface BattleOutcomeSummary {
  outcome: "win" | "loss";
  /** This stage's own reward, regardless of whether the run ended here. */
  stageWood: number;
  stageAmber: number;
  /** True on a stage-5 win, or any loss — the run ended and pending rewards
   * were banked (bankedWood/bankedAmber/bankPct below); false on a win at
   * stages 1-4, where the reward is still just pending (see AdventureState). */
  runOver: boolean;
  bankedWood: number;
  bankedAmber: number;
  /** 100 normally; 50 on a non-narrow-escape loss. */
  bankPct: number;
  /** Names of party members left resting by this loss (empty on a win or a
   * narrow escape, where nobody drops to 0 HP). */
  restingNames: string[];
  narrowEscape: boolean;
}

/** What a just-opened milestone chest (stage 3 clear / stage 5 full clear)
 * actually granted — see Game.grantChest/pendingChestReveal. Unlike
 * BattleOutcomeSummary/lastOutcome, this is intentionally NOT persisted:
 * the reward itself is already applied to the save for real the instant
 * it's granted (wood/amber/shards/inventory), so there's nothing to lose by
 * an app restart clearing this — the player just doesn't get to see the
 * reveal screen replay, exactly the same acceptable tradeoff the existing
 * (also non-persisted) win/loss outcome text already has. */
export interface ChestRevealSummary {
  wood: number;
  amber: number;
  itemName: string;
  itemRarity: Rarity;
  shardRarity: Rarity;
  shardAmount: number;
  /** A homestead decoration the chest carried home, if any — credited to
   * decorStock so it can be placed for free. */
  decorName?: string;
  decorId?: string;
}
import type {
  AdventureState,
  GameSave,
} from "../game-state";
import { scheduleSave } from "../game-state";
import {
  DEFAULT_WORKER_ATK,
  effectiveAtk,
  equippedItem,
  grantXp,
  levelUpCost,
  MAX_LEVEL,
  optimizeEquipment,
  sortRosterByPower,
  stageXpReward,
  syncHp,
  type TeamMemberSave,
} from "../team";
import { playSfx } from "../sfx";
import { Effect, LeafBurst, SteamWisp, type SceneEffect } from "./effects";
import { CELL, Grid, type Cell } from "./grid";
import { FloatingText, abbrev } from "./floating-text";
import { Plot } from "./plot";
import { hashString, mulberry32 } from "./rng";
import {
  FOREMAN_WORK_FRAMES,
  NPC_IDS,
  NPCS,
  pickLine,
  type NpcId,
} from "../npc/npcs";
import { buildUsageView, type UsageView } from "../npc/usage-view";
import { renderLine, type NpcLine } from "../npc/lines";
import { Ambience, type DayPhase } from "./ambience";
import { pushHomesteadDrawables } from "./homestead";
import { renderBattleScene, renderSkillCheckTrack } from "./battle-render";
import { renderPovScene } from "./pov-render";
import {
  BATTLE_ZOOM,
  battleEnemySlot,
  battleEnemyZoom,
  battlePartySlot,
  deathSquash,
} from "./battle-layout";
import {
  drawBubble,
  hitBubble,
  hitChoice,
  layoutBubble,
  wrapLines,
  type Dialogue,
  drawAmbient,
  layoutAmbient,
} from "../npc/dialogue";
import { Sky } from "./sky";
import { pushTimberLineDrawables } from "./travel";
import {
  BARN_PHASE_SPRITES,
  BUILDABLE_SPRITES,
  ENCAMPMENT,
  CACHE_KOI,
  COTTAGE_PHASE_SPRITES,
  drawSprite,
  drawText,
  ENEMY_KIND_SPRITES,
  GLOW_LG,
  GLOW_SM,
  LANTERN_FRAME,
  LANTERN_GLASS,
  LANTERN_HOOK,
  LANTERN_POST,
  LOG,
  LOG_END,
  LOG_STAKE,
  HANDCAR_UP,
  RARITY_WOODCUTTER_SPRITES,
  RIPPLE1,
  RIPPLE2,
  SAP_PRESS_DOWN,
  SAP_PRESS_IDLE,
  SIGN_NO_AI,
  SIGNPOST_IDLE,
  SIGNPOST_SWAY,
  SLASH1,
  SLASH2,
  SPARK,
  spriteSize,
  textWidth,
  WHETSTONE,
  withPalette,
  type EnemyFrameSet,
  type PixelMap,
} from "./sprites";
import type { ManualChop, PendingChop } from "./woodcutter";
import { Tree } from "./forest";
import { Woodcutter } from "./woodcutter";

export type SkillGrade = "great" | "good" | "miss";

export interface SkillCheck {
  pos: number; // 0..100, current needle position
  dir: 1 | -1; // current sweep direction — bounces at 0/100, never times out
  speed: number; // %/sec
  zoneStart: number; // 0..100
  zoneWidth: number; // percentage points
  greatStart: number; // subset of the zone, centered
  greatWidth: number;
}

/** Simplified stand-ins for the tree behind a POV close-up — the real
 * Forest.renderTree draws in absolute plot coordinates, which don't compose
 * cleanly with the zoomed/centered POV transform, so POV just draws the
 * right silhouette for the kind directly. */
const MAX_WOODCUTTERS = 8;
const COALESCE_SECS = 0.5;
/** How long a plot/world change takes, end to end.
 *
 * This used to be a 1.4s horizontal SLIDE of two plots past each other, and
 * it looked broken because the renderer skipped its entire depth-sorted pass
 * while it ran: every tree, worker, building, NPC and the whole crossing
 * vanished, two flat bands of ground colour slid by, and the world popped
 * back. Rendering both plots' full contents at two offsets would mean
 * threading a plot + dx through every drawable in the file, for an effect
 * nobody asked for.
 *
 * A fade does the same job honestly. The world keeps rendering normally the
 * whole time — it just darkens, swaps while you cannot see it, and comes
 * back. Nothing pops because nothing was ever missing, and it is shorter
 * because a fade does not need time to travel a screen width. */
const TRANSITION_SECS = 0.7;

/** Half-width and height of a typical tree's canopy, in logical px — the
 * silhouette used when deciding whether a tree would overhang water or a
 * prop.
 *
 * Sized between the medium TREE (11x14) and the large TREE_LG (13x18) rather
 * than the elder (19x21). Which kind lands in which cell is decided later by
 * the forest's own spiral placement, so this has to cover the common cases
 * without reserving for the single biggest tree in the game — that would
 * push a wide, visibly empty ring around every lake. */
const CANOPY_HALF_W = 6;
const CANOPY_H = 14;
const WOOD_COLOR = "#f0a04a";
const TOKEN_COLOR = "#ffe9a8";
/** frenzyBurst item effect: seconds of faster swings granted on a Great POV
 * skill-check result — see Woodcutter.grantBurst/FRENZY_BURST_FACTOR. */
const FRENZY_BURST_SECS = 6;

interface ChopBuffer {
  tokens: number;
  hits: number;
  /** Summed swingWeight of every coalesced event — the damage/yield this
   * buffer is worth. Tracked alongside `hits` rather than replacing it
   * because `hits` still drives the stats counter and the swing animation
   * count, which are about how many times the axe moved, not how hard. */
  weight: number;
  age: number;
}

/** Per-swing damage/yield inputs resolveChop needs, resolved once per chop
 * from whichever member (if any) is doing the chopping — mirrors how
 * atkForWc/leadAtk already resolve `atk` alone, extended to also carry the
 * chopper's Woodchopping item yield bonus and effect (see
 * chopModsForWc/chopModsForLead). */
interface ChopMods {
  atk: number;
  /** 1 = no bonus; e.g. 1.125 = equipped item's yieldPct is +12.5%. */
  itemYieldMult: number;
  effectId?: ItemEffectId;
  effectMagnitude?: number;
}

export interface TravelStatus {
  nextName: string;
  cost: number;
  gate: number;
  gateMet: boolean;
  affordable: boolean;
}

export class Game {
  w = 180;
  h = 117;
  readonly save: GameSave;
  private skyH = 30;
  /** Passive ambient life (birds/butterflies/fireflies/leaves). Purely
   * decorative — never clickable, never touches the save or the economy. */
  private ambience = new Ambience(mulberry32(0x5eed1f));
  private sky = new Sky();
  private plot: Plot;
  private plotWorld: number;
  private nextPlot: Plot | null = null;
  private nextPlotWorld = 0;
  /** Seconds left in a plot/world change. The world renders normally the
   * whole time; this only drives how dark the overlay is (see render). */
  private transitionT = 0;
  private density = 1;
  private woodcutters = new Map<string, Woodcutter>();
  /** Live session id -> assigned roster member id (null = default-worker
   * filler). Set once per new session, kept for that session's lifetime —
   * see applySnapshot(). Runtime-only, not persisted. */
  private slotAssignment = new Map<string, string | null>();
  private floats: FloatingText[] = [];
  private buffers = new Map<string, ChopBuffer>();
  private extraCount = 0;
  private hasData = false;
  private gnomeTimer = 0;
  // Interaction layer (none of this persists except via save fields).
  private tokenCarry = 0;
  /** Separate carry-over accumulator for Focus (vs. tokenCarry above, which
   * drives Amber) — split so a focusEfficiencyPct Woodchopping item can
   * boost Focus gain without also boosting Amber. Identical to tokenCarry
   * in every tick where no such item is in play. */
  private focusCarry = 0;
  private effects: SceneEffect[] = [];
  private spot: { tree: Tree; x: number; y: number; ttl: number } | null = null;
  private spotTimer = 8;
  private goldenLog: { x: number; y: number; ttl: number } | null = null;
  /** Focus-overflow meter (see economy.ts accrueOverflow) — transient, like
   * focusCarry/tokenCarry. Earned-but-unspawned logs queue in
   * overflowLogsPending until the single golden-log slot frees up. */
  private overflowCarry = 0;
  private overflowLogsPending = 0;
  /** Cache Koi (see economy.ts's accrueCacheKoi/koiReward) — fed by
   * cache-read tokens rather than counted ones, so it accrues independently
   * of Focus/Amber/Golden-Log progress. `koi` is the one currently
   * swimming (phase = angle along Lake.koiPosition, ttl counts down to
   * despawn); null when none is up. */
  private koiCarry = 0;
  private koi: { phase: number; ttl: number } | null = null;
  /** Seconds for one full swim-path lap — slow enough to track, fast
   * enough to feel alive rather than static. */
  private static readonly KOI_SWIM_SECS = 4;
  /** Click hit-test radius (px) around the koi's current rendered center. */
  private static readonly KOI_CLICK_RADIUS = 5;
  /** Sap Press: a physical world object at the forest's edge (bottom-right,
   * a fixed screen position — deliberately NOT part of the procedural tree
   * layout, so it's always in the same reachable spot regardless of plot
   * seed) — click the lever to squeeze wood into amber (economy.pressSap),
   * replacing the old flat Boosts-tab shop card. `pressT` counts down a
   * short press animation (lever frame swap + amber-drip particles); 0 =
   * idle, clickable again. */
  /** Fractional seconds carried toward the next passive Focus charge. */
  private passiveFocusCarry = 0;
  private sapPressT = 0;
  /** Post-click sway on the Crossroads Signpost. */
  private signpostT = 0;
  private static readonly SIGNPOST_ANIM_SECS = 0.4;
  /** Countdown to the next whetstone steam wisp (see update). */
  private steamT = 0;
  /** Focus fraction above which the whetstone starts steaming — deliberately
   * higher than FOCUS_HEAT_FLOOR so glow comes first and steam reads as the
   * second, more urgent stage. */
  private static readonly STEAM_FLOOR = 0.6;
  private static readonly SAP_PRESS_ANIM_SECS = 0.35;
  private frenzyT = 0;
  private espressoT = 0;
  private animT = 0;
  // POV mode: watch one woodcutter close-up with a DBD-style skill check.
  // None of this persists — it's pure UI/interaction state, same treatment
  // as `spot`/`goldenLog` above.
  private povTarget: Woodcutter | null = null;
  /** Seconds since POV opened, driving the walk-up-to-the-tree animation. */
  private povWalkT = 0;
  private static readonly POV_WALK_SECS = 0.55;
  private povSkillCheck: SkillCheck | null = null;
  private povFlash: { grade: SkillGrade; t: number; wood: number | null } | null =
    null;

  /** What the pointer is over in the world, if it's something you can use. */
  private hoverTarget: { label: string; x: number; y: number; enabled: boolean } | null =
    null;
  /** Cell under the pointer, from the canvas mousemove. */
  private hoverCell: Cell | null = null;
  /** Buildable armed for placement, or null. */
  private buildSelection: string | null = null;
  /** The inventory panel is open. Independent of having something armed:
   * you can look in the box, and close it again, without placing anything. */
  private inventoryOpen = false;
  /** Index into save.placed of an item being moved, or null. */
  private buildMovingIndex: number | null = null;

  /** 0..1 fade on the homestead's status board.
   *
   * The board used to be painted every frame forever. That is a HUD stapled
   * to a diegetic world: the yard props already carry these three values at
   * a glance — the log pile's height is your wood, the lantern's fill is your
   * amber, the blade's heat is your focus — so a permanent numeric readout
   * both duplicates them and is the one rectangle of pure UI left in the
   * clearing. Revealed on hovering the homestead instead. Faded rather than
   * snapped so it does not blink on and off as the pointer crosses the fence. */
  private boardReveal = 0;
  private boardHovered = false;

  // --- The cast (see src/npc/) ---
  /** Latest backend telemetry, purely so NPC lines can quote it. */
  private lastSnapshot: Snapshot | null = null;
  /** Last line each NPC used, so a click never repeats itself. */
  private lastLine = new Map<NpcId, NpcLine>();
  /** An unprompted mutter currently on screen, or null. Non-modal by
   * construction — see the Ambient type in npc/dialogue. */
  private ambient: {
    speaker: { x: number; y: number };
    lines: string[];
    ttl: number;
    life: number;
  } | null = null;
  /** Seconds until the next mutter is even considered. */
  private ambientCooldown = Game.AMBIENT_MIN_GAP;
  private static readonly AMBIENT_MIN_GAP = 45;
  private static readonly AMBIENT_MAX_GAP = 90;
  private static readonly AMBIENT_LIFE = 4.5;

  // --- The Timber Line's transient state ---
  /** Open NPC conversation, or null. While set, it owns every canvas click. */
  private dialogue: Dialogue | null = null;
  private dialogueHover: number | null = null;
  /** Counts DOWN while the foreman rebuilds the span. */
  private trestleBuildT = 0;
  /** Next `trestleBuildT` threshold at which to play a hammer blow. */
  private trestleHammerNext = 0;
  /** Counts DOWN while the handcar pumps off the left edge. */
  private handcarDepartT = 0;
  private static readonly TRESTLE_BUILD_SECS = 1.5;
  private static readonly HANDCAR_DEPART_SECS = 0.7;

  /** Bare extension hook for a future item perk ("chainsaw execution on a
   * perfect skill check") — not wired to anything yet. */
  onSkillCheckResult: ((grade: SkillGrade, wc: Woodcutter) => void) | null =
    null;
  /** Set by ui/adventure.ts — lets the on-canvas "resume adventure" HUD icon
   * open the Adventure overlay directly when there's a run in progress but
   * no live battle to jump straight into (see hitAdventureIndicator). */
  onWantAdventureOverlay: (() => void) | null = null;
  /** Set by main.ts — the Crossroads Signpost standing in the clearing is the
   * in-world way into Settings. Routed through a hook because scene/* must
   * never import ui/*; main.ts points it at the same toggle the #gear button
   * uses, so both entrances share one code path. */
  onWantSettings: (() => void) | null = null;

  // Battle mode: full-window turn-based fight, same "temporarily grow the
  // widget window" pattern as POV. Turn state itself lives in
  // save.adventure.battle (persisted); battleViewOpen is only whether the
  // window is currently showing it — nothing about the fight advances off a
  // wall clock, so leaving this view is always a free, lossless pause.
  private battleViewOpen = false;
  private battleAnimQueue: TurnEvent[] = [];
  private battleAnim: { event: TurnEvent; t: number; dur: number } | null =
    null;
  private battleShakeT = 0;
  /** Shake amplitude in px, set per-hit by onBattleEventStart (damage-scaled). */
  private battleShakeMag = 4;
  private battleFlashId: string | null = null;
  private battleFlashT = 0;
  private battleEndT = 0;
  /** The one member currently mid-timing-check, and which action it's for —
   * Defend (existing) and Attack (the "Paper Mario"-style crit-timing
   * minigame — see beginBattleTiming/finishBattleTiming) share this same
   * single slot and the same underlying sweep-the-bar mechanic
   * (rollSkillCheck/advanceSkillCheck/gradeSkillCheck), just graded into a
   * different outcome. `targetEnemyId` only ever matters for "attack" —
   * threaded through to resolvePartyTurn exactly like submitTurnAction's own
   * param already does for the non-timed path. */
  private battlePendingAction: {
    memberId: string;
    action: "attack" | "defend";
    targetEnemyId?: string;
  } | null = null;
  /** Unit id -> seconds elapsed in its death collapse. A unit only enters this
   * map on the frame its HP first hits 0, so the squash plays once rather than
   * restarting every frame it stays dead. */
  private deathAnims = new Map<string, number>();
  /** Ids already seen at 0 HP, so a corpse that stays on screen (or a battle
   * resumed from a save with someone already down) doesn't re-trigger. */
  private deathSeen = new Set<string>();
  private static readonly DEATH_SECS = 0.55;

  private battleSkillCheck: SkillCheck | null = null;
  /** Seconds left of the "ignore clicks" window after a timing check opens
   * (see beginBattleTiming/handleBattleClick). */
  private battleSkillCheckGrace = 0;
  private static readonly SKILL_CHECK_GRACE_SECS = 0.22;
  private battleFlash: { grade: SkillGrade; t: number } | null = null;
  /** A finished battle is logged and has adv.battle cleared the instant
   * it's decided — never left half-applied on disk. Banking is the one
   * exception: a win/loss that leaves the party fully wiped first offers a
   * "Team Down" revive (see AdventureState.pendingRevival/resolveRevival),
   * so bankAdventure may not run until that's resolved. These three hold
   * just enough to keep rendering the scene for a brief summary beat
   * afterward, since save.adventure may already be null by then (a
   * run-ending win/loss also clears it via bankAdventure). */
  private lastBattleSnapshot: BattleSnapshot | null = null;
  private lastBattleWorld = 0;
  private lastBattlePartyIds: string[] = [];
  /** Concrete numbers for the just-finished fight's outcome screen (see
   * ui/battle.ts's showOutcome) — stashed at finalize time since a
   * run-ending win/loss already banks + clears save.adventure, so by the
   * time the UI reads this the pending/adv numbers it would want are gone. */
  private lastOutcome: BattleOutcomeSummary | null = null;
  /** A just-opened milestone chest, awaiting dismissal — see grantChest/
   * pendingChestReveal/dismissChestReveal. Session-only, not persisted (see
   * ChestRevealSummary for why that's safe). */
  private chestReveal: ChestRevealSummary | null = null;

  constructor(save: GameSave) {
    this.save = save;
    this.plotWorld = save.worldIndex;
    this.plot = this.makePlot(save.worldIndex, save.plotIndex);
    if (save.currentPlotHp) {
      this.plot.forest.restoreHp(save.currentPlotHp);
    }
    this.layout();
    this.refreshModifiers();
    // Wires the chainsawExecution/frenzyBurst Woodchopping item effects to
    // every POV skill-check result (see applyWoodchoppingItemEffects).
    // timberSplash is applied inside resolveChop instead — see there for why.
    this.onSkillCheckResult = (grade, wc) =>
      this.applyWoodchoppingItemEffects(grade, wc);

    // Resuming mid-decision after a genuine app restart — a pending offer, a
    // pending revive, an unanswered door, or a half-resolved event room. The
    // room that produced it is already decided, but lastBattleSnapshot (alive
    // only for the rest of THIS session — see its own doc comment) starts null
    // on a fresh process, which would leave renderBattle with nothing to draw
    // behind the reward UI: a black chamber with a card panel floating in it.
    //
    // Seeding a minimal already-decided snapshot fixes that. Nothing runs turn
    // logic against it — resolveTurn is never called with this — so which room
    // it names does not matter, only that it is a real one.
    //
    // The door and event cases are easy to forget here precisely because they
    // are new; leaving them out is a black-screen bug that only appears after a
    // restart, which is the hardest kind to notice while building.
    if (
      save.adventure?.pendingOffer ||
      save.adventure?.pendingRevival ||
      save.adventure?.pendingExits ||
      save.adventure?.pendingRoom
    ) {
      const adv = save.adventure;
      this.lastBattleSnapshot = {
        enemies: buildEnemy(adv.world, roomTier(adv.roomsCleared)).map((spec, index) => ({
          id: `enemy-${index}`,
          spec,
          hp: 0,
        })),
        round: 1,
        turnOrder: [],
        turnIndex: 0,
        phase: "done",
        guarding: {},
        reflectBonus: 0,
        lastStandArmed: false,
        charmed: false,
        roped: false,
        narrowEscape: false,
        enemyTurnCount: 0,
        skipNext: {},
        roundDamage: {},
        events: [],
        outcome: "win",
      };
      this.lastBattleWorld = adv.world;
      this.lastBattlePartyIds = [...adv.partyIds];
    }
  }

  /** Fired whenever a run beat resolves and the reward flow should re-check
   * what is pending. Mirrors the existing onWantAdventureOverlay hook: Game
   * owns the state, ui/battle.ts owns the screens, and neither polls the
   * other. */
  onRunBeatResolved?: () => void;

  private makePlot(world: number, plotIndex: number): Plot {
    return new Plot(
      hashString(`w${world}-p${plotIndex}`),
      getWorld(world).mult,
    );
  }

  private has(helper: string): boolean {
    return (this.save.helpers as string[]).includes(helper);
  }

  hasPowerup(id: PowerupId): boolean {
    return (this.save.powerups as string[]).includes(id);
  }

  // --- team / gacha ---------------------------------------------------

  private memberById(id: string): TeamMemberSave | undefined {
    return this.save.team.find((m) => m.id === id);
  }

  private rarityForMember(
    memberId: string | null,
  ): "common" | "rare" | "epic" | "legendary" {
    if (!memberId) return "common";
    const member = this.memberById(memberId);
    if (!member) return "common";
    return WORKER_DEFS_BY_ID[member.defId]?.rarity ?? "common";
  }

  /** Rarity of `memberId`'s equipped Woodchopping item, defaulting to
   * "common" for a null/filler member (over-cap workers with no roster
   * assignment) or a member with nothing equipped — Woodchopping always
   * shows a weapon (never bare-handed), so "no item" just means "draw the
   * common-tier axe" rather than "draw nothing", unlike Adventuring/Battle
   * (see the party-member loop in renderBattle). */
  private weaponRarityForMember(memberId: string | null): Rarity {
    if (!memberId) return "common";
    const member = this.memberById(memberId);
    if (!member) return "common";
    return (
      equippedItem(member, "woodchopping", this.save.inventory)?.rarity ??
      "common"
    );
  }

  /** `memberId`'s WorkerDef.accent (per-character palette overlay, Part E),
   * or null for a filler/unassigned slot — sibling to rarityForMember()/
   * weaponRarityForMember() above, feeding Woodcutter.accent the same way
   * those feed `rarity`/`weaponRarity`. */
  private accentForMember(
    memberId: string | null,
  ): Record<string, string> | null {
    if (!memberId) return null;
    const member = this.memberById(memberId);
    if (!member) return null;
    return WORKER_DEFS_BY_ID[member.defId]?.accent ?? null;
  }

  /** Pick the highest-priority available, unclaimed roster member for a
   * brand-new live session slot. Existing sessions keep whatever they were
   * first assigned — see applySnapshot(). */
  private pickMember(excludeSourceId: string): string | null {
    const taken = new Set<string>();
    for (const [sourceId, memberId] of this.slotAssignment) {
      if (sourceId !== excludeSourceId && memberId) taken.add(memberId);
    }
    for (const member of this.save.team) {
      if (member.status === "available" && !taken.has(member.id)) {
        return member.id;
      }
    }
    return null;
  }

  /** Damage dealt by a specific woodcutter this swing. */
  private atkForWc(wc: Woodcutter): number {
    if (wc.variant === "gnome") return this.leadAtk();
    if (wc.memberId) {
      const member = this.memberById(wc.memberId);
      if (member)
        return effectiveAtk(
          member,
          this.save.inventory,
          this.save.prestigeLevel,
        );
    }
    return DEFAULT_WORKER_ATK;
  }

  /** Best currently-assigned member's ATK — used by gnomes and the
   * over-cap fallback path, which have no sprite of their own. */
  private leadAtk(): number {
    let best = DEFAULT_WORKER_ATK;
    for (const memberId of this.slotAssignment.values()) {
      if (!memberId) continue;
      const member = this.memberById(memberId);
      if (member)
        best = Math.max(
          best,
          effectiveAtk(member, this.save.inventory, this.save.prestigeLevel),
        );
    }
    // Fall back to the strongest member on the ROSTER when no slots are
    // assigned. Slots only fill while a Claude Code session is live, so
    // without this a manual click swung at an idle forest did
    // DEFAULT_WORKER_ATK (1) damage no matter how geared the team was —
    // against tree HP that scales 10x per world, that's 500 clicks to fell
    // one tree at World 2 and 10,000 at World 4. The click still paid out
    // wood (chips scale with the world mult), so it read as "I get wood but
    // the tree never falls".
    //
    // This is not an infinite-damage tap: every manual chop costs 1 Focus,
    // and Focus is capped (FOCUS_CAP) and only refills from real token usage,
    // so the number of swings stays bounded by exactly the same meter it
    // always was. It just makes those swings land as hard as your team
    // actually hits.
    if (best === DEFAULT_WORKER_ATK) {
      for (const member of this.save.team) {
        best = Math.max(
          best,
          effectiveAtk(member, this.save.inventory, this.save.prestigeLevel),
        );
      }
    }
    return best;
  }

  /** Best currently-assigned member's equipped Woodchopping yieldPct bonus,
   * as a multiplier (1 = none) — the yield-side counterpart of leadAtk,
   * used by every chop that isn't tied to one specific woodcutter sprite. */
  private leadYieldMult(): number {
    let best = 1;
    for (const memberId of this.slotAssignment.values()) {
      if (!memberId) continue;
      const member = this.memberById(memberId);
      if (!member) continue;
      const item = equippedItem(member, "woodchopping", this.save.inventory);
      best = Math.max(best, 1 + (item?.woodchopping?.yieldPct ?? 0));
    }
    return best;
  }

  /** Damage + yield/effect inputs for a specific woodcutter's swing — the
   * per-member counterpart to chopModsForLead(), pulling the chopper's
   * equipped Woodchopping item's yieldPct/effectId/effectMagnitude the same
   * way atkForWc already pulls their atk. */
  private chopModsForWc(wc: Woodcutter): ChopMods {
    const atk = this.atkForWc(wc);
    if (wc.variant === "gnome" || !wc.memberId) {
      return { atk, itemYieldMult: this.leadYieldMult() };
    }
    const member = this.memberById(wc.memberId);
    const item = member
      ? equippedItem(member, "woodchopping", this.save.inventory)
      : null;
    return {
      atk,
      itemYieldMult: 1 + (item?.woodchopping?.yieldPct ?? 0),
      effectId: item?.effectId,
      effectMagnitude: item?.effectMagnitude,
    };
  }

  /** Chop mods for a chop with no specific woodcutter sprite behind it
   * (manual clicks, golden-spot bursts, over-cap buffer flushes) — uses the
   * same "best currently-assigned member" fallback leadAtk already used. */
  private chopModsForLead(): ChopMods {
    return { atk: this.leadAtk(), itemYieldMult: this.leadYieldMult() };
  }

  pullWorkerGacha(count: 1 | 10): ReturnType<typeof pullWorker>[] {
    const cost = count === 10 ? WORKER_GACHA_COST_10X : WORKER_GACHA_COST;
    if (this.save.wood < cost) return [];
    this.save.wood -= cost;
    const results = Array.from({ length: count }, () => pullWorker(this.save));
    scheduleSave(this.save, true);
    return results;
  }

  pullItemGacha(world: number, count: 1 | 10): ReturnType<typeof pullItem>[] {
    if (world > this.save.worldIndex) return [];
    const cost = count === 10 ? itemGachaCost10x(world) : itemGachaCost(world);
    if (this.save.wood < cost) return [];
    this.save.wood -= cost;
    const results = Array.from({ length: count }, () =>
      pullItem(this.save, world),
    );
    scheduleSave(this.save, true);
    return results;
  }

  pullPowerupGacha(count: 1 | 10): ReturnType<typeof pullPowerup>[] {
    const cost = count === 10 ? POWERUP_GACHA_COST_10X : POWERUP_GACHA_COST;
    if (this.save.wood < cost) return [];
    this.save.wood -= cost;
    const results = Array.from({ length: count }, () => pullPowerup(this.save));
    scheduleSave(this.save, true);
    return results;
  }

  /** Clears `instanceId` out of every team member's equipped slots
   * (woodchopping/adventuring/utility/utility2), wherever it currently
   * appears — an item instance must never be equipped in more than one
   * place at once. Calls syncHp on any member actually changed, since
   * losing a stat-bearing item can shrink their maxHp. Used by equipItem
   * to make moving gear between (or within) members a safe, automatic
   * "unequip from wherever it was, then equip here" transfer. */
  private unequipInstanceEverywhere(instanceId: string): void {
    for (const other of this.save.team) {
      let changed = false;
      if (other.equipped.woodchopping === instanceId) {
        other.equipped.woodchopping = null;
        changed = true;
      }
      if (other.equipped.adventuring === instanceId) {
        other.equipped.adventuring = null;
        changed = true;
      }
      if (other.equipped.utility === instanceId) {
        other.equipped.utility = null;
        changed = true;
      }
      if (other.equipped.utility2 === instanceId) {
        other.equipped.utility2 = null;
        changed = true;
      }
      if (changed) syncHp(other, this.save.inventory, this.save.prestigeLevel);
    }
  }

  /** `slot` defaults to the item's own slot; pass "utility2" explicitly to
   * target the extraUtility Power-up's second Utility slot instead — since
   * a Utility item's def.slot is always just "utility", there's no other
   * way to tell the two slots apart. Refuses "utility2" for a non-Utility
   * item or without the Power-up owned. An item instance already equipped
   * elsewhere (on this member or any other) is automatically unequipped
   * from there first, so a single click safely transfers gear between
   * workers instead of ending up double-equipped. */
  equipItem(
    memberId: string,
    instanceId: string,
    slot?: ItemSlot | "utility2",
  ): boolean {
    const member = this.memberById(memberId);
    const inst = this.save.inventory.find((i) => i.id === instanceId);
    if (!member || !inst) return false;
    const def = itemDefById(inst.defId);
    if (!def) return false;
    const targetSlot = slot ?? def.slot;
    if (targetSlot === "utility2") {
      if (def.slot !== "utility" || !this.hasPowerup("extraUtility"))
        return false;
      this.unequipInstanceEverywhere(instanceId);
      member.equipped.utility2 = instanceId;
    } else {
      if (def.slot !== targetSlot) return false;
      this.unequipInstanceEverywhere(instanceId);
      member.equipped[targetSlot] = instanceId;
    }
    syncHp(member, this.save.inventory, this.save.prestigeLevel);
    scheduleSave(this.save, true);
    return true;
  }

  unequipItem(memberId: string, slot: ItemSlot | "utility2"): boolean {
    const member = this.memberById(memberId);
    if (!member) return false;
    if (slot === "utility2") member.equipped.utility2 = null;
    else member.equipped[slot] = null;
    syncHp(member, this.save.inventory, this.save.prestigeLevel);
    scheduleSave(this.save, true);
    return true;
  }

  reorderTeam(memberId: string, newIndex: number): boolean {
    const idx = this.save.team.findIndex((m) => m.id === memberId);
    if (idx === -1) return false;
    const clamped = Math.max(0, Math.min(newIndex, this.save.team.length - 1));
    const [member] = this.save.team.splice(idx, 1);
    this.save.team.splice(clamped, 0, member);
    scheduleSave(this.save, true);
    return true;
  }

  levelUpMember(memberId: string): boolean {
    const member = this.memberById(memberId);
    if (!member || member.level >= MAX_LEVEL) return false;
    const def = WORKER_DEFS_BY_ID[member.defId];
    const rarity = def?.rarity ?? "common";
    const cost = levelUpCost(member);
    if (this.save.shards[rarity] < cost) return false;
    this.save.shards[rarity] -= cost;
    member.level += 1;
    syncHp(member, this.save.inventory, this.save.prestigeLevel);
    scheduleSave(this.save, true);
    return true;
  }

  // --- adventure mode ---------------------------------------------------
  //
  // Turn-based, player-paced: progress is a strict function of explicit
  // paid actions. Nothing here is touched by update(dt) — walking away is
  // always free, and there's nothing to "miss" by not watching.

  private partyFor(ids: string[]): TeamMemberSave[] {
    return ids
      .map((id) => this.memberById(id))
      .filter((m): m is TeamMemberSave => !!m);
  }

  /** Bank a fraction of the pending run rewards, release the party back to
   * the roster, and end the run. Shared by a win-clear, a loss, and an
   * explicit retreat. Returns the actual amounts banked so callers (the
   * outcome-summary builder below) can show real numbers instead of
   * re-deriving them after save.adventure is already gone. */
  private bankAdventure(pct: number): { wood: number; amber: number } {
    const s = this.save;
    const adv = s.adventure;
    if (!adv) return { wood: 0, amber: 0 };
    const wood = Math.floor(adv.pendingWood * pct);
    const amber = Math.floor(adv.pendingAmber * pct);
    s.wood += wood;
    s.amber += amber;
    s.totalWoodEarned += wood;
    s.stats.woodFromAdventures += wood;
    for (const id of adv.partyIds) {
      const m = this.memberById(id);
      if (m && m.status === "adventuring") {
        m.status = m.currentHp > 0 ? "available" : "resting";
      }
    }
    s.adventure = null;
    return { wood, amber };
  }

  /** Finalizes an already-decided loss for real: marks any still-downed
   * party members resting (skipped on a narrow escape, where nobody's
   * actually at 0 HP — see battle.ts's `roped` save), bumps the
   * adventuresFailed stat, banks the appropriate fraction of pending
   * rewards (50% normally, 100% on a narrow escape) via bankAdventure, and
   * refreshes lastOutcome/lastOutcomeSummary() so the UI's post-decision
   * recap (see ui/battle.ts's showOutcome) reflects the real banked
   * numbers. Shared by finalizeBattleOutcome's loss branch (the
   * deadCount === 0 fallback there — not actually reachable, since a
   * "loss" outcome from battle.ts always means a full wipe, but kept so
   * that path stays honest) and resolveRevival's "skip"/failed-afford
   * branch for a full-wipe Team Down offer — same "the wipe is now final"
   * work either way, just possibly deferred behind a revive decision
   * first (see AdventureState.pendingRevival.afterWipe). */
  private finalizeLoss(adv: AdventureState, battle: BattleSnapshot): void {
    const s = this.save;
    s.stats.adventuresFailed += 1;
    const restingNames: string[] = [];
    if (!battle.narrowEscape) {
      for (const id of adv.partyIds) {
        const m = this.memberById(id);
        if (m && m.currentHp <= 0) {
          m.status = "resting";
          restingNames.push(WORKER_DEFS_BY_ID[m.defId]?.name ?? m.defId);
        }
      }
    } else {
      adv.carried = adv.carried.filter((p) => p !== "emergencyRope");
    }
    const bankPct = battle.narrowEscape ? 100 : 50;
    const banked = this.bankAdventure(bankPct / 100);
    this.lastOutcome = {
      outcome: "loss",
      stageWood: 0,
      stageAmber: 0,
      runOver: true,
      bankedWood: banked.wood,
      bankedAmber: banked.amber,
      bankPct,
      restingNames,
      narrowEscape: battle.narrowEscape,
    };
  }

  /** Read-only preview for the Muster screen — win odds + expected reward
   * against stage 1, averaged over 200 simulated auto-battles against a
   * cloned party (same engine as the real fight — see battle.ts). */
  previewAdventure(
    world: number,
    partyIds: string[],
  ): { cost: number; winPct: number; avgWoodOnWin: number } | null {
    if (
      world > this.save.worldIndex ||
      partyIds.length < 1 ||
      partyIds.length > 3
    )
      return null;
    const party = this.partyFor(partyIds);
    if (party.length !== partyIds.length) return null;
    const mult = getWorld(world).mult;
    const cost = embarkCost(mult);
    const { winPct, avgWoodOnWin } = previewBattle(
      party,
      buildEnemy(world, 1),
      this.save.inventory,
      this.save.prestigeLevel,
    );
    return { cost, winPct, avgWoodOnWin };
  }

  /** The Muster screen's go/no-go verdict for the world the player is
   * actually standing in.
   *
   * This replaces a row of per-world buttons. That row asked the player a
   * question the game is better placed to answer — it listed every unlocked
   * world with its wood multiplier and left "is my gear good enough for this
   * one" entirely to them, with no information on the screen that could
   * settle it. The answer is knowable: `previewRun` walks the real twelve-
   * room tier ladder with HP carrying over, so it can say how deep this
   * party gets before it is worn down.
   *
   * Bands are set on expected rooms cleared out of twelve, calibrated
   * against the pessimistic floor previewRun deliberately reports (no boons,
   * no heals, always-Attack — see its doc comment):
   *   - `red`    — under a third of the run. The party is outclassed here,
   *                not unlucky, and the advice is to drop back a world.
   *   - `amber`  — reaches Depth II but not the end. A real run's boons and
   *                fountains can close a gap this size, hence "a chance".
   *   - `green`  — clears most of the ladder before any run upgrades at all.
   *
   * `betterWorld` is the concrete navigation the verdict implies: the
   * highest unlocked world this party still reads green in, or null when it
   * is already there. Naming the destination is the difference between a
   * warning and an instruction.
   */
  previewWorldReadiness(partyIds: string[]): {
    world: number;
    worldName: string;
    cost: number;
    band: "red" | "amber" | "green";
    avgRoomsCleared: number;
    roomsTotal: number;
    betterWorld: number | null;
  } | null {
    const world = this.save.worldIndex;
    if (partyIds.length < 1 || partyIds.length > 3) return null;
    const party = this.partyFor(partyIds);
    if (party.length !== partyIds.length) return null;

    const bandFor = (w: number): { band: "red" | "amber" | "green"; run: ReturnType<typeof previewRun> } => {
      const tiers = Array.from({ length: TOTAL_ROOMS }, (_, i) => buildEnemy(w, roomTier(i)));
      const run = previewRun(party, tiers, this.save.inventory, this.save.prestigeLevel);
      return { band: readinessBand(run.avgRoomsCleared, run.roomsTotal), run };
    };

    const here = bandFor(world);
    // Only searched when the current world is a bad bet — an amber/green
    // verdict needs no alternative, and each probe is a full 40-trial run
    // simulation.
    let betterWorld: number | null = null;
    if (here.band === "red") {
      for (let w = world - 1; w >= 0; w--) {
        if (bandFor(w).band === "green") {
          betterWorld = w;
          break;
        }
      }
    }

    return {
      world,
      worldName: getWorld(world).name,
      cost: embarkCost(getWorld(world).mult),
      band: here.band,
      avgRoomsCleared: here.run.avgRoomsCleared,
      roomsTotal: here.run.roomsTotal,
      betterWorld,
    };
  }

  /** Deducts the embark cost and opens the interactive fight for stage 1 —
   * the embark cost IS the first attempt, no separate fee. */
  startAdventure(
    world: number,
    partyIds: string[],
    carried: ProvisionId[],
    keepsake?: PatronId | null,
  ): boolean {
    const s = this.save;
    if (s.adventure) return false;
    if (world > s.worldIndex || partyIds.length < 1 || partyIds.length > 3)
      return false;
    if (new Set(partyIds).size !== partyIds.length) return false;
    const party = this.partyFor(partyIds);
    if (party.length !== partyIds.length) return false;
    if (party.some((m) => m.status !== "available")) return false;
    const cost = embarkCost(getWorld(world).mult);
    if (s.wood < cost) return false;

    // Pack Mule (prestige-unlocked Power-up): carry 3 provisions, base 2.
    const carryCap = this.hasPowerup("packMule") ? 3 : 2;
    const cappedCarried = carried
      .filter((id) => (s.provisions[id] ?? 0) > 0 && id !== "trailRations")
      .slice(0, carryCap);
    for (const id of cappedCarried) s.provisions[id] -= 1;

    s.wood -= cost;
    for (const m of party) m.status = "adventuring";

    // One seed for the whole run. The map, every offer and every stall derive
    // from it, so a run is reproducible from a single number — which is what
    // makes a resumed run show the doors and cards it was already showing.
    const seed = hashString(`${new Date().toISOString()}-${world}-${partyIds.join()}`);
    // Dry Wells removes the pre-boss springs, which is a MAP property, so it
    // has to be decided when the map is generated rather than when a fountain
    // is walked into.
    const map = generateRunMap(seed, { noFountains: (s.pact ?? []).includes("dryWells") });
    const rank = groveRank(s.pact ?? []);

    s.adventure = {
      world,
      partyIds: [...partyIds],
      roomsCleared: 0,
      seed,
      map,
      currentRoomId: map.slots[0][0].id,
      pendingExits: null,
      pendingRoom: null,
      acorns: 0,
      boonList: [],
      charms: [],
      curses: [],
      bark: {},
      rerollsLeft: BASE_REROLLS,
      shop: null,
      keepsake: keepsake ?? null,
      // Snapshotted at embark so changing the pact mid-run cannot retroactively
      // change what this run pays out.
      groveRank: rank,
      pact: [...(s.pact ?? [])],
      pendingWood: 0,
      pendingAmber: 0,
      carried: cappedCarried,
      abilityUsed: false,
      startedAt: new Date().toISOString(),
      log: [],
      battle: null,
      pendingOffer: null,
      pendingRevival: null,
      freeReviveUsed: false,
    };
    s.stats.adventuresEmbarked += 1;
    this.enterRoom(map.slots[0][0]);
    return true;
  }

  /** Persists a change the UI made directly to `save` (the pact toggles are
   * the only such case — they are pre-run configuration, not a run action, so
   * they have no natural Game method of their own). */
  persist(): void {
    scheduleSave(this.save, true);
  }

  /** The run's derived build — one call, used by combat, the ledger and every
   * reward screen so none of them can disagree about what the player has. */
  runStats(): RunStats {
    const s = this.save;
    const adv = s.adventure;
    if (!adv) return baseRunStats();
    return deriveRunStats({
      party: this.partyFor(adv.partyIds),
      inventory: s.inventory,
      prestigeLevel: s.prestigeLevel,
      boonList: adv.boonList,
      charms: adv.charms,
      curses: adv.curses,
      carried: adv.carried,
      world: adv.world,
    });
  }

  /** The room the party is standing in, or null between rooms. */
  currentRoom(): RoomSpec | null {
    const adv = this.save.adventure;
    if (!adv?.currentRoomId) return null;
    return roomById(adv.map, adv.currentRoomId);
  }

  /** The doors awaiting a choice, resolved from their persisted ids. Null
   * whenever the party is not standing at a junction. */
  exitOffer(): RoomSpec[] | null {
    const adv = this.save.adventure;
    if (!adv?.pendingExits) return null;
    const rooms = adv.pendingExits.map((id) => roomById(adv.map, id)).filter((r): r is RoomSpec => !!r);
    return rooms.length > 0 ? rooms : null;
  }

  /** A non-combat room awaiting resolution. */
  pendingRoomEvent(): { roomId: string; kind: string } | null {
    return this.save.adventure?.pendingRoom ?? null;
  }

  /** True when the party has just cleared a Depth boss and the run continues —
   * the run's "descend or bank" moment, and the only place a toll is charged. */
  depthCleared(): { depth: number; toll: number } | null {
    const adv = this.save.adventure;
    if (!adv || adv.pendingExits || adv.pendingRoom || adv.pendingOffer || adv.pendingRevival) return null;
    if (!isDepthBoundary(adv.roomsCleared - 1)) return null;
    return {
      depth: depthOf(adv.roomsCleared - 1),
      toll: descentToll(getWorld(adv.world).mult, depthOf(adv.roomsCleared)),
    };
  }

  acorns(): number {
    return this.save.adventure?.acorns ?? 0;
  }

  heldBoons(): BoonInstance[] {
    return this.save.adventure?.boonList ?? [];
  }

  /**
   * Enters a room: either opens its fight, or hands a non-combat room to the
   * event flow.
   *
   * The single funnel for "the party is now somewhere new", so anything that
   * must happen on arrival — curse countdown, Bark carried in from the last
   * room — happens exactly once and in one place.
   */
  private enterRoom(room: RoomSpec): void {
    const s = this.save;
    const adv = s.adventure;
    if (!adv) return;
    adv.currentRoomId = room.id;
    adv.pendingExits = null;

    if (room.kind === "fight" || room.kind === "elite" || room.kind === "boss") {
      this.startRoomBattle(room);
      return;
    }
    // Non-combat rooms resolve through the event flow, which the battle view
    // drives with a canvas dialogue rather than a DOM panel.
    adv.pendingRoom = { roomId: room.id, kind: room.kind };
    if (room.kind === "shop") {
      adv.shop = rollShop(this.offerContext(), depthOf(adv.roomsCleared), adv.seed + adv.roomsCleared * 7919, adv.charms);
    }
    this.battleViewOpen = true;
    scheduleSave(s, true);
    this.onRunBeatResolved?.();
  }

  private startRoomBattle(room: RoomSpec): void {
    const s = this.save;
    const adv = s.adventure;
    if (!adv) return;
    const party = this.partyFor(adv.partyIds);
    // The room's affix is what makes an elite door's promise real — without
    // this the sigil would announce "Armoured, bring status damage" over a
    // fight that behaved exactly like every other one.
    const enemies = buildEnemy(
      adv.world,
      roomTier(adv.roomsCleared),
      room.affix as EliteAffixId | undefined,
      // The pact the run EMBARKED under, not the one currently switched on —
      // toggling a modifier mid-run must not retroactively change the fight
      // the player is standing in, nor what it pays out.
      pactEnemyScaling(adv.pact ?? []),
    );
    const stats = this.runStats();
    adv.battle = startBattle(party, enemies, s.inventory, {
      charmed: adv.carried.includes("fortuneCharm"),
      roped: adv.carried.includes("emergencyRope"),
      stats,
    });
    // Bark is the one status that outlives a battle — it is a wall the party
    // built and carried, not a wound the last room left. Restoring it here
    // rather than at pick time keeps the carry rule in one place.
    for (const [memberId, shield] of Object.entries(adv.bark)) {
      if (shield <= 0) continue;
      adv.battle.statuses = adv.battle.statuses ?? {};
      adv.battle.statuses[memberId] = { bark: { stacks: shield, rounds: 0, potency: 1 } };
    }
    this.battleAnimQueue = [];
    this.battleAnim = null;
    this.battleEndT = 0;
    // A fresh battle never inherits UI-interaction state from whatever
    // came before it (a stray Defend skill-check from an abandoned fight,
    // a still-decaying hit flash, etc.) — see retreatAdventure() for the
    // matching cleanup when a mid-flight battle is abandoned instead.
    this.battleSkillCheck = null;
    this.battlePendingAction = null;
    this.battleFlash = null;
    this.battleFlashId = null;
    this.battleFlashT = 0;
    this.battleShakeT = 0;
    if (this.povTarget) this.exitPov();
    this.closeDialogue();
    this.battleViewOpen = true;
    scheduleSave(s, true);
  }

  /** Takes a door. Pays the descent toll when crossing into a new Depth. */
  pickExit(roomId: string): boolean {
    const s = this.save;
    const adv = s.adventure;
    if (!adv?.pendingExits?.includes(roomId)) return false;
    const room = roomById(adv.map, roomId);
    if (!room) return false;
    if (isDepthBoundary(adv.roomsCleared - 1)) {
      const toll = descentToll(getWorld(adv.world).mult, room.depth);
      if (s.wood < toll) return false;
      s.wood -= toll;
    }
    this.enterRoom(room);
    return true;
  }

  /** The offer context, assembled from the run and the build. One place, so
   * the shop and the reward screen can never disagree about what is legal. */
  private offerContext(): OfferContext {
    const s = this.save;
    const adv = s.adventure;
    const stats = this.runStats();
    return {
      held: adv?.boonList ?? [],
      prestigeLevel: s.prestigeLevel,
      favor: s.patronFavor,
      rarityLuck: stats.values.rarityLuck,
      extraCards:
        stats.values.extraOfferCount - ((adv?.pact ?? []).includes("leanOfferings") ? 1 : 0),
      keepsake: adv?.keepsake ?? null,
    };
  }

  /** Whoever's turn it currently is, or null if no battle is active. */
  currentBattleActorId(): string | null {
    const battle = this.save.adventure?.battle;
    if (!battle || battle.outcome) return null;
    return battle.turnOrder[battle.turnIndex] ?? null;
  }

  /** Canvas-space position of the current actor's formation slot — public
   * passthrough to the private battlePartySlot() lookup, for the floating
   * action-bubble UI (ui/battle.ts) to anchor itself to. Index is the
   * member's position in adv.partyIds (front/backLeft/backRight), same
   * ordering renderBattle already draws by. Null whenever there's no live
   * battle or the actor isn't part of the current party (shouldn't happen,
   * but the UI has nothing sane to anchor to either way). */
  currentBattleActorScreenPos(): { x: number; y: number } | null {
    const adv = this.save.adventure;
    const actorId = this.currentBattleActorId();
    if (!adv || !actorId) return null;
    const index = adv.partyIds.indexOf(actorId);
    if (index < 0) return null;
    return battlePartySlot(index, this);
  }

  /** Screen position (logical canvas px) of the TOP OF THE HEAD of a battle
   * unit — party member or enemy alike — for ui/battle.ts to hang its
   * floating nameplate above. Battle sprites are drawn feet-anchored at
   * their slot (`drawSprite(..., -size.h)` after translating to slot.y), so
   * the head is simply slot.y minus the scaled sprite height.
   *
   * Deliberately measured off each unit's IDLE frame rather than its
   * CURRENT pose: a windup frame is taller than a strike frame, so keying
   * off the live pose made the plate jump a few px on every swing. The
   * plate holding still while the sprite animates under it is the point —
   * it reads as a fixed label, not another moving part. Same reason it
   * ignores the idle bob and lunge offsets.
   *
   * Null when `id` isn't a unit in the current battle. */
  battleUnitHeadPos(id: string): { x: number; y: number } | null {
    const battle = this.battleSnapshot();
    if (!battle) return null;
    const enemyIdx = battle.enemies.findIndex((u) => u.id === id);
    if (enemyIdx >= 0) {
      const unit = battle.enemies[enemyIdx];
      const frames =
        ENEMY_KIND_SPRITES[unit.spec.kind as keyof typeof ENEMY_KIND_SPRITES] ??
        ENEMY_KIND_SPRITES.protestor;
      const slot = battleEnemySlot(enemyIdx, battle.enemies.length, this);
      const zoom = battleEnemyZoom(enemyIdx, battle.enemies.length);
      // Protestors hold a picket sign ABOVE their heads (see renderBattle's
      // SIGN_NO_AI draw), so their true silhouette is taller than the body
      // sprite. Without this the nameplate landed on top of the placard and
      // the two overlapping bits of art read as one unreadable smear.
      const overhead =
        unit.spec.kind === "protestor" ? spriteSize(SIGN_NO_AI).h * 1.6 : 0;
      return {
        x: slot.x,
        y: slot.y - spriteSize(frames.idle).h * zoom - overhead,
      };
    }
    const partyIds = this.save.adventure?.partyIds ?? this.lastBattlePartyIds;
    const idx = partyIds.indexOf(id);
    if (idx < 0) return null;
    const member = this.save.team.find((m) => m.id === id);
    const rarity =
      (member && WORKER_DEFS_BY_ID[member.defId]?.rarity) || "common";
    const slot = battlePartySlot(idx, this);
    const zoom =
      BATTLE_ZOOM[idx] ?? BATTLE_ZOOM[BATTLE_ZOOM.length - 1];
    return {
      x: slot.x,
      y: slot.y - spriteSize(RARITY_WOODCUTTER_SPRITES[rarity].stand).h * zoom,
    };
  }

  /** Read-only battle state for the UI to render — falls back to the last
   * finished battle's snapshot during its brief post-outcome summary beat,
   * since a run-ending win/loss already clears save.adventure.battle (and
   * possibly save.adventure itself) the instant it's decided. */
  battleSnapshot(): BattleSnapshot | null {
    return this.save.adventure?.battle ?? this.lastBattleSnapshot;
  }

  battleAwaitingSkillCheck(): boolean {
    return this.battleSkillCheck !== null;
  }

  /** Which action the live timing check (if any) is actually for — lets the
   * UI label/color the sweep track "Attack" (crit-timing) vs "Defend"
   * (mitigation-timing) instead of one generic look for both. */
  battlePendingActionKind(): "attack" | "defend" | null {
    return this.battlePendingAction?.action ?? null;
  }

  /** True while a queued turn event is still animating — the DOM action
   * menu waits for this so the player can't fire the next turn faster than
   * the current one's animation, keeping turns readable one at a time. */
  battleAnimating(): boolean {
    return this.battleAnim !== null || this.battleAnimQueue.length > 0;
  }

  /** True once an equipped Adventuring-slot item on this member has an
   * effect AND the once-per-run charge hasn't been spent yet. */
  battleCanAbility(memberId: string): boolean {
    const adv = this.save.adventure;
    if (!adv || adv.abilityUsed) return false;
    const member = this.memberById(memberId);
    if (!member) return false;
    return !!equippedItem(member, "adventuring", this.save.inventory)?.effectId;
  }

  /** Ability goes straight through; Attack and Defend both open a canvas
   * timing skill-check first (see finishBattleTiming)
   * rather than submitting immediately — the floating-bubble battle UI
   * (ui/battle.ts) has no button-click-submits-instantly path anymore.
   * `targetEnemyId` is only meaningful for "attack" (see resolvePartyTurn) —
   * the UI only ever supplies one when the player explicitly picked a
   * living enemy from the multi-enemy target list; omitted (a single-enemy
   * fight, or the player never picked) falls back to the engine's own
   * lowest-index-living-enemy default. */
  submitTurnAction(
    memberId: string,
    action: BattleAction,
    targetEnemyId?: string,
  ): TurnEvent[] {
    if (action === "defend") {
      this.beginBattleTiming(memberId, "defend");
      return [];
    }
    if (action === "attack") {
      this.beginBattleTiming(memberId, "attack", targetEnemyId);
      return [];
    }
    return this.applyTurnAction(
      memberId,
      action,
      undefined,
      undefined,
      undefined,
    );
  }

  private applyTurnAction(
    memberId: string,
    action: BattleAction,
    defendGrade: SkillGrade | undefined,
    targetEnemyId?: string,
    attackGrade?: SkillGrade,
  ): TurnEvent[] {
    const s = this.save;
    const adv = s.adventure;
    const battle = adv?.battle;
    if (!adv || !battle || battle.outcome) return [];
    if (action === "ability" && adv.abilityUsed) return [];
    const party = this.partyFor(adv.partyIds);
    const events = resolvePartyTurn(
      battle,
      party,
      memberId,
      action,
      defendGrade,
      s.inventory,
      s.prestigeLevel,
      Math.random,
      {},
      targetEnemyId,
      attackGrade,
    );
    if (action === "ability" && events.some((e) => e.kind === "ability")) {
      adv.abilityUsed = true;
      // Benediction's Rite. It is resolved HERE rather than in battle.ts
      // because a reroll charge is a run concern and BattleSnapshot has no
      // business knowing about the offer economy — see RunStats.riteHandler.
      // Without this the card's headline promise had no code path at all.
      if (this.runStats().riteHandler === "riteReroll") {
        adv.rerollsLeft += 1;
      }
    }
    this.battleAnimQueue.push(...events);
    const outcome = isBattleOver(battle);
    if (outcome) this.finalizeBattleOutcome(outcome);
    scheduleSave(s, true);
    return events;
  }

  /** Opens the shared sweep-the-bar timing check for either Attack (crit
   * bonus) or Defend (mitigation grade) — same underlying mechanic
   * (rollSkillCheck/advanceSkillCheck), the grade it produces is just
   * consumed differently once the player clicks (see handleBattleClick). */
  private beginBattleTiming(
    memberId: string,
    action: "attack" | "defend",
    targetEnemyId?: string,
  ): void {
    if (this.currentBattleActorId() !== memberId) return;
    this.battlePendingAction = { memberId, action, targetEnemyId };
    const member = this.memberById(memberId);
    const widenPct = member ? this.skillCheckWidenForMember(member) : 0;
    this.battleSkillCheck = this.rollSkillCheck(
      this.save.adventure?.world,
      widenPct,
    );
    this.battleFlash = null;
    // Ignore clicks for a beat after the check opens. The action bubbles are
    // small targets, so players naturally click again when a press doesn't
    // seem to land — and without this guard that second click lands on the
    // freshly-opened timing bar and instantly grades it, almost always as a
    // miss. The result felt like "Attack does nothing, then randomly turns
    // into a Defend-style skill check".
    this.battleSkillCheckGrace = Game.SKILL_CHECK_GRACE_SECS;
  }

  /** Resolves whichever timing check is currently open — routes to the
   * Attack or Defend outcome depending on battlePendingAction.action, since
   * both share this one skill-check slot (see beginBattleTiming). */
  private finishBattleTiming(grade: SkillGrade): void {
    const pending = this.battlePendingAction;
    this.battleSkillCheck = null;
    this.battlePendingAction = null;
    this.battleFlash = { grade, t: 0 };
    if (!pending) return;
    if (pending.action === "attack") {
      this.applyTurnAction(
        pending.memberId,
        "attack",
        undefined,
        pending.targetEnemyId,
        grade,
      );
    } else {
      this.applyTurnAction(pending.memberId, "defend", grade);
    }
  }

  /** Applies the same Adventure-level side effects resolveStage used to
   * apply for the old whole-stage roll — log entry, pending reward/stage
   * advance, and (on the run's final beat: a stage-5 win, or a loss with
   * nobody left to offer a revive to) the actual bank + status update — all
   * applied atomically, in the same tick the fight is decided, so
   * save.adventure.battle is never left on disk in a "decided but not yet
   * resolved" state. The one exception is a genuine full-party-wipe loss:
   * that gets the same "Team Down" revive chance a partial-death win
   * already offers FIRST (see the loss branch below), and the actual
   * bank/resting-status update is deferred to resolveRevival until the
   * player decides — see AdventureState.pendingRevival.afterWipe. A
   * snapshot is stashed on the side purely so the battle view can keep
   * rendering the scene for a brief summary beat (see update()/
   * closeBattleView()) even after save.adventure (or just .battle) has
   * already been cleared. */
  private finalizeBattleOutcome(outcome: "win" | "loss"): void {
    const s = this.save;
    const adv = s.adventure;
    const battle = adv?.battle;
    if (!adv || !battle) return;
    const room = this.currentRoom();
    const clearedIndex = adv.roomsCleared;
    const advWorld = adv.world;
    const stats = this.runStats();

    let roomWood = 0;
    let roomAmber = 0;
    let runOver = false;

    if (outcome === "win") {
      const totalWoodReward = battle.enemies.reduce((sum, u) => sum + u.spec.woodReward, 0);
      const payout = grovePayoutMult(adv.groveRank);
      roomWood = Math.round(
        totalWoodReward * (1 + stats.values.expeditionPct) * stats.values.woodMult * payout,
      );
      roomAmber = Math.round(
        (isFinalRoom(clearedIndex) ? 30 : Math.random() < 0.2 ? 5 : 0) *
          (1 + stats.values.expeditionPct) *
          stats.values.amberMult *
          payout,
      );
      adv.pendingWood += roomWood;
      adv.pendingAmber += roomAmber;

      // Acorns — the run-local currency, and the only reward that is DELETED
      // when the run ends. Skipped for non-combat rooms, which reach this path
      // only in the sense that they never do.
      const earned = Math.round(
        roomAcorns(depthOf(clearedIndex), room?.kind ?? "fight", Math.random) *
          stats.values.acornMult *
          ((adv.pact ?? []).includes("thinPurse") ? 0.5 : 1),
      );
      adv.acorns += earned;

      adv.roomsCleared = clearedIndex + 1;

      // Curses count down per ROOM, not per fight, so a curse taken at a chaos
      // gate expires on a schedule the player can actually plan around.
      adv.curses = adv.curses
        .map((c) => ({ ...c, roomsLeft: c.roomsLeft - 1 }))
        .filter((c) => c.roomsLeft > 0);

      // Bark survives into the next room — a wall the party built and carried,
      // not a wound the last room left.
      adv.bark = {};
      for (const [unitId, state] of Object.entries(battle.statuses ?? {})) {
        const shield = state.bark?.stacks ?? 0;
        if (shield > 0 && adv.partyIds.includes(unitId)) adv.bark[unitId] = shield;
      }

      const party = this.partyFor(adv.partyIds);
      const xpReward = Math.round(stageXpReward(roomTier(clearedIndex), advWorld) * stats.values.xpMult);
      for (const m of party) grantXp(m, xpReward, s.inventory, s.prestigeLevel);

      // Patron favour: earned by CLEARING with a patron's boons, not merely by
      // picking them. Committing has to survive contact with the run for the
      // meta layer to mean anything.
      if (isDepthBoundary(clearedIndex) || isFinalRoom(clearedIndex)) {
        s.patronFavor = s.patronFavor ?? {};
        for (const patron of new Set(adv.boonList.map((b) => BOON_DEFS_BY_ID[b.id]?.patron).filter(Boolean))) {
          const id = patron as PatronId;
          s.patronFavor[id] = Math.min(MAX_PATRON_FAVOR, (s.patronFavor[id] ?? 0) + 1);
        }
      }

      if (isFinalRoom(clearedIndex)) {
        s.stats.adventuresCleared += 1;
        runOver = true;
      }
    }

    const enemyNames = battle.enemies.map((u) => u.spec.name);
    const combinedEnemyName =
      enemyNames.length <= 1
        ? (enemyNames[0] ?? "")
        : enemyNames.length === 2
          ? `${enemyNames[0]} & ${enemyNames[1]}`
          : `${enemyNames.slice(0, -1).join(", ")} & ${enemyNames[enemyNames.length - 1]}`;

    adv.log.push({
      stage: clearedIndex + 1,
      enemyName: combinedEnemyName,
      outcome,
      woodGained: roomWood,
      amberGained: roomAmber,
      narrowEscape: battle.narrowEscape,
    });
    if (adv.log.length > 8) adv.log.shift();

    this.lastBattleSnapshot = battle;
    this.lastBattleWorld = adv.world;
    this.lastBattlePartyIds = [...adv.partyIds];
    adv.battle = null;
    this.battleEndT = 0;

    if (outcome === "win") {
      const banked = runOver ? this.bankAdventure(1) : { wood: 0, amber: 0 };
      this.lastOutcome = {
        outcome,
        stageWood: roomWood,
        stageAmber: roomAmber,
        runOver,
        bankedWood: banked.wood,
        bankedAmber: banked.amber,
        bankPct: 100,
        restingNames: [],
        narrowEscape: battle.narrowEscape,
      };

      // A chest at each Depth boss — a real, permanent reward applied straight
      // to the save, never reduced by whatever happens afterward.
      if (room?.kind === "boss") {
        this.grantChest(advWorld, isFinalRoom(clearedIndex) ? 5 : 3);
      }

      if (!runOver && s.adventure) {
        const live = s.adventure;
        const party = this.partyFor(live.partyIds);
        const deadCount = party.filter((m) => m.currentHp <= 0).length;
        if (deadCount > 0) {
          const survivorCount = party.length - deadCount;
          const freeRevive =
            !live.freeReviveUsed &&
            (survivorCount <= 1 ? true : Math.random() < 1 - Math.pow(0.5, deadCount));
          live.pendingRevival = { free: freeRevive, cost: reviveCost(), afterWipe: false };
        }
        // The room's reward decides what comes next. A boon or rank door draws
        // an offer; everything else goes straight to the doors, because the
        // reward WAS the room.
        if (room?.reward === "boon" || room?.reward === "rank" || room?.kind === "elite" || room?.kind === "boss") {
          this.drawRoomOffer(room.reward === "rank", room.kind === "elite" || room.kind === "boss");
        } else {
          this.openExits();
        }
      }
    } else {
      const party = this.partyFor(adv.partyIds);
      const deadCount = party.filter((m) => m.currentHp <= 0).length;
      if (deadCount > 0) {
        const freeRevive = !adv.freeReviveUsed && Math.random() < 1 - Math.pow(0.5, deadCount);
        adv.pendingRevival = { free: freeRevive, cost: reviveCost(), afterWipe: true };
        this.lastOutcome = {
          outcome,
          stageWood: 0,
          stageAmber: 0,
          runOver: false,
          bankedWood: 0,
          bankedAmber: 0,
          bankPct: battle.narrowEscape ? 100 : 50,
          restingNames: [],
          narrowEscape: battle.narrowEscape,
        };
      } else {
        this.finalizeLoss(adv, battle);
      }
    }
    scheduleSave(s, true);
  }

  /** Draws the offer a cleared room owes, and persists it verbatim.
   *
   * An elite or a boss always pays at least Epic — the reward has to visibly
   * match the risk, or taking the elite door is a tax rather than a wager. */
  private drawRoomOffer(rankUpOnly: boolean, elite = false): void {
    const s = this.save;
    const adv = s.adventure;
    if (!adv) return;
    const stats = this.runStats();
    const seed = (adv.seed + adv.roomsCleared * 104729) >>> 0;
    const offer = drawOffer(this.offerContext(), seed, 3);
    if (rankUpOnly) {
      for (const card of offer.cards) {
        if (adv.boonList.some((h) => h.id === card.boonId)) card.rankUp = true;
      }
    }
    // An elite or a boss pays at least Epic. Taking the harder door has to be
    // a WAGER, not a tax — a player who accepts a Regrowing elite and spends
    // half the party's health on it must not then be handed the same Common
    // card the safe door was offering.
    if (elite) {
      for (const card of offer.cards) {
        const def = BOON_DEFS_BY_ID[card.boonId];
        if (!def) continue;
        if (card.rarity === "common" || card.rarity === "rare") {
          card.rarity = def.rarities.includes("epic")
            ? "epic"
            : def.rarities[def.rarities.length - 1];
        }
      }
    }
    offer.rerollsLeft = adv.rerollsLeft + Math.round(stats.values.rerollCharges);
    adv.pendingOffer = offer;
    for (const card of offer.cards) this.discover(card.boonId);
    scheduleSave(s, true);
  }

  /** Records a boon, charm or curse in the Fated List. Discovery is permanent;
   * seeing a thing once is the reward. */
  private discover(id: string): void {
    const s = this.save;
    s.codex = s.codex ?? [];
    if (!s.codex.includes(id)) s.codex.push(id);
  }

  /** Opens the doors out of the current room. */
  private openExits(): void {
    const s = this.save;
    const adv = s.adventure;
    if (!adv) return;
    const exits = exitsAfter(adv.map, adv.roomsCleared - 1);
    if (!exits) return;
    adv.pendingExits = exits.map((r) => r.id);
    adv.currentRoomId = null;
    scheduleSave(s, true);
  }

  /** The offer awaiting a pick. */
  boonOffer(): RunOffer | null {
    return this.save.adventure?.pendingOffer ?? null;
  }

  /**
   * Takes one of the offered cards.
   *
   * Three outcomes, and the distinction is the slot system working: a rank-up
   * deepens what is held, a rarity upgrade replaces in place while KEEPING the
   * rank already earned, and an exclusive pick displaces whatever the card
   * named. The instant boons resolve their whole payload here and are never
   * held at all.
   */
  pickBoonCard(boonId: string): boolean {
    const s = this.save;
    const adv = s.adventure;
    const offer = adv?.pendingOffer;
    if (!adv || !offer) return false;
    const card = offer.cards.find((c) => c.boonId === boonId);
    if (!card) return false;
    const def = BOON_DEFS_BY_ID[boonId];
    adv.pendingOffer = null;
    this.discover(boonId);

    if (def?.slot === "instant") {
      this.applyInstantBoon(def.effects.find((e) => e.kind === "custom")?.handlerId);
    } else {
      adv.boonList = applyOfferCard(adv.boonList, card, adv.roomsCleared);
      // Iron Skin touches real HP pools once, at pick time — the same
      // apply-once treatment equipping gear already gets — rather than being a
      // per-turn multiplier.
      if (boonId === "ironSkin") this.applyInstantBoon("ironSkinHp");
    }
    this.openExits();
    scheduleSave(s, true);
    return true;
  }

  private applyInstantBoon(handlerId: string | undefined): void {
    const s = this.save;
    const adv = s.adventure;
    if (!adv || !handlerId) return;
    const party = this.partyFor(adv.partyIds);
    if (handlerId === "ironSkinHp") {
      for (const m of party) {
        if (m.currentHp <= 0) continue;
        const bump = Math.round(m.maxHp * BOON_HP_PCT);
        m.maxHp += bump;
        m.currentHp = Math.min(m.maxHp, m.currentHp + bump);
      }
    } else if (handlerId === "secondWindHeal") {
      for (const m of party) {
        if (m.currentHp <= 0) continue;
        m.currentHp = Math.min(m.maxHp, m.currentHp + Math.round(m.maxHp * BOON_HEAL_PCT));
      }
    } else if (handlerId === "rechargeAbility") {
      adv.abilityUsed = false;
    }
  }

  // --- non-combat rooms ---------------------------------------------------
  //
  // Shops, springs, shrines and chaos gates. Each resolves through
  // `leaveRoom`, which is the single exit — so "the room is finished, open the
  // doors" is stated once rather than at each of four call sites where one of
  // them would eventually forget to open them and strand the run.

  shopState(): ShopState | null {
    return this.save.adventure?.shop ?? null;
  }

  shopRerollPrice(): number {
    return shopRerollCost(this.save.adventure?.shop?.rerollCount ?? 0);
  }

  /** Display text for a stall entry — resolved here rather than in the UI so
   * the shop and the offer screen name the same thing the same way. */
  shopEntryLabel(entry: ShopEntry): { name: string; blurb: string } {
    if (entry.kind === "charm") {
      const def = CHARM_DEFS_BY_ID[entry.refId];
      return { name: def?.name ?? entry.refId, blurb: def?.blurb ?? "" };
    }
    if (entry.kind === "consumable") {
      const def = CONSUMABLE_DEFS_BY_ID[entry.refId];
      return { name: def?.name ?? entry.refId, blurb: def?.blurb ?? "" };
    }
    const def = BOON_DEFS_BY_ID[entry.refId];
    if (!def || !entry.card) return { name: entry.refId, blurb: "" };
    const held = this.heldBoons().find((h) => h.id === def.id);
    const rank = entry.card.rankUp ? (held?.rank ?? 1) + 1 : (held?.rank ?? 1);
    return {
      name: `${def.name} (${RARITY_LABEL[entry.card.rarity]})`,
      blurb: describeBoon(def, { rarity: entry.card.rarity, rank }),
    };
  }

  buyShopEntry(index: number): boolean {
    const s = this.save;
    const adv = s.adventure;
    const entry = adv?.shop?.stock[index];
    if (!adv || !entry) return false;
    if (!canBuy(entry, adv.acorns, adv.charms, adv.boonList)) return false;
    adv.acorns -= entry.cost;
    entry.sold = true;

    if (entry.kind === "charm") {
      adv.charms.push(entry.refId);
      this.discover(entry.refId);
    } else if (entry.kind === "boon" && entry.card) {
      // Instants resolve their payload rather than joining the build — the same
      // split pickBoonCard makes, applied here too so a stall cannot sell a
      // boon that behaves differently from the identical card on an offer
      // screen.
      const def = BOON_DEFS_BY_ID[entry.refId];
      if (def?.slot === "instant") {
        this.applyInstantBoon(def.effects.find((e) => e.kind === "custom")?.handlerId);
      } else {
        adv.boonList = applyOfferCard(adv.boonList, entry.card, adv.roomsCleared);
        if (entry.refId === "ironSkin") this.applyInstantBoon("ironSkinHp");
      }
      this.discover(entry.refId);
    } else if (entry.kind === "consumable") {
      this.applyConsumable(entry.refId);
    }
    scheduleSave(s, true);
    return true;
  }

  private applyConsumable(id: string): void {
    const s = this.save;
    const adv = s.adventure;
    if (!adv) return;
    const party = this.partyFor(adv.partyIds);
    if (id === "salve") {
      for (const m of party) {
        if (m.currentHp <= 0) continue;
        m.currentHp = Math.min(m.maxHp, m.currentHp + Math.round(m.maxHp * 0.4));
      }
    } else if (id === "whetstone") {
      // Deepens whatever is shallowest, so the purchase is never wasted on
      // something already maxed.
      const target = [...adv.boonList]
        .filter((b) => b.rank < (BOON_DEFS_BY_ID[b.id]?.maxRank ?? 1))
        .sort((a, b) => a.rank - b.rank)[0];
      if (target) target.rank += 1;
    } else if (id === "ward") {
      adv.curses.shift();
    } else if (id === "rerollToken") {
      adv.rerollsLeft += 1;
    }
  }

  rerollShopStock(): boolean {
    const s = this.save;
    const adv = s.adventure;
    if (!adv?.shop) return false;
    const cost = shopRerollCost(adv.shop.rerollCount);
    if (adv.acorns < cost) return false;
    adv.acorns -= cost;
    adv.shop = rerollShop(adv.shop, this.offerContext(), depthOf(adv.roomsCleared), adv.charms);
    scheduleSave(s, true);
    return true;
  }

  /** The chaos gate's wager: a named curse for a fixed number of rooms, in
   * exchange for something the run could not otherwise reach. Drawn from the
   * run seed so a resumed gate offers the same bargain. */
  chaosOffer(): { curse: CurseDef } | null {
    const adv = this.save.adventure;
    if (!adv || adv.pendingRoom?.kind !== "chaos") return null;
    const idx = (adv.seed + adv.roomsCleared * 31) % CURSE_DEFS.length;
    return { curse: CURSE_DEFS[idx] };
  }

  acceptChaos(): boolean {
    const s = this.save;
    const adv = s.adventure;
    const gate = this.chaosOffer();
    if (!adv || !gate) return false;
    adv.curses.push({ id: gate.curse.id, roomsLeft: gate.curse.rooms });
    this.discover(gate.curse.id);

    // The payout. Two of these hand back an OFFER rather than a thing, which
    // is the point — a chaos gate should widen what the run can become, not
    // just hand it a number.
    switch (gate.curse.reward) {
      case "rank2": {
        const target = [...adv.boonList]
          .filter((b) => b.rank < (BOON_DEFS_BY_ID[b.id]?.maxRank ?? 1))
          .sort((a, b) => b.rank - a.rank)[0];
        if (target) target.rank = Math.min(BOON_DEFS_BY_ID[target.id]?.maxRank ?? 1, target.rank + 2);
        break;
      }
      case "rerolls":
        adv.rerollsLeft += 2;
        break;
      case "charm": {
        const available = CHARM_DEFS.filter((c) => !adv.charms.includes(c.id));
        if (available.length > 0) {
          const pick = available[(adv.seed + adv.roomsCleared) % available.length];
          adv.charms.push(pick.id);
          this.discover(pick.id);
        }
        break;
      }
      case "epicBoon":
      case "duoOffer": {
        const ctx = this.offerContext();
        const offer = drawOffer(
          { ...ctx, duoOnly: gate.curse.reward === "duoOffer" },
          (adv.seed + adv.roomsCleared * 7717) >>> 0,
          3,
        );
        for (const card of offer.cards) {
          if (gate.curse.reward === "epicBoon" && card.rarity === "common") card.rarity = "epic";
          this.discover(card.boonId);
        }
        adv.pendingOffer = offer;
        break;
      }
    }
    adv.pendingRoom = null;
    adv.shop = null;
    if (!adv.pendingOffer) this.openExits();
    scheduleSave(s, true);
    return true;
  }

  shrineRankUp(boonId: string): boolean {
    const s = this.save;
    const adv = s.adventure;
    if (!adv) return false;
    const inst = adv.boonList.find((b) => b.id === boonId);
    const def = BOON_DEFS_BY_ID[boonId];
    if (!inst || !def || inst.rank >= def.maxRank) return false;
    inst.rank += 1;
    this.leaveRoom();
    return true;
  }

  /** Fountains and chests — a single act with no decision attached. */
  resolveSimpleRoom(): boolean {
    const s = this.save;
    const adv = s.adventure;
    if (!adv?.pendingRoom) return false;
    if (adv.pendingRoom.kind === "fountain") {
      // 35%, not 50%. At half a health bar a spring was strictly better than any
      // boon on offer, and the balance harness showed a route that took every
      // heal door and skipped the build outclearing every actual build. A
      // fountain should be a relief, not a strategy.
      for (const m of this.partyFor(adv.partyIds)) {
        if (m.currentHp <= 0) continue;
        m.currentHp = Math.min(m.maxHp, m.currentHp + Math.round(m.maxHp * 0.35));
      }
      // A spring also lifts the oldest curse. A room whose whole promise is
      // relief should relieve more than hit points.
      adv.curses.shift();
    } else if (adv.pendingRoom.kind === "chest") {
      this.grantChest(adv.world, 3);
    }
    this.leaveRoom();
    return true;
  }

  /** The single exit from any non-combat room. */
  leaveRoom(): boolean {
    const s = this.save;
    const adv = s.adventure;
    if (!adv?.pendingRoom) return false;
    adv.pendingRoom = null;
    adv.shop = null;
    adv.roomsCleared += 1;
    // Curses count down per room, including the quiet ones — otherwise a run
    // could park in event rooms to wait a curse out.
    adv.curses = adv.curses.map((c) => ({ ...c, roomsLeft: c.roomsLeft - 1 })).filter((c) => c.roomsLeft > 0);
    this.openExits();
    scheduleSave(s, true);
    return true;
  }

  /** Rerolls the pending offer, spending a charge. */
  rerollBoonOffer(): boolean {
    const s = this.save;
    const adv = s.adventure;
    if (!adv?.pendingOffer || adv.pendingOffer.rerollsLeft <= 0) return false;
    adv.pendingOffer = rerollOffer(adv.pendingOffer, this.offerContext(), 3);
    adv.rerollsLeft = Math.max(0, adv.rerollsLeft - 1);
    for (const card of adv.pendingOffer.cards) this.discover(card.boonId);
    scheduleSave(s, true);
    return true;
  }

  /** Read-only summary of the most recently finished fight, for the battle
   * HUD's outcome text (see ui/battle.ts's showOutcome) — null before any
   * fight has finished this session. */
  lastOutcomeSummary(): BattleOutcomeSummary | null {
    return this.lastOutcome;
  }

  /** The pending "Team Down" revive offer, or null — see
   * finalizeBattleOutcome/AdventureState.pendingRevival. Mirrors
   * boonOffer()'s pattern for ui/battle.ts to read from. `afterWipe`
   * distinguishes a win-case offer (partial-death win, run continues either
   * way) from a loss-case offer (full wipe, run-ending unless revived) —
   * see resolveRevival. */
  revivalOffer(): { free: boolean; cost: number; afterWipe: boolean } | null {
    return this.save.adventure?.pendingRevival ?? null;
  }

  /** Resolves the pending Team Down offer (see finalizeBattleOutcome):
   * "free" only succeeds if the free roll already came up true
   * (pendingRevival.free); "paid" spends pendingRevival.cost amber, a no-op
   * returning false if there isn't enough; "skip" declines outright — unlike
   * a boon pick, skipping is allowed here (the player may want to save
   * amber rather than spend on a revive). A successful free/paid revive
   * heals the WHOLE current party to full HP, not just the downed members
   * — same "clamp to maxHp" idea pickBoon's Second Wind/Iron Skin healing
   * already uses, just unconditional here instead of skipping <=0 HP
   * members, and collapsing to a plain full-heal since every member's
   * target is exactly maxHp rather than a partial percentage.
   *
   * `pendingRevival.afterWipe` forks what happens next. A WIN-case offer
   * (afterWipe false) just heals-or-doesn't and returns — the run was
   * already continuing regardless of the choice; finishRewardFlow moves on
   * to the boon offer either way. A WIPE-case offer (afterWipe true) is a
   * real fork: "skip", or an attempted "free"/"paid" that fails validation
   * (shouldn't happen through the UI — ui/battle.ts hides the free button
   * unless pendingRevival.free and disables the paid button when
   * unaffordable — but handled here too rather than leaving pendingRevival
   * stuck forever and soft-locking beginStageBattle's guard), finalizes the
   * loss for real via finalizeLoss — exactly the work finalizeBattleOutcome's
   * loss branch used to do immediately, before this feature existed. A
   * validated "free"/"paid" instead discards the old, terminally-"done"
   * battle object (it can't be resumed mid-turn) and retries the very same
   * stage that was just lost — adv.stage was never incremented on a loss,
   * so startBattleForNextStage() naturally re-fights it, at no extra wood
   * fee (the player already paid via amber, or via the free roll). */
  resolveRevival(choice: "free" | "paid" | "skip"): boolean {
    const s = this.save;
    const adv = s.adventure;
    const revival = adv?.pendingRevival;
    if (!adv || !revival) return false;
    // Stashed by finalizeBattleOutcome regardless of outcome/branch (see
    // its doc comment) — the one piece of the just-finished fight
    // finalizeLoss needs (battle.narrowEscape) that isn't already on adv.
    const battle = this.lastBattleSnapshot;

    if (choice === "free" && !revival.free) {
      if (revival.afterWipe && battle) {
        adv.pendingRevival = null;
        this.finalizeLoss(adv, battle);
        scheduleSave(s, true);
      }
      return false;
    }
    if (choice === "paid" && s.amber < revival.cost) {
      if (revival.afterWipe && battle) {
        adv.pendingRevival = null;
        this.finalizeLoss(adv, battle);
        scheduleSave(s, true);
      }
      return false;
    }
    if (choice === "paid") s.amber -= revival.cost;

    if (choice === "skip") {
      adv.pendingRevival = null;
      if (revival.afterWipe && battle) this.finalizeLoss(adv, battle);
      scheduleSave(s, true);
      return true;
    }

    // "free" (validated true) or "paid" (validated + spent) from here.
    // Spending the run's one-per-run free revive happens exactly here, not
    // at either offer/roll site above (see AdventureState.freeReviveUsed) —
    // an offered-but-declined-or-unused free revive shouldn't burn it.
    if (choice === "free") adv.freeReviveUsed = true;
    const party = this.partyFor(adv.partyIds);
    for (const m of party) m.currentHp = m.maxHp;
    adv.pendingRevival = null;
    if (revival.afterWipe) {
      // Already null (finalizeBattleOutcome clears adv.battle regardless of
      // branch) — cleared again explicitly so this reads correctly even if
      // that invariant ever changes.
      adv.battle = null;
      // A wipe-case revive retries the room the party just fell in, not the
      // next one — the room was never cleared, so roomsCleared is unchanged and
      // re-entering it is simply starting that fight again.
      const room = this.currentRoom();
      if (room) this.startRoomBattle(room);
      return true;
    }
    scheduleSave(s, true);
    return true;
  }

  /** What the most recently opened milestone chest granted, awaiting
   * dismissal — see grantChest/ChestRevealSummary. */
  pendingChestReveal(): ChestRevealSummary | null {
    return this.chestReveal;
  }

  /** Dismisses the chest-reveal screen — purely a UI-state clear, the
   * reward itself was already applied for real the instant grantChest ran. */
  dismissChestReveal(): void {
    this.chestReveal = null;
  }

  /** Opens a milestone chest (stage 3 / stage 5 full clear): bonus wood +
   * amber, a guaranteed item pull from the current world's pool, and
   * shards — all granted for real, immediately, independent of whether the
   * run's own pendingWood/pendingAmber ever get fully banked. The item pull
   * reuses gacha.ts's normal pullItem, deliberately INCLUDING its pity-
   * counter update: a free chest pull still counts as "a pull" against the
   * shared per-world item pity counter, same as a paid one, rather than a
   * separate exploitable path that never advances (or resets) it. */
  private grantChest(world: number, stage: 3 | 5): void {
    const s = this.save;
    const reward: ChestReward = chestReward(world, stage);
    s.wood += reward.wood;
    s.amber += reward.amber;
    s.totalWoodEarned += reward.wood;
    const pull = pullItem(s, world);
    s.shards[reward.shardRarity] += reward.shardAmount;
    // Homestead decoration, credited as a free placeable rather than as wood —
    // the reward is "you can put one more of these in your yard".
    const decorId = chestDecoration(stage, Math.random());
    if (decorId) {
      const stock = this.save.decorStock ?? {};
      this.save.decorStock = { ...stock, [decorId]: (stock[decorId] ?? 0) + 1 };
    }
    const decorSpec = decorId ? buildableById(decorId) : undefined;

    this.chestReveal = {
      wood: reward.wood,
      amber: reward.amber,
      itemName: pull.def.name,
      itemRarity: pull.def.rarity,
      shardRarity: reward.shardRarity,
      shardAmount: reward.shardAmount,
      decorId: decorSpec?.id,
      decorName: decorSpec?.name,
    };
    scheduleSave(s, true);
  }

  /** Bank 100% of pending rewards and end the run — always available. If a
   * fight is mid-flight (not yet decided), it's abandoned, forfeiting that
   * stage's reward, same as any other retreat. */
  retreatAdventure(): boolean {
    const adv = this.save.adventure;
    if (!adv) return false;
    if (adv.battle && adv.battle.outcome === null) {
      adv.battle = null;
      this.battleViewOpen = false;
      this.battleAnimQueue = [];
      this.battleAnim = null;
      // Abandoning mid-flight (possibly mid-timing-check) must not leave
      // that check's state to leak into whatever battle starts next.
      this.battleSkillCheck = null;
      this.battlePendingAction = null;
    }
    this.bankAdventure(1);
    scheduleSave(this.save, true);
    return true;
  }

  /** Instant-use shop item: heals the whole roster to full HP. */
  useTrailRations(): boolean {
    const s = this.save;
    const spec = PROVISIONS.find((p) => p.id === "trailRations")!;
    if (s.wood < spec.cost) return false;
    s.wood -= spec.cost;
    for (const m of s.team) {
      m.currentHp = m.maxHp;
      if (m.status === "resting") m.status = "available";
    }
    scheduleSave(s, true);
    return true;
  }

  /** Fortune Charm / Emergency Rope: purchased into `provisions`, carried
   * onto a run at embark time. */
  buyProvision(id: ProvisionId): boolean {
    const s = this.save;
    const spec = PROVISIONS.find((p) => p.id === id);
    if (!spec || spec.instant) return false;
    if (s.amber < spec.cost) return false;
    s.amber -= spec.cost;
    s.provisions[id] = (s.provisions[id] ?? 0) + 1;
    scheduleSave(s, true);
    return true;
  }

  adventureStatus(): {
    world: number;
    roomsCleared: number;
    depth: number;
    acorns: number;
    partyIds: string[];
    pendingWood: number;
    pendingAmber: number;
    battleInProgress: boolean;
  } | null {
    const adv = this.save.adventure;
    if (!adv) return null;
    return {
      world: adv.world,
      roomsCleared: adv.roomsCleared,
      depth: depthOf(adv.roomsCleared),
      acorns: adv.acorns,
      partyIds: [...adv.partyIds],
      pendingWood: adv.pendingWood,
      pendingAmber: adv.pendingAmber,
      // "There's something live to jump back into" — a fight in progress,
      // OR a boon pick still awaiting a decision (no skip button — Push On
      // stays unavailable, see beginStageBattle, so the Field screen must
      // offer Resume instead), OR a Team Down revive offer still awaiting a
      // decision (skip IS allowed here, but Push On still stays unavailable
      // until it's explicitly resolved one way or another — same
      // beginStageBattle gate), OR a milestone-chest reveal this session
      // hasn't dismissed yet.
      // "There's something live to jump back into." Every pending decision
      // counts, not just a live fight — an unanswered door or a half-shopped
      // stall is just as much a reason to offer Resume, and omitting one of
      // them shows the player a run that looks idle when it is waiting on them.
      battleInProgress:
        (!!adv.battle && adv.battle.outcome === null) ||
        !!adv.pendingOffer ||
        !!adv.pendingRevival ||
        !!adv.pendingExits ||
        !!adv.pendingRoom ||
        !!this.chestReveal,
    };
  }

  /** Wood cost of the next descent, for UI display. Zero everywhere except
   * the two Depth boundaries — moving between rooms inside a Depth is free, so
   * the run is never gated on the idle economy mid-Depth. */
  nextStageFee(): number {
    const adv = this.save.adventure;
    if (!adv) return 0;
    if (!isDepthBoundary(adv.roomsCleared - 1)) return 0;
    return descentToll(getWorld(adv.world).mult, depthOf(adv.roomsCleared));
  }

  // --- layout -------------------------------------------------------------

  private groundTop(): number {
    return this.skyH;
  }

  private groundBottom(): number {
    return this.h - 4;
  }

  private layout(): void {
    this.skyH = Math.max(24, Math.round(this.h * 0.26));
    // Trees must not grow inside the homestead — the yard is a cleared plot
    // of land with a fence round it, and a tree standing in the middle of it
    // reads as the fence having been drawn over the forest rather than as a
    // place carved out of it. Passed as a callback because yardRect() reads
    // the grid's dimensions, which only become correct partway through
    // Forest.resize (see its `reserved` parameter).
    this.plot.resize(this.w, this.groundTop(), this.groundBottom(), (grid) => {
      // Runs with the grid freshly sized, which is the only moment the yard's
      // footprint is knowable AND the trees haven't been snapped yet. Push
      // the pond out of the homestead first, so the water cells reserved
      // below describe where the water actually ends up.
      const y = this.yardRect();
      // Corner-to-corner in logical px, taken off the grid's own mapping
      // rather than assuming its origin — `center` is the cell midpoint, so
      // back off half a cell to reach the yard's outer edges.
      const nw = grid.center({ cx: y.cx, cy: y.cy });
      const se = grid.center({ cx: y.cx + y.cols - 1, cy: y.cy + y.rows - 1 });
      this.plot.lake.avoidRect(
        nw.x - CELL / 2,
        nw.y - CELL / 2,
        se.x + CELL / 2,
        se.y + CELL / 2,
        this.w,
        this.groundTop(),
        this.groundBottom(),
      );
      // Reserve the yard AND the water. Trees already avoid the lake when a
      // plot is first seeded, but that check runs in normalized space before
      // any nudge, so without this a displaced pond can end up with trunks
      // standing in it.
      // ONE rule for everything: a tree may not be placed where its drawn
      // silhouette would overlap anything that matters — water, the track,
      // the homestead, a building, or a person.
      //
      // This used to be four separate passes with four different margins
      // (yard cells, the rail row, a river band by footing-x, a 3x3 apron
      // around each NPC), and each one leaked in its own way: trees stood in
      // front of the adventure tent and swallowed clicks meant for it, grew
      // through NPCs, crept into the river, and appeared inside the yard.
      // Testing the actual footprint against one list of keep-out shapes
      // fixes all of them at once and leaves nowhere new to leak.
      const out: Cell[] = [];
      const keepOut = this.treeKeepOutRects();
      for (let cy = 0; cy < grid.rows; cy++) {
        for (let cx = 0; cx < grid.cols; cx++) {
          // jitteredFooting, NOT footing: the forest places each trunk at a
          // deterministic offset inside its cell (see Forest.resize), so
          // testing the cell's centre-bottom checked a spot no tree ever
          // stands on.
          if (this.treeWouldIntrude(grid.jitteredFooting({ cx, cy }), keepOut)) {
            out.push({ cx, cy });
          }
        }
      }
      return out;
    });
    // The incoming plot during a travel slide carries no homestead yet.
    this.nextPlot?.resize(this.w, this.groundTop(), this.groundBottom());
    this.ambience.resize(
      this.w,
      this.skyH,
      this.groundTop(),
      this.groundBottom(),
    );
  }

  /** Which critters are out. Read off the sky's own darkness ramp rather
   * than the wall clock, so ambience always agrees with the sky the player
   * is actually looking at. */
  private dayPhase(): DayPhase {
    const d = this.sky.darkness;
    if (d > 0.55) return "night";
    return d > 0.22 ? "dusk" : "day";
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.layout();
    // The grid — and therefore the yard — is derived from the canvas, so a
    // resize can strand placed buildables outside it. Runs after layout()
    // so it reads the NEW footprint.
    this.reconcilePlacements();
    for (const wc of this.woodcutters.values()) {
      wc.x = Math.min(wc.x, this.w - 12);
      wc.y = Math.max(this.skyH + 10, Math.min(wc.y, this.h - 3));
      wc.repath();
    }
  }

  // --- backend inputs -----------------------------------------------------

  applySnapshot(s: Snapshot): void {
    this.hasData = true;
    // Kept so the NPCs can be specific about your usage (see npc/usage-view).
    // Nothing else reads it; the rest of the app consumes the derived values
    // below. Null until the backend first answers — which in a plain browser
    // is forever, hence UsageView.blind.
    this.lastSnapshot = s;
    // Lake level: real account utilization when available, else the
    // budget-estimate density carried on the block.
    this.density = s.real
      ? Math.max(0, Math.min(1, 1 - s.real.fiveHourPct))
      : s.block
        ? s.block.density
        : 1;
    this.plot.setLakeLevel(this.density);
    this.nextPlot?.setLakeLevel(this.density);

    const wanted = s.sources.filter(
      (src) => src.kind === "session" || src.state === "working",
    );
    const shown = wanted.slice(0, MAX_WOODCUTTERS);
    this.extraCount = wanted.length - shown.length;

    const seen = new Set<string>();
    for (const src of shown) {
      seen.add(src.id);
      let wc = this.woodcutters.get(src.id);
      if (!wc) {
        const entryY =
          this.skyH +
          14 +
          ((this.woodcutters.size * 17) % (this.h - this.skyH - 22));
        wc = new Woodcutter(src.id, src.kind === "subagent", entryY);
        this.slotAssignment.set(src.id, this.pickMember(src.id));
        wc.memberId = this.slotAssignment.get(src.id) ?? null;
        wc.rarity = this.rarityForMember(wc.memberId);
        wc.weaponRarity = this.weaponRarityForMember(wc.memberId);
        wc.accent = this.accentForMember(wc.memberId);
        this.applyModifiers(wc);
        this.woodcutters.set(src.id, wc);
      } else if (!this.slotAssignment.has(src.id)) {
        // Shouldn't normally happen (slot cleared without the sprite
        // despawning), but re-pick defensively rather than leave it null.
        this.slotAssignment.set(src.id, this.pickMember(src.id));
        wc.memberId = this.slotAssignment.get(src.id) ?? null;
        wc.rarity = this.rarityForMember(wc.memberId);
        wc.weaponRarity = this.weaponRarityForMember(wc.memberId);
        wc.accent = this.accentForMember(wc.memberId);
      }
      wc.activity = src.state === "waiting" ? "waiting" : "working";
      wc.leaving = false;
    }
    for (const [id, wc] of this.woodcutters) {
      if (!seen.has(id) && wc.variant !== "gnome") {
        wc.leaving = true;
      }
    }
  }

  applyChop(e: ChopEvent): void {
    const buf = this.buffers.get(e.sourceId);
    const weight = swingWeight(e.counted);
    if (buf) {
      buf.tokens += e.counted;
      buf.hits += 1;
      buf.weight += weight;
    } else {
      this.buffers.set(e.sourceId, { tokens: e.counted, hits: 1, weight, age: 0 });
    }

    // Amber accrual: every 1k counted tokens charges +1 Amber, boosted by an
    // equipped amberIncome Utility item / the Amber Vein Power-up (see
    // amberIncomeMult). Kept on its own carry-over accumulator (tokenCarry)
    // separate from Focus's (focusCarry, below) so the two can be boosted
    // independently.
    this.tokenCarry += e.counted;
    const amberTicks = Math.floor(this.tokenCarry / TOKENS_PER_CHARGE);
    if (amberTicks > 0) {
      this.tokenCarry %= TOKENS_PER_CHARGE;
      this.save.amber += Math.round(amberTicks * this.amberIncomeMult());
      scheduleSave(this.save);
    }

    // Focus accrual: a focusEfficiencyPct Woodchopping item effectively
    // lowers the tokens-per-Focus-point requirement for whoever's chopping
    // — implemented as a boost to the tokens counted toward the next Focus
    // charge (equivalent net effect, composes cleanly with the shared
    // TOKENS_PER_CHARGE threshold instead of needing a second constant).
    const focusMult = 1 + this.focusEfficiencyForSource(e.sourceId);
    // Focus Overflow: tokens that arrive while Focus is already pinned at
    // the cap feed the overflow meter instead of vanishing — every
    // OVERFLOW_LOG_TOKENS earns a Golden Log (spawned by update() when the
    // single log slot is free).
    if (this.save.focus >= FOCUS_CAP) {
      const overflow = accrueOverflow(this.overflowCarry, e.counted);
      this.overflowCarry = overflow.carry;
      this.overflowLogsPending += overflow.logs;
    }

    // Cache Koi: cache-read tokens (context reused instead of re-sent —
    // "free" relative to counted usage) feed a separate meter that spawns
    // a catchable fish in the lake. Independent of the Focus-cap gate
    // above — cache reads accrue this regardless of whether Focus is full.
    const koiEarn = accrueCacheKoi(this.koiCarry, e.cacheRead);
    this.koiCarry = koiEarn.carry;
    if (koiEarn.koi > 0 && !this.koi) {
      this.koi = { phase: Math.random() * Math.PI * 2, ttl: CACHE_KOI_TTL };
    }
    this.focusCarry += e.counted * focusMult;
    const focusTicks = Math.floor(this.focusCarry / TOKENS_PER_CHARGE);
    if (focusTicks > 0) {
      this.focusCarry %= TOKENS_PER_CHARGE;
      this.save.focus = Math.min(FOCUS_CAP, this.save.focus + focusTicks);
      scheduleSave(this.save);
    }

    // Heavy single turns drop a clickable golden log — the threshold is
    // effectively lowered (spawns more often) by an equipped rareMapSpawn
    // Utility item / the Golden Sense Power-up, expressed as a spawn-rate
    // multiplier dividing the threshold (see goldenLogSpawnMult).
    const goldenLogThreshold = GOLDEN_LOG_THRESHOLD / this.goldenLogSpawnMult();
    if (e.counted > goldenLogThreshold && !this.goldenLog && !this.nextPlot) {
      this.goldenLog = {
        x: Math.round(12 + Math.random() * (this.w - 24)),
        y: Math.round(
          this.skyH + 14 + Math.random() * (this.h - this.skyH - 22),
        ),
        ttl: GOLDEN_LOG_TTL,
      };
    }
  }

  // --- POV mode -------------------------------------------------------

  /** Bbox hit-test against live woodcutter sprites, front-most first. */
  hitWoodcutter(lx: number, ly: number): Woodcutter | null {
    const candidates = [...this.woodcutters.values()]
      .filter((wc) => !wc.gone)
      .sort((a, b) => b.y - a.y);
    for (const wc of candidates) {
      const { w, h } = spriteSize(RARITY_WOODCUTTER_SPRITES[wc.rarity].stand);
      if (
        lx >= wc.x - 1 &&
        lx <= wc.x + w + 1 &&
        ly >= wc.y - h - 1 &&
        ly <= wc.y + 1
      ) {
        return wc;
      }
    }
    return null;
  }

  isPovActive(): boolean {
    return this.povTarget !== null;
  }

  enterPov(wc: Woodcutter): void {
    if (this.battleViewOpen) return; // POV and battle are mutually exclusive takeovers
    this.closeDialogue();
    if (this.povTarget) this.povTarget.endPov();
    this.povTarget = wc;
    this.povSkillCheck = null;
    this.povFlash = null;
    this.povWalkT = 0; // replay the walk-up every time the view opens
    wc.beginPov();
  }

  exitPov(): void {
    this.povTarget?.endPov();
    this.povTarget = null;
    this.povSkillCheck = null;
    this.povFlash = null;
  }

  /** Click-on-canvas or Space while POV is active. If the cutter is sitting
   * idle waiting for a swing to start (awaitingStart — whether or not any
   * token-work happens to be queued), this starts one; otherwise it grades
   * the live skill check, if one is currently awaiting input. No-op
   * otherwise. Shared by both input paths (canvas click via handleClick,
   * and the Space key in main.ts) so neither has to duplicate the gate. */
  handlePovInput(): void {
    if (!this.povTarget) return;
    // Can't swing until he's actually reached the trunk — otherwise a click the
    // instant POV opens fires an axe from halfway across the frame.
    if (this.povWalkT < Game.POV_WALK_SECS) return;
    if (this.povTarget.awaitingStart) {
      this.povTarget.beginSwing();
      return;
    }
    if (!this.povSkillCheck || !this.povTarget.awaitingInput) return;
    const sc = this.povSkillCheck;
    this.finishSkillCheck(this.gradeSkillCheck(sc, sc.pos));
  }

  // --- battle mode ------------------------------------------------------

  isBattleViewOpen(): boolean {
    return this.battleViewOpen;
  }

  /** Re-opens an already-in-progress battle (see startBattleForNextStage
   * for starting a new one), OR a still-unresolved boon pick / not-yet-
   * dismissed chest reveal from the most recent stage win — used by the HUD
   * indicator / Adventure overlay's "Resume Battle" whenever there's
   * something live to jump back into. */
  openBattleView(): boolean {
    const adv = this.save.adventure;
    // Resumable whenever there's still a run going (a live fight, a pending
    // boon pick, or the no-battle "stage cleared, push on or retreat"
    // in-between-stages window — see ui/battle.ts's showStageCleared) OR a
    // milestone chest hasn't been dismissed yet (the one case that can be
    // true with `adv` already null — a stage-5 full clear banks + clears
    // save.adventure before its chest is even granted).
    if (!adv && !this.chestReveal) return false;
    if (this.povTarget) this.exitPov();
    this.closeDialogue();
    this.battleViewOpen = true;
    return true;
  }

  /** Leaves the battle view — whether that's pausing a still-live fight
   * (its turn state stays untouched on disk, save.adventure.battle is
   * exactly as it was), pausing on the no-battle "stage cleared" prompt
   * between stages, or dismissing an already-finished run's summary beat
   * early (already fully applied/banked by finalizeBattleOutcome, so there's
   * nothing left to do here but stop showing it). */
  closeBattleView(): void {
    this.battleViewOpen = false;
    this.battleAnimQueue = [];
    this.battleAnim = null;
    // Keep the fallback snapshot alive as long as there's still something to
    // resume into — the run hasn't ended (covers a live fight, a pending
    // boon pick, and the no-battle "stage cleared" prompt alike, since all
    // three leave `adv` non-null) or a milestone chest reveal hasn't been
    // dismissed yet. renderBattle needs it to draw the party/enemy sprites
    // behind whatever UI is showing on the next openBattleView(), same as
    // the constructor's app-restart seeding above (see its doc comment).
    if (!this.save.adventure && !this.chestReveal) {
      this.lastBattleSnapshot = null;
    }
  }

  /** Click/Space while the battle view is open — resolves a pending Attack
   * or Defend timing check if one is live, otherwise just consumes the
   * click (real turn actions come from the floating bubble UI, not a
   * generic canvas click). */
  /** Watches every battle unit for the frame its HP first reaches 0 and kicks
   * off the death beat: a squash-and-stretch collapse (see deathSquash) plus a
   * spray of blood. Previously a defeated unit simply swapped to a static
   * "defeated" frame with no transition at all, so kills landed with no impact
   * — the sprite was just suddenly lying down. */
  private updateDeaths(dt: number): void {
    for (const [id, t] of this.deathAnims) {
      const next = t + dt;
      if (next >= Game.DEATH_SECS) this.deathAnims.delete(id);
      else this.deathAnims.set(id, next);
    }

    const battle = this.battleSnapshot();
    if (!battle) return;
    const check = (
      id: string,
      hp: number,
      pos: { x: number; y: number } | null,
    ): void => {
      if (hp > 0) {
        // Revived (or a fresh unit reusing an id) — allow a future death.
        this.deathSeen.delete(id);
        return;
      }
      if (this.deathSeen.has(id)) return;
      this.deathSeen.add(id);
      this.deathAnims.set(id, 0);
      if (!pos) return;
      // Reuses LeafBurst rather than adding a near-identical class — its
      // gravity-and-sway arc is exactly a spatter, only the colors differ.
      // Same "reuse the existing particle system" call as the Sap Press.
      this.effects.push(
        new LeafBurst(
          pos.x,
          pos.y - 6,
          ["#8c1c1c", "#b52d2d", "#5e1010"],
          14,
          0.7,
        ),
      );
      this.battleShakeT = Math.max(this.battleShakeT, 0.18);
    };

    for (let i = 0; i < battle.enemies.length; i++) {
      const u = battle.enemies[i];
      check(u.id, u.hp, battleEnemySlot(i, battle.enemies.length, this));
    }
    const adv = this.save.adventure;
    if (adv) {
      for (const m of this.partyFor(adv.partyIds)) {
        const idx = adv.partyIds.indexOf(m.id);
        check(m.id, m.currentHp, idx >= 0 ? battlePartySlot(idx, this) : null);
      }
    }
  }

  /** Vertical squash factor for a unit mid-collapse: a quick stretch as it
   * drops, then a hard squash as it hits the ground, easing out to rest.
   * 1 = no deformation (not dying, or the beat is over). */
  private deathSquash(id: string): number {
    return deathSquash(this.deathAnims.get(id), Game.DEATH_SECS);
  }

  /** Hovered door index, or null. Recomputed on every hover; never persisted,
   * since it is pure pointer state. */
  private doorHover: number | null = null;

  /** The doors currently drawn on the back wall, in the order Game.exitOffer()
   * returns them. Empty whenever the party is not at a junction. */
  private doorRectsNow(): DoorRect[] {
    const exits = this.exitOffer();
    if (!exits || !this.battleViewOpen) return [];
    return doorRects(this.w, this.h, exits.length);
  }

  /** Hover feedback for the doorways. Called from handleHover, which
   * previously never checked battleViewOpen at all and so ran homestead and
   * grid hit-tests during a takeover — meaningless there, and they would have
   * fought the doors for the pointer. */
  handleBattleHover(lx: number, ly: number): boolean {
    const rects = this.doorRectsNow();
    if (rects.length === 0) {
      this.doorHover = null;
      return false;
    }
    const hit = hitDoor(rects, lx, ly);
    this.doorHover = hit;
    return hit !== null;
  }

  doorHoverIndex(): number | null {
    return this.doorHover;
  }

  handleBattleClick(lx = 0, ly = 0): boolean {
    // Doors first: they are the only thing on the canvas that is a control
    // rather than scenery, and a live skill check can never coexist with a
    // junction (one is mid-fight, the other is between rooms).
    const rects = this.doorRectsNow();
    if (rects.length > 0) {
      const hit = hitDoor(rects, lx, ly);
      const exits = this.exitOffer();
      if (hit !== null && exits?.[hit]) {
        this.pickExit(exits[hit].id);
        this.doorHover = null;
        this.onRunBeatResolved?.();
      }
      return true;
    }
    if (this.battleSkillCheck) {
      // Swallow the click while the opening grace window is live (see
      // beginBattleTiming) — but still consume it, so it can't fall through
      // and start a window-drag mid-fight.
      if (this.battleSkillCheckGrace > 0) return true;
      const sc = this.battleSkillCheck;
      this.finishBattleTiming(this.gradeSkillCheck(sc, sc.pos));
    }
    return true;
  }

  /** Bbox hit-test for the top-left "N away · stage M" HUD icon, clickable
   * whenever a run is in progress at all — not just mid-battle — so it's
   * always a working path back in, whether that means resuming a live
   * fight or opening the Adventure overlay to Push On between stages. */
  /** Superseded by the encampment: adventuring is now a place on the map, so
   * this stays only as the resume path for a run already in progress and is
   * anchored to the camp rather than a floating corner badge. */
  private hitAdventureIndicator(lx: number, ly: number): boolean {
    if (!this.save.adventure) return false;
    return this.hitEncampment(lx, ly);
    // eslint-disable-next-line no-unreachable
    // Follows the badge to its home on the signpost (see render). Sits ABOVE
    // the signpost's own box, so the two can't both claim a click.
    const sp = this.signpostPos();
    return (
      lx >= sp.x + 5 && lx <= sp.x + 30 && ly >= sp.y - 24 && ly <= sp.y - 16
    );
  }

  /** Deliberately NOT part of the procedural tree layout, so the press is
   * always in a predictable, reachable spot regardless of plot seed — but
   * placed by fraction like every other prop so it scales with the window. */
  sapPressOwned(): boolean {
    return this.save.sapPressBuilt === true;
  }

  sapPressPurchaseCost(): number {
    return sapPressBuildCost(getWorld(this.save.worldIndex).mult);
  }

  /** Buys the Sap Press. It then stands in the clearing permanently and works
   * exactly as before — this only gates whether you have one at all. */
  buySapPress(): boolean {
    if (this.sapPressOwned()) return false;
    const cost = this.sapPressPurchaseCost();
    if (this.save.wood < cost) return false;
    this.save.wood -= cost;
    this.save.sapPressBuilt = true;
    scheduleSave(this.save, true);
    return true;
  }

  private sapPressPos(): { x: number; y: number } {
    return this.propSpot(0.955, 0.99);
  }

  // --- Environmental resource props -----------------------------------------
  //
  // Wood / amber / focus used to be a readout drawn in the top-left corner.
  // They're now physical objects standing around the clearing.
  //
  // Placement is by FRACTION of the clearing, never fixed pixel offsets. The
  // canvas is as wide as the player's window — 840 logical px on a 1680px
  // window, against a 180px default — so hardcoded offsets bunched every prop
  // into the leftmost ~9% and left the middle of the clearing empty. Depth
  // varies per prop as well, because props sharing one ground line read as a
  // toolbar strip pasted along the bottom edge rather than objects standing in
  // a world. Varying y also lets them depth-sort in among the trees.

  /** Converts a (fraction-across, fraction-into-the-clearing) pair to canvas
   * coords, then nudges the result off the lake — the lake is seeded per plot,
   * so any fixed spot can land in open water on some seeds. */
  private propSpot(fx: number, fy: number): { x: number; y: number } {
    const top = this.groundTop() + 8;
    const bottom = this.groundBottom();
    const x = Math.round(this.w * fx);
    const y = Math.round(top + (bottom - top) * fy);
    return this.avoidLake(x, y);
  }

  /** Walks a point horizontally out of the lake, away from its centre. Bounded
   * so a pathological lake can never push a prop off-canvas; if it somehow
   * can't escape, the original point stands (a prop briefly in the shallows
   * beats a prop teleported off screen). */
  private avoidLake(x: number, y: number): { x: number; y: number } {
    const lake = this.plot.lake;
    if (!lake.contains(x, y)) return { x, y };
    const dir = x < lake.cx ? -1 : 1;
    for (let step = 2; step <= lake.rx + 12; step += 2) {
      const nx = x + dir * step;
      if (nx < 8 || nx > this.w - 8) break;
      if (!lake.contains(nx, y)) return { x: nx, y };
    }
    return { x, y };
  }

  // --- Homestead ------------------------------------------------------------
  //
  // The cottage and its fenced yard are the plot of land everything else lives
  // on: the resource readouts are its furnishings, and bought buildables get
  // placed on its free grid cells.
  //
  // The yard is anchored in GRID CELLS rather than pixels so it lines up with
  // the tiles buildables snap to — a yard measured in pixels would leave
  // placements half-in and half-out of the fence at some window sizes.

  /** Yard footprint in cells: origin plus span. Sized as a fraction of the
   * grid so the homestead stays proportionate on any window, with a floor so
   * it never collapses below something buildable on a tiny canvas. */
  private yardRect(): { cx: number; cy: number; cols: number; rows: number } {
    const grid = this.plot.forest.gridRef();
    // The plot GROWS with the cottage: each phase widens it and (from phase 2)
    // deepens it, so raising the cottage tangibly buys you more room to build
    // rather than just a nicer sprite. Clamped to a fraction of the grid so a
    // fully-built homestead still can't swallow a small window.
    const phase = this.cottagePhase();
    // Width is a FRACTION of the grid, not a fixed cell count. The old
    // `baseCols + phase * 3` was tuned when the canvas rendered at half CSS
    // size and the grid was ~70 columns wide, where a fully-built yard came
    // to a comfortable 30% of the plot. Once the renderer started targeting
    // a constant ~240px logical width the grid dropped to ~20 columns and
    // the very same numbers made the homestead swallow 75% of the world —
    // fence and all, pond included. A fraction holds the intended
    // proportion at any grid size.
    const cols = Math.max(
      5,
      Math.min(grid.cols - 4, Math.round(grid.cols * (0.25 + phase * 0.05))),
    );
    const baseRows = Math.max(3, Math.min(4, Math.round(grid.rows * 0.14)));
    const rows = Math.min(
      Math.max(3, Math.round(grid.rows * 0.4)),
      baseRows + Math.max(0, phase - 1),
    );
    return {
      cx: Math.max(0, Math.round(grid.cols * 0.06)),
      cy: Math.max(0, grid.rows - rows - 1),
      cols,
      rows,
    };
  }



  /** Cell the cottage itself stands on — back-left of the yard. */
  private cottageCell(): Cell {
    const y = this.yardRect();
    return { cx: y.cx + 1, cy: y.cy };
  }

  /** Where each resource readout stands inside the yard. These are the
   * cottage's furnishings — the whole point of the homestead is that wood,
   * amber and focus are all visible in one plot of land instead of scattered
   * across the clearing at fraction-of-canvas positions, which is what made
   * them read as a toolbar strip.
   *
   * Laid out along the yard's front row (nearest the viewer) so nothing hides
   * behind the cottage, with the lantern one row back since it hangs high. */
  private yardPropCells(): Record<
    "logStack" | "whetstone" | "signpost" | "lantern",
    Cell
  > {
    const y = this.yardRect();
    const front = y.cy + y.rows - 1;
    // Props are spread across a FRACTION of the yard's width, not parked at
    // fixed column offsets. The old version used literal columns 1/4/7/9 and
    // clamped anything past the edge to the last column — so in a yard
    // narrower than 10 cells the signpost and lantern both collapsed onto
    // the whetstone's cell and three props drew on top of each other. Yard
    // width now varies with both the grid size and the cottage phase, so
    // anything absolute here is a collision waiting to happen.
    const span = Math.max(1, y.cols - 1);
    const col = (f: number): number =>
      y.cx + Math.max(0, Math.min(y.cols - 1, Math.round(f * span)));
    return {
      logStack: { cx: col(0.1), cy: front },
      whetstone: { cx: col(0.37), cy: front },
      signpost: { cx: col(0.63), cy: front },
      lantern: { cx: col(0.88), cy: Math.max(y.cy, front - 2) },
    };
  }

  private cottagePos(): { x: number; y: number } {
    return this.plot.forest.gridRef().footing(this.cottageCell());
  }

  // --- The Timber Line: how you move between worlds -------------------------
  //
  // Travel was a single raft on the lake (forward = click, back = an
  // undiscoverable right-click), then a dirt-road stub on the left and a plank
  // bridge on the right. The second version fixed the discoverability but not
  // the reading: two unrelated props at opposite screen edges, sharing no
  // visual language, so nothing said they were the two ends of one route.
  //
  // Now there is ONE narrow-gauge logging railway running along the back of
  // the clearing. Its left end is a halt with a handcar you ride back down the
  // line; its right end runs out onto a timber trestle over the ravine that a
  // foreman rebuilds for you — and paying WOOD to rebuild a TIMBER
  // trestle is what makes the travel cost read as a reason rather than a toll.
  //
  // The economics are untouched: travelStatus/repairBridge/crossBridge/
  // travelBackTo below are exactly as they were. This is presentation.

  /** The track runs along the BACK row of the plot, tucked under the treeline.
   * The old road/bridge sat at ~0.42 of the grid's depth, which cut the
   * clearing in half; along the back it frames the plot instead, and both ends
   * land naturally at the screen edges. Trees are kept off this row by
   * layout()'s reservation callback. */
  private railRow(): number {
    return 0;
  }

  private railFooting(cx: number): { x: number; y: number } {
    return this.plot.forest.gridRef().footing({ cx, cy: this.railRow() });
  }

  private haltPos(): { x: number; y: number } {
    return this.railFooting(0);
  }

  /** The handcar sits just along the rails from the platform, so the two read
   * as one installation without the car covering the departures board. */
  private handcarPos(): { x: number; y: number } {
    const p = this.railFooting(1);
    return { x: p.x + 2, y: p.y };
  }

  /** The chasm the bridge crosses, in logical px.
   *
   * Deliberately leaves a strip of FAR BANK on screen to the right. The old
   * crossing ran off the edge, so you never saw a span start and finish and
   * it never read as a bridge — you have to be able to see both ends. Kept
   * to the right ~13% so it costs the plot very little usable ground. */
  private ravineRect(): { x0: number; x1: number; top: number; bottom: number } {
    return {
      // Narrower than the chasm it replaces. A river only has to be too wide
      // to jump, not a canyon — the old 13% band swallowed a sixth of the
      // plot and read as the map ending rather than as a feature in it.
      x0: Math.round(this.w * 0.84),
      x1: Math.round(this.w * 0.92),
      top: this.groundTop(),
      bottom: this.h,
    };
  }

  private trestlePos(): { x: number; y: number } {
    const grid = this.plot.forest.gridRef();
    return this.railFooting(Math.max(0, grid.cols - 3));
  }

  /** The wright stands one step in FRONT of the track (a row nearer the
   * viewer), not on it — a person standing between the rails reads as about
   * to be run down, and he'd also be occluded by his own trestle. */
  private foremanPos(): { x: number; y: number } {
    // At the bridge head, on the NEAR bank, just in front of the track.
    //
    // He used to stand a couple of rows below and to the right of the
    // crossing, which put him adrift in open grass — "the man at the bridge"
    // was not something the picture actually said. Anchoring him to the
    // ravine's near lip does say it, and it also solves the occlusion
    // complaint: the ravine cells are reserved from trees and props (see
    // layout), so nothing can ever be placed in front of him.
    const rav = this.ravineRect();
    // Well BELOW the deck, not level with it. At +8 his head sat behind the
    // bridge's approach planking and railing — the man you are meant to
    // click was drawn inside the structure he is standing next to. Dropping
    // him to +20 clears the whole span, and the depth sort then draws him in
    // front of it rather than behind.
    const y = this.railFooting(0).y + 20;
    return { x: rav.x0 - 8, y: Math.min(this.h - 4, y) };
  }

  private hitHandcar(lx: number, ly: number): boolean {
    if (this.backTravelOptions().length === 0) return false;
    const p = this.handcarPos();
    const size = spriteSize(HANDCAR_UP);
    // Generous on the left: the platform and board are part of the same
    // "leave from here" affordance, and they sit off the car's left edge.
    return (
      lx >= p.x - size.w - 4 && lx <= p.x + size.w && ly >= p.y - 16 && ly <= p.y + 3
    );
  }

  bridgeRepaired(world = this.save.worldIndex): boolean {
    return (this.save.bridgesRepaired ?? []).includes(world);
  }

  /** Pays the onward travel cost. Crossing is then free, and stays free if
   * you come back through later. */
  repairBridge(route: "timber" | "coin" | "sweat" = "timber"): boolean {
    const status = this.travelStatus();
    if (!status || !status.gateMet) return false;
    // Already built. This guard is what makes paying idempotent. The UI also
    // closes the bubble before running the handler, but a double-charge has
    // to be impossible at the money layer, not only at the presentation one.
    if (this.bridgeRepaired()) return false;

    const mult = getWorld(this.save.worldIndex + 1).mult;
    const amber = travelAmberCost(mult);
    const sweatWood = travelSweatWoodCost(status.cost);

    // Affordability is checked and the charge applied in the SAME branch, so
    // there is no path that verifies one resource and then deducts another.
    // The default stays "timber", so every existing caller (including the
    // keyboard affordance in main.ts) behaves exactly as before.
    if (route === "timber") {
      if (this.save.wood < status.cost) return false;
      this.save.wood -= status.cost;
    } else if (route === "coin") {
      if (this.save.amber < amber) return false;
      this.save.amber -= amber;
    } else {
      if (this.save.wood < sweatWood || this.save.focus < FOCUS_CAP) return false;
      this.save.wood -= sweatWood;
      this.save.focus = 0;
    }

    this.save.bridgesRepaired = [
      ...(this.save.bridgesRepaired ?? []),
      this.save.worldIndex,
    ];
    scheduleSave(this.save, true);
    return true;
  }

  /** Opens the departures board at the halt. Every world `backTravelOptions`
   * offers becomes a row; picking one calls the existing travelBackTo, which
   * has always accepted an arbitrary world index — the old road handler just
   * threw everything but `[0]` away, so getting from world 5 back to world 1
   * meant four separate trips through four separate loading slides. */
  private openDepartureBoard(): void {
    const options = this.backTravelOptions();
    if (options.length === 0) return;
    const anchor = this.handcarPos();
    this.dialogue = {
      speaker: { x: anchor.x, y: anchor.y - 12 },
      lines: ["DEPARTURES"],
      // Two columns past six entries: the logical canvas is only ~120-140px
      // tall, and ten worlds in one column would run off the bottom.
      columns: options.length > 6 ? 2 : 1,
      choices: options.map((o) => ({
        label: o.name.toUpperCase(),
        onPick: () => {
          if (this.travelBackTo(o.world)) {
            this.handcarDepartT = Game.HANDCAR_DEPART_SECS;
            playSfx("railWhistle");
          }
        },
      })),
    };
    this.dialogueHover = null;
  }

  /** The foreman's line for whatever state the crossing is in. He is the
   * single voice for onward travel: the gate, the price, and the all-clear
   * all come from him, so there is one place to look. */
  private openForemanDialogue(): void {
    const st = this.travelStatus();
    if (!st) return;
    const w = this.foremanPos();
    const speaker = { x: w.x, y: w.y - spriteSize(NPCS.foreman.idle).h - 1 };
    // Narrow on purpose. The bubble is clamped to the canvas, and the canvas
    // is only ~240 logical px wide — a wide wrap produced a box spanning half
    // the world. Wrapping sooner gives a taller, chattier, much smaller box.
    const maxW = Math.min(76, this.w - 16);
    const say = (text: string): string[] => wrapLines(text, maxW);

    // Repaired FIRST. Checking the gate first meant a returning player was
    // told to clear three more plots while standing in front of their own
    // finished bridge.
    if (this.bridgeRepaired()) {
      this.dialogue = {
        speaker,
        lines: say(`She will hold. Track is open to ${st.nextName}.`),
        choices: [
          {
            label: "ALL ABOARD",
            onPick: () => {
              if (this.crossBridge()) playSfx("railWhistle");
            },
          },
          { label: "NOT YET", onPick: () => {} },
        ],
      };
    } else if (!st.gateMet) {
      const left = st.gate - this.save.plotsClearedInWorld;
      this.dialogue = {
        speaker,
        lines: say(
          `No sense laying track to nowhere. Clear ${left} more plot${left === 1 ? "" : "s"} first.`,
        ),
        choices: [{ label: "RIGHT YOU ARE", onPick: () => {} }],
      };
    } else if (!this.bridgeRepaired()) {
      // Three ways to settle, all building the identical bridge — the choice
      // is "what am I short of", not "which is best". See economy.ts for why
      // Sweat still charges wood (Focus is free and would otherwise make
      // every crossing in the game free) and why Coin scales with the world.
      const mult = getWorld(this.save.worldIndex + 1).mult;
      const amber = travelAmberCost(mult);
      const sweatWood = travelSweatWoodCost(st.cost);
      const routes: { label: string; ok: boolean; pay: () => void }[] = [
        {
          label: `TIMBER ${abbrev(st.cost)} WOOD`,
          ok: this.save.wood >= st.cost,
          pay: () => this.payTheForeman("timber"),
        },
        {
          label: `COIN ${abbrev(amber)} AMBER`,
          ok: this.save.amber >= amber,
          pay: () => this.payTheForeman("coin"),
        },
        {
          label: `SWEAT ${abbrev(sweatWood)} + FOCUS`,
          ok: this.save.wood >= sweatWood && this.save.focus >= FOCUS_CAP,
          pay: () => this.payTheForeman("sweat"),
        },
      ];
      const anyAffordable = routes.some((r) => r.ok);
      this.dialogue = {
        speaker,
        lines: say(
          anyAffordable
            ? "Wood you look at that. Span's down. So who's paying?"
            : "Span's down and you're skint. Come back with timber, coin, or a rested pair of arms.",
        ),
        choices: anyAffordable
          ? [
              // Unaffordable routes stay VISIBLE but disabled, so the price
              // list reads as a rate card. Hiding them would make the bubble
              // silently change shape depending on your balance.
              ...routes.map((r) => ({ label: r.label, onPick: r.pay, disabled: !r.ok })),
              { label: "NOT YET", onPick: () => {} },
            ]
          : [{ label: "AYE, FAIR ENOUGH", onPick: () => {} }],
      };
    } else {
      this.dialogue = {
        speaker,
        lines: say(`She will hold. Track is open to ${st.nextName}.`),
        choices: [
          {
            label: "ALL ABOARD",
            onPick: () => {
              if (this.crossBridge()) playSfx("railWhistle");
            },
          },
          { label: "NOT YET", onPick: () => {} },
        ],
      };
    }
    this.dialogueHover = null;
  }

  /** Does he have actual business, or is he just standing about? Drives
   * whether clicking him opens the rate card or just gets you a remark. */
  private foremanHasBusiness(): boolean {
    return this.travelStatus() !== null;
  }

  /** Pay, then let him actually build it. The beat matters: the whole point
   * of the two-step (pay, then cross) is that the wood buys a visible,
   * permanent change to the world instead of vanishing into a teleport, and
   * watching him swing the hammer is what sells that. */
  private payTheForeman(route: "timber" | "coin" | "sweat"): void {
    if (!this.repairBridge(route)) return;
    this.trestleBuildT = Game.TRESTLE_BUILD_SECS;
    // Seeded AT the start value, not 0, so the very first update tick already
    // satisfies `trestleBuildT <= trestleHammerNext` and the first blow lands
    // immediately. Seeding it at 0 would hold every blow until the beat was
    // already over.
    this.trestleHammerNext = Game.TRESTLE_BUILD_SECS;
    const t = this.trestlePos();
    this.effects.push(
      new LeafBurst(t.x - 6, t.y - 6, ["#8a6440", "#c49a6c"], 12, 0.6),
    );
  }

  /** Crosses an already-repaired bridge to the next world. */
  crossBridge(): boolean {
    const status = this.travelStatus();
    // NO GATE CHECK. The plot gate governs when you may BUILD the crossing,
    // not whether you may use one that already exists.
    //
    // travelBackTo resets plotsClearedInWorld, so riding back down the line
    // and then trying to come forward again demanded you re-clear three
    // plots for a bridge you had already paid for and built — the ladder
    // silently re-tolled itself every time you revisited. And since getting
    // PAST a world requires repairing its bridge in the first place, every
    // world you can travel back to necessarily has one: `bridgeRepaired`
    // alone is the correct and sufficient condition.
    if (!status || !this.bridgeRepaired() || this.nextPlot) return false;
    const s = this.save;
    s.worldIndex += 1;
    s.adventureWorldUnlocked = Math.max(s.adventureWorldUnlocked, s.worldIndex);
    s.plotIndex = 0;
    s.plotsClearedInWorld = 0;
    s.currentPlotHp = null;
    scheduleSave(s, true);
    this.startTransition(s.worldIndex, 0);
    return true;
  }

  /** The adventure encampment — where you set out from. Deliberately OUTSIDE
   * the fenced yard and further back toward the treeline, so the homestead
   * (what you build) and the expedition camp (where you leave) read as two
   * different places rather than more yard furniture. */
  private encampmentPos(): { x: number; y: number } {
    const grid = this.plot.forest.gridRef();
    const yard = this.yardRect();
    // Anchored to the grid as a whole, NOT to the yard's right edge: the yard
    // grows with each cottage phase, so "just past the fence" shoved the camp
    // off the map and into the lake.
    const cell = {
      cx: Math.max(
        yard.cx + yard.cols + 1,
        // 0.66, not 0.74: at 0.74 the camp landed on the strip of bank
        // between the homestead and the river, which is exactly where the
        // foreman has to stand.
        Math.min(grid.cols - 3, Math.round(grid.cols * 0.66)),
      ),
      // At least two rows clear of the track. The camp used to sit directly
      // under it, and its hover label draws ABOVE the sprite — which put a
      // long dark label straight across the rails.
      cy: Math.min(grid.rows - 1, Math.max(this.railRow() + 2, yard.cy - 3)),
    };
    const foot = grid.footing(cell);
    return this.avoidLake(foot.x, foot.y);
  }

  private hitEncampment(lx: number, ly: number): boolean {
    const p = this.encampmentPos();
    const size = spriteSize(ENCAMPMENT);
    return (
      Math.abs(lx - p.x) <= size.w / 2 + 1 && ly >= p.y - size.h - 1 && ly <= p.y + 1
    );
  }

  // --- The barn: the homestead's second permanent build ---------------------

  private barnCell(): Cell {
    const y = this.yardRect();
    const grid = this.plot.forest.gridRef();
    const wanted = Math.min(y.cx + y.cols - 2, y.cx + 5);
    // Walk left along the yard's back row until the cell is dry. The yard
    // widens with each cottage phase and the lake is seeded per plot, so the
    // two genuinely overlap on some plots — and a barn standing in the pond
    // is the kind of thing you only notice after you have paid for it.
    for (let cx = wanted; cx > y.cx; cx--) {
      const f = grid.footing({ cx, cy: y.cy });
      if (!this.plot.lake.contains(f.x, f.y)) return { cx, cy: y.cy };
    }
    return { cx: wanted, cy: y.cy };
  }

  private barnPos(): { x: number; y: number } {
    return this.plot.forest.gridRef().footing(this.barnCell());
  }

  barnPhase(): number {
    return Math.max(0, Math.min(BARN_MAX_PHASE, this.save.barnPhase ?? 0));
  }

  /** The barn only unlocks once the cottage is finished — a second landmark
   * is a reward for completing the first, not a parallel track. */
  barnAvailable(): boolean {
    return barnUnlocked(this.cottagePhase());
  }

  barnNextCost(): number | null {
    if (!this.barnAvailable()) return null;
    return barnPhaseCost(this.barnPhase(), getWorld(this.save.worldIndex).mult);
  }

  buildBarnPhase(): boolean {
    const cost = this.barnNextCost();
    if (cost === null || this.save.wood < cost) return false;
    this.save.wood -= cost;
    this.save.barnPhase = this.barnPhase() + 1;
    // The barn stands on a yard cell, so keep the clearing consistent for
    // the same reason buildCottagePhase does.
    this.layout();
    scheduleSave(this.save, true);
    return true;
  }

  private hitBarn(lx: number, ly: number): boolean {
    if (!this.barnAvailable()) return false;
    const p = this.barnPos();
    const size = spriteSize(BARN_PHASE_SPRITES[this.barnPhase()]);
    return (
      Math.abs(lx - p.x) <= size.w / 2 + 1 && ly >= p.y - size.h - 1 && ly <= p.y + 1
    );
  }

  // --- The cottage ----------------------------------------------------------

  cottagePhase(): number {
    return Math.max(0, Math.min(COTTAGE_MAX_PHASE, this.save.cottagePhase ?? 0));
  }

  cottageNextCost(): number | null {
    return cottagePhaseCost(
      this.cottagePhase(),
      getWorld(this.save.worldIndex).mult,
    );
  }

  buildCottagePhase(): boolean {
    const cost = this.cottageNextCost();
    if (cost === null || this.save.wood < cost) return false;
    this.save.wood -= cost;
    this.save.cottagePhase = this.cottagePhase() + 1;
    // The yard GROWS with each cottage phase, so land that was forest a
    // moment ago is now inside the fence. Re-running layout re-snaps the
    // trees out of the enlarged homestead (and reflows any placed
    // buildable), which is the visible payoff for the upgrade: the clearing
    // widens. Tree HP/standing state lives on the Tree objects and survives
    // a re-snap untouched.
    this.layout();
    scheduleSave(this.save, true);
    return true;
  }

  private hitCottage(lx: number, ly: number): boolean {
    const p = this.cottagePos();
    const frame = COTTAGE_PHASE_SPRITES[this.cottagePhase()];
    const size = spriteSize(frame);
    return (
      Math.abs(lx - p.x) <= Math.max(6, size.w / 2 + 1) &&
      ly >= p.y - size.h - 1 &&
      ly <= p.y + 1
    );
  }

  // --- Build Mode -----------------------------------------------------------

  /** Is the placer armed — i.e. will a canvas click drop or move something?
   * Distinct from the inventory merely being open. */
  buildModeActive(): boolean {
    return this.buildSelection !== null || this.buildMovingIndex !== null;
  }

  /** Should the inventory bar be on screen? */
  inventoryVisible(): boolean {
    return this.inventoryOpen || this.buildModeActive();
  }

  toggleInventory(): boolean {
    this.inventoryOpen = !this.inventoryOpen;
    if (!this.inventoryOpen) this.cancelBuildMode();
    return this.inventoryOpen;
  }

  openInventory(): void {
    this.inventoryOpen = true;
  }

  /** Everything you own but have not put down yet, in display order. */
  inventoryEntries(): { id: string; count: number }[] {
    const stock = this.save.decorStock ?? {};
    return BUILDABLES.filter((b) => (stock[b.id] ?? 0) > 0).map((b) => ({
      id: b.id,
      count: stock[b.id] ?? 0,
    }));
  }

  buildSelectionId(): string | null {
    return this.buildSelection;
  }

  /** How many of a buildable you own in total — standing in the yard PLUS
   * sitting unplaced in your inventory. The cap has to apply to both: an
   * item in the box is one you have already bought. */
  totalOwned(id: string): number {
    return ownedCount(this.save.placed, id) + this.decorInStock(id);
  }

  /** Buys one and puts it in your inventory. Nothing is placed — you open
   * the inventory and put it down wherever you like, whenever you like.
   *
   * Purchase used to happen on DROP: the shop merely armed the placer, and
   * every cell you clicked charged you again. Buying one bench and then
   * placing "it" six times silently cost six benches, because there was no
   * such thing as a bought item — only a charge per drop. Now a purchase is
   * a thing you own. */
  buyBuildable(id: string): boolean {
    const spec = buildableById(id);
    if (!spec) return false;
    if (this.totalOwned(id) >= spec.maxOwned) return false;
    const cost = buildableCost(spec, getWorld(this.save.worldIndex).mult);
    if (this.save.wood < cost) return false;
    this.save.wood -= cost;
    const stock = this.save.decorStock ?? {};
    this.save.decorStock = { ...stock, [id]: (stock[id] ?? 0) + 1 };
    scheduleSave(this.save, true);
    return true;
  }

  /** Arms placement with something you already own. Nothing is charged here
   * or on the drop — you paid when you bought it. */
  beginPlacing(id: string): boolean {
    if (!buildableById(id)) return false;
    if (this.decorInStock(id) <= 0) return false;
    this.buildSelection = id;
    this.buildMovingIndex = null;
    return true;
  }

  cancelBuildMode(): void {
    this.buildSelection = null;
    this.buildMovingIndex = null;
    this.inventoryOpen = false;
  }

  /** What the pointer is over in the world, if it's something you can use.
   * Every interactive prop was previously silent — nothing named what the
   * boat or the little gold badge actually did, so the whole clearing read as
   * scenery with a few mystery hotspots. */
  private resolveHoverTarget(
    lx: number,
    ly: number,
  ): { label: string; x: number; y: number; enabled: boolean } | null {
    if (this.battleViewOpen || this.povTarget || this.nextPlot) return null;

    const wc = this.hitWoodcutter(lx, ly);
    if (wc) {
      return wc.readyToChop
        ? { label: "CHOP UP CLOSE", x: wc.x, y: wc.y - 16, enabled: true }
        : {
            label: "IDLE - WAITING FOR WORK",
            x: wc.x,
            y: wc.y - 16,
            enabled: false,
          };
    }

    if (this.hitCottage(lx, ly)) {
      const p = this.cottagePos();
      const cost = this.cottageNextCost();
      // BELOW the cottage. Hovering the homestead is exactly what reveals the
      // status board (see `boardReveal`), and that board hangs on the
      // cottage's gable — so a label drawn above the roof landed straight on
      // the numbers the hover was meant to show you. The two now stack:
      // board above the roof, label below the door.
      const y = p.y + 11;
      if (cost === null) {
        return { label: "YOUR COTTAGE", x: p.x, y, enabled: false };
      }
      return {
        label: `BUILD ${COTTAGE_PHASE_NAME[this.cottagePhase()]} - ${abbrev(cost)} WOOD`,
        x: p.x,
        y,
        enabled: this.save.wood >= cost,
      };
    }

    if (this.hitEncampment(lx, ly)) {
      const p = this.encampmentPos();
      const adv = this.save.adventure;
      return {
        label: adv
          ? `RESUME ADVENTURE - ROOM ${adv.roomsCleared + 1}/${TOTAL_ROOMS}`
          : "SET OUT ON AN ADVENTURE",
        x: p.x,
        // BELOW the tent, unlike every other prop's label. The camp already
        // carries its own party/stage badge directly above it, and a label
        // drawn upward landed square on that badge — two dark plaques of
        // overlapping text. Below the tent is open grass at every window
        // size, and it keeps the label clear of the rail line behind it too.
        y: p.y + 11,
        enabled: true,
      };
    }

    if (this.hitBarn(lx, ly)) {
      const p = this.barnPos();
      const cost = this.barnNextCost();
      const y = p.y - spriteSize(BARN_PHASE_SPRITES[this.barnPhase()]).h - 4;
      if (cost === null) return { label: "THE BARN", x: p.x, y, enabled: false };
      return {
        label: `RAISE BARN ${BARN_PHASE_NAME[this.barnPhase()]} - ${abbrev(cost)} WOOD`,
        x: p.x,
        y,
        enabled: this.save.wood >= cost,
      };
    }

    // NOTE: this branch and its twin in handleClick are near-identical by
    // shape and must be kept in step BY HAND. A blanket find-and-replace over
    // `if (this.hitX(lx, ly)) {` has already corrupted this file once.
    if (this.hitHandcar(lx, ly)) {
      const p = this.handcarPos();
      return { label: "RIDE THE LINE BACK", x: p.x + 6, y: p.y - 18, enabled: true };
    }

    // The whole cast, in one sweep. Each label names the person rather than
    // their business — what they actually want is their own line to deliver
    // (see talkTo / openForemanDialogue), and duplicating it here would put
    // the same information in two visual languages a few pixels apart.
    for (const id of NPC_IDS) {
      if (!this.hitNpc(id, lx, ly)) continue;
      const p = this.npcPos(id);
      const busy =
        id === "foreman" && this.foremanHasBusiness() && !this.bridgeRepaired();
      return {
        label: busy ? "THE FOREMAN - HE WANTS PAYING" : `TALK TO ${NPCS[id].name}`,
        x: p.x,
        // BELOW them, like every other label near the rail line: above their
        // heads is where their speech opens AND where the track runs.
        y: p.y + 11,
        enabled: true,
      };
    }

    if (this.hitSignpost(lx, ly)) {
      const p = this.signpostPos();
      return { label: "SETTINGS", x: p.x, y: p.y - 20, enabled: true };
    }

    const press = this.sapPressPos();
    if (
      this.sapPressOwned() &&
      Math.abs(lx - press.x) <= 6 &&
      Math.abs(ly - press.y) <= 7
    ) {
      const cost = sapPressCost(getWorld(this.save.worldIndex).mult);
      return {
        label: `PRESS SAP - ${abbrev(cost)} WOOD`,
        x: press.x,
        y: press.y - 14,
        enabled: this.save.wood >= cost,
      };
    }

    if (
      this.goldenLog &&
      Math.abs(lx - this.goldenLog.x) <= 6 &&
      Math.abs(ly - this.goldenLog.y) <= 5
    ) {
      return {
        label: "GOLDEN LOG",
        x: this.goldenLog.x,
        y: this.goldenLog.y - 8,
        enabled: true,
      };
    }

    if (this.koi) {
      const k = this.plot.lake.koiPosition(this.koi.phase);
      if (Math.hypot(lx - k.x, ly - k.y) <= Game.KOI_CLICK_RADIUS) {
        return { label: "CATCH KOI", x: k.x, y: k.y - 8, enabled: true };
      }
    }

    const tree = this.plot.forest.treeAt(lx, ly);
    if (!tree) return null;
    return {
      label: this.save.focus > 0 ? "CHOP" : "NO FOCUS",
      x: tree.x + tree.width / 2,
      y: tree.y - tree.height - 2,
      enabled: this.save.focus > 0,
    };
  }

  hoverIsInteractive(): boolean {
    return (
      this.buildModeActive() ||
      this.hoverTarget !== null ||
      this.dialogueHover !== null ||
      // A doorway is a control, so the cursor has to say so — without this the
      // one genuinely clickable thing on the canvas between rooms looks
      // exactly as inert as the flagstones.
      this.doorHover !== null
    );
  }

  /** Canvas hover, driven from main.ts. */
  handleHover(lx: number, ly: number): void {
    // A takeover owns the pointer. Without this the homestead grid, tree and
    // cottage hit-tests all kept running underneath the battle view — they are
    // meaningless in a dungeon, and they would have competed with the doorways
    // for the same pixels the moment those became clickable.
    if (this.battleViewOpen) {
      this.hoverCell = null;
      this.hoverTarget = null;
      this.handleBattleHover(lx, ly);
      return;
    }
    // An open conversation takes the pointer, matching the way it takes every
    // click — otherwise the world's own hover labels keep firing underneath a
    // bubble the player is reading.
    if (this.dialogue) {
      this.hoverCell = null;
      this.hoverTarget = null;
      const layout = layoutBubble(this.dialogue, this.w, this.h);
      const idx = hitChoice(layout, lx, ly);
      this.dialogueHover =
        idx !== null && !this.dialogue.choices[idx].disabled ? idx : null;
      return;
    }
    this.dialogueHover = null;
    // Pointer anywhere over the homestead reveals the status board. The
    // whole fenced plot is the target rather than the cottage alone: it's a
    // big, obvious area, and "look at my homestead" is the intent behind
    // wanting the numbers.
    this.boardHovered = this.pointerOverHomestead(lx, ly);
    if (this.buildModeActive()) {
      this.hoverCell = this.plot.forest.gridRef().cellAt(lx, ly);
      this.hoverTarget = null;
      return;
    }
    this.hoverCell = null;
    this.hoverTarget = this.resolveHoverTarget(lx, ly);
  }

  /** Is the pointer over the fenced homestead (or the board hanging above
   * the cottage)? Extends upward past the yard's own top edge because the
   * board and the cottage roof both stand above the plot's back row — the
   * reveal would otherwise vanish the moment you moved onto the thing you
   * were trying to read. */
  private pointerOverHomestead(lx: number, ly: number): boolean {
    const grid = this.plot.forest.gridRef();
    const y = this.yardRect();
    const nw = grid.center({ cx: y.cx, cy: y.cy });
    const se = grid.center({ cx: y.cx + y.cols - 1, cy: y.cy + y.rows - 1 });
    return (
      lx >= nw.x - CELL / 2 - 2 &&
      lx <= se.x + CELL / 2 + 2 &&
      ly >= nw.y - CELL * 3 &&
      ly <= se.y + CELL / 2 + 2
    );
  }

  clearHover(): void {
    this.hoverCell = null;
    this.hoverTarget = null;
    this.dialogueHover = null;
    this.boardHovered = false;
  }

  /** Screen rects of the open conversation's choice rows, in logical px, in
   * choice order. Empty when nothing is open.
   *
   * Exists so the headless interaction tests can click a reply where it
   * actually is instead of reaching in and invoking `onPick` directly — the
   * bit worth testing about "PAY" is precisely that the CLICK path can't fire
   * it twice, and calling the handler by hand tests the one thing that was
   * never in doubt. Read-only, so it costs nothing to ship. */
  dialogueChoiceRects(): { x: number; y: number; w: number; h: number }[] {
    if (!this.dialogue) return [];
    return layoutBubble(this.dialogue, this.w, this.h).choiceRects;
  }

  /** Drop any open conversation. Called whenever the world is about to be
   * replaced or covered — a bubble anchored to a speaker who is no longer on
   * screen would hang in mid-air over the new view. */
  private closeDialogue(): void {
    this.dialogue = null;
    this.dialogueHover = null;
  }

  /** Whether a cell can take the thing currently being placed. */
  canPlaceAt(c: Cell): boolean {
    const grid = this.plot.forest.gridRef();
    if (!grid.inBounds(c)) return false;
    const y = this.yardRect();
    if (c.cx < y.cx || c.cx >= y.cx + y.cols) return false;
    if (c.cy < y.cy || c.cy >= y.cy + y.rows) return false;
    const key = Grid.key(c);
    if (key === Grid.key(this.cottageCell())) return false;
    if (this.barnAvailable() && key === Grid.key(this.barnCell())) return false;
    for (const p of Object.values(this.yardPropCells())) {
      if (Grid.key(p) === key) return false;
    }
    // A tree standing in the cell blocks it. freeYardCells never consulted the
    // forest's own occupancy map despite that map's doc comment claiming to be
    // exactly this check, so buildables could be dropped inside a tree trunk.
    if (this.plot.forest.occupiedCells().has(key)) return false;
    // Not in the water. The yard widens with each cottage phase and the lake
    // is seeded per plot, so the two genuinely can overlap.
    const foot = grid.footing(c);
    if (this.plot.lake.contains(foot.x, foot.y)) return false;
    const placed = this.save.placed ?? [];
    for (let i = 0; i < placed.length; i++) {
      if (i === this.buildMovingIndex) continue;
      if (placed[i].cx === c.cx && placed[i].cy === c.cy) return false;
    }
    return true;
  }

  /** Drops whatever Build Mode is holding onto the hovered cell. */
  commitPlacement(): "placed" | "moved" | "invalid" | "unaffordable" | "maxed" | "none" {
    const cell = this.hoverCell;
    if (!cell || !this.buildModeActive()) return "none";
    if (!this.canPlaceAt(cell)) return "invalid";

    if (this.buildMovingIndex !== null) {
      const placed = [...(this.save.placed ?? [])];
      const moving = placed[this.buildMovingIndex];
      if (!moving) return "none";
      placed[this.buildMovingIndex] = { ...moving, cx: cell.cx, cy: cell.cy };
      this.save.placed = placed;
      this.buildMovingIndex = null;
      scheduleSave(this.save, true);
      return "moved";
    }

    const spec = buildableById(this.buildSelection ?? "");
    if (!spec) return "none";
    // Placing SPENDS AN OWNED ITEM. It never charges wood — that already
    // happened at the shop. Running out of stock is the only thing that can
    // stop a drop now.
    const stock = this.save.decorStock ?? {};
    if ((stock[spec.id] ?? 0) <= 0) return "unaffordable";
    this.save.decorStock = { ...stock, [spec.id]: stock[spec.id] - 1 };
    this.save.placed = [
      ...(this.save.placed ?? []),
      { id: spec.id, cx: cell.cx, cy: cell.cy },
    ];
    // Keep the placer armed while you still have more of this to put down —
    // laying a row of fence posts should not mean reopening a menu each time.
    if (this.decorInStock(spec.id) <= 0) this.buildSelection = null;
    scheduleSave(this.save, true);
    return "placed";
  }

  /** Clicking an already-placed item picks it up to move it — the natural
   * "no, move THAT one" gesture. */
  pickUpAt(c: Cell): boolean {
    const placed = this.save.placed ?? [];
    const i = placed.findIndex((p) => p.cx === c.cx && p.cy === c.cy);
    if (i < 0) return false;
    this.buildMovingIndex = i;
    this.buildSelection = null;
    return true;
  }

  /** Removes a placed item, refunding half. */
  removeAt(c: Cell): boolean {
    const placed = [...(this.save.placed ?? [])];
    const i = placed.findIndex((p) => p.cx === c.cx && p.cy === c.cy);
    if (i < 0) return false;
    // Picked-up items go back in the box, not half-refunded as wood. You
    // bought the thing; rearranging your own yard should be lossless.
    const id = placed[i].id;
    const stock = this.save.decorStock ?? {};
    this.save.decorStock = { ...stock, [id]: (stock[id] ?? 0) + 1 };
    placed.splice(i, 1);
    this.save.placed = placed;
    if (this.buildMovingIndex === i) this.buildMovingIndex = null;
    scheduleSave(this.save, true);
    return true;
  }

  /** Cells inside the yard that nothing is standing on yet — where a bought
   * buildable may be placed. Excludes the cottage's own cell and anything
   * already placed. */
  freeYardCells(): Cell[] {
    const y = this.yardRect();
    const grid = this.plot.forest.gridRef();
    const taken = new Set<string>();
    taken.add(Grid.key(this.cottageCell()));
    if (this.barnAvailable()) taken.add(Grid.key(this.barnCell()));
    // The readouts are furnishings occupying real cells, so a bought buildable
    // can't be dropped on top of the log pile or the signpost.
    for (const c of Object.values(this.yardPropCells())) taken.add(Grid.key(c));
    for (const p of this.save.placed ?? []) {
      taken.add(Grid.key({ cx: p.cx, cy: p.cy }));
    }
    const out: Cell[] = [];
    for (let dy = 0; dy < y.rows; dy++) {
      for (let dx = 0; dx < y.cols; dx++) {
        const c = { cx: y.cx + dx, cy: y.cy + dy };
        if (!grid.inBounds(c)) continue;
        if (taken.has(Grid.key(c))) continue;
        out.push(c);
      }
    }
    return out;
  }

  // --- NPCs -----------------------------------------------------------------

  /** Where each character stands, in logical px.
   *
   * Lives here rather than in the registry because every one of these depends
   * on plot state the registry has no business knowing: the fisher needs the
   * lake's seeded position, the foreman needs the bridge, the quartermaster
   * needs the camp. */
  npcPos(id: NpcId): { x: number; y: number } {
    if (id === "foreman") return this.foremanPos();
    if (id === "quartermaster") {
      const camp = this.encampmentPos();
      // Off to the camp's left so he doesn't stand in the tent doorway, and
      // clear of the tent's own party/stage badge.
      return this.avoidLake(camp.x - 16, camp.y + 2);
    }
    return this.fisherPos();
  }

  /** The fisher sits on the near shore, on whichever side has more room, so
   * he never ends up wedged against a screen edge or standing in the yard. */
  private fisherPos(): { x: number; y: number } {
    const lake = this.plot.lake;
    const yard = this.yardRect();
    const grid = this.plot.forest.gridRef();
    const yardRight =
      grid.center({ cx: yard.cx + yard.cols - 1, cy: yard.cy }).x + CELL / 2;
    const leftRoom = lake.cx - lake.rx - yardRight;
    const rightRoom = this.w - (lake.cx + lake.rx);
    const onLeft = leftRoom > rightRoom;
    let x = onLeft ? lake.cx - lake.rx - 8 : lake.cx + lake.rx + 8;
    // Never in the river. Picking a bank by lake room alone put him on the
    // right of the lake, which on plots where the lake sits far over is
    // exactly where the river runs — so he ended up sitting IN the water
    // with half of him on the far bank. If the chosen side collides, put him
    // back on the near bank of the river instead.
    const rav = this.ravineRect();
    const half = spriteSize(NPCS.fisher.idle).w / 2;
    if (x + half >= rav.x0 - 2 && x - half <= rav.x1 + 2) {
      x = rav.x0 - half - 4;
    }
    return {
      x: Math.max(6, Math.min(this.w - 8, Math.round(x))),
      // Near the lake's waterline, a little toward the viewer so he reads as
      // sitting on the bank rather than floating on the surface.
      y: Math.round(lake.cy + lake.ry * 0.5),
    };
  }

  private npcSize(id: NpcId): { w: number; h: number } {
    return spriteSize(NPCS[id].idle);
  }

  private hitNpc(id: NpcId, lx: number, ly: number): boolean {
    if (!this.npcPresent(id)) return false;
    const p = this.npcPos(id);
    const size = this.npcSize(id);
    // The sprite, plus 2px of slop. Nothing more.
    //
    // The foreman used to ALSO answer for the whole trestle box, which made
    // his click target a large invisible rectangle stretching off to the
    // right — you would open his rate card by clicking apparently empty
    // ground, and clicking the man himself was the unreliable part. Now that
    // he stands at the bridge head, "click the person" is both the obvious
    // gesture and the only one.
    return (
      Math.abs(lx - p.x) <= size.w / 2 + 2 && ly >= p.y - size.h - 2 && ly <= p.y + 2
    );
  }

  /** Whether a character is on this plot at all. The foreman only exists
   * where there is a crossing to build; the others are always about. */
  private npcPresent(id: NpcId): boolean {
    if (id === "foreman") return this.travelStatus() !== null;
    return true;
  }

  /** A read-only view of the live telemetry plus the player's stores, for
   * lines that want to be specific. Rebuilt per pick rather than cached: the
   * numbers move constantly and a stale quote is worse than no quote. */
  private usageView(): UsageView {
    return buildUsageView(this.lastSnapshot, this.density, {
      wood: this.save.wood,
      amber: this.save.amber,
      focus: this.save.focus,
    });
  }

  /** Anchor for a character's speech, just above their head. */
  private npcSpeakerPoint(id: NpcId): { x: number; y: number } {
    const p = this.npcPos(id);
    return { x: p.x, y: p.y - this.npcSize(id).h - 1 };
  }

  /** Click-to-talk: a fresh random line, in a modal bubble with one dismiss
   * row. The foreman is the exception — when there is business to do, his
   * business takes priority over his chatter (see openForemanDialogue). */
  private talkTo(id: NpcId): void {
    if (id === "foreman" && this.foremanHasBusiness()) {
      this.openForemanDialogue();
      return;
    }
    const u = this.usageView();
    const line = pickLine(NPCS[id].lines, u, { previous: this.lastLine.get(id) ?? null });
    if (!line) return;
    this.lastLine.set(id, line);
    this.dialogue = {
      speaker: this.npcSpeakerPoint(id),
      lines: wrapLines(renderLine(line, u), Math.min(76, this.w - 16)),
      choices: [{ label: "AYE", onPick: () => {} }],
    };
    this.dialogueHover = null;
  }

  /** Tick the unprompted chatter.
   *
   * Rules, in order of how annoying their absence would be:
   *   - never during a takeover (battle, POV, build mode, a world slide) or
   *     while a real conversation is open;
   *   - one speaker at a time, globally, so two characters never talk over
   *     each other;
   *   - a long random gap, re-rolled each time, so the rhythm never becomes
   *     predictable enough to notice.
   * Ambient bubbles are drawn but never hit-tested, so a mutter can't eat a
   * click meant for the world underneath it. */
  private updateAmbient(dt: number): void {
    if (this.ambient) {
      this.ambient.ttl -= dt;
      if (this.ambient.ttl <= 0) this.ambient = null;
      return;
    }
    const busy =
      this.battleViewOpen ||
      this.povTarget !== null ||
      this.nextPlot !== null ||
      this.buildModeActive() ||
      this.dialogue !== null;
    if (busy) return;
    this.ambientCooldown -= dt;
    if (this.ambientCooldown > 0) return;
    this.ambientCooldown =
      Game.AMBIENT_MIN_GAP + Math.random() * (Game.AMBIENT_MAX_GAP - Game.AMBIENT_MIN_GAP);

    const present = NPC_IDS.filter((id) => this.npcPresent(id));
    if (present.length === 0) return;
    const id = present[Math.floor(Math.random() * present.length)];
    const u = this.usageView();
    const line = pickLine(NPCS[id].lines, u, { ambient: true, previous: this.lastLine.get(id) ?? null });
    if (!line) return;
    this.lastLine.set(id, line);
    this.ambient = {
      speaker: this.npcSpeakerPoint(id),
      lines: wrapLines(renderLine(line, u), Math.min(70, this.w - 16)),
      ttl: Game.AMBIENT_LIFE,
      life: Game.AMBIENT_LIFE,
    };
  }

  /** Queue every present character into the depth-sorted pass, so a
   * woodcutter walking past one is occluded by them exactly like a tree. */
  private pushNpcDrawables(
    ctx: CanvasRenderingContext2D,
    drawables: { y: number; draw: () => void }[],
  ): void {
    for (const id of NPC_IDS) {
      if (!this.npcPresent(id)) continue;
      const p = this.npcPos(id);
      drawables.push({
        y: p.y + 0.3,
        draw: () => {
          if (id === "fisher") this.drawFisherLine(ctx, p);
          const def = NPCS[id];
          // The foreman's hammer frames are driven by the rebuild beat when
          // he's working; otherwise everyone just breathes on their own slow
          // cycle, offset per character so they never sync up.
          let frame = def.idle;
          if (id === "foreman" && this.trestleBuildT > 0) {
            frame = Math.sin(this.animT * 14) > 0 ? FOREMAN_WORK_FRAMES.up : FOREMAN_WORK_FRAMES.down;
          } else if (def.alt && def.altRate) {
            const phase = id.charCodeAt(0);
            if (Math.sin(this.animT * def.altRate + phase) > 0.86) frame = def.alt;
          }
          const size = spriteSize(frame);
          // The fisher's rod is baked pointing RIGHT, so he has to be
          // mirrored whenever he's sitting on the far bank — otherwise he
          // casts off into the grass while his line runs the other way.
          const flip = id === "fisher" && !this.fisherFacesRight();
          drawSprite(ctx, frame, p.x - Math.floor(size.w / 2), p.y - size.h, flip);
        },
      });
    }
  }

  /** Which way the fisher is turned: toward the water, always. Shared by the
   * sprite flip and the line/float placement so the two can never disagree. */
  private fisherFacesRight(): boolean {
    return this.fisherPos().x < this.plot.lake.cx;
  }

  /** The fisher's line, from his rod tip out to the water, with a float
   * bobbing on the surface. Drawn procedurally rather than baked into the
   * sprite because the lake's position is seeded per plot — a painted-on line
   * would point at grass half the time. */
  private drawFisherLine(ctx: CanvasRenderingContext2D, p: { x: number; y: number }): void {
    const lake = this.plot.lake;
    const size = spriteSize(NPCS.fisher.idle);
    const facingRight = this.fisherFacesRight();
    const tipX = p.x + (facingRight ? size.w / 2 : -size.w / 2);
    const tipY = p.y - size.h + 2;
    // Land the float a little inside the near edge of the water.
    const floatX = Math.round(lake.cx + (facingRight ? -lake.rx * 0.45 : lake.rx * 0.45));
    const bob = Math.round(Math.sin(this.animT * 1.7) * 1);
    const floatY = Math.round(lake.cy + lake.ry * 0.25) + bob;
    ctx.strokeStyle = "rgba(235, 240, 245, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(tipX) + 0.5, Math.round(tipY) + 0.5);
    ctx.lineTo(floatX + 0.5, floatY + 0.5);
    ctx.stroke();
    ctx.fillStyle = "#d64545";
    ctx.fillRect(floatX, floatY, 1, 2);
  }

  /** Every rectangle a tree's silhouette must stay out of.
   *
   * The lake is handled separately by treeWouldIntrude (it is an ellipse, not
   * a rect); everything else in the world that a tree must not grow through
   * or in front of is listed here, in one place, so a new prop only has to be
   * added once. */
  private treeKeepOutRects(): { x0: number; y0: number; x1: number; y1: number }[] {
    const grid = this.plot.forest.gridRef();
    const rects: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const box = (
      p: { x: number; y: number },
      map: PixelMap,
      pad = 1,
    ): { x0: number; y0: number; x1: number; y1: number } => {
      const size = spriteSize(map);
      return {
        x0: p.x - size.w / 2 - pad,
        y0: p.y - size.h - pad,
        x1: p.x + size.w / 2 + pad,
        y1: p.y + pad,
      };
    };

    // The homestead, generously. No trees in the home area at all — the yard
    // is a cleared plot of land, and the fence is meant to enclose ground you
    // can build on, not a thicket.
    const y = this.yardRect();
    const nw = grid.center({ cx: y.cx, cy: y.cy });
    const se = grid.center({ cx: y.cx + y.cols - 1, cy: y.cy + y.rows - 1 });
    // Exactly the yard, plus a couple of pixels. Padding this by a whole
    // cell on every side (and two above) reserved 60 of the grid's 160 cells
    // on its own — between that, the track, the river and the lake, only 13
    // cells were left for 28 trees, so the forest's placement spiral gave up
    // and dropped trees into reserved ground anyway. The canopy test already
    // provides the real clearance; the rect only has to be the thing itself.
    rects.push({
      x0: nw.x - CELL / 2 - 2,
      y0: nw.y - CELL / 2 - 2,
      x1: se.x + CELL / 2 + 2,
      y1: se.y + CELL / 2 + 2,
    });

    // The track, edge to edge. It has to run unbroken for the two ends of
    // the line to read as one route.
    const railY = this.railFooting(0).y;
    // The tile is 5px tall; reserving a full cell above it cost another 20
    // cells for no visual benefit.
    rects.push({ x0: -CELL, y0: railY - 6, x1: this.w + CELL, y1: railY + 2 });

    // The river and its banks.
    const rav = this.ravineRect();
    rects.push({ x0: rav.x0 - 2, y0: rav.top - 4, x1: rav.x1 + 2, y1: rav.bottom });

    // Buildings and props that stand outside the fence.
    rects.push(box(this.encampmentPos(), ENCAMPMENT, 1));
    if (this.sapPressOwned()) rects.push(box(this.sapPressPos(), SAP_PRESS_IDLE));
    rects.push(box(this.signpostPos(), SIGNPOST_IDLE));

    // The cast. A tree in front of a person hides them and, worse, eats the
    // click meant for them.
    for (const id of NPC_IDS) {
      if (!this.npcPresent(id)) continue;
      rects.push(box(this.npcPos(id), NPCS[id].idle, 1));
    }
    return rects;
  }

  /** Would a tree standing at `foot` overlap the lake or any keep-out rect?
   *
   * Samples the tree silhouette rather than its bounding box: the canopy is
   * wide at the top and the trunk narrow at the bottom, so a full-rectangle
   * test would reserve cells whose tree never actually reaches the water. */
  private treeWouldIntrude(
    foot: { x: number; y: number },
    rects: { x0: number; y0: number; x1: number; y1: number }[],
  ): boolean {
    const pts: [number, number][] = [
      [0, 0], // trunk base
      [-2, -2],
      [2, -2],
      [0, -CANOPY_H / 2],
      [-CANOPY_HALF_W, -CANOPY_H * 0.6],
      [CANOPY_HALF_W, -CANOPY_H * 0.6],
      [-CANOPY_HALF_W + 1, -CANOPY_H],
      [CANOPY_HALF_W - 1, -CANOPY_H],
      [0, -CANOPY_H],
    ];
    for (const [dx, dy] of pts) {
      const x = foot.x + dx;
      const y = foot.y + dy;
      if (this.plot.lake.contains(x, y)) return true;
      for (const r of rects) {
        if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) return true;
      }
    }
    return false;
  }

  /** Pull any placed buildable that has ended up outside the yard back into
   * it, onto the nearest free cell.
   *
   * The yard is defined in GRID CELLS and the grid is rebuilt from the
   * canvas on every resize, so its footprint moves whenever the window
   * does — it is anchored to the bottom-left, so shrinking the logical
   * canvas slides the yard up and leaves anything placed near the old
   * bottom edge stranded outside it. A stranded item is invisible (it draws
   * off the plot) and unreachable (Build Mode only hit-tests yard cells),
   * so it reads as "my bench got deleted".
   *
   * Best-effort by design: an item with nowhere free to go keeps its
   * current cell rather than being dropped. Losing the placement is bad;
   * losing the ITEM would be much worse. */
  private reconcilePlacements(): void {
    const placed = this.save.placed;
    if (!placed || placed.length === 0) return;
    const y = this.yardRect();
    const grid = this.plot.forest.gridRef();
    const inYard = (cx: number, cy: number): boolean =>
      cx >= y.cx &&
      cx < y.cx + y.cols &&
      cy >= y.cy &&
      cy < y.cy + y.rows &&
      grid.inBounds({ cx, cy });

    if (placed.every((p) => inYard(p.cx, p.cy))) return;

    // Rebuild against a live occupancy set so two relocated items can't be
    // sent to the same cell.
    const taken = new Set<string>();
    taken.add(Grid.key(this.cottageCell()));
    if (this.barnAvailable()) taken.add(Grid.key(this.barnCell()));
    for (const c of Object.values(this.yardPropCells())) taken.add(Grid.key(c));
    for (const p of placed)
      if (inYard(p.cx, p.cy)) taken.add(Grid.key({ cx: p.cx, cy: p.cy }));

    let moved = 0;
    const next = placed.map((p) => {
      if (inYard(p.cx, p.cy)) return p;
      let best: Cell | null = null;
      let bestD = Infinity;
      for (let dy = 0; dy < y.rows; dy++) {
        for (let dx = 0; dx < y.cols; dx++) {
          const c = { cx: y.cx + dx, cy: y.cy + dy };
          if (!grid.inBounds(c) || taken.has(Grid.key(c))) continue;
          // Nearest free cell to where it used to be, so a reflow feels like
          // the yard shifting under the furniture rather than a reshuffle.
          const d = (c.cx - p.cx) ** 2 + (c.cy - p.cy) ** 2;
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
      if (!best) return p;
      taken.add(Grid.key(best));
      moved++;
      return { ...p, cx: best.cx, cy: best.cy };
    });
    if (moved > 0) {
      this.save.placed = next;
      scheduleSave(this.save, false);
    }
  }

  /** Buys a buildable and drops it on the first free yard cell. Returns false
   * if it's unaffordable or the yard is full — the caller surfaces which. */
  placeBuildable(id: string): boolean {
    const spec = buildableById(id);
    if (!spec) return false;
    const cost = buildableCost(spec, getWorld(this.save.worldIndex).mult);
    if (this.save.wood < cost) return false;
    const free = this.freeYardCells();
    if (free.length === 0) return false;
    const cell = free[0];
    this.save.wood -= cost;
    this.save.placed = [
      ...(this.save.placed ?? []),
      { id, cx: cell.cx, cy: cell.cy },
    ];
    scheduleSave(this.save, true);
    return true;
  }

  /** How many free (chest-won) copies of a buildable are in stock. */
  decorInStock(id: string): number {
    return this.save.decorStock?.[id] ?? 0;
  }

  yardIsFull(): boolean {
    return this.freeYardCells().length === 0;
  }

  /** Every readout now stands on its own yard cell rather than at a
   * fraction-of-canvas position — see yardPropCells for why. */
  private logStackPos(): { x: number; y: number } {
    return this.plot.forest.gridRef().footing(this.yardPropCells().logStack);
  }

  private whetstonePos(): { x: number; y: number } {
    return this.plot.forest.gridRef().footing(this.yardPropCells().whetstone);
  }

  private lanternPos(): { x: number; y: number } {
    return this.plot.forest.gridRef().footing(this.yardPropCells().lantern);
  }

  //
  // NOTE: the brief describes a crank for "music volume" and a needle for SFX.
  // This game has no music — src/sfx.ts is entirely synthesized one-shots — so
  // rather than inventing a music bus, the crank drives SFX VOLUME and the
  // tone-arm drives SFX MUTE. Don't go looking for an audio track; there isn't
  // one.
  //
  // Volume reads as an 8-pip brass arc rather than crank angle: at a 5px radius
  // an angle simply isn't legible as a value. The crank still animates to the
  // level, but the pips are the actual readout.
  /** Crossroads Signpost — the in-world entrance to Settings. Sits between the
   * whetstone (x 31..41) and the lantern post, on the ground line like every
   * other prop. Unlike the three resource props this one IS clickable, so its
   * hit box has to be tight: a miss falls through to startDragging(). */
  private signpostPos(): { x: number; y: number } {
    return this.plot.forest.gridRef().footing(this.yardPropCells().signpost);
  }

  private hitSignpost(lx: number, ly: number): boolean {
    const p = this.signpostPos();
    return Math.abs(lx - p.x) <= 5 && ly >= p.y - 16 && ly <= p.y;
  }

  /** The BRIDGE's box in canvas-logical coords, for main.ts to park the
   * transparent keyboard-accessible travel affordance over. Null when there's
   * no onward world at all, so the affordance hides with it rather than
   * leaving a focusable ghost at the map edge. */
  travelTargetRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.travelStatus()) return null;
    // Points at the WRIGHT, not the trestle: he is what you interact with now.
    const p = this.foremanPos();
    return { x: p.x - 8, y: p.y - 12, w: 16, h: 16 };
  }

  /** The pile is ONE pyramid — 3 logs along the base, four rows, 7 total, so
   * at 4px per log it is exactly CELL (12px) wide and sits inside a single tile.
   * It used to be 6 wide (24px), straddling two cells, which meant the Build
   * Mode grid showed a free tile that the pile visually covered —
   * and the tier only decides how many of those 18 slots are filled. It
   * deliberately does NOT give each tier its own width/height, because that
   * made the stack change shape at every boundary: a full Cord packed 7 logs
   * into a tight 2-row stack, then a fresh Wall spread the same 7 across a
   * 6-wide base and read as a thinner, sparser pile despite being more wood.
   * With a single fixed pyramid, growth is strictly additive — logs only ever
   * get stacked on, never rearranged. */
  private static readonly PILE_BASE = 3;
  private static readonly PILE_ROWS = 4;
  /** Filled-slot range per tier. Each tier starts where the last one ended, so
   * the count is continuous across thresholds as well as monotonic. */
  private static readonly LOG_PILE = {
    kindling: { from: 1, to: 2 },
    cord: { from: 2, to: 4 },
    wall: { from: 4, to: 7 },
  } as const;

  /** Filled log slots for the current wood, 1..18. */
  private logPileCount(): number {
    const { tier, within } = logStackTier(this.save.wood, this.save.worldIndex);
    const { from, to } = Game.LOG_PILE[tier];
    return Math.max(1, from + Math.round((to - from) * within));
  }

  /** Builds the view the Timber Line renderer needs (see scene/travel.ts) and
   * hands off. Everything about HOW the line looks lives over there now; this
   * only knows where the pieces are. */
  private pushRailDrawables(
    ctx: CanvasRenderingContext2D,
    drawables: { y: number; draw: () => void }[],
  ): void {
    pushTimberLineDrawables(ctx, drawables, {
      w: this.w,
      animT: this.animT,
      railY: this.railFooting(0).y,
      halt: this.haltPos(),
      handcar: this.handcarPos(),
      trestle: this.trestlePos(),
      ravine: this.ravineRect(),
      hasTrestle: this.travelStatus() !== null,
      hasWayBack: this.backTravelOptions().length > 0,
      bridgeRepaired: this.bridgeRepaired(),
      trestleBuildT: this.trestleBuildT,
      trestleBuildSecs: Game.TRESTLE_BUILD_SECS,
      handcarDepartT: this.handcarDepartT,
      handcarDepartSecs: Game.HANDCAR_DEPART_SECS,
    });
  }

  /** Queues the homestead — fence, cottage, and every placed buildable — into
   * the depth-sorted pass, so a worker walking past the cottage is occluded by
   * it exactly like a tree. */
  /** Builds the view the homestead renderer needs (see scene/homestead.ts)
   * and hands off. */
  private pushYardDrawables(
    ctx: CanvasRenderingContext2D,
    drawables: { y: number; draw: () => void }[],
  ): void {
    pushHomesteadDrawables(ctx, drawables, {
      plot: this.plot,
      save: this.save,
      yardRect: () => this.yardRect(),
      cottagePos: () => this.cottagePos(),
      cottagePhase: () => this.cottagePhase(),
      barnPos: () => this.barnPos(),
      barnPhase: () => this.barnPhase(),
      barnAvailable: () => this.barnAvailable(),
      encampmentPos: () => this.encampmentPos(),
    });
  }

  /** Pixel width of the pile's widest row. The pile is CENTRED on this, so at
   * PILE_BASE=3 it is exactly one CELL wide and stays inside its own tile. */
  private logPileWidth(): number {
    return Game.PILE_BASE * spriteSize(LOG_END).w;
  }

  private drawLogStack(ctx: CanvasRenderingContext2D): void {
    const { x, y } = this.logStackPos();
    const { tier } = logStackTier(this.save.wood, this.save.worldIndex);
    const count = this.logPileCount();
    const { w: lw, h: lh } = spriteSize(LOG_END);
    const left = x - Math.floor(this.logPileWidth() / 2);

    // Retaining stakes appear once the pile is a real stack rather than a
    // handful of kindling.
    if (tier !== "kindling") {
      // Stakes sit INSIDE the pile's own footprint. Drawn outside it they
      // extended past the cell, and since the log stack is the yard's
      // left-most prop that put the left stake straight through the fence's
      // side rail.
      const stake = spriteSize(LOG_STAKE);
      drawSprite(ctx, LOG_STAKE, left, y - stake.h);
      drawSprite(
        ctx,
        LOG_STAKE,
        left + this.logPileWidth() - stake.w,
        y - stake.h,
      );
    }

    let placed = 0;
    for (let r = 0; r < Game.PILE_ROWS && placed < count; r++) {
      const inRow = Math.max(1, Game.PILE_BASE - r);
      // Each row is itself centred over the one below, so the pyramid tapers
      // symmetrically instead of leaning right.
      const rowLeft = left + Math.floor(((Game.PILE_BASE - inRow) * lw) / 2);
      for (let c = 0; c < inRow && placed < count; c++) {
        drawSprite(ctx, LOG_END, rowLeft + c * lw, y - (r + 1) * lh);
        placed++;
      }
    }
  }

  /** Whetstone — the Focus meter's fixed home. The wheel takes the same heat
   * ramp as the axe blade, so the two read as one meter expressed twice. */
  private drawWhetstone(ctx: CanvasRenderingContext2D): void {
    const { x, y } = this.whetstonePos();
    const heat = focusHeatColor(this.save.focus);
    const size = spriteSize(WHETSTONE);
    const draw = (): void =>
      drawSprite(ctx, WHETSTONE, x - Math.floor(size.w / 2), y - size.h);
    if (heat) {
      withPalette({ e: heat }, draw);
    } else {
      draw();
    }
  }

  /** Hanging lantern. The amber level is painted into LANTERN_FRAME's hollow
   * interior bottom-up; the light cone it casts is drawn later, in
   * renderPropLabels, so the night overlay can't wash it out. */
  private drawLantern(ctx: CanvasRenderingContext2D): void {
    const { x, y } = this.lanternPos();
    const post = spriteSize(LANTERN_POST);
    const postX = x;
    const postY = y - post.h;
    drawSprite(ctx, LANTERN_POST, postX, postY);

    const f = this.lanternFill();
    const frame = this.lanternFramePos();
    drawSprite(ctx, LANTERN_FRAME, frame.x, frame.y);
    if (f > 0) {
      const g = LANTERN_GLASS;
      const fillH = Math.max(1, Math.round(g.h * f));
      ctx.fillStyle = "#ffd75e";
      ctx.fillRect(frame.x + g.x, frame.y + g.y + (g.h - fillH), g.w, fillH);
    }
  }

  private lanternFill(): number {
    return Math.max(0, Math.min(1, this.save.amber / amberLanternFull()));
  }

  /** Top-left of LANTERN_FRAME, derived from the post's hook pixel so the two
   * sprites can't drift apart if either is re-authored. The frame is centered
   * horizontally under the hook and hangs from it. */
  private lanternFramePos(): { x: number; y: number } {
    const { x, y } = this.lanternPos();
    const post = spriteSize(LANTERN_POST);
    const frame = spriteSize(LANTERN_FRAME);
    return {
      x: x + LANTERN_HOOK.x - Math.floor(frame.w / 2),
      y: y - post.h + LANTERN_HOOK.y,
    };
  }

  /** The props' etched counts, plus the lantern's light cone. Runs after the
   * night overlay (see render) — the whole point of the always-visible counts
   * is that an exact value never needs a hover, and there is no canvas hover
   * infrastructure to fall back on, so they must survive nightfall.
   *
   * All labels are UPPERCASE/numeric: FONT has no lowercase glyphs. */
  /** Grid + ghost preview, shown only while Build Mode is armed. */
  private renderBuildOverlay(ctx: CanvasRenderingContext2D): void {
    const grid = this.plot.forest.gridRef();
    const yard = this.yardRect();

    // Tint the buildable plot and rule its cells, so "here, on these squares"
    // is unmistakable without the grid ever intruding on normal play.
    ctx.save();
    ctx.globalAlpha = 0.5;
    for (let dy = 0; dy < yard.rows; dy++) {
      for (let dx = 0; dx < yard.cols; dx++) {
        const c = { cx: yard.cx + dx, cy: yard.cy + dy };
        if (!grid.inBounds(c)) continue;
        const f = grid.footing(c);
        const x = f.x - CELL / 2;
        const y = f.y - CELL;
        const free = this.canPlaceAt(c);
        ctx.fillStyle = free
          ? "rgba(120, 200, 130, 0.16)"
          : "rgba(200, 90, 70, 0.16)";
        ctx.fillRect(x, y, CELL, CELL);
        ctx.strokeStyle = free
          ? "rgba(180, 240, 190, 0.5)"
          : "rgba(230, 140, 120, 0.45)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
      }
    }
    ctx.restore();

    const hover = this.hoverCell;
    if (!hover) return;
    const valid = this.canPlaceAt(hover);
    const f = grid.footing(hover);

    // Highlight the aimed cell solidly — the tint above is context, this is aim.
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = valid ? "#8ef0a0" : "#ff6b5a";
    ctx.lineWidth = 1;
    ctx.strokeRect(f.x - CELL / 2 + 0.5, f.y - CELL + 0.5, CELL - 1, CELL - 1);
    ctx.restore();

    // Ghost of the thing being placed, at the exact anchor the real object will
    // use (footing, bottom-centre) so what you preview is what you get.
    const id =
      this.buildMovingIndex !== null
        ? (this.save.placed ?? [])[this.buildMovingIndex]?.id
        : this.buildSelection;
    const map = id ? BUILDABLE_SPRITES[id] : undefined;
    if (!map) return;
    const size = spriteSize(map);
    ctx.save();
    // drawSprite paints raw fillRects with no alpha of its own, so the ghost's
    // translucency has to come from the context.
    ctx.globalAlpha = valid ? 0.65 : 0.35;
    drawSprite(ctx, map, Math.round(f.x - size.w / 2), f.y - size.h);
    ctx.restore();
  }

  /** The homestead's status board: wood, amber and focus on ONE sign hung on
   * the cottage, instead of three little plaques floating above three separate
   * props scattered across the yard.
   *
   * The old plaques were bare 7px fill-rects with no frame, no icon and no unit
   * cue — nothing told you which number was which — drawn in a brown from the
   * same family as the log pile behind them, with text double-drawn 1px apart
   * (drawEngraved) which at a 3x5 glyph size smears the strokes rather than
   * incising them. Here each row gets its own colour-coded pip and the numbers
   * are left-aligned in a column, so the three read as one table.
   *
   * Runs AFTER the night overlay so the board stays legible in the dark. */
  private renderPropLabels(ctx: CanvasRenderingContext2D): void {
    const cottage = this.cottagePos();
    const rows: { pip: string; text: string }[] = [
      { pip: "#c49a6c", text: abbrev(Math.floor(this.save.wood)) },
      { pip: "#ffd75e", text: abbrev(Math.round(this.save.amber)) },
      {
        pip: focusHeatColor(this.save.focus) ?? "#8fb7d6",
        text: String(Math.round(this.save.focus)),
      },
    ];

    // Hover-revealed, not permanent — see `boardReveal`. Bailing out early
    // keeps the rest of this method (the lantern cone, the trestle's state
    // label) unconditional: those are world lighting and a prop's own
    // signage, not the readout, and hiding them with it would be wrong.
    if (this.boardReveal > 0.01) {
      const padX = 3;
      const pipW = 2;
      const rowH = 6;
      const textW = Math.max(...rows.map((r) => textWidth(r.text)));
      const boardW = padX * 2 + pipW + 2 + textW;
      const boardH = 3 + rows.length * rowH;

      // Hangs on the cottage's gable, clamped so it can never leave the canvas.
      const frame = COTTAGE_PHASE_SPRITES[this.cottagePhase()];
      let bx = Math.round(cottage.x - boardW / 2);
      bx = Math.max(2, Math.min(this.w - boardW - 2, bx));
      const by = Math.max(2, cottage.y - spriteSize(frame).h - boardH - 3);

      // Board: dark plank with a light top bevel and a post to the roof, so it
      // reads as a hung sign rather than a floating rectangle.
      ctx.save();
      ctx.globalAlpha = this.boardReveal;
      ctx.fillStyle = "#2a1e12";
      ctx.fillRect(bx - 1, by - 1, boardW + 2, boardH + 2);
      ctx.fillStyle = "#5c452c";
      ctx.fillRect(bx, by, boardW, boardH);
      ctx.fillStyle = "#7a5f3e";
      ctx.fillRect(bx, by, boardW, 1);

      rows.forEach((r, i) => {
        const ry = by + 2 + i * rowH;
        ctx.fillStyle = r.pip;
        ctx.fillRect(bx + padX, ry + 1, pipW, 3);
        drawText(ctx, r.text, bx + padX + pipW + 2, ry, "#f2e6d0");
      });
      ctx.restore();
    }

    // Lantern light cone — kept here (not in the prop pass) so the night
    // overlay can't wash it out.
    const f = this.lanternFill();
    if (f > 0) {
      const lframe = this.lanternFramePos();
      const cx = lframe.x + Math.floor(spriteSize(LANTERN_FRAME).w / 2);
      const top = lframe.y + LANTERN_GLASS.y + LANTERN_GLASS.h;
      const ground = this.lanternPos().y;
      if (ground > top) {
        const a = 0.1 + 0.26 * f * (0.35 + 0.65 * this.sky.darkness);
        const rowsN = ground - top;
        for (let i = 0; i < rowsN; i++) {
          const spread = 1 + Math.round((i / rowsN) * 6);
          ctx.fillStyle = `rgba(255, 215, 94, ${(a * (1 - i / rowsN)).toFixed(3)})`;
          ctx.fillRect(cx - spread, top + i, spread * 2 + 1, 1);
        }
      }
    }

    // The raft still labels its own cost/gate — it's nowhere near the cottage
    // and the number only means anything next to the boat it applies to.
    // Bridge cost/gate label, next to the bridge itself.
    const st = this.travelStatus();
    if (st) {
      // Hung over the TRESTLE, not the wright — it labels the crossing's
      // state at a glance (locked / price / open) while his speech bubble
      // carries the actual conversation.
      const p = this.trestlePos();
      const label = this.bridgeRepaired()
        ? "OPEN"
        : !st.gateMet
          ? `${this.save.plotsClearedInWorld}/${st.gate}`
          : abbrev(st.cost);
      const tw = textWidth(label);
      const lx = Math.round(
        Math.max(3, Math.min(this.w - tw - 3, p.x - 8 - tw / 2)),
      );
      ctx.fillStyle = "#1d2b21";
      ctx.fillRect(lx - 2, p.y - 22, tw + 4, 7);
      drawText(
        ctx,
        label,
        lx,
        p.y - 21,
        this.bridgeRepaired() ? "#8ef0a0" : "#f2b0a0",
      );
    }
  }

  private gradeSkillCheck(sc: SkillCheck, pos: number): SkillGrade {
    if (pos >= sc.greatStart && pos <= sc.greatStart + sc.greatWidth)
      return "great";
    if (pos >= sc.zoneStart && pos <= sc.zoneStart + sc.zoneWidth)
      return "good";
    return "miss";
  }

  /** `tierOverride` lets Battle's Defend check scale with the Adventure
   * world actually being fought (`adv.world`) instead of the wood-chopping
   * ladder's `worldIndex` — the two can diverge, especially post-Prestige
   * since `adventureWorldUnlocked` doesn't reset. POV's chop skill-check
   * omits it and keeps using `worldIndex`, which is correct for it.
   * `widenPct` is a skillCheckWindowPct item bonus (see
   * skillCheckWidenForMember/Wc) — it widens zoneWidth, and greatWidth
   * widens right along with it since it's already derived as a fraction of
   * zoneWidth below. */
  private rollSkillCheck(tierOverride?: number, widenPct = 0): SkillCheck {
    const tier = tierOverride ?? this.save.worldIndex;
    const baseZoneWidth =
      Math.max(7, Math.min(22, 12 - tier * 1.5)) + Math.random() * 10;
    const zoneWidth = baseZoneWidth * (1 + widenPct);
    const zoneStart = 8 + Math.random() * (92 - zoneWidth);
    const greatWidth = zoneWidth * 0.3;
    const greatStart = zoneStart + (zoneWidth - greatWidth) / 2;
    const speed =
      SKILL_SPEED_BASE + Math.random() * SKILL_SPEED_RANGE + tier * SKILL_SPEED_PER_TIER;
    return {
      pos: 0,
      dir: 1,
      speed,
      zoneStart,
      zoneWidth,
      greatStart,
      greatWidth,
    };
  }

  /** Bounces the needle back and forth between the track's 0..100 bounds
   * forever — there is no auto-miss timeout. A skill check just waits for
   * input indefinitely; walking away mid-check leaves that swing/turn
   * stalled until the player returns and clicks, which is an accepted
   * tradeoff (idle wood-chopping and everything else keeps running). */
  private advanceSkillCheck(sc: SkillCheck, dt: number): void {
    sc.pos += sc.speed * dt * sc.dir;
    if (sc.pos >= 100) {
      sc.pos = 200 - sc.pos;
      sc.dir = -1;
    } else if (sc.pos <= 0) {
      sc.pos = -sc.pos;
      sc.dir = 1;
    }
  }

  private finishSkillCheck(grade: SkillGrade): void {
    const wc = this.povTarget;
    if (!wc) return;
    // Pay on the sweep you actually faced, not just on the grade: a fast
    // needle is a harder target and is worth more (see povYieldMult).
    const sc = this.povSkillCheck;
    const mult = sc
      ? povYieldMult(grade, sc.speed, this.save.worldIndex)
      : POV_GRADE_MULT[grade];
    this.onSkillCheckResult?.(grade, wc);
    wc.resolveSkillCheck(mult);
    this.povSkillCheck = null;
    // `wood` is filled in by resolveManualPovChop once the swing actually
    // lands and the real payout is known — the bar reports the wood earned,
    // not a multiplier the player then has to convert in their head.
    this.povFlash = { grade, t: 0, wood: null };
  }

  /** Canvas click at logical coords. Returns false if nothing was hit. */
  handleClick(lx: number, ly: number): boolean {
    if (this.battleViewOpen) {
      return this.handleBattleClick(lx, ly);
    }
    if (this.povTarget) {
      this.handlePovInput();
      return true; // POV consumes every click — never falls through to drag
    }
    if (this.nextPlot) return false;

    // An open conversation owns every click, exactly like POV and Build Mode
    // above — picking a choice, or clicking away to dismiss. Returning `true`
    // unconditionally is load-bearing: a `false` falls through to
    // appWindow.startDragging() (see main.ts) and would drag the window out
    // from under someone reaching for a reply.
    if (this.dialogue) {
      this.save.stats.clicks += 1;
      const layout = layoutBubble(this.dialogue, this.w, this.h);
      const idx = hitChoice(layout, lx, ly);
      if (idx !== null) {
        const choice = this.dialogue.choices[idx];
        if (!choice.disabled) {
          // Close BEFORE running the handler. onPick can start a world
          // transition, and a bubble still holding a stale speaker position
          // would hang over the slide; it also makes a double-click
          // physically unable to pay twice.
          this.dialogue = null;
          this.dialogueHover = null;
          playSfx("click");
          choice.onPick();
        }
        return true;
      }
      // Clicking the bubble's own padding is not dismissal — only clicking
      // genuinely away from it is.
      if (!hitBubble(layout, lx, ly)) {
        this.dialogue = null;
        this.dialogueHover = null;
      }
      return true;
    }

    // Build Mode owns every click while armed — including empty ground. A
    // `false` here would fall through to appWindow.startDragging() and drag the
    // window out from under someone aiming at a cell.
    if (this.buildModeActive()) {
      this.save.stats.clicks += 1;
      const cell = this.plot.forest.gridRef().cellAt(lx, ly);
      this.hoverCell = cell;
      const at = this.cottagePos();
      switch (this.commitPlacement()) {
        case "placed":
          playSfx("chop");
          break;
        case "moved":
          playSfx("click");
          break;
        case "unaffordable":
          this.floats.push(
            new FloatingText(at.x, at.y - 14, "NOT ENOUGH WOOD", "#d64545"),
          );
          break;
        case "maxed":
          this.floats.push(
            new FloatingText(at.x, at.y - 14, "ALREADY BUILT", "#d64545"),
          );
          this.cancelBuildMode();
          break;
        case "invalid": {
          // Clicking an occupied yard cell picks that item up instead of
          // failing — the natural "no, move THAT one" gesture.
          if (!this.pickUpAt(cell)) {
            const p = this.plot.forest.gridRef().footing(cell);
            this.floats.push(
              new FloatingText(p.x, p.y - 8, "CAN'T BUILD HERE", "#d64545"),
            );
          }
          break;
        }
        default:
          break;
      }
      return true;
    }
    const s = this.save;

    if (this.hitAdventureIndicator(lx, ly)) {
      // Anything resumable (live fight, pending boon pick, the no-battle
      // "stage cleared" in-between-stages window, or an undismissed chest)
      // jumps straight back into the battle view now — only a run that
      // hasn't been embarked at all falls back to the Muster overlay.
      if (this.save.adventure || this.chestReveal) {
        this.openBattleView();
      } else {
        this.onWantAdventureOverlay?.();
      }
      return true;
    }

    const wc = this.hitWoodcutter(lx, ly);
    if (wc) {
      // Only cutters actually working a tree can be followed. An idle cutter
      // (waiting session, so no tree claimed) used to open a close-up where
      // clicking did nothing and nothing explained why.
      if (wc.readyToChop) {
        this.enterPov(wc);
      } else {
        this.floats.push(
          new FloatingText(wc.x, wc.y - 14, "NOT CHOPPING", "#d64545"),
        );
      }
      return true;
    }

    // Cottage → build the next stage. Like the raft, a refusal says why in the
    // world rather than just doing nothing.
    if (this.hitCottage(lx, ly)) {
      s.stats.clicks += 1;
      const p = this.cottagePos();
      const cost = this.cottageNextCost();
      if (cost === null) {
        this.floats.push(new FloatingText(p.x, p.y - 14, "HOME", "#ffd75e"));
      } else if (this.buildCottagePhase()) {
        playSfx("fell");
        this.effects.push(
          new LeafBurst(
            p.x,
            p.y - 6,
            ["#8a6440", "#c49a6c", "#6e4c30"],
            12,
            0.6,
          ),
        );
        this.floats.push(
          new FloatingText(
            p.x,
            p.y - 14,
            COTTAGE_PHASE_NAME[this.cottagePhase() - 1],
            "#ffd75e",
          ),
        );
      } else {
        this.floats.push(
          new FloatingText(p.x, p.y - 14, "NOT ENOUGH WOOD", "#d64545"),
        );
      }
      return true;
    }

    // Encampment → adventuring. Same destinations the old corner badge had,
    // but now attached to a thing on the map that looks like what it does.
    if (this.hitEncampment(lx, ly)) {
      this.save.stats.clicks += 1;
      if (this.save.adventure || this.chestReveal) {
        this.openBattleView();
      } else {
        this.onWantAdventureOverlay?.();
      }
      return true;
    }

    if (this.hitBarn(lx, ly)) {
      this.save.stats.clicks += 1;
      const p = this.barnPos();
      const cost = this.barnNextCost();
      if (cost === null) {
        this.floats.push(
          new FloatingText(p.x, p.y - 14, "THE BARN", "#ffd75e"),
        );
      } else if (this.buildBarnPhase()) {
        playSfx("fell");
        this.effects.push(
          new LeafBurst(
            p.x,
            p.y - 6,
            ["#8a6440", "#c49a6c", "#6e4c30"],
            12,
            0.6,
          ),
        );
        this.floats.push(
          new FloatingText(
            p.x,
            p.y - 14,
            BARN_PHASE_NAME[this.barnPhase() - 1],
            "#ffd75e",
          ),
        );
      } else {
        this.floats.push(
          new FloatingText(p.x, p.y - 14, "NOT ENOUGH WOOD", "#d64545"),
        );
      }
      return true;
    }

    // Road (left) → back a world. Free: you already paid to pass it once.
    // Halt (left) → the departures board. Both the handcar and the platform
    // open it; see openDepartureBoard.
    if (this.hitHandcar(lx, ly)) {
      this.save.stats.clicks += 1;
      playSfx("crank");
      this.openDepartureBoard();
      return true;
    }

    // Trestle (right) → talk to the foreman. He owns every onward-travel
    // state — the gate, the price, and the all-clear — so the whole route
    // forward has one voice instead of three different floating texts.
    // Anyone you can talk to. The foreman is in this sweep like everyone
    // else now — talkTo() routes him to his rate card when there is business
    // and to his chatter when there isn't (see foremanHasBusiness).
    for (const id of NPC_IDS) {
      if (!this.hitNpc(id, lx, ly)) continue;
      this.save.stats.clicks += 1;
      playSfx("click");
      this.talkTo(id);
      return true;
    }

    // Crossroads Signpost → Settings. Checked before the sap press purely for
    // reading order; their boxes don't overlap at any window size.
    if (this.hitSignpost(lx, ly)) {
      s.stats.clicks += 1;
      this.signpostT = Game.SIGNPOST_ANIM_SECS;
      playSfx("click");
      this.onWantSettings?.();
      return true;
    }

    const press = this.sapPressPos();
    if (
      this.sapPressOwned() &&
      this.sapPressT <= 0 &&
      Math.abs(lx - press.x) <= 6 &&
      Math.abs(ly - press.y) <= 7
    ) {
      s.stats.clicks += 1;
      if (this.pressSap()) {
        this.sapPressT = Game.SAP_PRESS_ANIM_SECS;
        playSfx("koiCatch"); // reuse the watery squish/plip tone — fits a wood-crush drip well enough to not need a 5th synthesized sound
        this.effects.push(
          new LeafBurst(press.x, press.y - 8, ["#e8b84b", "#ffe9a8"], 8, 0.5),
        );
        this.floats.push(
          new FloatingText(
            press.x,
            press.y - 10,
            `+${SAP_PRESS_AMBER_YIELD}`,
            "#ffd75e",
          ),
        );
      } else {
        // Not enough wood — a small red denial shake, no reward. UPPERCASE
        // is load-bearing: FONT (sprites.ts) has no lowercase glyphs, so a
        // lowercase string draws nothing at all but still advances 4px per
        // character — this message was silently invisible until now.
        this.floats.push(
          new FloatingText(press.x, press.y - 10, "NOT ENOUGH WOOD", "#d64545"),
        );
      }
      return true;
    }

    if (
      this.spot &&
      Math.abs(lx - this.spot.x) <= 3 &&
      Math.abs(ly - this.spot.y) <= 3
    ) {
      const tree = this.spot.tree;
      this.spot = null;
      this.spotTimer = 6 + Math.random() * 4;
      s.stats.goldenSpotsHit += 1;
      s.stats.clicks += 1;
      if (s.focus > 0 && tree.standing) {
        s.focus -= 1;
        this.effects.push(new Effect(lx, ly, [SLASH1, SLASH2], 0.25));
        this.resolveChop(
          tree,
          { tokens: 0, hits: 3 },
          lx,
          ly,
          this.chopModsForLead(),
        );
      } else {
        this.frenzyT = FRENZY_SECS;
        this.refreshModifiers();
        this.floats.push(new FloatingText(lx, ly, "x2", "#ffd75e"));
        scheduleSave(s);
      }
      return true;
    }

    if (
      this.goldenLog &&
      Math.abs(lx - this.goldenLog.x) <= 6 &&
      Math.abs(ly - this.goldenLog.y) <= 5
    ) {
      // amberIncome Utility gear / the Amber Vein Power-up boost this claim
      // the same way they boost passive per-1k-token Amber (see applyChop).
      const amount = Math.round(GOLDEN_LOG_AMBER * this.amberIncomeMult());
      s.amber += amount;
      playSfx("goldenLog");
      this.floats.push(
        new FloatingText(
          this.goldenLog.x,
          this.goldenLog.y - 4,
          `+${amount}`,
          "#ffd75e",
        ),
      );
      this.goldenLog = null;
      scheduleSave(s, true);
      return true;
    }

    if (this.koi) {
      const pos = this.plot.lake.koiPosition(this.koi.phase);
      if (
        Math.abs(lx - pos.x) <= Game.KOI_CLICK_RADIUS &&
        Math.abs(ly - pos.y) <= Game.KOI_CLICK_RADIUS
      ) {
        const amount = koiReward(this.density);
        s.amber += amount;
        playSfx("koiCatch");
        this.effects.push(new Effect(pos.x, pos.y, [RIPPLE1, RIPPLE2], 0.35));
        this.floats.push(
          new FloatingText(pos.x, pos.y - 4, `+${amount}`, "#7fd9c8"),
        );
        this.koi = null;
        scheduleSave(s, true);
        return true;
      }
    }

    const tree = this.plot.forest.treeAt(lx, ly);
    if (!tree) return false;
    s.stats.clicks += 1;
    if (s.focus > 0) {
      s.focus -= 1;
      this.effects.push(new Effect(lx, ly, [SLASH1, SLASH2], 0.25));
      this.resolveChop(
        tree,
        { tokens: 0, hits: 1 },
        lx,
        ly,
        this.chopModsForLead(),
      );
    } else {
      // Out of Focus: spark, no damage — run another prompt to recharge.
      this.effects.push(new Effect(lx, ly, [SPARK], 0.2));
      scheduleSave(s);
    }
    return true;
  }

  // --- economy ------------------------------------------------------------

  /** Fell juice, shared by every fell site: crash SFX + a leaf burst in the
   * felled tree's own canopy colors (world palette override, else the base
   * greens). */
  private fellJuice(tree: Tree): void {
    playSfx("fell");
    const palette = getWorld(this.plotWorld).palette;
    const colors = [palette?.G ?? "#4a9e5c", palette?.g ?? "#86d194"];
    this.effects.push(
      new LeafBurst(tree.x + tree.width / 2, tree.y - 16, colors),
    );
  }

  /** Pays a felled OTHER tree's full wood reward — shared by resolveChop's
   * own fell branch (via the arithmetic below) and timberSplash's splash
   * damage, which can incidentally finish off a neighbor. */
  private paySplashFell(tree: Tree, prestigeMult: number): void {
    const s = this.save;
    const payout =
      WOOD_YIELD[tree.kind] * getWorld(this.plotWorld).mult * prestigeMult;
    s.wood += payout;
    s.totalWoodEarned += payout;
    s.stats.treesFelled += 1;
    if (tree.kind === "elder") s.stats.eldersFelled += 1;
    this.floats.push(
      new FloatingText(
        tree.x + tree.width / 2,
        tree.y - 14,
        `+${abbrev(payout)}`,
        WOOD_COLOR,
      ),
    );
    this.fellJuice(tree);
    void reportFell(payout);
  }

  /** A chop lands: damage the tree, pay chips + fell wood, persist. */
  private resolveChop(
    tree: Tree,
    chop: PendingChop,
    x: number,
    y: number,
    mods: ChopMods,
  ): number {
    const s = this.save;
    // POV skill-check grade (great/good/miss) — wood value only, never
    // damage or stats. 1 for every non-POV chop (the vast majority).
    const yieldMult = chop.yieldMult ?? 1;
    s.stats.chops += chop.hits;
    s.stats.tokensSeen += chop.tokens;
    if (chop.tokens > 0) {
      this.floats.push(
        new FloatingText(x, y, `-${abbrev(chop.tokens)}`, TOKEN_COLOR),
      );
    }
    // Chips: every landed hit pays a little wood — token usage visibly
    // fills the inventory even between fells. Composed multiplier: POV
    // grade × Prestige × the chopper's equipped Woodchopping yieldPct ×
    // the Forest Blessing Power-up's flat +15% (its own blurb's exact
    // number) — every wood-yield source lands in this one place instead of
    // branching separately.
    const prestigeMult = 1 + 0.1 * s.prestigeLevel;
    const blessingMult = this.hasPowerup("forestBlessing") ? 1.15 : 1;
    const totalYieldMult =
      yieldMult * prestigeMult * mods.itemYieldMult * blessingMult;
    // How hard this swing lands. Token-driven chops carry a `weight` derived
    // from the volume behind them (see swingWeight); player-driven swings
    // have none and fall back to `hits`, which is what they always used —
    // a click is a click regardless of what the model happened to be doing.
    const force = chop.weight ?? chop.hits;
    const chips = force * getWorld(this.plotWorld).mult * totalYieldMult;
    s.wood += chips;
    s.totalWoodEarned += chips;
    // Everything this swing paid, returned to the caller so the POV timing
    // bar can report the real figure instead of a multiplier.
    let awarded = chips;
    const felled = this.plot.forest.applyDamage(tree, force * mods.atk);
    playSfx("chop");
    // Always show what a swing paid.
    //
    // This float used to be opt-in via `chipFloat`, and every caller that
    // opted in was a PLAYER action (manual click, golden spot, POV swing)
    // while both token-driven callers left it off. The wood was paid either
    // way — it was only ever invisible. The result read as "my woodcutters
    // chop for free and only clicking earns anything", which is the exact
    // opposite of what the game does, and it hid the one number that makes
    // token usage feel like it is worth something.
    if (!felled && chips > 0) {
      this.floats.push(
        new FloatingText(x, y - 5, `+${abbrev(chips)}`, WOOD_COLOR),
      );
    }
    if (felled) {
      const payout =
        WOOD_YIELD[tree.kind] * getWorld(this.plotWorld).mult * totalYieldMult;
      s.wood += payout;
      s.totalWoodEarned += payout;
      awarded += payout;
      s.stats.treesFelled += 1;
      if (tree.kind === "elder") {
        s.stats.eldersFelled += 1;
      }
      this.floats.push(
        new FloatingText(
          tree.x + tree.width / 2,
          tree.y - 14,
          `+${abbrev(payout)}`,
          WOOD_COLOR,
        ),
      );
      this.fellJuice(tree);
      void reportFell(payout);
    }

    // timberSplash: chop damage also splashes to nearby standing trees.
    // Kept out of the onSkillCheckResult hook (unlike chainsawExecution/
    // frenzyBurst above) since it needs to fire on every landed hit, not
    // just POV-driven ones, to matter at all during normal idle chopping.
    // Splash lands at half the item's headline magnitude (so 25%/45% ->
    // ~12%/22% of the hit's own damage) since it can hit up to 2 trees.
    let splashFelled = false;
    if (mods.effectId === "timberSplash" && mods.effectMagnitude) {
      const splashDamage = Math.round(
        chop.hits * mods.atk * mods.effectMagnitude * 0.5,
      );
      if (splashDamage > 0) {
        for (const neighbor of this.plot.forest.neighborsOf(tree, 2)) {
          if (this.plot.forest.applyDamage(neighbor, splashDamage)) {
            this.paySplashFell(neighbor, prestigeMult);
            splashFelled = true;
          }
        }
      }
    }

    // Persist once, after any splash fells have also been applied, so the
    // saved plot HP snapshot never lags behind what's on screen.
    s.currentPlotHp = this.plot.forest.hpSnapshot();
    scheduleSave(s, felled || splashFelled);
    return awarded;
  }
  

  /** Resolves a manual POV swing's impact (Woodcutter.beginSwing/
   * takeManualChop).
   *
   * POV swings deliberately DO NOT cost Focus. Focus is a rate limiter for
   * spam-clicking trees in the world view, where a click is instant and free;
   * a POV swing is already limited by something better — you have to wind up
   * and land a timing check for every single one, so the animation and the
   * skill check are the throttle. Charging Focus on top meant the mode you
   * enter specifically to chop by hand ran out of the ability to chop.
   *
   * The grade still matters: it scales the wood via chop.yieldMult, so timing
   * swings well is the reward rather than being allowed to swing at all. */
  private resolveManualPovChop(wc: Woodcutter, chop: ManualChop): void {
    const tree = wc.currentTree;
    if (!tree || !tree.standing) return;
    this.effects.push(new Effect(chop.x, chop.y, [SLASH1, SLASH2], 0.25));
    const awarded = this.resolveChop(
      tree,
      { tokens: 0, hits: chop.hits, yieldMult: chop.yieldMult },
      chop.x,
      chop.y,
      this.chopModsForWc(wc),
    );
    // Report the real payout on the timing bar, and restart the flash timer
    // so the number gets its full read — the swing lands a beat after the
    // click that graded it, so the grade alone would already be fading.
    if (this.povFlash) {
      this.povFlash.wood = awarded;
      this.povFlash.t = 0;
    }
  }

  travelStatus(): TravelStatus | null {
    const next = this.save.worldIndex + 1;
    // The ladder's reachable cap grows with prestige (Isaac-style — see
    // unlocks.ts): worlds past maxWorldIndex simply aren't travelable yet.
    if (next > maxWorldIndex(this.save.prestigeLevel)) return null;
    const spec = getWorld(next);
    // Travel Discount Power-up: -25% travel cost, exactly matching its own
    // gacha blurb. travel() below reads this same `cost` back, so the
    // discount is applied exactly once, in exactly one place.
    const cost = Math.round(
      spec.travelCost * (this.hasPowerup("travelDiscount") ? 0.75 : 1),
    );
    return {
      nextName: spec.name,
      cost,
      gate: spec.plotGate,
      gateMet: this.save.plotsClearedInWorld >= spec.plotGate,
      affordable: this.save.wood >= cost,
    };
  }

  /** User clicked Travel. Returns false if not currently allowed. */
  /** Sails back to a world you've already unlocked.
   *
   * Free and ungated on purpose: you already paid the travel cost and cleared
   * the plot gate to get past it once, and charging again would just tax
   * revisiting. `adventureWorldUnlocked` is the high-water mark of where you've
   * been, so it — not the current index — is what bounds this. */
  travelBackTo(world: number): boolean {
    const s = this.save;
    if (this.nextPlot || this.battleViewOpen || this.povTarget) return false;
    if (!Number.isInteger(world) || world < 0) return false;
    if (world >= s.worldIndex) return false; // forward travel is travel()
    if (world > s.adventureWorldUnlocked) return false;
    s.worldIndex = world;
    s.plotIndex = 0;
    s.plotsClearedInWorld = 0;
    s.currentPlotHp = null;
    scheduleSave(s, true);
    this.startTransition(s.worldIndex, 0);
    return true;
  }

  /** Worlds you can sail back to right now, nearest first. */
  backTravelOptions(): { world: number; name: string }[] {
    const out: { world: number; name: string }[] = [];
    for (let w = this.save.worldIndex - 1; w >= 0; w--) {
      if (w > this.save.adventureWorldUnlocked) continue;
      out.push({ world: w, name: getWorld(w).name });
    }
    return out;
  }

  travel(): boolean {
    const status = this.travelStatus();
    if (!status || !status.gateMet || !status.affordable || this.nextPlot) {
      return false;
    }
    const s = this.save;
    s.wood -= status.cost;
    s.worldIndex += 1;
    // Tracked separately from worldIndex (which Game.prestige() resets to 0)
    // so Adventure-mode world access survives a prestige reset.
    s.adventureWorldUnlocked = Math.max(s.adventureWorldUnlocked, s.worldIndex);
    s.plotIndex = 0;
    s.plotsClearedInWorld = 0;
    s.currentPlotHp = null;
    scheduleSave(s, true);
    this.startTransition(s.worldIndex, 0);
    return true;
  }

  /** Read-only status for the Settings panel's Prestige button. */
  prestigeStatus(): {
    eligible: boolean;
    level: number;
    bonusPct: number;
    nextBonusPct: number;
  } {
    const s = this.save;
    return {
      // "Beating the run" = reaching the current prestige level's ladder cap
      // (world 5 at prestige 0, +1 world per level — see unlocks.ts), not
      // the whole curated ladder: each prestige both resets the ladder AND
      // widens it, so the next run has somewhere new to go.
      eligible: s.worldIndex >= maxWorldIndex(s.prestigeLevel),
      level: s.prestigeLevel,
      bonusPct: 10 * s.prestigeLevel,
      nextBonusPct: 10 * (s.prestigeLevel + 1),
    };
  }

  /** Resets the wood-chopping world ladder in exchange for a permanent
   * +10%/level bonus to wood yield and party ATK/HP. Team, items, amber,
   * any in-progress adventure, and all lifetime stats are untouched — only
   * wood/worldIndex/plotIndex/plotsClearedInWorld/currentPlotHp reset. */
  prestige(): boolean {
    const s = this.save;
    if (s.worldIndex < maxWorldIndex(s.prestigeLevel)) return false;
    s.wood = 0;
    s.worldIndex = 0;
    s.plotIndex = 0;
    s.plotsClearedInWorld = 0;
    s.currentPlotHp = null;
    s.prestigeLevel += 1;
    // The permanent +10%/level bonus is baked into every member's persisted
    // maxHp/currentHp immediately, not just effectiveAtk (already computed
    // live on every read) — otherwise HP bars, vampiricHeal's cap, and the
    // party-wipe check would all under-count the new bonus until the player
    // happened to level/re-equip that specific member.
    for (const member of s.team) {
      syncHp(member, s.inventory, s.prestigeLevel);
    }
    scheduleSave(s, true);
    this.startTransition(0, 0);
    return true;
  }

  buyHelper(id: string): boolean {
    const s = this.save;
    const spec = HELPER_BY_ID[id];
    if (!spec || this.has(id) || s.wood < spec.cost) return false;
    if (spec.requires && !this.has(spec.requires)) return false;
    s.wood -= spec.cost;
    s.helpers.push(spec.id);
    scheduleSave(s, true);
    this.refreshModifiers();
    return true;
  }

  /** Sap Press: squeeze wood into a flat +10 amber (see economy.ts's
   * SAP_PRESS constants and the sim's no-arbitrage gate). */
  pressSap(): boolean {
    const s = this.save;
    const cost = sapPressCost(getWorld(s.worldIndex).mult);
    if (s.wood < cost) return false;
    s.wood -= cost;
    s.amber += SAP_PRESS_AMBER_YIELD;
    scheduleSave(s, true);
    return true;
  }

  /**
   * The one-button answer to a growing roster and a growing bag: rank the team
   * strongest-first, then hand out the best gear in that order.
   *
   * The two halves have to happen together. Optimising alone distributes gear
   * by ROSTER ORDER, which is just the sequence members were pulled in — so it
   * would cheerfully give the best axe to whoever happened to be first,
   * including a level-1 common sitting above a legendary. Sorting alone leaves
   * the gear where it was. Doing both is the only version that reliably ends
   * with your best equipment on your best members.
   *
   * Sorting is also not merely cosmetic: index 0 is the first member assigned
   * to a live chopping session.
   */
  optimizeGear(): boolean {
    const s = this.save;
    sortRosterByPower(s.team, s.inventory, s.prestigeLevel);
    optimizeEquipment(s.team, s.inventory, this.hasPowerup("extraUtility"));
    for (const member of s.team) {
      syncHp(member, s.inventory, s.prestigeLevel);
    }
    this.refreshModifiers();
    scheduleSave(s, true);
    return true;
  }

  buyBoost(id: string): boolean {
    const s = this.save;
    const spec = BOOSTS.find((b) => b.id === id);
    if (!spec) return false;
    if (spec.id === "espresso" && !this.has("gnome1")) return false;
    if (spec.id === "focusPotion" && s.focus >= FOCUS_CAP) return false;
    // Amber Trade's cost scales with world tier to match its scaling wood
    // payout (see amberTradeCost) — every other boost stays at its flat cost.
    const cost =
      spec.id === "amberWood"
        ? amberTradeCost(getWorld(s.worldIndex).mult)
        : spec.cost;
    if (s.amber < cost) return false;
    s.amber -= cost;
    switch (spec.id) {
      case "focusPotion":
        s.focus = FOCUS_CAP;
        break;
      case "espresso":
        this.espressoT = ESPRESSO_DURATION;
        break;
      case "amberWood": {
        const bundle = 25 * getWorld(s.worldIndex).mult;
        s.wood += bundle;
        s.totalWoodEarned += bundle;
        break;
      }
    }
    scheduleSave(s, true);
    return true;
  }

  buyCosmetic(id: string): boolean {
    const s = this.save;
    const spec = COSMETICS.find((c) => c.id === id);
    if (!spec || s.wood < spec.cost) return false;
    if ((s.cosmetics as string[]).includes(id)) return false;
    s.wood -= spec.cost;
    s.cosmetics.push(spec.id);
    this.equipCosmetic(id);
    scheduleSave(s, true);
    return true;
  }

  /** Toggle an owned cosmetic on/off. */
  equipCosmetic(id: string): void {
    const s = this.save;
    const spec = COSMETICS.find((c) => c.id === id);
    if (!spec || !(s.cosmetics as string[]).includes(id)) return;
    if (spec.kind === "cap") {
      s.equippedCap = s.equippedCap === spec.id ? null : spec.id;
    } else {
      s.equippedTreeSkin = s.equippedTreeSkin === spec.id ? null : spec.id;
    }
    scheduleSave(s, true);
  }

  /** Dye an owned cosmetic. `hex` must be one of the swatches that cosmetic
   * has actually unlocked; null clears back to its shipped colors.
   *
   * The validation is deliberate rather than defensive theater: this value
   * flows straight into withPalette() and is persisted, so accepting an
   * arbitrary string from the DOM would let bad input reach the renderer and
   * survive a reload. */
  setCosmeticColor(id: string, hex: string | null): boolean {
    const s = this.save;
    const spec = COSMETICS.find((c) => c.id === id);
    if (!spec || !(s.cosmetics as string[]).includes(id)) return false;
    if (hex !== null && !unlockedSwatches(spec).some((sw) => sw.hex === hex))
      return false;

    const colors = { ...(s.cosmeticColors ?? {}) };
    if (hex === null) {
      delete colors[spec.id];
    } else {
      colors[spec.id] = hex;
    }
    s.cosmeticColors = colors;
    scheduleSave(s, true);
    return true;
  }

  /** The dye currently applied to a cosmetic, or null if it's undyed. */
  cosmeticColor(id: string): string | null {
    return this.save.cosmeticColors?.[id as CosmeticId] ?? null;
  }

  private applyModifiers(wc: Woodcutter): void {
    wc.walkMult = this.hasPowerup("swiftBoots") ? 1.5 : 1;
    wc.chopDurFactor =
      (this.hasPowerup("keenEdge") ? 0.75 : 1) * (this.frenzyT > 0 ? 0.5 : 1);
  }

  // --- utility-slot perks (fastRest/amberIncome/rareMapSpawn) -------------
  //
  // Utility items aren't tied to "who's chopping" the way Woodchopping gear
  // is (see chopModsForWc) — amberIncome/rareMapSpawn read as roster-wide
  // passives, so every equipped Utility item on every member counts,
  // stacking additively. fastRest is the one exception: it only matters for
  // the specific member it's equipped on (see tickPassiveRest).

  /** Every equipped Utility-slot item on this member — the base slot
   * always, plus the second slot too but only once extraUtility is owned
   * (equipItem already refuses to fill utility2 without it; this stays
   * defensive since nothing else here re-derives that gate). */
  private memberUtilityItems(member: TeamMemberSave): ItemDef[] {
    const items: ItemDef[] = [];
    const primary = equippedItem(member, "utility", this.save.inventory);
    if (primary) items.push(primary);
    if (this.hasPowerup("extraUtility")) {
      const secondary = equippedItem(member, "utility2", this.save.inventory);
      if (secondary) items.push(secondary);
    }
    return items;
  }

  private memberHasUtilityPerk(
    member: TeamMemberSave,
    perk: UtilityPerkId,
  ): boolean {
    return this.memberUtilityItems(member).some(
      (d) => d.utility?.perk === perk,
    );
  }

  /** Sum of `magnitude` across every equipped item on every roster member
   * carrying this perk — additive stacking (not multiplicative), matching
   * the same additive-sum pattern startBattle uses for passive reflectPct. */
  private utilityPerkMagnitudeSum(perk: UtilityPerkId): number {
    let sum = 0;
    for (const member of this.save.team) {
      for (const item of this.memberUtilityItems(member)) {
        if (item.utility?.perk === perk) sum += item.utility.magnitude;
      }
    }
    return sum;
  }

  /** Amber income multiplier: amberIncome Utility gear (summed across the
   * roster) plus the Amber Vein Power-up's flat +20% (its own blurb's exact
   * number), additively combined. Applied to passive per-1k-token Amber
   * accrual and Golden Log claims — NOT to Adventure stage rewards, which
   * have their own dedicated bonus (expeditionBonusPct, see
   * finalizeBattleOutcome) so the two don't get conflated. */
  private amberIncomeMult(): number {
    const itemBonus = this.utilityPerkMagnitudeSum("amberIncome");
    const powerupBonus = this.hasPowerup("amberVein") ? 0.2 : 0;
    return 1 + itemBonus + powerupBonus;
  }

  /** Golden Log spawn-rate multiplier: rareMapSpawn Utility gear (summed)
   * plus the Golden Sense Power-up's flat +50%, additively combined, then
   * applied by DIVIDING the usual token threshold — a 1.5× spawn-rate
   * multiplier means roughly 1.5× as many bursts clear the (now lower) bar. */
  private goldenLogSpawnMult(): number {
    const itemBonus = this.utilityPerkMagnitudeSum("rareMapSpawn");
    const powerupBonus = this.hasPowerup("goldenSense") ? 0.5 : 0;
    return 1 + itemBonus + powerupBonus;
  }

  /** focusEfficiencyPct of whichever roster member is currently assigned to
   * this live session (see slotAssignment) — 0 if the source has no
   * assigned member or that member has no such item equipped. */
  private focusEfficiencyForSource(sourceId: string): number {
    const memberId = this.slotAssignment.get(sourceId);
    if (!memberId) return 0;
    const member = this.memberById(memberId);
    if (!member) return 0;
    const item = equippedItem(member, "woodchopping", this.save.inventory);
    return item?.woodchopping?.focusEfficiencyPct ?? 0;
  }

  /** skillCheckWindowPct of a member's equipped Woodchopping item — widens
   * the good/great zones of a skill check for both the POV chop check
   * (chopModsForWc's chopper) and the Battle Defend check (whoever's
   * defending); see rollSkillCheck's widenPct param. */
  private skillCheckWidenForMember(member: TeamMemberSave): number {
    const item = equippedItem(member, "woodchopping", this.save.inventory);
    return item?.woodchopping?.skillCheckWindowPct ?? 0;
  }

  private skillCheckWidenForWc(wc: Woodcutter): number {
    if (!wc.memberId) return 0;
    const member = this.memberById(wc.memberId);
    return member ? this.skillCheckWidenForMember(member) : 0;
  }

  /** Baseline passive HP regen for "resting" party members — the only
   * source of passive (non-Trail-Rations) healing in the game. 1%/min of
   * max HP baseline, doubled to 2%/min for a member with a fastRest
   * Utility item equipped. Driven by real elapsed time during normal
   * wood-chopping (this is called from update(dt), which keeps running
   * regardless of the battle/POV view) — never by adventure turns, keeping
   * the turn-based battle engine's "nothing advances off a wall clock"
   * invariant untouched. */
  private static readonly REST_REGEN_PER_MIN = 0.01;
  private static readonly FAST_REST_REGEN_PER_MIN = 0.02;

  private tickPassiveRest(dt: number): void {
    let changed = false;
    for (const member of this.save.team) {
      if (member.status !== "resting") continue;
      // Resting AND already whole: there is nothing left to wait for, so
      // release them now. The old guard skipped this member entirely, and
      // the only line that restores "available" sits *after* the heal — so
      // anything that topped a resting member up without also clearing their
      // status (a full-heal item, a maxHp change from levelling or gear)
      // left them resting forever.
      if (member.currentHp >= member.maxHp) {
        member.status = "available";
        changed = true;
        continue;
      }
      const fast = this.memberHasUtilityPerk(member, "fastRest");
      const perMin = fast
        ? Game.FAST_REST_REGEN_PER_MIN
        : Game.REST_REGEN_PER_MIN;
      member.currentHp = Math.min(
        member.maxHp,
        Math.round(member.currentHp + member.maxHp * perMin * (dt / 60)),
      );
      changed = true;
      if (member.currentHp >= member.maxHp) {
        member.currentHp = member.maxHp;
        member.status = "available";
      }
    }
    if (changed) scheduleSave(this.save);
  }

  /** chainsawExecution (chance to instantly fell the tree) and frenzyBurst
   * (temporary faster swings) both trigger only on a Great POV skill-check
   * result — wired here via the onSkillCheckResult hook set in the
   * constructor. timberSplash is handled separately, inside resolveChop
   * (see there for why). */
  private applyWoodchoppingItemEffects(
    grade: SkillGrade,
    wc: Woodcutter,
  ): void {
    if (!wc.memberId || grade !== "great") return;
    const member = this.memberById(wc.memberId);
    const item = member
      ? equippedItem(member, "woodchopping", this.save.inventory)
      : null;
    if (!item?.effectId || item.effectMagnitude === undefined) return;

    if (item.effectId === "chainsawExecution") {
      // effectMagnitude IS the execution chance (25% epic / 45% legendary,
      // from UTILITY_RARITY_MAGNITUDE) — reuses resolveChop's own felling
      // math for the payout by handing it lethal damage directly, so the
      // reward/stat bookkeeping never has to be duplicated.
      const tree = wc.currentTree;
      if (tree?.standing && Math.random() < item.effectMagnitude) {
        const mods: ChopMods = { ...this.chopModsForWc(wc), atk: tree.hp };
        this.resolveChop(
          tree,
          { tokens: 0, hits: 1 },
          wc.x,
          wc.y - 10,
          mods,
        );
      }
    } else if (item.effectId === "frenzyBurst") {
      wc.grantBurst(FRENZY_BURST_SECS);
    }
  }

  refreshModifiers(): void {
    for (const wc of this.woodcutters.values()) {
      this.applyModifiers(wc);
    }
    // Gnomes exist iff owned.
    const wantGnomes =
      (this.has("gnome1") ? 1 : 0) + (this.has("gnome2") ? 1 : 0);
    for (let i = 1; i <= 2; i++) {
      const id = `gnome-${i}`;
      const exists = this.woodcutters.has(id);
      if (i <= wantGnomes && !exists) {
        const gnome = new Woodcutter(
          id,
          false,
          this.skyH + 20 + i * 14,
          "gnome",
        );
        this.applyModifiers(gnome);
        this.woodcutters.set(id, gnome);
      } else if (i > wantGnomes && exists) {
        const gnome = this.woodcutters.get(id)!;
        gnome.leaving = true;
      }
    }
  }

  // --- plot / world transitions ------------------------------------------

  private startTransition(world: number, plotIndex: number): void {
    this.closeDialogue();
    this.nextPlot = this.makePlot(world, plotIndex);
    this.nextPlotWorld = world;
    this.nextPlot.resize(this.w, this.groundTop(), this.groundBottom());
    this.nextPlot.setLakeLevel(this.density);
    this.transitionT = TRANSITION_SECS;
    this.spot = null;
    this.goldenLog = null;
    this.koi = null; // new plot's lake — the old swim position is meaningless
    for (const wc of this.woodcutters.values()) {
      wc.startTravel();
    }
  }

  private finishTransition(): void {
    if (this.nextPlot) {
      this.plot = this.nextPlot;
      this.plotWorld = this.nextPlotWorld;
      this.nextPlot = null;
    }
    this.save.currentPlotHp = this.plot.forest.hpSnapshot();
    scheduleSave(this.save, true);
    let i = 0;
    for (const wc of this.woodcutters.values()) {
      wc.arriveAtNewPlot(i++);
    }
  }

  // --- frame update -------------------------------------------------------

  update(dt: number): void {
    this.sky.update(dt);
    this.tickPassiveRest(dt);

    // Flush coalesced chops.
    for (const [id, buf] of this.buffers) {
      buf.age += dt;
      if (buf.age >= COALESCE_SECS) {
        const wc = this.woodcutters.get(id);
        if (wc && !wc.gone) {
          this.buffers.delete(id);
          wc.enqueue({ tokens: buf.tokens, hits: buf.hits, weight: buf.weight });
        } else {
          // No visible woodcutter (over cap / despawned): damage directly so
          // tokens are never wasted. If no tree stands (mid-trek), retry.
          const tree = this.plot.forest.nearestStanding(
            this.w - 24,
            this.h / 2,
          );
          if (tree) {
            this.buffers.delete(id);
            this.resolveChop(
              tree,
              { tokens: buf.tokens, hits: buf.hits, weight: buf.weight },
              tree.x,
              tree.y - 12,
              this.chopModsForLead(),
            );
          }
        }
      }
    }

    // Boost timers.
    this.animT += dt;
    if (this.frenzyT > 0) {
      this.frenzyT -= dt;
      if (this.frenzyT <= 0) {
        this.frenzyT = 0;
        this.refreshModifiers();
      }
    }
    if (this.espressoT > 0) {
      this.espressoT = Math.max(0, this.espressoT - dt);
    }

    // Golden spot lifecycle: spawns on recently-chopped trees.
    if (this.spot) {
      this.spot.ttl -= dt;
      if (this.spot.ttl <= 0 || !this.spot.tree.standing) {
        this.spot = null;
        this.spotTimer = 6 + Math.random() * 4;
      }
    } else if (!this.nextPlot) {
      this.spotTimer -= dt;
      if (this.spotTimer <= 0) {
        const candidates = this.plot.forest.trees.filter(
          (t) => t.standing && t.recentHit > 0,
        );
        if (candidates.length === 0) {
          this.spotTimer = 1;
        } else {
          const tree =
            candidates[Math.floor(Math.random() * candidates.length)];
          this.spot = {
            tree,
            x:
              tree.x +
              Math.round(tree.width / 2) +
              (Math.random() < 0.5 ? -1 : 1),
            y:
              tree.y -
              1 -
              Math.floor(Math.random() * Math.min(6, tree.height * 0.3)),
            ttl: 3 + Math.random() * 2,
          };
        }
      }
    }

    // Golden log decay.
    if (this.goldenLog) {
      this.goldenLog.ttl -= dt;
      if (this.goldenLog.ttl <= 0) {
        this.goldenLog = null;
      }
    }
    // Cache Koi: swim + decay independently of the golden-log slot (a
    // separate mechanic, not competing for the same pickup).
    if (this.koi) {
      this.koi.ttl -= dt;
      // Full lap in KOI_SWIM_SECS, plus a little wobble so the path isn't a
      // perfectly flat ellipse orbit.
      this.koi.phase += (dt * Math.PI * 2) / Game.KOI_SWIM_SECS;
      if (this.koi.ttl <= 0) this.koi = null;
    }
    // Passive Focus trickle. Manual chopping spends Focus, and Focus used to
    // come only from counted tokens — so with no session running the axe went
    // dead and trees could never be felled by hand at all. Clicking is meant to
    // be an alternative to token-driven chopping, not a way to spend it.
    if (this.save.focus < FOCUS_CAP) {
      const gained = accruePassiveFocus(this.passiveFocusCarry, dt);
      this.passiveFocusCarry = gained.carry;
      if (gained.focus > 0) {
        this.save.focus = Math.min(FOCUS_CAP, this.save.focus + gained.focus);
        scheduleSave(this.save);
      }
    } else {
      this.passiveFocusCarry = 0;
    }

    if (this.sapPressT > 0) this.sapPressT = Math.max(0, this.sapPressT - dt);
    if (this.signpostT > 0) this.signpostT = Math.max(0, this.signpostT - dt);

    // Steam off the whetstone once Focus runs genuinely hot. Rate scales with
    // the square of heat so it stays a rare wisp near the threshold and only
    // becomes a real plume near the cap — the escalation IS the readout.
    {
      const t = this.save.focus / FOCUS_CAP;
      if (t > Game.STEAM_FLOOR && !this.nextPlot) {
        const heat = (t - Game.STEAM_FLOOR) / (1 - Game.STEAM_FLOOR);
        this.steamT -= dt;
        if (this.steamT <= 0) {
          this.steamT = 0.5 - 0.34 * heat * heat;
          const stone = this.whetstonePos();
          this.effects.push(
            new SteamWisp(stone.x, stone.y - spriteSize(WHETSTONE).h, 2),
          );
        }
      } else {
        this.steamT = 0;
      }
    }

    // Focus-overflow logs queue behind the single golden-log slot.
    if (!this.goldenLog && this.overflowLogsPending > 0 && !this.nextPlot) {
      this.overflowLogsPending -= 1;
      this.goldenLog = {
        x: Math.round(12 + Math.random() * (this.w - 24)),
        y: Math.round(
          this.skyH + 14 + Math.random() * (this.h - this.skyH - 22),
        ),
        ttl: GOLDEN_LOG_TTL,
      };
    }

    for (const e of this.effects) {
      e.update(dt);
    }
    this.effects = this.effects.filter((e) => !e.done);

    // Gnome chops on a wall-clock trickle.
    const gnomes = [...this.woodcutters.values()].filter(
      (wc) => wc.variant === "gnome" && !wc.leaving,
    );
    if (gnomes.length > 0) {
      this.gnomeTimer += dt;
      const interval =
        this.espressoT > 0
          ? GNOME_ESPRESSO_SECS
          : this.has("gnomeHaste")
            ? GNOME_HASTE_SECS
            : GNOME_CHOP_SECS;
      if (this.gnomeTimer >= interval) {
        this.gnomeTimer = 0;
        for (const gnome of gnomes) {
          gnome.enqueue({ tokens: 0, hits: 1 });
        }
      }
    }

    // Plot cleared → trek to the next plot of this world.
    if (this.transitionT > 0) {
      this.transitionT = Math.max(0, this.transitionT - dt);
      // Swap at the midpoint, while the screen is fully dark. Doing it at
      // either end would show the change happening.
      if (this.nextPlot && this.transitionT <= TRANSITION_SECS / 2) {
        this.finishTransition();
      }
    } else if (this.hasData && this.plot.forest.cleared()) {
      this.save.plotsClearedInWorld += 1;
      this.save.plotIndex += 1;
      this.save.currentPlotHp = null;
      scheduleSave(this.save, true);
      this.startTransition(this.plotWorld, this.save.plotIndex);
    }

    this.plot.update(dt);
    this.ambience.update(dt);

    // The wright's rebuild beat. Hammer blows fire on a fixed cadence rather
    // than off the sprite's animation phase — the sprite flips at 14rad/s,
    // which would machine-gun the sound.
    if (this.trestleBuildT > 0) {
      this.trestleBuildT = Math.max(0, this.trestleBuildT - dt);
      if (this.trestleBuildT <= this.trestleHammerNext) {
        playSfx("chop");
        this.trestleHammerNext = this.trestleBuildT - 0.25;
      }
    }
    this.updateAmbient(dt);
    if (this.handcarDepartT > 0)
      this.handcarDepartT = Math.max(0, this.handcarDepartT - dt);

    // Status-board fade. ~5/s, so it is visibly a reveal rather than a
    // toggle, but is fully up well before you could have read it anyway.
    const boardTarget = this.boardHovered ? 1 : 0;
    if (this.boardReveal !== boardTarget) {
      const step = dt * 5;
      this.boardReveal =
        boardTarget > this.boardReveal
          ? Math.min(1, this.boardReveal + step)
          : Math.max(0, this.boardReveal - step);
    }
    this.nextPlot?.update(dt);

    for (const [id, wc] of this.woodcutters) {
      wc.update(dt, this.plot.forest, (tree, chop, x, y, srcWc) =>
        this.resolveChop(tree, chop, x, y, this.chopModsForWc(srcWc)),
      );
      // Manual POV swing impact (see Woodcutter.beginSwing) — null on the
      // overwhelming majority of ticks. Only ever set on a cutter that has
      // been the POV target, but polled for every cutter (not just the
      // current povTarget) so a swing that was already underway when the
      // player exited POV still resolves instead of leaking.
      const manualChop = wc.takeManualChop();
      if (manualChop) {
        this.resolveManualPovChop(wc, manualChop);
      }
      wc.x = Math.min(wc.x, this.w - 10);
      if (wc.gone) {
        wc.releaseTree();
        this.woodcutters.delete(id);
        this.slotAssignment.delete(id);
      }
    }

    // Battle mode never blocks the loop above either — wood-chopping keeps
    // running in the background exactly like POV. Turn state itself only
    // ever advances via explicit submitTurnAction calls; everything here is
    // purely cosmetic sequencing of the events that call already produced.
    if (this.battleViewOpen) {
      if (!this.battleAnim && this.battleAnimQueue.length > 0) {
        const event = this.battleAnimQueue.shift()!;
        this.battleAnim = {
          event,
          t: 0,
          dur: this.BATTLE_ANIM_DUR[event.kind] ?? 0.5,
        };
        this.onBattleEventStart(event);
      }
      if (this.battleAnim) {
        this.battleAnim.t += dt;
        if (this.battleAnim.t >= this.battleAnim.dur) this.battleAnim = null;
      }
      if (this.battleShakeT > 0)
        this.battleShakeT = Math.max(0, this.battleShakeT - dt);
      if (this.battleFlashT > 0)
        this.battleFlashT = Math.max(0, this.battleFlashT - dt);
      if (this.battleFlash) {
        this.battleFlash.t += dt;
        if (this.battleFlash.t > 0.6) this.battleFlash = null;
      }
      if (this.battleSkillCheck) {
        if (this.battleSkillCheckGrace > 0) {
          // The marker deliberately does NOT move during the lead-in. A grace
          // window that swallowed clicks while the bar visibly swept looked
          // broken — you aimed at the zone, clicked, and nothing happened. A
          // frozen bar plus the "GET READY" label (see renderBattle) makes the
          // wait legible, so no input is ever discarded silently.
          this.battleSkillCheckGrace = Math.max(
            0,
            this.battleSkillCheckGrace - dt,
          );
        } else {
          this.advanceSkillCheck(this.battleSkillCheck, dt);
        }
      }
      this.updateDeaths(dt);
      if (this.lastBattleSnapshot?.outcome) {
        this.battleEndT += dt;
        if (
          this.battleEndT > 1.8 &&
          this.battleAnimQueue.length === 0 &&
          !this.battleAnim &&
          // Auto-close is reserved for a genuinely run-ending outcome — a
          // loss, or a win that just fully banked the run (stage-5 clear,
          // once its chest is dismissed) — never merely because time has
          // elapsed while the run is still ongoing. `save.adventure` is
          // null exactly once bankAdventure has run (every loss, and a
          // stage-5 win), which also covers every intermediate 1-4 stage
          // clear staying open on its new "push on or retreat" prompt (see
          // ui/battle.ts's showStageCleared/finishRewardFlow) without
          // needing to special-case pendingBoonOffer here anymore.
          !this.save.adventure &&
          !this.chestReveal
        ) {
          this.closeBattleView();
        }
      }
    }

    // POV mode never blocks the loop above — every cutter, including the
    // POV target, keeps chopping/felling in the background while watched.
    if (this.povTarget) {
      this.povWalkT += dt;
      // Fell the last tree (or the cutter downed tools) — leave the close-up
      // rather than stranding the player in a view with nothing to click.
      if (
        !this.povTarget.gone &&
        !this.povTarget.readyToChop &&
        this.povWalkT > Game.POV_WALK_SECS
      ) {
        this.exitPov();
      } else if (this.povTarget.gone) {
        this.exitPov();
      } else {
        if (this.povTarget.awaitingInput && !this.povSkillCheck) {
          this.povSkillCheck = this.rollSkillCheck(
            undefined,
            this.skillCheckWidenForWc(this.povTarget),
          );
        }
        if (this.povSkillCheck) {
          this.advanceSkillCheck(this.povSkillCheck, dt);
        }
        if (this.povFlash) {
          this.povFlash.t += dt;
          if (this.povFlash.t > 0.6) this.povFlash = null;
        }
      }
    }

    for (const f of this.floats) {
      f.update(dt);
    }
    this.floats = this.floats.filter((f) => !f.done);
  }

  // --- render -------------------------------------------------------------

  private treePalette(world: number): Record<string, string> | null {
    const base = getWorld(world).palette;
    const skin = COSMETICS.find((c) => c.id === this.save.equippedTreeSkin);
    if (!skin) return base;
    return {
      ...base,
      ...dyedPalette(skin, this.save.cosmeticColors?.[skin.id]),
    };
  }

  private capPalette(): Record<string, string> | null {
    const cap = COSMETICS.find((c) => c.id === this.save.equippedCap);
    return cap ? dyedPalette(cap, this.save.cosmeticColors?.[cap.id]) : null;
  }

  private workerPalette(world: number): Record<string, string> | null {
    const base = getWorld(world).workerPalette;
    const cap = this.capPalette();
    if (!base && !cap) return null;
    return { ...base, ...cap };
  }

  /** Sibling to workerPalette()/treePalette() above — per-world tint for
   * held weapons (only ever touches the neutral `D`/`d` steel base, see
   * WorldSpec.weaponPalette). No cosmetic-cap-style second override exists
   * for weapons, so this is a direct passthrough. */
  weaponPalette(world: number): Record<string, string> | null {
    return getWorld(world).weaponPalette;
  }

  /** Public passthrough to the private workerPalette() above — lets DOM
   * panels (Team roster portraits, ui/team.ts) compose the exact same
   * world+cap tint the canvas world already renders workers with, instead
   * of reimplementing that composition. */
  getWorkerPalette(world: number): Record<string, string> | null {
    return this.workerPalette(world);
  }

  render(ctx: CanvasRenderingContext2D): void {
    if (this.battleViewOpen) {
      this.renderBattle(ctx);
      return;
    }
    if (this.povTarget) {
      this.renderPov(ctx);
      return;
    }

    const { w, h, skyH } = { w: this.w, h: this.h, skyH: this.skyH };

    this.sky.render(ctx, w, skyH, new Date());

    // No more dual-plot offsets: a transition is a fade now, so exactly one
    // plot is ever on screen and everything below draws at its normal place.
    const dxOld = 0;
    ctx.fillStyle = getWorld(this.plotWorld).ground;
    ctx.fillRect(0, skyH, w, h - skyH);

    // Birds ride over the sky/treeline, before the ground goes down, so they
    // read as distant. See scene/ambience.ts.
    this.ambience.renderSky(ctx, dxOld, this.dayPhase());

    // Distant treeline first — it's the farthest thing in the world, so
    // everything on the ground draws over it.
    const oldWorld = getWorld(this.plotWorld);
    this.plot.renderTreeline(ctx, dxOld);

    this.plot.renderGroundLayer(ctx, dxOld, oldWorld.tuft);

    // Bushes / ferns / rocks / stumps: backdrop scenery, over the grass but
    // under everything that moves.
    this.plot.renderScenery(ctx, dxOld, oldWorld.tuft);

    // Butterflies / fireflies / falling leaves sit in the grass: after the
    // ground cover, before the depth-sorted sprite pass, so a woodcutter
    // always walks in FRONT of them rather than being speckled over.
    this.ambience.renderGround(ctx, dxOld, this.dayPhase());

    const workerPalette = this.workerPalette(this.plotWorld);
    // Focus heat rides the axe blade (`D`) and its shade (`d`) — the same ramp
    // the whetstone wheel uses, so the two read as one meter. Focus is global,
    // so this is merged once rather than per-worker. Rarity accents (N/H/Y/y)
    // are deliberately untouched: a legendary axe keeps its own glow.
    const baseWeaponPalette = this.weaponPalette(this.plotWorld);
    const axeHeat = focusHeatColor(this.save.focus);
    const weaponPalette = axeHeat
      ? {
          ...baseWeaponPalette,
          D: axeHeat,
          d: mixHex(axeHeat, "#1d2b21", 0.35),
        }
      : baseWeaponPalette;
    {
      type Drawable = { y: number; draw: () => void };
      const drawables: Drawable[] = [];
      // Resource props sit on the ground line, so they depth-sort with trees
      // and workers instead of being pasted on top like the sap press.
      // Homestead: fence first (it's ground-level and everything else in the
      // yard stands in front of or behind it via normal depth sorting), then
      // the cottage and each placed buildable as its own depth-sorted entry.
      this.pushYardDrawables(ctx, drawables);
      // Sap Press. Now depth-sorted with everything else — it used to be drawn
      // after the sort, so it floated on top of any tree or worker standing in
      // front of it.
      if (this.sapPressOwned())
        drawables.push({
          y: this.sapPressPos().y,
          draw: () => {
            const press = this.sapPressPos();
            const frame = this.sapPressT > 0 ? SAP_PRESS_DOWN : SAP_PRESS_IDLE;
            const size = spriteSize(frame);
            drawSprite(
              ctx,
              frame,
              press.x - Math.floor(size.w / 2),
              press.y - size.h,
            );
          },
        });
      drawables.push({
        y: this.logStackPos().y,
        draw: () => this.drawLogStack(ctx),
      });
      drawables.push({
        y: this.whetstonePos().y,
        draw: () => this.drawWhetstone(ctx),
      });
      drawables.push({
        y: this.lanternPos().y,
        draw: () => this.drawLantern(ctx),
      });
      // The Timber Line. Drawn as one continuous run so both ends read as the
      // same route: track all the way across, a halt at the left, a trestle at
      // the right. All of it joins the depth-sorted pass at its own footing,
      // so a woodcutter wandering to the back of the plot passes in front of
      // the rails and behind nothing.
      this.pushRailDrawables(ctx, drawables);
      this.pushNpcDrawables(ctx, drawables);

      drawables.push({
        y: this.signpostPos().y,
        draw: () => {
          const p = this.signpostPos();
          // Sways briefly after a click, and drifts on a slow idle cycle so it
          // advertises itself as clickable rather than looking like scenery.
          const swaying =
            this.signpostT > 0 || Math.floor(this.animT * 0.7) % 4 === 0;
          const frame = swaying ? SIGNPOST_SWAY : SIGNPOST_IDLE;
          const size = spriteSize(frame);
          drawSprite(ctx, frame, p.x - Math.floor(size.w / 2), p.y - size.h);
        },
      });
      for (const tree of this.plot.forest.trees) {
        drawables.push({
          y: tree.y,
          draw: () =>
            withPalette(this.treePalette(this.plotWorld), () =>
              this.plot.forest.renderTree(ctx, tree, 0),
            ),
        });
      }
      for (const wc of this.woodcutters.values()) {
        drawables.push({
          y: wc.y + 0.5,
          draw: () => wc.render(ctx, workerPalette, weaponPalette),
        });
      }
      if (this.spot) {
        const spot = this.spot;
        drawables.push({
          y: spot.tree.y + 0.6,
          draw: () => {
            const frame =
              Math.floor(this.animT * 3) % 2 === 0 ? GLOW_SM : GLOW_LG;
            const half = frame === GLOW_SM ? 1 : 2;
            drawSprite(ctx, frame, spot.x - half, spot.y - half);
          },
        });
      }
      drawables.sort((a, b) => a.y - b.y);
      for (const d of drawables) {
        d.draw();
      }
      // Golden log bonus pickup (blinks in its final 2 seconds).
      if (this.goldenLog) {
        const log = this.goldenLog;
        const blink = log.ttl < 2 && Math.floor(this.animT * 4) % 2 === 0;
        if (!blink) {
          withPalette({ T: "#c9982a", t: "#ffd75e" }, () => {
            drawSprite(ctx, LOG, log.x - 4, log.y - 2);
          });
        }
      }
      // Cache Koi — drawn over the lake, same final-2s blink cue as the
      // golden log; faces its actual swim direction (derivative of
      // Lake.koiPosition's cos(phase) x term).
      if (this.koi) {
        const pos = this.plot.lake.koiPosition(this.koi.phase);
        const blink = this.koi.ttl < 2 && Math.floor(this.animT * 4) % 2 === 0;
        if (!blink) {
          const facingLeft = Math.sin(this.koi.phase) > 0;
          const size = spriteSize(CACHE_KOI);
          drawSprite(
            ctx,
            CACHE_KOI,
            pos.x - Math.floor(size.w / 2),
            pos.y - Math.floor(size.h / 2),
            facingLeft,
          );
        }
      }
    }

    for (const f of this.floats) {
      f.render(ctx);
    }
    for (const e of this.effects) {
      e.render(ctx);
    }

    // Night falls over the land.
    if (this.sky.darkness > 0.01) {
      ctx.fillStyle = `rgba(14, 20, 46, ${(this.sky.darkness * 0.55).toFixed(3)})`;
      ctx.fillRect(0, skyH, w, h - skyH);
    }

    // Build Mode overlay: the ONLY time the grid is ever visible. Drawn after
    // the night overlay so tiles and the ghost stay readable in the dark, and
    // after the world so nothing occludes what you're aiming at.
    if (this.buildModeActive()) {
      this.renderBuildOverlay(ctx);
    }

    // Resource readouts. The prop BODIES are drawn back in the depth-sorted
    // pass (so trees and workers occlude them properly); only the etched
    // numbers and the lantern's light cone happen here, after the night
    // overlay, so the counts stay legible in the dark and the cone reads as
    // light rather than being dimmed along with everything else.
    {
      this.renderPropLabels(ctx);
    }

    // Hover label, drawn LAST of everything. It used to run before
    // renderPropLabels, so the cottage's resource sign board painted straight
    // over the label whenever you hovered the cottage — the one moment the
    // label matters most. Nothing may occlude it.
    // Suppressed while a conversation is open. handleHover already stops
    // RESOLVING a hover target then, but the last one resolved before the
    // click survives until the pointer next moves — so the prop's label sat
    // on screen underneath its own speech bubble. Gating at the draw makes
    // that impossible to reintroduce from a new dialogue opener.
    if (this.hoverTarget && !this.dialogue) {
      const t = this.hoverTarget;
      const tw = textWidth(t.label);
      const bx = Math.round(
        Math.max(2, Math.min(this.w - tw - 6, t.x - tw / 2 - 2)),
      );
      // Clamped at BOTH edges. Labels used to only ever be requested above
      // their prop, so a top-only clamp was enough; the encampment's now sits
      // below its tent, and a prop near the bottom of the plot would push its
      // label off the canvas entirely.
      const by = Math.max(2, Math.min(this.h - 9, Math.round(t.y - 8)));
      ctx.fillStyle = "rgba(20, 14, 8, 0.85)";
      ctx.fillRect(bx, by, tw + 4, 8);
      ctx.fillStyle = t.enabled ? "#8ef0a0" : "#e8a06a";
      ctx.fillRect(bx, by, 1, 8);
      drawText(ctx, t.label, bx + 2, by + 2, t.enabled ? "#f2e6d0" : "#c8b49a");
    }

    // Conversations draw above everything, including the hover label — the
    // bubble IS the interaction while it's open, and it already suppresses
    // the hover label in handleHover, so nothing may occlude it.
    // Unprompted chatter sits BELOW a real conversation in z-order and is
    // suppressed entirely while one is open (updateAmbient won't start one,
    // and this won't draw a leftover), so the two can never stack.
    if (this.ambient && !this.dialogue) {
      drawAmbient(ctx, this.ambient, layoutAmbient(this.ambient, this.w, this.h));
    }

    if (this.dialogue) {
      drawBubble(
        ctx,
        this.dialogue,
        layoutBubble(this.dialogue, this.w, this.h),
        this.dialogueHover,
      );
    }

    // Transition fade. Drawn over the world but UNDER the HUD text below, so
    // the status line stays readable while the scene changes behind it.
    // Peaks at full dark exactly halfway through, which is the frame the plot
    // swap happens on (see update) — so the change itself is never visible.
    if (this.transitionT > 0) {
      const p = 1 - this.transitionT / TRANSITION_SECS; // 0..1 through the beat
      const a = 1 - Math.abs(p * 2 - 1);
      ctx.fillStyle = `rgba(8, 10, 14, ${(a * a).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    if (this.extraCount > 0) {
      const label = `+${this.extraCount}`;
      const lx = w - textWidth(label) - 3;
      drawText(ctx, label, lx + 1, h - 7, "#1d2b21");
      drawText(ctx, label, lx, h - 8, "#ffffff");
    }

    if (!this.hasData) {
      const msg = "...";
      drawText(ctx, msg, Math.round(w / 2 - textWidth(msg) / 2), 12, "#ffffff");
    }
  }

  /** Builds the view the POV renderer needs (see scene/pov-render.ts). */
  private renderPov(ctx: CanvasRenderingContext2D): void {
    renderPovScene(ctx, {
      w: this.w,
      h: this.h,
      plotWorld: this.plotWorld,
      povTarget: this.povTarget,
      povWalkT: this.povWalkT,
      povWalkSecs: Game.POV_WALK_SECS,
      renderSkillCheck: (c, w, h) => this.renderSkillCheck(c, w, h),
      treePalette: (world) => this.treePalette(world),
      workerPalette: (world) => this.workerPalette(world),
      weaponPalette: (world) => this.weaponPalette(world),
    });
  }

  private renderSkillCheck(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
  ): void {
    const trackX = 6;
    const trackW = w - 12;
    const trackY = h - 16;
    const trackH = 6;
    renderSkillCheckTrack(
      ctx,
      trackX,
      trackY,
      trackW,
      trackH,
      this.povSkillCheck,
    );
    if (this.povFlash) {
      const grade = this.povFlash.grade;
      const color =
        grade === "great"
          ? "#ffd75e"
          : grade === "good"
            ? "#6fb7ff"
            : "#d64545";
      // The wood, not the multiplier. A bare "x1.5" restated the grade and
      // left you to work out what it was worth; the payout is the thing you
      // came here for, so it is what the bar says. The grade still shows,
      // smaller, above it — it is the feedback on your timing.
      const wood = this.povFlash.wood;
      const gradeLabel =
        grade === "great" ? "GREAT!" : grade === "good" ? "GOOD" : "MISS";
      drawText(
        ctx,
        gradeLabel,
        Math.round(w / 2 - textWidth(gradeLabel) / 2),
        trackY - 17,
        color,
      );
      if (wood !== null) {
        const woodLabel = `+${abbrev(Math.round(wood))} WOOD`;
        drawText(
          ctx,
          woodLabel,
          Math.round(w / 2 - textWidth(woodLabel) / 2),
          trackY - 9,
          WOOD_COLOR,
        );
      }
    }
  }



  // --- battle render ------------------------------------------------------

  private readonly BATTLE_ANIM_DUR: Record<TurnEvent["kind"], number> = {
    attack: 0.65,
    crit: 0.65,
    miss: 0.4,
    defend: 0.4,
    ability: 0.6,
    heal: 0.5,
    enemyMove: 0.65,
    battleEnd: 0.3,
    // Status beats are deliberately the fastest events in the table. A burn
    // build can apply a status on every attack and tick one on every unit at
    // round end, so at attack-length durations a three-enemy fight would spend
    // longer showing bookkeeping than showing the fight. Short enough to read
    // as a flourish attached to the hit that caused it, not a separate beat.
    status: 0.22,
    statusTick: 0.3,
  };

  /** Formation offsets for the 3 party slots, indexed the same way
   * `partyIds` is built (see adventure.ts's EMBARK_ORDER: front, backLeft,
   * backRight) — front sits nearest the enemy's own 0.5h engagement line
   * (conventional JRPG framing: the front line engages closest, back-liners
   * hang back toward the bottom/viewer edge), centered and offset to either
   * side for the two back slots. Front and the enemy sit on opposite
   * horizontal thirds of the screen (party x ~= 0.24w, enemy x ~= 0.74w —
   * see battlePartySlot/battleEnemySlot), so sharing a near-identical
   * dyFrac doesn't risk any sprite overlap despite front being the biggest
   * party sprite (BATTLE_ZOOM) next to the single biggest sprite in the
   * scene (enemyZoom = 4 in renderBattle). Ratios chosen to echo Muster's
   * `.adv-formation` back/front size split (back boxes are ~0.72x the
   * front box, back portraits ~0.65x). */
  /** `battleEnemySlot`, looked up by a specific enemy unit's own id rather
   * than its array index — null if `id` isn't a currently-living-or-dead
   * unit in this battle at all (a party memberId, or the literal "enemy"
   * used by battle-level, not-unit-sourced events). Used by
   * battleEventTargetPos to place a visual at the exact enemy that was
   * actually targeted, not just "the" enemy slot. */
  private enemySlotForId(
    battle: BattleSnapshot | null,
    id: string,
  ): { x: number; y: number } | null {
    if (!battle) return null;
    const idx = battle.enemies.findIndex((u) => u.id === id);
    return idx === -1 ? null : battleEnemySlot(idx, battle.enemies.length, this);
  }

  private battleMemberIndex(memberId: string): number {
    const ids = this.save.adventure?.partyIds ?? this.lastBattlePartyIds;
    return ids.indexOf(memberId);
  }

  private battleMemberSlot(memberId: string): { x: number; y: number } | null {
    const idx = this.battleMemberIndex(memberId);
    return idx === -1 ? null : battlePartySlot(idx, this);
  }

  private battleEventTargetPos(event: TurnEvent): { x: number; y: number } {
    const battle = this.battleSnapshot();
    // actorId is either the literal "enemy" (battle-level events not
    // sourced from one particular unit — the lastStand/roped save "heal",
    // battleEnd — see battle.ts's TurnEvent doc comment) or a specific
    // EnemyUnit.id (e.g. "enemy-1") for a per-unit attack/enemyMove. Either
    // way, the event was enemy-sourced, so its visual belongs on the party
    // side.
    const isEnemyActor =
      event.actorId === "enemy" ||
      !!battle?.enemies.some((u) => u.id === event.actorId);
    if (isEnemyActor) {
      if (event.targetId && event.targetId !== "party") {
        return this.battleMemberSlot(event.targetId) ?? battlePartySlot(0, this);
      }
      return battlePartySlot(0, this);
    }
    const fallbackEnemySlot = battleEnemySlot(0, battle?.enemies.length ?? 1, this);
    if (event.targetId) {
      return (
        this.enemySlotForId(battle, event.targetId) ??
        this.battleMemberSlot(event.targetId) ??
        fallbackEnemySlot
      );
    }
    return this.battleMemberSlot(event.actorId) ?? fallbackEnemySlot;
  }

  /** Fires the moment a queued TurnEvent starts animating (see update()) —
   * spawns the floating number / hit-flash / shake that make the turn
   * actually read as having happened, not just a silent state change. */
  private onBattleEventStart(event: TurnEvent): void {
    const pos = this.battleEventTargetPos(event);
    if (
      event.kind === "attack" ||
      event.kind === "crit" ||
      event.kind === "enemyMove"
    ) {
      if (typeof event.amount === "number") {
        const color = event.kind === "crit" ? "#ffd75e" : "#ffffff";
        this.floats.push(
          new FloatingText(
            pos.x,
            pos.y - 12,
            `-${abbrev(event.amount)}`,
            color,
          ),
        );
      }
      // A slash sweeps across whoever just got hit — the same SLASH1/SLASH2
      // asset manual chop swings already use, so every landed hit (either
      // direction) reads as a real impact rather than just a number
      // changing. Crits get a wider, brighter flourish.
      this.effects.push(
        new Effect(
          pos.x,
          pos.y,
          [SLASH1, SLASH2],
          event.kind === "crit" ? 0.3 : 0.22,
        ),
      );
      this.battleFlashId = event.targetId ?? null;
      this.battleFlashT = 0.25;
      playSfx(event.kind === "crit" ? "crit" : "hit");
      if (event.kind === "crit" || event.kind === "enemyMove") {
        this.battleShakeT = 0.2;
        // Shake scales with how hard the hit landed RELATIVE to its
        // target's max HP (scale-free — raw damage grows 10^world), from a
        // subtle 2px rattle to a 6px slam on a near-lethal hit.
        const targetMax = this.battleTargetMaxHp(event);
        const frac = targetMax > 0 ? (event.amount ?? 0) / targetMax : 0;
        this.battleShakeMag = Math.max(2, Math.min(6, 2 + 10 * frac));
      }
    } else if (event.kind === "heal") {
      playSfx("heal");
      if (typeof event.amount === "number") {
        this.floats.push(
          new FloatingText(
            pos.x,
            pos.y - 12,
            `+${abbrev(event.amount)}`,
            "#6fb7ff",
          ),
        );
      }
    } else if (event.kind === "defend") {
      playSfx("defend");
    }
  }

  /** Max HP of whatever a damage event just hit — a party member's maxHp or
   * an enemy unit's spec.hp — for scale-free screenshake magnitude. */
  private battleTargetMaxHp(event: TurnEvent): number {
    if (!event.targetId) return 0;
    const member = this.memberById(event.targetId);
    if (member) return member.maxHp;
    const unit = this.save.adventure?.battle?.enemies.find(
      (u) => u.id === event.targetId,
    );
    return unit?.spec.hp ?? 0;
  }

  /** Which pose a battle unit should show right now, given the in-flight
   * animation (if this unit is the actor or the target of it). */
  /** Battle-unit pose resolution. Returns both the PixelMap to draw (as
   * before) AND the resolved pose NAME, so the party-member loop can look
   * up an equipped Adventuring item's weapon art by the same key without
   * re-deriving the animation-state logic below. Every existing special
   * case is preserved exactly (in particular the scientist's glitchPulse
   * `special` frame override) — `special` still substitutes a different
   * PixelMap for the windup frame, but the pose is still conceptually
   * "attackWindup" (the ability replaces the sprite content, not the slot),
   * which is also why enemies — the only unit kind with a `special` frame —
   * are never weapon-composited (see the party-member loop; out of scope
   * for Part D regardless). */
  private battleUnitPose(
    id: string,
    hp: number,
    frames: EnemyFrameSet,
  ): {
    frame: PixelMap;
    name: "idle" | "attackWindup" | "attackStrike" | "hurt" | "defeated";
  } {
    if (hp <= 0) return { frame: frames.defeated, name: "defeated" };
    const anim = this.battleAnim;
    if (anim) {
      const p = anim.dur > 0 ? Math.min(1, anim.t / anim.dur) : 1;
      if (anim.event.actorId === id) {
        const attacking =
          anim.event.kind === "attack" ||
          anim.event.kind === "crit" ||
          anim.event.kind === "enemyMove";
        if (attacking) {
          const special = anim.event.moveId === "glitchPulse" && frames.special;
          if (p < 0.5)
            return {
              frame: special || frames.attackWindup,
              name: "attackWindup",
            };
          return { frame: frames.attackStrike, name: "attackStrike" };
        }
      }
      if (
        anim.event.targetId === id &&
        (anim.event.kind === "attack" ||
          anim.event.kind === "crit" ||
          anim.event.kind === "enemyMove")
      ) {
        return { frame: frames.hurt, name: "hurt" };
      }
    }
    return { frame: frames.idle, name: "idle" };
  }

  /** How far along its lunge an attacking unit currently is, 0 (idle) to 1
   * (full extension) and back to 0 — a cheap sine-shaped in/out. */
  private battleLungeT(id: string): number {
    const anim = this.battleAnim;
    if (!anim || anim.event.actorId !== id) return 0;
    const attacking =
      anim.event.kind === "attack" ||
      anim.event.kind === "crit" ||
      anim.event.kind === "enemyMove";
    if (!attacking || anim.dur <= 0) return 0;
    const p = Math.min(1, anim.t / anim.dur);
    return Math.sin(p * Math.PI);
  }

  /** Full-window turn-based battle scene. The party's HP/actions live in
   * the DOM overlay (#battle, arbitrary text) — this canvas layer only owns
   * the animated sprites, motion, and floating numbers/flashes. */
  /** Builds the view the battle renderer needs (see scene/battle-render.ts)
   * and hands off. Methods are wrapped rather than passed by reference so
   * they stay bound to this Game. */
  private renderBattle(ctx: CanvasRenderingContext2D): void {
    renderBattleScene(ctx, {
      w: this.w,
      h: this.h,
      animT: this.animT,
      doorCount: this.exitOffer()?.length ?? 0,
      doorHover: this.doorHover,
      doorRewards: this.exitOffer()?.map((r) => r.reward) ?? [],
      save: this.save,
      floats: this.floats,
      lastBattlePartyIds: this.lastBattlePartyIds,
      lastBattleWorld: this.lastBattleWorld,
      battleAnim: this.battleAnim,
      battleEndT: this.battleEndT,
      battleFlash: this.battleFlash,
      battleFlashId: this.battleFlashId,
      battleFlashT: this.battleFlashT,
      battleShakeMag: this.battleShakeMag,
      battleShakeT: this.battleShakeT,
      battleSkillCheck: this.battleSkillCheck,
      battleSkillCheckGrace: this.battleSkillCheckGrace,
      battleSnapshot: () => this.battleSnapshot(),
      currentBattleActorId: () => this.currentBattleActorId(),
      battlePendingActionKind: () => this.battlePendingActionKind(),
      battleMemberSlot: (id) => this.battleMemberSlot(id),
      battleLungeT: (id) => this.battleLungeT(id),
      battleUnitPose: (id, hp, frames) => this.battleUnitPose(id, hp, frames),
      deathSquash: (id) => this.deathSquash(id),
      partyFor: (ids) => this.partyFor(ids),
      workerPalette: (world) => this.workerPalette(world),
      weaponPalette: (world) => this.weaponPalette(world),
    });
  }
}
