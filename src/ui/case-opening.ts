// CS:GO-style case-opening reveal for gacha pulls. The pull itself already
// happened synchronously (see ../gacha.ts) — this only animates the reveal
// of an already-determined outcome; the filler cards spun past are random
// dressing, not additional rolls. Plain DOM/CSS, matching the rest of the
// UI layer's conventions (no framework, no canvas).

import { RARITY_WEIGHTS, type Rarity } from "../economy";
import { playSfx } from "../sfx";

export interface CaseCard {
  label: string;
  sub: string;
  rarity: Rarity;
  /** Cached-raster icon URL (Part E, from ../ui/pixel-icon.ts's
   * pixelIconUrl/pixelIconCompositeUrl) shown above the label when present.
   * Optional so a pool/card with no art yet still degrades gracefully to
   * the original text-only card. */
  iconUrl?: string;
}

const CARD_W = 68; // px per reel slot (60 card + 8 gap) — keep in lockstep with .case-card's width/margin-right in styles.css
const FILLER_COUNT = 46;
const TARGET_INDEX = 38;
const SPIN_MS = 3400;

function weightedPick(pool: CaseCard[]): CaseCard {
  const total = pool.reduce((sum, c) => sum + RARITY_WEIGHTS[c.rarity], 0);
  let roll = Math.random() * total;
  for (const c of pool) {
    roll -= RARITY_WEIGHTS[c.rarity];
    if (roll <= 0) return c;
  }
  return pool[pool.length - 1];
}

function buildCard(card: CaseCard): HTMLElement {
  const el = document.createElement("div");
  el.className = `case-card case-card-${card.rarity}`;
  const label = document.createElement("div");
  label.className = "case-card-label";
  // Small rarity-dot badge alongside the card's own already-rarity-colored
  // border/text (see .case-card-* in styles.css) — same badge used on the
  // Team roster and item picker, so a pull's reveal card reads with the
  // same rarity signal as everywhere else it later shows up owned.
  const dot = document.createElement("span");
  dot.className = `rarity-dot rarity-${card.rarity}`;
  label.append(dot, document.createTextNode(card.label));
  const sub = document.createElement("div");
  sub.className = "case-card-sub";
  sub.textContent = card.sub;
  if (card.iconUrl) {
    const icon = document.createElement("img");
    icon.className = "case-icon";
    icon.src = card.iconUrl;
    el.append(icon);
  }
  el.append(label, sub);
  return el;
}

export interface CaseOpeningHandle {
  /** Resolves once the landing flash settles — naturally, or via skip(). */
  finished: Promise<void>;
  /** Snaps the reel straight to its landed state and resolves immediately. */
  skip: () => void;
}

/** Spins a horizontal reel of filler cards (weighted like the real pool, for
 * visual plausibility only) and decelerates to land exactly on `result`
 * under a fixed center pointer. `finished` resolves once the landing flash
 * settles, or immediately if the caller invokes `skip()`. */
export function playCaseOpening(
  container: HTMLElement,
  pool: CaseCard[],
  result: CaseCard,
  durationMs: number = SPIN_MS,
): CaseOpeningHandle {
  container.replaceChildren();
  const fillerPool = pool.length > 0 ? pool : [result];

  const wrap = document.createElement("div");
  wrap.className = "case-opening";
  const viewport = document.createElement("div");
  viewport.className = "case-viewport";
  const strip = document.createElement("div");
  strip.className = "case-strip";
  const pointer = document.createElement("div");
  pointer.className = "case-pointer";

  for (let i = 0; i < FILLER_COUNT; i++) {
    strip.append(buildCard(i === TARGET_INDEX ? result : weightedPick(fillerPool)));
  }
  viewport.append(strip, pointer);
  wrap.append(viewport);
  container.append(wrap);

  let settled = false;
  let timer: number | null = null;
  let resolveFinished: () => void;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });

  /** Fires a burst of small diamond "sparkle" chips outward from the landed
   * card's center — the "chest pops open with sparkling particle effects"
   * beat. Count/color scale with rarity (see .case-sparkle-* in styles.css)
   * so a legendary pull visibly reads as a bigger event than a common one. */
  function spawnSparkles(landed: HTMLElement): void {
    const cardRect = landed.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const cx = cardRect.left - wrapRect.left + cardRect.width / 2;
    const cy = cardRect.top - wrapRect.top + cardRect.height / 2;
    const count =
      result.rarity === "legendary" ? 16 : result.rarity === "epic" ? 11 : result.rarity === "rare" ? 7 : 4;
    for (let i = 0; i < count; i++) {
      const chip = document.createElement("span");
      chip.className = `case-sparkle case-sparkle-${result.rarity}`;
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.7;
      const dist = 24 + Math.random() * 34;
      chip.style.left = `${cx}px`;
      chip.style.top = `${cy}px`;
      chip.style.setProperty("--dx", `${Math.cos(angle) * dist}px`);
      chip.style.setProperty("--dy", `${Math.sin(angle) * dist}px`);
      chip.style.animationDelay = `${Math.random() * 90}ms`;
      chip.addEventListener("animationend", () => chip.remove(), { once: true });
      wrap.append(chip);
    }
  }

  function land(): void {
    if (settled) return;
    settled = true;
    if (timer !== null) window.clearTimeout(timer);
    playSfx("gachaReveal", { rarity: result.rarity });
    const landed = strip.children[TARGET_INDEX] as HTMLElement | undefined;
    landed?.classList.add("case-landed");
    if (landed) spawnSparkles(landed);
    const reveal = document.createElement("div");
    reveal.className = `case-reveal case-reveal-${result.rarity}`;
    reveal.textContent = result.sub ? `${result.label} · ${result.sub}` : result.label;
    wrap.append(reveal);
    resolveFinished();
  }

  requestAnimationFrame(() => {
    const targetCenter = TARGET_INDEX * CARD_W + CARD_W / 2;
    const offset = targetCenter - viewport.clientWidth / 2;
    strip.style.transform = "translateX(0px)";
    void strip.offsetWidth; // force reflow so the transition below actually animates
    strip.style.transition = `transform ${durationMs}ms cubic-bezier(0.08, 0.82, 0.17, 1)`;
    requestAnimationFrame(() => {
      strip.style.transform = `translateX(-${offset}px)`;
    });
  });

  timer = window.setTimeout(land, durationMs + 60);

  function skip(): void {
    if (settled) return;
    // Snap instantly to the final position (no transition) before landing,
    // so a mid-flight skip doesn't leave the strip visually mismatched.
    const targetCenter = TARGET_INDEX * CARD_W + CARD_W / 2;
    const offset = targetCenter - viewport.clientWidth / 2;
    strip.style.transition = "none";
    strip.style.transform = `translateX(-${offset}px)`;
    land();
  }

  return { finished, skip };
}
