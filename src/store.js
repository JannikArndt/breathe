import { fin } from './util.js';

/* ============================================================
   4. RECORDER + STORE
   ------------------------------------------------------------
   Every session records, with no toggle, so the breath detector can
   later be tested against real breathing instead of synthetic tilt.

   Two shapes are involved and they are deliberately not the same:

     stored     columnar typed arrays in IndexedDB.
                motion   4 B uint32 ms + 3 x 4 B float32  = 16 B/sample
                derived  4 B uint32 ms + 8 x 4 B float32  = 36 B/row
     exported   the `breathe-session/1` JSON in the contract: rows as
                arrays of rounded numbers, roughly 2x the stored size.

   Store.put() packs, Store.get() unpacks, and nothing outside this
   section ever has to know the columnar form exists.

   Sizing for the longest session we expect, 20 min at 60 Hz:
     motion    72 000 samples x 16 B = 1.15 MB
     derived   12 000 rows    x 36 B = 0.43 MB
                                       ~1.6 MB stored, ~3 MB exported
   At the 48 MB budget below that is about thirty full-length sessions.
   When the budget is exceeded the oldest whole recording is deleted.
   The raw motion channel is never thinned, because the raw signal is
   the only reason any of this is worth keeping.

   Float32 for the axes is not a compromise: its relative precision at
   9.8 m/s^2 is ~6e-7 m/s^2, and the iPhone accelerometer's own
   quantisation step is ~1e-3 m/s^2. The 4 dp export rounding is
   likewise finer than the hardware, so the export is lossless with
   respect to the sensor.

   Nothing here touches indexedDB, navigator or document at definition
   time — same rule as Audio.
   ============================================================ */

