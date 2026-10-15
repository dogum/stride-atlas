// Presentation mode: a scripted tour of the dashboard for screen recordings and demos.
// Open the app with ?present=1 (and &share=1 to hide home) and press Play, or let scripts/record.mjs call
// window.__present.prep() and then start(). Every caption is computed from the loaded data, so the tour works for anyone's
// export. The tour runs on a musical clock (BPM below): sections start on bar lines and clicks land on beats, and
// window.__present.timeline tells scripts/record.mjs where the bars fell so the soundtrack lines up with the cuts.
import { useEffect } from 'react';
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, REG, S, emit, useWatch } from './store';
import { MONTHS, customTitle, f1, fDate, fDur, fInt, fK, fPace } from './core';
import { RECORDS } from './charts/terrain';
import { openCloseup } from './charts/closeup';
import { loadSleep, loadStreets } from './data';
import { streetShares } from './charts/streets';
import { Topo } from './components/ui';
import { CREDIT, VERSION } from './credits';

type Caption = { eyebrow?: string; title: string; sub?: string; right?: boolean } | null;
type Card = { kind: 'hero' | 'end'; title: string; sub: string; foot?: string; url?: string; credit?: string } | null;
const P = { cap: null as Caption, card: null as Card, kind: 'end', running: false, done: false, step: 0, steps: 1, stop: false, prepped: false };
// the card keeps its kind while it fades out
const set = (patch: Partial<typeof P>) => { Object.assign(P, patch); if (patch.card) P.kind = patch.card.kind; emit('present'); };
export const PRESENT = new URLSearchParams(location.search).get('present');
// ?present=short: the 15-second cut for posting an update (what is new, a beat each)
export const SHORT = PRESENT === 'short';

export const BPM = 128;
const BAR = 4 * 60000 / BPM; // ms; one bar is 1.875 s
let T0 = 0;
const timeline: any = { bpm: BPM, t0: 0, bars: 0, cues: {}, sections: [] as any[] };

const sleep = (ms: number) => new Promise<void>((ok, no) => setTimeout(() => (P.stop ? no(new Error('stopped')) : ok()), Math.max(0, ms)));
const at = (bar: number) => sleep(T0 + bar * BAR - performance.now());
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const headerH = () => (document.querySelector('header') as HTMLElement | null)?.offsetHeight ?? 0;
const tall = () => innerHeight > innerWidth;

function tween(ms: number, fn: (k: number) => void, e = ease) {
  return new Promise<void>(ok => {
    const t0 = performance.now();
    const tick = (t: number) => { const k = Math.max(0, Math.min(1, (t - t0) / ms)); fn(e(k)); if (k < 1 && !P.stop) requestAnimationFrame(tick); else ok(); };
    requestAnimationFrame(tick);
  });
}
async function scrollToY(y: number, ms: number) {
  const y0 = scrollY, y1 = Math.max(0, Math.min(y, document.documentElement.scrollHeight - innerHeight));
  await tween(ms, k => scrollTo(0, y0 + (y1 - y0) * k));
}
// bring an element to just under the sticky header (`center`: the middle of what is left), measuring again after
// each move in case something above it changed height on the way
async function focus(sel: string, { ms = 700, center = false } = {}) {
  let e: HTMLElement | null = null;
  for (let i = 0; i < 3; i++) {
    e = document.querySelector(sel) as HTMLElement | null;
    if (!e) return null;
    const r = e.getBoundingClientRect(), hh = headerH(), room = innerHeight - hh;
    const y = Math.max(0, Math.min(scrollY + r.top - hh - (center && r.height < room ? (room - r.height) / 2 : 14), document.documentElement.scrollHeight - innerHeight));
    if (Math.abs(y - scrollY) < 3) break;
    await scrollToY(y, i ? Math.min(250, ms) : ms);
  }
  return e;
}

