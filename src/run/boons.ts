// The boon catalog — what a run is actually built out of.
//
// The system this replaces was eight boons that each added a flat percentage
// and stacked without limit. Four picks per run, no exclusivity, no rarity, no
// depth: the optimal play was "take the biggest number", every run converged on
// the same shape, and the only thing distinguishing two builds was how many
// times you had been offered Battle Fury.
//
// Three structural decisions fix that, and everything in this file exists to
// serve one of them:
//
// 1. SLOTS MAKE PICKS EXCLUSIVE. Strike, Guard and Rite hold exactly ONE boon
//    each. Taking a new one replaces what was there. That single rule is what
//    turns an offer from an increment into a decision — you cannot have both
//    Kindle and Thornbite, so the run has to commit to being a burn run or a
//    bleed run, and it has to commit early. Aura and Fortune stack (up to a
//    cap) so there is still somewhere for breadth to go.
//
// 2. BOONS ADD VERBS. A boon that applies Burn plays differently from one that
//    applies Weak at identical power, because they interact with different
//    parts of the fight. Every patron's Strike and Guard boons carry that
//    patron's signature status, so committing a slot commits a play pattern.
//    Boons are expressed as data (`BoonEffect[]`) rather than code precisely so
//    this stays inspectable and sim-checkable: nothing here can quietly touch
//    combat in a way the ledger can't explain.
//
// 3. RARITY AND RANK SEPARATE "HOW GOOD" FROM "HOW MANY". A boon rolls at a
//    rarity when offered and is deepened by rank afterwards (Hades' Pom of
//    Power). Rank steps are LINEAR and deliberately smaller than a rarity step,
//    so a rank-2 Rare never eclipses a rank-1 Heroic — otherwise ranks would
//    make rarity cosmetic, and the excitement of a Heroic drop is most of what
//    an offer screen is for.
//
// A patron's boons may apply that patron's signature status and no other's;
// duo boons are the sole exception, which is exactly what makes them read as a
// secret rather than as more content. sim/sim.ts asserts this.

import type { StatusId } from "../statuses";
import type { RunStatKey } from "./stats";
import type { PatronId } from "./patrons";

export type BoonRarity = "common" | "rare" | "epic" | "heroic";

/** Where a boon lives on the build.
 *
 *  - strike / guard / rite: ONE each. Picking a second replaces the first.
 *  - aura: general passives, up to AURA_CAP.
 *  - fortune: economy and meta, up to FORTUNE_CAP.
 *  - instant: not held at all — resolves once at pick time and is recorded
 *    only so the HUD tally and the "don't offer a no-op again" filters see it. */
export type BoonSlot = "strike" | "guard" | "rite" | "aura" | "fortune" | "instant";

export const AURA_CAP = 4;
export const FORTUNE_CAP = 3;

/** Rarity multiplies a boon's base magnitude. The steps widen as they go, so a
 * Heroic is not merely "a bit more" — it is the thing you reroll for. */
export const BOON_RARITY_MULT: Record<BoonRarity, number> = {
  common: 1,
  rare: 1.5,
  epic: 2.2,
  heroic: 3.2,
};

/** Each rank adds this fraction of the BASE magnitude — linear, not
 * compounding. At 0.3, a rank-5 Common sits at 2.2x (an Epic), and a rank-2
 * Rare at 1.95x still lands under a rank-1 Heroic's 3.2x. That ordering is
 * asserted in the sim: ranks must deepen a build without making the rarity
 * roll irrelevant. */
export const BOON_RANK_STEP = 0.3;
export const MAX_BOON_RANK = 5;

/** Iron Skin's max-HP bump and Second Wind's heal, as fractions of max HP.
 *
 * These two are the only boons that touch real HP pools at PICK time rather
 * than through the per-turn stat block — the same apply-once treatment
 * equipping gear already gets — so their magnitudes live here beside the
 * catalog rather than in the effect data, which only describes things the
 * combat engine reads. */
export const BOON_HP_PCT = 0.2;
export const BOON_HEAL_PCT = 0.25;

