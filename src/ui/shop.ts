// Shop overlay: Team / Gacha / Gnomes / Boosts / Style tabs. Team and Gacha
// are rendered by their own panel modules (ui/team.ts, ui/gacha.ts); the
// rest render straight from the economy tables here. All purchases route
// through Game methods, which own the save.

import {
  amberTradeCost,
  BOOSTS,
  buildableCost,
  BUILDABLES,
  canOwnMore,
  type CosmeticSpec,
  COSMETICS,
  COTTAGE_PHASE_NAME,
  DYE_SWATCHES,
  dyedPalette,
  getWorld,
  HELPERS,
  ownedCount,
  PROVISIONS,
  SAP_PRESS_AMBER_YIELD,
  unlockedSwatches,
} from "../economy";
import { abbrev } from "../scene/floating-text";
import type { Game } from "../scene/game";
import {
  AMBER_GEM,
  BUILDABLE_SPRITES,
  COSMETIC_ITEM_ICON,
  COTTAGE_P3 as COTTAGE_ICON,
  SAP_PRESS_IDLE,
  drawSprite,
  LOG,
  type PixelMap,
  spriteSize,
  withPalette,
} from "../scene/sprites";
import { BOOST_ICON, DYE_POT, HELPER_ICON, PROVISION_ICON, UI_PALETTE } from "../scene/ui-icons";
import { createGachaPanel } from "./gacha";
import { closeOtherOverlays, registerOverlay } from "./overlay-coordinator";
import { pixelIcon, pixelIconComposite } from "./pixel-icon";
import { createTeamPanel } from "./team";

type Tab = "team" | "gacha" | "helpers" | "boosts" | "provisions" | "build" | "style";

/** Reads the overlay's open/closed state straight from the DOM rather than
 * initShop()'s closure, so main.ts's per-frame syncTakeover() can call it
 * without caring about init order (mirrors game.isPovActive()/
 * isBattleViewOpen(), which are similarly free functions/methods, not
 * closure-captured state). */
export function isShopOpen(): boolean {
  const el = document.getElementById("shop");
  return !!el && !el.classList.contains("hidden");
}

