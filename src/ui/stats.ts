// Lifetime Stats panel: surfaces GameSave.stats (and a few top-level save
// fields) that the game has tracked meticulously since Phase 1 but never
// actually shown anywhere — trees felled, adventures cleared, tokens seen,
// playtime. Read-only, settings-opened, same overlay pattern as
// ui/unlocks.ts (persistent DOM, registerOverlay for Esc/close-others).

import type { Game } from "../scene/game";
import { abbrev } from "../scene/floating-text";
import { closeOtherOverlays, registerOverlay } from "./overlay-coordinator";

/** "3d 4h", "5h 12m", "42m" — coarsest-two-units, matching the app's
 * existing resetsIn()-style duration formatting (main.ts) rather than a
 * full HH:MM:SS readout nobody needs for a "since you started" stat. */
function formatDuration(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const remMins = mins % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${remMins}m`;
  return `${Math.max(0, remMins)}m`;
}

interface StatRow {
  label: string;
  value: string;
}

function row(list: HTMLElement, label: string, value: string): void {
  const r = document.createElement("div");
  r.className = "stats-row";
  const l = document.createElement("span");
  l.className = "stats-row-label";
  l.textContent = label;
  const v = document.createElement("span");
  v.className = "stats-row-value";
  v.textContent = value;
  r.append(l, v);
  list.appendChild(r);
}

function group(title: string, rows: StatRow[]): HTMLElement {
  const el = document.createElement("div");
  el.className = "stats-group";
  const h = document.createElement("div");
  h.className = "stats-group-title";
  h.textContent = title;
  el.appendChild(h);
  for (const r of rows) row(el, r.label, r.value);
  return el;
}

export function initStats(game: Game): void {
  const overlay = document.createElement("div");
  overlay.id = "stats-panel";
  overlay.classList.add("hidden");
  document.body.appendChild(overlay);

  function close(): void {
    overlay.classList.add("hidden");
  }
  registerOverlay("stats-panel", close);

  function render(): void {
    const s = game.save;
    const st = s.stats;
    overlay.replaceChildren();

    const head = document.createElement("div");
    head.id = "stats-head";
    const title = document.createElement("span");
    title.textContent = "LIFETIME STATS";
    head.appendChild(title);
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "Close";
    closeBtn.addEventListener("click", close);
    head.appendChild(closeBtn);
    overlay.appendChild(head);

    const playedMs = Date.now() - new Date(st.startedAt).getTime();
    const totalAdvRuns = st.adventuresCleared + st.adventuresFailed;
    const winRate = totalAdvRuns > 0 ? `${Math.round((100 * st.adventuresCleared) / totalAdvRuns)}%` : "—";

    const list = document.createElement("div");
    list.id = "stats-list";
    list.append(
      group("Forest", [
        { label: "Trees felled", value: abbrev(st.treesFelled) },
        { label: "Elder trees felled", value: abbrev(st.eldersFelled) },
        { label: "Total chops", value: abbrev(st.chops) },
        { label: "Golden spots hit", value: abbrev(st.goldenSpotsHit) },
        { label: "Manual clicks", value: abbrev(st.clicks) },
      ]),
      group("Economy", [
        { label: "Wood on hand", value: abbrev(s.wood) },
        { label: "Total wood earned", value: abbrev(s.totalWoodEarned) },
        { label: "Wood from adventures", value: abbrev(st.woodFromAdventures) },
        { label: "Amber on hand", value: abbrev(s.amber) },
        { label: "Tokens seen", value: abbrev(st.tokensSeen) },
      ]),
      group("Adventure", [
        { label: "Runs embarked", value: abbrev(st.adventuresEmbarked) },
        { label: "Runs cleared", value: abbrev(st.adventuresCleared) },
        { label: "Runs failed", value: abbrev(st.adventuresFailed) },
        { label: "Clear rate", value: winRate },
      ]),
      group("Progress", [
        { label: "Prestige level", value: String(s.prestigeLevel) },
        { label: "Roster size", value: String(s.team.length) },
        { label: "Time played", value: formatDuration(playedMs) },
      ]),
    );
    overlay.appendChild(list);
  }

  const openBtn = document.getElementById("stats-btn") as HTMLButtonElement;
  openBtn.addEventListener("click", () => {
    closeOtherOverlays("stats-panel");
    render();
    overlay.classList.remove("hidden");
  });
}
