import { $, clamp, notice, fitCanvas, palette } from './util.js';
import { t, n as nfmt } from './i18n.js';
import { Store } from './store.js';
import { HR } from './hr.js';

/* ============================================================
   5. REVIEW UI
   ------------------------------------------------------------
   Two screens sharing one overlay:

     info      one session: the graph, what it measured, and
               the two things you can do with it
     list      every recording this phone is still holding

   There were three. `summary` (where End landed) and `detail`
   (scrub and label) were the same session shown twice, and the
   split only existed to give the labelling step somewhere to
   live. Labelling is gone — recognition got good enough that
   marking the usable stretch by hand stopped earning its
   keep — so the two collapsed into one. End lands here and a
   row in the list opens here; `from` is the only difference,
   and all it decides is where Back goes.

   Inert until show*() runs. No DOM lookups at definition time,
   the same rule Audio follows.

   ---- why the session screen has two lanes ----
   A twelve-minute session drawn across a 357 px phone canvas is
   2 s per pixel, and a thumb covers about 40 px of it — 80 s of
   blur. "Mark the moment I lay down" is simply not expressible
   on one full-width lane, so the detail screen stacks two:

     overview   the whole session; tap or drag to jump near.
                It also carries the rate line, which is the one
                thing a waveform cannot show at this zoom and
                which the old summary drew on a canvas of its own
     fine       a window of `span` seconds dragged past a
                playhead pinned to the centre of the lane, with
                the heart rate over it

   Pinning the playhead to the centre is the part that makes it
   work one-handed: the instant you are aiming at is never the
   pixel under your finger. At the 8 s span that is 22 ms per
   pixel, about a thousand times finer than one lane, and the
   half-second steppers cover the case where a steady drag is
   not available.
   ============================================================ */
