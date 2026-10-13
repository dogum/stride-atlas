// Port of mockup/src/app-core.js: formatting, colour ramps, tooltip, chart frame, axes, motion.
import * as d3 from 'd3';
import { G, MODE } from './store';

export const TYPES = [
  { key: 'walk', name: 'Walk', tok: '--s1' },
  { key: 'run', name: 'Run', tok: '--s2' },
  { key: 'hike', name: 'Hike', tok: '--s3' },
  { key: 'ride', name: 'Ride', tok: '--s4' },
  { key: 'swim', name: 'Swim', tok: '--s5' },
  { key: 'strength', name: 'Strength', tok: '--s6' },
  { key: 'other', name: 'Other', tok: '--s7' },
];
export const TYPE: Record<string, any> = Object.fromEntries(TYPES.map(t => [t.key, t]));
export const COND = ['Clear', 'Partly cloudy', 'Overcast', 'Rain', 'Snow', 'Storm'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DOWS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const ZONES = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5'];

// ---------- units: SI inside, imperial at display ----------
export const MI = 1609.344;
export const mi = (m: number) => m / MI;
export const ft = (m: number) => m * 3.28084;
export const degF = (c: number) => c * 9 / 5 + 32;
export const mph = (ms: number) => ms / 0.44704;

// ---------- formatting ----------
export const fInt = d3.format(',.0f');
export const f1 = d3.format(',.1f');
export const f2 = d3.format(',.2f');
export const fPct = d3.format('.0%');
export const fK = (v: number) => { const a = Math.abs(v); if (a >= 1e6) return d3.format('.3~s')(v); if (a >= 1e4) return d3.format('.3~s')(v).replace('k', 'K'); if (a >= 1000) return d3.format('.2~s')(v).replace('k', 'K'); return fInt(v); };
export const fPace = (p: number) => { if (!isFinite(p)) return '—'; let m = Math.floor(p), s = Math.round((p - m) * 60); if (s === 60) { m++; s = 0; } return `${m}:${String(s).padStart(2, '0')}`; };
export const fDur = (min: number) => { if (!isFinite(min)) return '—'; const h = Math.floor(min / 60), m = Math.round(min % 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`; };
export const fClock = (h: number) => { if (!isFinite(h)) return '—'; h = ((h % 24) + 24) % 24; const hh = Math.floor(h), mm = Math.round((h - hh) * 60); const H = (mm === 60 ? hh + 1 : hh) % 24, M = mm === 60 ? 0 : mm; const ap = H >= 12 ? 'pm' : 'am'; const h12 = ((H + 11) % 12) + 1; return `${h12}:${String(M).padStart(2, '0')} ${ap}`; };
export const fHourShort = (h: number) => { const H = ((h % 24) + 24) % 24; return H === 0 ? '12a' : H === 12 ? '12p' : H < 12 ? H + 'a' : (H - 12) + 'p'; };
export const fTime = (min: number) => { const s = Math.round(min * 60), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`; };
export const fTemp = (f: number) => isFinite(f) ? `${Math.round(f)}°F` : '—';
export const dayDate = (d: number) => new Date(G.D0 + d * G.DAY);
export const fDate = (d: number) => { const dt = dayDate(d); return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}, ${dt.getUTCFullYear()}`; };
export const fDateShort = (d: number) => { const dt = dayDate(d); return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`; };
export const fISO = (d: number) => dayDate(d).toISOString().slice(0, 10);
export const fDateISO = (iso: string) => { if (!iso) return '—'; const [y, m, dd] = iso.slice(0, 10).split('-').map(Number); return `${MONTHS[m - 1]} ${dd}, ${y}`; };
export const dayOfISO = (iso: string) => Math.round((Date.parse(iso.slice(0, 10) + 'T00:00:00Z') - G.D0) / G.DAY);
export const plural = (n: number, w: string) => `${fInt(n)} ${w}${n === 1 ? '' : 's'}`;
export const median = (a: number[]) => d3.median(a);
export const typeLabel = (w: any) => (TYPE[w.type] || {}).name || w.type;
// a name the person gave the workout (Strava titles), not an app's automatic "Morning Run"
export const customTitle = (w: any): string | null => w?.title && !/^(Morning|Lunch|Afternoon|Evening|Night) [A-Za-z ]+$/.test(w.title) ? w.title : null;
export const wLabel = (w: any) => `${customTitle(w) ? customTitle(w) + ' · ' : ''}${typeLabel(w)} · ${fDate(w.d)}`;
export const wxName = (w: any) => w.wxSrc === 'health' ? 'Health metadata' : /noaa/.test(w.wxProvider || '') ? 'NOAA station' : /nasa/.test(w.wxProvider || '') ? 'NASA POWER' : 'Open-Meteo';

// ---------- colour ----------
export const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const isDark = () => !css('color-scheme').includes('light');
export function seqInterp() { return d3.interpolateRgbBasis(['--q1', '--q2', '--q3', '--q4', '--q5', '--q6', '--q7'].map(css)); }
export function divInterp() { return d3.interpolateRgbBasis([css('--cold'), css('--mid'), css('--hot')]); }
export const tempColor = () => { const i = divInterp(); return (t: number) => i(Math.max(0, Math.min(1, (t - 20) / 75))); };
// map ramps are fixed: the map is a dark window in both themes
export const MAP_RAMPS: Record<string, (t: number) => string> = {
  year: d3.interpolateRgbBasis(['#5a4fcf', '#9a58d4', '#d55181', '#f0813f', '#ffc56b']),
  pace: d3.interpolateRgbBasis(['#184f95', '#256abf', '#3987e5', '#6da7ec', '#cde2fb']),
  hr: d3.interpolateRgbBasis(['#3d2a8a', '#8e2f86', '#d24a5c', '#f0813f', '#ffd36b']),
  temp: d3.interpolateRgbBasis(['#3987e5', '#6f8794', '#e66767']),
  time: d3.interpolateRgbBasis(['#6da7ec', '#7a8b93', '#f0813f']),
};
export const typeColor = (k: string) => css((TYPE[k] || TYPE.other).tok);
export const ordinalRamp = (n: number) => {
  const steps = isDark() ? ['#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb'] : ['#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281', '#0d366b'];
  if (n === steps.length) return steps;
  return d3.range(n).map(i => d3.interpolateRgbBasis(steps)(n === 1 ? 0.5 : i / (n - 1)));
};
// sky conditions: five blues from the mockup plus a violet for storms
export const condRamp = () => { const r = ordinalRamp(5); return [...r, css('--s7')]; };
export const gradientCSS = (interp: (t: number) => string, n = 9) => `linear-gradient(90deg, ${d3.range(n).map(i => interp(i / (n - 1))).join(',')})`;

// ---------- tooltip ----------
export const TIP = (() => {
  let el: HTMLDivElement | null = null;
  const get = () => (el ||= document.getElementById('tip') as HTMLDivElement);
  function show(evt: any, title: string, rows: any[][]) {
    const e = get(); if (!e) return;
    e.replaceChildren();
    if (title) { const t = document.createElement('div'); t.className = 't'; t.textContent = title; e.appendChild(t); }
    for (const r of rows) {
      const row = document.createElement('div'); row.className = 'r';
      const k = document.createElement('span'); k.className = 'k';
      if (r[2]) { const i = document.createElement('i'); i.style.setProperty('--c', r[2]); k.appendChild(i); }
      k.appendChild(document.createTextNode(r[0]));
      const v = document.createElement('span'); v.className = 'val'; v.textContent = r[1];
      row.append(k, v); e.appendChild(row);
    }
    e.classList.add('on');
    move(evt);
  }
  function move(evt: any) {
    const e = get(); if (!e) return;
    const pad = 14, bw = e.offsetWidth, bh = e.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + bw > innerWidth - 8) x = evt.clientX - bw - pad;
    if (y + bh > innerHeight - 8) y = evt.clientY - bh - pad;
    e.style.left = Math.max(8, x) + 'px'; e.style.top = Math.max(8, y) + 'px';
  }
  function hide() { get()?.classList.remove('on'); }
  return { show, move, hide };
})();

