// Typed wrappers around the Tauri bridge: tf:* events + commands.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

export interface Snapshot {
  block: BlockInfo | null;
  sources: SourceInfo[];
  woodcutters: number;
}

export function getSnapshot(): Promise<Snapshot> {
  return invoke<Snapshot>("get_snapshot");
}

export function setBudget(tokens: number): Promise<void> {
  return invoke("set_budget", { tokens });
}

/** Tell the tray a tree fell so the menu bar can celebrate it. */
export function reportFell(wood: number): Promise<void> {
  return invoke("report_fell", { wood });
}

export function onChop(handler: (e: ChopEvent) => void): void {
  void listen<ChopEvent>("tf:chop", (ev) => handler(ev.payload));
}

export function onSnapshot(handler: (s: Snapshot) => void): void {
  void listen<Snapshot>("tf:snapshot", (ev) => handler(ev.payload));
}

export function onBlockReset(handler: () => void): void {
  void listen("tf:block-reset", () => handler());
}
