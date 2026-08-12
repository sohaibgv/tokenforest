// Hand-authored pixel art for every DOM icon that used to be an emoji
// (nav tabs, equip-slot glyphs, boons, chest reveal, close/exit buttons,
// strip icons, power-ups). Same string-grid `PixelMap` format as sprites.ts
// (one char per pixel, "." = transparent), rendered through the same
// drawSprite/withPalette primitives via ../ui/pixel-icon.ts.
//
// Self-contained palette: these icons carry their OWN letter->color table
// (UI_PALETTE below) rather than reaching into sprites.ts's private
// PALETTE, so a shared letter (e.g. "K") never accidentally inherits an
// unrelated scene meaning. Call sites pass UI_PALETTE explicitly to
// pixelIcon()/pixelIconUrl() (the one exception is BOON_SPARK_ICON, which
// reuses the existing SPARK sprite verbatim, colors included — see below).
//
// Colors are chosen for contrast against the warm cream/parchment panels
// from Part A's palette shift (--bg-panel #eddfc0 / --bg-base #f7f0e0), not
// the old dark theme.

import { SPARK, type PixelMap } from "./sprites";
import type { BoostSpec, HelperId, PowerupId, ProvisionId, WorkerClass } from "../economy";

export const UI_PALETTE: Record<string, string> = {
  K: "#2a1e12", // ink outline (matches --text-bright)
  W: "#fdf6e8", // parchment highlight / sclera white
  E: "#e8b48c", // skin
  P: "#4a76ab", // body blue (team torso)
  p: "#345680", // body blue shade
  A: "#c4c8d0", // steel (blade/gear)
  a: "#8b9099", // steel shade
  w: "#8c603a", // wood (handles, chest body, signpost, boots)
  T: "#6e4c30", // dark wood / ore stone
  b: "#3f2c1a", // darkest wood shade (boot sole)
  G: "#4a9e5c", // leaf / accent green
  g: "#86d194", // light green
  R: "#c9403a", // red (cap, heart, fist)
  r: "#8f2c26", // red shade
  N: "#2f8f7d", // teal (flask liquid, blade inlay)
  n: "#7fd9c8", // teal light
  Y: "#c98f1c", // gold / brass rim
  y: "#f2cf6b", // gold light / glow core
  M: "#caa06a", // tan leather / charm frame
  m: "#8a6a3e", // tan shade
  L: "#5aa0e0", // sky blue (eye iris, palette dab)
  Q: "#e05a8a", // pink (palette dab)
  C: "#f3e6c8", // pale cream fill (mirror glass)
  t: "#8a6440", // wood light / log rings (amberWood icon, matches sprites.ts LOG)
};

// --- Nav / tab icons (~8x8) -------------------------------------------------

export const TEAM_ICON: PixelMap = [
  "..KKKK..",
  ".KEEEEK.",
  ".KEEEEK.",
  "..KEEK..",
  ".KPPPPK.",
  "KPPpPpPK",
  "KPPPPPPK",
  "KKKKKKKK",
];

export const GACHA_ICON: PixelMap = [
  "..YYYY..",
  ".YyyyyY.",
  "YyyyyyyY",
  "YyyyyyyY",
  "KKKKKKKK",
  "NnnnnnnN",
  "NnnnnnnN",
  ".NnnnnN.",
];

export const GNOMES_ICON: PixelMap = [
  "...RR...",
  "..RrrR..",
  ".RrrrrR.",
  "RrrrrrrR",
  "RrrrrrrR",
  "RrrrrrrR",
  "KKKKKKKK",
  ".MMMMMM.",
];

export const BOOSTS_ICON: PixelMap = [
  "...YY...",
  "..Yy....",
  ".Yy.....",
  "YyyyyyY.",
  "....Yy..",
  "...Yy...",
  "..Yy....",
  ".Yy.....",
];

export const PROVISIONS_ICON: PixelMap = [
  "..KK....",
  "..KK....",
  ".KyyK...",
  "KNnnnNK.",
  "KNnnnNK.",
  "KNnnnNK.",
  ".KNNNNK.",
  "..KKKK..",
];

export const STYLE_ICON: PixelMap = [
  ".MMMMM..",
  "MMMMMMM.",
  "MLMMMQM.",
  "MMMMMMM.",
  "MMMKMMM.",
  ".MMMMM..",
  "...M....",
];

