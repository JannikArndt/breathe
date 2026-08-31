import { $, clamp, lerp, lp, fin, TAU, notice, fitCanvas, palette, alpha } from './util.js';
import { Audio } from './audio.js';
import { Breath } from './breath.js';
import { Pulse } from './pulse.js';
import { Store, Recorder } from './store.js';
import { Review } from './review.js';

/* ============================================================
   6. APP
   ============================================================ */

/** Releases, newest first. There is no build step, so this list *is* the
    version: the top entry stamps the home screen and the exported session.
    Add an entry in the same commit as the change it describes, and write the
    notes for someone who has never seen the code — what the sound or the
    screen does differently, never how. */
const RELEASES = [
  {v:'0.9.9', date:'2026-08-31', notes:[
    'A new Try section in Adjust holds three things that are not sure of themselves yet. All three are off until you turn them on, and stay on once you have.',
    'Show what it hears shades the trace where the app thinks you are holding, and ticks each breath it counted — so you can check it against your own body instead of taking the sound\u2019s word for it.',
    'Dim the screen fades the display while you breathe. A tap brings it back, and that tap cannot press End by accident.',
    'Crest follows depth breaks the wave harder after a deeper breath rather than a longer one.',
    'Demo mode now breathes the way a person does — a long flat bottom, a quick rise, a pause at the top — instead of a sine wave. It runs at six a minute.'
  ]},
  {v:'0.9.8', date:'2026-08-31', notes:[
    'Very slow breathing is followed properly. Below four breaths a minute the sound was reading your movement as about a quarter weaker than it was, so the layers that follow the stroke faded exactly as you slowed down.',
    'Breaths longer than thirty seconds are counted instead of discarded.'
  ]},
  {v:'0.9.7', date:'2026-08-31', notes:[
    'The app works with no connection. It is kept on the phone whole, so nothing has to be fetched to start a session.',
    'When a new version exists the app says so, and Changes offers to install it. No more deleting the icon and adding it again.',
    'The Reload row is now a Check: it asks whether anything is new and tells you when nothing is.',
    'Added to the Home Screen it gets a proper icon and name instead of a screenshot.'
  ]},
  {v:'0.9.6', date:'2026-08-31', notes:[
    'Everything in Adjust is remembered on this phone. Volume, sensitivity, the seven sound controls and the two sensor switches all come back the way you left them.',
    'A Reset button under the sound controls puts those seven back where they started. Volume and sensitivity are left alone.',
    'Demo mode is deliberately not remembered, so a switch left on cannot quietly fake a session next week.',
    'The trace drew a second, flat line down the middle of the graph. It belonged to the guide tone, which was removed a while ago.'
  ]},
  {v:'0.9.5', date:'2026-08-31', notes:[
    'Changes has a Reload button. Added to the Home Screen the app runs without an address bar, so there was no way to pick up a new version short of deleting the icon.'
  ]},
  {v:'0.9.4', date:'2026-08-31', notes:[
    'The version and date sit at the bottom of the home screen, so you can tell a reload from a page that has not changed. Tap it for this list.'
  ]},
  {v:'0.9.3', date:'2026-08-31', notes:[
    'The sound no longer swells while you are still holding at the bottom of a breath. On slow breathing it was arriving up to ten seconds early.',
    'Long holds now read as held, so the sound settles instead of following the drift.',
    'The heart rate could never show a number, whatever it measured. It can now. Still experimental, and still unchecked against a real pulse.',
    'Sessions record where the sensitivity slider was set.'
  ]},
  {v:'0.9.2', date:'2026-08-29', notes:[
    'Swell, spray and undertow are louder: roughly their old maximum is the new default.',
    'The foam drops in pitch after the wave breaks, then drains.',
    'Space opens the stereo field as well as the reverb, so it is audible on headphones.',
    'Moving the Break slider plays the crest, so you can hear what you are setting.',
    'Tone is gone. It read as a drone laid over the sea rather than part of it.',
    'Brightness covers a wider range.'
  ]},
  {v:'0.9.1', date:'2026-08-29', notes:[
    'No length, no learning phase, no voice. Start asks for motion access and the session begins.',
    'One sound, Shore, with seven controls over it.',
    'Sensitivity decides how readily the app follows you.',
    'The app judges whether it is hearing breathing at all, and stays quiet about a rate it cannot back.'
  ]},
  {v:'0.9.0', date:'2026-08-28', notes:[
    'The summary reports breaths, rate and length, and has a way out.',
    'Recordings are reachable from the home screen.',
    'Back is top-left on every screen that has one.',
    'An experimental heart rate estimate, off by default.'
  ]}
];
const BUILD = RELEASES[0];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
/** '2026-08-31' -> '31 Aug 2026'. Parsed by hand rather than through Date, so
    a phone in any time zone reads the same day back. */
function relDate(iso){
  const p = String(iso).split('-');
  return `${+p[2]} ${MONTHS[+p[1]-1]} ${p[0]}`;
}

/** The change log. Built once, on first open — there is no reason to put five
    releases in the DOM for a screen most sessions never visit. */
/* ---------- keeping up to date ----------
   Added to the Home Screen the app runs standalone: no address bar, no
   pull-to-refresh, and iOS will go on serving the copy it has — including in
   answer to location.reload(). The service worker turns that around: it holds
   the whole app as one version-named set, a new version installs beside it
   without disturbing a running session, and swapping over is a button.

   The whole thing is optional. With no service worker (an old browser, a
   private window, http://) the app runs exactly as it did; only this panel
   changes what it says. */
