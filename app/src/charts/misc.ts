// Port of mockup/src/app-misc.js: swims, SWOLF, strength, plus indoor rides; the device and sensor timeline.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, S } from '../store';
import { MONTHS, Out, TIP, armArrival, css, dayDate, dayOfISO, emptyState, f1, fDate, fDateISO, fDur, fInt, fK, fPace, fPct, frame, ordinalRamp, rollingMedian, xAxis, yGrid } from '../core';

export function drawSwim(el: HTMLElement): Out {
  const ws = F.all.filter((w: any) => w.type === 'swim');
  if (!ws.length) return emptyState(el, 'No swims in this range. Your pool swims run from July 2023 to July 2024.');
  const first = d3.min(ws, (w: any) => w.y * 12 + w.m)!, last = d3.max(ws, (w: any) => w.y * 12 + w.m)!;
  const months = d3.range(first, last + 1).map(k => ({ k, y: Math.floor(k / 12), m: k % 12, v: d3.sum(ws, (w: any) => w.y * 12 + w.m === k ? w.yards : 0), n: ws.filter((w: any) => w.y * 12 + w.m === k).length }));
  const f = frame(el, 250, { t: 10, r: 8, b: 26, l: 46 });
  const x = d3.scaleBand(months.map(o => o.k), [0, f.iw]).padding(0.25), yS = d3.scaleLinear([0, d3.max(months, o => o.v)! * 1.1], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => fK(v));
  const every = Math.max(1, Math.ceil(months.length / 7));
  xAxis(f.g, x, f.ih, { values: months.filter((o, i) => i % every === 0).map(o => o.k), fmt: (k: number) => `${MONTHS[k % 12]} '${String(Math.floor(k / 12)).slice(2)}` });
  const bw = Math.min(24, x.bandwidth()), off = (x.bandwidth() - bw) / 2;
  f.g.selectAll('rect').data(months).join('rect').attr('class', 'a-bar').attr('x', (o: any) => x(o.k)! + off).attr('width', bw).attr('y', (o: any) => yS(o.v)).attr('height', (o: any) => f.ih - yS(o.v)).attr('rx', 2).style('fill', 'var(--s5)')
    .on('pointermove', (e: any, o: any) => TIP.show(e, `${MONTHS[o.m]} ${o.y}`, [['Yards', fInt(o.v)], ['Swims', fInt(o.n)]])).on('pointerleave', TIP.hide);
  armArrival(el);
  const tot = d3.sum(ws, (w: any) => w.yards);
  const laps = (G.swimLaps || []).filter((l: any) => !l.dropped && ws.some((w: any) => w.id === l.id));
  const byStroke = d3.rollup(laps, v => d3.sum(v, (l: any) => l.length_m), (l: any) => l.stroke_style);
  const lt = d3.sum([...byStroke.values()]) || 1;
  const pct = (k: string) => fPct((byStroke.get(k) || 0) / lt);
  return {
    sub: [[`${fInt(tot)} yards`], ` in ${fInt(ws.length)} pool swims (${poolLabel(ws)} lengths), about ${f1(tot / 1760)} miles. By lap: freestyle ${pct('freestyle')}, breaststroke ${pct('breaststroke')}, backstroke ${pct('backstroke')}.`],
    table: () => ({ cols: [{ k: 'm', label: 'Month' }, { k: 'n', label: 'Swims', num: true }, { k: 'v', label: 'Yards', num: true }], rows: months.map(o => ({ m: `${MONTHS[o.m]} ${o.y}`, n: o.n, v: fInt(o.v) })) }),
  };
}

// '25 m' or '25 yd', from the pool length the watch stored with each swim
const poolName = (m: number | null) => m == null ? '?' : Math.abs(m - 22.86) < 0.5 ? '25 yd' : Math.abs(m / 0.9144 - Math.round(m / 0.9144)) < 0.05 && Math.round(m) !== m ? `${Math.round(m / 0.9144)} yd` : `${Math.round(m)} m`;
function poolLabel(ws: any[]) { const names = [...new Set(ws.map((w: any) => poolName(w.lapLen)).filter((n: string) => n !== '?'))]; return names.length ? names.join(' and ') : '25 yd'; }