// --- Equip-slot icons (~8x8) -------------------------------------------------
// Woodchopping/Adventuring reuse the same silhouette language as the
// baked-in field axe (WC_CHOP_*'s A head / w handle) — the vocabulary Part D
// later extends into full held-weapon art.

export const SLOT_WOODCHOPPING_ICON: PixelMap = [
  "...AA...",
  "..AAAA..",
  ".AAAAAw.",
  "AAAAAw..",
  "....w...",
  "...w....",
  "..w.....",
  ".w......",
];

export const SLOT_ADVENTURING_ICON: PixelMap = [
  "...AA...",
  "...AA...",
  "...AA...",
  "...AA...",
  "..YYYY..",
  "...ww...",
  "...ww...",
  "....Y...",
];

// Deliberately a symmetric diamond charm-on-a-chain — distinct silhouette
// from AMBER_GEM (sprites.ts), which is a small asymmetric currency gem.
export const SLOT_UTILITY_ICON: PixelMap = [
  "...K....",
  "..K.K...",
  ".M...M..",
  "M..N..M.",
  "M.NnN.M.",
  ".M.N.M..",
  "..M.M...",
  "...M....",
];

// --- Boon icons (~9x9) -------------------------------------------------------

export const BOON_FIST_ICON: PixelMap = [
  "..KKKKK..",
  ".KRRRRRK.",
  "KRrRrRrRK",
  "KRRRRRRRK",
  "KRRRRRRRK",
  "KRRRRRRRK",
  ".KRRRRRK.",
  "..KEEEK..",
  "...KKK...",
];

export const BOON_SHIELD_ICON: PixelMap = [
  ".KKKKKKK.",
  "KAAAAAAAK",
  "KAyAAAyAK",
  "KAAyyyAAK",
  "KAAAyAAAK",
  ".KAAyAAK.",
  "..KAyAK..",
  "...KyK...",
  "....K....",
];

export const BOON_HEART_ICON: PixelMap = [
  ".KK.KK.",
  "KRRKRRK",
  "KRRRRRK",
  "KRRRRRK",
  ".KRRRK.",
  "..KRK..",
  "...K...",
];

export const BOON_EYE_ICON: PixelMap = [
  ".KKKKKKK.",
  "KWWWWWWWK",
  "KWWWLWWWK",
  "KWWWWWWWK",
  ".KKKKKKK.",
];

export const BOON_MIRROR_ICON: PixelMap = [
  "..KKKKK..",
  ".KCCCCCK.",
  "KCCCyCCCK",
  "KCCCCCCCK",
  ".KCCCCCK.",
  "..KKKKK..",
  "....M....",
  "....M....",
  "...MmM...",
];

// --- Worker class icons (~9x9, matches the boon icons above) --------------
//
// Team panel's class tag (ui/team.ts) and Battle's party-row marker
// (ui/battle.ts) both switched from a bare text letter to these — real
// pixel-art identity for Bruiser/Warden/Scout instead of a "B"/"W"/"S"
// glyph. Bruiser/Warden deliberately REUSE BOON_FIST_ICON/BOON_SHIELD_ICON
// above rather than drawing new assets: a fist for "hits harder" (crit
// ×2) and a shield for "blocks more" (Defend -25%) are exactly the same
// visual metaphor Battle Fury/Iron Skin already established, and reusing
// them keeps one fist-glyph and one shield-glyph meaning the same thing
// everywhere in the game rather than two near-identical hand-drawn twins.
// Scout (first-strike/speed) has no existing equivalent, so it gets a new
// asset: a solid right-pointing arrowhead.
export const SCOUT_ARROW_ICON: PixelMap = [
  ".........",
  "..NNN....",
  "..NNNN...",
  "..NNNNN..",
  "..NNNNNN.",
  "..NNNNN..",
  "..NNNN...",
  "..NNN....",
  ".........",
];

export const CLASS_ICON: Record<WorkerClass, PixelMap> = {
  bruiser: BOON_FIST_ICON,
  warden: BOON_SHIELD_ICON,
  scout: SCOUT_ARROW_ICON,
};

