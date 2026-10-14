// Port of mockup/src/app-rhythm.js: calendar, sun chart, walking clock, punchcard, month×year matrix, weekday profile.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, S } from '../store';
import {
  DOWS, MONTHS, Out, TIP, armArrival, css, dayDate, emptyState, f1, fClock, fDate, fDur, fHourShort, fInt, fPct, frame, monthTicks, seqInterp, typeColor, typeLabel, xAxis,
} from '../core';
import { KINDS, MS, msLabel, msWhen, showMs } from '../milestones';

// ---------- calendar ----------
export const CAL_METRICS = [
  { key: 'steps', label: 'Steps', get: (d: any) => d.steps, f: (v: number) => fInt(v) + ' steps', unit: 'steps' },
  { key: 'mi', label: 'Miles', get: (d: any) => d.mi, f: (v: number) => f1(v) + ' mi', unit: 'mi' },
  { key: 'flights', label: 'Flights', get: (d: any) => d.flights, f: (v: number) => fInt(v) + ' flights', unit: 'flights' },
  { key: 'ex', label: 'Exercise minutes', get: (d: any) => d.exMin, f: (v: number) => fInt(v) + ' min', unit: 'min' },
];
export function drawCal(el: HTMLElement): Out {
  const M = CAL_METRICS.find(m => m.key === S.calMetric)!;
  const years = F.years;
  if (!years.length) return emptyState(el, 'No days in range');
  const W0 = Math.max(300, el.clientWidth);
  const cols = W0 > 1080 && years.length > 3 ? 2 : 1;
  const colW = (W0 - (cols - 1) * 28) / cols, labW = 38;
  const cell = Math.max(5, Math.min(15, Math.floor((colW - labW) / 54)));
  const rowsPer = Math.ceil(years.length / cols), rowH = cell * 7 + 22;
  const H = rowsPer * rowH + 18;
  const f = frame(el, H, { t: 18, r: 0, b: 0, l: 0 });
  const vals = F.days.map(M.get).filter((v: any) => v > 0).sort(d3.ascending);
  const qs = d3.range(1, 7).map(i => d3.quantileSorted(vals, i / 7));
  const ramp = ['--q1', '--q2', '--q3', '--q4', '--q5', '--q6', '--q7'].map(css);
  // missing is not zero: unrecorded days use a hatched empty cell, true zeros the empty colour
  const colorOf = (v: any) => v == null ? 'transparent' : v > 0 ? ramp[d3.bisectRight(qs as number[], v)] : css('--cell-empty');
  years.forEach((y: number, yi: number) => {
    const c = Math.floor(yi / rowsPer), r = yi % rowsPer;
    const gx = c * (colW + 28), gy = r * rowH;
    const g = f.g.append('g').attr('transform', `translate(${gx},${gy})`);
    g.append('text').attr('class', 'dlabel strong mono').attr('x', 0).attr('y', cell * 3.5 + 4).text(y);
    const jan1 = new Date(Date.UTC(y, 0, 1)).getUTCDay();
    const ds = F.days.filter((d: any) => d.y === y);
    const gg = g.append('g').attr('transform', `translate(${labW},0)`);
    gg.selectAll('rect').data(ds).join('rect').attr('class', 'a-cell')
      .attr('data-i', (d: any) => Math.floor((d.doy + jan1) / 7))
      .attr('x', (d: any) => Math.floor((d.doy + jan1) / 7) * cell).attr('y', (d: any) => d.dow * cell)
      .attr('width', cell - 2).attr('height', cell - 2).attr('rx', cell > 9 ? 2 : 1)
      .style('fill', (d: any) => colorOf(M.get(d)))
      .style('stroke', (d: any) => M.get(d) == null ? 'var(--cell-empty)' : null).style('stroke-width', 1)
      .on('pointermove', (e: any, d: any) => {
        const ws = (G.workoutsByD?.get(d.d) || []).filter((w: any) => S.types.has(w.type) || !['walk', 'run', 'hike', 'ride'].includes(w.type));
        TIP.show(e, `${DOWS[d.dow]} ${fDate(d.d)}`, [[M.label, M.get(d) == null ? 'not recorded' : M.f(M.get(d))], ...ws.map((w: any) => [typeLabel(w) + (w.outdoor ? '' : w.setting === 'indoor' ? ' (indoor)' : ''), w.dist > 0.05 ? f1(w.dist) + ' mi' : fDur(w.dur), typeColor(w.type)])]);
      })
      .on('pointerleave', TIP.hide);
    if (showMs()) for (const m of MS.list) {
      const y0 = Math.round((Date.UTC(y, 0, 1) - G.D0) / G.DAY), y1 = Math.round((Date.UTC(y + 1, 0, 1) - G.D0) / G.DAY) - 1;
      const c = KINDS[m.kind].c, col = (d: number) => Math.floor((d - y0 + jan1) / 7) * cell, row = (d: number) => dayDate(d).getUTCDay() * cell;
      if (m.d2 != null && m.d2 >= y0 && m.d <= y1) gg.append('rect').attr('x', col(Math.max(m.d, y0))).attr('width', Math.max(2, col(Math.min(m.d2, y1)) - col(Math.max(m.d, y0)) + cell - 2)).attr('y', 7 * cell + 1).attr('height', 2).attr('rx', 1).style('fill', c).style('opacity', 0.8);
      if (m.d >= y0 && m.d <= y1) gg.append('rect').attr('x', col(m.d) - 1.5).attr('y', row(m.d) - 1.5).attr('width', cell + 1).attr('height', cell + 1).attr('rx', 3).style('fill', 'none').style('stroke', c).style('stroke-width', 1.8)
        .on('pointermove', (e: any) => TIP.show(e, msLabel(m), [[KINDS[m.kind].label, msWhen(m), c]])).on('pointerleave', TIP.hide);
    }
    if (r === 0) MONTHS.forEach((mn, mi) => { const doy = Math.round((Date.UTC(y, mi, 1) - Date.UTC(y, 0, 1)) / G.DAY); gg.append('text').attr('class', 'ax').attr('x', Math.floor((doy + jan1) / 7) * cell).attr('y', -6).style('fill', 'var(--ink-4)').style('font-family', 'var(--font-mono)').style('font-size', '10px').text(mn); });
  });
  armArrival(el);
  const rec = F.days.filter((d: any) => M.get(d) != null);
  const best = d3.greatest(rec, M.get) as any;
  const missing = F.days.length - rec.length;
  return {
    sub: best ? ['Busiest day ', [fDate(best.d)], ` at ${M.f(M.get(best))}. Average ${M.f(d3.mean(rec, M.get) as number)} a day` + (missing ? `; ${fInt(missing)} days have no ${M.unit} recorded (outlined).` : '.')] : [],
    table: () => ({ cols: [{ k: 'm', label: 'Month' }, { k: 'tot', label: `Total ${M.unit}`, num: true }, { k: 'avg', label: 'Daily average', num: true }, { k: 'n', label: 'Days recorded', num: true }], rows: d3.flatRollup(rec, (v: any) => [d3.sum(v, M.get), d3.mean(v, M.get), v.length], (d: any) => d.y, (d: any) => d.m).map(([y, m, [tot, avg, n]]: any) => ({ m: `${MONTHS[m]} ${y}`, tot: fInt(tot), avg: M.key === 'mi' ? f1(avg) : fInt(avg), n })) }),
  };
}
export const calRamp = () => ['--q1', '--q2', '--q3', '--q4', '--q5', '--q6', '--q7'].map(css);