export const Store = {
  DB_NAME:'tide', DB_VER:2,

  /* Optimistic until open() has actually decided. */
  available:true,
  opened:false,
  lastError:null,

  /* 48 MB ~= 30 sessions of 20 min. Lowered in open() if the origin's
     quota is smaller than that; see _fitBudget(). */
  budgetBytes: 48*1024*1024,

  FORMAT:'breathe-session/1',
  MOTION_COLUMNS:['t','x','y','z'],
  DERIVED_COLUMNS:['t','s','level','phase','bpm','quality','rich','hr','hrConf','rest'],
  DERIVED_HZ:10,

  /* Fixed vocabulary, kept for reading recordings made before the trim. The
     app no longer writes labels; see setTrim. */
  LABEL_KINDS:['lay-down','settled','sat-up','phone-moved','talking',
               'drifted-off','bad-detection','good-stretch','other'],

  _db:null, _openP:null,

  /* ---------- lifecycle ---------- */

  /** Safe to call repeatedly; resolves whether or not the store works. */
  open(){
    if(this._openP) return this._openP;
    const self = this;
    this._openP = new Promise(function(resolve){
      let settled = false;
      const giveUp = function(why){
        if(settled) return; settled = true;
        self.available = false; self.opened = false; self.lastError = why;
        resolve();
      };

      let idb = null;
      // Accessing indexedDB itself throws in Firefox private browsing.
      try{ idb = (typeof indexedDB !== 'undefined') ? indexedDB : null; }
      catch(e){ giveUp('blocked:' + ((e && e.name) || 'unknown')); return; }
      if(!idb){ giveUp('unsupported'); return; }

      let req;
      try{ req = idb.open(self.DB_NAME, self.DB_VER); }
      catch(e){ giveUp('blocked:' + ((e && e.name) || 'unknown')); return; }

      // Sandboxed frames sometimes never settle the request at all, so the
      // app must not wait on it forever.
      const timer = setTimeout(function(){ giveUp('timeout'); }, 8000);

      req.onupgradeneeded = function(ev){
        const db = ev.target.result;
        // meta holds everything except the sample arrays, so the session
        // browser and a label edit never read a megabyte off disk.
        if(!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath:'id'});
        if(!db.objectStoreNames.contains('data')) db.createObjectStore('data', {keyPath:'id'});
        // v2. One row, key 'settings'. It shares the database with the
        // recordings because IndexedDB is the only store this app is allowed,
        // and a second database for one object would be a second thing that
        // can fail to open.
        if(!db.objectStoreNames.contains('prefs')) db.createObjectStore('prefs');
      };
      req.onsuccess = function(){
        clearTimeout(timer);
        if(settled){ try{ req.result.close(); }catch(e){} return; }
        settled = true;
        self._db = req.result;
        self.available = true; self.opened = true; self.lastError = null;
        self._db.onclose = function(){ self._db = null; self.opened = false; self._openP = null; };
        self._db.onversionchange = function(){ try{ self._db.close(); }catch(e){} };
        self._fitBudget();
        resolve();
      };
      req.onerror = function(){
        clearTimeout(timer);
        giveUp('open:' + ((req.error && req.error.name) || 'unknown'));
      };
      req.onblocked = function(){ clearTimeout(timer); giveUp('blocked'); };
    });
    return this._openP;
  },

  /** Never claim more of the origin's quota than a quarter of it. */
  _fitBudget(){
    try{
      if(typeof navigator === 'undefined') return;
      if(!navigator.storage || !navigator.storage.estimate) return;
      const self = this;
      navigator.storage.estimate().then(function(est){
        if(!est || !est.quota) return;
        const fit = Math.max(8*1024*1024, Math.floor(est.quota*0.25));
        if(fit < self.budgetBytes) self.budgetBytes = fit;
      }, function(){});
    }catch(e){}
  },

  /**
   * Run one transaction. `body(stores, tx)` may return a thunk; its value
   * becomes the resolution once the transaction commits. Resolves null on
   * any failure — this never throws, because a storage problem must not be
   * able to interrupt a breathing session.
   */
  _run(names, mode, body){
    const self = this;
    return this.open().then(function(){
      if(!self.available || !self._db) return null;
      return new Promise(function(resolve){
        let tx;
        try{ tx = self._db.transaction(names, mode); }
        catch(e){ self.lastError = 'tx:' + ((e && e.name) || 'unknown'); resolve(null); return; }

        const st = {};
        for(let i=0;i<names.length;i++) st[names[i]] = tx.objectStore(names[i]);

        let fin = null;
        tx.oncomplete = function(){ resolve(fin ? fin() : null); };
        tx.onabort = tx.onerror = function(){
          self.lastError = 'tx:' + ((tx.error && tx.error.name) || 'aborted');
          resolve(null);
        };
        try{ fin = body(st, tx) || null; }
        catch(e){
          self.lastError = 'tx:' + ((e && e.name) || 'unknown');
          try{ tx.abort(); }catch(e2){}
        }
      });
    });
  },

  /* ---------- reads ---------- */

  /** Meta only, newest first. No sample arrays are touched. */
  list(){
    return this._run(['meta'],'readonly', function(st){
      const r = st.meta.getAll();
      let out = [];
      r.onsuccess = function(){ out = r.result || []; };
      return function(){
        out.sort(function(a,b){
          return a.startedAt < b.startedAt ? 1 : (a.startedAt > b.startedAt ? -1 : 0);
        });
        return out;
      };
    }).then(function(v){ return v || []; });
  },

  /**
   * Full session in export shape.
   * @param opts.motion   false to leave motion.rows empty (the session
   *                      browser plots `derived`, so it should pass this)
   * @param opts.derived  false to leave derived.rows empty
   * @param opts.cols     true to return typed-array columns instead of rows
   */
  get(id, opts){
    const o = opts || {};
    const wantM = o.motion !== false, wantD = o.derived !== false, asCols = o.cols === true;
    return this._run(['meta','data'],'readonly', function(st){
      const rm = st.meta.get(id), rd = st.data.get(id);
      let meta = null, data = null;
      rm.onsuccess = function(){ meta = rm.result || null; };
      rd.onsuccess = function(){ data = rd.result || null; };
      return function(){
        if(!meta) return null;
        return Store._assemble(meta, data, wantM, wantD, asCols);
      };
    });
  },

  usage(){
    const self = this;
    return this.list().then(function(metas){
      let bytes = 0;
      for(let i=0;i<metas.length;i++) bytes += metas[i].bytes || 0;
      return {count:metas.length, bytes:bytes, budget:self.budgetBytes,
              pct: self.budgetBytes ? bytes/self.budgetBytes : 0};
    });
  },

  /* ---------- settings ----------
     Read once at startup, written on every change. Both sides swallow their
     own failures: losing a slider position is an annoyance, and nothing about
     it is worth showing a user mid-session, let alone interrupting one. */

  /** @returns Promise<object> — {} when there is nothing saved or no store. */
  readPrefs(){
    return this._run(['prefs'], 'readonly', function(st){
      const req = st.prefs.get('settings');
      return function(){ return (req.result && typeof req.result === 'object') ? req.result : {}; };
    }).then(function(v){ return v || {}; });
  },

  /* ---------- the trim ----------
     Which stretch of a recording is worth reading. Every session begins with
     someone putting the phone down and ends with them picking it up, and those
     two minutes of handling are worth more than the rest of the session put
     together at throwing an analysis off.

     It replaced a vocabulary of nine label kinds and a free-text note, which
     asked the user to describe a recording when all they ever wanted to say was
     where the good part starts and stops. Metadata only: it never touches the
     samples, so marking a recording cannot cost you one. */

  /** @param trim {fromSec, toSec} — or null to mark the whole recording usable */
  setTrim(id, trim){
    const t = this._cleanTrim(trim);
    return this._editMeta(id, function(meta){ meta.trim = t; })
               .then(function(){ return t; });
  },

  _cleanTrim(t){
    if(!t) return null;
    const a = rnd(t.fromSec, 3), b = rnd(t.toSec, 3);
    const from = (typeof a === 'number' && isFinite(a) && a > 0) ? a : 0;
    const to   = (typeof b === 'number' && isFinite(b) && b > from) ? b : 0;
    if(!from && !to) return null;
    return {fromSec: from, toSec: to};
  },

  /** Whole-object write. There are a dozen values and they change on a slider
      drag, so a read-modify-write per key would be far more traffic than
      replacing the row. */
  writePrefs(obj){
    return this._run(['prefs'], 'readwrite', function(st){
      st.prefs.put(obj, 'settings');
    });
  },

  /* ---------- writes ---------- */

  /**
   * Persist a session. Accepts either shape for motion/derived: `rows`
   * (export shape) or `cols` (what Recorder produces).
   * @returns Promise<boolean> — false means it was not saved, and
   *          Store.lastError says why. Callers must not treat that as fatal.
   */
  put(session){
    const self = this;
    if(!session || !session.id){ this.lastError = 'no-session'; return Promise.resolve(false); }

    let packed;
    try{ packed = this._pack(session); }
    catch(e){ this.lastError = 'pack:' + ((e && e.name) || 'unknown'); return Promise.resolve(false); }

    return this.open().then(function(){
      if(!self.available) return false;
      return self._evictFor(packed.meta.bytes, packed.meta.id).then(function(){
        return self._write(packed);
      }).then(function(ok){
        if(ok) return true;
        // A quota rejection can still happen after eviction if something else
        // on the origin grew. Drop one more recording and try once more.
        if(String(self.lastError).indexOf('QuotaExceeded') < 0) return false;
        return self._evictOldest(1, packed.meta.id).then(function(dropped){
          if(!dropped) return false;
          return self._write(packed);
        });
      });
    });
  },

  _write(packed){
    const self = this;
    let refused = false;
    return this._run(['meta','data'],'readwrite', function(st){
      const prev = st.data.get(packed.meta.id);
      prev.onsuccess = function(){
        // A write that would replace samples with nothing is a caller handing
        // back a session it fetched without them — which is the ordinary shape
        // for every screen that only draws a summary. Keep what is there.
        // Recording is the one thing here that cannot be redone, so this is a
        // refusal rather than a merge: nothing but Recorder should ever be
        // writing a sample channel at all.
        const old = prev.result;
        if(old && !packed.data.mT.length && old.mT && old.mT.length){
          refused = true;
          self.lastError = 'refused: would have erased ' + old.mT.length + ' samples';
          return;
        }
        st.meta.put(packed.meta);
        st.data.put(packed.data);
      };
      return function(){ return !refused; };
    }).then(function(v){ return v === true; });
  },

  delete(id){
    return this._run(['meta','data'],'readwrite', function(st){
      st.meta.delete(id);
      st.data.delete(id);
      return function(){ return true; };
    }).then(function(){ return undefined; });
  },

  clear(){
    return this._run(['meta','data'],'readwrite', function(st){
      st.meta.clear();
      st.data.clear();
      return function(){ return true; };
    }).then(function(){ return undefined; });
  },

  /* ---------- labels ----------
     Labels live in the meta record, never in the sample arrays, so adding
     one is a read-modify-write of a few hundred bytes rather than of the
     whole recording. This is the path the labelling UI uses. */

  /** @returns Promise<labels[]|null> — null when the session is gone. */
  addLabel(id, label){
    const clean = this._cleanLabel(label);
    if(!clean) return Promise.resolve(null);
    return this._editMeta(id, function(meta){
      if(!meta.labels) meta.labels = [];
      meta.labels.push(clean);
      meta.labels.sort(function(a,b){ return a.tSec - b.tSec; });
    });
  },

  removeLabel(id, index){
    return this._editMeta(id, function(meta){
      if(meta.labels && index >= 0 && index < meta.labels.length) meta.labels.splice(index, 1);
    });
  },

  setLabels(id, labels){
    const self = this;
    return this._editMeta(id, function(meta){
      const out = [];
      for(let i=0;i<(labels||[]).length;i++){
        const c = self._cleanLabel(labels[i]);
        if(c) out.push(c);
      }
      out.sort(function(a,b){ return a.tSec - b.tSec; });
      meta.labels = out;
    });
  },

  _editMeta(id, mutate){
    const self = this;
    return this._run(['meta'],'readwrite', function(st){
      const r = st.meta.get(id);
      let meta = null;
      r.onsuccess = function(){
        meta = r.result || null;
        if(!meta) return;
        mutate(meta);
        meta.bytes = (meta.bytes || 0) - (meta.metaBytes || 0);
        meta.metaBytes = self._metaBytes(meta);
        meta.bytes += meta.metaBytes;
        st.meta.put(meta);
      };
      return function(){ return meta ? (meta.labels || []) : null; };
    });
  },

  _cleanLabel(l){
    if(!l || typeof l.tSec !== 'number' || !isFinite(l.tSec)) return null;
    const kind = this.LABEL_KINDS.indexOf(l.kind) >= 0 ? l.kind : 'other';
    let note = l.note == null ? '' : String(l.note);
    if(note.length > 200) note = note.slice(0, 200);   // a note, not a diary
    return {tSec: rnd(Math.max(0, l.tSec), 3), kind: kind, note: note};
  },

  /* ---------- eviction ----------
     One rule, so it can be stated in the interface: keep the newest
     `budgetBytes`, delete whole recordings oldest-first to make room.
     Never evict the recording being written. */

  _evictFor(incomingBytes, keepId){
    const self = this;
    return this.list().then(function(metas){
      let total = incomingBytes;
      const others = [];
      for(let i=0;i<metas.length;i++){
        if(metas[i].id === keepId) continue;      // an overwrite, not an addition
        total += metas[i].bytes || 0;
        others.push(metas[i]);
      }
      if(total <= self.budgetBytes) return 0;
      others.sort(function(a,b){ return a.startedAt < b.startedAt ? -1 : 1; });   // oldest first
      const doomed = [];
      for(let i=0;i<others.length && total > self.budgetBytes;i++){
        doomed.push(others[i].id);
        total -= others[i].bytes || 0;
      }
      return self._deleteMany(doomed);
    });
  },

  _evictOldest(n, keepId){
    const self = this;
    return this.list().then(function(metas){
      const others = metas.filter(function(m){ return m.id !== keepId; });
      others.sort(function(a,b){ return a.startedAt < b.startedAt ? -1 : 1; });
      return self._deleteMany(others.slice(0, n).map(function(m){ return m.id; }));
    });
  },

  _deleteMany(ids){
    if(!ids.length) return Promise.resolve(0);
    const self = this;
    return this._run(['meta','data'],'readwrite', function(st){
      for(let i=0;i<ids.length;i++){ st.meta.delete(ids[i]); st.data.delete(ids[i]); }
      return function(){ return ids.length; };
    }).then(function(n){
      self.evicted = (self.evicted || 0) + (n || 0);
      return n || 0;
    });
  },

  /* ---------- packing ---------- */

  _pack(session){
    const m = colsOf(session.motion,  4);
    const d = colsOf(session.derived, ((session.derived && session.derived.columns) || this.DERIVED_COLUMNS).length);
    const data = {
      id: session.id,
      mT: trim(m.t, m.n), mX: trim(m.v[0], m.n), mY: trim(m.v[1], m.n), mZ: trim(m.v[2], m.n),
      dT: trim(d.t, d.n), dV: d.v.map(function(a){ return trim(a, d.n); })
    };
    const meta = {
      id: session.id,
      format: this.FORMAT,
      startedAt: session.startedAt,
      durationSec: rnd(session.durationSec, 3),
      app: session.app || {},
      device: session.device || {},
      calibration: session.calibration || null,
      trim: this._cleanTrim(session.trim),
      labels: session.labels || [],
      events: session.events || [],
      summary: session.summary || null,
      motionUnits:  (session.motion  && session.motion.units)  || 'm/s^2',
      motionSource: (session.motion  && session.motion.source) || 'accelerationIncludingGravity',
      motionCount: m.n,
      derivedHz:   (session.derived && session.derived.hz) || this.DERIVED_HZ,
      derivedCount: d.n,
      // Written with the recording rather than assumed on read. Adding a column
      // to DERIVED_COLUMNS used to relabel every older recording with a channel
      // it does not carry — the reader indexes by name, so it would have read
      // the wrong array.
      derivedColumns: (session.derived && session.derived.columns) || this.DERIVED_COLUMNS.slice()
    };
    let bytes = 0;
    bytes += data.mT.byteLength + data.mX.byteLength + data.mY.byteLength + data.mZ.byteLength;
    bytes += data.dT.byteLength;
    for(let i=0;i<data.dV.length;i++) bytes += data.dV[i].byteLength;
    meta.metaBytes = this._metaBytes(meta);
    meta.bytes = bytes + meta.metaBytes;
    return {meta:meta, data:data};
  },

  _metaBytes(meta){
    try{ return JSON.stringify(meta).length; }catch(e){ return 512; }
  },

  _assemble(meta, data, wantM, wantD, asCols){
    const s = {
      format: this.FORMAT,
      id: meta.id,
      startedAt: meta.startedAt,
      durationSec: meta.durationSec,
      app: meta.app || {},
      device: meta.device || {},
      calibration: meta.calibration || null,
      trim: meta.trim || null,
      labels: meta.labels || [],
      events: meta.events || [],
      motion: {units: meta.motionUnits, source: meta.motionSource,
               columns: this.MOTION_COLUMNS.slice(), count: meta.motionCount || 0, rows: []},
      derived:{hz: meta.derivedHz,
               columns: (meta.derivedColumns || this.DERIVED_COLUMNS).slice(),
               count: meta.derivedCount || 0, rows: []},
      summary: meta.summary || null,
      bytes: meta.bytes || 0
    };
    if(!data) return s;
    if(asCols){
      s.motion.cols  = {t:data.mT, v:[data.mX, data.mY, data.mZ], n: meta.motionCount || 0};
      s.derived.cols = {t:data.dT, v:data.dV, n: meta.derivedCount || 0};
      return s;
    }
    if(wantM) s.motion.rows  = unpack(data.mT, [data.mX,data.mY,data.mZ], meta.motionCount, 4);
    if(wantD) s.derived.rows = unpack(data.dT, data.dV, meta.derivedCount, 3);
    return s;
  },

  /* ---------- export ----------
     Built as an array of string chunks so a 20-minute session never has to
     exist as one 3 MB concatenation before it reaches the Blob. */

  exportParts(session){
    const p = [];
    p.push('{\n"format": "' + this.FORMAT + '",\n');
    p.push('"id": ' + JSON.stringify(session.id) + ',\n');
    p.push('"startedAt": ' + JSON.stringify(session.startedAt) + ',\n');
    p.push('"durationSec": ' + num(session.durationSec, 3) + ',\n');
    p.push('"app": '         + JSON.stringify(session.app || {}) + ',\n');
    p.push('"device": '      + JSON.stringify(session.device || {}) + ',\n');
    p.push('"calibration": ' + JSON.stringify(session.calibration || null) + ',\n');
    p.push('"trim": '        + JSON.stringify(session.trim || null) + ',\n');
    p.push('"labels": '      + JSON.stringify(session.labels || []) + ',\n');
    p.push('"events": '      + JSON.stringify(session.events || []) + ',\n');
    p.push('"summary": '     + JSON.stringify(session.summary || null) + ',\n');

    const m = colsOf(session.motion, 4);
    p.push('"motion": {"units": ' + JSON.stringify(session.motion.units || 'm/s^2') +
           ', "source": ' + JSON.stringify(session.motion.source || 'accelerationIncludingGravity') +
           ', "columns": ' + JSON.stringify(this.MOTION_COLUMNS) +
           ', "count": ' + m.n + ',\n  "rows": [');
    rowText(p, m, 4, 3);
    p.push(']},\n');

    const d = colsOf(session.derived, (session.derived && session.derived.columns || this.DERIVED_COLUMNS).length);
    p.push('"derived": {"hz": ' + ((session.derived && session.derived.hz) || this.DERIVED_HZ) +
           ', "columns": ' + JSON.stringify((session.derived && session.derived.columns) || this.DERIVED_COLUMNS) +
           ', "count": ' + d.n + ',\n  "rows": [');
    rowText(p, d, 3, 3);
    p.push(']}\n}\n');
    return p;
  },

  exportJson(session){ return this.exportParts(session).join(''); },

  /** @param idOrSession  an id reads the full session back out of the store */
  exportBlob(idOrSession){
    const self = this;
    const one = function(s){
      return new Blob(self.exportParts(s), {type:'application/json'});
    };
    if(typeof idOrSession !== 'string') return Promise.resolve(one(idOrSession));
    // {cols:true} hands back the stored typed arrays. exportParts reads those
    // directly, so a 34 000-sample session never becomes 34 000 four-element
    // JS arrays on the way to a file it is about to be turned back into text.
    return this.get(idOrSession, {cols:true}).then(function(s){ return s ? one(s) : null; });
  },

  /** Every recording in one file. Can be tens of MB, which is exactly why this
      exists: the sessions are fetched one at a time and appended as string
      pieces to a Blob, so the phone never has to hold the whole thing as one
      contiguous JavaScript string. */
  exportAllBlob(){
    const self = this;
    return this.list().then(function(metas){
      const parts = ['{\n"format": "breathe-sessions/1",\n"sessions": [\n'];
      let chain = Promise.resolve();
      metas.forEach(function(meta, i){
        chain = chain.then(function(){
          return self.get(meta.id, {cols:true}).then(function(s){
            if(!s) return;
            if(i) parts.push(',\n');
            const sub = self.exportParts(s);
            for(let k=0;k<sub.length;k++) parts.push(sub[k]);
          });
        });
      });
      return chain.then(function(){
        parts.push('\n]}\n');
        return new Blob(parts, {type:'application/json'});
      });
    });
  },

  exportName(session){
    // 20260827T180411Z-a3f1 -> breathe-20260827-1804.json
    const id = String(session.id || '');
    const m = id.match(/^(\d{8})T(\d{4})/);
    return m ? ('breathe-' + m[1] + '-' + m[2] + '.json') : ('breathe-' + id + '.json');
  },

  /* ---------- presentation helpers ---------- */

  formatBytes(n){
    if(!(n > 0)) return '0 kB';
    if(n < 1024*1024) return Math.max(1, Math.round(n/1024)) + ' kB';
    return (n/(1024*1024)).toFixed(n < 10*1024*1024 ? 1 : 0) + ' MB';
  },

  formatDuration(sec){
    const s = Math.max(0, Math.round(sec || 0));
    const mm = Math.floor(s/60), ss = s % 60;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }
};