// --- Battle action bubbles (~9x9) -----------------------------------------
//
// Floating action icons (ui/battle.ts) that pop up around the current
// actor's sprite instead of a bottom Attack/Defend/Ability/Retreat button
// row. Defend/Ability reuse BOON_SHIELD_ICON/SPARK verbatim (same "blocks
// more"/"instant power" metaphor established elsewhere already) rather than
// drawing near-duplicate twins; Attack and Retreat get new assets since
// nothing existing fits a sword swing or a "flee" boot print.
export const SWORD_ICON: PixelMap = [
  ".....KAa",
  "....KAa.",
  "...KAa..",
  "..KAa...",
  ".KAa....",
  "KwwK....",
  "wKw.....",
  "Kw......",
  ".K......",
];

export const BOOT_ICON: PixelMap = [
  ".........",
  "..www....",
  "..wPw....",
  "..wPw....",
  "..wPw....",
  "..wPwww..",
  ".KbbbbbK.",
  ".Kbbbbb..",
  "..KKKKK..",
];

/** One icon per floating action bubble, in the fixed Attack/Defend/
 * Ability/Retreat order the UI always shows them in (matches the 1/2/3/4
 * hotkeys). */
export const ACTION_BUBBLE_ICON: Record<"attack" | "defend" | "ability" | "retreat", PixelMap> = {
  attack: SWORD_ICON,
  defend: BOON_SHIELD_ICON,
  ability: SPARK,
  retreat: BOOT_ICON,
};

// --- Chest icon (hero scale, ~15x11) ----------------------------------------

export const CHEST_ICON: PixelMap = [
  ".KKKKKKKKKKKKK.",
  "KTTTTTTTTTTTTTK",
  "KTYYYYYYYYYYYTK",
  "KTTTTTTTTTTTTTK",
  "KKKKKKKKKKKKKKK",
  "KwwwwwYYYwwwwwK",
  "KwwwwwYyYwwwwwK",
  "KwwwwwYYYwwwwwK",
  "KwwwwwwwwwwwwwK",
  "KwwwwwwwwwwwwwK",
  ".KKKKKKKKKKKKK.",
];

// --- Close/exit icon (~7x7) --------------------------------------------------
// Single color ("K") so it can be tinted per context via the palette arg.

export const CLOSE_ICON: PixelMap = [
  "K.....K",
  ".K...K.",
  "..K.K..",
  "...K...",
  "..K.K..",
  ".K...K.",
  "K.....K",
];

// --- Strip icons -------------------------------------------------------------

export const COMPASS_ICON: PixelMap = [
  "..KKK..",
  ".K...K.",
  "K.RRR.K",
  "K.RyR.K",
  "K.NNN.K",
  ".K...K.",
  "..KKK..",
];

export const GEAR_ICON: PixelMap = [
  "..K.K.K..",
  ".KAAAAAK.",
  "K.AAAAA.K",
  "KAAAaaAAK",
  "KAAaKaAAK",
  "KAAAaaAAK",
  "K.AAAAA.K",
  ".KAAAAAK.",
  "..K.K.K..",
];

// --- Power-up icons (~8x8 each) ---------------------------------------------
// One themed glyph per power-up — see economy.ts's POWERUPS for the source
// data these were designed against.

export const SWIFT_BOOTS_ICON: PixelMap = [
  "..www...",
  "..www...",
  "..www...",
  "..wTw...",
  "..wTw...",
  "KKwTwKK.",
  "KbbbbbK.",
  ".KKKKK..",
];

export const KEEN_EDGE_ICON: PixelMap = [
  ".....AA.",
  "....AAa.",
  "...AAa..",
  "..AAa...",
  ".AAa....",
  "AAa.....",
  "Yw......",
  "w.......",
];

export const AMBER_VEIN_ICON: PixelMap = [
  "..TTTT..",
  ".TTyTTT.",
  "TTyYyTTT",
  "TyYyYyTT",
  "TTyYyTTT",
  ".TTyTTT.",
  "..TTTT..",
  "........",
];

export const LUCKY_CHARM_ICON: PixelMap = [
  "..G..G..",
  ".GgGGgG.",
  "GgGKKGgG",
  ".GgGGgG.",
  "..G..G..",
  "...T....",
  "...T....",
  "........",
];

export const EXTRA_UTILITY_ICON: PixelMap = [
  ".MMMMM..",
  "MmmmmmM.",
  "MmmmmmM.",
  "MmmmmmM.",
  ".MMMMM..",
  "....G...",
  "...GGG..",
  "....G...",
];

export const TRAVEL_DISCOUNT_ICON: PixelMap = [
  "...w....",
  "..wYYw..",
  ".wYyYYw.",
  "..wYYw..",
  "...w....",
  "...w....",
  "...w....",
  "..wwwww.",
];