export function drawSwolf(el: HTMLElement): Out {
  const ws = F.all.filter((w: any) => w.type === 'swim' && w.swolf != null);
  if (ws.length < 2) return emptyState(el, 'No swims with freestyle laps in this range.');
  const f = frame(el, 250, { t: 10, r: 46, b: 26, l: 40 });
  const x = d3.scaleLinear(d3.extent(ws, (w: any) => w.d) as any, [0, f.iw]).nice();
  const vals = ws.flatMap((w: any) => [w.swolf, w.swolfApple].filter((v: any) => v != null));
  const yS = d3.scaleLinear([d3.max(vals)! + 2, d3.min(vals)! - 2], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => v);
  xAxis(f.g, x, f.ih, { ticks: 5, fmt: (v: number) => { const dt = dayDate(v); return `${MONTHS[dt.getUTCMonth()]} '${String(dt.getUTCFullYear()).slice(2)}`; } });
  f.g.selectAll('circle.a').data(ws.filter((w: any) => w.swolfApple != null)).join('circle').attr('class', 'a a-dot').attr('cx', (w: any) => x(w.d)).attr('cy', (w: any) => yS(w.swolfApple)).attr('r', 3).style('fill', 'none').style('stroke', 'var(--ink-3)').style('stroke-width', 1.5);
  f.g.selectAll('circle.p').data(ws).join('circle').attr('class', 'p a-dot').attr('data-i', (w: any, i: number) => i).attr('cx', (w: any) => x(w.d)).attr('cy', (w: any) => yS(w.swolf)).attr('r', 4.5).style('fill', 'var(--s5)')
    .on('pointermove', (e: any, w: any) => TIP.show(e, fDate(w.d), [['SWOLF, computed', f1(w.swolf), css('--s5')], ['SWOLF, Apple', w.swolfApple != null ? f1(w.swolfApple) : '—'], ['Yards', fInt(w.yards)], ['Pace', w.pace100 ? `${fPace(w.pace100)} /100 yd` : '—'], ['Main stroke', w.stroke || '—'], ['Pool', poolName(w.lapLen)]])).on('pointerleave', TIP.hide);
  // the trend runs within stretches of the same pool: SWOLF scales with length, and a line across a gap of
  // months would invent the swims in between
  const runs: any[][] = [];
  ws.forEach((w: any, i: number) => { const p = ws[i - 1]; if (!p || w.d - p.d > 120 || poolName(w.lapLen) !== poolName(p.lapLen)) runs.push([]); runs[runs.length - 1].push(w); });
  for (const run of runs) if (run.length >= 4) { const rm = rollingMedian(run.map((w: any) => w.swolf), 3); f.g.append('path').datum(rm).attr('class', 'a-line').attr('d', d3.line().x((v, i) => x(run[i].d)).y(v => yS(v)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', 'var(--ink-1)').style('stroke-width', 2); }
  armArrival(el);
  const a = ws[0], z = ws[ws.length - 1];
  return {
    sub: ['Strokes plus seconds per freestyle length, median per swim; better is up. From ', [f1(a.swolf)], ' to ', [f1(z.swolf)], `${poolName(a.lapLen) !== poolName(z.lapLen) ? ` (a ${poolName(a.lapLen)} pool then, ${poolName(z.lapLen)} now: SWOLF grows with pool length, so compare within each)` : ''}. Filled dots are computed from lap events and stroke counts; rings are the score Apple stores with each lap.`],
    legend: { items: [{ label: 'Computed (strokes + seconds)', c: css('--s5') }, { label: 'Apple HKSWOLFScore', c: css('--ink-3') }], kind: 'dt' },
  };
}

export function drawLift(el: HTMLElement): Out {
  const ws = F.all.filter((w: any) => w.type === 'strength');
  if (!ws.length) return emptyState(el, 'No strength sessions in this range.');
  const ys = F.years.filter((y: number) => ws.some((w: any) => w.y === y));
  const cw = Math.max(6, Math.min(26, Math.floor(((el.clientWidth || 800) - 50) / 53))), cell = Math.min(cw, 16);
  const f = frame(el, ys.length * (cell + 4) + 30, { t: 18, r: 4, b: 8, l: 46 });
  const ramp = ordinalRamp(4);
  const wk = (w: any) => Math.floor(w.d / 7) - Math.floor(Math.round((Date.UTC(w.y, 0, 1) - G.D0) / G.DAY) / 7);
  const cnt = d3.rollup(ws, v => v.length, (w: any) => w.y, wk);
  ys.forEach((y: number, yi: number) => {
    const g = f.g.append('g').attr('transform', `translate(0,${yi * (cell + 4)})`);
    g.append('text').attr('class', 'dlabel strong mono').attr('x', -8).attr('y', cell - 2).attr('text-anchor', 'end').style('font-size', '10.5px').text(y);
    const maxW = y === G.Y1 ? Math.floor(G.lastDay.doy / 7) + 1 : 52;
    g.selectAll('rect').data(d3.range(0, maxW + 1)).join('rect').attr('class', 'a-cell').attr('data-i', (k: number) => k).attr('x', (k: number) => k * cw).attr('width', cw - 2).attr('height', cell).attr('rx', 2)
      .style('fill', (k: number) => { const n = cnt.get(y)?.get(k) || 0; return n ? ramp[Math.min(3, n - 1)] : 'var(--cell-empty)'; })
      .on('pointermove', (e: any, k: number) => TIP.show(e, `${y} · week ${k + 1}`, [['Sessions', fInt(cnt.get(y)?.get(k) || 0)]])).on('pointerleave', TIP.hide);
  });
  MONTHS.forEach((m, mi) => { const doy = Math.round((Date.UTC(2025, mi, 1) - Date.UTC(2025, 0, 1)) / G.DAY); f.g.append('text').attr('x', Math.floor(doy / 7) * cw).attr('y', -6).style('fill', 'var(--ink-4)').style('font-family', 'var(--font-mono)').style('font-size', '10px').text(m); });
  armArrival(el);
  const per = d3.rollups(ws, v => v.length, (w: any) => w.y);
  const hrs = ws.filter((w: any) => w.hr);
  return {
    sub: [[`${fInt(ws.length)} sessions`], `, averaging ${fDur(d3.mean(ws, (w: any) => w.elapsed)!)}${hrs.length ? ` at ${Math.round(d3.mean(hrs, (w: any) => w.hr)!)} bpm` : ''}. Darker weeks had more sessions. Busiest year ${d3.greatest(per, p => p[1])![0]}.`],
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, { k: 'n', label: 'Sessions', num: true }, { k: 'd', label: 'Avg duration', num: true }, { k: 'h', label: 'Avg heart rate', num: true }], rows: ys.map((y: number) => { const a = ws.filter((w: any) => w.y === y), b = a.filter((w: any) => w.hr); return { y, n: a.length, d: fDur(d3.mean(a, (w: any) => w.elapsed)!), h: b.length ? Math.round(d3.mean(b, (w: any) => w.hr)!) : '—' }; }) }),
  };
}

