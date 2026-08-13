# DOTT — Execution Plan

| | |
|---|---|
| **Product** | DOTT (Digital Partner) — desktop companion platform |
| **Character #1** | `dott` — original design (orange capsule, round glasses, antenna, grey hoodie) |
| **Source PRD** | `PRD-Desktop-Companion-App.md` (working title "Buddy" → renamed **DOTT**) |
| **Owner** | Maqbool Ahmed |
| **Plan status** | v1.0 — ready to execute |
| **Date** | August 12, 2026 |

---

## 0. What changed from the PRD

Three decisions the PRD left open are now closed:

1. **Name:** "Buddy" → **DOTT**. The app is the *platform*; `dott` is the first character in it. This distinction matters — it forces the character-manifest boundary (G3) from day one instead of retrofitting it at M4.
2. **IP risk resolved.** PRD §11 flagged the Minion likeness as real legal exposure. The concept art supplied is an original design — orange/coral capsule body, round wire glasses, single bulb antenna, grey hoodie and gloves. Nothing derivative of Illumination's character. **§11's blocker is cleared**; keep the recommendation (original art only) as a standing rule for future character packs.
3. **Framework: Electron for v1.** Reasoning in §2 below. Tauri stays a measured, gated fallback rather than an open question.

Minor doc fix for the PRD: FR-8 and the Non-Goals both cite "Section 12 — Legal & IP", but Legal & IP is **Section 11** (12 is Milestones). Worth correcting so the cross-references don't rot.

---

## 1. Strategy: platform first, character second

The temptation with a desktop pet is to hardcode one character and ship fast. That produces an app that can never take a second character without a rewrite — which kills **G3** and **M4**.

The counter-move is cheap if done at the start: build the engine against a **manifest contract** and treat `dott` as the first consumer of that contract, not as the app itself. Concretely, no file in `src/` may ever contain the string `"dott"` outside of a default-config value. If a `grep -r dott src/` returns art-specific logic, the boundary has leaked.

That single rule is what makes the design workstream and the engine workstream genuinely parallel (PRD §9), rather than nominally parallel.

---

## 2. Framework decision: Electron

**Recommendation: Electron 3x + TypeScript for v1.** This confirms the PRD's lean, and here is the actual decision basis rather than just "it's mature."

The overlay needs five OS-level behaviours, and Electron is the only web-tech option where all five are first-party, documented, and identical across Windows and macOS:

| Need | Electron API | Tauri v2 equivalent |
|---|---|---|
| Transparent frameless always-on-top | `BrowserWindow({transparent, frame:false, alwaysOnTop})` | Works, but macOS WebView transparency has more edge cases |
| Click-through except sprite | `setIgnoreMouseEvents(true, {forward:true})` | `set_ignore_cursor_events` — no `forward` equivalent, so hover detection needs a manual cursor poll |
| Tray / menu bar | `Tray` | plugin-tray (fine) |
| Global hotkey | `globalShortcut` | plugin-global-shortcut (fine) |
| Encrypted token storage | `safeStorage` (Keychain / DPAPI) | plugin-stronghold or keyring crate |

The deciding line is row 2. `{forward: true}` is what makes precise hit-region click-through a ~20-line problem in Electron and a cursor-polling loop in Tauri — and a polling loop is exactly what the <2–3% idle CPU target (NFR) cannot afford.

**Trade-off accepted:** memory. The PRD targets <150MB idle, which is tight for Electron. §5 describes the specific measures that make it reachable.

**Tauri gate — not an open question, a threshold.** At the end of M1, measure idle RSS. If it exceeds **220MB**, spend one week on a Tauri spike; below that, stay on Electron and never revisit. Writing the number down now prevents this from becoming a recurring debate, and there is no Rust toolchain installed on this machine today, so a Tauri pivot has real setup cost attached.

> **GATE CLOSED — staying on Electron.** Measured on the M1 build (macOS 15, arm64, Electron 43, production, idle): **89.6MB** `phys_footprint` across 4 processes, against a 220MB threshold and a 150MB NFR target. Idle CPU **2.37% mean**, inside the 2–3% budget.
>
> One measurement trap worth recording: summing Electron's own `getAppMetrics().workingSetSize` reports **435MB** for the same processes, because it counts shared framework pages once per process. That number would have failed the gate and triggered a pointless week of Rust. `phys_footprint` — what Activity Monitor calls Memory — is the metric this gate is defined against.

### Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron + TypeScript | Above |
| Build | `electron-vite` | Fast HMR on the renderer, TS for main/preload, sane out of the box |
| Overlay renderer | **Zero framework** — vanilla TS + CSS | The overlay is one animated sprite. React would add MBs and a reconciler to a window whose entire job is `background-position` |
| Settings window | React + Tailwind, **created on demand, destroyed on close** | Settings UI benefits from a framework; idle memory shouldn't pay for it |
| Config | `electron-store` | Atomic JSON, schema validation, migrations for free |
| Secrets | `safeStorage` + encrypted blob in the store | Keychain on macOS, DPAPI on Windows — satisfies PRD §10 |
| Input hook | `uiohook-napi` in an Electron `utilityProcess` | §4.2 |
| Packaging | `electron-builder` | NSIS + DMG, notarization hooks built in |
| Updates | `electron-updater` → GitHub Releases | Matches the CI plan |
| Unit tests | Vitest | Manifest parser, cadence classifier, state machine — the pure logic |
| E2E smoke | `@playwright/test` `_electron` | Asserts window flags are actually applied on each OS |

---

## 3. Repo layout

```
dott/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # app lifecycle, single-instance lock
│   │   ├── overlay-window.ts    # transparent/AOT window + platform quirks
│   │   ├── settings-window.ts   # on-demand, destroyed on close
│   │   ├── tray.ts              # tray/menu-bar + hotkey registration
│   │   ├── config.ts            # electron-store schema + migrations
│   │   ├── state-machine.ts     # signal inputs → single animation state
│   │   └── sources/             # context providers, each independently killable
│   │       ├── typing.ts        # spawns + supervises the input utilityProcess
│   │       └── spotify.ts       # PKCE OAuth + polling
│   ├── preload/index.ts         # contextBridge — the only main↔renderer surface
│   ├── overlay/                 # renderer: sprite player, no framework
│   │   ├── main.ts
│   │   ├── sprite-player.ts     # CSS steps() animation driver
│   │   └── hit-region.ts        # mouseenter/leave → setIgnoreMouseEvents
│   ├── settings/                # renderer: React + Tailwind
│   └── shared/
│       ├── manifest.ts          # zod schema — THE contract with design
│       └── states.ts            # AnimationState union + priority table
├── characters/
│   └── dott/
│       ├── manifest.json
│       └── atlas/               # packed sprite sheets, @2x + @3x
├── tools/
│   └── pack-sprites.ts          # PNG sequence → atlas + manifest generator
├── build/                       # icons, entitlements.mac.plist, notarize.cjs
├── .github/workflows/
│   ├── ci.yml                   # PR: lint + typecheck + test
│   └── release.yml              # tag: matrix build → signed → draft Release
└── electron-builder.yml
```

---

## 4. The four hard problems

Everything else in this project is ordinary app work. These four are where the real risk sits, so each gets a decided approach rather than a menu.

### 4.1 The overlay window (M0)

The platform quirks that will otherwise eat a day each:

- **Windows: transparent windows cannot be natively resized.** Set `resizable: false` and implement resize entirely through `setBounds()` driven by the hover handle / slider. Do this from the start — discovering it at M1 means reworking the resize UX.
- **macOS: use the `'screen-saver'` always-on-top level**, plus `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})`. The default `'floating'` level loses to too many things.
- Both: `skipTaskbar: true`, `hasShadow: false`, `focusable: false`. A focusable overlay steals keyboard focus from the IDE — an instant uninstall.
- **Click-through:** window starts with `setIgnoreMouseEvents(true, {forward: true})`. `forward` keeps `mousemove` flowing to the renderer while clicks pass through. The sprite element's `mouseenter` → `setIgnoreMouseEvents(false)`; `mouseleave` → back to `true`. Hit region = the sprite's bounding box for MVP; per-pixel alpha testing only if the box feels wrong in daily use.
- **Multi-monitor:** persist position as `{displayId, xRatio, yRatio}`, not absolute pixels. Absolute coordinates strand the companion off-screen when a monitor is unplugged. On startup, validate the display still exists and clamp into `screen.getDisplayMatching()` bounds.

