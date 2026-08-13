// Team roster panel: priority order, level up, equip. Rendered inside the
// shop overlay's #shop-list. Mirrors shop.ts's plain-DOM row-builder style.

import {
  ITEM_EFFECT_BLURBS,
  ITEM_EFFECT_LABELS,
  itemDefById,
  PROVISIONS,
  WORKER_CLASS_INFO,
  WORKER_DEFS_BY_ID,
  type ItemDef,
} from "../economy";
import { abbrev, hpBarClass } from "../scene/floating-text";
import type { Game } from "../scene/game";
import {
  drawSprite,
  RARITY_WOODCUTTER_SPRITES,
  spriteSize,
  withPalette,
  type PixelMap,
  type WorkerRarity,
} from "../scene/sprites";
import {
  CLASS_ICON,
  SLOT_ADVENTURING_ICON,
  SLOT_UTILITY_ICON,
  SLOT_WOODCHOPPING_ICON,
  UI_PALETTE,
} from "../scene/ui-icons";
import { BODY_SPRITE_W, drawHeldWeapon, WEAPON_APPEARANCE } from "../scene/weapons";
import {
  effectiveAtk,
  equippedItem,
  levelUpCost,
  MAX_LEVEL,
  memberClass,
  xpToNext,
  bestUpgradeFor,
  itemScore,
  type ItemSlot,
  type Rarity,
  type TeamMemberSave,
} from "../team";
import { pixelIcon, pixelIconComposite } from "./pixel-icon";

/** Compact real-number summary of an item's stats, for the equip picker and
 * (via gacha.ts's own copy) the gacha reveal cards — one slot always has
 * exactly one of these three stat blocks (see economy.ts's buildItemDef).
 * Every field here is optional and additive, so a common/rare item (which
 * only ever has the base atk/hp) just prints that one line. */
export function itemStatSummary(d: ItemDef): string {
  if (d.woodchopping) {
    const parts = [`+${abbrev(d.woodchopping.atk ?? 0)} atk`];
    if (d.woodchopping.yieldPct) parts.push(`+${Math.round(d.woodchopping.yieldPct * 100)}% yield`);
    if (d.woodchopping.focusEfficiencyPct) {
      parts.push(`+${Math.round(d.woodchopping.focusEfficiencyPct * 100)}% focus`);
    }
    if (d.woodchopping.skillCheckWindowPct) {
      parts.push(`+${Math.round(d.woodchopping.skillCheckWindowPct * 100)}% skill-check window`);
    }
    if (d.effectId) parts.push(ITEM_EFFECT_LABELS[d.effectId]);
    return parts.join(" · ");
  }
  if (d.adventuring) {
    const parts = [`+${abbrev(d.adventuring.atk ?? 0)} atk`, `+${abbrev(d.adventuring.hp ?? 0)} hp`];
    if (d.adventuring.reflectPct) parts.push(`+${Math.round(d.adventuring.reflectPct * 100)}% reflect`);
    if (d.adventuring.expeditionBonusPct) {
      parts.push(`+${Math.round(d.adventuring.expeditionBonusPct * 100)}% expedition reward`);
    }
    if (d.effectId) parts.push(ITEM_EFFECT_LABELS[d.effectId]);
    return parts.join(" · ");
  }
  if (d.utility) return `${d.utility.perk} +${Math.round(d.utility.magnitude * 100)}%`;
  return "";
}

const SLOT_LABEL: Record<ItemSlot | "utility2", string> = {
  woodchopping: "Woodchopping",
  adventuring: "Adventuring",
  utility: "Utility",
  utility2: "Utility II",
};

// Slot icons shown next to each equip-slot button/picker — axe/sword reuse
// the same silhouette vocabulary as the Woodchopping/Adventuring strip
// icons; the Utility charm is deliberately a distinct diamond-on-a-chain
// silhouette from the amber-currency gem so the two never read as the same
// glyph (see scene/ui-icons.ts).
const SLOT_ICON: Record<ItemSlot | "utility2", PixelMap> = {
  woodchopping: SLOT_WOODCHOPPING_ICON,
  adventuring: SLOT_ADVENTURING_ICON,
  utility: SLOT_UTILITY_ICON,
  utility2: SLOT_UTILITY_ICON,
};

// Status dot classes for the team roster's at-a-glance scan — CSS-only (see
// .status-dot in styles.css), same shape/mechanism as .rarity-dot: green
// mirrors the hp-bar's own "fine" read, resting mirrors its warning-amber
// "hurt" read, adventuring is a dedicated "away/exploring" blue.

