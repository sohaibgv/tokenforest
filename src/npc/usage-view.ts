// A small read-only snapshot of "what is going on right now", handed to NPC
// lines so they can be specific about your token usage.
//
// This exists to keep `lines.ts` — which is pure content — from importing
// `Game`, the 6,000-line class. A line is a function of this object and
// nothing else, which makes the whole script testable without a canvas, a
// save, or a Tauri backend.
//
// EVERY FIELD IS OPTIONAL-BY-DESIGN. On a cold boot there is no block, no real
// usage, and no source list: the backend has not answered yet, and in a plain
// browser it never will. A line that renders "LAKE'S AT NaN%" is a worse
// failure than a line that simply doesn't fire, so the nullable telemetry is
// modelled as nullable and every line that touches it must guard with `when`.

import type { Snapshot } from "../bridge";

export interface UsageView {
  // --- live telemetry (null when the backend hasn't reported) ---
  /** 0..1 of the token budget still unspent — this is the lake's level. */
  density: number;
  /** 0..1 of the rolling 5-hour window consumed, or null. */
  fiveHourPct: number | null;
  /** 0..1 of the weekly allowance consumed, or null. */
  weeklyPct: number | null;
  /** Tokens counted against the budget this block, or null. */
  usedCounted: number | null;
  /** Cache reads this block — what the Cache Koi feeds on — or null. */
  usedCacheRead: number | null;
  /** Live Claude Code sessions right now. */
  sessions: number;
  /** Live subagents right now. */
  subagents: number;
  /** Sessions currently mid-request rather than idle. */
  working: number;

  // --- the player's own stores ---
  wood: number;
  amber: number;
  focus: number;

  /** True when there is no telemetry at all — every data-driven line must
   * fail closed on this, which is also the state the whole browser-based
   * verification harness runs in. */
  blind: boolean;
}

export function buildUsageView(
  snapshot: Snapshot | null,
  density: number,
  stores: { wood: number; amber: number; focus: number },
): UsageView {
  const block = snapshot?.block ?? null;
  const real = snapshot?.real ?? null;
  const sources = snapshot?.sources ?? [];
  return {
    density,
    fiveHourPct: real?.fiveHourPct ?? null,
    weeklyPct: real?.weeklyPct ?? null,
    usedCounted: block?.usedCounted ?? null,
    usedCacheRead: block?.usedCacheRead ?? null,
    sessions: sources.filter((s) => s.kind === "session").length,
    subagents: sources.filter((s) => s.kind === "subagent").length,
    working: sources.filter((s) => s.state === "working").length,
    wood: stores.wood,
    amber: stores.amber,
    focus: stores.focus,
    blind: block === null && real === null && sources.length === 0,
  };
}

/** A percentage as a whole number, for line text. */
export function pct(v: number): number {
  return Math.round(Math.max(0, Math.min(1, v)) * 100);
}
