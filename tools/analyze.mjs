#!/usr/bin/env node
/**
 * analyze.mjs — characterise a recorded session.
 *
 * Where replay.mjs re-runs the shipping tracker over a recording, this reads the
 * derived channel the app already wrote and describes the *breathing*: how long
 * the cycles were, how deep, and — the reason this exists — how much of each
 * cycle the user spent holding still at the turnaround.
 *
 *   node tools/analyze.mjs recordings/some-session.json
 *   node tools/analyze.mjs bundle.json --session <id>
 *   node tools/analyze.mjs s.json --json          # machine-readable
 */
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
  console.log(`usage: node tools/analyze.mjs <recording.json> [--session <id>] [--json]`);
  process.exit(argv.length ? 0 : 1);
}
const die = m => { console.error('analyze: ' + m); process.exit(1); };

let file = null, wantSession = null, asJson = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--session') wantSession = argv[++i];
  else if (a === '--json') asJson = true;
  else if (a.startsWith('-')) die(`unknown option ${a}`);
  else if (!file) file = a;
  else die('give one file');
}
if (!file) die('no file given');

let S;
try { S = JSON.parse(readFileSync(file, 'utf8')); }
catch (e) { die(`could not read ${file}: ${e.message}`); }

// "Export all" writes a bundle; pick one session out of it.
if (/^(breathe|tide)-sessions\//.test(String(S.format || ''))) {
  const all = Array.isArray(S.sessions) ? S.sessions : [];
  if (!all.length) die('bundle contains no sessions');
  const chosen = wantSession ? all.find(x => x && x.id === wantSession) : all[0];
  if (!chosen) die(`no session ${wantSession} in this bundle`);
  if (!wantSession && all.length > 1)
    console.error(`# bundle holds ${all.length} sessions; using ${chosen.id}. --session <id> picks another.`);
  S = chosen;
}

const D = S.derived;
if (!D || !Array.isArray(D.rows) || !D.rows.length)
  die('this file has no derived rows — it was exported without them');

const ix = {}; D.columns.forEach((c, i) => ix[c] = i);
const col = name => {
  if (!(name in ix)) die(`derived channel has no "${name}" column`);
  return D.rows.map(r => r[ix[name]]);
};
const t = col('t'), s = col('s'), quality = col('quality'), bpmCol = col('bpm');
const n = t.length;
const hz = D.hz || (n - 1) / (t[n - 1] - t[0]);

const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.max(0, Math.round((b.length - 1) * p)))]; };
const med = a => pct(a, 0.5);
const f2 = x => Number(x.toFixed(2));

/* ---------- cycles from the recorded turning points ----------
   The app already found these; re-deriving them here would measure this script
   rather than the app. The breath events carry the inhale and exhale it timed. */
const events = (S.events || []).filter(e => e.type === 'breath' && e.inhaleSec > 0);

/* ---------- turning points from the signal itself ----------
   Needed for the amplitude and stillness numbers, which the events do not carry.
   Same hysteresis rule as the tracker, so the segmentation matches what shipped. */
/* The tracker's hysteresis scales with the stroke depth it has learned; this is
   the middle of that range and is only used for segmenting a recording after
   the fact, never for deciding anything. */
const H = 0.5;
const turns = [];
let rising = true, ext = s[0], extI = 0;
for (let i = 1; i < n; i++) {
  const v = s[i];
  if (rising) {
    if (v > ext) { ext = v; extI = i; }
    else if (v < ext - H) { turns.push({ i: extI, t: t[extI], v: ext, kind: 'peak' }); rising = false; ext = v; extI = i; }
  } else {
    if (v < ext) { ext = v; extI = i; }
    else if (v > ext + H) { turns.push({ i: extI, t: t[extI], v: ext, kind: 'trough' }); rising = true; ext = v; extI = i; }
  }
}

/* ---------- stillness at the turnaround ----------
   The complaint this script was written for: after a long exhale the user rests,
   the belly barely moves, and the app calls that rest the start of an inhale.
   A pause is a run of samples whose slope stays under a fraction of the median
   inhale slope. Measured per half-cycle so a pause can be attributed to the
   turnaround it follows. */
