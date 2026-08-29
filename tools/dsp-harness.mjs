#!/usr/bin/env node
/**
 * dsp-harness.mjs — headless test for the breath tracker.
 *
 * There is no build step and no module system in index.html, so this file
 * slices sections 0-2 out of the single-file app and evaluates them in Node.
 * Section 1 (audio) comes along for the ride; it is inert because nothing
 * calls Audio.start(), which is the only place Web Audio is touched.
 *
 *   node tools/dsp-harness.mjs [path-to-html]
 *
 * Exit code 0 = all assertions passed, 1 = at least one failed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(process.argv[2] || `${here}/../index.html`);

// ---------------------------------------------------------------- extract
const html = readFileSync(htmlPath, 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!js) fail('no <script> block found in ' + htmlPath);

const START = 'const clamp';
const END = '   4. SPEECH';
const a = js.indexOf(START);
const b = js.indexOf(END);
if (a < 0 || b < 0) fail('section markers moved — update START/END in this harness');

// walk back to the start of the banner comment that precedes "3. SPEECH"
const core = js.slice(a, js.lastIndexOf('/* =====', b));

const { Breath, Pulse } = new Function(core + '\nreturn { Breath, Pulse };')();

// ---------------------------------------------------------------- utils
const TAU = Math.PI * 2;
let failures = 0;

function fail(msg) { console.error('FAIL ' + msg); process.exit(1); }

function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if (!ok) failures++;
}

/** Raised-cosine belly tilt, amplitude in m/s^2 on the gravity vector. */
function tilt(u, inShare) {
  return u < inShare
    ? (1 - Math.cos(Math.PI * u / inShare)) / 2 - 0.5
    : (1 + Math.cos(Math.PI * (u - inShare) / (1 - inShare))) / 2 - 0.5;
}

/**
 * Feed synthetic motion samples.
 * @param opts.bpm       breaths per minute
 * @param opts.secs      duration
 * @param opts.amp       peak-to-peak tilt in m/s^2. 0.9 is what real sessions
 *                        measure: the two recordings in recordings/ came back
 *                        at 0.32 and 0.45 m/s^2 RMS along the breath axis,
 *                        which is about 0.9-1.3 peak-to-peak. This used to say
 *                        0.09 and call it "a relaxed adult belly" — an
 *                        assumption nobody had checked against a recording,
 *                        and wrong by a factor of ten.
 * @param opts.inShare   fraction of the cycle spent inhaling
 * @param opts.axis      unit vector the breath moves along
 * @param opts.flip      invert the physical signal (phone upside down)
 * @param opts.noise     white noise amplitude in m/s^2
 * @param opts.drift     baseline drift in m/s^2 per minute
 */
function feed(state, opts) {
  const { bpm, secs, amp = 0.9, inShare = 0.45, axis = [0.81, 0, 0.58],
          flip = false, noise = 0.004, drift = 0 } = opts;
  const dt = 1 / 60, period = 60 / bpm;
  for (let i = 0; i < secs / dt; i++) {
    state.t += dt;
    state.u = (state.u + dt / period) % 1;
    const s = tilt(state.u, inShare) * amp * (flip ? -1 : 1);
    const d = drift * state.t / 60;
    const n = () => (Math.random() - 0.5) * 2 * noise;
    Breath.push(
      axis[0] * s + 0.30 + d + n(),
      axis[1] * s + 0.15 + n(),
      axis[2] * s + 9.79 + n()
    , state.t);
  }
}

function session(opts) {
  const state = { t: 0, u: 0 };
  Breath.begin(0);
  // There is no calibration step any more. The first 20 s are just the first
  // 20 s: the axis is tracked from the start and sharpens as breaths arrive.
  feed(state, { ...opts, secs: 20 });
  feed(state, { ...opts, secs: opts.secs ?? 90 });
  return { state };
}

// ---------------------------------------------------------------- tests
console.log('source: ' + htmlPath + '\n');

