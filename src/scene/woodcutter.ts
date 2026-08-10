// One woodcutter per active source (session or subagent), plus gnome
// helpers. Walks in, chops while token-backed work arrives, sits while the
// AI waits for input, walks out when idle.
//
// Idle-game rule: a swing only happens when the pending queue holds a
// token-backed (or gnome) chop — damage is gated on usage, not wall-clock.
// With an empty queue the woodcutter stands ready at its tree.

import { Forest, Tree } from "./forest";
import {
  drawSprite,
  spriteSize,
  WC_CHOP_DOWN,
  WC_CHOP_UP,
  WC_SIT,
  WC_STAND,
  WC_WALK1,
  WC_WALK2,
  withPalette,
} from "./sprites";

export type Activity = "working" | "waiting";
export type CutterVariant = "cutter" | "gnome";

export interface PendingChop {
  tokens: number; // 0 for gnome chops (suppresses the "-N" float)
  hits: number; // damage multiplier — folded bursts keep their hits
}

const WALK_SPEED = 22; // px/s
const CHOP_SECS = 0.6;
const MAX_PENDING = 3;

const GNOME_PALETTE = { C: "#4a9e5c", R: "#7a5230", r: "#5c3e24" };

/** Slots around the elder so several woodcutters can work it at once. */
const ELDER_SLOTS: { side: 1 | -1; dy: number }[] = [
  { side: -1, dy: 0 },
  { side: 1, dy: 0 },
  { side: -1, dy: 5 },
  { side: 1, dy: 5 },
];

function slotHash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export type ChopHandler = (
  tree: Tree,
  chop: PendingChop,
  x: number,
  y: number,
) => void;

type Mode = "enter" | "toTree" | "chop" | "sit" | "leave" | "travel";

export class Woodcutter {
  x: number;
  y: number;
  activity: Activity = "working";
  leaving = false;
  gone = false;
  /** Helper modifiers, set by the Game from owned upgrades. */
  walkMult = 1;
  chopDurFactor = 1;

  private mode: Mode = "enter";
  private facing: 1 | -1 = 1;
  private tree: Tree | null = null;
  private side: 1 | -1 = -1;
  private standDy = 0;
  private chopT = 0;
  private swinging = false;
  private walkT = 0;
  private impactFired = false;
  private pending: PendingChop[] = [];

  constructor(
    public readonly id: string,
    public readonly isSubagent: boolean,
    entryY: number,
    public readonly variant: CutterVariant = "cutter",
  ) {
    this.x = -12;
    this.y = entryY;
  }

  enqueue(chop: PendingChop): void {
    if (this.pending.length >= MAX_PENDING) {
      // Fold into the newest entry — tokens AND hits, so no damage is lost.
      const last = this.pending[this.pending.length - 1];
      last.tokens += chop.tokens;
      last.hits += chop.hits;
    } else {
      this.pending.push(chop);
    }
  }

  hasPending(): boolean {
    return this.pending.length > 0;
  }

  releaseTree(): void {
    if (this.tree && this.tree.claimedBy === this.id) {
      this.tree.claimedBy = null;
    }
    this.tree = null;
  }

  private acquireTree(forest: Forest): void {
    this.releaseTree();
    const tree = forest.nearestStanding(this.x, this.y, this.id);
    if (!tree) return;
    this.tree = tree;
    if (tree.kind === "elder") {
      const slot = ELDER_SLOTS[slotHash(this.id) % ELDER_SLOTS.length];
      this.side = slot.side;
      this.standDy = slot.dy;
    } else {
      tree.claimedBy = this.id;
      this.side = this.x <= tree.x + tree.width / 2 ? -1 : 1;
      this.standDy = 0;
    }
  }

  private standX(): number {
    if (!this.tree) return this.x;
    const wcW = spriteSize(WC_STAND).w;
    return this.side === -1
      ? this.tree.x - wcW + 2
      : this.tree.x + this.tree.width - 3;
  }

  private standY(): number {
    return this.tree ? this.tree.y + this.standDy : this.y;
  }

  private atTree(): boolean {
    return (
      this.tree !== null &&
      Math.abs(this.x - this.standX()) < 1.5 &&
      Math.abs(this.y - this.standY()) < 2
    );
  }