export const RARITY_LABEL: Record<BoonRarity, string> = {
  common: "Common",
  rare: "Rare",
  epic: "Epic",
  heroic: "Heroic",
};

/** Trigger points a boon can hang a status off. These map one-to-one onto
 * places battle.ts already has a natural seam, which is why the set is small:
 * a trigger that needed a new seam would be a `custom` handler instead. */
export type BoonTrigger = "attack" | "guard" | "kill" | "roundStart";

/** Bespoke behaviour that cannot be expressed as a stat or a status.
 *
 * Kept to a deliberately short list. Every entry here is a switch case
 * somewhere in battle.ts or Game, so each one is a place the data model stops
 * being able to explain itself — worth it for a handful of signature effects,
 * not worth it for ordinary ones. Anything expressible as a stat or trigger
 * MUST be expressed that way instead. */
export type BoonHandlerId =
  // Rite-slot: fire when the once-per-run Ability is used.
  | "riteBark"
  | "riteBurnAll"
  | "riteHealRegen"
  | "riteGlitchAll"
  | "riteReroll"
  // Pick-time, resolve once and are done.
  | "ironSkinHp"
  | "secondWindHeal"
  | "rechargeAbility";

export type BoonEffect =
  | { kind: "stat"; key: RunStatKey; perStep: number }
  | {
      kind: "trigger";
      on: BoonTrigger;
      status: StatusId;
      /** Base stack count; scaled by rarity and rank. */
      stacks: number;
      /** Duration for duration-decay statuses. Not scaled — a longer Weak is
       * far swingier than a stronger one, and scaling both would make a Heroic
       * control boon simply end fights. */
      rounds?: number;
      /** 0..1. Omitted means certain, which must not consume an rng draw. */
      chance?: number;
      /** Fraction of the applier's ATK (hostile statuses) or the target's max
       * HP (friendly). Not scaled by rarity — stacks carry the scaling, so the
       * per-tick number stays readable as the build grows. */
      potencyPct: number;
    }
  | { kind: "custom"; handlerId: BoonHandlerId };

export interface BoonDef {
  id: string;
  patron: PatronId;
  name: string;
  slot: BoonSlot;
  /** Which tiers this boon can roll at. Most roll at all four; a few
   * deliberately cap out lower because their effect does not want to be
   * tripled. */
  rarities: BoonRarity[];
  maxRank: number;
  effects: BoonEffect[];
  /** Shown verbatim on the card. `{n}` is substituted with the RESOLVED
   * magnitude for the rarity and rank actually being offered, so a Heroic card
   * shows its own real number rather than the Common one — the single most
   * important honesty property of an offer screen. */
  description: string;
  /** Duo boon: both patrons must already have at least one boon held. Implies
   * a non-exclusive slot and no ranks. */
  duoPatrons?: [PatronId, PatronId];
  /** Legendary: needs this many of its own patron's boons already held, at
   * rank 2 or better. */
  requiresPatronBoons?: number;
  /** Boons that must already be held for this to be offered at all. */
  requiresBoons?: string[];
  /** Never offered alongside these. */
  conflicts?: string[];
}

export interface BoonInstance {
  id: string;
  rarity: BoonRarity;
  rank: number;
  /** How many times this exact boon was taken. Only ever above 1 on the legacy
   * stacking path (a pre-rework save's `boons` record); new picks deepen rank
   * instead. Kept so those saves derive identical numbers to what they had. */
  stacks?: number;
  /** Room index it was picked in — run recap only. */
  room?: number;
}

