// Charms and curses — the run's costs.
//
// Boons only ever make you stronger, which means a boon offer is a question
// about direction but never about price. Brotato's whole texture comes from the
// opposite: almost every item worth taking hurts you somewhere, so building is
// a series of small bets rather than a series of gifts. Charms are that.
//
// The rule, enforced by sim/sim.ts: **every charm carries at least one positive
// and one negative effect.** A charm with only upside is a boon wearing a
// different hat, and the moment one exists the whole category stops being read
// as a decision — players learn "charms are free" and stop looking at the
// downside on the ones that have one.
//
// Curses are the other half: a chaos gate offers a real drawback for a fixed
// number of rooms in exchange for something the run could not otherwise get.
// They expire on their own, which is what makes them a gamble about the near
// future rather than a permanent tax.
//
// Charms are priced in ACORNS, the run-local currency, never in wood. That is
// deliberate: the sim asserts that embarking and clearing the first room is
// net-positive wood at every party size, and a wood-priced charm would put
// that invariant at the mercy of the shop stock.

import type { RunStatKey } from "./stats";

export interface CharmEffect {
  key: RunStatKey;
  /** Signed. For multiplier stats this is the delta above 1. */
  delta: number;
}

export interface CharmDef {
  id: string;
  name: string;
  /** What it gives. At least one, always. */
  upside: CharmEffect[];
  /** What it costs you. At least one, always — see the header. */
  downside: CharmEffect[];
  /** Shown on the card. Written so the downside is as prominent as the upside;
   * a charm whose cost reads as fine print is a charm nobody weighs. */
  blurb: string;
  /** Acorn price at Depth I. Scaled by depth at the shop. */
  cost: number;
}

export const CHARM_DEFS: CharmDef[] = [
  {
    id: "heavyMaul",
    name: "Heavy Maul",
    upside: [{ key: "atkMult", delta: 0.4 }],
    downside: [{ key: "armorPct", delta: -0.15 }],
    blurb: "+40% attack. You take a good deal more damage — it takes both hands.",
    cost: 22,
  },
  {
    id: "glassLens",
    name: "Glass Lens",
    upside: [{ key: "critChance", delta: 0.3 }],
    downside: [{ key: "armorPct", delta: -0.2 }],
    blurb: "+30% critical chance. Everything that reaches you hits harder.",
    cost: 24,
  },
  {
    id: "leadBoots",
    name: "Lead Boots",
    upside: [{ key: "guardBonus", delta: 0.3 }],
    downside: [{ key: "atkMult", delta: -0.2 }],
    blurb: "Defending blocks far more. You swing 20% slower for it.",
    cost: 18,
  },
  {
    id: "bloodletter",
    name: "Bloodletter",
    upside: [{ key: "lifestealPct", delta: 0.25 }],
    downside: [{ key: "regenPerRoundPct", delta: -0.03 }],
    blurb: "A quarter of your damage returns as health — but the wound never closes on its own.",
    cost: 26,
  },
  {
    id: "gamblersCoin",
    name: "Gambler's Coin",
    upside: [{ key: "acornMult", delta: 1 }],
    downside: [{ key: "extraOfferCount", delta: -1 }],
    blurb: "Double acorns from everything. Every offer shows one card fewer.",
    cost: 20,
  },
  {
    id: "crackedHourglass",
    name: "Cracked Hourglass",
    upside: [{ key: "dodgePct", delta: 0.2 }],
    downside: [{ key: "atkMult", delta: -0.15 }],
    blurb: "A fifth of attacks pass straight through you. Your own blows land slower.",
    cost: 25,
  },
  {
    id: "tinderbox",
    name: "Tinderbox",
    upside: [{ key: "executePct", delta: 0.2 }],
    downside: [{ key: "reflectPct", delta: -0.1 }],
    blurb: "Anything badly hurt simply goes out. Nothing is thrown back any more.",
    cost: 28,
  },
  {
    id: "beggarsBowl",
    name: "Beggar's Bowl",
    upside: [{ key: "rerollCharges", delta: 2 }],
    downside: [{ key: "acornMult", delta: -0.35 }],
    blurb: "Two more rerolls in your pocket, at a lasting cost to what you collect.",
    cost: 16,
  },
  {
    id: "cursedSapling",
    name: "Cursed Sapling",
    upside: [{ key: "rarityLuck", delta: 0.35 }],
    downside: [{ key: "lastStandCharges", delta: -1 }],
    blurb: "Offers come up far richer. Nothing will catch you when you fall.",
    cost: 30,
  },
  {
    id: "ironLocket",
    name: "Iron Locket",
    upside: [{ key: "armorPct", delta: 0.2 }],
    downside: [{ key: "critChance", delta: -0.1 }],
    blurb: "Take a fifth less from everything. You will not find the openings any more.",
    cost: 21,
  },
];

export const CHARM_DEFS_BY_ID: Record<string, CharmDef> = Object.fromEntries(CHARM_DEFS.map((c) => [c.id, c]));

// ---------------------------------------------------------------------------
// Curses
// ---------------------------------------------------------------------------

export interface CurseDef {
  id: string;
  name: string;
  /** Strictly negative — a curse with an upside is a boon. */
  effects: CharmEffect[];
  /** Rooms it lasts. Finite, always: a curse is a gamble about the near
   * future, and one that never lifted would just be a worse run. */
  rooms: number;
  blurb: string;
  /** What the gate pays out for accepting it. Resolved by Game, since some
   * rewards (a free rank, an extra reroll) are run concerns rather than stat
   * ones. */
  reward: "rank2" | "epicBoon" | "duoOffer" | "rerolls" | "charm";
  rewardBlurb: string;
}

export const CURSE_DEFS: CurseDef[] = [
  {
    id: "fog",
    name: "Fog",
    effects: [{ key: "critChance", delta: -0.1 }],
    rooms: 3,
    blurb: "You cannot see the openings. -10% critical chance for three rooms.",
    reward: "rank2",
    rewardBlurb: "Two ranks, on a boon of your choosing.",
  },
  {
    id: "numb",
    name: "Numb",
    effects: [{ key: "guardBonus", delta: -0.5 }],
    rooms: 2,
    blurb: "Your guard barely holds. Defending does almost nothing for two rooms.",
    reward: "epicBoon",
    rewardBlurb: "An Epic boon from the patron of your choice.",
  },
  {
    id: "frailty",
    name: "Frailty",
    effects: [{ key: "armorPct", delta: -0.3 }],
    rooms: 3,
    blurb: "Everything cuts deeper. You take far more damage for three rooms.",
    reward: "duoOffer",
    rewardBlurb: "A duo boon, offered right now.",
  },
  {
    id: "silence",
    name: "Silence",
    effects: [{ key: "atkMult", delta: -0.15 }],
    rooms: 4,
    blurb: "The patrons have stopped listening. -15% attack for four rooms.",
    reward: "rerolls",
    rewardBlurb: "Two permanent reroll charges.",
  },
  {
    id: "toll",
    name: "Toll",
    effects: [{ key: "acornMult", delta: -0.5 }],
    rooms: 3,
    blurb: "Something takes its share. Half acorns for three rooms.",
    reward: "charm",
    rewardBlurb: "A charm of your choosing, free.",
  },
];

export const CURSE_DEFS_BY_ID: Record<string, CurseDef> = Object.fromEntries(CURSE_DEFS.map((c) => [c.id, c]));

export interface RunCurse {
  id: string;
  /** Counts down as rooms are cleared; removed at 0. */
  roomsLeft: number;
}
