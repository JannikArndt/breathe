import { $, clamp, lerp, lp, fin, TAU, notice, fitCanvas, palette, alpha } from './util.js';
import { LANGS, pickLang, setLang, getLang, t, n as nfmt, apply as applyLang } from './i18n.js';
import { Audio } from './audio.js';
import { Breath } from './breath.js';
import { Pulse } from './pulse.js';
import { Store, Recorder } from './store.js';
import { Review } from './review.js';

/* ============================================================
   6. APP
   ============================================================ */

/* Has anybody touched the page yet? An AudioContext built before the first
   touch comes up suspended and, on iOS, does not reliably resume afterwards —
   so the home screen's sound has to wait for one rather than build a context
   that can never speak. navigator.userActivation answers this directly where
   it exists (Safari 16.4 and up); everywhere else the app watches for the
   event itself. Registered here, at module load, so it runs before any
   listener that asks the question. */
let sawGesture = false;
for(const type of ['pointerdown','keydown','click']){
  document.addEventListener(type, ()=>{ sawGesture = true; }, true);
}
function touched(){
  if(sawGesture) return true;
  try{
    const ua = navigator.userActivation;
    if(ua && ua.hasBeenActive) return true;
  }catch(e){}
  return false;
}

/** Releases, newest first. There is no build step, so this list *is* the
    version: the top entry stamps the home screen and the exported session.
    Add an entry in the same commit as the change it describes, and write the
    notes for someone who has never seen the code — what the sound or the
    screen does differently, never how. */
