import { useEffect, useRef, useState } from 'react';
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { DEMO, G, GPS_TYPES, MODE, S, emit, useWatch } from '../store';
import { CREDIT } from '../credits';
import { MilestonesButton } from './milestones';
import { SHARE_HIDDEN, SLEEP_CHAPTERS } from './sleep';
import { TYPE, fInt, fK } from '../core';

export const CHAPTERS = [['atlas', 'Atlas'], ['stack', 'In 3D'], ['rhythm', 'Rhythm'], ['volume', 'Volume'], ['effort', 'Pace & effort'], ['body', 'Heart & movement'], ['terrain', 'Terrain & weather'], ['records', 'Records'], ['bests', 'Bests'], ['closeup', 'Close-up'], ['pool', 'Pool & weights'], ['health', 'Data health'], ['watches', 'Watches'], ['about', 'About']];

export function applyFilter() {
  if (!S.types.has(S.effortType)) S.effortType = ['walk', 'run', 'hike'].find(k => S.types.has(k)) || 'walk';
  emit('filter');
}

function YearStrip() {
  useWatch(['filter']);
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<[number, number] | null>(null);
  const anchor = useRef<number | null>(null);
  const mi = d3.rollup(G.workouts.filter((w: any) => GPS_TYPES.includes(w.type) && S.types.has(w.type) && w.outdoor), v => d3.sum(v, (w: any) => w.dist), (w: any) => w.y);
  const mx = d3.max([...mi.values()]) || 1;
  const yearAt = (e: any) => { const t = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement)?.closest('.ycol') as HTMLElement | null; return t ? +t.dataset.y! : null; };
  const set = (a: number, b: number) => { if (a === b && S.y0 === a && S.y1 === b) { S.y0 = G.Y0; S.y1 = G.Y1; } else { S.y0 = a; S.y1 = b; } applyFilter(); };
  const on = (y: number) => drag ? y >= drag[0] && y <= drag[1] : y >= S.y0 && y <= S.y1;
  return (
    <div className="yearstrip" ref={ref} role="group" aria-labelledby="yrLbl"
      onPointerDown={e => { const y = yearAt(e); if (y == null) return; anchor.current = y; ref.current!.setPointerCapture(e.pointerId); setDrag([y, y]); }}
      onPointerMove={e => { if (anchor.current == null) return; const y = yearAt(e); if (y == null) return; setDrag([Math.min(anchor.current, y), Math.max(anchor.current, y)]); }}
      onPointerUp={e => { if (anchor.current == null) return; const y = yearAt(e) ?? anchor.current; const a = Math.min(anchor.current, y), b = Math.max(anchor.current, y); anchor.current = null; setDrag(null); set(a, b); }}>
      {G.years.map((y: number) => (
        <div key={y} className={'ycol' + (on(y) ? ' on' : '')} data-y={y} role="button" tabIndex={0} aria-pressed={on(y)} aria-label={`${y}, ${fInt(mi.get(y) || 0)} miles`}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(y, y); } }}>
          <div className="yb" style={{ height: Math.max(3, (mi.get(y) || 0) / mx * 22) + 'px' }} />
          <div className="yl">'{String(y).slice(2)}</div>
        </div>
      ))}
    </div>
  );
}

function Chips() {
  useWatch(['filter']);
  return (
    <div className="chips">
      {GPS_TYPES.map(t => {
        const n = G.workouts.filter((w: any) => w.type === t && w.outdoor && !w.fragment && w.y >= S.y0 && w.y <= S.y1).length;
        return (
          <button key={t} type="button" className="chip" aria-pressed={S.types.has(t)} title={n ? '' : `No GPS-recorded ${TYPE[t].name.toLowerCase()}s in this range`}
            onClick={() => { if (S.types.has(t)) { if (S.types.size > 1) S.types.delete(t); } else S.types.add(t); applyFilter(); }}>
            <span className="dot" style={{ ['--c' as any]: `var(${TYPE[t].tok})` }} />{TYPE[t].name} <span className="mono" style={{ color: 'var(--ink-4)', fontSize: 11 }}>{fK(n)}</span>
          </button>
        );
      })}
    </div>
  );
}

const THEMES = ['auto', 'dark', 'light'];
function ThemeToggle() {
  const [t, setT] = useState(() => { try { return localStorage.getItem('stride-theme') || 'auto'; } catch { return 'auto'; } });
  useEffect(() => {
    if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('stride-theme', t); } catch { /* private mode */ }
    MODE.quiet = true; emit('theme'); requestAnimationFrame(() => { MODE.quiet = false; });
  }, [t]);
  return <button className="ghost" type="button" title="Theme: follow the system, dark or light" onClick={() => setT(THEMES[(THEMES.indexOf(t) + 1) % 3])}>{t === 'auto' ? 'Auto theme' : t === 'dark' ? 'Dark' : 'Light'}</button>;
}

