// Port of mockup/src/app-effort.js: pace, pace vs temperature (raw and weather-adjusted), pace by hour,
// HR vs pace, beats per mile, zones, resting HR and VO2 max bands, iPhone gait.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, S } from '../store';
import { MONTHS, Out, TIP, TYPE, ZONES, fDateISO, armArrival, css, dayDate, divInterp, emptyState, f1, fDate, fInt, fK, fPace, fPct, frame, gradientCSS, ordinalRamp, rollingMedian, tempColor, typeLabel, xAxis, yGrid, yearTicks, daySpan } from '../core';
import { drawMilestones } from '../milestones';
import { openCloseup } from './closeup';

export const EFFORT_TYPES = [{ key: 'walk', label: 'Walks' }, { key: 'run', label: 'Runs' }, { key: 'hike', label: 'Hikes' }];
export const EFF = { ptempMode: 'raw' };
export function effortList() { return F.gps.filter((w: any) => w.type === S.effortType && isFinite(w.pace) && !w.g4 && !w.partial && w.dist >= 0.25); }
function paceAxis(f: any, yS: any, ticks = 5) {
  f.g.append('g').attr('class', 'gridl').call(d3.axisLeft(yS).ticks(ticks).tickSize(-f.iw).tickFormat('' as any));
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(yS).ticks(ticks).tickSize(0).tickPadding(8).tickFormat(fPace as any));
}
function effortGuard(el: HTMLElement, min = 5) {
  const name = TYPE[S.effortType].name;
  if (!S.types.has(S.effortType)) { emptyState(el, `${name}s are switched off in the activity filter.`); return null; }
  const ws = effortList(); if (ws.length < min) { emptyState(el, `Not enough GPS-recorded ${name.toLowerCase()}s in this range (${ws.length}).`); return null; }
  return ws;
}

export function drawPace(el: HTMLElement): Out {
  const ws = effortGuard(el); if (!ws) return;
  const f = frame(el, 320, { t: 12, r: 16, b: 26, l: 48 });
  const x = d3.scaleLinear(daySpan(), [0, f.iw]);
  const ext = [d3.quantile(ws, 0.995, (w: any) => w.pace)!, d3.quantile(ws, 0.005, (w: any) => w.pace)!];
  const yS = d3.scaleLinear([ext[0] + 0.3, ext[1] - 0.3], [f.ih, 0]).nice();
  paceAxis(f, yS);
  const yt = yearTicks(F.years, daySpan()[0]);
  xAxis(f.g, x, f.ih, { values: yt, fmt: (v: number) => dayDate(v).getUTCFullYear() });
  drawMilestones(f.g, x, f.ih, { labels: true });
  const tc = tempColor();
  const clamp = (p: number) => Math.max(yS.domain()[1], Math.min(yS.domain()[0], p));
  f.g.append('g').attr('class', 'a-reveal').selectAll('circle').data(ws).join('circle').attr('cx', (w: any) => x(w.d)).attr('cy', (w: any) => yS(clamp(w.pace))).attr('r', 2.4).style('fill', (w: any) => w.temp != null ? tc(w.temp) : 'var(--ink-4)').style('opacity', .75);
  const rm = rollingMedian(ws.map((w: any) => w.pace), 60);
  f.g.append('path').datum(rm).attr('class', 'a-line').attr('d', d3.line().x((v, i) => x(ws[i].d)).y(v => yS(v)).curve(d3.curveBasis)).style('fill', 'none').style('stroke', 'var(--ink-1)').style('stroke-width', 2.2);
  const del = d3.Delaunay.from(ws, (w: any) => x(w.d), (w: any) => yS(clamp(w.pace)));
  const ring = f.g.append('circle').attr('r', 6).style('fill', 'none').style('stroke', 'var(--ink-1)').style('stroke-width', 2).style('opacity', 0);
  f.svg.on('pointermove', (e: any) => { const [px, py] = d3.pointer(e, f.g.node()); const w: any = ws[del.find(px, py)]; ring.attr('cx', x(w.d)).attr('cy', yS(clamp(w.pace))).style('opacity', 1); TIP.show(e, `${typeLabel(w)} · ${fDate(w.d)}`, [['Pace', fPace(w.pace) + ' /mi'], ...(w.gapPace ? [['Grade-adjusted', fPace(w.gapPace) + ' /mi']] : []), ['Distance', f1(w.dist) + ' mi'], ['Temperature', w.temp != null ? Math.round(w.temp) + '°F' : '—', w.temp != null ? tc(w.temp) : undefined], ['Heart rate', w.hr ? Math.round(w.hr) + ' bpm' : '—']]); })
    .on('pointerleave', () => { ring.style('opacity', 0); TIP.hide(); }).on('click', (e: any) => { const [px, py] = d3.pointer(e, f.g.node()); openCloseup(ws[del.find(px, py)].id, true); });
  armArrival(el);
  const ys = F.years.filter((y: number) => ws.filter((w: any) => w.y === y).length >= 3);
  const y0 = ys[0], y1 = ys[ys.length - 1];
  const m0 = d3.median(ws.filter((w: any) => w.y === y0), (w: any) => w.pace), m1 = d3.median(ws.filter((w: any) => w.y === y1), (w: any) => w.pace);
  return { sub: m0 && m1 && y0 !== y1 ? [`Median moving pace went from ${fPace(m0)} in ${y0} to `, [`${fPace(m1)} per mile`], ` in ${y1}, ${fPace(Math.abs(m0 - m1))} ${m1 < m0 ? 'faster' : 'slower'}. Faster is up. Click a dot to open it below.`] : ['Faster is up. Click a dot to open it below.'] };
}
export const paceRampCSS = () => gradientCSS(divInterp());

