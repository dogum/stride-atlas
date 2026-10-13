// Streets near home: how much of the walkable network around home you have covered on foot, the way street-running
// apps count it. The network is OpenStreetMap (a Geofabrik extract, see pipeline/stride/osm.py), which computes
// coverage per street segment; the year filter here reads as "walked by the end of the last selected year".
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, S, emit } from '../store';
import { MI, Out, TIP, armArrival, css, dayDate, emptyState, f1, fDate, fInt, xAxis, yGrid, yearTicks } from '../core';
import { loadStreets } from '../data';

export const ST = { ring: 1 };
export const RINGS = [{ key: 1, label: '1 mi' }, { key: 2, label: '2 mi' }, { key: 3, label: '3 mi' }];
const HW: Record<string, string> = {
  residential: 'Residential street', living_street: 'Residential street', unclassified: 'Minor road', tertiary: 'Collector road', tertiary_link: 'Collector road',
  secondary: 'Secondary road', secondary_link: 'Secondary road', primary: 'Main road', primary_link: 'Main road', trunk: 'Highway', trunk_link: 'Highway',
  pedestrian: 'Pedestrian street', road: 'Road', footway: 'Footpath', path: 'Path or trail', track: 'Track', steps: 'Steps', bridleway: 'Bridleway',
  cycleway: 'Cycle path', service: 'Service road', corridor: 'Corridor',
};
const fLen = (m: number) => m < 0.1 * MI ? `${fInt(m * 3.28084)} ft` : `${f1(m / MI)} mi`;

function ringStats(edges: any[], ring: number, done: (e: any) => boolean) {
  const r = { streets: { tot: 0, wk: 0 }, paths: { tot: 0, wk: 0 }, named: 0, complete: 0 };
  const byName = new Map<string, [number, number]>();
  for (const e of edges) {
    if (!e.ring || e.ring > ring || e.cls > 1) continue;
    const o = e.cls === 0 ? r.streets : r.paths, d = done(e);
    o.tot += e.len; if (d) o.wk += e.len;
    if (e.cls === 0 && e.name) { const a = byName.get(e.name) || [0, 0]; a[0] += e.len; if (d) a[1] += e.len; byName.set(e.name, a); }
  }
  for (const [, [t, w]] of byName) { r.named++; if (w >= 0.9 * t) r.complete++; }
  return r;
}

// the shares the panel shows for each ring (year filter and share mode applied), for captions elsewhere
export function streetShares(): { streets: number; paths: number }[] {
  const N = G.streets; if (!N) return [];
  const asOf = Math.round((Date.UTC(S.y1 + 1, 0, 1) - G.D0) / G.DAY) - 1, share = !!S.share;
  const done = (e: any) => e.walked && e.first <= asOf && !(share && e.hidden);
  return [1, 2, 3].map(r => { const o = ringStats(N.edges, r, done); return { streets: o.streets.tot ? o.streets.wk / o.streets.tot : 0, paths: o.paths.tot ? o.paths.wk / o.paths.tot : 0 }; });
}

