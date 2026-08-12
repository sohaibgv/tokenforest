// Prestige-unlock UI: the "Unlocks" browser (settings-opened overlay listing
// every registry entry, locked ones silhouetted with the prestige level they
// need) and the post-prestige reveal (named cards for exactly what the ding
// just opened). Registry/data lives in src/unlocks.ts; this file is DOM only.

import type { Game } from "../scene/game";
import { UNLOCKS, unlocksAtLevel, type UnlockEntry } from "../unlocks";
import { closeOtherOverlays, registerOverlay } from "./overlay-coordinator";

const KIND_LABELS: Record<UnlockEntry["kind"], string> = {
  boon: "Boon",
  worker: "Worker",
  powerup: "Power-up",
  itemEffect: "Item Effect",
  world: "World",
};

function entryCard(entry: UnlockEntry, unlocked: boolean): HTMLElement {
  const card = document.createElement("div");
  card.className = unlocked ? "unlock-card" : "unlock-card locked";

  const tag = document.createElement("span");
  tag.className = "unlock-tag";
  tag.textContent = `P${entry.prestige} · ${KIND_LABELS[entry.kind]}`;
  card.appendChild(tag);

  const name = document.createElement("div");
  name.className = "unlock-name";
  // Locked entries are silhouetted: identity hidden, requirement shown.
  name.textContent = unlocked ? entry.name : "? ? ?";
  card.appendChild(name);

  const blurb = document.createElement("div");
  blurb.className = "unlock-blurb";
  blurb.textContent = unlocked
    ? entry.blurb
    : `Reach Prestige ${entry.prestige} to unlock this ${KIND_LABELS[entry.kind].toLowerCase()}.`;
  card.appendChild(blurb);

  return card;
}

/** Post-prestige reveal: named cards for what this new level just opened.
 * Skips itself silently if the level has no registry entries (past the end
 * of the authored content). */
export function showPrestigeReveal(newLevel: number): void {
  const entries = unlocksAtLevel(newLevel);
  if (entries.length === 0) return;

  const overlay = document.createElement("div");
  overlay.id = "prestige-reveal";

  const title = document.createElement("h2");
  title.textContent = `PRESTIGE ${newLevel} — NEW UNLOCKS`;
  overlay.appendChild(title);

  for (const entry of entries) overlay.appendChild(entryCard(entry, true));

  const done = document.createElement("button");
  done.id = "prestige-reveal-done";
  done.type = "button";
  done.textContent = "Onward";
  done.addEventListener("click", () => overlay.remove());
  overlay.appendChild(done);

  document.body.appendChild(overlay);
}

export function initUnlocks(game: Game): void {
  const overlay = document.createElement("div");
  overlay.id = "unlocks";
  overlay.classList.add("hidden");
  document.body.appendChild(overlay);

  function close(): void {
    overlay.classList.add("hidden");
  }
  registerOverlay("unlocks", close);

  function render(): void {
    const level = game.prestigeStatus().level;
    overlay.replaceChildren();

    const head = document.createElement("div");
    head.id = "unlocks-head";
    const title = document.createElement("span");
    title.textContent = `UNLOCKS — Prestige ${level}`;
    head.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);
    head.appendChild(closeBtn);
    overlay.appendChild(head);

    const list = document.createElement("div");
    list.id = "unlocks-list";
    const sorted = [...UNLOCKS].sort((a, b) => a.prestige - b.prestige);
    for (const entry of sorted) {
      list.appendChild(entryCard(entry, level >= entry.prestige));
    }
    overlay.appendChild(list);
  }

  const openBtn = document.getElementById("unlocks-btn") as HTMLButtonElement;
  openBtn.addEventListener("click", () => {
    closeOtherOverlays("unlocks");
    render();
    overlay.classList.remove("hidden");
  });
}
