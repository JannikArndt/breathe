# Plan: posture, sign and lock time

Written 2026-08-31 against the five recordings added that day. Everything in
section 1 is measured from those files; nothing here is synthetic.

## 1. What the recordings say

### 1.1 The phone's orientation is available, and it separates every case cleanly

`accelerationIncludingGravity` is the gravity vector in device coordinates, so
smoothing it (tau = 1.5 s, well below breathing) gives the phone's attitude
relative to down. That is not a compass heading -- rotation about the vertical
is unknowable from the accelerometer -- but "is it flat, is it moving, is it
being carried" needs only the tilt.

Tilt is measured from display-up-flat, as the angle between the device's -z
axis and gravity. Across the whole folder:

| recording | tilt p50 | tilt change p50 | tilt change p95 |
|---|---|---|---|
| 1001 phone on a table | 0.59 deg | 0.00 deg/s | 0.02 deg/s |
| 1131 belly, good session | 1.99 deg | 0.46 deg/s | 1.86 deg/s |
| 1122 belly | 2.42 deg | 0.79 deg/s | 2.24 deg/s |
| 1117 hand, then belly | 3.21 deg | 1.34 deg/s | 15.74 deg/s |
| 0830 belly | 5.27 deg | 0.51 deg/s | 1.23 deg/s |
| 1003 in the hand, moving | 48.26 deg | 4.19 deg/s | 24.94 deg/s |

Three usable facts:

- **A table is rigid in a way a body never is.** 0.59 deg tilt that varies by
  0.03 deg peak to peak, against 2-5 deg on a belly. This is a far sharper
  discriminator than the amplitude test in section 4a of `CLAUDE.md`, and it
  is one the sensitivity slider does not have to trade against.
- **Being carried is obvious within a second.** 48 deg of tilt and 4 deg/s.
- **Putting the phone down is a discrete event.** A settle rule of
  "tilt < 35 deg and changing by < 1.5 deg/s, held for 4 s" fires at 12.0 s
  (1131), 15.1 s (1122), 18.5 s (1117), 4.8 s (0830), and never on 1003.

### 1.2 The direction is a coin flip, and that is the inversion

Every session that locked found the *same line* in device coordinates. Taking
1131 -- the session the owner called great -- as the reference:

| recording | axis | dot | angle to that line | owner's verdict |
|---|---|---|---|---|
| 1131 | -0.158, 0.986, 0.054 | +1.000 | 0.0 deg | great |
| 0853 | -0.186, 0.981, 0.053 | +1.000 | 1.6 deg | fine |
| 0830 | -0.001, 0.995, 0.104 | +0.986 | 9.5 deg | fine |
| 1122 | 0.099, -0.993, -0.058 | **-0.998** | 3.4 deg | **inverse** |
| 1117 | -0.133, -0.879, 0.457 | **-0.822** | 34.8 deg | **inverse** (never locked) |

The axis is reproducible to within a few degrees across five sessions on four
days. The *sign* is not, and the sign is exactly what predicts the owner's
report. Both inverse sessions are the two negative dots; all three positive
dots were fine.

Why: an eigenvector has no natural sign, and `trackAxis` seeds power iteration
from `u = [0,0,1]`, the screen normal. The breath axis is close to +/-y, nearly
orthogonal to that seed, so which side it converges to is settled by noise in
the first seconds. `resolveSign()` is meant to correct it and never fired --
`flipped` is false in all five files, including both inverse ones.

It could not have fired correctly anyway. It flips when
`exhaleDur < inhaleDur * 0.8`, on the assumption that relaxed breathing exhales
more slowly than it inhales. **This owner is the other way round**: 1131
measures inhale 13.27 s against exhale 10.41 s, and 1122's inverted reading of
inhale 5.81 / exhale 9.35 is a true inhale of 9.35 against an exhale of 5.81.
**Correction (same day).** That last paragraph overstated it. The detector
measures the interval between turning points, so a pause lands inside whichever
stroke it falls in -- and in 1131, 58% of the held time sits mid-wave rather
than at either end. Those figures do not show the owner's inhale is the longer
one; they show the split is not a clean read of either. Which is reason enough
to distrust the test, but not evidence about a body.

### 1.3 Locking takes one to three minutes

First axis event with `ok: true`: **91 s** on 1131, **192 s** on 1122, never on
1117 (109 s long). That is the "it took forever" complaint, measured.

Three things stack up, and none of them is a bug on its own:

- rhythm is capped at 0.30 until three periods exist, and confidence must pass
  0.45 to report. At 2.8 breaths a minute three periods is 65 s at the
  absolute best.
- the baseline starts at tau = 12 s and only widens as a period is learned, so
  the first minute is high-passed far too hard for a 21 s breath.
- the axis, the AGC and the stroke amplitude all start from defaults, and 1117
  spent its first 18.5 s being carried, which is what the axis learned from.

## 2. What to do

Ordered by how much each is worth. Each is independently shippable.

### 2.0 DONE (0.16.0) -- open on a wave, and read the direction off it

