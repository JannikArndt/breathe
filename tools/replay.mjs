#!/usr/bin/env node
/**
 * replay.mjs — push a recorded session back through the real tracker.
 *
 * There is no build step and no module system in index.html, so this file
 * slices sections 0-3 out of the single-file app and evaluates them in Node,
 * exactly the way tools/dsp-harness.mjs does. The harness feeds the tracker
 * synthetic tilt; this feeds it a real recording, so an algorithm change can
 * be judged against breathing that actually happened.
 *
 *   node tools/replay.mjs session.json
 *   node tools/replay.mjs session.json --from 300 --to 480
 *   node tools/replay.mjs session.json --html ../other.html --json
 *
 * --from/--to bound what is *reported and plotted*, in seconds from the start
 * of the recording. The tracker is always fed from t=0 regardless, because its
 * baseline (tau = 12 s) and AGC (tau = 14 s) filters carry state: replaying a
 * stretch cold would measure the settling transient, not the algorithm.
 *
 * Exit code 0 on a successful replay, 1 on a bad file or a failed slice.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- args */
const argv = process.argv.slice(2);
const opt = { json: false, from: null, to: null, html: null, file: null, cycles: 24 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const take = () => argv[++i];
  if (a === '--json') opt.json = true;
  else if (a === '--from') opt.from = parseFloat(take());
  else if (a === '--to') opt.to = parseFloat(take());
  else if (a === '--html') opt.html = take();
  else if (a === '--cycles') opt.cycles = parseInt(take(), 10);
  else if (a.startsWith('--from=')) opt.from = parseFloat(a.slice(7));
  else if (a.startsWith('--to=')) opt.to = parseFloat(a.slice(5));
  else if (a.startsWith('--html=')) opt.html = a.slice(7);
  else if (a === '--session') opt.session = take();
  else if (a.startsWith('--session=')) opt.session = a.slice(10);
  else if (a === '-h' || a === '--help') { usage(); process.exit(0); }
  else if (a.startsWith('-')) die(`unknown option ${a}`);
  else if (!opt.file) opt.file = a;
  else die(`unexpected argument ${a}`);
}
if (!opt.file) { usage(); process.exit(1); }

function usage() {
  console.log(`usage: node tools/replay.mjs <session.json> [options]

  --from <sec>   first second to report on   (tracker still runs from 0)
  --to <sec>     last second to report on
  --html <path>  app to slice the tracker out of (default ../index.html)
  --cycles <n>   how many detected cycles to list (default 24, 0 = all)
  --json         machine-readable output, no plot
  --session <id> which session to replay out of an "Export all" bundle`);
}
function die(msg) { console.error('replay: ' + msg); process.exit(1); }

/* ---------------------------------------------------------------- the app */
const htmlPath = resolve(opt.html || `${here}/../index.html`);
let html;
try { html = readFileSync(htmlPath, 'utf8'); }
catch (e) { die(`cannot read ${htmlPath}: ${e.message}`); }

const js = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
if (!js) die('no <script> block found in ' + htmlPath);

/* Sections 0-3, i.e. from `const clamp` to the banner of whatever section
   follows the pacer. Keyed off "3. PACER" rather than the name of the next
   section, so this keeps working as sections are inserted after it. */
const a = js.indexOf('const clamp');
const pacer = js.indexOf('3. PACER');
let b = pacer >= 0 ? js.indexOf('/* =====', pacer) : -1;
if (b < 0) {                                    // fall back to the harness's markers
  for (const marker of ['   4. RECORDER + STORE', '   4. SPEECH', '   3. SPEECH', '   4. APP', '   4. ', '   7. APP']) {
    const m = js.indexOf(marker);
    if (m > 0) { b = js.lastIndexOf('/* =====', m); break; }
  }
}
if (a < 0 || b < 0) die('section markers moved — update the slice in this file');

let Breath, clamp, lp;
try {
  ({ Breath, clamp, lp } =
    new Function(js.slice(a, b) + '\nreturn {Breath, clamp, lp};')());
} catch (e) { die('sections 0-3 would not evaluate: ' + e.message); }
if (!Breath) die('sliced code did not define Breath');

/* ---------------------------------------------------------------- session */
let S;
try { S = JSON.parse(readFileSync(resolve(opt.file), 'utf8')); }
catch (e) { die(`cannot read ${opt.file}: ${e.message}`); }
if (!S || typeof S !== 'object') die('not a session object');