// ---------- chart frame ----------
export function frame(el: HTMLElement, h: number, m: any = {}) {
  el.replaceChildren();
  const M = Object.assign({ t: 10, r: 14, b: 26, l: 40 }, m);
  const w = Math.max(260, el.clientWidth || el.parentElement?.clientWidth || 600);
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('width', '100%').attr('height', h).attr('preserveAspectRatio', 'xMinYMin meet');
  const g = svg.append('g').attr('transform', `translate(${M.l},${M.t})`);
  return { el, svg, g, w, h, m: M, iw: w - M.l - M.r, ih: h - M.t - M.b };
}
export function yGrid(g: any, y: any, iw: number, ticks = 4, fmt: any = fK) {
  g.append('g').attr('class', 'gridl').call(d3.axisLeft(y).ticks(ticks).tickSize(-iw).tickFormat('' as any));
  g.append('g').attr('class', 'ax noline').call(d3.axisLeft(y).ticks(ticks).tickSize(0).tickPadding(8).tickFormat(fmt));
}
export function xAxis(g: any, x: any, ih: number, opts: any = {}) {
  const ax = d3.axisBottom(x).tickSizeOuter(0).tickSize(4).tickPadding(6);
  if (opts.ticks) ax.ticks(opts.ticks); if (opts.values) ax.tickValues(opts.values); if (opts.fmt) ax.tickFormat(opts.fmt);
  return g.append('g').attr('class', 'ax').attr('transform', `translate(0,${ih})`).call(ax);
}
export function emptyState(el: HTMLElement, text: string) { el.replaceChildren(); const d = document.createElement('div'); d.className = 'empty'; d.textContent = text; el.appendChild(d); }
export function rollingMedian(vals: number[], win: number) { const out: number[] = []; for (let i = 0; i < vals.length; i++) { const a = vals.slice(Math.max(0, i - (win >> 1)), Math.min(vals.length, i + (win >> 1) + 1)); out.push(d3.median(a) as number); } return out; }
export const yearTicks = (years: number[], d0: number) => years.map(y => Math.max(d0, Math.round((Date.UTC(y, 0, 1) - G.D0) / G.DAY)));
export const monthTicks = () => MONTHS.map((m, i) => Math.round((Date.UTC(2025, i, 1) - Date.UTC(2025, 0, 1)) / G.DAY));

