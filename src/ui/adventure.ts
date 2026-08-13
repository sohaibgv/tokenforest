// Adventure overlay: Muster (party select + embark) and In-the-Field
// (push on / resume / retreat) screens. Lives in its own #adventure
// div/button — a distinct mode from the shop, not a shop tab — but mirrors
// shop.ts's plain-DOM row/overlay conventions. All mutation routes through
// Game methods, which own the save. The actual turn-based fight (Attack/
// Defend/Ability) happens in the separate full-window battle view (see
// ui/battle.ts, Game.beginStageBattle/openBattleView) — this overlay only
// gets the player as far as "start" or "resume" a stage's fight.
//
// Every DOM node here is built ONCE at init; the periodic refresh only ever
// mutates text/classes/disabled state afterward (or rebuilds a small
// sub-list when its underlying identity actually changes, e.g. the roster
// gaining a member) — nothing is torn down and rebuilt wholesale on a
// timer, which is what used to let clicks get silently eaten (a button
// removed mid-click never receives its click event). Same fix already
// applied to ui/battle.ts; this brings this overlay in line with it.

import { BOON_DEFS, describeBoon } from "../run/boons";
import { CHARM_DEFS, CURSE_DEFS } from "../run/charms";
import { groveRank, grovePayoutMult, PACT_DEFS, type PactId } from "../run/pact";
import { PATRON_DEFS, PATRON_DEFS_BY_ID, type PatronId } from "../run/patrons";
import { DEPTH_NAMES, doorLabel, TOTAL_ROOMS } from "../run/rooms";
import { getWorld, PROVISIONS, WORKER_DEFS_BY_ID, type ProvisionId } from "../economy";
import { abbrev, hpBarClass } from "../scene/floating-text";
import type { Game } from "../scene/game";
import type { WorkerRarity } from "../scene/sprites";
import { effectiveAtk, equippedItem, type Rarity, type TeamMemberSave } from "../team";
import { closeOtherOverlays, registerOverlay } from "./overlay-coordinator";
import { pixelIconComposite } from "./pixel-icon";
import { PORTRAIT_H, PORTRAIT_W, requestSelectMember, workerPortraitDraw } from "./team";

const MAX_CARRIED = 2;

/** The 3 formation slots, in the FIXED order that becomes battle turn order
 * on embark (see EMBARK_ORDER below) — front acts first, then the two back
 * slots. This is deliberate now: the old checkbox-list muster derived
 * `partyIds` purely from click order (a Set's insertion order), which
 * silently decided turn order/battle-canvas stacking as a side effect no
 * player could see or control (see battlePartySlot/renderBattle in
 * scene/game.ts, unchanged by this file). The formation UI below makes that
 * choice explicit and visual instead. */
type SlotKey = "front" | "backLeft" | "backRight";
const EMBARK_ORDER: SlotKey[] = ["front", "backLeft", "backRight"];
const SLOT_LABEL: Record<SlotKey, string> = { front: "Front", backLeft: "Back Left", backRight: "Back Right" };

/** Same composited body+weapon portrait art the Team roster/detail panels
 * use (team.ts's memberPortrait) — reuses the exact exported drawing
 * primitive (workerPortraitDraw) and the shared cached-<img> pipeline
 * (pixelIconComposite) rather than re-deriving sprite compositing here.
 * team.ts's own memberPortrait wrapper isn't exported (it's a private
 * caching convenience local to that file), so this is that same one-line
 * wrapper, not a divergent copy of the compositing logic itself. */
function formationPortrait(
  rarity: WorkerRarity,
  workerPalette: Record<string, string> | null,
  weaponRarity: Rarity,
  weaponPalette: Record<string, string> | null,
  scale: number,
  className: string,
): HTMLImageElement {
  const { key, draw } = workerPortraitDraw(rarity, workerPalette, weaponRarity, weaponPalette);
  return pixelIconComposite(key, PORTRAIT_W, PORTRAIT_H, draw, { scale, className });
}

/** Brief "that worked" confirmation — this overlay's DOM is built once and
 * only ever mutated in place (see file header), so unlike team.ts/shop.ts
 * there's no re-render to lose the flash target between click and paint. */
function flash(el: HTMLElement): void {
  el.classList.remove("flash-pulse");
  void el.offsetWidth; // restart the animation from scratch
  el.classList.add("flash-pulse");
}

/** Whether the Muster/Field overlay is on screen.
 *
 * Read from the DOM rather than from a closure flag, matching isShopOpen — the
 * overlay coordinator can close this panel without going through `close()`, so
 * a cached boolean would drift out of sync with what is actually visible. */
/** Everything the Fated List tracks, in a stable order: boons grouped by
 * patron, then charms, then curses. Built once — the catalog never changes at
 * runtime, and rebuilding it per render would be pure waste on a screen that
 * re-renders on every click. */
interface CodexEntry {
  id: string;
  name: string;
  group: string;
  blurb: string;
}
const CODEX_ENTRIES: CodexEntry[] = [
  ...BOON_DEFS.map((d) => ({
    id: d.id,
    name: d.name,
    group: `${PATRON_DEFS_BY_ID[d.patron].name} boon`,
    blurb: describeBoon(d, { rarity: "common" as const, rank: 1 }),
  })),
  ...CHARM_DEFS.map((c) => ({ id: c.id, name: c.name, group: "Charm", blurb: c.blurb })),
  ...CURSE_DEFS.map((c) => ({ id: c.id, name: c.name, group: "Curse", blurb: c.blurb })),
];
const CODEX_TOTAL = CODEX_ENTRIES.length;
function codexEntries(): CodexEntry[] {
  return CODEX_ENTRIES;
}

export function isAdventureOpen(): boolean {
  return !document.getElementById("adventure")?.classList.contains("hidden");
}