const Updater = {
  reg:null, waiting:null, state:'unsupported',
  // idle      — registered, nothing new
  // checking  — asking the server
  // ready     — a new version is installed and waiting
  // unsupported

  start(){
    if(!('serviceWorker' in navigator) || !window.isSecureContext) return;
    this.state = 'idle';
    // updateViaCache:'none' keeps the HTTP cache from answering for the worker
    // script itself, which would make the whole mechanism unable to notice a
    // new version — the exact failure it exists to fix.
    navigator.serviceWorker.register('./sw.js', {updateViaCache:'none'}).then(reg=>{
      this.reg = reg;
      if(reg.waiting) this.arrived(reg.waiting);
      reg.addEventListener('updatefound', ()=>{
        const sw = reg.installing;
        if(!sw) return;
        sw.addEventListener('statechange', ()=>{
          // A first-ever install has nothing to replace, so it is not an update.
          if(sw.state === 'installed' && navigator.serviceWorker.controller) this.arrived(sw);
        });
      });
    }).catch(()=>{ this.state = 'unsupported'; });

    // The new worker takes over only when we ask it to, so this fires once,
    // in answer to the button.
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', ()=>{
      if(reloading) return;
      reloading = true;
      location.reload();
    });
  },

  arrived(sw){
    this.waiting = sw;
    this.state = 'ready';
    this.paint();
    notice('A new version is ready', 'Open Changes from the bottom of the home screen to install it.', 8000);
  },

  /** The Reload button. Asks the server, then says what it found — including
      "nothing", which is the answer the old button could never give. */
  check(){
    if(this.state === 'ready'){ this.install(); return; }
    if(!this.reg){
      // No service worker to ask. Fall back to what the app did before it had
      // one: a URL the phone has never seen cannot be answered from its cache.
      location.replace(location.pathname + '?r=' + Date.now());
      return;
    }
    this.state = 'checking'; this.paint();
    this.reg.update()
      .then(()=>new Promise(r=>setTimeout(r, 1200)))   // let an install settle
      .then(()=>{
        if(this.state === 'ready') return;             // arrived() already said so
        this.state = 'idle'; this.paint();
        notice('Up to date', 'This is the newest version. Nothing to install.', 4000);
      })
      .catch(()=>{
        this.state = 'idle'; this.paint();
        notice('Could not check', 'No answer from the network. The app keeps working offline.', 5000);
      });
  },

  install(){
    if(!this.waiting) return;
    this.waiting.postMessage('skip-waiting');          // controllerchange reloads
  },

  /** Keep the row in Changes honest about what the button will do. */
  paint(){
    const btn = $('reloadBtn'), hint = $('reloadHint');
    if(!btn || !hint) return;
    const say = {
      unsupported: ['Reload', 'fetches the page again, past the cache'],
      idle:        ['Check',  'asks whether a newer version exists'],
      checking:    ['…',      'asking'],
      ready:       ['Install','a new version is ready to take over']
    }[this.state];
    btn.textContent = say[0];
    btn.disabled = this.state === 'checking';
    hint.textContent = say[1];
    btn.classList.toggle('ready', this.state === 'ready');
  }
};

const Log = {
  built:false,
  open(){
    if(!this.built){ this.render(); this.built = true; }
    el.panel.classList.remove('open');       // one sheet up at a time
    Updater.paint();
    $('log').classList.add('open');
  },
  close(){ $('log').classList.remove('open'); },
  render(){
    const host = $('logList');
    host.textContent = '';
    RELEASES.forEach((r, i)=>{
      const box = document.createElement('div'); box.className = 'log-rel';
      const head = document.createElement('div'); head.className = 'log-when';
      const v = document.createElement('span'); v.className = 'log-v'; v.textContent = r.v;
      const d = document.createElement('span'); d.className = 'log-d'; d.textContent = relDate(r.date);
      head.append(v, d);
      if(i === 0){
        const now = document.createElement('span');
        now.className = 'log-now'; now.textContent = 'running';
        head.append(now);
      }
      const ul = document.createElement('ul'); ul.className = 'log-notes';
      r.notes.forEach(n=>{ const li = document.createElement('li'); li.textContent = n; ul.append(li); });
      box.append(head, ul);
      host.append(box);
    });
  }
};

export const UI = {
  state:'idle',                       // idle | running
  demo:false, demoPhase:0,
  wakeLock:null, silentEl:null,
  rich:0.4, lastFrame:0, sensorSeen:false, toldSaveTrouble:false,
  badSince:0,
  // trace is the signal; held and marks are what "Show what it hears" draws
  // over it. They share the trace's index, so they shift together.
  trace:[], held:[], marks:[], traceAcc:0, axisAcc:29,
  sensorPerm:'—', hz:0, hzAcc:0, lastSamples:0
};

const el = {
  main:$('mainBtn'), panelBtn:$('panelBtn'), panel:$('panel'), intro:$('intro'),
  homeSub:$('homeSub'), recBtn:$('recBtn'), buildLine:$('buildLine'),
  dial:$('dial'), centerRead:$('centerRead'), cue:$('cue'), sub:$('sub'),
  traceWrap:$('traceWrap'), trace:$('trace'), readout:$('readout'),
  vRate:$('vRate'), vRatio:$('vRatio'), vHr:$('vHr'), vHrUnit:$('vHrUnit'),
  cellHr:$('cellHr'),
  statusTag:$('statusTag'), qualityTxt:$('qualityTxt')
};

