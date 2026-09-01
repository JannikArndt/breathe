import { clamp, lerp, lp, fin, TAU } from './util.js';

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
  lastT:0, lastDt:1/60, samples:0, seen:0, lastEventT:0,
  motionRms:0, breathRms:0,

  // ---- continuous axis tracking
  // Exponentially-forgetting covariance of d. tau = 25 s spans one or two
  // breaths at the rates this is used at, which is long enough to be a
  // direction rather than an instant and short enough to follow a shift.
  cov:[[0,0,0],[0,0,0],[0,0,0]], dMean:[0,0,0],
  covSeen:0, lastTrack:0,

  // ---- phase one: settling
  // Putting the phone down, or reaching over to tap Start, swings the gravity
  // vector by tens of degrees where a breath moves it by a fraction of one.
  // Fed to the filters that swing is a step, and a step through a high-pass is
  // a ramp several breaths long — so the first minute of the session is spent
  // watching an event that is already over. Two recordings made on a table
  // show it plainly: the tracker reported movement worth following (0.88 and
  // 1.00) from a phone that never moved at all, and locked its axis onto the
  // tap. Nothing is measured until the tilt has stopped moving.
  //
  // gFast and gSlow are the same gravity direction at two time constants, both
  // far slower than a breath; tiltDev is the angle between them, in degrees.
  gFast:[NaN,NaN,NaN], gSlow:[NaN,NaN,NaN],
  tiltDev:0, stillTilt:0, settled:false, sinceBegin:0,
  TAU_FAST:4, TAU_SLOW:12,   // s
  TILT_STILL:1.5,     // degrees between them. Measured below.
  SETTLE_WARM:1.0,    // s before the hold may start counting
  SETTLE_HOLD:2.0,    // s under that before the tracker starts listening
  SETTLE_CAP:45,      // s. It is a clean start, not a lock-out: past this the
                      // tracker listens anyway and the confidence gates decide.
  axisAmp:0,            // RMS of the projection, in m/s^2 — a physical quantity
  sRaw:0,               // the projection before the AGC, so it stays in m/s^2
  // Display only, and only while settling. The chain measures nothing yet, but
  // the phone is plainly moving and a flat line says the app is not looking —
  // which is what the first half-minute of a session looked like. sPre is the
  // gap between the smoothed vector and its 12 s copy, projected on the axis
  // in use, at a fixed scale rather than through the AGC: it is the movement
  // itself, in units of PRE_FULL, and it reaches nothing but the trace and the
  // recording. 0.5 m/s^2 is a little over the deepest breath measured here, so
  // a real breath reads as most of the lane and being picked up runs off it.
  sPre:0, PRE_FULL:0.5,
  signSet:false, lostFor:0,
  // Direction, resolved by watching the user breathe along with a reference
  // rather than by guessing from the shape of the breath. See resolveSign().
  leadDot:0, leadMag:0,
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
    this.leadDot=0; this.leadMag=0; this.sRaw=0; this.flipped=false;
    this.periods=[]; this.conf=0;
    this.gFast=[NaN,NaN,NaN]; this.gSlow=[NaN,NaN,NaN];
    this.tiltDev=0; this.stillTilt=0; this.sPre=0;
    this.settled=false; this.sinceBegin=0; this.seen=0;
  },

  /** feed one sensor sample. t in seconds. */
  push(x,y,z,t){
    this.lastEventT = t;
    let dt = this.lastT ? t-this.lastT : 1/60;
    this.lastT = t;
    if(!(dt>0) || dt>0.5) dt = 1/60;               // guard against stalls
    this.lastDt = dt;                              // Pulse reads this rather than re-deriving it
    this.samples++;
    // The first devicemotion event on this phone is not a reading. Both
    // sessions recorded on 1 September open with one: a phone lying flat and
    // untouched reported (1.81, -5.95, -7.81) before settling to (0, 0, -9.85)
    // one sample later, and every filter here is seeded from the first sample
    // it sees. Seeded from that, the smoothed vector starts 6 m/s^2 away from
    // the truth and the baseline walks back to it over the next twelve
    // seconds — which is the "sudden movement down" a session opened with.
    // Nothing is lost by waiting one event: at 60 Hz it is 17 ms.
    if(++this.seen === 1) return;

    // The baseline is a high-pass, and a high-pass turns a held breath into a
    // ramp. A recorded session at 3 breaths a minute holds the bottom for 5 to
    // 10 s: across a 10 s hold a tau = 12 s baseline has already climbed 57%
    // of the way back to the signal, so the app hears an inhale beginning
    // while the belly is still perfectly flat. Measured on that recording the
    // sound started swelling a median 1.9 s early and as much as 9.8 s early.
    // Three periods of headroom leaves under a tenth of that droop. The 12 s
    // floor is what fast breathing already used, so nothing moves for anyone
    // breathing at an ordinary rate. The ceiling was 60 s, which is three
    // periods only down to 20 s a breath — and a 60 s breath is the rate this
    // app is now asked to reach. It is 150 s: measured against the harness,
    // raising it changes nothing at all about the drift check (6.00/min at
    // both), the phone-on-a-table check, or the bogus recording, because a
    // *steady* standing offset is taken out by the covariance-about-the-mean
    // and by the AGC. The ceiling is there to bound a runaway, not to shape
    // the passband.
    const tauBase = clamp(3.0*(this.period || 4), 12, 150);

    const v=[x,y,z];
    for(let i=0;i<3;i++) this.smooth[i] = lp(this.smooth[i], v[i], dt, 0.35);

    this.trackSettle(v, dt);

    // Until the phone has settled the baseline is held on the smoothed vector,
    // so the deviation the rest of the chain reads is exactly zero and none of
    // the movement of being put down reaches the axis, the gain or the cycle
    // detector. Once it settles the baseline is already where it belongs and
    // the session opens from a flat line rather than from a ramp.
    for(let i=0;i<3;i++){
      this.base[i] = this.settled ? lp(this.base[i], this.smooth[i], dt, tauBase)
                                  : this.smooth[i];
    }
    // energy above the breath band = fidgeting; used for the signal meter
    let hi=0; for(let i=0;i<3;i++){ const e=v[i]-this.smooth[i]; hi+=e*e; }
    this.motionRms = lp(this.motionRms, Math.sqrt(hi), dt, 1.5);

    const d = [this.smooth[0]-this.base[0], this.smooth[1]-this.base[1], this.smooth[2]-this.base[2]];
    if(!isFinite(d[0])) return;

    // Still settling: report a flat line and no confidence rather than a guess.
    // The lead wave is what the user hears through this, so the session is not
    // silent — it is just not pretending to hear anything yet.
    if(!this.settled){
      this.s = 0; this.sPrev = 0; this.dsLp = 0; this.sRaw = 0;
      this.follow = 0; this.conf = 0; this.phase = 0;
      // ...but say so with the movement rather than with a flat line. See sPre.
      const q = isFinite(this.gSlow[0])
        ? (this.smooth[0]-this.gSlow[0])*this.u[0]
        + (this.smooth[1]-this.gSlow[1])*this.u[1]
        + (this.smooth[2]-this.gSlow[2])*this.u[2]
        : 0;
      this.sPre = clamp(fin(q, 0)/this.PRE_FULL, -1.8, 1.8);
      return;
    }
    // Handing over: the trace reads s from here on, and a stale sPre behind it
    // would draw the settling stretch twice.
    this.sPre = 0;

    this.trackAxis(d, dt, t);

    // ---- project onto the breath axis
    let s = d[0]*this.u[0] + d[1]*this.u[1] + d[2]*this.u[2];
    if(this.invert) s = -s;
    this.breathRms = lp(this.breathRms, Math.abs(s), dt, 2.0);
    this.sRaw = s;

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
    // 0.087 rad/s is a 72 s breath, just past the detector's own ceiling.
    const w = clamp(this.omega, 0.087, 2.2);
    this.phase = Math.atan2(-this.dsLp/w, sN);
  },

  /** Phase one. Has the phone stopped being put down?

      The gravity vector is an absolute attitude reference — it says which way
      the phone is tilted, though not which way it faces. Putting it down is a
      *step* in that direction; breathing is an *oscillation* about it. So the
      test is not how fast the tilt is moving, which cannot tell those apart at
      a fast breathing rate, but how far apart two smoothed copies of it drift.
      Both time constants are far longer than a breath, so an oscillation moves
      them together and they stay within a degree of each other; a step pulls
      the 4 s copy off the 12 s one by tens of degrees for several seconds.

      A rate test was tried first and rejected: it separated the recordings in
      this repository cleanly, but only because they are all slow breathing.
      Against a synthetic 12 and 20 a minute at the same depth it never
      settled at all, because at those rates a breath alone moves the tilt
      faster than the threshold. The two-filter test settles a 3, 6, 12 and
      20 a minute wave alike.

      Measured over every recording here, with the first bogus event dropped:
      everything that was already lying still settles at the 3 s floor — a
      phone on a table, the sessions that opened on the belly, and the session
      the owner called great; the session started with the phone in the hand
      runs to the 45 s cap, which is right, because it was in the hand that
      long; and three minutes of deliberate shaking never settles.

      The warm-up is one second and the hold two. It was four and two, which
      put a 6 s floor under a phone that was already down — too slow to open a
      session on. Dropping the warm-up altogether is a second too far: the
      bogus recording's peak confidence goes 0.14 -> 0.38, past the 0.35 that
      reports a rate. One second keeps every rejection and halves the wait.

      There is no way back: once a session has settled it stays settled.
      Shifting position mid-session is handled by the axis tracker and the AGC
      as it always was, not by dropping into phase one and going quiet. */
  trackSettle(v, dt){
    this.sinceBegin += dt;
    if(this.settled) return;
    if(!isFinite(this.gFast[0])){ this.gFast = v.slice(); this.gSlow = v.slice(); return; }
    let dd = 0;
    for(let i=0;i<3;i++){
      this.gFast[i] = lp(this.gFast[i], v[i], dt, this.TAU_FAST);
      this.gSlow[i] = lp(this.gSlow[i], v[i], dt, this.TAU_SLOW);
      const e = this.gFast[i] - this.gSlow[i];
      dd += e*e;
    }
    // arc length over 9.81 m/s^2, in degrees
    this.tiltDev = Math.sqrt(dd)/9.81*180/Math.PI;
    // Both filters are seeded from the same sample, so they start identical and
    // drift apart over a time constant. Without this the hold is satisfied by
    // the seeding alone and every session settles two seconds in, put down or not.
    const warm = this.sinceBegin > this.SETTLE_WARM;
    if(warm && this.tiltDev < this.TILT_STILL) this.stillTilt += dt;
    else this.stillTilt = 0;
    // The baseline has been pinned to the smoothed vector all along and the
    // gain has not run at all, so both start from where reset() left them: the
    // signal opens from a flat line at a plausible gain, with no step to ring
    // on and nothing to unwind. Seeding the gain lower here instead pins the
    // first two breaths of a real session against the clamp.
    if(this.stillTilt >= this.SETTLE_HOLD || this.sinceBegin >= this.SETTLE_CAP) this.settled = true;
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
    // Release has to outlast a hold or the reference decays during the pause it
    // is measuring, the ratio climbs, and the gate re-opens on nothing. A 30 s
    // release is two hold-lengths at 6 a minute and half of one at 1 a minute,
    // so it follows the rate: two periods, floored at the old value.
    const release = clamp(2.0*(this.period || 15), 30, 150);
    this.slopePeak = lp(this.slopePeak, v, dt, v > this.slopePeak ? 0.5 : release);
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
          // 3 s is the fast end and it is the load-bearing one: it rejects
          // the bogus recording's 1.2 s "breaths". The slow end never rejected
          // anything — a phone being carried does not produce one 60 s cycle,
          // let alone three alike — and it has twice been the thing that
          // discarded a real breath. 70 s is 0.86 a minute, past the 1/min the
          // app is asked to support.
          if(p>3 && p<70){
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

  /** Which way round is the axis, and how would anyone know?

      An eigenvector has no natural sign, and the seed the power iteration
      starts from — the screen normal — is very nearly orthogonal to the answer
      on a phone lying on a belly, so which of the two directions it lands on
      is settled by noise in the first seconds. Across five recorded sessions
      the axis came out along the same line every time, within 0.0, 1.6, 3.4
      and 9.5 degrees, and the *sign* was a coin flip. Both sessions the owner
      reported as inverted are the two that came out negative.

      What used to be here guessed from timing: relaxed breathing exhales more
      slowly than it inhales, so flip if the falling half is the quicker one.
      It never fired in any of the five recordings, including both inverted
      ones, and it could not have been trusted if it had. The detector measures
      the interval between turning points, so a pause lands inside whichever
      stroke it falls in; in the session the owner called great, 58% of the
      held time sits mid-wave rather than at either end. The asymmetry that
      test reads is the detector's, not the body's.

      The shape of the wave cannot answer it either, and neither can the
      phone's orientation: whether the phone tilts toward the head or the feet
      as the belly rises depends on where it is sitting relative to the fullest
      part of the curve. The belly's upward travel would settle it and is
      placement-independent, but at three breaths a minute and a centimetre of
      movement it is about 0.0005 m/s^2 against a tilt of 0.5 — three orders
      of magnitude under.

      So stop guessing and observe it. The session opens with a wave the user
      breathes along with (`lead()`), which means their inhale is a known
      quantity for those first breaths: correlate the measured signal against
      it and the direction falls out. Decided once and then left alone — a sign
      that changes mid-session is indistinguishable from the user turning over.
  */
  resolveSign(){
    if(this.signSet) return;
    // Below this there is not enough reference to judge on. Measured over the
    // first 30 s of each recording in recordings/, against a 6/min reference at
    // every phase, because theirs is unknown: the three belly sessions
    // accumulate 8.6, 77 and 135, a phone on a table 0.11 and the bogus
    // recording 0.13. The threshold sits eight times under the quietest real
    // session and eight times over a table, so it is not a close call either
    // way. Do not raise it to "be sure" — a shallow breather is the case it
    // would cost, and it already has eight times the margin it needs.
    if(this.leadMag < 1.0) return;
    const r = this.leadDot/this.leadMag;
    // The user may simply not have followed it, in which case this says
    // nothing and the Flip direction toggle stays the answer.
    if(Math.abs(r) < 0.20) return;
    this.signSet = true;
    if(r < 0){
      this.u = [-this.u[0],-this.u[1],-this.u[2]];
      this.flipped = true;
    }
  },

  /** Feed the reference the user is breathing along with, -1..1, once per
      motion sample. Weighted by the size of the measured signal in m/s^2, so
      the seconds before the axis has converged — when the projection is small
      because it is pointing the wrong way — count for little on their own. */
  lead(ref){
    if(!isFinite(ref) || !isFinite(this.sRaw)) return;
    const dt = this.lastDt;
    this.leadDot += this.sRaw*ref*dt;
    this.leadMag += Math.abs(this.sRaw)*Math.abs(ref)*dt;
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