// ---------- every walk against the sun ----------
export function drawSun(el: HTMLElement): Out {
  const ws = F.gps.filter((w: any) => w.place === 0 && w.rise != null);
  if (!ws.length) return emptyState(el, 'No home routes in range');
  const f = frame(el, 410, { t: 12, r: 16, b: 26, l: 44 });
  const x = d3.scaleLinear([0, 365], [0, f.iw]);
  const y = d3.scaleLinear([4, 23.5], [0, f.ih]);
  const ref = d3.range(0, 366, 1).map(doy => ({ doy, ...G.sunRef(doy) }));
  f.g.append('rect').attr('width', f.iw).attr('height', f.ih).style('fill', 'var(--raised-2)').attr('rx', 3);
  const day = d3.area().x(d => x(d.doy)).y0(d => y(d.rise)).y1(d => y(d.set)).curve(d3.curveStepAfter);
  f.g.append('path').datum(ref).attr('d', day).style('fill', 'var(--panel)');
  for (const k of ['rise', 'set']) f.g.append('path').datum(ref).attr('d', d3.line().x(d => x(d.doy)).y(d => y(d[k])).curve(d3.curveStepAfter)).style('fill', 'none').style('stroke', 'var(--signal)').style('stroke-width', 1.2).style('opacity', .7);
  const ticks = monthTicks();
  xAxis(f.g, x, f.ih, { values: ticks, fmt: (v: number) => MONTHS[ticks.indexOf(v)] });
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(y).tickValues([6, 9, 12, 15, 18, 21]).tickSize(0).tickPadding(8).tickFormat((v: any) => fHourShort(v)));
  const segs = f.g.append('g').attr('class', 'a-reveal');
  segs.selectAll('line').data(ws).join('line')
    .attr('x1', (w: any) => x(w.doy + 0.5)).attr('x2', (w: any) => x(w.doy + 0.5)).attr('y1', (w: any) => y(w.hour)).attr('y2', (w: any) => y(Math.min(23.9, w.hour + w.elapsed / 60)))
    .style('stroke', (w: any) => w.dark ? 'var(--ink-1)' : 'var(--s1)').style('stroke-width', 1.1).style('opacity', (w: any) => w.dark ? 0.6 : 0.32).style('stroke-linecap', 'round');
  const mid = 172;
  f.g.append('text').attr('class', 'annot halo').attr('x', x(mid)).attr('y', y(G.sunRef(mid).rise) - 6).attr('text-anchor', 'middle').text('sunrise');
  f.g.append('text').attr('class', 'annot halo').attr('x', x(mid)).attr('y', y(G.sunRef(mid).set) + 15).attr('text-anchor', 'middle').text('sunset');
  // daylight saving starts where sunrise jumps an hour later
  let dst = -1; for (let d = 30; d < 120; d++) if (G.sunRef(d).rise - G.sunRef(d - 1).rise > 0.5) { dst = d; break; }
  if (dst > 0) f.g.append('text').attr('class', 'annot halo').attr('x', x(dst) + 4).attr('y', f.ih - 8).text('clocks spring forward');
  const del = d3.Delaunay.from(ws, (w: any) => x(w.doy + 0.5), (w: any) => y(w.hour + w.elapsed / 120));
  const hl = f.g.append('line').style('stroke', 'var(--signal)').style('stroke-width', 3).style('stroke-linecap', 'round').style('opacity', 0);
  f.svg.on('pointermove', (e: any) => { const [px, py] = d3.pointer(e, f.g.node()); const w: any = ws[del.find(px, py)]; hl.attr('x1', x(w.doy + .5)).attr('x2', x(w.doy + .5)).attr('y1', y(w.hour)).attr('y2', y(w.hour + w.elapsed / 60)).style('opacity', 1); TIP.show(e, fDate(w.d), [['Start', fClock(w.hour)], ['End', fClock(w.hour + w.elapsed / 60)], ['Sunrise', fClock(w.rise)], ['Sunset', fClock(w.set)], [typeLabel(w), f1(w.dist) + ' mi']]); })
    .on('pointerleave', () => { hl.style('opacity', 0); TIP.hide(); });
  armArrival(el);
  const nd = ws.filter((w: any) => w.dark).length;
  const darkM = d3.rollups(ws.filter((w: any) => w.dark), v => v.length, (w: any) => w.m).sort((a, b) => b[1] - a[1])[0];
  return {
    sub: [[fPct(nd / ws.length)], ` of home routes started before sunrise or ended after sunset, most of them in ${darkM ? MONTHS[darkM[0]] : '—'}. White marks are the walks in darkness. Sun times are computed for each date; the band shows ${G.sunRefYear}.`],
    table: () => ({ cols: [{ k: 'm', label: 'Month' }, { k: 'n', label: 'Routes', num: true }, { k: 'dk', label: 'In darkness', num: true }, { k: 'p', label: 'Share', num: true }], rows: d3.range(12).map(m => { const a = ws.filter((w: any) => w.m === m), b = a.filter((w: any) => w.dark); return { m: MONTHS[m], n: fInt(a.length), dk: fInt(b.length), p: a.length ? fPct(b.length / a.length) : '—' }; }) }),
  };
}

