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
  sus4: [0, 5, 7],
};

const ROLE_LABELS = ["Root", "3rd", "5th", "7th"];
const ROLE_CLASSES = ["guide-root", "guide-3", "guide-5", "guide-7"];

const EXERCISES = {
  five: {
    name: "5-tone scale",
    desc: "Do–Re–Mi–Fa–Sol and back. Keep the vowel steady.",
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
let sustainOn = false;
/** True when warmup playback engaged the pedal (restore afterward) */
let pedalAutoEngaged = false;
/** User pedal state before an auto-pedal passage */
let pedalUserBeforeAuto = false;
const activeVoices = new Map();

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
  baseOctave: 3,
  whiteCount: 15, // C3–C5 inclusive = 15 white keys
  mode: null, // 'warmup' | 'harmony' | null
  sustain: false,
  audioUnlocked: false,
  // warmup
  exercise: "five",
  vowel: "ah",
  warmupRoot: null,
  warmupStep: 0,
  warmupActive: false,
  warmupPlaying: false,
  // harmony
  quality: "major",
  voicing: "triad",
  harmonyRoot: null,
  syncPlay: false,
};

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

/** Grand piano sample playback; mild vowel filter in warmup mode */
function playNote(midi, { duration = null, velocity = 0.85 } = {}) {
  ensureAudio();
  const now = audioCtx.currentTime;
  stopNote(midi, true);

  const sample = nearestLoadedSample(midi);
  if (!sample) {
    // Kick off load and use a soft fallback until samples arrive
    decodeSample(midi).then((buf) => {
      if (buf && !activeVoices.has(midi)) {
        /* next press will use sample */
      }
    });
    return playFallbackTone(midi, { duration, velocity });
  }

  const source = audioCtx.createBufferSource();
  source.buffer = sample.buffer;
  source.playbackRate.value = Math.pow(2, (midi - sample.midi) / 12);

  const gain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();
  filter.type = "lowpass";

  if (state.mode === "warmup") {
    const formants = { ah: 2800, eh: 2400, ee: 3200, oh: 2000, oo: 1600 };
    filter.frequency.value = formants[state.vowel] || 2600;
    filter.Q.value = 0.7;
  } else {
    filter.frequency.value = 12000;
    filter.Q.value = 0.5;
  }

  source.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  const peak = Math.min(1, 0.95 * velocity);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(peak * 0.92, now + 0.08);

  source.start(now);

  const voice = { source, gain, filter, release: null, isSample: true };
  activeVoices.set(midi, voice);

  source.onended = () => {
    if (activeVoices.get(midi) === voice) activeVoices.delete(midi);
  };

  if (duration != null) {
    releaseNote(midi, now + duration);
  }

  // Prefetch neighbors for smoother runs
  decodeSample(midi + 1);
  decodeSample(midi - 1);

  return voice;
}

/** Soft sine fallback if samples are not loaded yet */
function playFallbackTone(midi, { duration = null, velocity = 0.85 } = {}) {
  const now = audioCtx.currentTime;
  const freq = midiToFreq(midi);
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(freq, now);
  osc.connect(gain);
  gain.connect(masterGain);
  const peak = 0.35 * velocity;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.02);
  osc.start(now);
  const voice = { source: osc, gain, release: null, isSample: false };
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
  const rel = releaseSec ?? (voice.isSample ? 0.55 : 0.35);
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
      voice.source.stop();
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
      voice.source.stop();
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
  // MIDI C for octave n is (n + 1) * 12  (C3 = 48, C4 = 60)
  const cStart = (state.baseOctave + 1) * 12;
  for (let i = 0; i < state.whiteCount; i++) {
    const octaveOffset = Math.floor(i / 7);
    const deg = i % 7;
    list.push(cStart + octaveOffset * 12 + WHITE_OFFSETS[deg]);
  }
  return list;
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
  const endLabel = noteLabel(whiteMidis[whiteMidis.length - 1]);
  setVectorLabel($("octave-label"), `${noteLabel(whiteMidis[0])} – ${endLabel}`, "octave");

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
      // Black key sits between whites that are a whole step apart
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
  refreshGuides();
}

function bindPianoPointers(piano) {
  const pressed = new Map();

  const midiFromPoint = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    const key = el.closest("[data-midi]");
    return key ? Number(key.dataset.midi) : null;
  };

  const down = (midi, pointerId) => {
    if (midi == null) return;
    pressed.set(pointerId, midi);
    const key = piano.querySelector(`[data-midi="${midi}"]`);
    key?.classList.add("active");
    onKeyDown(midi);
  };

  const up = (pointerId) => {
    const midi = pressed.get(pointerId);
    pressed.delete(pointerId);
    if (midi == null) return;
    const still = [...pressed.values()].includes(midi);
    if (!still) {
      piano.querySelector(`[data-midi="${midi}"]`)?.classList.remove("active");
      onKeyUp(midi);
    }
  };

  piano.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    piano.setPointerCapture?.(e.pointerId);
    const midi = Number(e.target.closest?.("[data-midi]")?.dataset?.midi);
    if (!Number.isFinite(midi)) return;
    down(midi, e.pointerId);
  });

  piano.addEventListener("pointermove", (e) => {
    if (!pressed.has(e.pointerId)) return;
    const midi = midiFromPoint(e.clientX, e.clientY);
    const prev = pressed.get(e.pointerId);
    if (midi != null && midi !== prev) {
      up(e.pointerId);
      down(midi, e.pointerId);
    }
  });

  const end = (e) => up(e.pointerId);
  piano.addEventListener("pointerup", end);
  piano.addEventListener("pointercancel", end);
  piano.addEventListener("lostpointercapture", end);
}