// 1. axis recovery
{
  const axis = [0.81, 0, 0.58];
  session({ bpm: 12, axis });
  const dot = Math.abs(Breath.u[0] * axis[0] + Breath.u[1] * axis[1] + Breath.u[2] * axis[2]);
  check('breath axis recovered with no calibration step', dot > 0.97, `|u.axis| = ${dot.toFixed(3)}`);

  // and it is usable early, which is the point of tracking it continuously
  const st = { t: 0, u: 0 };
  Breath.begin(0);
  feed(st, { bpm: 12, axis, secs: 12 });
  const early = Math.abs(Breath.u[0]*axis[0] + Breath.u[1]*axis[1] + Breath.u[2]*axis[2]);
  check('axis is close after 12 s', early > 0.95, `|u.axis| = ${early.toFixed(3)}`);
}

// 2. rate tracking, fast then slow
{
  const state = { t: 0, u: 0 };
  Breath.begin(0);
  feed(state, { bpm: 12, secs: 20 });
  feed(state, { bpm: 12, secs: 90 });
  const fast = Breath.bpmSmooth;
  feed(state, { bpm: 6, secs: 120 });
  const slow = Breath.bpmSmooth;
  check('tracks 12/min', Math.abs(fast - 12) < 0.6, `${fast.toFixed(2)}/min`);
  check('tracks 6/min', Math.abs(slow - 6) < 0.6, `${slow.toFixed(2)}/min`);
}

// 3. inhale/exhale split, true 2 s in / 5 s out
//
// Expect a systematic skew, not the true values. The tau = 0.35 s smoothing
// filter delays a sharp transition more than a gentle one, so on asymmetric
// breathing the peak lands late and the trough early: reported inhale runs
// ~0.4 s long and exhale ~0.4 s short at a 7 s cycle. This is measured, stable
// at zero noise, and harmless for the app, which uses the ratio and the sum.
// If these bounds start failing, the smoothing time constant has moved.
{
  session({ bpm: 60 / 7, inShare: 2 / 7, secs: 90 });
  const i = Breath.inhaleDur, o = Breath.exhaleDur;
  check('inhale duration (true 2.0 s, skewed long)',
    i > 2.1 && i < 2.9, `${i.toFixed(2)} s`);
  check('exhale duration (true 5.0 s, skewed short)',
    o > 4.1 && o < 4.9, `${o.toFixed(2)} s`);
  check('skew cancels in the total', Math.abs(i + o - 7) < 0.35,
    `${(i + o).toFixed(2)} s vs 7.00 s`);
  check('exhale still reads clearly longer', o > i * 1.6,
    `ratio ${(o / i).toFixed(2)}`);
}

// 4. sign heuristic: phone mounted either way up must give the same split
{
  session({ bpm: 60 / 7, inShare: 2 / 7, flip: true, secs: 90 });
  check('sign corrected when flipped',
    Breath.exhaleDur > Breath.inhaleDur * 1.5,
    `in ${Breath.inhaleDur.toFixed(2)} s / out ${Breath.exhaleDur.toFixed(2)} s`);
}

// 5. rejection: postural drift must not register as breathing
{
  session({ bpm: 6, drift: 0.6, secs: 120 });
  check('survives 0.6 m/s^2 per minute of drift',
    Math.abs(Breath.bpmSmooth - 6) < 0.8, `${Breath.bpmSmooth.toFixed(2)}/min`);
}

// 6. quality meter falls when the body is fidgeting
{
  // Noise scales with the signal it is judged against: these were 0.004 and
  // 0.09 when the synthetic breath was ten times smaller than a real one.
  session({ bpm: 6, noise: 0.04, secs: 60 });
  const clean = Breath.quality();
  session({ bpm: 6, noise: 0.9, secs: 60 });
  const noisy = Breath.quality();
  check('quality distinguishes still from restless',
    clean > 0.6 && noisy < clean * 0.75, `clean ${clean.toFixed(2)} / noisy ${noisy.toFixed(2)}`);
}

