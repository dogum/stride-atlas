// Port of mockup/src/app-terrain.js: temperature strip, sky by year, climb per year, hilliness, provenance; and records.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, S } from '../store';
import { COND, DOWS, MONTHS, Out, TIP, armArrival, condRamp, css, dayDate, emptyState, f1, fClock, fDate, fDur, fInt, fK, fPace, fPct, fTime, frame, monthTicks, typeLabel, xAxis, yGrid, wLabel, wxName, customTitle } from '../core';
import { openCloseup } from './closeup';
import { eddington, streak } from './bests';

const footRoutes = () => F.gps.filter((w: any) => w.type !== 'ride');

export function drawWx(el: HTMLElement): Out {
  const ws = footRoutes().filter((w: any) => w.temp != null);
  if (!ws.length) return emptyState(el, 'No routes in range');
  const ramp = condRamp();
  const f = frame(el, 320, { t: 10, r: 14, b: 26, l: 44 });
  const x = d3.scaleLinear([0, 366], [0, f.iw]);
  const yS = d3.scaleLinear([d3.min(ws, (w: any) => w.temp)! - 3, d3.max(ws, (w: any) => w.temp)! + 3], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 5, (v: number) => v + '°');
  const ticks = monthTicks();
  xAxis(f.g, x, f.ih, { values: ticks, fmt: (v: number) => MONTHS[ticks.indexOf(v)] });
  // typical range on your outings: 10th–90th percentile within ±15 days of each date, all years
  const all = G.workouts.filter((w: any) => w.outdoor && w.temp != null && w.type !== 'ride');
  const normal = d3.range(0, 367, 4).map(d => { const a = all.filter((w: any) => { const dd = Math.abs(w.doy - d); return Math.min(dd, 365 - dd) <= 15; }).map((w: any) => w.temp).sort(d3.ascending); return { d, lo: d3.quantileSorted(a, 0.1) ?? null, hi: d3.quantileSorted(a, 0.9) ?? null }; }).filter(n => n.lo != null);
  f.g.append('path').datum(normal).attr('d', d3.area().x(n => x(n.d)).y0(n => yS(n.lo)).y1(n => yS(n.hi)).curve(d3.curveBasis)).style('fill', 'var(--chip)').style('opacity', .55);
  const mid = normal[Math.floor(normal.length * 0.54)];
  void mid;
  for (const [t, lab] of [[32, 'freezing'], [90, '90°F']] as any) if (t > yS.domain()[0] && t < yS.domain()[1]) { f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', yS(t)).attr('y2', yS(t)).style('stroke', 'var(--ink-4)').style('opacity', .6); f.g.append('text').attr('class', 'annot halo').attr('x', 4).attr('y', yS(t) - 4).text(lab); }
  const cx = (w: any) => x(w.doy + w.hour / 24);
  f.g.append('g').attr('class', 'a-reveal').selectAll('circle').data(ws).join('circle').attr('cx', cx).attr('cy', (w: any) => yS(w.temp)).attr('r', (w: any) => w.cond >= 3 ? 3.2 : 2.3).style('fill', (w: any) => w.cond >= 0 ? ramp[w.cond] : 'var(--ink-4)').style('opacity', (w: any) => w.cond >= 3 ? .95 : .6);
  const del = d3.Delaunay.from(ws, cx, (w: any) => yS(w.temp));
  const ring = f.g.append('circle').attr('r', 6).style('fill', 'none').style('stroke', 'var(--ink-1)').style('stroke-width', 2).style('opacity', 0);
  f.svg.on('pointermove', (e: any) => { const [px, py] = d3.pointer(e, f.g.node()); const w: any = ws[del.find(px, py)]; ring.attr('cx', cx(w)).attr('cy', yS(w.temp)).style('opacity', 1); TIP.show(e, `${typeLabel(w)} · ${fDate(w.d)}`, [['Temperature', `${Math.round(w.temp)}°F`], ...(w.feels != null ? [['Feels like', `${Math.round(w.feels)}°F`]] : []), ['Sky', COND[w.cond] || '—', ramp[w.cond]], ['Humidity', w.hum != null ? `${Math.round(w.hum)}%` : '—'], ['Wind', w.wind != null ? `${Math.round(w.wind)} mph` : '—'], ['Source', w.wxSrc === 'api' ? `${wxName(w)} (filled)` : 'Health metadata']]); })
    .on('pointerleave', () => { ring.style('opacity', 0); TIP.hide(); }).on('click', (e: any) => { const [px, py] = d3.pointer(e, f.g.node()); openCloseup(ws[del.find(px, py)].id, true); });
  armArrival(el);
  const lo: any = d3.least(ws, (w: any) => w.temp), hi: any = d3.greatest(ws, (w: any) => w.temp), wet = ws.filter((w: any) => w.cond >= 3).length;
  const used = COND.filter((c, i) => ws.some((w: any) => w.cond === i));
  return { sub: ['From ', [`${Math.round(lo.temp)}°F`], ' to ', [`${Math.round(hi.temp)}°F`], `. ${fInt(wet)} outings in rain, snow or storms, drawn larger. The grey band is the middle 80% of your outing temperatures for each time of year.`], legend: { items: used.map(c => ({ label: c, c: ramp[COND.indexOf(c)] })), kind: 'dt' } };
}

export function drawCond(el: HTMLElement): Out {
  const ws = footRoutes().filter((w: any) => w.cond >= 0); if (!ws.length) return emptyState(el, 'No routes in range');
  const ramp = condRamp();
  const K = COND.map((c, i) => i).filter(i => ws.some((w: any) => w.cond === i));
  const rows = F.years.map((y: number) => { const a = ws.filter((w: any) => w.y === y); return { y, n: a.length, s: K.map(i => a.filter((w: any) => w.cond === i).length / Math.max(1, a.length)) }; }).filter((r: any) => r.n);
  const f = frame(el, 300, { t: 6, r: 6, b: 26, l: 40 });
  const x = d3.scaleBand(rows.map((r: any) => r.y), [0, f.iw]).padding(0.28), yS = d3.scaleLinear([0, 1], [f.ih, 0]);
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(yS).ticks(4).tickSize(0).tickPadding(8).tickFormat(fPct as any));
  xAxis(f.g, x, f.ih, { fmt: (y: number) => `'${String(y).slice(2)}` });
  const bw = Math.min(24, x.bandwidth()), off = (x.bandwidth() - bw) / 2;
  for (const r of rows) { let acc = 0; r.s.forEach((v: number, j: number) => { const i = K[j]; const y0 = yS(acc), y1 = yS(acc + v); acc += v; if (y0 - y1 < 0.5) return; f.g.append('rect').attr('class', 'a-bar').attr('x', x(r.y)! + off).attr('width', bw).attr('y', y1 + 1).attr('height', Math.max(0, y0 - y1 - 2)).attr('rx', 2).style('fill', ramp[i]).on('pointermove', (e: any) => TIP.show(e, `${r.y} · ${fInt(r.n)} outings`, K.map((k, jj) => [COND[k], fPct(r.s[jj]), ramp[k]]))).on('pointerleave', TIP.hide); }); }
  armArrival(el);
  const ri = K.indexOf(3);
  const wetShare = d3.mean(rows, (r: any) => ri >= 0 ? r.s[ri] : 0)!;
  return {
    sub: ['Share of outings by sky at the start: rain and snow from the nearest weather station where one reported, cloud cover from Open-Meteo. You head out in the rain ', [fPct(wetShare)], ' of the time.'],
    legend: { items: K.map(i => ({ label: COND[i], c: ramp[i] })) },
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, ...K.map(i => ({ k: 'c' + i, label: COND[i], num: true }))], rows: rows.map((r: any) => Object.assign({ y: r.y }, ...r.s.map((v: number, j: number) => ({ ['c' + K[j]]: fPct(v) })))) }),
  };
}

