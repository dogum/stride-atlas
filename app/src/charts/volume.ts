// Port of mockup/src/app-volume.js: year race with projection, miles per year by activity, weekly miles, monthly hours.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, GPS_TYPES, S } from '../store';
import { MONTHS, Out, TIP, TYPE, TYPES, armArrival, css, dayDate, emptyState, f1, fDate, fDateShort, fInt, fK, fPct, frame, monthTicks, typeColor, xAxis, yGrid } from '../core';
import { drawMilestones } from '../milestones';

export function drawRace(el: HTMLElement): Out {
  const ys = F.years; const ws = F.gps;
  if (!ws.length) return emptyState(el, 'No routes in range');
  const f = frame(el, 330, { t: 10, r: 46, b: 26, l: 46 });
  const lastY = G.Y1, lastDoy = G.lastDay.doy;
  const series = ys.map((y: number) => {
    const arr = new Float64Array(367); for (const w of ws) if (w.y === y) arr[w.doy] += w.dist;
    let s = 0; const pts: number[][] = []; const end = y === lastY ? lastDoy : (y % 4 === 0 ? 365 : 364);
    for (let d = 0; d <= end; d++) { s += arr[d]; pts.push([d, s]); }
    return { y, pts, total: s, partial: y === lastY && lastDoy < 364 };
  }).filter((s: any) => s.total > 0);
  if (!series.length) return emptyState(el, 'No routes in range');
  const x = d3.scaleLinear([0, 365], [0, f.iw]);
  const ymax = d3.max(series, (s: any) => s.total) as number * 1.06;
  const yS = d3.scaleLinear([0, ymax], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 5);
  const ticks = monthTicks();
  xAxis(f.g, x, f.ih, { values: ticks, fmt: (v: number) => MONTHS[ticks.indexOf(v)] });
  const line = d3.line().x(p => x(p[0])).y(p => yS(p[1]));
  const cur = series[series.length - 1];
  const full = series.filter((s: any) => !s.partial);
  const best = full.length ? d3.greatest(full, (s: any) => s.total) : null;
  const lines = f.g.append('g');
  // push end labels apart so years that finish close together stay readable
  const lab = series.map((s: any) => ({ s, y: yS(s.pts[s.pts.length - 1][1]) })).sort((a: any, b: any) => a.y - b.y);
  for (let i = 1; i < lab.length; i++) if (lab[i].y - lab[i - 1].y < 11) lab[i].y = lab[i - 1].y + 11;
  const labY = new Map(lab.map((l: any) => [l.s, l.y]));
  for (const s of series) {
    const hot = s === cur, isBest = s === best && s !== cur;
    lines.append('path').datum(s.pts).attr('class', 'a-line hov' + (hot || isBest ? ' hot' : '')).attr('d', line).style('fill', 'none')
      .style('stroke', hot ? 'var(--signal)' : isBest ? 'var(--s1)' : 'var(--ink-4)').style('stroke-width', hot ? 2.5 : isBest ? 2 : 1.3).style('opacity', hot || isBest ? 1 : .5).style('stroke-linejoin', 'round');
    const e = s.pts[s.pts.length - 1];
    lines.append('text').attr('class', 'dlabel mono a-fade' + (hot || isBest ? ' strong' : '')).attr('x', x(e[0]) + 6).attr('y', (labY.get(s) as number) + 4).style('font-size', '10.5px').style('opacity', hot || isBest ? 1 : .7).text(s.y);
  }
  let sub: any[];
  // projection: year-to-date ÷ the mean share of the year completed by this day across complete years (METRICS.md)
  if (cur.partial && full.length) {
    const doy = cur.pts.length - 1;
    const share = d3.mean(full, (s: any) => s.pts[Math.min(doy, s.pts.length - 1)][1] / s.total) as number;
    const proj = cur.total / share;
    f.g.append('path').datum([[doy, cur.total], [365, proj]]).attr('d', line).style('fill', 'none').style('stroke', 'var(--signal)').style('stroke-width', 1.5).style('stroke-dasharray', '3 4').style('opacity', .8);
    f.g.append('circle').attr('cx', x(365)).attr('cy', yS(proj)).attr('r', 4).style('fill', 'var(--panel)').style('stroke', 'var(--signal)').style('stroke-width', 2);
    f.g.append('text').attr('class', 'dlabel').attr('x', x(365) - 6).attr('y', yS(proj) - 10).attr('text-anchor', 'end').text(`on pace for ${fInt(proj)} mi`);
    sub = [`${cur.y} has `, [`${fInt(cur.total)} miles`], ` through ${fDateShort(G.NDAYS - 1)}, on pace for about ${fInt(proj)}.`, best ? ` The record is ${best.y} at ${fInt(best.total)}.` : ''];
  } else sub = best ? ['Best full year: ', [`${best.y}, ${fInt(best.total)} miles`], '.'] : [];
  const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
  f.svg.on('pointermove', (e: any) => {
    const [px] = d3.pointer(e, f.g.node()); const d = Math.max(0, Math.min(365, Math.round(x.invert(px))));
    ch.attr('x1', x(d)).attr('x2', x(d)).style('opacity', .6);
    const rows = series.map((s: any) => [String(s.y), s.pts[d] ? `${fInt(s.pts[d][1])} mi` : '—', s === cur ? css('--signal') : s === best ? css('--s1') : css('--ink-4')]).reverse();
    const dt = new Date(Date.UTC(2025, 0, 1) + d * G.DAY);
    TIP.show(e, `Through ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCDate()}`, rows);
  }).on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
  armArrival(el);
  return { sub, table: () => ({ cols: [{ k: 'y', label: 'Year' }, { k: 't', label: 'Miles', num: true }, { k: 'h', label: 'By Jun 30', num: true }], rows: series.map((s: any) => ({ y: s.y + (s.partial ? ' (to date)' : ''), t: fInt(s.total), h: s.pts[180] ? fInt(s.pts[180][1]) : '—' })) }) };
}

