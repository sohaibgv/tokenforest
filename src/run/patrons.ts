// The five patrons — the forest powers that grant boons during a run.
//
// A patron is a PROMISE, not a theme. Its whole job is to be learnable: after
// two or three runs the player should be able to see a sigil over a doorway
// and know roughly what is behind it without reading a word. That only works
// if each patron owns exactly one signature status and never borrows another's
// — the moment Cinder starts handing out shields, the sigil stops meaning
// anything and every door becomes a coin flip again.
//
// So the constraint enforced here and in boons.ts is: a patron's boons may
// apply its OWN signature status and no other patron's. Duo boons are the
// single exception, and that is precisely what makes them feel like a secret —
// they are the only place two signatures ever meet.
//
// Accents follow the same palette-overlay mechanism as enemy characters and
// worker rarities (see adventure.ts's ENEMY_CHARACTERS and economy.ts's
// WorkerDef.accent): a small letter->colour map composed at draw time, rather
// than a bespoke sprite per patron.

import type { StatusId } from "../statuses";

export type PatronId = "bramble" | "cinder" | "sap" | "static" | "lumen";

export interface PatronDef {
  id: PatronId;
  name: string;
  /** The role, in the player's words — shown under the name on an offer card. */
  domain: string;
  /** One line of character, for the codex and the door plaque. */
  blurb: string;
  /** The status this patron traffics in, and the only one its boons may apply.
   * null for a patron that deals in economy rather than combat. */
  signature: StatusId | null;
  /** Palette overlay, composed the same way worker and enemy accents are. */
  accent: Record<string, string>;
  /** Base draw weight before keepsake and favour weighting. Equal by default:
   * an unweighted pool is the honest starting point, and the interesting
   * skew should come from the player's own choices, not from a thumb on the
   * scale they never see. */
  weight: number;
}

export const PATRON_DEFS: PatronDef[] = [
  {
    id: "bramble",
    name: "Bramble",
    domain: "Thorns and retaliation",
    blurb: "The hedge that grew back angrier. Rewards being hit.",
    signature: "bleed",
    accent: { U: "#5a7a3a" },
    weight: 1,
  },
  {
    id: "cinder",
    name: "Cinder",
    domain: "Fire and critical strikes",
    blurb: "Every fire starts small. Rewards stacking fuel and lighting it.",
    signature: "burn",
    accent: { U: "#c2542a" },
    weight: 1,
  },
  {
    id: "sap",
    name: "Sap",
    domain: "Bark, roots and endurance",
    blurb: "The old growth does not hurry and does not die.",
    signature: "bark",
    accent: { U: "#3a6a5a" },
    weight: 1,
  },
  {
    id: "static",
    name: "Static",
    domain: "Interference and control",
    blurb: "Something in the machine learned the forest's name.",
    signature: "weak",
    accent: { U: "#5a5a8a" },
    weight: 1,
  },
  {
    id: "lumen",
    name: "Lumen",
    domain: "Luck and plenty",
    blurb: "First light through the canopy. Rewards greed.",
    signature: null,
    accent: { U: "#c9a23a" },
    weight: 1,
  },
];

export const PATRON_DEFS_BY_ID: Record<PatronId, PatronDef> = Object.fromEntries(
  PATRON_DEFS.map((p) => [p.id, p]),
) as Record<PatronId, PatronDef>;

/** Favour levels, earned across runs by picking a patron's boons and clearing
 * Depths with them. Higher favour improves that patron's rarity odds and opens
 * the later entries in its pool — the between-runs reason to commit to one
 * patron rather than taking whatever is in front of you. */
export const MAX_PATRON_FAVOR = 5;

/** Rarity-luck bonus granted by favour, per level. Small on purpose: favour
 * should feel like a nudge that accumulates, not like the early runs were
 * played with a handicap. */
export const FAVOR_RARITY_LUCK = 0.04;

export function favorRarityLuck(favor: number): number {
  return FAVOR_RARITY_LUCK * Math.min(MAX_PATRON_FAVOR, Math.max(0, favor));
}
