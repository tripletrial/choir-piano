/**
 * Voix — Choir practice piano
 * Web Audio piano + toggleable Warmups & Harmony finder
 */

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
const activeVoices = new Map();

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

function solfegeFromRoot(midi, rootMidi) {
  if (rootMidi == null) return SOLFEGE[midi % 12];
  const deg = ((midi - rootMidi) % 12 + 12) % 12;
  return SOLFEGE[deg];
}

function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0.28;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === "suspended") {
    audioCtx.resume();
  }
  if (!state.audioUnlocked) {
    state.audioUnlocked = true;
    $("audio-hint")?.classList.add("hidden");
  }
}

/** Choir-friendly soft tone with slight vowel formant coloring */
function playNote(midi, { duration = null, velocity = 0.85 } = {}) {
  ensureAudio();
  const now = audioCtx.currentTime;
  const freq = midiToFreq(midi);

  stopNote(midi, true);

  const osc1 = audioCtx.createOscillator();
  const osc2 = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const filter = audioCtx.createBiquadFilter();

  osc1.type = "sine";
  osc2.type = "triangle";
  osc1.frequency.setValueAtTime(freq, now);
  osc2.frequency.setValueAtTime(freq * 2, now);
  osc2.detune.setValueAtTime(4, now);

  // Vowel-ish formant when in warmup mode
  const formants = {
    ah: 750,
    eh: 550,
    ee: 320,
    oh: 480,
    oo: 360,
  };
  filter.type = "lowpass";
  filter.frequency.value = state.mode === "warmup" ? formants[state.vowel] * 2.2 : 2200;
  filter.Q.value = state.mode === "warmup" ? 1.4 : 0.7;

  const osc2Gain = audioCtx.createGain();
  osc2Gain.gain.value = 0.18;

  osc1.connect(filter);
  osc2.connect(osc2Gain);
  osc2Gain.connect(filter);
  filter.connect(gain);
  gain.connect(masterGain);

  const peak = 0.55 * velocity;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.025);
  gain.gain.exponentialRampToValueAtTime(peak * 0.65, now + 0.12);

  osc1.start(now);
  osc2.start(now);

  const voice = { osc1, osc2, gain, filter, release: null };
  activeVoices.set(midi, voice);

  if (duration != null) {
    releaseNote(midi, now + duration);
  } else if (!sustainOn) {
    // soft natural decay for held keys handled on pointer up
  }

  return voice;
}

function releaseNote(midi, at = null) {
  const voice = activeVoices.get(midi);
  if (!voice || voice.release) return;
  ensureAudio();
  const t = at ?? audioCtx.currentTime;
  voice.release = true;
  try {
    voice.gain.gain.cancelScheduledValues(t);
    voice.gain.gain.setValueAtTime(Math.max(voice.gain.gain.value, 0.0001), t);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      voice.osc1.stop();
      voice.osc2.stop();
    } catch {
      /* ignore */
    }
    if (activeVoices.get(midi) === voice) activeVoices.delete(midi);
  }, 450);
}

function stopNote(midi, immediate = false) {
  const voice = activeVoices.get(midi);
  if (!voice) return;
  if (immediate) {
    try {
      voice.osc1.stop();
      voice.osc2.stop();
    } catch {
      /* ignore */
    }
    activeVoices.delete(midi);
    return;
  }
  releaseNote(midi);
}