/* ---------- iOS: keep audio out of the "ringer" bucket ----------
   Community-reported behaviour, not a documented API: starting a silent
   <audio> element alongside Web Audio makes iOS treat the page as media
   playback, so the hardware silent switch no longer mutes it. Harmless
   elsewhere. If it does not work on your build, use headphones. */
function primeSilentChannel(){
  try{
    const a = document.createElement('audio');
    a.setAttribute('playsinline','');
    a.loop = true; a.volume = 0.001;
    // 0.2 s of digital silence, WAV
    a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
    const p = a.play();
    if(p && p.catch) p.catch(()=>{});
    UI.silentEl = a;
  }catch(e){}
}

async function requestWakeLock(){
  try{
    if('wakeLock' in navigator){
      UI.wakeLock = await navigator.wakeLock.request('screen');
      UI.wakeLock.addEventListener('release', ()=>{ UI.wakeLock=null; });
    }
  }catch(e){ /* not supported or denied — the session still runs */ }
}
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState==='visible'){
    if(UI.state!=='idle' && !UI.wakeLock) requestWakeLock();
    if(Audio.ctx && Audio.ctx.state==='suspended') Audio.ctx.resume();
  }
});

/* ---------- sensor ---------- */
function onMotion(e){
  const g = e.accelerationIncludingGravity || e.acceleration;
  if(!g || g.x===null || g.x===undefined) return;
  UI.sensorSeen = true;
  if(!Recorder.motionSource)
    Recorder.motionSource = e.accelerationIncludingGravity
      ? 'accelerationIncludingGravity' : 'acceleration';
  const t = performance.now()/1000;     // read once: two clocks here would drift apart
  Breath.push(g.x, g.y, g.z, t);
  Recorder.sample(g.x, g.y, g.z, t);
  if(Pulse.enabled){
    // dt from the tracker, which already clamps a stall and falls back to 1/60
    Pulse.push(Math.hypot(g.x, g.y, g.z), Breath.lastDt || 1/60, t);
  }
}

/**
 * MUST be called synchronously from inside the tap handler, and the returned
 * promise must NOT be awaited before other gesture-gated calls are made.
 *
 * requestPermission() requires transient activation. WebKit's implementation is
 * cruder than the spec: in practice you only have activation inside the same
 * stack as the click handler, so a single `await` anywhere before this line
 * loses it and the call rejects with NotAllowedError.
 * Spec:     https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static
 * WebKit:   https://macwright.com/2022/07/11/activation
 *
 * @returns Promise<'ok'|'denied'|'unsupported'|`error:${string}`>
 */
function requestSensor(){
  const DM = window.DeviceMotionEvent;
  if(!DM) return Promise.resolve('unsupported');

  const attach = () => {
    window.addEventListener('devicemotion', onMotion, {passive:true});
    return 'ok';
  };
  // Android and older iOS: no gate at all
  if(typeof DM.requestPermission !== 'function') return Promise.resolve(attach());

  let p;
  try{ p = DM.requestPermission(); }
  catch(err){ return Promise.resolve('error:' + ((err && err.name) || 'unknown')); }
  return Promise.resolve(p).then(
    res => res === 'granted' ? attach() : 'denied',
    err => 'error:' + ((err && err.name) || 'unknown')
  );
}

