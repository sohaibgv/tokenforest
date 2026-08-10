# 🌲 TokenForest

An idle woodcutting game in your menu bar, played by your Claude Code token
usage. Every token you spend, a woodcutter swings; felled trees pay wood;
wood buys better axes, helpers, cosmetics, and passage to harder worlds.
You focus on your work — the forest rewards you for it.

## The game

- **Click to chop** — click any standing tree for a manual swing at full axe
  damage. Swings spend **Focus** (blue bar, top-left): +1 per 1,000 tokens
  your prompts burn, cap 100. Out of Focus? Clicks just spark — run another
  prompt to recharge. Autoclickers earn nothing without token income.
- **Golden Spots** — trees being chopped sometimes show a glowing spot for a
  few seconds. Hit it precisely: with Focus it's a 3× damage strike; without,
  it grants a 5s Frenzy (everyone chops double-speed).
- **Amber** — every 1,000 tokens also pays +1 Amber (gold counter), spent in
  the shop's Boosts tab: Focus Potion (refill), Gnome Espresso (gnomes chop
  every 5s for a minute), or Amber→Wood trades. Heavy single turns (>30k
  tokens) drop a clickable golden log worth bonus Amber.
- **Chips** — every landed hit pays +1 wood × world multiplier; felled trees
  still pay their full yield on top.