// ---------- radial walking clock ----------
export function drawClock(el: HTMLElement): Out {
  const ys = F.years.filter((y: number) => F.gps.some((w: any) => w.y === y));
  if (!ys.length || !F.gps.length) return emptyState(el, 'No routes in range');
  const size = Math.min(el.clientWidth || 360, 420);
  const f = frame(el, size, { t: 0, r: 0, b: 0, l: 0 });
  const cx = f.w / 2, cy = size / 2, R = size / 2 - 22, r0 = R * 0.24;
  const ringW = (R - r0) / ys.length;
  const g = f.svg.append('g').attr('transform', `translate(${cx},${cy})`);
  const interp = seqInterp();
  const arc = d3.arc();
  let peak: any = null;
  ys.forEach((y: number, i: number) => {
    const wsY = F.gps.filter((w: any) => w.y === y); const bins = new Array(48).fill(0);
    for (const w of wsY) bins[Math.floor(w.hour * 2) % 48]++;
    const mx = d3.max(bins) || 1;
    const bi = d3.maxIndex(bins); if (i === ys.length - 1) peak = { y, h: bi / 2, share: bins[bi] / Math.max(1, wsY.length) };
    const inner = r0 + i * ringW, outer = inner + ringW - 1.5;
    g.selectAll(null).data(bins).join('path').attr('class', 'a-cell').attr('data-i', i * 3)
      .attr('d', (v: any, b: number) => arc({ innerRadius: inner, outerRadius: outer, startAngle: b / 48 * 2 * Math.PI + 0.004, endAngle: (b + 1) / 48 * 2 * Math.PI - 0.004 } as any))
      .style('fill', (v: number) => v ? interp(0.12 + 0.88 * v / mx) : 'var(--cell-empty)')
      .on('pointermove', (e: any, v: number) => { const b = bins.indexOf(v); TIP.show(e, `${y}`, [['Half hour', `${fClock(b / 2)}`], ['Starts', fInt(v)], ['Share of year', fPct(v / Math.max(1, wsY.length))]]); })
      .on('pointerleave', TIP.hide);
    if (ys.length <= 10 && ringW > 9) g.append('text').attr('x', 3).attr('y', -(inner + ringW / 2) + 3.5).style('fill', 'var(--ink-3)').style('font-family', 'var(--font-mono)').style('font-size', Math.min(10, ringW - 2) + 'px').text("'" + String(y).slice(2));
  });
  [[0, '12a'], [6, '6a'], [12, '12p'], [18, '6p']].forEach(([h, t]: any) => { const a = h / 24 * 2 * Math.PI; g.append('text').attr('x', Math.sin(a) * (R + 12)).attr('y', -Math.cos(a) * (R + 12) + 4).attr('text-anchor', 'middle').style('fill', 'var(--ink-3)').style('font-family', 'var(--font-mono)').style('font-size', '10.5px').text(t); });
  g.append('text').attr('text-anchor', 'middle').attr('y', -2).style('fill', 'var(--ink-1)').style('font-family', 'var(--font-display)').style('font-weight', 700).style('font-size', '15px').text(peak ? fClock(peak.h).replace(':00', '') : '');
  g.append('text').attr('text-anchor', 'middle').attr('y', 13).style('fill', 'var(--ink-3)').style('font-size', '10px').text(peak ? `peak ${peak.y}` : '');
  armArrival(el);
  const share = (y: number, fn: (w: any) => boolean) => { const a = F.gps.filter((w: any) => w.y === y && w.dow > 0 && w.dow < 6); return a.length ? a.filter(fn).length / a.length : 0; };
  const y0 = ys[0], y1 = ys[ys.length - 1];
  return { sub: ['On weekdays, starts before 8 am went from ', [`${fPct(share(y0, w => w.hour < 8))} to ${fPct(share(y1, w => w.hour < 8))}`], `, and starts after 4 pm from ${fPct(share(y0, w => w.hour >= 16))} to ${fPct(share(y1, w => w.hour >= 16))}, ${y0} to ${y1}.`] };
}