const dsdt = new Array(n).fill(0);
for (let i = 1; i < n; i++) dsdt[i] = (s[i] - s[i - 1]) / Math.max(1e-3, t[i] - t[i - 1]);

const strokes = [];
for (let k = 0; k + 1 < turns.length; k++) {
  const a = turns[k], b = turns[k + 1];
  const span = b.t - a.t;
  if (span < 0.5 || span > 40) continue;
  strokes.push({
    kind: a.kind === 'trough' ? 'inhale' : 'exhale',
    t0: a.t, t1: b.t, sec: span,
    amp: Math.abs(b.v - a.v),
    peakSlope: Math.max(...dsdt.slice(a.i, b.i + 1).map(Math.abs))
  });
}
const inh = strokes.filter(x => x.kind === 'inhale');
const exh = strokes.filter(x => x.kind === 'exhale');
const medAmp = strokes.length ? med(strokes.map(x => x.amp)) : 0;
const medSlope = strokes.length ? med(strokes.map(x => x.peakSlope)) : 0;

// A sample is "still" when the belly is moving under 18% of a typical stroke's
// peak slope. Below that the excursion over a whole second is a fifth of a
// breath — a rest, not a stroke.
const STILL = 0.18 * medSlope;
/* The gate the app itself ran with, when the recording carries it. Everything
   else in this section is re-derived after the fact from the signal; this one
   is what the sound actually did, and the two are worth reading together. */
const ci = {};
((S.derived && S.derived.columns) || []).forEach((c, i) => { ci[c] = i; });
let recordedHeld = null;
if (ci.rest != null && S.derived.rows.length) {
  const held = S.derived.rows.filter(r => r[ci.rest] < 0.5).length;
  recordedHeld = Math.round(100 * held / S.derived.rows.length);
}

const pauses = [];
let run = null;
for (let i = 1; i < n; i++) {
  if (Math.abs(dsdt[i]) < STILL) { if (!run) run = { t0: t[i], i0: i }; run.t1 = t[i]; run.i1 = i; }
  else { if (run && run.t1 - run.t0 >= 0.8) pauses.push(run); run = null; }
}
if (run && run.t1 - run.t0 >= 0.8) pauses.push(run);

// Where does each pause sit? After a trough (bottom of the exhale) is the case
// the user reported.
const afterTrough = [], afterPeak = [];
for (const p of pauses) {
  let last = null;
  for (const tp of turns) { if (tp.t <= p.t0 + 0.25) last = tp; else break; }
  if (!last) continue;
  (last.kind === 'trough' ? afterTrough : afterPeak).push({ ...p, sinceTurn: p.t0 - last.t });
}

/* ---------- how small is the motion the tracker would trip on? ----------
   The tracker flips to "inhaling" once the signal rises H above the trough. If
   the user's rest wobbles by more than H before the real inhale, the sound turns
   around early. This counts the troughs where that happens. */
let earlyFlips = 0, flipLead = [];
for (const tp of turns) {
  if (tp.kind !== 'trough') continue;
  // find the first sample after the trough that clears H, and the first that
  // clears half the median stroke — a rise that is unambiguously an inhale.
  let tH = null, tReal = null;
  for (let i = tp.i + 1; i < n; i++) {
    const rise = s[i] - tp.v;
    if (tH === null && rise > H) tH = t[i];
    if (rise > medAmp * 0.5) { tReal = t[i]; break; }
    if (t[i] - tp.t > 25) break;
  }
  if (tH !== null && tReal !== null && tReal - tH > 0.6) { earlyFlips++; flipLead.push(tReal - tH); }
}

