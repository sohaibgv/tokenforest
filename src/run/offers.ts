// Drawing the cards.
//
// This is the screen the run is actually about, so two properties matter more
// than anything else here:
//
// A. AN OFFER IS NEVER EMPTY. The run gate refuses to advance while an offer is
//    pending, so a draw that returned nothing would be a soft-lock with no
//    in-game way out — the worst class of bug this system can have, and one
//    that only shows up in the states hardest to reach (every slot full, deep
//    into a run, hours in). Exclusive slots make it genuinely reachable: with
//    Strike, Guard and Rite taken and four Auras held, most of the catalog is
//    ineligible. `guaranteedPool` is the floor, and sim/sim.ts fuzzes for it.
//
// B. AN OFFER IS DRAWN ONCE AND PERSISTED. Never re-rolled on resume. A player
//    who closes the app mid-decision and comes back must see the same three
//    cards, not a fresh draw — otherwise the decision they were weighing simply
//    evaporates, and worse, quitting becomes a way to fish for better cards.
//    This is the rule the previous boon offer already followed; it is preserved
//    verbatim.
//
// Rarity is rolled per card, so one offer can hold a Common, a Rare and a
// Heroic. That is most of the tension: the Heroic you cannot use in the slot
// you want versus the Common you can.

import { mulberry32 } from "../rng";
import { isUnlocked } from "../unlocks";
import {
  BOON_DEFS,
  BOON_DEFS_BY_ID,
  boonReplaces,
  slotCapacity,
  type BoonDef,
  type BoonInstance,
  type BoonRarity,
} from "./boons";
import { favorRarityLuck, type PatronId } from "./patrons";

/** Base rarity weights before any luck is applied. Heavily front-loaded: a
 * Heroic has to stay rare enough that seeing one is an event, or the whole
 * rarity ladder flattens into decoration. */
const RARITY_WEIGHTS: Record<BoonRarity, number> = {
  common: 60,
  rare: 28,
  epic: 10,
  heroic: 2,
};

const RARITY_ORDER: BoonRarity[] = ["common", "rare", "epic", "heroic"];

export interface OfferCard {
  boonId: string;
  rarity: BoonRarity;
  /** Set when this card would deepen a boon already held rather than grant a
   * new one — the shrine and rank-reward path. */
  rankUp?: boolean;
  /** The boon this pick would displace from an exclusive slot, if any. Carried
   * on the card so the UI can say so up front: an exclusive pick that silently
   * discarded the previous boon would be the single most frustrating moment in
   * a run. */
  replacesId?: string;
}

export interface RunOffer {
  cards: OfferCard[];
  rerollsLeft: number;
  /** The seed this offer was drawn from. Persisted so a reroll is itself
   * reproducible, which is what lets the sim replay a whole run's offer
   * sequence exactly. */
  seed: number;
  /** How many times this offer has already been rerolled — drives the
   * escalating cost. */
  rerollCount: number;
}

export interface OfferContext {
  held: BoonInstance[];
  prestigeLevel: number;
  /** Per-patron favour, earned across runs. Nudges rarity odds upward for the
   * patrons the player has committed to before. */
  favor?: Partial<Record<PatronId, number>>;
  /** From the build: Fortune's Eye and friends. */
  rarityLuck?: number;
  /** From the build: Overclock, The Long Day, and the Gambler's Coin penalty. */
  extraCards?: number;
  /** A keepsake chosen at Muster guarantees the first card of the run's first
   * offers comes from this patron — the pre-run lever that makes a build
   * intentional from room one instead of from wherever the draws allow. */
  keepsake?: PatronId | null;
  /** Restricts the draw to one patron (the Numb curse's payout). */
  onlyPatron?: PatronId | null;
  /** Draw only duo boons (the Frailty curse's payout). */
  duoOnly?: boolean;
}

function heldById(held: BoonInstance[]): Map<string, BoonInstance> {
  return new Map(held.map((h) => [h.id, h]));
}

/** How many of `patron`'s boons are held at rank 2 or better — the gate every
 * legendary sits behind. */
function committedTo(held: BoonInstance[], patron: PatronId): number {
  return held.filter((h) => BOON_DEFS_BY_ID[h.id]?.patron === patron && h.rank >= 2).length;
}

/** Whether a boon may legally be offered right now.
 *
 * Note what is NOT checked here: whether the slot is full. A full exclusive
 * slot makes a boon a REPLACEMENT, not an illegal pick — offering it with a
 * clear "replaces X" label is the whole texture of the slot system. Only Aura
 * and Fortune have hard caps, because they stack. */
