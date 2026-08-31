# breathe

A breath instrument for a phone lying on your belly.

The phone reads its own motion sensors, pulls your breathing out of the gravity vector, and
turns it into a slow ambient sound. Breathe more slowly and the sound opens up: the low-pass
lifts, a chord fades in, the room gets longer. It follows you; it does not lead you
anywhere.

Tap Start, lie down, breathe. There is no calibration, no session length, no voice and no
target — it starts listening immediately and runs until you end it. End lands on a summary
you can label and export.

A handful of static files. No dependencies, no build step, and no request to any origin but
its own. Sessions are recorded to the phone and go nowhere unless you export them yourself.

---

## Run it

**On a phone.** Serve the directory over HTTPS and open it in Safari. Motion sensors are
secure-context only, and Safari's permission prompt only fires from a real tap — both are
handled, but neither works over `http://` or inside someone else's iframe. Add it to the
Home Screen and it installs: the whole app is kept on the phone, so it starts with no
connection, and when a new version is published it says so and offers to install it.

There is no build step and nothing to compile. GitHub Pages serving the repository root is
the whole deployment.

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
between peaks, which is what the sound needs between turning points.

### The sound

One voice: a shoreline. Surf gathers as you draw in, breaks at the top, and drains through
the exhale. There were three, picked from a menu; the other two were deleted rather than
kept as also-rans, and the seven controls in Adjust are the depth that replaced the breadth.

| Control | What it moves |
|---|---|
| Swell | the body of the wave — a resonant low-pass that tightens as you draw in, so it gathers rather than merely getting louder |
| Break | the crest at the top of the inhale, and its answering draw at the bottom |
| Foam | hiss draining through the exhale, dropping in pitch through the first second after the break |
| Spray | a narrow band drifting across the field at 0.055 Hz — slower than the slowest breath, so the movement never counts time |
| Undertow | the low drag at the bottom |
| Brightness | every filter corner together, ±1.55 octaves, except the undertow, which follows at `br^0.35` — taking the bottom out along with everything else makes the sound thinner rather than darker |
| Space | stereo width first, reverb second |

Two of those are worth explaining, because both started as something else.

**There was a pitched layer.** A 55/110 Hz sub and a pair of upper tones sat under the water
behind a "tone" control. Asked what it was for, there was no good answer: it read as a drone
laid over the sea rather than as part of it. Removed, control and all — a control nobody
wants at anything but zero is not a control.

**Space was a reverb send, and it was inaudible.** Correctly so: the voice is entirely
noise, and convolved noise still sounds like noise, because there is no transient for a room
to smear. What does read as a room on a noise bed is width, so Space now drives a mid/side
width gain across the whole voice as well as the send.

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

That last one has since bitten twice. The reference is the peak the *current* rate implies,
and it was clamped at a floor of 4 breaths a minute — which is not slow. The owner's own
sessions run at a median 2.9/min, so the reference came out 32 % too large across an entire
session and every velocity-fed layer ran about a quarter under-scaled. Same failure as the
fixed divisor, one clamp further down. The floor is 2/min now.

The design idea is that slowness should be **rewarded rather than instructed**. A single
value, `rich`, rises with how slowly you are breathing and is then smoothed over ~3 s. It
opens the voice up and raises the reverb wet. Nothing tells you to slow down; the instrument
just sounds better when you do, and the change is gradual enough that you notice it as
atmosphere rather than as feedback.

Pink noise rather than white, because white noise is fatiguing over a ten-minute session and
this is meant to be listened to with eyes closed.

### Recording

Every session is recorded to the phone and nothing is uploaded. The reason is narrow: the
tracker was tuned against synthetic tilt, and `tools/replay.mjs` feeds a real recording
back through the same `Breath` code the app runs, so a change can be measured
against real breathing.

Storage is IndexedDB, not localStorage — twenty minutes at 60 Hz is ~2.8 MB exported, so
two sessions would blow past localStorage's ceiling. On disk it is columnar typed arrays
(1.59 MB for the same session); the verbose row-per-sample JSON exists only in the export,
where being readable matters more than being small. Raw motion is never thinned: `Float32`
at 4 dp is finer than the accelerometer's own step. The newest 48 MB is kept and the oldest
whole recording is dropped to make room.

Sessions can be labelled after the fact — the first thirty seconds of any recording are you
getting settled, so marking where you actually lay down makes the data usable.