/* ---------- session control ---------- */
/** Both promises are started inside the tap handler; begin() only awaits them. */
async function begin(sensorP, audioP){
  UI.badSince = 0;
  // Adjust stays reachable while breathing — it holds the volume and the
  // recalibrate button, both of which are wanted mid-session. Only Recordings
  // goes, since opening the browser over a running session is not a thing to
  // do by accident.
  el.recBtn.classList.add('hidden');
  el.buildLine.classList.add('hidden');
  const audioOk = await audioP;
  const sensor  = await sensorP;
  UI.sensorPerm = sensor;

  if(!audioOk){
    notice('No sound', 'This browser blocked audio. Reload the page and tap Begin again.', 0);
    el.main.disabled = false; return;
  }
  if(sensor === 'denied'){
    notice('Motion declined', 'Reload the page to be asked again. If no prompt appears, clear this site\u2019s data in Safari settings — a past "Don\u2019t Allow" is remembered per site.', 0);
  }else if(sensor === 'unsupported'){
    notice('No motion sensor', 'This device or browser has no motion sensor. Demo mode under Adjust will still show you how it sounds.', 0);
  }else if(sensor.indexOf('error:') === 0){
    const name = sensor.slice(6);
    notice('Motion request failed', name === 'NotAllowedError'
      ? 'Safari did not treat that as a direct tap. Reload the page and tap Begin as your first action, without scrolling first.'
      : name + '. Reload and try again, or use Demo mode under Adjust.', 0);
  }

  requestWakeLock();
  Audio.setVolume(parseInt($('vol').value,10)/100);

  // Every session is recorded. There is nothing to record if the sensor never
  // arrived, so a denied or unsupported run is left alone rather than saved empty.
  if(sensor === 'ok' || UI.demo){
    Recorder.start({app:{
      invert:      $('tglInvert').getAttribute('aria-checked') === 'true',
      demo:        UI.demo,
      // Where the sensitivity sat decides how much of the session the tracker
      // followed, so a recording cannot be interpreted without it.
      sensitivity: Breath.sensitivity,
      pulse:       Pulse.enabled,
      // which release produced this session, so a recording made before an
      // algorithm change can be told from one made after it
      build:       BUILD.v,
      buildDate:   BUILD.date
    }}, performance.now()/1000);        // session zero, the same clock onMotion reads
  }
  Review.hide();
  el.intro.classList.add('hidden');
  [el.dial, el.centerRead, el.traceWrap, el.readout].forEach(n=>n.classList.remove('hidden'));
  el.main.textContent = 'End'; el.main.classList.remove('primary'); el.main.disabled = false;

  UI.state = 'running';
  UI.trace = []; UI.held = []; UI.marks = [];
  Dim.arm();
  Breath.invert = $('tglInvert').getAttribute('aria-checked')==='true';
  Breath.begin(performance.now()/1000);
  el.statusTag.textContent = 'listening';
  el.cue.textContent = 'Breathe';
  el.sub.textContent = '';

  Breath.onExhaleStart = (inD)=>{
    // How much of a crest this breath earned. By default that is how long the
    // inhale ran; the experiment reads how deep it went instead, measured
    // against this user's own learned stroke, so a big breath breaks harder
    // than a slow shallow one. Duration and depth are only loosely related —
    // a long, shallow inhale is a real thing and sounds wrong rewarded.
    const size = Flags.depthBreak
      ? clamp((Math.abs((Breath.peakS ?? 0) - (Breath.troughS ?? 0)) / Breath.strokeAmp - 0.7) / 0.6, 0, 1)
      : clamp((inD - 2.0)/3.0, 0, 1);
    Audio.bell((0.55 + 0.45*size*UI.rich) * Breath.follow);
    // Only count it as a breath once the rhythm backs the claim. A phone being
    // moved about produced 248 "breaths" at 26 a minute before this line.
    if(Breath.conf > 0.45){
      Recorder.event('breath', {inhaleSec:inD, exhaleSec:Breath.exhaleDur});
      UI.marks.push(UI.trace.length);
      while(UI.marks.length && UI.marks[0] < 0) UI.marks.shift();
    }
  };

  // If nothing arrives at all, say which of the two possible causes it is.
  setTimeout(()=>{
    if(UI.state!=='running' || UI.sensorSeen || UI.demo) return;
    if(UI.sensorPerm === 'ok'){
      notice('Allowed, but silent', 'Motion access was granted and no readings are arriving. Lock and unlock the screen, or reload the page. If this is inside another app, open it in Safari directly.', 0);
    }else{
      notice('Motion not active', 'Permission state: ' + UI.sensorPerm + '. Reload and tap Start first, or switch on Demo mode under Adjust.', 0);
    }
  }, 5000);

  UI.lastFrame = performance.now();
  requestAnimationFrame(loop);
}

async function end(){
  UI.state='idle';
  window.removeEventListener('devicemotion', onMotion);
  Breath.onExhaleStart = null;
  await Audio.stop(2.2);
  if(UI.silentEl){ try{ UI.silentEl.pause(); }catch(e){} UI.silentEl=null; }
  if(UI.wakeLock){ try{ UI.wakeLock.release(); }catch(e){} UI.wakeLock=null; }
  [el.dial, el.centerRead, el.traceWrap, el.readout].forEach(n=>n.classList.add('hidden'));
  el.main.textContent='Start'; el.main.classList.add('primary');
  el.statusTag.textContent='standby';
  UI.sensorSeen=false;

  let session = null;
  try{ session = await Recorder.stop(); }catch(e){}
  // Recorder.build() leaves motion and derived in columnar form with rows:[];
  // Store.get() assembles the row shape the summary draws from. Motion is skipped
  // because the summary only needs the derived channel, and materialising 70k
  // motion rows on a phone just to draw a sparkline is not worth the pause.
  if(session && Store.available){
    try{ session = (await Store.get(session.id, {motion:false})) || session; }catch(e){}
  }
  reportSaveTrouble();
  Review.showSummary(session);
  refreshStorageRow();
}

/** Review's Done button. The list and detail screens never call this — they are
    reachable mid-session, so closing those must return you to the session. */
function toIntro(){
  el.intro.classList.remove('hidden');
  el.recBtn.classList.remove('hidden');
  el.buildLine.classList.remove('hidden');
  el.statusTag.textContent = 'standby';
}

/** Recording must never disturb a session, so trouble is reported once, after it. */
function reportSaveTrouble(){
  if(UI.toldSaveTrouble) return;
  if(!Store.available){
    UI.toldSaveTrouble = true;
    notice('Not recorded', 'This browser will not let breathe store anything, so that session '
      + 'was not kept. Your breathing was unaffected. Open the page in Safari directly, or '
      + 'leave private browsing, if you want recordings.', 8000);
  }else if(Recorder.saveError){
    UI.toldSaveTrouble = true;
    notice('Not recorded', 'That session could not be saved (' + Recorder.saveError
      + '). Your breathing was unaffected. Try deleting older recordings under Adjust.', 8000);
  }
}

