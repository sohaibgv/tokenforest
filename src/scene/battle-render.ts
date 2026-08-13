// The battle scene renderer.
//
// Lifted out of scene/game.ts, where it was the single largest method in the
// file at ~340 lines. It takes an explicit BattleRenderView instead of the
// Game instance: the interface below IS this renderer's real coupling to the
// rest of the game, and having it written down is the point. Twenty-seven
// entries is a lot, but it was always twenty-seven — the difference is that
// it used to be spelled as `this.` and invisible.
//
// Extracting scene/battle-layout.ts first is what made this tractable: a
// third of the original coupling was calls to the formation/slot/zoom
// helpers, which are pure and now imported directly.

import { ENEMY_CHARACTERS_BY_ID } from "../adventure";
import type { BattleSnapshot } from "../battle";
import type { SkillCheck, SkillGrade } from "./game";
import { getWorld, WORKER_DEFS_BY_ID } from "../economy";
import type { GameSave } from "../game-state";
import { equippedItem, type TeamMemberSave } from "../team";
import { battleEnemySlot, battleEnemyZoom, battleIdleBob, battlePartySlot, BATTLE_ZOOM } from "./battle-layout";
import { drawDoors, drawDungeonArena, drawFloorShadow } from "./dungeon";
import type { FloatingText } from "./floating-text";
import {
  DATA_BEAM,
  drawSprite,
  drawText,
  ENEMY_KIND_SPRITES,
  GLOW_SM,
  RARITY_WOODCUTTER_SPRITES,
  SIGN_NO_AI,
  spriteSize,
  textWidth,
  withPalette,
  type EnemyFrameSet,
  type PixelMap,
} from "./sprites";
import { drawHeldWeapon, WEAPON_APPEARANCE } from "./weapons";

/** Everything the battle renderer needs from the rest of the game. Rebuilt
 * once per frame by Game.renderBattle — cheap, and it keeps this module
 * unable to reach anything that isn't declared here. */
export interface BattleRenderView {
  w: number;
  h: number;
  animT: number;
  save: GameSave;
  floats: FloatingText[];
  lastBattlePartyIds: string[];
  lastBattleWorld: number;

  battleAnim: { event: BattleEventLike; t: number; dur: number } | null;
  battleEndT: number;
  battleFlash: { grade: SkillGrade; t: number } | null;
  battleFlashId: string | null;
  battleFlashT: number;
  battleShakeMag: number;
  battleShakeT: number;
  battleSkillCheck: SkillCheck | null;
  battleSkillCheckGrace: number;

  /** How many doorways to carve into the back wall, and which is hovered.
   * Zero everywhere except a junction between rooms — the doors ARE the
   * choice screen, drawn into the chamber rather than floated over it. */
  doorCount: number;
  doorHover: number | null;
  /** Reward kind per door, for the sigils carved into the lintels. */
  doorRewards: string[];

  battleSnapshot(): BattleSnapshot | null;
  currentBattleActorId(): string | null;
  battlePendingActionKind(): string | null;
  battleMemberSlot(id: string): { x: number; y: number } | null;
  battleLungeT(id: string): number;
  battleUnitPose(
    id: string,
    hp: number,
    frames: EnemyFrameSet,
  ): { name: "idle" | "attackWindup" | "attackStrike" | "hurt" | "defeated"; frame: PixelMap };
  deathSquash(id: string): number;
  partyFor(ids: string[]): TeamMemberSave[];
  workerPalette(world: number): Record<string, string> | null;
  weaponPalette(world: number): Record<string, string> | null;
}

/* Structural stand-ins: the concrete types live on Game and in battle.ts, and
   importing them here would drag the whole battle engine in for two fields. */
type BattleEventLike = { actorId?: string; targetId?: string | null; moveId?: string; kind?: string };

