// Deterministic RNG so plots look the same across frames and relaunches.
//
// The implementation moved to src/rng.ts so the pure run/ modules can use it
// without a src/*.ts -> src/scene/ import (see that file's header). This
// re-export keeps every existing canvas call site working unchanged.

export { hashString, mulberry32 } from "../rng";
