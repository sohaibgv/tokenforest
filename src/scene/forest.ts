// One plot's trees. Slots are seeded + normalized (resize-proof).
//
// Idle-game model: trees have hit points (small 1, medium 3, large 5,
// elder 30 — × the world's multiplier) and fall only when chop damage
// (token-backed or gnome) drains them. Nothing budget-driven fells trees.

import { Grid, type Cell } from "./grid";
import {
  drawSprite,
  PixelMap,
  spriteSize,
  STUMP,
  STUMP_LG,
  STUMP_XL,
  TREE,
  TREE_ELDER,
  TREE_LG,
  TREE_SM,
  TREE_SMALL,
} from "./sprites";

const FALL_SECS = 0.7;
const SPROUT_SECS = 0.5;

export type TreeKind = "small" | "medium" | "large" | "elder";

interface KindSpec {
  hits: number;
  sprite: PixelMap;
  stump: PixelMap;
  /** How many rows from the top are canopy (vs. trunk) — counted by hand
   * off each sprite's own pixel data. Idle sway (see renderTree) only
   * shears these rows, so the trunk base stays planted while the canopy
   * gently bends, instead of the whole tree sliding as one rigid block. */
  canopyRows: number;
}

const KIND_SPECS: Record<TreeKind, KindSpec> = {
  small: { hits: 1, sprite: TREE_SM, stump: STUMP, canopyRows: 5 },
  medium: { hits: 3, sprite: TREE, stump: STUMP, canopyRows: 10 },
  large: { hits: 5, sprite: TREE_LG, stump: STUMP_LG, canopyRows: 13 },
  elder: { hits: 30, sprite: TREE_ELDER, stump: STUMP_XL, canopyRows: 14 },
};

type TreeState = "standing" | "falling" | "stump" | "sprouting";

export class Tree {
  state: TreeState = "standing";
  t = 0;
  delay = 0;
  shake = 0;
  hp: number;
  readonly maxHp: number;
  /** Trunk-base sprite width, used by woodcutters to stand beside it. */
  readonly width: number;
  /** Sprite height, for click hit-testing. */
  readonly height: number;
  /** Seconds since last damage (counts down); >0 qualifies for golden spots. */
  recentHit = 0;
  /** Woodcutter id working this tree, so others pick a different one. */
  claimedBy: string | null = null;
  /** Deterministic per-tree phase offset for idle canopy sway (see
   * renderTree) — derived from the tree's own (nx, ny), not a fresh RNG
   * draw, so it never perturbs the seeded generation sequence (position
   * rolls, kind shuffle) that plot layouts already depend on. */
  readonly swayPhase: number;
  // Absolute base position, recomputed from (nx, ny) on resize.
  x = 0;
  y = 0;
  /** Grid cell this tree occupies (assigned in Forest.resize). */
  cell: Cell = { cx: 0, cy: 0 };

  constructor(
    public nx: number,
    public ny: number,
    public readonly kind: TreeKind,
    hpMult: number,
  ) {
    this.maxHp = KIND_SPECS[kind].hits * hpMult;
    this.hp = this.maxHp;
    const size = spriteSize(KIND_SPECS[kind].sprite);
    this.width = size.w;
    this.height = size.h;
    this.swayPhase = ((nx * 97.13 + ny * 57.71) % 1) * Math.PI * 2;
  }

  get standing(): boolean {
    return this.state === "standing";
  }
}

/** Size mix for a plot of `count` trees: one elder, then large/medium/small. */
function kindsFor(count: number, rand: () => number): TreeKind[] {
  const kinds: TreeKind[] = ["elder"];
  const large = Math.max(1, Math.round(count * 0.18));
  const medium = Math.max(1, Math.round(count * 0.36));
  for (let i = 0; i < large; i++) kinds.push("large");
  for (let i = 0; i < medium; i++) kinds.push("medium");
  while (kinds.length < count) kinds.push("small");
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  return kinds.slice(0, count);
}