### 4.2 Typing cadence (M2) — the privacy-critical one

**Architecture: the keyboard hook runs in a separate `utilityProcess`, not in main.** Three reasons, and the first is the one that matters:

1. The NFR requires that a hook failure degrade to `idle` rather than crash the app. A supervised child process gives that for free; an in-main native module takes the whole app down with it.
2. The privacy claim becomes auditable. That process's entire IPC surface is one message shape: `{t: number}`. It is structurally incapable of transmitting key values, and that is reviewable in about thirty seconds — which is a far stronger statement than "we promise we don't log content."
3. It isolates the AV-flagged component, so it can later be swapped for a separately-signed native sidecar without touching the app.

**Implementation:** `uiohook-napi` (prebuilt binaries, wraps `WH_KEYBOARD_LL` on Windows and `CGEventTap` on macOS — exactly the APIs the PRD names). No new language required. If AV flagging becomes a real problem, M4 replaces it with a minimal Rust sidecar that does nothing but emit timestamps.

**Classifier** (pure function, unit-tested, no OS dependency):

```
window        = trailing 3s of timestamps
kpm           = count / 3 * 60
idle          if now - lastKey > 2500ms
typing_fast   if kpm > 280   (exit below 200 — hysteresis)
typing_calm   otherwise
```

The hysteresis band is not optional. Without it the sprite flickers between calm and fast on every pause mid-sentence, which reads as a bug.

**Permission UX (macOS):** the settings toggle explains what is captured (timing only), what is not (key content), and that macOS will now ask for Input Monitoring — *before* triggering the OS prompt. A cold, unexplained Accessibility dialog from a cartoon character is how an app gets deleted. Ship the copy with the feature, not after.

### 4.3 Spotify (M3)

- **Authorization Code + PKCE**, redirect to a **loopback** `http://127.0.0.1:<ephemeral-port>/callback`. Use the `127.0.0.1` literal, not `localhost` — Spotify's current redirect rules treat them differently.
- Refresh token → `safeStorage.encryptString()` → stored blob. Never plaintext, per PRD §10.
- **Polling only** — the Web API has no push channel. `GET /me/player` every **4s while playing, 30s while paused/stopped**, with exponential backoff to 60s on any 429 or network error. Adaptive polling is what keeps this off the CPU budget.
- Any failure → the source reports `unavailable` and the state machine falls to `idle`. No retries visible to the user, no error dialogs.
- Note: a Spotify dev app is in dev mode by default, with users allowlisted manually. Fine for personal use; a quota-extension request is only needed if this is ever shared beyond a handful of people.
- **macOS shortcut, if the OAuth flow proves annoying:** AppleScript `tell application "Spotify" to player state` needs no auth at all. It breaks Windows/macOS parity (G2), so it stays a fallback, not the plan.

### 4.4 State resolution — one decision the PRD doesn't make

Music and typing can be true simultaneously. Without a rule, the sprite thrashes. Strict priority, highest wins:

```
dragged  >  typing_fast  >  typing_calm  >  music_reactive  >  idle
```

Add a **250ms minimum dwell time** per state so a single keystroke during music doesn't cause a visible snap. Every state transition flows through this one function — it is the only place animation state is decided, and it is fully unit-testable with zero OS involvement.

*v2 idea worth designing toward now:* render the headphones as a **separate accessory layer** rather than baking them into the `music_reactive` frames. Then "typing fast while music plays" can show fast-typing frames *with* headphones on, which is what the character should obviously do. Costs nothing to plan for; expensive to retrofit into a flattened sprite sheet.

---

## 5. Animation & asset pipeline

**Sprite sheet atlases, not loose PNG frames.** The PRD §9 proposes individual PNGs per frame. That contract works for design handoff but not at runtime: `typing_fast` at 14fps in 512px @3x means loading and decoding a dozen 1536px images and swapping `src` every 71ms. Instead:

- Design delivers exactly what §9 specifies — PNG sequences at `characters/<name>/<state>/frame-001.png`, @2x and @3x. **No change to the design workstream.**
- `tools/pack-sprites.ts` (Node + `sharp`) packs each state into a horizontal atlas and **generates `manifest.json` automatically** from what it finds on disk. The manifest becomes a build artifact, not a hand-maintained file — so it can never drift from the art.
- Runtime plays frames with a CSS `steps()` keyframe animation on `background-position`. This runs on the compositor, off the main thread — the cheapest possible path to the CPU target, and far cheaper than a `requestAnimationFrame` loop.

**Idle cost control** — how the <2–3% CPU and <150MB targets are actually met:

- `backgroundThrottling: false` is required (the overlay is almost never the focused window), which means nothing is throttled for you. Budget accordingly.
- Idle animation at **4fps**, and when the state is `idle` and no signal source is active, **stop the animation entirely** after one loop and hold a static frame. A companion that is perfectly still while you're away is correct behaviour, not a regression.
- Settings window is created on open and destroyed on close — a second persistent BrowserWindow would blow the memory budget on its own.
- Atlases are decoded once at character load and held; only the active state's atlas stays hot.
- Measure with `process.getProcessMemoryInfo()` and log it. Guessing at memory is how the Tauri debate reopens without data.

**Sourcing DOTT's frames.** The supplied concept art is 3D-rendered stills. Turning them into animation states means either (a) rebuilding DOTT in Blender and rendering true frame sequences — best quality, full control, reusable for every future state, or (b) hand-composing 2–3 frame loops from the existing stills via transform/squash-stretch in the renderer. **Do (b) for M1** to unblock the engine with something that moves, then (a) as the real deliverable. The manifest contract means swapping (b) for (a) is a folder replacement, not a code change — which is precisely the point of building the boundary first.

---

## 6. Milestones

Estimates assume part-time evening/weekend work alongside AZ-104 prep.

| # | Milestone | Scope | Exit criteria | Est. |
|---|---|---|---|---|
| **M0** | Spike | Transparent, always-on-top, click-through, draggable coloured square. Both OSes. Throwaway code allowed. | Square floats over a full-screen browser and IDE; clicks pass through everywhere except the square; drags across two monitors on both OSes | 3–5 days |
| **M1** | MVP | Real repo structure. `dott` character via manifest, drag + resize + persistence, tray/menu-bar, global hotkey, settings window. **Measure idle RSS.** | Survives a full workday of real use without annoying you. Position/size/character restore across restart. `grep -r dott src/` returns only a default-config string. Idle RSS recorded. | 2–3 weeks |
| **M2** | V1 — typing | `utilityProcess` input hook, cadence classifier, state machine + priority table, privacy copy, macOS permission flow | Typing speed visibly drives idle → calm → fast with no flicker. Killing the hook process degrades to `idle`, app survives. | 1–2 weeks |
| **M3** | V1.1 — music | Spotify PKCE, `safeStorage` tokens, adaptive polling, graceful offline | Play/pause in Spotify flips the state within ~4s. Airplane mode → silent fall back to `idle`. | 1 week |
| **M4** | V2 — ship it | Second character (proves G3), CI/CD matrix, code signing both OSes, notarization, auto-update | A pushed git tag produces signed installers for both OSes and a running v(n-1) app updates itself to them, unprompted by you | 2–3 weeks |

**M0 exists to fail cheap.** If the transparent + click-through + always-on-top combination has an unfixable defect on either OS, that is a framework-level finding, and it is worth discovering in week one with throwaway code rather than in week four on top of a real architecture.

---

## 7. Process & DevOps

Since this project is explicitly a DevOps practice surface (G4), the pipeline is a deliverable, not overhead.

**Dev workflow:** `git init` (not yet a repo), trunk-based on `main` with short-lived branches. Conventional commits — they let `electron-builder` generate release notes for free. `main` stays releasable.

**CI (`ci.yml`, on PR):** matrix `[windows-latest, macos-latest]` → install → typecheck → lint → Vitest → Playwright `_electron` smoke test asserting the window flags actually applied. Cross-platform window behaviour is the one thing that cannot be verified from one machine, which makes this matrix genuinely load-bearing rather than a box-tick.