export function renderBattleScene(ctx: CanvasRenderingContext2D, v: BattleRenderView): void {
  const battle = v.battleSnapshot();
  if (!battle) return;
  const adv = v.save.adventure;
  const partyIds = adv?.partyIds ?? v.lastBattlePartyIds;
  const w = v.w;
  const h = v.h;
  const world = getWorld(adv?.world ?? v.lastBattleWorld);

  const shakeX =
    v.battleShakeT > 0
      ? Math.round((Math.random() - 0.5) * v.battleShakeMag)
      : 0;
  const shakeY =
    v.battleShakeT > 0
      ? Math.round((Math.random() - 0.5) * v.battleShakeMag)
      : 0;
  ctx.save();
  ctx.translate(shakeX, shakeY);

  // A stone chamber, not a flat fill of the world's ground colour — see
  // scene/dungeon.ts. The old single fillRect made every fight read as
  // happening on the same lawn as the homestead, only emptier; the whole
  // point of going adventuring is that you went somewhere. The world's
  // ground colour still tints the masonry, so each world's dungeon keeps
  // its own flavour.
  drawDungeonArena(ctx, w, h, world.ground, v.animT);
  // Doors belong to the back wall, so they go down with the architecture and
  // before anything standing in the room.
  if (v.doorCount > 0) {
    drawDoors(ctx, w, h, world.ground, v.doorCount, v.doorHover, v.doorRewards);
  }
  const vignette = ctx.createRadialGradient(
    w / 2,
    h * 0.45,
    Math.min(w, h) * 0.2,
    w / 2,
    h * 0.45,
    Math.max(w, h) * 0.8,
  );
  vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignette.addColorStop(1, "rgba(0, 0, 0, 0.55)");
  ctx.fillStyle = vignette;
  ctx.fillRect(-4, -4, w + 8, h + 8);

  // Party. Formation slots (front/backLeft/backRight, see
  // BATTLE_FORMATION) are drawn back-to-front — index 0 ("front") last —
  // so it correctly overlaps the two back-row members when their sprites
  // are close together; battlePartySlot/zoom/dimming below still key off
  // each member's true formation index `i`, only the draw sequence
  // changes.
  const party = v.partyFor(partyIds);
  const drawOrder = party
    .map((_, i) => i)
    .sort((a, b) => (a === 0 ? 1 : 0) - (b === 0 ? 1 : 0));
  for (const i of drawOrder) {
    const member = party[i];
    const rarity = WORKER_DEFS_BY_ID[member.defId]?.rarity ?? "common";
    const frames = RARITY_WOODCUTTER_SPRITES[rarity];
    const pose = v.battleUnitPose(member.id, member.currentHp, {
      idle: frames.stand,
      attackWindup: frames.chopUp,
      attackStrike: frames.chopDown,
      hurt: frames.hurt,
      defeated: frames.defeated,
    });
    const slot = battlePartySlot(i, v);
    const idleBob = battleIdleBob(pose.name, v.animT);
    const lunge = v.battleLungeT(member.id) * 5;
    const flashing =
      v.battleFlashId === member.id && v.battleFlashT > 0;
    const zoom =
      BATTLE_ZOOM[i] ?? BATTLE_ZOOM[BATTLE_ZOOM.length - 1];
    const isBackSlot = i !== 0;
    const size = spriteSize(pose.frame);
    const worldIdx = adv?.world ?? v.lastBattleWorld;
    // Same white hit-flash override for both body and weapon, so a flash
    // reads as one coherent white silhouette rather than a white body
    // holding a still-colored weapon — extended to the weapon's own
    // letters (`w`/`D`/`d`/rarity accents), since the body's own s/R/r
    // override can't touch letters the weapon uses that the body doesn't.
    const flashOverride = { s: "#ffffff", R: "#ffffff", r: "#dddddd" };
    const weaponFlashOverride = {
      w: "#ffffff",
      D: "#ffffff",
      d: "#dddddd",
      N: "#ffffff",
      H: "#ffffff",
      h: "#dddddd",
      Y: "#ffffff",
      y: "#ffffff",
    };
    // Per-character accent (Part E) merged in alongside the world palette
    // — accent letters (C/N/H/h/Y/y) never collide with the world
    // palette's R/r or the hit-flash override's s/R/r, so this three-way
    // merge order is safe regardless of which side "wins" on overlap.
    const charAccent = WORKER_DEFS_BY_ID[member.defId]?.accent ?? null;
    const palette = flashing
      ? { ...v.workerPalette(worldIdx), ...charAccent, ...flashOverride }
      : { ...v.workerPalette(worldIdx), ...charAccent };
    const advWeaponPalette = flashing
      ? { ...v.weaponPalette(worldIdx), ...weaponFlashOverride }
      : v.weaponPalette(worldIdx);
    // Back-row members are drawn slightly translucent — same low-alpha
    // layering technique gacha-machine.ts uses for its glass-shine glint
    // (outer ctx.save/globalAlpha/ctx.restore wrapping the draw), just a
    // much subtler alpha since these are full character sprites that
    // still need to read clearly.
    // Contact shadow first, so the sprite draws over its own near edge.
    // The dungeon floor has real depth cues now (see scene/dungeon.ts) and
    // an unshadowed sprite over it reads as hovering — the better the
    // ground, the more obvious an unanchored character becomes.
    drawFloorShadow(ctx, slot.x, slot.y, (size.w * zoom) / 2 + 2);
    if (isBackSlot) {
      ctx.save();
      ctx.globalAlpha = 0.88;
    }
    withPalette(palette, () => {
      ctx.save();
      ctx.translate(slot.x + Math.round(lunge), slot.y + idleBob);
      ctx.scale(zoom, zoom);
      // Party members collapse the same way enemies do when they go down —
      // a downed ally reading identically to a defeated enemy is the point.
      const memberSquash = v.deathSquash(member.id);
      if (memberSquash !== 1)
        ctx.scale(1 / Math.sqrt(memberSquash), memberSquash);
      drawSprite(ctx, pose.frame, -Math.floor(size.w / 2), -size.h, false);
      // Adventuring weapon: only during idle/attackWindup/attackStrike
      // (never hurt/defeated), and only when something is actually
      // equipped — bare-handed stays bare-handed, unlike Woodchopping's
      // always-show-common-axe default.
      if (
        pose.name === "idle" ||
        pose.name === "attackWindup" ||
        pose.name === "attackStrike"
      ) {
        const item = equippedItem(member, "adventuring", v.save.inventory);
        if (item) {
          const held = WEAPON_APPEARANCE.adventuring[item.rarity].held;
          if (held) {
            drawHeldWeapon(
              ctx,
              held,
              pose.name,
              advWeaponPalette,
              false,
              -Math.floor(size.w / 2),
              0,
            );
          }
        }
      }
      ctx.restore();
    });
    if (isBackSlot) {
      ctx.restore();
    }
    const isTurn = v.currentBattleActorId() === member.id;
    if (isTurn && member.currentHp > 0) {
      drawSprite(
        ctx,
        GLOW_SM,
        slot.x - 1,
        slot.y + idleBob - size.h * zoom - 6,
      );
    }
  }

  // Enemies, right side — fanned out per BATTLE_ENEMY_FORMATIONS, keyed
  // by each unit's own `id` (not the old shared literal "enemy") for
  // pose/lunge/hit-flash state, so a multi-enemy round's animations never
  // bleed from one unit onto another. Drawn in array order; unlike the
  // party's front/back rows there's no fixed z-order to preserve here, and
  // the formation's own spacing already keeps sprites from overlapping at
  // the enemy counts this produces (1-3).
  for (let i = 0; i < battle.enemies.length; i++) {
    const unit = battle.enemies[i];
    // Cast to ENEMY_KIND_SPRITES' own key type (rather than assuming it
    // already covers every EnemyKind) — Phase 3 is concurrently widening
    // EnemyKind (adventure.ts) with a new "mayor" kind and may not have
    // landed a matching sprites.ts entry yet by the time this file is
    // touched; falls back to the protestor frames for any kind that
    // isn't (yet) a real key, rather than a hard crash.
    const enemyFrames =
      ENEMY_KIND_SPRITES[unit.spec.kind as keyof typeof ENEMY_KIND_SPRITES] ??
      ENEMY_KIND_SPRITES.protestor;
    const character = ENEMY_CHARACTERS_BY_ID[unit.spec.characterId];
    const enemyPose = v.battleUnitPose(unit.id, unit.hp, enemyFrames);
    const enemySlot = battleEnemySlot(i, battle.enemies.length, v);
    const enemyIdleBob = battleIdleBob(enemyPose.name, v.animT);
    const enemyLunge = v.battleLungeT(unit.id) * -6;
    const enemyFlashing =
      v.battleFlashId === unit.id && v.battleFlashT > 0;
    const enemyZoom = battleEnemyZoom(i, battle.enemies.length);
    const enemySize = spriteSize(enemyPose.frame);
    const enemyPalette = {
      ...(character?.accent ?? null),
      ...(unit.spec.kind === "protestor" ? world.workerPalette : null),
      ...(enemyFlashing
        ? {
            s: "#ffffff",
            V: "#ffffff",
            v: "#dddddd",
            L: "#ffffff",
            l: "#dddddd",
          }
        : null),
    };
    drawFloorShadow(
      ctx,
      enemySlot.x,
      enemySlot.y,
      (enemySize.w * enemyZoom) / 2 + 2,
    );
    withPalette(enemyPalette, () => {
      ctx.save();
      ctx.translate(
        enemySlot.x + Math.round(enemyLunge),
        enemySlot.y + enemyIdleBob,
      );
      ctx.scale(enemyZoom, enemyZoom);
      // Death collapse: squash vertically and widen to conserve volume, both
      // anchored at the feet (the sprite is drawn from -h upward), so it
      // crumples into the ground instead of shrinking toward its middle.
      const sq = v.deathSquash(unit.id);
      if (sq !== 1) ctx.scale(1 / Math.sqrt(sq), sq);
      drawSprite(
        ctx,
        enemyPose.frame,
        -Math.floor(enemySize.w / 2),
        -enemySize.h,
        true,
      );
      ctx.restore();
      if (unit.spec.kind === "protestor" && unit.hp > 0) {
        const signSize = spriteSize(SIGN_NO_AI);
        drawSprite(
          ctx,
          SIGN_NO_AI,
          enemySlot.x +
            Math.round(enemyLunge) -
            Math.floor((signSize.w * 1.6) / 2),
          enemySlot.y +
            enemyIdleBob -
            enemySize.h * enemyZoom -
            signSize.h * 1.6,
        );
      }
    });

    // Glitch Pulse beam, mid-strike only, for whichever specific enemy
    // unit cast it this turn.
    if (
      v.battleAnim?.event.actorId === unit.id &&
      v.battleAnim.event.moveId === "glitchPulse" &&
      v.battleAnim.event.targetId
    ) {
      const p =
        v.battleAnim.dur > 0
          ? Math.min(1, v.battleAnim.t / v.battleAnim.dur)
          : 0;
      if (p > 0.35 && p < 0.85) {
        const targetPos =
          v.battleMemberSlot(v.battleAnim.event.targetId) ??
          battlePartySlot(0, v);
        const bx = Math.round(
          enemySlot.x + (targetPos.x - enemySlot.x) * ((p - 0.35) / 0.5),
        );
        const by = Math.round(
          enemySlot.y + (targetPos.y - enemySlot.y) * ((p - 0.35) / 0.5) - 10,
        );
        drawSprite(ctx, DATA_BEAM, bx - 2, by - 1);
      }
    }
  }

  for (const f of v.floats) f.render(ctx);

  ctx.restore();

  if (v.battleSkillCheck) {
    renderSkillCheckTrack(
      ctx,
      6,
      h - 16,
      w - 12,
      6,
      v.battleSkillCheck,
    );
    // Name the action the check belongs to. Attack and Defend share one
    // timing bar, and an unlabelled bar after pressing Attack reads as
    // "my attack silently turned into a defend" — the bar is the only thing
    // on screen at that moment, and it looks identical either way.
    const kind = v.battlePendingActionKind();
    if (kind) {
      const arming = v.battleSkillCheckGrace > 0;
      const label = arming
        ? "GET READY"
        : kind === "attack"
          ? "ATTACK - TIME IT"
          : "DEFEND - TIME IT";
      const color = arming
        ? "#9aa3ab"
        : kind === "attack"
          ? "#ffb347"
          : "#6fb7ff";
      const lx = Math.round(w / 2 - textWidth(label) / 2);
      drawText(ctx, label, lx + 1, h - 25, "#1d2b21");
      drawText(ctx, label, lx, h - 26, color);
    }
  }
  if (v.battleFlash) {
    const grade = v.battleFlash.grade;
    const label =
      grade === "crit"
        ? "CRITICAL"
        : grade === "great"
          ? "GREAT"
          : grade === "good"
            ? "GOOD"
            : "MISS";
    const color =
      grade === "crit"
        ? "#e03b3b"
        : grade === "great"
          ? "#ffd75e"
          : grade === "good"
            ? "#6fb7ff"
            : "#d64545";
    drawText(
      ctx,
      label,
      Math.round(w / 2 - textWidth(label) / 2),
      h - 26,
      color,
    );
  }

  if (battle.outcome) {
    ctx.fillStyle = `rgba(10, 14, 10, ${Math.min(0.75, (v.battleEndT / 1.8) * 0.75).toFixed(2)})`;
    ctx.fillRect(0, 0, w, h);
    const label = battle.outcome === "win" ? "WIN" : "KO";
    const color = battle.outcome === "win" ? "#ffd75e" : "#d64545";
    drawText(
      ctx,
      label,
      Math.round(w / 2 - textWidth(label) / 2),
      Math.round(h / 2 - 3),
      color,
    );
  }
}

