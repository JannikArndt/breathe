#!/usr/bin/env node
/**
 * smoke.mjs — runs the whole app in Node, with a stub DOM and a stub Web Audio.
 *
 * The harness tests the signal chain and nothing else. This is the other half:
 * it imports index.html's actual entry module, taps Start, feeds a few minutes
 * of breathing through the render loop, taps End, and looks at what the screens
 * say. It is what catches the wiring — an id that no longer resolves, a symbol
 * that moved to another module, a parameter written the wrong way — none of
 * which the harness can see and all of which look fine until a phone opens the
 * page.
 *
 *   node tools/smoke.mjs
 *
 * Exit code 0 = every check passed.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { installDom } from './stub/dom.mjs';
import { installAudio, FakeAudioContext } from './stub/audio.mjs';
import { installIdb } from './stub/idb.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

let failures = 0;
function check(name, ok, detail){
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
  if(!ok) failures++;
}

/* ---------------------------------------------------------------- clock */
let nowMs = 1000;
const frames = [];
globalThis.performance = { now: () => nowMs };
globalThis.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
globalThis.cancelAnimationFrame = () => {};

/** Let every pending microtask and timer callback run. IndexedDB, the audio
    promises and the store's own writes all resolve this way. */
async function settle(times = 6){
  for(let i = 0; i < times; i++) await new Promise(r => setTimeout(r, 0));
}

/** Advance the virtual clock and run whatever the loop scheduled. */
function tick(ms){
  nowMs += ms;
  const due = frames.splice(0, frames.length);
  due.forEach(fn => fn(nowMs));
}
function run(seconds, hz){
  const step = 1000/hz;
  for(let e = 0; e < seconds*hz; e++) tick(step);
}

/* ---------------------------------------------------------------- world */
const { document } = installDom(resolve(root, 'index.html'));
let reloaded = false;
globalThis.location.reload = () => { reloaded = true; };
installAudio();
installIdb();

// Motion: granted, and delivered by dispatching on window the way Safari does.
globalThis.DeviceMotionEvent = { requestPermission: async () => 'granted' };
globalThis.window.DeviceMotionEvent = globalThis.DeviceMotionEvent;

const $ = id => document.getElementById(id);

/* ---------------------------------------------------------------- import */
// The store is a module singleton, so this is the same object main.js drives.
const { Store } = await import(resolve(root, 'src/store.js'));

let mod;
try{
  mod = await import(resolve(root, 'src/main.js'));
}catch(e){
  console.error('FAIL  the app would not even import');
  console.error(e);
  process.exit(1);
}
check('the app imports without touching a missing element', true);
check('the version stamp is on the home screen', /\d+\.\d+\.\d+ · /.test($('buildBtn').textContent),
      JSON.stringify($('buildBtn').textContent));
await settle();
check('the store opens', Store.available, Store.lastError || '');
check('the settings row exists after the v2 upgrade',
      Store._db && Store._db.objectStoreNames.contains('prefs'));

/* ---------------------------------------------------------------- panels */
$('panelBtn').click();
check('Adjust opens', $('panel').classList.contains('open'));
$('closePanel').click();
check('Adjust closes from Back', !$('panel').classList.contains('open'));

$('buildBtn').click();
check('Changes opens from the version stamp', $('log').classList.contains('open'));
check('Changes lists the releases', $('logList').children.length >= 3,
      $('logList').children.length + ' entries');
$('closeLog').click();
check('Changes closes from Back', !$('log').classList.contains('open'));

/* ---------------------------------------------------------------- velocity */
// The reference every velocity-fed layer divides by. It has to follow the rate
// all the way down, or slowing your breathing quietly turns those layers down.
const { velRef } = await import(resolve(root, 'src/audio.js'));
const off = bpm => velRef(bpm) / (0.040*bpm);
check('velocity is scaled right at an ordinary rate', Math.abs(off(12) - 1) < 0.01,
      off(12).toFixed(2) + 'x');
check('and still right at the owner\'s 2.9/min', Math.abs(off(2.9) - 1) < 0.01,
      off(2.9).toFixed(2) + 'x');

/* ---------------------------------------------------------------- worker */
// There is no build step to keep these in step, so they are asserted instead.
const swText = readFileSync(resolve(root, 'sw.js'), 'utf8');
const swVersion = (swText.match(/const VERSION = '([^']+)'/) || [])[1];
const appVersion = ($('buildBtn').textContent.split(' ')[0]) || '';
check('the worker and the app agree on the version', swVersion === appVersion,
      `sw ${swVersion} vs app ${appVersion}`);