/* ---------- main loop ---------- */
/* Demo mode simulates the sensor. It used to be a sine wave, which is not how
   anyone breathes and is precisely the case the tracker finds easy: a sinusoid
   has no holds in it, and holds are what has broken twice. The shape below is
   the one the owner described from their own trace — a long flat bottom, a
   quick rise, a pause at the top, a slower fall — at 6 a minute:

     0.00 - 0.18   inhale, 1.8 s
     0.18 - 0.38   held at the top, 2.0 s
     0.38 - 0.68   exhale, 3.0 s
     0.68 - 1.00   held at the bottom, 3.2 s

   Smootherstep on the two strokes, so the turnarounds have no corner in them
   for the tau = 0.35 s filter to ring on. Returns -1..1. */
const PHASES = [[0.18, 1], [0.38, 0], [0.68, -1], [1.00, 0]];
function demoBreath(dt, state){
  state.demoPhase = (state.demoPhase + dt/10) % 1;
  const u = state.demoPhase;
  let from = 0, base = -1;
  for(const [to, dir] of PHASES){
    if(u < to){
      if(dir === 0) return base;                 // a hold: the level does not move
      const k = (u - from)/(to - from);
      const e = k*k*k*(k*(k*6 - 15) + 10);       // smootherstep
      return dir > 0 ? -1 + 2*e : 1 - 2*e;
    }
    from = to;
    if(dir !== 0) base = dir;
  }
  return base;
}

function loop(now){
  if(UI.state==='idle') return;
  const dt = clamp((now-UI.lastFrame)/1000, 0.001, 0.1);
  UI.lastFrame = now;

  if(UI.demo){
    const dt0 = now/1000;
    const s = demoBreath(dt, UI);
    // 0.45 m/s^2 on each of two axes: the amplitude real sessions actually
    // measured. It was 0.05, which the confidence gate would now read as a
    // phone lying on a table.
    const dx = s*0.45, dy = 0.2, dz = 9.79 + s*0.45;
    Breath.push(dx, dy, dz, dt0);
    Recorder.sample(dx, dy, dz, dt0);   // or a demo session has no raw channel to replay
  }

  // The sound runs from the first frame, calibration included. Waiting for the
  // axis left the user lying in silence for twenty seconds wondering whether
  // anything worked. Before finishCalibration() the projection uses the default
  // z axis, which on a phone lying face-up on a belly already carries most of
  // the movement, so it responds — just less precisely than it will in a moment.
  // When there is nothing worth following, the sound settles to a neutral bed
  // rather than chasing whatever the sensor happens to be doing. lvl goes to
  // mid-breath, velocity to nothing.
  const f = Breath.follow;
  const level = 0.5 + (Breath.level() - 0.5)*f;
  const speed = Breath.speed()*f;

  // reward: slower breathing opens the sound up. bpmSmooth is 0 until the
  // second breath is timed, and (14-14)/8 = 0 holds rich at its floor until
  // there is a rate to reward.
  const slow = clamp((14 - (Breath.bpmSmooth||14))/8, 0, 1);
  UI.rich = lp(UI.rich, clamp(0.28 + 0.72*slow, 0, 1), dt, 3.0);

  Audio.frame({
    level, vel:Breath.vel()*f, speed, inhaling:Breath.rising, resting:Breath.resting,
    rich:UI.rich, bpm:Breath.bpmSmooth||0, dt
  });
  if(UI.state==='running') updateReadout();

  // live sample rate in the header: 0 Hz means no events are arriving at all
  UI.hzAcc += dt;
  if(UI.hzAcc >= 1){
    UI.hz = Math.round((Breath.samples - UI.lastSamples)/UI.hzAcc);
    UI.lastSamples = Breath.samples; UI.hzAcc = 0;
    el.statusTag.textContent =
      'listening' +
      (UI.demo ? ' \u00b7 demo' : ' \u00b7 ' + UI.hz + ' Hz');
  }

  // The axis moves now, so a recording that only carried the final one would
  // hide the tracker settling. 30 s is coarse enough to stay cheap.
  UI.axisAcc += dt;
  if(UI.axisAcc >= 30){
    UI.axisAcc = 0;
    Recorder.event('axis', {axis:Breath.u.slice(), ok:Breath.conf>0.45,
                            amplitude:+Breath.axisAmp.toFixed(4),
                            conf:+Breath.conf.toFixed(3), flipped:!!Breath.flipped});
  }

  // rolling trace at ~10 Hz
  UI.traceAcc += dt;
  if(UI.traceAcc>0.1){
    UI.traceAcc-=0.1;              // carry the remainder: resetting to 0 ran the tick at ~8.6 Hz
    UI.trace.push(clamp(Breath.s,-1.6,1.6));
    UI.held.push(Breath.restGate < 0.5);
    if(UI.trace.length>620){
      UI.trace.shift(); UI.held.shift();
      for(let i=0;i<UI.marks.length;i++) UI.marks[i]--;
      while(UI.marks.length && UI.marks[0] < 0) UI.marks.shift();
    }
    Recorder.derived({t:now/1000, s:Breath.s, level:level, phase:Breath.phase,
                      bpm:(Breath.conf>0.45 ? Breath.bpmSmooth : 0)||0,
                      quality:Breath.quality(), rich:UI.rich,
                      hr:Pulse.reading(Breath.motionRms), hrConf:Pulse.conf});
  }

  drawDial(level);
  drawTrace();
  requestAnimationFrame(loop);
}