// Idle sway: gentle, slow — a ~9s period keeps it a background ambience
// detail, never fighting for attention against the chop-hit jitter (which
// takes over entirely while `tree.shake > 0`, see renderTree).
const SWAY_FREQ = (Math.PI * 2) / 9;

export class Forest {
  /** Creation order is stable — hpSnapshot/restoreHp index into it. */
  trees: Tree[] = [];
  /** The plot's tile grid, rebuilt on every resize. */
  private grid = new Grid();
  /** Cell keys currently holding a tree. */
  private occupied = new Set<string>();
  /** Cell keys trees must not snap into — the homestead yard.
   *
   * Kept SEPARATE from `occupied` on purpose. `occupied` is the tree
   * occupancy map that buildable placement checks against; folding the yard
   * into it would mark every yard cell as taken and leave nowhere to build.
   * This set only blocks tree snapping. */
  private reserved = new Set<string>();
  /** Elapsed seconds, driving every standing tree's idle canopy sway. */
  private time = 0;

  constructor(
    rand: () => number,
    treeCount: number,
    hpMult: number,
    avoidNormalized?: (nx: number, ny: number) => boolean,
  ) {
    const kinds = kindsFor(treeCount, rand);
    // Trees still pick a normalized spot here (resolution-independent, and it's
    // what hpSnapshot ordering and lake avoidance already key off). The grid
    // quantises that spot to a cell at resize() time — see below — so the same
    // plot lays out identically at any window size while still being tile-based.
    for (const kind of kinds) {
      let nx = 0.5;
      let ny = 0.5;
      for (let attempt = 0; attempt < 12; attempt++) {
        if (kind === "elder") {
          nx = 0.3 + 0.4 * rand();
          ny = 0.3 + 0.4 * rand();
        } else {
          nx = rand();
          ny = rand();
        }
        if (!avoidNormalized || !avoidNormalized(nx, ny)) break;
      }
      this.trees.push(new Tree(nx, ny, kind, hpMult));
    }
  }

  /** Snaps every tree onto a grid cell, then places it at that cell's jittered
   * footing. Two trees are never allowed to share a cell — the loser spirals
   * out to the nearest free one — which is what turns a random scatter into a
   * real occupancy map that buildables can later reason about.
   *
   * The jitter is the whole reason this doesn't look like a chessboard: the
   * cell decides which tile a tree belongs to, `jitteredFooting` decides where
   * inside that tile it actually stands, deterministically per cell. */
  resize(
    w: number,
    groundTop: number,
    groundBottom: number,
    /** Cells the homestead occupies. Resolved lazily, AFTER the grid has
     * been resized, because the yard's footprint is derived from the grid's
     * own dimensions — asking for it before the resize would return the
     * previous window's yard. */
    reserved?: (grid: Grid) => Iterable<Cell>,
  ): void {
    this.grid.resize(w, groundTop, groundBottom);
    this.occupied.clear();
    this.reserved.clear();
    if (reserved) {
      for (const c of reserved(this.grid)) this.reserved.add(Grid.key(c));
    }

    for (const tree of this.trees) {
      const want = {
        cx: Math.min(this.grid.cols - 1, Math.floor(tree.nx * this.grid.cols)),
        cy: Math.min(this.grid.rows - 1, Math.floor(tree.ny * this.grid.rows)),
      };
      const cell = this.nearestFree(want);
      this.occupied.add(Grid.key(cell));
      tree.cell = cell;
      const foot = this.grid.jitteredFooting(cell);
      // Sprites draw upward from their base, and x is a left edge, so convert
      // the footing (bottom-centre) into the tree's own top-left anchor.
      tree.x = Math.max(1, Math.min(w - tree.width - 1, Math.round(foot.x - tree.width / 2)));
      tree.y = Math.max(groundTop + 6, Math.min(groundBottom, foot.y));
    }
  }