export function drawYearly(el: HTMLElement): Out {
  const ys = F.years, types = GPS_TYPES.filter(t => S.types.has(t) && F.gps.some((w: any) => w.type === t));
  if (!F.gps.length) return emptyState(el, 'No routes in range');
  const f = frame(el, 300, { t: 18, r: 8, b: 26, l: 46 });
  const rows = ys.map((y: number) => Object.assign({ y }, ...types.map(t => ({ [t]: d3.sum(F.gps, (w: any) => w.y === y && w.type === t ? w.dist : 0) }))));
  const stack = d3.stack().keys(types)(rows as any);
  const x = d3.scaleBand(ys, [0, f.iw]).padding(0.3);
  const yS = d3.scaleLinear([0, (d3.max(rows, (r: any) => d3.sum(types, t => r[t])) as number) * 1.1], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4);
  xAxis(f.g, x, f.ih, { fmt: (y: number) => ys.length > 6 ? `'${String(y).slice(2)}` : y });
  const bw = Math.min(26, x.bandwidth()), off = (x.bandwidth() - bw) / 2;
  stack.forEach((layer: any, li: number) => {
    f.g.append('g').selectAll('rect').data(layer).join('rect').attr('class', 'a-bar')
      .attr('x', (d: any) => x(d.data.y)! + off).attr('width', bw)
      .attr('y', (d: any) => yS(d[1]) + (li ? 1 : 0)).attr('height', (d: any) => Math.max(0, yS(d[0]) - yS(d[1]) - (li ? 2 : 0)))
      .attr('rx', li === stack.length - 1 ? 3 : 0).style('fill', typeColor(layer.key))
      .on('pointermove', (e: any, d: any) => TIP.show(e, String(d.data.y), types.map(t => [TYPE[t].name, `${fInt(d.data[t])} mi`, typeColor(t)]).concat([['Total', `${fInt(d3.sum(types, t => d.data[t]))} mi`]]))).on('pointerleave', TIP.hide);
  });
  f.g.selectAll('text.tot').data(rows).join('text').attr('class', 'dlabel mono a-fade').attr('text-anchor', 'middle').style('font-size', '10.5px')
    .attr('x', (r: any) => x(r.y)! + x.bandwidth() / 2).attr('y', (r: any) => yS(d3.sum(types, t => r[t])) - 6).text((r: any) => fK(d3.sum(types, t => r[t])));
  armArrival(el);
  const b: any = d3.greatest(rows, (r: any) => d3.sum(types, t => r[t]));
  return {
    sub: ['Outdoor GPS miles. Biggest year ', [String(b.y)], ` with ${fInt(d3.sum(types, t => b[t]))} miles. Treadmill walks and Peloton rides count in daily totals, not here.`],
    legend: { items: types.map(t => ({ label: TYPE[t].name, c: typeColor(t) })) },
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, ...types.map(t => ({ k: t, label: TYPE[t].name, num: true })), { k: 'tot', label: 'Total', num: true }], rows: rows.map((r: any) => Object.assign({ y: r.y, tot: fInt(d3.sum(types, t => r[t])) }, ...types.map(t => ({ [t]: fInt(r[t]) })))) }),
  };
}

