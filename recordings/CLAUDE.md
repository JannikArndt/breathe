# recordings/CLAUDE.md

What is in this folder, what each file has already proved, and what is known about
the body that produced it. The root `CLAUDE.md` is the contract for the code; this
is the contract for the evidence. **Read this before tuning any constant in
`src/breath.js`** — most of them were set against a specific recording, and the
reason is here rather than in the diff.

`README.md` next to this file is for a person exporting a session from their phone.

---

## 1. The one rule

**A recording is accelerometer data from a phone on someone's belly.** Committing one
is a deliberate act. Nothing here is uploaded by the app, and nothing here should
leave the repository.

---

## 2. What is here

Fourteen files. Thirteen carry raw 60 Hz motion, which is the only thing that lets a
DSP change be re-measured after the fact; `20260831-0853` does not, because an old
labelling bug destroyed it (see §6).

| file | what it is | why it stays |
|---|---|---|
| `20260829T115717-bogus` | phone on a table, then waved by hand | The negative control, and the only one that cannot go out of date: a table is still a table. `dsp-harness.mjs` replays it and asserts peak confidence stays under 0.35 (it is 0.135). Deleting it removes a check. |
| `20260830T223632` | 9:32 at ~3/min, long holds at both ends | The reference session. Four fixes came out of it (§5), and every constant in `detectRest` was measured against it. **Also the reason the top-of-inhale bug went unseen through four releases — see §4.** |
| `20260831-0853` | 7:00 on 0.10.0, derived channels only | The evidence for the reward curve: it descends 6.2 → 2.5/min over seven minutes with `rich` pinned at 1.00 for 86% of it. Carries the `rest` channel. No raw motion, so no future DSP change can be checked against it. |
| `20260831-1001-table` | 81 s, phone on a table | Settling: this reported `follow` 0.88 and a projection pinned to the clamp before §4c existed. Now settles and reads 0.03. |
| `20260831-1003-shaking` | 75 s of deliberate shaking | Never settles, which is the point. |
| `20260831-1117-slow-detection-inverse` | 109 s, no rate ever reported | The session that ran without the tracker ever reporting a rate — the case the lead-in was built for. Every one of its axis samples is `ok:false`, so it has no usable axis at all. |
| `20260831-1122-slow-and-inverse` | 4:22, axis came out negative | One of the two the owner reported as inverted. Its axis came out sign-negative, which is what `resolveSign()` exists to settle; it predates that mechanism. |
| `20260831-1131-great` | 7:57 at 2.76/min, the session the owner called great | The one to check a change against for "does this still feel right". Its top hold is 1.02 s against a bottom hold of 8.72 s — the most extreme asymmetry in the set. |
| `20260901-1313` | 2:12, started with the phone in hand | Settles at the 45 s cap rather than by the hold test. |
| `20260901-1322` | 21 s | Too short to say anything; kept as a degenerate case for the tools. |
| `20260901-2055` | 13:17 at 2.29/min | `dsp-harness.mjs` replays it and asserts the mean rest gate across its first real inhale clears 0.45 (0.00 before that fix, 0.77 now). The synthetic feed structurally cannot catch that case. |
| `20260903-2033` | 15:22 at 2.96/min, 0.19.0 | One of the three that produced the rest-gate latency fix (§4). |
| `20260904-1907` | 18:07 at 3.40/min, 0.19.0 | The clean separator: its top and bottom holds are the same length (1.33 / 1.37 s) and the gate still came out shallower at the top, which is what showed the asymmetry was in the code and not only in the body. |
| `20260906-2041` | 15:05 at 3.40/min, 0.19.0 | The shallow one — see §3. Also the recording that exposed the exported-axis bug (§6). |

---

## 3. What this body actually does

Every measurement below is from replaying the shipped tracker over the raw motion in
these files. **One body, one phone, one evening each.** Do not treat any of it as a
population.

**Rate.** A median around 3 breaths a minute, descending within a session — the 0853
trace goes 6.2 → 2.5/min over seven minutes. The app's target range is 14 down to 1.

**Breath size along the axis**, in m/s² RMS — the tracker's own running estimate,
taken as the median over the confident part of the session, which is what
`tools/analyze.mjs` now prints:

| session | amplitude | | session | amplitude |
|---|---|---|---|---|
| 0830 | 0.41 | | 2033 | 0.48 |
| 0853 | 0.49 | | 1907 | 0.43 |
| 1122 | 0.59 | | **2041** | **0.15** |
| great | 0.63 | | bogus (control) | 0.011 |
| 2055 | 0.63 | | | |

