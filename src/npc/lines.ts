// The script. Every line below is hand-written and committed to this file.
//
// NOTHING HERE IS GENERATED. The app makes no model calls, sends no prompts,
// and reaches no network at runtime — the NPCs joke *about* AI, the app never
// *uses* it. This is a plain data table; if you want a new line, you write a
// new line.
//
// Two kinds of entry:
//   * a plain string — the great majority, and the default
//   * a function of UsageView — used ONLY where the live number is the
//     punchline. A joke that quotes a figure lands once; a joke that quotes a
//     figure every single time is a status bar with a hat on.
//
// Any entry that touches telemetry MUST carry a `when` guard, because on a
// cold boot (and in every browser-based test) there is no telemetry at all —
// see UsageView.blind. Failing closed means the NPC says something static
// instead of something with "NaN" in it.
//
// House style, forced by the pixel font (see FONT/fontSafe in scene/sprites):
// everything renders upper-case, so lines are written upper-case. Punctuation
// is limited to the glyphs that exist — ' " , . ! ? : - / and digits.

import { abbrev } from "../scene/floating-text";
import { pct, type UsageView } from "./usage-view";

export interface NpcLine {
  text: string | ((u: UsageView) => string);
  /** Only eligible when this passes. Required for anything data-driven. */
  when?: (u: UsageView) => boolean;
  /** Short enough to read at a glance — eligible for unprompted mutters. */
  ambient?: boolean;
}

/** Telemetry is present at all. Every data-driven line starts with this. */
const seeing = (u: UsageView): boolean => !u.blind;

// ---------------------------------------------------------------------------
// THE FISHER — lakeside
//
// His complaint is not a joke about the mechanics, it IS the mechanics: the
// pond's level is literally the remaining token budget (Lake.setLevel is fed
// from Game.density), and the Cache Koi's payout literally shrinks as it
// drains (koiReward). He is the most factually correct character in the game.
// ---------------------------------------------------------------------------
export const FISHER_LINES: NpcLine[] = [
  { text: "USED TO BE YOU COULD LOSE A BOOT IN THIS WATER." },
  { text: "EVERY TIME YOU ASK IT SOMETHING, I LOSE A FOOT OF SHORELINE." },
  { text: "THE FISH DIDN'T AGREE TO ANY OF THIS." },
  { text: "OH, IT'S VERY CLEVER. ASK IT TO PUT THE WATER BACK." },
  { text: "I'VE BEEN FISHING THIS POND FORTY YEARS. IT'S BEEN A PUDDLE FOR TWO WEEKS." },
  { text: "THEY SAID IT WOULD SAVE ME TIME. I HAVE NOTHING BUT TIME. I HAD WATER." },
  { text: "CAUGHT A BOOT. CAUGHT A TIN. HAVEN'T CAUGHT A FISH SINCE TUESDAY." },
  { text: "NOBODY EVER ASKS WHAT IT'S DRINKING." },
  { text: "WATER'S DOWN AGAIN.", ambient: true },
  { text: "HM.", ambient: true },
  { text: "NOT A NIBBLE.", ambient: true },
  { text: "GO ON THEN. ASK IT SOMETHING.", ambient: true },

  // --- data-driven: the number is the joke ---
  {
    when: (u) => seeing(u) && u.density < 0.6,
    text: (u) => `LAKE'S AT ${pct(u.density)}%. IT WAS FULL ON MONDAY. YOU DO THE SUMS.`,
  },
  {
    when: (u) => seeing(u) && u.density < 0.25,
    text: (u) => `${pct(u.density)}%. I CAN SEE THE BOTTOM. I'VE NEVER SEEN THE BOTTOM.`,
  },
  {
    when: (u) => seeing(u) && (u.usedCacheRead ?? 0) > 100_000,
    text: (u) => `${abbrev(u.usedCacheRead ?? 0)} CACHE READS TODAY. THAT'S WHAT THE KOI EAT, YOU KNOW.`,
  },
  {
    when: (u) => seeing(u) && (u.usedCounted ?? 0) > 100_000,
    text: (u) => `${abbrev(u.usedCounted ?? 0)} TOKENS THIS BLOCK. FISH DON'T DRINK TOKENS. SOMEHOW THEY'RE THE ONES FLOATING.`,
  },
  {
    when: (u) => seeing(u) && u.working > 1,
    text: (u) => `${u.working} OF YOU TALKING TO IT AT ONCE. NO WONDER THE WELL'S DRY.`,
  },
  {
    when: (u) => seeing(u) && (u.fiveHourPct ?? 0) > 0.8,
    text: (u) => `${pct(u.fiveHourPct ?? 0)}% OF YOUR WINDOW GONE. AND FOR WHAT? A FENCE?`,
  },
];