// New for the real data: the Peloton years
export function drawRides(el: HTMLElement): Out {
  const ws = F.all.filter((w: any) => w.type === 'ride' && !w.outdoor);
  if (!ws.length) return emptyState(el, 'No indoor rides in this range.');
  const first = d3.min(ws, (w: any) => w.y * 12 + w.m)!, last = d3.max(ws, (w: any) => w.y * 12 + w.m)!;
  const months = d3.range(first, last + 1).map(k => { const a = ws.filter((w: any) => w.y * 12 + w.m === k); return { k, y: Math.floor(k / 12), m: k % 12, h: d3.sum(a, (w: any) => w.elapsed) / 60, n: a.length, hr: d3.mean(a.filter((w: any) => w.hr), (w: any) => w.hr) }; });
  const f = frame(el, 250, { t: 10, r: 40, b: 26, l: 46 });
  const x = d3.scaleBand(months.map(o => o.k), [0, f.iw]).padding(0.2), yS = d3.scaleLinear([0, d3.max(months, o => o.h)! * 1.1], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => v + ' h');
  xAxis(f.g, x, f.ih, { values: months.filter(o => o.m === 0 || o.k === first).map(o => o.k), fmt: (k: number) => `${MONTHS[k % 12]} '${String(Math.floor(k / 12)).slice(2)}` });
  f.g.selectAll('rect').data(months).join('rect').attr('class', 'a-bar').attr('x', (o: any) => x(o.k)!).attr('width', x.bandwidth()).attr('y', (o: any) => yS(o.h)).attr('height', (o: any) => f.ih - yS(o.h)).attr('rx', 2).style('fill', 'var(--s4)')
    .on('pointermove', (e: any, o: any) => TIP.show(e, `${MONTHS[o.m]} ${o.y}`, [['Rides', fInt(o.n)], ['Hours', f1(o.h)], ['Avg heart rate', o.hr ? Math.round(o.hr) + ' bpm' : '—']])).on('pointerleave', TIP.hide);
  armArrival(el);
  const tot = d3.sum(ws, (w: any) => w.elapsed) / 60;
  const peak = d3.greatest(months, o => o.n)!;
  const src = d3.rollups(ws, v => v.length, (w: any) => w.source).sort((a, b) => b[1] - a[1])[0];
  return {
    sub: [[`${fInt(ws.length)} indoor rides`], `, ${fInt(tot)} hours, mostly from ${src[0]}. Busiest month ${MONTHS[peak.m]} ${peak.y} with ${peak.n} rides. Indoor miles stay out of the mileage charts.`],
    table: () => ({ cols: [{ k: 'm', label: 'Month' }, { k: 'n', label: 'Rides', num: true }, { k: 'h', label: 'Hours', num: true }], rows: months.filter(o => o.n).map(o => ({ m: `${MONTHS[o.m]} ${o.y}`, n: o.n, h: f1(o.h) })) }),
  };
}

