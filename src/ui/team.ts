// Team roster panel: priority order, level up, equip. Rendered inside the
// shop overlay's #shop-list. Mirrors shop.ts's plain-DOM row-builder style.

import {
  ITEM_EFFECT_BLURBS,
  ITEM_EFFECT_LABELS,
  itemDefById,
  PROVISIONS,
  RARITY_ORDER,
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
  effectiveMaxHp,
  effectiveRarity,
  equippedItem,
  levelUpCost,
  MAX_LEVEL,
  memberClass,
  starCount,
  xpToNext,
  bestUpgradeFor,
  type ItemSlot,
  type Rarity,
  type TeamMemberSave,
} from "../team";
import { FUSION_BLOCKER_COPY, FUSION_FODDER_COUNT, type FusionPlan } from "../fusion";
import { playFusion } from "./fusion-fx";
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

/** What the right-hand pane is showing. The picker and the altar REPLACE the
 * member sheet rather than appending below it — the old picker appended, which
 * put 822px of content in a 288px pane and meant every equip decision started
 * with a scroll past the portrait, the HP bar, the XP bar and the level
 * button. */
type PaneMode = "sheet" | "picker" | "altar";

/** Roster rows are grouped by tier and collapse identical workers into one
 * stacked row. A stack is one character at one merge rank — two Rooks at rank
 * 0 stack, a Rook at rank 1 does not stack with them, because they are no
 * longer the same thing. */
interface RosterStack {
  key: string;
  members: TeamMemberSave[];
  rarity: Rarity;
}

