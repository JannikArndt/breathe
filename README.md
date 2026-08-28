# Tide

A breath instrument for a phone lying on your belly.

The phone reads its own motion sensors, pulls your breathing out of the gravity vector, and
turns it into a slow ambient sound. Breathe more slowly and the sound opens up: the low-pass
lifts, a chord fades in, the room gets longer. A quiet guide tone starts at whatever rate
you are actually breathing and eases toward a target over several minutes.

Single HTML file. No dependencies, no build step, no network calls, nothing stored.

---

## Run it

**On a phone.** Serve `index.html` over HTTPS and open it in Safari. Motion sensors are
secure-context only, and Safari's permission prompt only fires from a real tap — both are
handled, but neither works over `http://` or inside someone else's iframe.

**Checking the sound at a desk.** Open it anywhere, go to *Adjust*, switch on **Demo mode**.
Simulated breathing drives the whole instrument; no sensor needed.

**Position.** On your back, phone face-up on the belly just below the navel, screen up. Flat
on the fabric, not wedged under a waistband. Headphones, or ringer switch off silent.

---

## How it works

### Getting breathing out of an accelerometer

The phone is not measuring your breath. It is measuring which way down is. Every breath
tilts the phone by a fraction of a degree, and that shows up as a slow wander of the
gravity vector reported in `accelerationIncludingGravity` — three axes in m/s²
(https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent).

Breathing at 5–20 breaths/min lives at 0.08–0.33 Hz. Everything interesting is below half a
hertz, and everything below about 0.01 Hz is you settling into the mattress. So:

```
raw
  → smooth   = one-pole low-pass, τ = 0.35 s     drop pulse, tremor, sensor noise
  → baseline = one-pole low-pass, τ = 12 s       track posture and slow settling
  → d = smooth − baseline                        ≈ 0.013–0.45 Hz, three axes
  → s = d · u                                    project onto the breath axis
```

Two decisions worth naming:

- **Gravity included, not removed.** `DeviceMotionEvent` also exposes `acceleration` with
  gravity subtracted. That is the wrong signal here — belly motion is quasi-static tilt, so
  the gravity-free vector is essentially zero at breathing frequencies. `acceleration` is
  used only as a fallback if the gravity variant is missing.
