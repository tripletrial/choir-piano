/**
 * Voix — Choir practice piano
 * Web Audio piano + toggleable Warmups & Harmony finder
 */

import {
  setVectorLabel,
  setVectorBody,
} from "./vector-label.js";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SOLFEGE = ["Do", "Di", "Re", "Ri", "Mi", "Fa", "Fi", "Sol", "Si", "La", "Li", "Ti"];

const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11];

const QUALITY_INTERVALS = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  aug: [0, 4, 8],
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
};

const QUALITY_TITLE = {
  major: "major",
  minor: "minor",
  dom7: "7",
  maj7: "maj7",
  min7: "min7",
  aug: "aug",
  dim: "dim",
  sus4: "sus4",
};

const ROLE_LABELS = ["Root", "3rd", "5th", "7th"];
const ROLE_CLASSES = ["guide-root", "guide-3", "guide-5", "guide-7"];

const INSTRUMENTS = {
  piano: { name: "Grand Piano" },
  hum: { name: "Choir Hum" },
  organ: { name: "Pipe Organ" },
  strings: { name: "Strings" },
  epiano: { name: "Electric Piano" },
};

const EXERCISES = {
  five: {
    name: "5-tone scale",
    desc: "Do–Re–Mi–Fa–Sol and back. Keep the tone steady.",
    pattern: [0, 2, 4, 5, 7, 5, 4, 2, 0],
  },
  arpeggio: {
    name: "Arpeggio",
    desc: "Do–Mi–Sol–Do′–Sol–Mi–Do. Light and lifted.",
    pattern: [0, 4, 7, 12, 7, 4, 0],
  },
  siren: {
    name: "Siren glide",
    desc: "Slide through the tones. Reference pitches mark the path.",
    pattern: [0, 2, 4, 7, 12, 7, 4, 2, 0],
  },
  octave: {
    name: "Octave hop",
    desc: "Root and octave — place the top note cleanly.",
    pattern: [0, 12, 0, 12, 0],
  },
  solfege: {
    name: "Full solfege",
    desc: "Do through Do′ and descend. Name each pitch.",
    pattern: [0, 2, 4, 5, 7, 9, 11, 12, 11, 9, 7, 5, 4, 2, 0],
  },
};

/** @type {AudioContext | null} */
let audioCtx = null;
let masterGain = null;
let sustainOn = true;
/** True when warmup playback engaged the pedal (restore afterward) */
let pedalAutoEngaged = false;
/** User pedal state before an auto-pedal passage */
let pedalUserBeforeAuto = false;
const activeVoices = new Map();

/** Fixed choir keyboard: C2–C6 (29 white keys) */
const RANGE_START_MIDI = 36; // C2
const RANGE_WHITE_COUNT = 29;
const PAN_THRESHOLD_PX = 10;

/** Acoustic grand piano samples (MusyngKite via jsDelivr) */
const PIANO_SAMPLE_BASE =
  "https://cdn.jsdelivr.net/gh/gleitz/midi-js-soundfonts@gh-pages/MusyngKite/acoustic_grand_piano-mp3/";
const SAMPLE_FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
/** @type {Map<number, AudioBuffer>} */
const sampleBuffers = new Map();
/** @type {Map<number, Promise<AudioBuffer | null>>} */
const sampleLoading = new Map();
let pianoReady = false;
let pianoLoadPromise = null;

const state = {
  rangeStartMidi: RANGE_START_MIDI,
  whiteCount: RANGE_WHITE_COUNT,
  mode: null, // 'warmup' | 'harmony' | null
  sustain: true,
  audioUnlocked: false,
  isDesktop: false,
  // warmup
  exercise: "five",
  warmupRoot: null,
  warmupStep: 0,
  warmupActive: false,
  warmupPlaying: false,
  // harmony
  quality: "major",
  voicing: "triad",
  harmonyRoot: null,
  syncPlay: false,
  instrument: "piano",
};

/** Computer keyboard → semitone offset from the leftmost C on the piano */
const COMPUTER_KEY_OFFSETS = {
  a: 0,
  w: 1,
  s: 2,
  e: 3,
  d: 4,
  f: 5,
  t: 6,
  g: 7,
  y: 8,
  h: 9,
  u: 10,
  j: 11,
  k: 12,
  o: 13,
  l: 14,
  p: 15,
  ";": 16,
  "'": 17,
};
const pressedComputerKeys = new Set();

/** @type {Map<number, number[]>} root midi → chord midis held for sync release */
const syncHeld = new Map();

const $ = (id) => document.getElementById(id);

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function noteLabel(midi) {
  const name = NOTE_NAMES[midi % 12];
  const oct = Math.floor(midi / 12) - 1;
  return `${name}${oct}`;
}

function soundfontNoteName(midi) {
  const oct = Math.floor(midi / 12) - 1;
  return `${SAMPLE_FLAT_NAMES[midi % 12]}${oct}`;
}

function solfegeFromRoot(midi, rootMidi) {
  if (rootMidi == null) return SOLFEGE[midi % 12];
  const deg = ((midi - rootMidi) % 12 + 12) % 12;
  return SOLFEGE[deg];
}

function setAudioHint(text, { hide = false } = {}) {
  const el = $("audio-hint");
  if (!el) return;
  if (text) setVectorLabel(el, text, "hint");
  else el.setAttribute("aria-label", "");
  el.classList.toggle("hidden", hide);
}

function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.9;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  if (!state.audioUnlocked) {
    state.audioUnlocked = true;
    setAudioHint("Loading grand piano…");
    preloadPianoSamples();
  }
}

async function decodeSample(midi) {
  if (sampleBuffers.has(midi)) return sampleBuffers.get(midi);
  if (sampleLoading.has(midi)) return sampleLoading.get(midi);

  const task = (async () => {
    try {
      const url = `${PIANO_SAMPLE_BASE}${soundfontNoteName(midi)}.mp3`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.arrayBuffer();
      const buf = await audioCtx.decodeAudioData(raw.slice(0));
      sampleBuffers.set(midi, buf);
      return buf;
    } catch (err) {
      console.warn("Piano sample failed", soundfontNoteName(midi), err);
      return null;
    } finally {
      sampleLoading.delete(midi);
    }
  })();

  sampleLoading.set(midi, task);
  return task;
}

