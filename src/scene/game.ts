// Idle-game orchestration. Token usage drives chops; chops deal axe damage;
// felled trees pay wood; wood buys upgrades and travel to harder worlds.
// The 5h budget survives only as a meter (lake level, strip, tray icon).

import { reportFell, type ChopEvent, type Snapshot } from "../bridge";
import {
  AXES,
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
  TOKENS_PER_CHARGE,
  WOOD_YIELD,
  WORLDS,
} from "../economy";

const HELPER_BY_ID = Object.fromEntries(HELPERS.map((h) => [h.id, h]));
import type { GameSave } from "../game-state";
import { scheduleSave } from "../game-state";
import { Effect } from "./effects";
import { FloatingText, abbrev } from "./floating-text";
import { Plot } from "./plot";
import { hashString } from "./rng";
import { Sky } from "./sky";
import {
  AMBER_GEM,
  drawSprite,
  drawText,
  GLOW_LG,
  GLOW_SM,
  LOG,
  SLASH1,
  SLASH2,
  SPARK,
  textWidth,
  withPalette,
} from "./sprites";
import type { PendingChop } from "./woodcutter";
import { Tree } from "./forest";
import { Woodcutter } from "./woodcutter";

const MAX_WOODCUTTERS = 8;
const COALESCE_SECS = 0.5;
const SLIDE_SECS = 1.4;
const WOOD_COLOR = "#f0a04a";
const TOKEN_COLOR = "#ffe9a8";

interface ChopBuffer {
  tokens: number;
  hits: number;
  age: number;
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
  private sky = new Sky();
  private plot: Plot;
  private plotWorld: number;
  private nextPlot: Plot | null = null;
  private nextPlotWorld = 0;
  private slide = 0;
  private density = 1;
  private woodcutters = new Map<string, Woodcutter>();
  private floats: FloatingText[] = [];
  private buffers = new Map<string, ChopBuffer>();
  private extraCount = 0;
  private hasData = false;
  private gnomeTimer = 0;
  // Interaction layer (none of this persists except via save fields).
  private tokenCarry = 0;
  private effects: Effect[] = [];
  private spot: { tree: Tree; x: number; y: number; ttl: number } | null = null;
  private spotTimer = 8;
  private goldenLog: { x: number; y: number; ttl: number } | null = null;
  private frenzyT = 0;
  private espressoT = 0;
  private animT = 0;

  constructor(save: GameSave) {
    this.save = save;
    this.plotWorld = save.worldIndex;
    this.plot = this.makePlot(save.worldIndex, save.plotIndex);
    if (save.currentPlotHp) {
      this.plot.forest.restoreHp(save.currentPlotHp);
    }
    this.layout();
    this.refreshModifiers();
  }

  private makePlot(world: number, plotIndex: number): Plot {
    return new Plot(hashString(`w${world}-p${plotIndex}`), WORLDS[world].mult);
  }

  private axeDamage(): number {
    return AXES[this.save.ownedAxe].damage;
  }

  private has(helper: string): boolean {
    return (this.save.helpers as string[]).includes(helper);
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
    this.plot.resize(this.w, this.groundTop(), this.groundBottom());
    this.nextPlot?.resize(this.w, this.groundTop(), this.groundBottom());
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
    this.layout();
    for (const wc of this.woodcutters.values()) {
      wc.x = Math.min(wc.x, this.w - 12);
      wc.y = Math.max(this.skyH + 10, Math.min(wc.y, this.h - 3));
      wc.repath();
    }
  }

  // --- backend inputs -----------------------------------------------------

  applySnapshot(s: Snapshot): void {
    this.hasData = true;
    this.density = s.block ? s.block.density : 1;
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
          this.skyH + 14 + ((this.woodcutters.size * 17) % (this.h - this.skyH - 22));
        wc = new Woodcutter(src.id, src.kind === "subagent", entryY);
        this.applyModifiers(wc);
        this.woodcutters.set(src.id, wc);
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
    if (buf) {
      buf.tokens += e.counted;
      buf.hits += 1;
    } else {
      this.buffers.set(e.sourceId, { tokens: e.counted, hits: 1, age: 0 });
    }

    // Token accrual: every 1k counted charges +1 Focus (capped) and +1 Amber.
    this.tokenCarry += e.counted;
    const gained = Math.floor(this.tokenCarry / TOKENS_PER_CHARGE);
    if (gained > 0) {
      this.tokenCarry %= TOKENS_PER_CHARGE;
      this.save.amber += gained;
      this.save.focus = Math.min(FOCUS_CAP, this.save.focus + gained);
      scheduleSave(this.save);
    }

    // Heavy single turns drop a clickable golden log.
    if (e.counted > GOLDEN_LOG_THRESHOLD && !this.goldenLog && !this.nextPlot) {
      this.goldenLog = {
        x: Math.round(12 + Math.random() * (this.w - 24)),
        y: Math.round(this.skyH + 14 + Math.random() * (this.h - this.skyH - 22)),
        ttl: GOLDEN_LOG_TTL,
      };
    }
  }