/** The multiplier applied to a boon's base magnitudes. */
export function boonMagnitude(inst: Pick<BoonInstance, "rarity" | "rank" | "stacks">): number {
  const rarity = BOON_RARITY_MULT[inst.rarity] ?? 1;
  const rank = 1 + BOON_RANK_STEP * (Math.max(1, inst.rank) - 1);
  return rarity * rank * (inst.stacks ?? 1);
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------
//
// Magnitudes below are Common, rank 1 — multiply by boonMagnitude for a real
// offer. Every one is a RATIO, never a flat amount: gear, enemies and wood all
// scale by 10^world, so a flat number would decide fights in World 0 and be
// rounding noise by World 3. See run/stats.ts's rule 1.
//
// DECLARATION ORDER IS SIGNIFICANT. deriveRunStats folds contributions in
// catalog order, and the old helpers evaluated `1 + 0.15*fury + 0.05*trance`
// left to right. Floating-point addition is not associative, so Battle Fury
// must precede Battle Trance, and Keen Reflexes must precede Battle Trance, or
// the seeded sim results move in the last bits. The eight legacy boons keep
// their original ids for the same reason saves keep working.

const BRAMBLE_BOONS: BoonDef[] = [
  {
    id: "thornbite",
    patron: "bramble",
    name: "Thornbite",
    slot: "strike",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "trigger", on: "attack", status: "bleed", stacks: 2, potencyPct: 0.35 }],
    description: "Your attacks leave {n} Bleed. Bleeding enemies lose blood at the end of every round.",
  },
  {
    id: "bristleback",
    patron: "bramble",
    name: "Bristleback",
    slot: "guard",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [
      { kind: "stat", key: "reflectPct", perStep: 0.08 },
      { kind: "trigger", on: "guard", status: "bleed", stacks: 1, potencyPct: 0.3 },
    ],
    description: "Defending throws back {n}% of the blow and leaves every attacker Bleeding.",
  },
  {
    id: "brambleWall",
    patron: "bramble",
    name: "Bramble Wall",
    slot: "rite",
    rarities: ["common", "rare", "epic"],
    maxRank: 3,
    effects: [{ kind: "custom", handlerId: "riteBark" }],
    description: "Your Ability also raises a wall of Bark around the whole party.",
  },
  {
    id: "ironroot",
    patron: "bramble",
    name: "Ironroot",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [
      { kind: "stat", key: "armorPct", perStep: 0.08 },
      { kind: "stat", key: "reflectPct", perStep: 0.04 },
    ],
    description: "Take {n}% less damage from everything.",
  },
  {
    id: "barbedHide",
    patron: "bramble",
    name: "Barbed Hide",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "reflectPct", perStep: 0.11 }],
    description: "Anything that hits you takes {n}% of the blow straight back.",
  },
  {
    id: "deepRoots",
    patron: "bramble",
    name: "Deep Roots",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "regenPerRoundPct", perStep: 0.03 }],
    description: "Recover {n}% of your health at the end of every round.",
  },
  {
    id: "guardiansWard",
    patron: "bramble",
    name: "Guardian's Ward",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "reflectPct", perStep: 0.12 }],
    description: "{n}% of all damage taken is reflected back at whoever dealt it.",
  },
  {
    id: "harvestOfThorns",
    patron: "bramble",
    name: "Harvest of Thorns",
    slot: "fortune",
    rarities: ["common", "rare", "epic"],
    maxRank: 3,
    effects: [{ kind: "stat", key: "acornMult", perStep: 0.5 }],
    description: "Every room yields {n}% more acorns.",
  },
];

