// WebAudio-synthesized SFX — every sound is built from oscillators and
// filtered noise at play time; zero binary assets. The AudioContext is
// created lazily on the first play (which, via the UI-click hook in
// main.ts, always happens inside a user gesture, so autoplay policy never
// leaves it stuck suspended). Master mute/volume live in the Rust config
// (app-level, not per-save-slot) — see main.ts for the settings wiring.

import type { Rarity } from "./economy";

export type SfxId =
  | "chop"
  | "fell"
  | "goldenLog"
  | "koiCatch"
  | "gachaReveal"
  | "hit"
  | "crit"
  | "defend"
  | "heal"
  | "click"
  | "prestige"
  | "crank"
  | "needleUp"
  | "needleDown"
  | "raftLaunch"
  | "railWhistle"
  | "fusionCharge"
  | "fusionBurst";

let audio: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let volume = 0.5;

function ensure(): AudioContext | null {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return null;
  if (muted) return null; // don't even spin up the context while muted
  if (!audio) {
    audio = new AudioContext();
    master = audio.createGain();
    master.gain.value = volume;
    master.connect(audio.destination);
  }
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

function applyMaster(): void {
  if (master) master.gain.value = muted ? 0 : volume;
}

export function setSfxMuted(m: boolean): void {
  muted = m;
  applyMaster();
}

export function sfxMuted(): boolean {
  return muted;
}

/** 0..1. */
export function setSfxVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
  applyMaster();
}

export function sfxVolume(): number {
  return volume;
}

interface ToneOpts {
  type?: OscillatorType;
  delay?: number;
  gain?: number;
  /** Exponential frequency sweep target over the tone's duration. */
  sweepTo?: number;
}