Two things about that storage were wrong for a while and are worth writing down. Recordings
were written at the size of the *buffer they were captured in* rather than the size of their
contents: capture starts at two minutes and doubles when it fills, so a session ending just
after a doubling paid for up to twice its own samples, and the 48 MB budget — which decides
when the oldest recording is deleted — was computed from the same padded figure. Across the
growth curve that is a mean 36 % overhead. And exporting assembled the whole file as one
JavaScript string, which for *Export all* meant asking a phone for tens of megabytes
contiguously. Both go through the store's own columnar path now, one recording at a time.

The settings in Adjust live in the same database, in a one-row table. They used to reset on
every reload, which mattered more once reloading became easy.

### There is no pacer any more

There used to be one: a guide tone that started at your measured rate and eased toward a
target over several minutes, phase-coupled to you at 14 %, with the reward channel scoring
how well you stayed with it.

It is gone. The app is for attending to your own breathing, and a second thing to follow —
one that is quietly grading you — competes with that. `rich` is now driven by slowness
alone. Nothing should reintroduce a target rate, a guide tone, or a sync reward.

### Holding still between breaths

Slow breathing has rests in it, and the first real recording is full of them: 13 of 18
pauses came after the bottom of an exhale. The app used to read those rests as the start of
an inhale, because two separate things made a belly tremor look like a breath.

The hysteresis was a fixed 0.34 on the normalised signal. That recording's median stroke is
1.75, so the threshold sat at 19 % of a real breath — 56 of 57 exhale bottoms cleared it
more than 0.6 s before the signal reached half a stroke. It now scales with a learned
stroke amplitude, which on that recording puts it at 0.61 and drops the count to 23, while
finding the identical 57 peaks and troughs at the same 11.28 s median period.

The rest of it was in the audio path. `frame()` divides velocity by the peak the current
rate implies, so that slowing down does not fade the breath-driven layers. At 5.4 /min that
divisor is 0.216, and a tremor of 0.05 comes out the other side as a quarter-strength
inhale. Comparing velocity against the *rate* cannot tell a hold from a stroke; comparing
it against this user's own strokes can, so `detectRest()` does that and gates the velocity
channels through `restGate`.

There was a third piece, found later and larger than either. The baseline is a high-pass,
and a high-pass turns a hold into a ramp: across a 10 s hold a τ = 12 s baseline has already
climbed 57 % of the way back to the signal, so the app hears an inhale beginning while the
belly is perfectly flat. Measured against the raw tilt on a session at 3 breaths a minute,
the sound was swelling a median 1.9 s early and as much as 9.8 s early. The baseline now
spans three of the user's own breaths rather than a fixed twelve seconds. On that same
recording the median lead is 0.02 s, the gate is closed for 43 % of the session where it
used to be 12 %, and the gate at the steepest point of each real stroke is still 0.96 —
which is the check that the fix bought accuracy rather than silence.

**Where all of this came from is worth saying plainly.** None of these three numbers was
found by listening or by reasoning about the filter. Each came out of an exported recording
of somebody actually breathing, measured against the raw accelerometer rather than against
the app's own opinion of it. That is the entire reason recording exists.

### Very slow breathing

The owner breathes at a median 2.9 breaths a minute — a 20-second cycle, with p75 at 24.3 s
and a longest of 30.1 s. Two constants in the app had been set for someone breathing three
or four times faster, and both were found by measuring that recording rather than by
noticing anything wrong:

- The cycle detector discarded any period over 30 s, which threw away that session's
  longest breath outright and left 6 of its 28 periods within 20 % of the same fate. The
  ceiling is 36 s now, which is 1.7 breaths a minute. The *fast* end did not move: 3 s is
  what rejects a phone being waved about, and this end never did that job.
- The audio engine clamped the rate to a floor of 4/min before working out what a peak
  stroke should measure — described above as the thing that was already fixed once. At a
  real 2.9/min the reference came out 32 % too large for the whole session.

The lesson is the one the app keeps relearning: a constant chosen for a plausible-sounding
range quietly stops working just outside it, and the only way to notice is to measure a real
session rather than a synthetic one.

### Heart rate, experimentally

Off by default. Each heartbeat moves a little blood and the reaction reaches the phone —
ballistocardiography. Band-pass 4–14 Hz, envelope, autocorrelate twelve seconds of it, and
report only when the peak clearly stands out of the curve and the body is still. On
synthetic beats it is within 4 /min across 42–135 /min and produces no false positives on
noise, but it has never been checked against a real heartbeat, and on a belly rather than a
chest it may simply never find one. It shows a dash rather than a stale number, which will
be most of the time.