const RELEASES = [
  {v:'0.18.1', date:'2026-09-01', notes:[
    'The first breaths of a session are no longer silent. To tell a hold from a stroke the app measures how fast your belly moves at its fastest, and it was taking that measurement from the moment the phone finished settling — which is the one moment in a session when the trace moves faster than any breath ever does. Every real breath then looked slow by comparison, so the app read the opening minute as holding still and kept the sound shut. On the recording that turned this up the first three breaths made no sound at all, and the fourth was half there.',
    'The same measurement was what made the sound stutter at the start — a swell that arrived, dropped out and came back about half a second later, for the first few breaths.'
  ]},
  {v:'0.18.0', date:'2026-09-01', notes:[
    'A switch in the top right turns the sound on and off. The sound is supposed to start itself on the first touch of the screen; where it does not, that is the touch.',
    'Settling is quicker: about three seconds for a phone that is already lying still, down from six. A phone still being put down waits as long as it needs to.',
    'You can set how fast the opening waves run, on the home screen, from two to twelve a minute. It changes the wave you are watching and hearing right there, and it is the rate the session opens at.',
    'After a session with ten breaths or more in it, that setting moves to match your own breathing — halfway between your average and your fastest breath, so there is somewhere to slow down from. The summary says when it has done that.'
  ]},
  {v:'0.17.0', date:'2026-09-01', notes:[
    'The home screen has sound again from the moment you open it. It was building its sound before you had touched the screen, which a phone will not allow, so there was nothing to hear until you had run a session and come back.',
    'A session no longer opens with a lurch. Reaching over to tap Start tilts the phone far more than a breath does, and the app was reading that as the first thing you did — the trace jumped, and on two recordings made on a table it reported breathing worth following from a phone that never moved. It now waits for the phone to be lying still before it measures anything, which takes about six seconds. The header says settling until it does.',
    'The opening waves wait with it, and no longer hand over to nothing. They step aside once there is really something to hear, and in any case after a minute.',
    'A session shorter than half a minute can be thrown away from its own summary, so a Start that should have been an End does not leave a recording behind.'
  ]},
  {v:'0.16.0', date:'2026-08-31', notes:[
    'A session no longer opens in silence. The wave from the home screen carries on into the session at six breaths a minute, so there is something to breathe with while the app works out what it is looking at. It steps aside after three waves, or sooner if it can already hear you, and hands the sound over to your own breathing.',
    'Breathing along with that wave is also how the app now works out which way round it is lying. It used to guess from the shape of a breath and got it backwards about half the time, which is why the sound sometimes rose when you breathed out.',
    'You can turn the opening waves off under Adjust, in the Sensor section.'
  ]},
  {v:'0.15.0', date:'2026-08-31', notes:[
    'The home screen is one wave now: it washes up the sand, throws spray ahead of itself, hangs, and drains back. It has its own space above the text rather than passing behind it.',
    'The sound comes on by itself, faded in, and it is the wave you are watching — the same signal draws the water and drives the surf.',
    'Gone from the home screen: the standby label, the fine print, and the button that used to start the sound.',
    'Gone from the breathing screen: the \u201cYou\u201d legend and the live sensor numbers.',
    'Dimming the screen keeps the words readable. It was washing them out towards the background instead of turning the brightness down.'
  ]},
  {v:'0.14.0', date:'2026-08-31', notes:[
    'The app speaks German. It picks your phone\u2019s language on the first run, and there is a switch at the top of Adjust.',
    'These release notes stay in English: they grow every time something changes, and a translation of them would be out of date within a day.'
  ]},
  {v:'0.13.0', date:'2026-08-31', notes:[
    'The home screen has waves rolling in from the top of the phone, which is where the sea is when you are lying down with this on your belly.',
    'Hear the waves plays the sound before you lie down, so you can set the volume with your eyes open.',
    'The setup text says four things instead of six, and the ringer diagram is gone.'
  ]},
  {v:'0.12.0', date:'2026-08-31', notes:[
    'Opening a recording is now about one thing: marking where the usable part starts and stops. Two buttons, and everything outside the marks is veiled on both graphs.',
    'Gone from that screen: the nine categories, the note field, the list of labels, the row of numbers under the graph and the row of zoom buttons.',
    'Pinch the lower graph to zoom. Delete has moved away from Export.'
  ]},
  {v:'0.11.0', date:'2026-08-31', notes:[
    'The sound keeps opening up below six breaths a minute, all the way to one. It used to reach its fullest at six and stop — on a seven-minute session that went from 6.2 down to 2.5 a minute, it stopped responding ninety seconds in and stayed put for the rest.',
    'Getting there is rewarded a little less than before if you settle around six a minute, and a lot more if you keep going. That trade is deliberate.',
    'Breaths up to seventy seconds long are counted. The whole chain follows you down rather than needing you to start slow: the filters, the sensitivity to depth and the pause detection all re-scale as your rate changes.'
  ]},
  {v:'0.10.1', date:'2026-08-31', notes:[
    'Labelling a recording no longer erases its raw signal. Adding a label rewrote the whole recording from what was on screen, and the screen only ever holds the summary — so the one action you take to make a recording more useful was the action that threw most of it away. Recordings labelled before this update have already lost it, and it cannot be recovered.'
  ]},
  {v:'0.10.0', date:'2026-08-31', notes:[
    'It works with no connection. The whole app is kept on the phone, so a session starts whether or not you have signal.',
    'When there is a new version the app tells you, and Changes installs it. No more deleting the icon and adding it back. The Reload row is a Check now: it asks, and says so when there is nothing new.',
    'Added to the Home Screen it gets its own icon and name instead of a screenshot.',
    'Everything in Adjust is remembered. Volume, sensitivity, the seven sound controls and the sensor switches all come back the way you left them, and a Reset button puts the seven sound controls back where they started. Demo mode is deliberately not remembered, so a switch left on cannot quietly fake a session next week.',
    'Very slow breathing is followed properly. Below four a minute the sound was reading your movement as about a quarter weaker than it was, so the layers that follow the stroke faded exactly as you slowed down. Breaths longer than thirty seconds are counted now instead of thrown away.',
    'The summary says how long your breaths were, in and out, and how much of the session it read as held rather than moving.',
    'Opening a recording shades the stretches where the app thought you were holding, on both lanes, so you can check it against what you remember.',
    'A new Try section holds four things that are not sure of themselves yet, all off until you turn them on. Show what it hears shades the live trace where it reads you as holding and ticks each breath it counted. Dim the screen fades the display while you breathe, and the tap that brings it back cannot press End. Show the numbers puts the live sensor readings under the trace. Crest follows depth breaks the wave harder after a deeper breath rather than a longer one.',
    'Recordings take about a third less space, and Export all no longer asks the phone for the whole file in one piece.',
    'Demo mode breathes the way a person does now — a long flat bottom, a quick rise, a pause at the top — instead of a sine wave.',
    'The trace was drawing a second, flat line down the middle of the graph for the whole session. It belonged to the guide tone, which was removed a while ago.',
    'If an update is found but cannot be stored, the app says so rather than going quiet. What you are running is never disturbed by a failed one.'
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
export const Updater = {
  reg:null, waiting:null, state:'unsupported', handingOver:false, pending:false,
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
          // The worker precaches the whole app as one set and gives up if any
          // part of it is missing — a half-finished deploy, say. Silence there
          // would look exactly like "nothing new", which is the one thing this
          // panel exists to be able to tell apart from a real answer.
          else if(sw.state === 'redundant') this.failed();
        });
      });
    }).catch(()=>{ this.state = 'unsupported'; });

    // controllerchange fires in two quite different situations and only one of
    // them wants a reload.
    //
    // On the very first visit there is no controller at all: the worker
    // installs, activates, claims the page, and this fires a second or two
    // after the app loads. Reloading there would restart the app under
    // someone's finger — and if they had already tapped Start, it would kill
    // the session. Nothing is stale on a first visit, so there is nothing to
    // reload for.
    //
    // The other case is the handover we asked for, which does want the reload:
    // the page is running code the new cache no longer holds.
    navigator.serviceWorker.addEventListener('controllerchange', ()=>{
      if(!this.handingOver) return;
      this.handingOver = false;
      location.reload();
    });
  },

  arrived(sw){
    this.waiting = sw;
    this.state = 'ready';
    this.paint();
    // Never over a running session. Nothing about a new version is urgent, the
    // Changes screen is out of reach while breathing anyway, and a toast is the
    // one thing on this screen that can pull attention back to the phone.
    if(UI.state === 'running'){ this.pending = true; return; }
    this.announce();
  },

  /** An install that could not complete. The running version is untouched — the
      worker only ever replaces a version it managed to cache whole. */
  failed(){
    if(this.state === 'ready') return;              // a later attempt already won
    this.state = 'idle'; this.pending = false; this.paint();
    if(UI.state === 'running') return;              // never over a session
    notice(t('n.updfail', null, 'Update did not finish'),
      t('n.updfail.b', null, 'A new version was found but could not be stored. What you are running is unaffected. Try again in a minute.'), 6000);
  },

  announce(){
    this.pending = false;
    notice(t('n.newver', null, 'A new version is ready'), t('n.newver.b', null, 'Open Changes from the bottom of the home screen to install it.'), 8000);
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
        notice(t('n.uptodate', null, 'Up to date'), t('n.uptodate.b', null, 'This is the newest version. Nothing to install.'), 4000);
      })
      .catch(()=>{
        this.state = 'idle'; this.paint();
        notice(t('n.nocheck', null, 'Could not check'), t('n.nocheck.b', null, 'No answer from the network. The app keeps working offline.'), 5000);
      });
  },

  install(){
    if(!this.waiting) return;
    this.handingOver = true;
    this.waiting.postMessage('skip-waiting');          // controllerchange reloads
  },

  /** Keep the row in Changes honest about what the button will do. */
  paint(){
    const btn = $('reloadBtn'), hint = $('reloadHint');
    if(!btn || !hint) return;
    const say = {
      unsupported: [t('log.btn.reload','',null) || 'Reload',   t('log.hint.plain','',null) || 'fetches the page again, past the cache'],
      idle:        [t('log.btn.check','',null)  || 'Check',    t('log.hint.check','',null) || 'asks whether a newer version exists'],
      checking:    ['…',                                      t('log.hint.asking','',null) || 'asking'],
      ready:       [t('log.btn.install','',null)|| 'Install',  t('log.hint.ready','',null) || 'a new version is ready to take over']
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
        now.className = 'log-now'; now.textContent = t('log.running', null, 'running');
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
  demo:false, phase:0,
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
  statusTag:$('statusTag'), qualityTxt:$('qualityTxt'), traceKey:$('traceKey'),
  waves:$('waves'), soundBtn:$('soundBtn'), pace:$('pace'), paceVal:$('paceVal')
};

/** The readout beside the pace slider, and the label on the sound switch. Both
    change with state, so applyLang() cannot reach them. */
function paintPace(){
  el.paceVal.textContent = '';
  el.paceVal.appendChild(document.createTextNode(nfmt(Pace.bpm, Pace.bpm % 1 ? 1 : 0)));
  const u = document.createElement('span');
  u.textContent = t('unit.min', null, '/min');
  el.paceVal.appendChild(u);
}

function paintSoundBtn(){
  const on = !!Shore.audio;
  el.soundBtn.dataset.on = String(on);
  el.soundBtn.textContent = on ? t('btn.soundoff', null, 'Sound off')
                               : t('btn.soundon',  null, 'Sound on');
}

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
  if(document.visibilityState !== 'visible' && UI.state === 'idle') Shore.stop();
  if(document.visibilityState==='visible'){
    if(UI.state === 'idle') Shore.start();
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
  el.soundBtn.classList.add('hidden');   // the header slot is the status tag's now
  const audioOk = await audioP;
  const sensor  = await sensorP;
  UI.sensorPerm = sensor;

  if(!audioOk){
    notice(t('n.nosound', null, 'No sound'), t('n.nosound.b', null, 'This browser blocked audio. Reload the page and tap Start again.'), 0);
    el.main.disabled = false; return;
  }
  if(sensor === 'denied'){
    notice(t('n.denied', null, 'Motion declined'), t('n.denied.b', null, 'Reload the page to be asked again. If no prompt appears, clear this site\u2019s data in Safari settings — a past "Don\u2019t Allow" is remembered per site.'), 0);
  }else if(sensor === 'unsupported'){
    notice(t('n.unsupported', null, 'No motion sensor'), t('n.unsupported.b', null, 'This device or browser has no motion sensor. Demo mode under Adjust will still show you how it sounds.'), 0);
  }else if(sensor.indexOf('error:') === 0){
    const name = sensor.slice(6);
    notice(t('n.reqfail', null, 'Motion request failed'), name === 'NotAllowedError'
      ? t('n.reqfail.tap', null, 'The browser did not treat that as a direct tap. Reload the page and tap Start as your first action, without scrolling first.')
      : t('n.reqfail.b', [name], name + '. Reload and try again, or use Demo mode under Adjust.'), 0);
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
  el.main.textContent = t('btn.end', null, 'End'); el.main.classList.remove('primary'); el.main.disabled = false;

  UI.state = 'running';
  UI.trace = []; UI.held = []; UI.marks = [];
  Dim.arm();
  Breath.invert = $('tglInvert').getAttribute('aria-checked')==='true';
  Breath.begin(performance.now()/1000);
  // Carry the wave across at the phase it was already at, so pressing Start
  // does not restart it mid-stroke.
  Lead.begin(Shore.phase);
  el.statusTag.classList.remove('hidden');
  el.statusTag.textContent = t('tag.listening', null, 'listening');
  el.cue.textContent = Lead.on
    ? t('cue.with', null, 'Breathe with the waves')
    : t('cue.breathe', null, 'Breathe');
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
      notice(t('n.silent', null, 'Allowed, but silent'), t('n.silent.b', null, 'Motion access was granted and no readings are arriving. Lock and unlock the screen, or reload the page. If this is inside another app, open it in your browser directly.'), 0);
    }else{
      notice(t('n.inactive', null, 'Motion not active'), t('n.inactive.b', [UI.sensorPerm], 'Permission state: ' + UI.sensorPerm + '. Reload and tap Start first, or switch on Demo mode under Adjust.'), 0);
    }
  }, 5000);

  UI.lastFrame = performance.now();
  requestAnimationFrame(loop);
}