export function drawPtemp(el: HTMLElement): Out {
  const ws = effortGuard(el); if (!ws) return;
  const withT = ws.filter((w: any) => w.temp != null);
  const f = frame(el, 270, { t: 14, r: 14, b: 30, l: 52 });
  if (EFF.ptempMode === 'adjusted') {
    const rows = G.wxTemp || [];
    if (S.effortType !== 'walk' || !rows.length) return emptyState(el, 'The weather model is fitted on walks only.');
    const x = d3.scaleLinear(d3.extent(rows, (r: any) => r.temp_f) as any, [0, f.iw]);
    const yS = d3.scaleLinear([d3.max(rows, (r: any) => r.hi)! + 0.05, d3.min(rows, (r: any) => r.lo)! - 0.05], [f.ih, 0]).nice();
    const fmtD = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '') + fPace(Math.abs(v));
    f.g.append('g').attr('class', 'gridl').call(d3.axisLeft(yS).ticks(4).tickSize(-f.iw).tickFormat('' as any));
    f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(yS).ticks(4).tickSize(0).tickPadding(8).tickFormat(fmtD as any));
    xAxis(f.g, x, f.ih, { ticks: 6, fmt: (v: number) => v + '°F' });
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', yS(0)).attr('y2', yS(0)).style('stroke', 'var(--ink-3)').style('opacity', .6);
    f.g.append('path').datum(rows).attr('class', 'a-fade').attr('d', d3.area().x(r => x(r.temp_f)).y0(r => yS(r.lo)).y1(r => yS(r.hi)).curve(d3.curveMonotoneX)).style('fill', 'var(--s1)').style('opacity', .16);
    f.g.append('path').datum(rows).attr('class', 'a-line').attr('d', d3.line().x(r => x(r.temp_f)).y(r => yS(r.effect_min)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', 'var(--s1)').style('stroke-width', 2.2);
    f.g.append('text').attr('class', 'alabel').attr('x', f.iw).attr('y', f.ih + 28).attr('text-anchor', 'end').text('temperature at start');
    f.g.append('text').attr('class', 'annot').attr('x', 4).attr('y', yS(0) - 5).text('60°F reference');
    const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
    f.svg.on('pointermove', (e: any) => { const [px] = d3.pointer(e, f.g.node()); const t = x.invert(px); const r: any = d3.least(rows, (q: any) => Math.abs(q.temp_f - t)); ch.attr('x1', x(r.temp_f)).attr('x2', x(r.temp_f)).style('opacity', .6); TIP.show(e, `${Math.round(r.temp_f)}°F`, [['Effect on pace', fmtD(r.effect_min) + ' /mi'], ['95% interval', `${fmtD(r.lo)} to ${fmtD(r.hi)}`]]); })
      .on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
    armArrival(el);
    const fastest: any = d3.least(rows, (r: any) => r.effect_min), hot: any = rows[rows.length - 1];
    const info = G.meta?.weather_model;
    return { sub: ['Partial effect of temperature from a regression that holds year, time of day and hilliness fixed', info ? ` (${fInt(info.n)} walks)` : '', '. Fastest near ', [`${Math.round(fastest.temp_f)}°F`], `; at ${Math.round(hot.temp_f)}°F walks run ${fmtD(hot.effect_min)} a mile. Shaded: 95% interval.`] };
  }
  const bins = d3.range(-10, 105, 5).map(t => { const a = withT.filter((w: any) => w.temp >= t && w.temp < t + 5).map((w: any) => w.pace).sort(d3.ascending); return { t, n: a.length, med: d3.quantileSorted(a, 0.5)!, q1: d3.quantileSorted(a, 0.25)!, q3: d3.quantileSorted(a, 0.75)! }; }).filter(b => b.n >= 6);
  if (bins.length < 2) return emptyState(el, 'Not enough workouts with temperatures.');
  const x = d3.scaleLinear([d3.min(bins, b => b.t)!, d3.max(bins, b => b.t)! + 5], [0, f.iw]);
  const yS = d3.scaleLinear([d3.max(bins, b => b.q3)! + 0.2, d3.min(bins, b => b.q1)! - 0.2], [f.ih, 0]).nice();
  paceAxis(f, yS, 4);
  xAxis(f.g, x, f.ih, { ticks: 6, fmt: (v: number) => v + '°F' });
  f.g.append('path').datum(bins).attr('class', 'a-fade').attr('d', d3.area().x(b => x(b.t + 2.5)).y0(b => yS(b.q1)).y1(b => yS(b.q3)).curve(d3.curveMonotoneX)).style('fill', 'var(--s1)').style('opacity', .16);
  f.g.append('path').datum(bins).attr('class', 'a-line').attr('d', d3.line().x(b => x(b.t + 2.5)).y(b => yS(b.med)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', 'var(--s1)').style('stroke-width', 2);
  const best = d3.least(bins, b => b.med)!;
  f.g.selectAll('circle').data(bins).join('circle').attr('class', 'a-dot').attr('cx', (b: any) => x(b.t + 2.5)).attr('cy', (b: any) => yS(b.med)).attr('r', (b: any) => b === best ? 5.5 : 3.5).style('fill', (b: any) => b === best ? 'var(--signal)' : 'var(--s1)').style('stroke', 'var(--panel)').style('stroke-width', 2)
    .on('pointermove', (e: any, b: any) => TIP.show(e, `${b.t}–${b.t + 5}°F`, [['Median pace', fPace(b.med)], ['Middle half', `${fPace(b.q1)} to ${fPace(b.q3)}`], ['Workouts', fInt(b.n)]])).on('pointerleave', TIP.hide);
  f.g.append('text').attr('class', 'dlabel strong').attr('x', x(best.t + 2.5)).attr('y', yS(best.med) - 12).attr('text-anchor', 'middle').text(`fastest at ${best.t}–${best.t + 5}°F`);
  f.g.append('text').attr('class', 'alabel').attr('x', f.iw).attr('y', f.ih + 28).attr('text-anchor', 'end').text('temperature at start');
  armArrival(el);
  const hot = bins.filter(b => b.t >= 85), hm = hot.length ? d3.mean(hot, b => b.med)! : null;
  return {
    sub: ['Raw median pace per 5° band, middle half shaded. Raw medians mix in fitness: switch to Adjusted for the model view. ', hm ? [`Above 85°F you slow by ${fPace(hm - best.med)} a mile.`] : ''],
    table: () => ({ cols: [{ k: 't', label: 'Band' }, { k: 'n', label: 'Workouts', num: true }, { k: 'm', label: 'Median', num: true }, { k: 'q', label: 'Middle half', num: true }], rows: bins.map(b => ({ t: `${b.t}–${b.t + 5}°F`, n: b.n, m: fPace(b.med), q: `${fPace(b.q1)}–${fPace(b.q3)}` })) }),
  };
}

export function drawWxYear(el: HTMLElement): Out {
  const rows = (G.wxYear || []).filter((r: any) => r.year >= S.y0 && r.year <= S.y1);
  if (!rows.length || !S.types.has('walk')) return emptyState(el, 'No walks in range.');
  const f = frame(el, 245, { t: 16, r: 16, b: 26, l: 52 });
  const x = d3.scaleBand(rows.map((r: any) => r.year), [0, f.iw]).padding(0.4);
  const lo = d3.min(rows, (r: any) => Math.min(r.lo, r.raw_median_min))!, hi = d3.max(rows, (r: any) => Math.max(r.hi, r.raw_median_min))!;
  const yS = d3.scaleLinear([hi + 0.2, lo - 0.2], [f.ih, 0]).nice();
  paceAxis(f, yS, 4);
  xAxis(f.g, x, f.ih, { fmt: (y: number) => rows.length > 6 ? `'${String(y).slice(2)}` : y });
  const cx = (r: any) => x(r.year)! + x.bandwidth() / 2;
  f.g.selectAll('line.ci').data(rows).join('line').attr('class', 'ci a-fade').attr('x1', cx).attr('x2', cx).attr('y1', (r: any) => yS(r.lo)).attr('y2', (r: any) => yS(r.hi)).style('stroke', 'var(--s1)').style('stroke-width', 6).style('stroke-linecap', 'round').style('opacity', .25);
  f.g.append('path').datum(rows).attr('class', 'a-line').attr('d', d3.line().x(cx).y(r => yS(r.adjusted_min))).style('fill', 'none').style('stroke', 'var(--s1)').style('stroke-width', 2);
  f.g.append('path').datum(rows).attr('class', 'a-line').attr('d', d3.line().x(cx).y(r => yS(r.raw_median_min))).style('fill', 'none').style('stroke', 'var(--ink-4)').style('stroke-width', 1.4).style('stroke-dasharray', '4 4');
  f.g.selectAll('circle.a').data(rows).join('circle').attr('class', 'a a-dot').attr('cx', cx).attr('cy', (r: any) => yS(r.adjusted_min)).attr('r', 4).style('fill', 'var(--s1)').style('stroke', 'var(--panel)').style('stroke-width', 2)
    .on('pointermove', (e: any, r: any) => TIP.show(e, String(r.year), [['Adjusted pace', fPace(r.adjusted_min), css('--s1')], ['95% interval', `${fPace(r.lo)} to ${fPace(r.hi)}`], ['Raw median', fPace(r.raw_median_min), css('--ink-4')], ['Walks', fInt(r.n)]])).on('pointerleave', TIP.hide);
  f.g.selectAll('circle.r').data(rows).join('circle').attr('class', 'r a-dot').attr('cx', cx).attr('cy', (r: any) => yS(r.raw_median_min)).attr('r', 2.5).style('fill', 'var(--ink-4)');
  armArrival(el);
  const a = rows[0], z = rows[rows.length - 1];
  const ref = G.meta?.weather_model?.reference;
  return {
    sub: [`Blue: pace at 60°F, ${ref?.hbin ?? 'midday'}, typical climb, from the same model. Dashed: raw median. Adjusted, ${a.year} to ${z.year} went from ${fPace(a.adjusted_min)} to `, [`${fPace(z.adjusted_min)}`], '.'],
    legend: { items: [{ label: 'Weather-adjusted', c: css('--s1') }, { label: 'Raw median', c: css('--ink-4') }], kind: 'ln' },
  };
}

export function drawPhour(el: HTMLElement): Out {
  const ws = effortGuard(el); if (!ws) return;
  const bins = d3.range(5, 23).map(h => { const a = ws.filter((w: any) => Math.floor(w.hour) === h).map((w: any) => w.pace).sort(d3.ascending); return { h, n: a.length, med: d3.quantileSorted(a, .5)!, q1: d3.quantileSorted(a, .25)!, q3: d3.quantileSorted(a, .75)! }; }).filter(b => b.n >= 5);
  if (!bins.length) return emptyState(el, 'Not enough workouts.');
  const f = frame(el, 270, { t: 14, r: 14, b: 30, l: 48 });
  const x = d3.scaleBand(bins.map(b => b.h), [0, f.iw]).padding(0.3);
  const yS = d3.scaleLinear([d3.max(bins, b => b.q3)! + 0.2, d3.min(bins, b => b.q1)! - 0.2], [f.ih, 0]).nice();
  paceAxis(f, yS, 4);
  xAxis(f.g, x, f.ih, { fmt: (h: number) => (h % 12 || 12) + (h < 12 ? 'a' : 'p') });
  const best = d3.least(bins, b => b.med)!;
  const g = f.g.selectAll('g.b').data(bins).join('g').attr('class', 'b a-fade');
  g.append('line').attr('x1', (b: any) => x(b.h)! + x.bandwidth() / 2).attr('x2', (b: any) => x(b.h)! + x.bandwidth() / 2).attr('y1', (b: any) => yS(b.q1)).attr('y2', (b: any) => yS(b.q3)).style('stroke', (b: any) => b === best ? 'var(--signal)' : 'var(--s1)').style('stroke-width', Math.min(8, x.bandwidth() * 0.5)).style('stroke-linecap', 'round').style('opacity', .3);
  g.append('circle').attr('cx', (b: any) => x(b.h)! + x.bandwidth() / 2).attr('cy', (b: any) => yS(b.med)).attr('r', 4.5).style('fill', (b: any) => b === best ? 'var(--signal)' : 'var(--s1)').style('stroke', 'var(--panel)').style('stroke-width', 2);
  g.on('pointermove', (e: any, b: any) => TIP.show(e, `${(b.h % 12 || 12)}${b.h < 12 ? ' am' : ' pm'} starts`, [['Median pace', fPace(b.med)], ['Middle half', `${fPace(b.q1)} to ${fPace(b.q3)}`], ['Workouts', fInt(b.n)]])).on('pointerleave', TIP.hide);
  f.g.append('text').attr('class', 'alabel').attr('x', f.iw).attr('y', f.ih + 28).attr('text-anchor', 'end').text('start hour');
  armArrival(el);
  const late = bins.filter(b => b.h >= 17); const lm = late.length ? d3.mean(late, b => b.med)! : null;
  return {
    sub: ['Fastest when you start at ', [`${best.h % 12 || 12} ${best.h < 12 ? 'am' : 'pm'}`], lm && best.h < 17 ? `. Evening starts average ${fPace(lm - best.med)} a mile slower.` : '.'],
    table: () => ({ cols: [{ k: 'h', label: 'Start hour' }, { k: 'n', label: 'Workouts', num: true }, { k: 'm', label: 'Median', num: true }], rows: bins.map(b => ({ h: `${b.h % 12 || 12}:00 ${b.h < 12 ? 'am' : 'pm'}`, n: b.n, m: fPace(b.med) })) }),
  };
}

export function drawHrpace(el: HTMLElement): Out {
  const all0 = effortGuard(el); if (!all0) return;
  const all = all0.filter((w: any) => w.hr);
  const ys = F.years.filter((y: number) => all.filter((w: any) => w.y === y).length >= 10);
  if (!ys.length) return emptyState(el, 'Not enough workouts with heart rate.');
  const pickY = ys.length >= 3 ? [ys[0], ys[Math.floor((ys.length - 1) / 2)], ys[ys.length - 1]] : ys;
  const cols = ['--s1', '--s2', '--s3'].map(css);
  const ws = all.filter((w: any) => pickY.includes(w.y));
  const f = frame(el, 300, { t: 18, r: 50, b: 32, l: 44 });
  const xe = [d3.quantile(all, 0.99, (w: any) => w.pace)!, d3.quantile(all, 0.01, (w: any) => w.pace)!].sort(d3.ascending);
  const x = d3.scaleLinear([xe[1] + 0.3, xe[0] - 0.3], [0, f.iw]); // slower left, faster right
  const yS = d3.scaleLinear([d3.quantile(ws, 0.01, (w: any) => w.hr)! - 3, d3.quantile(ws, 0.99, (w: any) => w.hr)! + 3], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 5, (v: number) => v);
  xAxis(f.g, x, f.ih, { ticks: 6, fmt: fPace });
  f.g.append('text').attr('class', 'alabel').attr('x', f.iw).attr('y', f.ih + 30).attr('text-anchor', 'end').text('pace per mile, faster →');
  f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -6).text('avg bpm');
  // METRICS.md reference paces (16:00 walks, 9:00 runs) unless they fall outside the middle 80% of your paces
  const p10 = d3.quantile(all, 0.1, (w: any) => w.pace), p90 = d3.quantile(all, 0.9, (w: any) => w.pace);
  let ref = S.effortType === 'run' ? 9 : S.effortType === 'hike' ? 22 : 16;
  if (ref < p10 || ref > p90) ref = Math.round(d3.median(all, (w: any) => w.pace) * 2) / 2;
  const fits: any[] = [];
  pickY.forEach((y: number, i: number) => {
    const a = ws.filter((w: any) => w.y === y);
    f.g.append('g').selectAll('circle').data(a.filter((w: any) => w.pace <= x.domain()[0] && w.pace >= x.domain()[1] && w.hr >= yS.domain()[0] && w.hr <= yS.domain()[1])).join('circle').attr('class', 'a-dot').attr('data-i', (w: any, j: number) => j % 40).attr('cx', (w: any) => x(w.pace)).attr('cy', (w: any) => yS(w.hr)).attr('r', 3).style('fill', cols[i]).style('opacity', .5);
    const mx = d3.mean(a, (w: any) => w.pace)!, my = d3.mean(a, (w: any) => w.hr)!;
    const b = d3.sum(a, (w: any) => (w.pace - mx) * (w.hr - my)) / Math.max(1e-6, d3.sum(a, (w: any) => (w.pace - mx) ** 2));
    const at = (p: number) => my + b * (p - mx);
    fits.push({ y, at, c: cols[i] });
    const [p0, p1] = x.domain();
    f.g.append('path').datum([p0, p1]).attr('class', 'a-line').attr('d', d3.line().x(p => x(p)).y(p => yS(at(p)))).style('stroke', cols[i]).style('stroke-width', 2.2).style('fill', 'none');
    f.g.append('text').attr('class', 'dlabel strong mono a-fade').attr('x', f.iw + 6).attr('y', yS(at(p1)) + 4).text(y);
  });
  f.g.append('line').attr('x1', x(ref)).attr('x2', x(ref)).attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', .5);
  f.g.append('text').attr('class', 'annot').attr('x', x(ref) + 5).attr('y', 12).text(`${fPace(ref)} pace`);
  armArrival(el);
  const legend = { items: pickY.map((y: number, i: number) => ({ label: String(y), c: cols[i] })), kind: 'dt' as const };
  if (fits.length >= 2) {
    const a = fits[0], z = fits[fits.length - 1];
    const watches = (G.sensors?.devices || []).filter((d: any) => d.cls === 'watch');
    const change = watches.find((d: any, i: number) => i > 0 && +d.from.slice(0, 4) > a.y && +d.from.slice(0, 4) <= z.y);
    return { legend, sub: [`At a ${fPace(ref)} pace (your typical pace) average heart rate went from ${Math.round(a.at(ref))} bpm in ${a.y} to `, [`${Math.round(z.at(ref))} bpm in ${z.y}`], '. Lines are least-squares fits.', change ? ` The watch changed to the ${change.name.replace('Apple Watch ', '')} in ${fDateISO(change.from).replace(/ \d+,/, '')}; optical sensors differ between models.` : ''] };
  }
  return { legend };
}

export function drawBpm(el: HTMLElement): Out {
  const ws0 = effortGuard(el); if (!ws0) return;
  const ws = ws0.filter((w: any) => w.bpm);
  const rows = F.years.map((y: number) => { const a = ws.filter((w: any) => w.y === y); return { y, n: a.length, v: a.length >= 3 ? d3.median(a, (w: any) => w.bpm)! : null }; }).filter((r: any) => r.v);
  if (!rows.length) return emptyState(el, 'Not enough workouts with heart rate.');
  const f = frame(el, 300, { t: 22, r: 8, b: 26, l: 46 });
  const x = d3.scaleBand(rows.map((r: any) => r.y), [0, f.iw]).padding(0.3);
  const yS = d3.scaleLinear([0, d3.max(rows, (r: any) => r.v)! * 1.08], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => fK(v));
  xAxis(f.g, x, f.ih, { fmt: (y: number) => rows.length > 6 ? `'${String(y).slice(2)}` : y });
  const bw = Math.min(26, x.bandwidth()), off = (x.bandwidth() - bw) / 2;
  const last = rows[rows.length - 1];
  f.g.selectAll('rect').data(rows).join('rect').attr('class', 'a-bar').attr('x', (r: any) => x(r.y)! + off).attr('width', bw).attr('y', (r: any) => yS(r.v)).attr('height', (r: any) => f.ih - yS(r.v)).attr('rx', 3)
    .style('fill', (r: any) => r === last ? 'var(--signal)' : 'var(--s1)')
    .on('pointermove', (e: any, r: any) => TIP.show(e, String(r.y), [['Beats per mile', fInt(r.v)], ['Workouts', fInt(r.n)]])).on('pointerleave', TIP.hide);
  f.g.selectAll('text.v').data(rows).join('text').attr('class', 'dlabel mono a-fade').attr('text-anchor', 'middle').style('font-size', '10.5px').attr('x', (r: any) => x(r.y)! + x.bandwidth() / 2).attr('y', (r: any) => yS(r.v) - 6).text((r: any) => fK(r.v));
  armArrival(el);
  const first = rows[0];
  const ch = 1 - last.v / first.v;
  return {
    sub: ['Median of average heart rate × moving minutes per mile. ', [`${fPct(Math.abs(ch))} ${ch >= 0 ? 'fewer' : 'more'} beats`], ` per mile in ${last.y} than ${first.y}.`],
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, { k: 'v', label: 'Beats per mile', num: true }, { k: 'n', label: 'Workouts', num: true }], rows: rows.map((r: any) => ({ y: r.y, v: fInt(r.v), n: r.n })) }),
  };
}

