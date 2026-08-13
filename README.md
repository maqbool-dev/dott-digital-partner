# Dott — desk companion

An always-on animated desktop companion that reacts to what you're doing.
Cross-platform (macOS + Windows), built on Electron.

See [EXECUTION-PLAN.md](EXECUTION-PLAN.md) for the roadmap and
the architecture decisions, measurements and trade-offs behind it.

Status: **M3 — overlay engine, typing cadence, and Spotify reactivity.** Default size is 170px tall;
change it from the menu-bar icon or with `Cmd/Ctrl + scroll`.

## Run it from source

```bash
npm install
npm run dev
```

If the app fails to launch with `Error: Electron uninstall`, npm declined to run
Electron's install script. Fetch the binary explicitly, once:

```bash
npm run electron:binary
```

Dott appears bottom-right. Drag him anywhere, `Cmd/Ctrl + scroll` over him to
resize, and use the menu-bar icon for size presets, character selection, and a
**Preview state** submenu that forces any animation for art review.
`Cmd/Ctrl+Shift+D` hides and shows him.

## Build a real app

```bash
npm run dist:mac     # -> release/Dott-0.1.0-arm64.dmg
npm run dist:win     # -> release/Dott-0.1.0-x64-setup.exe
npm run dist         # both targets for the current platform
```

Each platform's installer must be built on that platform — a macOS machine
cannot produce a signed Windows build, and vice versa. That's what the CI
matrix is for.

Verified: the packaged macOS app renders all five states, keeps the correct
window flags, and idles at **97.8MB** — 8MB above the dev-mode figure, and
still well inside the 150MB target. `dmg` is 118MB; the `.app` is 284MB
unpacked, essentially all Electron framework.

### Two gotchas

**A space in the project path breaks native rebuilds.** `@electron/rebuild`
fails with *"Attempting to build a module with a space in the path"*. Harmless
here — `uiohook-napi` ships N-API prebuilds, so nothing needs compiling and the
build completes — but it will bite anyone who adds a dependency that does need
compiling. Clone into a path with no spaces.

**Unsigned builds are for local use only.** `dist:mac` produces an unsigned,
un-notarized app: macOS Gatekeeper will refuse to open it normally
(right-click → Open, once, to bypass). Windows will show a SmartScreen warning.
Signing is M4 — see [EXECUTION-PLAN.md](EXECUTION-PLAN.md) §7. It matters more
than usual here, because an unsigned binary containing a keyboard hook is close
to the textbook heuristic for a keylogger.

## Where settings live

Both integrations need a value hand-edited into `config.json`. Easiest route:
**menu-bar icon → Edit config file…**, which opens whichever file the running
instance actually reads.

The path depends on how Dott was launched, because Electron derives it from the
app name:

| How you launched it | macOS | Windows |
|---|---|---|
| Packaged app | `~/Library/Application Support/Dott/config.json` | `%APPDATA%\Dott\config.json` |
| `npm run dev` / `preview` | `~/Library/Application Support/dott/config.json` | `%APPDATA%\dott\config.json` |

Note the capitalisation — `Dott` vs `dott`. Editing one has no effect on the
other, which is an easy hour to lose.

The file is only written once something changes, so a fresh install may not have
one yet; "Edit config file…" creates it with defaults first.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Run with HMR |
| `npm run build` | Production build into `out/` |
| `npm run preview` | Run the production build |
| `npm test` | Unit tests (state machine, manifest, cadence, PKCE, Spotify) |
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

Renders arrive as stills, sometimes with a studio backdrop and sometimes
already cut out. Two stages:

1. **`tools/cutout.py`** — one-time art prep, run manually when new renders
   land. Border-seeded flood fill removes the backdrop, or `--keep-alpha`
   trusts the source's own alpha for art cut out by an external tool. Either
   way, frames belonging to one state are cropped to a **shared** canvas;
   cropping each to its own bounding box is what makes a sprite jitter as it
   cycles, and it bites just as hard with externally-supplied cutouts, since
   each file may have been exported with different margins.
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

Window flags and rendering are verified on both OSes by the CI matrix. The
platform-specific decisions behind that:

- **Transparent windows can't be natively resized on Windows.** `resizable` is
  `false` and every resize goes through `setBounds()`, on both platforms, to
  keep one code path rather than two.
- **`focusable: false`** so the overlay never steals keyboard focus from your
  editor. This was the main Windows risk — some Electron versions have treated
  it as "receives no input at all" — and CI shows the flag applied identically
  on both, with the sprite rendering normally.
- **macOS uses the `screen-saver` always-on-top level**, plus
  `setVisibleOnAllWorkspaces`; the default `floating` level loses to too many
  things.

Still only exercised by a human on macOS: dragging, wheel-resize, hit-region
click-through, and tray interaction. CI asserts the flags, not the feel.

## Licensing

**Not yet licensed** — a public repo with no `LICENSE` is all-rights-reserved,
which is the deliberate safe default until the split is decided.

The intent is two licences, because the code and the character are different
things: something permissive for `src/` and `tools/`, and something more
restrictive for `characters/` so Dott's likeness isn't given away irrevocably.
See [EXECUTION-PLAN.md](EXECUTION-PLAN.md) §10.