const CINDER_BOONS: BoonDef[] = [
  {
    id: "kindle",
    patron: "cinder",
    name: "Kindle",
    slot: "strike",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "trigger", on: "attack", status: "burn", stacks: 2, potencyPct: 0.3 }],
    description: "Your attacks set the target alight for {n} Burn.",
  },
  {
    id: "backdraft",
    patron: "cinder",
    name: "Backdraft",
    slot: "guard",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "trigger", on: "guard", status: "burn", stacks: 3, potencyPct: 0.3 }],
    description: "Defending fans the flames — every enemy catches {n} Burn.",
  },
  {
    id: "wildfire",
    patron: "cinder",
    name: "Wildfire",
    slot: "rite",
    rarities: ["common", "rare", "epic"],
    maxRank: 3,
    effects: [{ kind: "custom", handlerId: "riteBurnAll" }],
    description: "Your Ability sets the entire room on fire.",
  },
  {
    id: "keenReflexes",
    patron: "cinder",
    name: "Keen Reflexes",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "critChance", perStep: 0.1 }],
    description: "+{n}% critical hit chance.",
  },
  {
    id: "overheat",
    patron: "cinder",
    name: "Overheat",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "critMult", perStep: 0.4 }],
    description: "Critical hits land far harder.",
  },
  {
    id: "ashfall",
    patron: "cinder",
    name: "Ashfall",
    slot: "aura",
    rarities: ["common", "rare", "epic"],
    maxRank: 3,
    effects: [{ kind: "trigger", on: "roundStart", status: "burn", stacks: 1, potencyPct: 0.25 }],
    description: "Embers keep falling — every enemy gains {n} Burn each round.",
  },
  {
    id: "battleFury",
    patron: "cinder",
    name: "Battle Fury",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "atkMult", perStep: 0.15 }],
    description: "+{n}% party attack.",
  },
  {
    id: "battleTrance",
    patron: "cinder",
    name: "Battle Trance",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [
      { kind: "stat", key: "atkMult", perStep: 0.05 },
      { kind: "stat", key: "critChance", perStep: 0.05 },
    ],
    description: "+{n}% party attack and the same again in critical chance.",
  },
  {
    id: "cinderhide",
    patron: "cinder",
    name: "Cinderhide",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "armorPct", perStep: 0.09 }],
    description: "Skin like banked coals. Take {n}% less damage.",
  },
  {
    id: "emberdust",
    patron: "cinder",
    name: "Emberdust",
    slot: "fortune",
    rarities: ["common", "rare", "epic"],
    maxRank: 3,
    effects: [{ kind: "stat", key: "amberMult", perStep: 0.25 }],
    description: "What burns leaves amber behind: +{n}% amber.",
  },
];

const SAP_BOONS: BoonDef[] = [
  {
    id: "siphon",
    patron: "sap",
    name: "Siphon",
    slot: "strike",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [
      { kind: "stat", key: "lifestealPct", perStep: 0.15 },
      // Sustain alone loses the damage race: a fight you cannot end is a fight
      // that eventually ends you. Siphon takes as well as gives.
      { kind: "stat", key: "atkMult", perStep: 0.06 },
    ],
    description: "Your attacks hit harder and return {n}% of the damage dealt as health.",
  },
  {
    id: "barkskin",
    patron: "sap",
    name: "Barkskin",
    slot: "guard",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "shieldOnGuardPct", perStep: 0.2 }],
    description: "Defending grows Bark worth {n}% of your health — it soaks damage before you do.",
  },
  {
    id: "bloom",
    patron: "sap",
    name: "Bloom",
    slot: "rite",
    rarities: ["common", "rare", "epic"],
    maxRank: 3,
    effects: [{ kind: "custom", handlerId: "riteHealRegen" }],
    description: "Your Ability heals the party and leaves them regenerating.",
  },
  {
    id: "verdantPulse",
    patron: "sap",
    name: "Verdant Pulse",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "regenPerRoundPct", perStep: 0.055 }],
    description: "The party recovers {n}% of its health every round.",
  },
  {
    id: "heartwood",
    patron: "sap",
    name: "Heartwood",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "armorPct", perStep: 0.13 }],
    description: "Take {n}% less damage from every source.",
  },
  {
    id: "secondRing",
    patron: "sap",
    name: "Second Ring",
    slot: "aura",
    rarities: ["rare", "epic", "heroic"],
    maxRank: 1,
    effects: [{ kind: "stat", key: "lastStandCharges", perStep: 1 }],
    description: "The first blow that would end the party leaves one of you standing at 1 health instead.",
  },
  {
    id: "ironSkin",
    patron: "sap",
    name: "Iron Skin",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "custom", handlerId: "ironSkinHp" }],
    description: "+20% party maximum health, and heal for what you gain.",
  },
  {
    id: "secondWind",
    patron: "sap",
    name: "Second Wind",
    slot: "instant",
    rarities: ["common", "rare", "epic"],
    maxRank: 1,
    effects: [{ kind: "custom", handlerId: "secondWindHeal" }],
    description: "Heal the whole party for 25% of their health, right now.",
  },
  {
    id: "sapline",
    patron: "sap",
    name: "Sapline",
    slot: "fortune",
    rarities: ["common", "rare", "epic"],
    maxRank: 3,
    effects: [{ kind: "stat", key: "woodMult", perStep: 0.25 }],
    description: "Every room gives {n}% more wood.",
  },
];