// ---------- punchcard ----------
export function drawPunch(el: HTMLElement): Out {
  const ws = F.gps; if (!ws.length) return emptyState(el, 'No routes in range');
  const f = frame(el, 250, { t: 8, r: 10, b: 24, l: 38 });
  const hours = d3.range(5, 23), order = [1, 2, 3, 4, 5, 6, 0];
  const x = d3.scaleBand(hours, [0, f.iw]).padding(0.1), y = d3.scaleBand(order, [0, f.ih]).padding(0.1);
  const cnt = d3.rollup(ws, v => v.length, (w: any) => w.dow, (w: any) => Math.floor(w.hour));
  const cells: any[] = []; for (const dw of order) for (const h of hours) cells.push({ dw, h, n: cnt.get(dw)?.get(h) || 0 });
  const mx = d3.max(cells, c => c.n) || 1;
  const r = d3.scaleSqrt([0, mx], [0, Math.min(x.bandwidth(), y.bandwidth()) / 2]);
  f.g.selectAll('circle').data(cells).join('circle').attr('class', 'a-dot').attr('data-i', (c: any, i: number) => i % 18 + order.indexOf(c.dw))
    .attr('cx', (c: any) => x(c.h)! + x.bandwidth() / 2).attr('cy', (c: any) => y(c.dw)! + y.bandwidth() / 2).attr('r', (c: any) => c.n ? Math.max(1.5, r(c.n)) : 1)
    .style('fill', (c: any) => c.n ? 'var(--s1)' : 'var(--chip)')
    .on('pointermove', (e: any, c: any) => TIP.show(e, `${DOWS[c.dw]} · ${fClock(c.h)}`, [['Routes started', fInt(c.n)]])).on('pointerleave', TIP.hide);
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(y).tickSize(0).tickPadding(8).tickFormat((d: any) => DOWS[d]));
  xAxis(f.g, x, f.ih, { values: hours.filter(h => h % 3 === 0), fmt: fHourShort }).select('.domain').remove();
  armArrival(el);
  const top = d3.greatest(cells, c => c.n);
  return {
    sub: ['Busiest slot is ', [`${DOWS[top.dw]} at ${fClock(top.h).replace(':00', '')}`], `, with ${fInt(top.n)} starts. Circle area is the count.`],
    table: () => ({ cols: [{ k: 'd', label: 'Day' }, ...hours.map(h => ({ k: 'h' + h, label: fHourShort(h), num: true }))], rows: order.map(dw => Object.assign({ d: DOWS[dw] }, ...hours.map(h => ({ ['h' + h]: cnt.get(dw)?.get(h) || 0 })))) }),
  };
}