const shell = [...swText.matchAll(/'\.\/([^']*)'/g)].map(m => m[1]);
const onDisk = ['index.html', 'app.css', 'manifest.webmanifest', 'icon.png',
                ...readdirSync(resolve(root, 'src')).map(f => 'src/' + f)];
const missing = onDisk.filter(f => !shell.includes(f));
check('the worker precaches every file the app is made of', missing.length === 0, missing.join(' '));
const phantom = shell.filter(f => f && !existsSync(resolve(root, f)));
check('the worker precaches nothing that is not there', phantom.length === 0, phantom.join(' '));

await settle();
$('buildBtn').click();
check('with a worker registered the row offers a check, not a blind reload',
      $('reloadBtn').textContent === 'Check', JSON.stringify($('reloadBtn').textContent));

$('reloadBtn').click();
check('the button asks the server', swRegistration.updates === 1, String(swRegistration.updates));
await new Promise(r => setTimeout(r, 1400));
check('nothing new leaves it saying so', $('noticeTitle').textContent === 'Up to date',
      JSON.stringify($('noticeTitle').textContent));

const waiting = swUpdate();
check('an arriving version turns the row into an install', $('reloadBtn').textContent === 'Install',
      JSON.stringify($('reloadBtn').textContent));
check('and says so out loud', $('noticeTitle').textContent === 'A new version is ready',
      JSON.stringify($('noticeTitle').textContent));

$('reloadBtn').click();
check('installing tells the waiting worker to take over', waiting.posted === 'skip-waiting',
      JSON.stringify(waiting.posted));
check('and the app reloads itself when it does', reloaded, String(reloaded));
$('closeLog').click();

/* ---------------------------------------------------------------- settings */
// Every slider's default has to match its `value` in the markup, or Reset
// would move a control somewhere it has never been.
const DEFAULTS = {vol:'55', sens:'50', mSwell:'100', mBreak:'100', mFoam:'100',
                  mSpray:'100', mUnder:'100', mBright:'50', mSpace:'50'};
const wrong = Object.entries(DEFAULTS).filter(([id, v]) => $(id).getAttribute('value') !== v);
check('the markup carries the documented defaults', wrong.length === 0,
      wrong.map(([id]) => id).join(' '));

$('mSpray').value = '140';
$('mSpray').dispatch('input', {target: $('mSpray')});
$('tglInvert').click();
await new Promise(r => setTimeout(r, 500));   // the save is debounced at 400 ms
await settle(12);
const saved = await Store.readPrefs();
check('moving a control writes it to the store', saved.spray === 140 && saved.invert === true,
      JSON.stringify({spray: saved.spray, invert: saved.invert}));

$('resetMixBtn').click();
await settle(12);
check('Reset puts the sound controls back', $('mSpray').value === '100',
      JSON.stringify($('mSpray').value));
check('Reset leaves volume and sensitivity alone', $('vol').value === '55' && $('sens').value === '50');
$('tglInvert').click();                       // back to off for the session below
await settle();

/* ---------------------------------------------------------------- session */
$('tglDemo').click();                       // simulated breathing, no sensor needed
$('mainBtn').click();                       // Start
await Promise.resolve(); await new Promise(r => setTimeout(r, 0));
await new Promise(r => setTimeout(r, 0));   // begin() awaits two promises

check('Start switches the button to End', $('mainBtn').textContent === 'End',
      JSON.stringify($('mainBtn').textContent));
check('the intro is hidden while breathing', $('intro').classList.contains('hidden'));
check('the trace appears', !$('traceWrap').classList.contains('hidden'));
check('Recordings is out of reach mid-session', $('recBtn').classList.contains('hidden'));
check('the build line hides mid-session', $('buildLine').classList.contains('hidden'));

const ctx = FakeAudioContext.last;
run(180, 60);                               // three minutes at 60 Hz

const rateTxt = $('vRate').textContent;
check('a rate is reported after three minutes', /^\d+(\.\d+)?/.test(rateTxt) && parseFloat(rateTxt) > 3,
      JSON.stringify(rateTxt));
check('the ratio readout fills in', $('vRatio').textContent !== '—',
      JSON.stringify($('vRatio').textContent));