// "Export all" writes a bundle, because phone browsers refuse a burst of
// downloads. Unwrap it here rather than making the phone export one at a time.
if (/^(breathe|tide)-sessions\//.test(String(S.format || ''))) {
  const all = Array.isArray(S.sessions) ? S.sessions : [];
  if (!all.length) die('bundle contains no sessions');
  const want = opt.session || null;
  let chosen = want ? all.find(x => x && x.id === want) : null;
  if (want && !chosen) die(`no session ${want} in this bundle`);
  if (!chosen) {
    chosen = all[0];
    if (all.length > 1) {
      console.log(`bundle of ${all.length} sessions — replaying the first.`);
      console.log('pick another with --session <id>:');
      for (const x of all) console.log('  ' + (x && x.id));
      console.log('');
    }
  }
  S = chosen;
}

if (!/^(breathe|tide)-session\//.test(String(S.format || '')))
  die(`unexpected format ${JSON.stringify(S.format)}, want breathe-session/1`);

const rows = (S.motion && S.motion.rows) || [];
if (rows.length < 60)
  die(`motion.rows has ${rows.length} samples — nothing to replay ` +
      `(was this exported with the raw channel dropped?)`);

const app = S.app || {};
const labels = (S.labels || []).slice().sort((x, y) => x.tSec - y.tSec);
const t0 = rows[0][0];
const tEnd = rows[rows.length - 1][0];
const from = opt.from === null || !isFinite(opt.from) ? t0 : Math.max(t0, opt.from);
const to = opt.to === null || !isFinite(opt.to) ? tEnd : Math.min(tEnd, opt.to);
if (to <= from) die(`--from ${from} is not before --to ${to}`);

/* ---------------------------------------------------------------- rate */
const dts = [];
for (let i = 1; i < rows.length; i++) dts.push(rows[i][0] - rows[i - 1][0]);
const sorted = dts.slice().sort((x, y) => x - y);
const medianDt = sorted[sorted.length >> 1];
const gapLimit = medianDt * 3;
const gaps = [];
for (let i = 0; i < dts.length; i++)
  if (dts[i] > gapLimit) gaps.push({ tSec: r3(rows[i][0]), sec: r3(dts[i]) });
const rate = {
  samples: rows.length,
  spanSec: r3(tEnd - t0),
  meanHz: r2((rows.length - 1) / (tEnd - t0)),
  medianHz: r2(1 / medianDt),
  minDt: r3(sorted[0]),
  maxDt: r3(sorted[sorted.length - 1]),
  gaps: gaps.length,
  worstGapSec: gaps.length ? Math.max(...gaps.map(g => g.sec)) : 0,
  claimedHz: (S.device && S.device.sampleHz) || null
};

/* ------------------------------------------------------------- axis tracking */
// There is no calibration step to replay. The tracker finds the axis as it
// goes, so the useful comparison is where it ends up against what the session
// recorded, and how long it took to get there.
const cal = S.calibration || {};
const recordedAxis = Array.isArray(cal.axis) && cal.axis.length === 3 ? cal.axis : null;

Breath.invert = false;          // the toggle is reported separately, not applied twice
Breath.begin(rows[0][0]);

// Run the first 30 s to see how quickly the axis settles.
let i = 0, axisAt = {};
const axisMarks = [5, 10, 20, 30];
for (; i < rows.length; i++) {
  const el = rows[i][0] - t0;
  if (el > 30) break;
  Breath.push(rows[i][1], rows[i][2], rows[i][3], rows[i][0]);
  for (const m of axisMarks)
    if (axisAt[m] === undefined && el >= m) axisAt[m] = Breath.u.slice();
}
const dotOf = v => (v && recordedAxis)
  ? r4(Math.abs(v[0]*recordedAxis[0] + v[1]*recordedAxis[1] + v[2]*recordedAxis[2]))
  : null;
const calibration = {
  recordedAxis,
  axisAfter: axisMarks.reduce((o,m)=>{ o[m+'s'] = dotOf(axisAt[m]); return o; }, {}),
  amplitude: r4(Breath.axisAmp),
  recordedAmplitude: typeof cal.amplitude === 'number' ? cal.amplitude : null,
  confidence: r3(Breath.conf),
  follow: r3(Breath.follow)
};
i = 0;   // and replay the whole thing from the start for the run below
Breath.begin(rows[0][0]);

/* ---------------------------------------------------------------- run */
Breath.invert = !!app.invert;

const HZ = 10;                                    // same snapshot rate the app records at
const track = [];                                 // {t,s,level,phase,bpm,quality,rich,restGate}
const cycles = [];                                // {tSec, kind, periodSec, bpm}
let prevPeak = Breath.lastPeakT, prevTrough = Breath.lastTroughT;
// Snapshots start where the tracker starts producing output: during
// calibration Breath.push() returns before it sets s, so there is nothing
// to sample and the plot is honestly blank there.
let rich = 0.4, lastT = rows[i] ? rows[i][0] : calEnd;
let nextSnap = rows[i] ? rows[i][0] : calEnd;

for (; i < rows.length; i++) {
  const t = rows[i][0];
  if (t > to) break;
  Breath.push(rows[i][1], rows[i][2], rows[i][3], t);

  let dt = t - lastT; lastT = t;
  if (!(dt > 0) || dt > 0.5) dt = medianDt;

  // mirrors loop() in section 6 so the reward channel can be compared too
  const slow = clamp((14 - (Breath.bpmSmooth || 14)) / 8, 0, 1);
  rich = lp(rich, clamp(0.28 + 0.72 * slow, 0, 1), dt, 3.0);

  if (Breath.lastPeakT !== prevPeak) {
    prevPeak = Breath.lastPeakT;
    cycles.push({ tSec: r3(prevPeak - t0), kind: 'peak', periodSec: r2(Breath.period), bpm: r2(Breath.bpm) });
  }
  if (Breath.lastTroughT !== prevTrough) {
    prevTrough = Breath.lastTroughT;
    cycles.push({ tSec: r3(prevTrough - t0), kind: 'trough', periodSec: r2(Breath.period), bpm: r2(Breath.bpm) });
  }

  while (t >= nextSnap) {
    track.push({
      t: r3(nextSnap - t0), s: r3(Breath.s), level: r3(Breath.level()), phase: r3(Breath.phase),
      // the app shows a rate only above 0.45 confidence, so neither does this
      bpm: r2(Breath.conf > 0.45 ? Breath.bpmSmooth : 0),
      quality: r3(Breath.quality()), rich: r3(rich),
      restGate: r3(Breath.restGate), strokeAmp: r2(Breath.strokeAmp),
      conf: r3(Breath.conf), follow: r3(Breath.follow)
    });
    nextSnap += 1 / HZ;
  }
}
cycles.sort((x, y) => x.tSec - y.tSec);

const inWin = v => v.t >= from - t0 && v.t <= to - t0;
const win = track.filter(inWin);
if (!win.length) die('no samples fall inside the reported window');
const winCycles = cycles.filter(c => c.tSec >= from - t0 && c.tSec <= to - t0);

/* what the app itself believed at the time, for comparison */
const recDerived = (S.derived && S.derived.rows) || [];
const recIdx = { t: 0, bpm: 4, quality: 5 };
const recorded = recDerived.filter(r => r[recIdx.t] >= from - t0 && r[recIdx.t] <= to - t0);

const stats = block => {
  const bpm = block.map(v => v.bpm !== undefined ? v.bpm : v[recIdx.bpm]).filter(v => v > 0);
  const q = block.map(v => v.quality !== undefined ? v.quality : v[recIdx.quality]);
  return {
    n: block.length,
    meanBpm: bpm.length ? r2(bpm.reduce((x, y) => x + y, 0) / bpm.length) : 0,
    minBpm: bpm.length ? r2(Math.min(...bpm)) : 0,
    maxBpm: bpm.length ? r2(Math.max(...bpm)) : 0,
    meanQuality: q.length ? r3(q.reduce((x, y) => x + y, 0) / q.length) : 0
  };
};
const replayed = stats(win);
const asRecorded = recorded.length ? stats(recorded) : null;

/* ---------------------------------------------------------------- labels */
const marks = labels.filter(l => l.tSec >= from - t0 && l.tSec <= to - t0);
const stretches = labels.map((l, k) => {
  const a2 = l.tSec;
  const b2 = k + 1 < labels.length ? labels[k + 1].tSec : (to - t0);
  const seg = track.filter(v => v.t >= a2 && v.t < b2);
  const st = seg.length ? stats(seg) : { n: 0, meanBpm: 0, minBpm: 0, maxBpm: 0, meanQuality: 0 };
  return {
    kind: l.kind, note: l.note || '', fromSec: r2(a2), toSec: r2(b2), sec: r2(b2 - a2),
    breaths: cycles.filter(c => c.kind === 'trough' && c.tSec >= a2 && c.tSec < b2).length,
    ...st
  };
}).filter(s => s.toSec > s.fromSec && s.toSec > from - t0 && s.fromSec < to - t0);

const out = {
  file: opt.file, app: htmlPath,
  session: { id: S.id, startedAt: S.startedAt, durationSec: S.durationSec, device: S.device || {}, app },
  window: { fromSec: r3(from - t0), toSec: r3(to - t0), warmedFromZero: (from - t0) > 0 },
  sampleRate: rate,
  calibration,
  replayed, asRecorded,
  recordedSummary: S.summary || null,
  cycles: winCycles,
  labels: stretches,
  gaps: gaps.slice(0, 20)
};

if (opt.json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

/* ---------------------------------------------------------------- report */
const W = Math.max(60, Math.min((process.stdout.columns || 100) - 2, 140));
const GUT = 8;
const PW = W - GUT;

hr();
say(`session   ${S.id}`);
say(`recorded  ${S.startedAt}   ${fmtDur(S.durationSec)}   ${(S.device && S.device.ua) || 'unknown device'}`);
say(`settings  sound ${app.voice || '?'}` +
    ` · flip ${app.invert ? 'on' : 'off'}${app.demo ? ' · DEMO (simulated motion)' : ''}`);
say(`app       ${htmlPath}`);
hr();

head('sample rate');
say(`  ${rate.samples} samples over ${fmtDur(rate.spanSec)}`);
say(`  ${rate.meanHz} Hz mean` + (rate.claimedHz ? `   (the file claims ${rate.claimedHz} Hz)` : ''));
say(`  intervals ${rate.minDt}s .. ${rate.maxDt}s   (t is stored to 1 ms, so 60 Hz alternates 16/17 ms)`);
say(`  ` + (rate.gaps ? `${rate.gaps} gap(s) over ${r3(gapLimit)}s, worst ${rate.worstGapSec}s` : 'no dropouts'));
if (rate.gaps) say(`  first gaps: ` + gaps.slice(0, 5).map(g => `${g.tSec}s/${g.sec}s`).join('  '));

head('axis tracking');
say(`  recorded axis ${vec(calibration.recordedAxis)}` +
    (calibration.recordedAmplitude !== null ? `   amplitude ${calibration.recordedAmplitude} m/s^2` : ''));
say(`  tracked to    ` + Object.entries(calibration.axisAfter)
      .map(([k,v]) => `${k} ${v === null ? '-' : v}`).join('   ') + `   (1.000 = same direction)`);
say(`  after 30 s    amplitude ${calibration.amplitude} m/s^2   follow ${calibration.follow}   confidence ${calibration.confidence}`);

head('detected rate');
if (out.window.warmedFromZero)
  say(`  reporting ${out.window.fromSec}s .. ${out.window.toSec}s; the tracker was fed from 0s so its filters are settled`);
say(`  replayed   mean ${replayed.meanBpm}/min   range ${replayed.minBpm}..${replayed.maxBpm}   quality ${replayed.meanQuality}`);
if (asRecorded)
  say(`  as recorded mean ${asRecorded.meanBpm}/min   range ${asRecorded.minBpm}..${asRecorded.maxBpm}   quality ${asRecorded.meanQuality}` +
      `   ${verdict(replayed.meanBpm, asRecorded.meanBpm)}`);
if (S.summary) say(`  file summary  ${S.summary.breaths} breaths, mean ${S.summary.meanBpm}/min, ` +
                   `slowest 30s ${S.summary.slowestBpm}/min, ${S.summary.secondsUnder7}s under 7/min`);

plot();
rateStrip();

head('detected cycles');
if (!winCycles.length) say('  none — no peak/trough pair cleared the hysteresis');
else {
  const troughs = winCycles.filter(c => c.kind === 'trough');
  say(`  ${troughs.length} full cycles (trough to trough), ${winCycles.length - troughs.length} peaks`);
  const show = opt.cycles > 0 && winCycles.length > opt.cycles;
  const list = show ? winCycles.slice(0, opt.cycles) : winCycles;
  for (const c of list)
    say(`    ${pad(c.tSec + 's', 10)} ${pad(c.kind, 7)} ` +
        (c.periodSec ? `period ${pad(c.periodSec + 's', 7)} ${c.bpm}/min` : 'period not established yet'));
  if (show) say(`    ... ${winCycles.length - opt.cycles} more (--cycles 0 for all)`);
}

head('labels');
if (!labels.length) say('  none. Label a session in the app and the stretches show up here.');
if (stretches.length < labels.length)
  say(`  (${labels.length - stretches.length} label(s) fall outside ${out.window.fromSec}s..${out.window.toSec}s and are not listed)`);
for (const s of stretches) {
  say(`  ${pad(s.kind, 14)} ${pad(s.fromSec + 's', 9)}-> ${pad(s.toSec + 's', 10)} ${pad(fmtDur(s.sec), 7)}` +
      `  ${pad(s.meanBpm + '/min', 10)} ${pad(s.breaths + ' breaths', 12)} quality ${s.meanQuality}` +
      (s.note ? `\n                 "${s.note}"` : ''));
}
hr();
process.exit(0);

/* ---------------------------------------------------------------- drawing */

function plot() {
  const H = 15, lo = from - t0, span = (to - t0) - lo;
  const secPerCol = span / PW;
  const period = 60 / (replayed.meanBpm || 10);
  // Below about three columns per breath the min/max band saturates and the
  // waveform tells you nothing. At that zoom the useful picture is the rate.
  const waveform = secPerCol < period / 3;

  head(waveform ? 'projected signal' : 'rate');
  if (waveform) say(`  ${r3(lo)}s .. ${r3(lo + span)}s, ${win.length} snapshots at ${HZ} Hz`);
  else {
    say(`  ${r3(lo)}s .. ${r3(lo + span)}s — ${r1(secPerCol)}s per column is about ` +
        `${r1(secPerCol / period)} breaths, too dense for a waveform.`);
    say(`  Plotting the detected rate instead; use --from/--to to zoom into a stretch.`);
  }

  const grid = [];
  for (let r = 0; r < H; r++) grid.push(new Array(PW).fill(' '));
  const colOf = t => Math.min(PW - 1, Math.max(0, Math.floor((t - lo) / span * PW)));

  let top, bot, mainOf, guideOf, zeroVal;
  if (waveform) {
    let amp = 1.0;
    for (const v of win) amp = Math.max(amp, Math.abs(v.s));
    top = amp; bot = -amp; zeroVal = 0;
    mainOf = v => v.s; guideOf = v => v.restGate * 2 - 1;
  } else {
    let mn = Infinity, mx = -Infinity;
    for (const v of win) {
      if (v.bpm > 0) { mn = Math.min(mn, v.bpm); mx = Math.max(mx, v.bpm); }
    }
    if (!isFinite(mn)) { mn = 4; mx = 16; }
    const padv = Math.max(0.4, (mx - mn) * 0.12);
    top = mx + padv; bot = Math.max(0, mn - padv);
    zeroVal = 6;
    mainOf = v => (v.bpm > 0 ? v.bpm : null);
    guideOf = () => null;
  }
  const rowOf = v => Math.min(H - 1, Math.max(0, Math.round((top - v) / (top - bot) * (H - 1))));

  const mn = new Array(PW).fill(Infinity), mx = new Array(PW).fill(-Infinity);
  const pmn = new Array(PW).fill(Infinity), pmx = new Array(PW).fill(-Infinity);
  for (const v of win) {
    const c = colOf(v.t);
    const a2 = mainOf(v), g = guideOf(v);
    if (a2 !== null) { if (a2 < mn[c]) mn[c] = a2; if (a2 > mx[c]) mx[c] = a2; }
    if (g !== null) { if (g < pmn[c]) pmn[c] = g; if (g > pmx[c]) pmx[c] = g; }
  }

  const zrow = (zeroVal >= bot && zeroVal <= top) ? rowOf(zeroVal) : -1;
  if (zrow >= 0) for (let c = 0; c < PW; c++) grid[zrow][c] = '-';
  for (let c = 0; c < PW; c++) {                      // guide first, breath draws over it
    if (pmn[c] === Infinity) continue;
    for (let r = rowOf(pmx[c]); r <= rowOf(pmn[c]); r++) grid[r][c] = '.';
  }
  for (let c = 0; c < PW; c++) {
    if (mn[c] === Infinity) continue;
    for (let r = rowOf(mx[c]); r <= rowOf(mn[c]); r++) grid[r][c] = '#';
  }

  const lab = v => waveform ? (v >= 0 ? '+' : '') + v.toFixed(1) : v.toFixed(1);
  for (let r = 0; r < H; r++) {
    let g = ' '.repeat(GUT);
    if (r === 0) g = pad(lab(top), GUT);
    else if (r === H - 1) g = pad(lab(bot), GUT);
    else if (r === zrow) g = pad(lab(zeroVal), GUT);
    console.log(g + grid[r].join(''));
  }

  if (waveform) {
    const mk = new Array(PW).fill(' ');
    for (const c of winCycles) mk[colOf(c.tSec)] = c.kind === 'peak' ? '^' : 'v';
    console.log(pad('peak ^', GUT) + mk.join(''));
  }

  // calibration window, which produces no tracker output
  const cs = calStart - t0, ce = calEnd - t0;
  if (ce > lo && cs < lo + span) {
    const cb = new Array(PW).fill(' ');
    for (let c = colOf(Math.max(cs, lo)); c <= colOf(Math.min(ce, lo + span)); c++) cb[c] = '=';
    console.log(pad('cal =', GUT) + cb.join(''));
  }

  if (marks.length) {
    const lm = new Array(PW).fill(' ');
    marks.forEach((l, k) => { lm[colOf(l.tSec)] = String((k + 1) % 10); });
    console.log(pad('label', GUT) + lm.join(''));
  }

  const ax = new Array(PW).fill(' ');
  const ticks = 6;
  for (let k = 0; k <= ticks; k++) {
    const str = fmtDur(lo + span * k / ticks);
    const anchor = Math.round(k / ticks * (PW - 1));
    const st = Math.max(0, Math.min(PW - str.length, anchor - (k === ticks ? str.length - 1 : 0)));
    for (let j = 0; j < str.length; j++) ax[st + j] = str[j];
  }
  console.log(pad('time', GUT) + ax.join(''));

  say('  ' + (waveform
      ? '# your breath   . rest gate (low = held still)   ^ peak   v trough   = calibrating (no output)'
      : '# your rate   = calibrating (no output)') +
    (marks.length ? '   ' + marks.map((l, k) => `${k + 1}=${l.kind}`).join(' ') : ''));
}

function rateStrip() {
  head('rate over time');
  const step = Math.max(10, Math.round((to - from) / 10 / 10) * 10);
  const cols = [];
  for (let t = from - t0; t < to - t0; t += step) {
    const seg = track.filter(v => v.t >= t && v.t < t + step);
    const bpm = seg.map(v => v.bpm).filter(v => v > 0);
    cols.push({
      t: Math.round(t),
      you: bpm.length ? (bpm.reduce((x, y) => x + y, 0) / bpm.length) : 0,
      gate: seg.length ? seg[seg.length - 1].restGate : 1,
      q: seg.length ? seg.reduce((x, y) => x + y.quality, 0) / seg.length : null,
      n: seg.length
    });
  }
  const per = Math.max(4, Math.floor((W - 10) / 7));
  for (let k = 0; k < cols.length; k += per) {
    const c = cols.slice(k, k + per);
    say('  ' + pad('t', 8) + c.map(v => pad(fmtDur(v.t), 7)).join(''));
    say('  ' + pad('you', 8) + c.map(v => pad(v.you ? v.you.toFixed(1) : '-', 7)).join(''));
    say('  ' + pad('gate', 8) + c.map(v => pad(v.gate != null ? v.gate.toFixed(2) : '-', 7)).join(''));
    say('  ' + pad('signal', 8) + c.map(v => pad(v.n ? v.q.toFixed(2) : '-', 7)).join(''));
    if (k + per < cols.length) say('');
  }
}

/* ---------------------------------------------------------------- small */
function r1(v) { return Math.round((v || 0) * 10) / 10; }
function r2(v) { return Math.round((v || 0) * 100) / 100; }
function r3(v) { return Math.round((v || 0) * 1000) / 1000; }
function r4(v) { return Math.round((v || 0) * 10000) / 10000; }
function pad(s, n) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }
function say(s) { console.log(s); }
function head(s) { console.log('\n' + s.toUpperCase()); }
function hr() { console.log('-'.repeat(Math.min(W, 78))); }
function vec(v) { return v ? '[' + v.map(x => (x >= 0 ? ' ' : '') + x.toFixed(3)).join(', ') + ']' : '(none)'; }
function fmtDur(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function verdict(a2, b2) {
  if (!b2) return '';
  const d = a2 - b2;
  return Math.abs(d) < 0.25 ? '(agrees)' : `(replay differs by ${d > 0 ? '+' : ''}${r2(d)}/min)`;
}
