# CLAUDE.md

Operating notes for coding agents working on **Tide**. Read this before editing `index.html`.
Design rationale and evidence live in `README.md`; this file is the contract.

---

## 1. What this is

A single-page web app that reads iPhone motion sensors while the phone lies on the user's
belly, extracts the breathing waveform from the gravity vector, and drives an ambient
Web Audio instrument from it. The sound gets warmer as breathing slows, and a guide tone
eases the user from their measured rate toward a target (default 6 breaths/min).

Repository layout:

```
index.html              the entire app — markup, styles, DSP, audio engine
README.md               reasoning, decisions, evidence, limitations
CLAUDE.md               this file
tools/dsp-harness.mjs   headless Node test for the signal chain and pacer
tools/replay.mjs        replays an exported session through the real tracker
```

---

## 2. Hard constraints

These are not preferences. Breaking one breaks the product.

| Constraint | Why |
|---|---|
| One file, zero dependencies, no build step | It has to run from a file:// copy, a phone, a gist, or a Pages branch with nothing installed. Do not add npm, bundlers, TypeScript compilation, or CDN imports. |
| IndexedDB is the **only** permitted store. No `localStorage`, `sessionStorage` or cookies | The ban on all persistence held until the owner lifted it explicitly, to collect real breathing data for algorithm work. A twenty-minute session is ~2.8 MB exported, far past localStorage's ~5 MB ceiling for even two recordings, so IndexedDB is a capacity requirement rather than a preference. `Store.available` must go false and every method resolve harmlessly when IndexedDB is blocked — a recording failure must never disturb a breathing session. |
| Recordings never leave the device | Storage changed; the privacy claim did not. No upload, no sync, no analytics. Export is `Blob` → `URL.createObjectURL` → `<a download>`, and only the user starts it. |
| No network calls of any kind | Privacy claim in the UI copy ("Motion never leaves the phone") must stay literally true. No fonts, no analytics, no error reporting. |
| `DeviceMotionEvent.requestPermission()` is called synchronously inside the Begin tap handler, **with no `await` anywhere before it** | It requires transient activation and a secure context; without activation it rejects with `NotAllowedError` (https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static). WebKit is cruder than the spec — activation in practice only holds inside the same stack as the click handler, so one `await` before the call is enough to lose it (https://macwright.com/2022/07/11/activation). This shipped broken once: `await Audio.start()` sat above the call. See §9. |
| `AudioContext` is created in the same tap | iOS starts it suspended otherwise and the session runs silently. `Audio.start()` is async but constructs the context before its first `await`, so calling it without awaiting is correct and deliberate. |
| Every failure path produces a specific notice | A sensor failure that falls through silently reads to the user as "the app is broken". `requestSensor()` returns `ok` / `denied` / `unsupported` / `error:<Name>`; `begin()` must handle all four. |
| No medical claims in UI copy | It says "A relaxation tool, not a medical device." Keep it that way. Feature copy may describe what the sound does, never what the body will do. |
| System fonts only | No webfont fetch. The stacks in `:root` degrade sanely on Android and desktop. |

---

## 3. Map of `index.html`

The `<script>` is divided by banner comments. **`tools/dsp-harness.mjs` slices on these
markers** (`const clamp` → the banner before `4. APP`) — if you renumber or retitle a
section, update the harness in the same commit.

| Section | Contents |
|---|---|
| `0. small helpers` | `clamp`, `lerp`, `TAU`, `lp()` one-pole filter, `notice()` toast |
| `1. AUDIO ENGINE` | `Audio` — three voices (`tide`, `shore`, `harmonium`), crossfading, procedural noise and impulse responses, per-frame parameter updates, ducking |
| `2. BREATH TRACKER` | `Breath` — filtering, calibration PCA, projection, AGC, cycle detection, phase |
| `3. PACER` | `Pacer` — deceleration schedule and phase-coupled target envelope |
| `4. SPEECH` | `Speech` — Web Speech API guidance, keyed copy table, iOS priming, duck and restore |
| `5. RECORDER + STORE` | `Recorder` (typed-array capture) and `Store` (IndexedDB, eviction, export) |
| `6. REVIEW UI` | `Review` — the summary End lands on, the session browser, labelling |
| `7. APP` | `UI`/`el`, permissions, wake lock, session lifecycle, rAF loop, canvas drawing, event wiring |

Sections 4–6 sit between the DSP and APP so the harness's slice of 0–3 is unchanged.
**They must be inert at definition time** — no `document.getElementById`, `indexedDB`
or `speechSynthesis` at the top level of the IIFE, only inside methods. The harness
slices `const clamp` → the banner before `4. SPEECH`; renumbering means editing
`END` in `tools/dsp-harness.mjs` in the same commit.

`Audio` is inert until `Audio.start()` runs, which is why the harness can evaluate
sections 0–3 in Node without stubbing Web Audio.

---

## 4. Signal-chain invariants

The numbers below were chosen against the physics, not tuned by ear. Changing one without
re-running the harness is how this regresses.

**Band.** Breathing at 5–20 breaths/min is 0.08–0.33 Hz. The chain isolates roughly
0.013–0.45 Hz:

```
raw (accelerationIncludingGravity, m/s²)
  → smooth   = lp(raw,    τ = 0.35 s)   # kills pulse, tremor, sensor noise
  → baseline = lp(smooth, τ = 12.0 s)   # tracks posture and slow settling
  → d = smooth − baseline               # the band-passed gravity deviation
  → s = d · u                           # u = breath axis from calibration
```

- **Use `accelerationIncludingGravity`, not `acceleration`.** Belly motion is quasi-static
  tilt; the gravity-removed vector is near zero at these frequencies. `acceleration` is only
  a fallback when the gravity variant is absent. Both are m/s² on three axes:
  https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent
- **All filters take measured `dt`.** `devicemotion` fires at a regular but
  device-dependent interval (https://developer.mozilla.org/en-US/docs/Web/API/Window/devicemotion_event);
  iOS is around 60 Hz. Never hardcode a sample rate — the passband must not move if the
  rate does. `dt` is clamped to 0.5 s and falls back to 1/60 on a stall.

**Calibration.** 20 s, minimum 60 samples. Covariance of `d` over the window, 60 rounds of
power iteration for the dominant eigenvector `u`. Sign is resolved by counting rising vs
falling sample transitions and flipping when `up > down * 1.12`, on the assumption that
relaxed breathing exhales more slowly than it inhales. The *Flip direction* toggle is the
user-facing escape hatch — keep it.

**AGC.** `rms = lp(s², τ = 14 s)`, `scale = max(√rms · 1.55, 0.006)`, output clamped to
±1.8. The 0.006 floor stops the gain running away when the phone is on a table. If you
raise the τ, the app takes longer to adapt after the user shifts position.

**Known bias.** The τ = 0.35 s smoothing filter delays sharp transitions more than gentle
ones, so on asymmetric breathing the reported inhale runs ~0.4 s long and the exhale ~0.4 s
short at a 7 s cycle. The total is unaffected. The harness asserts these bounds explicitly
rather than the true values — if those checks start failing, the smoothing τ has moved.

`finishCalibration()` also records `Breath.flipped` — whether the sign heuristic
fired — purely so an exported session can say so. It changes no behaviour.
`Breath.vel()` returns the *signed* velocity, −1..1, positive while inhaling. The
audio engine needs direction; `speed()` only ever carried magnitude.

**Cycle detection.** Peak/trough with hysteresis scaled to the depth the user actually
breathes at: `H = clamp(strokeAmp · 0.30, 0.30, 0.80)`, where `strokeAmp` is an EMA
(α = 0.25) of measured peak-to-trough excursions, seeded at 1.7. Periods outside 2–25 s
are discarded. Period EMA α = 0.45, bpm EMA α = 0.4. Lowering the coefficient makes it
double-count on noisy signals; raising it drops shallow breaths.

`H` was a fixed 0.34 until the first real recording measured a median stroke of 1.75
normalised units — so the threshold sat at 19 % of a breath, and 56 of 57 exhale bottoms
cleared it more than 0.6 s before the signal reached half a stroke. At `H = 0.61` on that
same recording the count falls to 23 of 57 with the *identical* 57 peaks and troughs and
the same 11.28 s median period, so the sensitivity costs nothing in rate tracking.

**Rest.** Slow breathing has real holds in it. `detectRest()` compares `|ṡ|` against this
user's own stroke velocity (`slopeEnv` = mean `|ṡ|` at τ = 8 s; peak ≈ mean · 1.57), enters
"still" under a ratio of 0.22 and leaves it over 0.50 — a dead band, so a wobble on the
threshold cannot chatter. `resting` needs 0.5 s of holding, and `restGate` fades in over
0.30 s and out over 0.60 s. **`vel()` and `speed()` are both multiplied by `restGate`.**
This exists because velocity is normalised against breathing rate in `Audio.frame()`: at
5.4 /min the reference peak is 0.216, so a belly tremor of 0.05 divides out to a
quarter-strength inhale. Comparing against the rate alone cannot tell a hold from a stroke;
comparing against the user's own strokes can.

**Phase.** `phase = atan2(−ṡ_lp / ω, s)` with `ω` clamped to 0.25–2.2 rad/s and
`ṡ` low-passed at τ = 0.28 s.

```
phase = 0        top of the inhale
phase ∈ (0, π)   exhaling
phase = ±π       bottom of the exhale
phase ∈ (−π, 0)  inhaling
```

`Pacer.phase` uses the identical convention so the two can be compared directly. **If you
change one, change both** — the sync reward and the phase coupling both depend on it.

---

## 5. Audio invariants

- **`Audio.frame(f)` takes an object, and it carries direction.** The old positional
  `frame(level, speed, rich, pacerLvl)` passed only the *magnitude* of belly movement,
  so inhaling and exhaling at the same belly position produced identical parameters —
  no amount of mix tuning could make the two halves distinguishable. `f` now carries
  `{level, vel, speed, inhaling, rich, pacerLvl, pacerVel, bpm, dt}`, where `vel` is
  signed and positive while inhaling. **If a voice ever sounds directionless, check
  that `vel` is actually being passed before touching the voice.**
- **Velocity is normalised against the current rate.** Peak `|vel|` scales with
  breathing rate: at 6/min it is ~43 % of its 14/min value, because `ds/dt` peaks at
  `ω = 2π·bpm/60`. Dividing by a fixed constant made every velocity-fed layer quieter
  exactly as the user slowed down — the app rewarded slowness with `rich` while fading
  out its most breath-like layer. `frame()` divides by the peak the current rate
  implies. Do not replace that with a constant.
- **Three voices, one interface.** `Audio.voices` drives the picker, `setVoice(id)`
  crossfades over ~1.5 s and is safe before `start()` and mid-session. All three graphs
  are built at startup and crossfaded rather than rebuilt, which costs 24 oscillators
  and 99 nodes but cannot click. Each voice carries a `trim` (all 1.0) as the one
  number to move after a listening test — peak levels match within 1.0 dB, but peak is
  not loudness.
- **Everything is a `setTargetAtTime` on a smoothed parameter.** Never set an
  `AudioParam.value` directly in the render loop; it produces zipper noise on a signal this
  slow. Time constants in `Audio.frame()` are 0.09–0.5 s and are part of how the instrument
  feels.
- **`rich` (0–1) is the reward channel.** It opens the drone low-pass, fades in the pad, and
  raises reverb wet. It rises with slowness `(14 − bpm)/8` weighted 0.6 and phase sync
  `(1 + cos Δφ)/2` weighted 0.4, then is low-passed at τ = 3 s so the reward arrives as a
  gradual warming rather than a switch. Anything new that rewards the user should feed
  `rich` rather than adding a parallel mechanism.
- **The turnaround markers fire from `Breath.onExhaleStart`**, strength scaled by the
  preceding inhale duration. Keep them under ~0.16 gain — a cue, not a downbeat.
  `bell()` dispatches to the current voice, and each voice times its *bottom* marker
  from the top one, so removing this call silences both.
- **`DynamicsCompressor` at threshold −10 dB, ratio 12 is the output limiter.** Layers can
  sum unpredictably when a user breathes hard; do not remove it.
- **iOS silent switch:** `primeSilentChannel()` starts a silent looping `<audio>` element so
  the page is treated as media playback. This is community-reported behaviour, **not a
  documented API**, and has not been verified against WebKit source. If it stops working,
  the fallback advice is headphones — do not build anything load-bearing on it.

---

## 6. Testing

```bash
node tools/dsp-harness.mjs                    # defaults to ./index.html
node tools/dsp-harness.mjs path/to/other.html
```

18 checks: axis recovery, rate tracking at 12 and 6/min, inhale/exhale split, sign
correction with the phone inverted, tolerance to 0.6 m/s² per minute of postural drift, the
quality meter, the phase convention, and the pacer schedule. Exit code 0 on success.

The harness synthesises tilt at 0.09 m/s² peak-to-peak, which is roughly what a relaxed
adult belly produces. It uses random noise, so it is mildly stochastic — it passed five
consecutive runs at the current thresholds. A single flake is worth re-running once; two
is a regression.

Replay a real recording through the tracker:

```bash
node tools/replay.mjs recordings/some-session.json
node tools/replay.mjs bundle.json --session <id>     # an "Export all" file
node tools/replay.mjs s.json --from 40 --to 200      # one labelled stretch
```

It slices `Breath`/`Pacer` out of `index.html` the same way the harness does, so it
measures the code that actually ships. This is the point of recording: an algorithm
change can be checked against real breathing instead of synthetic tilt.

End-to-end smoke test, which needs no phone because Demo mode simulates the sensor:
serve the repo over `http://localhost`, drive `index.html` with Playwright, turn on
Demo mode, tap Begin, wait out calibration, tap End, and assert the summary renders
real numbers and the session appears under Recordings. This is what caught the demo
calibration bug and the empty-summary bug during integration.

**Run the harness after any change to sections 0–3.** It will not catch anything in
sections 4–7, the audio graph, or the canvas.

### Manual checks the harness cannot do

Do these on a real phone over HTTPS before calling a change done:

1. Begin → permission prompt appears → 20 s calibration → sound starts.
2. Deliberate slow breathing raises `rich` audibly within ~30 s (pad appears, sound opens).
3. Guide tone and your own breath drift into agreement rather than fighting.
4. Lock the screen and unlock: audio resumes, wake lock re-acquires.
5. Sit up mid-session: signal meter drops to "noisy", recovers within ~30 s.
6. Ringer switch on silent, no headphones: check whether sound survives. Record the result
   and the iOS version in the README's limitations section either way.

---

## 7. Style

- Metric units everywhere, in code comments and UI.
- Comments explain *why a constant has that value*, not what the line does. The `τ = 12 s`
  baseline filter needs a reason; `ctx.createGain()` does not.
- UI copy: sentence case, active voice, second person, no exclamation marks. A control says
  what happens when it is used. Errors say what went wrong and what to do — see the notice
  strings in section 4 for the register.
- CSS: custom properties in `:root` for every colour and font stack. No new hex literals in
  rules. Watch selector specificity between `.bar` and `.panel .bar` — margins there have
  collided before.
- Respect `prefers-reduced-motion` (already handled globally) and keep focus outlines.

---

## 8. Deployment

The app is a single static file, so branch publishing is the simplest correct option — no
Actions workflow is needed and none should be added unless a build step appears.

1. Rename the app to `index.html` at the repo root (or in `/docs`).
2. Settings → Pages → Source: **Deploy from a branch** → pick the branch and folder.
3. Add an empty `.nojekyll` at the root of the published folder.
4. Push; allow up to ~10 minutes for the first deploy.

HTTPS is mandatory, not cosmetic: `devicemotion` and `requestPermission()` are both
secure-context only (see the MDN links in §2 and §4). `*.github.io` is HTTPS by default.

> These GitHub Pages steps come from a local reference, not from GitHub's documentation
> re-fetched in this session. Verify against https://docs.github.com/pages before relying
> on exact menu labels or action versions.

**Embedded frames:** motion access is commonly blocked in cross-origin iframes, so the app
must be opened at its own origin. If someone reports "no sensor data", check this first —
the app already surfaces a notice after 5 s of silence.

---

## 9. Do not

- Add accounts, sync, or any network call. Recording is now permitted and on by
  default — that ban was lifted deliberately — but "it never leaves the phone" is
  still the privacy story, and it is now the *only* one. Anything that would move a
  recording off the device breaks the claim the intro makes.
- Let a storage failure touch a breathing session. `Store` degrades to unavailable and
  reports afterwards; it never interrupts, and it never blocks the audio path.
- Add a countdown, streaks, scores, or any gamification. The reward is the sound
  opening up. **The summary screen is where this will break first** — it reports
  measurements with units and nothing else. No grading, no congratulation, no arrow
  joining the first and last rate into a progress claim.
- Replace the peak/trough detector with FFT-based rate estimation without a plan for the
  latency: at 6 breaths/min a usable window is 60 s+, and the app needs a rate estimate
  within two breaths.
- Move `requestPermission()` or `new AudioContext()` out of the tap handler, or make the
  click handler `async` and put an `await` above them. The handler is deliberately
  synchronous: it starts both promises and hands them to `begin()`, which does the awaiting.
  If you find yourself adding `await` to that handler, you are re-introducing a shipped bug.
- Add a `catch` that returns a bare `'error'`. Carry the `err.name` through — the difference
  between `NotAllowedError` and anything else is the whole diagnosis.
- Tighten `H`, `τ`, or the AGC floor "to make it more responsive" without running the
  harness — those constants trade responsiveness against false cycles, and the harness is
  the only thing that measures the trade.
- Introduce claims about physiological effects into the interface.