// ---------- devices & metrics timeline (full history, not filtered) ----------
export function drawSensors(el: HTMLElement): Out {
  el.replaceChildren();
  const sn = G.sensors; if (!sn) return emptyState(el, 'No sensor data.');
  const t0 = Date.parse(sn.metrics.reduce((a: string, m: any) => m.from < a ? m.from : a, '2100-01-01') + 'T00:00:00Z');
  const t1 = Date.parse(G.lastISO + 'T00:00:00Z');
  const w = Math.max(820, el.clientWidth), lane = 22;
  const devs = sn.devices;
  const watches = devs.filter((d: any) => d.cls === 'watch'), phones = devs.filter((d: any) => d.cls === 'phone');
  const rows = sn.metrics;
  const top = 96;
  const h = top + rows.length * lane + 34;
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('width', w).attr('height', h);
  const L = 300, x = d3.scaleTime([new Date(t0), new Date(t1)], [L, w - 16]);
  const sx = (iso: string) => x(new Date(iso + 'T00:00:00Z'));
  const y0 = Date.UTC(S.y0, 0, 1), y1 = Math.min(t1, Date.UTC(S.y1 + 1, 0, 1));
  if (!(S.y0 === G.Y0 && S.y1 === G.Y1)) svg.append('rect').attr('x', x(new Date(y0))).attr('width', x(new Date(y1)) - x(new Date(y0))).attr('y', 0).attr('height', h - 22).style('fill', 'var(--signal-ghost)');
  for (let y = new Date(t0).getUTCFullYear() + 1; y <= new Date(t1).getUTCFullYear(); y++) { const d = new Date(Date.UTC(y, 0, 1)); svg.append('line').attr('x1', x(d)).attr('x2', x(d)).attr('y1', 0).attr('y2', h - 22).style('stroke', 'var(--grid)'); svg.append('text').attr('x', x(d) + 4).attr('y', h - 8).style('fill', 'var(--ink-3)').style('font-family', 'var(--font-mono)').style('font-size', '10.5px').text(y); }
  const band = (list: any[], yy: number, label: string, cls: string) => {
    svg.append('text').attr('x', 0).attr('y', yy + 17).attr('class', 'alabel').text(label);
    list.forEach((dv: any, i: number) => {
      const g = svg.append('g').attr('class', 'a-hbar');
      const a = sx(dv.from), b = sx(dv.to);
      g.append('rect').attr('x', a + 1).attr('width', Math.max(2, b - a - 2)).attr('y', yy).attr('height', 26).attr('rx', 3).style('fill', i % 2 ? 'var(--raised-2)' : 'var(--chip)');
      g.append('text').attr('x', a + 8).attr('y', yy + 17).style('fill', 'var(--ink-1)').style('font-size', '12px').style('font-weight', 600).text(b - a > 110 ? dv.name.replace('Apple Watch ', '') : '');
      g.on('pointermove', (e: any) => TIP.show(e, dv.name, [['Hardware', dv.hardware], ['First sample', fDateISO(dv.from)], ['Last sample', fDateISO(dv.to)], ['Samples', fInt(dv.n)]])).on('pointerleave', TIP.hide);
    });
  };
  band(watches, 8, 'Watch on your wrist', 'watch');
  band(phones, 42, 'Phone in your pocket', 'phone');
  const clsColor: Record<string, string> = { watch: 'var(--s1)', phone: 'var(--s3)', other: 'var(--s4)' };
  rows.forEach((m: any, i: number) => {
    const y = top + i * lane;
    const dup = rows.filter((o: any) => o.name === m.name).length > 1;
    svg.append('text').attr('x', 0).attr('y', y + 14).style('fill', 'var(--ink-2)').style('font-size', '12px').text(m.name + (m.cls === 'other' ? ' (other apps)' : dup ? (m.cls === 'phone' ? ' (iPhone)' : ' (watch)') : ''));
    const a = sx(m.from);
    // one bar per stretch of recording: a gap of half a year or more is a gap, not a bar
    for (const [s0, s1] of (m.spans || [[m.from, m.to]])) {
      const x0 = sx(s0), x1 = sx(s1);
      svg.append('rect').attr('class', 'a-hbar').attr('x', x0).attr('width', Math.max(3, x1 - x0)).attr('y', y + 4).attr('height', 11).attr('rx', 5.5).style('fill', clsColor[m.cls]).style('opacity', .8)
        .on('pointermove', (e: any) => TIP.show(e, m.name, [['This stretch', `${fDateISO(s0)} – ${fDateISO(s1)}`], ['Recorded since', fDateISO(m.from)], ['Last', fDateISO(m.to)], ['Source', m.cls === 'watch' ? 'Watch' : m.cls === 'phone' ? 'iPhone' : 'other apps and devices'], ['Samples', fInt(m.n)]])).on('pointerleave', TIP.hide);
    }
    if (a - L > 60) svg.append('text').attr('x', a - 6).attr('y', y + 14).attr('text-anchor', 'end').style('fill', 'var(--ink-4)').style('font-family', 'var(--font-mono)').style('font-size', '10px').text(`${MONTHS[new Date(m.from).getUTCMonth()]} ${new Date(m.from).getUTCFullYear()}`);
  });
  const lg = svg.append('g').attr('transform', `translate(0,${h - 12})`);
  [['Watch', '--s1'], ['iPhone', '--s3'], ['Other apps', '--s4']].forEach(([t, c], i) => { lg.append('rect').attr('x', i * 110).attr('y', -9).attr('width', 12).attr('height', 8).attr('rx', 4).style('fill', `var(${c})`); lg.append('text').attr('x', i * 110 + 18).attr('y', -1).style('fill', 'var(--ink-3)').style('font-size', '11.5px').text(t); });
  armArrival(el);
  const wnames = watches.map((d: any) => d.name.replace('Apple Watch ', ''));
  return { sub: ['Read from each record\'s ', ['device'], ' and ', ['sourceName'], ` attributes. ${wnames.join(', then ')} on the wrist; ${phones.map((d: any) => d.name).join(', ')} in the pocket. Each bar starts at the first sample, so charts know when a metric did not exist yet.`] };
}