const STATIC_BOONS: BoonDef[] = [
  {
    id: "jitter",
    patron: "static",
    name: "Jitter",
    slot: "strike",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "trigger", on: "attack", status: "weak", stacks: 1, rounds: 2, potencyPct: 0.16 }],
    description: "Your attacks leave the target Weak — it deals far less damage for two rounds.",
  },
  {
    id: "firewall",
    patron: "static",
    name: "Firewall",
    slot: "guard",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "trigger", on: "guard", status: "glitch", stacks: 1, chance: 0.3, potencyPct: 0 }],
    description: "Defending has a real chance to Glitch each attacker — it loses its next turn entirely.",
  },
  {
    id: "hardReset",
    patron: "static",
    name: "Hard Reset",
    slot: "rite",
    rarities: ["common", "rare", "epic"],
    maxRank: 3,
    effects: [{ kind: "custom", handlerId: "riteGlitchAll" }],
    description: "Your Ability Glitches every enemy in the room.",
  },
  {
    id: "packetLoss",
    patron: "static",
    name: "Packet Loss",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "dodgePct", perStep: 0.085 }],
    description: "{n}% of incoming attacks simply fail to connect.",
  },
  {
    id: "targetingLock",
    patron: "static",
    name: "Targeting Lock",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "trigger", on: "attack", status: "vulnerable", stacks: 1, rounds: 2, potencyPct: 0.2 }],
    description: "Everything you hit becomes Vulnerable, taking far more damage from every source.",
  },
  {
    id: "cascade",
    patron: "static",
    name: "Cascade",
    slot: "aura",
    rarities: ["rare", "epic", "heroic"],
    maxRank: 3,
    effects: [{ kind: "trigger", on: "kill", status: "glitch", stacks: 1, potencyPct: 0 }],
    description: "A kill cascades — every surviving enemy is Glitched.",
  },
  {
    id: "overclock",
    patron: "static",
    name: "Overclock",
    slot: "fortune",
    rarities: ["rare", "epic"],
    maxRank: 1,
    effects: [{ kind: "stat", key: "extraOfferCount", perStep: 1 }],
    description: "Every boon offer shows one more card.",
  },
];