async function end(){
  UI.state='idle';
  Dim.wake();                       // never leave the summary behind a dimmed screen
  window.removeEventListener('devicemotion', onMotion);
  Breath.onExhaleStart = null;
  await Audio.stop(2.2);
  if(UI.silentEl){ try{ UI.silentEl.pause(); }catch(e){} UI.silentEl=null; }
  if(UI.wakeLock){ try{ UI.wakeLock.release(); }catch(e){} UI.wakeLock=null; }
  [el.dial, el.centerRead, el.traceWrap, el.readout].forEach(n=>n.classList.add('hidden'));
  el.main.textContent = t('btn.start', null, 'Start'); el.main.classList.add('primary');
  // Nothing to say on the home screen: "standby" was a label for a state you
  // can already see.
  el.statusTag.classList.add('hidden');
  el.statusTag.textContent = '';
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
  Review.note = '';
  learnPace(session && session.summary);
  Review.showSummary(session);
  refreshStorageRow();
  // A version that arrived mid-session held its tongue. Now is a fine time.
  if(Updater.pending) Updater.announce();
}

/* Ten breaths, which at the rates this app is used at is three or four
   minutes. Below that a session is a start and a stop with a couple of breaths
   between, and its average is one breath's worth of evidence. */
const PACE_LEARN_MIN = 10;

/** Move the wave's rate to match the body it just listened to.

    Halfway between the average of the session and its fastest breath, not the
    average itself: the wave is where you *start*, and the owner works their
    way down inside a session — 6.2 to 2.5 a minute over seven minutes in one
    recording here. Opening at the average would open below where they began
    and ask them to speed up to meet it, which is the wrong direction for
    everything this app does. The fastest breath alone is one breath, so the
    halfway point is the trade.

    It is a default, not a target: nothing scores the user against it and they
    can move the slider afterwards. */
