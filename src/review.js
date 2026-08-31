import { $, clamp, notice, fitCanvas, palette } from './util.js';
import { Store } from './store.js';

/* ============================================================
   5. REVIEW UI
   ------------------------------------------------------------
   Three screens sharing one overlay:

     summary   where End goes instead of back to the intro
     list      every recording this phone is still holding
     detail    scrub the waveform and say what was happening

   Inert until show*() runs. No DOM lookups at definition time,
   the same rule Audio follows.

   ---- why the detail screen has two lanes ----
   A twelve-minute session drawn across a 357 px phone canvas is
   2 s per pixel, and a thumb covers about 40 px of it — 80 s of
   blur. "Mark the moment I lay down" is simply not expressible
   on one full-width lane, so the detail screen stacks two:

     overview   the whole session; tap or drag to jump near
     fine       a window of `span` seconds dragged past a
                playhead pinned to the centre of the lane

   Pinning the playhead to the centre is the part that makes it
   work one-handed: the instant you are aiming at is never the
   pixel under your finger. At the 8 s span that is 22 ms per
   pixel, about a thousand times finer than one lane, and the
   half-second steppers cover the case where a steady drag is
   not available.
   ============================================================ */
export const Review = {
  onDone:null,                 // app wires this: return to the intro screen

  screen:null,                 // null | 'summary' | 'list' | 'detail'
  session:null,                // the full session object on screen
  from:'list',                 // where Back leaves the detail screen for
  metas:[],                    // last Store.list() result
  confirmId:null,              // list row currently asking "delete this?"

  /** scrub state for the detail screen */
  det:{ dur:0, play:0, span:30, drag:null, pinch:null },
  trim:null,                   // {fromSec, toSec} or null for "all of it"

  /** projected signal unpacked from derived.rows, built once per session */
  sig:{ n:0 },

  /* fine-lane widths. 0 means "the whole recording". 8 s is the
     finest useful step: below that a breath no longer fits on screen. */
  SPANS:[[0,'Whole'],[120,'2 min'],[30,'30 s'],[8,'8 s']],

  /* ---------- lazy DOM + palette ---------- */

  dom(){
    if(this._dom) return this._dom;
    const d = this._dom = {
      root:$('review'), title:$('revTitle'), tag:$('revTag'), back:$('revBack'),
      scr:{ summary:$('revSummary'), list:$('revList'), detail:$('revDetail') },
      bar:{ summary:$('revSumBar'), list:$('revListBar'), detail:$('revDetBar') },
      spark:$('revSpark'), sumGrid:$('revSumGrid'), sumFlag:$('revSumFlag'),
      rows:$('revRows'), listEmpty:$('revListEmpty'), listFoot:$('revListFoot'),
      over:$('revOver'), fine:$('revFine'),
      trimFrom:$('revTrimFrom'), trimTo:$('revTrimTo'),
      trimState:$('revTrimState'), trimClear:$('revTrimClear')
    };
    this.wire();
    return d;
  },

  /** canvas colours live in :root like every other colour in the app */
  ink(){
    if(this._ink) return this._ink;
    const P = palette();
    return this._ink = {you:P.glass, pace:P.sand, mute:P.mute,
                        foam:P.foam, deep:P.deep, abyss:P.abyss};
  },

  wire(){
    if(this._wired) return; this._wired = true;
    const d = this._dom;

    d.back.addEventListener('click', ()=>this.back());
    $('revLabelBtn').addEventListener('click', ()=>{
      if(this.session) this.showDetail(this.session.id, 'summary');
    });
    $('revSumExport').addEventListener('click', ()=>this.exportOne(this.session));
    $('revExportAll').addEventListener('click', ()=>this.exportAll());
    $('revDetExport').addEventListener('click', ()=>this.exportOne(this.session));
    $('revDetDelete').addEventListener('click', ()=>this.deleteCurrent());

    d.trimFrom.addEventListener('click', ()=>this.markTrim('from'));
    d.trimTo.addEventListener('click', ()=>this.markTrim('to'));
    d.trimClear.addEventListener('click', ()=>this.clearTrim());

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
    this._dom.root.classList.add('hidden');
    this.screen = null;
    this.confirmId = null;
  },

  /** The only way out of any review screen. Detail steps back to wherever it
      was opened from; everything else closes, and leaving the summary is what
      returns the app to the intro. */
  back(){
    if(this.screen==='detail' && this.from==='summary'){ this.showSummary(this.session); return; }
    if(this.screen==='detail'){ this.showList(); return; }
    const wasSummary = this.screen === 'summary';
    this.hide();
    if(wasSummary && this.onDone) this.onDone();
  },

  /* ---------- 1. summary ---------- */

  showSummary(session){
    const d = this.dom();
    this.session = session || null;
    this.from = 'summary';
    d.title.textContent = 'This session';
    // No date or time here. You just finished it, and the phone puts the clock
    // at the top of the screen anyway. The recordings list still shows it,
    // because there it is how you tell one session from another.
    d.tag.textContent = '';
    this.show('summary');
    if(!session){
      d.sumFlag.textContent = 'Nothing was recorded, so there is nothing to show here.';
      d.sumFlag.classList.remove('hidden');
      d.sumGrid.textContent = '';
      return;
    }
    this.prepare(session);
    this.renderSummary();
    this.redraw();
  },

  renderSummary(){
    const d = this._dom, s = this.session, sum = s.summary || {};
    const dur = this.det.dur;
    const cell = (k, v, small)=>{
      const c = this.h('div','cell');
      c.appendChild(this.h('div','k',k));
      const val = this.h('div','v', v);
      if(small) val.appendChild(this.h('small',null,' '+small));
      c.appendChild(val);
      return c;
    };
    const bpm = n => (n>0 && isFinite(n)) ? n.toFixed(1) : '—';

    const q = (sum.meanQuality!=null) ? sum.meanQuality : this.meanOf('q');
    // Recordings made before these were summarised fall back to the signal.
    const rate = this.rateStats(sum);

    const g = d.sumGrid;
    g.textContent = '';
    g.appendChild(cell('Length', this.clock(dur)));
    g.appendChild(cell('Breaths', (sum.breaths!=null && sum.breaths>0) ? String(sum.breaths) : '—'));
    g.appendChild(cell('Average rate', bpm(rate.avg), '/min'));
    g.appendChild(cell('Slowest',      bpm(rate.min), '/min'));
    g.appendChild(cell('Fastest',      bpm(rate.max), '/min'));

    // Two more measurements, not two more verdicts. In and out are the halves
    // the live readout shows, averaged; held is how much of the session the app
    // read as a pause rather than a stroke, which for slow breathing is most of
    // what distinguishes one session from another.
    const inS = sum.meanInhaleSec, outS = sum.meanExhaleSec;
    g.appendChild(cell('In / out',
      (inS > 0 && outS > 0) ? inS.toFixed(1) + ' / ' + outS.toFixed(1) : '—', 's'));
    g.appendChild(cell('Held still',
      (sum.heldFraction != null && this.sig.n) ? Math.round(sum.heldFraction*100) + '%' : '—'));

    // Facts about the recording, not about the person. A failed calibration
    // or a noisy signal changes how much the numbers above are worth, so say so.
    const flags = [];
    if(rate.avg === 0)
      flags.push('This recording never settled into a rhythm the app could read, so no rate is given.');
    else if(q > 0 && q < 0.4)
      flags.push('The signal was noisy for most of this session. The rates above are approximate.');
    if(!this.sig.n)
      flags.push('This recording has no waveform stored, so the trace is empty.');
    d.sumFlag.textContent = flags.join(' ');
    d.sumFlag.classList.toggle('hidden', !flags.length);
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
    d.title.textContent = 'Recordings';
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
        mean>0 ? mean.toFixed(1)+' /min' : 'rate unknown',
        this.bytes(this.metaBytes(m)),
        (m.labels && m.labels.length) ? m.labels.length + (m.labels.length===1?' label':' labels') : 'no labels'
      ].join(' · ');
      open.appendChild(top); open.appendChild(sub);
      open.addEventListener('click', ()=>this.showDetail(m.id, 'list'));
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

  /* ---------- 3. detail ---------- */

  async showDetail(id, from){
    const d = this.dom();
    this.from = from || this.from;
    let session = (this.session && this.session.id===id) ? this.session : null;
    if(!session && typeof Store !== 'undefined' && Store.available !== false){
      try{ await Store.open(); session = await Store.get(id); }catch(err){ session = null; }
    }
    if(!session){
      notice('Recording not found', 'That recording is no longer on this phone. Open Recordings for the ones that are.', 6000);
      this.showList(); return;
    }
    this.session = session;
    this.prepare(session);
    this.det.play = 0;
    // A recording made before the trim existed may still carry the old labels;
    // a `settled` and a `sat-up` are exactly the two marks this screen now sets,
    // so read them rather than throwing them away.
    this.trim = session.trim || this.trimFromLabels(session.labels);
    // Two breaths at the slowest rate the app follows is a minute and a half.
    this.det.span = this.det.dur > 180 ? 90 : Math.max(this.det.dur, 1);

    d.title.textContent = 'Recording';
    d.tag.textContent = this.when(session.startedAt);
    this.show('detail');
    this.paintTrim();
    this.redraw();
  },

  /** Recordings made before the trim carry a list of label kinds instead. Two of
      the nine say the same thing the trim does, so they are read back rather
      than discarded — nothing is written in the old shape again. */
  trimFromLabels(labels){
    let from = 0, to = 0;
    for(const l of (labels || [])){
      if((l.kind === 'settled' || l.kind === 'lay-down') && !from) from = l.tSec;
      if(l.kind === 'sat-up') to = l.tSec;
    }
    if(!from && !to) return null;
    return {fromSec: from, toSec: to > from ? to : this.det.dur};
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
    if(this.screen==='summary') this.drawSpark();
    if(this.screen==='detail'){ this.drawOverview(); this.drawFine(); this.readout(); }
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

  /** summary sparkline: the shape of every breath behind the two rates */
  drawSpark(){
    const c = this._dom.spark;
    const {ctx,w,h} = fitCanvas(c);
    const K = this.ink(), pad = 8;
    this.ground(ctx,w,h);
    if(!this.sig.n){
      ctx.fillStyle = K.mute; ctx.globalAlpha=.8;
      ctx.font = '11px ui-monospace, monospace'; ctx.textAlign='center';
      ctx.fillText('no waveform stored', w/2, h/2+4); ctx.globalAlpha=1; ctx.textAlign='start';
      return;
    }
    const t0=0, t1=Math.max(this.det.dur, 1);
    const gut = 34, pw = w - gut;    // right gutter: the rate scale and its unit
    const foot = 15;                 // bottom strip: elapsed time
    const ph = h - foot;             // plot height

    // background: how deep each breath was
    ctx.fillStyle = K.you; ctx.globalAlpha = 0.16;
    this.band(ctx,pw,ph,t0,t1,'s',pad);
    ctx.globalAlpha = 1;

    ctx.font = '9px ui-monospace, monospace';

    const R = this.rateRange();
    if(R){
      // faint horizontal rules so the rate scale is readable at a glance
      ctx.textAlign='start';
      for(let v=Math.ceil(R.lo); v<=R.hi; v++){
        if((v % 2) !== 0) continue;
        const y = ph-pad - (v-R.lo)/(R.hi-R.lo)*(ph-pad*2);
        ctx.strokeStyle = K.mute; ctx.globalAlpha=.22;
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(pw,y); ctx.stroke();
        ctx.fillStyle = K.mute; ctx.globalAlpha=.6;
        ctx.fillText(String(v), pw+5, y+3);
      }
      // The rules are numbers until something says what they count.
      ctx.fillStyle = K.mute; ctx.globalAlpha=.75;
      ctx.fillText('/min', pw+5, 9);
      ctx.globalAlpha=1;

      ctx.strokeStyle = K.you; ctx.lineWidth=1.8;
      this.rateLine(ctx,pw,ph,t0,t1,'b',R.lo,R.hi,pad);
    }

    // ---- time along the bottom. Four ticks at most: on a phone this is about
    //      340 px wide, and five m:ss labels start colliding.
    const ticks = 4;
    ctx.fillStyle = K.mute; ctx.globalAlpha=.6;
    ctx.textBaseline='alphabetic';
    for(let i=0;i<=ticks;i++){
      const frac = i/ticks, x = frac*pw;
      ctx.textAlign = i===0 ? 'start' : (i===ticks ? 'end' : 'center');
      ctx.fillText(this.clock(t0 + frac*(t1-t0)), clamp(x, 0, pw), h-4);
      ctx.strokeStyle = K.mute; ctx.globalAlpha=.22;
      ctx.beginPath(); ctx.moveTo(x, ph); ctx.lineTo(x, ph+3); ctx.stroke();
      ctx.globalAlpha=.6;
    }
    ctx.globalAlpha=1; ctx.textAlign='start';
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
    }
    // the slice the fine lane is showing
    const win = this.fineWindow();
    const xa = (win.t0-t0)/(t1-t0)*w, xb = (win.t1-t0)/(t1-t0)*w;
    ctx.fillStyle = K.foam; ctx.globalAlpha=.08;
    ctx.fillRect(xa,0,Math.max(xb-xa,2),h);
    ctx.globalAlpha=.45; ctx.strokeStyle=K.foam; ctx.lineWidth=1;
    ctx.strokeRect(xa+0.5,0.5,Math.max(xb-xa-1,1),h-1);
    ctx.globalAlpha=1;
    this.veil(ctx,w,h,t0,t1);
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
    this.veil(ctx,w,h,t0,t1);
    this.playMark(ctx,w,h,(this.det.play-t0)/(t1-t0)*w,true);
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

  /** Everything outside the usable stretch, veiled. This is the whole point of
      the screen: the first minute and the last are someone handling a phone,
      and they are worth more than the rest of the session put together at
      throwing an analysis off. */
  veil(ctx,w,h,t0,t1){
    const t = this.trim;
    if(!t) return;
    const K = this.ink();
    const xOf = s => (s - t0)/(t1 - t0)*w;
    ctx.fillStyle = K.abyss; ctx.globalAlpha = .62;
    const a = xOf(t.fromSec), b = xOf(t.toSec);
    if(a > 0) ctx.fillRect(0, 0, Math.min(a, w), h);
    if(b < w) ctx.fillRect(Math.max(b, 0), 0, w - Math.max(b, 0), h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = K.pace; ctx.lineWidth = 1.5; ctx.globalAlpha = .8;
    ctx.beginPath();
    for(const x of [a, b]){
      if(x < -1 || x > w + 1) continue;
      ctx.moveTo(Math.round(x)+0.5, 0); ctx.lineTo(Math.round(x)+0.5, h);
    }
    ctx.stroke(); ctx.globalAlpha = 1;
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
    if(this.screen==='detail'){ this.drawOverview(); this.drawFine(); this.readout(); }
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

  /* ---------- the trim ----------
     One interval: where the usable part of a recording starts and stops. It
     replaced nine label kinds, a free-text note and a list, because the only
     thing anyone ever wanted to record about a session was "I had lain down by
     here" and "I sat up after here" — everything before and after is handling
     the phone, and it throws an analysis off more than the rest of the session
     put together. */

  markTrim(end){
    if(!this.session) return;
    const t = Math.round(this.det.play*1000)/1000;
    const cur = this.trim || {fromSec:0, toSec:this.det.dur};
    let from = end === 'from' ? t : cur.fromSec;
    let to   = end === 'to'   ? t : cur.toSec;
    // Marking a start past the end (or the other way) is a correction, not a
    // mistake to refuse: take the new mark and push the other one out of its way.
    if(end === 'from' && to <= from) to = this.det.dur;
    if(end === 'to'   && from >= to) from = 0;
    this.trim = {fromSec: from, toSec: to};
    this.paintTrim();
    this.redraw();
    this.persist();
  },

  clearTrim(){
    if(!this.session) return;
    this.trim = null;
    this.paintTrim();
    this.redraw();
    this.persist();
  },

  paintTrim(){
    const d = this._dom, t = this.trim;
    const whole = !t || (t.fromSec <= 0 && t.toSec >= this.det.dur - 0.05);
    d.trimState.textContent = whole
      ? 'All of it is marked usable.'
      : 'Usable: ' + this.clock(t.fromSec) + ' to ' + this.clock(t.toSec) +
        ' of ' + this.clock(this.det.dur);
    d.trimClear.classList.toggle('hidden', whole);
  },

  /** Metadata only — it never touches the samples, so marking a recording can
      never cost you one. This screen holds a session fetched without its motion
      channel, and writing that object back is what silently destroyed the raw
      signal of three recordings. */
  persist(){
    if(typeof Store === 'undefined' || Store.available === false || !this.session) return;
    if(!this.session.id) return;
    this.session.trim = this.trim;
    Store.setTrim(this.session.id, this.trim).catch(err=>{
      notice('Not kept', ((err && err.name) || 'The store refused the write') +
        '. The mark is on screen but will be gone when you leave this recording.', 6000);
    });
  },

  /* ---------- delete + export ---------- */

  async deleteCurrent(){
    const b = $('revDetDelete');
    if(b.dataset.armed !== '1'){
      b.dataset.armed='1'; b.textContent='Delete, really';
      setTimeout(()=>{ if(b.dataset.armed==='1'){ b.dataset.armed='0'; b.textContent='Delete'; } }, 5000);
      return;
    }
    b.dataset.armed='0'; b.textContent='Delete';
    const id = this.session && this.session.id;
    if(typeof Store !== 'undefined' && Store.available !== false && id){
      try{ await Store.delete(id); }
      catch(err){ notice('Could not delete', ((err && err.name)||'The store refused the delete') + '. Try again from Recordings.', 6000); return; }
    }
    this.metas = (this.metas||[]).filter(m=>m.id!==id);
    this.session = null;
    this.showList();
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
    if(typeof Store === 'undefined' || Store.available === false){ n.textContent = 'storage unavailable'; return; }
    try{
      await Store.open();
      const u = await Store.usage();
      n.textContent = u && u.count
        ? u.count + (u.count===1?' recording kept':' recordings kept')
        : 'nothing kept yet';
    }catch(err){ n.textContent = 'storage unavailable'; }
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
