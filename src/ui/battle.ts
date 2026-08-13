// Battle overlay: a thin, transparent HUD (enemy name/HP, party rows,
// floating action bubbles) floating over the canvas battle scene (see
// Game.renderBattle) — deliberately not an opaque panel like
// #shop/#adventure, since the whole point is to see the fight happening
// behind it. All mutation routes through Game methods, which own the save +
// turn engine (src/battle.ts).
//
// No text-box combat log, no button-grid menu: whoever's turn it is gets 4
// floating icon bubbles (Attack/Defend/Ability/Retreat, keys 1-4) positioned
// right around their sprite (see showBubbles/positionBubbles). Attack and
// Defend both open the same on-canvas sweep-the-bar timing check
// (Game.beginBattleTiming) instead of submitting instantly — a Defend grade
// sets its mitigation, an Attack grade can force a guaranteed crit ("great")
// or deny one outright ("miss"). Every turn's actual result is pure canvas
// juice (floating damage numbers, hit-flash, a slash sweep, screenshake —
// see Game.onBattleEventStart), not narrated in DOM text; syncModeFromGameState
// re-derives what the HUD should show every tick straight from Game's own
// state (no event queue to drain). `box`/textEl survive only for the
// run-ending outcome recap, which carries real banked-amount numbers with
// nowhere else to appear. Every DOM node is built ONCE at init and only
// ever has its text/classes/position updated afterward — nothing is torn
// down and rebuilt on a timer, which is what let clicks get silently eaten
// in an earlier version (a button removed mid-click never receives its
// click event).

import { ENEMY_CHARACTERS_BY_ID, type EnemySpec } from "../adventure";
import { PLAYER_CRIT_CHANCE, type BattleAction, type BattleSnapshot } from "../battle";
import {
  BOON_DEFS_BY_ID,
  describeBoon,
  RARITY_LABEL,
  type BoonSlot,
} from "../run/boons";
import type { RunOffer } from "../run/offers";
import { PATRON_DEFS_BY_ID, type PatronId } from "../run/patrons";
import {
  DEPTH_NAMES,
  depthOf,
  ELITE_AFFIXES,
  REWARD_LABEL,
  TOTAL_ROOMS,
  type RoomSpec,
} from "../run/rooms";

/** What a room is called on a door. Reads as a place rather than as a
 * mechanic — "A trader's stall" tells the player what they will walk into;
 * "shop" tells them what the code calls it. */
const ROOM_TITLE: Record<string, string> = {
  fight: "A fight",
  elite: "Something worse",
  boss: "The way down",
  shop: "A trader's stall",
  shrine: "A patron's shrine",
  fountain: "A cold spring",
  chaos: "A cracked gate",
  chest: "Something left behind",
};

/** The line under a door's title: what is actually promised behind it. */
function doorBlurb(room: RoomSpec): string {
  if (room.kind === "elite") {
    const affix = ELITE_AFFIXES.find((a) => a.id === room.affix);
    return affix ? `${affix.name}. ${affix.blurb}` : "A harder fight, for a better reward.";
  }
  switch (room.reward) {
    case "boon":
      return room.patron
        ? `${PATRON_DEFS_BY_ID[room.patron].name} is watching — ${PATRON_DEFS_BY_ID[room.patron].domain.toLowerCase()}.`
        : "A patron is watching.";
    case "rank":
      return "Deepen something you already carry.";
    case "acorns":
      return "Whatever is in here is worth taking.";
    case "heal":
      return "Cold water. A moment to breathe.";
    case "shop":
      return "Somebody down here still trades.";
    case "chaos":
      return "A bad bargain, honestly offered.";
    case "chest":
      return "Something was left for whoever got this far.";
    default:
      return "Onward.";
  }
}

/** What an exclusive slot is called on a card, when there is nothing being
 * replaced and no rank to show. Naming the slot is how the player learns the
 * system without a tutorial: three cards reading STRIKE, AURA, AURA teach the
 * rule faster than any explanation of it. */
const SLOT_LABEL: Record<BoonSlot, string> = {
  strike: "Strike slot",
  guard: "Guard slot",
  rite: "Rite slot",
  aura: "Aura",
  fortune: "Fortune",
  instant: "Instant",
};
import { WORKER_CLASS_INFO, WORKER_DEFS_BY_ID } from "../economy";
import { abbrev, hpBarClass } from "../scene/floating-text";
import type { ChestRevealSummary, Game } from "../scene/game";
import { BUILDABLE_SPRITES, LOG, SPARK, type PixelMap } from "../scene/sprites";
import {
  ACTION_BUBBLE_ICON,
  BOON_EYE_ICON,
  BOON_FIST_ICON,
  BOON_HEART_ICON,
  BOON_LOG_ICON,
  BOON_MIRROR_ICON,
  BOON_SHIELD_ICON,
  BOON_TRANCE_ICON,
  CHEST_ICON,
  CLASS_ICON,
  UI_PALETTE,
} from "../scene/ui-icons";
import { createLedger } from "./ledger";
import { closeOtherOverlays, registerOverlay } from "./overlay-coordinator";
import { pixelIcon } from "./pixel-icon";

const TICK_MS = 30;

/** One pixel-art sigil per PATRON, not per boon.
 *
 * The catalog is 55 boons; hand-drawing an icon for each would be a lot of art
 * for very little signal, and worse, it would bury the thing the player
 * actually needs to read at a glance. A patron's sigil appearing on a card is
 * the useful information — it says which of the five the card belongs to,
 * which is what a build is made of. The specific boon is named in words right
 * beside it.
 *
 * Reuses the existing glyph set rather than adding art: a mirror for Bramble
 * (it throws blows back), a fist for Cinder (pure aggression), a heart for Sap
 * (endurance), an eye for Static (targeting and interference) and the trance
 * glyph for Lumen (radiance). */
const PATRON_ICON_MAP: Record<PatronId, PixelMap> = {
  bramble: BOON_MIRROR_ICON,
  cinder: BOON_FIST_ICON,
  sap: BOON_HEART_ICON,
  static: BOON_EYE_ICON,
  lumen: BOON_TRANCE_ICON,
};

/** Slot glyphs override the patron sigil where the SLOT is the more useful
 * thing to know — an instant boon is not part of a build at all, and a shield
 * reads "defensive" faster than any patron colour. */
const SLOT_ICON_MAP: Partial<Record<BoonSlot, PixelMap>> = {
  instant: SPARK,
  guard: BOON_SHIELD_ICON,
  fortune: BOON_LOG_ICON,
};

function boonIcon(id: string, className?: string): HTMLImageElement {
  const def = BOON_DEFS_BY_ID[id];
  const map = (def && SLOT_ICON_MAP[def.slot]) ?? (def ? PATRON_ICON_MAP[def.patron] : BOON_FIST_ICON);
  // SPARK is the one exception: it draws with its own sprites.ts base palette
  // rather than UI_PALETTE, so an instant boon's glyph renders identically to
  // the in-game VFX it stands for.
  const palette = map === SPARK ? undefined : UI_PALETTE;
  return pixelIcon(map, { palette, className });
}

/** Combined name for however many enemies are involved — "&" for exactly
 * 2, an Oxford-style comma list + "&" for 3+, unchanged (just that one
 * enemy's name) for the overwhelmingly common single-enemy case. Mirrors
 * Game.finalizeBattleOutcome's own combinedEnemyName (kept as a duplicate
 * small formatter rather than a shared import — game.ts must not depend on
 * ui/battle.ts). Takes a plain EnemySpec[] (not a BattleSnapshot) so it also
 * covers showStageCleared's pre-fight buildEnemy() preview, which has no
 * BattleSnapshot yet — see enemyGroupName below for the in-battle case. */