function learnPace(sum){
  if(!sum || !(sum.breaths >= PACE_LEARN_MIN)) return;
  const avg = sum.meanBpm, fast = sum.maxBpm;
  if(!(avg > 0) || !(fast > 0)) return;
  const want = clamp((avg + fast)/2, Pace.MIN, Pace.MAX);
  const tenths = Math.round(want*10/5)*5;         // the slider's own half-breath step
  if(tenths === parseInt(el.pace.value, 10)) return;
  setSlider('pace', tenths);
  saveSettings();
  // Said on the summary rather than in a toast: a toast at the end of a session
  // queues behind the update announcement, and the summary is where you are.
  Review.note = t('n.pace.b', [nfmt(Pace.bpm, 1)],
    'The opening waves are set to ' + nfmt(Pace.bpm, 1) +
    ' a minute from this session. You can change that on the home screen.');
}

/** Review's Done button. The list and detail screens never call this — they are
    reachable mid-session, so closing those must return you to the session. */
function toIntro(){
  el.intro.classList.remove('hidden');
  Shore.start();
  el.recBtn.classList.remove('hidden');
  el.buildLine.classList.remove('hidden');
  el.soundBtn.classList.remove('hidden');
  el.statusTag.classList.add('hidden');
  paintSoundBtn();
}

/** Recording must never disturb a session, so trouble is reported once, after it. */
function reportSaveTrouble(){
  if(UI.toldSaveTrouble) return;
  if(!Store.available){
    UI.toldSaveTrouble = true;
    notice(t('n.notrec', null, 'Not recorded'), t('n.notrec.store', null,
      'This browser will not let breathe store anything, so that session was not kept. Your breathing was unaffected. Open the page in your browser directly, or leave private browsing, if you want recordings.'), 8000);
  }else if(Recorder.saveError){
    UI.toldSaveTrouble = true;
    notice(t('n.notrec', null, 'Not recorded'), t('n.notrec.err', [Recorder.saveError],
      'That session could not be saved (' + Recorder.saveError + '). Your breathing was unaffected. Try deleting older recordings under Adjust.'), 8000);
  }
}

/**
 * How much of the reward a rate has earned, 0..1.
 *
 * This was one straight line from 14 breaths a minute to 6, and it saturated
 * there. On the owner's own session — the trace descends from 6.2/min to
 * 2.5/min over seven minutes, which is exactly what they described doing — it
 * reached 1.0 ninety seconds in and sat there for the remaining six minutes,
 * through the entire part of the session that the app is for. The one channel
 * the instrument has for responding to how someone is breathing stopped
 * responding before they had properly started.
 *
 * Two segments, because they are not the same job. Most of the reward is still
 * earned getting from 14 to 6 — that is the range the evidence in the README is
 * about, and a regular breather must not be robbed to pay for this. The rest is
 * a gentler slope from 6 down to 1, which is where slow-breathing practice
 * actually goes and where there used to be nothing at all.
 *
 *   14/min  0.00      6/min  0.75      3/min  0.90      1/min  1.00
 *
 * The cost is real and small: a 6/min breather sees rich 0.82 rather than 1.00,
 * which moves the reverb send from 0.60 to 0.55 and the break's tail from 3.5 s
 * to 3.2 s. Exported for tools/smoke.mjs, which checks the shape rather than
 * inferring it from a filter corner.
 */