check('the header shows the sample rate', /demo|Hz/.test($('statusTag').textContent),
      JSON.stringify($('statusTag').textContent));

/* ---------------------------------------------------------------- try */
const { Flags, Dim } = mod;

const traceCtx = $('trace').getContext('2d');
const rectsBefore = traceCtx.calls.fillRect || 0;
run(20, 60);
const rectsPlain = (traceCtx.calls.fillRect || 0) - rectsBefore;

$('tglHeard').click();
check('an experiment can be switched on', Flags.heard === true);
const rectsAt = traceCtx.calls.fillRect || 0;
run(20, 60);
const rectsHeard = (traceCtx.calls.fillRect || 0) - rectsAt;
// The trace paints its own ground every frame either way; the held stretches
// are extra rectangles on top, so "more than before" is the signal.
check('showing what it hears paints the held stretches',
      rectsHeard > rectsPlain, `${rectsPlain} rects off, ${rectsHeard} on`);

$('tglDepth').click();
check('the crest can be told to follow depth', Flags.depthBreak === true);

$('tglDim').click();
check('dimming arms itself when switched on mid-session', Dim.timer !== null);
Dim.sleep();
check('the screen dims', document.body.classList.contains('dimmed'));
check('and a catcher takes the tap that wakes it',
      !$('dimCatch').classList.contains('hidden'));
document.dispatch('pointerdown', {});
check('a touch brings it back', !document.body.classList.contains('dimmed') && !Dim.on);
check('and the catcher steps aside', $('dimCatch').classList.contains('hidden'));

$('tglDim').click();
check('switching dimming off leaves the screen up', Flags.dim === false && Dim.on === false);
$('tglHeard').click(); $('tglDepth').click();

/* ---------------------------------------------------------------- audio */
check('an audio graph was built', !!ctx && ctx.nodes.length > 20, ctx ? ctx.nodes.length + ' nodes' : 'none');
check('the output ends in a limiter', !!ctx && ctx.nodes.some(n =>
        n.kind === 'compressor' && n.outputs.some(o => o.dest === ctx.destination)));
if(ctx){
  const writes = ctx.params().reduce((a,p)=>a+p.writes.filter(w=>w.how==='setTargetAtTime').length, 0);
  check('the render loop drives parameters', writes > 500, writes + ' setTargetAtTime writes');
  check('nothing writes .value in the render loop', ctx.directSets() === 0,
        ctx.directSets() + ' direct sets');
}

/* ---------------------------------------------------------------- end */
// End must never leave the summary behind a dimmed screen. The tap that ends a
// session goes through the catcher first, so nothing else would wake it.
$('tglDim').click();
Dim.sleep();
check('the screen can be dim when a session ends', document.body.classList.contains('dimmed'));

$('mainBtn').click();                       // End
await new Promise(r => setTimeout(r, 0));
await new Promise(r => setTimeout(r, 0));
await new Promise(r => setTimeout(r, 0));

check('End returns the button to Start', $('mainBtn').textContent === 'Start',
      JSON.stringify($('mainBtn').textContent));
check('and brings the screen back with it', !document.body.classList.contains('dimmed'));
$('tglDim').click();
check('the summary is on screen', $('review').classList.contains('open') ||
      !$('review').classList.contains('hidden'));
check('the summary reports numbers', $('revSumGrid').children.length >= 5,
      $('revSumGrid').children.length + ' cells');

const cells = $('revSumGrid').querySelectorAll('.cell').map(c =>
  c.querySelectorAll('.v').map(v => v.textContent).join(''));
check('the summary is not all dashes', cells.some(t => /\d/.test(t)), cells.join(' | '));

