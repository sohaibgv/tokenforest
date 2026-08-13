// Per-unit status effects for Adventure combat — the thing that lets a boon
// add a VERB rather than another adjective.
//
// The old boon set was eight flat percentages, which meant every build was the
// same build at a different size: you could tell two runs apart by their
// numbers and by nothing else. Statuses are what make an ember build and a
// thorn build actually play differently at equal power, so they are the
// foundation the whole patron catalog sits on rather than a garnish on top.
//
// Design constraints this file is written against, all inherited:
//
//   1. PURE. No DOM, no Tauri, no clock — sim/sim.ts imports it headlessly and
//      drives it with a seeded rng.
//
//   2. JSON-SERIALIZABLE. Every value here is persisted inside BattleSnapshot,
//      which is written to disk on every action so a mid-fight app restart
//      resumes exactly where it left off. No class instances, no closures, no
//      Map/Set.
//
//   3. POTENCY IS SNAPSHOTTED AT APPLY TIME. `StatusStack.potency` stores the
//      per-stack magnitude in absolute HP, resolved once when the status lands.
//      Ticking never re-reads the applier's stats. This is not an optimisation
//      — it is what keeps the resume guarantee true: an applier who has since
//      died, levelled up mid-run, or had their gear swapped must not
//      retroactively change the damage of a burn that is already on the board.
//
//   4. RATIOS IN, ABSOLUTES OUT. Callers pass `potencyPct` — a fraction of the
//      applier's effective ATK (hostile statuses) or the target's max HP
//      (friendly ones) — and this module resolves it to an absolute at apply
//      time. A status defined in flat HP would be decisive in World 0 and
//      rounding noise by World 3, which is exactly the drift the sim's
//      cross-world parity check exists to catch.
//
//   5. NO ROLL WHEN THE OUTCOME IS CERTAIN. `applyStatus` only calls rng()
//      when `chance < 1`. Every seeded scenario in the sim is a function of
//      which draw index each roll lands on, so an unconditional roll here
//      would silently re-band scenarios that have nothing to do with statuses.
//      See src/battle.ts's header for the full rule.
//
// Deliberately NOT here: a `stun` status. BattleSnapshot.skipNext already is
// that mechanism and the glitchPulse enemy special already writes it, so
// Glitch-applying boons write skipNext too. Two mechanisms for one effect is
// precisely how the reflect/charmed duplication this rework is untangling got
// started.

export type StatusId =
  // hostile — applied to enemies
  | "burn" // damage at round end, intensity decays
  | "bleed" // damage at round end, intensity decays (Bramble's twin to burn)
  | "weak" // the afflicted deals less damage
  | "vulnerable" // the afflicted takes more damage
  | "mark" // the afflicted is easier to crit; consumed when hit
  /** Loses its next turn. A VIRTUAL status: authors write it as a trigger like
   * any other, but battle.ts routes it to BattleSnapshot.skipNext instead of
   * onto this board, so there stays exactly one mechanism for "misses a turn"
   * (the one glitchPulse has always used). It never appears in a StatusState. */
  | "glitch"
  // friendly — applied to party members
  | "bark" // absorbs damage before HP; does not decay
  | "regen" // heals at round end
  | "fervor"; // temporary attack bonus

/** How a status leaves the board.
 *
 *  - "stacks": intensity is the clock. Ticks for `stacks × potency`, then
 *    loses one stack (the Slay-the-Spire poison model). A 5-stack burn deals
 *    5+4+3+2+1 over five rounds, so stacking is front-loaded and worth
 *    chasing, but a single application still fades on its own.
 *  - "rounds": a fixed duration at full strength, then gone.
 *  - "none": persists until something consumes it (Bark absorbing a hit, Mark
 *    being struck). These must have a consumer or they are permanent. */
export type StatusDecay = "stacks" | "rounds" | "none";

export interface StatusDef {
  id: StatusId;
  name: string;
  decay: StatusDecay;
  /** True for statuses that land on enemies. Drives which denominator
   * `resolvePotency` uses, and lets the UI colour them apart. */
  hostile: boolean;
  /** One line, shown on the status pip's tooltip and in the codex. */
  blurb: string;
}

