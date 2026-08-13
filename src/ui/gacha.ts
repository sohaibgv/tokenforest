// Gacha pull screen (Worker / Item / Power-up), rendered inside the shop
// overlay's #shop-list. Mirrors shop.ts's plain-DOM row-builder style, with
// its own self-contained closure state (mirrors shop.ts one level deeper).
//
// Pulls resolve instantly (see ../gacha.ts) — the reel animation below is a
// pure reveal of an already-decided outcome, not a live spin.

import {
  CURATED_WORLD_THEMES,
  itemDefsForWorld,
  itemGachaCost,
  itemGachaCost10x,
  ITEM_PITY_THRESHOLD,
  POWERUP_GACHA_COST,
  POWERUP_GACHA_COST_10X,
  POWERUP_PITY_THRESHOLD,
  POWERUPS,
  RARITY_ORDER,
  RARITY_WEIGHTS,
  WORKER_DEFS,
  WORKER_GACHA_COST,
  WORKER_GACHA_COST_10X,
  WORKER_PITY_THRESHOLD,
  WORKER_RARITY_MULT,
  type ItemDef,
  type PowerupSpec,
  type WorkerDef,
} from "../economy";
import type { WorkerPullResult } from "../gacha";
import { abbrev } from "../scene/floating-text";
import { drawMachine, MACHINE_H, MACHINE_W, type MachineKind } from "../scene/gacha-machine";
import type { Game } from "../scene/game";
import { POWERUP_ICON, UI_PALETTE } from "../scene/ui-icons";
import { WEAPON_APPEARANCE } from "../scene/weapons";
import { playCaseOpening, type CaseCard } from "./case-opening";
import { pixelIconComposite, pixelIconCompositeUrl, pixelIconUrl } from "./pixel-icon";
import { itemStatSummary, PORTRAIT_H, PORTRAIT_W, workerPortraitDraw } from "./team";

/** Brief pause between reels in a ×10 sequence so each result is readable
 * before the next one starts spinning. */
const BETWEEN_PULLS_MS = 350;

export type GachaKind = "worker" | "item" | "powerup";

interface RowAction {
  text: string;
  enabled: boolean;
  onClick?: () => void;
  /** Shown as a native tooltip — used to explain *why* a disabled action is
   * disabled (RARITY_WEIGHTS-driven odds are otherwise invisible; likewise
   * an unaffordable Pull just looks broken without a reason). */
  title?: string;
  /** Marks this screen's highest-stakes action (Pull ×1/×10) so it renders
   * with the same bordered emphasis as #travel/#prestige-btn instead of
   * looking identical to every other row's minor action. */
  primary?: boolean;
}

export interface GachaPanel {
  render: (listEl: HTMLElement) => void;
}

/** "70% Common · 22% Rare · 7% Epic · 1% Legendary" — derived from
 * RARITY_WEIGHTS (economy.ts) rather than hardcoded, so it can never drift
 * from the actual roll. */
function oddsLine(): string {
  const total = RARITY_ORDER.reduce((sum, r) => sum + RARITY_WEIGHTS[r], 0);
  return RARITY_ORDER.map((r) => {
    const pct = (100 * RARITY_WEIGHTS[r]) / total;
    const pctText = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
    return `${pctText}% ${r[0].toUpperCase()}${r.slice(1)}`;
  }).join(" · ");
}

/** Real stat numbers for a pulled worker/item, shown at pull-reveal time
 * (not just name + rarity) — e.g. "atk ×3 / hp ×2" or "+18k atk". */
function workerStatLine(def: WorkerDef): string {
  const mult = WORKER_RARITY_MULT[def.rarity];
  return `atk ×${mult.atk} / hp ×${mult.hp}`;
}

/** Worker reel card art: the same rarity-tier body + held-Woodchopping-
 * weapon composite Team's portrait grid uses (team.ts's workerPortraitDraw,
 * Part C.2), tinted with the player's CURRENT world palette AND this
 * character's own per-character accent (economy.ts's WorkerDef.accent,
 * Part E.4) — merged in the same order as every other accent call site
 * (world palette first, accent spread last so it can never be clobbered by
 * it, though in practice the two never touch the same letters). Weapon
 * defaults to common-tier, same "never bare-handed" convention the Team
 * portrait/live scenes use for a filler/unequipped Woodchopping slot. */
