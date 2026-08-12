import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  getHideOnBlur,
  getSfxSettings,
  getSnapshot,
  getUseRealUsage,
  onChop,
  onSnapshot,
  setBudget,
  setHideOnBlur,
  setSfxSettings,
  setUseRealUsage,
  type Snapshot,
} from "./bridge";
import { playSfx, setSfxMuted, setSfxVolume, sfxMuted, sfxVolume } from "./sfx";
import { flushSaveNow, getCurrentSlot, loadSave, setCurrentSlot } from "./game-state";
import {
  buildableById,
} from "./economy";
import { abbrev } from "./scene/floating-text";
import { Game } from "./scene/game";
import { BUILDABLE_SPRITES, type PixelMap } from "./scene/sprites";
import {
  BOOSTS_ICON,
  CLOSE_ICON,
  COMPASS_ICON,
  GACHA_ICON,
  GEAR_ICON,
  GNOMES_ICON,
  PROVISIONS_ICON,
  SLOT_WOODCHOPPING_ICON,
  STYLE_ICON,
  TEAM_ICON,
  UI_PALETTE,
} from "./scene/ui-icons";
import { initAdventure } from "./ui/adventure";
import { initBattle } from "./ui/battle";
import {
  anyOverlayOpen,
  closeAllOverlays,
  closeOtherOverlays,
  registerOverlay,
} from "./ui/overlay-coordinator";
import { pixelIcon } from "./ui/pixel-icon";
import { initResizeEdges } from "./ui/resize-edges";
import { initShop, isShopOpen } from "./ui/shop";
import { pickSlot } from "./ui/slot-picker";
import { initStats } from "./ui/stats";
import { initUnlocks, showPrestigeReveal } from "./ui/unlocks";
import { initUpdater } from "./ui/updater";