// ---------- month × year matrix ----------
export function drawMatrix(el: HTMLElement): Out {
  const ys = F.years; if (!ys.length) return emptyState(el, 'No days in range');
  const f = frame(el, 30 + ys.length * 26, { t: 18, r: 6, b: 4, l: 42 });
  const x = d3.scaleBand(d3.range(12), [0, f.iw]).padding(0.08), y = d3.scaleBand(ys, [0, f.ih]).padding(0.1);
  const rec = F.days.filter((d: any) => d.steps != null);
  const avg = d3.rollup(rec, v => d3.mean(v, (d: any) => d.steps), (d: any) => d.y, (d: any) => d.m);
  const cells: any[] = []; for (const yy of ys) for (let m = 0; m < 12; m++) { const v = avg.get(yy)?.get(m); if (v != null) cells.push({ y: yy, m, v }); }
  if (!cells.length) return emptyState(el, 'No steps in range');
  const [lo, hi] = d3.extent(cells, c => c.v) as [number, number]; const interp = seqInterp();
  const col = (v: number) => interp(0.1 + 0.9 * (v - lo) / Math.max(1, hi - lo));
  const g = f.g.selectAll('g.c').data(cells).join('g').attr('class', 'c a-cell').attr('data-i', (c: any) => c.m + ys.indexOf(c.y));
  g.append('rect').attr('x', (c: any) => x(c.m)!).attr('y', (c: any) => y(c.y)!).attr('width', x.bandwidth()).attr('height', y.bandwidth()).attr('rx', 2).style('fill', (c: any) => col(c.v));
  if (x.bandwidth() > 30) g.append('text').attr('x', (c: any) => x(c.m)! + x.bandwidth() / 2).attr('y', (c: any) => y(c.y)! + y.bandwidth() / 2 + 4).attr('text-anchor', 'middle').style('font-family', 'var(--font-mono)').style('font-size', '10.5px')
    .style('fill', (c: any) => d3.hsl(col(c.v)).l > 0.6 ? '#0d1b2a' : '#f2f6fb').text((c: any) => f1(c.v / 1000));
  g.on('pointermove', (e: any, c: any) => TIP.show(e, `${MONTHS[c.m]} ${c.y}`, [['Average daily steps', fInt(c.v)]])).on('pointerleave', TIP.hide);
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(y).tickSize(0).tickPadding(8));
  f.g.append('g').attr('class', 'ax noline').call(d3.axisTop(x).tickSize(0).tickPadding(6).tickFormat((m: any) => MONTHS[m]));
  armArrival(el);
  const b = d3.greatest(cells, c => c.v), wst = d3.least(cells, c => c.v);
  return {
    sub: ['Thousands of steps per day, phone and watch deduplicated. Best month ', [`${MONTHS[b.m]} ${b.y}`], ` at ${f1(b.v / 1000)}K; quietest ${MONTHS[wst.m]} ${wst.y} at ${f1(wst.v / 1000)}K.`],
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, ...MONTHS.map((m, i) => ({ k: 'm' + i, label: m, num: true }))], rows: ys.map((yy: number) => Object.assign({ y: yy }, ...d3.range(12).map(m => ({ ['m' + m]: avg.get(yy)?.get(m) != null ? fInt(avg.get(yy)!.get(m)!) : '—' })))) }),
  };
}

