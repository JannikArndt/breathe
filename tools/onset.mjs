#!/usr/bin/env node
/**
 * onset.mjs — how early does the sound start, measured against the body?
 *
 * The complaint this exists to measure: "the timing was often way too early".
 * Nothing else in the toolbox can see it. The harness feeds synthetic tilt,
 * which is a clean sinusoid with no holds in it, and replay.mjs reports rate
 * and cycle counts — both of which were already right while the sound was
 * arriving seconds before the breath.
 *
 * Ground truth is the accelerometer with the tau = 0.35 s smoothing and
 * nothing else: no high-pass, no AGC, projected on the axis the tracker
 * settled on. That is the shape the belly actually made. Cycles are segmented
 * from it directly with a generous 22% hysteresis, because ground truth must
 * not invent breaths.
 *
 * For each real breath:
 *   takeoff  the tilt has risen 15% of the way from trough to peak — the
 *            inhale has genuinely started
 *   sound    vel * restGate, which is what drives the swell, first passes
 *            25% of its peak for that cycle
 *
 *   lead = takeoff - sound.   Positive means the app is early.
 *
 * Needs a recording with raw motion rows; sessions exported before that fix
 * carry only the derived channels and are skipped with a message.
 *
 *   node tools/onset.mjs recordings/some-session.json
 *   node tools/onset.mjs recordings/some-session.json --html other.html
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let file = null, srcDir = resolve(here, '..', 'src');
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--src') srcDir = argv[++i];
  else if (argv[i].startsWith('--src=')) srcDir = argv[i].slice(6);
  else if (!file) file = argv[i];
}
if (!file) { console.log('usage: node tools/onset.mjs <session.json> [--src src/]'); process.exit(1); }

/* ---- the tracker that ships, imported straight from the module ---- */
const load = n => import(pathToFileURL(resolve(srcDir, n)).href);
const { Breath } = await load('breath.js');
const { lp } = await load('util.js');

const S = JSON.parse(readFileSync(resolve(file), 'utf8'));
if (!S.motion || !S.motion.rows || !S.motion.rows.length) {
  console.error(`${file} carries no raw motion rows — nothing to measure against.`);
  process.exit(1);
}
const rows = S.motion.rows;
const dtAt = i => i ? Math.max(0.001, Math.min(0.5, rows[i][0] - rows[i - 1][0])) : 1 / 60;

/* ---- pass 1: the real tracker ---- */
Breath.begin(0);
Breath.invert = !!(S.app && S.app.invert);
if (S.app && typeof S.app.sensitivity === 'number') Breath.sensitivity = S.app.sensitivity;
const tr = [];
let t = 0;
for (let i = 0; i < rows.length; i++) {
  t += dtAt(i);
  Breath.push(rows[i][1], rows[i][2], rows[i][3], t);
  tr.push({ t, vel: Breath.vel(), gate: Breath.restGate });
}
const u = Breath.u.slice(), inv = Breath.invert ? -1 : 1;

/* ---- pass 2: ground truth, smoothed only ---- */
const raw = [];
let sm = null;
for (let i = 0; i < rows.length; i++) {
  const dt = dtAt(i), v = [rows[i][1], rows[i][2], rows[i][3]];
  if (!sm) sm = v.slice();
  else for (let k = 0; k < 3; k++) sm[k] = lp(sm[k], v[k], dt, 0.35);
  raw.push(inv * (sm[0] * u[0] + sm[1] * u[1] + sm[2] * u[2]));
}

/* Only the stretch the owner marked as usable, when there is one: the handling
   at each end of a session is exactly the kind of movement this tool would
   otherwise report as a breath with a wild onset. */
const trim = S.trim || null;
const inTrim = i => !trim || (tr[i].t >= trim.fromSec && tr[i].t <= trim.toSec);

/* ---- segment ground truth ---- */
/* The range has to be measured inside the trim. This signal is smoothed and
   nothing else — no high-pass — so picking the phone up at either end of the
   session swings it by the better part of 2 g, while a breath moves it by
   fractions of one. On the 2055 recording the whole file spans 19.6 m/s^2 and
   the breathing inside the trim spans 0.375, so a threshold taken from the
   whole file came out 11x larger than a breath and the tool found no cycles at
   all. Falling back to the whole file when there is no trim keeps the old
   behaviour for untrimmed recordings. */