export const GOLDEN_SENSE_ICON: PixelMap = [
  "...y....",
  "...y....",
  "..yYy...",
  "yyYYYyy.",
  "..yYy...",
  "...y....",
  "........",
  "........",
];

export const FOREST_BLESSING_ICON: PixelMap = [
  "...G....",
  "..GgG...",
  ".GggGG..",
  "GgggggG.",
  ".GggGG..",
  "..GgG...",
  "...T....",
  "...T....",
];

/** Pack Mule (prestige-unlocked): a leather saddlebag — tan leather body,
 * wood-brown straps, gold buckle. */
export const PACK_MULE_ICON: PixelMap = [
  "..wwww..",
  ".wMMMMw.",
  ".MMmMMm.",
  ".MMmMMm.",
  ".MMYMMm.",
  ".MMmMMm.",
  ".mmmmmm.",
  "........",
];

export const POWERUP_ICON: Record<PowerupId, PixelMap> = {
  swiftBoots: SWIFT_BOOTS_ICON,
  keenEdge: KEEN_EDGE_ICON,
  amberVein: AMBER_VEIN_ICON,
  luckyCharm: LUCKY_CHARM_ICON,
  extraUtility: EXTRA_UTILITY_ICON,
  travelDiscount: TRAVEL_DISCOUNT_ICON,
  goldenSense: GOLDEN_SENSE_ICON,
  forestBlessing: FOREST_BLESSING_ICON,
  packMule: PACK_MULE_ICON,
};

/** Sap Press (Boosts tab): an amber droplet being squeezed from a log. */
export const SAP_PRESS_ICON: PixelMap = [
  ".wwwwww.",
  "wtTTTTtw",
  ".wwwwww.",
  "...Y....",
  "...Yy...",
  "..YyyY..",
  "..YyyY..",
  "...YY...",
];

// --- Prestige-unlocked boon icons (see ui/battle.ts BOON_ICON_MAP) ---------

/** Lumber Blessing: a cut log, end-on — wood body with light ring center. */
export const BOON_LOG_ICON: PixelMap = [
  "........",
  ".wwwwww.",
  "wtTTTTtw",
  "wtTttTtw",
  "wtTttTtw",
  "wtTTTTtw",
  ".wwwwww.",
  "........",
];

/** Battle Trance: a gold spiral — focus wound tight. */
export const BOON_TRANCE_ICON: PixelMap = [
  "..yyyy..",
  ".y....y.",
  "y..yy..y",
  "y.y.Y..y",
  "y..yY..y",
  ".y..Y.y.",
  "..yyy...",
  "........",
];

// --- Shop item icons (Gnomes/Boosts/Provisions tabs) ------------------------
// One per HELPERS/BOOSTS/PROVISIONS entry (economy.ts) — these replace the
// old shared per-tab nav icon (GNOMES_ICON/BOOSTS_ICON/PROVISIONS_ICON) that
// every row in a tab used to show identically.

// Gnome cap+beard silhouette (same "conical red cap, dark brim, tan beard"
// vocabulary as GNOMES_ICON) plus a tiny axe — reusing the
// SLOT_WOODCHOPPING_ICON steel-head/wood-handle vocabulary at a smaller
// scale — leaning against its side, to read as "the gnome that chops".
export const HELPER_GNOME1_ICON: PixelMap = [
  "..RRR....",
  ".RrrrR...",
  ".RrrrR...",
  "RrrrrrR..",
  "RrEEErR..",
  ".MMMMM.A.",
  ".MMMMM.Aw",
  "........w",
];

// Two small gnome caps side by side — same cap/brim/beard vocabulary as
// HELPER_GNOME1_ICON, shrunk and doubled, no axe — reads as "a second one"
// without duplicating gnome1's silhouette outright.
export const HELPER_GNOME2_ICON: PixelMap = [
  ".R...R..",
  "RrR.RrR.",
  "RrR.RrR.",
  "KKK.KKK.",
  ".M...M..",
  ".M...M..",
];

// Gnome cap+beard again, this time with a small lightning-bolt accent
// (same Y/y bolt color as BOOSTS_ICON, but a short trailing accent rather
// than a full-icon diagonal) trailing off the cap to read as "gnome, but
// fast".
export const HELPER_GNOME_HASTE_ICON: PixelMap = [
  "..RR....",
  ".RrrR...",
  "RrrrrR.Y",
  "RrrrrRYy",
  "KKKKK.y.",
  ".MMMM.y.",
  ".MMMM...",
];