export function drawClimb(el: HTMLElement): Out {
  const ws = F.gps.filter((w: any) => w.gain != null); if (!ws.length) return emptyState(el, 'No routes in range');
  const rows = F.years.map((y: number) => ({ y, v: d3.sum(ws, (w: any) => w.y === y ? w.gain : 0) }));
  const f = frame(el, 270, { t: 20, r: 10, b: 26, l: 48 });
  const x = d3.scaleBand(rows.map((r: any) => r.y), [0, f.iw]).padding(0.3);
  const yS = d3.scaleLinear([0, Math.max(29032 * 1.15, d3.max(rows, (r: any) => r.v)! * 1.12)], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => fK(v));
  xAxis(f.g, x, f.ih, { fmt: (y: number) => `'${String(y).slice(2)}` });
  const bw = Math.min(26, x.bandwidth()), off = (x.bandwidth() - bw) / 2;
  f.g.selectAll('rect').data(rows).join('rect').attr('class', 'a-bar').attr('x', (r: any) => x(r.y)! + off).attr('width', bw).attr('y', (r: any) => yS(r.v)).attr('height', (r: any) => f.ih - yS(r.v)).attr('rx', 3).style('fill', (r: any) => r.v >= 29032 ? 'var(--s3)' : 'var(--s1)')
    .on('pointermove', (e: any, r: any) => TIP.show(e, String(r.y), [['Feet climbed', fInt(r.v)], ['Everests', f1(r.v / 29032)]])).on('pointerleave', TIP.hide);
  f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', yS(29032)).attr('y2', yS(29032)).style('stroke', 'var(--ink-2)').style('stroke-width', 1.2);
  f.g.append('text').attr('class', 'dlabel').attr('x', 4).attr('y', yS(29032) - 6).text('Everest, 29,032 ft');
  armArrival(el);
  const n = rows.filter((r: any) => r.v >= 29032).length;
  return {
    sub: [n ? [`${n} of ${rows.length} years`] : 'No year yet', ' topped an Everest of climbing; green columns cleared it. Climb is the watch barometer where it exists, else USGS terrain, else smoothed GPS.'],
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, { k: 'v', label: 'Feet', num: true }, { k: 'e', label: 'Everests', num: true }], rows: rows.map((r: any) => ({ y: r.y, v: fInt(r.v), e: f1(r.v / 29032) })) }),
  };
}