**2041 is a third the size of every other session and that is real.** It was checked
three ways: the app's own running estimate holds 0.14–0.175 from 31 s onward, an
offline eigen-solve on a clean mid-session window gives 0.160, and the projected
peak-to-peak is 0.523 m/s² against 1.42–1.61 for the others. Its axis is right
(0.8° from the offline solve), its confidence was fine (p50 0.80) and the AGC
normalised it, so it tracked and *felt* like an ordinary session — the owner
reported it as one. It is a placement or depth difference, not a fault. Keep it: it
is the only shallow session in the set and therefore the only check that a change
does not quietly assume a deep one.

**Holds.** This is the structural fact the code now depends on, so it is worth stating
plainly. Median hold at each end, found with the tracker's own rest test applied to
the body (under 22% of peak stroke speed):

| session | top of inhale | bottom of exhale |
|---|---|---|
| 0830 | **2.55 s** | **2.45 s** |
| 1122 | 1.05 s | 5.33 s |
| great | 1.02 s | 8.72 s |
| 1313 | 1.03 s | 4.48 s |
| 2055 | 0.48 s | 0.92 s |
| 2033 | 0.87 s | 2.85 s |
| 1907 | 1.33 s | 1.37 s |
| 2041 | 0.48 s | 0.45 s |

**The top hold is about a second; the bottom is about two and a half.** Seven of the
eight are asymmetric, and 0830 — the one every constant in `detectRest` was measured
against — is the only session where the two are equal. See §4.

**Signal-to-noise.** The `quality` channel in an export is **not** confidence. It is
`breathRms / (breathRms + 2.2·motionRms + 0.004)`, so a shallow session reads low
even while tracking perfectly: 2041 shows 0.38 against 0.65–0.73 elsewhere, while its
replayed `conf` is 0.80. Do not read `quality` as "how well did the tracker do".

---

## 4. The top-of-inhale bug, and why it lasted

Recorded here because it is the clearest example in this repository of a constant
being right for the evidence it was measured against and wrong for everything else.

**Symptom.** The owner, on the three 0.19.0 sessions: *"The silence at the bottom of
the breath is very good. At the top of the inhale, it still tries to start the exhale
a bit too quick."*

**Cause.** `restGate` is what produces the silence, and it was **latency-limited, not
threshold-limited**. Declaring rest needed 0.5 s of `stillFor` and the gate then faded
out over τ = 0.60 s — about 0.8 s from the belly stopping to the sound being gone.
That is comfortably inside a two-and-a-half-second hold and eats the whole of a
one-second one. Time actually spent silent inside the hold came out at 0.03 and 0.22 s
at the top against 1.13 and 0.80 s at the bottom.

**Why it survived.** `onset.mjs` measured only the trough→peak edge, so every number
the toolbox printed was about the bottom, which was fine. And 0830, the session all
of these constants were fitted to, is the one recording that holds equally at both
ends — measured on it, a symmetric gate looks correct.

**Fix.** `stillFor > 0.35` and a 0.30 s release, chosen from a 3×3 grid over the two
and validated on all eight readable sessions. Top silence improved on six, was
unchanged on two; exhale-early counts improved on four and regressed on none; the
inhale onset did not move on seven of eight. The full before/after table is in the
comment on `detectRest` in `src/breath.js`.

**Three things measured and rejected**, so nobody re-tries them:

- **`stillFor > 0.25`.** Buys 2033 one more breath and costs 2041 four times over —
  its inhale arrives 1.92 s late instead of 0.82 s, with whole inhales silent.
- **Enter threshold 0.22 → 0.30.** Reads better on the early counts while taking the
  gate to 43–56% of a session, and pushes 2041's inhale onset to −2.5 s. That is
  buying silence, which is the failure this gate exists to avoid. The thresholds
  decide *whether* a hold is a hold and were never what was wrong.
- **A separate `slopePeak` per direction.** Fixes 2041's late inhale (−1.92 → −0.82 s
  at `stillFor` 0.25) and regresses the top on every other recording, because the
  reference flips sign mid-hold: 0830 went 1/23 → 6/23 early, p90 0.22 → 0.85 s.

**The remaining cost, and the open question.** 2041's inhale now arrives 0.82 s late
instead of 0.27 s. Its exhale is 1.33× faster than its inhale, so `slopePeak` is set
by the exhale and the inhale then has to climb to half of the *other* stroke's peak
before the gate reopens. A reference that serves two strokes of different speeds
fairly, without flipping mid-hold, is unsolved. It needs a recording with a strongly
asymmetric breath and a deep signal to work against — 2041 is asymmetric but shallow,
which confounds the two.

---

## 5. What each fix was measured against