function updateReadout(){
  // A dash until the rhythm supports a number. Showing a rate the app does not
  // stand behind is how the bogus session came to claim 26 breaths a minute.
  const sure = Breath.conf > 0.45;
  const b = sure ? Breath.bpmSmooth : 0;
  el.vRate.textContent = b ? b.toFixed(1) : '—';
  const i=Breath.inhaleDur, o=Breath.exhaleDur;
  el.vRatio.textContent = (sure && i>0.4 && o>0.4) ? (i.toFixed(1)+' / '+o.toFixed(1)) : '—';
  if(Pulse.enabled){
    const hr = Pulse.reading(Breath.motionRms);
    // A dash is the honest reading most of the time. Holding the last number on
    // screen after the evidence went away would make it look far more reliable
    // than it is.
    el.vHr.textContent = hr ? String(Math.round(hr)) : '—';
    // The unit would be a lie next to a dash: there is no rate to give units to.
    el.vHrUnit.classList.toggle('hidden', !hr);
  }
  signalHint();
}

/**
 * "signal: fair" told the user a number they could not act on. Say nothing
 * while the signal is usable, and when it is not, say which of the two things
 * is wrong — there is not much movement to read, or there is too much of the
 * wrong sort — because those have different fixes.
 *
 * Debounced hard on purpose. The user is lying with their eyes closed; a line
 * that appears and vanishes as quality crosses a threshold is worse than none,
 * and by the time they look it should still be true.
 */
function signalHint(){
  const bad = Breath.follow < 0.3, good = Breath.follow > 0.55;
  const now = performance.now()/1000;

  if(bad){ if(!UI.badSince) UI.badSince = now; }
  else if(good){ UI.badSince = 0; }

  if(!(UI.badSince && (now - UI.badSince) > 8)){
    el.qualityTxt.textContent = '';
    return;
  }
  // axisAmp is the size of the movement on the breath axis, in m/s^2. Real
  // sessions measure 0.3-0.5; too little means the phone is not picking the
  // breath up, too much means it is being handled rather than breathed on.
  el.qualityTxt.textContent = Breath.axisAmp < 0.05
    ? 'move the phone lower on your belly'
    : 'lie still for a moment';
  el.qualityTxt.style.color = 'var(--sand)';
}

/* ---------- drawing ---------- */
function drawDial(level){
  const {ctx,w,h}=fitCanvas(el.dial);
  ctx.clearRect(0,0,w,h);
  const cx=w/2, cy=h/2, R=Math.min(w,h)*0.40;

  // your breath — filled swell. The fill deepens with rich, so the reward for
  // slowing down is visible as well as audible.
  const P = palette();
  const br = R*(0.36 + 0.64*level);
  const grd = ctx.createRadialGradient(cx,cy,br*0.15,cx,cy,br);
  grd.addColorStop(0, alpha(P.glass, 0.10 + 0.24*UI.rich));
  grd.addColorStop(1, alpha(P.glass, 0.015));
  ctx.beginPath(); ctx.arc(cx,cy,br,0,TAU); ctx.fillStyle=grd; ctx.fill();
  ctx.strokeStyle=alpha(P.glass, 0.80); ctx.lineWidth=1.6; ctx.stroke();

  // still centre
  ctx.beginPath(); ctx.arc(cx,cy,2.2,0,TAU);
  ctx.fillStyle=alpha(P.foam, 0.5); ctx.fill();
}

function drawTrace(){
  const {ctx,w,h}=fitCanvas(el.trace);
  ctx.clearRect(0,0,w,h);
  const P = palette();
  ctx.fillStyle=alpha(P.deep, 0.55); ctx.fillRect(0,0,w,h);
  ctx.strokeStyle=alpha(P.mute, 0.20); ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(0,h/2); ctx.lineTo(w,h/2); ctx.stroke();

  const n=UI.trace.length; if(n<2) return;
  const step=w/620, x0=w-n*step;

  // "Show what it hears": the stretches the app read as held, and a tick for
  // every breath it actually counted. The point is that you can check it
  // against your own body rather than taking the sound's word for it — the
  // one complaint about this app so far was about timing.
  if(Flags.heard){
    ctx.fillStyle = alpha(P.sand, 0.13);
    let from = -1;
    for(let i=0;i<=n;i++){
      const held = i<n && UI.held[i];
      if(held && from<0) from = i;
      else if(!held && from>=0){
        ctx.fillRect(x0+from*step, 0, (i-from)*step, h);
        from = -1;
      }
    }
    ctx.strokeStyle = alpha(P.foam, 0.34); ctx.lineWidth = 1;
    ctx.beginPath();
    for(const m of UI.marks){
      if(m < 0 || m >= n) continue;
      const x = Math.round(x0+m*step) + 0.5;
      ctx.moveTo(x, h-9); ctx.lineTo(x, h);
    }
    ctx.stroke();
  }

  ctx.beginPath();
  for(let i=0;i<n;i++){
    const y=h/2 - clamp(UI.trace[i],-1.6,1.6)*(h/2-5)/1.6;
    i?ctx.lineTo(x0+i*step,y):ctx.moveTo(x0+i*step,y);
  }
  ctx.strokeStyle=P.glass; ctx.lineWidth=1.7; ctx.lineJoin='round'; ctx.stroke();
}

