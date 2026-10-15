// Sound: the level around you, measured by the watch all day and night, and in your ears from headphones
// (pipeline/stride/export.py export_sound). Levels are dBA; months and days without readings stay empty.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, S } from '../store';
import { MONTHS, Out, TIP, armArrival, css, dayDate, emptyState, f1, fClock, fDate, fInt, frame, xAxis, yGrid, yearTicks } from '../core';
import { drawMilestones } from '../milestones';
import { calRamp } from './rhythm';

const inYears = (r: any) => r.y >= S.y0 && r.y <= S.y1;
const hoursIn = () => (G.sound?.hours ?? []).filter((r: any) => inYears(r) && r.n >= 4);
const daysIn = () => (G.sound?.days ?? []).filter(inYears);
const fDb = (v: number) => `${Math.round(v)} dB`;
const monthKey = (r: any) => r.y * 12 + r.m;
const monthName = (k: number) => `${MONTHS[k % 12]} ${Math.floor(k / 12)}`;
const kDay = (k: number) => Math.round((Date.UTC(Math.floor(k / 12), k % 12, 1) - G.D0) / G.DAY);
function timeAxis(f: any, x: any, dom: [number, number]) {
  const t = yearTicks(F.years, F.days[0]?.d ?? dom[0]).filter((v: number) => v >= dom[0] && v <= dom[1]);
  const narrow = f.iw / Math.max(1, t.length) < 46;
  xAxis(f.g, x, f.ih, { values: t, fmt: (v: number) => narrow ? `'${String(dayDate(v).getUTCFullYear()).slice(2)}` : dayDate(v).getUTCFullYear() });
}
// a ramp across the calendar's seven steps, quiet to loud, spread over the middle 94% of the values shown
export function soundRamp(vals: number[]) {
  const s = vals.slice().sort(d3.ascending), lo = d3.quantileSorted(s, 0.03) ?? 40, hi = d3.quantileSorted(s, 0.97) ?? 85;
  const R = calRamp();
  const c = d3.scaleLinear(R.map((_: any, i: number) => lo + (hi - lo) * i / (R.length - 1)), R).interpolate(d3.interpolateRgb).clamp(true);
  return { c, lo, hi, css: `linear-gradient(90deg, ${R.join(',')})` };
}

