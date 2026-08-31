import { clamp, lerp, lp, TAU } from './util.js';

/* ============================================================
   2. BREATH TRACKER
   ------------------------------------------------------------
   accelerationIncludingGravity is a gravity vector. With the phone
   resting on the belly, each breath tilts it by a fraction of a
   degree, so the breath shows up as a slow wander of that vector.

   raw --(lp 0.35s)--> smooth --(lp 3 periods)--> baseline
   d = smooth - baseline                        // 0.013 .. 0.45 Hz
   s = d . u                                    // u tracked continuously

   There is no calibration step. The breath axis is the dominant
   direction of a covariance kept with exponential forgetting, so it
   is available from the first samples, sharpens as breaths arrive,
   and follows the user if they shift position.
   ============================================================ */
export const Breath = {
  smooth:[NaN,NaN,NaN], base:[NaN,NaN,NaN],
  u:[0,0,1], invert:false,
  s:0, sPrev:0, dsLp:0, rms:0.02,
  lastT:0, lastDt:1/60, samples:0, lastEventT:0,
  motionRms:0, breathRms:0,

  // ---- continuous axis tracking
  // Exponentially-forgetting covariance of d. tau = 25 s spans one or two
  // breaths at the rates this is used at, which is long enough to be a
  // direction rather than an instant and short enough to follow a shift.
  cov:[[0,0,0],[0,0,0],[0,0,0]], dMean:[0,0,0],
  covSeen:0, lastTrack:0,
  axisAmp:0,            // RMS of the projection, in m/s^2 — a physical quantity
  signSet:false, lostFor:0,
  periods:[], conf:0, follow:0,
  // follow  — there is movement of a plausible size, so the sound should track
  //           it. Available within seconds, because the sound cannot wait.
  // conf    — it is also rhythmic, so a rate is worth reporting. Needs a few
  //           cycles, and is what stops a waved phone being counted as breaths.
  // 0..1, user-facing. Low: only clear, deep, steady breathing gets through.
  // High: follow almost anything. The right value depends on the person and
  // where the phone sits, and is not something to guess from two recordings.
  sensitivity:0.5,

  // cycle bookkeeping
  rising:true, extreme:0, extremeT:0,
  lastPeakT:0, lastTroughT:0,
  inhaleDur:0, exhaleDur:0, period:0, bpm:0, bpmSmooth:0,
  omega:TAU/5, phase:0, onExhaleStart:null,

  // how big a breath this user actually takes, learned as it goes.
  // strokeAmp is peak-to-trough in normalised units; 1.7 is what a relaxed
  // adult measured at, and is only a starting point until a stroke completes.
  strokeAmp:1.7, peakS:null, troughS:null,
  // rest detection: slopeEnv is mean |velocity|, stillFor counts seconds held
  // still, restGate fades the velocity channels out while the user holds.
  slopeEnv:0.35, slopePeak:0.55, stillFor:0, resting:false, restGate:1,

  reset(){
    this.smooth=[NaN,NaN,NaN]; this.base=[NaN,NaN,NaN];
    this.s=0; this.sPrev=0; this.dsLp=0; this.rms=0.02;
    this.samples=0; this.bpm=0; this.bpmSmooth=0; this.period=0;
    this.inhaleDur=0; this.exhaleDur=0; this.lastPeakT=0; this.lastTroughT=0;
    this.omega=TAU/5;
    this.strokeAmp=1.7; this.peakS=null; this.troughS=null;
    this.slopeEnv=0.35; this.slopePeak=0.55; this.stillFor=0; this.resting=false;
    this.restGate=1;
  },

  begin(now){
    this.reset();
    this.cov=[[0,0,0],[0,0,0],[0,0,0]]; this.dMean=[0,0,0];
    this.covSeen=0; this.lastTrack=now; this.axisAmp=0;
    this.u=[0,0,1]; this.signSet=false; this.lostFor=0;
    this.periods=[]; this.conf=0;
  },

  /** feed one sensor sample. t in seconds. */
  push(x,y,z,t){
    this.lastEventT = t;
    let dt = this.lastT ? t-this.lastT : 1/60;
    this.lastT = t;
    if(!(dt>0) || dt>0.5) dt = 1/60;               // guard against stalls
    this.lastDt = dt;                              // Pulse reads this rather than re-deriving it
    this.samples++;

    // The baseline is a high-pass, and a high-pass turns a held breath into a
    // ramp. A recorded session at 3 breaths a minute holds the bottom for 5 to
    // 10 s: across a 10 s hold a tau = 12 s baseline has already climbed 57%
    // of the way back to the signal, so the app hears an inhale beginning
    // while the belly is still perfectly flat. Measured on that recording the
    // sound started swelling a median 1.9 s early and as much as 9.8 s early.
    // Three periods of headroom leaves under a tenth of that droop. The 12 s
    // floor is what fast breathing already used, so nothing moves for anyone
    // breathing at an ordinary rate, and the 60 s ceiling keeps a standing
    // postural offset (tau x drift rate) smaller than a breath.
    const tauBase = clamp(3.0*(this.period || 4), 12, 60);

    const v=[x,y,z];
    for(let i=0;i<3;i++){
      this.smooth[i] = lp(this.smooth[i], v[i], dt, 0.35);
      this.base[i]   = lp(this.base[i], this.smooth[i], dt, tauBase);
    }
    // energy above the breath band = fidgeting; used for the signal meter
    let hi=0; for(let i=0;i<3;i++){ const e=v[i]-this.smooth[i]; hi+=e*e; }
    this.motionRms = lp(this.motionRms, Math.sqrt(hi), dt, 1.5);

    const d = [this.smooth[0]-this.base[0], this.smooth[1]-this.base[1], this.smooth[2]-this.base[2]];
    if(!isFinite(d[0])) return;

    this.trackAxis(d, dt, t);

    // ---- project onto the breath axis
    let s = d[0]*this.u[0] + d[1]*this.u[1] + d[2]*this.u[2];
    if(this.invert) s = -s;
    this.breathRms = lp(this.breathRms, Math.abs(s), dt, 2.0);

    // ---- automatic gain: normalise to roughly +/-1
    this.rms = lp(this.rms, s*s, dt, 14.0);
    const scale = Math.max(Math.sqrt(this.rms)*1.55, 0.006);
    const sN = clamp(s/scale, -1.8, 1.8);

    const ds = (sN - this.sPrev)/dt;
    this.sPrev = sN;
    this.dsLp = lp(this.dsLp, ds, dt, 0.28);
    this.s = sN;

    this.detectRest(dt);
    this.detectCycle(sN, t);
    this.scoreConfidence(dt);

    // ---- instantaneous phase from the signal and its derivative
    // s = sin(wt) => -ds/w = -cos(wt); atan2 gives 0 at the top of the inhale
    const w = clamp(this.omega, 0.25, 2.2);
    this.phase = Math.atan2(-this.dsLp/w, sN);
  },

  /** Is the belly moving, or is the user holding still between breaths?
      Slow breathing has real pauses in it — on the first recording, 13 of 18
      rests followed the bottom of an exhale. The tracker cannot tell a rest
      from a stroke by velocity alone, because velocity is compared against
      the breathing rate: at 5.4/min the reference peak is 0.216, so a tremor
      of 0.05 divides out to a quarter-strength inhale. Compare against what
      this user's own strokes measure instead. */
  detectRest(dt){
    const v = Math.abs(this.dsLp);
    // tau = 8 s spans several breaths, so one held breath does not drag the
    // reference down and make the next rest impossible to see.
    this.slopeEnv = lp(this.slopeEnv, v, dt, 8.0);
    // The reference is this user's own peak stroke velocity, followed directly:
    // fast up so a stroke sets it within half a second, slow down so it holds
    // across a long pause. It used to be inferred from the mean as peak =
    // mean * 1.57, which is the ratio for a sinusoid and only for a sinusoid.
    // Breathing with real holds in it is nothing like a sinusoid — a 3 s inhale
    // inside a 20 s cycle has a peak several times further above its mean —
    // so the inferred peak came out far too low, every hold measured as motion
    // against it, and the gate stayed open through pauses it existed to catch.
    this.slopePeak = lp(this.slopePeak, v, dt, v > this.slopePeak ? 0.5 : 30.0);
    const peak = Math.max(this.slopePeak, 0.05);
    const r = v/peak;
    // Asymmetric thresholds: fall under 0.22 to start counting as still, clear
    // 0.50 to be moving again. Between the two nothing changes, so a wobble on
    // the threshold cannot chatter.
    if(r < 0.22)      this.stillFor += dt;
    else if(r > 0.50) this.stillFor = 0;
    this.resting = this.stillFor > 0.5;              // 0.5 s of holding, not a zero crossing
    // Open in 0.30 s so a real inhale is not audibly late; close in 0.60 s so
    // the sound settles rather than cutting.
    const want = this.resting ? 0 : 1;
    this.restGate = lp(this.restGate, want, dt, want ? 0.30 : 0.60);
  },

  detectCycle(sN, t){
    // Hysteresis scaled to how deeply this user breathes. A fixed threshold is
    // a different test for a deep breather than a shallow one: on the first
    // real recording 0.34 was 19% of a typical stroke, and 50 of 57 exhale
    // bottoms cleared it more than 0.6 s before the signal reached half a
    // stroke. The floor keeps shallow breathers detectable, the ceiling stops
    // a few deep sighs from making the detector numb.
    const H = clamp(this.strokeAmp*0.30, 0.30, 0.80);
    if(this.rising){
      if(sN > this.extreme){ this.extreme=sN; this.extremeT=t; }
      else if(sN < this.extreme - H){                 // that was a peak
        this.lastPeakT = this.extremeT;
        this.peakS = this.extreme;
        this.learnAmp();
        if(this.lastTroughT) this.inhaleDur = this.lastPeakT - this.lastTroughT;
        this.rising=false; this.extreme=sN; this.extremeT=t;
        if(this.onExhaleStart) this.onExhaleStart(this.inhaleDur, this.exhaleDur);
      }
    }else{
      if(sN < this.extreme){ this.extreme=sN; this.extremeT=t; }
      else if(sN > this.extreme + H){                 // that was a trough
        const prevTrough = this.lastTroughT;
        this.lastTroughT = this.extremeT;
        this.troughS = this.extreme;
        this.learnAmp();
        if(this.lastPeakT) this.exhaleDur = this.lastTroughT - this.lastPeakT;
        if(prevTrough){
          const p = this.lastTroughT - prevTrough;
          if(p>3 && p<30){
            this.periods.push(p);
            if(this.periods.length > 6) this.periods.shift();
            this.period = this.period ? lerp(this.period, p, 0.45) : p;
            this.bpm = 60/this.period;
            this.bpmSmooth = this.bpmSmooth ? lerp(this.bpmSmooth, this.bpm, 0.4) : this.bpm;
            this.omega = TAU/this.period;
          }
        }
        this.rising=true; this.extreme=sN; this.extremeT=t;
      }
    }
  },

  /** Track how deep this user's breaths are, so the hysteresis can scale with
      them. Bounds reject a half-stroke caught mid-drift and a sigh; alpha 0.25
      settles over about four breaths, slow enough that one deep sigh does not
      move the threshold out from under the next ordinary breath. */
  learnAmp(){
    if(this.peakS === null || this.troughS === null) return;
    const amp = Math.abs(this.peakS - this.troughS);
    if(amp > 0.35 && amp < 3.6) this.strokeAmp = lerp(this.strokeAmp, amp, 0.25);
  },

  /** Follow the dominant direction of belly movement, continuously.

      The covariance forgets exponentially, so the axis is an estimate over the
      last half-minute rather than a decision taken once at the start. Early on
      it averages everything it has seen instead (1/n), which converges in a
      few seconds rather than a few time constants — the sound needs a
      direction to follow before the user has taken two breaths.

      The power iteration is warm-started from the axis already in use, so it
      costs a handful of rounds and the estimate cannot jump between refreshes.
  */
  trackAxis(d, dt, t){
    this.covSeen++;
    const a = Math.max(1/this.covSeen, 1 - Math.exp(-dt/25.0));
    // Covariance about the mean, not about zero. Steady postural drift leaves a
    // standing offset in d — 0.6 m/s^2 per minute puts 0.12 m/s^2 through a
    // 12 s high-pass, which is larger than a breath — and a covariance taken
    // about zero locks the axis onto that offset instead of onto the breathing.
    for(let i=0;i<3;i++) this.dMean[i] += (d[i] - this.dMean[i])*a;
    const c = [d[0]-this.dMean[0], d[1]-this.dMean[1], d[2]-this.dMean[2]];
    for(let i=0;i<3;i++)
      for(let j=0;j<3;j++)
        this.cov[i][j] += (c[i]*c[j] - this.cov[i][j])*a;

    if(t - this.lastTrack < 0.4) return;
    this.lastTrack = t;

    const C = this.cov;
    let v = this.u.slice();
    for(let k=0;k<8;k++){
      const w=[
        C[0][0]*v[0]+C[0][1]*v[1]+C[0][2]*v[2],
        C[1][0]*v[0]+C[1][1]*v[1]+C[1][2]*v[2],
        C[2][0]*v[0]+C[2][1]*v[1]+C[2][2]*v[2]
      ];
      const m=Math.hypot(w[0],w[1],w[2]);
      if(m<1e-14) return;                 // nothing has moved yet
      v=[w[0]/m,w[1]/m,w[2]/m];
    }
    // The eigenvalue is the variance along the axis, so its root is the size of
    // a breath in m/s^2 — the one number here that means something physical,
    // and the one that tells a belly from a table.
    const Av=[
      C[0][0]*v[0]+C[0][1]*v[1]+C[0][2]*v[2],
      C[1][0]*v[0]+C[1][1]*v[1]+C[1][2]*v[2],
      C[2][0]*v[0]+C[2][1]*v[1]+C[2][2]*v[2]
    ];
    this.axisAmp = Math.sqrt(Math.max(0, v[0]*Av[0]+v[1]*Av[1]+v[2]*Av[2]));

    // Keep the sign continuous with what is already playing. An axis that
    // flips inverts the sound mid-breath, which is far worse than being
    // upside down consistently.
    const dot = v[0]*this.u[0] + v[1]*this.u[1] + v[2]*this.u[2];
    this.u = dot < 0 ? [-v[0],-v[1],-v[2]] : v;
  },

  /** Which way round is the axis? Relaxed breathing usually exhales more
      slowly than it inhales, so the slower half should be the falling one.
      Decided once, when there is finally enough signal to decide it on, and
      then left alone unless tracking is lost for a good while — a sign that
      changes mid-session is indistinguishable from the user turning over. */
  resolveSign(){
    if(this.signSet || this.periods.length < 2) return;
    this.signSet = true;
    if(this.exhaleDur > 0 && this.inhaleDur > 0 && this.exhaleDur < this.inhaleDur*0.8){
      this.u = [-this.u[0],-this.u[1],-this.u[2]];
      this.flipped = true;
    }
  },

  /** How much is this actually breathing?

      The app used to sonify whatever the accelerometer produced. A recording
      made with the phone on a table, then waved about, came back claiming 248
      breaths at 26 a minute. Three things separate that from a real session,
      each measured on real recordings before being written down here:

        size     a belly moves the gravity vector by 0.32-0.46 m/s^2 RMS along
                 the breath axis; a phone on a table managed 0.011
        pace     real sessions ran 11.8 s and 23.1 s per breath; the table and
                 the waving both produced 1.2-1.3 s
        rhythm   consecutive breaths differ by 1.09-1.29x when someone is
                 breathing, and 1.66-6.03x when the phone is just being moved

      Any one of them is enough to reject the bogus recording. Together they
      leave a wide margin, which matters because the cost of a false positive
      is the app confidently sonifying nothing.
  */
  scoreConfidence(dt){
    // size: how big the movement is, in m/s^2 on the breath axis. The sessions
    // recorded so far measured 0.32 and 0.45; a phone left on a table measured
    // 0.007. Where to put the line between them depends on the body and where
    // the phone sits, so sensitivity moves it rather than a constant deciding.
    const floor = lerp(0.030, 0.004, this.sensitivity);
    const small = clamp((this.axisAmp - floor)/(floor*1.9), 0, 1);
    // ...and an upper bound, which the bogus recording is the reason for: being
    // picked up and waved put 6.4 m/s^2 on the axis. A belly does not do that,
    // so past about 1.2 this is a phone being handled, not a breath.
    const big = clamp((2.6 - this.axisAmp)/1.4, 0, 1);
    const size = small*big;

    // rhythm: how alike are consecutive breaths? Until three periods exist
    // there is no evidence either way, so this caps at 0.30 rather than
    // assuming the best — that cap is what keeps a waved phone below the bar
    // for reporting a rate during the seconds before its erratic periods
    // accumulate. The sound does not wait for this; `follow` does not use it.
    let rhythm = 0.30;
    const P = this.periods;
    if(P.length >= 3){
      const tol = lerp(1.45, 2.70, this.sensitivity);
      let sum = 0;
      for(let i=1;i<P.length;i++){
        const r = Math.max(P[i],P[i-1])/Math.min(P[i],P[i-1]);
        sum += clamp((tol - r)/(tol*0.34), 0, 1);
      }
      rhythm = sum/(P.length-1);
    }

    // stillness: a phone being carried or waved is not reporting a breath.
    const calm = clamp((1.1 - this.motionRms)/0.7, 0, 1);

    // The sound only needs to know there is real movement to follow, and it
    // needs to know it in seconds rather than in breaths.
    const wantFollow = size * calm;
    this.follow = lp(this.follow, wantFollow, dt, wantFollow > this.follow ? 3.0 : 1.5);

    // Reporting a rate is a stronger claim and waits for the rhythm to back it.
    const want = wantFollow * rhythm;
    this.conf = lp(this.conf, want, dt, want > this.conf ? 6.0 : 2.0);

    if(this.conf > 0.5) this.resolveSign();
    // If it has been lost for a long time the user has probably moved, so let
    // the next lock decide the direction again.
    this.lostFor = this.conf < 0.15 ? this.lostFor + dt : 0;
    if(this.lostFor > 45) this.signSet = false;
  },

  /** 0 = fully exhaled, 1 = fully inhaled */
  level(){ return clamp((this.s+1)/2, 0, 1); },
  /** 0..1 how quickly the belly is moving. Gated by restGate so a held breath
      reads as stillness rather than as a faint stroke. */
  speed(){ return clamp(Math.abs(this.dsLp)/2.4, 0, 1) * this.restGate; },
  /** signed belly velocity, -1..1; positive while inhaling */
  vel(){ return clamp(this.dsLp/2.4, -1, 1) * this.restGate; },
  quality(){
    const b=this.breathRms, m=this.motionRms;
    if(b<=0) return 0;
    return clamp(b/(b + m*2.2 + 0.004), 0, 1);
  }
};