// ---------------------------------------------------------------- the pointer: moves like a hand, clicks on the beat
const CUR = { x: 0, y: 0, el: null as HTMLDivElement | null };
function placeCursor() { if (CUR.el) CUR.el.style.transform = `translate(${CUR.x}px, ${CUR.y}px)`; }
function showCursor(on: boolean) { CUR.el?.classList.toggle('on', on); }
async function cursorTo(x: number, y: number, ms: number) {
  const x0 = CUR.x, y0 = CUR.y;
  showCursor(true);
  await tween(ms, k => { CUR.x = x0 + (x - x0) * k; CUR.y = y0 + (y - y0) * k; placeCursor(); });
}
function ripple() {
  const r = document.createElement('div');
  r.className = 'pres-ripple'; r.style.left = CUR.x + 'px'; r.style.top = CUR.y + 'px';
  document.querySelector('.pres')?.appendChild(r);
  setTimeout(() => r.remove(), 700);
}
const btn = (scope: string, label: string) => [...document.querySelectorAll(`${scope} .seg button`)].find(b => (b.textContent || '').trim().startsWith(label) && !(b as HTMLButtonElement).disabled) as HTMLButtonElement | undefined;
// travel to a button so the press lands exactly on `bar`, then press it
async function clickAt(bar: number, el: Element | null | undefined, travel = 320) {
  if (!el) return false;
  await sleep(T0 + bar * BAR - travel - performance.now());
  const r = el.getBoundingClientRect();
  await cursorTo(r.left + r.width / 2, r.top + r.height / 2, travel);
  CUR.el?.classList.add('down'); ripple();
  (el as HTMLElement).click();
  setTimeout(() => CUR.el?.classList.remove('down'), 160);
  return true;
}
// a hand moving across a chart, so its hover readout (and the marker on the route map) travels along
async function sweep(svg: Element | null, ms: number, from = 0.03, to = 0.97, yk = 0.5) {
  if (!svg) return;
  const r = svg.getBoundingClientRect(), y = r.top + r.height * yk;
  await cursorTo(r.left + r.width * from, y, 280);
  await tween(ms, k => {
    CUR.x = r.left + r.width * (from + (to - from) * k); CUR.y = y; placeCursor();
    svg.dispatchEvent(new PointerEvent('pointermove', { clientX: CUR.x, clientY: CUR.y, bubbles: true, pointerType: 'mouse' }));
  }, t => t);
  svg.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
}
const cap = (c: Caption) => set({ cap: c });
async function waitFor(test: () => boolean, ms = 15000) { const t0 = performance.now(); while (!test() && performance.now() - t0 < ms) await sleep(100); }

// ---------------------------------------------------------------- facts, from the data
function facts() {
  const gps = F.gps, foot = gps.filter((w: any) => ['walk', 'run', 'hike'].includes(w.type));
  const g0 = gps[0], g1 = gps[gps.length - 1];
  const years = Math.max(1, Math.round(((g1?.d ?? 0) - (g0?.d ?? 0)) / 365.25));
  const strava = (G.meta?.sources || []).some((s: any) => s.name === 'Strava archive');
  const steps = d3.sum(F.days, (d: any) => d.steps ?? 0);
  const byYear = d3.rollups(foot, (v: any[]) => d3.sum(v, (w: any) => w.dist), (w: any) => w.y).sort((a: any, b: any) => b[1] - a[1]);
  const pick = (label: string) => RECORDS.find((r: any) => r.label === label && r.w?.route);
  const long = pick('Longest hike') || pick('Longest run') || pick('Longest walk');
  const temps = gps.map((w: any) => w.temp).filter((t: any) => t != null);
  const watches = (G.sensors?.devices || []).filter((d: any) => d.cls === 'watch').map((d: any) => d.name.replace(/^Apple Watch /, ''));
  const med = (t: string) => { const v = gps.filter((w: any) => w.type === t && isFinite(w.pace)).map((w: any) => w.pace); return v.length >= 5 ? { n: v.length, pace: d3.median(v) as number } : null; };
  const inF = new Set(gps.map((w: any) => w.id));
  const bestOf = (type: string, label: string) => d3.min((G.bestEfforts || []).filter((b: any) => b.type === type && b.distance_label === label && inF.has(b.id)), (b: any) => b.seconds) as number | undefined;
  const swims = F.all.filter((w: any) => w.type === 'swim');
  return { gps, g0, g1, years, strava, steps, best: byYear[0], long, tmin: d3.min(temps), tmax: d3.max(temps), watches, med, bestOf,
    miles: d3.sum(gps, (w: any) => w.dist), dayMiles: d3.sum(F.days, (d: any) => d.mi ?? 0), swims, swimYd: d3.sum(swims, (w: any) => w.yards) };
}
const fT = (s: number) => s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- the tour
type Step = { name: string; bars: number; run: (b: number) => Promise<void> };
// scroll so the panel arrives on the downbeat, caption cleared on the way
async function arrive(b: number, sel: string, opts: { center?: boolean } = {}) {
  await at(b - 0.42);
  cap(null);
  await focus(sel, { ms: Math.round(0.4 * BAR), ...opts });
  await at(b);
}