function tone(freq: number, dur: number, opts: ToneOpts = {}): void {
  const ctx = ensure();
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + (opts.delay ?? 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.sweepTo) osc.frequency.exponentialRampToValueAtTime(opts.sweepTo, t0 + dur);
  const peak = opts.gain ?? 0.25;
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

interface NoiseOpts {
  delay?: number;
  gain?: number;
  /** Lowpass cutoff — low for thuds/crashes, high for snappy ticks. */
  filterFreq?: number;
}

function noise(dur: number, opts: NoiseOpts = {}): void {
  const ctx = ensure();
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + (opts.delay ?? 0);
  const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = opts.filterFreq ?? 1200;
  const g = ctx.createGain();
  const peak = opts.gain ?? 0.3;
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** Rarity → base sweep frequency for the gacha reveal: rarer = higher. */
const RARITY_FREQ: Record<Rarity, number> = {
  common: 300,
  rare: 420,
  epic: 560,
  legendary: 720,
};

export function playSfx(id: SfxId, opts: { rarity?: Rarity } = {}): void {
  if (muted) return;
  switch (id) {
    case "chop": // short woody thunk
      noise(0.06, { gain: 0.4, filterFreq: 700 });
      tone(170, 0.05, { type: "square", gain: 0.12 });
      break;
    case "fell": // long low crash
      noise(0.45, { gain: 0.5, filterFreq: 320 });
      tone(95, 0.4, { type: "sawtooth", sweepTo: 38, gain: 0.25 });
      break;
    case "goldenLog": // two-note chime
      tone(880, 0.12, { gain: 0.2 });
      tone(1318, 0.2, { delay: 0.08, gain: 0.18 });
      break;
    case "koiCatch": // watery plip + splash noise
      noise(0.12, { gain: 0.22, filterFreq: 2200 });
      tone(660, 0.1, { sweepTo: 440, gain: 0.16 });
      tone(990, 0.14, { delay: 0.06, sweepTo: 1320, gain: 0.1 });
      break;
    case "gachaReveal": {
      // rising sweep pitched by rarity; epic+ adds a shimmer note on top
      const base = RARITY_FREQ[opts.rarity ?? "common"];
      tone(base, 0.35, { sweepTo: base * 2, gain: 0.22 });
      if (opts.rarity === "epic" || opts.rarity === "legendary") {
        tone(base * 3, 0.3, { delay: 0.18, gain: 0.12 });
      }
      break;
    }
    case "hit":
      noise(0.05, { gain: 0.3, filterFreq: 900 });
      tone(160, 0.06, { type: "square", gain: 0.1 });
      break;
    case "crit": // heavier double impact
      noise(0.09, { gain: 0.45, filterFreq: 600 });
      tone(120, 0.1, { type: "square", gain: 0.2 });
      tone(240, 0.08, { delay: 0.04, type: "square", gain: 0.15 });
      break;
    case "defend": // descending "brace"
      tone(330, 0.16, { type: "triangle", sweepTo: 210, gain: 0.2 });
      break;
    case "heal": // gentle upward glide
      tone(520, 0.22, { sweepTo: 780, gain: 0.18 });
      break;
    case "click":
      tone(620, 0.03, { type: "square", gain: 0.08 });
      break;
    // --- Gramophone + raft (Iteration 5) ---
    case "crank": // one detent of the volume crank — a tiny mechanical tick
      noise(0.03, { gain: 0.18, filterFreq: 2600 });
      tone(900, 0.02, { type: "square", gain: 0.06 });
      break;
    case "needleUp": // tone-arm lifted off the record
      noise(0.07, { gain: 0.2, filterFreq: 2000 });
      tone(300, 0.05, { type: "triangle", sweepTo: 500, gain: 0.08 });
      break;
    case "needleDown": // tone-arm set back down
      noise(0.09, { gain: 0.25, filterFreq: 1600 });
      tone(220, 0.06, { type: "triangle", sweepTo: 140, gain: 0.1 });
      break;
    case "raftLaunch": // shoving off downstream
      noise(0.28, { gain: 0.3, filterFreq: 900 });
      tone(140, 0.3, { type: "triangle", sweepTo: 90, gain: 0.15 });
      break;
    case "railWhistle": // handcar pulling out of the halt
      // Two stacked tones a fifth apart, both bending down, with a breath of
      // noise under them — the classic hollow two-note whistle. A single pure
      // tone reads as a UI beep, not as steam.
      tone(880, 0.22, { type: "triangle", sweepTo: 780, gain: 0.16 });
      tone(1320, 0.22, { type: "triangle", sweepTo: 1170, gain: 0.1 });
      noise(0.24, { gain: 0.08, filterFreq: 2600 });
      tone(660, 0.3, { delay: 0.2, type: "triangle", sweepTo: 560, gain: 0.13 });
      break;
    case "fusionCharge": {
      // Four voices climbing together and converging on one pitch — the sound
      // of the four sacrifices being pulled into the fifth. Deliberately ends
      // unresolved: it is the wind-up, and fusionBurst is the landing.
      for (let i = 0; i < 4; i++) {
        tone(180 + i * 40, 0.5, { sweepTo: 660, gain: 0.075, delay: i * 0.05, type: "triangle" });
      }
      noise(0.5, { gain: 0.05, filterFreq: 900 });
      break;
    }
    case "fusionBurst": {
      // The impact, pitched by the tier it produced, so a merge into Legendary
      // sounds like more than a merge into Rare. Same RARITY_FREQ table the
      // gacha reveal uses, so the two celebrations share a key.
      const base = RARITY_FREQ[opts.rarity ?? "common"];
      noise(0.16, { gain: 0.3, filterFreq: 1800 });
      tone(base, 0.3, { gain: 0.24 });
      tone(base * 1.5, 0.28, { delay: 0.08, gain: 0.2 });
      tone(base * 2, 0.42, { delay: 0.16, gain: 0.22, sweepTo: base * 2.2 });
      break;
    }
    case "prestige": // little fanfare arpeggio
      tone(523, 0.18, { gain: 0.2 });
      tone(659, 0.18, { delay: 0.12, gain: 0.2 });
      tone(784, 0.18, { delay: 0.24, gain: 0.2 });
      tone(1047, 0.34, { delay: 0.36, gain: 0.24 });
      break;
  }
}
