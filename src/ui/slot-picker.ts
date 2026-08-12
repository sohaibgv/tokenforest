// Boot-time (and settings-invoked) save-slot picker overlay: 3 cards with a
// per-slot summary (world / wood / prestige / last-played), new-game on an
// empty slot, and a two-click delete confirm. Fully keyboard-driven too:
// 1/2/3 picks a slot, Esc cancels (only when opened from settings — at boot
// there is nothing to fall back to, so Esc is swallowed instead of leaving
// the app save-less). All colors are the design-token pairs styles.css
// already vets for WCAG AA on light panels.

import { deleteSlot, listSlotSummaries, type SlotSummary } from "../game-state";
import { BIRDHOUSE_H, BIRDHOUSE_W, drawBirdhouse, type BirdhouseState } from "../scene/birdhouse";
import { abbrev } from "../scene/floating-text";
import { pixelIconComposite } from "./pixel-icon";

export interface SlotPickerOptions {
  /** True when opened from settings over a running game — enables Esc/the
   * Cancel button. False at boot: a slot MUST be chosen. */
  allowCancel: boolean;
  /** Highlights the slot the running game is currently on. */
  activeSlot?: number | null;
}

function agoLabel(ms: number | null): string {
  if (ms === null) return "";
  const delta = Date.now() - ms;
  if (delta < 90_000) return "just now";
  const mins = Math.round(delta / 60_000);
  if (mins < 90) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function pickSlot(opts: SlotPickerOptions): Promise<number | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.id = "slot-picker";
    document.body.appendChild(overlay);
    /** Slot number whose Delete button is awaiting its confirm click. */
    let armedDelete: number | null = null;

    function finish(result: number | null): void {
      window.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(result);
    }

    function onKey(e: KeyboardEvent): void {
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        e.stopPropagation();
        e.preventDefault();
        finish(Number(e.key));
      } else if (e.key === "Escape") {
        // Capture-phase + stopPropagation either way: at boot this swallows
        // Esc so main.ts's global handler can't hide the window under an
        // unresolved picker.
        e.stopPropagation();
        if (opts.allowCancel) finish(null);
      }
    }
    window.addEventListener("keydown", onKey, true);

    function card(summary: SlotSummary): HTMLElement {
      const el = document.createElement("button");
      el.className = "slot-card";
      el.type = "button";
      el.setAttribute("aria-keyshortcuts", String(summary.slot));

      // The birdhouse is the ICON, not a replacement for the text: pixel art
      // cannot say "12k wood, 4h ago", which is the whole job of this screen.
      const state: BirdhouseState = summary.empty
        ? "empty"
        : armedDelete === summary.slot
          ? "clearing"
          : "occupied";
      const active = opts.activeSlot === summary.slot;
      const art = document.createElement("div");
      art.className = "slot-art";
      art.append(
        pixelIconComposite(
          // Every visual input must be in the cache key — the composite cache
          // is a plain Map that is never evicted, so a key of just the slot
          // number would keep serving a stale house after a delete.
          `birdhouse:${state}:${active ? "a" : "-"}`,
          BIRDHOUSE_W,
          BIRDHOUSE_H,
          (ctx) => drawBirdhouse(ctx, state, { active }),
          { scale: 2 },
        ),
      );
      el.appendChild(art);

      const text = document.createElement("div");
      text.className = "slot-text";
      el.appendChild(text);

      const title = document.createElement("div");
      title.className = "slot-title";
      const current = active ? " · current" : "";
      title.textContent = `[${summary.slot}] Slot ${summary.slot}${current}`;
      text.appendChild(title);

      const sub = document.createElement("div");
      sub.className = "slot-sub";
      if (summary.empty) {
        sub.textContent = "Empty — start a new game";
      } else {
        const bits = [
          summary.worldName,
          `${abbrev(summary.wood)} wood`,
          summary.prestigeLevel > 0 ? `Prestige ${summary.prestigeLevel}` : null,
          agoLabel(summary.lastPlayedMs),
        ].filter((b): b is string => !!b);
        sub.textContent = bits.join(" · ");
      }
      text.appendChild(sub);

      if (!summary.empty) {
        const del = document.createElement("button");
        del.className = "slot-delete";
        del.type = "button";
        del.textContent = armedDelete === summary.slot ? "Really clear?" : "Clear nest";
        if (armedDelete === summary.slot) del.classList.add("armed");
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          if (armedDelete === summary.slot) {
            armedDelete = null;
            void deleteSlot(summary.slot).then(render);
          } else {
            armedDelete = summary.slot;
            void render();
          }
        });
        el.appendChild(del);
      }

      el.addEventListener("click", () => finish(summary.slot));
      return el;
    }

    async function render(): Promise<void> {
      const summaries = await listSlotSummaries();
      overlay.replaceChildren();
      // Heading stays plain and literal: at first boot this is the accessible
      // name for the whole screen, and a brand-new player should not have to
      // work out that a birdhouse means a save file.
      const heading = document.createElement("h2");
      heading.textContent = "CHOOSE A SAVE SLOT";
      overlay.appendChild(heading);
      const subhead = document.createElement("div");
      subhead.className = "slot-subhead";
      subhead.textContent = "Three birdhouses on one post";
      overlay.appendChild(subhead);
      for (const summary of summaries) overlay.appendChild(card(summary));
      const hint = document.createElement("div");
      hint.className = "slot-hint";
      hint.textContent = opts.allowCancel ? "Press 1-3 to pick · Esc to cancel" : "Press 1-3 to pick";
      overlay.appendChild(hint);
      if (opts.allowCancel) {
        const cancel = document.createElement("button");
        cancel.id = "slot-cancel";
        cancel.type = "button";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => finish(null));
        overlay.appendChild(cancel);
      }
    }

    void render();
  });
}