/* ---------- shared number handling ----------
   Nothing raw ever reaches the file: 3 dp for time and derived values,
   4 dp for the motion axes. */

function rnd(v, dp){
  if(typeof v !== 'number' || !isFinite(v)) return 0;
  const k = Math.pow(10, dp);
  return Math.round(v*k)/k;
}

/** Fixed dp, trailing zeros trimmed, no "-0". */
function num(v, dp){
  if(typeof v !== 'number' || !isFinite(v)) return '0';
  let s = v.toFixed(dp);
  if(s.indexOf('.') >= 0) s = s.replace(/0+$/,'').replace(/\.$/,'');
  return (s === '-0' || s === '') ? '0' : s;
}

/** Accept either the columnar shape or export rows, and give back columns. */
/** Cut a capture buffer down to what is actually in it.
    Recorder starts each channel at two minutes and doubles when it fills, so a
    session that ends just after a doubling is sitting in a buffer up to twice
    the size of its contents. That padding used to be written to IndexedDB
    verbatim and counted against the 48 MB budget — so at the worst point in the
    growth curve a recording took twice the space it needed and evicted an older
    session twice as soon.

    `slice` copies rather than viewing, deliberately: structured clone stores the
    whole underlying ArrayBuffer, so a subarray would save nothing at all. */