  /** Canvas click at logical coords. Returns false if nothing was hit. */
  handleClick(lx: number, ly: number): boolean {
    if (this.nextPlot) return false;
    const s = this.save;

    if (this.spot && Math.abs(lx - this.spot.x) <= 3 && Math.abs(ly - this.spot.y) <= 3) {
      const tree = this.spot.tree;
      this.spot = null;
      this.spotTimer = 6 + Math.random() * 4;
      s.stats.goldenSpotsHit += 1;
      s.stats.clicks += 1;
      if (s.focus > 0 && tree.standing) {
        s.focus -= 1;
        this.effects.push(new Effect(lx, ly, [SLASH1, SLASH2], 0.25));
        this.resolveChop(tree, { tokens: 0, hits: 3 }, lx, ly, true);
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
      s.amber += GOLDEN_LOG_AMBER;
      this.floats.push(
        new FloatingText(this.goldenLog.x, this.goldenLog.y - 4, `+${GOLDEN_LOG_AMBER}`, "#ffd75e"),
      );
      this.goldenLog = null;
      scheduleSave(s, true);
      return true;
    }

    const tree = this.plot.forest.treeAt(lx, ly);
    if (!tree) return false;
    s.stats.clicks += 1;
    if (s.focus > 0) {
      s.focus -= 1;
      this.effects.push(new Effect(lx, ly, [SLASH1, SLASH2], 0.25));
      this.resolveChop(tree, { tokens: 0, hits: 1 }, lx, ly, true);
    } else {
      // Out of Focus: spark, no damage — run another prompt to recharge.
      this.effects.push(new Effect(lx, ly, [SPARK], 0.2));
      scheduleSave(s);
    }
    return true;
  }

  // --- economy ------------------------------------------------------------

  /** A chop lands: damage the tree, pay chips + fell wood, persist. */
  private resolveChop(
    tree: Tree,
    chop: PendingChop,
    x: number,
    y: number,
    chipFloat = false,
  ): void {
    const s = this.save;
    s.stats.chops += chop.hits;
    s.stats.tokensSeen += chop.tokens;
    if (chop.tokens > 0) {
      this.floats.push(new FloatingText(x, y, `-${abbrev(chop.tokens)}`, TOKEN_COLOR));
    }
    // Chips: every landed hit pays a little wood — token usage visibly
    // fills the inventory even between fells.
    const chips = chop.hits * WORLDS[this.plotWorld].mult;
    s.wood += chips;
    s.totalWoodEarned += chips;
    const felled = this.plot.forest.applyDamage(tree, chop.hits * this.axeDamage());
    if (chipFloat && !felled) {
      this.floats.push(new FloatingText(x, y - 5, `+${abbrev(chips)}`, WOOD_COLOR));
    }
    if (felled) {
      const payout = WOOD_YIELD[tree.kind] * WORLDS[this.plotWorld].mult;
      s.wood += payout;
      s.totalWoodEarned += payout;
      s.stats.treesFelled += 1;
      if (tree.kind === "elder") {
        s.stats.eldersFelled += 1;
      }
      this.floats.push(
        new FloatingText(tree.x + tree.width / 2, tree.y - 14, `+${abbrev(payout)}`, WOOD_COLOR),
      );
      void reportFell(payout);
      s.currentPlotHp = this.plot.forest.hpSnapshot();
      scheduleSave(s, true);
    } else {
      s.currentPlotHp = this.plot.forest.hpSnapshot();
      scheduleSave(s);
    }
  }

  travelStatus(): TravelStatus | null {
    const next = this.save.worldIndex + 1;
    if (next >= WORLDS.length) return null;
    const spec = WORLDS[next];
    return {
      nextName: spec.name,
      cost: spec.travelCost,
      gate: spec.plotGate,
      gateMet: this.save.plotsClearedInWorld >= spec.plotGate,
      affordable: this.save.wood >= spec.travelCost,
    };
  }

  /** User clicked Travel. Returns false if not currently allowed. */
  travel(): boolean {
    const status = this.travelStatus();
    if (!status || !status.gateMet || !status.affordable || this.nextPlot) {
      return false;
    }
    const s = this.save;
    s.wood -= status.cost;
    s.worldIndex += 1;
    s.plotIndex = 0;
    s.plotsClearedInWorld = 0;
    s.currentPlotHp = null;
    scheduleSave(s, true);
    this.startTransition(s.worldIndex, 0);
    return true;
  }

  buyAxe(tier: number): boolean {
    const s = this.save;
    const spec = AXES[tier];
    if (!spec || tier !== s.ownedAxe + 1 || s.wood < spec.cost) return false;
    s.wood -= spec.cost;
    s.ownedAxe = tier;
    scheduleSave(s, true);
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

  buyBoost(id: string): boolean {
    const s = this.save;
    const spec = BOOSTS.find((b) => b.id === id);
    if (!spec || s.amber < spec.cost) return false;
    if (spec.id === "espresso" && !this.has("gnome1")) return false;
    if (spec.id === "focusPotion" && s.focus >= FOCUS_CAP) return false;
    s.amber -= spec.cost;
    switch (spec.id) {
      case "focusPotion":
        s.focus = FOCUS_CAP;
        break;
      case "espresso":
        this.espressoT = ESPRESSO_DURATION;
        break;
      case "amberWood": {
        const bundle = 25 * WORLDS[s.worldIndex].mult;
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

  private applyModifiers(wc: Woodcutter): void {
    wc.walkMult = this.has("boots") ? 1.5 : 1;
    wc.chopDurFactor =
      (this.has("keenEdge") ? 0.75 : 1) * (this.frenzyT > 0 ? 0.5 : 1);
  }

  refreshModifiers(): void {
    for (const wc of this.woodcutters.values()) {
      this.applyModifiers(wc);
    }
    // Gnomes exist iff owned.
    const wantGnomes = (this.has("gnome1") ? 1 : 0) + (this.has("gnome2") ? 1 : 0);
    for (let i = 1; i <= 2; i++) {
      const id = `gnome-${i}`;
      const exists = this.woodcutters.has(id);
      if (i <= wantGnomes && !exists) {
        const gnome = new Woodcutter(id, false, this.skyH + 20 + i * 14, "gnome");
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
    this.nextPlot = this.makePlot(world, plotIndex);
    this.nextPlotWorld = world;
    this.nextPlot.resize(this.w, this.groundTop(), this.groundBottom());
    this.nextPlot.setLakeLevel(this.density);
    this.slide = 0;
    this.spot = null;
    this.goldenLog = null;
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
    this.slide = 0;
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

    // Flush coalesced chops.
    for (const [id, buf] of this.buffers) {
      buf.age += dt;
      if (buf.age >= COALESCE_SECS) {
        const wc = this.woodcutters.get(id);
        if (wc && !wc.gone) {
          this.buffers.delete(id);
          wc.enqueue({ tokens: buf.tokens, hits: buf.hits });
        } else {
          // No visible woodcutter (over cap / despawned): damage directly so
          // tokens are never wasted. If no tree stands (mid-trek), retry.
          const tree = this.plot.forest.nearestStanding(this.w - 24, this.h / 2);
          if (tree) {
            this.buffers.delete(id);
            this.resolveChop(tree, { tokens: buf.tokens, hits: buf.hits }, tree.x, tree.y - 12);
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
          const tree = candidates[Math.floor(Math.random() * candidates.length)];
          this.spot = {
            tree,
            x: tree.x + Math.round(tree.width / 2) + (Math.random() < 0.5 ? -1 : 1),
            y: tree.y - 1 - Math.floor(Math.random() * Math.min(6, tree.height * 0.3)),
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
    if (this.nextPlot) {
      this.slide += dt / SLIDE_SECS;
      if (this.slide >= 1) {
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
    this.nextPlot?.update(dt);

    for (const [id, wc] of this.woodcutters) {
      wc.update(dt, this.plot.forest, (tree, chop, x, y) =>
        this.resolveChop(tree, chop, x, y),
      );
      wc.x = Math.min(wc.x, this.w - 10);
      if (wc.gone) {
        wc.releaseTree();
        this.woodcutters.delete(id);
      }
    }

    for (const f of this.floats) {
      f.update(dt);
    }
    this.floats = this.floats.filter((f) => !f.done);
  }

  // --- render -------------------------------------------------------------

  private treePalette(world: number): Record<string, string> | null {
    const base = WORLDS[world].palette;
    const skin = COSMETICS.find((c) => c.id === this.save.equippedTreeSkin);
    if (!skin) return base;
    return { ...base, ...skin.palette };
  }

  private capPalette(): Record<string, string> | null {
    const cap = COSMETICS.find((c) => c.id === this.save.equippedCap);
    return cap ? cap.palette : null;
  }

  render(ctx: CanvasRenderingContext2D): void {
    const { w, h, skyH } = { w: this.w, h: this.h, skyH: this.skyH };

    this.sky.render(ctx, w, skyH, new Date());

    const sliding = this.nextPlot !== null;
    const dxOld = sliding ? Math.round(-this.slide * w) : 0;
    const dxNew = sliding ? Math.round((1 - this.slide) * w) : 0;

    // Ground per world (both worlds visible during a travel slide).
    if (sliding) {
      ctx.fillStyle = WORLDS[this.plotWorld].ground;
      ctx.fillRect(dxOld, skyH, w, h - skyH);
      ctx.fillStyle = WORLDS[this.nextPlotWorld].ground;
      ctx.fillRect(dxNew, skyH, w, h - skyH);
    } else {
      ctx.fillStyle = WORLDS[this.plotWorld].ground;
      ctx.fillRect(0, skyH, w, h - skyH);
    }

    this.plot.renderGroundLayer(ctx, dxOld, WORLDS[this.plotWorld].tuft);
    if (this.nextPlot) {
      this.nextPlot.renderGroundLayer(ctx, dxNew, WORLDS[this.nextPlotWorld].tuft);
    }

    const capPalette = this.capPalette();
    if (!sliding) {
      type Drawable = { y: number; draw: () => void };
      const drawables: Drawable[] = [];
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
        drawables.push({ y: wc.y + 0.5, draw: () => wc.render(ctx, capPalette) });
      }
      if (this.spot) {
        const spot = this.spot;
        drawables.push({
          y: spot.tree.y + 0.6,
          draw: () => {
            const frame = Math.floor(this.animT * 3) % 2 === 0 ? GLOW_SM : GLOW_LG;
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
    } else {
      withPalette(this.treePalette(this.plotWorld), () => {
        for (const tree of [...this.plot.forest.trees].sort((a, b) => a.y - b.y)) {
          this.plot.forest.renderTree(ctx, tree, dxOld);
        }
      });
      if (this.nextPlot) {
        withPalette(this.treePalette(this.nextPlotWorld), () => {
          for (const tree of [...this.nextPlot!.forest.trees].sort((a, b) => a.y - b.y)) {
            this.nextPlot!.forest.renderTree(ctx, tree, dxNew);
          }
        });
      }
      for (const wc of this.woodcutters.values()) {
        wc.render(ctx, capPalette);
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

    // HUD top-left: wood, amber, focus bar.
    drawSprite(ctx, LOG, 2, 2);
    const woodLabel = abbrev(this.save.wood);
    drawText(ctx, woodLabel, 13, 3, "#1d2b21");
    drawText(ctx, woodLabel, 12, 2, WOOD_COLOR);

    drawSprite(ctx, AMBER_GEM, 3, 9);
    const amberLabel = abbrev(this.save.amber);
    drawText(ctx, amberLabel, 13, 10, "#1d2b21");
    drawText(ctx, amberLabel, 12, 9, "#ffd75e");

    ctx.fillStyle = "#1d2b21";
    ctx.fillRect(2, 16, 28, 5);
    ctx.fillStyle = "#12324a";
    ctx.fillRect(3, 17, 26, 3);
    ctx.fillStyle = this.save.focus > 0 ? "#6fb7ff" : "#3a5a74";
    ctx.fillRect(3, 17, Math.round((26 * this.save.focus) / FOCUS_CAP), 3);

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
}