function visibleMidiRange() {
  const whites = whiteMidiList();
  const lo = whites[0] - 1;
  const hi = whites[whites.length - 1] + 1;
  const midis = [];
  for (let m = Math.max(21, lo); m <= Math.min(108, hi); m++) midis.push(m);
  return midis;
}

async function preloadPianoSamples() {
  ensureAudio();
  const midis = visibleMidiRange();
  // Prioritize middle of the current keyboard so the first taps sound like piano
  const mid = midis[Math.floor(midis.length / 2)] || 60;
  midis.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));

  const missing = midis.filter((m) => !sampleBuffers.has(m) && !sampleLoading.has(m));
  if (missing.length === 0) {
    if (sampleBuffers.size > 0) {
      pianoReady = true;
      setAudioHint("", { hide: true });
    }
    return;
  }

  if (!pianoReady) setAudioHint("Loading grand piano…");

  const run = (async () => {
    const batchSize = 6;
    for (let i = 0; i < missing.length; i += batchSize) {
      await Promise.all(missing.slice(i, i + batchSize).map((m) => decodeSample(m)));
      if (!pianoReady && sampleBuffers.size > 0) {
        pianoReady = true;
        setAudioHint("Grand piano ready");
        setTimeout(() => setAudioHint("", { hide: true }), 1200);
      }
    }
    pianoReady = sampleBuffers.size > 0;
    if (pianoReady) setAudioHint("", { hide: true });
    else setAudioHint("Piano samples unavailable — using fallback tone");
  })();

  pianoLoadPromise = run;
  return run;
}

function nearestLoadedSample(midi) {
  if (sampleBuffers.has(midi)) return { midi, buffer: sampleBuffers.get(midi) };
  let best = null;
  let bestDist = Infinity;
  for (const [m, buffer] of sampleBuffers) {
    const d = Math.abs(m - midi);
    if (d < bestDist && d <= 4) {
      bestDist = d;
      best = { midi: m, buffer };
    }
  }
  return best;
}

/** Play note with the selected instrument */
function playNote(midi, { duration = null, velocity = 0.85 } = {}) {
  ensureAudio();
  stopNote(midi, true);

  if (state.instrument !== "piano") {
    return playSynthVoice(midi, { duration, velocity });
  }

  const sample = nearestLoadedSample(midi);
  if (!sample) {
    decodeSample(midi).then(() => {
      /* next press will use sample */
    });
    return playSynthVoice(midi, { duration, velocity, preset: "fallback" });
  }

  const now = audioCtx.currentTime;
  const source = audioCtx.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.value = Math.pow(2, (midi - sample.midi) / 12);

  const gain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 12000;
  filter.Q.value = 0.5;

  source.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  const peak = Math.min(1, 0.95 * velocity);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(peak * 0.92, now + 0.08);

  source.start(now);

  const voice = { source, gain, filter, release: null, isSample: true, releaseSec: 0.55, oscillators: [] };
  activeVoices.set(midi, voice);

  source.onended = () => {
    if (activeVoices.get(midi) === voice) activeVoices.delete(midi);
  };

  if (duration != null) {
    releaseNote(midi, now + duration);
  }

  decodeSample(midi + 1);
  decodeSample(midi - 1);

  return voice;
}

/** Synthesized instruments (hum / organ / strings / e.piano) + soft fallback */
function playSynthVoice(midi, { duration = null, velocity = 0.85, preset = null } = {}) {
  ensureAudio();
  const now = audioCtx.currentTime;
  const freq = midiToFreq(midi);
  const kind = preset || state.instrument;
  const gain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();
  const oscillators = [];

  const addOsc = (type, ratio, level, detune = 0) => {
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq * ratio, now);
    if (detune) osc.detune.setValueAtTime(detune, now);
    g.gain.value = level;
    osc.connect(g);
    g.connect(filter);
    oscillators.push(osc);
    return osc;
  };

  filter.type = "lowpass";
  let peak = 0.55 * velocity;
  let attack = 0.02;
  let decayTo = 0.7;
  let sustainFloor = 0.08;
  let naturalDecaySec = 4.5;
  let releaseSec = 0.55;

  if (kind === "hum") {
    filter.frequency.value = 900;
    filter.Q.value = 1.2;
    peak = 0.42 * velocity;
    attack = 0.08;
    decayTo = 0.85;
    sustainFloor = 0.06;
    naturalDecaySec = 5.5;
    releaseSec = 0.7;
    addOsc("sine", 1, 0.7);
    addOsc("sine", 2, 0.18, 3);
    addOsc("triangle", 1, 0.22, -4);
  } else if (kind === "organ") {
    filter.frequency.value = 4200;
    filter.Q.value = 0.4;
    peak = 0.38 * velocity;
    attack = 0.01;
    decayTo = 0.95;
    sustainFloor = null; // holds like a pipe organ
    naturalDecaySec = 0;
    releaseSec = 0.55;
    addOsc("sine", 1, 0.45);
    addOsc("sine", 2, 0.28);
    addOsc("sine", 3, 0.16);
    addOsc("sine", 4, 0.12);
    addOsc("sine", 6, 0.08);
  } else if (kind === "strings") {
    filter.frequency.value = 2800;
    filter.Q.value = 0.6;
    peak = 0.4 * velocity;
    attack = 0.14;
    decayTo = 0.8;
    sustainFloor = 0.1;
    naturalDecaySec = 6;
    releaseSec = 0.7;
    addOsc("sawtooth", 1, 0.35, -6);
    addOsc("sawtooth", 1, 0.35, 7);
    addOsc("triangle", 2, 0.12, 2);
  } else if (kind === "epiano") {
    filter.frequency.value = 3200;
    filter.Q.value = 0.9;
    peak = 0.5 * velocity;
    attack = 0.005;
    decayTo = 0.45;
    sustainFloor = 0.04;
    naturalDecaySec = 3.2;
    releaseSec = 0.55;
    addOsc("sine", 1, 0.55);
    addOsc("triangle", 2, 0.28, 4);
    addOsc("sine", 4.02, 0.12);
  } else {
    // fallback soft tone while piano samples load
    filter.frequency.value = 2200;
    filter.Q.value = 0.5;
    peak = 0.35 * velocity;
    sustainFloor = 0.05;
    naturalDecaySec = 3.8;
    releaseSec = 0.55;
    addOsc("triangle", 1, 0.8);
  }

  filter.connect(gain);
  gain.connect(masterGain);

  const afterAttack = now + attack;
  const afterDecay = afterAttack + 0.18;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.001), afterAttack);
  gain.gain.exponentialRampToValueAtTime(Math.max(peak * decayTo, 0.001), afterDecay);
  // Piano-like natural fade while held (organ sustains)
  if (sustainFloor != null && naturalDecaySec > 0) {
    gain.gain.exponentialRampToValueAtTime(
      Math.max(peak * sustainFloor, 0.001),
      afterDecay + naturalDecaySec
    );
  }

  for (const osc of oscillators) osc.start(now);

  const voice = {
    source: oscillators[0],
    oscillators,
    gain,
    filter,
    release: null,
    isSample: false,
    releaseSec,
  };
  activeVoices.set(midi, voice);

  if (duration != null) releaseNote(midi, now + duration);
  return voice;
}