/* ---------- wiring ---------- */
el.main.addEventListener('click', ()=>{
  if(UI.state !== 'idle'){ end(); return; }
  // ---- everything gated on user activation happens synchronously, right here.
  // Do not await anything above these three lines. See requestSensor().
  primeSilentChannel();
  const sensorP = UI.demo ? Promise.resolve('ok') : requestSensor();
  const audioP  = Audio.start().then(()=>true, ()=>false);
  el.main.disabled = true;
  begin(sensorP, audioP);
});
el.panelBtn.addEventListener('click', ()=>{
  Log.close();
  el.panel.classList.add('open');
  // Recalibrating only means something while a session is running.
  $('recalBar').classList.toggle('hidden', UI.state === 'idle');
  Review.refreshCount(); refreshStorageRow();
});
$('recBtn').addEventListener('click', ()=>Review.showList());
$('buildBtn').textContent = `${BUILD.v} · ${relDate(BUILD.date)}`;
$('buildBtn').addEventListener('click', ()=>Log.open());
$('closeLog').addEventListener('click', ()=>Log.close());
$('reloadBtn').addEventListener('click', ()=>Updater.check());
$('closePanel').addEventListener('click', ()=>el.panel.classList.remove('open'));
// Not a calibration step — there is none. This throws away the tracked axis
// and the learned stroke depth, which is what you want after turning over or
// moving the phone: the tracker re-finds them in a few breaths instead of
// dragging the old ones along.
$('recalBtn').addEventListener('click', ()=>{
  el.panel.classList.remove('open');
  if(UI.state==='idle') return;
  Breath.begin(performance.now()/1000);
  notice('Starting over', 'Breathe normally. It finds your breathing again in a few breaths.', 4500);
});
/* ---------- the Adjust panel ----------
   One table, because every control needs the same four things done to it:
   wired to its effect, restored from the last session, saved when it moves,
   and put back when the user asks for the defaults. Adding a control that is
   not in this list is how one of the four gets forgotten. */

const SLIDERS = [
  // id        key            default  apply
  // The defaults repeat index.html's `value` attributes on purpose: a control
  // has to be able to go back to where it started without a reload, now that
  // moving it is permanent. resetSound() below asserts the two agree.
  ['vol',     'volume',      55,  v => Audio.setVolume(v/100)],
  ['sens',    'sensitivity', 50,  v => { Breath.sensitivity = clamp(v/100, 0, 1); }],
  ['mSwell',  'swell',      100,  v => Audio.setMix('swell', v/100)],
  ['mBreak',  'brk',        100,  v => Audio.setMix('brk',   v/100)],
  ['mFoam',   'foam',       100,  v => Audio.setMix('foam',  v/100)],
  ['mSpray',  'spray',      100,  v => Audio.setMix('spray', v/100)],
  ['mUnder',  'under',      100,  v => Audio.setMix('under', v/100)],
  ['mBright', 'bright',      50,  v => Audio.setMix('bright',v/100)],
  ['mSpace',  'space',       50,  v => Audio.setMix('space', v/100)],
];

/* This module is the entry point and nothing in the app imports it — that is
   what lets the tools load the tracker in Node with no DOM. The three exports
   below are for tools/smoke.mjs, which drives the app the way a finger would
   and needs to see the state a finger cannot: a timer that is armed, a flag
   that is set. Do not import them from another module in src/. */

/* Experiments. Off by default and saved with everything else, so trying one
   costs a tap and keeping it costs nothing. They are grouped under "Try" in
   Adjust rather than mixed in with the settled controls, because a control the
   app is not sure of should say so. */
export const Flags = { heard:false, dim:false, depthBreak:false };

const TOGGLES = [
  // Demo mode is deliberately absent: it is a way to hear the sound without
  // lying down, and a phone that silently starts a fake session a week later
  // because the switch was left on is worse than setting it again.
  ['tglPulse',  'pulse',  on => {
    Pulse.enabled = on;
    if(on) Pulse.reset();
    el.cellHr.classList.toggle('hidden', !on);
  }],
  ['tglInvert', 'invert', on => { Breath.invert = on; }],

  ['tglHeard',  'heard',  on => { Flags.heard = on; }],
  ['tglDim',    'dim',    on => {
    Flags.dim = on;
    if(!on) Dim.wake();
    else if(UI.state === 'running') Dim.arm();
  }],
  ['tglDepth',  'depthBreak', on => { Flags.depthBreak = on; }],
];

/* ---------- dimming ----------
   Lying in a dark room with a phone on your belly, the screen is the brightest
   thing in the room and there is nothing on it you need. It fades out after a
   while and a tap brings it back — but the tap that brings it back must not
   also press End, so a transparent catcher takes that one. */
export const Dim = {
  timer:null, on:false,
  AFTER: 25,                       // seconds of no touch; long enough to settle

  arm(){
    clearTimeout(this.timer);
    if(!Flags.dim || UI.state !== 'running') return;
    this.timer = setTimeout(()=>this.sleep(), this.AFTER*1000);
  },
  sleep(){
    if(!Flags.dim || UI.state !== 'running') return;
    this.on = true;
    document.body.classList.add('dimmed');
    $('dimCatch').classList.remove('hidden');
  },
  wake(){
    clearTimeout(this.timer);
    if(this.on){
      this.on = false;
      document.body.classList.remove('dimmed');
      $('dimCatch').classList.add('hidden');
    }
    this.arm();
  }
};
// pointerdown rather than click: the screen should come back as the finger
// lands, not when it lifts.
document.addEventListener('pointerdown', ()=>Dim.wake(), true);