// ---------------------------------------------------------------------------
// THE FOREMAN — the trestle
//
// A construction man with a clipboard and a rate card. His opening beat is the
// user's own: the pun, then the invoice.
// ---------------------------------------------------------------------------
export const FOREMAN_LINES: NpcLine[] = [
  { text: "I BUILD THINGS THAT STAY BUILT. NOVEL CONCEPT ROUND HERE." },
  { text: "ASK YOUR MACHINE TO CROSS THE RAVINE. I'LL WAIT." },
  { text: "IT CAN WRITE ME A BRIDGE. CAN'T HAND ME A PLANK." },
  { text: "MEASURE TWICE. YOUR LOT MEASURE NEVER." },
  { text: "EVERYONE WANTS A SPAN. NOBODY WANTS AN INVOICE." },
  { text: "I DON'T DO ESTIMATES. I DO PRICES." },
  { text: "TIMBER, COIN, OR SWEAT. PICK ONE, THEY ALL BUILD THE SAME BRIDGE." },
  { text: "THAT RAVINE'S BEEN THERE LONGER THAN EITHER OF US. IT'S PATIENT." },
  { text: "MIND THE GAP.", ambient: true },
  { text: "HMPH. AMATEURS.", ambient: true },
  { text: "STILL WANTS PAYING.", ambient: true },

  // --- data-driven ---
  {
    when: (u) => seeing(u) && (u.usedCounted ?? 0) > 100_000,
    text: (u) => `${abbrev(u.usedCounted ?? 0)} TOKENS THIS BLOCK AND NOT ONE OF THEM HELD UP A BEAM.`,
  },
  {
    when: (u) => seeing(u) && u.sessions > 1,
    text: (u) => `${u.sessions} OF YOU ON THE JOB AND THE SPAN'S STILL DOWN. THAT'S MANAGEMENT, THAT IS.`,
  },
  {
    when: (u) => seeing(u) && (u.fiveHourPct ?? 0) > 0.9,
    text: () => "YOU'RE NEARLY OUT OF WHATEVER IT IS YOU SPEND. I ONLY TAKE WOOD, AMBER OR ELBOW GREASE.",
  },
];

// ---------------------------------------------------------------------------
// THE QUARTERMASTER — the encampment
//
// Runs the camp, outfits the party, keeps the ledger. Unimpressed by how you
// treat hired help — of either kind.
// ---------------------------------------------------------------------------
export const QUARTERMASTER_LINES: NpcLine[] = [
  { text: "EVERY EXPEDITION COMES BACK LIGHTER THAN IT LEFT. FUNNY, THAT." },
  { text: "I SIGN THEM OUT. I DON'T ALWAYS SIGN THEM BACK IN." },
  { text: "YOU WANT THEM FED AND PAID? THAT'S NOT HOW YOU TREAT THE OTHER ONES." },
  { text: "THEY DON'T ASK WHERE THEY'RE GOING. THAT'S THE PART THAT WORRIES ME." },
  { text: "NEW HANDS ARE CHEAP. GOOD HANDS AREN'T." },
  { text: "SOMETHING OUT THERE'S BEEN LEARNING OUR ROUTES." },
  { text: "PACK LIGHT. COME BACK." },
  { text: "RATIONS ARE SHORT.", ambient: true },
  { text: "SIGN HERE.", ambient: true },
  { text: "ANOTHER ONE OUT.", ambient: true },

  // --- data-driven ---
  {
    when: (u) => seeing(u) && u.sessions > 1,
    text: (u) => `${u.sessions} SESSIONS RUNNING. THAT'S ${u.sessions} MOUTHS I DIDN'T AGREE TO FEED.`,
  },
  {
    when: (u) => seeing(u) && u.subagents > 0,
    text: (u) =>
      `${u.subagents} LITTLE HELPER${u.subagents === 1 ? "" : "S"} OUT THERE SWINGING AXES FOR YOU, AND YOU CAME TO ME FOR MORE HANDS.`,
  },
  {
    when: (u) => seeing(u) && u.working > 2,
    text: (u) => `${u.working} OF THEM MID-ERRAND RIGHT NOW. NONE OF THEM ASKED FOR A BREAK. THINK ON THAT.`,
  },
];

/** Resolve a line to text. Split out so the content gates can render every
 * line against a fabricated UsageView without going through an NPC. */
export function renderLine(line: NpcLine, u: UsageView): string {
  return typeof line.text === "function" ? line.text(u) : line.text;
}

/** Lines eligible right now. `ambientOnly` restricts to the short mutters. */
export function eligibleLines(pool: NpcLine[], u: UsageView, ambientOnly: boolean): NpcLine[] {
  return pool.filter((l) => (ambientOnly ? l.ambient === true : true) && (!l.when || l.when(u)));
}