export function drawStreets(el: HTMLElement): Out {
  const N = G.streets;
  if (N === undefined) { emptyState(el, 'Loading the street network…'); loadStreets().then(() => emit('streets')); return; }
  if (!N) return emptyState(el, 'No street network yet. Run make osm to add OpenStreetMap coverage (see docs/ENRICHMENT.md).');
  el.replaceChildren();
  const asOf = Math.round((Date.UTC(S.y1 + 1, 0, 1) - G.D0) / G.DAY) - 1;
  const share = !!S.share;
  const done = (e: any) => e.walked && e.first <= asOf && !(share && e.hidden);
  const ring = ST.ring;
  // share mode draws the whole extract rectangle: a map cut to a circle would point straight at its centre
  const shown = N.edges.filter((e: any) => share ? true : e.ring && e.ring <= ring);
  const stats = [1, 2, 3].map(r => ringStats(N.edges, r, done));
  const cur = stats[ring - 1];

  const W = Math.max(300, el.clientWidth || 900), wide = W >= 760;
  const wrap = document.createElement('div');
  wrap.style.cssText = `display:grid;grid-template-columns:${wide ? 'minmax(0,1.3fr) minmax(0,1fr)' : 'minmax(0,1fr)'};gap:${wide ? 26 : 14}px;align-items:start`;
  el.appendChild(wrap);

  // ---------------------------------------------------------------- map (canvas: 60k segments)
  const mapBox = document.createElement('div');
  mapBox.style.cssText = 'position:relative;border-radius:var(--r-lg);overflow:hidden;background:var(--map-bg)';
  wrap.appendChild(mapBox);
  const mw = wide ? Math.floor((W - 26) * 1.3 / 2.3) : W, mh = Math.round(Math.min(560, Math.max(320, mw * 0.86)));
  mapBox.style.height = mh + 'px';
  const dpr = Math.min(2, devicePixelRatio || 1);
  const layer = (cls = '') => { const c = document.createElement('canvas'); c.width = mw * dpr; c.height = mh * dpr; c.style.cssText = `position:absolute;inset:0;width:${mw}px;height:${mh}px`; if (cls) c.className = cls; mapBox.appendChild(c); const x = c.getContext('2d')!; x.scale(dpr, dpr); x.lineCap = 'round'; x.lineJoin = 'round'; return { c, x }; };
  const base = layer('a-fade'), lit = layer('a-reveal'), hov = layer();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const e of shown) { const p = e.path; for (let i = 0; i < p.length; i += 2) { if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i]; if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1]; } }
  const kx = Math.cos(((y0 + y1) / 2) * Math.PI / 180), pad = 14;
  const s = Math.min((mw - 2 * pad) / Math.max(1e-9, (x1 - x0) * kx), (mh - 2 * pad) / Math.max(1e-9, y1 - y0));
  const ox = (mw - (x1 - x0) * kx * s) / 2, oy = (mh - (y1 - y0) * s) / 2;
  const PX = (lon: number) => ox + (lon - x0) * kx * s, PY = (lat: number) => oy + (y1 - lat) * s;
  const stroke = (ctx: CanvasRenderingContext2D, list: any[], color: string, width: number, alpha: number, dash: number[] = []) => {
    ctx.save(); ctx.strokeStyle = color; ctx.globalAlpha = alpha; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
    for (const e of list) { const p = e.path; ctx.moveTo(PX(p[0]), PY(p[1])); for (let i = 2; i < p.length; i += 2) ctx.lineTo(PX(p[i]), PY(p[i + 1])); }
    ctx.stroke(); ctx.restore();
  };
  // maps stay on the night ground in both themes (as the atlas does), so they use the dark palette throughout
  const mStreet = '#ff8f4a', mPath = '#1fb27f', cDim = css('--map-ink'), cFaint = '#8090a8';
  const cStreet = css('--signal'), cPath = css('--s3'); // the same hues in the theme, for the bars and the timeline
  const zoomW = Math.max(0.6, Math.min(1.6, s / 9000));
  stroke(base.x, shown.filter((e: any) => e.cls === 2), cFaint, 0.5 * zoomW, 0.16);
  stroke(base.x, shown.filter((e: any) => e.cls === 0 && !done(e)), cDim, 0.8 * zoomW, 0.42);
  stroke(base.x, shown.filter((e: any) => e.cls === 1 && !done(e)), mPath, 0.8 * zoomW, 0.32, [2, 2.5]);
  stroke(lit.x, shown.filter((e: any) => e.cls === 1 && done(e)), mPath, 1.9 * zoomW, 0.95);
  stroke(lit.x, shown.filter((e: any) => e.cls === 0 && done(e)), mStreet, 2.1 * zoomW, 0.95);
  const note = document.createElement('div');
  note.className = 'mono';
  note.style.cssText = 'position:absolute;right:8px;bottom:6px;font-size:10px;color:var(--ink-4);pointer-events:none';
  note.textContent = (N.attribution || '© OpenStreetMap contributors').replace(/ \(ODbL\).*$/, '');
  mapBox.appendChild(note);

  // hover: nearest segment vertex or midpoint within 10 px, highlighting the segment and the rest of its street
  let qt: any = null;
  const tree = () => {
    if (qt) return qt;
    const pts: any[] = [];
    shown.forEach((e: any) => { if (e.cls > 1) return; const p = e.path; for (let i = 0; i < p.length; i += 2) { const X = PX(p[i]), Y = PY(p[i + 1]); pts.push([X, Y, e]); if (i + 2 < p.length) pts.push([(X + PX(p[i + 2])) / 2, (Y + PY(p[i + 3])) / 2, e]); } });
    return (qt = d3.quadtree().x((d: any) => d[0]).y((d: any) => d[1]).addAll(pts));
  };
  let last: any = null;
  mapBox.addEventListener('pointermove', (ev: PointerEvent) => {
    const r = mapBox.getBoundingClientRect();
    const hit = tree().find(ev.clientX - r.left, ev.clientY - r.top, 10);
    const e = hit?.[2] || null;
    if (e !== last) {
      last = e;
      hov.x.clearRect(0, 0, mw, mh);
      if (e) {
        const masked = share && e.hidden;
        if (e.name && !masked) stroke(hov.x, shown.filter((o: any) => o.name === e.name && o.cls === e.cls), '#eef2f7', 1.6 * zoomW, 0.35);
        stroke(hov.x, [e], '#eef2f7', 3 * zoomW, 0.95);
      }
    }
    if (!e) { TIP.hide(); return; }
    const masked = share && e.hidden;
    const label = HW[e.hw] || (e.cls === 0 ? 'Street' : 'Path');
    const rows: any[][] = [['Type', label], ['Length', fLen(e.len)],
      ['Walked', masked ? 'Hidden in share mode' : done(e) ? `Since ${fDate(e.first)}` : e.cov > 0 && e.first < 0 ? `${Math.round(100 * e.cov / e.len)}% covered so far` : 'Not yet']];
    if (e.name && !masked) {
      let t = 0, w = 0; for (const o of shown) if (o.name === e.name && o.cls === e.cls) { t += o.len; if (done(o)) w += o.len; }
      rows.push(['Whole street here', `${fLen(w)} of ${fLen(t)}`]);
    }
    TIP.show(ev, (!masked && e.name) || label, rows);
  });
  mapBox.addEventListener('pointerleave', () => { last = null; hov.x.clearRect(0, 0, mw, mh); TIP.hide(); });

  // ---------------------------------------------------------------- rings and timeline
  const side = document.createElement('div');
  wrap.appendChild(side);
  const pct = (o: any) => o.tot ? o.wk / o.tot : 0;
  const fP = (v: number) => d3.format(v < 0.1 ? '.1%' : '.0%')(v);
  const rings = d3.select(side).append('div').attr('role', 'list').style('display', 'grid').style('gap', '6px').style('margin-bottom', '18px');
  stats.forEach((st, i) => {
    const r = i + 1, on = r === ring;
    const row = rings.append('button').attr('type', 'button').attr('role', 'listitem').attr('aria-pressed', on)
      .style('all', 'unset').style('cursor', 'pointer').style('display', 'grid').style('grid-template-columns', '58px 1fr').style('gap', '4px 12px')
      .style('padding', '9px 11px').style('border-radius', 'var(--r-md)').style('border', `1px solid ${on ? 'var(--edge-strong)' : 'var(--edge-soft)'}`)
      .style('background', on ? 'var(--raised)' : 'transparent')
      .on('click', () => { ST.ring = r; emit('streets'); });
    row.append('div').attr('class', 'mono').style('grid-row', 'span 2').style('font-size', '12px').style('color', on ? 'var(--ink-1)' : 'var(--ink-3)').style('padding-top', '2px').text(`≤ ${r} mi`);
    for (const [k, c, name] of [['streets', cStreet, 'Streets'], ['paths', cPath, 'Paths & trails']] as const) {
      const o = (st as any)[k], v = pct(o);
      const line = row.append('div').style('display', 'grid').style('grid-template-columns', '92px 1fr 52px').style('align-items', 'center').style('gap', '8px').style('font-size', '12px');
      line.append('span').style('color', 'var(--ink-2)').text(name);
      const bar = line.append('span').style('height', '6px').style('border-radius', '3px').style('background', 'var(--grid)').style('overflow', 'hidden');
      bar.append('i').attr('class', 'a-hbar').style('display', 'block').style('height', '100%').style('width', `${Math.max(0.5, v * 100)}%`).style('background', c).style('transform-origin', 'left');
      line.append('span').attr('class', 'mono').style('text-align', 'right').style('color', on ? 'var(--ink-1)' : 'var(--ink-2)').text(fP(v));
    }
  });

  // cumulative miles walked inside the chosen ring, by the day each segment became walked
  const inR = N.edges.filter((e: any) => e.ring && e.ring <= ring && e.cls <= 1 && e.walked && !(share && e.hidden)).sort((a: any, b: any) => a.first - b.first);
  const dStart = F.days[0]?.d ?? 0;
  const series = [0, 1].map(c => { let acc = 0; const pts: any[] = [{ d: dStart, v: 0 }]; for (const e of inR) if (e.cls === c && e.first <= asOf) { acc += e.len / MI; pts.push({ d: Math.max(dStart, e.first), v: acc }); } pts.push({ d: Math.min(asOf, F.days[F.days.length - 1]?.d ?? asOf), v: acc }); return pts; });
  const tl = document.createElement('div');
  side.appendChild(tl);
  // fill the column beside the map; stacked under it on narrow screens
  const th = wide ? Math.max(170, mh - rings.node().getBoundingClientRect().height - 18) : 220;
  drawTimeline(tl, series, th, Math.max(260, side.clientWidth || W), dStart, asOf, cStreet, cPath);

  armArrival(el);
  const yr = S.y1 === G.Y1 ? 'so far' : `by the end of ${S.y1}`;
  return {
    sub: [[`${fP(pct(cur.streets))} of the streets`], ` within ${ring} mile${ring > 1 ? 's' : ''} of home walked ${yr}, and `, [`${fP(pct(cur.paths))} of the paths and trails`],
      `. ${cur.complete ? `Every block of ${fInt(cur.complete)} of ${fInt(cur.named)} named streets.` : `${fInt(cur.named)} named streets in range.`}`],
    legend: { kind: 'ln', items: [{ label: 'Walked street', c: cStreet }, { label: 'Walked path or trail', c: cPath }, { label: 'Not walked yet', c: cDim }] },
    table: () => ({
      cols: [{ k: 'r', label: 'Within' }, { k: 'st', label: 'Streets', num: true }, { k: 'sw', label: 'Walked', num: true }, { k: 'sp', label: 'Share', num: true },
        { k: 'pt', label: 'Paths & trails', num: true }, { k: 'pw', label: 'Walked', num: true }, { k: 'pp', label: 'Share', num: true }, { k: 'c', label: 'Streets complete', num: true }],
      rows: stats.map((st, i) => ({ r: `${i + 1} mi`, st: `${f1(st.streets.tot / MI)} mi`, sw: `${f1(st.streets.wk / MI)} mi`, sp: fP(pct(st.streets)),
        pt: `${f1(st.paths.tot / MI)} mi`, pw: `${f1(st.paths.wk / MI)} mi`, pp: fP(pct(st.paths)), c: `${fInt(st.complete)} of ${fInt(st.named)}` })),
    }),
  };
}