/* ---------------------------------------------------------------- stored */
await settle(20);
const metas = await Store.list();
check('the session was written to the store', metas.length === 1, metas.length + ' recordings');
if(metas.length){
  const m = metas[0];
  check('the recording knows which release made it', !!(m.app && m.app.build), JSON.stringify(m.app));
  check('the recording carries the sensitivity it ran at',
        m.app && typeof m.app.sensitivity === 'number', String(m.app && m.app.sensitivity));

  const full = await Store.get(m.id, {motion:true, derived:true});
  const cols = await Store.get(m.id, {cols:true});
  check('the columns can be read without building row objects',
        !!cols && cols.motion.cols && cols.motion.cols.n > 1000 && cols.motion.rows.length === 0,
        cols && cols.motion.cols ? cols.motion.cols.n + ' packed' : 'none');
  // The capture buffer doubles as it fills, so the stored arrays have to be cut
  // down to what is in them or a session pays for up to twice its own size.
  check('nothing is stored but the samples themselves',
        !!cols && cols.motion.cols.t.length === cols.motion.cols.n,
        cols ? `${cols.motion.cols.t.length} slots for ${cols.motion.cols.n} samples` : 'none');
  // 16 B per motion sample, and 4 B per derived column plus the 4 B timestamp.
  const derivedWidth = 4 + 4*(cols.derived.columns.length - 1);
  check('and the size the budget sees is the size on disk',
        Math.abs(m.bytes - (cols.motion.cols.n*16 + cols.derived.cols.n*derivedWidth + (m.metaBytes||0))) < 64,
        `${m.bytes} B claimed`);
  check('the recording says which channels it carries',
        cols.derived.columns.includes('rest'), cols.derived.columns.join(','));
  check('the raw motion channel survived the round trip',
        !!full && full.motion.rows.length > 1000,
        full ? full.motion.rows.length + ' samples' : 'none');
  check('the derived channel survived too',
        !!full && full.derived.rows.length > 100,
        full ? full.derived.rows.length + ' rows' : 'none');
  check('a motion row is [t, x, y, z] with real numbers',
        !!full && full.motion.rows[10].length === 4 && full.motion.rows[10].every(Number.isFinite),
        full ? JSON.stringify(full.motion.rows[10]) : '');

  const blob = await Store.exportBlob(m.id);
  check('the export comes back as a Blob the phone can hand to the share sheet',
        !!blob && blob.size > 100000, blob ? (blob.size/1048576).toFixed(2) + ' MB' : 'none');
  const json = await blob.text();
  let parsed = null;
  try{ parsed = JSON.parse(json); }catch(e){ /* reported by the check below */ }
  check('the export is valid JSON in the documented format',
        !!parsed && parsed.format === Store.FORMAT, parsed ? parsed.format : 'unparseable');
  check('the export carries the rows, not just the header',
        !!parsed && parsed.motion && parsed.motion.rows.length > 1000,
        parsed && parsed.motion ? parsed.motion.rows.length + ' rows' : 'none');
}

$('revBack').click();
check('Back from the summary lands on the home screen', !$('intro').classList.contains('hidden'));

/* ---------------------------------------------------------------- browsing */
$('recBtn').click();
await settle(10);
check('Recordings opens from the home screen', !$('revList').classList.contains('hidden'));
const rows = $('revRows').querySelectorAll('.rec-open');
check('the session is listed', rows.length === 1, rows.length + ' rows');

if(rows.length){
  rows[0].click();
  await settle(10);
  check('tapping a row opens the detail', !$('revDetail').classList.contains('hidden'));
  check('the detail knows how long it is', /\d+:\d\d/.test($('revVAt').textContent),
        JSON.stringify($('revVAt').textContent));
  const { Review } = await import(resolve(root, 'src/review.js'));
  check('the detail lane knows where the holds were',
        Review.sig.hasRest && [...Review.sig.g].some(v => v < 0.5),
        Review.sig.hasRest ? 'rest channel present' : 'no rest channel');

  $('revNote').value = 'a note from the smoke test';
  $('revAdd').click();
  await settle(14);
  const withLabel = await Store.list();
  check('a label is written to the recording',
        withLabel[0].labels && withLabel[0].labels.length === 1,
        JSON.stringify(withLabel[0].labels));
  check('and the note survives with it',
        withLabel[0].labels[0].note === 'a note from the smoke test',
        JSON.stringify(withLabel[0].labels[0]));
  check('the labels list shows it', $('revLabels').children.length === 1,
        $('revLabels').children.length + ' shown');

  $('revBack').click();
  await settle();
  check('Back from a detail opened by the list returns to the list',
        !$('revList').classList.contains('hidden'));

  rows[0].click(); await settle(10);
  $('revDetDelete').click();                     // arms
  $('revDetDelete').click();                     // confirms
  await settle(16);
  check('Delete removes the recording', (await Store.list()).length === 0);
  check('and lands back on the list', !$('revList').classList.contains('hidden'));
}
$('revBack').click();
await settle();
check('Recordings is reachable again', !$('recBtn').classList.contains('hidden'));
check('the build line is back', !$('buildLine').classList.contains('hidden'));

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