function steps(x: ReturnType<typeof facts>, N: any): Step[] {
  const sources = `one Apple Health export${x.strava ? ' and a Strava archive' : ''}`;
  const out: Step[] = [];
  const homeN = x.gps.filter((w: any) => w.place === 0).length;
  out.push({ name: 'atlas', bars: 7, run: async b => {
    // the hook: routes start drawing on the first frame, under the title
    set({ card: { kind: 'hero', title: 'Stride Atlas', sub: `${x.years} years on foot` } });
    REG.atlas?.play(false, 3.5 * BAR / 1000);
    await at(b + 2);
    set({ card: null });
    cap({ eyebrow: 'Every GPS route', title: `${fInt(x.gps.length)} routes, ${fInt(x.miles)} miles`, sub: `${MONTHS[x.g0.m]} ${x.g0.y} to ${MONTHS[x.g1.m]} ${x.g1.y}, from ${sources}, drawn as light.` });
    await at(b + 3.7);
    if (homeN) {
      REG.flyNext = Math.round(BAR * 1.15); S.place = 0; emit('place');
      await at(b + 4.15);
      cap({ eyebrow: 'Home', title: `${fInt(homeN)} routes from home`, sub: S.share ? 'Share mode hides the streets around the front door.' : 'Every route that starts within 2 km of home.' });
    }
    // four colorings, one every two beats
    const modes: [string, string][] = [['Time of day', 'Colored by time of day'], ['Temperature', 'Colored by temperature'], ['Pace', 'Colored by pace'], ['Heart rate', 'Colored by heart rate']];
    for (let i = 0; i < modes.length; i++) {
      if (await clickAt(b + 5 + i * 0.5, btn('#mapwrap .map-ui', modes[i][0]), i ? 220 : 380)) cap({ eyebrow: 'Color by', title: modes[i][1] });
    }
    await clickAt(b + 6.5, btn('#mapwrap .map-ui', 'Year'), 220);
  } });
  if (REG.stack?.pieces?.length) out.push({ name: 'stack', bars: 6, run: async b => {
    S.stackMode = 'date'; REG.stack.setMode('date'); emit('stack');
    REG.stackSpin = 0.16;
    await arrive(b, '#p-stack');
    const i = REG.stack.info;
    const yrs = Math.max(1, Math.round((i.d1 - i.d0) / 365.25));
    cap({ eyebrow: 'In 3D', title: 'Every route, stacked by date', sub: `${fInt(i.n)} routes around ${i.name}, ${yrs} year${yrs > 1 ? 's' : ''} tall. Loops walked for years rise as columns.` });
    if (await clickAt(b + 2, btn('#p-stack .p-tools', 'Time of day'))) {
      await at(b + 2.5); cap({ eyebrow: 'In 3D', title: 'Stacked by time of day', sub: 'Midnight at the floor: mornings sit low, evenings high.' });
    }
    if (G.routeEle && await clickAt(b + 4, btn('#p-stack .p-tools', 'Elevation'))) {
      await at(b + 4.5); cap({ eyebrow: 'In 3D', title: 'Stacked by elevation', sub: `The ground under every route, ${i.exag}× taller than life.` });
    }
  } });
  out.push({ name: 'rhythm', bars: 2, run: async b => {
    await arrive(b, '#p-cal');
    cap({ eyebrow: 'Rhythm', title: `${fK(x.steps)} steps since ${G.Y0}`, sub: 'Every day as one square, phone and watch deduplicated minute by minute.' });
    if (x.dayMiles > 0 && await clickAt(b + 1, btn('#p-cal', 'Miles'))) cap({ eyebrow: 'Rhythm', title: `${fInt(x.dayMiles)} miles walked and run`, sub: 'The same calendar, by distance.' });
  } });
  out.push({ name: 'volume', bars: 2, run: async b => {
    await arrive(b, '#p-race');
    cap({ eyebrow: 'Volume', title: x.best ? `${x.best[0]}: ${fInt(x.best[1])} miles on foot` : 'Year against year', sub: 'Cumulative miles, every year raced against the others.' });
    await sweep(document.querySelector('#p-race .chart svg'), 1.45 * BAR, 0.08, 0.92, 0.42);
  } });
  const walk = x.med('walk'), run = x.med('run') || x.med('hike');
  if (walk || run) out.push({ name: 'effort', bars: 2, run: async b => {
    if (S.effortType !== 'walk' && walk) { S.effortType = 'walk'; emit('effort'); }
    await arrive(b, '#effort');
    const [noun, first] = walk ? ['Walks', walk] : ['Runs', run!];
    cap({ eyebrow: 'Pace & effort', title: `${noun}: ${fPace(first.pace)} a mile, typically`, sub: `${fInt(first.n)} of them, each dot colored by the temperature at the start.` });
    if (walk && run) {
      const lbl = x.med('run') ? 'Run' : 'Hike';
      if (await clickAt(b + 1, btn('#effort .ch-head', lbl))) cap({ eyebrow: 'Pace & effort', title: `${lbl}s: ${fPace(run.pace)} a mile, typically`, sub: `${fInt(run.n)} of them. Pick the activity and every chart in the chapter follows.` });
    }
  } });
  if (x.tmin != null) out.push({ name: 'weather', bars: 2, run: async b => {
    await arrive(b, '#p-wx');
    cap({ eyebrow: 'Terrain & weather', title: `From ${Math.round(x.tmin)}°F to ${Math.round(x.tmax)}°F`, sub: 'The temperature at the start of every outing, from Health or the nearest weather station.' });
    await sweep(document.querySelector('#p-wx .chart svg'), 1.45 * BAR, 0.06, 0.94);
  } });
  if (RECORDS.some((r: any) => r.w)) out.push({ name: 'records', bars: 2, run: async b => {
    await arrive(b, '#recs');
    // four cards on screen above the caption, the headline records first
    const hh = headerH(), low = innerHeight * (tall() ? 0.62 : 0.7);
    const seen = [...document.querySelectorAll('.rec-card[data-rec]')].filter(e => { const r = e.getBoundingClientRect(); return r.top > hh && r.bottom < low; }).map(e => (e as HTMLElement).dataset.rec);
    const pref = ['Longest hike', 'Longest run', 'Longest walk', 'Most climbing', 'Hottest', 'Coldest', 'Earliest start', 'Fastest mile'];
    const recs: any[] = [...pref.filter(l => seen.includes(l)), ...seen.filter(l => !pref.includes(l!))].slice(0, 4).map(l => RECORDS.find((r: any) => r.label === l && r.w)).filter(Boolean);
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i], card = document.querySelector(`[data-rec="${r.label}"]`) as HTMLElement | null;
      await at(b + i * 0.5);
      document.querySelectorAll('.rec-card.pres-hl').forEach(e => e.classList.remove('pres-hl'));
      card?.classList.add('pres-hl');
      cap({ eyebrow: 'Records', title: `${r.label}: ${r.val}`, sub: `${customTitle(r.w) ? customTitle(r.w) + ', ' : ''}${fDate(r.w.d)}` });
    }
    await at(b + 1.9);
    document.querySelectorAll('.rec-card.pres-hl').forEach(e => e.classList.remove('pres-hl'));
  } });
  const bt = S.types.has('walk') && x.bestOf('walk', '1 mi') ? 'walk' : x.bestOf('run', '1 mi') ? 'run' : null;
  if (bt) out.push({ name: 'bests', bars: 2, run: async b => {
    await arrive(b, '#p-prog');
    const noun = bt === 'walk' ? 'walked' : 'run';
    const show = (d: string) => { const s = x.bestOf(bt, d); if (s) cap({ eyebrow: 'Best efforts', title: `Fastest ${d} ${noun}: ${fT(s)}`, sub: 'Found inside every GPS track, not just whole workouts.' }); };
    show('1 mi');
    const next = ['5K', '2 mi', '5 mi'].find(d => x.bestOf(bt, d));
    if (next && await clickAt(b + 1, btn('#p-prog', next))) show(next);
  } });
  const R = N ? streetShares() : [];
  // the same shares the panel shows (share mode leaves out the streets it hides)
  const pct = (v: number) => v < 0.1 ? d3.format('.1%')(v) : d3.format('.0%')(v);
  if (R.length) out.push({ name: 'streets', bars: 2, run: async b => {
    await arrive(b, '#p-streets');
    cap({ eyebrow: 'Exploration', title: `${pct(R[0].streets)} of the streets within a mile of home`, sub: `${pct(R[0].paths)} of the paths and trails. OpenStreetMap, matched on this computer.` });
    if (R[1] && await clickAt(b + 1, btn('#p-streets', '2 mi'))) cap({ eyebrow: 'Exploration', title: `${pct(R[1].streets)} within two miles`, sub: 'Every street segment you have walked, run or hiked.' });
  } });
  if (x.long) out.push({ name: 'closeup', bars: 3, run: async b => {
    const w = x.long.w;
    await arrive(b, '#closeup');
    cap({ eyebrow: 'Close-up · ' + x.long.label, title: `${f1(w.dist)} mi in ${fDur(w.elapsed)}`, sub: [customTitle(w), w.gain != null ? `${fInt(w.gain)} ft climbed` : null, fDate(w.d)].filter(Boolean).join(' · '), right: !tall() });
    await sweep(document.querySelector('#closeup .chart svg'), 2.5 * BAR, 0.02, 0.98, 0.3);
  } });
  if (x.swims.length >= 10) out.push({ name: 'pool', bars: 2, run: async b => {
    await arrive(b, '#p-swim');
    cap({ eyebrow: 'Pool & weights', title: `${fInt(x.swims.length)} swims, ${f1(x.swimYd / 1760)} miles`, sub: 'Laps, strokes and SWOLF from the watch: the workouts without a map.' });
  } });
  if (G.health?.tracks?.length) out.push({ name: 'health', bars: 2, run: async b => {
    await arrive(b, '#p-track');
    cap({ eyebrow: 'Data health', title: 'Cleaned before any chart sees it', sub: `${fInt(G.health.log_rows)} fixes logged, each one traceable to the raw export.` });
    await clickAt(b + 0.75, btn('#p-track', 'Raw'));
    await clickAt(b + 1.25, btn('#p-track', 'Cleaned'));
  } });
  if (x.watches.length) out.push({ name: 'watches', bars: 2, run: async b => {
    await arrive(b, '#p-sensors');
    cap({ eyebrow: 'Watches', title: x.watches.join(' → '), sub: 'Each metric starts when a device could first record it. Missing is never zero.' });
  } });
  out.push({ name: 'end', bars: 3, run: async b => {
    await at(b - 0.3);
    cap(null); showCursor(false);
    set({ card: { kind: 'end', title: 'Stride Atlas', sub: 'Your Apple Health export, mapped on your own machine.', foot: CREDIT.repo ? 'Open source' : 'Open source · build yours with Claude Code', url: CREDIT.repo ? CREDIT.repo.replace(/^https?:\/\/(www\.)?/, '') : undefined, credit: `by ${CREDIT.by} · built with ${CREDIT.with}` } });
    await at(b + 3);
  } });
  return out;
}