// Small potion bottle — tan cork, glass outline, bright blue liquid with a
// glint. Blue matches the existing HUD Focus-meter color (game.ts's
// "#6fb7ff" fill) via UI_PALETTE's L.
export const BOOST_FOCUS_POTION_ICON: PixelMap = [
  "..MM....",
  "..KK....",
  ".KLLK...",
  "KLLLLK..",
  "KLyLLK..",
  "KLLLLK..",
  "KLLLLK..",
  ".KKKK...",
];

// Small cup-and-saucer with two short steam wisps above.
export const BOOST_ESPRESSO_ICON: PixelMap = [
  ".W..W...",
  "..W..W..",
  "........",
  ".KKKKK..",
  "KTTTTTK.",
  "KTTTTTKw",
  ".KKKKK..",
  "wwwwwwww",
];

// Amber gem (Y/y, same shape family as sprites.ts's AMBER_GEM) transitioning
// diagonally into a small wood-log cross-section (t/T rings, same colors as
// sprites.ts's LOG) — reads as "trade amber for wood".
export const BOOST_AMBER_WOOD_ICON: PixelMap = [
  "..Y.....",
  ".YyY....",
  "..Y.....",
  "...tttt.",
  "..tTTTTt",
  "..tTTTTt",
  "...tttt.",
  "........",
];

// Small wrapped bread loaf / ration bundle — wood-tan crust with a dark tie
// band across the middle and a cloth corner peeking below.
export const PROVISION_TRAIL_RATIONS_ICON: PixelMap = [
  "..www...",
  ".wwwww..",
  "wwwwwwww",
  "KKKKKKKK",
  "wwwwwwww",
  ".wwwww..",
  "..MMM...",
  "........",
];

// Round tan charm medallion with a glowing gold rune center and a loop at
// top (like an amulet) — deliberately NOT the four-leaf-clover shape used by
// POWERUP_ICON.luckyCharm (LUCKY_CHARM_ICON), so the two "luck" items in
// different systems (gacha powerup vs. carried provision) stay visually
// distinct.
export const PROVISION_FORTUNE_CHARM_ICON: PixelMap = [
  "..KK....",
  ".MMMMM..",
  "MMyYyMM.",
  "MMYyYMM.",
  "MMyYyMM.",
  ".MMMMM..",
  "..KKK...",
  "........",
];

// Small coiled rope, tan with darker shaded inner rings and a hole at
// center, seen from above.
export const PROVISION_EMERGENCY_ROPE_ICON: PixelMap = [
  ".wwwww..",
  "wwwwwww.",
  "wwTTTww.",
  "wTT.TTw.",
  "wwTTTww.",
  "wwwwwww.",
  ".wwwww..",
  "........",
];

export const HELPER_ICON: Record<HelperId, PixelMap> = {
  gnome1: HELPER_GNOME1_ICON,
  gnome2: HELPER_GNOME2_ICON,
  gnomeHaste: HELPER_GNOME_HASTE_ICON,
};

export const BOOST_ICON: Record<BoostSpec["id"], PixelMap> = {
  focusPotion: BOOST_FOCUS_POTION_ICON,
  espresso: BOOST_ESPRESSO_ICON,
  amberWood: BOOST_AMBER_WOOD_ICON,
};

export const PROVISION_ICON: Record<ProvisionId, PixelMap> = {
  trailRations: PROVISION_TRAIL_RATIONS_ICON,
  fortuneCharm: PROVISION_FORTUNE_CHARM_ICON,
  emergencyRope: PROVISION_EMERGENCY_ROPE_ICON,
};

/** Dye pot for the Style tab's swatch grid — an open paint pot whose contents
 * (`Z`) are recolored per swatch at render time. `Z` is deliberately a letter
 * UI_PALETTE does not define, so a swatch color can never collide with an
 * existing UI tone; the caller always supplies it (see shop.ts's dyePot). */
export const DYE_POT: PixelMap = [
  "..KKKK..",
  ".KZZZZK.",
  "KZZZZZZK",
  "KZZZZZZK",
  "KZZZZZZK",
  "KZZZZZZK",
  ".KZZZZK.",
  "..KKKK..",
];