const LUMEN_BOONS: BoonDef[] = [
  {
    id: "sunstrike",
    patron: "lumen",
    name: "Sunstrike",
    slot: "strike",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [
      { kind: "stat", key: "critChance", perStep: 0.15 },
      { kind: "stat", key: "critMult", perStep: 0.2 },
    ],
    description: "+{n}% critical chance, and criticals hit harder.",
  },
  {
    id: "aegisOfDawn",
    patron: "lumen",
    name: "Aegis of Dawn",
    slot: "guard",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "guardBonus", perStep: 0.2 }],
    description: "Defending blocks {n}% more than it should.",
  },
  {
    id: "benediction",
    patron: "lumen",
    name: "Benediction",
    slot: "rite",
    rarities: ["common", "rare", "epic"],
    maxRank: 3,
    effects: [
      { kind: "custom", handlerId: "riteReroll" },
      // A Rite that only paid out between fights left Lumen with a dead slot
      // in every fight it had. The patron's attention should be worth
      // something while it is on you.
      { kind: "stat", key: "critChance", perStep: 0.08 },
    ],
    description: "Your Ability returns a reroll to your pocket, and the patron's eye is on you: +{n}% critical chance.",
  },
  {
    id: "goldenHour",
    patron: "lumen",
    name: "Golden Hour",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [
      { kind: "stat", key: "woodMult", perStep: 0.35 },
      { kind: "stat", key: "amberMult", perStep: 0.35 },
    ],
    description: "+{n}% wood and amber from every room.",
  },
  {
    id: "fortunesEye",
    patron: "lumen",
    name: "Fortune's Eye",
    slot: "aura",
    rarities: ["rare", "epic", "heroic"],
    maxRank: 3,
    effects: [
      { kind: "stat", key: "rarityLuck", perStep: 0.2 },
      { kind: "stat", key: "critMult", perStep: 0.25 },
    ],
    description: "Offers roll at a higher rarity far more often, and your criticals bite deeper.",
  },
  {
    id: "windfall",
    patron: "lumen",
    name: "Windfall",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [
      { kind: "stat", key: "acornMult", perStep: 0.5 },
      { kind: "stat", key: "atkMult", perStep: 0.08 },
    ],
    description: "+{n}% acorns from everything, and fortune favours your swing.",
  },
  {
    id: "dawnward",
    patron: "lumen",
    name: "Dawnward",
    slot: "aura",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [
      { kind: "stat", key: "armorPct", perStep: 0.13 },
      { kind: "stat", key: "dodgePct", perStep: 0.08 },
    ],
    description: "First light keeps some of it off you: {n}% less damage taken.",
  },
  {
    id: "patronsEar",
    patron: "lumen",
    name: "Patron's Ear",
    slot: "fortune",
    rarities: ["rare", "epic"],
    maxRank: 2,
    effects: [
      { kind: "stat", key: "rerollCharges", perStep: 1 },
      { kind: "stat", key: "atkMult", perStep: 0.05 },
    ],
    description: "{n} more reroll to spend on offers you don't like, and a little more force behind you.",
  },
  {
    id: "lumberBlessing",
    patron: "lumen",
    name: "Lumber Blessing",
    slot: "fortune",
    rarities: ["common", "rare", "epic", "heroic"],
    maxRank: MAX_BOON_RANK,
    effects: [{ kind: "stat", key: "woodMult", perStep: 0.3 }],
    description: "+{n}% wood from every room cleared this run.",
  },
  {
    id: "vengefulSpirit",
    patron: "lumen",
    name: "Vengeful Spirit",
    slot: "instant",
    rarities: ["common", "rare"],
    maxRank: 1,
    effects: [{ kind: "custom", handlerId: "rechargeAbility" }],
    description: "Recharges your once-per-run Ability immediately.",
  },
];

/** Duo boons — the only place two patrons' signatures meet.
 *
 * Offered only when the player already holds at least one boon from BOTH
 * patrons, which means they are always a reward for a commitment already made
 * rather than a suggestion to make one. Always Epic or better, never ranked:
 * a duo is a landmark, and landmarks should not have levels. */