export function isOfferable(def: BoonDef, ctx: OfferContext): boolean {
  const held = heldById(ctx.held);
  if (!isUnlocked("boon", def.id, ctx.prestigeLevel)) return false;

  // Already held at max rank, with no rarity left to climb — offering it again
  // would be a card that does nothing.
  const have = held.get(def.id);
  if (have && have.rank >= def.maxRank && have.rarity === "heroic") return false;

  if (def.conflicts?.some((id) => held.has(id))) return false;
  if (def.requiresBoons?.some((id) => !held.has(id))) return false;

  // Duos need a real foothold in BOTH patrons — that is what makes them read as
  // a discovery rather than as another card.
  if (def.duoPatrons) {
    const [a, b] = def.duoPatrons;
    const hasA = ctx.held.some((h) => BOON_DEFS_BY_ID[h.id]?.patron === a);
    const hasB = ctx.held.some((h) => BOON_DEFS_BY_ID[h.id]?.patron === b);
    if (!hasA || !hasB) return false;
  }

  if (def.requiresPatronBoons && committedTo(ctx.held, def.patron) < def.requiresPatronBoons) return false;

  // Stacking slots are the only ones that can genuinely fill up.
  const cap = slotCapacity(def.slot);
  if (cap > 1 && !have) {
    const used = ctx.held.filter((h) => BOON_DEFS_BY_ID[h.id]?.slot === def.slot).length;
    if (used >= cap) return false;
  }

  if (ctx.onlyPatron && def.patron !== ctx.onlyPatron) return false;
  if (ctx.duoOnly && !def.duoPatrons) return false;

  return true;
}

/**
 * The always-available floor (property A in the header).
 *
 * Deliberately the boons with no prerequisites, no conflicts and a stacking
 * slot — the ones that can essentially always be offered. If this is ever
 * empty for a reachable state, the run can soft-lock, so sim/sim.ts fuzzes
 * held-boon sets against it rather than trusting the reasoning here.
 */
export function guaranteedPool(ctx: OfferContext): BoonDef[] {
  return BOON_DEFS.filter(
    (d) => !d.duoPatrons && !d.requiresPatronBoons && !d.requiresBoons && d.slot !== "instant" && isOfferable(d, ctx),
  );
}

/** Rolls a rarity, biased upward by luck. Luck shifts weight from the bottom of
 * the ladder to the top rather than adding a flat bonus, so it can never
 * produce a rarity the boon does not support. */
