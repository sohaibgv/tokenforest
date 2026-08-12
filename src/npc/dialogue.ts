// Canvas speech bubbles — the game's only NPC conversation surface.
//
// Deliberately canvas-only, no DOM. Every other overlay in this app that
// lived in the DOM had to fight the same three problems: it renders in CSS
// pixels while the world renders in logical pixels (so it never lines up with
// what it points at), it sits in a stacking context with the window-drag
// handler underneath it, and it re-flows independently of the frame it
// belongs to. A bubble that has to point at a character's head is exactly the
// case where all three bite. Drawing it in world space costs a hit-test
// helper and buys perfect alignment for free.
//
// Layout is computed fresh each frame rather than cached: the speaker moves
// (idle bob, walk), the canvas resizes, and a stale rect would leave the tail
// pointing at nothing and the choice hit-boxes lying about where they are.

import { drawText, fontSafe, textWidth } from "../scene/sprites";

export interface DialogueChoice {
  label: string;
  /** Run when picked. Returning nothing closes the bubble; the caller owns
   * any follow-up state (see Game's travel handlers). */
  onPick: () => void;
  /** Greyed and unclickable — used for "you're short on wood" so the price
   * still reads instead of the option silently vanishing. */
  disabled?: boolean;
}

export interface Dialogue {
  /** World-space point the tail points at — a speaker's head, or a prop. */
  speaker: { x: number; y: number };
  /** Already word-wrapped by `wrapLines`. */
  lines: string[];
  choices: DialogueChoice[];
  /** Two columns instead of one. The departures board can carry ten worlds,
   * which does not fit down a ~120px-tall canvas in a single column. */
  columns?: 1 | 2;
}

export interface BubbleLayout {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  lineY: number;
  choiceRects: { x: number; y: number; w: number; h: number }[];
  tailX: number;
  tailY: number;
  tailUp: boolean;
}

const PAD = 3;
const LINE_H = 7;
const ROW_H = 8;
const TAIL = 3;

/** Greedy word-wrap against the pixel font's real measured width. Falls back
 * to emitting an over-long word on its own line rather than looping forever
 * or splitting mid-word. */
export function wrapLines(text: string, maxW: number): string[] {
  // Folded to the font's real charset BEFORE measuring, so the wrap width is
  // computed against the glyphs that will actually be drawn.
  const words = fontSafe(text).split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (line && textWidth(candidate) > maxW) {
      out.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [""];
}

export function layoutBubble(d: Dialogue, canvasW: number, canvasH: number): BubbleLayout {
  const cols = d.columns ?? 1;
  const rows = Math.ceil(d.choices.length / cols);

  let contentW = 0;
  for (const l of d.lines) contentW = Math.max(contentW, textWidth(l));
  let choiceW = 0;
  for (const c of d.choices) choiceW = Math.max(choiceW, textWidth(fontSafe(c.label)) + 6);
  contentW = Math.max(contentW, choiceW * cols + (cols - 1) * 2);

  const w = Math.min(canvasW - 4, contentW + PAD * 2);
  const h = PAD * 2 + d.lines.length * LINE_H + (rows > 0 ? rows * ROW_H + 1 : 0);

  // Prefer sitting ABOVE the speaker; flip below only when there's no room,
  // so a bubble never covers the character it belongs to.
  const tailUp = d.speaker.y - h - TAIL - 2 < 1;
  // Clamped vertically as well as horizontally. The logical canvas is only
  // ~120-140px tall, and the departures board on a ten-world save is most of
  // that — without the clamp its lower rows fall off the bottom edge and
  // become unclickable while still looking present.
  const y = Math.max(
    1,
    Math.min(canvasH - h - 1, tailUp ? d.speaker.y + TAIL + 2 : d.speaker.y - h - TAIL - 2),
  );
  const x = Math.max(2, Math.min(canvasW - w - 2, Math.round(d.speaker.x - w / 2)));

  const choiceRects: { x: number; y: number; w: number; h: number }[] = [];
  const colW = Math.floor((w - PAD * 2 - (cols - 1) * 2) / cols);
  const rowsTop = y + PAD + d.lines.length * LINE_H + 1;
  for (let i = 0; i < d.choices.length; i++) {
    const col = cols === 1 ? 0 : Math.floor(i / rows);
    const row = cols === 1 ? i : i % rows;
    choiceRects.push({
      x: x + PAD + col * (colW + 2),
      y: rowsTop + row * ROW_H,
      w: colW,
      h: ROW_H - 1,
    });
  }

  return {
    x,
    y,
    w,
    h,
    lines: d.lines,
    lineY: y + PAD,
    choiceRects,
    // Tail stays under the speaker even when the box was clamped to the edge.
    tailX: Math.max(x + 2, Math.min(x + w - 4, Math.round(d.speaker.x - 1))),
    tailY: tailUp ? y - TAIL : y + h,
    tailUp,
  };
}

/** Index of the choice under a world-space point, or null. */
export function hitChoice(layout: BubbleLayout, lx: number, ly: number): number | null {
  for (let i = 0; i < layout.choiceRects.length; i++) {
    const r = layout.choiceRects[i];
    if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) return i;
  }
  return null;
}

