// Presentation mode: a scripted tour of the dashboard for screen recordings and demos.
// Open the app with ?present=1 (and &share=1 to hide home) and press Play, or let scripts/record.mjs call
// window.__present.start(). Every caption is computed from the loaded data, so the tour works for anyone's export.
import { useEffect } from 'react';
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, REG, S, emit, useWatch } from './store';
import { MONTHS, customTitle, f1, fDate, fDur, fInt, fK, typeLabel } from './core';
import { RECORDS } from './charts/terrain';
import { openCloseup } from './charts/closeup';
import { loadStreets } from './data';
import { Topo } from './components/ui';

type Caption = { eyebrow?: string; title: string; sub?: string } | null;
type Card = { kind: 'title' | 'end'; title: string; sub: string; foot?: string } | null;
const P = { cap: null as Caption, card: null as Card, running: false, done: false, step: 0, steps: 1, stop: false };
const set = (patch: Partial<typeof P>) => { Object.assign(P, patch); emit('present'); };
export const PRESENT = new URLSearchParams(location.search).get('present');

const sleep = (ms: number) => new Promise<void>((ok, no) => setTimeout(() => (P.stop ? no(new Error('stopped')) : ok()), ms));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const headerH = () => (document.querySelector('header') as HTMLElement | null)?.offsetHeight ?? 0;

function tween(ms: number, fn: (k: number) => void) {
  return new Promise<void>(ok => {
    const t0 = performance.now();
    const tick = (t: number) => { const k = Math.min(1, (t - t0) / ms); fn(ease(k)); if (k < 1 && !P.stop) requestAnimationFrame(tick); else ok(); };
    requestAnimationFrame(tick);
  });
}
async function scrollToY(y: number, ms = 1300) {
  const y0 = scrollY, y1 = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight));
  await tween(ms, k => scrollTo(0, y0 + (y1 - y0) * k));
}
// bring an element to just under the sticky header (`center`: the middle of what is left), measuring again after
// each move in case something above it changed height on the way
async function focus(sel: string, { ms = 1300, center = false } = {}) {
  let e: HTMLElement | null = null;
  for (let i = 0; i < 4; i++) {
    e = document.querySelector(sel) as HTMLElement | null;
    if (!e) return null;
    const r = e.getBoundingClientRect(), hh = headerH(), room = innerHeight - hh;
    const y = Math.max(0, Math.min(scrollY + r.top - hh - (center && r.height < room ? (room - r.height) / 2 : 18), document.documentElement.scrollHeight - innerHeight));
    if (Math.abs(y - scrollY) < 3) break;
    await scrollToY(y, i ? 400 : ms);
    await sleep(150);
  }
  return e;
}
// move a synthetic pointer across a chart, so its hover readout (and the marker on the route map) travels along
async function sweep(svg: Element | null, ms: number, from = 0.02, to = 0.98) {
  if (!svg) return;
  const r = svg.getBoundingClientRect();
  await tween(ms, k => {
    const x = r.left + r.width * (from + (to - from) * k), y = r.top + r.height * 0.5;
    svg.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, pointerType: 'mouse' }));
  });
  svg.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
}
const cap = async (c: Caption, hold: number) => { set({ cap: c }); await sleep(hold); };
function setColor(mode: string) { S.colorBy = mode; emit('colorBy'); REG.atlas?.render(); }
async function waitFor(test: () => boolean, ms = 15000) { const t0 = performance.now(); while (!test() && performance.now() - t0 < ms) await sleep(100); }

// ---------------------------------------------------------------- the tour, from the data
const x0d = (gps: any[]) => gps[0]?.d ?? 0, x1d = (gps: any[]) => gps[gps.length - 1]?.d ?? 0;
function facts() {
  const gps = F.gps, foot = gps.filter((w: any) => ['walk', 'run', 'hike'].includes(w.type));
  const g0 = gps[0], g1 = gps[gps.length - 1];
  const years = Math.max(1, Math.round((x1d(gps) - x0d(gps)) / 365.25));
  const strava = (G.meta?.sources || []).some((s: any) => s.name === 'Strava archive');
  const steps = d3.sum(F.days, (d: any) => d.steps ?? 0);
  const byYear = d3.rollups(foot, (v: any[]) => d3.sum(v, (w: any) => w.dist), (w: any) => w.y).sort((a: any, b: any) => b[1] - a[1]);
  const pick = (label: string) => RECORDS.find((r: any) => r.label === label && r.w?.route);
  const long = pick('Longest hike') || pick('Longest run') || pick('Longest walk');
  const temps = gps.map((w: any) => w.temp).filter((t: any) => t != null);
  const watches = (G.sensors?.devices || []).filter((d: any) => d.cls === 'watch').map((d: any) => d.name.replace(/^Apple Watch /, ''));
  return { gps, g0, g1, years, strava, steps, best: byYear[0], long, tmin: d3.min(temps), tmax: d3.max(temps), watches,
    miles: d3.sum(gps, (w: any) => w.dist) };
}