function rollRarity(allowed: BoonRarity[], luck: number, rng: () => number): BoonRarity {
  const pool = allowed.length > 0 ? allowed : RARITY_ORDER;
  const weights = pool.map((r) => {
    const base = RARITY_WEIGHTS[r];
    const tier = RARITY_ORDER.indexOf(r);
    // Luck multiplies the upper tiers and divides the lowest one. At luck 0
    // this is exactly the base table.
    const shift = 1 + luck * tier;
    return Math.max(0.001, base * shift);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** Patrons are equal-weighted on purpose.
 *
 * The obvious "improvement" is to weight toward the patrons the player already
 * holds boons from, so builds converge. That is exactly wrong: it turns the
 * first two lucky draws into the whole run and quietly removes the decision the
 * door system exists to create. Commitment should come from the player choosing
 * it, not from the pool agreeing with them. The keepsake — chosen deliberately,
 * before the run — is the one sanctioned thumb on the scale, and it is applied
 * by the caller rather than here. */
function pickDef(defs: BoonDef[], rng: () => number): BoonDef {
  return defs[Math.floor(rng() * defs.length)];
}

/**
 * Draws an offer.
 *
 * `count` is the base card count (3), adjusted by the build. The floor of 1 is
 * property A: a card count driven to zero by stacked Gambler's Coins would
 * otherwise soft-lock the run.
 */
export function drawOffer(ctx: OfferContext, seed: number, count = 3): RunOffer {
  const rng = mulberry32(seed >>> 0);
  const cards: OfferCard[] = [];
  const wanted = Math.max(1, count + (ctx.extraCards ?? 0));

  let pool = BOON_DEFS.filter((d) => isOfferable(d, ctx));
  if (pool.length === 0) pool = guaranteedPool(ctx);
  // Even the guaranteed pool can be empty in a fully-maxed run. Falling back to
  // rank-ups on what is already held means there is ALWAYS something to offer,
  // because a run cannot reach this point without holding something.
  const rankUpFallback = pool.length === 0;

  const taken = new Set<string>();
  for (let i = 0; i < wanted; i++) {
    if (rankUpFallback) {
      const candidates = ctx.held.filter((h) => !taken.has(h.id) && h.rank < (BOON_DEFS_BY_ID[h.id]?.maxRank ?? 1));
      const inst = candidates[0] ?? ctx.held[0];
      if (!inst) break;
      taken.add(inst.id);
      cards.push({ boonId: inst.id, rarity: inst.rarity, rankUp: true });
      continue;
    }

    let candidates = pool.filter((d) => !taken.has(d.id));
    if (candidates.length === 0) break;

    // The keepsake's promise: the first card of an offer comes from the chosen
    // patron whenever that patron has anything legal to give.
    if (i === 0 && ctx.keepsake) {
      const preferred = candidates.filter((d) => d.patron === ctx.keepsake);
      if (preferred.length > 0) candidates = preferred;
    }

    const def = pickDef(candidates, rng);
    taken.add(def.id);

    const patronFavor = ctx.favor?.[def.patron] ?? 0;
    const luck = (ctx.rarityLuck ?? 0) + favorRarityLuck(patronFavor);
    const have = ctx.held.find((h) => h.id === def.id);
    let rarity = rollRarity(def.rarities, luck, rng);
    // A card for something already held must be an improvement, or it is a
    // card that does nothing. Roll upward past the held rarity, or fall back to
    // deepening it instead.
    let rankUp = false;
    if (have) {
      const heldTier = RARITY_ORDER.indexOf(have.rarity);
      const rolledTier = RARITY_ORDER.indexOf(rarity);
      if (rolledTier <= heldTier) {
        if (have.rank < (BOON_DEFS_BY_ID[def.id]?.maxRank ?? 1)) {
          rankUp = true;
          rarity = have.rarity;
        } else {
          const better = def.rarities.filter((r) => RARITY_ORDER.indexOf(r) > heldTier);
          if (better.length === 0) continue;
          rarity = better[0];
        }
      }
    }

    const replaced = boonReplaces(ctx.held, def);
    cards.push({
      boonId: def.id,
      rarity,
      ...(rankUp ? { rankUp: true } : {}),
      ...(replaced ? { replacesId: replaced.id } : {}),
    });
  }

  return { cards, rerollsLeft: 0, seed: seed >>> 0, rerollCount: 0 };
}

/** Rerolls an offer into a fresh draw.
 *
 * The new seed is derived from the old one rather than taken from a live rng,
 * so the whole reroll chain stays reproducible from the run's single seed —
 * which is what lets a resumed run show the same cards it was showing, even
 * mid-reroll. */
export function rerollOffer(offer: RunOffer, ctx: OfferContext, count = 3): RunOffer {
  const nextSeed = (Math.imul(offer.seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0) + offer.rerollCount + 1;
  const fresh = drawOffer(ctx, nextSeed >>> 0, count);
  return {
    ...fresh,
    rerollsLeft: Math.max(0, offer.rerollsLeft - 1),
    rerollCount: offer.rerollCount + 1,
  };
}

/**
 * Applies a picked card to the held set, returning the new set.
 *
 * Pure: the caller persists the result. Three distinct outcomes, and the
 * distinction is the slot system working —
 *   - a rank-up deepens what is held;
 *   - a re-offer at higher rarity upgrades in place, KEEPING the rank already
 *     earned (losing accumulated ranks to an upgrade would make Heroics a
 *     punishment for anyone who had invested);
 *   - an exclusive-slot pick displaces whatever was there.
 */
export function applyOfferCard(held: BoonInstance[], card: OfferCard, room: number): BoonInstance[] {
  const def = BOON_DEFS_BY_ID[card.boonId];
  if (!def) return held;
  const next = held.filter((h) => h.id !== card.replacesId);
  const existing = next.find((h) => h.id === card.boonId);

  // Slot caps are enforced HERE, at the single mutation point, not only at
  // draw time.
  //
  // `isOfferable` checks the cap when a card is drawn, which is enough for an
  // offer — one card is taken and the screen closes. A shop stall is different:
  // its stock is rolled once and then bought item by item, so two Aura cards
  // drawn against three held Auras are both legal at draw time and together
  // put the build one over its budget. Caught by the sim's slot-cap assertion
  // once the harness started actually shopping.
  const cap = slotCapacity(def.slot);
  // An instant boon is never HELD — it resolves once and is done. Its capacity
  // is 0, which fell through both branches below and quietly added it to the
  // build as a permanent do-nothing entry. The offer screen routes instants
  // away before reaching here; a shop purchase did not, which is how a stall
  // could push a build one slot over its budget.
  if (cap === 0) return next;
  if (cap === 1) {
    // An exclusive slot holds one boon, full stop — enforced against the CURRENT
    // held set rather than by trusting `card.replacesId`. That field is computed
    // when the card is drawn, and a stall's stock is drawn once but bought item
    // by item: buy two Strike cards from one stall and the second names a boon
    // the first already removed, leaving the build with two Strikes.
    for (let i = next.length - 1; i >= 0; i--) {
      if (next[i].id !== card.boonId && BOON_DEFS_BY_ID[next[i].id]?.slot === def.slot) next.splice(i, 1);
    }
  } else if (cap > 1 && !existing) {
    const used = next.filter((h) => BOON_DEFS_BY_ID[h.id]?.slot === def.slot).length;
    if (used >= cap) return next;
  }

  if (existing) {
    if (card.rankUp) {
      existing.rank = Math.min(def.maxRank, existing.rank + 1);
    } else {
      existing.rarity = card.rarity;
    }
    return next;
  }
  next.push({ id: card.boonId, rarity: card.rarity, rank: 1, room });
  return next;
}