/** True if a point is anywhere on the bubble (including its tail band) —
 * the caller uses this to tell "clicked a choice" from "clicked away to
 * dismiss" without treating the bubble's own padding as dismissal. */
export function hitBubble(layout: BubbleLayout, lx: number, ly: number): boolean {
  return (
    lx >= layout.x - 1 &&
    lx <= layout.x + layout.w + 1 &&
    ly >= Math.min(layout.y, layout.tailY) - 1 &&
    ly <= Math.max(layout.y + layout.h, layout.tailY) + 1
  );
}

/** An unprompted mutter: one short line over an NPC's head, no choices, no
 * hit-testing, fading itself out after a few seconds.
 *
 * Deliberately a SEPARATE thing from `Dialogue` rather than a flag on it. A
 * Dialogue is modal — Game routes every click into it while it is open (see
 * handleClick) — and that is exactly wrong for something the player never
 * asked for: chatter that swallowed a click on the tree behind it would be
 * infuriating. Keeping the two types apart means the modal path structurally
 * cannot be reached by an ambient line. */
export interface Ambient {
  speaker: { x: number; y: number };
  lines: string[];
  /** Seconds left. Game ticks this down and drops the object at 0. */
  ttl: number;
  /** Total lifetime, so the renderer can derive the fade. */
  life: number;
}

/** Ambient bubbles reuse the exact layout maths of a real conversation — same
 * box, same tail, same clamping — with an empty choice list, so a mutter and a
 * reply look like the same character speaking rather than two UI systems. */
export function layoutAmbient(a: Ambient, canvasW: number, canvasH: number): BubbleLayout {
  return layoutBubble({ speaker: a.speaker, lines: a.lines, choices: [] }, canvasW, canvasH);
}

export function drawAmbient(
  ctx: CanvasRenderingContext2D,
  a: Ambient,
  layout: BubbleLayout,
): void {
  // Fade in over the first 15% and out over the last 30%, so it neither pops
  // nor lingers half-visible.
  const t = 1 - a.ttl / a.life;
  const alpha = Math.min(1, Math.min(t / 0.15, (1 - t) / 0.3));
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  drawBubble(ctx, { speaker: a.speaker, lines: a.lines, choices: [] }, layout, null);
  ctx.restore();
}

export function drawBubble(
  ctx: CanvasRenderingContext2D,
  d: Dialogue,
  layout: BubbleLayout,
  hovered: number | null,
): void {
  const { x, y, w, h } = layout;

  // Body: parchment on a dark rim, matching the hover-affordance label's
  // ink-on-board look so a bubble reads as the same family of thing.
  ctx.fillStyle = "#1a120a";
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = "#f2e6d0";
  ctx.fillRect(x, y, w, h);
  // Corner nibbles — a plain rectangle reads as a UI panel; knocking the
  // corners out makes it a drawn object.
  ctx.fillStyle = "#1a120a";
  ctx.fillRect(x, y, 1, 1);
  ctx.fillRect(x + w - 1, y, 1, 1);
  ctx.fillRect(x, y + h - 1, 1, 1);
  ctx.fillRect(x + w - 1, y + h - 1, 1, 1);

  // Tail: a stepped triangle, drawn in the rim colour then filled, so it
  // keeps the 1px outline the body has.
  for (let i = 0; i < TAIL; i++) {
    const tw = TAIL - i;
    const ty = layout.tailUp ? layout.tailY + i : layout.tailY - TAIL + i + 1;
    ctx.fillStyle = "#1a120a";
    ctx.fillRect(layout.tailX - 1, ty, tw + 2, 1);
    ctx.fillStyle = "#f2e6d0";
    ctx.fillRect(layout.tailX, ty, tw, 1);
  }

  for (let i = 0; i < layout.lines.length; i++) {
    drawText(ctx, layout.lines[i], x + PAD, layout.lineY + i * LINE_H, "#2b1d0f");
  }

  for (let i = 0; i < layout.choiceRects.length; i++) {
    const r = layout.choiceRects[i];
    const c = d.choices[i];
    // Labels go through fontSafe too — they are the one place a caller can
    // still hand in a lower-case string, and a silently half-drawn button
    // label is worse than a silently half-drawn sentence.
    const label = fontSafe(c.label);
    if (c.disabled) {
      drawText(ctx, label, r.x + 3, r.y + 1, "#a08f78");
      continue;
    }
    const hot = hovered === i;
    ctx.fillStyle = hot ? "#3f6d3a" : "#e0d1b4";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    // Leading marker doubles as the selection cue, so the row still reads as
    // pickable on the frame before the pointer arrives.
    drawText(ctx, ">", r.x + 1, r.y + 1, hot ? "#f2e6d0" : "#8a6440");
    drawText(ctx, label, r.x + 5, r.y + 1, hot ? "#ffffff" : "#2b1d0f");
  }
}