function releaseNote(midi, at = null, { releaseSec = null } = {}) {
  const voice = activeVoices.get(midi);
  if (!voice || voice.release) return;
  ensureAudio();
  const t = at ?? audioCtx.currentTime;
  voice.release = true;
  const rel = releaseSec ?? voice.releaseSec ?? 0.55;
  try {
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), t);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, t + rel);
  } catch {
    /* ignore */
  }
  const stopDelay = Math.ceil(rel * 1000) + 40;
  setTimeout(() => {
    try {
      voice.source?.stop?.();
      (voice.oscillators || []).forEach((o) => {
        try {
          o.stop();
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    if (activeVoices.get(midi) === voice) activeVoices.delete(midi);
  }, stopDelay);
}

function stopNote(midi, immediate = false) {
  const voice = activeVoices.get(midi);
  if (!voice) return;
  if (immediate) {
    try {
      voice.source?.stop?.();
      (voice.oscillators || []).forEach((o) => {
        try {
          o.stop();
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
    activeVoices.delete(midi);
    return;
  }
  releaseNote(midi);
}

function setPedal(on, { auto = false, phraseClear = false } = {}) {
  if (auto && on) {
    if (!pedalAutoEngaged) {
      pedalUserBeforeAuto = sustainOn;
      pedalAutoEngaged = true;
    }
  }

  sustainOn = !!on;
  state.sustain = sustainOn;
  $("sustain-btn")?.setAttribute("aria-pressed", String(sustainOn));

  if (!sustainOn) {
    for (const midi of [...activeVoices.keys()]) releaseNote(midi);
  }

  // End of an auto-pedaled passage: restore the player's own pedal preference
  if (auto && !on && !phraseClear && pedalAutoEngaged) {
    pedalAutoEngaged = false;
    if (pedalUserBeforeAuto) {
      sustainOn = true;
      state.sustain = true;
      $("sustain-btn")?.setAttribute("aria-pressed", "true");
    }
  }
}

function releaseAllVoices({ immediate = false } = {}) {
  for (const midi of [...activeVoices.keys()]) {
    if (immediate) stopNote(midi, true);
    else releaseNote(midi);
  }
}

function stopAll() {
  releaseAllVoices({ immediate: true });
}

/** Peak index of a warmup pattern (phrase turnaround) */
function patternPeakIndex(pattern) {
  let peak = 0;
  let peakVal = -Infinity;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] > peakVal) {
      peakVal = pattern[i];
      peak = i;
    }
  }
  return peak;
}

/** Soft dynamic curve: swell to the peak, ease down — like a sung warmup */
function warmupVelocity(i, len, peakIdx) {
  if (len <= 1) return 0.72;
  if (i === len - 1) return 0.55; // settle on the final
  if (i <= peakIdx) {
    const t = peakIdx === 0 ? 1 : i / peakIdx;
    return 0.58 + t * 0.28;
  }
  const t = (i - peakIdx) / Math.max(1, len - 1 - peakIdx);
  return 0.86 - t * 0.22;
}

function whiteMidiList() {
  const list = [];
  const cStart = state.rangeStartMidi;
  for (let i = 0; i < state.whiteCount; i++) {
    const octaveOffset = Math.floor(i / 7);
    const deg = i % 7;
    list.push(cStart + octaveOffset * 12 + WHITE_OFFSETS[deg]);
  }
  return list;
}

function pianoScrollEl() {
  return $("piano-scroll");
}

function keyWidthPx() {
  const el = $("piano") || $("app");
  if (!el) return 40;
  const raw = getComputedStyle(el).getPropertyValue("--key-w").trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : 40;
}

function updateVisibleRangeLabel() {
  const scroll = pianoScrollEl();
  const whites = whiteMidiList();
  if (!scroll || !whites.length) return;
  const kw = keyWidthPx();
  const startIdx = Math.max(0, Math.min(whites.length - 1, Math.floor(scroll.scrollLeft / kw)));
  const visibleCount = Math.max(1, Math.ceil(scroll.clientWidth / kw));
  const endIdx = Math.min(whites.length - 1, startIdx + visibleCount - 1);
  setVectorLabel(
    $("octave-label"),
    `${noteLabel(whites[startIdx])} – ${noteLabel(whites[endIdx])}`,
    "octave"
  );
}

function scrollByOctave(dir) {
  const scroll = pianoScrollEl();
  if (!scroll) return;
  const delta = keyWidthPx() * 7 * (dir < 0 ? -1 : 1);
  scroll.scrollBy({ left: delta, behavior: "smooth" });
}

function scrollMidiIntoView(midi, { smooth = true } = {}) {
  const scroll = pianoScrollEl();
  const key = document.querySelector(`.piano [data-midi="${midi}"]`);
  if (!scroll || !key) return;
  const keyLeft = key.offsetLeft;
  const keyRight = keyLeft + key.offsetWidth;
  const viewLeft = scroll.scrollLeft;
  const viewRight = viewLeft + scroll.clientWidth;
  let next = viewLeft;
  if (keyLeft < viewLeft + 8) next = keyLeft - scroll.clientWidth * 0.35;
  else if (keyRight > viewRight - 8) next = keyRight - scroll.clientWidth * 0.65;
  else return;
  next = Math.max(0, Math.min(scroll.scrollWidth - scroll.clientWidth, next));
  scroll.scrollTo({ left: next, behavior: smooth ? "smooth" : "auto" });
}

function isMidiInViewport(midi) {
  const scroll = pianoScrollEl();
  const key = document.querySelector(`.piano [data-midi="${midi}"]`);
  if (!scroll || !key) return false;
  const keyLeft = key.offsetLeft;
  const keyRight = keyLeft + key.offsetWidth;
  const viewLeft = scroll.scrollLeft;
  const viewRight = viewLeft + scroll.clientWidth;
  return keyRight > viewLeft + 4 && keyLeft < viewRight - 4;
}

function leftmostVisibleWhiteMidi() {
  const scroll = pianoScrollEl();
  const whites = whiteMidiList();
  if (!scroll || !whites.length) return whites[0] ?? 60;
  const idx = Math.max(0, Math.min(whites.length - 1, Math.round(scroll.scrollLeft / keyWidthPx())));
  // Snap to nearest C in view for computer-key mapping
  const approx = whites[idx];
  const c = approx - (approx % 12);
  return Math.max(whites[0], Math.min(whites[whites.length - 1], c));
}

function centerInitialScroll() {
  const scroll = pianoScrollEl();
  if (!scroll) return;
  // Start near C3–C5 for choir practice
  const c3 = document.querySelector(`.piano [data-midi="48"]`);
  if (c3) {
    const target = Math.max(0, c3.offsetLeft - scroll.clientWidth * 0.15);
    scroll.scrollLeft = target;
  }
  updateVisibleRangeLabel();
}

function renderPiano() {
  const piano = $("piano");
  piano.innerHTML = "";
  piano.style.setProperty("--white-count", String(state.whiteCount));

  const whites = document.createElement("div");
  whites.className = "keys-white";
  const blacks = document.createElement("div");
  blacks.className = "keys-black";

  const whiteMidis = whiteMidiList();

  whiteMidis.forEach((midi, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "key-white";
    btn.dataset.midi = String(midi);
    btn.setAttribute("aria-label", noteLabel(midi));
    const label = document.createElement("span");
    label.className = "key-label";
    label.setAttribute("aria-hidden", "true");
    setVectorLabel(label, NOTE_NAMES[midi % 12], "key");
    btn.appendChild(label);
    whites.appendChild(btn);

    if (i < state.whiteCount - 1) {
      const nextWhite = whiteMidis[i + 1];
      if (nextWhite - midi === 2) {
        const blackMidi = midi + 1;
        const b = document.createElement("button");
        b.type = "button";
        b.className = "key-black";
        b.dataset.midi = String(blackMidi);
        b.setAttribute("aria-label", noteLabel(blackMidi));
        const leftPct = ((i + 1) / state.whiteCount) * 100;
        const widthPct = (100 / state.whiteCount) * 0.62;
        b.style.left = `calc(${leftPct}% - ${widthPct / 2}%)`;
        blacks.appendChild(b);
      }
    }
  });

  piano.appendChild(whites);
  piano.appendChild(blacks);
  bindPianoPointers(piano);
  bindPianoScroll();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      centerInitialScroll();
      refreshGuides();
    });
  });
}

