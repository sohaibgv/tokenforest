// The Field Ledger — the run's stat sheet.
//
// Brotato's real addiction is not its items, it is its stat panel: a column of
// numbers you can watch move, with every item's contribution legible in it. A
// build you can READ is a build you want to keep tuning; a build you can only
// feel is a build you take on faith and stop thinking about.
//
// This is the payoff for run/stats.ts carrying a `sources` ledger alongside
// `values`. Nothing here derives, guesses, or re-computes anything — it renders
// what the engine already knows, which is the only way the sheet can be trusted
// to agree with the fight.
//
// Two rules, both learned the hard way in this codebase:
//
//   1. BUILT ONCE, MUTATED IN PLACE. Rows are created on first render and only
//      ever have their text and classes updated. Rebuilding on a timer eats
//      clicks — see ui/adventure.ts's header for the incident.
//
//   2. ONLY SHOW WHAT IS DOING SOMETHING. A sheet listing twenty-one stats, of
//      which four are non-zero, teaches the player to skim it and then to stop
//      opening it. `activeStatKeys` filters to what the build actually touches,
//      so the panel grows as the run does — which is itself the reward.

import {
  activeStatKeys,
  BASE_RUN_STATS,
  effectiveAtkMult,
  type RunStatKey,
  type RunStats,
} from "../run/stats";

/** Display name and format for every stat the sheet can show.
 *
 * `pct` renders as a whole percentage, `mult` as a multiplier above 1 (so
 * atkMult 1.42 reads "+42%"), `count` as a plain integer. Anything absent from
 * this table is engine bookkeeping the player has no use for. */
const STAT_ROWS: { key: RunStatKey; label: string; kind: "pct" | "mult" | "count" | "x" }[] = [
  { key: "atkMult", label: "Attack", kind: "mult" },
  { key: "critChance", label: "Critical", kind: "pct" },
  { key: "critMult", label: "Crit damage", kind: "x" },
  { key: "lifestealPct", label: "Lifesteal", kind: "pct" },
  { key: "executePct", label: "Execute", kind: "pct" },
  { key: "armorPct", label: "Armour", kind: "pct" },
  { key: "reflectPct", label: "Reflect", kind: "pct" },
  { key: "dodgePct", label: "Dodge", kind: "pct" },
  { key: "guardBonus", label: "Guard", kind: "pct" },
  { key: "shieldOnGuardPct", label: "Bark on guard", kind: "pct" },
  { key: "regenPerRoundPct", label: "Regen", kind: "pct" },
  { key: "lastStandCharges", label: "Last stand", kind: "count" },
  { key: "woodMult", label: "Wood", kind: "mult" },
  { key: "amberMult", label: "Amber", kind: "mult" },
  { key: "acornMult", label: "Acorns", kind: "mult" },
  { key: "expeditionPct", label: "Expedition", kind: "pct" },
  { key: "extraOfferCount", label: "Extra cards", kind: "count" },
  { key: "rerollCharges", label: "Rerolls", kind: "count" },
  { key: "rarityLuck", label: "Luck", kind: "pct" },
];

function formatValue(kind: "pct" | "mult" | "count" | "x", value: number): string {
  if (kind === "count") return `${Math.round(value)}`;
  if (kind === "x") return `x${value.toFixed(2)}`;
  if (kind === "mult") {
    const delta = Math.round((value - 1) * 100);
    return `${delta >= 0 ? "+" : ""}${delta}%`;
  }
  return `${Math.round(value * 100)}%`;
}

export interface LedgerView {
  el: HTMLElement;
  /** Repaints from a freshly derived block. Cheap enough to call whenever the
   * panel is open; does nothing structural after the first call. */
  update(stats: RunStats, battle?: { charmed: boolean; atkSurge?: number }): void;
}

export function createLedger(): LedgerView {
  const el = document.createElement("div");
  el.className = "battle-box ledger-panel hidden";

  const title = document.createElement("div");
  title.className = "battle-boon-title";
  title.textContent = "The Field Ledger";

  const table = document.createElement("div");
  table.className = "ledger-rows";

  const notes = document.createElement("div");
  notes.className = "ledger-notes";

  el.append(title, table, notes);

  // Rows are created lazily on first appearance and then kept — a stat that
  // becomes active mid-run gets a row, and a stat that goes back to neutral
  // keeps its row rather than making the sheet jump around underneath the
  // player's eyes while they are reading it.
  const rows = new Map<RunStatKey, { row: HTMLElement; value: HTMLElement; from: HTMLElement }>();

  function ensureRow(key: RunStatKey, label: string): { row: HTMLElement; value: HTMLElement; from: HTMLElement } {
    const existing = rows.get(key);
    if (existing) return existing;
    const row = document.createElement("div");
    row.className = "ledger-row";
    const name = document.createElement("span");
    name.className = "ledger-label";
    name.textContent = label;
    const value = document.createElement("span");
    value.className = "ledger-value";
    const from = document.createElement("span");
    from.className = "ledger-from";
    row.append(name, value, from);
    table.append(row);
    const entry = { row, value, from };
    rows.set(key, entry);
    return entry;
  }

  function update(stats: RunStats, battle?: { charmed: boolean; atkSurge?: number }): void {
    const active = new Set(activeStatKeys(stats));
    for (const spec of STAT_ROWS) {
      const isActive = active.has(spec.key) || rows.has(spec.key);
      if (!isActive) continue;
      const entry = ensureRow(spec.key, spec.label);
      // Attack is the one stat whose real figure is not `values.atkMult`: the
      // Fortune Charm and War Cry are applied by battle.ts from the snapshot,
      // in their own factor slots, and must not be folded into the stat block
      // itself (see run/stats.ts's rule 2). `effectiveAtkMult` is the sanctioned
      // way to show the combined number without anyone combining it in the
      // damage path.
      const raw = spec.key === "atkMult" ? effectiveAtkMult(stats, battle) : stats.values[spec.key];
      entry.value.textContent = formatValue(spec.kind, raw);
      entry.value.classList.toggle("below-base", raw < BASE_RUN_STATS[spec.key]);

      const sources = stats.sources[spec.key];
      // The provenance line is the whole point — "+42% attack" is a number,
      // "+42% attack, from Battle Fury and a Heavy Maul" is a build.
      const shown = sources.slice(0, 3).map((c) => c.label);
      entry.from.textContent = shown.join(" · ") + (sources.length > 3 ? ` +${sources.length - 3}` : "");
      // The full list goes in the tooltip, since a run deep enough to have six
      // contributors to one stat has no room to show them all inline.
      entry.row.title = sources.length
        ? sources
            .map((c) => `${c.label}: ${c.delta >= 0 ? "+" : ""}${Math.round(c.delta * 100)}%`)
            .join("\n")
        : "";
      entry.row.classList.toggle("hidden", !active.has(spec.key));
    }
    notes.replaceChildren(
      ...stats.notes.map((n) => {
        const line = document.createElement("div");
        line.className = n.startsWith("Cursed") ? "ledger-note cursed" : "ledger-note";
        line.textContent = n;
        return line;
      }),
    );
  }

  return { el, update };
}