/** The DBD-style needle/zone/track, shared by POV's chop skill-check and
 * the battle view's Defend skill-check — same math (rollSkillCheck/
 * gradeSkillCheck), just drawn at whatever rect the caller wants. */
export function renderSkillCheckTrack(
  ctx: CanvasRenderingContext2D,
  trackX: number,
  trackY: number,
  trackW: number,
  trackH: number,
  sc: SkillCheck | null,
): void {
  ctx.fillStyle = "#1d2b21";
  ctx.fillRect(trackX - 1, trackY - 1, trackW + 2, trackH + 2);
  ctx.fillStyle = "#12324a";
  ctx.fillRect(trackX, trackY, trackW, trackH);
  if (!sc) return;

  const zx = trackX + Math.round((sc.zoneStart / 100) * trackW);
  const zw = Math.max(1, Math.round((sc.zoneWidth / 100) * trackW));
  ctx.fillStyle = "rgba(111, 183, 255, 0.55)";
  ctx.fillRect(zx, trackY, zw, trackH);

  const gx = trackX + Math.round((sc.greatStart / 100) * trackW);
  const gw = Math.max(1, Math.round((sc.greatWidth / 100) * trackW));
  ctx.fillStyle = "#ffd75e";
  ctx.fillRect(gx, trackY, gw, trackH);

  // The crit sliver, dead centre of the great zone (POV chops only — battle
  // checks roll no crit zone, so this branch never fires there). Drawn last
  // so it paints over the gold, and given a minimum width of 1px because at
  // ~5% of an already-narrow zone it would otherwise round away to nothing
  // on a small window and be invisible right up until it fired.
  if (sc.critStart !== undefined && sc.critWidth !== undefined) {
    const cx = trackX + Math.round((sc.critStart / 100) * trackW);
    const cw = Math.max(1, Math.round((sc.critWidth / 100) * trackW));
    ctx.fillStyle = "#e03b3b";
    ctx.fillRect(cx, trackY, cw, trackH);
  }

  const nx =
    trackX + Math.min(trackW - 1, Math.round((sc.pos / 100) * trackW));
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(nx, trackY - 1, 1, trackH + 2);
}