let pianoScrollBound = false;
function bindPianoScroll() {
  const scroll = pianoScrollEl();
  if (!scroll || pianoScrollBound) return;
  pianoScrollBound = true;
  let raf = 0;
  scroll.addEventListener(
    "scroll",
    () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        updateVisibleRangeLabel();
        if (state.mode === "harmony" && state.harmonyRoot != null) {
          updateRangeCues(getHarmonyTones(state.harmonyRoot));
        }
      });
    },
    { passive: true }
  );
}

function bindPianoPointers(piano) {
  if (piano.dataset.pointerBound === "1") return;
  piano.dataset.pointerBound = "1";

  /** @type {Map<number, { midi: number|null, startX: number, startY: number, lastX: number, panning: boolean, armed: boolean }>} */
  const gestures = new Map();

  const midiFromPoint = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const key = el.closest("[data-midi]");
    return key ? Number(key.dataset.midi) : null;
  };

  const playDown = (midi, gesture) => {
    if (midi == null || gesture.panning) return;
    gesture.midi = midi;
    gesture.armed = true;
    piano.querySelector(`[data-midi="${midi}"]`)?.classList.add("active");
    onKeyDown(midi);
  };

  const playUp = (gesture) => {
    const midi = gesture.midi;
    gesture.midi = null;
    if (midi == null) return;
    const still = [...gestures.values()].some((g) => g.midi === midi);
    if (!still) {
      piano.querySelector(`[data-midi="${midi}"]`)?.classList.remove("active");
      onKeyUp(midi);
    }
  };

  const enterPan = (gesture, totalDx) => {
    if (gesture.panning) return;
    gesture.panning = true;
    if (gesture.armed) {
      playUp(gesture);
      gesture.armed = false;
    }
    const scroll = pianoScrollEl();
    if (scroll) scroll.scrollLeft -= totalDx;
  };

  piano.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    piano.setPointerCapture?.(e.pointerId);
    const midi = Number(e.target.closest?.("[data-midi]")?.dataset?.midi);
    const gesture = {
      midi: null,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      panning: false,
      armed: false,
    };
    gestures.set(e.pointerId, gesture);
    // Delay commit slightly so a horizontal drag can become a pan instead
    gesture.commitTimer = window.setTimeout(() => {
      if (!gestures.has(e.pointerId) || gesture.panning || gesture.armed) return;
      if (Number.isFinite(midi)) playDown(midi, gesture);
    }, 45);
  });

  piano.addEventListener("pointermove", (e) => {
    const g = gestures.get(e.pointerId);
    if (!g) return;
    const dx = e.clientX - g.lastX;
    g.lastX = e.clientX;
    const totalDx = e.clientX - g.startX;
    const totalDy = e.clientY - g.startY;

    if (!g.panning && !g.armed) {
      if (Math.abs(totalDx) >= PAN_THRESHOLD_PX && Math.abs(totalDx) > Math.abs(totalDy)) {
        clearTimeout(g.commitTimer);
        enterPan(g, totalDx);
        return;
      }
      if (Math.abs(totalDy) >= PAN_THRESHOLD_PX || Math.abs(totalDx) + Math.abs(totalDy) > 0) {
        // Vertical / small motion — commit the note under the finger
        if (!g.armed) {
          clearTimeout(g.commitTimer);
          const midi = midiFromPoint(e.clientX, e.clientY) ?? Number(e.target.closest?.("[data-midi]")?.dataset?.midi);
          if (Number.isFinite(midi)) playDown(midi, g);
        }
      }
      return;
    }

    if (g.panning) {
      const scroll = pianoScrollEl();
      if (scroll) scroll.scrollLeft -= dx;
      return;
    }

    const midi = midiFromPoint(e.clientX, e.clientY);
    const prev = g.midi;
    if (midi != null && midi !== prev) {
      playUp(g);
      playDown(midi, g);
    }
  });

  const end = (e) => {
    const g = gestures.get(e.pointerId);
    if (!g) return;
    clearTimeout(g.commitTimer);
    if (!g.armed && !g.panning) {
      const midi = Number(e.target.closest?.("[data-midi]")?.dataset?.midi);
      if (Number.isFinite(midi)) playDown(midi, g);
    }
    if (g.armed) playUp(g);
    gestures.delete(e.pointerId);
  };

  piano.addEventListener("pointerup", end);
  piano.addEventListener("pointercancel", end);
  piano.addEventListener("lostpointercapture", end);
}