async function boot(): Promise<void> {
  const canvas = document.getElementById("scene") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;

  // --- save slot: last-used slot from config skips the picker; first boot
  // (or a cleared config) must pick one before anything else loads.
  let slot = await getCurrentSlot();
  if (slot === null) {
    slot = (await pickSlot({ allowCancel: false }))!;
  }
  // Persisting the choice is best-effort: in a plain-browser dev preview
  // (no Tauri bridge) the invoke rejects, which shouldn't kill boot.
  await setCurrentSlot(slot).catch(() => {});
  const save = await loadSave(slot);
  const game = new Game(save);
  // Dev-only hook for visual verification (drive the game from the console
  // / browser automation without playing through the token economy).
  if (import.meta.env.DEV) {
    (window as unknown as { __game: Game }).__game = game;
    // SFX state is module-private, so browser-automation checks of the
    // gramophone (does the crank actually move volume? does the tone-arm
    // actually mute?) need a read path that isn't the DOM mirror.
    (window as unknown as { __sfx: unknown }).__sfx = { sfxVolume, sfxMuted };
  }

  // The world renders at a fixed 2x pixel scale: a bigger window shows a
  // bigger plot of land, not stretched pixels.
  /** Logical width we aim the canvas at, whatever the window is doing.
   *
   * The canvas used to render at a FIXED half of CSS size, which meant the
   * logical resolution grew without limit: at the 1680px window this app
   * actually gets used at, that was an 840px-wide world drawn with ~12px
   * sprites. Widening the window didn't scale the game up, it just handed
   * the same handful of trees more empty ground to rattle around in —
   * which is exactly what "the world feels empty" is.
   *
   * Targeting a roughly constant logical size instead means the window
   * getting bigger makes the WORLD bigger, not the emptiness: sprites keep
   * a constant share of the screen, and the fixed per-plot tree count keeps
   * a constant density. */
  const TARGET_LOGICAL_W = 240;

  function fitCanvas(): void {
    const cssW = canvas.clientWidth || window.innerWidth;
    const cssH = canvas.clientHeight || window.innerHeight - 26;
    // INTEGER scale, always. drawSprite paints 1x1 fillRects; at a
    // fractional scale those land on fractional device pixels and Chromium
    // anti-aliases every sprite edge into a blur (the same reason
    // BATTLE_ZOOM is integers-only — see game.ts). Lower bound of 2 keeps
    // the old behaviour on small windows; upper bound of 8 stops a very
    // large display from zooming so far that the plot no longer fits.
    const scale = Math.max(2, Math.min(8, Math.round(cssW / TARGET_LOGICAL_W)));
    const w = Math.max(140, Math.floor(cssW / scale));
    const h = Math.max(90, Math.floor(cssH / scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      game.resize(w, h);
    }
    ctx.imageSmoothingEnabled = false;
  }
  window.addEventListener("resize", fitCanvas);
  fitCanvas();

  // Clicks interact with the game (chop, golden spots, logs); clicks that
  // hit nothing fall back to dragging the frameless window.
  // Canvas hover — new infrastructure, added for Build Mode's ghost preview.
  // Nothing in the app listened for pointer movement before this; two comments
  // elsewhere still assert that and are now stale.
  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    game.handleHover(
      ((e.clientX - r.left) * canvas.width) / r.width,
      ((e.clientY - r.top) * canvas.height) / r.height,
    );
    canvas.style.cursor = game.buildModeActive()
      ? "crosshair"
      : game.hoverIsInteractive()
        ? "pointer"
        : "";
  });
  canvas.addEventListener("mouseleave", () => {
    game.clearHover();
    canvas.style.cursor = "";
  });

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const lx = ((e.clientX - r.left) * canvas.width) / r.width;
    const ly = ((e.clientY - r.top) * canvas.height) / r.height;
    if (!game.handleClick(lx, ly)) {
      void appWindow?.startDragging();
    }
  });

  // --- Build Mode bar: selection, placeable inventory, and the way out ------
  const buildBar = document.getElementById("build-bar")!;
  const buildLabel = document.getElementById("build-label")!;
  const buildSlots = document.getElementById("build-slots")!;
  const buildExit = document.getElementById("build-exit")!;

  buildExit.addEventListener("click", () => {
    game.cancelBuildMode();
    canvas.style.cursor = "";
  });

  // Your box, openable at any time — not only as a side effect of buying
  // something. Closing it also disarms the placer, so "Done" and the button
  // mean the same thing.
  document.getElementById("box-btn")!.addEventListener("click", () => {
    closeAllOverlays();
    game.toggleInventory();
    canvas.style.cursor = "";
  });

  /** Rebuilds the bar only when its contents actually change — it's driven
   * from the render loop, so blindly re-creating the slots every frame would
   * destroy the button under the pointer mid-click. */
  let buildBarKey = "";
  function syncBuildBar(): void {
    const visible = game.inventoryVisible();
    buildBar.classList.toggle("hidden", !visible);
    if (!visible) {
      buildBarKey = "";
      return;
    }
    const sel = game.buildSelectionId();
    const entries = game.inventoryEntries();
    const key = `${sel}|${JSON.stringify(entries)}|${(game.save.placed ?? []).length}`;
    if (key === buildBarKey) return;
    buildBarKey = key;

    buildLabel.textContent = sel
      ? `Placing ${buildableById(sel)?.name ?? sel}`
      : game.buildModeActive()
        ? "Moving — pick a spot"
        : entries.length > 0
          ? "Your box — pick something to place"
          : "Your box is empty";

    buildSlots.replaceChildren();
    // ONLY what you own and have not placed. The bar used to list every
    // buildable in the game with a price on it, which is what made it read
    // as a second shop where each click cost wood — the whole confusion
    // behind buying one bench and placing six.
    for (const e of entries) {
      const b = buildableById(e.id);
      if (!b) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "build-slot stocked";
      btn.classList.toggle("selected", sel === b.id);
      btn.title = `${b.name} — ${e.count} in your box`;
      const icon = pixelIcon(BUILDABLE_SPRITES[b.id], { palette: UI_PALETTE, scale: 2 });
      const count = document.createElement("span");
      count.textContent = `x${e.count}`;
      btn.append(icon, count);
      btn.addEventListener("click", () => {
        game.beginPlacing(b.id);
        buildBarKey = ""; // force a redraw so the selection highlight moves
      });
      buildSlots.append(btn);
    }
    if (entries.length === 0) {
      const empty = document.createElement("span");
      empty.className = "build-empty";
      empty.textContent = "Buy decorations in the Shop.";
      buildSlots.append(empty);
    }
  }

  // --- static icon buttons: prepend cached pixel-art icons (see
  // scene/ui-icons.ts) wherever index.html used to embed a raw emoji
  // character — static HTML can't hold a runtime-generated data: URL, so
  // these are inserted once at boot instead of baked into the markup. Text
  // labels (if any) are left in place in index.html; the icon is just
  // inserted before them.
  function prependIcon(id: string, map: PixelMap, scale: number, hasLabel: boolean): void {
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if (!btn) return;
    const icon = pixelIcon(map, { palette: UI_PALETTE, scale });
    if (hasLabel) icon.style.marginRight = "4px";
    btn.insertBefore(icon, btn.firstChild);
  }
  prependIcon("close", CLOSE_ICON, 2, false);
  prependIcon("pov-exit", CLOSE_ICON, 2, true);
  prependIcon("battle-exit", CLOSE_ICON, 2, true);
  prependIcon("shop-close", CLOSE_ICON, 2, true);
  prependIcon("adventure-close", CLOSE_ICON, 2, true);
  prependIcon("shop-btn", SLOT_WOODCHOPPING_ICON, 2, false);
  prependIcon("adventure-btn", COMPASS_ICON, 2, false);
  prependIcon("box-btn", BUILDABLE_SPRITES.flowerbed ?? COMPASS_ICON, 2, false);
  prependIcon("gear", GEAR_ICON, 2, false);
  const shopTabIcons: Record<string, PixelMap> = {
    team: TEAM_ICON,
    gacha: GACHA_ICON,
    helpers: GNOMES_ICON,
    boosts: BOOSTS_ICON,
    provisions: PROVISIONS_ICON,
    style: STYLE_ICON,
  };
  for (const tabBtn of document.querySelectorAll<HTMLButtonElement>("#shop-tabs button")) {
    const map = tabBtn.dataset.tab ? shopTabIcons[tabBtn.dataset.tab] : undefined;
    if (!map) continue;
    const icon = pixelIcon(map, { palette: UI_PALETTE, scale: 1 });
    icon.style.marginRight = "3px";
    tabBtn.insertBefore(icon, tabBtn.firstChild);
  }

  // --- bottom strip (budget meter) ---
  const barFill = document.getElementById("bar-fill")!;
  const stats = document.getElementById("stats")!;
  const gear = document.getElementById("gear")!;
  const settings = document.getElementById("settings")!;
  const budgetInput = document.getElementById("budget-input") as HTMLInputElement;
  const budgetSave = document.getElementById("budget-save")!;
  const budgetPlank = document.getElementById("budget-plank")!;
  const budgetUp = document.getElementById("budget-up")!;
  const budgetDown = document.getElementById("budget-down")!;
  const budgetExactBtn = document.getElementById("budget-exact")!;
  const budgetExactRow = document.getElementById("budget-exact-row")!;

  // --- Budget notch board ---------------------------------------------------
  //
  // The one control on the Crossroads Signpost that genuinely resists being
  // made diegetic. A peg-and-notch ladder reads beautifully but cannot express
  // an arbitrary budget like 437,000, and this number drives the app's whole
  // reason for existing — so the notches are a fast path over common values,
  // and the exact numeric entry stays available behind a disclosure rather
  // than being replaced by a metaphor that loses information.
  const BUDGET_NOTCHES = [
    50_000, 100_000, 200_000, 300_000, 500_000, 750_000, 1_000_000, 1_500_000,
    2_000_000, 3_000_000, 5_000_000, 8_000_000, 12_000_000, 20_000_000,
  ];
  /** True once the player has moved the peg or typed, so the 1s strip poll
   * stops overwriting their in-progress choice. Cleared on commit. */
  let budgetDirty = false;

  function setPendingBudget(v: number): void {
    budgetPlank.textContent = abbrev(v);
    // An off-ladder value is shown as-is and flagged, never silently rounded
    // onto a notch — quietly changing someone's real budget would be worse
    // than admitting the peg sits between notches.
    const onNotch = BUDGET_NOTCHES.includes(v);
    budgetPlank.classList.toggle("off-notch", !onNotch);
    budgetPlank.title = onNotch ? `${v.toLocaleString()} tokens` : `${v.toLocaleString()} tokens (between notches)`;
  }

  function nudgeBudget(dir: 1 | -1): void {
    const cur = Number.parseInt(budgetInput.value, 10);
    const base = Number.isFinite(cur) && cur > 0 ? cur : BUDGET_NOTCHES[0];
    let next: number;
    if (dir > 0) {
      next = BUDGET_NOTCHES.find((n) => n > base) ?? BUDGET_NOTCHES[BUDGET_NOTCHES.length - 1];
    } else {
      const below = BUDGET_NOTCHES.filter((n) => n < base);
      next = below.length ? below[below.length - 1] : BUDGET_NOTCHES[0];
    }
    budgetDirty = true;
    budgetInput.value = String(next);
    setPendingBudget(next);
  }

  budgetUp.addEventListener("click", () => nudgeBudget(1));
  budgetDown.addEventListener("click", () => nudgeBudget(-1));
  budgetInput.addEventListener("input", () => {
    budgetDirty = true;
    const v = Number.parseInt(budgetInput.value, 10);
    if (Number.isFinite(v) && v > 0) setPendingBudget(v);
  });
  budgetExactBtn.addEventListener("click", () => {
    const open = budgetExactRow.classList.toggle("hidden");
    budgetExactBtn.setAttribute("aria-expanded", String(!open));
    if (!open) budgetInput.focus();
  });

  function resetsIn(endIso: string): string {
    const ms = new Date(endIso).getTime() - Date.now();
    if (ms <= 0) return "resetting";
    const mins = Math.ceil(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `resets in ${h}h ${m}m` : `resets in ${m}m`;
  }

  function paintBar(density: number): void {
    barFill.style.width = `${Math.round(density * 100)}%`;
    barFill.style.background =
      density < 0.15 ? "#d64545" : density < 0.35 ? "#e6a23c" : "#4a9e5c";
  }

  function updateStrip(s: Snapshot): void {
    if (s.real) {
      // Real account usage, same numbers as Claude Code's /usage.
      const left = Math.max(0, Math.min(1, 1 - s.real.fiveHourPct));
      paintBar(left);
      const pct = Math.round(s.real.fiveHourPct * 100);
      let text = `${pct}% of 5h used`;
      if (s.real.fiveHourResetsAt) {
        text += ` · ${resetsIn(s.real.fiveHourResetsAt)}`;
      }
      if (s.real.weeklyPct !== null) {
        text += ` · wk ${Math.round(s.real.weeklyPct * 100)}%`;
      }
      stats.textContent = text;
      return;
    }
    if (!s.block) {
      paintBar(1);
      stats.textContent = "budget fresh · all quiet";
      return;
    }
    const b = s.block;
    paintBar(b.density);
    stats.textContent = `${abbrev(b.usedCounted)} / ${abbrev(b.budget)} · ${resetsIn(b.end)}`;
    if (document.activeElement !== budgetInput) {
      budgetInput.value = String(b.budget);
      // Only re-sync the notch board while the player isn't mid-adjustment,
      // or every poll would yank their pending choice back to the live value.
      if (!budgetDirty) setPendingBudget(b.budget);
    }
  }

  registerOverlay("settings", () => settings.classList.add("hidden"));
  function toggleSettings(): void {
    if (settings.classList.contains("hidden")) {
      closeOtherOverlays("settings");
      settings.classList.remove("hidden");
    } else {
      settings.classList.add("hidden");
    }
  }
  gear.addEventListener("click", toggleSettings);
  // The Crossroads Signpost in the clearing is the diegetic way in. #gear is
  // deliberately KEPT alongside it rather than removed: the signpost can be
  // occluded by a tree or a worker, and it isn't on screen at all during POV /
  // battle takeovers or mid-transition (handleClick bails while nextPlot is
  // set), so removing the button would strand settings behind a prop that
  // sometimes isn't reachable.
  game.onWantSettings = toggleSettings;
  const autohideBox = document.getElementById("autohide-box") as HTMLInputElement;
  void getHideOnBlur().then((v) => {
    autohideBox.checked = v;
  });
  autohideBox.addEventListener("change", () => {
    void setHideOnBlur(autohideBox.checked);
  });
  const realUsageBox = document.getElementById("realusage-box") as HTMLInputElement;
  void getUseRealUsage().then((v) => {
    realUsageBox.checked = v;
  });
  realUsageBox.addEventListener("change", () => {
    void setUseRealUsage(realUsageBox.checked);
  });

  // --- SFX settings: master mute + volume, persisted app-level in config.
  const sfxBox = document.getElementById("sfx-box") as HTMLInputElement;
  const sfxSlider = document.getElementById("sfx-volume") as HTMLInputElement;
  void getSfxSettings().then((s) => {
    setSfxMuted(s.muted);
    setSfxVolume(s.volume);
    sfxBox.checked = !s.muted;
    sfxSlider.value = String(Math.round(s.volume * 100));
  });
  function persistSfx(): void {
    void setSfxSettings(sfxMuted(), sfxVolume());
  }
  sfxBox.addEventListener("change", () => {
    setSfxMuted(!sfxBox.checked);
    persistSfx();
    if (!sfxMuted()) playSfx("click");
  });
  // "input", not "change": a range fires `change` only on pointer-release, so
  // the old wiring gave no audio feedback at all while dragging — you set a
  // level blind and only heard it after letting go. Volume is applied live on
  // every input event; persistence is debounced to release so a drag doesn't
  // spam the Tauri config with a write per pixel.
  sfxSlider.addEventListener("input", () => {
    setSfxVolume(Number(sfxSlider.value) / 100);
    playSfx("click"); // audible preview at the level you're currently on
  });
  sfxSlider.addEventListener("change", () => {
    setSfxVolume(Number(sfxSlider.value) / 100);
    persistSfx();
  });
  // Global UI click blip: any real <button> press. Capture-phase so it fires
  // inside the user gesture (which also unlocks the lazy AudioContext).
  document.addEventListener(
    "click",
    (e) => {
      if ((e.target as HTMLElement).closest?.("button")) playSfx("click");
    },
    true,
  );
  // Slot switching from settings: reopen the picker (cancelable this time);
  // a different choice flushes any debounced save for the CURRENT slot,
  // persists the new slot in config, then reloads the webview — a clean
  // re-boot into the chosen slot beats trying to hot-swap every piece of
  // live Game state in place.
  const slotSwitchBtn = document.getElementById("slot-switch") as HTMLButtonElement;
  slotSwitchBtn.addEventListener("click", () => {
    settings.classList.add("hidden");
    void (async () => {
      const chosen = await pickSlot({ allowCancel: true, activeSlot: slot });
      if (chosen !== null && chosen !== slot) {
        await flushSaveNow();
        await setCurrentSlot(chosen);
        location.reload();
      }
    })();
  });

  budgetSave.addEventListener("click", () => {
    // The exact input stays the source of truth on commit — the notch board
    // writes into it, so whichever control was used last is what gets carved.
    const v = Number.parseInt(budgetInput.value, 10);
    if (Number.isFinite(v) && v > 0) {
      void setBudget(v);
    }
    budgetDirty = false;
    settings.classList.add("hidden");
  });

  // Null when the Tauri bridge is absent (plain-browser dev for visual QA)
  // — window management degrades to no-ops; everything else runs.
  const appWindow = (() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  })();
  const closeBtn = document.getElementById("close") as HTMLButtonElement;
  closeBtn.addEventListener("click", () => {
    void appWindow?.hide();
  });

  // --- Full-window takeover modes (POV, Battle): grow the tiny widget
  // window for legibility, restore its exact prior size on exit. Only one
  // of these is ever active at a time (enforced in Game).
  //
  // #close is explicitly hidden while either is active: it used to sit at
  // the identical top:4/right:4 corner as #pov-exit/#battle-exit, which was
  // confusing even before the #pov-exit.hidden CSS rule was (re)added below
  // — three visually-identical "✕" buttons stacked at one spot is a trap
  // regardless of which one is technically on top.
  const povExitBtn = document.getElementById("pov-exit") as HTMLButtonElement;
  const battleExitBtn = document.getElementById("battle-exit") as HTMLButtonElement;
  const stripEl = document.getElementById("strip")!;

  type TakeoverMode = "none" | "pov" | "battle" | "shop";
  let takeoverMode: TakeoverMode = "none";
  /** The window size to restore once we return to "none" — captured ONCE on
   * the none->takeover transition, never re-captured on a takeover->takeover
   * transition (POV<->Battle), which is what used to race: re-reading
   * `appWindow.innerSize()` right after an un-awaited restore from the prior
   * mode could observe that prior mode's (already-wrong) size instead of the
   * true original widget size, corrupting the stashed restore target. */
  let stashedSize: { width: number; height: number } | null = null;
  let takeoverBusy = false;

  function targetSizeFor(mode: TakeoverMode): LogicalSize | null {
    if (mode === "pov") return new LogicalSize(380, 340);
    if (mode === "battle") return new LogicalSize(460, 360);
    if (mode === "shop") return new LogicalSize(560, 480);
    return null;
  }

  function syncTakeoverChrome(mode: TakeoverMode): void {
    // POV/Battle are opaque full-window takeovers — they hide #close/
    // #strip/#travel entirely. Shop is NOT: it keeps its existing "partial
    // overlay over a visible scene sliver" identity, just at a bigger
    // window size, so none of that chrome hides for it — only `opaque`
    // (not "any takeover") gates them.
    const opaque = mode === "pov" || mode === "battle";
    closeBtn.classList.toggle("hidden", opaque);
    povExitBtn.classList.toggle("hidden", mode !== "pov");
    battleExitBtn.classList.toggle("hidden", mode !== "battle");
    // Both the Travel button and the bottom strip are DOM elements that
    // would otherwise sit on top of the canvas-drawn scene/skill-check bar
    // during a takeover — the 1s travel-status interval also checks
    // takeover state so it never un-hides #travel while one is active.
    document.getElementById("travel")?.classList.toggle("hidden", opaque);
    stripEl.classList.toggle("hidden", opaque);
    // Shop-only: lets styles.css grow #shop's `top` offset to claim more of
    // the now-bigger window, instead of the normal `top: 26%` rule keeping
    // it proportionally small.
    document.body.classList.toggle("shop-takeover", mode === "shop");
  }

  async function syncTakeover(): Promise<void> {
    if (takeoverBusy) return; // next frame will retry once the current transition settles
    const wantMode: TakeoverMode = game.isBattleViewOpen()
      ? "battle"
      : game.isPovActive()
        ? "pov"
        : isShopOpen()
          ? "shop"
          : "none";
    if (wantMode === takeoverMode) return;
    const prevMode = takeoverMode;
    takeoverMode = wantMode;
    syncTakeoverChrome(wantMode); // instant visual feedback, doesn't wait on the resize
    takeoverBusy = true;
    try {
      // Browser dev (no Tauri bridge): chrome classes still toggle above,
      // just no window resize — this early-return MUST stay inside the
      // try/finally (it used to sit before it), or takeoverBusy latches
      // true forever on the very first takeover and every later transition
      // silently no-ops (syncTakeoverChrome never runs again).
      if (!appWindow) return;
      if (wantMode === "none") {
        if (stashedSize) {
          const size = stashedSize;
          stashedSize = null;
          await appWindow.setSize(new LogicalSize(size.width, size.height));
        }
      } else {
        // A takeover only ever GROWS the window: per-dimension target =
        // max(current, mode target), so a window the user deliberately made
        // bigger than a mode's baseline is never shrunk out from under
        // them (that includes takeover->takeover switches, e.g. leaving a
        // 560-wide Shop for Battle keeps the extra width).
        const scale = await appWindow.scaleFactor();
        const logical = (await appWindow.innerSize()).toLogical(scale);
        if (prevMode === "none") {
          // Entering from the normal view: the only time "current size"
          // reliably IS the true pre-takeover size to restore later.
          stashedSize = { width: logical.width, height: logical.height };
        }
        const target = targetSizeFor(wantMode)!;
        await appWindow.setSize(
          new LogicalSize(Math.max(logical.width, target.width), Math.max(logical.height, target.height)),
        );
      }
    } catch {
      // Window resize isn't essential — the view still works at current size.
    } finally {
      takeoverBusy = false;
    }
  }

  povExitBtn.addEventListener("click", () => {
    game.exitPov();
  });
  battleExitBtn.addEventListener("click", () => {
    game.closeBattleView();
  });

  window.addEventListener("keydown", (e) => {
    // Cancel an armed placement first — Esc during building means "put the
    // ghost down", not "close the game window".
    if (e.key === "Escape" && game.buildModeActive()) {
      game.cancelBuildMode();
      canvas.style.cursor = "";
      e.stopPropagation();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape") {
      if (game.isBattleViewOpen()) {
        game.closeBattleView();
        return;
      }
      if (game.isPovActive()) {
        game.exitPov();
        return;
      }
      if (anyOverlayOpen()) {
        closeAllOverlays();
        return;
      }
      void appWindow?.hide();
    } else if (e.code === "Space") {
      if (game.isBattleViewOpen()) {
        e.preventDefault();
        game.handleBattleClick();
      } else if (game.isPovActive()) {
        e.preventDefault();
        game.handlePovInput();
      }
    }
  });

  // --- shop + adventure + travel + updates ---
  initShop(game);
  initAdventure(game);
  initBattle(game);
  initUnlocks(game);
  initStats(game);
  initUpdater();
  initResizeEdges();
  // Travel is now the moored raft on the lake (see Game.hitRaft/drawables).
  // #travel survives as a TRANSPARENT, still-focusable button positioned over
  // the raft rather than as a visible pill: the canvas prop carries the visual
  // affordance, but a canvas hit-box is invisible to keyboard and screen-reader
  // users, so the real control has to stay in the DOM. It keeps the exact label
  // the pill had, which is also what an assistive reader announces.
  const travelBtn = document.getElementById("travel") as HTMLButtonElement;
  travelBtn.classList.add("affordance");
  travelBtn.addEventListener("click", () => {
    if (game.bridgeRepaired() ? game.crossBridge() : game.repairBridge()) {
      travelBtn.classList.add("hidden");
    }
  });
  window.setInterval(() => {
    if (game.isPovActive() || game.isBattleViewOpen()) return; // stays hidden — see syncTakeoverChrome
    const status = game.travelStatus();
    const rect = game.travelTargetRect();
    if (!status || !rect) {
      travelBtn.classList.add("hidden");
      return;
    }
    travelBtn.classList.remove("hidden");
    // Mirrors the bridge's own two-step state so the accessible control says
    // the same thing the world does.
    const repaired = game.bridgeRepaired();
    // A built bridge is always crossable — the gate governs building it, not
    // using it (see Game.crossBridge).
    travelBtn.disabled = repaired
      ? false
      : !status.gateMet || !status.affordable;
    travelBtn.textContent = repaired
      ? `Cross the bridge to ${status.nextName}`
      : `Repair the bridge to ${status.nextName} — ${abbrev(status.cost)} wood`;
    travelBtn.setAttribute("aria-label", travelBtn.textContent);
    // Canvas-logical → CSS px via the canvas's real rendered size. Never assume
    // exactly 2x: fitCanvas floors cssW/2, so odd widths give a fractional scale.
    const r = canvas.getBoundingClientRect();
    const sx = r.width / canvas.width;
    const sy = r.height / canvas.height;
    travelBtn.style.left = `${r.left + rect.x * sx}px`;
    travelBtn.style.top = `${r.top + rect.y * sy}px`;
    travelBtn.style.width = `${rect.w * sx}px`;
    travelBtn.style.height = `${rect.h * sy}px`;
  }, 1000);

  // --- prestige: reset the wood-chopping ladder for a permanent bonus.
  // A real, deliberate progress reset — armed by one click, only triggers
  // on a second click within 4s, so an accidental click can't fire it.
  const prestigeBtn = document.getElementById("prestige-btn") as HTMLButtonElement;
  let prestigeArmed = false;
  let prestigeDisarmTimer: number | null = null;

  function disarmPrestige(): void {
    prestigeArmed = false;
    if (prestigeDisarmTimer !== null) {
      window.clearTimeout(prestigeDisarmTimer);
      prestigeDisarmTimer = null;
    }
  }

  prestigeBtn.addEventListener("click", () => {
    if (!prestigeArmed) {
      prestigeArmed = true;
      prestigeBtn.textContent = "Click again to confirm";
      prestigeDisarmTimer = window.setTimeout(disarmPrestige, 4000);
      return;
    }
    disarmPrestige();
    if (game.prestige()) {
      playSfx("prestige");
      // Isaac-style reveal: show exactly what this new level just opened.
      showPrestigeReveal(game.prestigeStatus().level);
    }
  });

  window.setInterval(() => {
    const status = game.prestigeStatus();
    if (!status.eligible) {
      prestigeBtn.classList.add("hidden");
      disarmPrestige();
      return;
    }
    prestigeBtn.classList.remove("hidden");
    // Full reset breakdown lives in the tooltip; the button text itself
    // stays a short "what you get" summary (see below).
    const breakdown =
      `Resets: wood, wood-chopping world/plot progress (back to World 1). ` +
      `Kept: team, items, inventory, amber, currency, and all Adventure/Field progress. ` +
      `Gained: a permanent +${status.nextBonusPct}% bonus to wood yield and party ATK/HP` +
      (status.level > 0 ? ` (currently +${status.bonusPct}% from ${status.level} prior level${status.level === 1 ? "" : "s"}).` : ".");
    prestigeBtn.title = prestigeArmed ? `${breakdown} Click again to confirm.` : breakdown;
    if (!prestigeArmed) {
      prestigeBtn.textContent =
        status.level > 0
          ? `Prestige (Lv.${status.level}, +${status.bonusPct}%) → Lv.${status.level + 1} (+${status.nextBonusPct}%)`
          : `Prestige → Lv.1 (+${status.nextBonusPct}% wood & party power)`;
    }
  }, 1000);

  // --- backend wiring ---
  onSnapshot((s) => {
    game.applySnapshot(s);
    updateStrip(s);
  });
  onChop((e) => game.applyChop(e));
  void getSnapshot().then((s) => {
    game.applySnapshot(s);
    updateStrip(s);
  });

  // --- fixed-timestep loop ---
  const STEP = 1 / 60;
  let last = performance.now();
  let acc = 0;

  function frame(now: number): void {
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;
    while (acc >= STEP) {
      game.update(STEP);
      acc -= STEP;
    }
    void syncTakeover();
    syncBuildBar();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    game.render(ctx);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void boot();
