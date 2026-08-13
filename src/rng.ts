// Deterministic RNG, shared by everything that needs reproducible randomness:
// plot/dungeon layout (so scenery doesn't crawl between frames or relaunches),
// the Adventure run map (so a run's rooms and doors regenerate identically
// after an app restart), and sim/sim.ts's seeded scenario streams.
//
// This lives at src/ rather than src/scene/ because of the repo's purity
// contract: src/*.ts modules must not import DOM, Tauri, or canvas code, and
// sim/sim.ts imports them headlessly. src/run/* needs a seeded stream, and no
// src/*.ts module currently reaches into src/scene/ — a run-map module must
// not be the first to open that door, or the direction of the dependency graph
// (pure core <- canvas <- DOM) stops being enforceable by inspection.
//
// src/scene/rng.ts is kept as a re-export so the canvas call sites that
// already import from there don't have to change.

export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