function updateNowPlaying(midi) {
  setVectorLabel($("np-note"), noteLabel(midi), "display");
  const root = state.mode === "warmup" ? state.warmupRoot : state.harmonyRoot;
  setVectorLabel($("np-solfege"), solfegeFromRoot(midi, root), "solfege");
}

function keyExists(midi) {
  return Boolean(document.querySelector(`.piano [data-midi="${midi}"]`));
}

function partLetter(part) {
  if (!part) return "?";
  if (part === "Soprano") return "S";
  if (part === "Alto") return "A";
  if (part === "Tenor") return "T";
  if (part === "Bass") return "B";
  return part.charAt(0).toUpperCase();
}

function updateRangeCues(tones = []) {
  const left = $("range-cue-left");
  const right = $("range-cue-right");
  if (!left || !right) return;

  if (!tones.length || state.mode !== "harmony") {
    left.hidden = true;
    right.hidden = true;
    left.replaceChildren();
    right.replaceChildren();
    left.dataset.targetMidi = "";
    right.dataset.targetMidi = "";
    return;
  }

  const scroll = pianoScrollEl();
  const midX = scroll ? scroll.scrollLeft + scroll.clientWidth / 2 : 0;
  const below = [];
  const above = [];

  tones.forEach((t) => {
    if (!keyExists(t.midi)) return;
    if (isMidiInViewport(t.midi)) return;
    const key = document.querySelector(`.piano [data-midi="${t.midi}"]`);
    if (!key) return;
    if (key.offsetLeft + key.offsetWidth / 2 < midX) below.push(t);
    else above.push(t);
  });

  const paintCue = (btn, list, side) => {
    if (!list.length) {
      btn.hidden = true;
      btn.replaceChildren();
      btn.dataset.targetMidi = "";
      return;
    }
    btn.hidden = false;
    const letters = [...new Set(list.map((t) => partLetter(t.part)))].join("");
    const label = side === "left" ? `‹ ${letters}` : `${letters} ›`;
    setVectorLabel(btn, label, "chip");
    btn.dataset.side = side;
    // Aim for the farthest off-screen tone in that direction
    const target = list.reduce((best, t) => {
      if (!best) return t;
      return side === "left" ? (t.midi < best.midi ? t : best) : t.midi > best.midi ? t : best;
    }, null);
    btn.dataset.targetMidi = target ? String(target.midi) : "";
  };

  paintCue(left, below, "left");
  paintCue(right, above, "right");
}

function clearGuides() {
  document.querySelectorAll(".piano [data-midi]").forEach((el) => {
    el.classList.remove(
      "guide-root",
      "guide-next",
      "guide-path",
      "guide-3",
      "guide-5",
      "guide-7",
      "guide-bass"
    );
  });
}

function markMidi(midi, className) {
  document.querySelector(`.piano [data-midi="${midi}"]`)?.classList.add(className);
}

function refreshGuides() {
  clearGuides();
  if (state.mode === "warmup" && state.warmupRoot != null) {
    const pattern = EXERCISES[state.exercise].pattern;
    const midis = pattern.map((semi) => state.warmupRoot + semi);
    if (state.warmupPlaying) {
      midis.forEach((m, i) => {
        if (i === state.warmupStep) markMidi(m, "guide-next");
        else markMidi(m, i === 0 ? "guide-root" : "guide-path");
      });
    } else {
      midis.forEach((m, i) => markMidi(m, i === 0 ? "guide-root" : "guide-path"));
    }
    markMidi(state.warmupRoot, "guide-root");
    updateRangeCues([]);
  } else if (state.mode === "harmony" && state.harmonyRoot != null) {
    const tones = getHarmonyTones(state.harmonyRoot);
    tones.forEach((t, i) => {
      markMidi(t.midi, ROLE_CLASSES[Math.min(i, ROLE_CLASSES.length - 1)]);
      if (t.part === "Bass") markMidi(t.midi, "guide-bass");
    });
    updateRangeCues(tones);
  } else {
    updateRangeCues([]);
  }
}

function onKeyDown(midi) {
  if (state.mode === "harmony" && state.syncPlay) {
    handleHarmonyKey(midi);
    playSyncChord(midi);
    return;
  }

  playNote(midi);
  updateNowPlaying(midi);

  if (state.mode === "warmup") {
    handleWarmupKey(midi);
  } else if (state.mode === "harmony") {
    handleHarmonyKey(midi);
  }
}

function onKeyUp(midi) {
  if (state.mode === "harmony" && state.syncPlay && syncHeld.has(midi)) {
    releaseSyncChord(midi);
    return;
  }
  if (!sustainOn) releaseNote(midi);
}