function trim(arr, n){
  return (n >= arr.length) ? arr : arr.slice(0, n);
}

function colsOf(chan, width){
  const vcount = width - 1;
  if(chan && chan.cols && chan.cols.t) return {t:chan.cols.t, v:chan.cols.v, n:chan.cols.n};
  const rows = (chan && chan.rows) || [];
  const n = rows.length;
  const t = new Uint32Array(n);
  const v = [];
  for(let c=0;c<vcount;c++) v.push(new Float32Array(n));
  for(let i=0;i<n;i++){
    const r = rows[i];
    t[i] = Math.max(0, Math.round((r[0] || 0)*1000));
    for(let c=0;c<vcount;c++) v[c][i] = r[c+1] || 0;
  }
  return {t:t, v:v, n:n};
}

function unpack(t, v, n, dp){
  const rows = new Array(n);
  for(let i=0;i<n;i++){
    const r = new Array(v.length + 1);
    r[0] = t[i]/1000;                       // ms integers are already 3 dp
    for(let c=0;c<v.length;c++) r[c+1] = rnd(v[c][i], dp);
    rows[i] = r;
  }
  return rows;
}

/** Push row text into `parts`, one string per row, newline every 8 rows. */
function rowText(parts, c, dp, tdp){
  for(let i=0;i<c.n;i++){
    let s = (i ? ',' : '') + ((i % 8 === 0) ? '\n    [' : '[') + num(c.t[i]/1000, tdp);
    for(let k=0;k<c.v.length;k++) s += ',' + num(c.v[k][i], dp);
    parts.push(s + ']');
  }
  if(c.n) parts.push('\n  ');
}