// every month as a column, every hour of the day as a row
export function drawSoundHours(el: HTMLElement): Out {
  const H = hoursIn();
  if (H.length < 48) return emptyState(el, 'The sound around you comes from an Apple Watch (watchOS 6 and later, with the Noise app); not recorded in this range.');
  const k0 = d3.min(H, monthKey), k1 = d3.max(H, monthKey);
  const dom: [number, number] = [kDay(k0), kDay(k1 + 1)];
  const f = frame(el, 330, { t: 22, r: 16, b: 24, l: 58 });
  const x = d3.scaleLinear(dom, [0, f.iw]), y = d3.scaleLinear([0, 24], [0, f.ih]);
  const R = soundRamp(H.map((r: any) => r.v));
  f.g.append('rect').attr('width', f.iw).attr('height', f.ih).style('fill', 'var(--cell-empty)').attr('rx', 2);
  f.g.append('g').selectAll('rect').data(H).join('rect').attr('class', 'a-fade')
    .attr('x', (r: any) => x(r.d)).attr('width', (r: any) => Math.max(1, x(r.d2) - x(r.d) + 0.4)).attr('y', (r: any) => y(r.hour)).attr('height', y(1) - y(0) + 0.4)
    .style('fill', (r: any) => R.c(r.v));
  const hl = (h: number) => h === 0 || h === 24 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`;
  f.g.append('g').attr('class', 'ax').selectAll('text').data([0, 6, 12, 18, 24]).join('text').attr('x', -8).attr('y', (h: number) => y(h) + 4).attr('text-anchor', 'end').text(hl);
  timeAxis(f, x, dom);
  drawMilestones(f.g, x, f.ih, { labels: true, y0: -10 });
  const at = new Map(H.map((r: any) => [`${monthKey(r)}|${r.hour}`, r]));
  f.svg.on('pointermove', (ev: any) => {
    const [px, py] = d3.pointer(ev, f.g.node());
    const h = Math.floor(y.invert(py)), d = x.invert(px), dt = dayDate(d), k = dt.getUTCFullYear() * 12 + dt.getUTCMonth();
    const r: any = at.get(`${k}|${h}`);
    if (h < 0 || h > 23) return TIP.hide();
    TIP.show(ev, `${monthName(k)}, ${hl(h)} to ${hl(h + 1)}`, r ? [['Typical level', fDb(r.v), R.c(r.v)], ['Readings', fInt(r.n)]] : [['', 'no readings']]);
  }).on('pointerleave', TIP.hide);
  armArrival(el);
  // the shape of a day: the loudest and quietest hour across the range
  const byH = d3.rollups(H, (v: any[]) => d3.median(v, (r: any) => r.v), (r: any) => r.hour).sort((a: any, b: any) => a[0] - b[0]);
  const loud = d3.greatest(byH, (a: any) => a[1]), quiet = d3.least(byH, (a: any) => a[1]);
  return { sub: ['Each column is a month, each row an hour of the day, coloured by the typical level the watch measured around you. Loudest hour ',
    [`${fClock(loud[0])} (${fDb(loud[1])})`], ', quietest ', [`${fClock(quiet[0])} (${fDb(quiet[1])})`], '. A conversation is about 60 dB.'] };
}

// month by month: the typical level by day and by night
export function drawSoundDayNight(el: HTMLElement): Out {
  const D = daysIn();
  if (D.filter((r: any) => r.day != null).length < 30) return emptyState(el, 'No sound readings in this range.');
  const series = [
    { key: 'day', label: 'Day, 7 am to 10 pm', c: css('--s4') },
    { key: 'night', label: 'Night, 10 pm to 7 am', c: css('--s1') },
  ];
  const months = d3.range(d3.min(D, monthKey), d3.max(D, monthKey) + 1);
  const rows = series.map(s => {
    const g = d3.rollup(D.filter((r: any) => r[s.key] != null), (v: any[]) => { const a = v.map((r: any) => r[s.key]).sort(d3.ascending); return { m: d3.quantileSorted(a, 0.5), lo: d3.quantileSorted(a, 0.25), hi: d3.quantileSorted(a, 0.75), n: a.length }; }, monthKey);
    return { ...s, pts: months.map((k: number) => ({ k, d: kDay(k) + 14, ...(g.get(k)?.n >= 10 ? g.get(k) : { m: null, lo: null, hi: null }) })) };   // a month needs ten days to have a middle
  });
  const dom: [number, number] = [kDay(months[0]), kDay(months[months.length - 1] + 1)];
  const f = frame(el, 330, { t: 22, r: 50, b: 24, l: 44 });
  const x = d3.scaleLinear(dom, [0, f.iw]);
  const all = rows.flatMap(r => r.pts.filter((p: any) => p.m != null));
  const yS = d3.scaleLinear([d3.min(all, (p: any) => p.lo), d3.max(all, (p: any) => p.hi)], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => v);
  timeAxis(f, x, dom);
  drawMilestones(f.g, x, f.ih, { y0: -10 });
  const def = (p: any) => p.m != null;
  for (const r of rows) {
    f.g.append('path').datum(r.pts).attr('class', 'a-fade').attr('d', d3.area().defined(def).x((p: any) => x(p.d)).y0((p: any) => yS(p.lo)).y1((p: any) => yS(p.hi)).curve(d3.curveMonotoneX)).style('fill', r.c).style('opacity', 0.13);
    f.g.append('path').datum(r.pts).attr('class', 'a-line').attr('d', d3.line().defined(def).x((p: any) => x(p.d)).y((p: any) => yS(p.m)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', r.c).style('stroke-width', 2);
    const e = r.pts.filter(def).slice(-1)[0];
    if (e) f.g.append('text').attr('class', 'dlabel strong mono').attr('x', x(e.d) + 6).attr('y', yS(e.m) + 4).text(fDb(e.m));
  }
  f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -8).text('Typical level by month, dB');
  const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
  f.svg.on('pointermove', (ev: any) => {
    const [px] = d3.pointer(ev, f.g.node()); const dd = x.invert(px);
    const i = d3.leastIndex(rows[0].pts, (p: any) => Math.abs(p.d - dd)); const k = rows[0].pts[i].k;
    ch.attr('x1', x(rows[0].pts[i].d)).attr('x2', x(rows[0].pts[i].d)).style('opacity', 0.6);
    TIP.show(ev, monthName(k), rows.map(r => [r.label, r.pts[i].m != null ? fDb(r.pts[i].m) : 'no readings', r.c]) as any);
  }).on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
  armArrival(el);
  // first and last full year in range, by day and by night
  const yr = (key: string, y: number) => d3.median(D.filter((r: any) => r.y === y && r[key] != null), (r: any) => r[key]);
  const ys = [...new Set(D.map((r: any) => r.y))].filter((y: any) => D.filter((r: any) => r.y === y && r.day != null).length > 200) as number[];
  const parts: any[] = ['The median of each day’s readings, then the middle of each month (the band is the middle half of days). '];
  if (ys.length > 1) { const a = ys[0], b = ys[ys.length - 1]; parts.push(`Days ${a} `, [fDb(yr('day', a))], ` → ${b} `, [fDb(yr('day', b))], `, nights `, [fDb(yr('night', a))], ' → ', [fDb(yr('night', b))], '.'); }
  return { sub: parts, legend: { items: rows.map(r => ({ label: r.label, c: r.c })) } };
}

// headphones and loud places: three strips on one time axis
export function drawEars(el: HTMLElement): Out {
  el.replaceChildren();
  const D = daysIn();
  if (!D.some((r: any) => r.hp || r.alerts)) return emptyState(el, 'No headphone listening or loud-sound alerts in this range.');
  const months = d3.range(d3.min(D, monthKey), d3.max(D, monthKey) + 1);
  const by = d3.group(D, monthKey);
  const M = months.map((k: number) => {
    const v = by.get(k) ?? [], hs = d3.sum(v, (r: any) => r.hp ?? 0), days = new Date(Date.UTC(Math.floor(k / 12), k % 12 + 1, 0)).getUTCDate();
    const lvl = hs ? 10 * Math.log10(d3.sum(v.filter((r: any) => r.hp), (r: any) => r.hp * Math.pow(10, r.hpDb / 10)) / hs) : null;
    const loud = v.filter((r: any) => r.alerts);
    return { k, d: kDay(k), d2: kDay(k + 1), hpw: hs / 3600 / (days / 7), lvl, alerts: d3.sum(loud, (r: any) => r.alerts), max: d3.max(loud, (r: any) => r.alertDb) };
  });
  const dom: [number, number] = [kDay(months[0]), kDay(months[months.length - 1] + 1)];
  const strips: any[] = [
    { label: 'Headphones, hours a week', get: (p: any) => p.hpw, c: css('--s7'), fmt: (v: number) => f1(v) + ' h', bars: true },
    { label: 'Headphone level while listening, dB', get: (p: any) => p.lvl, c: css('--s3'), fmt: fDb, bars: false },
    { label: 'Loud-sound alerts a month', get: (p: any) => p.alerts, c: 'var(--warning)', fmt: (v: number) => fInt(v), bars: true },
  ];
  strips.forEach((s, i) => {
    const holder = document.createElement('div'); el.appendChild(holder);
    const last = i === strips.length - 1;
    const f = frame(holder, last ? 128 : 104, { t: 18, r: 48, b: last ? 24 : 6, l: 40 });
    const x = d3.scaleLinear(dom, [0, f.iw]);
    const vals = M.map(s.get).filter((v: any) => v != null && (s.bars ? v > 0 : true));
    if (!vals.length) { f.g.append('text').attr('class', 'annot').attr('x', f.iw / 2).attr('y', f.ih / 2).attr('text-anchor', 'middle').text('none in this range'); return; }
    const yS = s.bars ? d3.scaleLinear([0, d3.max(vals)], [f.ih, 0]).nice() : d3.scaleLinear(d3.extent(vals), [f.ih, 0]).nice();
    yGrid(f.g, yS, f.iw, 2, (v: number) => v);
    if (last) timeAxis(f, x, dom);
    drawMilestones(f.g, x, f.ih, { y0: -8, marks: i === 0 });
    if (s.bars) f.g.append('g').selectAll('rect').data(M.filter((p: any) => s.get(p) > 0)).join('rect').attr('class', 'a-bar')
      .attr('x', (p: any) => x(p.d) + 0.5).attr('width', (p: any) => Math.max(1, x(p.d2) - x(p.d) - 1)).attr('y', (p: any) => yS(s.get(p))).attr('height', (p: any) => f.ih - yS(s.get(p))).style('fill', s.c).style('opacity', 0.8);
    else f.g.append('path').datum(M).attr('class', 'a-line').attr('d', d3.line().defined((p: any) => s.get(p) != null).x((p: any) => x((p.d + p.d2) / 2)).y((p: any) => yS(s.get(p))).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', s.c).style('stroke-width', 1.8);
    f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -6).text(s.label);
    f.svg.on('pointermove', (ev: any) => {
      const [px] = d3.pointer(ev, f.g.node()); const dd = x.invert(px); const p: any = M.find((p: any) => dd >= p.d && dd < p.d2);
      if (!p) return TIP.hide();
      TIP.show(ev, monthName(p.k), [['Headphones', p.hpw ? `${f1(p.hpw)} h a week` : 'none', css('--s7')], ['Level', p.lvl != null ? fDb(p.lvl) : '–', css('--s3')],
        ['Loud-sound alerts', p.alerts ? `${fInt(p.alerts)}, loudest ${fDb(p.max)}` : 'none', css('--warning')]]);
    }).on('pointerleave', TIP.hide);
  });
  armArrival(el);
  const hpH = d3.sum(D, (r: any) => r.hp ?? 0) / 3600, al = d3.sum(D, (r: any) => r.alerts);
  const top = d3.greatest(M, (p: any) => p.alerts);
  return { sub: [[`${fInt(hpH)} hours`], ' of headphone listening and ', [`${fInt(al)} loud-sound alerts`], ' (the watch warns when the sound around you stays loud for a few minutes)',
    ...(top?.alerts ? ['; the most in ', [monthName(top.k)], ` (${fInt(top.alerts)}).`] : ['.'])] as any };
}

// the date of the loudest alert, for the chapter's records line
export function loudest(): { d: number; db: number } | null {
  const a = daysIn().filter((r: any) => r.alertDb != null);
  const r: any = d3.greatest(a, (r: any) => r.alertDb);
  return r ? { d: r.d, db: r.alertDb } : null;
}
export const fLoud = (l: { d: number; db: number }) => `${fDb(l.db)} on ${fDate(l.d)}`;