const DUO_BOONS: BoonDef[] = [
  {
    id: "wildfireThicket",
    patron: "cinder",
    duoPatrons: ["cinder", "bramble"],
    name: "Wildfire Thicket",
    slot: "aura",
    rarities: ["epic", "heroic"],
    maxRank: 1,
    effects: [
      { kind: "trigger", on: "attack", status: "burn", stacks: 2, potencyPct: 0.3 },
      { kind: "trigger", on: "attack", status: "bleed", stacks: 2, potencyPct: 0.3 },
    ],
    description: "Thorns catch fire. Every attack applies both Burn and Bleed.",
  },
  {
    id: "smolderingRoots",
    patron: "sap",
    duoPatrons: ["cinder", "sap"],
    name: "Smouldering Roots",
    slot: "aura",
    rarities: ["epic", "heroic"],
    maxRank: 1,
    effects: [{ kind: "stat", key: "lifestealPct", perStep: 0.2 }],
    description: "The fire feeds you. A fifth of all damage dealt returns as health.",
  },
  {
    id: "blackout",
    patron: "static",
    duoPatrons: ["static", "cinder"],
    name: "Blackout",
    slot: "aura",
    rarities: ["epic", "heroic"],
    maxRank: 1,
    effects: [
      { kind: "trigger", on: "attack", status: "burn", stacks: 3, potencyPct: 0.3 },
      { kind: "trigger", on: "guard", status: "glitch", stacks: 1, chance: 0.5, potencyPct: 0 },
    ],
    description: "The lights go out and the fire spreads. Heavy Burn on attack, Glitch on guard.",
  },
  {
    id: "faradayCage",
    patron: "bramble",
    duoPatrons: ["static", "bramble"],
    name: "Faraday Cage",
    slot: "aura",
    rarities: ["epic", "heroic"],
    maxRank: 1,
    effects: [
      { kind: "stat", key: "reflectPct", perStep: 0.12 },
      { kind: "trigger", on: "guard", status: "glitch", stacks: 1, chance: 0.6, potencyPct: 0 },
    ],
    description: "What you throw back carries a charge. Guarding Glitches almost anything that swings.",
  },
  {
    id: "dawnThorn",
    patron: "lumen",
    duoPatrons: ["lumen", "bramble"],
    name: "Dawn Thorn",
    slot: "aura",
    rarities: ["epic", "heroic"],
    maxRank: 1,
    effects: [
      { kind: "stat", key: "acornMult", perStep: 0.6 },
      { kind: "trigger", on: "attack", status: "bleed", stacks: 1, potencyPct: 0.3 },
    ],
    description: "Bleeding things shed acorns. Far richer rooms, and every attack draws blood.",
  },
  {
    id: "photosynthesis",
    patron: "lumen",
    duoPatrons: ["lumen", "sap"],
    name: "Photosynthesis",
    slot: "aura",
    rarities: ["epic", "heroic"],
    maxRank: 1,
    effects: [
      { kind: "stat", key: "regenPerRoundPct", perStep: 0.05 },
      { kind: "stat", key: "woodMult", perStep: 0.3 },
    ],
    description: "Light into growth. Steady regeneration, and a great deal more wood.",
  },
  {
    id: "gridFailure",
    patron: "static",
    duoPatrons: ["static", "sap"],
    name: "Grid Failure",
    slot: "aura",
    rarities: ["epic", "heroic"],
    maxRank: 1,
    effects: [
      { kind: "stat", key: "dodgePct", perStep: 0.12 },
      { kind: "stat", key: "regenPerRoundPct", perStep: 0.04 },
    ],
    description: "Their targeting never quite resolves, and the roots keep working.",
  },
  {
    id: "solarFlare",
    patron: "cinder",
    duoPatrons: ["lumen", "cinder"],
    name: "Solar Flare",
    slot: "aura",
    rarities: ["epic", "heroic"],
    maxRank: 1,
    effects: [
      { kind: "stat", key: "executePct", perStep: 0.15 },
      { kind: "stat", key: "critChance", perStep: 0.1 },
    ],
    description: "Anything already badly hurt simply goes out when you strike it.",
  },
];

/** Legendary boons — one per patron, offered only to a run that has clearly
 * committed to that patron (three of its boons, at rank 2 or better).
 *
 * These are the payoff for the loyalty the slot system asks for, and the
 * reason to keep taking Bramble cards when a shiny Cinder Heroic is sitting
 * next to them. */