function playSyncChord(rootMidi) {
  // Drop any previous sync stack from another root so glissando stays clean
  for (const prev of [...syncHeld.keys()]) {
    if (prev !== rootMidi) releaseSyncChord(prev, true);
  }

  const tones = getHarmonyTones(rootMidi);
  const midis = [...new Set(tones.map((t) => t.midi))];
  syncHeld.set(rootMidi, midis);

  for (const m of midis) {
    playNote(m, { velocity: m === rootMidi ? 0.85 : 0.62 });
    document.querySelector(`.piano [data-midi="${m}"]`)?.classList.add("active");
  }
  updateNowPlaying(rootMidi);
  setVectorLabel($("np-solfege"), "chord", "solfege");
}

function releaseSyncChord(rootMidi, immediate = false) {
  const midis = syncHeld.get(rootMidi);
  if (!midis) return;
  syncHeld.delete(rootMidi);

  for (const m of midis) {
    document.querySelector(`.piano [data-midi="${m}"]`)?.classList.remove("active");
    // Keep sounding if another held root still includes this tone
    const stillNeeded = [...syncHeld.values()].some((list) => list.includes(m));
    if (stillNeeded) continue;
    if (immediate) stopNote(m, true);
    else if (!sustainOn) releaseNote(m);
  }
}

/* ---------- Warmups ---------- */

function selectWarmupRoot(midi) {
  state.warmupRoot = midi;
  state.warmupStep = 0;
  state.warmupActive = true;
  const ex = EXERCISES[state.exercise];
  setVectorLabel($("warmup-title"), `${ex.name} from ${noteLabel(midi)}`, "title");
  setVectorBody(
    $("warmup-body"),
    `Tap ${noteLabel(midi)} again to play this set`
  );
  refreshGuides();
}

function handleWarmupKey(midi) {
  if (state.warmupPlaying) return;

  // First tap, or a different key: select / switch starting pitch
  if (state.warmupRoot == null || midi !== state.warmupRoot) {
    selectWarmupRoot(midi);
    return;
  }

  // Same key again: confirm and play the set
  demoWarmup();
}

function resetWarmup() {
  state.warmupRoot = null;
  state.warmupStep = 0;
  state.warmupActive = false;
  state.warmupPlaying = false;
  setVectorLabel($("warmup-title"), "Choose a root", "title");
  setVectorBody(
    $("warmup-body"),
    "Tap a key to choose the starting pitch, then tap it again to play."
  );
  refreshGuides();
}