// ---------- weekday profile ----------
export function drawDow(el: HTMLElement): Out {
  const ys = F.years; if (!ys.length) return emptyState(el, 'No days in range');
  const order = [1, 2, 3, 4, 5, 6, 0];
  const f = frame(el, 230, { t: 6, r: 70, b: 24, l: 42 });
  const rec = F.days.filter((d: any) => d.steps != null);
  const all = d3.rollup(rec, v => d3.mean(v, (d: any) => d.steps), (d: any) => d.dow);
  const per = d3.rollup(rec, v => d3.mean(v, (d: any) => d.steps), (d: any) => d.y, (d: any) => d.dow);
  const mx = d3.max([...per.values()].flatMap(m => [...m.values()])) as number;
  const x = d3.scaleLinear([0, mx * 1.05], [0, f.iw]).nice(), y = d3.scaleBand(order, [0, f.ih]).padding(0.32);
  f.g.append('g').attr('class', 'gridl').attr('transform', `translate(0,${f.ih})`).call(d3.axisBottom(x).ticks(6).tickSize(-f.ih).tickFormat('' as any));
  xAxis(f.g, x, f.ih, { ticks: 6, fmt: (v: number) => d3.format('.2~s')(v).replace('k', 'K') }).select('.domain').remove();
  f.g.selectAll('rect.b').data(order).join('rect').attr('class', 'b a-hbar').attr('x', 0).attr('y', (d: any) => y(d)!).attr('height', y.bandwidth()).attr('width', (d: any) => x(all.get(d) || 0)).attr('rx', 3).style('fill', 'var(--chip)')
    .on('pointermove', (e: any, d: any) => TIP.show(e, DOWS[d], [['All years', fInt(all.get(d)!)], ...ys.map((yy: number) => [String(yy), fInt(per.get(yy)?.get(d) || 0)])])).on('pointerleave', TIP.hide);
  const yrs = ys.filter((yy: number) => per.has(yy));
  const last = yrs[yrs.length - 1], first = yrs[0];
  for (const yy of yrs) for (const d of order) {
    const v = per.get(yy)?.get(d); if (v == null) continue;
    const hot = yy === last, fst = yy === first && yrs.length > 1;
    f.g.append('circle').attr('class', 'a-dot').attr('data-i', yrs.indexOf(yy) * 4).attr('cx', x(v)).attr('cy', y(d)! + y.bandwidth() / 2).attr('r', hot || fst ? 5 : 3)
      .style('fill', hot ? 'var(--signal)' : fst ? 'var(--s1)' : 'var(--ink-4)').style('opacity', hot || fst ? 1 : .55).style('stroke', 'var(--panel)').style('stroke-width', 2);
  }
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(y).tickSize(0).tickPadding(8).tickFormat((d: any) => DOWS[d]));
  const sat = order[d3.maxIndex(order, d => per.get(last)?.get(d) || 0)];
  f.g.append('text').attr('class', 'dlabel').attr('x', x(per.get(last)?.get(sat) || 0) + 9).attr('y', y(sat)! + y.bandwidth() / 2 + 4).text(String(last));
  armArrival(el);
  const wkend = (yy: number) => { const m = per.get(yy); if (!m) return 0; return (((m.get(0) || 0) + (m.get(6) || 0)) / 2) / (d3.mean([1, 2, 3, 4, 5], d => m.get(d)) || 1); };
  const diff = wkend(last) - 1;
  return {
    sub: ['Average daily steps. Bars are all years; dots are single years, with ', [String(first)], ' in blue and ', [String(last)], ` in orange. Weekends run ${fPct(Math.abs(diff))} ${diff >= 0 ? 'above' : 'below'} weekdays in ${last}.`],
    table: () => ({ cols: [{ k: 'd', label: 'Day' }, { k: 'a', label: 'All years', num: true }, ...yrs.map((yy: number) => ({ k: 'y' + yy, label: String(yy), num: true }))], rows: order.map(d => Object.assign({ d: DOWS[d], a: fInt(all.get(d)!) }, ...yrs.map((yy: number) => ({ ['y' + yy]: per.get(yy)?.get(d) != null ? fInt(per.get(yy)!.get(d)!) : '—' })))) }),
  };
}