// ---------------------------------------------------------------- the 15-second cut
// Eight bars at 128 BPM are 15 seconds: the routes drawing under the title, then what this release added, then the
// end card. The music drops when the 3D view lands. Share mode leaves the Breathing chapter out, and the tour never
// goes near it.
function shortSteps(x: ReturnType<typeof facts>): Step[] {
  const out: Step[] = [];
  // hard cuts on the beat: a long scroll would pass half-drawn chapters on the way
  const cut = async (b: number, sel: string) => { await at(b - 0.06); cap(null); await focus(sel, { ms: 1 }); await at(b); };
  const sources = `one Apple Health export${x.strava ? ' and a Strava archive' : ''}`;
  out.push({ name: 'atlas', bars: 2, run: async b => {
    set({ card: { kind: 'hero', title: 'Stride Atlas', sub: `v${VERSION}: what's new` } });
    REG.atlas?.play(false, 1.9 * BAR / 1000);
    await at(b + 1);
    set({ card: null });
    cap({ eyebrow: 'Every GPS route', title: `${fInt(x.gps.length)} routes, ${fInt(x.miles)} miles`, sub: `${x.years} years from ${sources}, drawn as light.` });
  } });
  if (REG.stack?.pieces?.length) out.push({ name: 'stack', bars: 1.5, run: async b => {
    S.stackMode = 'date'; REG.stack.setMode('date'); emit('stack');
    REG.stackSpin = 0.3;
    await cut(b, '#p-stack');
    cap({ eyebrow: 'New · Life milestones', title: 'The moments behind the data', sub: 'A move, a new baby, a new job: faint on every chart, and rings in 3D.' });
    await clickAt(b + 0.75, btn('#p-stack .p-tools', 'Time of day'), 260);
  } });
  if ((G.body?.hrr?.length ?? 0) >= 10) out.push({ name: 'body', bars: 1, run: async b => {
    await cut(b, '#p-hrr');
    cap({ eyebrow: 'New · Heart & movement', title: 'How fast your heart recovers', sub: 'After every workout, with walking steadiness and stair speed.' });
    await sweep(document.querySelector('#p-hrr .chart svg'), 0.75 * BAR, 0.35, 0.98, 0.45);
  } });
  if (G.sleep?.nights?.length) out.push({ name: 'sleep', bars: 2, run: async b => {
    await at(b - 0.3);
    cap(null); showCursor(false);
    scrollTo(0, 0);
    S.view = 'sleep'; emit('view');                    // a new page: the Sleep tab, from its top
    await waitFor(() => !!document.querySelector('#p-barcode canvas, #p-barcode svg'), 1500);
    await focus('#p-barcode', { ms: 1 });
    await at(b);
    const N = G.sleep.nights;
    cap({ eyebrow: 'New · Sleep', title: `${fInt(N.length)} nights, one picture`, sub: `Every night since ${N[0].y}, colored by stage, one source per night.` });
    await cut(b + 1, '#stages');
    cap({ eyebrow: 'New · Sleep', title: 'Deep, core and REM', sub: 'And a typical night, lined up at the moment you fell asleep.' });
  } });
  out.push({ name: 'end', bars: 1.5, run: async b => {
    await at(b - 0.2);
    cap(null); showCursor(false);
    set({ card: { kind: 'end', title: 'Stride Atlas', sub: `New in v${VERSION}: sleep, life milestones, heart and movement.`, foot: 'Free and open source', url: CREDIT.repo ? CREDIT.repo.replace(/^https?:\/\/(www\.)?/, '') : undefined, credit: `by ${CREDIT.by} · built with ${CREDIT.with}` } });
    await at(b + 1.5);
  } });
  return out;
}