export function reward(bpm){
  const fast = clamp((14 - bpm)/8, 0, 1);   // 14 -> 6
  const slow = clamp(( 6 - bpm)/5, 0, 1);   //  6 -> 1
  return clamp(0.75*fast + 0.25*slow, 0, 1);
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

/* The rate the wave runs at — on the home screen, and in the lead-in, because
   they are the same wave. Six a minute is where it starts; the owner works
   their way down from there and can set it before lying down, and a session
   with enough breaths in it to mean something moves the default. See
   learnPace(). */
const Pace = {
  MIN: 2, MAX: 12, DEF: 6,          // breaths a minute
  bpm: 6,
  get period(){ return 60/this.bpm; },     // seconds
  set(v){ this.bpm = clamp(fin(v, this.DEF), this.MIN, this.MAX); },

  /* The steepest the wave ever moves, as a fraction of one full stroke a
     second. The rise covers the whole stroke in 0.18 of the period and
     smootherstep peaks at 1.875x its mean. Velocity is divided by this, so
     the loudest moment of the wave is 1 whatever rate it runs at — which is
     the same rule Audio.frame() applies to real breathing, and for the same
     reason: peak velocity scales with rate, so a fixed divisor would fade the
     wave out exactly as the user slowed it down. */
  get vRef(){ return 1.875/(0.18*this.period); }
};

/* Demo mode's simulated body runs at a fixed six a minute, not at Pace: the
   pace control sets the rate of the *wave*, and if the fake body followed it
   too the two could never disagree — which is exactly the case worth hearing,
   since a real body does not breathe at whatever the slider says. */
const DEMO_PERIOD = 10;

function demoBreath(dt, state, period){
  state.phase = ((state.phase || 0) + dt/(period || Pace.period)) % 1;
  const u = state.phase;
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

/* ---------- the lead-in ----------
   A session used to open in silence. Measured on the recordings from 31 Aug,
   the tracker first reported a rate 91 s into the session the owner called
   great, 192 s into the next one, and never in a third that ran 109 s. Lying
   still waiting for a sound to appear is the worst part of using this app, and
   it is also the part where the user has nothing to breathe to.

   So the session opens with the same wave the home screen was playing, at six
   breaths a minute, carried across without a jump in the phase. It hands over
   to the user's own breathing after three of those waves, or sooner if there
   is already enough movement to follow.

   This is not the pacer that was removed, and must not be allowed to grow back
   into one. That one ran for the whole session, moved a target rate toward a
   goal, and rewarded the user for staying locked to it. This one is a
   reference to start from: it is the same single voice, it never adapts to
   what the user does, nothing scores them against it, and it ends — after
   thirty seconds it is gone and the sound is theirs.

   It also earns its keep twice over, because breathing along with a known wave
   is what finally makes the *direction* observable. See Breath.resolveSign(). */
export const Lead = {
  get PERIOD(){ return Pace.period; },   // the wave's own, and the crossfade's
  BREATHS: 3,                  // waves before handing over, given something to hand to
  MAX: 6,                      // waves before handing over regardless. See ready().
  on:false, phase:0, breaths:0, mix:0, handing:false, wasRising:false,
  s:-1, level:0, vel:0, prev:null, wasSettled:false,

  begin(phase){
    this.on = !!Flags.lead;
    this.phase = phase || 0;   // carried from the home screen, so the wave does not jump
    this.breaths = 0; this.mix = 0; this.handing = false;
    this.wasRising = false; this.s = -1; this.prev = null;
    this.level = 0.5; this.vel = 0; this.wasSettled = false;
  },

  /** Advance the wave and decide whether it is time to step aside. */
  step(dt){
    if(!this.on) return;
    const s = demoBreath(dt, this);
    const reach = (s + 1)/2;
    const vel = this.prev === null ? 0 : (reach - this.prev)/dt;
    this.prev = reach;
    const rising = vel > 0;
    // One wave counted at the crest, the same event the spray is thrown at.
    if(this.wasRising && !rising) this.breaths++;
    this.wasRising = rising;
    this.s = s;
    this.level = reach;
    // The same normalisation the home screen uses, against a stroke of 1 here
    // rather than the 0.70 the shore draws over. Both go through Pace.vRef, so
    // the two halves of the handover are the same loudness at any rate.
    this.vel = clamp(vel/Pace.vRef, -1, 1);

    // The reference the user is breathing along with, fed to the tracker so it
    // can see which way round the axis is.
    Breath.lead(s);

    // Phase one is over. The waves counted while the phone was still being put
    // down were heard but not measured against anything, so the count of what
    // the tracker has had a chance to see starts here.
    if(Breath.settled && !this.wasSettled){ this.wasSettled = true; this.breaths = 0; }

    if(!this.handing && this.ready()){
      // Resolve the direction *before* the crossfade starts, while the lead is
      // still at full volume — flipping the axis inverts the measured signal,
      // and this is the one moment where nobody can hear it happen.
      Breath.resolveSign();
      // Start at the bottom of the wave, where a mismatch between the two is
      // smallest, and take one full wave over it.
      if(this.phase > 0.68) this.handing = true;
    }
    if(this.handing){
      this.mix = clamp(this.mix + dt/this.PERIOD, 0, 1);
      if(this.mix >= 1){
        this.on = false;
        Recorder.event('lead', {waves:this.breaths, follow:+Breath.follow.toFixed(3),
                                flipped:!!Breath.flipped});
        el.cue.textContent = t('cue.breathe', null, 'Breathe');
      }
    }
  },

  /** When to hand over. Three tests, and the last one is the one that keeps
      this from being a pacer.

      A phone lying on a table used to satisfy the old "three waves and hand
      over" rule outright, and hand over to nothing. So there has to be
      something to hand over *to*: either enough movement to follow after a
      single wave, or a weaker signal after three. But it also always ends —
      six waves is a minute, and past that the sound is the user's whether or
      not the app can hear anything, because a wave that never stops is exactly
      the thing this app deliberately does not have. */
  ready(){
    if(this.breaths >= 1 && Breath.follow > 0.6) return true;
    if(this.breaths >= this.BREATHS && Breath.follow > 0.35) return true;
    return this.breaths >= this.MAX;
  },

  /** Smootherstep, so the handover has no corner at either end. */
  blend(){
    if(!this.on) return 1;
    const k = this.mix;
    return k*k*k*(k*(k*6 - 15) + 10);
  }
};

function loop(now){
  if(UI.state==='idle') return;
  const dt = clamp((now-UI.lastFrame)/1000, 0.001, 0.1);
  UI.lastFrame = now;

  if(UI.demo){
    const dt0 = now/1000;
    const s = demoBreath(dt, UI, DEMO_PERIOD);
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
  let level = 0.5 + (Breath.level() - 0.5)*f;
  let speed = Breath.speed()*f;
  let vel   = Breath.vel()*f;
  let rising = Breath.rising, resting = Breath.resting;

  // The lead-in, and the crossfade out of it. Both halves are the same shape
  // of number, so this is a blend rather than a switch.
  Lead.step(dt);
  if(Lead.on){
    const k = Lead.blend();
    level  = lerp(Lead.level, level, k);
    vel    = lerp(Lead.vel,   vel,   k);
    speed  = lerp(Math.abs(Lead.vel), speed, k);
    rising = k < 0.5 ? Lead.vel > 0 : Breath.rising;
    resting= k < 0.5 ? Math.abs(Lead.vel) < 0.03 : Breath.resting;
  }

  // reward: slower breathing opens the sound up. bpmSmooth is 0 until the
  // second breath is timed, and reward(14) = 0 holds rich at its floor until
  // there is a rate to reward.
  UI.rich = lp(UI.rich, clamp(0.28 + 0.72*reward(Breath.bpmSmooth||14), 0, 1), dt, 3.0);

  // The lead wave is six a minute, which is a real rate and the one the sound
  // should be normalised against while it is playing — velocity is divided by
  // the peak the rate implies, so leaving this at zero would over-scale every
  // velocity-fed layer for the first half-minute. Warmth is carried across
  // too, or pressing Start would audibly dull a sound that was already open.
  let rich = UI.rich, bpm = Breath.bpmSmooth||0;
  if(Lead.on){
    const k = Lead.blend();
    rich = lerp(0.80, UI.rich, k);
    bpm  = lerp(Pace.bpm, Breath.bpmSmooth || Pace.bpm, k);
  }

  Audio.frame({
    level, vel, speed, inhaling:rising, resting,
    rich, bpm, dt
  });
  if(UI.state==='running') updateReadout();

  // live sample rate in the header: 0 Hz means no events are arriving at all
  UI.hzAcc += dt;
  if(UI.hzAcc >= 1){
    UI.hz = Math.round((Breath.samples - UI.lastSamples)/UI.hzAcc);
    UI.lastSamples = Breath.samples; UI.hzAcc = 0;
    // Settling is a phase of the session, not a fault, so it is reported where
    // the other live state is rather than in the cue — the cue is what someone
    // lying down with their eyes half shut reads, and it should stay calm.
    el.statusTag.textContent =
      (Breath.settled ? t('tag.listening', null, 'listening')
                      : t('tag.settling', null, 'settling')) +
      (UI.demo ? ' \u00b7 ' + t('tag.demo', null, 'demo') : ' \u00b7 ' + UI.hz + ' Hz');
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
                      hr:Pulse.reading(Breath.motionRms), hrConf:Pulse.conf,
                      rest:Breath.restGate});
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
  el.vRate.textContent = b ? nfmt(b, 1) : '—';
  const i=Breath.inhaleDur, o=Breath.exhaleDur;
  el.vRatio.textContent = (sure && i>0.4 && o>0.4) ? (nfmt(i,1)+' / '+nfmt(o,1)) : '—';
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

  // The row holds nothing but this hint now that the "You" key is gone, so it
  // gets out of the way when there is nothing to say.
  if(!(UI.badSince && (now - UI.badSince) > 8)){
    el.qualityTxt.textContent = '';
    el.traceKey.classList.add('hidden');
    return;
  }
  el.traceKey.classList.remove('hidden');
  // axisAmp is the size of the movement on the breath axis, in m/s^2. Real
  // sessions measure 0.3-0.5; too little means the phone is not picking the
  // breath up, too much means it is being handled rather than breathed on.
  el.qualityTxt.textContent = Breath.axisAmp < 0.05
    ? t('hint.lower', null, 'move the phone lower on your belly')
    : t('hint.still', null, 'lie still for a moment');
  el.qualityTxt.style.color = 'var(--sand)';
}

/* ---------- the home screen ----------
   One wave, washing up the sand and draining back, with the sound of it. The
   two are the same signal: `reach` below is the demo breath, and the audio
   engine is driven from the same number on the same frame — so the surf you
   hear is the water you are watching, by construction rather than by tuning.

   It advances over the inhale, hangs at the top, drains over the exhale and
   rests. That is a beach wash and it is also a breath, which is the whole
   idea: the home screen is the app, at rest.

   It stops the moment a session starts — there is nothing to look at with your
   eyes shut — and after a few minutes untouched, because a phone left on this
   screen should not play surf all afternoon. */
export const Shore = {
  // mute is the sound switch in the header, not a saved setting: the volume
  // slider is the setting. This is a way out of silence — and back into it —
  // for the visit you are in, because the sound is meant to start itself and
  // on some phones it does not.
  on:false, audio:false, armed:false, reduced:false, mute:false,
  phase:0, prev:null, wet:0.14, spray:[], last:0, until:0,

  BAND: 0.14,                  // the waterline when fully drained, as a fraction
  RUN:  0.70,                  // how much further it washes at full reach
  IDLE: 180,                   // seconds before it lets the screen go quiet

  start(){
    if(this.on) return;
    try{
      this.reduced = !!(window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }catch(e){ this.reduced = false; }
    this.on = true;
    this.phase = 0.55;         // drained and about to come in
    this.prev = null;
    this.wet = this.BAND;
    this.spray.length = 0;
    this.last = performance.now();
    this.until = this.last + this.IDLE*1000;
    this.wantAudio();
    requestAnimationFrame(t => this.frame(t));
  },

  /** The sound cannot start itself: a browser will not build an AudioContext
      without a gesture, and there is no way around that. So try, and if the
      context comes up suspended, take the first touch the page gets — which on
      a phone is moments away and needs no button. */
  /** `inGesture` is the caller saying it is already inside one — the header
      switch is, by construction, so it must not ask. */
  wantAudio(inGesture){
    if(this.audio || this.mute) return;
    // A context built before the page has ever been touched comes up suspended
    // and does not reliably come back — and the app was building one on load,
    // every time, which is why the home screen was silent until a session had
    // been run and torn its context down. Wait for the touch instead: on a
    // phone it is moments away, and a context built inside one starts running.
    if(!inGesture && !touched()){ this.armGesture(); return; }
    Audio.start().then(()=>{
      const live = Audio.ctx && Audio.ctx.state === 'running';
      if(live){
        this.audio = true;
        paintSoundBtn();
        Audio.setVolume(parseInt($('vol').value, 10)/100);
        Audio.fade(Audio.vol, 5.0);          // in over five seconds, from nothing
      }else{
        // It came up suspended anyway. Throw it away rather than keep trying to
        // resume it, so the next touch gets a fresh one.
        Audio.discard();
        this.armGesture();
      }
    }, ()=>this.armGesture());
  },

  armGesture(){
    if(this.armed) return;
    this.armed = true;
    const go = ()=>{
      document.removeEventListener('pointerdown', go, true);
      document.removeEventListener('keydown', go, true);
      this.armed = false;
      if(this.on) this.wantAudio();
    };
    document.addEventListener('pointerdown', go, true);
    document.addEventListener('keydown', go, true);
  },

  stop(keepAudio){
    if(!this.on) return;
    this.on = false;
    this.audio = false;
    if(!keepAudio) Audio.stop(1.6);
    paintSoundBtn();
  },

  /** The header switch. Off tears the context down rather than muting it, so
      nothing is left running behind a silent screen; on builds a fresh one,
      inside the tap, which is the one place a phone will let it start. */
  toggle(){
    if(this.audio){
      this.mute = true;
      this.audio = false;
      Audio.stop(0.8);
    }else{
      this.mute = false;
      if(!this.on) this.start();     // it may have gone quiet on its own
      this.wantAudio(true);
    }
    paintSoundBtn();
  },

  /** A touch anywhere wakes it again after it has let the screen go quiet. */
  poke(){
    if(UI.state !== 'idle') return;
    if(this.on){ this.until = performance.now() + this.IDLE*1000; return; }
    this.start();
  },

  frame(now){
    if(!this.on || UI.state !== 'idle'){ this.stop(); return; }
    if(now > this.until){ this.stop(); this.draw(0, 0); return; }

    const dt = clamp((now - this.last)/1000, 0.001, 0.1);
    this.last = now;

    const s = demoBreath(dt, this);
    const reach = this.BAND + this.RUN*(s+1)/2;
    const vel = this.prev === null ? 0 : (reach - this.prev)/dt;
    const rising = vel > 0;
    this.prev = reach;

    // The sand stays wet where the water got to, and dries slowly.
    this.wet = Math.max(reach, this.wet - dt*0.045);

    if(this.audio){
      // The same numbers a session sends, from the same breath: level is the
      // waterline, and velocity is how fast it is moving. The water runs RUN
      // of the strip over one stroke, so its peak is that much of Pace.vRef —
      // divide by it and the loudest the sound gets is the moment the water is
      // running fastest up the sand, at whatever rate the wave is set to.
      const v = clamp(vel/(Pace.vRef*this.RUN), -1, 1);
      Audio.frame({
        level: (s+1)/2, vel: v, speed: Math.abs(v),
        inhaling: rising, resting: Math.abs(vel) < 0.02,
        rich: 0.8, bpm: Pace.bpm, dt
      });
      // The crest, at the moment the water stops advancing — the same instant
      // the spray is thrown, because they are the same event.
      if(this.wasRising && !rising) Audio.bell(0.7);
    }
    this.wasRising = rising;

    this.step(dt, reach, vel);
    this.draw(reach, now/1000);
    if(!this.reduced) requestAnimationFrame(t => this.frame(t));
  },

  /** Spray: flung ahead of the edge while the water is running up the sand.
      Thrown forward and slowed by drag, not arced by gravity — the view is
      straight down at a shoreline, and there is no gravity in that plane.
      Capped, because this runs on a phone. */
  step(dt, reach, vel){
    const c = el.waves;
    const h = (c && c.getBoundingClientRect) ? (c.getBoundingClientRect().height || 160) : 160;
    const w = (c && c.getBoundingClientRect) ? (c.getBoundingClientRect().width  || 360) : 360;
    if(vel > 0.10 && this.spray.length < 120){
      const n = Math.min(3, Math.round(vel*10));
      for(let i=0;i<n;i++)
        // Launched at one and a half to three times the speed of the water
        // that threw them, or the edge simply outruns its own spray and the
        // drops trail behind on the wet side, which is not what spray is.
        this.spray.push({
          x: Math.random()*w, y: reach*h,
          vx: (Math.random()-0.5)*0.10*w,
          vy: vel*h*(1.5 + Math.random()*1.5),
          a: 1
        });
    }
    const drag = Math.exp(-dt/0.32);
    for(const p of this.spray){
      p.x += p.vx*dt; p.y += p.vy*dt;
      p.vx *= drag; p.vy *= drag;
      p.a -= dt*0.85;
    }
    // Filter in place rather than allocating a new array sixty times a second.
    let k = 0;
    for(const p of this.spray) if(p.a > 0) this.spray[k++] = p;
    this.spray.length = k;
  },

  draw(reach, t){
    const c = el.waves;
    if(!c || !c.getBoundingClientRect) return;
    const {ctx, w, h} = fitCanvas(c);
    ctx.clearRect(0, 0, w, h);
    if(!this.on) return;
    const P = palette();

    // Two sines, two and four cycles across the width. One at half that reads
    // as a ribbon — which is what the first version of this looked like.
    const edgeAt = (r, k, tt) =>
      r*h + Math.sin(k*11.0 + tt*0.9)*0.025*h + Math.sin(k*4.4 - tt*0.55)*0.045*h;

    const line = (r, tt) => {
      const path = new Path2D();
      for(let x = 0; x <= w; x += 5){
        const y = edgeAt(r, x/w, tt);
        x ? path.lineTo(x, y) : path.moveTo(x, y);
      }
      return path;
    };

    // The sea, as a gradient hanging above the waterline rather than a slab:
    // the edge is the thing worth looking at.
    const band = 0.35*h;
    const sea = new Path2D(line(reach, t));
    sea.lineTo(w, 0); sea.lineTo(0, 0); sea.closePath();
    const g = ctx.createLinearGradient(0, reach*h - band, 0, reach*h);
    g.addColorStop(0, alpha(P.deep, 0));
    g.addColorStop(0.72, alpha(P.deep, 0.45));
    g.addColorStop(1, alpha(P.glass, 0.24));
    ctx.fillStyle = g;
    ctx.fill(sea);

    // The wash before this one, still draining off the sand.
    if(this.wet > reach + 0.01){
      ctx.strokeStyle = alpha(P.foam, 0.13);
      ctx.lineWidth = 1;
      ctx.stroke(line(this.wet, t - 0.8));
    }

    ctx.strokeStyle = alpha(P.foam, 0.62);
    ctx.lineWidth = 1.4;
    ctx.lineJoin = 'round';
    ctx.stroke(line(reach, t));

    for(const p of this.spray){
      ctx.fillStyle = alpha(P.foam, clamp(p.a, 0, 1)*0.75);
      ctx.fillRect(p.x, p.y, 1.4, 1.4);
    }
  }
};

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
  // Hand the running context to the session rather than tearing it down and
  // building another one inside the same tap.
  Shore.stop(true);   // hand the running audio to the session
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
  notice(t('n.refind', null, 'Starting over'), t('n.refind.b', null, 'Breathe normally. It finds your breathing again in a few breaths.'), 4500);
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
  // Tenths of a breath a minute: this table is integers, and half a breath a
  // minute is a step you can hear. Lives on the home screen rather than in
  // Adjust, because it is set before lying down — but it is a row here like
  // everything else, or it would work and silently not be saved.
  ['pace',    'pace',        60,  v => { Pace.set(v/10); paintPace(); }],
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
export const Flags = { heard:false, dim:false, depthBreak:false, lead:true };

/* Pick-one controls. Neither a slider nor a switch, so a third table rather
   than a hand-wired exception — the point of the tables is that a control
   cannot be wired to its effect and forgotten by the thing that saves it. */
const CHOICES = [
  ['langPick', 'lang', () => pickLang(), LANGS, code => {
    setLang(code);
    applyLang();
    repaintLabels();
  }],
];

const TOGGLES = [
  // Demo mode is deliberately absent: it is a way to hear the sound without
  // lying down, and a phone that silently starts a fake session a week later
  // because the switch was left on is worse than setting it again.
  ['tglPulse',  'pulse',  on => {
    Pulse.enabled = on;
    if(on) Pulse.reset();
    el.cellHr.classList.toggle('hidden', !on);
  }],
  ['tglLead',   'lead',   on => { Flags.lead = on; }],
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
  },
  wake(){
    clearTimeout(this.timer);
    if(this.on){
      this.on = false;
      document.body.classList.remove('dimmed');
    }
    this.arm();
  }
};
// pointerdown rather than click: the screen should come back as the finger
// lands, not when it lifts.
document.addEventListener('pointerdown', ()=>{ Dim.wake(); Shore.poke(); }, true);

/** Read every control and hand back the object that goes to the store. */
function collectSettings(){
  const out = {};
  for(const [id, key] of SLIDERS) out[key] = parseInt($(id).value, 10);
  for(const [id, key] of TOGGLES) out[key] = $(id).getAttribute('aria-checked') === 'true';
  out.lang = getLang();
  return out;
}

/** Build the pick-one rows and wire them. */
function buildChoices(){
  for(const [id, key, , options, apply] of CHOICES){
    const host = $(id);
    host.textContent = '';
    for(const [code, label] of options){
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.value = code;
      b.textContent = label;
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', ()=>{
        apply(code);
        paintChoice(id);
        saveSettings();
      });
      host.appendChild(b);
    }
  }
}

