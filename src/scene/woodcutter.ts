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
  RARITY_WOODCUTTER_SPRITES,
  spriteSize,
  withPalette,
  type PixelMap,
  type WorkerRarity,
} from "./sprites";
import { drawHeldWeapon, WEAPON_APPEARANCE, type WeaponPoseName } from "./weapons";
import type { Rarity } from "../economy";

export type Activity = "working" | "waiting";
export type CutterVariant = "cutter" | "gnome";

export interface PendingChop {
  tokens: number; // 0 for gnome chops (suppresses the "-N" float)
  hits: number; // damage multiplier — folded bursts keep their hits
  /** Wood-yield multiplier from a POV skill-check grade (great/good/miss).
   * Never affects damage/stats — only the wood value resolveChop pays out. */
  yieldMult?: number;
}

/** Impact payload for a manual (unqueued) POV swing — see `manualSwing`/
 * `manualChop` and beginSwing()/takeManualChop() below. `x`/`y` mirror the
 * position onChop is normally called at (this cutter's own sprite), for
 * Game to place its slash/spark effect and floating text. */
export interface ManualChop {
  hits: number;
  yieldMult: number;
  x: number;
  y: number;
}

const WALK_SPEED = 22; // px/s
const CHOP_SECS = 0.6;
const MAX_PENDING = 3;
/** frenzyBurst item effect: swings land ~43% faster (duration ×0.7) while
 * burstT is still counting down — a per-cutter analog of the account-wide
 * golden-spot Frenzy (×0.5) / keenEdge (×0.75), scoped to just this cutter
 * so it reads as "this axe" reacting to a Great hit, not a global buff. */