export function drawZones(el: HTMLElement): Out {
  const ws0 = effortGuard(el); if (!ws0) return;
  const ws = ws0.filter((w: any) => w.hasZones);
  const ramp = ordinalRamp(5);
  const rows = F.years.map((y: number) => { const a = ws.filter((w: any) => w.y === y); const tot = d3.sum(a, (w: any) => d3.sum(w.zones)) || 1; return { y, n: a.length, z: d3.range(5).map(i => d3.sum(a, (w: any) => w.zones[i]) / tot) }; }).filter((r: any) => r.n);
  if (!rows.length) return emptyState(el, 'No heart-rate streams in range.');
  const f = frame(el, 32 + rows.length * 30, { t: 4, r: 10, b: 24, l: 42 });
  const x = d3.scaleLinear([0, 1], [0, f.iw]), y = d3.scaleBand(rows.map((r: any) => r.y), [0, f.ih]).padding(0.22);
  xAxis(f.g, x, f.ih, { ticks: 5, fmt: fPct }).select('.domain').remove();
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(y).tickSize(0).tickPadding(8));
  for (const r of rows) {
    let acc = 0;
    r.z.forEach((v: number, i: number) => {
      const x0 = x(acc), x1 = x(acc + v); acc += v;
      if (x1 - x0 < 0.5) return;
      f.g.append('rect').attr('class', 'a-hbar').attr('x', x0 + (i ? 1 : 0)).attr('width', Math.max(0, x1 - x0 - (i ? 2 : 0))).attr('y', y(r.y)!).attr('height', y.bandwidth()).attr('rx', i === 0 || i === 4 ? 2 : 0).style('fill', ramp[i])
        .on('pointermove', (e: any) => TIP.show(e, String(r.y), ZONES.map((z, k) => [z, fPct(r.z[k]), ramp[k]]))).on('pointerleave', TIP.hide);
      if (x1 - x0 > 34) f.g.append('text').attr('x', (x0 + x1) / 2).attr('y', y(r.y)! + y.bandwidth() / 2 + 4).attr('text-anchor', 'middle').style('font-family', 'var(--font-mono)').style('font-size', '10px').style('pointer-events', 'none').style('fill', d3.hsl(ramp[i]).l > 0.6 ? '#0d1b2a' : '#f2f6fb').text(fPct(v));
    });
  }
  armArrival(el);
  const a = rows[0], z = rows[rows.length - 1];
  const hm = G.meta?.hr_max ?? 178;
  const pct = G.meta?.zones_pct ?? [60, 70, 80, 90];
  return {
    sub: [`Share of workout time in each zone, from a ${Math.round(hm)} bpm max${G.meta?.hr_max_file_era ? ` (${Math.round(G.meta.hr_max_file_era.hr_max)} bpm for the Garmin years, from their own data)` : ''} (zone 2 starts at ${Math.round(hm * pct[0] / 100)} bpm). Zone 2 and above went from `, [fPct(d3.sum(a.z.slice(1)))], ' to ', [fPct(d3.sum(z.z.slice(1)))], '.'],
    legend: { items: ZONES.map((zz, i) => ({ label: zz, c: ramp[i] })) },
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, ...ZONES.map((zz, i) => ({ k: 'z' + i, label: zz, num: true }))], rows: rows.map((r: any) => Object.assign({ y: r.y }, ...r.z.map((v: number, i: number) => ({ ['z' + i]: fPct(v) })))) }),
  };
}