async function tour() {
  const x = facts();
  const sources = `one Apple Health export${x.strava ? ' and a Strava archive' : ''}`;
  const steps: (() => Promise<void>)[] = [
    async () => { // title card
      scrollTo(0, 0); setColor('year');
      set({ card: { kind: 'title', title: 'Stride Atlas', sub: `${x.years} years on foot, from ${sources}.`, foot: 'Built on this computer · no accounts, no cloud' } });
      await sleep(3600); set({ card: null }); await sleep(500);
    },
    async () => { // every place at once, replayed, then a flight home; the map fills the screen under the header
      S.place = -1; emit('place');
      await focus('#mapwrap', { ms: 900 });
      await sleep(400);
      REG.atlas?.resize(); REG.atlas?.fit(REG.atlas.inFilter); REG.atlas?.render();
      await cap({ eyebrow: 'Every GPS route', title: `${fInt(x.gps.length)} routes, ${fInt(x.miles)} miles`, sub: `${MONTHS[x.g0.m]} ${x.g0.y} to ${MONTHS[x.g1.m]} ${x.g1.y}, drawn as light: the ground covered most glows brightest.` }, 3000);
      set({ cap: { eyebrow: 'Replay', title: `${x.g0.y} to now, in thirteen seconds` } });
      REG.atlas?.play(false);
      await sleep(600);
      await waitFor(() => !REG.atlas?.playing, 20000);
      await sleep(1200);
      const home = x.gps.filter((w: any) => w.place === 0).length;
      if (home) {
        set({ cap: null });
        REG.flyNext = 3200; S.place = 0; emit('place');
        await sleep(3400);
        await cap({ eyebrow: 'Home', title: `${fInt(home)} routes from home`, sub: S.share ? 'Share mode hides the streets around the front door.' : 'Every route that starts within 2 km of home.' }, 2800);
      }
    },
    async () => {
      setColor('time'); await cap({ eyebrow: 'Color by', title: 'Time of day', sub: 'The same routes, by start time.' }, 2600);
      setColor('temp'); await cap({ eyebrow: 'Color by', title: 'Temperature at the start', sub: 'Filled from the nearest weather station where Health did not record it.' }, 2600);
      setColor('year');
    },
    async () => {
      set({ cap: null }); await focus('#p-cal');
      await cap({ eyebrow: 'Rhythm', title: `${fK(x.steps)} steps since ${G.Y0}`, sub: 'Every day as one square, phone and watch deduplicated minute by minute.' }, 3200);
    },
    async () => {
      set({ cap: null }); await focus('#p-race');
      await cap({ eyebrow: 'Volume', title: x.best ? `${x.best[0]}: ${fInt(x.best[1])} miles on foot` : 'Year against year', sub: 'Cumulative miles, every year raced against the others.' }, 3200);
    },
    async () => {
      if (!x.long) return;
      set({ cap: null }); await focus(`[data-rec="${x.long.label}"]`, { center: true });
      const card = document.querySelector(`[data-rec="${x.long.label}"]`) as HTMLElement | null;
      card?.classList.add('pres-hl');
      await cap({ eyebrow: 'Records', title: `${x.long.label}: ${x.long.val}`, sub: `${customTitle(x.long.w) ? customTitle(x.long.w) + ', ' : ''}${fDate(x.long.w.d)}.` }, 3200);
      card?.classList.remove('pres-hl');
    },
    async () => {
      if (!x.long) return;
      const w = x.long.w;
      set({ cap: null }); openCloseup(w.id, false);
      await focus('#closeup');
      await waitFor(() => !!document.querySelector('#closeup .chart svg'), 8000);
      await sleep(500);
      set({ cap: { eyebrow: 'Close-up', title: `${f1(w.dist)} mi in ${fDur(w.elapsed)}`, sub: [w.gain != null ? `${fInt(w.gain)} ft climbed` : null, w.temp != null ? `${Math.round(w.temp)}°F at the start` : null, typeLabel(w).toLowerCase()].filter(Boolean).join(' · ') } });
      await sweep(document.querySelector('#closeup .chart svg'), 4200);
      await sleep(600);
    },
    async () => {
      const N = await loadStreets().catch(() => null);
      if (!N?.rings?.length) return;
      set({ cap: null }); await focus('#p-streets');
      const r1 = N.rings[0];
      await cap({ eyebrow: 'Exploration', title: `${d3.format('.0%')(r1.streets.share)} of the streets within a mile of home`, sub: `${d3.format('.0%')(r1.paths.share)} of the paths and trails. OpenStreetMap, matched on this computer.` }, 3400);
    },
    async () => {
      if (x.tmin == null) return;
      set({ cap: null }); await focus('#p-wx');
      await cap({ eyebrow: 'Terrain and weather', title: `From ${Math.round(x.tmin)}°F to ${Math.round(x.tmax)}°F`, sub: 'The temperature at the start of every outing.' }, 3000);
    },
    async () => {
      if (!x.watches.length) return;
      set({ cap: null }); await focus('#p-sensors');
      await cap({ eyebrow: 'Watches', title: x.watches.join(' → '), sub: 'Each metric starts when a device could first record it. Missing is never zero.' }, 3200);
    },
    async () => { // end card
      set({ cap: null });
      set({ card: { kind: 'end', title: 'Stride Atlas', sub: 'Your Apple Health export, mapped on your own machine.', foot: 'Every number traceable to its source' } });
      await sleep(3800);
    },
  ];
  set({ steps: steps.length });
  for (let i = 0; i < steps.length; i++) { set({ step: i }); await steps[i](); }
}