function drawTimeline(el: HTMLElement, series: any[][], h: number, w: number, d0: number, d1: number, cStreet: string, cPath: string) {
  const M = { t: 18, r: 50, b: 24, l: 40 };
  const iw = w - M.l - M.r, ih = h - M.t - M.b;
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('width', '100%').attr('height', h);
  const g = svg.append('g').attr('transform', `translate(${M.l},${M.t})`);
  const x = d3.scaleLinear([d0, d1], [0, iw]);
  const top = d3.max(series.flat(), (p: any) => p.v) || 1;
  const y = d3.scaleLinear([0, top * 1.08], [ih, 0]).nice();
  yGrid(g, y, iw, 4, (v: number) => `${fInt(v)} mi`);
  const yt = yearTicks(F.years, d0); const narrow = iw / Math.max(1, yt.length) < 40;
  xAxis(g, x, ih, { values: yt, fmt: (v: number) => narrow ? `'${String(dayDate(v).getUTCFullYear()).slice(2)}` : dayDate(v).getUTCFullYear() });
  g.append('text').attr('class', 'dlabel').attr('x', 0).attr('y', -6).style('font-size', '11px').style('fill', 'var(--ink-3)').text('Miles walked inside the ring, cumulative');
  series.forEach((pts, i) => {
    const c = i ? cPath : cStreet;
    g.append('path').datum(pts).attr('class', 'a-line').attr('d', d3.line().x((p: any) => x(p.d)).y((p: any) => y(p.v)).curve(d3.curveStepAfter)).style('fill', 'none').style('stroke', c).style('stroke-width', 2);
    const e = pts[pts.length - 1];
    g.append('text').attr('class', 'dlabel mono a-fade').attr('x', iw + 6).attr('y', y(e.v) + (i ? 11 : -2)).style('fill', c).style('font-size', '11px').text(f1(e.v));
  });
  const ch = g.append('line').attr('y1', 0).attr('y2', ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
  svg.on('pointermove', (ev: any) => {
    const [px] = d3.pointer(ev, g.node()); const d = Math.max(d0, Math.min(d1, x.invert(px)));
    const at = (pts: any[]) => pts[Math.max(0, d3.bisector((p: any) => p.d).right(pts, d) - 1)].v;
    ch.attr('x1', x(d)).attr('x2', x(d)).style('opacity', 0.6);
    TIP.show(ev, fDate(Math.round(d)), [['Streets walked', `${f1(at(series[0]))} mi`, cStreet], ['Paths & trails walked', `${f1(at(series[1]))} mi`, cPath]]);
  }).on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
}