// 7. phase convention: 0 at the top of the inhale, positive while exhaling
{
  const state = { t: 0, u: 0 };
  Breath.begin(0);
  feed(state, { bpm: 6, inShare: 0.5, secs: 20 });
  feed(state, { bpm: 6, inShare: 0.5, secs: 60 });

  const dt = 1 / 60, obs = [];
  for (let i = 0; i < 90 / dt; i++) {
    feed(state, { bpm: 6, inShare: 0.5, secs: dt });
    obs.push([Breath.level(), Breath.phase, Breath.dsLp]);
  }
  obs.sort((p, q) => q[0] - p[0]);
  const top = obs.slice(0, Math.floor(obs.length * 0.02));
  const worst = Math.max(...top.map(o => Math.abs(o[1])));
  check('phase ~0 at full inhale', worst < 0.7, `max |phase| = ${worst.toFixed(2)} rad`);

  const rising = obs.filter(o => o[2] > 0.4);
  const badSign = rising.filter(o => o[1] > 0).length / Math.max(rising.length, 1);
  check('phase negative while inhaling', badSign < 0.05,
    `${(badSign * 100).toFixed(1)}% wrong sign`);
}

// 7b. the signal is live from the start
{
  const state = { t: 0, u: 0 };
  Breath.begin(0);
  feed(state, { bpm: 10, secs: 4 });
  const early = [];
  for (let i = 0; i < 60 * 8; i++) { feed(state, { bpm: 10, secs: 1 / 60 }); early.push(Breath.s); }
  const span = Math.max(...early) - Math.min(...early);
  check('the signal is live in the first seconds', span > 0.5, `range ${span.toFixed(2)}`);
}

// 7c. confidence tells breathing from everything else
{
  // Real breathing, at the depth a relaxed adult produces.
  session({ bpm: 10, secs: 180 });
  const real = Breath.conf;
  check('confident on real breathing', real > 0.6, `conf = ${real.toFixed(2)}`);

  // A phone on a table: sensor noise, no breath. The first real recording of
  // this measured 0.011 m/s^2 against 0.32-0.46 for a belly.
  {
    const st = { t: 0 };
    Breath.begin(0);
    for (let i = 0; i < 60 * 180; i++) {
      st.t = (st.t || 0) + 1 / 60;
      const n = () => (Math.random() - 0.5) * 0.008;
      Breath.push(0.30 + n(), 0.15 + n(), 9.79 + n(), st.t);
    }
    check('not fooled by a phone on a table', Breath.conf < 0.05, `conf = ${Breath.conf.toFixed(3)}`);
  }

}

// 7d. the same question, against a real recording rather than an imitation of one
// A phone left on a table and then waved around by hand. Synthetic "not
// breathing" is easy to get wrong in the app's favour, so this reads the actual
// sensor stream. Skipped, not failed, when the file is not checked out.
{
  const path = `${here}/../recordings/breathe-20260829T115717-bogus.json`;
  let S = null;
  try { S = JSON.parse(readFileSync(path, 'utf8')); } catch { /* not present */ }
  const rows = S && S.motion && S.motion.rows;
  if (!rows || !rows.length) {
    console.log('skip  real not-breathing recording (recordings/ not checked out)');
  } else {
    Breath.begin(rows[0][0]);
    let peak = 0;
    for (const r of rows) { Breath.push(r[1], r[2], r[3], r[0]); peak = Math.max(peak, Breath.conf); }
    // This recording is what motivated the confidence gate: before it existed
    // the app reported 248 breaths at 26/min from this file.
    check('a real not-breathing recording stays rejected', peak < 0.2,
      `peak conf = ${peak.toFixed(3)} over ${(S.durationSec).toFixed(0)} s`);
  }
}

// 8. the learned stroke amplitude tracks the signal, and scales the hysteresis
{
  session({ bpm: 10, secs: 120 });
  const amp = Breath.strokeAmp;
  // After the AGC the normalised stroke settles near 2; the interesting claim is
  // that it lands in a range where H is well clear of both clamp ends, so the
  // threshold is actually being driven by the measurement.
  check('stroke amplitude is learned', amp > 1.2 && amp < 3.2, `strokeAmp = ${amp.toFixed(2)}`);
  const H = Math.min(0.80, Math.max(0.30, amp * 0.30));
  check('hysteresis scales off the clamp ends', H > 0.31 && H < 0.79, `H = ${H.toFixed(2)}`);
}