// the frame before the first bar: the map fills the screen under the header, empty, everything drawn and loaded
async function prep() {
  if (P.prepped) return;
  set({ running: false, done: false, stop: false, cap: null, card: null });
  document.documentElement.classList.add('presenting');
  document.documentElement.style.setProperty('--hdr', headerH() + 'px');
  REG.fitPad = { top: 80, bottom: Math.round(innerHeight * (tall() ? 0.36 : 0.3)), left: 50, right: 50 };
  const x = facts();
  if (x.long) openCloseup(x.long.w.id, false);           // draw the close-up now, not when the tour gets there
  S.colorBy = 'year'; emit('colorBy');
  // the short cut has no time for the flight home: it opens there (routes in many places are specks on the whole map)
  S.place = SHORT && x.gps.some((w: any) => w.place === 0) ? 0 : -1; emit('place');
  await new Promise(r => setTimeout(r, 300));
  const m = document.querySelector('#mapwrap') as HTMLElement;
  scrollTo(0, scrollY + m.getBoundingClientRect().top - headerH() - 12);
  await new Promise(r => setTimeout(r, 400));
  REG.atlas?.resize(); REG.atlas?.fit(REG.atlas.inFilter);
  REG.atlas?.blank();
  CUR.x = innerWidth * 0.78; CUR.y = innerHeight * 0.72; placeCursor();
  await waitFor(() => !!REG.stack?.pieces?.length || !REG.stack, 8000);
  REG.stack?.fit();
  if (SHORT) await loadSleep().catch(() => null);
  set({ prepped: true });
}