export function createTeamPanel(game: Game): TeamPanel {
  let mode: PaneMode = "sheet";
  let openSlot: ItemSlot | "utility2" | null = null;
  let selectedMemberId: string | null = null;
  let mounted: HTMLElement | null = null;
  /** Stacks the player has opened to see the individual copies inside. */
  const expanded = new Set<string>();

  // --- altar state ---
  let altarTarget: string | null = null;
  let altarFodder: string[] = [];
  /** Set while a merge animation owns the pedestal — render() must not tear
   * the DOM out from under it (the same rule ui/gacha.ts follows for its reel
   * with `revealing`). */
  let fusing = false;

  function tierIndex(r: Rarity): number {
    return RARITY_ORDER.indexOf(r);
  }

  /** Every roster member, grouped into stacks, highest tier first and
   * strongest first within a tier. This is display order only — the ACTUAL
   * roster order (which decides who gets picked for a live chopping session)
   * is save.team's own order, set by the Sort action. */
  function rosterStacks(): RosterStack[] {
    const s = game.save;
    const byKey = new Map<string, RosterStack>();
    for (const m of s.team) {
      const rarity = effectiveRarity(m);
      const key = `${m.defId}:${m.starRank ?? 0}`;
      const stack = byKey.get(key);
      if (stack) stack.members.push(m);
      else byKey.set(key, { key, members: [m], rarity });
    }
    const stacks = [...byKey.values()];
    for (const st of stacks) st.members.sort((a, b) => b.level - a.level || a.id.localeCompare(b.id));
    stacks.sort(
      (a, b) =>
        tierIndex(b.rarity) - tierIndex(a.rarity) ||
        b.members[0].level - a.members[0].level ||
        a.key.localeCompare(b.key),
    );
    return stacks;
  }

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
   * changed. EVERY piece of panel state belongs here, not just the saved
   * ones — `openSlot` was missing for a long time, and the symptom was that
   * clicking a gear slot did nothing at all: the handler flipped the state,
   * called render(), and render() saw an unchanged key and returned. It only
   * appeared when the wood counter happened to tick a second later. */
  function renderKey(): string {
    const s = game.save;
    return [
      mode,
      openSlot ?? "",
      selectedMemberId,
      altarTarget ?? "",
      altarFodder.join(","),
      [...expanded].sort().join(","),
      s.wood,
      s.inventory.length,
      s.prestigeLevel,
      ...s.team.map(
        (m) =>
          `${m.id}:${m.defId}:${m.level}:${m.xp ?? 0}:${m.starRank ?? 0}:${m.currentHp}/${m.maxHp}:${m.status}:` +
          `${m.equipped.woodchopping ?? ""},${m.equipped.adventuring ?? ""},` +
          `${m.equipped.utility ?? ""},${m.equipped.utility2 ?? ""}`,
      ),
      ...(Object.keys(s.shards) as (keyof typeof s.shards)[]).map((r) => `${r}${s.shards[r]}`),
    ].join("|");
  }
  let lastKey: string | null = null;

  function repaint(): void {
    if (mounted) render(mounted);
  }

  function render(listEl: HTMLElement): void {
    mounted = listEl;
    if (fusing) return;

    const key = renderKey();
    if (key === lastKey && listEl.querySelector(".team-layout")) return;
    lastKey = key;

    // Both axes. The roster is a vertical column in normal mode and a
    // HORIZONTAL strip in altar mode, and only scrollTop was carried across a
    // rebuild — so every click in the altar's reserve snapped it back to the
    // first card, which is a lot of the "it jumps to the start" feeling.
    const prevRoster = listEl.querySelector(".team-roster");
    const prevScroll = prevRoster ? prevRoster.scrollTop : 0;
    const prevScrollX = prevRoster ? prevRoster.scrollLeft : 0;

    listEl.replaceChildren();
    const s = game.save;

    if (pendingSelectMemberId && s.team.some((m) => m.id === pendingSelectMemberId)) {
      selectedMemberId = pendingSelectMemberId;
      mode = "sheet";
    }
    pendingSelectMemberId = null;

    if (!selectedMemberId || !s.team.some((m) => m.id === selectedMemberId)) {
      selectedMemberId = s.team[0]?.id ?? null;
    }
    // The altar's target can be merged away or sent on a run by another
    // screen while this one sits open.
    if (altarTarget && !s.team.some((m) => m.id === altarTarget)) altarTarget = null;
    altarFodder = altarFodder.filter((id) => s.team.some((m) => m.id === id));

    listEl.append(renderHeadBar());

    const layout = document.createElement("div");
    layout.className = "team-layout";
    // In altar mode the two panes swap axis: the pedestal takes the full width
    // and the roster becomes a horizontal reserve strip beneath it. Side by
    // side, the altar got ~330x108 — not enough for five sockets, a stat
    // preview and two buttons, and the sockets were the part that scrolled.
    // The reserve is still the roster, still grouped, still clickable; it is
    // just laid out the way the Muster screen lays out its bench.
    layout.classList.toggle("altar-mode", mode === "altar");
    layout.append(renderRoster());

    const selected = s.team.find((m) => m.id === selectedMemberId);
    if (mode === "altar") {
      layout.append(renderAltar());
    } else if (selected && mode === "picker" && openSlot) {
      layout.append(renderItemPicker(selected, openSlot));
    } else if (selected) {
      layout.append(renderDetail(selected));
    } else {
      const empty = document.createElement("div");
      empty.className = "team-detail team-detail-empty shop-sub";
      empty.textContent = "No team members yet.";
      layout.append(empty);
    }

    listEl.append(layout);
    const roster = layout.querySelector<HTMLElement>(".team-roster");
    if (roster && prevScroll > 0) roster.scrollTop = prevScroll;
    if (roster && prevScrollX > 0) roster.scrollLeft = prevScrollX;
  }

  function flashPane(): void {
    const panel = mounted?.querySelector<HTMLElement>(".team-detail, .fusion-altar");
    if (!panel) return;
    panel.classList.add("flash-pulse");
    panel.addEventListener("animationend", () => panel.classList.remove("flash-pulse"), { once: true });
  }

  function renderAndFlash(): void {
    repaint();
    flashPane();
  }

  // --- head bar -----------------------------------------------------------

  /** Roster-wide actions, gathered in one bar instead of being scattered.
   * Auto-equip used to live in the Heal All row, which is a row about
   * healing. */
  function renderHeadBar(): HTMLElement {
    const s = game.save;
    const bar = document.createElement("div");
    bar.className = "team-headbar";

    const title = document.createElement("div");
    title.className = "team-headbar-title";
    title.textContent = `Roster ${s.team.length}`;
    bar.append(title);

    const actions = document.createElement("div");
    actions.className = "team-headbar-actions";

    // Heal lives here rather than in a row of its own. As a `.shop-row` with a
    // name, a blurb and a button it cost ~50px of column height to express one
    // verb — and on a 480px panel that was the difference between the altar's
    // pedestal fitting and the altar's pedestal scrolling.
    const spec = PROVISIONS.find((p) => p.id === "trailRations")!;
    const needsHeal = s.team.some((m) => m.currentHp < m.maxHp || m.status === "resting");
    const healBtn = document.createElement("button");
    healBtn.textContent = `Heal · ${abbrev(spec.cost)}`;
    healBtn.disabled = !needsHeal || s.wood < spec.cost;
    healBtn.title = !needsHeal
      ? "Everyone's already at full HP"
      : s.wood < spec.cost
        ? `Need ${abbrev(spec.cost - s.wood)} more wood`
        : `${spec.blurb} — ${abbrev(spec.cost)} wood`;
    healBtn.addEventListener("click", () => {
      game.useTrailRations();
      repaint();
    });

    const sortBtn = document.createElement("button");
    sortBtn.textContent = "Sort";
    sortBtn.title =
      "Order the roster strongest first. Roster order decides who is sent to a live chopping session.";
    sortBtn.disabled = s.team.length < 2;
    sortBtn.addEventListener("click", () => {
      game.sortRoster();
      repaint();
    });

    const autoBtn = document.createElement("button");
    autoBtn.textContent = "Auto-equip";
    autoBtn.title = "Sort the roster strongest-first, then hand out your best items in that order.";
    autoBtn.disabled = s.team.length === 0;
    autoBtn.addEventListener("click", () => {
      game.optimizeGear();
      repaint();
    });

    const altarBtn = document.createElement("button");
    altarBtn.className = "team-altar-btn";
    altarBtn.textContent = "✦ Altar";
    altarBtn.title = "Fusion Altar — spend four workers of a tier to raise a fifth to the next one.";
    altarBtn.classList.toggle("active", mode === "altar");
    altarBtn.addEventListener("click", () => {
      mode = mode === "altar" ? "sheet" : "altar";
      openSlot = null;
      repaint();
    });

    actions.append(healBtn, sortBtn, autoBtn, altarBtn);
    bar.append(actions);
    return bar;
  }

  // --- roster -------------------------------------------------------------

  function memberHasUpgrade(member: TeamMemberSave): boolean {
    const s = game.save;
    const slots: (ItemSlot | "utility2")[] = ["woodchopping", "adventuring", "utility"];
    if (game.hasPowerup("extraUtility")) slots.push("utility2");
    return slots.some((slot) => bestUpgradeFor(member, slot, s.inventory, s.team) !== null);
  }

  function portraitFor(member: TeamMemberSave, scale: number, className: string): HTMLImageElement {
    const s = game.save;
    const def = WORKER_DEFS_BY_ID[member.defId];
    // Body art is chosen by EFFECTIVE rarity, so a merged worker visibly
    // changes tier rather than only changing a number.
    const rarity = effectiveRarity(member);
    const weaponDef = equippedItem(member, "woodchopping", s.inventory);
    const weaponRarity: Rarity = weaponDef?.rarity ?? "common";
    const worldPalette = game.getWorkerPalette(s.worldIndex);
    const accent = def?.accent;
    const palette = accent ? { ...(worldPalette ?? {}), ...accent } : worldPalette;
    return memberPortrait(rarity, palette, weaponRarity, game.weaponPalette(s.worldIndex), scale, className);
  }

  /** The ★ badge. Stars encode the tier, so they and the border colour always
   * agree — the badge is there because a colour alone cannot be counted. */
  function starBadge(member: TeamMemberSave): HTMLElement {
    const el = document.createElement("span");
    const n = starCount(member);
    el.className = `team-stars rarity-${effectiveRarity(member)}`;
    el.textContent = "★".repeat(n);
    el.title = `${effectiveRarity(member)} · ${n} star${n === 1 ? "" : "s"}`;
    return el;
  }

  function renderRoster(): HTMLElement {
    const s = game.save;
    const roster = document.createElement("div");
    roster.className = "team-roster";

    // Which members the altar will accept right now, so the roster can light
    // up the legal picks instead of making the player guess and be refused.
    const altarWants = mode === "altar" ? eligibleForAltar() : null;

    let lastTier: Rarity | null = null;
    for (const stack of rosterStacks()) {
      if (stack.rarity !== lastTier) {
        lastTier = stack.rarity;
        const head = document.createElement("div");
        head.className = `team-group rarity-${stack.rarity}`;
        head.title = stack.rarity;
        // The name is wrapped so the altar's sideways strip can drop it: set
        // vertically, "**** legendary" needs 92px of a 74px strip and cropped
        // the bottom off every card behind it. The stars carry the tier on
        // their own — that is what they are for — and the colour agrees.
        const label = document.createElement("span");
        label.className = "team-group-label";
        label.textContent = stack.rarity;
        head.append(starBadge(stack.members[0]), label);
        roster.append(head);
      }
      const isOpen = expanded.has(stack.key);
      // A stack of one is just a row. A stack of many shows its best copy and
      // a count; opening it lists the copies, which matters once you are
      // choosing which of four Rooks to keep.
      if (stack.members.length === 1 || isOpen) {
        for (const m of stack.members) roster.append(rosterRow(m, stack, altarWants, stack.members.length > 1));
      } else {
        // A collapsed row STANDS FOR THE WHOLE STACK, not for copy #1. Seating
        // it used to seat that one member and then go inert: the row showed as
        // ineligible (its representative was now spoken for) and clicking
        // again just took them back off, so the other four Rooks behind it
        // were unreachable without expanding first.
        roster.append(rosterRow(stack.members[0], stack, altarWants, false, true));
      }
    }

    if (s.team.length === 0) {
      const empty = document.createElement("div");
      empty.className = "shop-sub";
      empty.textContent = "No workers yet — pull the Worker Gacha.";
      roster.append(empty);
    }
    return roster;
  }

  function rosterRow(
    member: TeamMemberSave,
    stack: RosterStack,
    altarWants: Set<string> | null,
    inExpandedStack: boolean,
    /** This row speaks for every copy in the stack, not just `member`. */
    representsStack = false,
  ): HTMLElement {
    const s = game.save;
    const def = WORKER_DEFS_BY_ID[member.defId];
    const count = stack.members.length;
    // In altar mode a stack row is a pile you draw from: the copies it can
    // still give, and the ones already standing on the pedestal.
    const pool = representsStack ? stack.members : [member];
    const free = altarWants ? pool.filter((m) => altarWants.has(m.id)) : [];
    const seated = altarWants
      ? pool.filter((m) => m.id === altarTarget || altarFodder.includes(m.id))
      : [];

    const row = document.createElement("div");
    row.className = `team-row rarity-border-${effectiveRarity(member)}`;
    row.dataset.memberId = member.id;
    row.classList.toggle("selected", member.id === selectedMemberId && mode !== "altar");
    row.classList.toggle("nested", inExpandedStack);
    if (altarWants) {
      row.classList.toggle("altar-eligible", free.length > 0);
      // Dimmed only when the pile is spent — a Rook x5 with one on the altar
      // still has four to give and must not look finished.
      row.classList.toggle("altar-seated", free.length === 0 && seated.length > 0);
    }

    row.append(portraitFor(member, 2, "team-row-portrait-img"));

    const text = document.createElement("div");
    text.className = "team-row-text";
    const nameLine = document.createElement("div");
    nameLine.className = "team-row-name";
    nameLine.textContent = def?.name ?? member.defId;
    if (member.status !== "available") {
      const dot = document.createElement("span");
      dot.className = `status-dot ${member.status}`;
      dot.title = member.status;
      nameLine.append(dot);
    }
    const statLine = document.createElement("div");
    statLine.className = "shop-sub team-row-stat";
    statLine.textContent = `Lv${member.level} · ${abbrev(Math.round(effectiveAtk(member, s.inventory, s.prestigeLevel)))} atk`;
    text.append(nameLine, statLine);
    row.append(text);

    if (memberHasUpgrade(member)) {
      const mark = document.createElement("span");
      mark.className = "team-row-upgrade";
      mark.textContent = "▲";
      mark.title = "Better gear is sitting in your bag";
      row.append(mark);
    }

    // The count badge is its own control: tapping it opens the stack, tapping
    // the row selects the worker. Two jobs, two targets, both full-height.
    if (count > 1 && !inExpandedStack) {
      const badge = document.createElement("button");
      badge.className = "team-row-count";
      badge.textContent = altarWants && seated.length > 0 ? `${seated.length}/${count}` : `×${count}`;
      badge.title =
        altarWants && seated.length > 0
          ? `${seated.length} of ${count} on the altar`
          : `${count} copies — open to pick between them`;
      badge.addEventListener("click", (e) => {
        e.stopPropagation();
        if (expanded.has(stack.key)) expanded.delete(stack.key);
        else expanded.add(stack.key);
        repaint();
      });
      row.append(badge);
    } else if (inExpandedStack) {
      const collapse = document.createElement("button");
      collapse.className = "team-row-count";
      collapse.textContent = "×";
      collapse.title = "Collapse these copies";
      collapse.addEventListener("click", (e) => {
        e.stopPropagation();
        expanded.delete(stack.key);
        repaint();
      });
      row.append(collapse);
    }

    row.addEventListener("click", () => {
      if (mode === "altar") {
        // Draw the next copy off the pile; when it is empty, put the last one
        // back, so the row stays a toggle rather than becoming a dead end.
        if (free.length > 0) seatAtAltar(free[0].id);
        else if (seated.length > 0) seatAtAltar(seated[seated.length - 1].id);
        return;
      }
      selectedMemberId = member.id;
      mode = "sheet";
      openSlot = null;
      repaint();
    });

    return row;
  }

  // --- member sheet -------------------------------------------------------

  function renderDetail(member: TeamMemberSave): HTMLElement {
    const s = game.save;
    const def = WORKER_DEFS_BY_ID[member.defId];
    const rarity = effectiveRarity(member);

    const panel = document.createElement("div");
    panel.className = "team-detail";
    panel.dataset.memberId = member.id;
    if (rarity === "epic") panel.classList.add("team-card-epic");
    else if (rarity === "legendary") panel.classList.add("team-card-legendary");

    const head = document.createElement("div");
    head.className = "team-card-head team-detail-head";
    const name = document.createElement("div");
    name.className = `rarity-${rarity} team-detail-name`;
    name.append(document.createTextNode(def?.name ?? member.defId), starBadge(member));
    head.append(name);

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

    const body = document.createElement("div");
    body.className = "team-detail-body";

    const portraitWrap = document.createElement("div");
    portraitWrap.className = "team-detail-portrait";
    portraitWrap.append(portraitFor(member, 4, "team-detail-portrait-img"));
    body.append(portraitWrap);

    const vitals = document.createElement("div");
    vitals.className = "team-vitals";

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
    vitals.append(hpBar);

    const stat = document.createElement("div");
    stat.className = "shop-sub";
    stat.textContent = `Lv${member.level} · atk ${abbrev(Math.round(effectiveAtk(member, s.inventory, s.prestigeLevel)))} · hp ${abbrev(member.currentHp)}/${abbrev(member.maxHp)}`;
    vitals.append(stat);

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
      vitals.append(xpBar);
    }
    body.append(vitals);

    // Gear as labelled ROWS. The old chips were icon-only, with what was
    // equipped conveyed by a coloured dot and whether anything better existed
    // by a bare "▲" — neither readable without hovering each one in turn.
    const gear = document.createElement("div");
    gear.className = "team-gear";
    const slotList: (ItemSlot | "utility2")[] = ["woodchopping", "adventuring", "utility"];
    if (game.hasPowerup("extraUtility")) slotList.push("utility2");
    for (const slot of slotList) {
      gear.append(renderGearRow(member, slot));
    }
    body.append(gear);

    const actions = document.createElement("div");
    actions.className = "team-actions";
    const cost = levelUpCost(member);
    const levelBtn = document.createElement("button");
    levelBtn.textContent = member.level >= MAX_LEVEL ? "Max level" : `Level · ${cost} ${rarity} shards`;
    levelBtn.disabled = member.level >= MAX_LEVEL || s.shards[rarity] < cost;
    levelBtn.title =
      member.level >= MAX_LEVEL
        ? "Already at max level"
        : s.shards[rarity] < cost
          ? `Need ${cost - s.shards[rarity]} more ${rarity} shards`
          : `Spend ${cost} ${rarity} shards to level up`;
    levelBtn.addEventListener("click", () => {
      game.levelUpMember(member.id);
      renderAndFlash();
    });
    actions.append(levelBtn);

    const altarBtn = document.createElement("button");
    altarBtn.className = "team-altar-btn";
    altarBtn.textContent = "✦ Take to the Altar";
    const check = game.fusionCheck(member.id);
    altarBtn.disabled = !check.ok;
    altarBtn.title = check.ok
      ? `Raise ${def?.name ?? "them"} to the next tier by spending four other ${rarity} workers.`
      : FUSION_BLOCKER_COPY[check.reason ?? "missing"];
    altarBtn.addEventListener("click", () => {
      altarTarget = member.id;
      altarFodder = [];
      mode = "altar";
      repaint();
    });
    actions.append(altarBtn);

    panel.append(body);
    // The actions sit OUTSIDE the scrolling body, pinned to the foot of the
    // pane. Inside it they were the first thing to fall off the bottom edge —
    // which is the same "primary action below the fold" fault the Muster
    // screen has, and it is no more acceptable here.
    panel.append(actions);
    return panel;
  }

  function renderGearRow(member: TeamMemberSave, slot: ItemSlot | "utility2"): HTMLElement {
    const s = game.save;
    const equippedDef = equippedItem(member, slot, s.inventory);
    const upgrade = bestUpgradeFor(member, slot, s.inventory, s.team);

    const row = document.createElement("button");
    row.className = "team-gear-row";
    row.classList.toggle("has-upgrade", !!upgrade);
    row.append(pixelIcon(SLOT_ICON[slot], { palette: UI_PALETTE, scale: 2 }));

    const text = document.createElement("div");
    text.className = "team-gear-text";
    const label = document.createElement("div");
    label.className = "team-gear-label";
    label.textContent = SLOT_LABEL[slot];
    const value = document.createElement("div");
    value.className = equippedDef ? `team-gear-value rarity-${equippedDef.rarity}` : "team-gear-value team-gear-empty";
    value.textContent = equippedDef ? equippedDef.name : "empty";
    text.append(label, value);
    row.append(text);

    if (upgrade) {
      const mark = document.createElement("span");
      mark.className = "team-slot-upgrade";
      mark.textContent = "▲";
      row.append(mark);
    }
    row.title = upgrade
      ? `${SLOT_LABEL[slot]}: ${equippedDef ? equippedDef.name : "empty"} — ${upgrade.name} is better and unused`
      : `${SLOT_LABEL[slot]}: ${equippedDef ? equippedDef.name : "empty"}`;
    row.addEventListener("click", () => {
      openSlot = slot;
      mode = "picker";
      repaint();
    });
    return row;
  }

  // --- item picker --------------------------------------------------------

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

  /** What equipping `d` into `slot` would actually do to this member's real
   * numbers. Measured by running the game's own stat functions over a probe
   * copy rather than by re-deriving anything here — a second formula would be
   * wrong the first time either one changed. */
  function gearDelta(
    member: TeamMemberSave,
    slot: ItemSlot | "utility2",
    instanceId: string,
  ): { atk: number; hp: number } {
    const s = game.save;
    const probe: TeamMemberSave = { ...member, equipped: { ...member.equipped, [slot]: instanceId } };
    return {
      atk:
        Math.round(effectiveAtk(probe, s.inventory, s.prestigeLevel)) -
        Math.round(effectiveAtk(member, s.inventory, s.prestigeLevel)),
      hp: effectiveMaxHp(probe, s.inventory, s.prestigeLevel) - effectiveMaxHp(member, s.inventory, s.prestigeLevel),
    };
  }

  function deltaChip(label: string, value: number): HTMLElement {
    const el = document.createElement("span");
    el.className = value > 0 ? "gear-delta up" : value < 0 ? "gear-delta down" : "gear-delta flat";
    el.textContent = `${value > 0 ? "+" : ""}${abbrev(value)} ${label}`;
    return el;
  }

  function renderItemPicker(member: TeamMemberSave, slot: ItemSlot | "utility2"): HTMLElement {
    const s = game.save;
    const panel = document.createElement("div");
    panel.className = "team-detail item-picker-pane";
    panel.dataset.memberId = member.id;

    const head = document.createElement("div");
    head.className = "team-card-head";
    const back = document.createElement("button");
    back.className = "pane-back";
    back.textContent = "‹";
    back.title = "Back to the worker";
    back.addEventListener("click", () => {
      mode = "sheet";
      openSlot = null;
      repaint();
    });
    const title = document.createElement("div");
    title.className = "team-detail-name";
    title.textContent = SLOT_LABEL[slot];
    head.append(back, title);
    panel.append(head);

    const body = document.createElement("div");
    body.className = "item-picker";

    const baseSlot: ItemSlot = slot === "utility2" ? "utility" : slot;
    const equippedId = slot === "utility2" ? (member.equipped.utility2 ?? null) : member.equipped[slot];

    if (equippedId) {
      const cur = itemDefById(s.inventory.find((i) => i.id === equippedId)?.defId ?? "");
      const unequipBtn = document.createElement("button");
      unequipBtn.className = "item-row item-row-unequip";
      unequipBtn.textContent = `Unequip ${cur?.name ?? "current"}`;
      unequipBtn.addEventListener("click", () => {
        game.unequipItem(member.id, slot);
        renderAndFlash();
      });
      body.append(unequipBtn);
    }

    // Identical items collapse into one row. The old list showed one row per
    // instance — 21 rows for 8 distinct items in a real save, most of them
    // the same sentence repeated four times.
    const owned = s.inventory.filter((inst) => {
      const d = itemDefById(inst.defId);
      if (!d || d.slot !== baseSlot) return false;
      return (
        inst.id !== member.equipped.woodchopping &&
        inst.id !== member.equipped.adventuring &&
        inst.id !== member.equipped.utility &&
        inst.id !== member.equipped.utility2
      );
    });

    if (owned.length === 0) {
      const empty = document.createElement("div");
      empty.className = "shop-sub";
      empty.textContent = "Nothing of this type in the bag — try the Item Gacha.";
      body.append(empty);
    }

    interface Group {
      def: ItemDef;
      free: string[];
      worn: { id: string; by: TeamMemberSave }[];
    }
    const groups = new Map<string, Group>();
    for (const inst of owned) {
      const d = itemDefById(inst.defId);
      if (!d) continue;
      let g = groups.get(inst.defId);
      if (!g) {
        g = { def: d, free: [], worn: [] };
        groups.set(inst.defId, g);
      }
      const by = equippedElsewhere(inst.id, member.id);
      if (by) g.worn.push({ id: inst.id, by });
      else g.free.push(inst.id);
    }

    const rows = [...groups.values()].map((g) => {
      const instId = g.free[0] ?? g.worn[0]?.id;
      return { g, instId, delta: gearDelta(member, slot, instId) };
    });
    // Upgrades first and biggest-gain first, then everything else, with
    // items that would strip a teammate last.
    rows.sort((a, b) => {
      const aFree = a.g.free.length > 0 ? 1 : 0;
      const bFree = b.g.free.length > 0 ? 1 : 0;
      return bFree - aFree || b.delta.atk - a.delta.atk || b.delta.hp - a.delta.hp;
    });

    for (const { g, instId, delta } of rows) {
      const d = g.def;
      const btn = document.createElement("button");
      btn.className = "item-row";
      const isUpgrade = delta.atk > 0 || delta.hp > 0;
      btn.classList.toggle("item-row-upgrade", isUpgrade);
      btn.classList.toggle("item-row-worn", g.free.length === 0);

      const previewMap =
        WEAPON_APPEARANCE[baseSlot][d.rarity].icon ?? WEAPON_APPEARANCE[baseSlot][d.rarity].held?.idle;
      if (previewMap) {
        btn.append(
          pixelIcon(previewMap, {
            palette: game.weaponPalette(s.worldIndex) ?? undefined,
            scale: 2,
            className: "item-picker-preview",
          }),
        );
      }

      const text = document.createElement("div");
      text.className = "item-row-text";
      const nameLine = document.createElement("div");
      nameLine.className = `item-row-name rarity-${d.rarity}`;
      const total = g.free.length + g.worn.length;
      nameLine.textContent = total > 1 ? `${d.name} ×${total}` : d.name;
      const deltaLine = document.createElement("div");
      deltaLine.className = "item-row-delta";
      // The numbers the decision actually turns on, against what is worn right
      // now — not the item's own absolute stats, which told the player nothing
      // without holding the equipped item's numbers in their head.
      if (delta.atk !== 0) deltaLine.append(deltaChip("atk", delta.atk));
      if (delta.hp !== 0) deltaLine.append(deltaChip("hp", delta.hp));
      if (delta.atk === 0 && delta.hp === 0) {
        const same = document.createElement("span");
        same.className = "gear-delta flat";
        same.textContent = d.utility ? itemStatSummary(d) : "no change";
        deltaLine.append(same);
      }
      text.append(nameLine, deltaLine);
      btn.append(text);

      if (g.free.length === 0 && g.worn.length > 0) {
        const wornDef = WORKER_DEFS_BY_ID[g.worn[0].by.defId];
        const tag = document.createElement("span");
        tag.className = "item-picker-worn-tag";
        tag.textContent = `on ${wornDef?.name ?? g.worn[0].by.defId}`;
        btn.append(tag);
        btn.title = `Equipping this takes it off ${wornDef?.name ?? "them"}.`;
      }
      const full = itemStatSummary(d);
      btn.title = [btn.title, `${d.name} (${d.rarity})`, full, d.effectId ? ITEM_EFFECT_BLURBS[d.effectId] : ""]
        .filter(Boolean)
        .join(" · ");

      btn.addEventListener("click", () => {
        game.equipItem(member.id, instId, slot);
        renderAndFlash();
      });
      body.append(btn);
    }

    panel.append(body);
    return panel;
  }

  // --- fusion altar -------------------------------------------------------

  /** Members the altar would currently accept — the target if none is chosen
   * yet, otherwise anything that could fill a sacrifice socket. */
  function eligibleForAltar(): Set<string> {
    const s = game.save;
    const out = new Set<string>();
    if (!altarTarget) {
      for (const m of s.team) if (game.fusionCheck(m.id).ok) out.add(m.id);
      return out;
    }
    const target = s.team.find((m) => m.id === altarTarget);
    if (!target) return out;
    const tier = effectiveRarity(target);
    for (const m of s.team) {
      if (m.id === altarTarget || altarFodder.includes(m.id)) continue;
      if (effectiveRarity(m) !== tier) continue;
      if (m.status !== "available") continue;
      out.add(m.id);
    }
    return out;
  }

  function seatAtAltar(memberId: string): void {
    if (!altarTarget) {
      if (game.fusionCheck(memberId).ok) {
        altarTarget = memberId;
        altarFodder = [];
        repaint();
      }
      return;
    }
    if (memberId === altarTarget) return;
    if (altarFodder.includes(memberId)) {
      altarFodder = altarFodder.filter((id) => id !== memberId);
      repaint();
      return;
    }
    if (altarFodder.length >= FUSION_FODDER_COUNT) return;
    if (!eligibleForAltar().has(memberId)) return;
    altarFodder = [...altarFodder, memberId];
    repaint();
  }

  function socket(member: TeamMemberSave | null, kind: "target" | "sacrifice", onClear: () => void): HTMLElement {
    const el = document.createElement("div");
    el.className = `fusion-socket fusion-socket-${kind}`;
    el.classList.toggle("filled", !!member);
    if (member) {
      const who = WORKER_DEFS_BY_ID[member.defId]?.name ?? member.defId;
      el.title = `${who} · Lv${member.level}`;
      el.append(portraitFor(member, 2, "fusion-socket-img"));
      const clear = document.createElement("button");
      clear.className = "fusion-socket-clear";
      clear.textContent = "×";
      clear.title = "Take them back off the altar";
      clear.addEventListener("click", (e) => {
        e.stopPropagation();
        onClear();
      });
      el.append(clear);
    } else {
      const plus = document.createElement("span");
      plus.className = "fusion-socket-plus";
      plus.textContent = "+";
      el.append(plus);
    }
    return el;
  }

  function renderAltar(): HTMLElement {
    const s = game.save;
    const panel = document.createElement("div");
    panel.className = "fusion-altar";

    const head = document.createElement("div");
    head.className = "team-card-head";
    const back = document.createElement("button");
    back.className = "pane-back";
    back.textContent = "‹";
    back.title = "Back to the roster";
    back.addEventListener("click", () => {
      mode = "sheet";
      repaint();
    });
    const title = document.createElement("div");
    title.className = "team-detail-name";
    title.textContent = "✦ Fusion Altar";
    head.append(back, title);
    panel.append(head);

    const target = s.team.find((m) => m.id === altarTarget) ?? null;
    const fodder = altarFodder.map((id) => s.team.find((m) => m.id === id) ?? null);

    const body = document.createElement("div");
    body.className = "fusion-body";

    const pedestal = document.createElement("div");
    pedestal.className = "fusion-pedestal";
    pedestal.classList.toggle("ready", !!target && altarFodder.length === FUSION_FODDER_COUNT);

    const ring = document.createElement("div");
    ring.className = "fusion-ring";
    for (let i = 0; i < FUSION_FODDER_COUNT; i++) {
      const m = fodder[i] ?? null;
      ring.append(
        socket(m, "sacrifice", () => {
          altarFodder = altarFodder.filter((id) => id !== m?.id);
          repaint();
        }),
      );
    }
    const centre = socket(target, "target", () => {
      altarTarget = null;
      altarFodder = [];
      repaint();
    });
    pedestal.append(ring, centre);
    body.append(pedestal);

    const preview = document.createElement("div");
    preview.className = "fusion-preview";
    const plan = target ? game.fusionPlan(target.id, altarFodder) : null;

    if (!target) {
      const hint = document.createElement("div");
      hint.className = "shop-sub";
      hint.textContent = "Pick the worker to raise — tap one in the roster.";
      preview.append(hint);
    } else if (!plan) {
      const need = FUSION_FODDER_COUNT - altarFodder.length;
      const have = game.fusionFodderAvailable(target.id);
      const hint = document.createElement("div");
      hint.className = "shop-sub";
      const tier = effectiveRarity(target);
      hint.textContent =
        have >= need
          ? `Choose ${need} more ${tier} worker${need === 1 ? "" : "s"} to spend.`
          : `Only ${have} spare ${tier} worker${have === 1 ? "" : "s"} available — you need ${need} more.`;
      preview.append(hint);
    } else {
      const tiers = document.createElement("div");
      tiers.className = "fusion-tier-line";
      const who = document.createElement("span");
      who.className = "fusion-who";
      who.textContent = WORKER_DEFS_BY_ID[target.defId]?.name ?? target.defId;
      tiers.append(who);
      const from = document.createElement("span");
      from.className = `rarity-${plan.fromRarity}`;
      from.textContent = `${"★".repeat(plan.before.stars)} ${plan.fromRarity}`;
      const arrow = document.createElement("span");
      arrow.className = "fusion-arrow";
      arrow.textContent = "➔";
      const to = document.createElement("span");
      to.className = `rarity-${plan.toRarity}`;
      to.textContent = `${"★".repeat(plan.after.stars)} ${plan.toRarity}`;
      tiers.append(from, arrow, to);
      preview.append(tiers);

      const refund = document.createElement("span");
      refund.className = "shop-sub fusion-refund";
      refund.textContent = `+${plan.shardRefund.amount} shards back`;
      tiers.append(refund);

      const stats = document.createElement("div");
      stats.className = "fusion-stat-line";
      stats.append(
        statRow("ATK", plan.before.atk, plan.after.atk),
        statRow("HP", plan.before.hp, plan.after.hp),
      );
      preview.append(stats);
    }
    panel.append(body);
    // The preview is pinned beside the actions, not inside the scrolling
    // body: the numbers ARE the decision, and a stat comparison you have to
    // scroll to find is a stat comparison nobody reads.
    panel.append(preview);

    const actions = document.createElement("div");
    actions.className = "fusion-actions";

    const autoBtn = document.createElement("button");
    autoBtn.textContent = "⚡ Auto-Fill";
    autoBtn.disabled = !target;
    autoBtn.title = target
      ? "Seat the cheapest spare workers of this tier — never the ones you have levelled."
      : "Pick a worker to raise first.";
    autoBtn.addEventListener("click", () => {
      if (!target) return;
      altarFodder = game.fusionAutoFill(target.id);
      repaint();
    });

    const mergeBtn = document.createElement("button");
    mergeBtn.className = "btn-primary fusion-merge";
    mergeBtn.textContent = "💥 Merge";
    mergeBtn.disabled = !plan;
    mergeBtn.title = plan
      ? `Spend ${FUSION_FODDER_COUNT} workers to raise this one to ${plan.toRarity}.`
      : !target
        ? "Pick a worker to raise first."
        : `Fill all ${FUSION_FODDER_COUNT} sockets to merge.`;
    mergeBtn.addEventListener("click", () => {
      if (!plan) return;
      void runFusion(panel, plan);
    });

    actions.append(autoBtn, mergeBtn);
    panel.append(actions);
    return panel;
  }

  function statRow(label: string, before: number, after: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "fusion-stat-row";
    const name = document.createElement("span");
    name.className = "fusion-stat-label";
    name.textContent = label;
    const from = document.createElement("span");
    from.textContent = abbrev(before);
    const arrow = document.createElement("span");
    arrow.className = "fusion-arrow";
    arrow.textContent = "➔";
    const to = document.createElement("span");
    to.className = "fusion-stat-after";
    to.textContent = abbrev(after);
    const delta = document.createElement("span");
    delta.className = "gear-delta up";
    delta.textContent = `+${abbrev(after - before)} ▲`;
    row.append(name, from, arrow, to, delta);
    return row;
  }

  /** Plays the merge, then commits it.
   *
   * `fusing` freezes render() for the duration so the 1s shop refresh cannot
   * tear the pedestal out mid-animation — the same guard ui/gacha.ts uses for
   * its reel. The commit happens at the moment of impact rather than at the
   * end, so a player who clicks through the animation never waits on it. */
  async function runFusion(panel: HTMLElement, plan: FusionPlan): Promise<void> {
    fusing = true;
    try {
      await playFusion(panel, plan, () => {
        game.fuseMembers(plan);
      });
    } finally {
      fusing = false;
      altarFodder = [];
      // Stay on the altar with the upgraded worker still seated — the result
      // is the reward, and bouncing straight back to the roster would hide it.
      lastKey = null;
      repaint();
      flashPane();
    }
  }

  return { render };
}