- **Time-constant filters, not fixed coefficients.** Every filter takes the measured `dt`
  between events. `devicemotion` fires at a regular but device-dependent interval
  (https://developer.mozilla.org/en-US/docs/Web/API/Window/devicemotion_event), and iOS caps
  it around 60 Hz. With τ-form filters the passband stays put even if the rate changes
  mid-session.

### Finding the axis

Which direction the breath moves depends on how the phone happens to be lying. Rather than
guessing an axis, the app watches for 20 s, builds the 3×3 covariance of `d`, and runs power
iteration for the dominant eigenvector. That is the direction the phone actually moved most,
which for a still person on their back is the breath.

Sign is genuinely ambiguous — the eigenvector could point either way. The heuristic assumes
relaxed breathing exhales more slowly than it inhales, so the axis is oriented to make the
slower half the falling one. It is a guess, and the *Flip direction* toggle exists because
guesses fail. If the sound drops when you breathe in, that toggle is the fix.

### Rate and phase

Peak-and-trough detection with hysteresis on the auto-gained signal, rather than zero
crossings — a slow signal with drift crosses zero unpredictably, but a real peak has to be
followed by a real fall before it counts. That gives breath rate, and separately the inhale
and exhale durations, which is the more interesting number of the two.

Continuous phase comes from the signal and its derivative:

```
phase = atan2(−ṡ/ω, s)
```

Zero at the top of the inhale, running positive through the exhale to ±π at the bottom, then
negative back up through the inhale. It gives a smooth position within the breath cycle
between peaks, which is what the sound and the guide tone both need.

### The sound

Three voices — **Tide**, **Shore** and **Harmonium** — chosen under Adjust and crossfaded
over ~1.5 s, so you can change one mid-session without a gap.

The first version of this app had a real problem: you could not hear whether you were
breathing in or out. Three things caused it, and only one was mixing.

The engine could not tell. Its per-frame call carried the *magnitude* of belly movement
and not its sign, so inhaling and exhaling at the same belly position produced identical
parameters. No amount of tuning would have fixed that.

The filter sweep was 2.3 octaves driven by position alone, so both halves of the breath
retraced one curve rather than tracing two. It is now 4.2 octaves driven by position *and*
direction, and every voice does something on the inhale that it does not do on the exhale.

And velocity scales with rate. Peak belly velocity at 6 breaths a minute is about 43 % of
what it is at 14, because the derivative of a sinusoid peaks at `ω = 2π·bpm/60`. Dividing
by a fixed constant meant every velocity-fed layer got quieter exactly as you did what the
app was asking. The app rewarded slowness with one hand and faded out its most breath-like
layer with the other. Velocity is now normalised against the rate you are actually
breathing at.

Tide's five layers, as an example of the shape all three share:

| Layer | Driven by |
|---|---|
| Drone — 55/110/165/220 Hz, slow detune drift | Low-pass cutoff opens 165 → ~800 Hz as you inhale |
| Air — band-passed pink noise | Centre frequency follows belly position, level follows belly *speed* |
| Pad — open Asus2 chord | Fades in only when breathing is slow |
| Bell — soft low strike, 5 s decay | Fires at the top of each exhale, louder after a long inhale |
| Guide — quiet E5 sine | Follows the target envelope, not you |

The design idea is that slowness should be **rewarded rather than instructed**. A single
value, `rich`, rises with how slow you are breathing (weighted 0.6) and how well you match
the guide (weighted 0.4), then is smoothed over ~3 s. It controls the drone's brightness,
the pad's level, and the reverb wet. Nothing tells you to slow down; the instrument just
sounds better when you do, and the change is gradual enough that you notice it as
atmosphere rather than as feedback.

Pink noise rather than white, because white noise is fatiguing over a ten-minute session and
this is meant to be listened to with eyes closed.

### Spoken guidance

The phone is on your belly, so the screen is unreadable and reaching for it corrupts the
signal you are trying to record. The app speaks the stages instead, through the Web Speech
API — on-device synthesis, so the no-network claim survives.

It talks during setup and then stops. About twelve seconds of speech is front-loaded into
the twenty-second calibration window, which is the right half of it: the τ = 12 s baseline
filter is still converging early on, so the covariance that picks the breath axis takes
most of its information from the last ten seconds anyway. After that it is silent except
for two pace markers across the whole ramp, a signal-lost warning, and errors.

Speech and Web Audio share one audio session on iOS, so the instrument is ducked
deliberately rather than left to fight the synthesiser. iOS drops the `end` event often
enough that four independent paths converge on the unduck — a missed one would leave the
session quiet for the rest of the sitting.

### Recording

Every session is recorded to the phone and nothing is uploaded. The reason is narrow: the
tracker was tuned against synthetic tilt, and `tools/replay.mjs` feeds a real recording
back through the same `Breath` and `Pacer` code the app runs, so a change can be measured
against real breathing.

Storage is IndexedDB, not localStorage — twenty minutes at 60 Hz is ~2.8 MB exported, so
two sessions would blow past localStorage's ceiling. On disk it is columnar typed arrays
(1.59 MB for the same session); the verbose row-per-sample JSON exists only in the export,
where being readable matters more than being small. Raw motion is never thinned: `Float32`
at 4 dp is finer than the accelerometer's own step. The newest 48 MB is kept and the oldest
whole recording is dropped to make room.

Sessions can be labelled after the fact — the first thirty seconds of any recording are you
getting settled, which pollutes calibration, so marking where you actually lay down makes
the data usable.

### The pacer

The guide tone starts at your measured rate — clamped to 7–18/min so a bad calibration
cannot start it somewhere absurd — and eases to the target over the chosen ramp using a
smoothstep curve. The inhale share of the cycle shifts from 0.5 to 0.42, so the exhale
gradually lengthens.

It is **phase-coupled to you at 14%**. The guide's own clock speeds up or slows down
slightly depending on where you are in your cycle, so it walks with you instead of over you.
Coupling only engages when the signal quality is good, so fidgeting does not drag the pace
around.

---

## Why 6 breaths per minute

The default target is 6/min, with 5, 5.5 and 7 available.

Slow-paced breathing at a rate near 6 cycles/min is described as matching a resonance
frequency of the cardiovascular system, and a 2024 open-access meta-analysis and systematic
review of 31 studies (n = 1133, nonclinical adults) reported significant immediate effects:
time-domain heart-rate variability increased (RMSSD SMD = 0.37; SDNN SMD = 0.77), systolic
blood pressure decreased (SMD = −0.45), and heart rate decreased slightly (SMD = −0.10). The
effect on negative emotion, chiefly perceived stress, was marginal (SMD = −0.51, p = 0.06),
and the authors state that long-term efficacy remains to be established
(https://link.springer.com/article/10.1007/s12671-023-02294-2).

Two things from the same source shaped the design:

- The review's inclusion criterion was a pace of **≤ 10 breaths/min**, which is why 7/min is
  offered as a legitimate gentle target rather than a compromise.
- It notes that vagal control decreases during inhalation, allowing heart rate to rise, and
  is restored during exhalation, when heart rate falls — the mechanism behind respiratory
  sinus arrhythmia.

**What is not established here:** the 4:6 inhale-to-exhale ratio the pacer drifts toward is a
design choice reflecting common practice, not something verified against a source in this
project. The claim that a longer exhale specifically increases RSA amplitude appears in the
literature but has not been checked against a fetched primary source — treat it as unverified.
Individual resonance frequency also appears not to be stable across sessions, so 6/min is a
reasonable starting point rather than a personal optimum.

This is a relaxation tool. It is not a medical device, it does not diagnose anything, and the
interface deliberately makes no claims about what the sound will do to your body.

---

## Decisions, and what was rejected

**Accelerometer, not the microphone or camera.** A microphone picks up breath sounds only
for mouth breathing and records the room. The gravity vector works with silent nasal
breathing and never captures anything that could be replayed.

**Covariance PCA over a fixed axis or a per-axis variance pick.** A fixed axis assumes the
phone is placed the same way every time. Picking the single highest-variance axis throws
away the other two components of a diagonal tilt. The 3×3 eigenvector is cheap — 60 rounds
of power iteration on a matrix that small is nothing — and handles arbitrary placement.

**Peaks with hysteresis over FFT rate estimation.** A spectral estimate at 6 breaths/min
needs a 60 s+ window to resolve usefully. The app needs a rate within about two breaths so
the pacer can start where the user actually is. Peak detection also gives inhale and exhale
durations separately, which a rate estimate does not.

**Automatic gain over a fixed threshold.** Tilt amplitude varies with body shape, clothing,
mattress firmness, and how deeply someone happens to be breathing. A fixed threshold would
need calibrating per person per session. The AGC normalises to roughly ±1 over a 14 s window,
with a floor so the gain does not run away when the phone is on a table.

**Reward over instruction.** The obvious build is a metronome with a "breathe in / breathe
out" cue. That makes the app the authority and the user the follower, and it is unpleasant
when it disagrees with you. Phase-coupling the guide and routing all encouragement through a
single slowly-smoothed `rich` value means the app never contradicts you — it just gets
quieter and duller when you speed up.

**No persistence.** No history, no streaks, no session log. Partly the artifact sandbox
blocks browser storage; mostly, a tool you use with your eyes closed should not be
accumulating a record of how well you did.

---

## Known limitations

- **Cross-voice loudness is matched on peak, not loudness.** The three voices sit within
  1.0 dB of each other by peak level, but peak is not loudness and the usual RMS proxy
  ignores filtering — which is exactly where these voices differ. Each carries a `trim`,
  all currently 1.0, as the one number to move per voice after a listening test.
- **Turnaround cues lag by about a second.** `inhaling` comes from the tracker's
  hysteresis detector, which cannot know a peak has happened until the signal has fallen
  past it. The one-shot marker fires from the same detector at the same instant, so it
  covers the transition, but the sustained direction cues arrive late.
- **Spoken guidance on iOS is the least verified part of this app.** Whether the
  zero-volume priming utterance genuinely lifts the gesture restriction, and whether the
  silent switch mutes speech while Web Audio survives it, both need a real phone. Guidance
  degrades to on-screen notices when speech does not start.
- **Embedded frames.** Motion access is commonly blocked in cross-origin iframes. Opened
  inside another app's webview, the app may receive no sensor data at all. It says so after
  5 s. Serve it from its own origin.
- **iOS silent switch.** A silent looping `<audio>` element is started alongside Web Audio to
  keep the page out of the ringer bucket. This is community-reported behaviour, not a
  documented API, and it has not been verified against a current WebKit source. Headphones
  are the reliable path.
- **Side-lying and prone positions are untested.** The axis-finding should cope, but the
  sign heuristic was designed for supine.
- **Very shallow chest breathers** may not move the phone enough. The calibration reports
  this and suggests moving the phone lower, but there is a floor below which there is no
  signal to find.
- **Large postural shifts** blow out the baseline for roughly 30 s. The signal meter shows
  "noisy" while it recovers.
- **The inhale/exhale split is skewed by about 0.4 s** at a 7 s cycle. The 0.35 s smoothing
  filter delays a sharp transition more than a gentle one, so a fast inhale followed by a
  slow exhale reads as slightly too long in and slightly too short out. Measured, stable,
  and present even with zero noise. The total cycle length is unaffected, so rate and the
  in-vs-out ratio are both fine; only the absolute seconds on the readout are biased.
- **Sample rate.** iOS caps `devicemotion` at about 60 Hz. Ample for a 0.1 Hz signal, and the
  τ-form filters mean a different rate on another device does not shift the band.
- **Not tested on Android.** The Chrome axis convention differs from Safari's, but since the
  app derives its own axis from the data rather than assuming one, this should not matter.
  Unverified.

---

## Ideas not built

- A gentle end-of-session fade after a chosen duration, rather than requiring a tap to stop.
- Using the inhale/exhale ratio directly as a second reward dimension, separate from rate.
- A post-session summary — deliberately omitted, but the data exists in memory if it ever
  earns its place.
- Detecting breath-holds, which currently read as a flat signal and stall the cycle detector.
- Per-session resonance search: sweep 4.5–7/min and keep whatever produces the largest,
  steadiest amplitude. This is the closest thing to a real personalisation and the most
  interesting open question in the project.

---

## Development

```bash
node tools/dsp-harness.mjs
```

18 headless checks against the signal chain and pacer: axis recovery, rate tracking, the
inhale/exhale split, sign correction with the phone inverted, drift rejection, the quality
meter, the phase convention, and the pacer schedule. See `CLAUDE.md` for the invariants
those checks protect and what not to change without re-running them.
