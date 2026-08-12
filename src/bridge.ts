// Typed wrappers around the Tauri bridge: tf:* events + commands.
//
// Every wrapper below degrades gracefully when the Tauri bridge is absent
// (plain-browser `npm run dev` for visual QA) or a command fails: invoke()
// THROWS SYNCHRONOUSLY without __TAURI_INTERNALS__, which would otherwise
// kill boot() halfway through wiring the UI — so everything funnels through
// call(), which converts both sync throws and rejections into a fallback.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

async function call<T>(cmd: string, args: Record<string, unknown> | undefined, fallback: T): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch {
    return fallback;
  }
}

export interface ChopEvent {
  sourceId: string;
  sessionId: string;
  agentId: string | null;
  counted: number;
  cacheRead: number;
  ts: string;
}

export type SourceActivity = "working" | "waiting" | "idle";

export interface SourceInfo {
  id: string;
  kind: "session" | "subagent";
  state: SourceActivity;
  projectDir: string;
  lastActivity: string;
}

export interface BlockInfo {
  start: string;
  end: string;
  usedCounted: number;
  usedCacheRead: number;
  budget: number;
  density: number;
}

export interface RealUsage {
  fiveHourPct: number; // 0..1 of the 5h window consumed
  fiveHourResetsAt: string | null;
  weeklyPct: number | null;
  weeklyResetsAt: string | null;
}

export interface Snapshot {
  block: BlockInfo | null;
  /** Real account usage from the Claude Code login, when readable. */
  real: RealUsage | null;
  sources: SourceInfo[];
  woodcutters: number;
}

export function getSnapshot(): Promise<Snapshot> {
  return call<Snapshot>("get_snapshot", undefined, { block: null, real: null, sources: [], woodcutters: 0 });
}

export function setBudget(tokens: number): Promise<void> {
  return call<void>("set_budget", { tokens }, undefined);
}

/** Tell the tray a tree fell so the menu bar can celebrate it. */
export function reportFell(wood: number): Promise<void> {
  return call<void>("report_fell", { wood }, undefined);
}

/** Dropdown mode: hide on click-away + always-on-top + skip taskbar. */
export function getHideOnBlur(): Promise<boolean> {
  return call<boolean>("get_hide_on_blur", undefined, false);
}

export function setHideOnBlur(enabled: boolean): Promise<void> {
  return call<void>("set_hide_on_blur", { enabled }, undefined);
}

/** Poll real account usage via the local Claude Code login. */
export function getUseRealUsage(): Promise<boolean> {
  return call<boolean>("get_use_real_usage", undefined, true);
}

export function setUseRealUsage(enabled: boolean): Promise<void> {
  return call<void>("set_use_real_usage", { enabled }, undefined);
}

export interface SfxSettings {
  muted: boolean;
  volume: number;
}

/** SFX master mute/volume, persisted app-level in config.json. Falls back
 * to defaults when the Tauri bridge is absent (plain-browser dev preview). */
export function getSfxSettings(): Promise<SfxSettings> {
  return call<SfxSettings>("get_sfx_settings", undefined, { muted: false, volume: 0.5 });
}

export function setSfxSettings(muted: boolean, volume: number): Promise<void> {
  return call<void>("set_sfx_settings", { muted, volume }, undefined);
}

export function onChop(handler: (e: ChopEvent) => void): void {
  try {
    void listen<ChopEvent>("tf:chop", (ev) => handler(ev.payload));
  } catch {
    /* no bridge (browser dev) — no chop events */
  }
}

export function onSnapshot(handler: (s: Snapshot) => void): void {
  try {
    void listen<Snapshot>("tf:snapshot", (ev) => handler(ev.payload));
  } catch {
    /* no bridge (browser dev) — no snapshots */
  }
}

export function onBlockReset(handler: () => void): void {
  try {
    void listen("tf:block-reset", () => handler());
  } catch {
    /* no bridge (browser dev) */
  }
}