// 9. a held breath reads as rest, and an ordinary stroke does not
{
  // Breathe normally, then hold still for 8 s at the bottom of an exhale — the
  // case the first real recording is full of. `resting` must fire during the
  // hold and the gate must fall; mid-stroke it must do neither.
  const state = { t: 0, u: 0 };
  Breath.begin(0);
  feed(state, { bpm: 8, secs: 20 });
  feed(state, { bpm: 8, secs: 60 });

  // sample the gate through a normal stroke
  let midGate = 1, midResting = false;
  for (let i = 0; i < 60 * 2; i++) {
    feed(state, { bpm: 8, secs: 1 / 60 });
    if (Math.abs(Breath.vel()) > 0.25) { midGate = Math.min(midGate, Breath.restGate); midResting = midResting || Breath.resting; }
  }

  // now hold: freeze the phase and keep feeding the same tilt plus sensor noise
  const held = state.u;
  let restedAt = null, gateLow = 1;
  for (let i = 0; i < 60 * 8; i++) {
    state.t += 1 / 60;
    state.u = held;
    feed(state, { bpm: 8, secs: 1 / 60 });
    state.u = held;
    if (Breath.resting && restedAt === null) restedAt = i / 60;
    gateLow = Math.min(gateLow, Breath.restGate);
  }
  check('a hold is detected as rest', restedAt !== null && restedAt < 3.0,
    restedAt === null ? 'never fired' : `after ${restedAt.toFixed(1)} s`);
  check('the gate closes on a hold', gateLow < 0.25, `gate fell to ${gateLow.toFixed(2)}`);
  check('an ordinary stroke is not rest', midResting === false && midGate > 0.75,
    `gate stayed ${midGate.toFixed(2)}`);
}

// 10. the experimental pulse estimator
{
  // A heartbeat in an accelerometer is a short damped ring once per beat, not a
  // sinusoid. 62 bpm at 4 milli-g, which is the low end of what a torso
  // produces, buried under a breathing tilt ten times larger.
  const HR = 62, dt = 1 / 60;
  Pulse.enabled = true;
  Pulse.reset();
  let t = 0, phase = 0;
  for (let i = 0; i < 60 * 45; i++) {
    t += dt;
    phase += dt * HR / 60;
    const since = (phase % 1) * 60 / HR;              // seconds since the last beat
    // damped 9 Hz ring, 90 ms long: roughly the shape of a J-wave in a phone
    const beat = since < 0.09 ? Math.exp(-since * 34) * Math.sin(TAU * 9 * since) : 0;
    const breath = 0.045 * Math.sin(TAU * t / 6);      // 10/min, 60x larger
    const noise = (Math.random() - 0.5) * 0.0009;
    Pulse.push(9.81 + breath + beat * 0.004 + noise, dt, t);
  }
  const got = Pulse.bpm;
  check('pulse recovers a synthetic heartbeat', got > 0 && Math.abs(got - HR) < 4,
    got > 0 ? `${got.toFixed(1)} bpm vs ${HR}` : 'reported nothing');

  // The same signal with the beat removed must NOT produce a number. Reporting
  // a heart rate off noise is worse than reporting none.
  Pulse.reset();
  t = 0;
  for (let i = 0; i < 60 * 45; i++) {
    t += dt;
    Pulse.push(9.81 + 0.045 * Math.sin(TAU * t / 6) + (Math.random() - 0.5) * 0.0009, dt, t);
  }
  check('pulse stays silent on noise alone', Pulse.bpm === 0,
    Pulse.bpm ? `claimed ${Pulse.bpm.toFixed(1)} bpm` : 'reported nothing');

  // And it must refuse while the body is moving, whatever it last computed.
  Pulse.bpm = 65;
  check('pulse refuses while the body moves', Pulse.reading(0.2) === 0);
  Pulse.enabled = false;
}

console.log('');
if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('all checks passed');
