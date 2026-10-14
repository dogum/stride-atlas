import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { DEMO, F, G, MODE, REG, S, emit, useWatch } from '../store';
import { COND, MONTHS, REDUCED, TYPE, armArrival, countTo, dayDate, f1, fClock, fDate, fDur, fInt, fK, fPace, fPct, gradientCSS, MAP_RAMPS, TIP, typeLabel, customTitle, wLabel } from '../core';
import { STACK_MODES, Stack, type StackMode } from '../map/stack';
import { CREDIT, creditLine } from '../credits';
import { Atlas, MODES, legendFor, scaleFor } from '../map/atlas';
import { ChHead, EAGER, RichText, Seg } from './ui';
import { RECORDS, computeRecords } from '../charts/terrain';
import { cuStats, drawCuCharts, drawCuMap, drawSplits, openCloseup, samples } from '../charts/closeup';
import { TRACK, drawTrack } from '../charts/health';
import { DATA_BASE, loadContours, loadRoutes3D, loadStream } from '../data';
import { eddington, streak } from '../charts/bests';

// ---------------------------------------------------------------- hero, map, tiles
export function AtlasSection() {
  const v = useWatch(['filter', 'place', 'share', 'data', 'routes', 'basemap']);
  useWatch(['colorBy']);
  const wrap = useRef<HTMLDivElement>(null);
  const atlas = useRef<Atlas | null>(null);
  const [card, setCard] = useState<{ w: any; x: number; y: number } | null>(null);
  const [view, setView] = useState<any>(null);
  const [play, setPlay] = useState<any>({ on: false });
  const mode = S.colorBy;
  const prevPlace = useRef<number | null>(null);
  const fitted = useRef(false);
  const t = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    atlas.current = new Atlas(wrap.current!, { onSelect: (w, px) => setCard(w ? { w, x: px![0], y: px![1] } : null), onView: (vs) => setView({ ...vs }), onPlay: setPlay });
    REG.atlas = atlas.current;
    if (import.meta.env.DEV) (window as any).__atlas = atlas.current;
    const ro = new ResizeObserver(() => atlas.current?.resize());
    ro.observe(wrap.current!);
    return () => { ro.disconnect(); atlas.current?.destroy(); };
  }, []);
  useEffect(() => {
    if (!atlas.current || !G.workouts.length) return;
    atlas.current.stop();
    const refit = prevPlace.current !== S.place || !fitted.current;
    prevPlace.current = S.place;
    if (G.routeXY) fitted.current = true;
    atlas.current.setPlace(refit);
    setCard(c => c && atlas.current!.sel === c.w.id ? c : null);
  }, [v]);

  // hero copy
  const n = F?.gps.length ?? 0, mi = d3.sum(F?.gps ?? [], (w: any) => w.dist);
  const onlyWalk = S.types.size === 1 && S.types.has('walk');
  const noun = onlyWalk ? 'walks' : S.types.size === 1 ? TYPE[[...S.types][0] as string].name.toLowerCase() + 's' : 'routes';
  const a = useRef<HTMLSpanElement>(null), em = useRef<HTMLElement>(null);
  useLayoutEffect(() => { countTo(a.current, n, v => `${fInt(v)} ${noun}`); countTo(em.current, mi, v => `${fInt(v)} miles`); }, [v]);
  const g0 = F?.gps[0], g1 = F?.gps[F.gps.length - 1];

  const counts = d3.rollup(F?.gps ?? [], v => v.length, (w: any) => w.place);
  const places = (G.places || []).filter((p: any) => p.n >= 3).slice(0, 6);
  const sc = view ? scaleFor(view) : null;
  const L = legendFor(mode);
  return (
    <section className="chapter" id="atlas">
      <div className="hero">
        <div className="hero-head">
          <div>
            <div className="eyebrow">{g0 ? `Every GPS route, ${MONTHS[g0.m]} ${g0.y} to ${MONTHS[g1.m]} ${g1.y}` : 'No routes in range'}</div>
            <h1 ref={t}><span ref={a} />, <em ref={em} /></h1>
            <p>Each line is one workout route from <code className="mono">workout-routes/*.gpx</code>{(G.meta?.sources || []).some((x: any) => x.name === 'Strava archive') ? ' and your Strava archive' : ''}, cleaned and drawn with additive light so the streets you walk most glow brightest. Contours are USGS 3DEP terrain; the Streets basemap is OpenStreetMap.</p>
          </div>
        </div>
        <div className="mapwrap" id="mapwrap">
          <div className="deckmap" ref={wrap} />
          <div className="map-ui">
            <div className="glass"><Seg label="Color routes by" options={MODES} value={mode} onPick={k => { S.colorBy = k; emit('colorBy'); atlas.current?.render(); }} /></div>
            <div className="glass places"><Seg label="Place" options={[{ key: -1, label: `Everywhere ${fK(n)}`, disabled: !n }, ...places.map((p: any) => ({ key: p.id, label: `${p.id === 0 ? 'Home' : p.name.split(',')[0]} ${fK(counts.get(p.id) || 0)}`, disabled: !counts.get(p.id) }))]} value={S.place} onPick={k => { S.place = k; setCard(null); emit('place'); }} /></div>
          </div>
          <div className={'counter' + (play.on ? ' on' : '')}><div className="big">{play.date}</div><div className="sm">{play.sub}</div>{play.note && <div className="atlas-ms" style={{ color: play.noteC }}>◆ {play.note}</div>}</div>
          <div className="glass map-bl"><span className="lbl">{L[0]}</span><div className="map-legend"><span>{L[1]}</span><span className="bar-r" style={{ background: gradientCSS(MAP_RAMPS[mode]) }} /><span>{L[2]}</span></div></div>
          <div className="map-br">
            <div className="glass"><Seg label="Basemap" options={[{ key: 'contours', label: 'Contours' }, { key: 'streets', label: 'Streets', disabled: S.place !== 0 }, { key: 'none', label: 'Plain' }]} value={S.basemap} onPick={k => { S.basemap = k; emit('basemap'); }} /></div>
            {S.basemap === 'streets' && S.place === 0 && <div className="glass scalebar"><span>© OpenStreetMap contributors</span></div>}
            {sc && <div className="glass scalebar"><i style={{ width: sc.px }} /><span>{sc.mi} mi</span></div>}
            <button className="glass playbtn" type="button" onClick={() => { setCard(null); atlas.current?.play(REDUCED()); }}>
              <svg viewBox="0 0 12 12"><path d={play.on ? 'M2 2h3v8H2zM7 2h3v8H7z' : 'M2 1l9 5-9 5z'} /></svg>
              <span>{play.on ? 'Stop replay' : `Replay ${S.y0} to ${S.y1 === G.Y1 ? 'now' : S.y1}`}</span>
            </button>
          </div>
          {card && <MapCard card={card} close={() => { setCard(null); if (atlas.current) { atlas.current.sel = null; atlas.current.render(); } }} />}
        </div>
      </div>
      <Tiles v={v} />
    </section>
  );
}

function MapCard({ card, close }: { card: any; close: () => void }) {
  const w = card.w;
  const box = document.getElementById('mapwrap')!.getBoundingClientRect();
  const left = Math.min(box.width - 262, Math.max(12, card.x + 14)), top = Math.min(box.height - 250, Math.max(56, card.y - 110));
  const rows: [string, string][] = [['Start', fClock(w.hour)], ['Distance', f1(w.dist) + ' mi'], [w.type === 'ride' ? 'Speed' : 'Pace', w.type === 'ride' ? f1(w.speed) + ' mph' : fPace(w.pace) + ' /mi'],
    ['Avg heart rate', w.hr ? Math.round(w.hr) + ' bpm' : '—'], ['Climb', w.gain != null ? fInt(w.gain) + ' ft' : '—'], ['Weather', w.temp != null ? `${Math.round(w.temp)}°F, ${(COND[w.cond] || '').toLowerCase()}` : '—'],
    ['Route', w.tpl ? (G.loops || []).find((l: any) => l.loop_id === w.tpl)?.label || 'loop' : w.placeName || '—']];
  return (
    <div className="glass mapcard" style={{ left, top }}>
      <h4>{customTitle(w) ? `${customTitle(w)} · ` : ''}{typeLabel(w)} · {fDate(w.d)}</h4>
      <div className="kv">{rows.map(([k, v]) => <Fragment key={k}><span>{k}</span><b>{v}</b></Fragment>)}</div>
      <button type="button" onClick={() => { openCloseup(w.id, true); close(); }}>Open in close-up</button>
    </div>
  );
}

function Tiles({ v }: { v: string }) {
  const el = useRef<HTMLDivElement>(null);
  const T = (() => {
    if (!F) return [];
    const gps = F.gps, days = F.days.filter((d: any) => d.steps != null);
    const byYear = (fn: (y: number) => number) => F.years.map(fn);
    const yr = (arr: any[], y: number) => arr.filter((o: any) => o.y === y);
    const walkDays = new Set(gps.map((w: any) => w.d));
    // calendar days, not daily-record rows: years before the phone existed have routes (an older watch) but no rows
    const d0 = Math.min(gps[0]?.d ?? Infinity, F.days[0]?.d ?? Infinity), d1 = Math.max(gps[gps.length - 1]?.d ?? -Infinity, F.days[F.days.length - 1]?.d ?? -Infinity);
    const cal: number[] = isFinite(d0) && isFinite(d1) ? d3.range(d0, d1 + 1) : [];
    const calY = (y: number) => cal.filter(d => dayDate(d).getUTCFullYear() === y);
    const st = streak(cal.map(d => walkDays.has(d)));
    const climb = d3.sum(gps, (w: any) => w.gain ?? 0), hrs = d3.sum(gps, (w: any) => w.dur) / 60, steps = d3.sum(days, (d: any) => d.steps);
    const mi = d3.sum(gps, (w: any) => w.dist);
    return [
      { k: 'Distance', v: mi, f: (x: number) => fInt(x), u: 'mi', x: `${f1(mi / 24901 * 100)}% of the way around Earth`, s: byYear(y => d3.sum(yr(gps, y), (w: any) => w.dist)) },
      { k: 'Steps', v: steps, f: (x: number) => fK(x), u: '', x: `${fK(steps / Math.max(1, days.length))} a day, deduplicated`, s: byYear(y => d3.mean(yr(days, y), (d: any) => d.steps) || 0) },
      { k: 'Climbed', v: climb, f: (x: number) => fInt(x), u: 'ft', x: `${f1(climb / 29032)}× the height of Everest`, s: byYear(y => d3.sum(yr(gps, y), (w: any) => w.gain ?? 0)) },
      { k: 'Time moving', v: hrs, f: (x: number) => fInt(x), u: 'h', x: `${f1(hrs / 24)} full days on your feet or wheels`, s: byYear(y => d3.sum(yr(gps, y), (w: any) => w.dur)) },
      { k: 'Active days', v: walkDays.size / Math.max(1, cal.length), f: (x: number) => fPct(x), u: '', x: `${fInt(walkDays.size)} of ${fInt(cal.length)} days had a route`, s: byYear(y => { const c = calY(y); return c.length ? c.filter(d => walkDays.has(d)).length / c.length : 0; }) },
      { k: 'Longest streak', v: st.len, f: (x: number) => fInt(x), u: 'days', x: st.len ? `ended ${fDate(cal[st.end])}` : '', s: byYear(y => streak(calY(y).map(d => walkDays.has(d))).len) },
    ];
  })();
  useLayoutEffect(() => {
    if (!el.current) return;
    [...el.current.children].forEach((d: any, i) => {
      const t = T[i]; if (!t) return;
      countTo(d.querySelector('.num'), t.v, t.f);
      const sp = d.querySelector('.sp'); sp.replaceChildren();
      const w = 150, h = 28, n = t.s.length, bw = Math.min(12, (w - (n - 1) * 2) / n);
      const mx = d3.max(t.s) || 1;
      const svg = d3.select(sp).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h);
      svg.selectAll('rect').data(t.s).join('rect').attr('class', 'a-bar').attr('x', (v: any, j: number) => j * (bw + 2)).attr('width', bw).attr('y', (v: any) => h - Math.max(1, v / mx * h)).attr('height', (v: any) => Math.max(1, v / mx * h)).attr('rx', 1.5)
        .style('fill', (v: any, j: number) => j === n - 1 ? 'var(--signal)' : 'var(--chip)')
        .on('pointermove', (e: any, v: any) => { const j = t.s.indexOf(v); TIP.show(e, `${t.k} · ${F.years[j]}`, [[String(F.years[j]), t.f(v) + (t.u ? ' ' + t.u : '')]]); }).on('pointerleave', TIP.hide);
      armArrival(sp);
    });
  }, [v]);
  return (
    <div className="tiles" ref={el}>
      {T.map(t => <div className="tile" key={t.k}><span className="lbl">{t.k}</span><span className="v"><span className="num" /><small>{t.u}</small></span><span className="x">{t.x}</span><div className="sp" /></div>)}
    </div>
  );
}

// ---------------------------------------------------------------- space and time (3D)
export function StackSection() {
  const v = useWatch(['filter', 'place', 'share', 'routes', 'stack']);
  const wrap = useRef<HTMLDivElement>(null), sec = useRef<HTMLElement>(null);
  const st = useRef<Stack | null>(null);
  const [near, setNear] = useState(EAGER);
  const [info, setInfo] = useState<any>(null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setNear(true); if (st.current) st.current.visible = e.isIntersecting; }, { rootMargin: '600px 0px' });
    io.observe(sec.current!);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!near || st.current) return;
    const s = new Stack(wrap.current!);
    st.current = s; REG.stack = s;
    s.visible = true;
    s.onHover = (w, x, y) => {
      if (!w) { TIP.hide(); return; }
      const r = wrap.current!.getBoundingClientRect();
      TIP.show({ clientX: r.left + x, clientY: r.top + y }, wLabel(w), [['Distance', f1(w.dist) + ' mi'], ['Start', fClock(w.hour)], ['Climb', w.gain != null ? fInt(w.gain) + ' ft' : '—'], ['', 'Click to open in close-up']]);
    };
    s.onClick = w => { TIP.hide(); openCloseup(w.id, true); };
    const ro = new ResizeObserver(() => { s.resize(); s.fit(); });
    ro.observe(wrap.current!);
    return () => { ro.disconnect(); };
  }, [near]);
  useEffect(() => () => { st.current?.destroy(); st.current = null; REG.stack = null; }, []);
  useEffect(() => {
    const s = st.current; if (!s || !G.routeXY) return;
    let alive = true;
    (async () => {
      await loadRoutes3D();
      if (!alive) return;
      setMissing(!G.routeEle);
      s.mode = S.stackMode;
      await s.build();
      if (!alive) return;
      s.render();
      setInfo({ ...s.info });
    })();
    return () => { alive = false; };
  }, [v, near]);
  const m = S.stackMode as StackMode;
  const span = info ? `${fDateMY(info.d0)} to ${fDateMY(info.d1 - 1)}` : '';
  const legend = m === 'hour' ? ['Start time', '5 am', '9 pm', MAP_RAMPS.time] : ['Year', String(G.Y0), String(G.Y1), MAP_RAMPS.year];
  const how = m === 'date' ? `Height is the date, ${span}: a loop walked for years rises as a column, a trip is a thin slab, a quiet stretch is a gap.`
    : m === 'hour' ? 'Height is the time of day, midnight at the floor: each route climbs as its clock runs, so mornings sit low and evenings high.'
    : `Height is the ground's elevation, exaggerated ${info?.exag ?? ''}× so the hills read, with the terrain's contours lifted to their own heights.`;
  const places = (G.places || []).filter((p: any) => p.n >= 3).slice(0, 6);
  return (
    <section className="chapter" id="stack" ref={sec}>
      <ChHead idx={9} eyebrow="Space & time" title="Every route, stacked in time">The atlas with a third axis. The floor is the map; height is when you were there. Drag to turn it, pick a height, click any line to open it.</ChHead>
      <div className="grid">
        <div className="panel c12" id="p-stack">
          <div className="p-head"><div className="tt"><h3>{info ? `${fInt(info.n)} routes around ${info.name}` : 'Routes in 3D'}</h3><p className="sub">{missing ? 'This export predates the elevation and time buffers: run make export to fill the time-of-day and elevation views.' : how}</p></div>
            <div className="p-tools"><Seg label="Height" options={STACK_MODES.map(o => ({ ...o, disabled: missing && o.key !== 'date' }))} value={m} onPick={k => { S.stackMode = k; st.current?.setMode(k as StackMode); emit('stack'); }} /></div></div>
          <div className="stackwrap" ref={wrap}>
            {places.length > 1 && <div className="map-ui"><div className="glass places"><Seg label="Place" options={places.map((p: any) => ({ key: p.id, label: p.id === 0 ? 'Home' : p.name.split(',')[0] }))} value={info?.place ?? 0} onPick={k => { S.place = k; emit('place'); }} /></div></div>}
            <div className="glass map-bl"><span className="lbl">{legend[0] as string}</span><div className="map-legend"><span>{legend[1] as string}</span><span className="bar-r" style={{ background: gradientCSS(legend[3] as any) }} /><span>{legend[2] as string}</span></div></div>
            {info && <div className="glass map-br stack-note"><span>Floor {f1(info.sideMi)} mi across{m === 'ele' ? ` · ${info.exag}× vertical` : ''}</span></div>}
          </div>
        </div>
      </div>
    </section>
  );
}
const fDateMY = (d: number) => { const dt = dayDate(d); return `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`; };

// ---------------------------------------------------------------- records
export function RecordsSection() {
  const v = useWatch(['filter', 'data']);
  const R = useState<any[]>([])[0];
  const recs = (() => { try { return F ? computeRecords() : []; } catch (e) { console.error(e); return []; } })();
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { armArrival(el.current); }, [v]);
  void R;
  const groups = d3.groups(recs, (r: any) => r.group);
  return (
    <div className="recs" id="recs" ref={el}>
      {!recs.length && <div className="empty">No routes in range</div>}
      {groups.map(([g, list]) => (
        <Fragment key={g}>
          <div className="recs-group">{g}</div>
          {list.map((r: any) => r.w ? (
            <button key={r.label} type="button" className="rec-card a-fade" data-rec={r.label} onClick={() => openCloseup(r.w.id, true)}>
              <span className="lbl">{r.label}</span><span className="v">{r.val}</span><span className="d">{r.det}</span>{r.ru && <span className="ru">{r.ru}</span>}<span className="go">Open in close-up →</span>
            </button>
          ) : (
            <div key={r.label} className="rec-card a-fade" style={{ cursor: 'default' }}><span className="lbl">{r.label}</span><span className="v">{r.val}</span><span className="d">{r.det}</span></div>
          ))}
        </Fragment>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- close-up
export function CloseupSection() {
  useWatch(['filter']); // picker lists follow the filter
  const v = useWatch(['closeup', 'data', 'theme', 'size', 'share']);
  const cv = useRef<HTMLCanvasElement>(null), charts = useRef<HTMLDivElement>(null), spl = useRef<HTMLDivElement>(null);
  const [splitSub, setSplitSub] = useState<any>(null);
  const [info, setInfo] = useState<any>(null);
  if (!S.cuId && RECORDS[0]?.w) S.cuId = RECORDS.find((r: any) => r.w?.route)?.w.id;
  if (!S.cuId && F?.gps.length) S.cuId = F.gps[F.gps.length - 1].id;
  const w = G.byId?.get(S.cuId);
  const sec = useRef<HTMLElement>(null);
  const [near, setNear] = useState(EAGER);
  useEffect(() => { const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setNear(true); io.disconnect(); } }, { rootMargin: '800px 0px' }); io.observe(sec.current!); return () => io.disconnect(); }, []);
  useEffect(() => {
    let alive = true;
    if (!w || !near) return;
    setInfo(cuStats(w));
    (async () => {
      const [st, cont] = await Promise.all([w.route ? loadStream(w.id) : null, w.place != null ? loadContours(w.place) : null]);
      if (!alive) return;
      G.cuStream = st;
      const smp = st ? samples(st, w) : [];
      if (cv.current) drawCuMap(cv.current, w, smp, cont);
      if (charts.current) drawCuCharts(charts.current, w, smp);
      if (spl.current) { const o: any = drawSplits(spl.current, w); setSplitSub(o?.sub); }
    })();
    return () => { alive = false; };
  }, [v, near]);
  const recs = RECORDS.filter((r: any) => r.w?.route);
  const recent = (F?.gps ?? []).slice(-25).reverse();
  return (
    <section className="chapter" id="closeup" ref={sec}>
      <div className="ch-head">
        <div><div className="eyebrow">Close-up</div><h2>{info?.title ?? 'One walk, second by second'}</h2></div>
        <div className="cu-picker"><label className="lbl" htmlFor="cuSelect" style={{ alignSelf: 'center' }}>Workout</label>
          <select className="sel" id="cuSelect" value={S.cuId ?? ''} onChange={e => openCloseup(e.target.value, false)}>
            <optgroup label="Records">{recs.map((r: any) => <option key={'r' + r.label} value={r.w.id}>{r.label}: {r.val}</option>)}</optgroup>
            <optgroup label="Most recent">{recent.map((x: any) => <option key={x.id} value={x.id}>{fDate(x.d)} · {typeLabel(x)} {f1(x.dist)} mi</option>)}</optgroup>
            {w && !recs.some((r: any) => r.w.id === w.id) && !recent.some((x: any) => x.id === w.id) && <optgroup label="Selected"><option value={w.id}>{fDate(w.d)} · {typeLabel(w)} {f1(w.dist)} mi</option></optgroup>}
          </select></div>
        <p>The sample streams inside a single workout, resampled every 10 m. Hover any chart to find that moment on the route.</p>
      </div>
      <div className="closeup">
        <div className="cu-map"><canvas ref={cv} aria-label="Route of the selected workout, colored by pace" role="img" /></div>
        <div className="panel">
          <div className="cu-stats">{info?.items.map(([k, val]: any) => <div key={k}><span className="lbl">{k}</span><span className="v">{val}</span></div>)}</div>
          <div className="chart" ref={charts} />
          <div className="p-foot"><code>HKQuantityTypeIdentifierHeartRate</code><code>{w?.route ? `workout-routes/…` : 'no route'}</code><span>{info?.src}</span></div>
        </div>
      </div>
      <div className="grid" style={{ marginTop: 14 }}>
        <div className="panel c12"><div className="p-head"><div className="tt"><h3>Mile splits</h3><p className="sub"><RichText parts={splitSub} /></p></div></div><div className="chart" ref={spl} /></div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- data health track
export function TrackPanel() {
  const v = useWatch(['theme', 'size', 'data', 'track']);
  const cv = useRef<HTMLCanvasElement>(null);
  const [sub, setSub] = useState<any>(null);
  const [mode, setMode] = useState(TRACK.mode);
  const [which, setWhich] = useState(TRACK.which);
  useEffect(() => { if (cv.current && G.health) { const o: any = drawTrack(cv.current); setSub(o?.sub); } }, [v, mode, which]);
  const tracks = G.health?.tracks ?? [];
  return (
    <div className="panel c7" id="p-track">
      <div className="p-head"><div className="tt"><h3>One route, raw and cleaned</h3><p className="sub"><RichText parts={sub} /></p></div>
        <div className="p-tools">
          {tracks.length > 1 && <Seg label="Example" options={tracks.map((t: any, i: number) => ({ key: i, label: i === 0 ? 'Driving cut' : 'Spikes' }))} value={which} onPick={k => { TRACK.which = k; setWhich(k); }} />}
          <Seg label="Track view" options={[{ key: 'raw', label: 'Raw' }, { key: 'clean', label: 'Cleaned' }, { key: 'both', label: 'Both' }]} value={mode} onPick={k => { TRACK.mode = k; setMode(k); }} />
        </div></div>
      <div className="cu-map" style={{ minHeight: 340 }}><canvas ref={cv} aria-label="A route before and after cleaning" role="img" /></div>
      <div className="legend" style={{ marginTop: 10 }}><span><i className="ln" style={{ ['--c' as any]: '#e66767' }} />Raw from the GPX file</span><span><i className="ln" style={{ ['--c' as any]: '#ff8f4a' }} />Cleaned</span><span><i className="dt" style={{ ['--c' as any]: '#e66767' }} />Dropped point</span></div>
    </div>
  );
}

export function RelabelPanel() {
  useWatch(['data']);
  const rows = G.health?.relabel ?? [];
  return (
    <div className="panel c12" id="p-relabel">
      <div className="p-head"><div className="tt"><h3>Walks that might be something else</h3><p className="sub">Rule W4 only suggests. <b>{rows.length} walks</b> are mostly faster than 11:00 a mile (a run?) or climb more than 120 ft per mile over at least a mile (a hike?). Change the type on your phone if you agree; the next export picks it up.</p></div></div>
      <div className="tview" style={{ maxHeight: 260 }}><table><thead><tr><th>Date</th><th>Maybe a</th><th>Why</th><th className="n">Miles</th><th /></tr></thead>
        <tbody>{rows.map((r: any) => <tr key={r.workout_id + r.suggest}><td>{r.date}</td><td>{r.suggest}</td><td>{r.reason}</td><td className="n">{f1(r.mi)}</td><td><button className="tbtn" type="button" onClick={() => openCloseup(r.workout_id, true)}>Open</button></td></tr>)}</tbody></table></div>
    </div>
  );
}

// ---------------------------------------------------------------- about
export function About() {
  useWatch(['data']);
  // when the pipeline last wrote the data: the file's Last-Modified header, so no clock time is baked into the exports
  const [refreshed, setRefreshed] = useState<string | null>(null);
  useEffect(() => { fetch(DATA_BASE + 'meta.json', { method: 'HEAD' }).then(r => { const h = r.headers.get('last-modified'); if (h) setRefreshed(new Date(h).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })); }).catch(() => {}); }, []);
  const m = G.meta; if (!m) return null;
  const c = m.counts || {};
  const edd = m.eddington;
  return (
    <section className="chapter" id="about">
      <div className="ch-head"><div><div className="eyebrow">About</div><h2>Where every number comes from</h2></div><p>{DEMO ? <>This is the live demo: a synthetic Apple Health export and Strava archive for Alex, who does not exist, run through the same pipeline you would run on your own data. On your computer, nothing leaves it.</> : <>Everything here was computed on this computer from your Apple Health export{(m.sources || []).some((x: any) => x.name === 'Strava archive') ? ' and your Strava archive' : ''}. The only network calls were the cached weather, elevation and map lookups listed below.</>}</p></div>
      <div className="about">
        <div className="panel"><h3 style={{ margin: '0 0 10px' }}>This build</h3>
          <dl>
            <dt>Export</dt><dd>{m.export_date}</dd>
            <dt>Last refresh</dt><dd>{refreshed ?? '—'} (when <code className="mono">make all</code> last wrote the data)</dd>
            <dt>Workouts</dt><dd>{fInt(c.workouts)} after removing duplicates; {fInt(c.routes)} GPS routes ({fInt(c.route_points)} display points)</dd>
            <dt>Places</dt><dd>{(m.places || []).length} clusters of route starts (2 km); names from the offline GeoNames gazetteer</dd>
            <dt>Max heart rate</dt><dd>{Math.round(m.hr_max)} bpm: {m.hr_max_source}{m.hr_max_file_era ? `. Garmin years (${m.hr_max_file_era.from.slice(0, 4)}–${m.hr_max_file_era.to.slice(0, 4)}): ${Math.round(m.hr_max_file_era.hr_max)} bpm, p99.5 of ${fInt(m.hr_max_file_era.n)} chest-strap samples from runs and rides` : ''}</dd>
            <dt>Zones</dt><dd>Zone 1 below {m.zones_pct[0]}%, then {m.zones_pct.join(', ')}% of max</dd>
            <dt>Fitness model</dt><dd>Banister CTL/ATL on daily TRIMP from {m.fitness_model_start?.slice(0, 10)}, first 60 days hidden</dd>
            <dt>Eddington</dt><dd>{edd?.E} on foot ({edd?.need} more days of {edd ? edd.E + 1 : ''}+ miles for the next)</dd>
            <dt>Weather model</dt><dd>{m.weather_model ? `${m.weather_model.formula}; ${fInt(m.weather_model.n)} walks, R² ${m.weather_model.r2.toFixed(2)}` : '—'}</dd>
            <dt>Time zone</dt><dd>{m.home_tz} at home; trips use the zone where you walked</dd>
            <dt>Software</dt><dd>{creditLine()}; open source under the MIT license{CREDIT.repo ? <>, <a href={CREDIT.repo} target="_blank" rel="noreferrer">{CREDIT.repo.replace(/^https?:\/\//, '')}</a></> : ''}</dd>
          </dl>
        </div>
        <div className="panel"><h3 style={{ margin: '0 0 10px' }}>Data sources</h3>
          <ul>{(m.sources || []).map((s: any) => <li key={s.name}><b>{s.name}</b>: {s.detail}</li>)}</ul>
          <p className="mini-note" style={{ marginTop: 10 }}>Reanalysis weather (Open-Meteo, NASA POWER) is a model on a grid, not a reading from a weather station. Weather requests used start points rounded to 0.25°; elevation requests used fixed 0.1° tiles; the street network is one regional file, so home never leaves this machine.</p>
        </div>
        <div className="panel"><h3 style={{ margin: '0 0 10px' }}>Privacy and refresh</h3>
          <ul>
            <li>No accounts, no analytics, no fonts or scripts from the internet. The app only reads <code className="mono">/data</code> on this machine.</li>
            <li>Home is detected from route starts and stays in <code className="mono">data/stride.duckdb</code>. Share mode hides the first and last 200 m of routes that start or end within 300 m of it, plus a 300 m zone around it whose centre is offset from your door.</li>
            <li>To refresh: export again from the Health app, drop the zip in <code className="mono">data/</code>, run <code className="mono">make all</code>. New rows merge by natural key; enrichment reuses its cache.</li>
            <li>Judgment calls are logged in <code className="mono">docs/DECISIONS.md</code>; every cleaning change in <code className="mono">cleaning_log</code> and <code className="mono">reports/02_data_health.html</code>.</li>
          </ul>
        </div>
      </div>
    </section>
  );
}
export { MODE, fDur, fPct, COND };