**Release (`release.yml`, on `v*` tag):** build → sign → notarize → publish a **draft** GitHub Release. Draft, so a broken build can be discarded before `electron-updater` clients ever see the feed.

**Signing** — do this early, at the *start* of M4, not the end. It is the step with external dependencies and multi-day latency:

- **macOS:** Apple Developer Program, $99/yr. Developer ID Application certificate; notarize with `notarytool`; needs `entitlements.mac.plist` and hardened runtime. Store `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` as GitHub secrets. **Note: only Command Line Tools are installed on this machine — verify `xcrun notarytool --help` works, and install full Xcode if it doesn't.**
- **Windows:** skip traditional OV/EV certs (~$200–400/yr, hardware-token pain in CI). Use **Azure Trusted Signing** — roughly $10/month, cloud-native, designed for exactly this pipeline. It also happens to be Azure identity, RBAC and resource-provider work, which is directly on top of the AZ-104 syllabus. Best value-per-effort item in the entire plan.

**Signing matters more here than for a typical app:** an unsigned binary containing a `WH_KEYBOARD_LL` hook is close to the textbook heuristic signature of a keylogger. Signature plus a clear publisher identity is what keeps DOTT out of the AV quarantine.

---

## 8. Open questions — answers needed before M4, not before M0

The PRD's four open questions do not block starting. Q1 is the only one that changes engineering:

1. ~~**Personal / friends / public?**~~ **ANSWERED (Aug 13): public, open-source on GitHub.** The build-as-if-public assumption was correct, so nothing needs retrofitting. Consequences now binding rather than optional:
   - Code signing and notarization move from "nice to have" to **required** — an unsigned public download containing a keyboard hook is a non-starter. Start the Apple Developer and Azure Trusted Signing accounts now (§7).
   - A **licensing split** is needed before the repo goes public: the code and the character art should not share a licence. See §10.
   - The privacy story for M2 becomes public-facing documentation, not a personal note. Strangers will read the keyboard-hook code specifically to check it; the `utilityProcess` design (§4.2) is what makes that check take thirty seconds.
   - §11's original-character requirement is now load-bearing rather than precautionary.
2. Moddable character packs vs curated? — affects manifest validation strictness only. Decide at M4.
3. Monetization? — no engineering impact at v1.
4. Show/hide hotkey? — **proposed default `Cmd/Ctrl+Shift+D`** ("D for DOTT"), user-rebindable in settings.

---

## 10. Licensing — decide before the repo goes public

This is the one open decision that actually blocks publishing, and it needs a human call rather than a default.

**The code and the character art should not share a licence.** They are different assets with different risks:

- **The code** is a desktop-pet engine. Permissive licensing (MIT/Apache-2.0) costs nothing and is what makes an open-source project worth publishing — people can learn from the overlay and manifest work, which is the genuinely reusable part.
- **The art is Dott himself** — a commissioned, original character and the project's actual identity. Under MIT, anyone could ship "Dott" in their own product, sell character packs of him, or use him as branding. Once published under a permissive licence that grant is irrevocable.

**Recommendation:** MIT (or Apache-2.0, which adds an explicit patent grant) for everything in `src/` and `tools/`, and a separate, more restrictive licence for `characters/` — CC BY-NC-ND 4.0 is the usual fit, or plain "all rights reserved" if you want to keep every option open. State the split in `README.md` and put a `characters/LICENSE` next to the art so it travels with the files.

Note that GitHub's licence picker assumes one licence for the whole repo, so the split has to be written out explicitly or it will be misread.

**Until this is decided, no `LICENSE` file should be added.** A public repo with no licence defaults to all-rights-reserved, which is the safe state — it can always be loosened later, never tightened.

Worth a quick read of the original commission terms too, to confirm the art is yours to license rather than licensed to you.

## 9. Immediate next actions

1. `git init`, scaffold `electron-vite` + TypeScript, one BrowserWindow.
2. Build M0 in `spike/` — coloured square, all five window behaviours, both OSes.
3. Write `src/shared/manifest.ts` (zod schema) **first**, before any character code exists. It is the contract everything else is built against.
4. Start the Apple Developer enrolment and the Azure Trusted Signing account now — they have lead times, and they cost nothing to have waiting.
