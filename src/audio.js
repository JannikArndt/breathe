import { clamp, lp, fin } from './util.js';

/* ============================================================
   1. AUDIO ENGINE
   ------------------------------------------------------------
   One voice: a shoreline. Surf gathers as you draw in, breaks at the
   top, and drains through the exhale. There were three; the other two
   were dropped rather than kept as also-rans, and the seven controls
   in Adjust are the depth that replaced the breadth.

   Direction is the whole point of this rewrite. The old engine only
   ever saw |velocity|, so filling and emptying sounded identical.
   frame() now takes signed velocity, and every voice says which way
   the belly is going on three channels at once:

     brightness   rises through the inhale, falls through the exhale,
                  across about four octaves rather than the old two
     texture      one layer belongs to the inhale and a different one
                  to the exhale; neither sounds during the other half
     turnarounds  a one-shot at the top and a deliberately unlike one
                  at the bottom, so the two ends never blur together

   The exhale is the half the app is trying to lengthen, so it is the
   wider, warmer, more rewarding of the two.

   Shared and built once: two looping noise buffers, one convolution
   room, one limiter.
   ============================================================ */

export const Audio = {
  ctx:null, ready:false, vol:0.55,

  // User-facing sound controls, 0..1 unless noted. The layer gains run to 1.5
  // so a layer can be pushed past its designed level, which is the point of
  // having the control at all.
  mix:{ swell:1, brk:1, foam:1, spray:1, under:1, bright:0.5, space:0.5 },

  widthG:null,                  // the mid/side width gain, Space's real work
  v:null,                       // built voices, keyed by id
  m:null,                       // the per-frame bundle, allocated once
  dir:-1, wasIn:false, hit:0,   // held breath direction, break-to-foam decay
  lastTop:0, lastBottom:0,
  fadeFrom:null, fadeUntil:0,

  async start(){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) throw new Error('no-webaudio');
    // Constructed before the first await, deliberately: iOS only lets the
    // context leave the suspended state if it was made inside the tap.
    const ctx = this.ctx = new AC({latencyHint:'playback'});
    if(ctx.state === 'suspended') await ctx.resume();

    const t = ctx.currentTime;

    // ---- construction helpers. Setting .value here is construction, not the
    //      render loop, so it is fine; frame() never does it.
    const G = v => { const g=ctx.createGain(); g.gain.value=v; return g; };
    const F = (type,f,q) => {
      const b=ctx.createBiquadFilter(); b.type=type; b.frequency.value=f;
      if(q!=null) b.Q.value=q; return b;
    };
    // StereoPannerNode is not on every WebKit build the app can land on; the
    // fallback is a plain unity gain, which costs the stereo movement and
    // nothing else.
    const P = p => { if(!ctx.createStereoPanner) return G(1);
                     const n=ctx.createStereoPanner(); n.pan.value=p; return n; };
    const O = (freq,type,gain,dest,detune) => {
      const o=ctx.createOscillator(); o.type=type; o.frequency.value=freq;
      if(detune) o.detune.value=detune;
      const g=G(gain); o.connect(g); g.connect(dest); o.start(t);
      return {o,g};
    };
    const LOOP = buf => {
      const s=ctx.createBufferSource(); s.buffer=buf; s.loop=true; s.start(t); return s;
    };

    // ---- output chain: voices -> (dry | room) -> mix -> duck -> master -> limiter
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value=-10; limiter.knee.value=18;
    limiter.ratio.value=12; limiter.attack.value=0.008; limiter.release.value=0.3;
    limiter.connect(ctx.destination);

    const master = this.master = G(0);   master.connect(limiter);
    const duckG  = this.duckG  = G(1);   duckG.connect(master);
    const mix    = G(1);                 mix.connect(duckG);
    const dry    = G(0.85);              dry.connect(mix);

    // Space. A reverb send on its own is nearly inaudible here, because the
    // whole voice is noise and convolved noise still sounds like noise: there
    // is no transient for a room to smear. What does read as a room on a noise
    // bed is width, so Space opens the stereo field as well as the send.
    // Mid/side: L' = M + w*S, R' = M - w*S, with w the one moving gain.
    const wIn = G(1), wSplit = ctx.createChannelSplitter(2),
          wMerge = ctx.createChannelMerger(2),
          wMid = G(1), wSide = this.widthG = G(1), wSideNeg = G(-1),
          wML = G(0.5), wMR = G(0.5), wSL = G(0.5), wSR = G(-0.5);
    wIn.connect(wSplit);
    wSplit.connect(wML, 0); wSplit.connect(wMR, 1);
    wML.connect(wMid);      wMR.connect(wMid);
    wSplit.connect(wSL, 0); wSplit.connect(wSR, 1);
    wSL.connect(wSide);     wSR.connect(wSide);
    wMid.connect(wMerge, 0, 0);  wMid.connect(wMerge, 0, 1);
    wSide.connect(wMerge, 0, 0); wSide.connect(wSideNeg); wSideNeg.connect(wMerge, 0, 1);

    // One room for all three voices. Per-voice convolvers would suit them
    // better — shore wants a longer tail than harmonium — but a convolver is
    // by far the most expensive node here and this runs with the screen
    // locked, so each voice trims its own send instead.
    const conv = ctx.createConvolver();
    conv.buffer = this.impulse(ctx, 4.0, 2.5);
    const wetTrim = G(0.9);
    conv.connect(wetTrim); wetTrim.connect(mix);

    // ---- shared sources. Buffers are generated here, in JS: nothing is
    //      fetched, and nothing is stored as data anywhere in the file.
    this.pinkBuf = this.noiseBuffer(ctx, 6, 1);
    // two independent channels: all of shore's stereo, and the width of tide's
    // exhale, comes from that decorrelation rather than from a panner
    this.surfBuf = this.noiseBuffer(ctx, 8, 2);
    const pink = LOOP(this.pinkBuf);
    const surf = LOOP(this.surfBuf);
    const dc   = LOOP(this.dcBuffer(ctx));

    const kit = {ctx, t, G, F, P, O, pink, surf, dc,
                 pinkBuf:this.pinkBuf, surfBuf:this.surfBuf};

    this.voice = this.buildShore(kit);
    this.voice.out.connect(wIn);
    wMerge.connect(dry);
    wMerge.connect(this.voice.send);
    this.voice.send.connect(conv);
    this.voice.out.gain.value = this.voice.trim;

    // Built once: frame() runs 60 times a second for as long as the session
    // lasts, and allocating a bundle plus four closures each time is the one
    // avoidable piece of garbage in the render path.
    this.m = {
      t:0, dt:1/60, lvl:0.5, vel:0, up:0, dn:0, spd:0, hit:0,
      rich:0, inG:0, outG:1, bpm:10,
      // Every render-loop write goes through one of these four: setTargetAtTime
      // only, and clamped into a range the node can actually accept, so no
      // arithmetic slip can park a filter at 0 Hz or a gain below zero.
      stF(p,v,tc){ p.setTargetAtTime(clamp(v, 25, 16000),   this.t, tc); },
      stG(p,v,tc){ p.setTargetAtTime(clamp(v, 0, 1.4),      this.t, tc); },
      stQ(p,v,tc){ p.setTargetAtTime(clamp(v, 0.05, 12),    this.t, tc); },
      stC(p,v,tc){ p.setTargetAtTime(clamp(v, -1200, 1200), this.t, tc); }
    };

    this.dir=-1; this.pdir=-1; this.wasIn=false; this.hit=0;
    this.lastTop=0; this.lastBottom=t;
    this.fadeFrom=null; this.fadeUntil=0;

    this.ready = true;
    this.fade(this.vol, 2.5);
  },

  /* ---------- procedural buffers ---------- */

  /** Crossfade the generator's overhang back over the head of the buffer, so the
      wrap is an ordinary sample-to-sample step instead of a jump between two
      uncorrelated points. On this pink source that is a small win — measured, it
      takes the seam from roughly 1.4 to 1.0 times the ordinary step — but it is
      what keeps the lap inaudible if the noise is ever given more low end. */
  seal(ext, out, n, f){
    for(let i=0;i<f;i++){ const k=i/f; out[i] = ext[i]*k + ext[n+i]*(1-k); }
    for(let i=f;i<n;i++) out[i] = ext[i];
  },

  /** Procedural room. Normalised to unit energy so a send gain means what it
      says: at 0.35 the reverb comes back at roughly 35% of the source, whatever
      sample rate the device runs at. */
  impulse(ctx, seconds, decay){
    const rate=ctx.sampleRate, n=Math.floor(rate*seconds);
    const buf=ctx.createBuffer(2,n,rate);
    const atk=Math.max(1, rate*0.012);
    for(let c=0;c<2;c++){
      const d=buf.getChannelData(c);
      let e=0;
      for(let i=0;i<n;i++){
        const env=Math.pow(1-i/n, decay);
        const v=(Math.random()*2-1)*env*(i<atk ? i/atk : 1);
        d[i]=v; e+=v*v;
      }
      const g = e>0 ? 1/Math.sqrt(e) : 1;
      for(let i=0;i<n;i++) d[i]*=g;
    }
    return buf;
  },

  /** Voss-McCartney-ish pink noise. Gentler on the ear than white, and unlike
      brown it still has real energy at 4 kHz — shore's foam is a high-pass that
      climbs to 4.5 kHz and would be silent on a browner source. */
  pinkFill(out, n, f){
    const ext=new Float32Array(n+f);
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for(let i=0;i<n+f;i++){
      const w=Math.random()*2-1;
      b0=0.99886*b0+w*0.0555179; b1=0.99332*b1+w*0.0750759;
      b2=0.96900*b2+w*0.1538520; b3=0.86650*b3+w*0.3104856;
      b4=0.55000*b4+w*0.5329522; b5=-0.7616*b5-w*0.0168980;
      ext[i]=(b0+b1+b2+b3+b4+b5+b6+w*0.5362)*0.11;
      b6=w*0.115926;
    }
    this.seal(ext, out, n, f);
  },

  /** One generator for both noise buffers, so the layers fed from each are
      level-matched — tide's inhale air comes off the mono buffer and its exhale
      air off the stereo one, and they have to sound like one instrument. */
  noiseBuffer(ctx, seconds, channels){
    const n=Math.floor(ctx.sampleRate*seconds);
    const f=Math.min(Math.floor(ctx.sampleRate*0.05), n>>2);
    const buf=ctx.createBuffer(channels,n,ctx.sampleRate);
    for(let c=0;c<channels;c++) this.pinkFill(buf.getChannelData(c), n, f);
    return buf;
  },

  /** Constant 1.0. A looped DC buffer works on every build the app can reach,
      where ConstantSourceNode only arrived in Safari 14. */
  dcBuffer(ctx){
    const b=ctx.createBuffer(1,512,ctx.sampleRate);
    b.getChannelData(0).fill(1);
    return b;
  },

  /* ============================================================
     VOICE: tide — today's identity, with the direction made plain
     ============================================================ */
  /* Each voice ends in `out`, and `trim` is the level that gain crossfades to.
     Measured peak levels are within 1.1 dB of each other across the three, but
     peak is not loudness: tide is filtered sines, shore is broadband noise and
     harmonium is filtered sawtooths, and noise reads louder than a drone at the
     same peak. Nothing here has been heard yet, so these are all 1.0 — this is
     the one number to move per voice after a listening test, and moving it
     changes nothing else. */
  buildShore(k){
    const {ctx,G,F,P,O,surf} = k;
    const out=G(0), send=G(0.45), trim=1.0;
    let lastRich=0;
    // The one-shots fire outside frame(), so they read the live mix directly
    // rather than the per-frame bundle.
    const mix = this.mix;

    // Swell: the body of the wave. A resonant low-pass on brown noise tightens
    // as you draw in, which is what makes it gather rather than merely get
    // louder — a wave has pitch just before it breaks.
    const swF=F('lowpass',300,2.0), swG=G(0);
    surf.connect(swF); swF.connect(swG); swG.connect(out);

    // Foam: hiss that falls in pitch through the exhale. Stereo straight
    // through with no panner — the two noise channels are independent, so this
    // is the widest thing in the voice for free.
    const foF=F('highpass',1200,0.7), foG=G(0);
    surf.connect(foF); foF.connect(foG); foG.connect(out);

    // Spray: a narrow band that drifts across the field. 0.055 Hz is slower
    // than the slowest breath the app accepts, so the movement never counts time.
    const spF=F('bandpass',2200,1.2), spG=G(0), spPan=P(0);
    surf.connect(spF); spF.connect(spG); spG.connect(spPan); spPan.connect(out);
    if(spPan.pan) O(0.055,'sine',0.55,spPan.pan);

    // Undertow: the drag back down the beach, strongest at the very bottom.
    const unF=F('lowpass',90,1.1), unG=G(0);
    surf.connect(unF); unF.connect(unG); unG.connect(out);

    // There is no pitch in this voice. A sub-bass sine and a pair of upper
    // tones used to sit under the water; they read as a drone laid over the
    // sea rather than as part of it, and they were the one thing in the mix
    // that could not be mistaken for weather. Removed rather than defaulted
    // to zero — a control nobody wants at anything but zero is not a control.

    return {
      out, send, trim,
      frame(m){
        lastRich = m.rich;
        const X = m.mix;
        // Brightness shifts every filter corner together, up or down about
        // one and a half octaves, so the whole voice moves rather than one
        // layer detaching. One octave each way was too small a span to hear
        // as a change of character rather than a change of level.
        const br = Math.pow(2, (X.bright - 0.5)*3.1);

        // 170 Hz to 1.6 kHz. The swell is the loudest thing at the top of the
        // inhale and drops by nearly half the moment you turn.
        m.stF(swF.frequency, br*170*Math.pow(2, 3.2*m.lvl), 0.10);
        m.stQ(swF.Q,         2.0 + 3.0*m.up*m.inG, 0.20);
        // the resonance is worth up to ~10 dB at the corner, so take it back
        // out of the level or the wave stabs every time it gathers
        m.stG(swG.gain, X.swell*0.250*(0.15+0.85*m.lvl)*(0.55+0.45*m.inG)/(1+0.55*m.up*m.inG), 0.12);

        // The foam opens an extra octave and a quarter at the break and falls
        // back through the first second of the exhale, so the hiss arrives with
        // the wave and then drains rather than sitting at one pitch.
        m.stF(foF.frequency, br*900*Math.pow(2, 2.32*m.lvl + 1.25*m.hit), 0.13);
        m.stG(foG.gain,      X.foam*0.123*m.dn*m.outG*(0.65+0.35*m.rich), 0.10);

        m.stF(spF.frequency, br*1400*Math.pow(2, 1.6*m.lvl), 0.15);
        m.stG(spG.gain,      X.spray*0.145*m.dn*m.outG, 0.14);

        // The undertow is the floor of the sound, so brightness moves it much
        // less than the layers above it — otherwise turning down the brightness
        // takes the bottom out too and the whole thing gets thinner, not darker.
        m.stF(unF.frequency, (60 + 70*(1-m.lvl))*Math.pow(br, 0.35), 0.30);
        m.stG(unG.gain,      X.under*0.195*m.outG*(0.30+0.70*(1-m.lvl)), 0.20);

        m.stG(send.gain,     (0.34+0.26*m.rich)*(0.20+1.60*X.space), 0.50);
      },

      /** top of the inhale: the break. The loudest event in the app, and the
          only one allowed to be — a wave that gathers and then does not break
          is a worse cue than no wave at all. Tail lengthens with rich. */
      top(s){
        s *= mix.brk;
        if(s <= 0.02) return;
        const t0=ctx.currentTime, dec=1.9+1.6*lastRich;
        const src=ctx.createBufferSource(); src.buffer=k.surfBuf;
        const bp=F('bandpass',2600,0.8), bg=G(0);
        src.connect(bp); bp.connect(bg); bg.connect(out);
        bp.frequency.setValueAtTime(2600,t0);
        bp.frequency.exponentialRampToValueAtTime(420,t0+dec);
        bg.gain.setValueAtTime(0,t0);
        bg.gain.linearRampToValueAtTime(0.200*s,t0+0.12);
        bg.gain.exponentialRampToValueAtTime(0.0001,t0+dec);
        // crest hiss: shorter and brighter, so the break has an edge on it
        const hp=F('highpass',5000,0.7), hg=G(0);
        src.connect(hp); hp.connect(hg); hg.connect(out);
        hp.frequency.setValueAtTime(5000,t0);
        hp.frequency.exponentialRampToValueAtTime(1200,t0+1.3);
        hg.gain.setValueAtTime(0,t0);
        hg.gain.linearRampToValueAtTime(0.080*s,t0+0.10);
        hg.gain.exponentialRampToValueAtTime(0.0001,t0+1.4);
        src.start(t0, Math.random()*6); src.stop(t0+dec+0.2);
      },

      /** bottom of the exhale: the draw. Slow attack, rising band, low and
          soft — the opposite envelope to the break, which is the point. */
      bottom(s){
        s *= mix.brk;
        if(s <= 0.02) return;
        const t0=ctx.currentTime;
        const src=ctx.createBufferSource(); src.buffer=k.surfBuf;
        const bp=F('bandpass',240,1.0), g=G(0);
        src.connect(bp); bp.connect(g); g.connect(out);
        bp.frequency.setValueAtTime(240,t0);
        bp.frequency.exponentialRampToValueAtTime(900,t0+0.9);
        g.gain.setValueAtTime(0,t0);
        g.gain.linearRampToValueAtTime(0.110*s,t0+0.55);
        g.gain.linearRampToValueAtTime(0,t0+1.15);
        src.start(t0, Math.random()*6); src.stop(t0+1.2);
      }
    };
  },

  /* ============================================================
     VOICE: harmonium — a reed drone box worked by the belly
     ============================================================ */
  /**
   * @param f {level, vel, speed, inhaling, resting, rich, bpm, dt}
   *          level 0..1 (1 = fullest inhale), vel -1..1 (positive inhaling).
   */
  frame(f){
    if(!this.ready || !this.voice || !this.m) return;
    const t = this.ctx.currentTime;
    if(!f) f = {};

    const dt   = clamp(fin(f.dt, 1/60), 0.001, 0.25);
    const lvl  = clamp(fin(f.level, 0.5), 0, 1);
    const vel  = clamp(fin(f.vel, 0), -1, 1);
    const sp   = clamp(fin(f.speed, 0), 0, 1);
    const rich = clamp(fin(f.rich, 0), 0, 1);
    const bpmR = fin(f.bpm, 0);
    const bpm  = clamp(bpmR > 0 ? bpmR : 10, 4, 22);
    const inh  = !!f.inhaling;

    // |vel| scales with breathing rate: at 6/min a clean sinusoid produces only
    // about 40% of the velocity it does at 14/min, so a raw velocity channel
    // would fade every layer it feeds exactly when the user does the one thing
    // the app is asking for. Divide out the peak the rate implies —
    // |v|max = wA/2.4 with w = 2*pi*bpm/60 and A ~ 0.91 after the AGC, so
    // roughly 0.040*bpm.
    const vRef = clamp(0.040*bpm, 0.10, 0.90);
    const up   = clamp( vel/vRef, 0, 1.25);
    const dn   = clamp(-vel/vRef, 0, 1.25);
    const spd  = clamp(   sp/vRef, 0, 1.25);

    // Held direction. tau = 0.30 s swings it over about a second at each
    // turnaround and holds it flat through the stroke, so the layers that
    // belong to one half do not flicker while velocity crosses zero.
    this.dir = lp(this.dir, inh ? 1 : -1, dt, 0.30);
    const inG = clamp((this.dir+1)/2, 0, 1), outG = 1-inG;

    // The top of the breath arrives through bell(), fired by the cycle
    // detector. The bottom has no such hook, so watch the flip here. 1.6 s is
    // below the shortest period the tracker will accept (2 s), so this
    // debounces jitter without ever swallowing a real turn.
    if(inh && !this.wasIn && (t - this.lastBottom) > 1.6){
      this.lastBottom = t;
      const outDur = this.lastTop ? (t - this.lastTop) : 0;
      this.dispatch('bottom', 0.55 + 0.45*clamp((outDur-2.5)/4.0, 0, 1));
    }
    this.wasIn = inh;

    const m = this.m;
    m.t=t; m.dt=dt; m.lvl=lvl; m.vel=vel; m.up=up; m.dn=dn; m.spd=spd;
    m.rich=rich; m.inG=inG; m.outG=outG; m.bpm=bpm;

    // The break opens the foam an octave and lets it fall. tau = 0.55 s puts
    // most of the drop inside the first second of the exhale.
    this.hit *= Math.exp(-dt/0.55);
    m.hit = this.hit;

    m.mix = this.mix;
    if(this.voice) this.voice.frame(m);

    // 0.35 is narrower than the source, 1.9 well past it: at the top of the
    // range the two noise channels pull apart far enough to sound like a beach
    // rather than a speaker.
    if(this.widthG)
      this.widthG.gain.setTargetAtTime(
        clamp(0.35 + 1.55*fin(this.mix.space, 0.5), 0.1, 2.2), t, 0.5);

  },

  /* ============================================================
     turnaround markers, voice switching, level
     ============================================================ */

  /** Top of the breath, fired from Breath.onExhaleStart. Each voice supplies
      its own sound; this only routes it and remembers when it happened, so the
      bottom marker can scale itself by how long the exhale actually ran. */
  bell(strength){
    if(!this.ready) return;
    this.lastTop = this.ctx.currentTime;
    this.hit = 1;
    this.dispatch('top', strength);
  },

  dispatch(which, strength){
    if(!this.ready || !this.voice) return;
    const s = clamp(fin(strength, 0.5), 0, 1);
    if(s <= 0.02) return;
    if(this.voice[which]) this.voice[which](s);
  },

  /** 0..1 from a slider; bright and space run 0..1, the layers 0..1.5. */
  setMix(key, v){
    if(!(key in this.mix)) return;
    this.mix[key] = clamp(fin(v, 1), 0, 1.5);
  },

  /** Equal-power ramp. Two voices are uncorrelated, so a pair of linear ramps
      loses about 3 dB in the middle of the crossfade and reads as a dropout.
      48 points over 1.5 s is one step per 31 ms, well under anything audible. */
  xfade(param, to, secs){
    const t = this.ctx.currentTime;
    const from = clamp(fin(param.value, 0), 0, 2);
    try{
      const n=48, curve=new Float32Array(n);
      for(let i=0;i<n;i++){
        const k=i/(n-1);
        curve[i]=Math.sqrt(clamp(from*from*(1-k) + to*to*k, 0, 4));
      }
      param.cancelScheduledValues(t);
      param.setValueCurveAtTime(curve, t, secs);
      return;
    }catch(e){ /* a curve already running here: fall through to a plain ramp */ }
    try{
      param.cancelScheduledValues(t);
      param.setValueAtTime(from, t);
      param.linearRampToValueAtTime(to, t+secs);
    }catch(e){}
  },

  fade(to, secs){
    if(!this.ready) return;
    const t=this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(clamp(fin(this.master.gain.value,0),0,1), t);
    this.master.gain.linearRampToValueAtTime(clamp(fin(to,0),0,1), t+secs);
  },

  setVolume(v){ this.vol = clamp(fin(v,0.55),0,1); if(this.ready) this.fade(this.vol, 0.25); },

  /** Speech ducking. `amount` is the fraction of the current level to keep, so
      duck(0.25, 0.3) drops the instrument to a quarter over 300 ms. Sits on its
      own node so the volume slider and a duck cannot overwrite each other. */
  duck(amount, secs){ this.rampDuck(clamp(fin(amount,0.3),0,1), Math.max(fin(secs,0.3),0.02)); },
  unduck(secs){       this.rampDuck(1, Math.max(fin(secs,0.6),0.02)); },
  rampDuck(to, secs){
    if(!this.ready || !this.duckG) return;
    const t=this.ctx.currentTime, p=this.duckG.gain;
    try{
      p.cancelScheduledValues(t);
      p.setValueAtTime(clamp(fin(p.value,1),0,1), t);
      p.linearRampToValueAtTime(to, t+secs);
    }catch(e){}
  },

  async stop(fadeSec){
    if(!this.ready) return;
    const f = clamp(fin(fadeSec, 1.4), 0.2, 12);
    this.fade(0, f);
    const ctx=this.ctx;
    this.ready=false; this.voice=null; this.m=null;
    setTimeout(()=>{ try{ ctx.close(); }catch(e){} }, f*1000 + 300);
    this.ctx=null;
  }
};