export function drawHills(el: HTMLElement): Out {
  const ws = footRoutes().filter((w: any) => w.gpm != null && w.dist >= 0.5); if (!ws.length) return emptyState(el, 'No routes in range');
  const f = frame(el, 280, { t: 44, r: 14, b: 30, l: 44 });
  const x = d3.scaleLinear([0, Math.min(320, d3.quantile(ws, 0.995, (w: any) => w.gpm)! + 10)], [0, f.iw]).nice();
  const bins = d3.bin().domain(x.domain() as any).thresholds(x.ticks(32)).value((w: any) => Math.min(x.domain()[1] - 0.01, w.gpm))(ws);
  const yS = d3.scaleLinear([0, d3.max(bins, b => b.length)!], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4);
  xAxis(f.g, x, f.ih, { ticks: 8, fmt: (v: number) => v });
  f.g.append('text').attr('class', 'alabel').attr('x', f.iw).attr('y', f.ih + 28).attr('text-anchor', 'end').text('feet of climb per mile');
  f.g.selectAll('rect').data(bins).join('rect').attr('class', 'a-bar').attr('x', (b: any) => x(b.x0) + 1).attr('width', (b: any) => Math.max(0, x(b.x1) - x(b.x0) - 2)).attr('y', (b: any) => yS(b.length)).attr('height', (b: any) => f.ih - yS(b.length)).attr('rx', 2).style('fill', 'var(--s1)')
    .on('pointermove', (e: any, b: any) => TIP.show(e, `${b.x0}–${b.x1} ft/mi`, [['Routes', fInt(b.length)]])).on('pointerleave', TIP.hide);
  // medians for the places you walk most
  const regs = d3.rollups(ws.filter((w: any) => w.place != null), v => ({ n: v.length, m: d3.median(v, (w: any) => w.gpm)! }), (w: any) => w.placeName || 'Other').filter(([, o]) => o.n >= 8).sort((a, b) => b[1].n - a[1].n).slice(0, 5).sort((a, b) => a[1].m - b[1].m);
  let lastX = -999, row = 0;
  regs.forEach(([name, o]) => {
    const px = x(o.m); row = px - lastX < 120 ? (row + 1) % 3 : 0; lastX = px;
    const ty = -22 + row * 11;
    f.g.append('line').attr('x1', px).attr('x2', px).attr('y1', ty + 3).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', .55);
    f.g.append('text').attr('class', 'dlabel a-fade').attr('x', px).attr('y', ty).attr('text-anchor', 'middle').style('font-size', '11px').text(String(name).split(',')[0]);
  });
  armArrival(el);
  const ok = ws.filter((w: any) => w.dist >= 1 && !w.g4 && !w.partial);
  const steep: any = d3.greatest(ok.length ? ok : ws, (w: any) => w.gpm);
  return { sub: ['Vertical lines are the median for the places you walk most. Hilliest outing of a mile or more: ', [`${fInt(steep.gpm)} ft/mi`], ` on ${fDate(steep.d)}${steep.placeName ? ', ' + steep.placeName.split(',')[0] : ''}.`] };
}