- **Wood** — small trees pay 1, medium 3, large 5, the elder 50 (× the
  world's multiplier). The counter lives top-left; wood persists forever in
  `~/.config/tokenforest/save.json` (exact mid-plot progress included).
- **Damage is token-gated** — a woodcutter only swings when real usage
  arrived; an axe hit deals your axe's damage. No tokens, no progress
  (except gnomes).
- **Shop (🪓 in the strip)** — five axes (×10 damage each: Rusty → Iron →
  Steel → Mithril → Crystal), helpers (Swift Boots, Keen Edge, Gnome
  Choppers that chop on a slow wall-clock trickle even while you rest),
  and cosmetics (cap colors, tree skins).
- **Worlds** — clear enough plots and the Travel button appears: pay wood
  to trek to Autumn Lands, Snowreach, Emberwaste, Crystal Hollow. Each
  world has ×10 tree HP and ×10 wood, so a tier-matched axe keeps the
  rhythm identical — upgrade or grind.

- **Chopping woodcutter** — Claude is working. A floating `-1.2k` shows the
  tokens each burst of work consumed.
- **Sitting woodcutter** — Claude finished its turn and is waiting for your
  input (or is stuck on a permission prompt).
- **Multiple woodcutters** — parallel sessions and subagents. Spawn 5 agents,
  get 5 extra woodcutters (subagents wear a small yellow marker). More than 8
  and a `+N` badge appears.
- **Plots of land** — seeded plots of 28 trees (12 small, 10 medium, 5
  large, 1 elder — the elder always falls last, with the whole crew ganged
  around it). Clear-cut a plot and the woodcutters trek to the next, camera
  sliding along. Plots are endless within a world.
- **Budget meter** — your 5-hour block lives in the lake level (cracked mud
  when empty), the bottom bar, and the tray warning icon (<20% left shows a
  lone stump). It no longer drives the forest.
- **Day & night** — the sun (6:00–18:00) and moon (18:00–6:00) arc across
  the sky on your local clock, with dawn/dusk palettes and stars at night.
- **Resizable** — drag the window edges; the world grows to fill it (more
  land, same chunky pixels), and the size is remembered.
- **Dismissing the panel** — click the tray tree, press Esc, click the ✕,
  or just click anywhere else (it hides on losing focus). Quit via the
  tray right-click menu.
- **Moving the panel** — drag it anywhere by grabbing the scene or the
  bottom strip; it remembers the spot. Until you drag it, it opens at the
  tray icon (or bottom-right before the tray has been clicked).
- **Menu bar at a glance** — the tray icon animates chopping while Claude
  works, and a live `-2.7k` counter next to it shows tokens spent in the
  last few seconds, so you don't even need to open the panel.
- **Regrowth** — when the 5-hour block rolls over, trees sprout back.

## How it works

No API keys, no network. TokenForest tails the transcript files Claude Code
already writes to `~/.claude/projects/**/*.jsonl`, dedupes the per-message
usage entries, and infers activity from what's being appended:

- token usage → chop events
- `stop_reason: end_turn` with nothing after it → waiting for input
- separate `subagents/agent-*.jsonl` files → extra woodcutters
- 30 minutes of silence → the woodcutter walks home

**The budget is directional, not accounting.** Real Claude subscription
limits are cost- and model-weighted and not published; TokenForest counts
`input + output + cache_creation` tokens against a configurable budget per
5-hour block (default 5M, ⚙ in the panel). Cache-read tokens are tracked but
excluded — they'd dwarf everything else and make the forest meaningless.

## Install

Grab the installer for your platform from the
[latest release](../../releases/latest): `.dmg` (macOS, Apple Silicon or
Intel), `.exe` (Windows), `.AppImage`/`.deb` (Linux).

Builds are **unsigned** (no paid certificates), so:
- **macOS**: right-click the app → Open the first time, or run
  `xattr -dr com.apple.quarantine /Applications/TokenForest.app`.
- **Windows**: SmartScreen may warn — "More info" → "Run anyway".

You need [Claude Code](https://claude.com/claude-code) — the game reads its
local transcript files. No account, no network, no keys.

## Code signing (optional, costs money)

Unsigned builds trigger Gatekeeper / SmartScreen warnings. To sign for real:

**macOS** (~$99/yr [Apple Developer Program](https://developer.apple.com/programs/)):
create a "Developer ID Application" certificate, export it as .p12, then add
repo secrets — the release workflow picks them up automatically, no code
changes: `APPLE_CERTIFICATE` (base64 of the .p12), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY` ("Developer ID Application: Your Name (TEAMID)"),
`APPLE_ID`, `APPLE_PASSWORD` (app-specific password), `APPLE_TEAM_ID`.
This also notarizes, so downloads open without warnings.

**Windows**: needs a code-signing certificate (OV certs ~$100–400/yr from
vendors like Certum/SSL.com, or [Azure Trusted Signing](https://azure.microsoft.com/en-us/products/trusted-signing)
~$10/mo). SmartScreen reputation also builds over time even for signed OV
certs. Wire it via `bundle.windows.signCommand` in `tauri.conf.json` per the
[Tauri signing docs](https://tauri.app/distribute/sign/windows/) once you
have one.

## Releasing (maintainers)

Push a version tag and GitHub Actions builds all installers into a draft
release (publish it manually after review):

```sh
git tag v0.1.0 && git push origin v0.1.0
```

## Auto-updates

The app checks GitHub releases on launch (and via "Check for updates" in
the ⚙ settings). When a newer version exists, an update pill appears —
one click downloads, verifies the signature, installs, and relaunches.
Update artifacts are signed with a minisign keypair; the public key ships
in `tauri.conf.json`, the private key lives only in the repo's Actions
secrets.

## Run from source

```sh
npm install
npm run tauri dev     # dev
npm run tauri build   # bundle
```

`tauri build` needs an updater signing key (any key — updates just won't
apply to self-built copies unless it matches the release key):

```sh
npx tauri signer generate -w ~/.tauri/dev.key --password ""
export TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/dev.key
```

Click the tree in your menu bar to open the panel. Right-click for the menu
(Linux desktops without tray left-click support: use "Open panel" there).

Linux needs `libayatana-appindicator`; GNOME additionally needs the
AppIndicator extension.

## Testing with fixtures

Point the watcher at a scratch dir and append transcript lines by hand:

```sh
TOKENFOREST_ROOT=/tmp/tf-fixtures npm run tauri dev
```

Other dev knobs: debug builds show the panel on launch, and
`TOKENFOREST_NO_AUTOHIDE=1` keeps it from hiding on blur (handy for
screenshots).

Rust unit tests (parser leniency, state-machine thresholds, block math):

```sh
cd src-tauri && cargo test
```
