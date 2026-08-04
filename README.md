# Voix — Choir Practice Piano

A phone-first web piano for choir rehearsal. The keyboard is always there; **Warmups** and **Harmony** toggle on as practice overlays.

## Features

- **Piano** — Touch or click keyboard with acoustic grand piano samples (Web Audio). On desktop: wider range, computer-key playing (A–L), Space for pedal, ← → for octave. On phone: octave shift and sustain pedal.

- **Warmups** (toggle) — Pick an opening set and vowel tone, tap a starting pitch, then tap the same key again to play the set. Tap another key to switch pitch and confirm again.
- **Harmony** (toggle) — Play a root; Voix highlights chord tones (major / minor / dom7 / sus4) as a triad, close voicing, or SATB parts. Hear the stacked chord. Turn on **Play chord on key** so each keypress sounds the full harmony together.

## Run locally

Any static server works. From this folder:

```bash
python3 -m http.server 5173
```

Open `http://localhost:5173` on your phone (same network) or in a mobile viewport.

Add to Home Screen for a standalone app feel (`manifest.json` included).

## Stack

Static HTML / CSS / JS — no build step. Designed for mobile Safari and Chrome.