const FRENZY_BURST_FACTOR = 0.7;
/** Idle "breathing" bob amplitude/frequency — see render()'s `idle` bob. */
const IDLE_BOB_AMP = 1.5;
const IDLE_BOB_FREQ = (Math.PI * 2) / 1.6; // ~1.6s period

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
  wc: Woodcutter,
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
  /** Roster member this live session is currently assigned to (see Game's
   * slot-assignment algorithm), or null for a default-worker filler. */
  memberId: string | null = null;
  /** Visual tier of the assigned member — drives sprite silhouette. */
  rarity: WorkerRarity = "common";
  /** Rarity of the assigned member's equipped Woodchopping item, or
   * "common" for a null/filler member — set by Game alongside `rarity`
   * (see applySnapshot). Woodchopping always shows a weapon (never
   * bare-handed), so unlike `rarity` there's no "no weapon" state; this
   * just picks which of the 4 tiers to draw. Gnomes never have this field
   * touched (no memberId is ever assigned to a gnome), so the "common"
   * default here — same trick `rarity` already relies on — is exactly the
   * gnome special-case, made explicit in resolvedWeaponRarity() below. */
  weaponRarity: Rarity = "common";
  /** Per-character palette overlay of the assigned member's WorkerDef (see
   * economy.ts's WorkerDef.accent), or null for a filler/gnome — set by
   * Game alongside `rarity`/`weaponRarity` (see applySnapshot). Merged into
   * whatever world/cap palette the caller passes, in paletteOverride()
   * below. */
  accent: Record<string, string> | null = null;
  /** Set by Game while this cutter is the POV target. Gates the swing on
   * player input instead of firing automatically. Inert (false) for every
   * other cutter — byte-for-byte no-op on the background chop loop. */
  povGate = false;
  /** True while this cutter is the POV target, no swing is in progress, and
   * it's sitting idle at its tree waiting for the player to click to start
   * one — set instead of the background loop's fully-automatic
   * `swinging = true` as soon as `pending.length > 0`. True regardless of
   * whether any token-work happens to be queued (see beginSwing()). Never
   * true for a non-POV cutter — inert like povGate above. */
  awaitingStart = false;
  /** True while a swing is frozen at the raised-axe pose, waiting for
   * Game.resolveSkillCheck() to grade the player's timing. */
  awaitingInput = false;

  private mode: Mode = "enter";
  private facingDir: 1 | -1 = 1;
  private tree: Tree | null = null;
  private side: 1 | -1 = -1;
  private standDy = 0;
  private chopT = 0;
  private swinging = false;
  private walkT = 0;
  private impactFired = false;
  private pending: PendingChop[] = [];
  private pendingYieldMult: number | null = null;
  /** True for a swing started by beginSwing() while no token-work happened
   * to be queued at that instant — routes its impact through `manualChop`
   * below instead of `pending`/onChop, so it can never consume a queue
   * entry it has nothing to do with. */
  private manualSwing = false;
  /** Set at a manual swing's impact frame with the literal chop to resolve.
   * Game.update() drains this every tick via takeManualChop() and resolves
   * it with a direct resolveChop call, mirroring the golden-spot/plain-
   * tree-click manual-chop precedents in game.ts (spends 1 Focus, no
   * `pending`/onChop involved). */
  private manualChop: ManualChop | null = null;
  /** frenzyBurst item effect: seconds remaining of faster swings, granted by
   * Game.applyWoodchoppingItemEffects on a Great POV skill-check result. */
  private burstT = 0;
  /** Free-running dt-accumulated clock (mirrors walkT's role for the walk
   * cycle) used only to phase the idle "breathing" bob in render() below —
   * unlike walkT, this keeps advancing while genuinely idle-standing
   * (mode "chop", not swinging), which is the only state that reads it. */
  private idleT = 0;

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

  get currentTree(): Tree | null {
    return this.tree;
  }

  get facing(): 1 | -1 {
    return this.facingDir;
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
    const wcW = spriteSize(RARITY_WOODCUTTER_SPRITES[this.rarity].stand).w;
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
    this.awaitingStart = false;
    this.awaitingInput = false;
    this.pendingYieldMult = null;
    this.manualSwing = false;
    this.manualChop = null;
  }

  /** frenzyBurst item effect: (re)arms `secs` of faster swings — takes the
   * longer of the requested duration and whatever's already running, so it
   * never gets cut short by a weaker re-trigger. */
  grantBurst(secs: number): void {
    this.burstT = Math.max(this.burstT, secs);
  }

  /** Called by Game when this cutter becomes the POV target. */
  beginPov(): void {
    this.povGate = true;
  }

  /** Called by Game on POV exit. Un-freezes any held swing — the next
   * update() resumes chopT from wherever it was and fires normally. */
  endPov(): void {
    this.povGate = false;
    this.awaitingStart = false;
    this.awaitingInput = false;
    this.pendingYieldMult = null;
  }

  /** Called by Game (via handlePovInput) when the player clicks/Spaces this
   * cutter while it's the POV target and awaitingStart is true. Starts the
   * windup exactly like the background loop's automatic swing, but records
   * whether any token-work happened to be queued at this exact instant —
   * the impact-fire logic in update() below uses that to decide whether
   * this swing pays out through the pending queue (onChop) or as a manual
   * tokenless chop (manualChop/takeManualChop, mirroring the golden-spot/
   * plain-tree-click manual-chop precedents in game.ts). No-op if a swing
   * is already underway. */
  beginSwing(): void {
    if (!this.awaitingStart) return;
    this.awaitingStart = false;
    this.swinging = true;
    this.chopT = 0;
    this.manualSwing = this.pending.length === 0;
  }

  /** Game grades the live skill check and hands back a wood-yield
   * multiplier; the held swing resumes and fires on the next update(). */
  resolveSkillCheck(yieldMult: number): void {
    this.pendingYieldMult = yieldMult;
    this.awaitingInput = false;
  }

  /** Drains whatever a manual swing's impact frame produced (or null, the
   * overwhelming majority of ticks) — see beginSwing()'s doc comment.
   * Called once per tick, for every cutter, from Game.update(). */
  takeManualChop(): ManualChop | null {
    const chop = this.manualChop;
    this.manualChop = null;
    return chop;
  }

  update(dt: number, forest: Forest, onChop: ChopHandler): void {
    this.idleT += dt;
    if (this.burstT > 0) this.burstT = Math.max(0, this.burstT - dt);
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
        // Token gate: start a swing only when a chop is queued — except
        // while this cutter is the POV target, where the player's click
        // (beginSwing(), routed in via Game) is what starts a swing
        // instead, regardless of whether any token-work happens to be
        // queued yet. Inert for every non-POV cutter — povGate is only
        // ever true for the current POV target, so the background chop
        // loop's fully-automatic behavior is untouched.
        if (!this.swinging) {
          if (this.povGate) {
            this.awaitingStart = true;
            break; // ready stance — wait for beginSwing()
          }
          if (this.pending.length === 0) {
            break; // ready stance
          }
          this.swinging = true;
        }
        this.faceTree();
        // POV gate: hold the swing frozen at the raised-axe pose (chopT just
        // under 0.5, so currentFrame() keeps showing chopUp) instead of
        // advancing, until Game grades a skill check via resolveSkillCheck().
        // Inert for every non-POV cutter — awaitingInput never becomes true.
        if (!this.awaitingInput) {
          const burstFactor = this.burstT > 0 ? FRENZY_BURST_FACTOR : 1;
          this.chopT += dt / (CHOP_SECS * this.chopDurFactor * burstFactor);
        }
        if (this.chopT >= 0.45 && !this.impactFired) {
          if (this.povGate && this.pendingYieldMult === null) {
            this.awaitingInput = true;
          } else {
            this.impactFired = true;
            this.awaitingInput = false;
            if (this.manualSwing) {
              // Manual POV swing — no token-work was queued when it
              // started (beginSwing()), so it resolves through
              // manualChop/takeManualChop instead of the pending queue:
              // Game.update() drains this and pays it out with a direct
              // resolveChop call, exactly like the golden-spot/plain-
              // tree-click manual-chop precedents in game.ts.
              const size = spriteSize(RARITY_WOODCUTTER_SPRITES[this.rarity].chopDown);
              this.manualChop = {
                hits: 1,
                yieldMult: this.pendingYieldMult ?? 1,
                x: this.x + size.w / 2,
                y: this.y - size.h - 2,
              };
              this.pendingYieldMult = null;
            } else {
              const chop = this.pending.shift();
              if (chop) {
                if (this.povGate) {
                  chop.yieldMult = this.pendingYieldMult ?? 1;
                }
                this.pendingYieldMult = null;
                const size = spriteSize(RARITY_WOODCUTTER_SPRITES[this.rarity].chopDown);
                onChop(this.tree, chop, this.x + size.w / 2, this.y - size.h - 2, this);
              }
            }
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
      this.facingDir = this.side === -1 ? 1 : -1;
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
      this.facingDir = dx > 0 ? 1 : -1;
    }
  }

  /** Current animation frame, driven by mode/swing/walk state. Factored out
   * so POV close-up rendering (Game.renderPov) can never desync from the
   * normal world render below. */
  /** Whether this cutter is actually in a position to swing an axe right now.
   *
   * A cutter whose session is idle sits down with no tree claimed (mode "sit"),
   * and one that's leaving/entering is mid-walk. Entering POV on any of those
   * put the player in a close-up where clicking did nothing at all, with no
   * explanation — so POV is gated on this instead. */
  get readyToChop(): boolean {
    return (
      !this.gone &&
      !this.leaving &&
      this.mode === "chop" &&
      !!this.currentTree &&
      this.currentTree.standing
    );
  }

  currentFrame(): PixelMap {
    const frames = this.variant === "gnome" ? RARITY_WOODCUTTER_SPRITES.common : RARITY_WOODCUTTER_SPRITES[this.rarity];
    switch (this.mode) {
      case "enter":
      case "toTree":
      case "leave":
      case "travel":
        return Math.floor(this.walkT * 6) % 2 === 0 ? frames.walk1 : frames.walk2;
      case "chop":
        return this.swinging ? (this.chopT < 0.5 ? frames.chopUp : frames.chopDown) : frames.stand;
      case "sit":
        return frames.sit;
      default:
        return frames.stand;
    }
  }

  /** Gnomes always render with their own fixed palette, ignoring whatever
   * world/cap palette the caller passes — same rule normal render() uses.
   * Otherwise merges in this cutter's per-character accent (if any) on top
   * of `base` — accent letters (C/N/H/h/Y/y) never overlap the letters a
   * world palette tints (R/r), so merge order is a non-issue in practice,
   * but accent is spread last so it would win if that ever changed. */
  paletteOverride(base: Record<string, string> | null): Record<string, string> | null {
    if (this.variant === "gnome") return GNOME_PALETTE;
    return this.accent ? { ...(base ?? {}), ...this.accent } : base;
  }

  /** Gnomes always chop with a plain common-tier axe, ignoring whatever
   * weaponRarity happens to be set — mirrors paletteOverride()'s gnome
   * special-case above. In practice weaponRarity is never reassigned away
   * from its "common" field default for a gnome (no memberId is ever
   * assigned to one — see Game.refreshModifiers), so this is a belt-and-
   * braces guard rather than a load-bearing branch. */
  resolvedWeaponRarity(): Rarity {
    return this.variant === "gnome" ? "common" : this.weaponRarity;
  }

  /** Which pose (if any) the currently-held Woodchopping weapon should draw
   * in, mirroring currentFrame()'s own mode/swing/chopT switch above so the
   * weapon can never desync from the body frame it's held against. `sit`
   * (and any other non-chopping mode) omits the weapon — mirrors the
   * existing convention that the `hurt`/`defeated`/`sit` body frames never
   * show `A`/`w` either. */
  currentWeaponPose(): WeaponPoseName | null {
    switch (this.mode) {
      case "enter":
      case "toTree":
      case "leave":
      case "travel":
        return "idle";
      case "chop":
        if (!this.swinging) return "idle";
        return this.chopT < 0.5 ? "attackWindup" : "attackStrike";
      case "sit":
        return null;
      default:
        return "idle";
    }
  }

  render(
    ctx: CanvasRenderingContext2D,
    palette: Record<string, string> | null,
    weaponPalette: Record<string, string> | null = null,
  ): void {
    const map = this.currentFrame();
    const { h } = spriteSize(map);
    const flip = this.facingDir === -1;
    // Small procedural "breathing" bob — only while genuinely idle-standing
    // at the tree (mode "chop", not mid-swing; currentFrame()'s only other
    // source of the `stand` sprite), applied to the draw position alone so
    // it never touches chopT/swing timing.
    const idle = this.mode === "chop" && !this.swinging;
    const bob = idle ? Math.round(Math.sin(this.idleT * IDLE_BOB_FREQ) * IDLE_BOB_AMP) : 0;
    withPalette(this.paletteOverride(palette), () => {
      drawSprite(ctx, map, Math.round(this.x), Math.round(this.y - h) + bob, flip);
    });
    const weaponPose = this.currentWeaponPose();
    if (weaponPose) {
      const held = WEAPON_APPEARANCE.woodchopping[this.resolvedWeaponRarity()].held;
      if (held) {
        drawHeldWeapon(ctx, held, weaponPose, weaponPalette, flip, Math.round(this.x), Math.round(this.y) + bob);
      }
    }
    if (this.isSubagent) {
      ctx.fillStyle = "#ffd75e";
      ctx.fillRect(Math.round(this.x) + 3, Math.round(this.y - h) - 2, 2, 1);
    }
  }
}