export function initShop(game: Game): void {
  const overlay = document.getElementById("shop")!;
  const openBtn = document.getElementById("shop-btn")!;
  const closeBtn = document.getElementById("shop-close")!;
  const listEl = document.getElementById("shop-list")!;
  const woodEl = document.getElementById("shop-wood")!;
  const tabBtns = Array.from(
    document.querySelectorAll<HTMLButtonElement>("#shop-tabs button"),
  );

  const teamPanel = createTeamPanel(game);
  const gachaPanel = createGachaPanel(game);

  let tab: Tab = "team";
  let refreshTimer: number | null = null;
  /** Which cosmetic's dye tray is open on the Style tab, if any. */
  let dyeOpenId: string | null = null;

  /** 2-column card-tile builder for the Gnomes/Boosts/Provisions/Style tabs
   * (Part C.5) — replaces the old flat row() list. Each tab still computes
   * exactly the same (label, sub, action) data it always did; this just
   * lays it out as a card (icon centered up top, name, sub-text, then a
   * full-width action button pinned to the bottom) instead of a flat row,
   * and optionally tags the card with an owned/equipped/locked class so
   * that state reads at a glance instead of only via the button's text.
   * `icon` is still the tab's own nav icon (§B.2), just rendered bigger and
   * centered instead of small-inline-with-text. */
  function card(
    label: string,
    sub: string,
    action: { text: string; enabled: boolean; onClick?: () => void } | null,
    // Every tab but Style passes a plain nav-icon PixelMap, rendered through
    // the shared UI_PALETTE below. Style instead passes a ready-made image
    // (see cosmeticIcon()) — it needs the cosmetic's OWN palette, not
    // UI_PALETTE, so it builds its icon itself and hands the <img> straight
    // through.
    icon: PixelMap | HTMLImageElement,
    state?: "owned" | "equipped" | "locked",
  ): HTMLElement {
    const el = document.createElement("div");
    el.className = "shop-card";
    if (state) el.classList.add(state);

    const iconWrap = document.createElement("div");
    iconWrap.className = "shop-card-icon";
    iconWrap.append(
      Array.isArray(icon) ? pixelIcon(icon, { palette: UI_PALETTE, scale: 3 }) : icon,
    );
    el.append(iconWrap);

    const name = document.createElement("div");
    name.className = "shop-card-name";
    name.textContent = label;
    el.append(name);

    const blurb = document.createElement("div");
    blurb.className = "shop-card-sub shop-sub";
    blurb.textContent = sub;
    el.append(blurb);

    if (action) {
      const btn = document.createElement("button");
      btn.className = "shop-card-btn";
      btn.textContent = action.text;
      btn.disabled = !action.enabled;
      if (action.onClick) {
        btn.addEventListener("click", () => {
          action.onClick!();
          renderList();
          // Brief "that worked" confirmation on the wood/amber readout —
          // it's the one piece of chrome every purchase actually changes
          // and, unlike the card itself, isn't torn down/rebuilt by renderList().
          woodEl.classList.remove("flash-pulse");
          void woodEl.offsetWidth; // restart the animation from scratch
          woodEl.classList.add("flash-pulse");
        });
      }
      el.append(btn);
    }
    return el;
  }

  /** Style tab's per-card icon: the ITEM, on its own.
   *
   * This used to draw a whole woodcutter for a cap and a whole tree for a tree
   * skin, which buried the thing being bought — a cap is two pixels of `C` in
   * WC_STAND, and Silver Birch (a trunk-only recolor) previewed with a big
   * green canopy it never touches. COSMETIC_ITEM_ICON (scene/sprites.ts) gives
   * each cosmetic a standalone portrait instead, with `crop` trimming a canopy
   * skin down to just the canopy.
   *
   * The cache key MUST carry the chosen dye: pixelIconComposite's cache is a
   * plain Map that is never evicted, so a key of just `cosmetic:<id>` would
   * serve the pre-dye image forever after a recolor.
   */
  function cosmeticIcon(cos: CosmeticSpec, color: string | null): HTMLImageElement {
    const { map, crop } = COSMETIC_ITEM_ICON[cos.id];
    const { w, h } = spriteSize(map);
    const drawH = crop ?? h;
    const palette = dyedPalette(cos, color ?? undefined);
    return pixelIconComposite(
      `cosmetic:${cos.id}:${color ?? "default"}`,
      w,
      drawH,
      (ctx) => withPalette(palette, () => drawSprite(ctx, map, 0, 0)),
      { scale: 3 },
    );
  }

  /** One dye pot. Routed through pixelIcon (not pixelIconComposite) because
   * pixelIconUrl already keys its cache on the palette, so per-color caching
   * is correct for free. */
  function dyePot(hex: string, className: string): HTMLImageElement {
    return pixelIcon(DYE_POT, {
      palette: { ...UI_PALETTE, Z: hex },
      scale: 3,
      className,
    });
  }

  /** The dye tray for the currently selected cosmetic — a full-width panel
   * below the card grid (the grid is 2-column, so a 16-pot swatch grid cannot
   * live inside a card). Mirrors the tile-grid + detail-panel shape the Team
   * tab already uses. */
  function dyeTray(cos: CosmeticSpec): HTMLElement {
    const current = game.cosmeticColor(cos.id);
    const tray = document.createElement("div");
    tray.className = "dye-tray";

    const head = document.createElement("div");
    head.className = "dye-tray-head";
    const preview = document.createElement("div");
    preview.className = "dye-tray-preview";
    preview.append(cosmeticIcon(cos, current));
    const title = document.createElement("div");
    title.className = "dye-tray-title";
    title.textContent = `Dye ${cos.name}`;
    head.append(preview, title);
    tray.append(head);

    const unlocked = unlockedSwatches(cos);
    const unlockedIds = new Set(unlocked.map((sw) => sw.id));
    const grid = document.createElement("div");
    grid.className = "dye-grid";
    for (const sw of DYE_SWATCHES) {
      const open = unlockedIds.has(sw.id);
      const btn = document.createElement("button");
      btn.className = "dye-pot";
      btn.classList.toggle("selected", current === sw.hex);
      btn.classList.toggle("locked", !open);
      btn.disabled = !open;
      btn.append(dyePot(sw.hex, "dye-pot-icon"));
      if (open) {
        btn.title = sw.name;
        btn.setAttribute("aria-label", `Dye ${cos.name} ${sw.name}`);
        btn.setAttribute("aria-pressed", String(current === sw.hex));
        btn.addEventListener("click", () => {
          // Clicking the active dye clears it, back to the shipped colors.
          game.setCosmeticColor(cos.id, current === sw.hex ? null : sw.hex);
          renderList();
        });
      } else {
        // Name the cheapest cap that unlocks this dye — the locked pots are
        // the pitch for the pricier caps, so say what buys them.
        const unlocker = COSMETICS.filter((c) => c.kind === cos.kind)
          .sort((a, b) => a.cost - b.cost)
          .find((c) => unlockedSwatches(c).some((u) => u.id === sw.id));
        btn.title = unlocker ? `${sw.name} — unlocked by ${unlocker.name}` : sw.name;
        btn.setAttribute("aria-label", btn.title);
      }
      grid.append(btn);
    }
    tray.append(grid);

    if (current) {
      const reset = document.createElement("button");
      reset.className = "dye-reset";
      reset.textContent = "Reset to original";
      reset.addEventListener("click", () => {
        game.setCosmeticColor(cos.id, null);
        renderList();
      });
      tray.append(reset);
    }
    return tray;
  }

  /** Wraps a tab's cards in the shared 2-column grid container. */
  function grid(cards: HTMLElement[]): HTMLElement {
    const el = document.createElement("div");
    el.className = "shop-grid";
    el.append(...cards);
    return el;
  }

  function renderList(): void {
    const s = game.save;
    const woodIcon = pixelIcon(LOG, { scale: 1, className: "shop-currency-icon" });
    const amberIcon = pixelIcon(AMBER_GEM, { scale: 1, className: "shop-currency-icon" });
    woodEl.replaceChildren(
      woodIcon,
      document.createTextNode(` wood: ${abbrev(s.wood)} · `),
      amberIcon,
      document.createTextNode(` amber: ${abbrev(s.amber)}`),
    );

    if (tab === "team") {
      teamPanel.render(listEl);
      return;
    }
    if (tab === "gacha") {
      gachaPanel.render(listEl);
      return;
    }

    listEl.replaceChildren();
    if (tab === "helpers") {
      const cards: HTMLElement[] = [];
      for (const helper of HELPERS) {
        const owned = (s.helpers as string[]).includes(helper.id);
        const gated = helper.requires && !(s.helpers as string[]).includes(helper.requires);
        const icon = HELPER_ICON[helper.id];
        if (owned) {
          cards.push(card(helper.name, helper.blurb, { text: "owned", enabled: false }, icon, "owned"));
        } else if (gated) {
          cards.push(
            card(
              helper.name,
              `${helper.blurb} · requires ${helper.requires}`,
              { text: "locked", enabled: false },
              icon,
              "locked",
            ),
          );
        } else {
          cards.push(
            card(
              helper.name,
              `${helper.blurb} · ${abbrev(helper.cost)} wood`,
              {
                text: "Buy",
                enabled: s.wood >= helper.cost,
                onClick: () => void game.buyHelper(helper.id),
              },
              icon,
            ),
          );
        }
      }
      listEl.append(grid(cards));
    } else if (tab === "boosts") {
      const cards: HTMLElement[] = [];
      for (const boost of BOOSTS) {
        const gated = boost.id === "espresso" && !(s.helpers as string[]).includes("gnome1");
        // Amber Trade's cost scales with world tier to match its scaling
        // wood payout (see amberTradeCost) — every other boost stays flat.
        const cost = boost.id === "amberWood" ? amberTradeCost(getWorld(s.worldIndex).mult) : boost.cost;
        const icon = BOOST_ICON[boost.id];
        if (gated) {
          cards.push(
            card(
              boost.name,
              `${boost.blurb} · needs a gnome`,
              { text: "locked", enabled: false },
              icon,
              "locked",
            ),
          );
        } else {
          cards.push(
            card(
              boost.name,
              `${boost.blurb} · ${abbrev(cost)} amber`,
              {
                text: "Use",
                enabled: s.amber >= cost,
                onClick: () => void game.buyBoost(boost.id),
              },
              icon,
            ),
          );
        }
      }
      listEl.append(grid(cards));
    } else if (tab === "provisions") {
      const cards: HTMLElement[] = [];
      for (const prov of PROVISIONS) {
        const icon = PROVISION_ICON[prov.id];
        if (prov.instant) {
          cards.push(
            card(
              prov.name,
              `${prov.blurb} · ${abbrev(prov.cost)} wood`,
              {
                text: "Use",
                enabled: s.wood >= prov.cost,
                onClick: () => void game.useTrailRations(),
              },
              icon,
            ),
          );
        } else {
          const owned = s.provisions[prov.id] ?? 0;
          cards.push(
            card(
              prov.name,
              `${prov.blurb} · ${abbrev(prov.cost)} amber · owned ${owned}`,
              {
                text: "Buy",
                enabled: s.amber >= prov.cost,
                onClick: () => void game.buyProvision(prov.id),
              },
              icon,
              owned > 0 ? "owned" : undefined,
            ),
          );
        }
      }
      listEl.append(grid(cards));
    } else if (tab === "build") {
      const mult = getWorld(s.worldIndex).mult;
      const cards: HTMLElement[] = [];

      // The cottage itself is NOT purchasable here. It's raised by walking up
      // and clicking it in the world — building your own house through a shop
      // menu undercuts the whole point of it being a place you go to. The tab
      // reports its progress so the Build screen still tells the whole story.
      const placedCount = (s.placed ?? []).length;
      const phase = game.cottagePhase();
      const nextCost = game.cottageNextCost();
      const cottageLine = document.createElement("div");
      cottageLine.className = "build-cottage-line";
      cottageLine.textContent =
        nextCost === null
          ? "Cottage complete — your homestead is finished."
          : `Cottage · stage ${phase + 1}/3 (${COTTAGE_PHASE_NAME[phase]}) · ${abbrev(nextCost)} wood — click the cottage in the clearing to build it.`;
      listEl.append(cottageLine);

      // The barn appears only once the cottage is done — a second unbuilt shell
      // alongside the first reads as clutter rather than progression.
      if (game.barnAvailable()) {
        const barnCost = game.barnNextCost();
        const barnLine = document.createElement("div");
        barnLine.className = "build-cottage-line";
        barnLine.textContent =
          barnCost === null
            ? "Barn complete — the homestead is fully built."
            : `Barn · stage ${game.barnPhase() + 1}/2 · ${abbrev(barnCost)} wood — click the barn in the clearing to raise it.`;
        listEl.append(barnLine);
      }

      // Sap Press — a one-off structure that converts wood into amber. Bought
      // here, then it stands in the clearing and is used by clicking it.
      if (!game.sapPressOwned()) {
        const spCost = game.sapPressPurchaseCost();
        cards.push(
          card(
            "Sap Press",
            `Crush wood into amber, forever · ${abbrev(spCost)} wood`,
            {
              text: "Build",
              enabled: s.wood >= spCost,
              onClick: () => void game.buySapPress(),
            },
            SAP_PRESS_IDLE,
          ),
        );
      } else {
        cards.push(
          card(
            "Sap Press",
            `Built · click it in the clearing to press ${abbrev(SAP_PRESS_AMBER_YIELD)} amber`,
            { text: "built", enabled: false },
            SAP_PRESS_IDLE,
            "owned",
          ),
        );
      }

      const yardFull = game.yardIsFull();
      for (const b of BUILDABLES) {
        const cost = buildableCost(b, mult);
        const owned = ownedCount(s.placed, b.id);
        const maxed = !canOwnMore(s.placed, b);
        // Landmarks read as "built / not built"; repeat decorations show how
        // many of the allowance you've used, because that's the number you
        // actually care about when arranging a row of them.
        const countText = b.unique
          ? owned > 0
            ? " · built"
            : " · one only"
          : ` · ${owned}/${b.maxOwned}`;
        cards.push(
          card(
            b.name,
            `${b.blurb} · ${abbrev(cost)} wood${countText}`,
            {
              // Arms placement rather than buying: the shop closes and the
              // player picks the cell. Nothing is charged until they drop it,
              // so opening the placer and backing out costs nothing.
              text: maxed ? (b.unique ? "built" : "max") : yardFull ? "yard full" : "Place",
              enabled: !maxed && !yardFull && s.wood >= cost,
              onClick: () => {
                if (game.beginPlacing(b.id)) close();
              },
            },
            BUILDABLE_SPRITES[b.id] ?? COTTAGE_ICON,
            maxed ? "owned" : owned > 0 ? "equipped" : undefined,
          ),
        );
      }
      listEl.append(grid(cards));

      const hint = document.createElement("div");
      hint.className = "shop-sub build-hint";
      hint.textContent = yardFull
        ? "The yard is full — raise the cottage to expand the plot."
        : `${game.freeYardCells().length} free plots · ${placedCount} built · click a plot to place, Esc to cancel, click a built item to move it`;
      listEl.append(hint);
    } else {
      const cards: HTMLElement[] = [];
      for (const cos of COSMETICS) {
        const owned = (s.cosmetics as string[]).includes(cos.id);
        const equipped = s.equippedCap === cos.id || s.equippedTreeSkin === cos.id;
        const color = game.cosmeticColor(cos.id);
        if (owned) {
          const el = card(
            cos.name,
            cos.kind === "cap" ? "cap" : "tree skin",
            {
              text: equipped ? "unequip" : "equip",
              enabled: true,
              onClick: () => game.equipCosmetic(cos.id),
            },
            cosmeticIcon(cos, color),
            equipped ? "equipped" : "owned",
          );
          // Second action on owned cards: open this cosmetic's dye tray. It's a
          // toggle so the tray can be dismissed without leaving the tab.
          const dyeBtn = document.createElement("button");
          dyeBtn.className = "shop-card-btn dye-open";
          dyeBtn.textContent = dyeOpenId === cos.id ? "Close dyes" : "Dye";
          dyeBtn.setAttribute("aria-expanded", String(dyeOpenId === cos.id));
          dyeBtn.addEventListener("click", () => {
            dyeOpenId = dyeOpenId === cos.id ? null : cos.id;
            renderList();
          });
          el.append(dyeBtn);
          cards.push(el);
        } else {
          cards.push(
            card(
              cos.name,
              `${cos.kind === "cap" ? "cap" : "tree skin"} · ${abbrev(cos.cost)} wood`,
              {
                text: "Buy",
                enabled: s.wood >= cos.cost,
                onClick: () => void game.buyCosmetic(cos.id),
              },
              cosmeticIcon(cos, color),
            ),
          );
        }
      }
      listEl.append(grid(cards));

      // Dye tray hangs below the grid, full width — 16 pots don't fit in a
      // 2-column card. Guarded on ownership so selling/prestige can't strand
      // an open tray on something the player no longer has.
      const open = COSMETICS.find(
        (c) => c.id === dyeOpenId && (s.cosmetics as string[]).includes(c.id),
      );
      if (open) {
        listEl.append(dyeTray(open));
      } else if (dyeOpenId) {
        dyeOpenId = null;
      }
    }
  }

  function open(): void {
    if (game.isBattleViewOpen() || game.isPovActive()) return; // that view owns the screen
    closeOtherOverlays("shop");
    overlay.classList.remove("hidden");
    renderList();
    refreshTimer = window.setInterval(renderList, 1000);
  }

  function close(): void {
    overlay.classList.add("hidden");
    if (refreshTimer !== null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  registerOverlay("shop", close);

  openBtn.addEventListener("click", () => {
    if (overlay.classList.contains("hidden")) {
      open();
    } else {
      close();
    }
  });
  closeBtn.addEventListener("click", close);
  for (const btn of tabBtns) {
    btn.addEventListener("click", () => {
      tab = btn.dataset.tab as Tab;
      for (const b of tabBtns) {
        b.classList.toggle("active", b === btn);
      }
      renderList();
    });
  }
}