function paintChoice(id){
  const row = CHOICES.find(c => c[0] === id);
  const now = row[2]();
  for(const b of $(id).querySelectorAll('button'))
    b.setAttribute('aria-pressed', String(b.dataset.value === now));
}

/* The labels the script owns rather than the markup: they change with state,
   so applyLang() cannot reach them. */
function repaintLabels(){
  el.main.textContent = t(UI.state === 'idle' ? 'btn.start' : 'btn.end',
                          null, UI.state === 'idle' ? 'Start' : 'End');
  paintPace();
  paintSoundBtn();
  Updater.paint();
  Review.repaint();
  Log.built = false;
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

// The sound switch in the header. Not in TOGGLES: it is not saved, and it is
// not an aria-checked switch row — it is a button whose label says what the
// next tap does.
el.soundBtn.addEventListener('click', ()=>Shore.toggle());

// Demo mode: wired by hand, since it is the one switch that is not saved.
$('tglDemo').addEventListener('click', function(){
  const on = this.getAttribute('aria-checked') !== 'true';
  this.setAttribute('aria-checked', String(on));
  UI.demo = on;
  if(on) notice(t('n.demo', null, 'Demo mode'), t('n.demo.b', null, 'Simulated breathing. Good for checking the sound without lying down.'), 5000);
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
  for(const [id, key, def] of SLIDERS)
    if(key !== 'volume' && key !== 'sensitivity' && key !== 'pace') setSlider(id, def);
  saveSettings();
  notice(t('n.soundreset', null, 'Sound reset'), t('n.soundreset.b', null, 'The seven sound controls are back where they started.'), 3500);
});

/** Restore what was saved. Anything missing keeps the slider's own default,
    so a settings row written by an older release cannot blank a new control. */
function applySettings(p){
  for(const [id, key] of SLIDERS) if(typeof p[key] === 'number') setSlider(id, p[key]);
  for(const [id, key] of TOGGLES) if(typeof p[key] === 'boolean') setToggle(id, p[key]);
  // Language before anything else that draws text: the phone's own language
  // when nothing is saved, so a German phone opens in German.
  setLang(pickLang(p.lang));
  applyLang();
  buildChoices();
  paintChoice('langPick');
  repaintLabels();
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
    this.setAttribute('data-armed','true'); this.textContent = t('adj.clear.again', null, 'Tap again');
    setTimeout(()=>{ this.setAttribute('data-armed','false'); this.textContent = t('adj.clear.btn', null, 'Delete all'); }, 4000);
    return;
  }
  this.setAttribute('data-armed','false'); this.textContent = t('adj.clear.btn', null, 'Delete all');
  Store.clear().then(()=>{
    notice(t('n.deleted', null, 'Recordings deleted'), t('n.deleted.b', null, 'Every recording is gone from this phone.'), 4000);
    Review.refreshCount(); refreshStorageRow();
  });
});
Review.onDone = toIntro;
// No user gesture is needed for IndexedDB, so this stays well away from the tap
// handler. Settings come back before the first tap, which is the whole point.
Store.open()
  .then(()=>Store.readPrefs())
  .then(p=>{ applySettings(p); Review.refreshCount(); refreshStorageRow(); });

Shore.start();
Updater.start();

// secure-context check up front — requestPermission simply will not fire otherwise
if(!window.isSecureContext && location.hostname!=='localhost'){
  notice(t('n.insecure', null, 'Not a secure page'), t('n.insecure.b', null, 'Motion sensors need HTTPS. Open this page over https:// and it will work.'), 0);
}