async function start() {
  if (P.running) return;
  set({ running: true, done: false, stop: false, cap: null, card: null });
  document.documentElement.classList.add('presenting');
  document.documentElement.style.setProperty('--hdr', headerH() + 'px');
  REG.fitPad = { top: 90, bottom: Math.round(innerHeight * 0.3), left: 60, right: 60 };
  try { await tour(); } catch (e) { if (!P.stop) console.error(e); }
  REG.atlas?.stop(); REG.fitPad = null;
  set({ running: false, done: true, cap: null, card: P.stop ? null : P.card });
}
function stop() { P.stop = true; REG.atlas?.stop(); set({ cap: null, card: null }); document.documentElement.classList.remove('presenting'); }

// ---------------------------------------------------------------- overlay
export function Presenter() {
  useWatch(['present']);
  useEffect(() => {
    (window as any).__present = { start, stop, get done() { return P.done; }, get running() { return P.running; }, ready: true };
    document.documentElement.classList.add('present-mode');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const c = P.cap, card = P.card;
  return (
    <div className="pres" aria-live="polite">
      {!P.running && !P.done && <button type="button" className="pres-play" onClick={start}><svg viewBox="0 0 12 12"><path d="M2 1l9 5-9 5z" /></svg>Play the tour</button>}
      <div className={'pres-cap' + (c ? ' on' : '')} key={c ? c.title : 'none'}>
        {c?.eyebrow && <div className="eyebrow">{c.eyebrow}</div>}
        {c && <div className="t">{c.title}</div>}
        {c?.sub && <div className="s">{c.sub}</div>}
      </div>
      <div className={'pres-card' + (card ? ' on' : '')}>
        <Topo idx={card?.kind === 'end' ? 4 : 1} />
        {card && <div className="in">
          <svg className="mark" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="12" fill="none" stroke="var(--edge-strong)" strokeWidth="1.2" /><path className="route" d="M5 17 C 9 6, 13 20, 17 9 S 21 8, 22 7" fill="none" stroke="var(--signal)" strokeWidth="2" strokeLinecap="round" pathLength={1} /><circle cx="5" cy="17" r="2" fill="var(--signal)" /></svg>
          <div className="t">{card.title}</div>
          <div className="s">{card.sub}</div>
          {card.foot && <div className="f">{card.foot}</div>}
        </div>}
      </div>
      <div className="pres-prog" style={{ transform: `scaleX(${P.running ? (P.step + 1) / P.steps : P.done ? 1 : 0})` }} />
    </div>
  );
}