/** Read every control and hand back the object that goes to the store. */
function collectSettings(){
  const out = {};
  for(const [id, key] of SLIDERS) out[key] = parseInt($(id).value, 10);
  for(const [id, key] of TOGGLES) out[key] = $(id).getAttribute('aria-checked') === 'true';
  return out;
}

/* A slider drag fires `input` on every pixel. Writing through each one would
   put a few hundred transactions on the store for one gesture, so coalesce. */
let saveTimer = null;
function saveSettings(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{ Store.writePrefs(collectSettings()); }, 400);
}

/** Put a value on a slider and through to whatever it drives. */
function setSlider(id, v){
  const inp = $(id);
  inp.value = String(v);
  const [, , , apply] = SLIDERS.find(c => c[0] === id);
  apply(clamp(parseInt(inp.value, 10), 0, 1000));
}

function setToggle(id, on){
  $(id).setAttribute('aria-checked', String(!!on));
  const found = TOGGLES.find(t => t[0] === id);
  if(found) found[2](!!on);
}

for(const [id, , , apply] of SLIDERS){
  $(id).addEventListener('input', e => {
    apply(parseInt(e.target.value, 10));
    saveSettings();
  });
}

for(const [id, , apply] of TOGGLES){
  const b = $(id);
  b.addEventListener('click', ()=>{
    const on = b.getAttribute('aria-checked') !== 'true';
    b.setAttribute('aria-checked', String(on));
    apply(on);
    saveSettings();
  });
}

// Demo mode: wired by hand, since it is the one switch that is not saved.
$('tglDemo').addEventListener('click', function(){
  const on = this.getAttribute('aria-checked') !== 'true';
  this.setAttribute('aria-checked', String(on));
  UI.demo = on;
  if(on) notice('Demo mode','Simulated breathing. Good for checking the sound without lying down.',5000);
});

// The break only sounds at the top of a breath, so moving its slider while
// sitting up holding the phone changed nothing audible and read as a dead
// control. Moving it now plays the crest, at the level being set.
let breakPreviewAt = 0;
$('mBreak').addEventListener('input', ()=>{
  const now = Date.now();
  if(now - breakPreviewAt < 900) return;
  breakPreviewAt = now;
  Audio.dispatch('top', 0.85);
});

// The sound has seven controls and no way back once they are all moved, now
// that they persist. Volume and sensitivity are yours and are left alone.
$('resetMixBtn').addEventListener('click', ()=>{
  for(const [id, key, def] of SLIDERS) if(key !== 'volume' && key !== 'sensitivity') setSlider(id, def);
  saveSettings();
  notice('Sound reset', 'The seven sound controls are back where they started.', 3500);
});

/** Restore what was saved. Anything missing keeps the slider's own default,
    so a settings row written by an older release cannot blank a new control. */
function applySettings(p){
  for(const [id, key] of SLIDERS) if(typeof p[key] === 'number') setSlider(id, p[key]);
  for(const [id, key] of TOGGLES) if(typeof p[key] === 'boolean') setToggle(id, p[key]);
}

$('notice').addEventListener('click', ()=>$('notice').classList.remove('show'));
window.addEventListener('resize', ()=>{ if(UI.state!=='idle'){ drawDial(Breath.level()); drawTrace(); } });

/* ---------- voice picker ---------- */
// built from Audio.voices so the markup and the engine cannot drift apart
/* ---------- recordings ---------- */
function refreshStorageRow(){
  const meter = $('storeMeterFill'), bar = $('storeMeter');
  if(!Store.available){ if(meter) meter.style.width = '0%'; return; }
  Store.usage().then(u=>{
    if(!u || !meter) return;
    const full = clamp(u.bytes/(u.budget||1), 0, 1);
    meter.style.width = Math.round(full*100) + '%';
    // Past 85% the next session deletes the oldest recording to make room, so
    // say so before it happens. The stylesheet had the rule; nothing set it.
    if(bar) bar.setAttribute('data-full', String(full > 0.85));
  });
}
$('openRecordings').addEventListener('click', ()=>{
  el.panel.classList.remove('open');
  Review.showList();
});
$('clearRecBtn').addEventListener('click', function(){
  // asks twice rather than using confirm(), which iOS renders badly over the panel
  if(this.getAttribute('data-armed') !== 'true'){
    this.setAttribute('data-armed','true'); this.textContent = 'Tap again';
    setTimeout(()=>{ this.setAttribute('data-armed','false'); this.textContent = 'Delete all'; }, 4000);
    return;
  }
  this.setAttribute('data-armed','false'); this.textContent = 'Delete all';
  Store.clear().then(()=>{
    notice('Recordings deleted', 'Every recording is gone from this phone.', 4000);
    Review.refreshCount(); refreshStorageRow();
  });
});
Review.onDone = toIntro;
// No user gesture is needed for IndexedDB, so this stays well away from the tap
// handler. Settings come back before the first tap, which is the whole point.
Store.open()
  .then(()=>Store.readPrefs())
  .then(p=>{ applySettings(p); Review.refreshCount(); refreshStorageRow(); });

Updater.start();

// secure-context check up front — requestPermission simply will not fire otherwise
if(!window.isSecureContext && location.hostname!=='localhost'){
  notice('Not a secure page','Motion sensors need HTTPS. Open this page over https:// and it will work.',0);
}