async function demoWarmup() {
  if (state.warmupRoot == null || state.warmupPlaying) return;
  const pattern = EXERCISES[state.exercise].pattern;
  const root = state.warmupRoot;
  const peakIdx = patternPeakIndex(pattern);
  const beatMs = 480; // moderate practice tempo (~125 bpm)
  state.warmupPlaying = true;
  setVectorBody($("warmup-body"), "Playing set…");

  // Pianist puts the pedal down for a legato phrase
  setPedal(true, { auto: true });

  let aborted = false;
  let pedalStillDown = true;
  for (let i = 0; i < pattern.length; i++) {
    if (state.warmupRoot !== root || state.mode !== "warmup") {
      aborted = true;
      break;
    }

    // Clear & re-take pedal at the phrase peak (breath at the top)
    if (i === peakIdx && i > 0 && i < pattern.length - 1) {
      setPedal(false, { auto: true, phraseClear: true });
      await sleep(55);
      if (state.warmupRoot !== root || state.mode !== "warmup") {
        aborted = true;
        break;
      }
      setPedal(true, { auto: true });
    }

    state.warmupStep = i;
    refreshGuides();
    const m = root + pattern[i];
    const isLast = i === pattern.length - 1;
    const velocity = warmupVelocity(i, pattern.length, peakIdx);
    updateNowPlaying(m);

    // Under pedal: tones overlap. Final rings ~4 beats with a natural fade.
    playNote(m, { velocity });
    if (isLast) {
      // Hold with pedal, then lift so the tone fades away across 4 beats
      await sleep(beatMs * 2.75);
      setPedal(false, { auto: true });
      pedalStillDown = false;
      await sleep(beatMs * 1.25);
    } else {
      const step =
        i >= pattern.length - 3 ? beatMs * (i === pattern.length - 2 ? 1.25 : 1.1) : beatMs;
      await sleep(step);
    }
  }

  // Safety: lift auto-pedal if we aborted mid-phrase
  if (pedalStillDown) setPedal(false, { auto: true });
  if (aborted) releaseAllVoices({ immediate: false });

  state.warmupPlaying = false;
  state.warmupStep = 0;
  refreshGuides();

  if (state.mode === "warmup" && state.warmupRoot === root) {
    setVectorBody(
      $("warmup-body"),
      `Done. Tap ${noteLabel(root)} again to replay, or another key to switch pitch.`
    );
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- Harmony ---------- */

function getHarmonyTones(rootMidi) {
  const intervals = QUALITY_INTERVALS[state.quality];
  if (state.voicing === "triad" || state.voicing === "close") {
    return intervals.map((semi, i) => ({
      midi: rootMidi + semi,
      role: ROLE_LABELS[i] || `+${semi}`,
      part: ROLE_LABELS[i] || "Tone",
    }));
  }
  // SATB: spread voicing typical choir placement
  // Bass = root (or drop octave if root is high)
  // Tenor = 5th (below middle if needed)
  // Alto = 3rd
  // Soprano = root or 5th up octave
  const root = rootMidi;
  let bass = root;
  if (bass > 55) bass -= 12;
  const third = root + intervals[1];
  const fifth = root + intervals[2];
  let tenor = fifth;
  if (tenor - bass > 12) tenor -= 12;
  if (tenor < bass) tenor += 12;
  let alto = third;
  if (alto < tenor) alto += 12;
  let soprano = root + 12;
  if (intervals[3] != null) {
    // add 7th to alto/tenor area for dom7
    alto = root + intervals[3];
    if (alto < tenor) alto += 12;
    soprano = root + 12;
  }
  if (soprano < alto) soprano += 12;

  return [
    { midi: bass, role: "Root", part: "Bass" },
    { midi: tenor, role: "5th", part: "Tenor" },
    { midi: alto, role: intervals[3] != null ? "7th" : "3rd", part: "Alto" },
    { midi: soprano, role: "Root/8ve", part: "Soprano" },
  ];
}

function updateHarmonyBodyHint() {
  if (state.syncPlay) {
    setVectorBody($("harmony-body"), "Each key plays the full harmony together. Lift to release.");
    return;
  }
  setVectorBody(
    $("harmony-body"),
    state.voicing === "satb"
      ? "SATB parts highlighted — tap Hear chord to stack them."
      : "Chord tones highlighted on the keys."
  );
}

function handleHarmonyKey(midi) {
  state.harmonyRoot = midi;
  $("harmony-hear").disabled = false;
  $("harmony-clear").disabled = false;
  const q = state.quality;
  const tones = getHarmonyTones(midi);
  setVectorLabel(
    $("harmony-title"),
    `${noteLabel(midi)} ${QUALITY_TITLE[q] || q}`,
    "title"
  );
  updateHarmonyBodyHint();

  const list = $("part-list");
  list.hidden = false;
  list.innerHTML = "";
  tones.forEach((t, i) => {
    const color = ["var(--guide-root)", "var(--guide-third)", "var(--guide-fifth)", "var(--guide-seventh)"][
      Math.min(i, 3)
    ];
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "part-name";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = color;
    name.appendChild(swatch);
    const nameLabel = document.createElement("span");
    setVectorLabel(nameLabel, t.part.toUpperCase(), "partName");
    name.appendChild(nameLabel);
    const note = document.createElement("span");
    note.className = "part-note";
    setVectorLabel(note, `${noteLabel(t.midi)} · ${t.role}`, "partNote");
    li.appendChild(name);
    li.appendChild(note);
    list.appendChild(li);
  });
  refreshGuides();
}

function clearHarmony() {
  for (const root of [...syncHeld.keys()]) releaseSyncChord(root, true);
  state.harmonyRoot = null;
  $("harmony-hear").disabled = true;
  $("harmony-clear").disabled = true;
  setVectorLabel($("harmony-title"), "Play a root", "title");
  setVectorBody(
    $("harmony-body"),
    state.syncPlay
      ? "Tap any key — the full chord sounds with it."
      : "Highlighted keys are your harmony parts."
  );
  $("part-list").hidden = true;
  $("part-list").innerHTML = "";
  refreshGuides();
}

async function hearHarmony() {
  if (state.harmonyRoot == null) return;
  const tones = getHarmonyTones(state.harmonyRoot);
  $("harmony-hear").disabled = true;
  // arpeggiate then sustain stack
  for (const t of tones) {
    playNote(t.midi, { duration: 0.55, velocity: 0.7 });
    updateNowPlaying(t.midi);
    await sleep(180);
  }
  await sleep(200);
  stopAll();
  ensureAudio();
  for (const t of tones) {
    playNote(t.midi, { velocity: 0.55 });
  }
  await sleep(1200);
  for (const t of tones) releaseNote(t.midi);
  $("harmony-hear").disabled = false;
}

/* ---------- Mode toggles ---------- */

function setMode(mode) {
  const next = state.mode === mode ? null : mode;
  state.mode = next;

  $("warmup-toggle").setAttribute("aria-pressed", String(next === "warmup"));
  $("harmony-toggle").setAttribute("aria-pressed", String(next === "harmony"));

  $("warmup-panel").hidden = next !== "warmup";
  $("harmony-panel").hidden = next !== "harmony";
  $("app")?.classList.toggle("has-panel", next != null);

  if (next !== "warmup") {
    state.warmupPlaying = false;
    if (pedalAutoEngaged) setPedal(false, { auto: true });
  }
  if (next === null) {
    clearGuides();
  } else {
    refreshGuides();
  }

  if (next !== "harmony") {
    for (const root of [...syncHeld.keys()]) releaseSyncChord(root, true);
  }

  if (next === "warmup" && state.warmupRoot == null) {
    resetWarmup();
  }
  if (next === "harmony" && state.harmonyRoot == null) {
    clearHarmony();
  }
}

function bindUI() {
  $("warmup-toggle").addEventListener("click", () => {
    ensureAudio();
    setMode("warmup");
  });
  $("harmony-toggle").addEventListener("click", () => {
    ensureAudio();
    setMode("harmony");
  });
  $("warmup-close").addEventListener("click", () => setMode(null));
  $("harmony-close").addEventListener("click", () => setMode(null));

  $("sustain-btn").addEventListener("click", () => {
    // Manual pedal cancels any auto-pedal bookkeeping
    pedalAutoEngaged = false;
    setPedal(!sustainOn);
  });

  $("oct-down").addEventListener("click", () => scrollByOctave(-1));
  $("oct-up").addEventListener("click", () => scrollByOctave(1));

  document.querySelectorAll("#warmup-exercises .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#warmup-exercises .chip").forEach((c) => {
        c.classList.remove("active");
        c.setAttribute("aria-selected", "false");
      });
      chip.classList.add("active");
      chip.setAttribute("aria-selected", "true");
      state.exercise = chip.dataset.exercise;
      if (state.warmupRoot != null) {
        state.warmupStep = 0;
        const ex = EXERCISES[state.exercise];
        setVectorLabel($("warmup-title"), `${ex.name} from ${noteLabel(state.warmupRoot)}`, "title");
        setVectorBody(
          $("warmup-body"),
          `Tap ${noteLabel(state.warmupRoot)} again to play this set`
        );
        refreshGuides();
      }
    });
  });

  const voiceSelect = $("voice-select");
  if (voiceSelect) {
    voiceSelect.value = state.instrument;
    voiceSelect.addEventListener("change", () => {
      const next = voiceSelect.value;
      if (!INSTRUMENTS[next]) return;
      state.instrument = next;
      releaseAllVoices({ immediate: true });
      ensureAudio();
      if (next === "piano" && state.audioUnlocked) preloadPianoSamples();
    });
  }

  const scrollCueTarget = (btn) => {
    const midi = Number(btn?.dataset?.targetMidi);
    if (Number.isFinite(midi)) scrollMidiIntoView(midi);
    else scrollByOctave(btn?.dataset?.side === "left" ? -1 : 1);
  };

  $("range-cue-left")?.addEventListener("click", (e) => scrollCueTarget(e.currentTarget));
  $("range-cue-right")?.addEventListener("click", (e) => scrollCueTarget(e.currentTarget));

  // Hear set / Reset removed — tap root twice to play the set

  document.querySelectorAll("#quality-chips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#quality-chips .chip").forEach((c) => {
        c.classList.remove("active");
        c.setAttribute("aria-selected", "false");
      });
      chip.classList.add("active");
      chip.setAttribute("aria-selected", "true");
      state.quality = chip.dataset.quality;
      if (state.harmonyRoot != null) handleHarmonyKey(state.harmonyRoot);
    });
  });

  document.querySelectorAll("#voicing-chips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#voicing-chips .chip").forEach((c) => {
        c.classList.remove("active");
        c.setAttribute("aria-selected", "false");
      });
      chip.classList.add("active");
      chip.setAttribute("aria-selected", "true");
      state.voicing = chip.dataset.voicing;
      if (state.harmonyRoot != null) handleHarmonyKey(state.harmonyRoot);
    });
  });

  $("harmony-hear").addEventListener("click", () => hearHarmony());
  $("harmony-clear").addEventListener("click", () => clearHarmony());

  $("harmony-sync-toggle").addEventListener("click", () => {
    state.syncPlay = !state.syncPlay;
    $("harmony-sync-toggle").setAttribute("aria-pressed", String(state.syncPlay));
    if (!state.syncPlay) {
      for (const root of [...syncHeld.keys()]) releaseSyncChord(root, true);
    }
    if (state.harmonyRoot != null) updateHarmonyBodyHint();
    else {
      setVectorBody(
        $("harmony-body"),
        state.syncPlay
          ? "Tap any key — the full chord sounds with it."
          : "Highlighted keys are your harmony parts."
      );
    }
  });

  // Block iOS text selection / Look Up / callout menus on the app shell
  const app = $("app");
  const block = (e) => e.preventDefault();
  app.addEventListener("contextmenu", block);
  app.addEventListener("selectstart", block);
  app.addEventListener("gesturestart", block, { passive: false });
  app.addEventListener("gesturechange", block, { passive: false });

  // Prevent accidental double-tap zoom on the shell (esp. when touch-action was overridden)
  let lastTapAt = 0;
  app.addEventListener(
    "touchend",
    (e) => {
      const now = Date.now();
      if (now - lastTapAt < 300) e.preventDefault();
      lastTapAt = now;
    },
    { passive: false }
  );

  // Unlock audio on first gesture
  const unlock = () => ensureAudio();
  window.addEventListener("pointerdown", unlock, { once: false });
  window.addEventListener("keydown", unlock, { once: false });

  bindComputerKeyboard();
  window.addEventListener("resize", () => {
    applyDesktopLayout();
    if (state.mode === "harmony" && state.harmonyRoot != null) {
      updateRangeCues(getHarmonyTones(state.harmonyRoot));
    }
  });
}