const out = {
  file, id: S.id, startedAt: S.startedAt,
  durationSec: f2(S.durationSec || t[n - 1]),
  derivedHz: f2(hz),
  motionRows: (S.motion && S.motion.rows && S.motion.rows.length) || 0,
  motionCount: (S.motion && S.motion.count) || 0,
  calibration: S.calibration,
  quality: { median: f2(med(quality)), p10: f2(pct(quality, 0.1)) },
  rate: { medianBpm: f2(med(bpmCol.filter(x => x > 0))), fromEvents: events.length },
  cycles: {
    n: strokes.length,
    inhaleSec: { p25: f2(pct(inh.map(x => x.sec), 0.25)), med: f2(med(inh.map(x => x.sec))), p75: f2(pct(inh.map(x => x.sec), 0.75)) },
    exhaleSec: { p25: f2(pct(exh.map(x => x.sec), 0.25)), med: f2(med(exh.map(x => x.sec))), p75: f2(pct(exh.map(x => x.sec), 0.75)) },
    amp: { p10: f2(pct(strokes.map(x => x.amp), 0.1)), med: f2(medAmp), p90: f2(pct(strokes.map(x => x.amp), 0.9)) },
    peakSlope: { med: f2(medSlope) }
  },
  stillness: {
    stillSlopeThreshold: f2(STILL),
    pauses: pauses.length,
    totalSec: f2(pauses.reduce((a, p) => a + (p.t1 - p.t0), 0)),
    shareOfSession: f2(pauses.reduce((a, p) => a + (p.t1 - p.t0), 0) / (t[n - 1] - t[0])),
    medianSec: pauses.length ? f2(med(pauses.map(p => p.t1 - p.t0))) : 0,
    longestSec: pauses.length ? f2(Math.max(...pauses.map(p => p.t1 - p.t0))) : 0,
    afterExhaleBottom: afterTrough.length,
    afterInhaleTop: afterPeak.length
  },
  earlyOnset: {
    troughs: turns.filter(x => x.kind === 'trough').length,
    flaggedEarly: earlyFlips,
    medianLeadSec: flipLead.length ? f2(med(flipLead)) : 0,
    worstLeadSec: flipLead.length ? f2(Math.max(...flipLead)) : 0
  }
};

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const R = [];
R.push(`session   ${out.id || '(no id)'}   ${out.startedAt || ''}`);
R.push(`length    ${out.durationSec} s     derived ${out.derivedHz} Hz     motion rows ${out.motionRows}${out.motionCount && !out.motionRows ? ` (of ${out.motionCount} recorded — exported without them)` : ''}`);
if (out.calibration) R.push(`axis      [${out.calibration.axis.map(x => x.toFixed(3)).join(', ')}]  amplitude ${out.calibration.amplitude}  flipped ${out.calibration.flipped}`);
R.push(`quality   median ${out.quality.median}   worst tenth ${out.quality.p10}`);
R.push('');
R.push(`rate      median ${out.rate.medianBpm}/min over ${out.cycles.n} strokes (${out.rate.fromEvents} breath events)`);
R.push(`inhale    ${out.cycles.inhaleSec.p25} / ${out.cycles.inhaleSec.med} / ${out.cycles.inhaleSec.p75} s   (p25 / median / p75)`);
R.push(`exhale    ${out.cycles.exhaleSec.p25} / ${out.cycles.exhaleSec.med} / ${out.cycles.exhaleSec.p75} s`);
R.push(`depth     ${out.cycles.amp.p10} / ${out.cycles.amp.med} / ${out.cycles.amp.p90} normalised units (p10 / median / p90)`);
R.push('');
R.push(`stillness  a "pause" is >= 0.8 s under ${out.stillness.stillSlopeThreshold} units/s, 18% of a typical stroke's peak slope`);
R.push(`           ${out.stillness.pauses} pauses, ${out.stillness.totalSec} s total — ${Math.round(out.stillness.shareOfSession * 100)}% of the session`);
if (recordedHeld !== null)
  R.push(`           the app's own gate read ${recordedHeld}% of the session as held`);
R.push(`           median ${out.stillness.medianSec} s, longest ${out.stillness.longestSec} s`);
R.push(`           ${out.stillness.afterExhaleBottom} after the bottom of an exhale, ${out.stillness.afterInhaleTop} after the top of an inhale`);
R.push('');
R.push(`early onset  of ${out.earlyOnset.troughs} exhale bottoms, ${out.earlyOnset.flaggedEarly} cross the H=${H} hysteresis`);
R.push(`             more than 0.6 s before the signal reaches half a typical stroke.`);
R.push(`             median lead ${out.earlyOnset.medianLeadSec} s, worst ${out.earlyOnset.worstLeadSec} s`);
console.log(R.join('\n'));