/* ============================================================
   Recorder — buffers one session into growable typed arrays.
   ------------------------------------------------------------
   sample() runs at the sensor rate, so it does no allocation, no
   rounding and no branching beyond a bounds check. Everything else
   happens in stop().

   A recording failure must never reach the user mid-breath: every
   entry point is guarded, and problems are parked in Recorder.saveError
   for the summary screen to report afterwards.
   ============================================================ */

export const Recorder = {
  active:false,
  lastSession:null,
  /* Set once by onMotion: accelerationIncludingGravity is what the tracker
     wants, but the event can only offer `acceleration` on some devices and a
     reader has to be able to tell which one produced the file. */
  motionSource:null,
  saveError:null,          // set at stop(); APP shows it on the summary screen
  truncated:false,

  /* A breathing session is not an all-nighter. 45 min at 60 Hz is
     162 000 samples = 2.6 MB of buffer; past that the motion channel
     stops growing and an event records that it happened. */
  MAX_MIN:45,

  t0:null, startedAt:null, id:null,
  m:null, d:null, events:null, meta:null,
  maxSamples:0,

  /**
   * @param meta.app  {invert, demo, sensitivity, pulse, build, buildDate}
   * @param t         session zero, in the same clock sample() will use.
   *                  Defaults to now; pass it explicitly when replaying a
   *                  recorded clock. Every tSec in the file is relative to it,
   *                  so samples and events can never disagree about time zero.
   */
  start(meta, t){
    try{
      this.stopBuffers();
      const now = new Date();
      this.startedAt = now.toISOString();
      this.id = idFor(this.startedAt);
      this.t0 = (typeof t === 'number' && isFinite(t)) ? t : nowSec();
      this.truncated = false;
      this.saveError = null;
      this.motionSource = null;
      this.events = [];
      this.meta = meta || {};
      this.maxSamples = this.MAX_MIN*60*60;
      // 2 min of headroom, doubled as needed up to the ceiling
      this.m = allocCols(60*120, 3, this.maxSamples);
      this.d = allocCols(10*120, 9, this.MAX_MIN*60*20);
      this.active = true;
    }catch(e){
      this.active = false;
      this.saveError = 'start:' + ((e && e.name) || 'unknown');
    }
  },

  /** Every raw sensor sample. t in seconds, same clock as derived(). */
  sample(x, y, z, t){
    if(!this.active) return;
    const m = this.m;
    if(m.n >= this.maxSamples){
      if(!this.truncated){
        this.truncated = true;
        this.event('recording-truncated', {afterSec: this.MAX_MIN*60});
      }
      return;
    }
    if(m.n >= m.cap && !this.grow(m)) return;
    const i = m.n++;
    const ms = (t - this.t0)*1000;
    m.t[i] = ms > 0 ? Math.round(ms) : 0;
    m.v[0][i] = x; m.v[1][i] = y; m.v[2][i] = z;
  },

  /**
   * ~10 Hz snapshot of what the tracker believed at that moment.
   * @param o {t,s,level,phase,bpm,quality,rich,hr,hrConf}
   */
  derived(o){
    if(!this.active || !o) return;
    const d = this.d;
    if(d.n >= d.cap && !this.grow(d)) return;
    const i = d.n++;
    const ms = (o.t - this.t0)*1000;
    d.t[i] = ms > 0 ? Math.round(ms) : 0;
    d.v[0][i] = o.s || 0;
    d.v[1][i] = o.level || 0;
    d.v[2][i] = o.phase || 0;
    d.v[3][i] = o.bpm || 0;
    d.v[4][i] = o.quality || 0;
    d.v[5][i] = o.rich || 0;
    d.v[6][i] = o.hr || 0;
    d.v[7][i] = o.hrConf || 0;
    d.v[8][i] = o.rest || 0;        // the rest gate, 1 = moving, 0 = held
  },

  /**
   * Sparse timeline event. `t` is optional and defaults to the wall clock;
   * pass it when replaying a recorded clock.
   *
   * Known types, all optional except the first two:
   *   axis               {axis:[x,y,z], amplitude, conf}  every 30 s
   *   breath             {inhaleSec, exhaleSec}
   *   breath             {inhaleSec, exhaleSec}
   *   recalibrate        {}
   *   signal-lost / signal-back  {quality}
   *   recording-truncated {afterSec}
   */
  event(type, data, t){
    if(!this.events) return;
    if(this.events.length > 4000) return;          // a runaway loop must not eat the heap
    const now = (typeof t === 'number') ? t : nowSec();
    const e = {tSec: rnd(Math.max(0, now - this.t0), 3), type: type};
    if(data) for(const k in data) if(Object.prototype.hasOwnProperty.call(data, k)) e[k] = data[k];
    this.events.push(e);
  },

  grow(c){
    try{
      const cap = Math.min(c.cap*2, c.max);
      if(cap <= c.cap) return false;
      const t = new Uint32Array(cap), v = [];
      t.set(c.t);
      for(let i=0;i<c.v.length;i++){ const a = new Float32Array(cap); a.set(c.v[i]); v.push(a); }
      c.t = t; c.v = v; c.cap = cap;
      return true;
    }catch(e){
      // Out of memory. Stop recording; the session itself carries on.
      this.active = false;
      this.saveError = 'memory:' + ((e && e.name) || 'unknown');
      return false;
    }
  },

  /**
   * Flush and persist.
   * @returns Promise<session|null>  the session in memory. Its motion is
   *          carried as typed-array columns, not rows — export it with
   *          Store.exportBlob(id) or Store.exportJson(session), never by
   *          JSON.stringify().
   */
  stop(){
    if(!this.m){ return Promise.resolve(null); }
    this.active = false;
    let session;
    try{ session = this.build(); }
    catch(e){
      this.saveError = 'build:' + ((e && e.name) || 'unknown');
      this.stopBuffers();
      return Promise.resolve(null);
    }
    this.lastSession = session;
    const self = this;
    return Store.put(session).then(function(ok){
      if(!ok) self.saveError = Store.lastError || 'unavailable';
      return session;
    }, function(e){
      self.saveError = 'save:' + ((e && e.name) || 'unknown');
      return session;
    });
  },

  stopBuffers(){ this.m = null; this.d = null; this.active = false; },

  build(){
    const m = this.m, d = this.d;
    const durationSec = m.n ? m.t[m.n-1]/1000 : (d.n ? d.t[d.n-1]/1000 : 0);
    const hz = durationSec > 1 ? m.n/durationSec : 0;

    const cal = calFromEvents(this.events);
    const app = (this.meta && this.meta.app) || {};
    const dSpan = d.n > 1 ? (d.t[d.n-1] - d.t[0])/1000 : 0;
    const dHz = dSpan > 0 ? Math.round((d.n-1)/dSpan*100)/100 : Store.DERIVED_HZ;

    return {
      format: Store.FORMAT,
      id: this.id,
      startedAt: this.startedAt,
      durationSec: rnd(durationSec, 3),
      app: app,
      device: deviceInfo(hz),
      calibration: cal,
      trim: null,
      labels: [],
      events: this.events.slice(),
      motion: {units:'m/s^2',
               source: app.demo ? 'simulated'
                                : (this.motionSource || 'accelerationIncludingGravity'),
               columns: Store.MOTION_COLUMNS.slice(),
               count: m.n,
               cols: {t:m.t, v:m.v, n:m.n}, rows: []},
      derived:{hz: dHz,
               columns: Store.DERIVED_COLUMNS.slice(),
               count: d.n,
               cols: {t:d.t, v:d.v, n:d.n}, rows: []},
      summary: summarise(d, this.events, dHz)
    };
  }
};