export function drawFill(el: HTMLElement): Out {
  const ws = F.gps; if (!ws.length) return emptyState(el, 'No routes in range');
  const cR = css('--s1'), cF = css('--s2'), cG = css('--s3');
  el.replaceChildren();
  const wrap = document.createElement('div'); wrap.style.display = 'grid'; wrap.style.gridTemplateColumns = 'repeat(auto-fit, minmax(300px, 1fr))'; wrap.style.gap = '18px'; el.appendChild(wrap);
  const holders = [0, 1].map(() => { const d = document.createElement('div'); d.style.minWidth = '0'; wrap.appendChild(d); return d; });
  const make = (d: HTMLElement, title: string, parts: { key: string; label: string; c: string; test: (w: any) => boolean }[]) => {
    const rows = F.years.map((y: number) => { const a = ws.filter((w: any) => w.y === y); return Object.assign({ y, n: a.length }, ...parts.map(p => ({ [p.key]: a.filter(p.test).length }))); }).filter((r: any) => r.n);
    const f = frame(d, 220, { t: 22, r: 8, b: 26, l: 40 });
    const x = d3.scaleBand(rows.map((r: any) => r.y), [0, f.iw]).padding(0.3), yS = d3.scaleLinear([0, d3.max(rows, (r: any) => r.n)! * 1.08], [f.ih, 0]).nice();
    yGrid(f.g, yS, f.iw, 3);
    xAxis(f.g, x, f.ih, { fmt: (y: number) => `'${String(y).slice(2)}` });
    const bw = Math.min(24, x.bandwidth()), off = (x.bandwidth() - bw) / 2;
    const stack = d3.stack().keys(parts.map(p => p.key))(rows as any);
    stack.forEach((layer: any, li: number) => f.g.append('g').selectAll('rect').data(layer).join('rect').attr('class', 'a-bar').attr('x', (q: any) => x(q.data.y)! + off).attr('width', bw)
      .attr('y', (q: any) => yS(q[1]) + (li ? 1 : 0)).attr('height', (q: any) => Math.max(0, yS(q[0]) - yS(q[1]) - (li ? 1 : 0))).attr('rx', li === stack.length - 1 ? 3 : 0).style('fill', parts[li].c));
    f.g.selectAll('rect.h').data(rows).join('rect').attr('class', 'h').attr('x', (r: any) => x(r.y)!).attr('width', x.bandwidth()).attr('y', 0).attr('height', f.ih).style('fill', 'transparent')
      .on('pointermove', (e: any, r: any) => TIP.show(e, `${title} · ${r.y}`, [...parts.map(p => [p.label, fInt(r[p.key]), p.c]), ['Routes', fInt(r.n)]])).on('pointerleave', TIP.hide);
    f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -10).text(title);
    armArrival(d);
    return rows;
  };
  const wr = make(holders[0], 'Weather at start', [{ key: 'h', label: 'Health metadata', c: cR, test: w => w.wxSrc === 'health' },
    { key: 's', label: 'NOAA station', c: cF, test: w => w.wxSrc === 'api' && /noaa/.test(w.wxProvider || '') },
    { key: 'a', label: 'Reanalysis (Open-Meteo)', c: cG, test: w => w.wxSrc === 'api' && !/noaa/.test(w.wxProvider || '') }]);
  const er = make(holders[1], 'Climb', [{ key: 'w', label: 'Watch barometer', c: cR, test: w => w.climbSrc === 'watch' }, { key: 'd', label: 'USGS 3DEP terrain', c: cF, test: w => w.climbSrc === 'dem' }, { key: 'g', label: 'Smoothed GPS', c: cG, test: w => w.climbSrc === 'gps' }]);
  const fw = d3.sum(wr, (r: any) => r.a + r.s), fe = d3.sum(er, (r: any) => r.d + r.g);
  const both = ws.filter((w: any) => w.tempHealth != null && w.tempApi != null);
  const dT = both.length ? d3.mean(both, (w: any) => w.tempHealth - w.tempApi)! : null;
  return {
    sub: ['The export has weather for most watch walks and barometric climb for most routes. In this range, ', [`${fInt(fw)} weather gaps`], ' and ', [`${fInt(fe)} climb gaps`], ' are filled and tagged.', dT != null ? ` Where both exist, Health reads ${f1(Math.abs(dT))}°F ${dT >= 0 ? 'warmer' : 'cooler'} than the filled value on average.` : ''],
    legend: { items: [{ label: 'In the export', c: cR }, { label: 'Filled: station or terrain model', c: cF }, { label: 'Filled: reanalysis or GPS', c: cG }] },
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, { k: 'n', label: 'Routes', num: true }, { k: 'wf', label: 'Weather filled', num: true }, { k: 'ed', label: 'Climb from DEM', num: true }, { k: 'eg', label: 'Climb from GPS', num: true }], rows: wr.map((r: any, i: number) => ({ y: r.y, n: r.n, wf: r.a + r.s, ed: er[i]?.d ?? 0, eg: er[i]?.g ?? 0 })) }),
  };
}