export const STATUS_DEFS: StatusDef[] = [
  { id: "burn", name: "Burn", decay: "stacks", hostile: true, blurb: "Takes damage at the end of each round; fades a stack at a time." },
  { id: "bleed", name: "Bleed", decay: "stacks", hostile: true, blurb: "Takes damage at the end of each round; fades a stack at a time." },
  { id: "weak", name: "Weak", decay: "rounds", hostile: true, blurb: "Deals less damage while it lasts." },
  { id: "vulnerable", name: "Vulnerable", decay: "rounds", hostile: true, blurb: "Takes more damage while it lasts." },
  { id: "mark", name: "Marked", decay: "none", hostile: true, blurb: "Far easier to critically hit. Consumed by the next hit." },
  // Listed so it has a name, blurb and icon like any other status. Its decay
  // is "none" because it never reaches the board at all — battle.ts consumes
  // it at application time by setting skipNext. See the StatusId comment.
  { id: "glitch", name: "Glitched", decay: "none", hostile: true, blurb: "Loses its next turn entirely." },
  { id: "bark", name: "Bark", decay: "none", hostile: false, blurb: "A shield that soaks damage before HP does." },
  { id: "regen", name: "Regen", decay: "rounds", hostile: false, blurb: "Heals at the end of each round." },
  { id: "fervor", name: "Fervor", decay: "rounds", hostile: false, blurb: "Deals more damage while it lasts." },
];

export const STATUS_DEFS_BY_ID: Record<StatusId, StatusDef> = Object.fromEntries(
  STATUS_DEFS.map((d) => [d.id, d]),
) as Record<StatusId, StatusDef>;

export interface StatusStack {
  /** Intensity. For "stacks" decay this is also the remaining duration. */
  stacks: number;
  /** Rounds remaining, for "rounds" decay. Ignored otherwise. */
  rounds: number;
  /** Per-stack magnitude in ABSOLUTE units, resolved once at apply time:
   * HP for burn/bleed/bark/regen, a 0..1 fraction for weak/vulnerable/mark/
   * fervor. Never recomputed — see constraint 3 in the header. */
  potency: number;
  /** Who applied it, for lifesteal attribution and the event log. */
  sourceId?: string;
}

/** One unit's statuses. Sparse by contract: an entry is DELETED the moment it
 * empties rather than left at zero, so a fight with no statuses in play
 * persists an empty object and costs nothing in the save. */
export type StatusState = Partial<Record<StatusId, StatusStack>>;

/** unitId -> statuses. Unit ids are memberIds for the party and EnemyUnit.ids
 * ("enemy-0", "enemy-1", ...) for the other side. Note that enemy ids are
 * POSITIONAL and reassigned by every startBattle, so this map must never
 * outlive its battle. */
export type StatusBoard = Record<string, StatusState>;

/** A status a boon, charm or enemy move wants to apply. Magnitudes are ratios
 * (see header constraint 4); `resolvePotency` turns them into the absolute
 * that gets stored. */
export interface StatusApplication {
  status: StatusId;
  stacks: number;
  /** Duration for "rounds"-decay statuses. Ignored by the others. */
  rounds: number;
  /** 0..1. A value of 1 must not consume an rng draw — see header constraint 5. */
  chance: number;
  /** Fraction of the applier's effective ATK (hostile) or the target's max HP
   * (friendly). For the pure-multiplier statuses (weak/vulnerable/mark/fervor)
   * this IS the final per-stack fraction and is stored as-is. */
  potencyPct: number;
}

/** True for statuses whose potency is already a fraction rather than a
 * quantity of HP — these are stored verbatim instead of being scaled by an
 * ATK or max-HP denominator. */
function isMultiplierStatus(id: StatusId): boolean {
  return id === "weak" || id === "vulnerable" || id === "mark" || id === "fervor";
}

/**
 * Turns an application's ratio into the absolute per-stack magnitude that gets
 * frozen onto the board.
 *
 * `attackerAtk` is the applier's effective ATK at the moment of application;
 * `targetMaxHp` is the recipient's. Which one is used depends on the status,
 * not on the caller — passing both and letting this decide is what stops a
 * bark shield from accidentally being denominated in the attacker's damage.
 */
export function resolvePotency(app: StatusApplication, attackerAtk: number, targetMaxHp: number): number {
  if (isMultiplierStatus(app.status)) return app.potencyPct;
  const base = STATUS_DEFS_BY_ID[app.status].hostile ? attackerAtk : targetMaxHp;
  // Floor of 1 so a status is never applied as a visible pip that does
  // literally nothing — a 0-damage burn reads as a bug, not as balance.
  return Math.max(1, Math.round(base * app.potencyPct));
}

/**
 * Applies one status to one unit, returning whether it actually landed.
 *
 * Stacking rule: intensity ADDS, duration takes the MAX, and potency takes the
 * max of old and new. Taking the max on potency rather than overwriting means
 * a weak late-run attacker can never dilute a strong early application, which
 * would otherwise read as "my burn got worse when I hit it again".
 *
 * `rng` is only consulted when `chance < 1`.
 */
export function applyStatus(
  board: StatusBoard,
  unitId: string,
  app: StatusApplication,
  potency: number,
  sourceId?: string,
  rng: () => number = Math.random,
): boolean {
  if (app.stacks <= 0) return false;
  if (app.chance < 1 && rng() >= app.chance) return false;

  const state = board[unitId] ?? {};
  const existing = state[app.status];
  state[app.status] = {
    stacks: (existing?.stacks ?? 0) + app.stacks,
    rounds: Math.max(existing?.rounds ?? 0, app.rounds),
    potency: Math.max(existing?.potency ?? 0, potency),
    sourceId: sourceId ?? existing?.sourceId,
  };
  board[unitId] = state;
  return true;
}