## Typing reactivity (M2)

Dott can animate faster when you type faster. **Off by default**, opt-in from
the menu-bar icon.

### What it records

Only the **time** of each keystroke. Never which keys.

That is not a promise you have to take on trust — it's checkable. The keyboard
hook runs in its own process whose entire source is
[src/main/typing-hook.ts](src/main/typing-hook.ts), a few dozen lines, and the
only message it can send is `{ t: <milliseconds> }`. Its keydown handler
doesn't even take the event parameter. No characters, no modifiers, no window
titles; nothing written to disk, nothing sent anywhere.

The rate is bucketed into `calm` / `fast` by a trailing-window counter with
hysteresis ([src/shared/cadence.ts](src/shared/cadence.ts)) — 360 keystrokes
per minute to enter `fast`, 260 to leave it, `idle` after 2.5s of silence. The
gap between the two thresholds is what stops the animation flickering when
your speed sits near the boundary.

### Why a separate process

Three reasons, and only the first is about privacy:

1. A crash in the native hook degrades Dott to `idle` instead of taking the app
   down — the reliability NFR, demonstrated rather than assumed (see below).
2. The privacy claim becomes auditable in about thirty seconds.
3. The component antivirus heuristics care about is isolated, so it can be
   replaced or signed separately without touching the app.

### macOS permission

macOS requires **Input Monitoring**. Dott explains what it captures *before*
triggering the system prompt — a cold permission dialog asking for keyboard
access on behalf of a cartoon character deserves to be refused.

To grant it: System Settings → Privacy & Security → Input Monitoring → add the
app (in development that is `node_modules/electron/dist/Electron.app`), then
re-tick the toggle. Revoking it at any time just returns Dott to `idle`.

Without the grant, the hook reports cleanly and the tray reads
**"Typing reactivity — needs permission"**. Observed output:

```
hook_run [1405]: Accessibility API is disabled!
[typing] hook reported: Failed to enable access for assistive devices.
[selftest] ... 5 states captured, 4 processes    <- app unaffected
```

## Spotify reactivity (M3)

Dott puts headphones on while something is playing. **Off by default.**

### One-time setup

Spotify requires each installation to use its own app credentials — there is no
shared key an open-source project can ship, so this can't be avoided:

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Add this exact redirect URI: `http://127.0.0.1:8888/callback`
   (the literal `127.0.0.1` — Spotify rejects `localhost`)
3. Put the Client ID into `spotify.clientId` in `config.json`
   (`~/Library/Application Support/dott/` on macOS,
   `%APPDATA%\dott\` on Windows)
4. Tick **Spotify reactivity** in the menu bar

The tray shows `— needs setup` until step 3 is done, and offers to open the
dashboard for you.

### What it can and can't do

The only scope requested is `user-read-playback-state`. Dott can see whether
something is playing. It cannot control playback, read your library, or see
anything about your account — and there's a test asserting the scope list stays
read-only.

Auth is **Authorization Code + PKCE**, so there is no client secret. That's
required here twice over: a desktop app can't keep a secret (anyone can unpack
the binary), and this repo is public, so a secret in the source would be a
secret in every clone. The client ID is not a secret and is fine in config.

The refresh token is encrypted through the OS keystore — Keychain on macOS,
DPAPI on Windows — via Electron's `safeStorage`. If a platform can't encrypt,
Dott stores **nothing** and asks you to sign in again next launch, rather than
writing a long-lived token to a plaintext file.

### Polling

The Web API has no push channel, so this polls: **4s while playing, 30s while
stopped**, with exponential backoff to 60s on failures and `Retry-After`
honoured on a 429. Adaptive rather than fixed because a constant 4s poll would
be the largest idle cost in the app — 900 needless requests an hour while
nothing is playing.

Every failure path ends at `playing = false`, so losing the network makes Dott
go idle rather than misbehave.

## Verification status

| Area | State |
|---|---|
| Overlay, drag, resize, persistence, tray, hotkey | Verified on macOS |
| Windows window flags + rendering | **Verified in CI** — see below |
| Typing: hook spawn, failure handling, cadence maths | Verified |
| Typing: real keystrokes → animation | **Unverified** — needs Input Monitoring granted |
| Spotify: PKCE, response parsing, poll scheduling | Verified (39 unit tests) |
| Spotify: live OAuth + polling | **Unverified** — needs a client ID |
| Animation actually advances frame to frame | **Not asserted by CI** — see gap below |

### Cross-platform parity

The CI matrix runs the real app on both OSes. Both report identical window
flags — `alwaysOnTop: true`, `resizable: false`, `focusable: false`,
`hasShadow: false` — identical 188×170 bounds, and per-state opaque coverage
matching to within 0.0003. The `focusable: false` concern about Windows
swallowing input did not materialise.

### Known gap

Each state is captured once, which proves the sprite painted and the window is
transparent — but not that a multi-frame animation is *advancing*. In one run,
macOS produced byte-identical captures for `typing_calm` and `typing_fast`
while Windows produced three distinct ones. Both states can legitimately land
on the same source frame, so a single capture cannot tell a phase coincidence
from a frozen animation.

Closing this means capturing twice per state and asserting the two differ
wherever `sequence.length > 1`.