function midiFromComputerKey(key) {
  const offset = COMPUTER_KEY_OFFSETS[key];
  if (offset == null) return null;
  const baseC = leftmostVisibleWhiteMidi();
  const midi = baseC + offset;
  const whites = whiteMidiList();
  const lo = whites[0];
  const hi = whites[whites.length - 1] + 1;
  if (midi < lo || midi > hi) return null;
  return keyExists(midi) ? midi : null;
}

function setKeyVisual(midi, on) {
  document.querySelector(`.piano [data-midi="${midi}"]`)?.classList.toggle("active", on);
}

function bindComputerKeyboard() {
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = e.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (e.code === "Space") {
      e.preventDefault();
      if (e.repeat) return;
      pedalAutoEngaged = false;
      setPedal(!sustainOn);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (!e.repeat) scrollByOctave(-1);
      return;
    }
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (!e.repeat) scrollByOctave(1);
      return;
    }

    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const midi = midiFromComputerKey(key);
    if (midi == null) return;
    e.preventDefault();
    if (pressedComputerKeys.has(key)) return;
    pressedComputerKeys.add(key);
    ensureAudio();
    setKeyVisual(midi, true);
    onKeyDown(midi);
  });

  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      e.preventDefault();
      return;
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!pressedComputerKeys.has(key)) return;
    pressedComputerKeys.delete(key);
    const midi = midiFromComputerKey(key);
    if (midi == null) return;
    setKeyVisual(midi, false);
    onKeyUp(midi);
  });
}

function applyDesktopLayout() {
  const desktop = window.matchMedia("(min-width: 700px)").matches;
  state.isDesktop = desktop;
  state.whiteCount = RANGE_WHITE_COUNT;
  state.rangeStartMidi = RANGE_START_MIDI;

  updateVisibleRangeLabel();

  const hint = $("desk-keys-hint");
  if (hint) {
    hint.hidden = true;
    if (desktop) {
      setVectorLabel(
        hint,
        "Computer keys  A–L  ·  blacks W E T Y U  ·  Space pedal  ·  ← → scroll",
        "hint"
      );
    }
  }
}

function paintStaticLabels() {
  setVectorLabel($("brand-label"), "Voix", "brand");
  setVectorLabel($("sustain-btn"), "PEDAL", "pedal");
  setVectorLabel($("np-note"), "—", "display");
  setVectorLabel($("np-solfege"), " ", "solfege");

  setVectorLabel($("warmup-name"), "Warmups", "modeName");
  setVectorLabel($("harmony-name"), "Harmony", "modeName");

  setVectorLabel($("warmup-heading"), "Warmup set", "title");
  setVectorLabel($("warmup-close"), "Close", "close");
  setVectorLabel($("warmup-title"), "Choose a root", "title");

  setVectorLabel($("harmony-heading"), "Harmony finder", "title");
  setVectorLabel($("harmony-close"), "Close", "close");
  setVectorLabel($("sync-name"), "Play chord on key", "syncName");
  setVectorLabel($("harmony-title"), "Play a root", "title");

  document.querySelectorAll("[data-label]").forEach((el) => {
    const style = el.classList.contains("btn") ? "button" : "chip";
    setVectorLabel(el, el.dataset.label, style);
  });
}

function init() {
  applyDesktopLayout();
  paintStaticLabels();
  bindUI();
  setPedal(true);
  renderPiano();
  applyDesktopLayout();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* offline cache optional */
    });
  }
}

init();