// two pages: the activity dashboard and the sleep deep dive, switched by the URL hash
export function setView(v: 'activity' | 'sleep') {
  if (S.view === v) return;
  S.view = v; history.replaceState(null, '', v === 'sleep' ? '#sleep' : location.pathname + location.search);
  scrollTo(0, 0); emit('view');
}
function Views() {
  useWatch(['view']);
  return (
    <nav className="views" aria-label="Pages">
      {([['activity', 'Activity'], ['sleep', 'Sleep']] as const).map(([k, l]) => (
        <a key={k} href={k === 'sleep' ? '#sleep' : '#'} aria-current={S.view === k ? 'page' : undefined} onClick={e => { e.preventDefault(); setView(k); }}>{l}</a>
      ))}
    </nav>
  );
}

export function Header() {
  useWatch(['filter', 'share', 'view']);
  const lbl = S.y0 === G.Y0 && S.y1 === G.Y1 ? 'Years' : S.y0 === S.y1 ? `${S.y0}` : `${S.y0}–${String(S.y1).slice(2)}`;
  const exp = G.meta?.export_date?.slice(0, 10);
  return (
    <header className="bar">
      {DEMO && <div className="demo-bar"><span><b>Live demo</b> with synthetic data for Alex, who does not exist.</span>
        <a href="?present=1">Play the 70-second tour</a><a href={CREDIT.repo || '#'}>Build yours from your Apple Health export →</a></div>}
      <div className="bar-in">
        <div className="brand">
          <svg className="mark" viewBox="0 0 26 26" aria-hidden="true"><circle cx="13" cy="13" r="12" fill="none" stroke="var(--edge-strong)" strokeWidth="1.2" /><path d="M5 17 C 9 6, 13 20, 17 9 S 21 8, 22 7" fill="none" stroke="var(--signal)" strokeWidth="2" strokeLinecap="round" /><circle cx="5" cy="17" r="2" fill="var(--signal)" /></svg>
          <span className="name">Stride Atlas</span>
          <span className="badge" title={DEMO ? 'A synthetic export for a person who does not exist' : 'Built from your Apple Health export on this computer'}>{exp ? `${DEMO ? 'Demo data' : 'Your data'} · ${new Date(exp + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}` : 'Your data'}</span>
          {S.share && <span className="badge" title="Route ends near home are hidden">Share mode</span>}
          <Views />
        </div>
        <div className="filters">
          <div className="fgroup"><span className="flabel" id="yrLbl">{lbl}</span><YearStrip /></div>
          {S.view !== 'sleep' && <div className="fgroup"><span className="flabel">Activities</span><Chips /></div>}
          <div className="bar-tools">
            <MilestonesButton />
            <button className="ghost" type="button" onClick={() => { S.y0 = G.Y0; S.y1 = G.Y1; S.types = new Set(GPS_TYPES); S.place = 0; S.effortType = 'walk'; applyFilter(); emit('place'); }}>Reset</button>
            <button className="ghost" type="button" aria-pressed={S.share} title="For screenshots: hides the first and last 200 m of routes that start or end near home, and a 300 m zone around it" onClick={() => { S.share = !S.share; emit('share', 'filter'); }}>Share mode</button>
            <ThemeToggle />
          </div>
        </div>
      </div>
      <Toc key={S.view + (S.share ? '-share' : '')} />
    </header>
  );
}

// chapter nav drawn as a route with a "you are here" marker
function Toc() {
  const nav = useRef<HTMLElement>(null);
  const [cur, setCur] = useState(0);
  const chapters = (S.view === 'sleep' ? SLEEP_CHAPTERS : CHAPTERS).filter(([id]) => !(S.share && SHARE_HIDDEN.has(id)));
  useEffect(() => {
    const secs = chapters.map(([id]) => document.getElementById(id));
    let raf = 0;
    const onScroll = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { let i = 0; secs.forEach((s, k) => { if (s && s.getBoundingClientRect().top < 160) i = k; }); setCur(i); }); };
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
    return () => removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const a = nav.current?.querySelectorAll('a')[cur] as HTMLElement | undefined;
    if (a && nav.current) nav.current.style.setProperty('--prog', (a.offsetLeft + a.offsetWidth / 2 - 20) + 'px');
  }, [cur]);
  return (
    <nav className="toc" ref={nav} aria-label="Chapters">
      {chapters.map(([id, label], k) => <a key={id} href={'#' + id} className={(k === cur ? 'cur ' : '') + (k < cur ? 'done' : '')}>{label}</a>)}
    </nav>
  );
}
