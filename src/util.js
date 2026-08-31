/* Shared helpers. Nothing here touches the DOM at import time. */

/* ============================================================
   0. small helpers
   ============================================================ */
export const $  = id => document.getElementById(id);
export const clamp = (v,a,b) => v<a?a:(v>b?b:v);
export const lerp  = (a,b,t) => a+(b-a)*t;
export const TAU = Math.PI*2;

/** one-pole low-pass, time-constant form so it is sample-rate independent */
export function lp(prev, x, dt, tau){
  if(!isFinite(prev)) return x;
  const a = dt/(tau+dt);
  return prev + (x-prev)*a;
}

let noticeTimer = null;
export function notice(title, body, ms){
  $('noticeTitle').textContent = title;
  $('noticeBody').textContent  = body;
  $('notice').classList.add('show');
  clearTimeout(noticeTimer);
  if(ms !== 0) noticeTimer = setTimeout(()=>$('notice').classList.remove('show'), ms||6000);
}

/** finite-or-fallback. Nothing from the tracker reaches an AudioParam without
    passing through this: one NaN would poison a param for the rest of the
    session, and there is no way to recover a param short of a new context. */
export const fin = (x,d) => (typeof x === 'number' && x-x === 0) ? x : d;

/** Size a canvas to its box in device pixels and hand back a scaled context.
    Both the live screens and the review lanes draw this way, so it lives here
    rather than in either of them. */
export function fitCanvas(c){
  const r=c.getBoundingClientRect(), dpr=Math.min(window.devicePixelRatio||1, 2.5);
  if(c.width!==Math.round(r.width*dpr) || c.height!==Math.round(r.height*dpr)){
    c.width=Math.round(r.width*dpr); c.height=Math.round(r.height*dpr);
  }
  const ctx=c.getContext('2d');
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return {ctx, w:r.width, h:r.height};
}