function enemyNamesList(specs: EnemySpec[]): string {
  const names = specs.map((s) => s.name);
  if (names.length <= 1) return names[0] ?? "The enemy";
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

function enemyGroupName(battle: BattleSnapshot): string {
  return enemyNamesList(battle.enemies.map((u) => u.spec));
}


/** One-line warning shown at the start of a fresh fight against an enemy
 * with a recurring special move — surfaces EnemySpecialAbility/
 * EnemyCharacterDef.blurb (src/adventure.ts), which otherwise never render
 * anywhere in the UI. */
function specialHintFor(battle: BattleSnapshot): string | null {
  const withSpecial = battle.enemies.filter((u) => u.spec.special);
  if (withSpecial.length === 0) return null;
  return withSpecial
    .map((u) => {
      const special = u.spec.special!;
      const blurb = ENEMY_CHARACTERS_BY_ID[u.spec.characterId]?.blurb;
      const dmgPct = Math.round((special.dmgMult - 1) * 100);
      return `${u.spec.name}${blurb ? ` — ${blurb}` : ""} Watch out: every ${special.everyNth} turns it hits one ally for +${dmgPct}% damage!`;
    })
    .join(" ");
}

type Mode =
  // "bubbles": the floating action bubbles are up, waiting on a pick — the
  // direct replacement for the old "menu" (text prompt + button grid).
  | "bubbles"
  | "skillcheck"
  | "outcome"
  | "idle"
  | "revival"
  | "boon"
  | "chest"
  | "cleared"
  | "doors"
  | "room"
  | "done";

export function initBattle(game: Game): void {
  const overlay = document.getElementById("battle")!;
  const body = document.getElementById("battle-body")!;
  body.replaceChildren();

  /** Every screen this overlay can show. Exactly one is visible at a time.
   *
   * Each show* function used to hide its siblings by listing them explicitly,
   * which worked right up until the door and event screens were added: the
   * older functions had never heard of them, so taking a chest ROOM left the
   * event panel sitting on top of the chest reveal, swallowing every click
   * aimed at Continue. The run looked frozen.
   *
   * Adding a panel to this list is now the only thing required to make every
   * screen hide it. */
  const ALL_PANELS: HTMLElement[] = [];

  /** Reveals exactly one panel and hides the rest. */
  function showOnly(panel: HTMLElement | null): void {
    for (const p of ALL_PANELS) p.classList.toggle("hidden", p !== panel);
  }

  // --- persistent DOM, built once --------------------------------------
  const top = document.createElement("div");
  top.className = "battle-top";
  const round = document.createElement("span");
  round.className = "battle-round";
  // Opening the sheet is a decision the player makes mid-run, so the toggle
  // lives in the persistent top bar rather than on any one reward screen —
  // "what does my build actually do" is a question that comes up during a
  // fight at least as often as between them.
  const ledgerBtn = document.createElement("button");
  ledgerBtn.className = "battle-ledger-btn";
  ledgerBtn.textContent = "Ledger";
  ledgerBtn.title = "Everything your build is doing, and what is doing it";
  top.append(round, ledgerBtn);

  // Per-enemy name + HP-bar list — one row per living-or-dead EnemyUnit,
  // same persistent-DOM/diff-in-place discipline as partyWrap/partyRows
  // below (rows are only rebuilt when the actual set of enemy ids changes,
  // e.g. a fresh fight — never every tick, which is exactly the "rebuild
  // everything and eat a mid-click" bug class this codebase has fixed
  // before). Doubles as the multi-enemy target-selection UI: clicking a
  // living row (when more than one enemy is alive) sets it as the pending
  // Attack target — see selectEnemyTarget/syncEnemyRows.
  const enemyWrap = document.createElement("div");
  enemyWrap.className = "battle-enemies";
  const enemyRows = new Map<string, { row: HTMLElement; label: HTMLElement; fill: HTMLElement; hp: HTMLElement }>();
  let enemyRowOrder: string[] = [];

  // Stage/world/pending-reward context — the top row above only ever showed
  // the enemy's own name/HP/round, with no sense of where this fight sits
  // in the run or what's riding on it.
  const stageInfo = document.createElement("div");
  stageInfo.className = "battle-stage-info";

  // Compact "currently active boons" row — only shown once at least one
  // boon has been picked this run (see syncBoonsHud). Abbreviated labels
  // rather than icons, matching the rest of this HUD's text-first style.
  const boonsHud = document.createElement("div");
  boonsHud.className = "battle-boons-hud hidden";

  const partyWrap = document.createElement("div");
  partyWrap.className = "battle-party";
  const partyRows = new Map<string, { row: HTMLElement; label: HTMLElement; fill: HTMLElement; hp: HTMLElement }>();
  let partyRowOrder: string[] = [];

  // `box`/textEl now carry ONLY the run-ending outcome recap ("X defeated!
  // banked N wood...") — real information with nowhere else to appear, not
  // per-turn combat narration. Every ordinary turn (attack/defend/ability)
  // is pure canvas juice now: floating damage numbers, hit-flash, a slash
  // sweep, screenshake — see Game.onBattleEventStart. No "click to
  // continue" typewriter, no command-grid button box; see battle-bubbles
  // below for how a turn actually gets submitted.
  const box = document.createElement("div");
  box.className = "battle-box hidden";
  const textEl = document.createElement("div");
  textEl.className = "battle-box-text";
  box.append(textEl);

  // --- floating action bubbles: pop up around whoever's turn it is,
  // replacing the old bottom Attack/Defend/Ability/Retreat button row.
  // Built once; positioned every tick from Game.currentBattleActorScreenPos
  // (see positionBubbles). Attack and Defend both submit straight into
  // Game.submitTurnAction, which now ALWAYS opens the sweep-the-bar timing
  // check itself (see Game.beginBattleTiming) — clicking a bubble starts
  // the check, doesn't skip it.
  const bubbleWrap = document.createElement("div");
  bubbleWrap.className = "battle-bubbles hidden";
  const BUBBLE_ORDER: { action: BattleAction | "retreat"; key: string; title: string }[] = [
    {
      action: "attack",
      key: "1",
      title: `Attack — time the sweep for a bonus: a Great hit is a guaranteed crit (${PLAYER_CRIT_CHANCE > 0 ? "normally a " + Math.round(PLAYER_CRIT_CHANCE * 100) + "% chance" : "no crit chance normally"}), a Miss guarantees no crit.`,
    },
    {
      action: "defend",
      key: "2",
      title: "Time the sweep to block: 70% reduction on a Great, 40% on a Good, 10% on a Fumble.",
    },
    { action: "ability", key: "3", title: "Use your equipped Adventuring item's ability (once per run)." },
    { action: "retreat", key: "4", title: "Bank the run's pending haul now and leave the fight." },
  ];
  const bubbleEls = BUBBLE_ORDER.map(({ action, key, title }) => {
    const btn = document.createElement("button");
    btn.className = `battle-bubble battle-bubble-${action}`;
    btn.title = title;
    btn.append(pixelIcon(ACTION_BUBBLE_ICON[action], { palette: UI_PALETTE, className: "battle-bubble-icon" }));
    const badge = document.createElement("span");
    badge.className = "battle-bubble-key";
    badge.textContent = key;
    btn.append(badge);
    if (action === "retreat") {
      btn.addEventListener("click", () => game.retreatAdventure());
    } else {
      btn.addEventListener("click", () => submitAction(action));
    }
    bubbleWrap.append(btn);
    return { action, btn };
  });
  const abilityBubble = bubbleEls.find((b) => b.action === "ability")!.btn;

  // --- "Team Down" revive-offer screen, persistent DOM, built once -------
  // Shown ahead of a pending boon offer (see finishRewardFlow) whenever a
  // stage win left 1+ party members downed — see Game.finalizeBattleOutcome/
  // AdventureState.pendingRevival. Reuses the exact same gold-bordered
  // reward-panel chrome as the boon/chest screens below (.battle-boon-panel)
  // rather than inventing a new visual language for a third reward screen.
  // Unlike the boon panel, a skip IS offered — see Game.resolveRevival.
  const revivalPanel = document.createElement("div");
  revivalPanel.className = "battle-box battle-boon-panel hidden";
  const revivalTitle = document.createElement("div");
  revivalTitle.className = "battle-boon-title";
  revivalTitle.textContent = "Team Down!";
  const revivalText = document.createElement("div");
  revivalText.className = "battle-chest-rewards";
  // Full-width standalone CTA, only shown when the free roll succeeded —
  // same "primary reward action below a text block" role chestContinueBtn
  // already plays on the chest-reveal screen, just reusing its classes
  // verbatim instead of a new one.
  const revivalFreeBtn = document.createElement("button");
  revivalFreeBtn.className = "battle-chest-continue btn-primary";
  revivalFreeBtn.textContent = "Revive Team — Free!";
  // Paid option + skip, in the same 2-column command-grid chrome the
  // stage-cleared prompt's Push On/Retreat & Bank pair already uses — the
  // paid button follows pushOnBtn's own disabled/title-tooltip convention
  // for "not enough currency", and the skip button reuses the exact same
  // muted "de-emphasized exit" look retreatBtn/clearRetreatBtn already have.
  const revivalGrid = document.createElement("div");
  revivalGrid.className = "battle-box-grid";
  const revivalPaidBtn = document.createElement("button");
  const revivalSkipBtn = document.createElement("button");
  revivalSkipBtn.textContent = "Continue Without Reviving";
  revivalSkipBtn.className = "battle-retreat-grid";
  revivalGrid.append(revivalPaidBtn, revivalSkipBtn);
  revivalPanel.append(revivalTitle, revivalText, revivalFreeBtn, revivalGrid);

  // --- boon-offer card screen, persistent DOM, built once ----------------
  // Same darkened-panel chrome as .battle-box, sized to hold 3 selectable
  // cards instead of a text line + command grid. Shown in place of `box`
  // after a stage-1-4 win (see showBoonOffer) — no skip button, per
  // explicit design: picking one of the 3 is mandatory before Push On
  // becomes available again (see Game.beginStageBattle).
  const boonPanel = document.createElement("div");
  boonPanel.className = "battle-box battle-boon-panel hidden";
  const boonTitle = document.createElement("div");
  boonTitle.className = "battle-boon-title";
  boonTitle.textContent = "Choose a boon";
  const boonCardsWrap = document.createElement("div");
  boonCardsWrap.className = "battle-boon-cards";
  // Four slots, not three: Overclock and The Long Day both widen the offer,
  // and the extra node costs nothing while it stays hidden.
  const boonCards = Array.from({ length: 4 }, () => {
    const btn = document.createElement("button");
    btn.className = "battle-boon-card";
    const tag = document.createElement("span");
    tag.className = "battle-boon-card-tag";
    const name = document.createElement("span");
    name.className = "battle-boon-card-name";
    const desc = document.createElement("span");
    desc.className = "battle-boon-card-desc";
    // The line that says what this pick COSTS — which exclusive boon it
    // displaces, or which rank it moves. Without it, an exclusive slot is a
    // trap rather than a decision.
    const note = document.createElement("span");
    note.className = "battle-boon-card-note";
    btn.append(tag, name, desc, note);
    boonCardsWrap.append(btn);
    return { btn, tag, name, desc, note };
  });
  const boonReroll = document.createElement("button");
  boonReroll.className = "battle-boon-reroll hidden";
  boonPanel.append(boonTitle, boonCardsWrap, boonReroll);

  // --- chest-reveal screen, persistent DOM, built once --------------------
  // A milestone chest (stage 3 clear / stage 5 full clear) — the reward is
  // already permanently applied to the save by the time this shows (see
  // Game.grantChest); this is purely a "here's what you got" reveal beat.
  const chestPanel = document.createElement("div");
  chestPanel.className = "battle-box battle-chest-panel hidden";
  const chestTitle = document.createElement("div");
  chestTitle.className = "battle-chest-title";
  chestTitle.append(
    pixelIcon(CHEST_ICON, { palette: UI_PALETTE, className: "battle-chest-title-icon" }),
    document.createTextNode("Milestone Chest!"),
  );
  const chestRewardsEl = document.createElement("div");
  chestRewardsEl.className = "battle-chest-rewards";
  const chestContinueBtn = document.createElement("button");
  chestContinueBtn.className = "battle-chest-continue btn-primary";
  chestContinueBtn.textContent = "Continue";
  chestPanel.append(chestTitle, chestRewardsEl, chestContinueBtn);

  // --- stage-cleared prompt, persistent DOM, built once -------------------
  // Shown once finishRewardFlow has exhausted the boon/chest sequence but
  // the run is still ongoing (an intermediate stage 1-4 clear) — the same
  // plain green-bordered command-grid chrome as the normal menu (this is a
  // turn-order-adjacent decision, not a reward moment like boon/chest), just
  // with two buttons instead of four: Push On (mirrors ui/adventure.ts's
  // Field-screen Push On button — same Game.beginStageBattle() call, same
  // fee display/afford-gating) or Retreat & Bank (same Game.retreatAdventure()
  // the live-battle Retreat grid button already uses). Replaces the old
  // inert terminal "done" mode for this case — see finishRewardFlow.
  const clearPanel = document.createElement("div");
  clearPanel.className = "battle-box hidden";
  const clearText = document.createElement("div");
  clearText.className = "battle-box-text";
  const clearGrid = document.createElement("div");
  clearGrid.className = "battle-box-grid";
  const pushOnBtn = document.createElement("button");
  const clearRetreatBtn = document.createElement("button");
  clearRetreatBtn.textContent = "Retreat & Bank";
  clearRetreatBtn.className = "battle-retreat-grid";
  clearGrid.append(pushOnBtn, clearRetreatBtn);
  clearPanel.append(clearText, clearGrid);

  // --- door choice, persistent DOM, built once ---------------------------
  // The junction between rooms: two or three ways on, each showing what it
  // promises. This is the run's core act of agency — everything else is
  // reacting to what a fight did, this is choosing what the next one will be.
  const doorPanel = document.createElement("div");
  doorPanel.className = "battle-box battle-boon-panel hidden";
  const doorTitle = document.createElement("div");
  doorTitle.className = "battle-boon-title";
  doorTitle.textContent = "Choose your way on";
  const doorWrap = document.createElement("div");
  doorWrap.className = "battle-boon-cards";
  const doorCards = Array.from({ length: 4 }, () => {
    const btn = document.createElement("button");
    btn.className = "battle-boon-card battle-door-card hidden";
    const tag = document.createElement("span");
    tag.className = "battle-boon-card-tag";
    const name = document.createElement("span");
    name.className = "battle-boon-card-name";
    const desc = document.createElement("span");
    desc.className = "battle-boon-card-desc";
    btn.append(tag, name, desc);
    doorWrap.append(btn);
    return { btn, tag, name, desc };
  });
  doorPanel.append(doorTitle, doorWrap);

  // --- event room, persistent DOM, built once ----------------------------
  // Shops, springs, shrines and chaos gates all resolve through here. One
  // panel rather than four: they share a shape (a title, a line of prose, a
  // short list of choices), and four near-identical panels would drift.
  const eventPanel = document.createElement("div");
  eventPanel.className = "battle-box battle-boon-panel hidden";
  const eventTitle = document.createElement("div");
  eventTitle.className = "battle-boon-title";
  const eventText = document.createElement("div");
  eventText.className = "battle-box-text";
  const eventWrap = document.createElement("div");
  eventWrap.className = "battle-boon-cards";
  const eventCards = Array.from({ length: 4 }, () => {
    const btn = document.createElement("button");
    btn.className = "battle-boon-card hidden";
    const tag = document.createElement("span");
    tag.className = "battle-boon-card-tag";
    const name = document.createElement("span");
    name.className = "battle-boon-card-name";
    const desc = document.createElement("span");
    desc.className = "battle-boon-card-desc";
    btn.append(tag, name, desc);
    eventWrap.append(btn);
    return { btn, tag, name, desc };
  });
  const eventLeave = document.createElement("button");
  // Its own class as well as the shared styling one: this footer and the offer
  // panel's reroll are different controls with different handlers, and a lookup
  // by the shared class silently resolves to whichever is first in the DOM.
  eventLeave.className = "battle-boon-reroll battle-event-action";
  eventPanel.append(eventTitle, eventText, eventWrap, eventLeave);

  const ledger = createLedger();
  let ledgerOpen = false;
  ledgerBtn.addEventListener("click", () => {
    ledgerOpen = !ledgerOpen;
    if (ledgerOpen) ledger.update(game.runStats(), game.battleSnapshot() ?? undefined);
    ledger.el.classList.toggle("hidden", !ledgerOpen);
    ledgerBtn.classList.toggle("active", ledgerOpen);
  });

  body.append(
    top,
    stageInfo,
    boonsHud,
    enemyWrap,
    partyWrap,
    bubbleWrap,
    box,
    revivalPanel,
    boonPanel,
    chestPanel,
    clearPanel,
    doorPanel,
    eventPanel,
    ledger.el,
  );
  // The ledger is deliberately NOT in this list: it is a toggle the player
  // opens over whatever is on screen, not one of the mutually-exclusive
  // screens, and hiding it on every transition would close it under them.
  ALL_PANELS.push(box, revivalPanel, boonPanel, chestPanel, clearPanel, doorPanel, eventPanel);

  // --- state -------------------------------------------------------------
  let mode: Mode = "idle";
  let currentActor: string | null = null;
  let wasOpen = false;
  /** The player's explicitly-clicked Attack target for the current actor's
   * turn (an EnemyUnit.id), or null to fall back to the engine's own
   * lowest-index-living-enemy default (see resolvePartyTurn/submitAction()).
   * Reset whenever the acting member changes (see showBubbles) — a stale
   * pick from an earlier turn could point at an enemy that's since been
   * defeated, and each actor's turn should start from the same clean
   * default the very first turn of the fight did. */
  let selectedTargetEnemyId: string | null = null;

  // --- one-time special-move warning, non-blocking -----------------------
  // Replaces the old blocking "click to continue" narration line for this:
  // a brief top banner that fades on its own, shown alongside the bubbles
  // rather than gating them — the whole point of dropping the text box is
  // that nothing waits on a click to read prose anymore.
  const hintBanner = document.createElement("div");
  hintBanner.className = "battle-hint hidden";
  let hintTimer: number | null = null;
  function showHint(text: string): void {
    hintBanner.textContent = text;
    hintBanner.classList.remove("hidden");
    if (hintTimer !== null) window.clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => hintBanner.classList.add("hidden"), 4200);
  }
  body.appendChild(hintBanner);

  /** Canvas-logical-space -> this element's actual rendered CSS size — not
   * a hardcoded 2x, so this stays correct at any battle-takeover window
   * size. #battle-body and #scene share the exact same box whenever a
   * battle is showing (see #battle's "thin HUD over the canvas" comment up
   * top), which is the only time this ever runs. */
  const canvasEl = document.getElementById("scene") as HTMLCanvasElement;
  // Spread widened along with the bubbles themselves (26px -> 40px, see
  // styles.css): at the old offsets 40px circles would overlap each other,
  // and adjacent-but-touching targets are exactly how a click meant for
  // Attack lands on Defend.
  // A 2x2 block FLANKING the actor, not a diamond ringing it. The diamond
  // this replaces put Attack directly above the head and Retreat directly
  // below the feet, and at a 40px token that top one landed squarely on the
  // sprite's own head/torso — the character was reading through a hole in
  // its own controls. Keeping the whole vertical column above the head
  // clear also leaves room for the floating nameplate (see positionPlates),
  // which now lives there. Reading order matches the 1/2/3/4 key badges:
  // left-to-right, top-to-bottom.
  // The top row's dy is set by the NAMEPLATE, not by the sprite: a party
  // sprite is only ~50 CSS px tall, so its plate hangs just above the head
  // and a 40px token at dy -50 punched straight through the plate's lower
  // edge (measured: 9px of overlap). -34 clears it with a few px to spare
  // and still keeps the whole cluster flanking the character.
  // Offsets in LOGICAL px, converted to CSS at the canvas's live scale — the
  // same conversion the anchor position goes through.
  //
  // They used to be CSS px. That was fine while the canvas rendered at ~4x,
  // but once it targeted a constant logical width the scale went to ~7x at a
  // 1680px window: sprites nearly doubled, the offsets did not, and the token
  // cluster ended up sitting on top of the character it belonged to. Anything
  // positioned against the world has to be measured in the world's units.
  //
  // Both rows sit ABOVE the actor's feet and well out to the sides. The
  // constraints are tighter than they look: the front sprite is 15 logical px
  // half-wide, so anything inside +/-20 is drawn on top of the character; and
  // the two BACK-ROW members stand at 0.72h with their own nameplates above
  // their heads, which a downward-hanging token row lands squarely on.
  const BUBBLE_OFFSET: Record<string, { dx: number; dy: number }> = {
    attack: { dx: -22, dy: -15 },
    defend: { dx: 22, dy: -15 },
    ability: { dx: -22, dy: -3 },
    retreat: { dx: 22, dy: -3 },
  };

  /** Convert a logical-canvas-px point (what every Game screen-pos getter
   * returns) into a point in `body`'s coordinate space, which is what the
   * floating action tokens and the unit nameplates both position against.
   * The canvas renders at half CSS resolution and can be letterboxed inside
   * its element, so this needs the live bounding rects, not a constant.
   * Null when the canvas has no size yet (first frame before layout). */
  function canvasToBody(pos: { x: number; y: number }): { x: number; y: number } | null {
    if (canvasEl.width === 0 || canvasEl.height === 0) return null;
    const rect = canvasEl.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    return {
      x: rect.left - bodyRect.left + (pos.x * rect.width) / canvasEl.width,
      y: rect.top - bodyRect.top + (pos.y * rect.height) / canvasEl.height,
    };
  }

  function positionBubbles(): void {
    const slot = game.currentBattleActorScreenPos();
    if (!slot) return;
    const screen = canvasToBody(slot);
    if (!screen) return;
    const cx = screen.x;
    const cy = screen.y;
    const scale = canvasEl.getBoundingClientRect().width / canvasEl.width;
    for (const { action, btn } of bubbleEls) {
      const off = BUBBLE_OFFSET[action] ?? { dx: 0, dy: 0 };
      btn.style.left = `${Math.round(cx + off.dx * scale)}px`;
      btn.style.top = `${Math.round(cy + off.dy * scale)}px`;
    }
  }

  /** Hang every unit's name/HP plate directly over that unit's own head,
   * JRPG-style, instead of parking the whole roster in two fixed corners.
   * Two fixed lists meant you had to read a name in the corner, find the
   * matching sprite in the middle, and hold the mapping yourself — with
   * three party members and up to three enemies that's six lookups a turn.
   * Anchored to the sprite, the association is free.
   *
   * Runs every tick because the anchor moves whenever the window resizes
   * (slots are fractions of canvas size). It only ever writes left/top on
   * nodes that already exist — no rebuild, so it can't eat a click on a
   * targetable enemy row (see syncEnemyRows' note on that bug class).
   *
   * `translate: -50% -100%` in CSS does the centring and the sit-above, so
   * this stays pure "where is the head" math and doesn't need to measure
   * each plate. That property, NOT `transform` — these plates are inside a
   * clickable row, and the global `button:active` rule owns `transform`
   * (see the convention note in styles.css). */
  function positionPlates(): void {
    const place = (id: string, row: HTMLElement): void => {
      const head = game.battleUnitHeadPos(id);
      const screen = head && canvasToBody(head);
      if (!screen) {
        row.classList.add("unanchored");
        return;
      }
      row.classList.remove("unanchored");
      const scale = canvasEl.getBoundingClientRect().width / canvasEl.width;
      row.style.left = `${Math.round(screen.x)}px`;
      // 2 logical px of daylight above the head, not 8 CSS px — same reason
      // as the token offsets above.
      row.style.top = `${Math.round(screen.y - 2 * scale)}px`;
    };
    for (const [id, entry] of enemyRows) place(id, entry.row);
    for (const [id, entry] of partyRows) place(id, entry.row);
  }

  function hideBubbles(): void {
    bubbleWrap.classList.add("hidden");
  }

  /** The direct replacement for the old showMenu(): pops the 4 bubbles up
   * around whoever's turn it is, instead of a text prompt + button grid. */
  function showBubbles(): void {
    const actorId = game.currentBattleActorId();
    if (!actorId) {
      mode = "idle";
      hideBubbles();
      syncClickCapture();
      return;
    }
    if (currentActor !== actorId) {
      currentActor = actorId;
      selectedTargetEnemyId = null;
    }
    const canAbility = game.battleCanAbility(actorId);
    abilityBubble.classList.toggle("disabled", !canAbility);
    abilityBubble.title = canAbility
      ? "Use your equipped Adventuring item's ability (once per run)."
      : "No ability available — needs an Adventuring-slot item with an effect equipped, and the once-per-run charge unused.";
    bubbleWrap.classList.remove("hidden");
    positionBubbles();
    mode = "bubbles";
    syncClickCapture();
  }

  /** REWARD_MODES are fully click/button-driven screens (see their own
   * handlers) — syncModeFromGameState below must never override them mid-
   * display, only decide what comes next once their own handler moves on. */
  // "doors" and "room" belong here for the same reason every other entry does:
  // they are fully button-driven, and letting the 30ms tick re-derive the mode
  // underneath them would yank a live choice off the screen mid-decision.
  const REWARD_MODES = new Set<Mode>([
    "outcome",
    "revival",
    "boon",
    "chest",
    "cleared",
    "doors",
    "room",
    "done",
  ]);

  /** The live-combat half of the old advance()/tick() narration chain,
   * minus the narration: decides what the view should be showing RIGHT NOW
   * purely from Game's own state (no queued events to drain) — an awaiting
   * timing check, animations still playing out, a just-decided outcome, or
   * the next actor's bubbles. Called after every action and once a frame
   * while live combat is on screen (see tick()), so it's cheap and
   * idempotent by design. */
  function syncModeFromGameState(): void {
    if (REWARD_MODES.has(mode)) return;
    const battle = game.battleSnapshot();
    if (!battle) {
      mode = "idle";
      hideBubbles();
      syncClickCapture();
      return;
    }
    if (game.battleAwaitingSkillCheck()) {
      mode = "skillcheck";
      hideBubbles();
      box.classList.add("hidden");
      syncClickCapture();
      return;
    }
    if (game.battleAnimating()) {
      // The current turn's slash/flash/floating-number juice is still
      // playing out on canvas — nothing to show yet, next tick checks again.
      mode = "idle";
      hideBubbles();
      syncClickCapture();
      return;
    }
    if (battle.outcome) {
      showOutcome(battle);
      return;
    }
    showBubbles();
  }

  /** Entry beat for a genuinely fresh fight (a new stage, or a wipe-revive
   * retrying the same one) — the one-time special-move warning (if any),
   * non-blocking, then hands off to the normal per-frame flow. Shared by
   * afterRevivalResolved, pushOnBtn's handler, and tick()'s fresh-open
   * branch, which all used to duplicate this exact sequence. */
  function enterFreshBattleBeat(): void {
    box.classList.add("hidden");
    const battle = game.battleSnapshot();
    const hint =
      battle && battle.round === 1 && battle.turnIndex === 0 && battle.events.length === 0
        ? specialHintFor(battle)
        : null;
    if (hint) showHint(hint);
    mode = "idle";
    syncModeFromGameState();
  }

  /** Shown once per decided fight — the run-summary recap (banked amounts,
   * who's resting) has real numbers nowhere else appears, so this stays a
   * real (if terse) text screen even though per-turn narration is gone. The
   * canvas already drew its own big WIN/KO banner by the time this shows
   * (see Game.renderBattle) — this is the follow-up detail, not a
   * duplicate of that beat. */
  function showOutcome(battle: BattleSnapshot): void {
    const summary = game.lastOutcomeSummary();
    const enemyLabel = enemyGroupName(battle);
    const defeatedVerb = battle.enemies.length > 1 ? "are" : "is";
    let text: string;
    if (battle.outcome === "win") {
      if (summary?.runOver) {
        text = `${enemyLabel} ${defeatedVerb} defeated! Run complete — banked ${abbrev(summary.bankedWood)} wood and ${abbrev(summary.bankedAmber)} amber.`;
      } else if (summary) {
        const amberText = summary.stageAmber > 0 ? ` and ${abbrev(summary.stageAmber)} amber` : "";
        text = `${enemyLabel} ${defeatedVerb} defeated! +${abbrev(summary.stageWood)} wood${amberText} added to the run's pending haul.`;
      } else {
        text = `${enemyLabel} ${defeatedVerb} defeated! You gained the spoils.`;
      }
    } else if (game.revivalOffer()?.afterWipe) {
      // A full wipe just happened, but banking is deliberately deferred
      // until the pending Team Down offer resolves (see
      // Game.finalizeBattleOutcome's loss branch) — summary.bankedWood/
      // bankPct/restingNames are all still zeroed placeholders at this
      // point, so showing them would falsely claim the run already ended.
      // Neutral wording only; the real recap (or a revive) comes once the
      // offer is resolved — see finishRewardFlow/showRevivalOffer below,
      // and afterRevivalResolved's re-call into this same function once a
      // decline/failed-afford finalizes the loss for real.
      text = "Your party has been wiped! All is not lost just yet...";
    } else if (summary) {
      const amberText = summary.bankedAmber > 0 ? `, ${abbrev(summary.bankedAmber)} amber` : "";
      const restText = summary.narrowEscape
        ? " A narrow escape — everyone's still standing."
        : summary.restingNames.length > 0
          ? ` ${summary.restingNames.join(", ")} ${summary.restingNames.length === 1 ? "is" : "are"} now resting.`
          : "";
      text = `Your party has been defeated... only ${summary.bankPct}% of the run's rewards were kept (${abbrev(summary.bankedWood)} wood${amberText}).${restText}`;
    } else {
      text = "Your party has been defeated...";
    }
    textEl.textContent = text;
    hideBubbles();
    showOnly(box);
    mode = "outcome";
    syncClickCapture();
  }

  function rarityLabel(rarity: string): string {
    return rarity.charAt(0).toUpperCase() + rarity.slice(1);
  }

  /** "Team Down" screen — shown ahead of a pending boon offer (see
   * finishRewardFlow) whenever Game.revivalOffer() is non-null, either for
   * a stage win that left 1+ party members downed, or for a full wipe on a
   * loss (see revival.afterWipe). The downed count for the win-case wording
   * is read live off the current party's HP (still un-healed at this point
   * — resolveRevival hasn't run yet) rather than stored on pendingRevival
   * itself, the same "derive it from the save, don't duplicate it" approach
   * the rest of this HUD already uses for HP bars/actor names; the wipe
   * case skips that entirely (every member is down by definition, see
   * Game.finalizeBattleOutcome's loss branch) and just leads with the
   * stage-retry framing instead. Buttons/layout/disabled-state are
   * identical either way — only this header line's wording changes;
   * afterRevivalResolved() is what actually branches behavior per choice. */
  function showRevivalOffer(revival: { free: boolean; cost: number; afterWipe: boolean }): void {
    showOnly(revivalPanel);
    if (revival.afterWipe) {
      revivalText.textContent = "Your party was wiped! Revive the whole team to retry this stage?";
    } else {
      const adv = game.save.adventure;
      const deadCount = (adv?.partyIds ?? []).filter((id) => {
        const m = game.save.team.find((t) => t.id === id);
        return !!m && m.currentHp <= 0;
      }).length;
      revivalText.textContent = `${deadCount} ${deadCount === 1 ? "teammate" : "teammates"} went down this fight. Revive the whole team to full HP?`;
    }
    revivalFreeBtn.classList.toggle("hidden", !revival.free);
    revivalFreeBtn.onclick = () => {
      game.resolveRevival("free");
      afterRevivalResolved(revival.afterWipe);
    };
    const affordable = game.save.amber >= revival.cost;
    revivalPaidBtn.disabled = !affordable;
    revivalPaidBtn.title = affordable ? "" : `Need ${abbrev(revival.cost - game.save.amber)} more amber.`;
    revivalPaidBtn.textContent = `Revive Team — ${abbrev(revival.cost)} amber`;
    revivalPaidBtn.onclick = () => {
      game.resolveRevival("paid");
      afterRevivalResolved(revival.afterWipe);
    };
    revivalSkipBtn.onclick = () => {
      game.resolveRevival("skip");
      afterRevivalResolved(revival.afterWipe);
    };
    mode = "revival";
    syncClickCapture();
  }

  /** Continues from a just-resolved Team Down offer. A win-case offer
   * (wasAfterWipe false) always feeds into the normal reward sequence
   * (revival was never run-ending to begin with) — finishRewardFlow already
   * handles that, moving on to the boon offer. A wipe-case offer
   * (wasAfterWipe true) forks instead: a successful free/paid revive
   * already healed the party, discarded the old battle, and started a
   * brand-new one for the very same stage (see Game.resolveRevival) — jump
   * straight into that fresh fight's opening beat, the exact same entry
   * sequence pushOnBtn's own handler uses below, rather than routing
   * through finishRewardFlow (there's no reward pending here, it's a live
   * fight again). A declined ("skip") or failed-afford choice instead
   * finalized the loss for real (Game.resolveRevival -> finalizeLoss) —
   * re-run showOutcome so the player sees the real banked numbers
   * Game.lastOutcomeSummary() was just updated with (the very first
   * showOutcome call, before this offer even appeared, could only show
   * neutral wording — see showOutcome's afterWipe branch). */
  function afterRevivalResolved(wasAfterWipe: boolean): void {
    if (wasAfterWipe) {
      if (game.save.adventure?.battle) {
        revivalPanel.classList.add("hidden");
        enterFreshBattleBeat();
        return;
      }
      const battle = game.battleSnapshot();
      if (battle) showOutcome(battle);
      return;
    }
    finishRewardFlow();
  }

  /** Card-choice screen for a stage win's boon offer — exactly 3 options,
   * drawn once by Game.finalizeBattleOutcome and persisted verbatim on
   * AdventureState.pendingBoonOffer (see boons.ts's drawBoonOffer), so this
   * always shows the same 3 cards a pause-then-resume (even across an app
   * restart) originally offered. No skip: the only way out is picking one. */
  function showBoonOffer(offer: RunOffer): void {
    showOnly(boonPanel);
    boonCards.forEach((card, i) => {
      const offered = offer.cards[i];
      const def = offered ? BOON_DEFS_BY_ID[offered.boonId] : undefined;
      card.btn.classList.toggle("hidden", !def || !offered);
      if (!def || !offered) return;
      const patron = PATRON_DEFS_BY_ID[def.patron];

      // The rarity is the card's loudest signal, so it drives the border
      // colour as well as the tag — a glance across three cards should find
      // the Heroic before any word is read.
      card.btn.className = `battle-boon-card rarity-border-${offered.rarity}`;
      card.tag.textContent = offered.rankUp
        ? "RANK UP"
        : `${RARITY_LABEL[offered.rarity].toUpperCase()} · ${patron?.name.toUpperCase() ?? ""}`;
      card.tag.classList.toggle("instant", def.slot === "instant");
      card.tag.className = `battle-boon-card-tag rarity-${offered.rarity}${def.slot === "instant" ? " instant" : ""}`;

      card.name.replaceChildren(
        boonIcon(def.id, "battle-boon-card-icon"),
        document.createTextNode(def.name),
      );

      const held = game.heldBoons().find((h) => h.id === def.id);
      const rank = offered.rankUp ? (held?.rank ?? 1) + 1 : (held?.rank ?? 1);
      card.desc.textContent = describeBoon(def, { rarity: offered.rarity, rank });

      // Exclusive slots are the system's whole texture, and they only work if
      // the card says what taking it costs. A silent replacement is the most
      // frustrating thing this screen can do.
      const replaced = offered.replacesId ? BOON_DEFS_BY_ID[offered.replacesId] : undefined;
      card.note.textContent = replaced
        ? `Replaces ${replaced.name}`
        : offered.rankUp
          ? `Rank ${(held?.rank ?? 1)} → ${rank}`
          : SLOT_LABEL[def.slot];
      card.note.classList.toggle("replaces", !!replaced);

      card.btn.onclick = () => {
        game.pickBoonCard(offered.boonId);
        finishRewardFlow();
      };
    });

    layoutCards(boonCardsWrap, offer.cards.filter((c) => BOON_DEFS_BY_ID[c.boonId]).length);

    const rerolls = offer.rerollsLeft;
    boonReroll.classList.toggle("hidden", rerolls <= 0 && offer.rerollCount === 0);
    boonReroll.disabled = rerolls <= 0;
    boonReroll.textContent = rerolls > 0 ? `Reroll · ${rerolls} left` : "No rerolls left";
    boonReroll.title = rerolls > 0 ? "Draw a fresh set of cards" : "You have no reroll charges.";
    boonReroll.onclick = () => {
      if (!game.rerollBoonOffer()) return;
      const next = game.boonOffer();
      if (next) showBoonOffer(next);
    };

    mode = "boon";
    syncClickCapture();
  }

  /** Reveal screen for a milestone chest (stage 3 / stage 5 full clear) —
   * the reward is already permanently applied to the save by the time this
   * shows (see Game.grantChest); this is purely informational. */
  function showChestReveal(chest: ChestRevealSummary): void {
    showOnly(chestPanel);
    const amberLine = chest.amber > 0 ? ` and ${abbrev(chest.amber)} amber` : "";
    chestRewardsEl.replaceChildren();
    const woodLine = document.createElement("div");
    const woodIcon = pixelIcon(LOG, { className: "battle-chest-wood-icon" });
    woodLine.append(woodIcon, document.createTextNode(` +${abbrev(chest.wood)} wood${amberLine}`));
    const itemLine = document.createElement("div");
    const itemDot = document.createElement("span");
    itemDot.className = `rarity-dot rarity-${chest.itemRarity}`;
    itemLine.append(itemDot, document.createTextNode(`${rarityLabel(chest.itemRarity)} item: ${chest.itemName}`));
    const shardLine = document.createElement("div");
    const shardDot = document.createElement("span");
    shardDot.className = `rarity-dot rarity-${chest.shardRarity}`;
    shardLine.append(
      shardDot,
      document.createTextNode(`+${abbrev(chest.shardAmount)} ${rarityLabel(chest.shardRarity)} shards`),
    );
    chestRewardsEl.append(woodLine, itemLine, shardLine);

    // Homestead decoration — given its own emphasised row with the actual
    // sprite, because it's the one reward you take home and place rather than
    // a number that vanishes into a total.
    if (chest.decorId && chest.decorName) {
      const decorLine = document.createElement("div");
      decorLine.className = "battle-chest-decor";
      const map = BUILDABLE_SPRITES[chest.decorId];
      if (map) decorLine.append(pixelIcon(map, { palette: UI_PALETTE, scale: 2 }));
      decorLine.append(
        document.createTextNode(` ${chest.decorName} — free to place in your yard`),
      );
      chestRewardsEl.append(decorLine);
    }
    chestContinueBtn.onclick = () => {
      game.dismissChestReveal();
      finishRewardFlow();
    };
    mode = "chest";
    syncClickCapture();
  }

  /** Interactive "stage cleared" prompt: shown once finishRewardFlow has
   * exhausted the boon/chest sequence but the run is still ongoing (an
   * intermediate stage 1-4 clear, including stage 3's chest-then-boon
   * combo) — lets the player push straight on to the next fight or bank out,
   * without ever leaving this view. Mirrors ui/adventure.ts's Field screen's
   * own Push On/Retreat & Bank buttons (same Game calls, same fee-display/
   * afford-gating convention), just reachable without a round trip through
   * the DOM overlay. */
  function showDepthCleared(): void {
    showOnly(clearPanel);
    const adv = game.save.adventure;
    if (adv) {
      const toll = game.nextStageFee();
      const depth = depthOf(adv.roomsCleared);
      const amberText = adv.pendingAmber > 0 ? ` and ${abbrev(adv.pendingAmber)} amber` : "";
      clearText.textContent =
        `${DEPTH_NAMES[depthOf(adv.roomsCleared - 1)]} is behind you. Descend into ` +
        `${DEPTH_NAMES[depth] ?? "the deep"} for ${abbrev(toll)} wood, or leave now and ` +
        `bank ${abbrev(adv.pendingWood)} wood${amberText}?`;
      const affordable = game.save.wood >= toll;
      pushOnBtn.disabled = !affordable;
      pushOnBtn.title = affordable ? "" : `Need ${abbrev(toll - game.save.wood)} more wood to descend.`;
      pushOnBtn.textContent = `Descend · ${abbrev(toll)} wood`;
    }
    mode = "cleared";
    syncClickCapture();
  }

  pushOnBtn.addEventListener("click", () => {
    // Past a Depth boss there is exactly one way on, so "descend" and "take
    // the only door" are the same action — no door screen is shown for it.
    const exits = game.exitOffer();
    if (!exits || exits.length === 0 || !game.pickExit(exits[0].id)) return;
    // beginStageBattle() already started the next fight in place (same
    // Game.startBattleForNextStage() a fresh embark/Push On always goes
    // through) — replicate the exact same entry beat tick()'s own
    // fresh-open branch uses, so the next enemy's opening warning (if any)
    // and bubbles appear immediately, without the view ever closing.
    clearPanel.classList.add("hidden");
    enterFreshBattleBeat();
  });
  clearRetreatBtn.addEventListener("click", () => {
    game.retreatAdventure();
    game.closeBattleView();
  });

  /** After a revive decision (and/or a boon pick, and/or a chest dismissal),
   * continues to whatever's next in the win-reward sequence — revive offer,
   * then boon, then chest, then either the interactive "stage cleared"
   * prompt above (run still ongoing — an intermediate 1-4 stage clear) or a
   * plain ready-to-exit idle state (the run just ended for real: a stage-5
   * full clear, already banked by finalizeBattleOutcome's win branch by the
   * time its chest is even granted — see Game.bankAdventure/grantChest). The
   * "X defeated!" recap was already shown once, before the first of these
   * screens ever appeared (see showOutcome/the overlay click handler), so
   * it's deliberately not replayed here. Re-checked from scratch each time
   * rather than a fixed linear sequence, so it stays correct regardless of
   * which of revival/boon/chest was actually pending (e.g. a downed member
   * only ever comes with a boon too, stage 5 only ever has a chest, stage 3
   * has both boon and chest). Revival is checked first — a downed teammate
   * is more urgent/prominent than a boon pick. */
  /** Lays a card grid out for however many cards are actually showing.
   *
   * Four cards go to a 2x2 rather than a single row of four: at the tray's
   * width four columns leaves each card too narrow to hold a sentence, and a
   * card whose description is cut off is worse than one more row. */
  function layoutCards(wrap: HTMLElement, visible: number): void {
    const cols = visible <= 3 ? Math.max(1, visible) : 2;
    wrap.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  }

  /** The junction screen. Each card is a door, showing the reward waiting
   * behind it — which is the whole point: the choice is informed, so a run's
   * shape is something the player steers rather than something that happens to
   * them. */
  function showDoors(exits: RoomSpec[]): void {
    showOnly(doorPanel);
    hideBubbles();
    doorCards.forEach((card, i) => {
      const room = exits[i];
      card.btn.classList.toggle("hidden", !room);
      if (!room) return;
      card.btn.className = `battle-boon-card battle-door-card door-${room.reward}`;
      card.tag.textContent = REWARD_LABEL[room.reward];
      card.tag.className = `battle-boon-card-tag door-tag-${room.reward}`;
      card.name.replaceChildren(document.createTextNode(ROOM_TITLE[room.kind] ?? "Onward"));
      card.desc.textContent = doorBlurb(room);
      card.btn.onclick = () => {
        if (!game.pickExit(room.id)) return;
        doorPanel.classList.add("hidden");
        finishRewardFlow();
      };
    });
    layoutCards(doorWrap, exits.length);
    mode = "doors";
    syncClickCapture();
  }

  /** Shops, springs, shrines and chaos gates. */
  function showRoomEvent(event: { roomId: string; kind: string }): void {
    showOnly(eventPanel);
    hideBubbles();
    eventTitle.textContent = ROOM_TITLE[event.kind] ?? "A quiet room";
    eventLeave.classList.remove("hidden");
    eventLeave.textContent = "Move on";
    eventLeave.disabled = false;
    eventLeave.onclick = () => {
      game.leaveRoom();
      finishRewardFlow();
    };

    const hide = () => eventCards.forEach((c) => c.btn.classList.add("hidden"));
    const relayout = () =>
      layoutCards(eventWrap, eventCards.filter((c) => !c.btn.classList.contains("hidden")).length);

    if (event.kind === "shop") {
      const shop = game.shopState();
      const acorns = game.acorns();
      eventText.textContent = `${abbrev(acorns)} acorns in hand.`;
      hide();
      (shop?.stock ?? []).forEach((entry, i) => {
        const card = eventCards[i];
        if (!card) return;
        const label = game.shopEntryLabel(entry);
        card.btn.classList.remove("hidden");
        card.btn.className = `battle-boon-card${entry.sold ? " sold" : ""}`;
        card.tag.textContent = entry.sold ? "SOLD" : `${entry.cost} ACORNS`;
        card.name.replaceChildren(document.createTextNode(label.name));
        card.desc.textContent = label.blurb;
        const affordable = !entry.sold && acorns >= entry.cost;
        card.btn.disabled = !affordable;
        // The codebase's one tooltip convention: say WHY a control is dead.
        card.btn.title = entry.sold
          ? "Already bought."
          : affordable
            ? ""
            : `Need ${entry.cost - acorns} more acorns.`;
        card.btn.onclick = () => {
          if (!game.buyShopEntry(i)) return;
          showRoomEvent(event);
        };
      });
      const rerollCost = game.shopRerollPrice();
      eventLeave.textContent = `Move on  ·  Reroll ${rerollCost}`;
      eventLeave.onclick = () => {
        if (acorns >= rerollCost && game.rerollShopStock()) {
          showRoomEvent(event);
          return;
        }
        game.leaveRoom();
        finishRewardFlow();
      };
      relayout();
      mode = "room";
      syncClickCapture();
      return;
    }

    if (event.kind === "chaos") {
      const gate = game.chaosOffer();
      eventText.textContent = gate
        ? `${gate.curse.blurb}`
        : "The air here is wrong, but nothing answers.";
      hide();
      if (gate) {
        const card = eventCards[0];
        card.btn.classList.remove("hidden");
        card.btn.className = "battle-boon-card door-chaos";
        card.tag.textContent = "ACCEPT THE CURSE";
        card.name.replaceChildren(document.createTextNode(gate.curse.name));
        card.desc.textContent = gate.curse.rewardBlurb;
        card.btn.disabled = false;
        card.btn.onclick = () => {
          game.acceptChaos();
          finishRewardFlow();
        };
      }
      eventLeave.textContent = "Walk away";
      relayout();
      mode = "room";
      syncClickCapture();
      return;
    }

    if (event.kind === "shrine") {
      const held = game.heldBoons();
      eventText.textContent = held.length
        ? "Deepen what you already carry."
        : "You carry nothing for the shrine to deepen.";
      hide();
      held.slice(0, 4).forEach((inst, i) => {
        const def = BOON_DEFS_BY_ID[inst.id];
        const card = eventCards[i];
        if (!def) return;
        card.btn.classList.remove("hidden");
        card.btn.className = `battle-boon-card rarity-border-${inst.rarity}`;
        card.tag.textContent = `RANK ${inst.rank} → ${inst.rank + 1}`;
        card.name.replaceChildren(boonIcon(def.id, "battle-boon-card-icon"), document.createTextNode(def.name));
        card.desc.textContent = describeBoon(def, { rarity: inst.rarity, rank: inst.rank + 1 });
        card.btn.disabled = inst.rank >= def.maxRank;
        card.btn.title = inst.rank >= def.maxRank ? "Already at its deepest." : "";
        card.btn.onclick = () => {
          game.shrineRankUp(inst.id);
          finishRewardFlow();
        };
      });
      relayout();
      mode = "room";
      syncClickCapture();
      return;
    }

    // Fountain and chest: a single act, no decision to make.
    hide();
    eventText.textContent =
      event.kind === "fountain"
        ? "Cold water, and a moment to breathe."
        : "Something was left here for whoever made it this far.";
    eventLeave.textContent = event.kind === "fountain" ? "Drink and move on" : "Take it";
    eventLeave.onclick = () => {
      game.resolveSimpleRoom();
      finishRewardFlow();
    };
    relayout();
    mode = "room";
    syncClickCapture();
  }

  function finishRewardFlow(): void {
    // A live, undecided fight outranks everything — this is the case the
    // separate resume ladder in tick() used to own, folded in here so there is
    // exactly one statement of the priority order to keep correct.
    const live = game.save.adventure?.battle;
    if (live && !live.outcome) {
      enterFreshBattleBeat();
      return;
    }
    const revival = game.revivalOffer();
    if (revival) {
      showRevivalOffer(revival);
      return;
    }
    const boonOffer = game.boonOffer();
    if (boonOffer) {
      showBoonOffer(boonOffer);
      return;
    }
    const chest = game.pendingChestReveal();
    if (chest) {
      showChestReveal(chest);
      return;
    }
    const roomEvent = game.pendingRoomEvent();
    if (roomEvent) {
      showRoomEvent(roomEvent);
      return;
    }
    // A Depth boss just fell and the run continues: the one moment worth
    // stopping for, because it is the only place a toll is charged and the only
    // place banking out is a genuinely live option.
    if (game.depthCleared()) {
      showDepthCleared();
      return;
    }
    const exits = game.exitOffer();
    if (exits) {
      showDoors(exits);
      return;
    }
    showOnly(box);
    // Deliberately "done", not "idle" — "idle" is syncModeFromGameState's
    // transient "no living actor yet, keep polling" wait state mid-fight
    // and would immediately re-trigger showOutcome every frame here
    // (battle.outcome is still true). "done" is inert: nothing left to do
    // but exit the battle view — reached only once the run has genuinely
    // ended, never for an intermediate room clear.
    mode = "done";
    hideBubbles();
    textEl.textContent = "";
    syncClickCapture();
  }

  /** A bubble click: submits straight into Game.submitTurnAction, which now
   * ALWAYS opens the sweep-the-bar timing check itself for attack/defend
   * (see Game.beginBattleTiming) — this only needs to gate against a stale
   * click (wrong mode, or the current actor changed under it) and hide the
   * bubbles immediately so a second click can't double-submit while the
   * check/animation plays out. syncModeFromGameState (called every tick)
   * picks the result up on its own — no explicit "wait for the result"
   * step needed here. */
  function submitAction(action: "attack" | "defend" | "ability"): void {
    if (mode !== "bubbles" || !currentActor) return;
    if (action === "ability" && !game.battleCanAbility(currentActor)) return;
    hideBubbles();
    // Only "attack" needs a target — the player's explicit pick (see the
    // enemy row list/selectEnemyTarget above), or undefined to let the
    // engine fall back to its own lowest-index-living-enemy default (the
    // single-enemy case never needs a pick at all).
    const targetEnemyId = action === "attack" ? (selectedTargetEnemyId ?? undefined) : undefined;
    game.submitTurnAction(currentActor, action, targetEnemyId);
    syncModeFromGameState();
  }

  // The rest of #battle's children (.battle-top/.battle-stage-info/
  // .battle-party) are `pointer-events: none` in CSS, so by default clicks
  // over them fall straight through to the canvas underneath (which is
  // exactly what an Attack/Defend timing check needs — see
  // handleBattleClick/gradeSkillCheck in scene/game.ts). #battle itself
  // also starts `pointer-events: none` for the same reason; .battle-bubbles
  // and .battle-box both carry their own unconditional `pointer-events:
  // auto` in CSS so their own buttons/clicks always work regardless of this
  // toggle. We only flip #battle to `auto` while the outcome recap is
  // showing WITH a reward screen waiting behind it (click-anywhere-to-
  // continue) — that's the one remaining "click the background to advance"
  // affordance left, now that per-turn narration is gone.
  function syncClickCapture(): void {
    const outcomeHasReward =
      mode === "outcome" && (!!game.revivalOffer() || !!game.boonOffer() || !!game.pendingChestReveal());
    overlay.style.pointerEvents = outcomeHasReward ? "auto" : "";
  }
  overlay.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (mode === "outcome" && (game.revivalOffer() || game.boonOffer() || game.pendingChestReveal())) {
      // Click-to-continue into whatever reward screen is pending — revival
      // (win-case downed member OR loss-case full wipe, see
      // Game.revivalOffer), then boon, then chest. A loss with nobody left
      // to offer a revive to (not actually reachable — see
      // Game.finalizeBattleOutcome's loss branch) has nothing pending here
      // and stays a dead end, same as before this feature — exit via the
      // battle-exit button.
      finishRewardFlow();
    }
  });

  /** Row click handler for the multi-enemy target list — a no-op unless
   * the bubbles are actually up with more than one enemy still alive
   * (nothing to choose with 0 or 1 living enemy — the engine's own default
   * already handles those cases, see resolvePartyTurn). */
  function selectEnemyTarget(id: string): void {
    if (mode !== "bubbles") return;
    const battle = game.battleSnapshot();
    if (!battle) return;
    const unit = battle.enemies.find((u) => u.id === id);
    if (!unit || unit.hp <= 0) return;
    if (battle.enemies.filter((u) => u.hp > 0).length <= 1) return;
    selectedTargetEnemyId = id;
    syncEnemyRows(battle);
  }

  /** Per-enemy name + HP-bar row list — mirrors syncPartyRows' persistent-
   * DOM/diff-in-place pattern exactly (rows rebuilt only when the id set
   * itself changes, text/classes updated in place every other tick).
   * Additionally toggles "targetable" (clickable, only true at the menu
   * with 2+ enemies still living) and "targeted" (the row that would
   * actually get hit if Attack were pressed right now — either the
   * player's explicit pick, or the engine's own lowest-index-living-enemy
   * default when nothing's been picked) so the highlighted row always
   * matches what submit("attack") is about to send. */
  function syncEnemyRows(battle: BattleSnapshot): void {
    // Composite key (id + characterId), not id alone: EnemyUnit.id is
    // reassigned fresh by array position on every startBattle() call (see
    // battle.ts), so two DIFFERENT battles with the same enemy headcount
    // produce the exact same id set ("enemy-0", "enemy-1", ...) — e.g.
    // stages 3, 4, and 5 are each a single enemy, all just "enemy-0". Id
    // alone can't tell "still the same ongoing fight" from "a brand new
    // fight that happens to have the same headcount", so a same-count stage
    // transition mid-run left the OLD stage's name/HP-bar rows in place
    // showing a defeated enemy's name for the new one. Folding in
    // characterId (stable per real enemy, freshly rolled per battle) makes
    // any genuinely new fight force a full rebuild, while repeated
    // per-frame calls within one ongoing fight still skip it.
    const keys = battle.enemies.map((u) => `${u.id}:${u.spec.characterId}`);
    const changed = keys.length !== enemyRowOrder.length || keys.some((k, i) => k !== enemyRowOrder[i]);
    if (changed) {
      enemyWrap.replaceChildren();
      enemyRows.clear();
      enemyRowOrder = keys;
      for (const unit of battle.enemies) {
        const row = document.createElement("div");
        row.className = "battle-enemy-row";
        const label = document.createElement("span");
        label.className = "battle-enemy-name";
        label.textContent = unit.spec.name;
        const bar = document.createElement("div");
        bar.className = "hp-bar";
        const fill = document.createElement("div");
        fill.className = "hp-bar-fill";
        const hp = document.createElement("span");
        hp.className = "battle-plate-hp";
        bar.append(fill);
        row.append(label, bar, hp);
        row.addEventListener("click", () => selectEnemyTarget(unit.id));
        enemyWrap.append(row);
        enemyRows.set(unit.id, { row, label, fill, hp });
      }
    }
    const livingCount = battle.enemies.filter((u) => u.hp > 0).length;
    const firstLivingId = battle.enemies.find((u) => u.hp > 0)?.id;
    for (const unit of battle.enemies) {
      const entry = enemyRows.get(unit.id);
      if (!entry) continue;
      const pct = unit.spec.hp > 0 ? Math.max(0, Math.round((100 * unit.hp) / unit.spec.hp)) : 0;
      entry.fill.style.width = `${pct}%`;
      // Raw current/max, abbreviated — a bare percentage-width bar can't
      // tell a 40-HP chip off a 4000-HP one, and later worlds run into the
      // thousands. abbrev() is the same shortener the resource readouts use.
      entry.hp.textContent = `${abbrev(Math.max(0, unit.hp))}/${abbrev(unit.spec.hp)}`;
      const hpState = hpBarClass(pct);
      entry.fill.classList.toggle("low", hpState === "low");
      entry.fill.classList.toggle("critical", hpState === "critical");
      entry.row.classList.toggle("defeated", unit.hp <= 0);
      const targetable = mode === "bubbles" && livingCount > 1 && unit.hp > 0;
      entry.row.classList.toggle("targetable", targetable);
      const isImplicitDefault = !selectedTargetEnemyId && unit.id === firstLivingId;
      entry.row.classList.toggle(
        "targeted",
        livingCount > 1 && unit.hp > 0 && (selectedTargetEnemyId === unit.id || isImplicitDefault),
      );
    }
  }

  function syncPartyRows(battle: BattleSnapshot): void {
    const ids = game.save.adventure?.partyIds ?? battle.turnOrder;
    const changed = ids.length !== partyRowOrder.length || ids.some((id, i) => id !== partyRowOrder[i]);
    if (changed) {
      partyWrap.replaceChildren();
      partyRows.clear();
      partyRowOrder = [...ids];
      for (const id of ids) {
        const member = game.save.team.find((m) => m.id === id);
        if (!member) continue;
        const def = WORKER_DEFS_BY_ID[member.defId];
        const row = document.createElement("div");
        row.className = "battle-party-row";
        const label = document.createElement("span");
        label.className = `rarity-${def?.rarity ?? "common"}`;
        label.textContent = def?.name ?? member.defId;
        // Class marker (Bruiser/Warden/Scout): the same pixel icon as the
        // Team panel's tag (see scene/ui-icons.ts CLASS_ICON), tooltip
        // carries the details so the compact row stays one line.
        const cls = def?.class ?? "bruiser";
        const clsInfo = WORKER_CLASS_INFO[cls];
        label.title = `${clsInfo.name}: ${clsInfo.blurb}`;
        const clsTag = pixelIcon(CLASS_ICON[cls], { palette: UI_PALETTE, className: "battle-class-tag" });
        clsTag.title = label.title;
        label.append(clsTag);
        const bar = document.createElement("div");
        bar.className = "hp-bar";
        const fill = document.createElement("div");
        fill.className = "hp-bar-fill";
        const hp = document.createElement("span");
        hp.className = "battle-plate-hp";
        bar.append(fill);
        row.append(label, bar, hp);
        partyWrap.append(row);
        partyRows.set(id, { row, label, fill, hp });
      }
    }
    const currentActorId = game.currentBattleActorId();
    for (const id of partyRowOrder) {
      const entry = partyRows.get(id);
      const member = game.save.team.find((m) => m.id === id);
      if (!entry || !member) continue;
      const pct = member.maxHp > 0 ? Math.max(0, Math.round((100 * member.currentHp) / member.maxHp)) : 0;
      entry.fill.style.width = `${pct}%`;
      entry.hp.textContent = `${abbrev(Math.max(0, member.currentHp))}/${abbrev(member.maxHp)}`;
      entry.row.classList.toggle("defeated", member.currentHp <= 0);
      const hpState = hpBarClass(pct);
      entry.fill.classList.toggle("low", hpState === "low");
      entry.fill.classList.toggle("critical", hpState === "critical");
      entry.row.classList.toggle("active", currentActorId === id);
    }
  }

  /** Compact "active boons" row, shown once at least one has been picked
   * this run — abbreviated to icon + name + stack count. Rebuilt from
   * scratch each sync: the list is short (at most 6 distinct boons) and
   * only changes on a pick, so there's no meaningful cost to not diffing
   * it. */
  /** The active-build tray.
   *
   * DIFFED, not rebuilt. The previous version called replaceChildren on every
   * 30ms tick, which was safe only because the chips were inert — the moment
   * anything here becomes clickable, rebuilding under the pointer swallows the
   * click, which is the exact bug this file's header documents. Keying on the
   * build's shape means the DOM is touched only when the build actually
   * changes. */
  let boonsHudKey = "";
  function syncBoonsHud(): void {
    const held = game.heldBoons();
    const key = held.map((h) => `${h.id}:${h.rarity}:${h.rank}`).join("|");
    boonsHud.classList.toggle("hidden", held.length === 0);
    if (key === boonsHudKey) return;
    boonsHudKey = key;
    if (held.length === 0) {
      boonsHud.replaceChildren();
      return;
    }
    boonsHud.replaceChildren(
      ...held.map((inst) => {
        const def = BOON_DEFS_BY_ID[inst.id];
        const chip = document.createElement("span");
        chip.className = `battle-boon-chip rarity-border-${inst.rarity}`;
        chip.title = def ? `${def.name} — ${describeBoon(def, inst)}` : inst.id;
        if (def) chip.append(boonIcon(def.id, "battle-boon-chip-icon"));
        const label = document.createElement("span");
        label.textContent = inst.rank > 1 ? `${def?.name ?? inst.id} ${inst.rank}` : (def?.name ?? inst.id);
        chip.append(label);
        return chip;
      }),
    );
  }

  // Game fires this whenever a run beat resolves on its side — entering a
  // non-combat room, say. The dispatcher then re-derives what should be on
  // screen. Push rather than poll: the 30ms tick exists to keep the HUD in
  // sync, not to discover state changes.
  game.onRunBeatResolved = () => {
    if (game.isBattleViewOpen()) finishRewardFlow();
  };

  function tick(): void {
    const isOpen = game.isBattleViewOpen();
    if (isOpen !== wasOpen) {
      wasOpen = isOpen;
      if (isOpen) {
        closeOtherOverlays("battle");
        // ONE priority ladder, in finishRewardFlow. This branch used to carry a
        // hand-maintained second copy of it, with three comments explaining why
        // each check sat where it did — which was already fragile at four
        // beats, and would not have survived the six the room graph needs. The
        // dispatcher re-derives everything from the save on every call, so it
        // is exactly as correct on a cold resume as it is mid-run; the only
        // case it did not previously cover (a live, undecided fight) is now its
        // first branch.
        const battle = game.battleSnapshot();
        if (!game.save.adventure && battle?.outcome) {
          // The run is over and this is the closing recap — not a pending
          // decision, so it sits outside the ladder.
          showOutcome(battle);
        } else {
          finishRewardFlow();
        }
      }
    }
    syncClickCapture();
    overlay.classList.toggle("hidden", !isOpen);
    if (!isOpen) return;

    const adv = game.save.adventure;
    syncBoonsHud();

    if (ledgerOpen) {
      if (game.save.adventure) {
        ledger.update(game.runStats(), game.battleSnapshot() ?? undefined);
      } else {
        ledgerOpen = false;
        ledger.el.classList.add("hidden");
        ledgerBtn.classList.remove("active");
      }
    }
    ledgerBtn.classList.toggle("hidden", !game.save.adventure);

    const battle = game.battleSnapshot();
    if (battle) {
      syncEnemyRows(battle);
      round.textContent = `Round ${battle.round}`;
      syncPartyRows(battle);
      positionPlates();
      if (mode === "bubbles") positionBubbles();
    }
    // Read off the run rather than off the live BattleSnapshot, so this stays
    // accurate even when there is no fight at all — a door screen, a stall, or
    // an offer resumed after an app restart.
    stageInfo.textContent = adv
      ? `${DEPTH_NAMES[depthOf(adv.roomsCleared)]} · Room ${Math.min(TOTAL_ROOMS, adv.roomsCleared + 1)}/${TOTAL_ROOMS} · ` +
        `${abbrev(adv.acorns)} acorns · ${abbrev(adv.pendingWood)} wood`
      : "";

    // Revival/boon/chest/cleared/done screens are entirely click/button-
    // driven by their own handlers (see showRevivalOffer/showBoonOffer/
    // showChestReveal/showStageCleared) — none of them need per-frame logic,
    // and "outcome" only needs syncClickCapture (already called above) to
    // keep working. Everything else (bubbles up / a timing check live /
    // animations still playing) is exactly what syncModeFromGameState
    // already re-derives fresh every tick.
    if (REWARD_MODES.has(mode)) return;
    syncModeFromGameState();
  }

  registerOverlay("battle", () => game.closeBattleView());
  window.setInterval(tick, TICK_MS);

  // 1-4 hotkeys for the floating bubbles — matches the number badge printed
  // on each one. Only live while the bubbles are actually up and clickable;
  // a stray keypress during a timing check, a reward screen, or with the
  // battle view closed entirely is just ignored.
  const HOTKEY_ACTION: Record<string, BattleAction | "retreat"> = {
    "1": "attack",
    "2": "defend",
    "3": "ability",
    "4": "retreat",
  };
  window.addEventListener("keydown", (e) => {
    if (mode !== "bubbles" || !game.isBattleViewOpen()) return;
    const action = HOTKEY_ACTION[e.key];
    if (!action) return;
    e.preventDefault();
    if (action === "retreat") game.retreatAdventure();
    else submitAction(action);
  });
}
