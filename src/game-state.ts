// Persistent idle-game state, owned by the frontend. Rust stores it as
// opaque JSON at ~/.config/tokenforest/save.json.

import { invoke } from "@tauri-apps/api/core";
import type { CosmeticId, HelperId } from "./economy";

export const SAVE_VERSION = 2;

export interface GameSave {
  version: number;
  wood: number;
  totalWoodEarned: number;
  /** Click energy, charged by token usage (1 per 1k counted, cap 100). */
  focus: number;
  /** Instant per-token currency (1 per 1k counted), spent on boosts. */
  amber: number;
  worldIndex: number;
  plotIndex: number;
  plotsClearedInWorld: number;
  ownedAxe: number;
  helpers: HelperId[];
  cosmetics: CosmeticId[];
  equippedCap: CosmeticId | null;
  equippedTreeSkin: CosmeticId | null;
  /** HP per tree slot of the current plot; <= 0 means stump. Null = fresh. */
  currentPlotHp: number[] | null;
  stats: {
    treesFelled: number;
    eldersFelled: number;
    chops: number;
    tokensSeen: number;
    clicks: number;
    goldenSpotsHit: number;
    startedAt: string;
  };
}

export function defaultSave(): GameSave {
  return {
    version: SAVE_VERSION,
    wood: 0,
    totalWoodEarned: 0,
    focus: 0,
    amber: 0,
    worldIndex: 0,
    plotIndex: 0,
    plotsClearedInWorld: 0,
    ownedAxe: 0,
    helpers: [],
    cosmetics: [],
    equippedCap: null,
    equippedTreeSkin: null,
    currentPlotHp: null,
    stats: {
      treesFelled: 0,
      eldersFelled: 0,
      chops: 0,
      tokensSeen: 0,
      clicks: 0,
      goldenSpotsHit: 0,
      startedAt: new Date().toISOString(),
    },
  };
}

export async function loadSave(): Promise<GameSave> {
  try {
    const raw = await invoke<string | null>("load_game");
    if (!raw) return defaultSave();
    const parsed = JSON.parse(raw) as Partial<GameSave>;
    // Spread-merge is shallow: nested objects need their own merge so old
    // saves gain new stats fields instead of clobbering the defaults.
    const d = defaultSave();
    return {
      ...d,
      ...parsed,
      stats: { ...d.stats, ...parsed.stats },
      version: SAVE_VERSION,
    };
  } catch {
    return defaultSave();
  }
}

let pending: GameSave | null = null;
let timer: number | null = null;

function flush(): void {
  if (pending) {
    void invoke("save_game", { json: JSON.stringify(pending) });
    pending = null;
  }
  timer = null;
}

/** Debounced (2s); pass immediate=true on fells/purchases/travel. */
export function scheduleSave(save: GameSave, immediate = false): void {
  pending = save;
  if (immediate) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    flush();
    return;
  }
  if (timer === null) {
    timer = window.setTimeout(flush, 2000);
  }
}
