# Dott — desk companion

An always-on animated desktop companion that reacts to what you're doing.
Cross-platform (macOS + Windows), built on Electron.

See [EXECUTION-PLAN.md](EXECUTION-PLAN.md) for the full roadmap and
[PRD-Desktop-Companion-App.md](../PRD-Desktop-Companion-App.md) for requirements.

Status: **M1 (MVP) — overlay engine complete on macOS.**

## Quick start

```bash
npm install && npm run dev
```

Dott appears bottom-right. Drag him anywhere, `Cmd/Ctrl + scroll` over him to
resize, and use the menu-bar icon for size presets, character selection, and a
**Preview state** submenu that forces any animation for art review.
`Cmd/Ctrl+Shift+D` hides and shows him.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run with HMR |
| `npm run build` | Production build into `out/` |
| `npm run preview` | Run the production build |
| `npm test` | Unit tests (state machine, manifest contract) |
| `npm run typecheck` | Typecheck main + renderer |
| `npm run assets` | Repack sprite atlases and regenerate `manifest.json` |

## Architecture

```
src/shared/     manifest schema + state machine  (pure, no OS, unit-tested)
src/main/       window, tray, config, asset protocol, self-test
src/preload/    the entire main<->renderer surface
src/overlay/    sprite player + hit region       (no framework, deliberately)
characters/     data-driven character bundles
tools/          art prep (cutout) + build (pack-sprites)
```

The engine never references a specific character. `grep -ri dott src/` returns
only the default-config value and the asset-scheme name — that's the invariant
that keeps the design workstream independent of app code.

### The character contract

`characters/<name>/character.json` is **authored**; `manifest.json` and
`atlas/*.png` are **generated** by `npm run assets` and validated by a zod
schema at load. Adding a character means adding a directory — no code change.

Animation states: `idle`, `typing_calm`, `typing_fast`, `music_reactive`,
`dragged`. All are required; a manifest missing one fails loudly at load.

Because music and typing can be true simultaneously, state is resolved by
priority — `dragged > typing_fast > typing_calm > music_reactive > idle` — with
a 250ms minimum dwell so a stray keystroke during playback doesn't snap the
animation. Drag bypasses dwell, since direct manipulation must feel immediate.

## Asset pipeline

Renders arrive as stills with a studio backdrop. Two stages:

1. **`tools/cutout.py`** — one-time art prep, run manually when new renders
   land. Border-seeded flood fill removes the backdrop. Frames belonging to one
   state are cropped to a **shared** canvas; cropping each to its own bounding
   box is what makes a sprite jitter as it cycles.
2. **`tools/pack-sprites.py`** — the build step. Normalises every frame from
   every state onto one global canvas, bottom-centre anchored, packs per-state
   atlases, de-duplicates frames used more than once in a sequence, computes
   each state's hit box, and writes `manifest.json`.

Both need Python + Pillow. **CI does not** — atlases are committed, so the
release pipeline only consumes them.

## Verification

`DOTT_SELFTEST=<dir> npm run preview` drives the companion through every state,
captures each one via `capturePage`, and writes a report with window flags,
bounds, and memory. It needs no Screen Recording permission and is the intended
body of the CI matrix smoke test.

Measured on macOS 15 (arm64, Electron 43), production build, idle:

| Metric | Target | Measured |
|---|---|---|
| Memory (`phys_footprint`, 4 processes) | <150MB | **89.6MB** |
| Idle CPU | <2–3% | **2.37% mean** (0.1% at rest) |

The Tauri decision gate from the plan (spike if idle memory >220MB) is
**closed — staying on Electron.**

Note that summing Electron's `getAppMetrics().workingSetSize` reports ~435MB for
the same process set, because it counts shared framework pages once per
process. `phys_footprint` is the number that matches Activity Monitor.

Idle CPU is duty-cycled deliberately: a CSS transform animation is
compositor-driven but not free, and leaving `breathe` running permanently cost
6.8% CPU on an idle machine. Dott now breathes once every seven seconds and
composites nothing in between.

## Platform notes

Verified on macOS. **Windows is unverified** — M0's Windows leg is outstanding.
Specific things to check there:

- `focusable: false`. Some Electron versions have treated this as "receives no
  input at all" on Windows, which would break the hit region entirely.
- Transparent windows can't be natively resized on Windows; resizing already
  goes through `setBounds()` on both platforms to keep one code path.
- Tray icon rendering and the `screen-saver` always-on-top level.

## Not yet implemented

M2 typing cadence and M3 Spotify are stubbed as disabled tray toggles — visible
so the privacy-sensitive feature is discoverable, off by default per FR-13.
There is no settings window yet; the tray covers M1's surface.