  repath(): void {
    if (this.mode === "chop" && !this.atTree()) {
      this.mode = "toTree";
      this.resetSwing();
    }
  }

  startTravel(): void {
    this.releaseTree();
    this.mode = "travel";
  }

  arriveAtNewPlot(index: number): void {
    this.releaseTree();
    this.x = -12 - index * 9;
    this.mode = "enter";
    this.resetSwing();
  }

  private resetSwing(): void {
    this.chopT = 0;
    this.swinging = false;
    this.impactFired = false;
  }

  update(dt: number, forest: Forest, onChop: ChopHandler): void {
    if (this.leaving && this.mode !== "leave") {
      this.releaseTree();
      this.mode = "leave";
    }

    switch (this.mode) {
      case "enter":
      case "toTree": {
        if (!this.tree || !this.tree.standing) {
          this.acquireTree(forest);
        }
        if (!this.tree) {
          break;
        }
        this.walkToward(this.standX(), this.standY(), dt);
        if (this.atTree()) {
          this.mode = this.activity === "waiting" ? "sit" : "chop";
          this.resetSwing();
        }
        break;
      }
      case "chop": {
        if (this.activity === "waiting" && !this.swinging) {
          this.mode = "sit";
          break;
        }
        if (!this.tree || !this.tree.standing) {
          this.acquireTree(forest);
          this.mode = "toTree";
          this.resetSwing();
          break;
        }
        if (!this.atTree()) {
          this.mode = "toTree";
          this.resetSwing();
          break;
        }
        // Token gate: start a swing only when a chop is queued.
        if (!this.swinging) {
          if (this.pending.length === 0) {
            break; // ready stance
          }
          this.swinging = true;
        }
        this.faceTree();
        this.chopT += dt / (CHOP_SECS * this.chopDurFactor);
        if (this.chopT >= 0.5 && !this.impactFired) {
          this.impactFired = true;
          const chop = this.pending.shift();
          if (chop) {
            const size = spriteSize(WC_CHOP_DOWN);
            onChop(this.tree, chop, this.x + size.w / 2, this.y - size.h - 2);
          }
        }
        if (this.chopT >= 1) {
          this.resetSwing();
        }
        break;
      }
      case "sit": {
        if (this.activity === "working") {
          this.mode = this.tree && this.tree.standing && this.atTree() ? "chop" : "toTree";
          this.resetSwing();
        }
        break;
      }
      case "leave": {
        this.walkToward(-16, this.y, dt);
        if (this.x <= -14) {
          this.gone = true;
        }
        break;
      }
      case "travel": {
        this.walkToward(this.x + 100, this.y, dt);
        break;
      }
    }
  }

  private faceTree(): void {
    if (this.tree) {
      this.facing = this.side === -1 ? 1 : -1;
    }
  }

  private walkToward(tx: number, ty: number, dt: number): void {
    this.walkT += dt;
    const dx = tx - this.x;
    const dy = ty - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) return;
    const step = Math.min(dist, WALK_SPEED * this.walkMult * dt);
    this.x += (dx / dist) * step;
    this.y += (dy / dist) * step;
    if (Math.abs(dx) > 0.5) {
      this.facing = dx > 0 ? 1 : -1;
    }
  }

  render(ctx: CanvasRenderingContext2D, capPalette: Record<string, string> | null): void {
    let map;
    switch (this.mode) {
      case "enter":
      case "toTree":
      case "leave":
      case "travel":
        map = Math.floor(this.walkT * 6) % 2 === 0 ? WC_WALK1 : WC_WALK2;
        break;
      case "chop":
        map = this.swinging ? (this.chopT < 0.5 ? WC_CHOP_UP : WC_CHOP_DOWN) : WC_STAND;
        break;
      case "sit":
        map = WC_SIT;
        break;
      default:
        map = WC_STAND;
    }
    const { h } = spriteSize(map);
    const palette = this.variant === "gnome" ? GNOME_PALETTE : capPalette;
    withPalette(palette, () => {
      drawSprite(ctx, map, Math.round(this.x), Math.round(this.y - h), this.facing === -1);
    });
    if (this.isSubagent) {
      ctx.fillStyle = "#ffd75e";
      ctx.fillRect(Math.round(this.x) + 3, Math.round(this.y - h) - 2, 2, 1);
    }
  }
}