// Portrait canvas sizing (Part C.2): PORTRAIT_W/H pad the body's own
// BODY_SPRITE_W=10 / legendary's tallest 9-row frame so a held weapon's
// idle pose (drawn via drawHeldWeapon's hand-anchor/grip math, which can
// draw slightly outside the body's own silhouette — e.g. the legendary
// axe's detached glow-halo pixels) never gets clipped.
export const PORTRAIT_PAD_X = 3;
export const PORTRAIT_PAD_Y = 3;
export const PORTRAIT_W = BODY_SPRITE_W + PORTRAIT_PAD_X * 2;
export const PORTRAIT_H = 9 + PORTRAIT_PAD_Y * 2;

/** Builds the (cache key, draw callback) pair for a worker portrait —
 * composites a rarity-tier body sprite (RARITY_WOODCUTTER_SPRITES, Part B)
 * AND its resolved Woodchopping weapon (WEAPON_APPEARANCE/drawHeldWeapon,
 * Part D) onto one flattened icon. Exported so the gacha reel (Part E,
 * ui/gacha.ts) can reuse the EXACT same composition — including whatever
 * per-character accent (economy.ts's WorkerDef.accent) the caller has
 * already merged into `workerPalette` — instead of diverging with its own
 * copy. `workerPalette`/`weaponPalette` isn't a simple (map, palette) pair
 * at (0,0), since the weapon's position comes from drawHeldWeapon's own
 * hand-anchor math — that's why this hands back a draw callback for
 * pixel-icon.ts's composite variant rather than a plain PixelMap. */
export function workerPortraitDraw(
  rarity: WorkerRarity,
  workerPalette: Record<string, string> | null,
  weaponRarity: Rarity,
  weaponPalette: Record<string, string> | null,
): { key: string; draw: (ctx: CanvasRenderingContext2D) => void } {
  const bodyMap = RARITY_WOODCUTTER_SPRITES[rarity].stand;
  const held = WEAPON_APPEARANCE.woodchopping[weaponRarity].held;
  const key = `portrait:${rarity}:${weaponRarity}:${JSON.stringify(workerPalette)}:${JSON.stringify(weaponPalette)}`;
  return {
    key,
    draw: (ctx) => {
      const { h } = spriteSize(bodyMap);
      withPalette(workerPalette, () => {
        drawSprite(ctx, bodyMap, PORTRAIT_PAD_X, PORTRAIT_PAD_Y);
      });
      if (held) {
        drawHeldWeapon(ctx, held, "idle", weaponPalette, false, PORTRAIT_PAD_X, PORTRAIT_PAD_Y + h);
      }
    },
  };
}

/** Cached, ready-to-mount `<img>` wrapper around workerPortraitDraw() above
 * — what the Team roster tiles + detail panel (§C.2) actually append.
 * Cached by pixelIconComposite, keyed on the exact (rarity, weaponRarity,
 * palettes) combination, so the Team panel's 1s refresh timer is a cache
 * hit unless gear/world/accent actually changed. `scale`/`className` are
 * overridable so the compact roster tile (small) and the detail panel
 * (large) can share this exact composition at two different sizes instead
 * of diverging with separate draw logic. */
function memberPortrait(
  rarity: WorkerRarity,
  workerPalette: Record<string, string> | null,
  weaponRarity: Rarity,
  weaponPalette: Record<string, string> | null,
  scale = 3,
  className = "team-card-portrait-img",
): HTMLImageElement {
  const { key, draw } = workerPortraitDraw(rarity, workerPalette, weaponRarity, weaponPalette);
  return pixelIconComposite(key, PORTRAIT_W, PORTRAIT_H, draw, { scale, className });
}

export interface TeamPanel {
  render: (listEl: HTMLElement) => void;
}

/** Cross-module "open the Team panel to this member" request — set by
 * another overlay (the Adventure campfire's backpack shortcut, see
 * ui/adventure.ts) and consumed on the Team panel's very next render.
 * Module-level rather than threaded through TeamPanel's return type since
 * only one Team panel instance ever exists (owned by shop.ts) and the
 * request can arrive before or after it's been created — a plain module
 * variable needs no wiring either way. */
let pendingSelectMemberId: string | null = null;

export function requestSelectMember(id: string): void {
  pendingSelectMemberId = id;
}

