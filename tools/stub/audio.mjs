/**
 * Web Audio, enough of it to build the graph and run frame() for real.
 *
 * Every node records what it was connected to and every AudioParam records
 * every value written to it, so the smoke test can assert on the graph and on
 * the parameter traffic rather than merely on "it did not throw". The one
 * rule the app has about parameters — setTargetAtTime only, never .value, in
 * the render loop — is checkable from here.
 */

class Param {
  constructor(name, value){
    this.name = name;
    this._value = value;
    this.writes = [];        // {how, v, t}
    this.directSets = 0;     // .value = x after the graph was built
    this.armed = false;      // set true once construction is finished
  }
  get value(){ return this._value; }
  set value(v){
    if(this.armed) this.directSets++;
    this._value = v;
    this.writes.push({how:'value', v});
  }
  setValueAtTime(v,t){ this._value=v; this.writes.push({how:'setValueAtTime',v,t}); return this; }
  setTargetAtTime(v,t,tc){
    if(!Number.isFinite(v)) throw new Error(`setTargetAtTime(${this.name}) got ${v}`);
    if(!(tc > 0)) throw new Error(`setTargetAtTime(${this.name}) time constant ${tc}`);
    this._value=v; this.writes.push({how:'setTargetAtTime',v,t,tc}); return this;
  }
  linearRampToValueAtTime(v,t){ this._value=v; this.writes.push({how:'linear',v,t}); return this; }
  exponentialRampToValueAtTime(v,t){
    if(!(Math.abs(v) > 0)) throw new Error(`exponentialRamp(${this.name}) to ${v}`);
    this._value=v; this.writes.push({how:'expo',v,t}); return this;
  }
  setValueCurveAtTime(c,t,d){ this.writes.push({how:'curve',t,d}); return this; }
  cancelScheduledValues(){ return this; }
}

let nodeId = 0;
class Node {
  constructor(ctx, kind){
    this.ctx = ctx; this.kind = kind; this.id = ++nodeId;
    this.outputs = []; this.inputs = [];
    ctx.nodes.push(this);
  }
  connect(dest, from, to){
    if(!dest) throw new Error(`${this.kind}.connect(undefined)`);
    this.outputs.push({dest, from:from|0, to:to|0});
    if(dest.inputs) dest.inputs.push(this);
    return dest;
  }
  disconnect(){ this.outputs.length = 0; }
  start(){ this.started = true; }
  stop(){ this.stopped = true; }
  addEventListener(){}
}

class Buffer {
  constructor(ch, len, rate){
    this.numberOfChannels = ch; this.length = len; this.sampleRate = rate;
    this.duration = len/rate;
    this._d = Array.from({length:ch}, () => new Float32Array(len));
  }
  getChannelData(i){ return this._d[i]; }
}

export class FakeAudioContext {
  static last = null;
  constructor(){
    this.sampleRate = 48000;
    this.state = 'running';
    this.currentTime = 0;
    this.nodes = [];
    this.destination = new Node(this, 'destination');
    this.closed = false;
    FakeAudioContext.last = this;
  }
  async resume(){ this.state = 'running'; }
  async close(){ this.closed = true; this.state = 'closed'; }
  createGain(){ const n = new Node(this,'gain'); n.gain = new Param('gain',1); return n; }
  createBiquadFilter(){
    const n = new Node(this,'biquad');
    n.type='lowpass'; n.frequency=new Param('frequency',350);
    n.Q=new Param('Q',1); n.detune=new Param('detune',0); n.gain=new Param('bqgain',0);
    return n;
  }
  createStereoPanner(){ const n=new Node(this,'panner'); n.pan=new Param('pan',0); return n; }
  createOscillator(){
    const n=new Node(this,'osc'); n.type='sine';
    n.frequency=new Param('frequency',440); n.detune=new Param('detune',0);
    return n;
  }
  createBufferSource(){
    const n=new Node(this,'bufferSource'); n.buffer=null; n.loop=false;
    n.playbackRate=new Param('playbackRate',1); n.detune=new Param('detune',0);
    return n;
  }
  createConvolver(){ const n=new Node(this,'convolver'); n.buffer=null; n.normalize=true; return n; }
  createChannelSplitter(){ return new Node(this,'splitter'); }
  createChannelMerger(){ return new Node(this,'merger'); }
  createDelay(){ const n=new Node(this,'delay'); n.delayTime=new Param('delayTime',0); return n; }
  createWaveShaper(){ const n=new Node(this,'shaper'); n.curve=null; n.oversample='none'; return n; }
  createDynamicsCompressor(){
    const n=new Node(this,'compressor');
    for(const k of ['threshold','knee','ratio','attack','release']) n[k]=new Param(k,0);
    return n;
  }
  createBuffer(ch,len,rate){ return new Buffer(ch,len,rate); }

  /** Called once the graph is built: every later `.value =` is a rule break. */
  arm(){
    for(const n of this.nodes)
      for(const k of Object.keys(n))
        if(n[k] instanceof Param) n[k].armed = true;
  }
  params(){
    const out = [];
    for(const n of this.nodes)
      for(const k of Object.keys(n))
        if(n[k] instanceof Param) out.push(n[k]);
    return out;
  }
  directSets(){ return this.params().reduce((a,p)=>a+p.directSets, 0); }
  advance(dt){ this.currentTime += dt; }
}

export function installAudio(){
  globalThis.AudioContext = FakeAudioContext;
  globalThis.webkitAudioContext = undefined;
  if(globalThis.window){
    globalThis.window.AudioContext = FakeAudioContext;
    globalThis.window.webkitAudioContext = undefined;
  }
}
