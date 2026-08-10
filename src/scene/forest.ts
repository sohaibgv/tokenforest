// One plot's trees. Slots are seeded + normalized (resize-proof).
//
// Idle-game model: trees have hit points (small 1, medium 3, large 5,
// elder 30 — × the world's multiplier) and fall only when chop damage
// (token-backed or gnome) drains them. Nothing budget-driven fells trees.

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
}

const KIND_SPECS: Record<TreeKind, KindSpec> = {
  small: { hits: 1, sprite: TREE_SM, stump: STUMP },
  medium: { hits: 3, sprite: TREE, stump: STUMP },
  large: { hits: 5, sprite: TREE_LG, stump: STUMP_LG },
  elder: { hits: 30, sprite: TREE_ELDER, stump: STUMP_XL },
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
  // Absolute base position, recomputed from (nx, ny) on resize.
  x = 0;
  y = 0;

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

export class Forest {
  /** Creation order is stable — hpSnapshot/restoreHp index into it. */
  trees: Tree[] = [];

  constructor(
    rand: () => number,
    treeCount: number,
    hpMult: number,
    avoidNormalized?: (nx: number, ny: number) => boolean,
  ) {
    const kinds = kindsFor(treeCount, rand);
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

  resize(w: number, groundTop: number, groundBottom: number): void {
    for (const tree of this.trees) {
      tree.x = Math.round(2 + tree.nx * (w - tree.width - 6));
      tree.y = Math.round(groundTop + 10 + tree.ny * (groundBottom - groundTop - 12));
    }
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
        const jitter = tree.shake > 0 && Math.floor(tree.shake * 10) % 2 === 0 ? 1 : 0;
        drawSprite(ctx, spec.sprite, tree.x + jitter + dx, tree.y - h);
        break;
      }
      case "falling": {
        ctx.save();
        ctx.translate(baseX, tree.y);
        ctx.rotate((Math.PI / 2) * Math.min(1, tree.t) * Math.min(1, tree.t));
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