export function initAdventure(game: Game): void {
  const overlay = document.getElementById("adventure")!;
  const openBtn = document.getElementById("adventure-btn")!;
  const closeBtn = document.getElementById("adventure-close")!;
  const bodyEl = document.getElementById("adventure-body")!;
  bodyEl.replaceChildren();

  let selectedWorld = game.save.worldIndex;
  // Formation state — replaces the old `selectedParty: Set<string>` (whose
  // insertion order silently became battle turn order). Null = empty slot.
  const formation: Record<SlotKey, string | null> = { front: null, backLeft: null, backRight: null };
  // Which slot the NEXT click in the bottom roster tray (see trayWrap below)
  // will assign into — at most one at a time. Formerly `openPicker`, which
  // tracked which slot's inline dropdown was open; that per-slot dropdown
  // is gone (superseded by the persistent tray), so this now just marks a
  // "targeted" slot for highlighting/assignment instead of an open/closed
  // UI element.
  let targetSlot: SlotKey | null = null;
  const selectedCarry = new Set<ProvisionId>();
  let selectedKeepsake: PatronId | null = null;
  let codexOpen = false;
  let refreshTimer: number | null = null;

  /** `partyIds` in embark order (front, then back-left, then back-right) —
   * the single source of truth for both the win/cost preview and the
   * embark call itself, so they can never disagree about who's mustered. */
  function currentPartyIds(): string[] {
    return EMBARK_ORDER.map((k) => formation[k]).filter((id): id is string => id !== null);
  }

  // --- Muster screen: persistent DOM, built once --------------------------
  const musterEl = document.createElement("div");
  musterEl.className = "adv-muster";

  // The destination, stated rather than chosen.
  //
  // This was a row of buttons, one per unlocked world, each labelled with its
  // wood multiplier. It put a decision on the player that the screen gave
  // them nothing to decide it WITH: the multiplier says what a world pays,
  // never whether this party can survive it, and the only other number
  // present was a stage-1 win% that stays high in worlds that are hopeless
  // four rooms in. In practice there was one right answer anyway — the
  // current world, since lower ones pay strictly less for the same fight —
  // so the row's real function was to let players accidentally farm a world
  // beneath them, or to sit unused.
  //
  // Now the run goes where the player already is, and the screen spends that
  // space answering the question the buttons couldn't: a red/amber/green
  // readiness verdict from previewWorldReadiness, and — when the verdict is
  // red — which world to drop back to instead.
  const worldCard = document.createElement("div");
  worldCard.className = "adv-world-card";
  const worldTitle = document.createElement("div");
  worldTitle.className = "adv-world-name";
  const verdictEl = document.createElement("div");
  verdictEl.className = "adv-verdict";
  const verdictDot = document.createElement("span");
  verdictDot.className = "adv-verdict-dot";
  const verdictText = document.createElement("span");
  verdictText.className = "adv-verdict-text";
  verdictEl.append(verdictDot, verdictText);
  const verdictHint = document.createElement("div");
  verdictHint.className = "adv-verdict-hint";
  worldCard.append(worldTitle, verdictEl, verdictHint);
  musterEl.append(worldCard);

  const rosterEmpty = document.createElement("div");
  rosterEmpty.className = "shop-sub";
  rosterEmpty.textContent = "no team members yet — pull the Worker Gacha first";
  musterEl.append(rosterEmpty);

  // --- Formation: a campsite clearing at night, 3 workers seated on logs
  // around a fire — built once and mutated in place (see file header). This
  // IS the party picker, not just a display: drag a roster member from the
  // tray onto a log to seat them, drag a seated worker onto another log to
  // swap seats (see assignToSlot below), or fall back to the older
  // click-to-target/click-tray-card flow (still fully wired, just no longer
  // the primary affordance). A small always-visible "×" clears a seat
  // directly and a "🎒" opens that worker's backpack (equip gear) — see
  // openBackpack — no targeting required for either.
  const formationWrap = document.createElement("div");
  formationWrap.className = "adv-formation";
  // Purely decorative — logs + a flickering flame, CSS-only (no image
  // assets, matching the rest of the app's synthesized-not-drawn ethos for
  // ambient effects). A REAL flex sibling between the back and front rows
  // (not an absolutely-positioned guess at "the empty space") — it was
  // originally guessed-positioned and ended up hidden entirely behind the
  // front seat's own log (headless-verified: the glow peeked out at the
  // edges, the flame itself never did). Sitting in the actual layout gap
  // between the two rows guarantees it's never occluded by either seat,
  // regardless of window size.
  const campfire = document.createElement("div");
  campfire.className = "adv-campfire";
  const campfireGlow = document.createElement("div");
  campfireGlow.className = "adv-campfire-glow";
  const campfireLogs = document.createElement("div");
  campfireLogs.className = "adv-campfire-logs";
  const flame1 = document.createElement("div");
  flame1.className = "adv-campfire-flame adv-campfire-flame-1";
  const flame2 = document.createElement("div");
  flame2.className = "adv-campfire-flame adv-campfire-flame-2";
  campfire.append(campfireGlow, campfireLogs, flame1, flame2);
  const backRow = document.createElement("div");
  backRow.className = "adv-formation-back";
  const frontRow = document.createElement("div");
  frontRow.className = "adv-formation-front";
  formationWrap.append(backRow, campfire, frontRow);
  musterEl.append(formationWrap);

  // Drag payload key for both directions of drag (tray -> slot, slot ->
  // slot) — a plain memberId string is all either side needs; the drop
  // handler below figures out "is this member already seated somewhere
  // else" itself by scanning `formation`; it doesn't need to know the drag
  // ORIGIN. Custom MIME type (not "text/plain") so a drag originating
  // outside this app can never accidentally look like a valid drop.
  const DRAG_MIME = "application/x-tf-member";

  /** Opens the roster member's equipment in the Team panel — the
   * "backpack" resting beside them at the campfire. Reuses the existing,
   * fully-built Team panel wholesale (requestSelectMember, team.ts) rather
   * than duplicating an equip picker inline here; closes this overlay and
   * simulates the same two clicks a player would make by hand (Shop button,
   * then the Team tab, in case a different tab was last open). */
  function openBackpack(memberId: string): void {
    requestSelectMember(memberId);
    close();
    document.getElementById("shop-btn")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.querySelector<HTMLButtonElement>('#shop-tabs button[data-tab="team"]')?.click();
  }

  /** Moves `memberId` into `target`, swapping with whoever's already there
   * if the member being displaced came from another slot (a genuine
   * campfire-seat swap), or simply bumping them back to the bench if the
   * member arrived from the roster tray instead (nothing to swap them
   * INTO). Shared by both the drag-drop handler below and the existing
   * click-to-target/click-tray-card flow, which now calls this too instead
   * of duplicating the "clear the member's old slot first" guard. */
  function assignToSlot(memberId: string, target: SlotKey): void {
    let fromSlot: SlotKey | null = null;
    for (const k of EMBARK_ORDER) {
      if (formation[k] === memberId) fromSlot = k;
    }
    const displaced = formation[target];
    formation[target] = memberId;
    // A slot-to-slot drag swaps: whoever WAS at `target` takes the dragged
    // member's old spot, a real seat exchange. A drag from the roster tray
    // (fromSlot null) instead just bumps `displaced` back to the bench —
    // there's no "old spot" of the dragged member's to send them to.
    if (fromSlot && fromSlot !== target) formation[fromSlot] = displaced;
  }

  interface SlotDom {
    root: HTMLElement;
    face: HTMLElement;
    portraitWrap: HTMLElement;
    nameEl: HTMLElement;
    portraitKey: string | null;
  }
  const slotDom = new Map<SlotKey, SlotDom>();
  for (const key of (["backLeft", "backRight", "front"] as SlotKey[])) {
    const root = document.createElement("div");
    root.className = `adv-slot adv-slot-${key}`;

    const face = document.createElement("div");
    face.className = "adv-slot-face";
    const portraitWrap = document.createElement("div");
    portraitWrap.className = "adv-slot-portrait";
    face.append(portraitWrap);
    const nameEl = document.createElement("div");
    nameEl.className = "adv-slot-name";
    nameEl.textContent = SLOT_LABEL[key];
    face.append(nameEl);

    // Always-visible remove badge — CSS-gated to only show once the slot is
    // filled (.adv-slot.filled .adv-slot-remove, see styles.css), so
    // clearing a slot never requires targeting/opening anything first. This
    // is the exact same clear logic the old dropdown's buried "Clear slot"
    // row used, just given a real, un-buried affordance.
    const removeBtn = document.createElement("button");
    removeBtn.className = "adv-slot-remove";
    removeBtn.textContent = "×";
    removeBtn.title = "Remove from formation";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      formation[key] = null;
      renderMuster();
    });
    face.append(removeBtn);

    // Backpack shortcut — CSS-gated to only show once filled, same as the
    // remove badge above, opposite corner. "Click a worker to open their
    // backpack" (see openBackpack).
    const backpackBtn = document.createElement("button");
    backpackBtn.className = "adv-slot-backpack";
    backpackBtn.textContent = "🎒";
    backpackBtn.title = "Open backpack (equip gear)";
    backpackBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const memberId = formation[key];
      if (memberId) openBackpack(memberId);
    });
    face.append(backpackBtn);

    face.addEventListener("click", () => {
      targetSlot = targetSlot === key ? null : key;
      renderMuster();
    });

    // Drag a seated worker to another log to swap seats. Only filled slots
    // are draggable (see renderSlot's `face.draggable` toggle below) — an
    // empty seat has nothing to pick up.
    face.addEventListener("dragstart", (e) => {
      const memberId = formation[key];
      if (!memberId || !e.dataTransfer) return;
      e.dataTransfer.setData(DRAG_MIME, memberId);
      e.dataTransfer.effectAllowed = "move";
      root.classList.add("dragging");
    });
    face.addEventListener("dragend", () => root.classList.remove("dragging"));
    face.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      face.classList.add("drag-over");
    });
    face.addEventListener("dragleave", () => face.classList.remove("drag-over"));
    face.addEventListener("drop", (e) => {
      e.preventDefault();
      face.classList.remove("drag-over");
      const memberId = e.dataTransfer?.getData(DRAG_MIME);
      if (!memberId) return;
      assignToSlot(memberId, key);
      targetSlot = null;
      renderMuster();
    });

    root.append(face);

    (key === "front" ? frontRow : backRow).append(root);
    slotDom.set(key, { root, face, portraitWrap, nameEl, portraitKey: null });
  }

  // Inline Trail Rations shortcut — this screen is arguably the more
  // natural place a player discovers they're short a party member (roster
  // rows go greyed-out/unselectable while resting) than Shop → Provisions.
  const healBtn = document.createElement("button");
  healBtn.classList.add("btn-primary");
  healBtn.addEventListener("click", () => {
    game.useTrailRations();
    renderMuster();
    flash(healBtn);
  });
  musterEl.append(healBtn);

  const carryWrap = document.createElement("div");
  carryWrap.className = "adv-carry";
  const carryBtns = new Map<ProvisionId, HTMLButtonElement>();
  for (const prov of PROVISIONS) {
    if (prov.instant) continue;
    const btn = document.createElement("button");
    btn.addEventListener("click", () => {
      if (selectedCarry.has(prov.id)) selectedCarry.delete(prov.id);
      else selectedCarry.add(prov.id);
      renderMuster();
    });
    carryBtns.set(prov.id, btn);
    carryWrap.append(btn);
  }
  musterEl.append(carryWrap);

  // --- keepsake rack ------------------------------------------------------
  //
  // The one sanctioned thumb on the scale, and the only place a build can be
  // steered BEFORE the run rather than by whatever the draws allow: the chosen
  // patron is guaranteed the first card of every offer.
  //
  // Earned rather than given — a patron only appears here once its favour has
  // been raised by actually clearing Depths with its boons. That is the whole
  // between-runs loop in one control: commit to a patron, clear with it, and
  // next time you can commit deliberately from room one.
  const keepsakeWrap = document.createElement("div");
  keepsakeWrap.className = "adv-keepsakes";
  const keepsakeBtns = new Map<PatronId, HTMLButtonElement>();
  for (const patron of PATRON_DEFS) {
    const btn = document.createElement("button");
    btn.className = "adv-keepsake";
    btn.addEventListener("click", () => {
      selectedKeepsake = selectedKeepsake === patron.id ? null : patron.id;
      renderMuster();
    });
    keepsakeBtns.set(patron.id, btn);
    keepsakeWrap.append(btn);
  }
  musterEl.append(keepsakeWrap);

  // --- Pact of the Grove --------------------------------------------------
  //
  // Opt-in difficulty, and the reason the mode still has something to offer
  // once it has been beaten. Each modifier says exactly what it does and
  // exactly what it is worth, and the payout multiplier is shown live as they
  // are toggled — a player has to be able to price the risk BEFORE taking it,
  // or it is not a wager, it is just a harder setting.
  //
  // Hidden entirely until a first full clear: offering difficulty modifiers to
  // someone who has not yet finished a run is offering them a way to lose
  // faster.
  const pactWrap = document.createElement("div");
  pactWrap.className = "adv-pact hidden";
  const pactTitle = document.createElement("div");
  pactTitle.className = "adv-pact-title";
  const pactBtns = new Map<PactId, HTMLButtonElement>();
  const pactRow = document.createElement("div");
  pactRow.className = "adv-pact-row";
  for (const mod of PACT_DEFS) {
    const btn = document.createElement("button");
    btn.className = "adv-pact-mod";
    btn.addEventListener("click", () => {
      const s2 = game.save;
      s2.pact = s2.pact ?? [];
      s2.pact = s2.pact.includes(mod.id) ? s2.pact.filter((m) => m !== mod.id) : [...s2.pact, mod.id];
      game.persist();
      renderMuster();
    });
    pactBtns.set(mod.id, btn);
    pactRow.append(btn);
  }
  pactWrap.append(pactTitle, pactRow);
  musterEl.append(pactWrap);

  // --- the Fated List -----------------------------------------------------
  //
  // Every boon, charm and curse, greyed until it has been SEEN once. Discovery
  // is permanent and costs nothing to grant, which is the point: it turns
  // "that card I got offered in a run I lost" into a thing that stays, and it
  // gives a player who has stopped needing wood a reason to keep delving.
  //
  // Lives on the Muster screen behind a toggle rather than in its own overlay:
  // it is read between runs, which is exactly when this screen is up, and a
  // fourth top-level overlay would be a fourth thing to remember to close.
  const codexToggle = document.createElement("button");
  codexToggle.className = "adv-codex-toggle";
  codexToggle.addEventListener("click", () => {
    codexOpen = !codexOpen;
    renderMuster();
  });
  const codexWrap = document.createElement("div");
  codexWrap.className = "adv-codex hidden";
  musterEl.append(codexToggle, codexWrap);

  const previewEl = document.createElement("div");
  previewEl.className = "shop-sub";
  musterEl.append(previewEl);

  const embarkBtn = document.createElement("button");
  embarkBtn.className = "btn-primary";
  embarkBtn.textContent = "Embark";
  embarkBtn.addEventListener("click", () => {
    if (game.startAdventure(selectedWorld, currentPartyIds(), [...selectedCarry], selectedKeepsake)) {
      formation.front = null;
      formation.backLeft = null;
      formation.backRight = null;
      targetSlot = null;
      selectedCarry.clear();
      selectedKeepsake = null;
      // startAdventure already opened the battle view for stage 1 — get
      // this overlay out of the way so the fight is actually visible.
      close();
    }
  });
  musterEl.append(embarkBtn);

  // --- Bottom roster tray: replaces the old per-slot .adv-slot-picker
  // dropdown entirely. A persistent horizontal row of larger member cards
  // (portrait + name/level/rarity/status + HP bar + atk/hp line, same
  // pattern as team.ts's renderDetail) for every roster member currently
  // eligible to be assigned. Clicking a formation slot above "targets" it
  // (see targetSlot); clicking a card here assigns that member into the
  // targeted slot (or, if none is targeted, the first empty slot — see
  // trayCard's click handler below).
  const trayWrap = document.createElement("div");
  trayWrap.className = "adv-tray";
  const trayEmpty = document.createElement("div");
  trayEmpty.className = "shop-sub adv-tray-empty";
  trayEmpty.textContent = "No other available members to assign.";
  trayWrap.append(trayEmpty);
  // Inserted directly AFTER the formation (before Heal/carry/Embark), not
  // appended last: the tray IS the party picker, and at the small default
  // window heights an end-of-column tray sat entirely below the scroll
  // fold — the muster showed empty slots with no visible way to fill them
  // (headless-verified). Assignment flow now reads top-to-bottom:
  // world → slots → pick members → provisions → Embark.
  musterEl.insertBefore(trayWrap, healBtn);

  interface TrayCardDom {
    root: HTMLElement;
    portraitWrap: HTMLElement;
    portraitKey: string | null;
    rarityDot: HTMLElement;
    nameEl: HTMLElement;
    statusDot: HTMLElement;
    hpFill: HTMLElement;
    statEl: HTMLElement;
  }
  const trayCardDom = new Map<string, TrayCardDom>();
  let trayRowIds: string[] = [];

  /** Builds one tray card's DOM once (mirrors team.ts's renderDetail header/
   * portrait/hp-bar/stat-line layout at a glance-friendly compact width) and
   * registers it in trayCardDom for renderTray's in-place updates. The click
   * handler only ever reads `member.id` (stable across re-renders), so it's
   * safe even though `member` itself is a snapshot from whichever render
   * built this card. */
  function buildTrayCard(member: TeamMemberSave): HTMLElement {
    const root = document.createElement("div");
    root.className = "adv-tray-card";
    root.dataset.memberId = member.id;

    const head = document.createElement("div");
    head.className = "adv-tray-card-head";
    const rarityDot = document.createElement("span");
    rarityDot.className = "rarity-dot";
    const nameEl = document.createElement("span");
    const statusDot = document.createElement("span");
    statusDot.className = "status-dot";
    head.append(rarityDot, nameEl, statusDot);
    root.append(head);

    const portraitWrap = document.createElement("div");
    portraitWrap.className = "adv-tray-card-portrait";
    root.append(portraitWrap);

    const hpBar = document.createElement("div");
    hpBar.className = "hp-bar";
    const hpFill = document.createElement("div");
    hpFill.className = "hp-bar-fill";
    hpBar.append(hpFill);
    root.append(hpBar);

    const statEl = document.createElement("div");
    statEl.className = "shop-sub";
    root.append(statEl);

    root.addEventListener("click", () => {
      const target = targetSlot ?? EMBARK_ORDER.find((k) => formation[k] === null) ?? null;
      if (!target) return; // no slot targeted and formation already full
      assignToSlot(member.id, target);
      targetSlot = null;
      renderMuster();
    });

    // Drag straight from the bench onto a log — the primary way to seat
    // someone new now, alongside the target-then-click fallback above.
    root.draggable = true;
    root.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(DRAG_MIME, member.id);
      e.dataTransfer.effectAllowed = "move";
      root.classList.add("dragging");
    });
    root.addEventListener("dragend", () => root.classList.remove("dragging"));

    trayCardDom.set(member.id, { root, portraitWrap, portraitKey: null, rarityDot, nameEl, statusDot, hpFill, statEl });
    return root;
  }

  /** Refreshes one already-built tray card's visuals in place — same
   * portraitKey-diffing discipline as renderSlot, so the 1s refresh timer
   * doesn't rebuild a portrait `<img>` (or the whole card) unless something
   * about the member actually changed. */
  function updateTrayCard(member: TeamMemberSave, s: typeof game.save): void {
    const dom = trayCardDom.get(member.id);
    if (!dom) return;
    const def = WORKER_DEFS_BY_ID[member.defId];
    const rarity: WorkerRarity = (def?.rarity as WorkerRarity | undefined) ?? "common";

    dom.rarityDot.className = `rarity-dot rarity-${rarity}`;
    dom.nameEl.className = `rarity-${rarity}`;
    dom.nameEl.textContent = `${def?.name ?? member.defId} · Lv${member.level}`;
    dom.statusDot.className = `status-dot ${member.status}`;
    dom.statusDot.title = member.status;

    const weaponDef = equippedItem(member, "woodchopping", s.inventory);
    const weaponRarity: Rarity = weaponDef?.rarity ?? "common";
    const worldPalette = game.getWorkerPalette(s.worldIndex);
    const accent = def?.accent;
    const portraitPalette = accent ? { ...(worldPalette ?? {}), ...accent } : worldPalette;
    const weaponPalette = game.weaponPalette(s.worldIndex);
    const portraitKey = `${member.id}:${rarity}:${weaponRarity}:${JSON.stringify(portraitPalette)}:${JSON.stringify(weaponPalette)}`;
    if (dom.portraitKey !== portraitKey) {
      dom.portraitKey = portraitKey;
      dom.portraitWrap.replaceChildren(
        formationPortrait(rarity, portraitPalette, weaponRarity, weaponPalette, 5, "adv-tray-card-portrait-img"),
      );
    }

    const pct = member.maxHp > 0 ? Math.round((100 * member.currentHp) / member.maxHp) : 0;
    dom.hpFill.style.width = `${pct}%`;
    const hpState = hpBarClass(pct);
    dom.hpFill.classList.toggle("low", hpState === "low");
    dom.hpFill.classList.toggle("critical", hpState === "critical");

    dom.statEl.textContent = `atk ${abbrev(Math.round(effectiveAtk(member, s.inventory, s.prestigeLevel)))} · hp ${abbrev(member.currentHp)}/${abbrev(member.maxHp)}`;
  }

  /** Which roster members currently show in the tray: available, and not
   * already occupying one of the OTHER formation slots — same filter the
   * old per-slot picker applied, just relative to `targetSlot` instead of a
   * fixed "this slot". With no slot targeted there's no "other two" to
   * compare against, so every filled slot counts as taken — the tray then
   * shows only fully-unassigned members, until a slot is targeted (at which
   * point that slot's own current occupant reappears too, so they can be
   * swapped for someone else). */
  function renderTray(s: typeof game.save): void {
    const takenElsewhere = new Set(
      EMBARK_ORDER.filter((k) => k !== targetSlot)
        .map((k) => formation[k])
        .filter((id): id is string => id !== null),
    );
    const eligible = s.team.filter((m) => m.status === "available" && !takenElsewhere.has(m.id));
    const rowIds = eligible.map((m) => m.id);
    const changed = rowIds.length !== trayRowIds.length || rowIds.some((id, i) => id !== trayRowIds[i]);
    if (changed) {
      trayRowIds = rowIds;
      trayCardDom.clear();
      trayWrap.replaceChildren(trayEmpty, ...eligible.map((m) => buildTrayCard(m)));
    }
    trayEmpty.classList.toggle("hidden", eligible.length > 0);
    for (const m of eligible) updateTrayCard(m, s);
  }

  // --- Field screen: persistent DOM, built once ----------------------------
  const fieldEl = document.createElement("div");
  fieldEl.className = "adv-field";

  const tallyEl = document.createElement("div");
  tallyEl.className = "shop-sub";
  fieldEl.append(tallyEl);

  const partyWrap = document.createElement("div");
  partyWrap.className = "adv-roster";
  let partyRowIds: string[] = [];
  const partyRows = new Map<string, { name: HTMLElement; fill: HTMLElement }>();
  fieldEl.append(partyWrap);

  const logEl = document.createElement("div");
  logEl.className = "shop-sub";
  fieldEl.append(logEl);

  // Preview of the next stage's enemy — Push On used to be a total blind
  // commit with no idea who (or what kind of fight) is coming.
  const nextEnemyEl = document.createElement("div");
  nextEnemyEl.className = "shop-sub";
  fieldEl.append(nextEnemyEl);

  const resumeBtn = document.createElement("button");
  resumeBtn.textContent = "Resume Battle";
  resumeBtn.addEventListener("click", () => {
    game.openBattleView();
    close();
  });
  fieldEl.append(resumeBtn);

  const pushBtn = document.createElement("button");
  pushBtn.addEventListener("click", () => {
    // A run between rooms is standing at a junction. The door screen lives in
    // the battle view (it is drawn into the dungeon wall), so this just reopens
    // that view and gets out of the way rather than duplicating the choice
    // here in DOM.
    game.openBattleView();
    close();
  });
  fieldEl.append(pushBtn);

  const retreatBtn = document.createElement("button");
  retreatBtn.textContent = "Retreat & Bank";
  retreatBtn.addEventListener("click", () => {
    game.retreatAdventure();
    flash(tallyEl);
  });
  fieldEl.append(retreatBtn);

  bodyEl.append(musterEl, fieldEl);

  // --- sync helpers ---------------------------------------------------------

  /** Renders one formation slot: its portrait/placeholder + name, its
   * rarity-tinted border, and whether it's the currently-targeted slot for
   * the bottom tray's next click. Diffs before touching the DOM the same
   * way the old syncRoster did — the portrait `<img>` is only rebuilt when
   * the occupant/gear/palette actually changed — so a click landing mid-1s-
   * refresh never lands on a node that just got torn out from under it (see
   * file header). Assignment/removal itself is handled by the always-
   * visible remove badge and the bottom tray (built once, see above), not
   * by anything rebuilt here. */
  function renderSlot(key: SlotKey, s: typeof game.save): void {
    const dom = slotDom.get(key)!;
    const memberId = formation[key];
    const member = memberId ? s.team.find((m) => m.id === memberId) ?? null : null;
    const def = member ? WORKER_DEFS_BY_ID[member.defId] : null;
    const rarity: WorkerRarity = (def?.rarity as WorkerRarity | undefined) ?? "common";

    const weaponDef = member ? equippedItem(member, "woodchopping", s.inventory) : null;
    const weaponRarity: Rarity = weaponDef?.rarity ?? "common";
    const worldPalette = game.getWorkerPalette(s.worldIndex);
    const accent = def?.accent;
    const portraitPalette = accent ? { ...(worldPalette ?? {}), ...accent } : worldPalette;
    const weaponPalette = game.weaponPalette(s.worldIndex);
    const portraitKey = member
      ? `${member.id}:${rarity}:${weaponRarity}:${JSON.stringify(portraitPalette)}:${JSON.stringify(weaponPalette)}`
      : null;
    if (dom.portraitKey !== portraitKey) {
      dom.portraitKey = portraitKey;
      dom.portraitWrap.replaceChildren();
      if (member) {
        dom.portraitWrap.append(
          formationPortrait(
            rarity,
            portraitPalette,
            weaponRarity,
            weaponPalette,
            key === "front" ? 4 : 2,
            key === "front" ? "adv-slot-portrait-img adv-slot-portrait-img-front" : "adv-slot-portrait-img",
          ),
        );
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "adv-slot-placeholder";
        placeholder.textContent = "+";
        dom.portraitWrap.append(placeholder);
      }
    }

    dom.root.classList.toggle("filled", !!member);
    dom.root.classList.toggle("empty", !member);
    dom.root.classList.toggle("targeted", targetSlot === key);
    // Only a seated worker can be picked up and dragged to another log —
    // an empty seat has nothing to drag.
    dom.face.draggable = !!member;
    dom.root.classList.remove("rarity-common", "rarity-rare", "rarity-epic", "rarity-legendary");
    if (member) dom.root.classList.add(`rarity-${rarity}`);

    dom.nameEl.className = member ? `adv-slot-name rarity-${rarity}` : "adv-slot-name adv-slot-name-empty";
    dom.nameEl.textContent = member ? `${def?.name ?? member.defId} · Lv${member.level}` : SLOT_LABEL[key];
  }

  const VERDICT_COPY: Record<"red" | "amber" | "green", string> = {
    red: "Outmatched here",
    amber: "Risky — a real chance either way",
    green: "Well equipped for this world",
  };

  // The verdict is a 40-trial, twelve-room simulation — roughly 500 auto-
  // battles. renderMuster runs on a 1s interval while the screen is open (and
  // again on every drag, click and slot change), so recomputing it per render
  // would burn that much work every second to redraw the same sentence.
  //
  // The key is everything the estimate actually depends on: the world, who is
  // mustered, what they are carrying into the fight, and the prestige level
  // that scales them. Equipment is included because swapping gear via the 🎒
  // backpack shortcut is the single most likely thing a player does in
  // response to a red verdict — a cache that missed it would show them the
  // old answer to the exact question they just acted on.
  let verdictKey = "";
  function renderVerdict(partyIds: string[]): void {
    const s = game.save;
    if (partyIds.length === 0) {
      verdictKey = "";
      worldCard.classList.remove("verdict-red", "verdict-amber", "verdict-green");
      verdictText.textContent = "Muster a party to size up the run";
      verdictHint.textContent = "";
      return;
    }
    const key = [
      s.worldIndex,
      s.prestigeLevel,
      ...partyIds.map((id) => {
        const m = s.team.find((t) => t.id === id);
        return m ? `${id}:${m.currentHp}/${m.maxHp}:${Object.values(m.equipped).join(",")}` : id;
      }),
    ].join("|");
    if (key === verdictKey) return;
    verdictKey = key;

    const r = game.previewWorldReadiness(partyIds);
    if (!r) return;
    worldCard.classList.remove("verdict-red", "verdict-amber", "verdict-green");
    worldCard.classList.add(`verdict-${r.band}`);
    verdictText.textContent = VERDICT_COPY[r.band];
    // Always show the depth estimate that produced the verdict, so the colour
    // is backed by a number the player can watch move as they re-gear.
    const depth = `Reaches about room ${Math.round(r.avgRoomsCleared)} of ${r.roomsTotal}`;
    verdictHint.textContent =
      r.band === "red"
        ? r.betterWorld !== null
          ? `${depth}. Upgrade your gear, or run ${getWorld(r.betterWorld).name} instead.`
          : `${depth}. Upgrade your team's gear before embarking.`
        : r.band === "amber"
          ? `${depth}. Boons and fountains found on the way can close the gap.`
          : `${depth} with no boons at all — the run's own upgrades should carry you the rest.`;
  }

  function renderMuster(): void {
    const s = game.save;
    // Gated on the higher of worldIndex (resettable by Prestige) and
    // adventureWorldUnlocked (never reset) — adventure access survives a
    // prestige reset even though the wood-chopping ladder drops back to 0.
    const adventureWorldCeiling = Math.max(s.worldIndex, s.adventureWorldUnlocked);
    selectedWorld = Math.min(s.worldIndex, adventureWorldCeiling);
    const worldMult = getWorld(selectedWorld).mult;
    worldTitle.textContent =
      worldMult > 1
        ? `${getWorld(selectedWorld).name} · ×${abbrev(worldMult)} wood`
        : getWorld(selectedWorld).name;

    rosterEmpty.classList.toggle("hidden", s.team.length > 0);
    formationWrap.classList.toggle("hidden", s.team.length === 0);
    for (const key of EMBARK_ORDER) renderSlot(key, s);
    trayWrap.classList.toggle("hidden", s.team.length === 0);
    if (s.team.length > 0) renderTray(s);

    for (const prov of PROVISIONS) {
      if (prov.instant) continue;
      const btn = carryBtns.get(prov.id)!;
      const owned = s.provisions[prov.id] ?? 0;
      btn.textContent = `${prov.name} (${owned})`;
      btn.classList.toggle("active", selectedCarry.has(prov.id));
      btn.disabled = owned === 0 || (!selectedCarry.has(prov.id) && selectedCarry.size >= MAX_CARRIED);
    }

    // A keepsake is only offered once its patron's favour has been earned. An
    // unearned one is shown greyed with what it would take, rather than hidden
    // — the meta loop only pulls if the player can see what they are working
    // toward.
    const favor = s.patronFavor ?? {};
    let anyKeepsake = false;
    for (const patron of PATRON_DEFS) {
      const btn = keepsakeBtns.get(patron.id)!;
      const level = favor[patron.id] ?? 0;
      const unlocked = level >= 1;
      anyKeepsake = anyKeepsake || unlocked;
      btn.textContent = patron.name;
      btn.disabled = !unlocked;
      btn.classList.toggle("active", selectedKeepsake === patron.id);
      btn.title = unlocked
        ? `${patron.name}'s token — the first card of every offer will be ${patron.name}'s. ${patron.domain}.`
        : `Clear a Depth using ${patron.name}'s boons to earn this token.`;
    }
    keepsakeWrap.classList.toggle("hidden", !anyKeepsake);

    // Pact of the Grove.
    const cleared = s.stats.adventuresCleared > 0;
    pactWrap.classList.toggle("hidden", !cleared);
    if (cleared) {
      const active = s.pact ?? [];
      const rank = groveRank(active);
      const mult = grovePayoutMult(rank);
      pactTitle.textContent =
        rank > 0
          ? `Pact of the Grove — rank ${rank}, ${Math.round((mult - 1) * 100)}% richer`
          : "Pact of the Grove — make the delve harder for a better payout";
      for (const mod of PACT_DEFS) {
        const btn = pactBtns.get(mod.id)!;
        btn.textContent = `${mod.name} +${mod.rank}`;
        btn.classList.toggle("active", active.includes(mod.id));
        btn.title = mod.blurb;
      }
    }

    // Codex. Rebuilt only when opened or when the discovered set changes —
    // it is a long list and this screen re-renders on every interaction.
    const seen = new Set(s.codex ?? []);
    const codexKey = `${codexOpen}:${seen.size}`;
    codexToggle.textContent = codexOpen
      ? `Hide the Fated List (${seen.size}/${CODEX_TOTAL})`
      : `The Fated List (${seen.size}/${CODEX_TOTAL})`;
    codexWrap.classList.toggle("hidden", !codexOpen);
    if (codexOpen && codexWrap.dataset.key !== codexKey) {
      codexWrap.dataset.key = codexKey;
      codexWrap.replaceChildren(
        ...codexEntries().map((entry) => {
          const found = seen.has(entry.id);
          const tile = document.createElement("div");
          tile.className = found ? "adv-codex-tile" : "adv-codex-tile locked";
          // An undiscovered entry shows its CATEGORY but not its name. Knowing
          // there are three Bramble boons you have never seen is the hook; being
          // told what they do would spend it.
          tile.textContent = found ? entry.name : "? ? ?";
          tile.title = found ? `${entry.group} — ${entry.blurb}` : `${entry.group} — not yet discovered`;
          return tile;
        }),
      );
    }

    const rationsSpec = PROVISIONS.find((pr) => pr.id === "trailRations")!;
    const availableCount = s.team.filter((m) => m.status === "available").length;
    const needsHeal = s.team.some((m) => m.currentHp < m.maxHp || m.status === "resting");
    const canAffordHeal = s.wood >= rationsSpec.cost;
    healBtn.textContent = `Heal All (${abbrev(rationsSpec.cost)} wood)`;
    healBtn.disabled = !needsHeal || !canAffordHeal;
    healBtn.title = !needsHeal
      ? "Everyone's already at full HP"
      : !canAffordHeal
        ? `Need ${abbrev(rationsSpec.cost - s.wood)} more wood`
        : `Heal your whole roster to full HP for ${abbrev(rationsSpec.cost)} wood`;
    healBtn.classList.toggle("cta", availableCount === 0 && s.team.length > 0);

    const partyIds = currentPartyIds();
    const p = partyIds.length > 0 ? game.previewAdventure(selectedWorld, partyIds) : null;
    if (availableCount === 0 && s.team.length > 0) {
      previewEl.textContent = "No team members available to muster — heal your roster above to continue.";
    } else {
      previewEl.textContent = p
        ? `Embark: ${abbrev(p.cost)} wood · est. ${p.winPct}% win (first room) · ~${abbrev(p.avgWoodOnWin)} wood on win`
        : "Assign up to 3 available team members to the formation slots below.";
    }
    renderVerdict(partyIds);
    embarkBtn.disabled = !p || s.wood < p.cost;
  }

  function syncParty(partyIds: string[]): void {
    const changed = partyIds.length !== partyRowIds.length || partyIds.some((id, i) => id !== partyRowIds[i]);
    if (!changed) return;
    partyWrap.replaceChildren();
    partyRows.clear();
    partyRowIds = [...partyIds];
    for (const id of partyIds) {
      const member = game.save.team.find((m) => m.id === id);
      if (!member) continue;
      const row = document.createElement("div");
      row.className = "adv-roster-row";
      const nameEl = document.createElement("span");
      const hpBar = document.createElement("div");
      hpBar.className = "hp-bar";
      const fill = document.createElement("div");
      fill.className = "hp-bar-fill";
      hpBar.append(fill);
      row.append(nameEl, hpBar);
      partyWrap.append(row);
      partyRows.set(id, { name: nameEl, fill });
    }
  }

  function renderField(adv: NonNullable<ReturnType<Game["adventureStatus"]>>): void {
    const s = game.save;
    tallyEl.textContent =
      `${getWorld(adv.world).name} · ${DEPTH_NAMES[adv.depth as 1 | 2 | 3] ?? "the deep"} · ` +
      `room ${Math.min(TOTAL_ROOMS, adv.roomsCleared + 1)}/${TOTAL_ROOMS} · ${abbrev(adv.acorns)} acorns · ` +
      `pending ${abbrev(adv.pendingWood)} wood, ${abbrev(adv.pendingAmber)} amber`;

    syncParty(adv.partyIds);
    for (const id of adv.partyIds) {
      const member = s.team.find((m) => m.id === id);
      const entry = partyRows.get(id);
      if (!member || !entry) continue;
      const def = WORKER_DEFS_BY_ID[member.defId];
      entry.name.className = `rarity-${def?.rarity ?? "common"}`;
      entry.name.textContent = `${def?.name ?? member.defId}`;
      const pct = member.maxHp > 0 ? Math.round((100 * member.currentHp) / member.maxHp) : 0;
      entry.fill.style.width = `${pct}%`;
      const hpState = hpBarClass(pct);
      entry.fill.classList.toggle("low", hpState === "low");
      entry.fill.classList.toggle("critical", hpState === "critical");
    }

    const lastLog = s.adventure ? s.adventure.log[s.adventure.log.length - 1] : undefined;
    logEl.textContent = lastLog
      ? `${lastLog.enemyName}: ${lastLog.outcome === "win" ? "defeated" : "lost"}${lastLog.narrowEscape ? " · narrow escape" : ""} · +${abbrev(lastLog.woodGained)} wood${lastLog.amberGained ? ` · +${abbrev(lastLog.amberGained)} amber` : ""}`
      : "No encounters yet.";

    resumeBtn.classList.toggle("hidden", !adv.battleInProgress);
    pushBtn.classList.toggle("hidden", adv.battleInProgress);
    nextEnemyEl.style.display = adv.battleInProgress ? "none" : "";
    if (!adv.battleInProgress) {
      // What is actually ahead is a CHOICE of doors, not a fixed next fight, so
      // this previews the choice rather than pretending to know the outcome of
      // it. The doors themselves are drawn in the dungeon.
      const fee = game.nextStageFee();
      const exits = game.exitOffer();
      nextEnemyEl.textContent = exits
        ? `Ahead: ${exits.map((r) => doorLabel(r).toLowerCase()).join(" · ")}`
        : "The way on is open.";
      pushBtn.textContent = fee > 0 ? `Descend · ${abbrev(fee)} wood` : "Press On";
      pushBtn.disabled = s.wood < fee;
      pushBtn.title = s.wood >= fee ? "" : `Need ${abbrev(fee - s.wood)} more wood to descend.`;
    }
  }

  function render(): void {
    const adv = game.adventureStatus();
    musterEl.classList.toggle("hidden", !!adv);
    fieldEl.classList.toggle("hidden", !adv);
    if (adv) renderField(adv);
    else renderMuster();
  }

  function open(): void {
    if (game.isBattleViewOpen() || game.isPovActive()) return; // that view owns the screen
    closeOtherOverlays("adventure");
    overlay.classList.remove("hidden");
    render();
    refreshTimer = window.setInterval(render, 1000);
  }

  function close(): void {
    overlay.classList.add("hidden");
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  registerOverlay("adventure", close);
  // Lets the on-canvas "resume adventure" HUD icon open this overlay
  // directly when there's a run in progress but no live battle to jump
  // straight into (see Game.hitAdventureIndicator).
  game.onWantAdventureOverlay = open;
  // The formation is closure state keyed by member id, and until the Fusion
  // Altar existed no member could ever leave the roster — so a seat could
  // safely hold an id forever. Now it can go stale: seat three workers, merge
  // one of them away from the Team screen, and this screen would still draw
  // them on their log and then quietly refuse to embark, because
  // `partyFor(ids).length !== partyIds.length` fails the guard with nothing on
  // screen explaining why. Empty the seat instead.
  game.onRosterMembersRemoved = (removedIds) => {
    const gone = new Set(removedIds);
    for (const key of EMBARK_ORDER) {
      const seated = formation[key];
      if (seated && gone.has(seated)) formation[key] = null;
    }
    if (targetSlot && formation[targetSlot] === null) targetSlot = null;
    if (!overlay.classList.contains("hidden")) render();
  };

  openBtn.addEventListener("click", () => {
    if (overlay.classList.contains("hidden")) open();
    else close();
  });
  closeBtn.addEventListener("click", close);
}
