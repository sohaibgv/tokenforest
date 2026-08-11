import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  getHideOnBlur,
  getSnapshot,
  getUseRealUsage,
  onChop,
  onSnapshot,
  setBudget,
  setHideOnBlur,
  setUseRealUsage,
  type Snapshot,
} from "./bridge";
import { loadSave } from "./game-state";
import { abbrev } from "./scene/floating-text";
import { Game } from "./scene/game";
import { initShop } from "./ui/shop";
import { initUpdater } from "./ui/updater";

async function boot(): Promise<void> {
  const canvas = document.getElementById("scene") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;

  const save = await loadSave();
  const game = new Game(save);

  // The world renders at a fixed 2x pixel scale: a bigger window shows a
  // bigger plot of land, not stretched pixels.
  function fitCanvas(): void {
    const cssW = canvas.clientWidth || window.innerWidth;
    const cssH = canvas.clientHeight || window.innerHeight - 26;
    const w = Math.max(140, Math.floor(cssW / 2));
    const h = Math.max(90, Math.floor(cssH / 2));
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
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const lx = ((e.clientX - r.left) * canvas.width) / r.width;
    const ly = ((e.clientY - r.top) * canvas.height) / r.height;
    if (!game.handleClick(lx, ly)) {
      void appWindow.startDragging();
    }
  });

  // --- bottom strip (budget meter) ---
  const barFill = document.getElementById("bar-fill")!;
  const stats = document.getElementById("stats")!;
  const gear = document.getElementById("gear")!;
  const settings = document.getElementById("settings")!;
  const budgetInput = document.getElementById("budget-input") as HTMLInputElement;
  const budgetSave = document.getElementById("budget-save")!;

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
    }
  }

  gear.addEventListener("click", () => {
    settings.classList.toggle("hidden");
  });
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
  budgetSave.addEventListener("click", () => {
    const v = Number.parseInt(budgetInput.value, 10);
    if (Number.isFinite(v) && v > 0) {
      void setBudget(v);
    }
    settings.classList.add("hidden");
  });

  const appWindow = getCurrentWindow();
  document.getElementById("close")!.addEventListener("click", () => {
    void appWindow.hide();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      void appWindow.hide();
    }
  });

  // --- shop + travel + updates ---
  initShop(game);
  initUpdater();
  const travelBtn = document.getElementById("travel") as HTMLButtonElement;
  travelBtn.addEventListener("click", () => {
    if (game.travel()) {
      travelBtn.classList.add("hidden");
    }
  });
  window.setInterval(() => {
    const status = game.travelStatus();
    if (!status || !status.gateMet) {
      travelBtn.classList.add("hidden");
      return;
    }
    travelBtn.classList.remove("hidden");
    travelBtn.disabled = !status.affordable;
    travelBtn.textContent = `Travel to ${status.nextName} — ${abbrev(status.cost)} wood`;
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
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    game.render(ctx);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void boot();
