# Voix — Choir Practice Piano

A phone-first web piano for choir rehearsal. The keyboard is always there; **Warmups** and **Harmony** toggle on as practice overlays.

## Features

- **Piano** — Touch keyboard with acoustic grand piano samples (Web Audio). Octave shift and sustain pedal.
- **Warmups** (toggle) — Pick an opening set (5-tone, arpeggio, siren, octave, solfege), choose a vowel tone (Ah/Eh/Ee/Oh/Oo), tap a starting pitch, then follow the highlighted path. Hear the set as a demo.
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