export function createTeamPanel(game: Game): TeamPanel {
  const openSlot = new Map<string, ItemSlot | "utility2" | null>();
  // Which single roster member's detail panel is showing on the right —
  // same per-render-closure state pattern as `openSlot` above, just a lone
  // id instead of a per-member map since only one member can be selected at
  // a time (barracks roster/detail split, §two-pane layout).
  let selectedMemberId: string | null = null;
  let mounted: HTMLElement | null = null;

  /** Everything render() actually reads, as a comparable string.
   *
   * The shop rebuilds its list on a 1s interval. For most tabs that is
   * harmless, but this panel is a two-pane layout with a scrolling roster, and
   * a rebuild throws away the scroll position along with the DOM — scroll down
   * the roster, wait a second, and it snaps back to the top. It is also the
   * click-eating pattern this codebase has been bitten by before: a tile
   * replaced between mousedown and mouseup never receives the click.
   *
   * So the panel only rebuilds when something it displays has actually
   * changed. */
  function renderKey(): string {
    const s = game.save;
    return [
      selectedMemberId,
      // The open gear slot MUST be in the key. It is panel state, not save
      // state, which is exactly why it was missed — and the symptom was that
      // clicking a gear slot did nothing at all: the handler flipped
      // `openSlot`, called render(), and render() saw an unchanged key and
      // returned without building the picker. It only appeared when something
      // else moved the key, in practice the wood counter ticking a second
      // later while chopping. Anything the panel DISPLAYS belongs here,
      // whether or not it is persisted.
      selectedMemberId ? (openSlot.get(selectedMemberId) ?? "") : "",
      s.wood,
      s.inventory.length,
      s.prestigeLevel,
      ...s.team.map(
        (m) =>
          `${m.id}:${m.defId}:${m.level}:${m.xp ?? 0}:${m.currentHp}/${m.maxHp}:${m.status}:` +
          `${m.equipped.woodchopping ?? ""},${m.equipped.adventuring ?? ""},` +
          `${m.equipped.utility ?? ""},${m.equipped.utility2 ?? ""}`,
      ),
      ...(Object.keys(s.shards) as (keyof typeof s.shards)[]).map((r) => `${r}${s.shards[r]}`),
    ].join("|");
  }
  let lastKey: string | null = null;

  function render(listEl: HTMLElement): void {
    mounted = listEl;

    const key = renderKey();
    // A repaint that would produce identical DOM is skipped outright. This is
    // what stops the 1s refresh from resetting the roster's scroll.
    if (key === lastKey && listEl.querySelector(".team-layout")) return;
    lastKey = key;

    // When a rebuild IS warranted (a purchase, a level-up, a new pull), the
    // roster's scroll position is carried across it. Losing your place in the
    // list every time you equip something is the same annoyance in a smaller
    // costume.
    const prevRoster = listEl.querySelector(".team-roster");
    const prevScroll = prevRoster ? prevRoster.scrollTop : 0;

    listEl.replaceChildren();
    const s = game.save;
    // Heal-All stays OUTSIDE the two-pane layout, full-width, above it —
    // it's an action, not a roster entry.
    listEl.append(renderHealRow());

    // An external "select this member" request (see requestSelectMember)
    // wins over both the remembered selection and the default-to-first
    // fallback below — consumed exactly once, so a plain re-render later
    // doesn't keep fighting the player's own subsequent clicks.
    if (pendingSelectMemberId && s.team.some((m) => m.id === pendingSelectMemberId)) {
      selectedMemberId = pendingSelectMemberId;
    }
    pendingSelectMemberId = null;

    // Default to the first roster member on initial render, and fall back
    // to the first member again if the previously-selected one somehow
    // vanished from the roster (defensive — team members are never removed
    // today, but this keeps the panel from silently showing nothing).
    if (!selectedMemberId || !s.team.some((m) => m.id === selectedMemberId)) {
      selectedMemberId = s.team[0]?.id ?? null;
    }

    const layout = document.createElement("div");
    layout.className = "team-layout";

    const roster = document.createElement("div");
    roster.className = "team-roster";
    s.team.forEach((member, i) => {
      roster.append(renderRosterTile(member, i, s.team.length, member.id === selectedMemberId));
    });
    layout.append(roster);

    const selected = s.team.find((m) => m.id === selectedMemberId);
    if (selected) {
      layout.append(renderDetail(selected));
    } else {
      const empty = document.createElement("div");
      empty.className = "team-detail team-detail-empty shop-sub";
      empty.textContent = "No team members yet.";
      layout.append(empty);
    }

    listEl.append(layout);
    // Restore after append — scrollTop on a detached node is silently dropped.
    if (prevScroll > 0) roster.scrollTop = prevScroll;
  }

  /** Re-renders, then briefly flashes the detail panel whose identity
   * survives the rebuild (found via its data-member-id) — a lightweight
   * "that worked" confirmation for level-up/equip/unequip, since render()
   * otherwise tears down and rebuilds the DOM node instantly with no
   * visible feedback. Scoped to `.team-detail` specifically (rather than
   * any `[data-member-id]`) since a roster tile for the same member also
   * carries that attribute and sits earlier in the DOM. */
  function renderAndFlash(listEl: HTMLElement, memberId: string): void {
    render(listEl);
    const panel = listEl.querySelector<HTMLElement>(`.team-detail[data-member-id="${memberId}"]`);
    if (!panel) return;
    panel.classList.add("flash-pulse");
    panel.addEventListener("animationend", () => panel.classList.remove("flash-pulse"), { once: true });
  }

  /** Inline shortcut for Trail Rations — otherwise the only way to heal a
   * resting/injured member is Shop → Provisions → Trail Rations, with no
   * pointer from here that that's even where to look. */
  function renderHealRow(): HTMLElement {
    const s = game.save;
    const spec = PROVISIONS.find((p) => p.id === "trailRations")!;
    const needsHeal = s.team.some((m) => m.currentHp < m.maxHp || m.status === "resting");
    const affordable = s.wood >= spec.cost;

    const el = document.createElement("div");
    el.className = "shop-row";
    const info = document.createElement("div");
    info.className = "shop-info";
    const name = document.createElement("div");
    name.textContent = "Heal All";
    const blurb = document.createElement("div");
    blurb.className = "shop-sub";
    blurb.textContent = `${spec.blurb} · ${abbrev(spec.cost)} wood`;
    info.append(name, blurb);
    el.append(info);

    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = "Heal";
    btn.disabled = !needsHeal || !affordable;
    btn.title = !needsHeal
      ? "Everyone's already at full HP"
      : !affordable
        ? `Need ${abbrev(spec.cost - s.wood)} more wood`
        : `Heal your whole roster to full HP for ${abbrev(spec.cost)} wood`;
    btn.addEventListener("click", () => {
      game.useTrailRations();
      if (mounted) render(mounted);
    });
    el.append(btn);

    // Optimize Gear: one-click greedy re-equip of the whole roster by
    // priority order (see team.ts's optimizeEquipment) — the QoL answer to
    // hand-shuffling items across a growing roster.
    const optBtn = document.createElement("button");
    optBtn.textContent = "Auto-equip";
    // The label used to say "Optimize gear", which described half of what it
    // does and none of what it costs — it also REORDERS the roster, and roster
    // order decides who gets assigned to a live chopping session. Worth saying
    // out loud before someone presses it.
    optBtn.title =
      "Sort the roster strongest-first, then hand out your best items in that order. Also changes who chops first.";
    optBtn.addEventListener("click", () => {
      game.optimizeGear();
      if (mounted) render(mounted);
    });
    el.append(optBtn);
    return el;
  }

  /** Left column: one small "slot" tile per roster member — portrait,
   * level badge, status dot, and compact corner ▲/▼ priority-reorder
   * controls. Clicking anywhere else on the tile selects that member for
   * the detail panel on the right (renderDetail). Reordering works
   * straight from the tile, no selection required first — same
   * game.reorderTeam(member.id, ...) call the old inline card buttons
   * made, just relocated. */
  /** Does this member have an unused upgrade for any slot? Drives the roster
   * tile's marker, so the player can see WHICH members need attention without
   * selecting each one in turn. */
  function memberHasUpgrade(member: TeamMemberSave): boolean {
    const s = game.save;
    const slots: (ItemSlot | "utility2")[] = ["woodchopping", "adventuring", "utility"];
    if (game.hasPowerup("extraUtility")) slots.push("utility2");
    return slots.some((slot) => bestUpgradeFor(member, slot, s.inventory, s.team) !== null);
  }

  function renderRosterTile(member: TeamMemberSave, index: number, total: number, selected: boolean): HTMLElement {
    const s = game.save;
    const def = WORKER_DEFS_BY_ID[member.defId];
    const rarity = def?.rarity ?? "common";

    const tile = document.createElement("div");
    tile.className = "team-tile";
    tile.dataset.memberId = member.id;
    if (rarity === "epic") tile.classList.add("team-tile-epic");
    else if (rarity === "legendary") tile.classList.add("team-tile-legendary");
    tile.classList.toggle("selected", selected);
    // A dot in the corner for "this one has better gear waiting", so the
    // roster answers "who needs attention" at a glance rather than requiring
    // the player to click through every member to find out.
    const hasUpgrade = memberHasUpgrade(member);
    tile.classList.toggle("has-upgrade", hasUpgrade);
    if (hasUpgrade) {
      const pip = document.createElement("span");
      pip.className = "team-tile-upgrade";
      tile.append(pip);
    }
    tile.title = hasUpgrade
      ? `${def?.name ?? member.defId} · Lv${member.level} — better gear available`
      : `${def?.name ?? member.defId} · Lv${member.level}`;

    // Woodchopping always shows a weapon (defaults to common-tier if
    // nothing's equipped) — matches the on-canvas resolution rule in
    // game.ts/woodcutter.ts, so the portrait never looks bare-handed.
    const weaponDef = equippedItem(member, "woodchopping", s.inventory);
    const weaponRarity: Rarity = weaponDef?.rarity ?? "common";
    // Per-character accent (Part E) merged in on top of the world palette —
    // same merge order as game.ts's own render sites, spread last so it can
    // never get clobbered by the world tint (which only ever touches R/r,
    // never the accent letters C/N/H/h/Y/y).
    const worldPalette = game.getWorkerPalette(s.worldIndex);
    const accent = def?.accent;
    const portraitPalette = accent ? { ...(worldPalette ?? {}), ...accent } : worldPalette;
    const portraitWrap = document.createElement("div");
    portraitWrap.className = "team-tile-portrait";
    portraitWrap.append(
      memberPortrait(
        rarity,
        portraitPalette,
        weaponRarity,
        game.weaponPalette(s.worldIndex),
        2,
        "team-tile-portrait-img",
      ),
    );
    tile.append(portraitWrap);

    const levelBadge = document.createElement("span");
    levelBadge.className = "team-tile-level";
    levelBadge.textContent = `${member.level}`;
    tile.append(levelBadge);

    const statusDot = document.createElement("span");
    statusDot.className = `status-dot team-tile-status ${member.status}`;
    statusDot.title = member.status;
    tile.append(statusDot);

    // Compact stacked ▲/▼ in the tile's corner — reordering shouldn't
    // require selecting the member first.
    const reorder = document.createElement("div");
    reorder.className = "team-reorder team-tile-reorder";
    const up = document.createElement("button");
    up.textContent = "▲";
    up.disabled = index === 0;
    up.title = index === 0 ? "Already highest priority" : "Move up in priority order";
    up.addEventListener("click", (e) => {
      e.stopPropagation();
      game.reorderTeam(member.id, index - 1);
      if (mounted) render(mounted);
    });
    const down = document.createElement("button");
    down.textContent = "▼";
    down.disabled = index === total - 1;
    down.title = index === total - 1 ? "Already lowest priority" : "Move down in priority order";
    down.addEventListener("click", (e) => {
      e.stopPropagation();
      game.reorderTeam(member.id, index + 1);
      if (mounted) render(mounted);
    });
    reorder.append(up, down);
    tile.append(reorder);

    tile.addEventListener("click", () => {
      selectedMemberId = member.id;
      if (mounted) render(mounted);
    });

    return tile;
  }

  /** Right pane: the ONE detail panel for whichever member is currently
   * selected — larger portrait, name/level/rarity, HP bar, atk/hp line,
   * the equip-slot chip row, and (when a slot is toggled open) the item
   * picker + the level-up button. Reuses the exact same slot-chip and
   * item-picker rendering/behavior the old per-card layout had — just
   * mounted once here instead of appended under every card. */
  function renderDetail(member: TeamMemberSave): HTMLElement {
    const s = game.save;
    const def = WORKER_DEFS_BY_ID[member.defId];
    const rarity = def?.rarity ?? "common";

    const panel = document.createElement("div");
    panel.className = "team-detail";
    panel.dataset.memberId = member.id;
    // Persistent (subtler than the pull-reveal celebration) chrome so an
    // owned epic/legendary keeps reading as special on the roster, not just
    // during its one-time gacha reveal.
    if (rarity === "epic") panel.classList.add("team-card-epic");
    else if (rarity === "legendary") panel.classList.add("team-card-legendary");

    const head = document.createElement("div");
    head.className = "team-card-head team-detail-head";
    const name = document.createElement("div");
    name.className = `rarity-${rarity}`;
    const rarityDot = document.createElement("span");
    rarityDot.className = `rarity-dot rarity-${rarity}`;
    const statusDot = document.createElement("span");
    statusDot.className = `status-dot ${member.status}`;
    statusDot.title = member.status;
    name.append(
      rarityDot,
      document.createTextNode(`${def?.name ?? member.defId} · Lv${member.level}`),
      statusDot,
    );
    head.append(name);
    // Class tag (Bruiser/Warden/Scout): real pixel-art icon (see
    // scene/ui-icons.ts CLASS_ICON) + name, hook details in the tooltip.
    const cls = memberClass(member);
    const clsInfo = WORKER_CLASS_INFO[cls];
    const clsTag = document.createElement("span");
    clsTag.className = "team-class-tag";
    clsTag.title = clsInfo.blurb;
    clsTag.append(
      pixelIcon(CLASS_ICON[cls], { palette: UI_PALETTE, scale: 1 }),
      document.createTextNode(clsInfo.name),
    );
    head.append(clsTag);
    panel.append(head);

    const weaponDef = equippedItem(member, "woodchopping", s.inventory);
    const weaponRarity: Rarity = weaponDef?.rarity ?? "common";
    const worldPalette = game.getWorkerPalette(s.worldIndex);
    const accent = def?.accent;
    const portraitPalette = accent ? { ...(worldPalette ?? {}), ...accent } : worldPalette;
    const portraitWrap = document.createElement("div");
    portraitWrap.className = "team-detail-portrait";
    portraitWrap.append(
      memberPortrait(
        rarity,
        portraitPalette,
        weaponRarity,
        game.weaponPalette(s.worldIndex),
        5,
        "team-detail-portrait-img",
      ),
    );
    panel.append(portraitWrap);

    const hpBar = document.createElement("div");
    hpBar.className = "hp-bar";
    const hpFill = document.createElement("div");
    hpFill.className = "hp-bar-fill";
    const pct = member.maxHp > 0 ? Math.round((100 * member.currentHp) / member.maxHp) : 0;
    hpFill.style.width = `${pct}%`;
    const hpState = hpBarClass(pct);
    hpFill.classList.toggle("low", hpState === "low");
    hpFill.classList.toggle("critical", hpState === "critical");
    hpBar.append(hpFill);
    panel.append(hpBar);

    const stat = document.createElement("div");
    stat.className = "shop-sub";
    stat.textContent = `atk ${abbrev(Math.round(effectiveAtk(member, s.inventory, s.prestigeLevel)))} · hp ${abbrev(member.currentHp)}/${abbrev(member.maxHp)}`;
    panel.append(stat);

    // Battle-XP progress toward the next level (grantXp/xpToNext — team.ts).
    if (member.level < MAX_LEVEL) {
      const xpNeed = xpToNext(member.level);
      const xpHave = Math.min(member.xp ?? 0, xpNeed);
      const xpBar = document.createElement("div");
      xpBar.className = "xp-bar";
      xpBar.title = `Battle XP: ${xpHave}/${xpNeed} to Lv${member.level + 1}`;
      const xpFill = document.createElement("div");
      xpFill.className = "xp-bar-fill";
      xpFill.style.width = `${Math.round((100 * xpHave) / xpNeed)}%`;
      xpBar.append(xpFill);
      panel.append(xpBar);
      const xpLabel = document.createElement("div");
      xpLabel.className = "shop-sub xp-label";
      xpLabel.textContent = `xp ${xpHave}/${xpNeed}`;
      panel.append(xpLabel);
    }

    const slots = document.createElement("div");
    slots.className = "team-slots";
    // The extraUtility Power-up's second Utility slot only shows up once
    // it's actually owned — every other member's panel is byte-for-byte
    // unchanged until then.
    const slotList: (ItemSlot | "utility2")[] = ["woodchopping", "adventuring", "utility"];
    if (game.hasPowerup("extraUtility")) slotList.push("utility2");
    slotList.forEach((slot) => {
      const btn = document.createElement("button");
      const equippedId = slot === "utility2" ? (member.equipped.utility2 ?? null) : member.equipped[slot];
      const equippedInst = equippedId ? s.inventory.find((i) => i.id === equippedId) : null;
      const equippedDef = equippedInst ? itemDefById(equippedInst.defId) : null;
      // Icon-only chip: the full "Woodchopping: Item Name" text lives in the
      // tooltip; a rarity dot next to the icon still gives an at-a-glance
      // read of what's equipped without any text at all. Scaled up (native
      // 8x8 -> 24x24) so the glyph actually reads at a glance instead of
      // being a barely-legible speck next to the chip's chrome.
      const slotIcon = pixelIcon(SLOT_ICON[slot], { palette: UI_PALETTE, scale: 3 });
      btn.append(slotIcon);
      if (equippedDef) {
        const dot = document.createElement("span");
        dot.className = `rarity-dot rarity-${equippedDef.rarity}`;
        dot.style.marginLeft = "4px";
        dot.style.marginRight = "0";
        btn.append(dot);
      }
      // "There is something better in your bag for this slot."
      //
      // Without this the only way to find out was to open every slot on every
      // member and compare names against a list of stats you cannot see. The
      // badge answers the question the player is actually asking, and the
      // tooltip names the item so they can decide without opening anything.
      const upgrade = bestUpgradeFor(member, slot, s.inventory, s.team);
      if (upgrade) {
        const mark = document.createElement("span");
        mark.className = "team-slot-upgrade";
        mark.textContent = "▲";
        btn.append(mark);
      }
      btn.classList.toggle("has-upgrade", !!upgrade);
      btn.title = upgrade
        ? `${SLOT_LABEL[slot]}: ${equippedDef ? equippedDef.name : "empty"} — ${upgrade.name} is better and unused`
        : `${SLOT_LABEL[slot]}: ${equippedDef ? equippedDef.name : "empty"}`;
      btn.classList.toggle("active", openSlot.get(member.id) === slot);
      btn.addEventListener("click", () => {
        openSlot.set(member.id, openSlot.get(member.id) === slot ? null : slot);
        if (mounted) render(mounted);
      });
      slots.append(btn);
    });
    panel.append(slots);

    const actions = document.createElement("div");
    actions.className = "team-actions";
    const cost = levelUpCost(member);
    const levelBtn = document.createElement("button");
    levelBtn.textContent = member.level >= MAX_LEVEL ? "max" : `Level (${cost} ${rarity} shards)`;
    levelBtn.disabled = member.level >= MAX_LEVEL || s.shards[rarity] < cost;
    levelBtn.title =
      member.level >= MAX_LEVEL
        ? "Already at max level"
        : s.shards[rarity] < cost
          ? `Need ${cost - s.shards[rarity]} more ${rarity} shards`
          : `Spend ${cost} ${rarity} shards to level up`;
    levelBtn.addEventListener("click", () => {
      game.levelUpMember(member.id);
      if (mounted) renderAndFlash(mounted, member.id);
    });
    actions.append(levelBtn);
    panel.append(actions);

    const openS = openSlot.get(member.id);
    if (openS) {
      panel.append(renderItemPicker(member, openS));
    }

    return panel;
  }

  /** Finds whichever OTHER team member currently has `instanceId` equipped
   * (in any slot), if any — used to warn the player in the item picker
   * before a click silently moves gear off of them (Game.equipItem's
   * unequipInstanceEverywhere now handles the transfer safely, but the
   * player should still see it coming). */
  function equippedElsewhere(instanceId: string, excludeMemberId: string): TeamMemberSave | undefined {
    return game.save.team.find(
      (m) =>
        m.id !== excludeMemberId &&
        (m.equipped.woodchopping === instanceId ||
          m.equipped.adventuring === instanceId ||
          m.equipped.utility === instanceId ||
          m.equipped.utility2 === instanceId),
    );
  }

  function renderItemPicker(member: TeamMemberSave, slot: ItemSlot | "utility2"): HTMLElement {
    const s = game.save;
    const picker = document.createElement("div");
    picker.className = "item-picker";
    const baseSlot: ItemSlot = slot === "utility2" ? "utility" : slot;
    const equippedId = slot === "utility2" ? (member.equipped.utility2 ?? null) : member.equipped[slot];

    if (equippedId) {
      const unequipBtn = document.createElement("button");
      unequipBtn.textContent = "Unequip";
      unequipBtn.addEventListener("click", () => {
        game.unequipItem(member.id, slot);
        if (mounted) renderAndFlash(mounted, member.id);
      });
      picker.append(unequipBtn);
    }

    // A Utility item can only ever be equipped into ONE of a member's two
    // slots at a time — excluded from both pickers' "owned" lists whichever
    // slot it's already in, not just the one currently open.
    const owned = s.inventory.filter((inst) => {
      const d = itemDefById(inst.defId);
      if (!d || d.slot !== baseSlot) return false;
      if (inst.id === member.equipped.woodchopping) return false;
      if (inst.id === member.equipped.adventuring) return false;
      if (inst.id === member.equipped.utility) return false;
      if (inst.id === member.equipped.utility2) return false;
      return true;
    });

    if (owned.length === 0) {
      const empty = document.createElement("div");
      empty.className = "shop-sub";
      empty.textContent = "no items of this type owned — pull the Item Gacha (Shop → Gacha tab) to find some";
      picker.append(empty);
    }

    // Best first. The list was in whatever order the items happened to be
    // pulled in, so choosing well meant reading every row and holding a
    // comparison in your head — with no stats shown to compare against.
    const equippedDefForSlot = equippedItem(member, slot, s.inventory);
    const equippedScore = equippedDefForSlot ? itemScore(equippedDefForSlot) : 0;
    owned.sort((a, b) => {
      const da = itemDefById(a.defId);
      const db = itemDefById(b.defId);
      return (db ? itemScore(db) : 0) - (da ? itemScore(da) : 0);
    });

    for (const inst of owned) {
      const d = itemDefById(inst.defId);
      if (!d) continue;
      const itemBtn = document.createElement("button");
      // Two facts the row could not previously convey: whether this is an
      // upgrade on what is worn, and whether taking it strips a teammate.
      // Both are decisions the player was being asked to make blind.
      // "Worn by X" is already surfaced below; this is the other half of the
      // decision the row was asking the player to make blind — is this
      // actually better than what they have on?
      const isUpgrade = itemScore(d) > equippedScore;
      if (isUpgrade) itemBtn.classList.add("item-row-upgrade");
      // Weapon/charm preview so the picker row shows what the item actually
      // looks like, not just its name — woodchopping/adventuring weapons
      // only carry a `.held.idle` pose (no standalone `.icon`), while
      // utility charms only carry `.icon` (they're never held in-hand), so
      // this fallback covers every slot uniformly. Defensive: every real
      // rarity/slot combo has one or the other, but a missing lookup just
      // skips the image rather than breaking the row.
      const previewMap = WEAPON_APPEARANCE[baseSlot][d.rarity].icon ?? WEAPON_APPEARANCE[baseSlot][d.rarity].held?.idle;
      if (previewMap) {
        const preview = pixelIcon(previewMap, {
          palette: game.weaponPalette(s.worldIndex) ?? undefined,
          scale: 3,
          className: "item-picker-preview",
        });
        itemBtn.append(preview);
      }
      const dot = document.createElement("span");
      dot.className = `rarity-dot rarity-${d.rarity}`;
      const stats = itemStatSummary(d);
      itemBtn.append(dot, document.createTextNode(`${d.name} (${d.rarity})${stats ? ` — ${stats}` : ""}`));
      if (isUpgrade) {
        const up = document.createElement("span");
        up.className = "item-picker-upgrade-tag";
        up.textContent = " ▲ upgrade";
        itemBtn.append(up);
      }
      const wornBy = equippedElsewhere(inst.id, member.id);
      if (wornBy) {
        const wornDef = WORKER_DEFS_BY_ID[wornBy.defId];
        const tag = document.createElement("span");
        tag.className = "item-picker-worn-tag";
        tag.textContent = ` — worn by ${wornDef?.name ?? wornBy.defId}`;
        itemBtn.append(tag);
        itemBtn.title = `Currently equipped on ${wornDef?.name ?? wornBy.defId} — equipping it here will move it off of them.`;
      }
      if (d.effectId) {
        itemBtn.title = itemBtn.title ? `${itemBtn.title} ${ITEM_EFFECT_BLURBS[d.effectId]}` : ITEM_EFFECT_BLURBS[d.effectId];
      }
      itemBtn.addEventListener("click", () => {
        game.equipItem(member.id, inst.id, slot);
        if (mounted) renderAndFlash(mounted, member.id);
      });
      picker.append(itemBtn);
    }

    return picker;
  }

  return { render };
}
