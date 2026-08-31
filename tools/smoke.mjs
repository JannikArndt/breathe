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

/* Two worlds, and every check below must pass in both.
   iOS gates devicemotion behind DeviceMotionEvent.requestPermission() and a
   real tap. Android Chrome has no such method at all, so requestSensor()
   attaches the listener directly — a different branch, on the path that
   decides whether the app works or does nothing. Run with --android to take
   the other one. */
const ANDROID = process.argv.includes('--android');
globalThis.DeviceMotionEvent = ANDROID
  ? function DeviceMotionEvent(){}
  : { requestPermission: async () => 'granted' };
globalThis.window.DeviceMotionEvent = globalThis.DeviceMotionEvent;
if(ANDROID) globalThis.navigator.userAgent =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36';
console.log(ANDROID ? 'world: Android Chrome (no permission gate)\n'
                    : 'world: iOS Safari (requestPermission)\n');

const $ = id => document.getElementById(id);

/* ---------------------------------------------------------------- import */
// The store is a module singleton, so this is the same object main.js drives.
const { Store } = await import(resolve(root, 'src/store.js'));
const { Breath } = await import(resolve(root, 'src/breath.js'));

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

/* ---------------------------------------------------------------- language */
const { t, setLang, getLang, LANGS } = await import(resolve(root, 'src/i18n.js'));
check('the app opens in English by default', getLang() === 'en', getLang());
check('the language picker offers what the table holds',
      $('langPick').children.length === LANGS.length,
      `${$('langPick').children.length} of ${LANGS.length}`);