function workerCard(def: WorkerDef, game: Game): CaseCard {
  const worldPalette = game.getWorkerPalette(game.save.worldIndex);
  const mergedPalette = def.accent ? { ...(worldPalette ?? {}), ...def.accent } : worldPalette;
  const { key, draw } = workerPortraitDraw(def.rarity, mergedPalette, "common", game.weaponPalette(game.save.worldIndex));
  const iconUrl = pixelIconCompositeUrl(key, PORTRAIT_W, PORTRAIT_H, draw);
  return { label: def.name, sub: `${def.rarity} · ${workerStatLine(def)}`, rarity: def.rarity, iconUrl };
}

/** The worker reveal's second line.
 *
 * A repeat pull is no longer a consolation prize, so it must not read like
 * one: the copy joins the roster and is a quarter of a merge. The old
 * "dupe → N shards" wording now only applies past MAX_COPIES_PER_WORKER,
 * where the pull genuinely does melt down again. Powerups keep the original
 * wording throughout — they still have no use for a second copy. */
function workerSub(base: CaseCard, r: WorkerPullResult): string {
  if (r.isNew) {
    const copies = r.copiesHeld ?? 1;
    return copies > 1 ? `${base.sub} · copy ${copies} — altar fodder` : base.sub;
  }
  return `${base.sub} · roster full → ${r.shardsGained ?? 0} shards`;
}

/** Item reel card art: WEAPON_APPEARANCE's dedicated `.icon` (Utility
 * charms) or its held idle pose (Woodchopping/Adventuring, which have no
 * separate icon asset — Part D deliberately reuses one PixelMap at
 * multiple draw scales), tinted with the item's OWN bound world (ItemDef.
 * world), matching how the Item gacha pool itself is always world-scoped. */
function itemIconMap(def: ItemDef) {
  const visual = WEAPON_APPEARANCE[def.slot][def.rarity];
  return visual.icon ?? visual.held!.idle;
}
function itemCard(def: ItemDef, game: Game): CaseCard {
  // Shares its stat formatting with the equip picker (ui/team.ts) so a
  // pull's reveal card and its later listing there can never drift apart.
  const stat = itemStatSummary(def);
  const iconUrl = pixelIconUrl(itemIconMap(def), game.weaponPalette(def.world) ?? undefined);
  return { label: def.name, sub: stat ? `${def.slot} · ${stat}` : def.slot, rarity: def.rarity, iconUrl };
}

function powerupCard(spec: PowerupSpec): CaseCard {
  const iconUrl = pixelIconUrl(POWERUP_ICON[spec.id], UI_PALETTE);
  return { label: spec.name, sub: `${spec.rarity} · ${spec.blurb}`, rarity: spec.rarity, iconUrl };
}