The session now opens on the home screen's wave at 6/min and hands over after
three waves, or sooner once there is enough movement to follow. Breathing along
with a known reference is what makes the direction *observable*: `resolveSign()`
correlates the measured signal against it, and leaves the sign alone when there
is not enough reference to judge on. Measured over the first 30 s of each
recording, belly sessions accumulate 8.6, 77 and 135 against a threshold of 1.0;
a table manages 0.11.

This supersedes 2.2 below and does most of what 2.5 was for. 2.1 is still worth
having -- it would resolve the direction on the very first breath rather than
after one wave, and it is the answer for anyone who turns the lead-in off.

### 2.1 Remember the axis between sessions  -- would resolve it sooner still

Store the settled axis, in device coordinates, in the existing `prefs` store,
and seed `trackAxis` from it instead of from `[0,0,1]`. Because the axis is
reproducible to a few degrees for the same person with the same habit, this
resolves the sign for free and removes most of the convergence time with it.

- write it only from a session that actually locked (`conf` sustained above
  the reporting threshold), so a bad session cannot poison the next one
- when *Flip direction* is used, write the flipped axis -- so the toggle
  becomes a one-time correction instead of something to remember every session
- if the remembered axis and the measured line disagree by more than ~40 deg,
  the phone is somewhere new: drop the memory and start cold
- first ever session still needs a cold start, so 2.2 still matters

### 2.2 SUPERSEDED by 2.0 -- the shape statistic

Kept for the record, and as a warning against reviving it.

The timing assumption is measurably wrong here. The shape statistic is better:
the signal lingers at the exhaled bottom. On the correctly-signed 1131 the
median sits at 0.250 of the range with 55% of samples in the bottom third; on
1122, inverted, it sits at 0.778 with 56% in the top third -- flipping it puts
it back where 1131 is. 1117 does not test this: it never locked and is too
short for the baseline to settle.

So: **two recordings agree and a third is silent.** That is not enough to
declare a rule. Treat 2.2 as a proposal to test against the next few sessions,
not a finding. Do not tune it against these files.

Whatever replaces it, delete the `exhaleDur < inhaleDur * 0.8` test -- it is
not merely unproven, it is backwards for the only body measured.

### 2.3 DONE (0.17.0) -- a settle gate, from the tilt

Shipped, and with two corrections to what is written above.

**The rate test in 1.1 does not survive a fast breather.** It separates every
recording here cleanly, but every recording here is slow breathing. Against a
synthetic 12 and 20 a minute at the same depth it never settles at all, because
at those rates a breath alone turns the tilt faster than any usable threshold.
What shipped instead compares two smoothed copies of the gravity vector, tau =
4 s and tau = 12 s: an oscillation moves them together, a step pulls them apart.
That settles 3, 6, 12 and 20 a minute alike. See CLAUDE.md section 4c.

**No reset mid-session.** Once settled it stays settled. Dropping back into a
phase that reports nothing would take the sound away from someone who is still
breathing, and shifting position is already the axis tracker's and the AGC's job.

Also found on the way: **the first devicemotion event on this phone is not a
reading**, and every filter was seeded from it. Both 1 September recordings open
with one -- a phone flat and untouched reporting (1.81, -5.95, -7.81) before
settling to (0, 0, -9.85) one sample later. That single sample is most of the
"sudden movement down" a session opened with. It is dropped now.

Measured after: table 6.0 s, belly-start sessions 6.0 s, 1131 8.2 s, 1117 45 s
(the cap; its own test says 53 s, which is right -- it was in the hand that
long), three minutes of shaking never. The table session's peak `follow` falls
from 0.88 to 0.30 and its projection from 1.80 to 0.03.

### 2.4 Rigidity as the table test

A table holds still to 0.03 deg. Use the variance of the tilt, not just the
amplitude on the breath axis, to reject it. This is what would let sensitivity
rise for a shallow breather without letting a table back in.

Keep every existing test in section 4a. This is an addition, not a replacement.

### 2.5 Shorten the lock

Widen the baseline from the start rather than growing into it, and let the
three-period rhythm cap fall away sooner once the axis is remembered (2.1),
since most of what those three periods were establishing is then already known.
Re-run the DSP harness on every change here; the 3-36 s period band and the
size/rhythm/calm terms are load-bearing against the bogus recording.

## 3. What this does not fix

The sign cannot be derived from orientation. Which way the phone tilts when the
belly rises depends on where it sits relative to the apex of the curve -- above
the navel it goes one way, below it the other. The upward translation of the
belly is the placement-independent cue, but at 3 breaths a minute and a
centimetre of travel it is about 0.0005 m/s^2, three orders of magnitude under
the tilt. So: remember the axis, keep the toggle, and treat the cold-start
guess as a guess.

## 4. Test coverage to add with it

- a harness check that a remembered axis of the wrong sign is corrected, and
  that a remembered axis 90 deg away is discarded
- a replay check over 1122 and 1117 asserting the direction comes out matching
  1131's line
- a check that 1001 (table) still reports nothing, and 1003 (carried) too
- `tools/analyze.mjs` to report tilt and settle time, so posture is visible
  next to the breathing