export const Review = {
  onDone:null,                 // app wires this: return to the intro screen
  note:'',                     // one line the app adds to this summary's flags

  screen:null,                 // null | 'info' | 'list'
  session:null,                // the full session object on screen
  from:'list',                 // 'summary' when End opened this, else 'list'
  metas:[],                    // last Store.list() result
  confirmId:null,              // list row currently asking "delete this?"

  /** scrub state for the session screen */
  det:{ dur:0, play:0, span:30, drag:null, pinch:null },

  /** Heart rate, recovered from the stored motion after the fact — see
      src/hr.js. `job` is the cancellation flag for the pass in flight: opening
      another recording while one is still running must not let the first one
      finish into the second one's screen. */
  hr:null,
  hrJob:null,

  /** projected signal unpacked from derived.rows, built once per session */
  sig:{ n:0 },

  /* fine-lane widths. 0 means "the whole recording". 8 s is the
     finest useful step: below that a breath no longer fits on screen. */
  SPANS:[[0,'Whole'],[120,'2 min'],[30,'30 s'],[8,'8 s']],

  /* seconds. Under this a session gets a Discard button on its summary. Half a
     minute is about one slow breath plus the settling either side of it, so
     there is nothing in a recording this short worth keeping. */
  DISCARD_UNDER: 30,

  /* ---------- lazy DOM + palette ---------- */

  dom(){
    if(this._dom) return this._dom;
    const d = this._dom = {
      root:$('review'), title:$('revTitle'), tag:$('revTag'), back:$('revBack'),
      scr:{ info:$('revInfo'), list:$('revList') },
      // Only the list has a bottom bar. The session screen's actions are meant
      // to be found, not offered: Export is one of two quiet rows under the
      // numbers rather than the button your thumb rests on.
      bar:{ list:$('revListBar') },
      grid:$('revGrid'), flag:$('revFlag'), cap:$('revCap'),
      rows:$('revRows'), listEmpty:$('revListEmpty'), listFoot:$('revListFoot'),
      over:$('revOver'), fine:$('revFine'),
      exportBtn:$('revExport'), deleteBtn:$('revDelete')
    };
    this.wire();
    return d;
  },

  /** Redraw whatever is on screen in the current language. Only the strings
      this module writes itself need it; the markup is handled by i18n.apply. */
  repaint(){
    if(!this._dom) return;
    if(this.screen === 'info'){ this._dom.title.textContent = this.infoTitle(); this.renderInfo(); }
    else if(this.screen === 'list'){ this._dom.title.textContent = t('rev.recordings', null, 'Recordings'); this.renderList(); }
    this.refreshCount();
  },

  /** canvas colours live in :root like every other colour in the app */
  ink(){
    if(this._ink) return this._ink;
    const P = palette();
    return this._ink = {you:P.glass, pace:P.sand, mute:P.mute,
                        foam:P.foam, deep:P.deep, abyss:P.abyss, beat:P.ember};
  },

  wire(){
    if(this._wired) return; this._wired = true;
    const d = this._dom;

    d.back.addEventListener('click', ()=>this.back());
    d.exportBtn.addEventListener('click', ()=>this.exportOne(this.session));
    d.deleteBtn.addEventListener('click', ()=>this.remove());
    $('revExportAll').addEventListener('click', ()=>this.exportAll());

    this.bindLane(d.over, 'over');
    this.bindLane(d.fine, 'fine');

    window.addEventListener('resize', ()=>{ if(this.screen) this.redraw(); });
  },

  /* ---------- screen switching ---------- */

  show(name){
    const d = this.dom();
    this.screen = name;
    d.root.classList.remove('hidden');
    for(const k in d.scr) d.scr[k].classList.toggle('hidden', k!==name);
    for(const k in d.bar) d.bar[k].classList.toggle('hidden', k!==name);
    // Back is shown on every screen, the summary included. It used to be hidden
    // here because the summary's bottom bar carried a Done button that did the
    // same job; Done is gone, so hiding Back left the summary with no exit.
    d.root.scrollTop = 0;
    const sc = d.root.querySelector('.rev-scroll');
    if(sc) sc.scrollTop = 0;
    d.title.focus();
  },

  hide(){
    if(!this._dom) return;
    this.cancelHr();
    this._dom.root.classList.add('hidden');
    this.screen = null;
    this.confirmId = null;
  },

  /** The only way out of any review screen. A session opened from the list
      steps back to the list; the one End landed on closes, and closing it is
      what returns the app to the intro. */
  back(){
    if(this.screen==='info' && this.from==='list'){ this.showList(); return; }
    const wasSession = this.screen === 'info';
    this.hide();
    if(wasSession && this.onDone) this.onDone();
  },

  /* ---------- 1. one session ---------- */

  /** End lands here with the session it has just finished; a row in the list
      lands here with one read back off the phone. The screen is the same
      either way — `from` only decides the title, whether the date is shown,
      and where Back and a delete go. */
  showInfo(session, from){
    const d = this.dom();
    this.cancelHr();
    this.hr = null;
    this.session = session || null;
    this.from = from || this.from;
    d.title.textContent = this.infoTitle();
    // The date belongs on a recording you went looking for, not on the one you
    // just put down: you know when that was, and the phone already puts a
    // clock at the top of the screen.
    d.tag.textContent = (this.from === 'list' && session) ? this.when(session.startedAt) : '';
    this.show('info');
    if(!session){
      d.flag.textContent = t('rev.none', null, 'Nothing was recorded, so there is nothing to show here.');
      d.flag.classList.remove('hidden');
      d.grid.textContent = '';
      d.cap.classList.add('hidden');
      d.exportBtn.classList.add('hidden');
      d.deleteBtn.classList.add('hidden');
      return;
    }
    d.cap.classList.remove('hidden');
    d.exportBtn.classList.remove('hidden');
    d.deleteBtn.classList.remove('hidden');
    d.deleteBtn.dataset.armed = '0';
    d.deleteBtn.textContent = t('rev.delete', null, 'Delete this recording');
    this.prepare(session);
    this.det.play = 0;
    // Two breaths at the slowest rate the app follows is a minute and a half.
    this.det.span = this.det.dur > 180 ? 90 : Math.max(this.det.dur, 1);
    this.renderInfo();
    this.redraw();
    this.startHr();
  },

  infoTitle(){
    return this.from === 'list'
      ? t('rev.recording', null, 'Recording')
      : t('rev.session', null, 'This session');
  },

  /* ---------- the heart rate, recovered afterwards ----------
     Pulse is an experiment and is off by default, so hr/hrConf are empty in
     effectively every recording that exists. The raw motion is not, and that
     is all the estimator needs — so the number is recovered here rather than
     only being available to sessions that happened to have the switch on.
     See src/hr.js, and CLAUDE.md 4a2 for what the number is and is not. */

  async startHr(){
    const s = this.session;
    if(!s || !s.id) return;
    const job = this.hrJob = {cancelled:false};
    let rows = (s.motion && s.motion.rows) || null;
    // Both ways in fetch the session without its motion channel, because the
    // screen draws from `derived` at 10 Hz and materialising 48 000 rows to do
    // that is a pause nobody asked for. The heart rate wants exactly those
    // rows, so they are read here — once, after the screen is already up and
    // the graph is already on it.
    if((!rows || !rows.length) && typeof Store !== 'undefined' && Store.available !== false){
      try{
        const full = await Store.get(s.id, {derived:false});
        rows = (full && full.motion && full.motion.rows) || null;
      }catch(err){ rows = null; }
    }
    if(job.cancelled || this.hrJob !== job) return;
    if(!rows || rows.length < 2){ this.hr = {n:0}; this.renderInfo(); return; }
    let est = null;
    try{ est = await HR.estimate(rows, {signal:job}); }
    catch(err){ est = null; }
    if(job.cancelled || this.hrJob !== job) return;
    this.hr = est || {n:0};
    this.renderInfo();
    this.redraw();
  },

  /** Opening another recording while a pass is still running must not let the
      first one finish into the second one's screen. */
  cancelHr(){
    if(this.hrJob) this.hrJob.cancelled = true;
    this.hrJob = null;
  },

  renderInfo(){
    const d = this._dom, s = this.session, sum = (s && s.summary) || {};
    if(!s) return;
    const dur = this.det.dur;
    const cell = (k, v, small)=>{
      const c = this.h('div','cell');
      c.appendChild(this.h('div','k',k));
      const val = this.h('div','v', v);
      if(small) val.appendChild(this.h('small',null,' '+small));
      c.appendChild(val);
      return c;
    };
    const bpm = v => (v>0 && isFinite(v)) ? nfmt(v, 1) : '\u2014';

    const q = (sum.meanQuality!=null) ? sum.meanQuality : this.meanOf('q');
    // Recordings made before these were summarised fall back to the signal.
    const rate = this.rateStats(sum);

    const g = d.grid;
    g.textContent = '';
    const min = t('unit.min', null, '/min');
    g.appendChild(cell(t('rev.length', null, 'Length'), this.clock(dur)));
    g.appendChild(cell(t('rev.breaths', null, 'Breaths'), (sum.breaths!=null && sum.breaths>0) ? String(sum.breaths) : '\u2014'));
    g.appendChild(cell(t('rev.avg', null, 'Average rate'), bpm(rate.avg), min));
    g.appendChild(cell(t('rev.slowest', null, 'Slowest'), bpm(rate.min), min));
    g.appendChild(cell(t('rev.fastest', null, 'Fastest'), bpm(rate.max), min));

    // Two more measurements, not two more verdicts. In and out are the halves
    // the live readout shows, averaged; held is how much of the session the app
    // read as a pause rather than a stroke, which for slow breathing is most of
    // what distinguishes one session from another.
    const inS = sum.meanInhaleSec, outS = sum.meanExhaleSec;
    g.appendChild(cell(t('rev.inout', null, 'In / out'),
      (inS > 0 && outS > 0) ? nfmt(inS,1) + ' / ' + nfmt(outS,1) : '\u2014', 's'));
    g.appendChild(cell(t('rev.held', null, 'Held still'),
      (sum.heldFraction != null && this.sig.n) ? Math.round(sum.heldFraction*100) + '%' : '\u2014'));

    // The longest single pause. At three breaths a minute the interesting
    // thing about a session is not the average of anything, it is how long the
    // bottom of a breath was allowed to last.
    const hold = this.longestHold();
    g.appendChild(cell(t('rev.longhold', null, 'Longest hold'),
      hold > 0 ? nfmt(hold, 1) : '\u2014', 's'));

    // Heart rate last, because it is the least sure of itself: an estimate
    // from the same accelerometer, never checked against a real pulse, and
    // labelled as an estimate wherever it appears.
    const hs = this.hr ? HR.summary(this.hr) : null;
    g.appendChild(cell(t('rev.hr', null, 'Heart rate'),
      hs ? (hs.bpm > 0 ? String(Math.round(hs.bpm)) : '\u2014') : '\u2026',
      hs && hs.bpm > 0 ? t('rev.hr.est', null, 'est /min') : ''));

    // Facts about the recording, not about the person. A failed calibration
    // or a noisy signal changes how much the numbers above are worth, so say so.
    const flags = [];
    if(rate.avg === 0)
      flags.push(t('rev.noflag.rate', null, 'This recording never settled into a rhythm the app could read, so no rate is given.'));
    else if(q > 0 && q < 0.4)
      flags.push(t('rev.noflag.q', null, 'The signal was noisy for most of this session. The rates above are approximate.'));
    if(!this.sig.n)
      flags.push(t('rev.noflag.sig', null, 'This recording has no waveform stored, so the trace is empty.'));
    if(hs && hs.of > 0 && hs.bpm <= 0)
      flags.push(t('rev.noflag.hr', null, 'No heartbeat could be picked out of this recording.'));
    // Something the app changed because of this session, set by whoever changed
    // it. It goes here rather than in a toast because this is where you are
    // looking, and because a toast at the end of a session has to queue behind
    // an update announcement.
    if(this.note) flags.push(this.note);
    d.flag.textContent = flags.join(' ');
    d.flag.classList.toggle('hidden', !flags.length);
  },

  /** Longest run the app read as held, in seconds. */
  longestHold(){
    const S = this.sig;
    if(!S.n || !S.hasRest) return 0;
    let best = 0, from = -1;
    for(let i=0;i<=S.n;i++){
      const on = i<S.n && S.g[i] < 0.5;
      if(on && from<0) from = i;
      else if(!on && from>=0){ best = Math.max(best, S.t[i-1]-S.t[from]); from = -1; }
    }
    return best;
  },

  /** Rate min/avg/max, from the stored summary when it has them and from the
      recorded rate channel when it does not. Zeros are excluded throughout: a
      zero means no cycle had been timed yet, not a rate of zero. */
  rateStats(sum){
    if(sum && sum.minBpm > 0 && sum.maxBpm > 0)
      return {min:sum.minBpm, avg:sum.meanBpm, max:sum.maxBpm};
    const S = this.sig;
    let lo=Infinity, hi=0, tot=0, k=0;
    for(let i=0;i<S.n;i++){
      const v = S.b[i];
      if(v > 0){ if(v<lo) lo=v; if(v>hi) hi=v; tot+=v; k++; }
    }
    if(!k) return {min:0, avg:(sum && sum.meanBpm) || 0, max:0};
    return {min:lo, avg:tot/k, max:hi};
  },

  /* ---------- 2. recordings ---------- */

  async showList(){
    const d = this.dom();
    d.title.textContent = t('rev.recordings', null, 'Recordings');
    d.tag.textContent = '';
    this.from = 'list';
    this.show('list');
    d.rows.textContent = '';
    d.listEmpty.classList.add('hidden');
    d.listFoot.textContent = '';

    if(typeof Store === 'undefined' || Store.available === false){
      this.listMessage('Storage is not available',
        'This browser is blocking local storage, so sessions cannot be kept between visits. ' +
        'A session you have just finished still shows on the summary screen, and you can export it from there before you leave it.');
      return;
    }
    try{
      await Store.open();
      this.metas = await Store.list();
    }catch(err){
      this.listMessage('Recordings could not be read',
        ((err && err.name) || 'The store failed to open') + '. Close other tabs of this page and open Recordings again.');
      return;
    }
    this.renderList();
  },

  listMessage(head, body){
    const d = this._dom;
    d.listEmpty.textContent = '';
    d.listEmpty.appendChild(this.h('h3',null,head));
    d.listEmpty.appendChild(this.h('p',null,body));
    d.listEmpty.classList.remove('hidden');
    $('revExportAll').disabled = true;
  },

  renderList(){
    const d = this._dom, list = this.metas || [];
    d.rows.textContent = '';
    if(!list.length){
      this.listMessage('No recordings yet',
        'Every session you run is kept here on the phone. Finish one and it will appear in this list.');
      return;
    }
    d.listEmpty.classList.add('hidden');
    $('revExportAll').disabled = false;

    let bytes = 0;
    list.forEach(m=>{
      bytes += this.metaBytes(m);
      const row = this.h('div','rec');
      const open = this.h('button','rec-open');
      open.type = 'button';
      const top = this.h('span','rec-top');
      top.appendChild(this.h('span','rec-when', this.when(m.startedAt)));
      top.appendChild(this.h('span','rec-len',  this.clock(m.durationSec||0)));
      const sub = this.h('span','rec-sub');
      const mean = this.metaBpm(m);
      sub.textContent = [
        mean>0 ? nfmt(mean,1)+' '+t('unit.min', null, '/min') : t('rev.rateunknown', null, 'rate unknown'),
        this.bytes(this.metaBytes(m))
      ].join(' · ');
      open.appendChild(top); open.appendChild(sub);
      open.addEventListener('click', ()=>this.openRecording(m.id));
      row.appendChild(open);

      if(this.confirmId === m.id){
        const ask = this.h('div','rec-ask');
        ask.appendChild(this.h('span','rec-ask-q','Delete this recording?'));
        const yes = this.h('button','danger','Delete'); yes.type='button';
        const no  = this.h('button','ghost','Keep');   no.type='button';
        yes.addEventListener('click', ()=>this.removeRecording(m.id));
        no.addEventListener('click', ()=>{ this.confirmId=null; this.renderList(); });
        ask.appendChild(yes); ask.appendChild(no);
        row.appendChild(ask);
      }else{
        const del = this.h('button','rec-del','Delete');
        del.type = 'button';
        del.setAttribute('aria-label','Delete the recording from '+this.when(m.startedAt));
        del.addEventListener('click', ()=>{ this.confirmId=m.id; this.renderList(); });
        row.appendChild(del);
      }
      d.rows.appendChild(row);
    });

    d.listFoot.textContent = list.length + (list.length===1?' recording':' recordings') +
      ' · ' + this.bytes(bytes) + ' on this phone';
    if(typeof Store !== 'undefined' && Store.usage){
      Store.usage().then(u=>{
        if(this.screen!=='list' || !u) return;
        d.listFoot.textContent = u.count + (u.count===1?' recording':' recordings') +
          ' · ' + this.bytes(u.bytes) + ' on this phone';
      }, ()=>{});
    }
  },

  async removeRecording(id){
    this.confirmId = null;
    try{ await Store.delete(id); }
    catch(err){
      notice('Could not delete', ((err && err.name)||'The store refused the delete') + '. Open Recordings again and retry.', 6000);
      return;
    }
    this.metas = (this.metas||[]).filter(m=>m.id!==id);
    if(this.session && this.session.id===id) this.session = null;
    this.renderList();
  },

  /* ---------- opening one from the list ---------- */

  async openRecording(id){
    const d = this.dom();
    let session = (this.session && this.session.id===id) ? this.session : null;
    if(!session && typeof Store !== 'undefined' && Store.available !== false){
      // Without its motion channel, for the same reason End reads it that way:
      // the graph is drawn from `derived`. startHr() fetches the raw rows on
      // its own once the screen is up.
      try{ await Store.open(); session = await Store.get(id, {motion:false}); }catch(err){ session = null; }
    }
    if(!session){
      notice(t('n.norec', null, 'Recording not found'),
             'That recording is no longer on this phone. Open Recordings for the ones that are.', 6000);
      this.showList(); return;
    }
    this.showInfo(session, 'list');
  },

  /* ---------- session unpacking ---------- */

  cols(block){
    const m = {};
    ((block && block.columns) || []).forEach((c,i)=>{ m[c]=i; });
    return m;
  },

  /** derived.rows -> typed arrays, so redraws never re-walk the JSON */
  prepare(session){
    const dv = session.derived || {}, rows = dv.rows || [], ci = this.cols(dv);
    const n = rows.length;
    const t=new Float32Array(n), s=new Float32Array(n),
          b=new Float32Array(n), q=new Float32Array(n), g=new Float32Array(n);
    // Recordings made before the guide tone was removed still carry pacerLevel
    // and pacerBpm. They are ignored: the pacer is gone from the product, so
    // drawing its line would explain nothing to anyone looking at a session now.
    const hasQ = ci.quality!=null;
    // Recordings made before the rest gate was stored have no rest column, and
    // the reader must not invent one: a missing channel reads as 1, which is
    // "moving", so an older recording simply shows no held stretches rather
    // than showing the whole session as held.
    const hasG = ci.rest!=null;
    for(let i=0;i<n;i++){
      const r = rows[i] || [];
      t[i] = +r[ci.t] || 0;
      s[i] = +r[ci.s] || 0;
      b[i] = +r[ci.bpm] || 0;
      q[i] = hasQ ? (+r[ci.quality]||0) : 0;
      g[i] = hasG ? (+r[ci.rest]||0) : 1;
    }
    this.sig = { n, t, s, b, q, g, hasRest: hasG };
    this.det.dur = session.durationSec || (n ? t[n-1] : 0);
    this.det.play = clamp(this.det.play, 0, this.det.dur);
    if(!(this.det.span>0)) this.det.span = this.det.dur || 30;
    return this.sig;
  },

  calEnd(){
    const c = this.session && this.session.calibration;
    return (c && c.endSec>0) ? c.endSec : 0;
  },

  idxAt(t){
    const a = this.sig.t, n = this.sig.n;
    if(!n) return -1;
    if(t<=a[0]) return 0;
    if(t>=a[n-1]) return n-1;
    let lo=0, hi=n-1;
    while(hi-lo>1){ const m=(lo+hi)>>1; if(a[m]<=t) lo=m; else hi=m; }
    return (t-a[lo] <= a[hi]-t) ? lo : hi;
  },

  /** mean of the measured rate over a time window; ignores rows with no estimate yet */
  meanOf(key){
    const S=this.sig, a=S[key]; if(!S.n || !a) return 0;
    let sum=0; for(let i=0;i<S.n;i++) sum+=a[i];
    return sum/S.n;
  },

  /* ---------- drawing ---------- */

  redraw(){
    if(this.screen==='info'){ this.drawOverview(); this.drawFine(); this.readout(); }
  },

  ground(ctx,w,h){
    ctx.clearRect(0,0,w,h);
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = this.ink().deep;
    ctx.fillRect(0,0,w,h);
    ctx.globalAlpha = 1;
  },

  yOf(v,h,pad){ return h/2 - clamp(v,-1.6,1.6)*(h/2-pad)/1.6; },

  /** min/max per pixel column: at whole-session zoom a polyline aliases
      individual breaths away, an envelope keeps their depth visible */
  band(ctx,w,h,t0,t1,key,pad){
    const S=this.sig; if(S.n<2) return;
    const a = S[key];
    const top=[], bot=[];
    for(let x=0;x<=w;x++){
      const ta = t0 + (t1-t0)*(x/w), tb = t0 + (t1-t0)*((x+1)/w);
      if(tb < S.t[0] || ta > S.t[S.n-1]){ top.push(null); bot.push(null); continue; }
      let i0=this.idxAt(ta), i1=this.idxAt(tb);
      if(i1<i0) i1=i0;
      let mn=Infinity, mx=-Infinity;
      for(let i=i0;i<=i1;i++){ if(a[i]<mn) mn=a[i]; if(a[i]>mx) mx=a[i]; }
      top.push(this.yOf(mx,h,pad)); bot.push(this.yOf(mn,h,pad));
    }
    ctx.beginPath();
    let open=false;
    for(let x=0;x<top.length;x++){
      if(top[x]==null){ open=false; continue; }
      if(!open){ ctx.moveTo(x,top[x]); open=true; } else ctx.lineTo(x,top[x]);
    }
    for(let x=top.length-1;x>=0;x--){ if(bot[x]!=null) ctx.lineTo(x,bot[x]); }
    ctx.closePath();
    ctx.fill();
  },

  poly(ctx,w,h,t0,t1,key,pad){
    const S=this.sig; if(S.n<2) return;
    const a = S[key];
    let i0 = Math.max(0, this.idxAt(t0)-1), i1 = Math.min(S.n-1, this.idxAt(t1)+1);
    ctx.beginPath();
    let started=false;
    for(let i=i0;i<=i1;i++){
      const x = (S.t[i]-t0)/(t1-t0)*w;
      const y = this.yOf(a[i],h,pad);
      started ? ctx.lineTo(x,y) : (ctx.moveTo(x,y), started=true);
    }
    ctx.lineJoin='round'; ctx.lineCap='round';
    ctx.stroke();
  },

  /** breaths-per-minute curve on its own vertical scale */
  rateLine(ctx,w,h,t0,t1,key,lo,hi,pad){
    const S=this.sig; if(S.n<2) return;
    const a = S[key];
    ctx.beginPath();
    let started=false;
    for(let i=0;i<S.n;i++){
      const v=a[i];
      if(!(v>0)){ started=false; continue; }
      const x = (S.t[i]-t0)/(t1-t0)*w;
      const y = h-pad - (clamp(v,lo,hi)-lo)/(hi-lo)*(h-pad*2);
      started ? ctx.lineTo(x,y) : (ctx.moveTo(x,y), started=true);
    }
    ctx.lineJoin='round'; ctx.lineCap='round';
    ctx.stroke();
  },

  rateRange(){
    const S=this.sig; let lo=Infinity, hi=-Infinity;
    for(let i=0;i<S.n;i++){
      if(S.b[i]>0){ if(S.b[i]<lo) lo=S.b[i]; if(S.b[i]>hi) hi=S.b[i]; }
    }
    if(!isFinite(lo) || !isFinite(hi)) return null;
    lo = Math.floor(lo-0.6); hi = Math.ceil(hi+0.6);
    if(hi-lo < 3) hi = lo+3;
    return {lo,hi};
  },

  drawOverview(){
    const {ctx,w,h} = fitCanvas(this._dom.over);
    const K = this.ink(), pad = 5;
    this.ground(ctx,w,h);
    const t0=0, t1=Math.max(this.det.dur,1);
    if(this.sig.n){
      // The whole session at once is where the pattern of holds is legible —
      // a long flat bottom every twenty seconds looks like nothing on the fine
      // lane and like a rhythm from here.
      this.held(ctx,w,h,t0,t1);
      ctx.fillStyle = K.you; ctx.globalAlpha = 0.34;
      this.band(ctx,w,h,t0,t1,'s',pad);
      ctx.globalAlpha = 1;
      // The rate over the whole session, which is the one thing a waveform
      // cannot show at this zoom — a session that starts at six a minute and
      // ends at two looks the same either end. The old summary drew this on a
      // canvas of its own; the strip that navigates the session is a better
      // place for the shape of it than a second picture above it was.
      const R = this.rateRange();
      if(R){
        ctx.strokeStyle = K.you; ctx.lineWidth = 1.6; ctx.globalAlpha = .9;
        this.rateLine(ctx,w,h,t0,t1,'b',R.lo,R.hi,pad);
        ctx.globalAlpha = 1;
      }
    }
    // the slice the fine lane is showing
    const win = this.fineWindow();
    const xa = (win.t0-t0)/(t1-t0)*w, xb = (win.t1-t0)/(t1-t0)*w;
    ctx.fillStyle = K.foam; ctx.globalAlpha=.08;
    ctx.fillRect(xa,0,Math.max(xb-xa,2),h);
    ctx.globalAlpha=.45; ctx.strokeStyle=K.foam; ctx.lineWidth=1;
    ctx.strokeRect(xa+0.5,0.5,Math.max(xb-xa-1,1),h-1);
    ctx.globalAlpha=1;
    this.playMark(ctx,w,h,(this.det.play-t0)/(t1-t0)*w,false);
  },

  drawFine(){
    const {ctx,w,h} = fitCanvas(this._dom.fine);
    const K = this.ink(), pad = 10;
    this.ground(ctx,w,h);
    const win = this.fineWindow(), t0=win.t0, t1=win.t1;

    // out-of-recording shading, so the ends of the session are obvious
    ctx.fillStyle = K.abyss; ctx.globalAlpha=.72;
    if(t0<0) ctx.fillRect(0,0,(0-t0)/(t1-t0)*w,h);
    if(t1>this.det.dur) ctx.fillRect((this.det.dur-t0)/(t1-t0)*w,0,w,h);
    ctx.globalAlpha=1;

    // seconds grid
    const stepFor = sp => sp<=10?1 : sp<=30?5 : sp<=120?10 : sp<=420?30 : 60;
    const step = stepFor(t1-t0);
    ctx.strokeStyle=K.mute; ctx.fillStyle=K.mute;
    ctx.font='9px ui-monospace, monospace'; ctx.textAlign='center';
    const px = (this.det.play-t0)/(t1-t0)*w;
    for(let s=Math.ceil(t0/step)*step; s<=t1; s+=step){
      const x=(s-t0)/(t1-t0)*w;
      ctx.globalAlpha=.16; ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h-12); ctx.stroke();
      if(s<0 || s>this.det.dur) continue;
      if(x<16 || x>w-17 || Math.abs(x-px)<20) continue;
      ctx.globalAlpha=.5;  ctx.fillText(this.clock(s), x, h-3);
    }
    ctx.globalAlpha=1; ctx.textAlign='start';

    ctx.strokeStyle=K.mute; ctx.globalAlpha=.2; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,this.yOf(0,h,pad)); ctx.lineTo(w,this.yOf(0,h,pad)); ctx.stroke();
    ctx.globalAlpha=1;

    if(this.sig.n){
      this.held(ctx,w,h,t0,t1);
      ctx.strokeStyle=K.you; ctx.lineWidth=1.9;
      this.poly(ctx,w,h,t0,t1,'s',pad);
    }
    this.hrLine(ctx,w,h,t0,t1,pad);
    this.playMark(ctx,w,h,(this.det.play-t0)/(t1-t0)*w,true);
  },

  /** The heartbeat, over the breath and on its own scale.

      No gutter is reserved for that scale. The lane's full width is the time
      axis, and bindLane/timeAtX map a finger straight onto it; narrowing the
      plot to make room would put every pinch and drag a few pixels out. So the
      two bounds are written at the right edge, over the plot, and the line
      keeps the whole width.

      The line breaks wherever the estimator declined — under MIN_CONF, or the
      body moving too much to read through. A heart rate drawn straight through
      a gap it did not measure is the one thing CLAUDE.md 4a2 says not to do,
      because it makes the number look far steadier than it is. */
  hrLine(ctx,w,h,t0,t1,pad){
    const H = this.hr;
    if(!H || !H.n) return;
    const K = this.ink();

    let lo = Infinity, hi = -Infinity;
    for(let i=0;i<H.n;i++){
      if(H.bpm[i] <= 0 || H.conf[i] < HR.MIN_CONF) continue;
      if(H.bpm[i] < lo) lo = H.bpm[i];
      if(H.bpm[i] > hi) hi = H.bpm[i];
    }
    if(!isFinite(lo) || !isFinite(hi)) return;
    // Round out to whole fives and keep a floor under the span, so a steady
    // session does not get its noise magnified into a mountain range.
    lo = Math.floor(lo/5)*5; hi = Math.ceil(hi/5)*5;
    if(hi - lo < 15){ const mid = (hi+lo)/2; lo = Math.round(mid-7.5); hi = lo+15; }

    const yOf = v => (h-pad) - (v-lo)/(hi-lo)*(h-pad*2);

    // Only the points in view, plus one either side so the line runs off the
    // edges rather than stopping at them. Zoomed into two minutes of a
    // thirteen-minute session this is 120 points instead of 795, and the path
    // spans the lane instead of x -721..1798 — it is clipped either way, but a
    // path built out of mostly off-screen points is rebuilt on every pan.
    const margin = HR.STEP * 1.5;
    let i0 = 0, i1 = H.n - 1;
    while(i0 < i1 && H.t[i0+1] < t0 - margin) i0++;
    while(i1 > i0 && H.t[i1-1] > t1 + margin) i1--;

    ctx.strokeStyle = K.beat; ctx.lineWidth = 1.5; ctx.globalAlpha = .85;
    ctx.beginPath();
    let down = true;
    for(let i=i0;i<=i1;i++){
      const ok = H.bpm[i] > 0 && H.conf[i] >= HR.MIN_CONF;
      if(!ok){ down = true; continue; }
      const x = (H.t[i]-t0)/(t1-t0)*w, y = yOf(H.bpm[i]);
      if(down){ ctx.moveTo(x,y); down = false; } else ctx.lineTo(x,y);
    }
    ctx.stroke();

    ctx.fillStyle = K.beat; ctx.globalAlpha = .7;
    ctx.font = '9px ui-monospace, monospace'; ctx.textAlign = 'end';
    ctx.fillText(String(hi), w-3, yOf(hi)+8);
    ctx.fillText(String(lo), w-3, yOf(lo)-3);
    ctx.globalAlpha = 1; ctx.textAlign = 'start';
  },

  /** Shade the stretches the app read as held rather than moving. This is the
      one thing a waveform alone cannot tell you: whether the app agreed with
      your body about where a breath stopped. Same threshold as the summary and
      as tools/onset.mjs, so all three mean the same thing by "held". */
  held(ctx,w,h,t0,t1){
    const S = this.sig;
    if(!S.hasRest) return;
    ctx.fillStyle = this.ink().pace; ctx.globalAlpha = .13;
    let from = -1;
    for(let i=0;i<=S.n;i++){
      const on = i<S.n && S.g[i] < 0.5;
      if(on && from<0) from = i;
      else if(!on && from>=0){
        const xa = (S.t[from]-t0)/(t1-t0)*w, xb = (S.t[i-1]-t0)/(t1-t0)*w;
        if(xb > 0 && xa < w) ctx.fillRect(xa, 0, Math.max(xb-xa, 1), h);
        from = -1;
      }
    }
    ctx.globalAlpha = 1;
  },

  /** the pending label position: a pin, not a cursor, so it reads as "here" */
  playMark(ctx,w,h,x,tall){
    const K=this.ink();
    ctx.strokeStyle=K.pace; ctx.fillStyle=K.pace; ctx.lineWidth=tall?1.6:1.2;
    ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x-5,0); ctx.lineTo(x+5,0); ctx.lineTo(x,tall?9:6); ctx.closePath(); ctx.fill();
  },

  /* ---------- scrubbing ---------- */

  fineWindow(){
    const dur = Math.max(this.det.dur,1), span = Math.max(this.det.span, 1);
    if(span >= dur) return {t0:0, t1:dur, centred:false};
    return {t0:this.det.play-span/2, t1:this.det.play+span/2, centred:true};
  },

  bindLane(canvas, which){
    const at = e => {
      const r = canvas.getBoundingClientRect();
      return {x:e.clientX-r.left, w:r.width};
    };
    // Live pointers, by id. One is a drag; two are a pinch. iOS delivers both
    // through the same pointer events, so the two gestures share this map
    // rather than fighting over a touch handler.
    const live = new Map();
    const spread = () => {
      const p = [...live.values()];
      return {gap: Math.abs(p[0].x - p[1].x), mid: (p[0].x + p[1].x)/2};
    };

    canvas.addEventListener('pointerdown', e=>{
      canvas.setPointerCapture(e.pointerId);
      const p = at(e);
      live.set(e.pointerId, p);
      if(live.size === 2 && which === 'fine'){
        const sp = spread();
        this.det.drag = null;
        this.det.pinch = {gap: Math.max(sp.gap, 1), span: this.det.span,
                          anchor: this.timeAtX(sp.mid, p.w)};
        e.preventDefault();
        return;
      }
      const win = which==='over' ? {t0:0,t1:Math.max(this.det.dur,1),centred:false} : this.fineWindow();
      this.det.drag = {which, x0:p.x, play0:this.det.play, win};
      if(!win.centred) this.setPlay(win.t0 + (win.t1-win.t0)*(p.x/p.w));
      e.preventDefault();
    });

    canvas.addEventListener('pointermove', e=>{
      if(!live.has(e.pointerId)) return;
      const p = at(e);
      live.set(e.pointerId, p);

      const z = this.det.pinch;
      if(z && live.size === 2){
        const sp = spread();
        // Fingers apart zooms in, so the visible width shrinks by the ratio.
        this.det.span = clamp(z.span * z.gap/Math.max(sp.gap,1), 4, Math.max(this.det.dur,1));
        // and the moment between the fingers stays between the fingers
        const k = sp.mid/p.w;
        this.setPlay(z.anchor + (0.5 - k)*this.det.span);
        this.redraw();
        e.preventDefault();
        return;
      }

      const d = this.det.drag; if(!d || d.which!==which) return;
      if(d.win.centred){
        // drag the strip, not the playhead: the moment you are aiming at
        // is never the pixel your thumb is covering
        this.setPlay(d.play0 - (p.x-d.x0)*(d.win.t1-d.win.t0)/p.w);
      }else{
        this.setPlay(d.win.t0 + (d.win.t1-d.win.t0)*(p.x/p.w));
      }
      e.preventDefault();
    });

    const done = e=>{
      live.delete(e.pointerId);
      if(live.size < 2) this.det.pinch = null;
      // Lifting one finger of a pinch must not become a drag from wherever the
      // other one happens to be sitting.
      if(live.size === 0 && this.det.drag && this.det.drag.which===which) this.det.drag=null;
      try{ canvas.releasePointerCapture(e.pointerId); }catch(err){}
    };
    canvas.addEventListener('pointerup', done);
    canvas.addEventListener('pointercancel', done);

    // The lanes are canvases, so a keyboard has nothing to grab. The fine lane
    // carries role=slider and takes the usual slider keys; + and - stand in for
    // the pinch, which was a row of width buttons before.
    if(which === 'fine') canvas.addEventListener('keydown', e=>{
      const page = Math.max(this.det.span/2, 5);
      let t = null;
      if(e.key === 'ArrowLeft'  || e.key === 'ArrowDown') t = this.det.play - 0.5;
      else if(e.key === 'ArrowRight' || e.key === 'ArrowUp') t = this.det.play + 0.5;
      else if(e.key === 'PageDown') t = this.det.play - page;
      else if(e.key === 'PageUp')   t = this.det.play + page;
      else if(e.key === 'Home')     t = 0;
      else if(e.key === 'End')      t = this.det.dur;
      else if(e.key === '+' || e.key === '=' ){ e.preventDefault(); this.zoomBy(0.5, this.det.play); return; }
      else if(e.key === '-' || e.key === '_' ){ e.preventDefault(); this.zoomBy(2.0, this.det.play); return; }
      if(t === null) return;
      e.preventDefault();
      this.setPlay(t);
    });
  },

  /** x within the fine lane -> the moment it is showing */
  timeAtX(x, w){
    const win = this.fineWindow();
    return win.t0 + (win.t1 - win.t0)*(x/w);
  },

  setPlay(t){
    this.det.play = clamp(t, 0, Math.max(this.det.dur,0));
    if(this.screen==='info'){ this.drawOverview(); this.drawFine(); this.readout(); }
  },

  /** The lane is a slider to a screen reader, and the only place the current
      position is still written down: the readout row that used to sit under it
      said "At 3:20" beside a graph with a time axis on it. */
  readout(){
    const d = this._dom, t = this.det.play;
    d.fine.setAttribute('aria-valuemax',  String(Math.round(this.det.dur)));
    d.fine.setAttribute('aria-valuenow',  String(Math.round(t)));
    d.fine.setAttribute('aria-valuetext', this.clock(t));
  },

  /** Zoom, as a factor on the visible width. Pinch calls this; so do + and −. */
  zoomBy(f, anchorT){
    const dur = Math.max(this.det.dur, 1);
    const before = this.det.span;
    // 4 s is about two breaths at a fast rate and is as far in as the 10 Hz
    // signal has anything to show; the whole recording is as far out as there is.
    this.det.span = clamp(before*f, 4, dur);
    // Keep the anchor where the fingers are: the moment under the midpoint of a
    // pinch must not slide out from under it.
    if(anchorT != null){
      const k = (anchorT - (this.det.play - before/2))/before;
      this.setPlay(anchorT - (k - 0.5)*this.det.span);
    }
    this.redraw();
  },

  /* ---------- delete + export ---------- */

  /** One delete, and it lands where you came from. There used to be two — a
      Discard on the summary for a session too short to be worth keeping, and a
      Delete on the detail screen — because they were two screens. One screen
      wants one button, and the rule it replaces still holds: two taps, because
      it cannot be undone, and you can see what you are deleting while you do
      it. A session you have just finished goes home rather than to the list,
      because the list is not where you were. */
  async remove(){
    const b = this._dom.deleteBtn;
    if(b.dataset.armed !== '1'){
      b.dataset.armed='1'; b.textContent=t('rev.delete2', null, 'Delete, really');
      setTimeout(()=>{ if(b.dataset.armed==='1'){ b.dataset.armed='0'; b.textContent=t('rev.delete', null, 'Delete this recording'); } }, 5000);
      return;
    }
    b.dataset.armed='0'; b.textContent=t('rev.delete', null, 'Delete this recording');
    const id = this.session && this.session.id, backTo = this.from;
    if(typeof Store !== 'undefined' && Store.available !== false && id){
      try{ await Store.delete(id); }
      catch(err){ notice(t('n.nodelete', null, 'Could not delete'),
                         ((err && err.name)||'The store refused the delete') + '. Try again from Recordings.', 6000); return; }
    }
    this.metas = (this.metas||[]).filter(m=>m.id!==id);
    this.session = null;
    this.cancelHr();
    if(backTo === 'list'){ this.showList(); return; }
    this.hide();
    if(this.onDone) this.onDone();
  },

  async exportOne(session){
    if(!session){ notice('Nothing to export','There is no recording on screen to write out.',5000); return; }
    // The summary holds a session fetched with {motion:false} so the phone does not
    // materialise 40k rows to draw a sparkline. Exporting that object shipped a file
    // with motion.count set and motion.rows empty — the raw signal, which is the whole
    // point of exporting, was missing. Re-read the full record here.
    //
    // Store builds the file: it writes the columns straight out as string pieces
    // into a Blob. JSON.stringify on the assembled session produced the same
    // bytes and needed the whole megabyte contiguous in memory to do it.
    let blob = null;
    try{
      blob = await Store.exportBlob(Store.available && session.id ? session.id : session);
    }catch(err){ blob = null; }
    if(!blob){
      notice('Export failed', 'That recording could not be read back off this phone.', 6000);
      return;
    }
    this.saveBlob(Store.exportName(session), blob);
  },

  async exportAll(){
    if(typeof Store === 'undefined' || Store.available === false){
      notice('Nothing to export','Storage is unavailable, so there is no list of recordings to write out.',5000); return;
    }
    // One file, because a phone browser will not accept a burst of downloads —
    // and built by the store, one recording at a time, straight into a Blob.
    // Reading every session into memory first and then calling JSON.stringify
    // on the lot needed the whole export twice over: once as row objects and
    // once as a single string. Thirty full-length sessions is tens of MB, which
    // is more than a phone will hand over in one contiguous allocation.
    let blob = null, count = 0;
    try{
      count = (await Store.list()).length;
      if(count) blob = await Store.exportAllBlob();
    }catch(err){
      notice('Export failed', ((err && err.name)||'The store could not be read') + '. Try exporting one recording at a time.', 6000);
      return;
    }
    if(!count || !blob){ notice('Nothing to export','There are no recordings on this phone yet.',5000); return; }
    const stamp = new Date().toISOString().slice(0,10).replace(/-/g,'');
    this.saveBlob('breathe-sessions-'+stamp+'.json', blob);
  },

  /** Blob -> share sheet if the phone takes files, otherwise a download anchor.
      Nothing leaves the device either way: no fetch, no upload, no URL beyond blob:. */
  saveBlob(name, blob){
    if(!blob){ notice('Export failed','This browser would not build the file. Try a different browser.',6000); return; }

    if(window.File && navigator.canShare && navigator.share){
      try{
        const file = new File([blob], name, {type:'application/json'});
        if(navigator.canShare({files:[file]})){
          navigator.share({files:[file], title:name}).catch(()=>this.anchor(name, blob));
          return;
        }
      }catch(err){ /* fall through to the anchor */ }
    }
    this.anchor(name, blob);
  },

  anchor(name, blob){
    try{
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click();
      setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 4000);
    }catch(err){
      notice('Export failed','This browser blocked the download. Open the page in Safari or Chrome directly and try again.',7000);
    }
  },

  /* ---------- the Adjust panel hint ---------- */

  async refreshCount(){
    const n = $('recCount'); if(!n) return;
    if(typeof Store === 'undefined' || Store.available === false){ n.textContent = t('n.storeunavail', null, 'storage unavailable'); return; }
    try{
      await Store.open();
      const u = await Store.usage();
      n.textContent = !u || !u.count ? t('rev.count.0', null, 'nothing kept yet')
        : u.count === 1 ? t('rev.count.1', null, '1 recording kept')
        : t('rev.count.n', [u.count], u.count + ' recordings kept');
    }catch(err){ n.textContent = t('n.storeunavail', null, 'storage unavailable'); }
  },

  /* ---------- small formatting ---------- */

  h(tag, cls, text){
    const n = document.createElement(tag);
    if(cls) n.className = cls;
    if(text!=null) n.textContent = text;
    return n;
  },

  clock(sec){
    sec = Math.max(0, Math.round(sec||0));
    return Math.floor(sec/60) + ':' + String(sec%60).padStart(2,'0');
  },

  /** metric prefixes, so 1 kB is 1000 bytes and the number matches the ones on the phone */
  bytes(b){
    b = b||0;
    if(b < 1000) return b + ' B';
    if(b < 1000000) return (b/1000).toFixed(b<10000?1:0) + ' kB';
    return (b/1000000).toFixed(1) + ' MB';
  },

  when(iso){
    if(!iso) return '';
    const d = new Date(iso);
    if(isNaN(d.getTime())) return String(iso).slice(0,16);
    return d.toLocaleDateString(undefined,{day:'numeric',month:'short'}) + ' · ' +
           d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
  },

  /** inOutRatio is inhale/exhale; "1 : 1.4" reads faster than "0.71" */
  metaBytes(m){ return (m && (m.bytes!=null ? m.bytes : m.size)) || 0; },
  metaBpm(m){
    if(!m) return 0;
    if(m.summary && m.summary.meanBpm>0) return m.summary.meanBpm;
    return m.meanBpm>0 ? m.meanBpm : 0;
  }
};