---

## Why slowness is the thing being rewarded

**The app has no target rate and never had a good reason to.** What follows is why slowness
is nevertheless what `rich` responds to, rather than, say, depth or regularity.

Slow-paced breathing at a rate near 6 cycles/min is described as matching a resonance
frequency of the cardiovascular system, and a 2024 open-access meta-analysis and systematic
review of 31 studies (n = 1133, nonclinical adults) reported significant immediate effects:
time-domain heart-rate variability increased (RMSSD SMD = 0.37; SDNN SMD = 0.77), systolic
blood pressure decreased (SMD = −0.45), and heart rate decreased slightly (SMD = −0.10). The
effect on negative emotion, chiefly perceived stress, was marginal (SMD = −0.51, p = 0.06),
and the authors state that long-term efficacy remains to be established
(https://link.springer.com/article/10.1007/s12671-023-02294-2).

Two things from the same source shaped the design:

- The review's inclusion criterion was a pace of **≤ 10 breaths/min**, which is the range
  `rich` opens across: `0.28 + 0.72·clamp((14 − bpm)/8)` reaches its ceiling at 6/min and
  its floor at 14.
- It notes that vagal control decreases during inhalation, allowing heart rate to rise, and
  is restored during exhalation, when heart rate falls — the mechanism behind respiratory
  sinus arrhythmia.

**What is not established here:** the 4:6 inhale-to-exhale ratio the app once drifted people
toward was a design choice reflecting common practice, not something verified against a
source in this project. Nothing asks for it now. The claim that a longer exhale specifically
increases RSA amplitude appears in the literature but has not been checked against a fetched
primary source — treat it as unverified. Individual resonance frequency also appears not to
be stable across sessions, which is one more reason there is no target.

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
needs a 60 s+ window to resolve usefully. The app needs a rate within about two breaths, to
scale the velocity reference and the learned stroke amplitude. Peak detection also gives
inhale and exhale durations separately, which a rate estimate does not.

**Automatic gain over a fixed threshold.** Tilt amplitude varies with body shape, clothing,
mattress firmness, and how deeply someone happens to be breathing. A fixed threshold would
need calibrating per person per session. The AGC normalises to roughly ±1 over a 14 s window,
with a floor so the gain does not run away when the phone is on a table.

**Reward over instruction.** The obvious build is a metronome with a "breathe in / breathe
out" cue. That makes the app the authority and the user the follower, and it is unpleasant
when it disagrees with you. Routing all encouragement through a single slowly-smoothed
`rich` value means the app never contradicts you — it just gets quieter and duller when you
speed up.

**Recordings, but no record of how you did.** There was no persistence at all for a long
while, for two reasons: the sandbox blocked it, and a tool you use with your eyes closed
should not be accumulating a scoreboard. The first reason went away and the second one
didn't. Sessions are now recorded, because the tracker cannot be improved without real
breathing to test against — but the summary reports measurements with units and nothing
else. No grading, no streaks, and no line joining your first rate to your last.

**A service worker rather than a cache-busting URL.** Added to the Home Screen the app runs
standalone: no address bar, no pull-to-refresh, and iOS will keep serving the copy it has,
including in answer to `location.reload()`. The first fix was to navigate to a URL the phone
had never seen, which works exactly once and does nothing about opening the icon tomorrow.
The worker holds the whole app as one version-named cache: a new version installs beside the
running one, waits, and takes over when you say so. Cache-first *inside a version* is the
part that matters — a fresh page can never end up driving last week's modules, because both
come from the same cache and that cache is discarded whole.

---

## Known limitations

- **The heart rate has never seen a real heartbeat.** Everything behind it was tuned
  against synthetic beats. Replayed over a real 9.5-minute belly recording it holds
  73–83 /min (p50 78.5) on 55 of 55 samples at confidence 0.46–0.98, while the deliberately
  bogus recording gives 4 scattered readings out of 14. That is plausible and remarkably
  steady, and steady is not correct: nothing here has ever been checked against a wrist.
- **Turnaround cues lag by about a second.** `inhaling` comes from the tracker's
  hysteresis detector, which cannot know a peak has happened until the signal has fallen
  past it. The one-shot marker fires from the same detector at the same instant, so it
  covers the transition, but the sustained direction cues arrive late.
- **Embedded frames.** Motion access is commonly blocked in cross-origin iframes. Opened
  inside another app's webview, the app may receive no sensor data at all. It says so after
  5 s. Serve it from its own origin.
- **iOS silent switch.** A silent looping `<audio>` element is started alongside Web Audio to
  keep the page out of the ringer bucket. This is community-reported behaviour, not a
  documented API, and it has not been verified against a current WebKit source. Headphones
  are the reliable path.
- **Side-lying and prone positions are untested.** The axis-finding should cope, but the
  sign heuristic was designed for supine.
- **Everything measured here comes from one body.** Three recordings, one person, one
  phone, one mattress. Every constant that was moved because a recording said so was moved
  because *that* recording said so. The sensitivity control exists for this reason and is
  not a substitute for a second person.
- **Very shallow chest breathers** may not move the phone enough. The signal line reports
  this and suggests moving the phone lower, but there is a floor below which there is no
  signal to find. The sensitivity control moves where that floor sits, because two
  recordings are not a sample to set it from.
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
- **No browser has ever run the test suite.** `tools/smoke.mjs` runs the whole app in Node
  against a stub DOM, a stub Web Audio and an in-memory IndexedDB, which answers "would this
  run" thoroughly and "does this look or sound right" not at all. Layout, real Web Audio and
  actual Safari behaviour are still only checkable on a phone.
- **The update flow has been tested against a stubbed service worker, not a real one.** The
  state machine is driven end to end in Node — check, nothing new, a version arriving, the
  handover — but whether iOS reliably re-fetches `sw.js` from a standalone Home Screen app
  is exactly the kind of thing this app has been wrong about before.

---

## Ideas not built

- A gentle end-of-session fade after a chosen duration, rather than requiring a tap to stop.
- Using the inhale/exhale ratio directly as a second reward dimension, separate from rate.
- Per-session resonance search: sweep 4.5–7/min and keep whatever produces the largest,
  steadiest amplitude. This is the closest thing to a real personalisation and the most
  interesting open question in the project — and the hardest to do without reintroducing a
  pacer, since sweeping means asking someone to follow something.
- A way to hear a recording back as sound, rather than reading it as a graph.
- **Headroom in the reward for someone already breathing very slowly.** `rich` is
  `0.28 + 0.72·clamp((14 − bpm)/8)`, which reaches its ceiling at 6 breaths a minute. The
  owner's sessions run at 2.5–5/min throughout, so `rich` has been pinned at 1.0 for the
  whole of every session they have recorded — the app's one channel for responding to how
  they are breathing has nothing left to give them. Extending the curve down would take
  something away from a 6/min breather to give it to a 3/min one, and rewarding the holds
  instead would be rewarding a behaviour, which is instruction wearing a different hat.
  Left open deliberately: it is a decision about what the app is for, not a bug.

Built since, and struck off this list: a post-session summary, breath-hold detection (holds
used to read as a flat signal and stall the detector; they now close a gate and quiet the
sound), and persistence.

---

## Development

```bash
node tools/dsp-harness.mjs      # the signal chain, against synthetic tilt
node tools/smoke.mjs            # the whole app, against stub DOM / audio / IndexedDB
```

The harness covers axis recovery, rate tracking from 12 down to 2 breaths a minute, the
inhale/exhale split, sign correction with the phone inverted, drift rejection, the quality
meter, the phase convention, the learned stroke amplitude, rest detection, whether it is
breathing at all, and the pulse estimator. The smoke test covers everything else: it opens
each panel, turns on Demo mode, taps Start, breathes for three simulated minutes through the
real render loop, taps End, reads the summary, browses and labels and deletes the recording,
and drives the update flow. It also asserts the things that hold a build-step-free project
together — that the service worker's version matches the release on the home screen, that
its precache list is exactly the files on disk, and that every slider's default matches its
markup.

Three more tools read real recordings rather than synthetic ones:

```bash
node tools/replay.mjs recordings/some-session.json    # re-run the tracker over it
node tools/onset.mjs  recordings/some-session.json    # how early does the sound start?
node tools/analyze.mjs recordings/some-session.json   # timing, depth, stillness
```

`onset.mjs` answers the one question the harness structurally cannot. The harness feeds a
sinusoid, and a sinusoid has no holds in it — which is precisely the case that has broken
twice here.

See `CLAUDE.md` for the invariants these checks protect and what not to change without
re-running them.
