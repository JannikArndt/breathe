/**
 * A DOM small enough to run breathe in Node, and no smaller.
 *
 * The app has no build step and no test browser here, so the risk a module
 * split introduces — a symbol that moved out from under its caller, an id that
 * no longer resolves — is invisible until someone opens the page on a phone.
 * This stub makes it a `node` command instead. It is deliberately strict:
 * getElementById returns null for an id index.html does not carry, so the
 * usual `$('gone').textContent` throws here exactly as it would in Safari.
 */
import { readFileSync } from 'node:fs';

class ClassList {
  constructor(el){ this.el = el; this.set = new Set(); }
  add(...c){ c.forEach(x=>x && this.set.add(x)); }
  remove(...c){ c.forEach(x=>this.set.delete(x)); }
  contains(c){ return this.set.has(c); }
  toggle(c, force){
    const on = force === undefined ? !this.set.has(c) : !!force;
    if(on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  get value(){ return [...this.set].join(' '); }
  toString(){ return this.value; }
}

let uid = 0;
export class El {
  constructor(tag){
    this.tagName = String(tag||'div').toUpperCase();
    this.nodeName = this.tagName;
    this.children = [];
    this.parentNode = null;
    this.classList = new ClassList(this);
    this.attrs = new Map();
    this.dataset = {};
    this.style = new Proxy({}, {set:(o,k,v)=>{o[k]=v; return true;}});
    this.listeners = new Map();
    this.textContent = '';
    this._value = null;            // null until something assigns .value
    this._uid = ++uid;
  }
  /** An <input>'s .value starts as its value attribute and detaches from it
      on the first assignment, which is what the app relies on for defaults. */
  get value(){
    if(this._value !== null) return this._value;
    const a = this.attrs.get('value');
    return a === undefined ? '' : a;
  }
  set value(v){ this._value = String(v); }

  get className(){ return this.classList.value; }
  set className(v){ this.classList.set = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get id(){ return this.attrs.get('id') || ''; }
  set id(v){ this.attrs.set('id', v); }
  get firstChild(){ return this.children[0] || null; }
  get innerHTML(){ return ''; }
  set innerHTML(v){ if(v === '') this.children.length = 0; }

  setAttribute(k, v){
    this.attrs.set(k, String(v));
    if(k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_,c)=>c.toUpperCase())] = String(v);
  }
  getAttribute(k){ return this.attrs.has(k) ? this.attrs.get(k) : null; }
  removeAttribute(k){ this.attrs.delete(k); }
  hasAttribute(k){ return this.attrs.has(k); }

  appendChild(c){ c.parentNode = this; this.children.push(c); return c; }
  append(...cs){ cs.forEach(c=>this.appendChild(c)); }
  insertBefore(c, ref){
    const i = this.children.indexOf(ref);
    c.parentNode = this;
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  removeChild(c){
    const i = this.children.indexOf(c);
    if(i >= 0) this.children.splice(i,1);
    c.parentNode = null;
    return c;
  }
  remove(){ if(this.parentNode) this.parentNode.removeChild(this); }
  replaceChildren(...cs){ this.children.length = 0; cs.forEach(c=>this.appendChild(c)); }

  addEventListener(type, fn){
    if(!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn){
    const a = this.listeners.get(type);
    if(a) this.listeners.set(type, a.filter(f=>f!==fn));
  }
  /** Fire every handler registered for `type`, then bubble to the parent. */
  dispatch(type, ev){
    const e = Object.assign({type, target:this, currentTarget:this,
                             preventDefault(){}, stopPropagation(){}}, ev||{});
    for(let n = this; n; n = n.parentNode){
      const a = n.listeners.get(type);
      if(a) a.slice().forEach(f=>f.call(n, Object.assign({}, e, {currentTarget:n})));
    }
    return e;
  }
  click(){ return this.dispatch('click'); }
  focus(){}
  scrollTo(){}
  getBoundingClientRect(){ return {width:390, height:220, top:0, left:0, right:390, bottom:220, x:0, y:0}; }

  /** Only the shapes the app actually asks for: a tag name or a .class. */
  matches(sel){
    if(sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    return this.tagName === sel.toUpperCase();
  }
  closest(sel){
    for(let n = this; n; n = n.parentNode) if(n.matches && n.matches(sel)) return n;
    return null;
  }
  querySelectorAll(sel){
    const out = [];
    const walk = n => { for(const c of n.children){ if(c.matches(sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel){ return this.querySelectorAll(sel)[0] || null; }

  /** Canvases: enough of a 2D context that the draw calls run and go nowhere. */
  getContext(){
    if(this._ctx) return this._ctx;
    const noop = () => {};
    const ctx = new Proxy({
      canvas: this,
      measureText: () => ({width: 10}),
      createLinearGradient: () => ({addColorStop: noop}),
      createRadialGradient: () => ({addColorStop: noop}),
      getImageData: () => ({data: new Uint8ClampedArray(4)}),
      setLineDash: noop,
    }, {
      get(o, k){
        if(k in o) return o[k];
        return typeof k === 'string' ? noop : undefined;
      },
      set(o, k, v){ o[k] = v; return true; }
    });
    this._ctx = ctx;
    return ctx;
  }
}

/**
 * Build the element tree from index.html. A real parser is overkill: the app
 * only ever reaches elements by id, by class within a subtree, or by tag, so
 * a tag/attribute scanner that keeps the nesting right is enough.
 */
function parse(html){
  const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
  const root = new El('body');
  const stack = [root];
  const VOID = new Set(['meta','link','br','hr','img','input','source','path','use','circle','rect','area','col','embed','track','wbr']);
  const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)(\/)?>|<!--[\s\S]*?-->/g;
  let m;
  while((m = tagRe.exec(body))){
    if(m[0].startsWith('<!--')) continue;
    const [, close, tag, attrText, selfClose] = m;
    if(close){
      if(stack.length > 1) stack.pop();
      continue;
    }
    const el = new El(tag);
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while((a = attrRe.exec(attrText))){
      const v = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : a[4] !== undefined ? a[4] : '';
      if(a[1] === 'class') el.className = v; else el.setAttribute(a[1], v);
    }
    stack[stack.length-1].appendChild(el);
    if(!selfClose && !VOID.has(tag.toLowerCase())) stack.push(el);
  }
  return root;
}

/** Install a document/window pair built from `htmlPath` onto globalThis. */
export function installDom(htmlPath){
  const body = parse(readFileSync(htmlPath, 'utf8'));
  const byId = new Map();
  (function walk(n){ for(const c of n.children){ if(c.id) byId.set(c.id, c); walk(c); } })(body);

  const documentEl = new El('html');
  documentEl.appendChild(body);

  const document = {
    body, documentElement: documentEl,
    visibilityState: 'visible',
    getElementById: id => byId.get(id) || null,
    createElement: tag => new El(tag),
    createTextNode: t => Object.assign(new El('#text'), {textContent: t}),
    querySelector: s => body.querySelector(s),
    querySelectorAll: s => body.querySelectorAll(s),
    addEventListener: (t, f) => documentEl.addEventListener(t, f),
    removeEventListener: (t, f) => documentEl.removeEventListener(t, f),
    dispatch: (t, e) => documentEl.dispatch(t, e),
  };

  const window = {
    document,
    isSecureContext: true,
    devicePixelRatio: 2,
    location: {hostname: 'localhost', pathname: '/index.html', href: 'http://localhost/', replace(){}, reload(){}},
    innerWidth: 390, innerHeight: 844,
    addEventListener: (t, f) => documentEl.addEventListener(t, f),
    removeEventListener: (t, f) => documentEl.removeEventListener(t, f),
    matchMedia: () => ({matches: false, addEventListener(){}, addListener(){}}),
  };

  // Every colour the review canvases draw with is read off :root, so the stub
  // has to answer for it — an empty string here would paint everything black
  // and no assertion would notice.
  const css = new Map(
    (readFileSync(htmlPath.replace(/index\.html$/, 'app.css'), 'utf8')
      .match(/^\s*(--[a-z-]+)\s*:\s*([^;]+);/gm) || [])
      .map(l => l.trim().replace(/;$/, '').split(/\s*:\s*/))
  );
  globalThis.getComputedStyle = () => ({
    getPropertyValue: k => css.get(k.trim()) || '#888'
  });
  window.getComputedStyle = globalThis.getComputedStyle;

  globalThis.document = document;
  globalThis.window = window;
  globalThis.location = window.location;
  globalThis.El = El;
  if(!globalThis.requestAnimationFrame){
    // Deliberately never fires: the smoke test drives the render loop itself,
    // so a real rAF would race it and make failures non-deterministic.
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
  }
  Object.defineProperty(globalThis, 'navigator', {
    value: {userAgent: 'node-smoke', storage: undefined, wakeLock: undefined},
    configurable: true, writable: true
  });
  globalThis.URL.createObjectURL = () => 'blob:node/0';
  globalThis.URL.revokeObjectURL = () => {};

  return {document, window, byId};
}