// monthly mean with 10th–90th band; months without data are gaps, never zeros
export function monthlyBand(days: any[], get: (d: any) => any) {
  const g = d3.rollup(days.filter(d => get(d) != null), v => { const a = v.map(get).sort(d3.ascending); return { m: d3.mean(a)!, lo: d3.quantileSorted(a, 0.1)!, hi: d3.quantileSorted(a, 0.9)!, n: a.length }; }, (d: any) => d.y * 12 + d.m);
  if (!days.length) return [];
  const k0 = days[0].y * 12 + days[0].m, k1 = days[days.length - 1].y * 12 + days[days.length - 1].m;
  return d3.range(k0, k1 + 1).map(k => ({ k, d: Math.round((Date.UTC(Math.floor(k / 12), k % 12, 15) - G.D0) / G.DAY), ...(g.get(k) || { m: null, lo: null, hi: null, n: 0 }) }));
}
export function bandChart(el: HTMLElement, rows: any[], opts: any) {
  const f = frame(el, opts.h || 150, { t: 18, r: 50, b: opts.axis ? 24 : 8, l: 44 });
  const has = rows.filter(r => r.m != null);
  const x = d3.scaleLinear(d3.extent(F.days, (d: any) => d.d) as any, [0, f.iw]);
  if (!has.length) { f.g.append('text').attr('class', 'annot').attr('x', f.iw / 2).attr('y', f.ih / 2).attr('text-anchor', 'middle').text('not recorded in this range'); return f; }
  const yS = d3.scaleLinear([d3.min(has, r => r.lo)!, d3.max(has, r => r.hi)!], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 3, opts.fmt || ((v: number) => v));
  // narrow charts get two-digit years so nine labels still fit
  if (opts.axis) { const yt = yearTicks(F.years, F.days[0].d); const narrow = f.iw / Math.max(1, yt.length) < 46; xAxis(f.g, x, f.ih, { values: yt, fmt: (v: number) => narrow ? `'${String(dayDate(v).getUTCFullYear()).slice(2)}` : dayDate(v).getUTCFullYear() }); }
  drawMilestones(f.g, x, f.ih, { y0: -8 });
  // before the first sample the metric did not exist yet (sensor timeline): say so instead of drawing zeros
  const firstD = has[0].d;
  if (firstD - F.days[0].d > 60) {
    f.g.append('rect').attr('x', 0).attr('width', x(firstD - 15)).attr('y', 0).attr('height', f.ih).style('fill', 'var(--raised)').style('opacity', .7);
    if (x(firstD - 15) > 96) f.g.append('text').attr('class', 'annot').attr('x', x(firstD - 15) / 2).attr('y', f.ih / 2 + 4).attr('text-anchor', 'middle').text('not recorded yet');
  }
  const def = (r: any) => r.m != null;
  f.g.append('path').datum(rows).attr('class', 'a-fade').attr('d', d3.area().defined(def).x(r => x(r.d)).y0(r => yS(r.lo)).y1(r => yS(r.hi)).curve(d3.curveMonotoneX)).style('fill', opts.color).style('opacity', .14);
  f.g.append('path').datum(rows).attr('class', 'a-line').attr('d', d3.line().defined(def).x(r => x(r.d)).y(r => yS(r.m)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', opts.color).style('stroke-width', 2);
  const e = has[has.length - 1];
  f.g.append('circle').attr('cx', x(e.d)).attr('cy', yS(e.m)).attr('r', 4).style('fill', opts.color).style('stroke', 'var(--panel)').style('stroke-width', 2);
  f.g.append('text').attr('class', 'dlabel strong mono').attr('x', x(e.d) + 8).attr('y', yS(e.m) + 4).text((opts.fmtEnd || ((v: number) => f1(v)))(e.m));
  f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -6).text(opts.label);
  const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
  f.svg.on('pointermove', (ev: any) => { const [px] = d3.pointer(ev, f.g.node()); const dd = x.invert(px); const r: any = d3.least(rows, (r: any) => Math.abs(r.d - dd)); ch.attr('x1', x(r.d)).attr('x2', x(r.d)).style('opacity', .6); TIP.show(ev, `${MONTHS[r.k % 12]} ${Math.floor(r.k / 12)}`, r.m == null ? [[opts.label, 'not recorded']] : [[opts.label, (opts.fmtEnd || f1)(r.m), opts.color], ['10th to 90th', `${f1(r.lo)} to ${f1(r.hi)}`]]); })
    .on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
  armArrival(el);
  return f;
}
export function drawFit(el: HTMLElement): Out {
  el.replaceChildren();
  if (!F.days.length) return emptyState(el, 'No days in range');
  const a = document.createElement('div'), b = document.createElement('div'); el.append(a, b);
  const rhr = monthlyBand(F.days, d => d.rhr), vo2 = monthlyBand(F.days, d => d.vo2);
  bandChart(a, rhr, { label: 'Resting heart rate, bpm', color: css('--s8'), fmtEnd: (v: number) => Math.round(v) + ' bpm' });
  bandChart(b, vo2, { label: 'VO₂ max, mL/kg·min', color: css('--s3'), axis: true, h: 170, fmtEnd: (v: number) => f1(v) });
  const h1 = rhr.filter(r => r.m != null), h2 = vo2.filter(r => r.m != null);
  if (!h1.length || !h2.length) return;
  return { sub: ['Resting heart rate ', [`${Math.round(h1[0].m)} → ${Math.round(h1[h1.length - 1].m)} bpm`], ', VO₂ max ', [`${f1(h2[0].m)} → ${f1(h2[h2.length - 1].m)}`], '. Two charts sharing one time axis, not one chart with two scales.'] };
}
export function drawGait(el: HTMLElement): Out {
  el.replaceChildren();
  const days = F.days.filter((d: any) => d.walkSpeed != null);
  if (days.length < 60) return emptyState(el, 'iPhone mobility metrics start in September 2020; widen the year range to see them.');
  const wrap = document.createElement('div'); wrap.style.display = 'grid'; wrap.style.gridTemplateColumns = 'repeat(auto-fit, minmax(240px, 1fr))'; wrap.style.gap = '14px'; el.appendChild(wrap);
  const defs: any[] = [['walkSpeed', 'Walking speed, mph', css('--s1'), (v: number) => f1(v) + ' mph'], ['stepLen', 'Step length, inches', css('--s3'), (v: number) => f1(v) + ' in'], ['dblSupport', 'Double support, % of stride', css('--s7'), (v: number) => f1(v) + '%']];
  // create every slot before drawing: a chart drawn while it is the grid's only child measures the whole row
  const holders = defs.map(() => { const d = document.createElement('div'); d.style.minWidth = '0'; wrap.appendChild(d); return d; });
  defs.forEach(([k, label, c, fe]: any, i: number) => bandChart(holders[i], monthlyBand(F.days, x => x[k]), { label, color: c, axis: true, h: 268, fmtEnd: fe, fmt: (v: number) => k === 'walkSpeed' ? d3.format('.2f')(v) : v }));
  const s0 = d3.mean(days.slice(0, 60), (d: any) => d.walkSpeed)!, s1 = d3.mean(days.slice(-60), (d: any) => d.walkSpeed)!;
  const b0 = d3.mean(days.slice(0, 60), (d: any) => d.dblSupport)!, b1 = d3.mean(days.slice(-60), (d: any) => d.dblSupport)!;
  return { sub: ['Measured passively whenever you carry the phone, not just during workouts. Everyday walking speed went from ', [`${d3.format('.2f')(s0)} to ${d3.format('.2f')(s1)} mph`], `, and time with both feet on the ground ${b1 < b0 ? 'fell' : 'rose'} from ${f1(b0)}% to ${f1(b1)}%${b1 < b0 ? ', a marker of steadier gait' : ''}.`] };
}