/** Current stack count, 0 when absent. */
export function statusStacks(board: StatusBoard, unitId: string, id: StatusId): number {
  return board[unitId]?.[id]?.stacks ?? 0;
}

/**
 * The damage multiplier a multiplier-status contributes, as `1 ± stacks ×
 * potency`. `sign` is +1 for statuses that increase the number (vulnerable,
 * fervor) and -1 for those that reduce it (weak).
 *
 * Returns EXACTLY 1 when the status is absent. That exactness matters: it is
 * multiplied into the damage formula unconditionally, and multiplying by a
 * float that merely rounds to 1 would perturb results the sim asserts to the
 * seventeenth digit.
 *
 * The reduction case is floored at 0.05 so stacked Weak can trivialise a fight
 * but never make an enemy literally harmless, which would remove any reason to
 * finish killing it.
 */
export function statusMult(board: StatusBoard, unitId: string, id: StatusId, sign: 1 | -1): number {
  const stack = board[unitId]?.[id];
  if (!stack) return 1;
  const delta = stack.stacks * stack.potency;
  return sign === 1 ? 1 + delta : Math.max(0.05, 1 - delta);
}

/**
 * Spends a Bark shield against incoming damage.
 *
 * Returns what still gets through plus how much the shield ate, so the caller
 * can surface the absorb separately — a hit that is fully soaked should read
 * as "blocked", not as "0 damage", which looks like a miss.
 */
export function absorbShield(board: StatusBoard, unitId: string, amount: number): { through: number; absorbed: number } {
  const state = board[unitId];
  const shield = state?.bark;
  if (!shield || shield.stacks <= 0 || amount <= 0) return { through: amount, absorbed: 0 };
  // Bark's `stacks` IS its remaining hit points — potency stays 1 so the two
  // never need multiplying, and the pip can show the raw number.
  const absorbed = Math.min(shield.stacks, amount);
  shield.stacks -= absorbed;
  if (shield.stacks <= 0) delete state!.bark;
  if (state && Object.keys(state).length === 0) delete board[unitId];
  return { through: amount - absorbed, absorbed };
}

/** Consumes a Mark, returning the crit-chance bonus it was worth. Mark is
 * "none"-decay, so this consumer is the only thing that removes it. */
export function consumeMark(board: StatusBoard, unitId: string): number {
  const state = board[unitId];
  const mark = state?.mark;
  if (!mark) return 0;
  const bonus = mark.stacks * mark.potency;
  delete state!.mark;
  if (state && Object.keys(state).length === 0) delete board[unitId];
  return bonus;
}

export interface StatusTick {
  unitId: string;
  /** Total damage from every damage-over-time status on this unit. */
  damage: number;
  /** Total healing from Regen. */
  heal: number;
}

/**
 * Advances every status on the board by one round and reports what each unit
 * should take or recover. Deliberately does NOT touch HP — the caller owns
 * that, because it also owns death detection, event emission and the
 * lastStand/rope saves that a lethal tick has to route through.
 *
 * `unitIds` fixes the iteration order rather than relying on object key order,
 * which is what keeps a seeded run reproducible.
 */
export function tickStatuses(board: StatusBoard, unitIds: string[]): StatusTick[] {
  const ticks: StatusTick[] = [];
  for (const unitId of unitIds) {
    const state = board[unitId];
    if (!state) continue;
    let damage = 0;
    let heal = 0;
    for (const def of STATUS_DEFS) {
      const stack = state[def.id];
      if (!stack) continue;
      if (def.id === "burn" || def.id === "bleed") damage += stack.stacks * stack.potency;
      if (def.id === "regen") heal += stack.stacks * stack.potency;
      if (def.decay === "stacks") {
        stack.stacks -= 1;
        if (stack.stacks <= 0) delete state[def.id];
      } else if (def.decay === "rounds") {
        stack.rounds -= 1;
        if (stack.rounds <= 0) delete state[def.id];
      }
    }
    if (Object.keys(state).length === 0) delete board[unitId];
    if (damage > 0 || heal > 0) {
      ticks.push({ unitId, damage: Math.round(damage), heal: Math.round(heal) });
    }
  }
  return ticks;
}

/** Drops every status belonging to units that are no longer on the board.
 * Enemy ids are positional and reused across battles, so a stale entry would
 * silently hand a fresh enemy the previous one's burn. */
export function pruneStatuses(board: StatusBoard, liveUnitIds: string[]): void {
  const live = new Set(liveUnitIds);
  for (const id of Object.keys(board)) {
    if (!live.has(id)) delete board[id];
  }
}