// Every key the script asks for must exist in every language, or a German
// phone shows an English sentence in the middle of a German screen.
{
  const jsText = readdirSync(resolve(root, 'src')).map(f =>
    readFileSync(resolve(root, 'src', f), 'utf8')).join('\n');
  const htmlText = readFileSync(resolve(root, 'index.html'), 'utf8');
  const used = new Set([
    ...[...jsText.matchAll(/\bt\('([a-z0-9.]+)'/g)].map(m => m[1]),
    ...[...htmlText.matchAll(/data-t(?:-aria)?="([a-z0-9.]+)"/g)].map(m => m[1]),
  ]);
  const i18nText = readFileSync(resolve(root, 'src/i18n.js'), 'utf8');
  const missing = [...used].filter(k => !i18nText.includes(`'${k}':`)).sort();
  check('every key the app uses has a German string', missing.length === 0,
        missing.join(' '));

  // The home screen is sized to fit a small phone and a translation is not
  // under our control: German ran to six wrapped lines where English runs to
  // four before these were shortened. The intro scrolls rather than clips now,
  // but a first screen that needs scrolling is still a bad first screen.
  // 40 characters is about one line at the app's size on a narrow phone.
  const rows = txt => Math.ceil(txt.length/40);
  let enRows = 0, deRows = 0, worst = [];
  for(const key of ['step.back','step.phone','step.sound','step.breathe']){
    const en = htmlText.match(new RegExp(`data-t="${key}">([^<]*)<`))[1].trim();
    const de = i18nText.match(new RegExp(`'${key}':\\s*'([^']*)'`))[1];
    enRows += rows(en); deRows += rows(de);
    if(rows(de) > rows(en)) worst.push(key);
  }
  check('the German setup text does not outgrow the screen', deRows <= enRows + 1,
        `${deRows} wrapped lines against ${enRows}` + (worst.length ? ' — ' + worst.join(' ') : ''));
}

// Switching language must change what is on the screen and change it back.
// A label the markup does not own: Updater rewrites this row as its state
// changes, so it is the one that proves the script's own strings translate.
const enStep = $('intro').querySelector('.steps').children[0].textContent;
const enRow  = $('reloadBtn').textContent;
$('langPick').children[1].click();
await settle();
check('switching to German changes the markup',
      $('intro').querySelector('.steps').children[0].textContent !== enStep,
      JSON.stringify($('intro').querySelector('.steps').children[0].textContent));
check('and the labels the script owns', $('reloadBtn').textContent !== enRow,
      `${JSON.stringify(enRow)} -> ${JSON.stringify($('reloadBtn').textContent)}`);
{
  const { n } = await import(resolve(root, 'src/i18n.js'));
  check('German writes a decimal comma', n(3.4, 1) === '3,4', n(3.4, 1));
}
$('langPick').children[0].click();
await settle();
check('and switching back restores the English',
      $('intro').querySelector('.steps').children[0].textContent === enStep &&
      $('reloadBtn').textContent === enRow,
      JSON.stringify($('reloadBtn').textContent));

/* ---------------------------------------------------------------- home */
/* One wave, washing up the sand and draining back, with the sound of it. The
   drawing and the audio are driven from the same number on the same frame, so
   the check is that both move and that they move together. */
const wavesCtx = $('waves').getContext('2d');
tick(16);
check('the shore is drawn on the home screen', (wavesCtx.calls.stroke || 0) >= 1,
      `${wavesCtx.calls.stroke || 0} strokes`);

run(6, 60);
check('and keeps washing', (wavesCtx.calls.stroke || 0) > 200,
      `${wavesCtx.calls.stroke} strokes over six seconds`);
check('spray is thrown as the water runs up', mod.Shore.spray.length > 0,
      `${mod.Shore.spray.length} drops`);
check('the sand it reached stays wet behind it', mod.Shore.wet >= mod.Shore.BAND,
      mod.Shore.wet.toFixed(2));

// The audio starts itself. A browser will not build a context without a
// gesture, so the app tries and then takes the first touch the page gets.
check('the sound starts with the waves', mod.Shore.audio === true && !!FakeAudioContext.last);
{
  const ctxNow = FakeAudioContext.last;
  const before = ctxNow.params().reduce((a,p)=>a+p.writes.filter(w=>w.how==='setTargetAtTime').length, 0);
  run(4, 60);
  const after = ctxNow.params().reduce((a,p)=>a+p.writes.filter(w=>w.how==='setTargetAtTime').length, 0);
  check('and is driven by the same wave that is drawn', after > before, `${after - before} writes`);
}

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

/* ---------------------------------------------------------------- style */
// Rules that carry their own colour are how a palette drifts apart. Every
// colour is defined once, in the :root block, and referenced with var().
const cssText = readFileSync(resolve(root, 'app.css'), 'utf8');
const rootBlock = cssText.slice(cssText.indexOf(':root{'), cssText.indexOf('}', cssText.indexOf(':root{')));
const strayHex = [...cssText.replace(rootBlock, '').matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
check('no rule carries its own colour', strayHex.length === 0, strayHex.join(' '));

// The `transition` shorthand resets every transition property, so a rule that
// carries one and out-specifies a component's own rule silently deletes what
// that component declared for itself. Dimming did exactly this to the Adjust
// sheet and the notice, via `body > :not(.dim-catch)`. Keep the shorthand
// inside the block that owns the element; use transition-duration / -property
// to adjust one from outside.
const broadTransition = cssText.split('\n').filter(l =>
  /^\s*(body\s*>|\*|html\s|:root\s)[^{]*\{[^}]*\btransition\s*:/.test(l));
check('no broad selector resets transitions with the shorthand',
      broadTransition.length === 0, broadTransition.join(' | '));

// The four overlays sit on top of #app, not inside it. Nested by accident they
// would inherit its fixed, unscrollable box and the sheet would be trapped in
// it — a mis-nested closing tag is easy to make and invisible until a phone.
const shells = document.body.children.filter(c => c.id).map(c => c.id);
for(const id of ['app', 'log', 'panel', 'review', 'notice'])
  check(`#${id} is a top-level shell`, shells.includes(id), shells.join(' '));

// An id in the markup that nothing reads is either dead or a bug where
// something meant to read it does not.
const idsInMarkup = [...readFileSync(resolve(root, 'index.html'), 'utf8')
  .matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
const jsText = readdirSync(resolve(root, 'src')).map(f =>
  readFileSync(resolve(root, 'src', f), 'utf8')).join('\n');
const orphans = idsInMarkup.filter(id =>
  !new RegExp(`['\"\`]${id}['\"\`]`).test(jsText) &&
  !new RegExp(`#${id}\\b`).test(cssText));
check('every id in the markup is read by something', orphans.length === 0, orphans.join(' '));

/* ---------------------------------------------------------------- velocity */
// The reference every velocity-fed layer divides by. It has to follow the rate
// all the way down, or slowing your breathing quietly turns those layers down.
const { velRef } = await import(resolve(root, 'src/audio.js'));
const off = bpm => velRef(bpm) / (0.040*bpm);
check('velocity is scaled right at an ordinary rate', Math.abs(off(12) - 1) < 0.01,
      off(12).toFixed(2) + 'x');
check('and still right at the owner\'s 2.9/min', Math.abs(off(2.9) - 1) < 0.01,
      off(2.9).toFixed(2) + 'x');
check('and all the way down to one a minute', Math.abs(off(1) - 1) < 0.01,
      off(1).toFixed(2) + 'x');

// The reward curve. A regular breather must keep most of it, and it must still
// be moving below six a minute — on the owner's own 0831 trace the old curve
// reached its ceiling ninety seconds in and never moved again while they went
// on halving their rate.
const { reward } = mod;
check('the reward is still mostly earned between 14 and 6 a minute',
      Math.abs(reward(6) - 0.75) < 0.01, reward(6).toFixed(2) + ' at 6/min');
check('and keeps rising all the way to one a minute',
      reward(3) > reward(6) && reward(1.5) > reward(3) && Math.abs(reward(1) - 1) < 0.01,
      [6, 4, 3, 2, 1].map(b => `${b}:${reward(b).toFixed(2)}`).join(' '));
check('and is flat above fourteen', reward(14) === 0 && reward(20) === 0);

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

// An install that cannot complete must not read as "nothing new". The worker
// caches the app as one set and gives up if any part of it is missing.
swUpdateFails();
check('a failed install says so rather than going quiet',
      $('noticeTitle').textContent === 'Update did not finish',
      JSON.stringify($('noticeTitle').textContent));
check('and the row goes back to offering a check', $('reloadBtn').textContent === 'Check',
      JSON.stringify($('reloadBtn').textContent));

const waiting = swUpdate();
check('an arriving version turns the row into an install', $('reloadBtn').textContent === 'Install',
      JSON.stringify($('reloadBtn').textContent));
check('and says so out loud', $('noticeTitle').textContent === 'A new version is ready',
      JSON.stringify($('noticeTitle').textContent));

$('reloadBtn').click();
check('installing tells the waiting worker to take over', waiting.posted === 'skip-waiting',
      JSON.stringify(waiting.posted));
check('and the app reloads itself when it does', reloaded, String(reloaded));

// The first visit has no controller to replace: the worker installs, activates
// and claims the page a second after it loads. Reloading there would restart
// the app under someone's finger, possibly mid-session, for no gain.
reloaded = false;
swFire('controllerchange', {});
check('but an unasked-for handover does not reload the page', reloaded === false);
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

check('the shore stops once a session starts', mod.Shore.on === false);
check('Start switches the button to End', $('mainBtn').textContent === 'End',
      JSON.stringify($('mainBtn').textContent));
check('the intro is hidden while breathing', $('intro').classList.contains('hidden'));
check('the trace appears', !$('traceWrap').classList.contains('hidden'));

check('Recordings is out of reach mid-session', $('recBtn').classList.contains('hidden'));
check('the build line hides mid-session', $('buildLine').classList.contains('hidden'));

const ctx = FakeAudioContext.last;
let notice0 = '';
run(180, 60);                               // three minutes at 60 Hz

const rateTxt = $('vRate').textContent;
check('a rate is reported after three minutes', /^\d+(\.\d+)?/.test(rateTxt) && parseFloat(rateTxt) > 3,
      JSON.stringify(rateTxt));
check('the ratio readout fills in', $('vRatio').textContent !== '—',
      JSON.stringify($('vRatio').textContent));
check('the header shows the sample rate', /demo|Hz/.test($('statusTag').textContent),
      JSON.stringify($('statusTag').textContent));

/* ---------------------------------------------------------------- try */
const { Flags, Dim, Updater } = mod;

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
check('and a scrim is there to take the tap that wakes it',
      !!document.querySelector('.dim-catch'));
document.dispatch('pointerdown', {});
check('a touch brings it back', !document.body.classList.contains('dimmed') && !Dim.on);
check('and the catcher steps aside', !document.body.classList.contains('dimmed'));

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

// A version arriving mid-session must not raise a toast: the Changes screen is
// out of reach while breathing anyway, and the notice is the one thing on this
// screen that can pull attention back to the phone.
notice0 = $('noticeTitle').textContent;
const second = swUpdate();
check('a version arriving mid-session waits its turn', Updater.pending === true);
check('and says nothing while you are breathing', $('noticeTitle').textContent === notice0,
      JSON.stringify($('noticeTitle').textContent));

/* ---------------------------------------------------------------- direction */
// The central claim this engine makes is that you can hear which way you are
// going. It was once false — frame() took only |velocity|, so inhaling and
// exhaling at the same belly position produced identical parameters, and no
// amount of mix tuning could have fixed it. This is that claim, as a check.
{
  const { Audio } = await import(resolve(root, 'src/audio.js'));
  const snapshot = () => ctx.params().map(p => p.value);
  const base = {level:0.5, speed:0.5, rich:0.5, bpm:6, dt:1/60};

  // Same belly position, same speed, opposite directions. Held for two seconds
  // because the direction gate is smoothed at tau = 0.30 s and would otherwise
  // still be halfway between the two.
  for(let i=0;i<120;i++){ ctx.advance(1/60); Audio.frame({...base, vel: 0.24, inhaling:true}); }
  const inward = snapshot();
  for(let i=0;i<120;i++){ ctx.advance(1/60); Audio.frame({...base, vel:-0.24, inhaling:false}); }
  const outward = snapshot();

  let moved = 0, biggest = 0;
  for(let i=0;i<inward.length;i++){
    const a = inward[i], b = outward[i];
    if(!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const rel = Math.abs(a-b) / Math.max(Math.abs(a), Math.abs(b), 1e-6);
    if(rel > 0.05) moved++;
    if(rel > biggest) biggest = rel;
  }
  check('inhaling and exhaling do not sound the same', moved >= 4,
        `${moved} parameters differ, the largest by ${(biggest*100).toFixed(0)}%`);

  // And the level channel still does its own separate work, or the sound would
  // only ever say "in" or "out" and never "how far in".
  for(let i=0;i<120;i++){ ctx.advance(1/60); Audio.frame({...base, level:0.05, vel:0.24, inhaling:true}); }
  const low = snapshot();
  for(let i=0;i<120;i++){ ctx.advance(1/60); Audio.frame({...base, level:0.95, vel:0.24, inhaling:true}); }
  const high = snapshot();
  let byLevel = 0;
  for(let i=0;i<low.length;i++){
    const rel = Math.abs(low[i]-high[i]) / Math.max(Math.abs(low[i]), Math.abs(high[i]), 1e-6);
    if(Number.isFinite(rel) && rel > 0.05) byLevel++;
  }
  check('and the top of a breath does not sound like the bottom', byLevel >= 4,
        `${byLevel} parameters differ`);
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
check('and the waiting version speaks up once the session is over',
      $('noticeTitle').textContent === 'A new version is ready' && Updater.pending === false,
      JSON.stringify($('noticeTitle').textContent));
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
  const { Review } = await import(resolve(root, 'src/review.js'));
  check('the detail lane knows where the holds were',
        Review.sig.hasRest && [...Review.sig.g].some(v => v < 0.5),
        Review.sig.hasRest ? 'rest channel present' : 'no rest channel');
  check('and it opens with the whole recording marked usable',
        Review.trim === null && /All of it/.test($('revTrimState').textContent),
        JSON.stringify($('revTrimState').textContent));

  // The two marks. Everything before the first and after the last is someone
  // handling a phone, and this screen exists to say where that stops and starts.
  Review.setPlay(20);
  $('revTrimFrom').click();
  Review.setPlay(150);
  $('revTrimTo').click();
  await new Promise(r => setTimeout(r, 60));
  await settle(14);
  check('marking both ends sets the usable stretch',
        !!Review.trim && Review.trim.fromSec === 20 && Review.trim.toSec === 150,
        JSON.stringify(Review.trim));
  check('and says so in words', /0:20 to 2:30/.test($('revTrimState').textContent),
        JSON.stringify($('revTrimState').textContent));

  const trimmed = (await Store.list())[0];
  check('the trim is written to the recording',
        !!trimmed.trim && trimmed.trim.fromSec === 20 && trimmed.trim.toSec === 150,
        JSON.stringify(trimmed.trim));

  // Marking a start past the end is a correction, not an error to refuse.
  Review.setPlay(200);
  $('revTrimFrom').click();
  check('a start past the end pushes the end out of the way',
        Review.trim.fromSec === 200 && Review.trim.toSec > 200,
        JSON.stringify(Review.trim));

  $('revTrimClear').click();
  await new Promise(r => setTimeout(r, 60));
  await settle(14);
  check('and it can be cleared again', Review.trim === null &&
        /All of it/.test($('revTrimState').textContent));
  check('the store forgets it too', (await Store.list())[0].trim === null,
        JSON.stringify((await Store.list())[0].trim));

  // Pinch stands in for the row of width buttons that used to be here.
  const span0 = Review.det.span;
  Review.zoomBy(0.5, Review.det.play);
  check('zooming in halves what the lane shows', Math.abs(Review.det.span - span0/2) < 0.01,
        `${span0.toFixed(0)}s -> ${Review.det.span.toFixed(0)}s`);
  Review.zoomBy(1000, Review.det.play);
  check('and zooming out stops at the whole recording',
        Math.abs(Review.det.span - Review.det.dur) < 0.01,
        Review.det.span.toFixed(0) + 's of ' + Review.det.dur.toFixed(0) + 's');

  // Whatever this screen writes, it must never cost a sample.
  const afterTrim = await Store.get(trimmed.id, {cols:true});
  check('marking a recording leaves the raw motion where it was',
        !!afterTrim && afterTrim.motion.cols && afterTrim.motion.cols.n > 1000,
        afterTrim && afterTrim.motion.cols ? afterTrim.motion.cols.n + ' samples' : 'none');

  // And the store refuses the write outright, whatever a future caller does:
  // recording is the one thing in this app that cannot be redone.
  const stripped = await Store.get(trimmed.id, {motion:false});
  const wrote = await Store.put(stripped);
  const afterPut = await Store.get(trimmed.id, {cols:true});
  check('a write that would erase the samples is refused', wrote === false,
        String(Store.lastError));
  check('and the samples are still there afterwards',
        afterPut.motion.cols.n > 1000, afterPut.motion.cols.n + ' samples');

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

/* ---------------------------------------------------------------- sensor */
/* Everything above ran in Demo mode, which by design never asks for the
   sensor at all. This is the real path, and it is the one branch that
   genuinely differs between the two worlds: on iOS it goes through
   requestPermission and a tap, on Android there is no such method and the
   listener has to be attached directly. Get that wrong for either and the app
   runs a silent session that records nothing. */
$('tglDemo').click();                          // demo off
check('demo mode is off for the sensor run', mod.UI.demo === false);
$('mainBtn').click();
await settle();
check('a session starts with the real sensor path', $('mainBtn').textContent === 'End',
      JSON.stringify($('mainBtn').textContent));

const before = Breath.samples;
for(let i = 0; i < 1200; i++){
  const t = i/60, v = Math.sin(t*2*Math.PI/10);
  document.documentElement.dispatch('devicemotion', {
    accelerationIncludingGravity: {x: v*0.45, y: 0.2, z: 9.79 + v*0.45}
  });
  tick(1000/60);
}
check('motion events reach the tracker', Breath.samples - before === 1200,
      `${Breath.samples - before} of 1200 samples`);
// Two breaths of a 0.45 m/s² tilt. Real sessions measure 0.41 and 0.49.
check('and the tracker finds a breath in them', Breath.axisAmp > 0.3,
      `amplitude ${Breath.axisAmp.toFixed(3)} m/s²`);
check('the header reports a live sample rate', /\d+ Hz/.test($('statusTag').textContent),
      JSON.stringify($('statusTag').textContent));

$('mainBtn').click();
await settle(20);
check('the sensor session ends on the summary', $('mainBtn').textContent === 'Start');
$('revBack').click();
await settle();
await Store.clear();
await settle();
check('Recordings is reachable again', !$('recBtn').classList.contains('hidden'));
check('the build line is back', !$('buildLine').classList.contains('hidden'));

/* ---------------------------------------------------------------- in German */
/* Every screen, in the other language, with nothing asserted about the words —
   only that opening each one does not throw and that the German is actually
   reaching the page. A missing key falls back to English rather than to a key
   name, so the failure mode this catches is a screen that cannot render at
   all. */
$('panelBtn').click();
$('langPick').children[1].click();
await settle();
$('closePanel').click();
$('buildBtn').click();
check('Changes opens in German', $('log').classList.contains('open') &&
      /Neueste|Version/.test($('logList').parentNode.textContent || 'x'));
$('closeLog').click();
$('recBtn').click();
await settle(10);
check('Recordings opens in German', !$('revList').classList.contains('hidden'));
$('revBack').click();
await settle();

$('tglDemo').click();
$('mainBtn').click();
await settle();
check('a session starts in German', $('mainBtn').textContent === 'Ende',
      JSON.stringify($('mainBtn').textContent));
run(90, 60);
check('and the readout fills in', $('vRate').textContent !== '',
      JSON.stringify($('vRate').textContent + ' / ' + $('vRatio').textContent));
$('mainBtn').click();
await settle(20);
check('and the summary renders in German',
      $('revSumGrid').children.length >= 5 &&
      /Dauer|Atemzüge/.test($('revSumGrid').textContent || $('revSumGrid').children.map(c=>c.textContent).join(' ')),
      $('revSumGrid').children.map(c => c.querySelectorAll('.k').map(k=>k.textContent).join('')).join(' | '));
$('revBack').click();
await settle();
$('panelBtn').click();
$('langPick').children[0].click();
$('closePanel').click();
await settle();

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