export function createGachaPanel(game: Game): GachaPanel {
  let kind: GachaKind = "worker";
  let itemWorld = 0;
  let mounted: HTMLElement | null = null;
  /** Set while a case-opening reel owns the DOM — the periodic shop refresh
   * must not rebuild the panel mid-animation (same pattern as adventure.ts's
   * checkPending for its Defend skill-check widget). */
  let revealing = false;
  /** The current render() pass's machine glass-window element (see
   * machineSlot() below) — revealSingle/revealTen mount the case-opening
   * reel directly into this instead of tearing down and rebuilding the
   * whole panel per pull, so the machine illustration + hero row/nav now
   * stay visible and in place throughout a reveal. */
  let currentMachineWindow: HTMLElement | null = null;
  /** The current render() pass's outer .gacha-machine-slot — toggled with
   * .gacha-tray-glow at landing (see revealSingle/revealTen). */
  let currentMachineSlot: HTMLElement | null = null;
  /** The current render() pass's .gacha-control-bar (pity/odds + pull
   * buttons, mounted below the machine — see machineSlot()'s caller in each
   * render() branch). revealSingle/revealTen append the "Pull i/10" progress
   * readout and the Skip button here instead of as standalone #shop-list
   * children, so the control bar's footprint stays identical between idle
   * and reveal states and the layout never jumps. */
  let currentControlBar: HTMLElement | null = null;

  function row(label: string, sub: string, action: RowAction | null): HTMLElement {
    const el = document.createElement("div");
    el.className = "shop-row";
    const info = document.createElement("div");
    info.className = "shop-info";
    const name = document.createElement("div");
    name.textContent = label;
    const blurb = document.createElement("div");
    blurb.className = "shop-sub";
    blurb.textContent = sub;
    info.append(name, blurb);
    el.append(info);
    if (action) {
      const btn = document.createElement("button");
      btn.textContent = action.text;
      btn.disabled = !action.enabled;
      if (action.primary) btn.classList.add("btn-primary");
      if (action.title) btn.title = action.title;
      if (action.onClick) {
        btn.addEventListener("click", () => {
          action.onClick!();
          if (mounted) render(mounted);
        });
      }
      el.append(btn);
    }
    return el;
  }

  /** Builds the Part E gacha machine illustration + its glass-window
   * overlay (scene/gacha-machine.ts owns the actual drawn art + the exact
   * transparent region documented there). `windowEl` is where
   * revealSingle/revealTen mount the case-opening reel directly behind the
   * glass — see MACHINE_WINDOW_PCT / .gacha-machine-window in styles.css
   * for how the two stay pixel-aligned. Rendered via pixel-icon.ts's
   * composite pipeline (same technique Team's portrait grid uses), so the
   * expensive draw pass is cached and only re-runs when the (kind,
   * brass-tint) key actually changes — not on every 1s panel refresh. */
  function machineSlot(machineKind: MachineKind, brass: Record<string, string> | null): { el: HTMLElement; windowEl: HTMLElement } {
    const el = document.createElement("div");
    el.className = "gacha-machine-slot";
    el.dataset.gachaMachineSlot = "";
    const frame = document.createElement("div");
    frame.className = "gacha-machine-frame";
    const windowEl = document.createElement("div");
    windowEl.className = "gacha-machine-window";
    const key = `machine:${machineKind}:${JSON.stringify(brass)}`;
    const img = pixelIconComposite(key, MACHINE_W, MACHINE_H, (ctx) => drawMachine(ctx, machineKind, brass), {
      className: "gacha-machine-img",
    });
    // DOM order matters here (not just CSS): the reel window comes first so
    // the machine <img> — with its own drawn pixels genuinely transparent
    // right over the glass rect — stacks on top of it by default, and the
    // img's pointer-events:none (styles.css) lets clicks/scroll on the reel
    // underneath through regardless.
    frame.append(windowEl, img);
    el.append(frame);
    return { el, windowEl };
  }

  /** A prominent full-width Pull ×1/×10 pill — reuses the existing
   * .btn-primary treatment (see #travel/#prestige-btn/Team's Heal All),
   * standing alone rather than wrapped in a .shop-row's label+sub+inline-
   * button layout, per the control bar's pity/odds/pull-buttons stack below
   * the machine. Mirrors row()'s own click-then-
   * render semantics (render() no-ops while a reveal owns the DOM — see
   * `revealing` above). Also guards against double-pulling and plays a
   * quick ~150ms "lever pulled" tactile pulse (Part E.5) right at click
   * time, before the actual pull/reveal flow starts. */
  function pullButton(
    text: string,
    enabled: boolean,
    title: string | undefined,
    onClick: () => void,
  ): HTMLElement {
    const btn = document.createElement("button");
    btn.className = "btn-primary";
    btn.textContent = text;
    btn.disabled = !enabled;
    if (title) btn.title = title;
    btn.addEventListener("click", () => {
      if (revealing) return;
      btn.classList.add("machine-lever-pulse");
      window.setTimeout(() => btn.classList.remove("machine-lever-pulse"), 150);
      onClick();
      if (mounted) render(mounted);
    });
    return btn;
  }

  function navRow(
    options: { label: string; active: boolean; disabled?: boolean; title?: string; onClick: () => void }[],
  ): HTMLElement {
    const nav = document.createElement("div");
    nav.className = "gacha-nav";
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.textContent = opt.label;
      btn.classList.toggle("active", opt.active);
      btn.disabled = !!opt.disabled;
      if (opt.title) btn.title = opt.title;
      btn.addEventListener("click", opt.onClick);
      nav.append(btn);
    }
    return nav;
  }

  /** Ends a reveal: restores the normal panel after a short beat so the
   * player has a moment to read the final result. */
  function finishReveal(listEl: HTMLElement, holdMs: number): void {
    window.setTimeout(() => {
      revealing = false;
      render(listEl);
    }, holdMs);
  }

  /** A "Skip ▶▶" button that snaps the given reel handle straight to its
   * landing — lets the player fast-forward a single spin, or click through
   * a ×10 sequence quickly instead of waiting out every reel. */
  function skipButton(onClick: () => void): HTMLElement {
    const btn = document.createElement("button");
    btn.className = "case-skip-btn";
    btn.textContent = "Skip ▶▶";
    btn.addEventListener("click", onClick);
    return btn;
  }

  /** Briefly flashes .gacha-tray-glow on the current machine slot — the
   * landing-moment flourish (Part E.5), gated on the reel's own existing
   * `finished` promise rather than any new timing logic. */
  function flashTray(): void {
    const slot = currentMachineSlot;
    if (!slot) return;
    slot.classList.add("gacha-tray-glow");
    window.setTimeout(() => slot.classList.remove("gacha-tray-glow"), 500);
  }

  /** Disables the Pull buttons AND the kind/world nav pills for the
   * duration of a reveal. Previously this was implicit — the whole panel
   * (nav included) was torn down by playCaseOpening's container.
   * replaceChildren() every reveal, so there was nothing left to click.
   * Now that the nav/hero row stay mounted throughout a reveal (so the
   * machine illustration doesn't disappear mid-pull), this explicit lock
   * replaces that — without it, clicking a nav pill mid-reveal would still
   * flip `kind`/`itemWorld` even though render() itself no-ops while
   * `revealing` is true, silently orphaning the in-flight reveal. */
  function lockControls(listEl: HTMLElement): void {
    listEl
      .querySelectorAll<HTMLButtonElement>(".gacha-pull-buttons button, .gacha-nav button")
      .forEach((b) => (b.disabled = true));
  }

  function revealSingle(listEl: HTMLElement, pool: CaseCard[], result: CaseCard): void {
    revealing = true;
    lockControls(listEl);
    const target = currentMachineWindow ?? listEl;
    const handle = playCaseOpening(target, pool, result);
    (currentControlBar ?? listEl).append(skipButton(handle.skip));
    void handle.finished.then(() => {
      flashTray();
      finishReveal(listEl, 900);
    });
  }

  /** Runs all 10 pulls as real, individual reels, one after another (not a
   * single hero reel + a grid) — each with its own Skip control and a
   * "Pull i/10" progress readout. The machine illustration + hero row/nav
   * now stay mounted for the WHOLE sequence (previously the entire panel
   * was torn down and rebuilt from scratch on every single pull) — only the
   * reel inside the glass window and the progress readout below it update
   * per iteration. */
  function revealTen(listEl: HTMLElement, pool: CaseCard[], results: CaseCard[]): void {
    revealing = true;
    lockControls(listEl);

    const progress = document.createElement("div");
    progress.className = "shop-sub case-progress";
    (currentControlBar ?? listEl).append(progress);

    async function runSequence(): Promise<void> {
      for (let i = 0; i < results.length; i++) {
        if (!revealing) return; // panel was closed mid-sequence
        progress.textContent = `Pull ${i + 1}/${results.length}`;
        const target = currentMachineWindow;
        if (!target) return; // defensive — should always exist while a reveal runs
        listEl.querySelector(".case-skip-btn")?.remove();
        const handle = playCaseOpening(target, pool, results[i]);
        (currentControlBar ?? listEl).append(skipButton(handle.skip));
        await handle.finished;
        flashTray();
        await new Promise((r) => window.setTimeout(r, BETWEEN_PULLS_MS));
      }
      finishReveal(listEl, 600);
    }

    void runSequence();
  }

  function render(listEl: HTMLElement): void {
    mounted = listEl;
    if (revealing) return;
    listEl.replaceChildren();
    const s = game.save;

    listEl.append(
      navRow(
        (["worker", "item", "powerup"] as GachaKind[]).map((k) => ({
          label: k === "worker" ? "Worker" : k === "item" ? "Item" : "Power-up",
          active: k === kind,
          onClick: () => {
            kind = k;
            render(listEl);
          },
        })),
      ),
    );

    if (kind === "worker") {
      const pool = WORKER_DEFS.map((d) => workerCard(d, game));
      const controlBar = document.createElement("div");
      controlBar.className = "gacha-control-bar";
      controlBar.append(
        row("Worker Gacha", `pity: ${s.pity.worker}/${WORKER_PITY_THRESHOLD} to guaranteed Rare+`, null),
      );
      controlBar.append(row("Odds", oddsLine(), null));
      const pullBtns = document.createElement("div");
      pullBtns.className = "gacha-pull-buttons";
      pullBtns.append(
        pullButton(
          `Pull ×1 — ${abbrev(WORKER_GACHA_COST)} wood`,
          s.wood >= WORKER_GACHA_COST,
          s.wood >= WORKER_GACHA_COST ? undefined : `Need ${abbrev(WORKER_GACHA_COST - s.wood)} more wood`,
          () => {
            const [r] = game.pullWorkerGacha(1);
            const base = workerCard(r.def, game);
            const card: CaseCard = { ...base, sub: workerSub(base, r) };
            revealSingle(listEl, pool, card);
          },
        ),
      );
      pullBtns.append(
        pullButton(
          `Pull ×10 — ${abbrev(WORKER_GACHA_COST_10X)} wood`,
          s.wood >= WORKER_GACHA_COST_10X,
          s.wood >= WORKER_GACHA_COST_10X ? undefined : `Need ${abbrev(WORKER_GACHA_COST_10X - s.wood)} more wood`,
          () => {
            const results = game.pullWorkerGacha(10);
            const cards: CaseCard[] = results.map((r) => {
              const base = workerCard(r.def, game);
              return { ...base, sub: workerSub(base, r) };
            });
            revealTen(listEl, pool, cards);
          },
        ),
      );
      controlBar.append(pullBtns);
      const hero = document.createElement("div");
      hero.className = "gacha-hero";
      const { el: machineEl, windowEl } = machineSlot("worker", null);
      currentMachineWindow = windowEl;
      currentMachineSlot = machineEl;
      currentControlBar = controlBar;
      hero.append(machineEl, controlBar);
      listEl.append(hero);
    } else if (kind === "item") {
      listEl.append(
        navRow(
          CURATED_WORLD_THEMES.map((w, i) => ({
            label: w.name,
            active: i === itemWorld,
            disabled: i > s.worldIndex,
            title: i > s.worldIndex ? `Locked — reach ${w.name} in wood-chopping first` : undefined,
            onClick: () => {
              itemWorld = i;
              render(listEl);
            },
          })),
        ),
      );
      const world = Math.min(itemWorld, s.worldIndex);
      const pity = s.pity.item[world] ?? 0;
      const cost = itemGachaCost(world);
      const cost10 = itemGachaCost10x(world);
      const pool = itemDefsForWorld(world).map((d) => itemCard(d, game));
      const controlBar = document.createElement("div");
      controlBar.className = "gacha-control-bar";
      controlBar.append(
        row(`${CURATED_WORLD_THEMES[world].name} Box`, `pity: ${pity}/${ITEM_PITY_THRESHOLD} to guaranteed Epic+`, null),
      );
      controlBar.append(row("Odds", oddsLine(), null));
      const pullBtns = document.createElement("div");
      pullBtns.className = "gacha-pull-buttons";
      pullBtns.append(
        pullButton(
          `Pull ×1 — ${abbrev(cost)} wood`,
          s.wood >= cost,
          s.wood >= cost ? undefined : `Need ${abbrev(cost - s.wood)} more wood`,
          () => {
            const [r] = game.pullItemGacha(world, 1);
            revealSingle(listEl, pool, itemCard(r.def, game));
          },
        ),
      );
      pullBtns.append(
        pullButton(
          `Pull ×10 — ${abbrev(cost10)} wood`,
          s.wood >= cost10,
          s.wood >= cost10 ? undefined : `Need ${abbrev(cost10 - s.wood)} more wood`,
          () => {
            const results = game.pullItemGacha(world, 10);
            revealTen(listEl, pool, results.map((r) => itemCard(r.def, game)));
          },
        ),
      );
      controlBar.append(pullBtns);
      const hero = document.createElement("div");
      hero.className = "gacha-hero";
      // Item machine's brass trim tints per-world, reusing
      // CURATED_WORLD_THEMES[world].workerPalette's existing R/r values
      // directly (see scene/gacha-machine.ts's drawMachine) — no new
      // per-world data needed.
      const worldPalette = CURATED_WORLD_THEMES[world].workerPalette;
      const brass = worldPalette ? { P: worldPalette.R, p: worldPalette.r } : null;
      const { el: machineEl, windowEl } = machineSlot("item", brass);
      currentMachineWindow = windowEl;
      currentMachineSlot = machineEl;
      currentControlBar = controlBar;
      hero.append(machineEl, controlBar);
      listEl.append(hero);
    } else {
      const pool = POWERUPS.map(powerupCard);
      const controlBar = document.createElement("div");
      controlBar.className = "gacha-control-bar";
      controlBar.append(
        row("Power-up Gacha", `pity: ${s.pity.powerup}/${POWERUP_PITY_THRESHOLD} to guaranteed Epic+`, null),
      );
      controlBar.append(row("Odds", oddsLine(), null));
      const pullBtns = document.createElement("div");
      pullBtns.className = "gacha-pull-buttons";
      pullBtns.append(
        pullButton(
          `Pull ×1 — ${abbrev(POWERUP_GACHA_COST)} wood`,
          s.wood >= POWERUP_GACHA_COST,
          s.wood >= POWERUP_GACHA_COST ? undefined : `Need ${abbrev(POWERUP_GACHA_COST - s.wood)} more wood`,
          () => {
            const [r] = game.pullPowerupGacha(1);
            const base = powerupCard(r.spec);
            const card: CaseCard = {
              ...base,
              sub: r.isNew ? base.sub : `${base.sub} · dupe → ${r.shardsGained ?? 0} shards`,
            };
            revealSingle(listEl, pool, card);
          },
        ),
      );
      pullBtns.append(
        pullButton(
          `Pull ×10 — ${abbrev(POWERUP_GACHA_COST_10X)} wood`,
          s.wood >= POWERUP_GACHA_COST_10X,
          s.wood >= POWERUP_GACHA_COST_10X
            ? undefined
            : `Need ${abbrev(POWERUP_GACHA_COST_10X - s.wood)} more wood`,
          () => {
            const results = game.pullPowerupGacha(10);
            const cards: CaseCard[] = results.map((r) => {
              const base = powerupCard(r.spec);
              return { ...base, sub: r.isNew ? base.sub : `${base.sub} · dupe → ${r.shardsGained ?? 0} shards` };
            });
            revealTen(listEl, pool, cards);
          },
        ),
      );
      controlBar.append(pullBtns);
      const hero = document.createElement("div");
      hero.className = "gacha-hero";
      const { el: machineEl, windowEl } = machineSlot("powerup", null);
      currentMachineWindow = windowEl;
      currentMachineSlot = machineEl;
      currentControlBar = controlBar;
      hero.append(machineEl, controlBar);
      listEl.append(hero);
    }
  }

  return { render };
}
