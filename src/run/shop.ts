// The trader's stall — the run's only place to convert acorns into build.
//
// Acorns are earned in every room and DELETED when the run ends. That is the
// Brotato contract, and it is what makes the shop interesting: there is no
// saving up across runs, so every acorn not spent is an acorn wasted, and the
// question is never "can I afford this" but "is this the best thing left to
// buy before the run takes my money back".
//
// The reroll cost escalates. A flat cost would make rerolling a chore you
// perform until you get what you want; an escalating one makes the third
// reroll a real decision and the fifth an obvious mistake. That curve is the
// entire design of the mechanic.

import { mulberry32 } from "../rng";
import { CHARM_DEFS, type CharmDef } from "./charms";
import type { BoonInstance } from "./boons";
import { drawOffer, type OfferCard, type OfferContext } from "./offers";

export type ShopEntryKind = "boon" | "charm" | "consumable";

export type ConsumableId = "salve" | "whetstone" | "ward" | "rerollToken";

export interface ConsumableDef {
  id: ConsumableId;
  name: string;
  blurb: string;
  cost: number;
}

export const CONSUMABLE_DEFS: ConsumableDef[] = [
  { id: "salve", name: "Pine Salve", blurb: "Heal the party for 40% of their health.", cost: 12 },
  { id: "whetstone", name: "Whetstone", blurb: "Add a rank to a boon you already hold.", cost: 20 },
  { id: "ward", name: "Warding Sprig", blurb: "Lift one curse immediately.", cost: 14 },
  { id: "rerollToken", name: "Crow's Feather", blurb: "One more reroll, for any offer.", cost: 8 },
];

export const CONSUMABLE_DEFS_BY_ID: Record<string, ConsumableDef> = Object.fromEntries(
  CONSUMABLE_DEFS.map((c) => [c.id, c]),
);

export interface ShopEntry {
  kind: ShopEntryKind;
  /** boon id, charm id or consumable id. */
  refId: string;
  /** Acorn price, already scaled for the Depth. */
  cost: number;
  /** For boon entries — carries rarity and any replacement, exactly as an
   * offer card does, so the shop and the offer screen can share a renderer. */
  card?: OfferCard;
  /** Set once bought, so a persisted stall shows what is already gone rather
   * than silently re-offering it. */
  sold?: boolean;
}

export interface ShopState {
  stock: ShopEntry[];
  rerollCount: number;
  seed: number;
}

/** Base reroll price, and the step it climbs by. 6 -> 9 -> 13 -> 18 -> 24:
 * cheap enough that the first reroll is nearly free, steep enough that the
 * fourth costs more than most of the stock. */
export const SHOP_REROLL_BASE = 6;

export function shopRerollCost(rerollCount: number): number {
  // Quadratic-ish by construction rather than by formula, so the early steps
  // stay gentle and the late ones bite.
  return Math.round(SHOP_REROLL_BASE * (1 + rerollCount * 0.5 + rerollCount * rerollCount * 0.15));
}

/** Prices climb with Depth because income does. Without this, a Depth III stall
 * would be trivially affordable and the shop would stop being a choice. */
export function depthPriceMult(depth: number): number {
  return 1 + 0.6 * (depth - 1);
}

const BOON_RARITY_COST: Record<string, number> = {
  common: 10,
  rare: 16,
  epic: 24,
  heroic: 34,
};

export function priceForCard(card: OfferCard, depth: number): number {
  const base = BOON_RARITY_COST[card.rarity] ?? 12;
  // A rank-up is cheaper than a fresh boon of the same rarity: it is worth less
  // in absolute terms, and pricing it the same would make deepening a build
  // strictly worse than widening it.
  return Math.round(base * (card.rankUp ? 0.7 : 1) * depthPriceMult(depth));
}

export function priceForCharm(charm: CharmDef, depth: number): number {
  return Math.round(charm.cost * depthPriceMult(depth));
}

export function priceForConsumable(def: ConsumableDef, depth: number): number {
  return Math.round(def.cost * depthPriceMult(depth));
}

/**
 * Rolls a stall: two boons, one charm, one consumable.
 *
 * The mix is fixed rather than random on purpose. A stall that might contain no
 * boons at all is a room the player resents walking into, and the shop appears
 * at most once per Depth — there is no second chance to make it up.
 */
export function rollShop(
  ctx: OfferContext,
  depth: number,
  seed: number,
  heldCharms: string[],
): ShopState {
  const rng = mulberry32(seed >>> 0);
  const stock: ShopEntry[] = [];

  const boonOffer = drawOffer(ctx, seed, 2);
  for (const card of boonOffer.cards.slice(0, 2)) {
    stock.push({ kind: "boon", refId: card.boonId, cost: priceForCard(card, depth), card });
  }

  const available = CHARM_DEFS.filter((c) => !heldCharms.includes(c.id));
  if (available.length > 0) {
    const charm = available[Math.floor(rng() * available.length)];
    stock.push({ kind: "charm", refId: charm.id, cost: priceForCharm(charm, depth) });
  }

  const consumable = CONSUMABLE_DEFS[Math.floor(rng() * CONSUMABLE_DEFS.length)];
  stock.push({ kind: "consumable", refId: consumable.id, cost: priceForConsumable(consumable, depth) });

  return { stock, rerollCount: 0, seed: seed >>> 0 };
}

/** Rerolls the stall. Derives its next seed from the current one so the whole
 * chain replays identically after an app restart — the same rule the offer
 * screen follows, and for the same reason: quitting must never be a way to
 * fish for better stock. */
export function rerollShop(
  shop: ShopState,
  ctx: OfferContext,
  depth: number,
  heldCharms: string[],
): ShopState {
  const nextSeed = (Math.imul(shop.seed ^ 0x27d4eb2d, 0xc2b2ae35) >>> 0) + shop.rerollCount + 1;
  const fresh = rollShop(ctx, depth, nextSeed >>> 0, heldCharms);
  return { ...fresh, rerollCount: shop.rerollCount + 1 };
}

/** Acorns a room should pay out, before the build's acornMult.
 *
 * Scaled by Depth so the Depth III stall stays reachable, and by whether the
 * room was a fight — a shop room paying acorns would be paying you to shop. */
export function roomAcorns(depth: number, kind: string, rng: () => number): number {
  if (kind === "shop" || kind === "fountain" || kind === "shrine") return 0;
  const base = kind === "boss" ? 26 : kind === "elite" ? 22 : 12;
  const spread = 0.85 + rng() * 0.3;
  return Math.max(1, Math.round(base * depthPriceMult(depth) * spread));
}

/** Whether a purchase is affordable AND legal — a charm already held, or a
 * sold-out slot, must not be buyable no matter how many acorns are in hand. */
export function canBuy(entry: ShopEntry, acorns: number, heldCharms: string[], held: BoonInstance[]): boolean {
  if (entry.sold) return false;
  if (acorns < entry.cost) return false;
  if (entry.kind === "charm" && heldCharms.includes(entry.refId)) return false;
  if (entry.kind === "boon" && entry.card?.rankUp && !held.some((h) => h.id === entry.refId)) return false;
  return true;
}
