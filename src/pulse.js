import { clamp, lerp, lp } from './util.js';

/* ============================================================
   3. PULSE — heartbeat from the same accelerometer, experimental
   ------------------------------------------------------------
   Every heartbeat moves a few grams of blood, and the reaction shows
   up in the phone as a tiny acceleration. This is ballistocardiography,
   and on a phone resting on a belly the signal is orders of magnitude
   below breathing: micro-g against the 0.09 m/s^2 of a belly rise. It
   is also fragile — a swallow, a shift, a hand on the phone all bury it.

   So the approach is not "measure the heart rate" but "say a number
   only when the evidence is unambiguous, and say nothing otherwise":

     band-pass 4-14 Hz    breathing and posture are below, sensor
                          noise above; the sharp part of each beat
                          (the J-wave) survives
     envelope             |x| smoothed at 60 ms, so each beat becomes
                          one bump rather than an oscillation
     autocorrelation      over lags for 40-140 bpm, on 12 s of envelope
     confidence gate      the peak must clearly beat the rest of the
                          curve, and the body must be still

   It reports nothing far more often than it reports a number. That is
   the intended behaviour, not a failure to tune.
   ============================================================ */
export const Pulse = {
  HZ: 40,              // envelope decimated to this before autocorrelation
  WIN: 12,             // s of envelope held; 12 s spans 8 beats at 40 bpm
  MIN_BPM: 40, MAX_BPM: 140,
  // A real beat stands well above the rest of the autocorrelation curve and
  // noise does not. 0.20 keeps false positives out at the cost of long
  // silences, which is the right trade for a number nobody should act on.
  MIN_CONF: 0.20,
  // Above this much broadband motion the body is not still enough for the
  // beat to survive. Same units as Breath.motionRms (m/s^2).
  //
  // This was 0.05, which is below the noise floor of a still human being: a
  // 9.5-minute recording of someone lying quietly with the phone on the belly
  // sits at 0.084 median, 0.117 at the 95th percentile. The gate therefore
  // returned 0 for the entire session, every session, and the readout could
  // never show anything at all. 0.25 clears a still body twice over and still
  // sits five times under a phone being carried, which measured 1.28.
  MAX_MOTION: 0.25,

  enabled:false,
  hp:0, hp2:0, bp:0, env:0, envSlow:0,   // filter state
  buf:null, n:0, filled:false,
  acc:0,                       // decimation accumulator
  bpm:0, conf:0, lastCalc:0,

  reset(){
    this.hp=0; this.hp2=0; this.bp=0; this.env=0; this.envSlow=0;
    this.buf = new Float32Array(this.HZ*this.WIN);
    this.n=0; this.filled=false; this.acc=0;
    this.bpm=0; this.conf=0; this.lastCalc=0;
  },

  /** @param mag |acceleration| in m/s^2  @param dt seconds  @param t seconds */
  push(mag, dt, t){
    if(!this.enabled) return;
    if(!this.buf) this.reset();

    // High-pass at 4 Hz, twice. One pole is 6 dB/octave, and breathing at
    // 0.17 Hz is only 4.6 octaves down, so a single pole leaves about -27 dB of
    // it — enough that rectifying the result produced an envelope dominated by
    // the breath, with no beat visible in it at all. Two poles make that -55 dB.
    // tau = 1/(2*pi*f).
    this.hp  = lp(this.hp,  mag,           dt, 0.0398);
    const h1 = mag - this.hp;
    this.hp2 = lp(this.hp2, h1,            dt, 0.0398);
    const hi = h1 - this.hp2;
    this.bp  = lp(this.bp,  hi,            dt, 0.0114);   // and above 14 Hz removed

    // 60 ms envelope: long enough to merge the ring of one beat into a single
    // bump, short enough to keep two apart at 140 bpm (430 ms between beats).
    this.env = lp(this.env, Math.abs(this.bp), dt, 0.060);
    // Rectification folds whatever slow modulation survived back into the
    // envelope, so take it out again: anything under about 0.45 Hz is not a
    // heartbeat at 40 bpm or more.
    this.envSlow = lp(this.envSlow, this.env, dt, 0.35);
    const e = this.env - this.envSlow;

    this.acc += dt;
    const step = 1/this.HZ;
    while(this.acc >= step){
      this.acc -= step;
      this.buf[this.n] = e;
      this.n = (this.n+1) % this.buf.length;
      if(this.n === 0) this.filled = true;
    }

    // Recomputing every sample would cost 60 autocorrelations a second for a
    // number that cannot change faster than a heartbeat.
    if(this.filled && t - this.lastCalc >= 1.0){ this.lastCalc = t; this.estimate(); }
  },

  /** autocorrelation of the mean-removed envelope over the plausible lags */
  estimate(){
    const b = this.buf, N = b.length;
    const x = new Float32Array(N);                 // unwrap the ring
    for(let i=0;i<N;i++) x[i] = b[(this.n+i)%N];

    let mean=0; for(let i=0;i<N;i++) mean += x[i];
    mean /= N;
    let e0=0; for(let i=0;i<N;i++){ x[i]-=mean; e0 += x[i]*x[i]; }
    if(e0 <= 1e-20){ this.bpm=0; this.conf=0; return; }

    // Compute one lag either side of the search range too, so the lags at the
    // edges can still be tested for being local maxima.
    const loLag = Math.max(2, Math.floor(this.HZ*60/this.MAX_BPM) - 1);
    const hiLag = Math.min(N-2, Math.ceil(this.HZ*60/this.MIN_BPM) + 1);
    const r = new Float32Array(hiLag+2);
    let sum=0, cnt=0;
    for(let L=loLag; L<=hiLag; L++){
      let c=0;
      for(let i=0;i+L<N;i++) c += x[i]*x[i+L];
      // normalise by the overlap as well as the energy, or long lags are
      // penalised purely for having fewer terms in the sum
      r[L] = c/e0 * (N/(N-L));
      sum += r[L]; cnt++;
    }
    if(cnt===0){ this.bpm=0; this.conf=0; return; }

    // Take the best *local* maximum, not the global one. The envelope is
    // smoothed at 60 ms, so neighbouring samples are strongly correlated and
    // the autocorrelation decays monotonically away from zero lag — the global
    // maximum is therefore always the shortest lag tried, whatever the actual
    // rate. A period shows up as a bump on that slope, and only a bump.
    const minLag = Math.floor(this.HZ*60/this.MAX_BPM);
    const maxLag = Math.ceil (this.HZ*60/this.MIN_BPM);
    const from = Math.max(loLag+1, minLag), to = Math.min(hiLag-1, maxLag);
    let best=-Infinity, bestLag=0;
    for(let L=from; L<=to; L++){
      if(r[L] >= r[L-1] && r[L] >= r[L+1] && r[L] > best){ best=r[L]; bestLag=L; }
    }
    if(!bestLag){ this.bpm=0; this.conf=0; return; }

    // Every beat also lands on the bump at twice its period, and the two are
    // often within a few percent of each other. Left alone the estimator
    // alternates between a rate and half of it, and the smoothing below then
    // parks on an average that is neither. Prefer the shortest lag that is
    // nearly as strong as the strongest.
    for(let L=from; L<bestLag; L++){
      if(r[L] >= r[L-1] && r[L] >= r[L+1] && r[L] >= best*0.80){ bestLag=L; best=r[L]; break; }
    }

    // Confidence: how far the winning bump stands above the average of every lag
    // tried. A periodic envelope gives one clear bump; noise gives a curve with
    // nothing on it, and the two look nothing alike on this measure.
    const conf = clamp(best - sum/cnt, 0, 1);

    // Parabolic interpolation, so the answer is not quantised to the 20 Hz grid
    // (one sample is 6 bpm at 60 bpm, which would be visible).
    let lag = bestLag;
    if(bestLag>loLag && bestLag<hiLag-1){
      const a=r[bestLag-1], c0=r[bestLag], c2=r[bestLag+1];
      const den = a - 2*c0 + c2;
      if(Math.abs(den) > 1e-9) lag = bestLag - 0.5*(c2-a)/den;
    }
    const bpm = 60*this.HZ/lag;
    this.conf = conf;
    if(conf >= this.MIN_CONF && bpm >= this.MIN_BPM && bpm <= this.MAX_BPM){
      // Smooth small movements, but take a big change outright. Blending across
      // a jump would report the midpoint of two candidate rates, which is a
      // number the heart never had.
      const jumped = !this.bpm || Math.abs(bpm - this.bpm) > this.bpm*0.20;
      this.bpm = jumped ? bpm : lerp(this.bpm, bpm, 0.35);
    }else{
      this.bpm = 0;
    }
  },

  /** the number to show, or 0 when there is nothing worth showing */
  reading(motionRms){
    if(!this.enabled) return 0;
    if(motionRms > this.MAX_MOTION) return 0;
    return this.bpm;
  }
};