function updateNowPlaying(midi) {
  setVectorLabel($("np-note"), noteLabel(midi), "display");
  const root = state.mode === "warmup" ? state.warmupRoot : state.harmonyRoot;
  setVectorLabel($("np-solfege"), solfegeFromRoot(midi, root), "solfege");
  const label =
    state.mode === "warmup" && state.vowel ? `Sing “${state.vowel}”` : "Now sounding";
  setVectorLabel($("np-label"), label.toUpperCase(), "npLabel");
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
  }
  if (state.mode === "harmony" && state.harmonyRoot != null) {
    const tones = getHarmonyTones(state.harmonyRoot);
    tones.forEach((t, i) => {
      markMidi(t.midi, ROLE_CLASSES[Math.min(i, ROLE_CLASSES.length - 1)]);
      if (t.part === "Bass") markMidi(t.midi, "guide-bass");
    });
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
    `Tap ${noteLabel(midi)} again to play this set · ${state.vowel.toUpperCase()}`
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
  state.warmupPlaying = true;
  setVectorBody($("warmup-body"), `Playing set · sing “${state.vowel.toUpperCase()}”`);

  for (let i = 0; i < pattern.length; i++) {
    // Pitch changed or mode left mid-playback — stop
    if (state.warmupRoot !== root || state.mode !== "warmup") break;
    state.warmupStep = i;
    refreshGuides();
    const m = root + pattern[i];
    updateNowPlaying(m);
    playNote(m, { duration: 0.38 });
    await sleep(420);
  }

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
    `${noteLabel(midi)} ${q === "dom7" ? "7" : q === "sus4" ? "sus4" : q}`,
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

  $("oct-down").addEventListener("click", () => {
    if (state.baseOctave > 1) {
      state.baseOctave -= 1;
      renderPiano();
      if (state.audioUnlocked) preloadPianoSamples();
    }
  });
  $("oct-up").addEventListener("click", () => {
    if (state.baseOctave < 5) {
      state.baseOctave += 1;
      renderPiano();
      if (state.audioUnlocked) preloadPianoSamples();
    }
  });

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
          `Tap ${noteLabel(state.warmupRoot)} again to play this set · ${state.vowel.toUpperCase()}`
        );
        refreshGuides();
      }
    });
  });

  document.querySelectorAll("#vowel-chips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#vowel-chips .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.vowel = chip.dataset.vowel;
      if (state.warmupRoot != null && !state.warmupPlaying) {
        setVectorBody(
          $("warmup-body"),
          `Tap ${noteLabel(state.warmupRoot)} again to play this set · ${state.vowel.toUpperCase()}`
        );
      }
      setVectorLabel($("np-label"), `SING “${state.vowel.toUpperCase()}”`, "npLabel");
    });
  });

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

  // Unlock audio on first gesture
  const unlock = () => ensureAudio();
  window.addEventListener("pointerdown", unlock, { once: false });
}

function paintStaticLabels() {
  setVectorLabel($("brand-label"), "Voix", "brand");
  setVectorLabel($("tagline-label"), "Choir practice piano", "tagline");
  setVectorLabel($("sustain-btn"), "PEDAL", "pedal");
  setVectorLabel($("np-label"), "TAP A KEY", "npLabel");
  setVectorLabel($("np-note"), "—", "display");
  setVectorLabel($("np-solfege"), " ", "solfege");

  setVectorLabel($("warmup-name"), "Warmups", "modeName");
  setVectorLabel($("warmup-hint"), "Opening & tone sets", "modeHint");
  setVectorLabel($("harmony-name"), "Harmony", "modeName");
  setVectorLabel($("harmony-hint"), "Find chord tones", "modeHint");

  setVectorLabel($("warmup-heading"), "Warmup set", "title");
  setVectorLabel($("warmup-close"), "Close", "close");
  setVectorBody(
    $("warmup-lead"),
    "Tap a starting pitch, then tap it again to play the set.",
    "body",
    36
  );
  setVectorLabel($("tone-field-label"), "TONE", "field");
  setVectorLabel($("warmup-title"), "Choose a root", "title");
  setVectorBody(
    $("warmup-body"),
    "Tap a key to choose the starting pitch, then tap it again to play."
  );

  setVectorLabel($("harmony-heading"), "Harmony finder", "title");
  setVectorLabel($("harmony-close"), "Close", "close");
  setVectorBody($("harmony-lead"), "Play a note — Voix highlights the chord tones around it.", "body", 36);
  setVectorLabel($("sync-name"), "Play chord on key", "syncName");
  setVectorLabel($("sync-hint"), "One key sounds the full harmony together", "syncHint");
  setVectorLabel($("harmony-title"), "Play a root", "title");
  setVectorBody($("harmony-body"), "Highlighted keys are your harmony parts.");

  setVectorLabel($("audio-hint"), "Tap anywhere to load the grand piano", "hint");

  document.querySelectorAll("[data-label]").forEach((el) => {
    const style = el.classList.contains("btn") ? "button" : "chip";
    setVectorLabel(el, el.dataset.label, style);
  });
}

function init() {
  paintStaticLabels();
  bindUI();
  renderPiano();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* offline cache optional */
    });
  }
}

init();
