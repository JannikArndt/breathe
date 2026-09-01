/* =========================================================================
   5b. HEART RATE, AFTER THE FACT
   =========================================================================
   Pulse runs live during a session, but it is an experiment and it is off by
   default, so `hr` and `hrConf` are empty in almost every recording anyone
   owns. The raw 60 Hz accelerometer rows are not: ballistocardiography needs
   nothing but those, and they are stored in full. So the number can be
   recovered from a recording made long before the experiment was ever
   switched on, which is what this module does.

   It is the same estimator the live path uses — src/pulse.js, unmodified —
   fed the same way. Nothing here re-implements the DSP, because a second
   implementation that quietly disagreed with the first would be worse than no
   number at all.

   Two things it does not do:

   - It does not touch the live Pulse. That object holds a session's filter
     state and the user's own enable flag, and this runs while a recording is
     open on screen; borrowing it would leave the next session's estimator
     primed with someone else's heartbeat. `Object.create` plus `reset()` is a
     fully isolated instance, because reset() assigns every stateful field.

   - It does not run the breath tracker. `reading()` refuses whenever
     `motionRms` is over MAX_MOTION, and motionRms is only a tau = 0.35 s
     smoothing of the raw vector and a tau = 1.5 s average of what is left
     over — twenty lines of Breath.push out of five hundred. Running the whole
     tracker to get it would double the work of an already slow pass for
     nothing.

   The pass is chunked and yields to the event loop between chunks. A
   thirteen-minute session is ~48 000 rows; done in one go that is a visible
   stall on the screen it is drawing into.
   ========================================================================= */

import { lp } from './util.js';
import { Pulse } from './pulse.js';

export const HR = {
  /** s between reported points. The estimator itself recomputes at most once
      a second (see Pulse.push), so asking more often than this would return
      the same number under a different timestamp. */
  STEP: 1.0,

  /** motion rows per slice. ~4000 is about 65 s of a 60 Hz recording and lands
      near 8 ms of work on the phones this app targets, so a slice fits inside
      a frame and the lane it is drawing into keeps redrawing. */
  CHUNK: 4000,

  /** Below this the estimator is not claiming to have found anything, and the
      line must break rather than be drawn through. Same threshold the live
      readout uses, so the two mean the same thing. */
  MIN_CONF: Pulse.MIN_CONF,

  /**
   * @param rows  motion.rows: [t, x, y, z], seconds and m/s^2
   * @param opts.signal  optional {cancelled:boolean} — checked between slices
   * @param opts.onProgress  optional (0..1)
   * @returns Promise<{n, t, bpm, conf}> typed arrays, one point per STEP.
   *          bpm is 0 wherever the estimator declined, and conf says why:
   *          a real 0 means it never locked, and the caller breaks the line.
   */
  async estimate(rows, opts){
    const o = opts || {};
    const out = {n:0, t:null, bpm:null, conf:null};
    if(!rows || rows.length < 2) return out;

    // Isolated estimator: same code, its own state.
    const P = Object.create(Pulse);
    P.reset();
    P.enabled = true;

    const cap = Math.ceil(((+rows[rows.length-1][0] - +rows[0][0]) / this.STEP) + 2);
    const ts = new Float32Array(cap), bs = new Float32Array(cap), cs = new Float32Array(cap);
    let k = 0;

    // motionRms, exactly as Breath.push computes it.
    const sm = [+rows[0][1] || 0, +rows[0][2] || 0, +rows[0][3] || 0];
    let motionRms = 0, nextAt = +rows[0][0] || 0, prevT = +rows[0][0] || 0;

    for(let i = 0; i < rows.length; i++){
      const r = rows[i];
      const t = +r[0] || 0, x = +r[1] || 0, y = +r[2] || 0, z = +r[3] || 0;
      // Same guard the tracker uses: a stalled sensor must not divide by zero,
      // and a gap must not be integrated as if it were one long step.
      const dt = i ? Math.min(Math.max(t - prevT, 0.001), 0.5) : 1/60;
      prevT = t;

      const v = [x, y, z];
      let hi = 0;
      for(let j = 0; j < 3; j++){
        sm[j] = lp(sm[j], v[j], dt, 0.35);
        const e = v[j] - sm[j];
        hi += e*e;
      }
      motionRms = lp(motionRms, Math.sqrt(hi), dt, 1.5);

      P.push(Math.hypot(x, y, z), dt, t);

      if(t >= nextAt && k < cap){
        ts[k] = t;
        bs[k] = P.reading(motionRms);
        cs[k] = P.conf;
        k++;
        nextAt = t + this.STEP;
      }

      if((i % this.CHUNK) === this.CHUNK - 1){
        if(o.signal && o.signal.cancelled) return out;
        if(o.onProgress) o.onProgress(i / rows.length);
        // Hand the frame back. A microtask is not enough — it would run before
        // the browser paints, which is the whole thing this is avoiding.
        await new Promise(res => setTimeout(res, 0));
      }
    }

    if(o.signal && o.signal.cancelled) return out;
    if(o.onProgress) o.onProgress(1);
    out.n = k; out.t = ts; out.bpm = bs; out.conf = cs;
    return out;
  },

  /** Median of the points that actually reported, and how many did. Median
      rather than mean because a single octave slip — the failure this
      estimator has, see CLAUDE.md 4a2 — drags a mean and not a median. */
  summary(est){
    if(!est || !est.n) return {bpm:0, reported:0, of:0};
    const v = [];
    for(let i = 0; i < est.n; i++)
      if(est.bpm[i] > 0 && est.conf[i] >= this.MIN_CONF) v.push(est.bpm[i]);
    if(!v.length) return {bpm:0, reported:0, of:est.n};
    v.sort((a, b) => a - b);
    return {bpm: v[v.length >> 1], reported: v.length, of: est.n};
  }
};