const LEGENDARY_BOONS: BoonDef[] = [
  {
    id: "brambleThrone",
    patron: "bramble",
    name: "The Bramble Throne",
    slot: "aura",
    rarities: ["heroic"],
    maxRank: 1,
    requiresPatronBoons: 3,
    effects: [
      { kind: "stat", key: "armorPct", perStep: 0.25 },
      { kind: "stat", key: "reflectPct", perStep: 0.15 },
    ],
    description: "You are the hedge now. Very little gets through, and what does regrets it.",
  },
  {
    id: "emberheart",
    patron: "cinder",
    name: "Emberheart",
    slot: "aura",
    rarities: ["heroic"],
    maxRank: 1,
    requiresPatronBoons: 3,
    effects: [
      { kind: "stat", key: "critMult", perStep: 0.8 },
      { kind: "stat", key: "critChance", perStep: 0.15 },
    ],
    description: "The fire is inside now. Criticals come often and land like a falling tree.",
  },
  {
    id: "worldTree",
    patron: "sap",
    name: "World Tree",
    slot: "aura",
    rarities: ["heroic"],
    maxRank: 1,
    requiresPatronBoons: 3,
    effects: [
      { kind: "stat", key: "regenPerRoundPct", perStep: 0.08 },
      { kind: "stat", key: "armorPct", perStep: 0.1 },
      { kind: "stat", key: "lastStandCharges", perStep: 1 },
    ],
    description: "Roots all the way down. You mend as fast as they can wound you, and you do not fall first.",
  },
  {
    id: "nullPointer",
    patron: "static",
    name: "Null Pointer",
    slot: "aura",
    rarities: ["heroic"],
    maxRank: 1,
    requiresPatronBoons: 3,
    effects: [
      { kind: "trigger", on: "roundStart", status: "weak", stacks: 2, rounds: 2, potencyPct: 0.2 },
      { kind: "stat", key: "dodgePct", perStep: 0.1 },
    ],
    description: "Nothing in the room can find its footing. Everything arrives Weak, every round.",
  },
  {
    id: "longDay",
    patron: "lumen",
    name: "The Long Day",
    slot: "fortune",
    rarities: ["heroic"],
    maxRank: 1,
    requiresPatronBoons: 3,
    effects: [
      { kind: "stat", key: "extraOfferCount", perStep: 1 },
      { kind: "stat", key: "rerollCharges", perStep: 1 },
      { kind: "stat", key: "rarityLuck", perStep: 0.3 },
    ],
    description: "The sun refuses to set. More on offer, more rerolls, and better odds on all of it.",
  },
];

export const BOON_DEFS: BoonDef[] = [
  ...BRAMBLE_BOONS,
  ...CINDER_BOONS,
  ...SAP_BOONS,
  ...STATIC_BOONS,
  ...LUMEN_BOONS,
  ...DUO_BOONS,
  ...LEGENDARY_BOONS,
];

export const BOON_DEFS_BY_ID: Record<string, BoonDef> = Object.fromEntries(BOON_DEFS.map((d) => [d.id, d]));

/** Slot capacity. `instant` returns 0 — it is never held. */
export function slotCapacity(slot: BoonSlot): number {
  if (slot === "aura") return AURA_CAP;
  if (slot === "fortune") return FORTUNE_CAP;
  if (slot === "instant") return 0;
  return 1;
}

/** Which held boon a pick would REPLACE, if any. Exclusive slots are the whole
 * point of the system, so the offer card has to be able to say what taking it
 * costs — an exclusive pick that silently discarded the previous boon would be
 * the single most frustrating thing in the run. */
export function boonReplaces(held: BoonInstance[], def: BoonDef): BoonInstance | null {
  if (slotCapacity(def.slot) !== 1) return null;
  return held.find((h) => BOON_DEFS_BY_ID[h.id]?.slot === def.slot && h.id !== def.id) ?? null;
}

/** Substitutes `{n}` in a description with the resolved magnitude, so a card
 * always shows the number the player is actually being offered.
 *
 * Uses the first stat effect's value where there is one, falling back to the
 * first trigger's stack count. Percentage-shaped stats render as whole
 * percents; counts render as integers. */
export function describeBoon(def: BoonDef, inst: Pick<BoonInstance, "rarity" | "rank" | "stacks">): string {
  if (!def.description.includes("{n}")) return def.description;
  const mult = boonMagnitude(inst);
  const stat = def.effects.find((e) => e.kind === "stat");
  if (stat && stat.kind === "stat") {
    const raw = stat.perStep * mult;
    const isCount = stat.key === "extraOfferCount" || stat.key === "rerollCharges" || stat.key === "lastStandCharges";
    return def.description.replace("{n}", isCount ? String(Math.round(raw)) : String(Math.round(raw * 100)));
  }
  const trigger = def.effects.find((e) => e.kind === "trigger");
  if (trigger && trigger.kind === "trigger") {
    return def.description.replace("{n}", String(Math.max(1, Math.round(trigger.stacks * mult))));
  }
  return def.description.replace("{n}", String(Math.round(mult * 100)));
}