async function start() {
  if (P.running) return;
  await prep();
  set({ running: true, done: false, stop: false });
  const plan: { s: Step; b: number }[] = [];
  let bar = 0;
  const N = SHORT ? null : await loadStreets().catch(() => null);
  for (const s of SHORT ? shortSteps(facts()) : steps(facts(), N)) { plan.push({ s, b: bar }); bar += s.bars; }
  T0 = performance.now();
  // the soundtrack counts whole bars: the short cut's outro resolves on the bar after its end card fades in
  const outro = SHORT ? Math.ceil(plan[plan.length - 1].b) : plan[plan.length - 1].b;
  Object.assign(timeline, { t0: performance.timeOrigin + T0, bars: Math.ceil(bar), cues: { drop: 2, outro, ...(SHORT ? { accents: [] } : {}) }, sections: plan.map(p => ({ name: p.s.name, bar: p.b })) });
  set({ steps: plan.length });
  try {
    for (let i = 0; i < plan.length; i++) { set({ step: i }); await plan[i].s.run(plan[i].b); }
  } catch (e) { if (!P.stop) console.error(e); }
  REG.atlas?.stop(); REG.fitPad = null; REG.stackSpin = undefined;
  set({ running: false, done: true, cap: null, card: P.stop ? null : P.card });
}
function stop() { P.stop = true; REG.atlas?.stop(); showCursor(false); set({ cap: null, card: null }); document.documentElement.classList.remove('presenting'); }