/* ---------- Recorder helpers ---------- */

function nowSec(){
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()/1000 : Date.now()/1000;
}

function idFor(iso){
  const stamp = String(iso).replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
  let tail = '';
  try{
    if(typeof crypto !== 'undefined' && crypto.getRandomValues){
      const a = new Uint8Array(2); crypto.getRandomValues(a);
      tail = (a[0]+256).toString(16).slice(1) + (a[1]+256).toString(16).slice(1);
    }
  }catch(e){}
  if(!tail) tail = ('000' + Math.floor(Math.random()*65536).toString(16)).slice(-4);
  return stamp + '-' + tail;
}

function deviceInfo(hz){
  const d = {sampleHz: rnd(hz, 1)};
  try{ if(typeof navigator !== 'undefined') d.ua = navigator.userAgent; }catch(e){}
  try{
    if(typeof screen !== 'undefined') d.screen = [screen.width, screen.height];
  }catch(e){}
  return d;
}

function allocCols(n, vcount, max){
  const v = [];
  for(let i=0;i<vcount;i++) v.push(new Float32Array(n));
  return {n:0, cap:n, max:max, t:new Uint32Array(n), v:v};
}

/** There is no calibration step any more, but the axis is still the single most
    useful thing to know when reading a recording back, so the tracker's own
    estimate is sampled into `axis` events and the last one fills the field the
    tools already read. Recordings made before this carry the old events. */