export function drawWeekly(el: HTMLElement): Out {
  if (!F.days.length) return emptyState(el, 'No days in range');
  const d0 = F.days[0].d, d1 = F.days[F.days.length - 1].d;
  const wk = (d: number) => Math.floor(d / 7); // weeks start Monday (Jan 1 2018 is a Monday)
  const w0 = wk(d0), w1 = wk(d1);
  const vals = new Float64Array(w1 - w0 + 1); for (const w of F.gps) vals[wk(w.d) - w0] += w.dist;
  const weeks = d3.range(w0, w1 + 1).map((k, i) => ({ k, i, v: vals[i], d: Math.max(d0, k * 7) }));
  const roll = weeks.map((w, i) => d3.mean(weeks.slice(Math.max(0, i - 11), i + 1), z => z.v) as number);
  const f = frame(el, 260, { t: 14, r: 12, b: 26, l: 42 });
  const x = d3.scaleLinear([0, weeks.length], [0, f.iw]);
  const yS = d3.scaleLinear([0, (d3.max(weeks, w => w.v) || 1) * 1.08], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => v + ' mi');
  const yrTicks = F.years.map((y: number) => { const d = Math.round((Date.UTC(y, 0, 1) - G.D0) / G.DAY); return wk(Math.max(d, d0)) - w0; });
  xAxis(f.g, x, f.ih, { values: yrTicks, fmt: (v: number) => F.years[yrTicks.indexOf(v)] });
  drawMilestones(f.g, d3.scaleLinear([w0 * 7, (w0 + weeks.length) * 7], [0, f.iw]), f.ih, { labels: true });
  const bw = Math.max(1, f.iw / weeks.length - (f.iw / weeks.length > 4 ? 1.5 : 0.5));
  f.g.append('g').attr('class', 'a-reveal').selectAll('rect').data(weeks).join('rect').attr('x', (w: any) => x(w.i)).attr('width', bw).attr('y', (w: any) => yS(w.v)).attr('height', (w: any) => f.ih - yS(w.v)).style('fill', 'var(--s1)').style('opacity', .38);
  f.g.append('path').datum(roll).attr('class', 'a-line').attr('d', d3.line().x((v, i) => x(i) + bw / 2).y(v => yS(v)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', 'var(--ink-1)').style('stroke-width', 2);
  const top = d3.greatest(weeks, w => w.v)!;
  f.g.append('circle').attr('cx', x(top.i) + bw / 2).attr('cy', yS(top.v)).attr('r', 4).style('fill', 'var(--signal)').style('stroke', 'var(--panel)').style('stroke-width', 2);
  f.g.append('text').attr('class', 'dlabel').attr('x', x(top.i) + (top.i > weeks.length * 0.8 ? -8 : 8)).attr('text-anchor', top.i > weeks.length * 0.8 ? 'end' : 'start').attr('y', yS(top.v) + 4).text(`${f1(top.v)} mi, week of ${fDateShort(top.d)} ${dayDate(top.d).getUTCFullYear()}`);
  const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
  f.svg.on('pointermove', (e: any) => { const [px] = d3.pointer(e, f.g.node()); const i = Math.max(0, Math.min(weeks.length - 1, Math.floor(x.invert(px)))); const w = weeks[i]; ch.attr('x1', x(i) + bw / 2).attr('x2', x(i) + bw / 2).style('opacity', .6); TIP.show(e, `Week of ${fDate(w.d)}`, [['Miles', f1(w.v)], ['12-week average', f1(roll[i])]]); })
    .on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
  armArrival(el);
  return {
    sub: ['Columns are single weeks, Monday to Sunday; the line is the 12-week average, now ', [`${f1(roll[roll.length - 1])} mi a week`], '.'],
    table: () => ({ cols: [{ k: 'w', label: 'Week of' }, { k: 'v', label: 'Miles', num: true }, { k: 'r', label: '12-week avg', num: true }], rows: weeks.slice().reverse().map(w => ({ w: fDate(w.d), v: f1(w.v), r: f1(roll[w.i]) })) }),
  };
}

export function drawMix(el: HTMLElement): Out {
  const types = TYPES.map(t => t.key).filter(t => !GPS_TYPES.includes(t) || S.types.has(t));
  const ws = F.all.filter((w: any) => types.includes(w.type) && !w.fragment);
  const used = types.filter(t => ws.some((w: any) => w.type === t));
  if (!ws.length) return emptyState(el, 'No workouts in range');
  const months: any[] = []; for (const y of F.years) for (let m = 0; m < 12; m++) { if (y === G.Y1 && m > G.lastDay.m) break; months.push({ y, m }); }
  const rows = months.map(o => Object.assign({ ...o }, ...used.map(t => ({ [t]: d3.sum(ws, (w: any) => w.y === o.y && w.m === o.m && w.type === t ? w.elapsed : 0) / 60 }))));
  const f = frame(el, 260, { t: 10, r: 12, b: 26, l: 42 });
  const x = d3.scaleBand(d3.range(months.length), [0, f.iw]).paddingInner(months.length > 60 ? 0.18 : 0.25);
  const yS = d3.scaleLinear([0, (d3.max(rows, (r: any) => d3.sum(used, t => r[t])) || 1) * 1.08], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => v + ' h');
  xAxis(f.g, x, f.ih, { values: months.map((o, i) => o.m === 0 ? i : null).filter(v => v != null), fmt: (i: number) => months[i].y });
  const stack = d3.stack().keys(used)(rows as any);
  stack.forEach((layer: any, li: number) => f.g.append('g').selectAll('rect').data(layer).join('rect').attr('class', 'a-bar')
    .attr('x', (d: any, i: number) => x(i)!).attr('width', x.bandwidth()).attr('y', (d: any) => yS(d[1]) + (li && x.bandwidth() > 3 ? 1 : 0)).attr('height', (d: any) => Math.max(0, yS(d[0]) - yS(d[1]) - (li && x.bandwidth() > 3 ? 1 : 0)))
    .style('fill', typeColor(layer.key))
    .on('pointermove', (e: any, d: any) => TIP.show(e, `${MONTHS[d.data.m]} ${d.data.y}`, used.map(t => [TYPE[t].name, `${f1(d.data[t])} h`, typeColor(t)]))).on('pointerleave', TIP.hide));
  armArrival(el);
  const tot = d3.rollup(ws, v => d3.sum(v, (w: any) => w.elapsed) / 60, (w: any) => w.type);
  const grand = d3.sum([...tot.values()]);
  const indoorRide = d3.sum(ws.filter((w: any) => w.type === 'ride' && !w.outdoor), (w: any) => w.elapsed) / 60;
  const firstStr = ws.find((w: any) => w.type === 'strength');
  return {
    sub: ['Walking is ', [fPct((tot.get('walk') || 0) / grand)], ' of all workout time, indoor and out.', indoorRide > 5 ? ` Indoor rides add ${fInt(indoorRide)} hours,` : '', firstStr ? ` and strength sessions run from ${firstStr.y} on.` : ''],
    legend: { items: used.map(t => ({ label: TYPE[t].name, c: typeColor(t) })) },
    table: () => ({ cols: [{ k: 'm', label: 'Month' }, ...used.map(t => ({ k: t, label: TYPE[t].name + ' h', num: true }))], rows: rows.map((r: any) => Object.assign({ m: `${MONTHS[r.m]} ${r.y}` }, ...used.map(t => ({ [t]: f1(r[t]) })))) }),
  };
}