// ---------------------------------------------------------------- overlay
export function Presenter() {
  useWatch(['present']);
  useEffect(() => {
    (window as any).__present = { prep, start, stop, get done() { return P.done; }, get running() { return P.running; }, get timeline() { return timeline; }, ready: true };
    document.documentElement.classList.add('present-mode');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') stop(); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);
  const c = P.cap, card = P.card;
  return (
    <div className="pres" aria-live="polite">
      {!P.running && !P.done && !P.prepped && <button type="button" className="pres-play" onClick={start}><svg viewBox="0 0 12 12"><path d="M2 1l9 5-9 5z" /></svg>Play the tour</button>}
      <div className={'pres-cap' + (c ? ' on' : '') + (c?.right ? ' right' : '')} key={c ? c.title : 'none'}>
        {c?.eyebrow && <div className="eyebrow">{c.eyebrow}</div>}
        {c && <div className="t">{c.title}</div>}
        {c?.sub && <div className="s">{c.sub}</div>}
      </div>
      <div className={'pres-card ' + P.kind + (card ? ' on' : '')}>
        {P.kind === 'end' && <Topo idx={4} />}
        {card && <div className="in">
          <svg className="mark" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="12" fill="none" stroke="var(--edge-strong)" strokeWidth="1.2" /><path className="route" d="M5 17 C 9 6, 13 20, 17 9 S 21 8, 22 7" fill="none" stroke="var(--signal)" strokeWidth="2" strokeLinecap="round" pathLength={1} /><circle cx="5" cy="17" r="2" fill="var(--signal)" /></svg>
          <div className="t">{card.title}</div>
          <div className="s">{card.sub}</div>
          {card.foot && <div className="f">{card.foot}{card.url && <> · <span className="url">{card.url}</span></>}</div>}
          {card.credit && <div className="cr">{card.credit}</div>}
        </div>}
      </div>
      <div className={'pres-cursor' + (tall() ? ' touch' : '')} ref={el => { CUR.el = el; placeCursor(); }}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2.5v17.2l4.6-4.3 2.9 6.6 2.9-1.3-2.9-6.5h6.3z" fill="#fff" stroke="#0b1220" strokeWidth="1.4" strokeLinejoin="round" /></svg>
      </div>
      <div className="pres-prog" style={{ transform: `scaleX(${P.running ? (P.step + 1) / P.steps : P.done ? 1 : 0})` }} />
    </div>
  );
}
