/**
 * IndexedDB, in memory, in about as few lines as the app's usage allows.
 *
 * Store is nine hundred lines that only ever run on a phone, which is a poor
 * place to find out that a version upgrade dropped a table. This covers what
 * Store actually calls — get, getAll, put, delete, clear, and an upgrade —
 * and nothing else, so an unimplemented call fails loudly rather than
 * silently doing the wrong thing.
 *
 * Requests resolve on a microtask, the way the real thing resolves off the
 * event loop: a caller that reads req.result before the callback fires is a
 * bug here too.
 */

class Request {
  constructor(){ this.result = undefined; this.error = null;
                 this.onsuccess = null; this.onerror = null; }
  _succeed(v){
    this.result = v;
    queueMicrotask(()=>{ if(this.onsuccess) this.onsuccess({target:this}); });
  }
}

class ObjectStore {
  constructor(name, keyPath, map, tx){
    this.name = name; this.keyPath = keyPath; this._map = map; this._tx = tx;
  }
  _key(value, explicit){
    if(explicit !== undefined) return explicit;
    if(!this.keyPath) throw new Error(`${this.name}.put needs a key`);
    return value[this.keyPath];
  }
  get(k){ const r = new Request(); this._tx._queue(()=>r._succeed(this._map.get(k))); return r; }
  getAll(){ const r = new Request(); this._tx._queue(()=>r._succeed([...this._map.values()])); return r; }
  put(v, k){
    const key = this._key(v, k);
    const r = new Request();
    this._tx._queue(()=>{ this._map.set(key, v); r._succeed(key); });
    return r;
  }
  delete(k){ const r = new Request(); this._tx._queue(()=>{ this._map.delete(k); r._succeed(undefined); }); return r; }
  clear(){ const r = new Request(); this._tx._queue(()=>{ this._map.clear(); r._succeed(undefined); }); return r; }
}

class Transaction {
  constructor(db, names, mode){
    this.db = db; this.mode = mode; this.error = null;
    this.oncomplete = null; this.onabort = null; this.onerror = null;
    this._ops = []; this._done = false; this._aborted = false;
    for(const n of names) if(!db._stores.has(n)) throw notFound(n);
    queueMicrotask(()=>this._flush());
  }
  objectStore(n){ return new ObjectStore(n, this.db._keyPaths.get(n), this.db._stores.get(n), this); }
  _queue(fn){ this._ops.push(fn); }
  _flush(){
    if(this._done || this._aborted) return;
    // Requests queued from inside a callback join the same transaction, so
    // keep draining until nothing new appears — that is how the real one behaves.
    const drain = () => {
      if(this._aborted) return;
      if(this._ops.length){
        this._ops.shift()();
        queueMicrotask(drain);
        return;
      }
      this._done = true;
      if(this.oncomplete) this.oncomplete({target:this});
    };
    drain();
  }
  abort(){
    this._aborted = true; this._ops.length = 0;
    queueMicrotask(()=>{ if(this.onabort) this.onabort({target:this}); });
  }
}

function notFound(n){
  const e = new Error(`no object store "${n}"`); e.name = 'NotFoundError'; return e;
}

class DB {
  constructor(name, version){
    this.name = name; this.version = version;
    this._stores = new Map(); this._keyPaths = new Map();
    this.onclose = null; this.onversionchange = null;
  }
  get objectStoreNames(){
    const names = [...this._stores.keys()];
    return {contains: n => this._stores.has(n), length: names.length, item: i => names[i], [Symbol.iterator]: () => names[Symbol.iterator]()};
  }
  createObjectStore(name, opts){
    this._stores.set(name, new Map());
    this._keyPaths.set(name, (opts && opts.keyPath) || null);
    return new ObjectStore(name, this._keyPaths.get(name), this._stores.get(name), {_queue: fn => fn()});
  }
  transaction(names, mode){
    return new Transaction(this, typeof names === 'string' ? [names] : names, mode || 'readonly');
  }
  close(){ if(this.onclose) this.onclose(); }
}

/** Install a fresh in-memory IndexedDB. `seed` pre-loads a db at a version,
    so a test can open an old database and watch the upgrade run. */
export function installIdb(seed){
  const dbs = new Map();
  if(seed) dbs.set(seed.name, seed.db);

  const factory = {
    open(name, version){
      const r = new Request();
      queueMicrotask(()=>{
        let db = dbs.get(name);
        const old = db ? db.version : 0;
        if(!db){ db = new DB(name, version || 1); dbs.set(name, db); }
        if(version && version > old){
          db.version = version;
          r.result = db;
          if(r.onupgradeneeded) r.onupgradeneeded({target:r, oldVersion:old, newVersion:version});
        }
        r._succeed(db);
      });
      return r;
    },
    deleteDatabase(name){ const r = new Request(); dbs.delete(name); queueMicrotask(()=>r._succeed(undefined)); return r; }
  };

  globalThis.indexedDB = factory;
  if(globalThis.window) globalThis.window.indexedDB = factory;
  return {factory, dbs, DB};
}