| fix | recording | what it measured |
|---|---|---|
| baseline τ from 12 s to 3 periods | 0830 | A high-pass turns a hold into a ramp: across a 10 s hold a 12 s baseline has climbed 57% back, so the sound swelled a median 1.9 s early and up to 9.8 s early. |
| rest reference from `mean · 1.57` to a followed peak | 0830 | The sinusoid ratio is wrong for breathing with holds in it; 12% of a hold-heavy session read as rest where 43% does now. |
| detector period ceiling 30 s → 70 s | 0830 | The longest breath in the session was discarded outright; 6 of 28 periods sat within 20% of being discarded. |
| audio rate floor 4/min → 2/min | 0830 | At a real 2.9/min the velocity reference was 32% too large for the whole session. |
| `REST_WARM`, the settling transient | 2055 | The projection swung to the clamp five times faster than any real stroke, `slopePeak` latched to 1.90, and the gate sat at 0.00 through the first three inhales. |
| hysteresis `H` scaled to stroke depth | 0830 | A fixed 0.34 was 19% of a measured stroke; 56 of 57 exhale bottoms cleared it more than 0.6 s early. |
| settling (§4c) | table, shaking, 1313 | A phone on a table reported `follow` 0.88 and locked its axis onto the tap. |
| sign from the lead-in | 1122, and 0830 | Both sessions the owner called inverted are the two whose axis came out negative; the sign is a coin flip and the lead-in resolves it. |
| **rest-gate latency (§4)** | **2033, 1907, 2041, + five more** | **The top hold is a third the length of the bottom one, and the gate was too slow for it.** |
| **exported axis (§6)** | **2041** | **The last axis event is sampled while the phone is being picked up.** |

---

## 6. Traps in the data itself

**`calibration.axis` in a file exported before 0.20.0 is unreliable.** It was filled
from the *last* `axis` event, and a session ends with the phone being picked up, which
swings the tilt by tens of degrees while the axis tracker follows it. 2041 ran thirteen
minutes at `[-0.03, 0.995, 0.09]` and was exported carrying `[-0.42, 0.90, 0.10]` —
24° off. Filtering on the event's own `ok` flag is not enough, because confidence lags
by several cycles and recovers to 0.59 and 0.84 while the axis is still 35° and 24° off.
`Store.calFromEvents` now takes the **median of the confident samples**, and
`tools/analyze.mjs` recomputes the same way so the files already committed read
correctly. Every session here then agrees to a few degrees: `[~0, 0.99, ~0.1]`.

**`calibration.flipped` is not a warning.** It records whether `resolveSign()` inverted
the eigenvector, which has no natural sign of its own — so the flag says the mechanism
ran, not that the session came out upside down. It is set on two of the thirteen files
here, and one of them is 0830, the reference session. Reading it as "something went
wrong with this recording" is a mistake; the sessions the owner actually experienced as
inverted are 1117 and 1122, and `flipped` is **false** on both, because they predate
`resolveSign()`.

**`20260831-0853` has no raw motion** because `Review.persist()` called
`Store.put(session)` with a session deliberately fetched without its samples, and so
labelling a recording destroyed its raw signal. `Store._write` now refuses any write
that would replace a non-empty motion channel with an empty one, and there is no
metadata-edit path left at all. Three of the four recordings that existed at the time
were destroyed this way; two of them were deleted as unreplayable.

**The `rest` channel in an export is the gate as it ran on that build**, and every
number the tools print is today's tracker re-run over old motion. `onset.mjs` prints
both side by side for exactly this reason. When they disagree, the recorded one is
history and the replayed one is the code you are about to change.

**Recordings before 0.12.0 carry no `app.build`.** 0829 and 0830 predate it.

---

## 7. Working with these files

```bash
node tools/analyze.mjs recordings/breathe-20260903-2033.json   # describe it
node tools/replay.mjs  recordings/breathe-20260903-2033.json   # re-run the tracker
node tools/onset.mjs   recordings/breathe-20260903-2033.json   # timing against the body
node tools/onset.mjs   recordings/some.json --src /tmp/variant-src   # A/B a change
```

`onset.mjs` is the one that answers "did this change help". It measures **both**
turnarounds and, in its last block, how much of each hold the sound was actually
silent for — which is the number that matches what a person reports. It skips a
recording with no raw motion, and skips one with no settled, confident stretch.

**To A/B a constant properly:** copy `src/` somewhere, edit the copy, and run
`onset.mjs` over every session it can read with `--src` pointing at each. Eight
sessions is enough to tell a real improvement from a fit to one recording — which is
the mistake §4 documents. `--src` is the only flag; there is no `--html`.

**Do not re-tune the confidence terms against these files.** Fourteen recordings from
one body is not a sample, and the sensitivity control exists so a user can settle it
on their own.

---

## 8. What is worth recording next

- **A session with a deep signal and a strongly asymmetric breath**, to work on the
  open question in §4. 2041 is asymmetric but shallow, so it cannot separate the two.
- **A second body.** Everything above is one person. Every threshold that reads as
  "measured" is measured on them.
- **A session with a real heart-rate reference.** The pulse estimator agrees with an
  independently written one to 5.5/min and has still never been checked against an
  actual heartbeat. Two implementations of one method agreeing is not validation.
- **Anything on an Android phone.** Nobody has run this on one.