let lo = Infinity, hi = -Infinity;
for (let i = 0; i < raw.length; i++) {
  if (!inTrim(i)) continue;
  if (raw[i] < lo) lo = raw[i];
  if (raw[i] > hi) hi = raw[i];
}
if (!(hi > lo)) { lo = Infinity; hi = -Infinity; for (const v of raw) { if (v < lo) lo = v; if (v > hi) hi = v; } }
const H = (hi - lo) * 0.22;
const ext = [];
let up = true, best = raw[0], bestI = 0;
for (let i = 1; i < raw.length; i++) {
  const v = raw[i];
  if (up) { if (v > best) { best = v; bestI = i; } else if (best - v > H) { ext.push({ i: bestI, kind: 'peak', v: best }); up = false; best = v; bestI = i; } }
  else    { if (v < best) { best = v; bestI = i; } else if (v - best > H) { ext.push({ i: bestI, kind: 'trough', v: best }); up = true;  best = v; bestI = i; } }
}

const leads = [], strokes = [], gates = [];
for (let k = 0; k < ext.length - 1; k++) {
  if (ext[k].kind !== 'trough' || ext[k + 1].kind !== 'peak') continue;
  if (!inTrim(ext[k].i) || !inTrim(ext[k + 1].i)) continue;
  const lowP = ext[k], highP = ext[k + 1];
  const thr = lowP.v + (highP.v - lowP.v) * 0.15;
  let iTake = lowP.i; while (iTake < highP.i && raw[iTake] < thr) iTake++;

  let pk = 0;
  for (let i = lowP.i; i <= highP.i; i++) pk = Math.max(pk, Math.max(0, tr[i].vel) * tr[i].gate);
  let iSnd = lowP.i; while (iSnd < highP.i && Math.max(0, tr[iSnd].vel) * tr[iSnd].gate < 0.25 * pk) iSnd++;

  // the gate at the moment the belly is moving fastest — the sound has to be
  // fully open there, or the fix for "too early" has bought silence instead
  let steep = 0, iSteep = lowP.i;
  for (let i = lowP.i + 30; i < highP.i - 30; i++) {
    const d = raw[i + 30] - raw[i - 30];
    if (d > steep) { steep = d; iSteep = i; }
  }

  leads.push(+(tr[iTake].t - tr[iSnd].t).toFixed(2));
  strokes.push(+(tr[highP.i].t - tr[iTake].t).toFixed(1));
  gates.push(+tr[iSteep].gate.toFixed(2));
}

if (!leads.length) { console.error('no complete breaths found in the raw signal'); process.exit(1); }
const med = arr => { const s = arr.slice().sort((x, y) => x - y); return s[s.length >> 1]; };
const heldPct = (100 * tr.filter(x => x.gate < 0.5).length / tr.length).toFixed(0);

/* What the app actually did at the time, if the recording carries it. Every
   number above comes from re-running today's tracker over old motion, which
   answers "how would this code behave" and not "how did it behave". The rest
   channel is the app's own gate as it ran, so the two side by side say whether
   a change moved the thing it was meant to move. */
const dv = S.derived || {};
const di = {};
(dv.columns || []).forEach((c, i) => { di[c] = i; });
let asRun = null;
if (di.rest != null && dv.rows && dv.rows.length) {
  const held = dv.rows.filter(r => r[di.rest] < 0.5).length;
  asRun = (100 * held / dv.rows.length).toFixed(0);
}

console.log(`${file}`);
console.log(`  ${leads.length} breaths over ${t.toFixed(0)} s   sensitivity ${Breath.sensitivity}` +
            (trim ? `   (marked usable ${trim.fromSec.toFixed(0)}-${trim.toSec.toFixed(0)} s)` : ''));
console.log(`  inhale, takeoff to peak     median ${med(strokes)} s   range ${Math.min(...strokes)}–${Math.max(...strokes)} s`);
console.log(`  sound starts before it      median ${med(leads)} s   worst ${Math.max(...leads)} s`);
console.log(`  held (gate under half)      ${heldPct}% of the session` +
            (asRun !== null ? `   (${asRun}% when it was recorded)` : ''));
console.log(`  gate at the steepest point  median ${med(gates)}   worst ${Math.min(...gates)}   (1 = wide open)`);
console.log(`  per breath: ${leads.join(' ')}`);