// ---------- panel outputs ----------
export type Rich = (string | [string])[];
export type TableSpec = { cols: { k: string; label: string; num?: boolean }[]; rows: any[] };
export type Legend = { items: { label: string; c: string }[]; kind?: 'sq' | 'ln' | 'dt' };
export type Out = { sub?: Rich; table?: () => TableSpec; legend?: Legend } | void;

// ---------- motion: charts arrive when they come into view, and again after a filter change ----------
export const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = 'cubic-bezier(.2,.8,.2,1)';
export function arrive(el: HTMLElement) {
  if (REDUCED() || !el.animate) return;
  const anim = (node: any, kf: any, opt: any) => { try { node.animate(kf, Object.assign({ easing: EASE, fill: 'backwards' }, opt)); } catch { /* ignore */ } };
  const q = (s: string) => el.querySelectorAll(s) as any;
  const bars = q('.a-bar'); bars.forEach((n: any, i: number) => anim(n, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 650, delay: Math.min(600, i * (600 / Math.max(1, bars.length))) }));
  q('.a-hbar').forEach((n: any, i: number) => anim(n, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 700, delay: Math.min(500, i * 40) }));
  q('.a-line').forEach((n: any, i: number) => { const L = n.getTotalLength ? n.getTotalLength() : 0; if (!L) return; anim(n, [{ strokeDasharray: `${L} ${L}`, strokeDashoffset: L }, { strokeDasharray: `${L} ${L}`, strokeDashoffset: 0 }], { duration: 1100, delay: 150 + i * 90, easing: 'cubic-bezier(.4,0,.2,1)' }); });
  // hundreds of individual animations cost more than they show: big groups arrive as one sweep instead
  const dots = q('.a-dot'), cells = q('.a-cell');
  if (dots.length > 300 || cells.length > 300) anim(el, [{ clipPath: 'inset(0 100% 0 0)', opacity: .4 }, { clipPath: 'inset(0 0% 0 0)', opacity: 1 }], { duration: 900, easing: 'cubic-bezier(.45,0,.2,1)' });
  if (dots.length <= 300) dots.forEach((n: any, i: number) => anim(n, [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 420, delay: 200 + Math.min(700, (+n.dataset.i || i) * 12) }));
  if (cells.length <= 300) cells.forEach((n: any) => anim(n, [{ opacity: 0 }, { opacity: 1 }], { duration: 380, delay: Math.min(900, (+n.dataset.i || 0) * 14) }));
  const fades = q('.a-fade'); fades.forEach((n: any, i: number) => anim(n, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 500, delay: 200 + Math.min(700, i * (fades.length > 12 ? 700 / fades.length : 60)) }));
  q('.a-reveal').forEach((n: any) => anim(n, [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }], { duration: 1300, easing: 'cubic-bezier(.45,0,.2,1)' }));
}
const inView = new WeakMap<Element, boolean>();
const IO = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((ents) => {
  for (const e of ents) { inView.set(e.target, e.isIntersecting); const t: any = e.target; if (e.isIntersecting && t._pending) { t._pending = false; arrive(t); } }
}, { threshold: 0.18 }) : null;
export function armArrival(el: any) {
  if (!el) return;
  if (!el._observed && IO) { IO.observe(el); el._observed = true; }
  if (MODE.quiet) { el._pending = false; return; }
  if (inView.get(el)) arrive(el); else el._pending = true;
}
// numbers that count from their last value to their new one
export function countTo(el: any, to: number, fmt: (v: number) => string) {
  if (!el) return;
  const from = el._v ?? 0; el._v = to;
  if (REDUCED() || from === to || MODE.quiet) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 900;
  cancelAnimationFrame(el._raf);
  const tick = (t: number) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(from + (to - from) * e); if (k < 1) el._raf = requestAnimationFrame(tick); };
  el._raf = requestAnimationFrame(tick);
}