function calFromEvents(events){
  let startSec = null, end = null;
  for(let i=0;i<events.length;i++){
    if(events[i].type === 'calibration-start') startSec = events[i].tSec;
    if(events[i].type === 'calibration-end')   end = events[i];
    if(events[i].type === 'axis'){ if(startSec===null) startSec = 0; end = events[i]; }
  }
  if(!end) return null;
  return {
    startSec: startSec === null ? 0 : startSec,
    endSec: end.tSec,
    axis: end.axis || null,
    flipped: (typeof end.flipped === 'boolean') ? end.flipped : null,
    amplitude: rnd(end.amplitude, 4),
    ok: end.ok !== false
  };
}

/**
 * `slowestBpm` is the slowest 30-second stretch, not the slowest single
 * estimate — one dropped breath can halve an instantaneous reading.
 */
function summarise(d, events, hz){
  const S = {meanBpm:0, minBpm:0, maxBpm:0, slowestBpm:0, secondsUnder7:0,
             inOutRatio:0, meanInhaleSec:0, meanExhaleSec:0, heldFraction:0,
             meanQuality:0, breaths:0};
  const n = d.n;
  if(!(hz > 0)) hz = Store.DERIVED_HZ;
  const bpm = d.v[3], q = d.v[4], rest = d.v[8];

  let bs = 0, bc = 0, qs = 0, under = 0, lo = Infinity, hi = 0, held = 0;
  for(let i=0;i<n;i++){
    // A zero means no cycle has been timed yet, not a rate of zero.
    if(bpm[i] > 0){
      bs += bpm[i]; bc++;
      if(bpm[i] < 7) under++;
      if(bpm[i] < lo) lo = bpm[i];
      if(bpm[i] > hi) hi = bpm[i];
    }
    qs += q[i];
    // Under half open is the same line tools/onset.mjs draws, so the number on
    // the summary and the number in the tool mean the same thing.
    if(rest && rest[i] < 0.5) held++;
  }
  S.heldFraction = n ? rnd(held/n, 3) : 0;
  S.meanBpm = bc ? rnd(bs/bc, 2) : 0;
  S.minBpm = bc ? rnd(lo, 2) : 0;
  S.maxBpm = bc ? rnd(hi, 2) : 0;
  S.secondsUnder7 = rnd(under/hz, 1);
  S.meanQuality = n ? rnd(qs/n, 3) : 0;

  const win = Math.round(30*hz);   // a 30 s stretch, in snapshots
  let best = 0;
  if(bc && n >= win){
    let sum = 0, good = 0;
    for(let i=0;i<n;i++){
      if(bpm[i] > 0){ sum += bpm[i]; good++; }
      if(i >= win){ if(bpm[i-win] > 0){ sum -= bpm[i-win]; good--; } }
      if(i >= win-1 && good === win){
        const mean = sum/win;
        if(!best || mean < best) best = mean;
      }
    }
  }
  S.slowestBpm = best ? rnd(best, 2) : S.meanBpm;

  let inS = 0, outS = 0, k = 0;
  for(let i=0;i<events.length;i++){
    const e = events[i];
    if(e.type !== 'breath') continue;
    S.breaths++;
    if(e.inhaleSec > 0 && e.exhaleSec > 0){ inS += e.inhaleSec; outS += e.exhaleSec; k++; }
  }
  if(k){
    S.meanInhaleSec = rnd(inS/k, 2);
    S.meanExhaleSec = rnd(outS/k, 2);
  }
  S.inOutRatio = k && outS > 0 ? rnd((inS/k)/(outS/k), 3) : 0;
  return S;
}