function stopAll() {
  for (const midi of [...activeVoices.keys()]) {
    stopNote(midi, true);
  }
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
  $("octave-label").textContent = `${noteLabel(whiteMidis[0])} – ${endLabel}`;

  whiteMidis.forEach((midi, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "key-white";
    btn.dataset.midi = String(midi);
    btn.setAttribute("aria-label", noteLabel(midi));
    const label = document.createElement("span");
    label.className = "key-label";
    label.textContent = NOTE_NAMES[midi % 12];
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
  $("np-note").textContent = noteLabel(midi);
  const root = state.mode === "warmup" ? state.warmupRoot : state.harmonyRoot;
  $("np-solfege").textContent = solfegeFromRoot(midi, root);
  $("now-playing").querySelector(".np-label").textContent =
    state.mode === "warmup" && state.vowel ? `Sing “${state.vowel}”` : "Now sounding";
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
    midis.forEach((m, i) => {
      if (i === state.warmupStep) markMidi(m, "guide-next");
      else markMidi(m, i === 0 ? "guide-root" : "guide-path");
    });
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
  $("np-solfege").textContent = "chord";
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

function handleWarmupKey(midi) {
  if (state.warmupRoot == null) {
    state.warmupRoot = midi;
    const pattern = EXERCISES[state.exercise].pattern;
    // First tap sets the root and counts as the first step when the pattern starts on 0
    state.warmupStep = pattern[0] === 0 ? 1 : 0;
    if (state.warmupStep >= pattern.length) state.warmupStep = 0;
    state.warmupActive = true;
    $("warmup-demo").disabled = false;
    $("warmup-reset").disabled = false;
    const ex = EXERCISES[state.exercise];
    $("warmup-title").textContent = `${ex.name} from ${noteLabel(midi)}`;
    if (state.warmupStep === 0) {
      $("warmup-body").textContent = `${ex.desc} Vowel: ${state.vowel.toUpperCase()}. Follow the bright key.`;
    } else {
      const next = state.warmupRoot + pattern[state.warmupStep];
      $("warmup-body").textContent = `Next: ${noteLabel(next)} (${solfegeFromRoot(next, state.warmupRoot)}) · ${state.vowel.toUpperCase()}`;
    }
    refreshGuides();
    return;
  }

  const pattern = EXERCISES[state.exercise].pattern;
  const expected = state.warmupRoot + pattern[state.warmupStep];
  if (midi === expected) {
    state.warmupStep += 1;
    if (state.warmupStep >= pattern.length) {
      $("warmup-title").textContent = "Set complete";
      $("warmup-body").textContent = "Nice. Reset for another starting pitch, or pick a new exercise.";
      state.warmupStep = 0;
      // brief celebrate — replay root softly
      setTimeout(() => playNote(state.warmupRoot, { duration: 0.5, velocity: 0.5 }), 120);
    } else {
      const next = state.warmupRoot + pattern[state.warmupStep];
      $("warmup-body").textContent = `Next: ${noteLabel(next)} (${solfegeFromRoot(next, state.warmupRoot)}) · ${state.vowel.toUpperCase()}`;
    }
    refreshGuides();
  }
}

function resetWarmup(keepExercise = true) {
  state.warmupRoot = null;
  state.warmupStep = 0;
  state.warmupActive = false;
  $("warmup-demo").disabled = true;
  $("warmup-reset").disabled = true;
  $("warmup-title").textContent = "Choose a root";
  $("warmup-body").textContent = keepExercise
    ? "Tap any key to set your starting pitch."
    : "Tap any key to set your starting pitch.";
  refreshGuides();
}

async function demoWarmup() {
  if (state.warmupRoot == null) return;
  const pattern = EXERCISES[state.exercise].pattern;
  $("warmup-demo").disabled = true;
  for (let i = 0; i < pattern.length; i++) {
    state.warmupStep = i;
    refreshGuides();
    const m = state.warmupRoot + pattern[i];
    updateNowPlaying(m);
    playNote(m, { duration: 0.38 });
    await sleep(420);
  }
  state.warmupStep = 0;
  refreshGuides();
  $("warmup-demo").disabled = false;
  $("warmup-body").textContent = "Your turn — follow the bright key.";
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
    $("harmony-body").textContent = "Each key plays the full harmony together. Lift to release.";
    return;
  }
  $("harmony-body").textContent =
    state.voicing === "satb"
      ? "SATB parts highlighted — tap Hear chord to stack them."
      : "Chord tones highlighted on the keys.";
}

function handleHarmonyKey(midi) {
  state.harmonyRoot = midi;
  $("harmony-hear").disabled = false;
  $("harmony-clear").disabled = false;
  const q = state.quality;
  const tones = getHarmonyTones(midi);
  $("harmony-title").textContent = `${noteLabel(midi)} ${q === "dom7" ? "7" : q === "sus4" ? "sus4" : q}`;
  updateHarmonyBodyHint();

  const list = $("part-list");
  list.hidden = false;
  list.innerHTML = tones
    .map((t, i) => {
      const color = ["var(--guide-root)", "var(--guide-third)", "var(--guide-fifth)", "var(--guide-seventh)"][
        Math.min(i, 3)
      ];
      return `<li><span class="part-name"><span class="swatch" style="background:${color}"></span>${t.part}</span><span class="part-note">${noteLabel(t.midi)} · ${t.role}</span></li>`;
    })
    .join("");
  refreshGuides();
}

function clearHarmony() {
  for (const root of [...syncHeld.keys()]) releaseSyncChord(root, true);
  state.harmonyRoot = null;
  $("harmony-hear").disabled = true;
  $("harmony-clear").disabled = true;
  $("harmony-title").textContent = "Play a root";
  $("harmony-body").textContent = state.syncPlay
    ? "Tap any key — the full chord sounds with it."
    : "Highlighted keys are your harmony parts.";
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
    // keep root if switching away briefly? clear guides only
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
    $("warmup-title").textContent = "Choose a root";
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
    sustainOn = !sustainOn;
    state.sustain = sustainOn;
    $("sustain-btn").setAttribute("aria-pressed", String(sustainOn));
    if (!sustainOn) {
      for (const midi of [...activeVoices.keys()]) releaseNote(midi);
    }
  });

  $("oct-down").addEventListener("click", () => {
    if (state.baseOctave > 1) {
      state.baseOctave -= 1;
      renderPiano();
    }
  });
  $("oct-up").addEventListener("click", () => {
    if (state.baseOctave < 5) {
      state.baseOctave += 1;
      renderPiano();
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
        $("warmup-title").textContent = `${ex.name} from ${noteLabel(state.warmupRoot)}`;
        $("warmup-body").textContent = ex.desc;
        refreshGuides();
      }
    });
  });

  document.querySelectorAll("#vowel-chips .chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("#vowel-chips .chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.vowel = chip.dataset.vowel;
      if (state.warmupRoot != null) {
        $("warmup-body").textContent = `${EXERCISES[state.exercise].desc} Vowel: ${state.vowel.toUpperCase()}.`;
      }
      $("now-playing").querySelector(".np-label").textContent = `Sing “${state.vowel}”`;
    });
  });

  $("warmup-demo").addEventListener("click", () => demoWarmup());
  $("warmup-reset").addEventListener("click", () => resetWarmup());

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
      $("harmony-body").textContent = state.syncPlay
        ? "Tap any key — the full chord sounds with it."
        : "Highlighted keys are your harmony parts.";
    }
  });

  // Unlock audio on first gesture
  const unlock = () => ensureAudio();
  window.addEventListener("pointerdown", unlock, { once: false });
}

function init() {
  bindUI();
  renderPiano();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      /* offline cache optional */
    });
  }
}

init();