  /** Spiral outward from a wanted cell until a free in-bounds one is found.
   * Falls back to the wanted cell if the grid is genuinely full (only possible
   * when there are more trees than cells, i.e. a very small window). */
  private nearestFree(want: Cell): Cell {
    const free = (c: Cell): boolean => {
      const k = Grid.key(c);
      return this.grid.inBounds(c) && !this.occupied.has(k) && !this.reserved.has(k);
    };
    if (free(want)) return want;
    for (let r = 1; r <= Math.max(this.grid.cols, this.grid.rows); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
          const c = { cx: want.cx + dx, cy: want.cy + dy };
          if (free(c)) return c;
        }
      }
    }
    // Genuinely nowhere to go (more trees than free cells, i.e. a very small
    // window with a large yard). Falling back to `want` may land in the yard,
    // but dropping the tree would desync hpSnapshot's positional indexing.
    return want;
  }

  /** Cells currently taken by a tree — the base occupancy map that placement
   * logic (buildables) checks against. */
  occupiedCells(): ReadonlySet<string> {
    return this.occupied;
  }

  gridRef(): Grid {
    return this.grid;
  }

  standingCount(): number {
    return this.trees.filter((t) => t.standing).length;
  }

  /** All trees down and none still falling: time to move to the next plot. */
  cleared(): boolean {
    return !this.trees.some((t) => t.standing || t.state === "falling");
  }

  /** Per-slot HP for persistence (<= 0 encodes a stump). */
  hpSnapshot(): number[] {
    return this.trees.map((t) => (t.standing || t.state === "falling" ? t.hp : 0));
  }

  restoreHp(hp: number[]): void {
    for (let i = 0; i < this.trees.length && i < hp.length; i++) {
      if (hp[i] <= 0) {
        this.trees[i].state = "stump";
      } else {
        this.trees[i].hp = Math.min(hp[i], this.trees[i].maxHp);
      }
    }
  }

  /**
   * Nearest standing tree by true 2D distance, preferring trees not claimed
   * by another woodcutter. The elder is only offered once it is the last
   * tree standing — and then it's offered to everyone at once.
   */
  nearestStanding(x: number, y: number, claimant?: string): Tree | null {
    let bestFree: Tree | null = null;
    let bestFreeD = Infinity;
    let bestAny: Tree | null = null;
    let bestAnyD = Infinity;
    let elder: Tree | null = null;
    for (const tree of this.trees) {
      if (!tree.standing) continue;
      if (tree.kind === "elder") {
        elder = tree;
        continue;
      }
      const dx = tree.x - x;
      const dy = (tree.y - y) * 1.5;
      const d = dx * dx + dy * dy;
      if (d < bestAnyD) {
        bestAnyD = d;
        bestAny = tree;
      }
      const free = !tree.claimedBy || tree.claimedBy === claimant;
      if (free && d < bestFreeD) {
        bestFreeD = d;
        bestFree = tree;
      }
    }
    return bestFree ?? bestAny ?? elder;
  }

  /** Visually topmost standing tree whose sprite box contains the point. */
  treeAt(x: number, y: number): Tree | null {
    const standing = this.trees
      .filter((t) => t.standing)
      .sort((a, b) => b.y - a.y);
    for (const t of standing) {
      if (
        x >= t.x - 1 &&
        x <= t.x + t.width + 1 &&
        y >= t.y - t.height &&
        y <= t.y + 1
      ) {
        return t;
      }
    }
    return null;
  }

  /** Up to `n` nearest OTHER standing trees to `tree`, by the same weighted
   * 2D distance nearestStanding uses — feeds the timberSplash item effect's
   * splash damage. */
  neighborsOf(tree: Tree, n: number): Tree[] {
    return this.trees
      .filter((t) => t !== tree && t.standing)
      .map((t) => ({ t, d: (t.x - tree.x) ** 2 + ((t.y - tree.y) * 1.5) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, n)
      .map((entry) => entry.t);
  }

  /** Deal chop damage. Returns true if this blow felled the tree. */
  applyDamage(tree: Tree, damage: number): boolean {
    if (!tree.standing) return false;
    tree.shake = 1;
    tree.recentHit = 4;
    tree.hp -= damage;
    if (tree.hp <= 0) {
      tree.state = "falling";
      tree.t = 0;
      return true;
    }
    return false;
  }

  update(dt: number): void {
    this.time += dt;
    for (const tree of this.trees) {
      tree.shake = Math.max(0, tree.shake - dt * 4);
      tree.recentHit = Math.max(0, tree.recentHit - dt);
      if (tree.state === "falling") {
        tree.t += dt / FALL_SECS;
        if (tree.t >= 1) {
          tree.state = "stump";
          tree.t = 0;
        }
      } else if (tree.state === "sprouting") {
        if (tree.delay > 0) {
          tree.delay -= dt;
          continue;
        }
        tree.t += dt / SPROUT_SECS;
        if (tree.t >= 1) {
          tree.state = "standing";
          tree.t = 0;
          tree.hp = tree.maxHp;
        }
      }
    }
  }

  renderTree(ctx: CanvasRenderingContext2D, tree: Tree, dx: number): void {
    const spec = KIND_SPECS[tree.kind];
    const { w, h } = spriteSize(spec.sprite);
    const baseX = tree.x + Math.round(w / 2) + dx;
    switch (tree.state) {
      case "standing": {
        if (tree.shake > 0) {
          // Just hit: the sharp whole-sprite jitter reads as impact —
          // takes over entirely, no idle sway competing with it.
          const jitter = Math.floor(tree.shake * 10) % 2 === 0 ? 1 : 0;
          drawSprite(ctx, spec.sprite, tree.x + jitter + dx, tree.y - h);
        } else {
          // Idle: canopy-only shear (trunk rows stay put, canopy rows
          // shift by the same 1px) — a tree bending gently in a breeze
          // rather than sliding as one rigid block. -1/0/1 is the finest
          // resolution this pixel grid has; sin's slow SWAY_FREQ plus each
          // tree's own swayPhase keeps a whole forest from swaying in
          // lockstep.
          const sway = Math.round(Math.sin(this.time * SWAY_FREQ + tree.swayPhase));
          const x = tree.x + dx;
          const y = tree.y - h;
          for (let row = 0; row < spec.sprite.length; row++) {
            const rowOffset = row < spec.canopyRows ? sway : 0;
            drawSprite(ctx, [spec.sprite[row]], x + rowOffset, y + row);
          }
        }
        break;
      }
      case "falling": {
        ctx.save();
        ctx.translate(baseX, tree.y);
        const t = Math.min(1, tree.t);
        ctx.rotate((Math.PI / 2) * t * t);
        // Squash-and-stretch: the trunk stretches along its length as it
        // gathers speed, then squashes hard at impact (last ~15% of the
        // fall) — classic animation weight, all inside the existing
        // rotate-around-the-base transform.
        if (t < 0.85) {
          const stretch = 1 + 0.08 * (t / 0.85);
          ctx.scale(1 / Math.sqrt(stretch), stretch);
        } else {
          const impact = (t - 0.85) / 0.15;
          const squash = 1 - 0.18 * impact;
          ctx.scale(1 / squash, squash);
        }
        drawSprite(ctx, spec.sprite, -Math.round(w / 2), -h);
        ctx.restore();
        break;
      }
      case "stump": {
        const s = spriteSize(spec.stump);
        drawSprite(ctx, spec.stump, baseX - Math.round(s.w / 2), tree.y - s.h);
        break;
      }
      case "sprouting": {
        if (tree.delay > 0) {
          const s = spriteSize(spec.stump);
          drawSprite(ctx, spec.stump, baseX - Math.round(s.w / 2), tree.y - s.h);
        } else if (tree.t < 0.5) {
          const s = spriteSize(TREE_SMALL);
          drawSprite(ctx, TREE_SMALL, baseX - Math.round(s.w / 2), tree.y - s.h);
        } else {
          drawSprite(ctx, spec.sprite, tree.x + dx, tree.y - h);
        }
        break;
      }
    }
  }
}