// ---------- records ----------
export let RECORDS: any[] = [];
export function computeRecords() {
  const ws = F.gps.filter((w: any) => !w.fragment);
  const foot = ws.filter((w: any) => w.type !== 'ride');
  const by = (t: string) => ws.filter((w: any) => w.type === t);
  const R: any[] = [];
  const add = (group: string, label: string, list: any[], key: (w: any) => number | null, mode: 'max' | 'min', val: (w: any) => string, det: (w: any) => string) => {
    const a = list.filter(w => key(w) != null && isFinite(key(w)!)).sort((p, q) => mode === 'max' ? key(q)! - key(p)! || p.d - q.d : key(p)! - key(q)! || p.d - q.d);
    if (!a.length) return;
    const named = customTitle(a[0]) && !det(a[0]).includes(customTitle(a[0])!) ? `${customTitle(a[0])} · ` : '';
    R.push({ group, label, w: a[0], val: val(a[0]), det: named + det(a[0]), ru: a[1] ? `runner-up ${val(a[1])}, ${fDate(a[1].d)}` : '' });
  };
  const addDay = (group: string, label: string, val: string, det: string) => R.push({ group, label, w: null, val, det, ru: '' });
  add('Distance', 'Longest walk', by('walk'), w => w.dist, 'max', w => `${f1(w.dist)} mi`, w => `${fDate(w.d)} · ${fDur(w.dur)}`);
  add('Distance', 'Longest hike', by('hike'), w => w.dist, 'max', w => `${f1(w.dist)} mi`, w => `${fDate(w.d)} · ${w.placeName || ''}`);
  add('Distance', 'Longest run', by('run'), w => w.dist, 'max', w => `${f1(w.dist)} mi`, w => `${fDate(w.d)} · ${fPace(w.pace)} /mi`);
  add('Distance', 'Longest walk by time', by('walk'), w => w.elapsed, 'max', w => fDur(w.elapsed), w => `${fDate(w.d)} · ${f1(w.dist)} mi`);
  const okPace = (w: any) => !w.g4 && !w.partial && isFinite(w.pace);
  add('Speed', 'Fastest walk over 2 miles', by('walk').filter(w => w.dist >= 2 && okPace(w)), w => w.pace, 'min', w => `${fPace(w.pace)} /mi`, w => `${fDate(w.d)} · ${f1(w.dist)} mi`);
  add('Speed', 'Fastest run over 3 miles', by('run').filter(w => w.dist >= 3 && okPace(w)), w => w.pace, 'min', w => `${fPace(w.pace)} /mi`, w => `${fDate(w.d)} · ${f1(w.dist)} mi`);
  for (const [t, lab] of [['walk', '1 mi'], ['walk', '5K'], ['run', '1 mi']]) {
    const be = (G.bestEfforts || []).filter((b: any) => b.type === t && b.distance_label === lab && b.w.y >= S.y0 && b.w.y <= S.y1 && S.types.has(t));
    const top: any = d3.least(be, (b: any) => b.t);
    if (top) R.push({ group: 'Speed', label: `Best ${lab} inside a ${t}`, w: top.w, val: fTime(top.t), det: `${fDate(top.w.d)} · ${fPace(top.t / top.D)} /mi`, ru: '' });
  }
  add('Speed', 'Biggest negative split', foot.filter((w: any) => w.dist >= 3 && w.splitDelta != null && okPace(w)), w => -w.splitDelta / w.dist / 60, 'max', w => `${fPace(-w.splitDelta / w.dist / 60)} /mi`, w => `${fDate(w.d)} · second half faster`);
  add('Climbing', 'Biggest climb', foot.filter((w: any) => w.gain != null), w => w.gain, 'max', w => `${fInt(w.gain)} ft`, w => wLabel(w));
  add('Climbing', 'Steepest stretch', foot.filter((w: any) => w.maxGrade != null && w.dist >= 0.5), w => w.maxGrade, 'max', w => `${fPct(w.maxGrade)} grade`, w => `${fDate(w.d)} · steepest 100 m`);
  add('Climbing', 'Hilliest walk', by('walk').filter((w: any) => w.dist >= 2 && w.gpm != null), w => w.gpm, 'max', w => `${fInt(w.gpm)} ft/mi`, w => `${fDate(w.d)} · ${f1(w.dist)} mi`);
  add('Heart', 'Most efficient walk', by('walk').filter((w: any) => w.dist >= 2 && w.ef != null), w => w.ef, 'max', w => `${(w.ef * 1).toFixed(2)} m/min per bpm`, w => `${fDate(w.d)} · ${fPace(w.pace)} at ${Math.round(w.hr)} bpm`);
  const rhr = F.days.map((d: any, i: number, a: any[]) => { const win = a.slice(Math.max(0, i - 29), i + 1).filter((x: any) => x.rhr != null); return win.length >= 20 ? { d: d.d, v: d3.mean(win, (x: any) => x.rhr)! } : null; }).filter(Boolean) as any[];
  const lr = d3.least(rhr, r => r.v); if (lr) addDay('Heart', 'Lowest resting heart rate', `${f1(lr.v)} bpm`, `30-day mean ending ${fDate(lr.d)}`);
  const vm = d3.rollups(F.days.filter((d: any) => d.vo2 != null), v => d3.mean(v, (d: any) => d.vo2)!, (d: any) => d.y * 12 + d.m).sort((a, b) => b[1] - a[1])[0];
  if (vm) addDay('Heart', 'Highest VO₂ max', `${f1(vm[1])}`, `monthly mean, ${MONTHS[vm[0] % 12]} ${Math.floor(vm[0] / 12)}`);
  add('Weather and sun', 'Hottest outing', foot.filter((w: any) => w.temp != null), w => w.temp, 'max', w => `${Math.round(w.temp)}°F`, w => `${fDate(w.d)} · ${fClock(w.hour)}`);
  add('Weather and sun', 'Coldest outing', foot.filter((w: any) => w.temp != null), w => w.temp, 'min', w => `${Math.round(w.temp)}°F`, w => `${fDate(w.d)} · ${(COND[w.cond] || '').toLowerCase()}`);
  add('Weather and sun', 'Hottest feels-like', foot.filter((w: any) => w.feels != null), w => w.feels, 'max', w => `${Math.round(w.feels)}°F`, w => `${fDate(w.d)} · ${Math.round(w.temp)}°F, ${Math.round(w.hum ?? 0)}% humidity`);
  add('Weather and sun', 'Coldest feels-like', foot.filter((w: any) => w.feels != null), w => w.feels, 'min', w => `${Math.round(w.feels)}°F`, w => `${fDate(w.d)} · wind ${Math.round(w.wind ?? 0)} mph`);
  add('Weather and sun', 'Windiest outing', foot.filter((w: any) => w.wind != null), w => w.wind, 'max', w => `${Math.round(w.wind)} mph`, w => `${fDate(w.d)} · mean over the workout`);
  add('Weather and sun', 'Wettest outing', foot.filter((w: any) => w.precip != null && w.precip > 0), w => w.precip, 'max', w => `${(w.precip / 25.4).toFixed(2)} in`, w => `${fDate(w.d)} · rain during the workout`);
  add('Weather and sun', 'Earliest start', foot, w => w.hour, 'min', w => fClock(w.hour), w => `${fDate(w.d)} · sunrise ${fClock(w.rise)}`);
  add('Weather and sun', 'Latest finish', foot, w => w.hour + w.elapsed / 60, 'max', w => fClock(w.hour + w.elapsed / 60), w => `${fDate(w.d)} · sunset ${fClock(w.set)}`);
  add('Weather and sun', 'Most minutes in darkness', foot.filter((w: any) => w.darkMin != null), w => w.darkMin, 'max', w => `${fInt(w.darkMin)} min`, w => `${fDate(w.d)} · ${fClock(w.hour)} start`);
  const md: any = d3.greatest(F.days.filter((d: any) => d.steps != null), (d: any) => d.steps);
  if (md) addDay('Volume', 'Most steps in a day', fInt(md.steps), `${DOWS[md.dow]} ${fDate(md.d)}`);
  const footAll = F.all.filter((w: any) => ['walk', 'run', 'hike'].includes(w.type) && S.types.has(w.type));
  const sumBy = (keyf: (w: any) => number) => d3.rollups(footAll, v => d3.sum(v, (w: any) => w.dist), keyf).sort((a, b) => b[1] - a[1])[0];
  const dd = sumBy(w => w.d); if (dd) addDay('Volume', 'Most miles on foot in a day', `${f1(dd[1])} mi`, fDate(dd[0]));
  const wk = sumBy(w => Math.floor(w.d / 7)); if (wk) addDay('Volume', 'Most miles on foot in a week', `${f1(wk[1])} mi`, `week of ${fDate(wk[0] * 7)}`);
  const mo = sumBy(w => w.y * 12 + w.m); if (mo) addDay('Volume', 'Most miles on foot in a month', `${fInt(mo[1])} mi`, `${MONTHS[mo[0] % 12]} ${Math.floor(mo[0] / 12)}`);
  const yr = sumBy(w => w.y); if (yr) addDay('Volume', 'Most miles on foot in a year', `${fInt(yr[1])} mi`, String(yr[0]));
  const nw = d3.rollups(footAll, v => v.length, (w: any) => Math.floor(w.d / 7)).sort((a, b) => b[1] - a[1])[0];
  if (nw) addDay('Volume', 'Most on-foot workouts in a week', fInt(nw[1]), `week of ${fDate(nw[0] * 7)}`);
  const act = streak(F.days.map((d: any) => d.active)); if (act.len) addDay('Consistency', 'Longest active streak', `${act.len} days`, `ended ${fDate(F.days[act.end].d)}`);
  const st = streak(F.days.map((d: any) => (d.steps ?? 0) >= 10000)); if (st.len) addDay('Consistency', 'Longest 10,000-step streak', `${st.len} days`, `ended ${fDate(F.days[st.end].d)}`);
  const weeks = d3.rollups(F.days, v => d3.sum(v, (d: any) => d.nFoot), (d: any) => Math.floor(d.d / 7)).sort((a, b) => a[0] - b[0]);
  const ws3 = streak(weeks.map(w => w[1] >= 3)); if (ws3.len) addDay('Consistency', 'Longest weekly streak', `${ws3.len} weeks`, `3+ on-foot workouts each week, ended ${fDate(weeks[ws3.end][0] * 7 + 6)}`);
  const e = eddington(F.days.map((d: any) => d.footMi)); if (e.E) addDay('Consistency', 'Eddington number', String(e.E), `${e.E} days of ${e.E}+ miles on foot`);
  add('Exploration', 'Furthest from home', foot.filter((w: any) => w.fromHome != null), w => w.fromHome, 'max', w => `${f1(w.fromHome)} mi`, w => `${fDate(w.d)} · on a route from your door`);
  add('Exploration', 'Most new ground in one outing', foot.filter((w: any) => w.newGround != null), w => w.newGround, 'max', w => `${f1(w.newGround)} mi`, w => `${fDate(w.d)} · ${w.placeName || ''}`);
  const sw = F.all.filter((w: any) => w.type === 'swim');
  add('Pool and weights', 'Longest swim', sw, w => w.yards, 'max', w => `${fInt(w.yards)} yd`, w => `${fDate(w.d)} · ${w.swimLaps ?? '—'} laps`);
  add('Pool and weights', 'Best SWOLF', sw.filter((w: any) => w.swolf != null), w => w.swolf, 'min', w => f1(w.swolf), w => `${fDate(w.d)} · freestyle median`);
  const str = F.all.filter((w: any) => w.type === 'strength');
  add('Pool and weights', 'Longest strength session', str, w => w.elapsed, 'max', w => fDur(w.elapsed), w => `${fDate(w.d)} · ${w.hr ? Math.round(w.hr) + ' bpm' : ''}`);
  RECORDS = R;
  return R;
}
