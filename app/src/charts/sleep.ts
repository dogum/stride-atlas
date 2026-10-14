// The Sleep page: every night since the first sleep record, from pipeline/stride/sleep.py (one source per night,
// rules Z1-Z5). Clock times are hours on an 18-to-42 axis (22.5 is 10:30 pm, 30 is 6 am the next morning).
// Nights marked `est` (a sleep window, not measured sleep) are drawn faintly and kept out of medians and records.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { G, S, emit } from '../store';
import { MONTHS, Out, TIP, armArrival, css, dayDate, emptyState, f1, fClock, fDate, fDur, fInt, frame, xAxis, yGrid } from '../core';
import { STAGES } from '../data';
import { KINDS, drawMilestones, showMs, visibleMs } from '../milestones';

// the stage colours on the night ground (the barcode and the one-night view are dark in both themes)
export const NIGHT_C: Record<number, string> = { 1: 'rgba(151,165,187,.30)', 2: '#4f78b8', 3: '#3987e5', 4: '#5a4fcf', 5: '#8ec5ff', 6: '#ff8f4a' };
const zc = (k: string) => css(`--z-${k}`);
export const nightsIn = (): any[] => (G.sleep?.nights ?? []).filter((n: any) => n.y >= S.y0 && n.y <= S.y1);
export const measured = (n: any) => n.asleep != null && !n.est;
const clock = (h: number) => fClock(h);
const span = (N: any[]): [number, number] => [N[0].d, N[N.length - 1].d];
const yTicks = (N: any[]) => d3.range(N[0].y + (N[0].doy > 20 ? 1 : 0), N[N.length - 1].y + 1).map((y: number) => Math.round((Date.UTC(y, 0, 1) - G.D0) / G.DAY));
const yearFmt = (v: number) => dayDate(v).getUTCFullYear();
export function openNight(n: any, scroll = true) {
  S.nightId = n.iso; emit('night');
  if (scroll) document.getElementById('onenight')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function runsOf(n: any): [number, number, number][] {
  const R = G.sleep.runs, out: [number, number, number][] = [];
  for (let k = 0; k < n.n; k++) { const i = (n.off + k) * 3; out.push([R[i], R[i + 1], R[i + 2]]); }
  return out;
}
const median = (a: any[], f: (x: any) => any) => d3.median(a.filter((x: any) => f(x) != null), f);
// a rolling median over nights (not days), so gaps in tracking do not drag the line to zero; a month without a
// value breaks the line instead of drawing across it (missing is not zero, and not a straight line either)
const GAP = 30;
function rolling(N: any[], f: (n: any) => number | null, win: number, mean = false) {
  const pts = N.filter(n => f(n) != null), out: any[] = [];
  pts.forEach((n, i) => {
    if (i && n.d - pts[i - 1].d > GAP) out.push({ d: (n.d + pts[i - 1].d) / 2, v: null, lo: null, hi: null });
    // the window stays inside this stretch of nights
    let a0 = i, a1 = i;
    while (a0 > 0 && i - a0 < win >> 1 && pts[a0].d - pts[a0 - 1].d <= GAP) a0--;
    while (a1 < pts.length - 1 && a1 - i < win >> 1 && pts[a1 + 1].d - pts[a1].d <= GAP) a1++;
    const a = pts.slice(a0, a1 + 1).map(f).sort(d3.ascending) as number[];
    out.push({ d: n.d, v: mean ? d3.mean(a) : d3.quantileSorted(a, 0.5), lo: d3.quantileSorted(a, 0.25), hi: d3.quantileSorted(a, 0.75) });
  });
  return out;
}
const def = (r: any) => r.v != null;
const lastDef = (roll: any[]) => roll.filter(def).slice(-1)[0];
let clipN = 0;
function clip(f: any) {
  const id = `sclip${++clipN}`;
  f.svg.append('defs').append('clipPath').attr('id', id).append('rect').attr('x', 0).attr('y', 0).attr('width', f.iw).attr('height', f.ih);
  return `url(#${id})`;
}
const yearAxis = (f: any, x: any, N: any[]) => { const t = yTicks(N); const narrow = f.iw / Math.max(1, t.length) < 46; xAxis(f.g, x, f.ih, { values: t, fmt: (v: number) => narrow ? `'${String(yearFmt(v)).slice(2)}` : yearFmt(v) }); };

// ---------------------------------------------------------------- every night (canvas)
export function drawBarcode(el: HTMLElement): Out {
  const N = nightsIn();
  if (!N.length) return emptyState(el, 'No sleep records in this range.');
  el.replaceChildren();
  const years = d3.range(N[0].y, N[N.length - 1].y + 1);
  const W = Math.max(320, el.clientWidth || 900), narrow = W < 700;
  const padL = narrow ? 34 : 46, padR = narrow ? 8 : 40, rowH = narrow ? 54 : 76, gap = narrow ? 8 : 10, top = 20;
  const H = top + years.length * (rowH + gap);
  const H0 = 19.5, H1 = 35;   // 7:30 pm to 11 am
  const dpr = Math.min(2, devicePixelRatio || 1);
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = H * dpr; cv.style.cssText = `width:${W}px;height:${H}px;display:block;border-radius:var(--r-lg);background:var(--map-bg);cursor:pointer`;
  cv.className = 'a-reveal';
  el.appendChild(cv);
  const ctx = cv.getContext('2d')!; ctx.scale(dpr, dpr);
  const iw = W - padL - padR, colW = iw / 366;
  const yOf = (h: number) => Math.max(0, Math.min(rowH, (h - H0) / (H1 - H0) * rowH));
  const rowY = (y: number) => top + years.indexOf(y) * (rowH + gap);
  ctx.font = `500 ${narrow ? 10 : 11}px ${css('--font-mono')}`;
  // months along the top, guide lines at 9 pm, midnight, 3, 6 and 9 am
  ctx.fillStyle = 'rgba(151,165,187,.75)'; ctx.textAlign = 'left';
  MONTHS.forEach((m, i) => { const doy = Math.round((Date.UTC(2025, i, 1) - Date.UTC(2025, 0, 1)) / 864e5); if (!narrow || i % 2 === 0) ctx.fillText(m, padL + doy * colW + 2, 12); });
  for (const y of years) {
    const ry = rowY(y);
    ctx.fillStyle = 'rgba(151,165,187,.05)'; ctx.fillRect(padL, ry, iw, rowH);
    ctx.strokeStyle = 'rgba(151,165,187,.10)'; ctx.lineWidth = 1;
    for (const h of [21, 24, 27, 30, 33]) { const yy = Math.round(ry + yOf(h)) + 0.5; ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(padL + iw, yy); ctx.stroke(); }
    ctx.fillStyle = 'rgba(195,205,219,.9)'; ctx.textAlign = 'right'; ctx.fillText(narrow ? `'${String(y).slice(2)}` : String(y), padL - 8, ry + rowH / 2 + 4);
    if (!narrow && y === years[0]) {   // the clock, once, at the right edge of the first year
      ctx.fillStyle = 'rgba(151,165,187,.7)'; ctx.textAlign = 'left'; ctx.font = `500 9.5px ${css('--font-mono')}`;
      for (const [h, l] of [[21, '9p'], [24, '12a'], [27, '3a'], [30, '6a'], [33, '9a']] as [number, string][]) ctx.fillText(l, padL + iw + 6, ry + yOf(h) + 3.5);
      ctx.font = `500 11px ${css('--font-mono')}`;
    }
  }
  // milestones: a faint band for a period, a line for a day, in every year row they touch
  if (showMs()) for (const m of visibleMs()) {
    const c = KINDS[m.kind].c;
    for (const y of years) {
      const y0 = Math.round((Date.UTC(y, 0, 1) - G.D0) / G.DAY), y1 = y0 + 365;
      const a = Math.max(m.d, y0), b = Math.min(m.d2 ?? m.d, y1);
      if (b < y0 || a > y1) continue;
      const ry = rowY(y);
      if (m.d2 != null) { ctx.fillStyle = c; ctx.globalAlpha = 0.09; ctx.fillRect(padL + (a - y0) * colW, ry, Math.max(1, (b - a + 1) * colW), rowH); ctx.globalAlpha = 1; }
      if (m.d >= y0 && m.d <= y1) { ctx.fillStyle = c; ctx.globalAlpha = 0.9; ctx.fillRect(padL + (m.d - y0) * colW, ry - 3, Math.max(1.2, colW), rowH + 6); ctx.globalAlpha = 1; }
    }
  }
  // the nights
  const w = Math.max(0.8, colW - (colW > 2.6 ? 0.6 : 0));
  for (const n of N) {
    const x = padL + n.doy * colW, ry = rowY(n.y);
    ctx.globalAlpha = n.est ? 0.42 : 1;
    for (const [st, mins, code] of runsOf(n)) {
      const h0 = 18 + st / 60, h1 = h0 + mins / 60;
      if (h1 < H0 || h0 > H1) continue;
      ctx.fillStyle = NIGHT_C[code] || NIGHT_C[2];
      ctx.fillRect(x, ry + yOf(h0), w, Math.max(0.8, yOf(h1) - yOf(h0)));
    }
  }
  ctx.globalAlpha = 1;
  const at = (ev: PointerEvent) => {
    const r = cv.getBoundingClientRect(), px = ev.clientX - r.left, py = ev.clientY - r.top;
    const yi = Math.floor((py - top) / (rowH + gap)), y = years[yi];
    if (y == null || px < padL) return null;
    const doy = Math.floor((px - padL) / colW);
    return N.find(n => n.y === y && n.doy === doy) || null;
  };
  cv.addEventListener('pointermove', ev => {
    const n = at(ev); if (!n) { TIP.hide(); return; }
    TIP.show(ev, `Night of ${fDate(n.d)}`, n.asleep != null ? [['Asleep', fDur(n.asleep * 60) + (n.est ? ' (estimate)' : '')], ['Fell asleep', clock(n.on)], ['Woke', clock(n.wake)],
      ...(n.cls === 'stages' ? [['Deep · REM', `${fDur(n.deep)} · ${fDur(n.rem)}`]] : []), ['Source', n.source]] : [['In bed', `${clock(n.bed)} to ${clock(n.up)}`], ['Source', `${n.source} (time in bed only)`]]);
  });
  cv.addEventListener('pointerleave', TIP.hide);
  cv.addEventListener('click', ev => { const n = at(ev); if (n) { TIP.hide(); openNight(n); } });
  armArrival(el);
  const M = N.filter(measured);
  return {
    sub: ['One column per night, from 7:30 pm at the top of each year to 11 am at the bottom, coloured by stage. ', [`${fInt(N.length)} nights`], ` since ${fDate(N[0].d)}; ${fInt(M.length)} measured asleep. Faint columns are estimates or time in bed only. Click a night to open it.`],
    legend: { items: [4, 3, 5, 6, 2, 1].map(c => ({ label: STAGES[c].label + (c === 2 ? ' (no stages)' : ''), c: NIGHT_C[c] })) },
  };
}

// ---------------------------------------------------------------- duration
// which source supplied most nights of each month, for the background bands
function eras(N: any[]) {
  const key = (n: any) => n.est ? `${n.source} (estimates)` : n.cls === 'inbed' ? 'Time in bed only' : n.source;
  const months = d3.rollups(N, (v: any[]) => d3.rollups(v, (x: any[]) => x.length, key).sort((a: any, b: any) => b[1] - a[1])[0][0], (n: any) => n.y * 12 + n.m).sort((a: any, b: any) => a[0] - b[0]);
  const out: any[] = [];
  for (const [k, src] of months) {
    const d0 = Math.round((Date.UTC(Math.floor(k / 12), k % 12, 1) - G.D0) / G.DAY), d1 = Math.round((Date.UTC(Math.floor(k / 12), k % 12 + 1, 1) - G.D0) / G.DAY);
    const last = out[out.length - 1];
    if (last && last.src === src && last.d1 >= d0 - 40) last.d1 = d1; else out.push({ src, d0, d1 });
  }
  return out;
}
export function drawSleepDur(el: HTMLElement): Out {
  const N = nightsIn(), M = N.filter(measured);
  if (M.length < 10) return emptyState(el, 'Not enough measured nights in this range.');
  const f = frame(el, 300, { t: 30, r: 54, b: 26, l: 40 });
  const x = d3.scaleLinear(span(N), [0, f.iw]);
  const all = N.filter((n: any) => n.asleep != null);
  const yS = d3.scaleLinear([Math.max(0, Math.min(3, d3.quantile(M.map((n: any) => n.asleep).sort(d3.ascending), 0.01))), Math.min(13, Math.max(10, d3.max(all, (n: any) => n.asleep)))], [f.ih, 0]).nice();
  const cp = clip(f);
  // eras of sources behind everything
  const E = eras(N), palette = [css('--q2'), css('--q4'), css('--q6')];
  const eg = f.g.append('g');
  E.forEach((e: any, i: number) => {
    const a = x(e.d0), b = x(e.d1);
    eg.append('rect').attr('x', Math.max(0, a)).attr('width', Math.max(1, Math.min(f.iw, b) - Math.max(0, a))).attr('y', 0).attr('height', f.ih).style('fill', e.src === 'Time in bed only' ? 'var(--raised)' : palette[i % 3]).style('opacity', e.src === 'Time in bed only' ? 0.8 : 0.06);
    if (b - a > 70) eg.append('text').attr('class', 'annot').attr('x', Math.max(0, a) + 4).attr('y', 11).text(e.src.length * 6 > b - a ? e.src.split(' ')[0] : e.src);
  });
  yGrid(f.g, yS, f.iw, 5, (v: number) => v + ' h');
  yearAxis(f, x, N);
  drawMilestones(f.g, x, f.ih, { labels: true, y0: -14 });
  f.g.append('g').attr('clip-path', cp).selectAll('circle').data(all).join('circle').attr('class', 'a-dot')
    .attr('cx', (n: any) => x(n.d)).attr('cy', (n: any) => yS(Math.max(yS.domain()[0], n.asleep))).attr('r', 1.6)
    .style('fill', (n: any) => n.est ? 'none' : zc('core')).style('stroke', (n: any) => n.est ? 'var(--ink-4)' : 'none').style('stroke-width', 0.8).style('opacity', (n: any) => n.est ? 0.5 : 0.42);
  const roll = rolling(M, (n: any) => n.asleep, 31);
  f.g.append('path').datum(roll).attr('class', 'a-line').attr('d', d3.line().defined(def).x((r: any) => x(r.d)).y((r: any) => yS(r.v)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', 'var(--signal)').style('stroke-width', 2.2);
  const e = lastDef(roll);
  f.g.append('text').attr('class', 'dlabel strong mono').attr('x', x(e.d) + 6).attr('y', yS(e.v) + 4).text(f1(e.v) + ' h');
  const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
  f.svg.on('pointermove', (ev: any) => {
    const [px] = d3.pointer(ev, f.g.node()); const dd = x.invert(px);
    const n: any = d3.least(all, (n: any) => Math.abs(n.d - dd)); const r: any = d3.least(roll.filter(def), (r: any) => Math.abs(r.d - dd));
    if (!n) return; ch.attr('x1', x(n.d)).attr('x2', x(n.d)).style('opacity', 0.6);
    TIP.show(ev, `Night of ${fDate(n.d)}`, [['Asleep', fDur(n.asleep * 60) + (n.est ? ' (estimate)' : '')], ['Month around it', r ? f1(r.v) + ' h, median' : '—'], ['Source', n.source]]);
  }).on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
  f.svg.on('click', (ev: any) => { const [px] = d3.pointer(ev, f.g.node()); const dd = x.invert(px); const n: any = d3.least(N.filter((n: any) => n.asleep != null), (n: any) => Math.abs(n.d - dd)); if (n) openNight(n); });
  armArrival(el);
  const med = median(M, (n: any) => n.asleep);
  const yr = d3.rollups(M, (v: any[]) => d3.median(v, (n: any) => n.asleep), (n: any) => n.y).sort((a: any, b: any) => a[0] - b[0]);
  return {
    sub: ['Hours asleep each night, with the median of the 31 nights around it. Typical night: ', [`${f1(med)} h`], yr.length > 1 ? `; by year from ${f1(yr[0][1])} h (${yr[0][0]}) to ${f1(yr[yr.length - 1][1])} h (${yr[yr.length - 1][0]}).` : '.', ' The bands behind show which source each stretch came from; hollow dots are estimates.'],
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, { k: 'n', label: 'Nights', num: true }, { k: 'm', label: 'Median asleep', num: true }], rows: yr.map(([y, m]: any) => ({ y, n: M.filter((n: any) => n.y === y).length, m: f1(m) + ' h' })) }),
  };
}

// ---------------------------------------------------------------- bedtime and wake time
export function drawSleepClock(el: HTMLElement): Out {
  const N = nightsIn(), M = N.filter(measured);
  if (M.length < 20) return emptyState(el, 'Not enough measured nights in this range.');
  const f = frame(el, 300, { t: 30, r: 70, b: 26, l: 62 });
  const x = d3.scaleLinear(span(M), [0, f.iw]);
  const lo = d3.quantile(M.map((n: any) => n.on).sort(d3.ascending), 0.03), hi = d3.quantile(M.map((n: any) => n.wake).sort(d3.ascending), 0.97);
  const yS = d3.scaleLinear([Math.floor(lo - 0.5), Math.ceil(hi + 0.5)], [0, f.ih]);
  yGrid(f.g, yS, f.iw, 6, (v: number) => clock(v).replace(':00', ''));
  yearAxis(f, x, M);
  const cp = clip(f);
  drawMilestones(f.g, x, f.ih, { labels: true, y0: -14 });
  const series = [{ k: 'on', label: 'Fell asleep', c: zc('deep') }, { k: 'wake', label: 'Woke', c: 'var(--signal)' }];
  const ends: any[] = [];
  for (const s of series) {
    const roll = rolling(M, (n: any) => n[s.k], 61);
    f.g.append('path').datum(roll).attr('clip-path', cp).attr('class', 'a-fade').attr('d', d3.area().defined(def).x((r: any) => x(r.d)).y0((r: any) => yS(r.lo)).y1((r: any) => yS(r.hi)).curve(d3.curveMonotoneX)).style('fill', s.c).style('opacity', 0.13);
    f.g.append('path').datum(roll).attr('clip-path', cp).attr('class', 'a-line').attr('d', d3.line().defined(def).x((r: any) => x(r.d)).y((r: any) => yS(r.v)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', s.c).style('stroke-width', 2.2);
    const e = lastDef(roll);
    f.g.append('text').attr('class', 'dlabel strong mono').attr('x', x(e.d) + 6).attr('y', yS(e.v) + 4).text(clock(e.v));
    ends.push(roll);
  }
  const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
  f.svg.on('pointermove', (ev: any) => {
    const [px] = d3.pointer(ev, f.g.node()); const dd = x.invert(px);
    const a: any = d3.least(ends[0].filter(def), (r: any) => Math.abs(r.d - dd)), b: any = d3.least(ends[1].filter(def), (r: any) => Math.abs(r.d - dd));
    ch.attr('x1', x(a.d)).attr('x2', x(a.d)).style('opacity', 0.6);
    TIP.show(ev, `Around ${fDate(a.d)}`, [['Fell asleep, median', clock(a.v), zc('deep')], ['Middle half', `${clock(a.lo)} to ${clock(a.hi)}`], ['Woke, median', clock(b.v), css('--signal')], ['Middle half', `${clock(b.lo)} to ${clock(b.hi)}`]]);
  }).on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
  armArrival(el);
  // first and last year of measured nights, as the copy's comparison
  const first = M.filter((n: any) => n.d < M[0].d + 365), last = M.filter((n: any) => n.d > M[M.length - 1].d - 365);
  const w0 = median(first, (n: any) => n.wake), w1 = median(last, (n: any) => n.wake), b0 = median(first, (n: any) => n.on), b1 = median(last, (n: any) => n.on);
  const mv = (a: number, b: number) => { const m = Math.round((b - a) * 60); return Math.abs(m) < 10 ? 'barely moved' : `moved ${Math.abs(m)} min ${m < 0 ? 'earlier' : 'later'}`; };
  return {
    sub: ['When you fell asleep and woke, the median of the 61 nights around each date, with the middle half shaded. Comparing your first and last year of measured nights, waking ', [mv(w0, w1)], ` (${clock(w0)} to ${clock(w1)}) and falling asleep ${mv(b0, b1)} (${clock(b0)} to ${clock(b1)}).`],
    legend: { items: series.map(s => ({ label: s.label, c: s.c.startsWith('var') ? css('--signal') : s.c })), kind: 'ln' },
  };
}

// ---------------------------------------------------------------- the week
export function drawSleepWeek(el: HTMLElement): Out {
  const M = nightsIn().filter(measured);
  if (M.length < 28) return emptyState(el, 'Not enough measured nights in this range.');
  // the night of each weekday (Friday night is the one before Saturday)
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const order = [1, 2, 3, 4, 5, 6, 0];
  const rows = order.map(dw => { const v = M.filter((n: any) => n.dow === dw); return { dw, name: names[dw], n: v.length, on: median(v, (n: any) => n.on), wake: median(v, (n: any) => n.wake), asleep: median(v, (n: any) => n.asleep) }; });
  const f = frame(el, 260, { t: 8, r: 70, b: 26, l: 92 });
  const x = d3.scaleLinear([Math.floor(d3.min(rows, (r: any) => r.on) - 0.5), Math.ceil(d3.max(rows, (r: any) => r.wake) + 0.5)], [0, f.iw]);
  const y = d3.scaleBand(rows.map(r => r.name), [0, f.ih]).padding(0.38);
  f.g.append('g').attr('class', 'gridl').call(d3.axisBottom(x).ticks(6).tickSize(f.ih).tickFormat('' as any));
  xAxis(f.g, x, f.ih, { ticks: 6, fmt: (v: number) => clock(v).replace(':00', '') });
  const g = f.g.selectAll('g.r').data(rows).join('g').attr('class', 'r').attr('transform', (r: any) => `translate(0,${y(r.name)})`);
  g.append('text').attr('class', 'dlabel').attr('x', -10).attr('y', y.bandwidth() / 2 + 4).attr('text-anchor', 'end').text((r: any) => `${r.name} night`);
  g.append('rect').attr('class', 'a-hbar').attr('x', (r: any) => x(r.on)).attr('width', (r: any) => x(r.wake) - x(r.on)).attr('y', 0).attr('height', y.bandwidth()).attr('rx', 3)
    .style('fill', (r: any) => r.dw === 5 || r.dw === 6 ? zc('rem') : zc('core')).style('opacity', 0.85);
  g.append('text').attr('class', 'dlabel mono').attr('x', (r: any) => x(r.wake) + 6).attr('y', y.bandwidth() / 2 + 4).style('font-size', '11px').text((r: any) => `${f1(r.asleep)} h`);
  g.on('pointermove', (ev: any, r: any) => TIP.show(ev, `${r.name} nights`, [['Fell asleep', clock(r.on)], ['Woke', clock(r.wake)], ['Asleep', fDur(r.asleep * 60)], ['Nights', fInt(r.n)]])).on('pointerleave', TIP.hide);
  armArrival(el);
  const wk = rows.filter(r => r.dw >= 1 && r.dw <= 4), we = rows.filter(r => r.dw === 5 || r.dw === 6);
  const dOn = Math.round((d3.mean(we, (r: any) => r.on) - d3.mean(wk, (r: any) => r.on)) * 60), dWake = Math.round((d3.mean(we, (r: any) => r.wake) - d3.mean(wk, (r: any) => r.wake)) * 60);
  return { sub: ['Median time asleep, from falling asleep to waking, by the night of the week. Friday and Saturday nights start ', [`${Math.abs(dOn)} min ${dOn >= 0 ? 'later' : 'earlier'}`], ` and end ${Math.abs(dWake)} min ${dWake >= 0 ? 'later' : 'earlier'} than Monday to Thursday nights.`] };
}

// ---------------------------------------------------------------- the year
export function drawSleepMonth(el: HTMLElement): Out {
  const M = nightsIn().filter(measured);
  if (M.length < 60) return emptyState(el, 'Not enough measured nights in this range.');
  const rows = d3.range(12).map((m: number) => { const v = M.filter((n: any) => n.m === m).map((n: any) => n.asleep).sort(d3.ascending); return { m, n: v.length, med: v.length ? d3.quantileSorted(v, 0.5) : null, lo: v.length ? d3.quantileSorted(v, 0.25) : null, hi: v.length ? d3.quantileSorted(v, 0.75) : null }; });
  const has = rows.filter(r => r.med != null);
  const f = frame(el, 260, { t: 12, r: 12, b: 26, l: 40 });
  const x = d3.scaleBand(MONTHS, [0, f.iw]).padding(0.28);
  const yS = d3.scaleLinear([Math.floor(d3.min(has, (r: any) => r.lo) - 0.3), Math.ceil(d3.max(has, (r: any) => r.hi) + 0.3)], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => v + ' h');
  xAxis(f.g, x, f.ih, {});
  const g = f.g.selectAll('g.m').data(has).join('g').attr('class', 'm').attr('transform', (r: any) => `translate(${x(MONTHS[r.m])},0)`);
  g.append('rect').attr('class', 'a-bar').attr('x', 0).attr('width', x.bandwidth()).attr('y', (r: any) => yS(r.hi)).attr('height', (r: any) => Math.max(1, yS(r.lo) - yS(r.hi))).attr('rx', 2).style('fill', zc('core')).style('opacity', 0.35);
  g.append('line').attr('x1', 0).attr('x2', x.bandwidth()).attr('y1', (r: any) => yS(r.med)).attr('y2', (r: any) => yS(r.med)).style('stroke', zc('core')).style('stroke-width', 2.4);
  g.on('pointermove', (ev: any, r: any) => TIP.show(ev, MONTHS[r.m], [['Median asleep', fDur(r.med * 60)], ['Middle half', `${f1(r.lo)} to ${f1(r.hi)} h`], ['Nights', fInt(r.n)]])).on('pointerleave', TIP.hide);
  armArrival(el);
  const best = d3.greatest(has, (r: any) => r.med), worst = d3.least(has, (r: any) => r.med);
  return { sub: ['Every year folded onto one: the median night of each month, with the middle half as a bar. Longest in ', [MONTHS[best.m]], ` (${f1(best.med)} h), shortest in ${MONTHS[worst.m]} (${f1(worst.med)} h).`] };
}

// ---------------------------------------------------------------- stages
const STG = [{ k: 'deep', code: 4, label: 'Deep' }, { k: 'core', code: 3, label: 'Core' }, { k: 'rem', code: 5, label: 'REM' }, { k: 'awake', code: 6, label: 'Awake' }];
export function drawStageTrend(el: HTMLElement): Out {
  const N = nightsIn().filter((n: any) => n.cls === 'stages' && measured(n));
  if (N.length < 20) return emptyState(el, 'Sleep stages start with watchOS 9 (autumn 2022) on an Apple Watch; there are not enough staged nights in this range.');
  const f = frame(el, 280, { t: 30, r: 64, b: 26, l: 40 });
  const x = d3.scaleLinear(span(N), [0, f.iw]);
  const win = 21;
  const sm = N.map((n: any, i: number) => { const a = N.slice(Math.max(0, i - (win >> 1)), i + (win >> 1) + 1); const o: any = { d: n.d }; for (const s of STG) o[s.k] = d3.mean(a, (z: any) => z[s.k]) / 60; return o; });
  const stack = d3.stack().keys(STG.map(s => s.k))(sm);
  const yS = d3.scaleLinear([0, d3.max(stack[stack.length - 1], (p: any) => p[1]) * 1.05], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 5, (v: number) => v + ' h');
  yearAxis(f, x, N);
  drawMilestones(f.g, x, f.ih, { labels: true, y0: -14 });
  f.g.selectAll('path.st').data(stack).join('path').attr('class', 'st a-fade').attr('d', d3.area().x((p: any) => x(p.data.d)).y0((p: any) => yS(p[0])).y1((p: any) => yS(p[1])).curve(d3.curveMonotoneX))
    .style('fill', (s: any) => zc(s.key)).style('opacity', 0.88);
  const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-1)').style('opacity', 0);
  f.svg.on('pointermove', (ev: any) => {
    const [px] = d3.pointer(ev, f.g.node()); const dd = x.invert(px); const o: any = d3.least(sm, (o: any) => Math.abs(o.d - dd));
    ch.attr('x1', x(o.d)).attr('x2', x(o.d)).style('opacity', 0.5);
    TIP.show(ev, `Around ${fDate(o.d)}`, STG.slice().reverse().map(s => [s.label, fDur(o[s.k] * 60), zc(s.k)]));
  }).on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
  armArrival(el);
  const tot = d3.sum(N, (n: any) => n.deep + n.core + n.rem);
  const pc = (k: string) => Math.round(d3.sum(N, (n: any) => n[k]) / tot * 100);
  return {
    sub: ['Time in each stage per night, averaged over the 21 nights around each date. Of the time asleep: ', [`${pc('deep')}% deep, ${pc('core')}% core, ${pc('rem')}% REM`], `; about ${Math.round(d3.median(N, (n: any) => n.awake))} min awake in a typical night.`],
    legend: { items: STG.map(s => ({ label: s.label, c: zc(s.k) })) },
  };
}

// the average night: of the nights still asleep at each point after falling asleep, the share in each stage
export function drawTypicalNight(el: HTMLElement): Out {
  const N = nightsIn().filter((n: any) => n.cls === 'stages' && measured(n));
  if (N.length < 20) return emptyState(el, 'Not enough staged nights in this range.');
  const bin = 10, nb = 9 * 60 / bin;
  const cnt = STG.map(() => new Float64Array(nb)), tot = new Float64Array(nb);
  for (const n of N) {
    const on = (n.on - 18) * 60, end = (n.wake - 18) * 60;
    for (const [st, mins, code] of runsOf(n)) {
      const si = STG.findIndex(s => s.code === code); if (si < 0) continue;
      for (let t = Math.max(st, on); t < Math.min(st + mins, end); t++) { const b = Math.floor((t - on) / bin); if (b >= 0 && b < nb) { cnt[si][b]++; tot[b]++; } }
    }
  }
  const rows = d3.range(nb).filter((b: number) => tot[b] > N.length * bin * 0.25).map((b: number) => { const o: any = { h: (b + 0.5) * bin / 60 }; STG.forEach((s, i) => (o[s.k] = cnt[i][b] / tot[b])); return o; });
  const f = frame(el, 260, { t: 10, r: 14, b: 30, l: 40 });
  const x = d3.scaleLinear([0, d3.max(rows, (r: any) => r.h) + bin / 120], [0, f.iw]);
  const yS = d3.scaleLinear([0, 1], [f.ih, 0]);
  const stack = d3.stack().keys(STG.map(s => s.k))(rows);
  yGrid(f.g, yS, f.iw, 4, d3.format('.0%'));
  xAxis(f.g, x, f.ih, { ticks: 9, fmt: (v: number) => `${v}h` });
  f.g.append('text').attr('class', 'alabel').attr('x', f.iw).attr('y', f.ih + 28).attr('text-anchor', 'end').text('hours after falling asleep');
  f.g.selectAll('path.st').data(stack).join('path').attr('class', 'st a-fade').attr('d', d3.area().x((p: any) => x(p.data.h)).y0((p: any) => yS(p[0])).y1((p: any) => yS(p[1])).curve(d3.curveBasis))
    .style('fill', (s: any) => zc(s.key)).style('opacity', 0.9);
  f.svg.on('pointermove', (ev: any) => { const [px] = d3.pointer(ev, f.g.node()); const o: any = d3.least(rows, (o: any) => Math.abs(o.h - x.invert(px))); if (o) TIP.show(ev, `${f1(o.h)} h after falling asleep`, STG.slice().reverse().map(s => [s.label, d3.format('.0%')(o[s.k]), zc(s.k)])); }).on('pointerleave', TIP.hide);
  armArrival(el);
  const early = rows.filter((r: any) => r.h < 2), late = rows.filter((r: any) => r.h > 5);
  return { sub: ['Every staged night lined up at the moment you fell asleep. Deep sleep is ', [`${Math.round(d3.mean(early, (r: any) => r.deep) * 100)}% of the first two hours`], ` and ${Math.round(d3.mean(late, (r: any) => r.deep) * 100)}% after five; REM goes from ${Math.round(d3.mean(early, (r: any) => r.rem) * 100)}% to ${Math.round(d3.mean(late, (r: any) => r.rem) * 100)}%.`] };
}

// ---------------------------------------------------------------- one night
export function drawHypno(el: HTMLElement, n: any): Out {
  if (!n) return emptyState(el, 'Pick a night.');
  const runs = runsOf(n);
  if (!runs.length) return emptyState(el, 'No timeline for this night.');
  const f = frame(el, 250, { t: 14, r: 16, b: 28, l: 64 });
  const t0 = 18 + runs[0][0] / 60, t1 = 18 + (runs[runs.length - 1][0] + runs[runs.length - 1][1]) / 60;
  const x = d3.scaleLinear([Math.floor((t0 - 0.25) * 2) / 2, Math.ceil((t1 + 0.25) * 2) / 2], [0, f.iw]);
  const lv = [{ code: 6, label: 'Awake' }, { code: 5, label: 'REM' }, { code: 3, label: 'Core' }, { code: 4, label: 'Deep' }];
  const y = d3.scaleBand(lv.map(l => l.label), [0, f.ih]).padding(0.18);
  const lvl = (code: number) => code === 2 ? 'Core' : code === 1 ? null : STAGES[code].label;
  f.g.append('rect').attr('x', 0).attr('y', 0).attr('width', f.iw).attr('height', f.ih).style('fill', 'var(--map-bg)').attr('rx', 4);
  f.g.append('g').attr('class', 'gridl').call(d3.axisBottom(x).ticks(8).tickSize(f.ih).tickFormat('' as any));
  xAxis(f.g, x, f.ih, { ticks: 8, fmt: (v: number) => clock(v).replace(':00', '') });
  f.g.selectAll('text.lv').data(lv).join('text').attr('class', 'dlabel').attr('x', -10).attr('y', (l: any) => y(l.label) + y.bandwidth() / 2 + 4).attr('text-anchor', 'end').text((l: any) => l.label);
  // time in bed without sleep as a faint band, then each stage run as a block at its level
  for (const [st, mins, code] of runs) {
    const a = x(18 + st / 60), b = x(18 + (st + mins) / 60);
    if (code === 1) { f.g.append('rect').attr('x', a).attr('width', Math.max(1, b - a)).attr('y', 0).attr('height', f.ih).style('fill', NIGHT_C[1]).style('opacity', 0.35); continue; }
    const L = lvl(code)!;
    f.g.append('rect').attr('class', 'a-fade').attr('x', a).attr('width', Math.max(1, b - a)).attr('y', y(L)).attr('height', y.bandwidth()).attr('rx', 1.5).style('fill', NIGHT_C[code]).style('opacity', n.est ? 0.5 : 1)
      .on('pointermove', (ev: any) => TIP.show(ev, STAGES[code].label + (code === 2 ? ' (no stages recorded)' : ''), [['From', clock(18 + st / 60)], ['For', fDur(mins)]])).on('pointerleave', TIP.hide);
  }
  armArrival(el);
  return {};
}
export function nightStats(n: any): [string, string][] {
  if (!n) return [];
  const out: [string, string][] = [];
  if (n.asleep != null) {
    out.push(['Asleep', fDur(n.asleep * 60) + (n.est ? ' *' : '')], ['Fell asleep', clock(n.on)], ['Woke', clock(n.wake)], ['Awake in the night', n.awake != null ? fDur(n.awake) : '—']);
    if (n.cls === 'stages') out.push(['Deep', fDur(n.deep)], ['REM', fDur(n.rem)], ['Core', fDur(n.core)], ['Woke up', n.wakes != null ? `${n.wakes} times` : '—']);
  } else out.push(['In bed', `${clock(n.bed)} to ${clock(n.up)}`], ['Asleep', 'not measured']);
  if (n.hr != null) out.push(['Lowest heart rate', `${Math.round(n.hr)} bpm`]);
  if (n.hrv != null) out.push(['HRV', `${Math.round(n.hrv)} ms`]);
  if (n.resp != null) out.push(['Breathing', `${f1(n.resp)} /min`]);
  if (n.spo2 != null) out.push(['Blood oxygen', `${Math.round(n.spo2)}%${n.spo2Min != null ? `, low ${Math.round(n.spo2Min)}%` : ''}`]);
  if (n.tempDev != null) out.push(['Wrist temperature', `${n.tempDev >= 0 ? '+' : '−'}${f1(Math.abs(n.tempDev))}°F`]);
  if (n.bdist != null) out.push(['Breathing disturbances', `${f1(n.bdist)} /h`]);
  return out;
}

// ---------------------------------------------------------------- overnight vitals
function band(el: HTMLElement, N: any[], get: (n: any) => number | null, opts: any) {
  const f = frame(el, opts.h || 200, { t: 22, r: 56, b: 24, l: 44 });
  const pts = N.filter(n => get(n) != null);
  const x = d3.scaleLinear(opts.dom || span(N), [0, f.iw]);
  if (pts.length < 10) { f.g.append('text').attr('class', 'annot').attr('x', f.iw / 2).attr('y', f.ih / 2).attr('text-anchor', 'middle').text('not recorded in this range'); return null; }
  const roll = rolling(pts, get, opts.win || 31, opts.mean !== false);
  const vals = pts.map(get).sort(d3.ascending) as number[];
  const yS = d3.scaleLinear([d3.quantileSorted(vals, 0.01), d3.quantileSorted(vals, 0.99)], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, opts.fmt || ((v: number) => v));
  yearAxis(f, x, N);
  const cp = clip(f);
  if (pts[0].d - N[0].d > 60) {
    f.g.append('rect').attr('x', 0).attr('width', x(pts[0].d - 10)).attr('y', 0).attr('height', f.ih).style('fill', 'var(--raised)').style('opacity', 0.7);
    if (x(pts[0].d - 10) > 110) f.g.append('text').attr('class', 'annot').attr('x', x(pts[0].d - 10) / 2).attr('y', f.ih / 2 + 4).attr('text-anchor', 'middle').text('not recorded yet');
  }
  (opts.under || (() => {}))(f, x, yS);
  drawMilestones(f.g, x, f.ih, { y0: -10 });
  f.g.append('g').attr('clip-path', cp).selectAll('circle').data(pts).join('circle').attr('class', 'a-dot').attr('cx', (n: any) => x(n.d)).attr('cy', (n: any) => yS(get(n))).attr('r', 1.4).style('fill', opts.color).style('opacity', 0.28);
  f.g.append('path').datum(roll).attr('clip-path', cp).attr('class', 'a-line').attr('d', d3.line().defined(def).x((r: any) => x(r.d)).y((r: any) => yS(r.v)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', opts.color).style('stroke-width', 2.2);
  const e = lastDef(roll);
  f.g.append('text').attr('class', 'dlabel strong mono').attr('x', x(e.d) + 6).attr('y', yS(e.v) + 4).text((opts.fmtEnd || f1)(e.v));
  f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -8).text(opts.label);
  f.svg.on('pointermove', (ev: any) => { const [px] = d3.pointer(ev, f.g.node()); const dd = x.invert(px); const n: any = d3.least(pts, (n: any) => Math.abs(n.d - dd)); const r: any = d3.least(roll.filter(def), (r: any) => Math.abs(r.d - dd)); if (n) TIP.show(ev, `Night of ${fDate(n.d)}`, [[opts.label, (opts.fmtEnd || f1)(get(n)!)], ['Month around it', (opts.fmtEnd || f1)(r.v)]]); }).on('pointerleave', TIP.hide);
  armArrival(el);
  return { pts, roll, f, x, yS };
}
export function drawTempDev(el: HTMLElement): Out {
  const N = nightsIn(), pts = N.filter((n: any) => n.tempDev != null);
  if (pts.length < 20) return emptyState(el, 'Wrist temperature during sleep comes from an Apple Watch Series 8, Ultra or later (watchOS 9); not recorded in this range.');
  const f = frame(el, 220, { t: 22, r: 56, b: 24, l: 48 });
  const x = d3.scaleLinear(span(pts), [0, f.iw]);
  const m = d3.max(pts, (n: any) => Math.abs(n.tempDev)), lim = Math.max(1, Math.ceil(d3.quantile(pts.map((n: any) => Math.abs(n.tempDev)).sort(d3.ascending), 0.995) * 2) / 2);
  const yS = d3.scaleLinear([-lim, lim], [f.ih, 0]);
  yGrid(f.g, yS, f.iw, 4, (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}°F`);
  yearAxis(f, x, pts);
  drawMilestones(f.g, x, f.ih, { labels: true, y0: -10 });
  const bw = Math.max(1, f.iw / Math.max(1, pts[pts.length - 1].d - pts[0].d + 1) * 0.8);
  f.g.append('g').selectAll('rect').data(pts).join('rect').attr('class', 'a-bar').attr('x', (n: any) => x(n.d) - bw / 2).attr('width', bw)
    .attr('y', (n: any) => yS(Math.max(0, Math.min(lim, n.tempDev)))).attr('height', (n: any) => Math.abs(yS(Math.max(-lim, Math.min(lim, n.tempDev))) - yS(0)))
    .style('fill', (n: any) => n.tempDev >= 0 ? 'var(--hot)' : 'var(--cold)').style('opacity', 0.7);
  f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', yS(0)).attr('y2', yS(0)).style('stroke', 'var(--ink-3)');
  f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -8).text('Wrist temperature, change from your 30-night baseline');
  f.svg.on('pointermove', (ev: any) => { const [px] = d3.pointer(ev, f.g.node()); const n: any = d3.least(pts, (n: any) => Math.abs(n.d - x.invert(px))); if (n) TIP.show(ev, `Night of ${fDate(n.d)}`, [['Change', `${n.tempDev >= 0 ? '+' : '−'}${f1(Math.abs(n.tempDev))}°F`], ['Wrist', `${f1(n.temp)}°F`]]); }).on('pointerleave', TIP.hide);
  armArrival(el);
  const big = pts.filter((n: any) => Math.abs(n.tempDev) >= 1).length;
  void m;
  return { sub: ['Each night against the median of the 30 nights before it, as the watch reports it. ', [`${fInt(big)} of ${fInt(pts.length)} nights`], ' were 1°F or more from baseline. Illness, alcohol, a warm room and travel all move it; the chart only shows when, not why.'] };
}
export function drawSleepVitals(el: HTMLElement): Out {
  el.replaceChildren();
  const N = nightsIn();
  if (!N.some((n: any) => n.hr != null || n.resp != null)) return emptyState(el, 'Overnight vitals come from an Apple Watch worn to bed; not recorded in this range.');
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px 18px'; el.appendChild(wrap);
  const defs: any[] = [
    [(n: any) => n.hr, 'Lowest heart rate asleep, bpm', css('--s8'), (v: number) => Math.round(v) + ' bpm'],
    [(n: any) => n.hrv, 'Heart-rate variability asleep, ms', css('--s3'), (v: number) => Math.round(v) + ' ms'],
    [(n: any) => n.resp, 'Breathing rate asleep, per minute', css('--s1'), (v: number) => f1(v)],
    [(n: any) => n.spo2, 'Blood oxygen asleep, %', css('--s7'), (v: number) => Math.round(v) + '%'],
  ];
  const holders = defs.map(() => { const d = document.createElement('div'); d.style.minWidth = '0'; wrap.appendChild(d); return d; });
  const res = defs.map(([get, label, color, fe], i) => band(holders[i], N, get, { label, color, fmtEnd: fe, h: 200 }));
  const a0 = (r: any) => r && r.roll.find(def), a1 = (r: any) => r && lastDef(r.roll);
  const parts: any[] = ['Each line is the average of the 31 nights around each date, measured only while asleep. '];
  if (res[0]) parts.push('Lowest heart rate ', [`${Math.round(a0(res[0]).v)} → ${Math.round(a1(res[0]).v)} bpm`], ', ');
  if (res[1]) parts.push('HRV ', [`${Math.round(a0(res[1]).v)} → ${Math.round(a1(res[1]).v)} ms`], '. ');
  return { sub: parts };
}
export function drawBreathing(el: HTMLElement): Out {
  const N = nightsIn();
  const pts = N.filter((n: any) => n.bdist != null);
  if (pts.length < 20) return emptyState(el, 'Breathing disturbances come from an Apple Watch with sleep apnea notifications (watchOS 11, autumn 2024); not recorded in this range.');
  const W = (G.sleep?.apnea ?? []) as any[];
  const r = band(el, pts, (n: any) => n.bdist, { mean: false,
    label: 'Breathing disturbances per hour asleep', color: css('--s4'), fmtEnd: (v: number) => f1(v), h: 230, dom: span(pts),
    under: (f: any, x: any) => {
      for (const w of W) { const a = Math.max(0, x(w.d)), b = Math.min(f.iw, x(w.d2)); if (b <= a) continue;
        f.g.append('rect').attr('x', a).attr('width', b - a).attr('y', 0).attr('height', f.ih).style('fill', 'var(--warning)').style('opacity', 0.12); }
    },
  });
  if (!r) return;
  const inW = W.filter(w => w.d2 >= pts[0].d && w.d <= pts[pts.length - 1].d).length;
  return {
    sub: (inW ? ['The watch counts brief interruptions to breathing each night (the line is the median of the 31 nights around each date). ', [`${inW} sleep apnea notification${inW > 1 ? 's' : ''}`],
      ' are shaded: the watch flags 30-day stretches where these stay elevated. It is a screening signal, not a diagnosis; a doctor and a sleep study are how it is confirmed.']
      : ['The watch counts brief interruptions to breathing each night (the median of 31 nights is the line). No sleep apnea notifications in this range.']) as any,
    legend: inW ? { items: [{ label: 'Sleep apnea notification (30 days)', c: css('--warning') }] } : undefined,
  };
}

// ---------------------------------------------------------------- records
export function sleepRecords(): any[] {
  const N = nightsIn(), M = N.filter(measured), full = M.filter((n: any) => n.asleep >= 4);
  if (!M.length) return [];
  const R: any[] = [];
  const add = (group: string, label: string, n: any, val: string, det?: string) => n && R.push({ group, label, n, val, det: det ?? `Night of ${fDate(n.d)}` });
  add('Length', 'Longest night', d3.greatest(M, (n: any) => n.asleep), '');
  add('Length', 'Shortest full night', d3.least(full, (n: any) => n.asleep), '');
  add('Length', 'Longest nap', d3.greatest(N.filter((n: any) => n.napMin > 0 && !n.est), (n: any) => n.napMin), '');
  add('Clock', 'Earliest asleep', d3.least(M, (n: any) => n.on), '');
  add('Clock', 'Latest asleep', d3.greatest(M, (n: any) => n.on), '');
  add('Clock', 'Earliest wake', d3.least(full, (n: any) => n.wake), '');
  add('Clock', 'Latest wake', d3.greatest(M, (n: any) => n.wake), '');
  const S2 = M.filter((n: any) => n.cls === 'stages');
  add('Stages', 'Most deep sleep', d3.greatest(S2, (n: any) => n.deep), '');
  add('Stages', 'Most REM', d3.greatest(S2, (n: any) => n.rem), '');
  add('Stages', 'Least time awake', d3.least(S2.filter((n: any) => n.asleep >= 6), (n: any) => n.awake), '');
  for (const r of R) {
    const n = r.n;
    r.val = r.label.includes('nap') ? fDur(n.napMin) : r.label.includes('Deep') || r.label.includes('deep') ? fDur(n.deep) : r.label.includes('REM') ? fDur(n.rem) : r.label.includes('awake') ? fDur(n.awake)
      : r.label.includes('asleep') ? clock(n.on) : r.label.includes('wake') ? clock(n.wake) : fDur(n.asleep * 60);
  }
  // runs of consecutive nights
  const runOf = (ok: (n: any) => boolean) => { let best = { len: 0, end: null as any }, cur = 0, prev: any = null;
    for (const n of M) { cur = ok(n) && prev && n.d === prev.d + 1 ? cur + 1 : ok(n) ? 1 : 0; if (cur > best.len) best = { len: cur, end: n }; prev = n; } return best; };
  const s7 = runOf((n: any) => n.asleep >= 7);
  if (s7.len > 1) R.push({ group: 'Streaks', label: 'Most nights in a row of 7 h or more', n: s7.end, val: `${s7.len} nights`, det: `ending ${fDate(s7.end.d)}` });
  // the most regular week: the smallest spread in bedtime over 7 measured nights in a row
  let bestSd = Infinity, bestEnd: any = null;
  for (let i = 6; i < M.length; i++) { if (M[i].d - M[i - 6].d !== 6) continue; const sd = d3.deviation(M.slice(i - 6, i + 1), (n: any) => n.on); if (sd < bestSd) { bestSd = sd; bestEnd = M[i]; } }
  if (bestEnd) R.push({ group: 'Streaks', label: 'Most regular week', n: bestEnd, val: `±${Math.round(bestSd * 60)} min`, det: `bedtime spread, week ending ${fDate(bestEnd.d)}` });
  return R;
}

// ---------------------------------------------------------------- sources
export function drawSleepSources(el: HTMLElement): Out {
  const N = nightsIn();
  if (!N.length) return emptyState(el, 'No sleep records in this range.');
  const key = (n: any) => n.est ? `${n.source} (estimate)` : n.cls === 'inbed' ? `${n.source} (in bed only)` : n.source;
  const keys = [...new Set(N.map(key))] as string[];
  const years = d3.range(N[0].y, N[N.length - 1].y + 1);
  const rows = years.map((y: number) => { const o: any = { y }; for (const k of keys) o[k] = N.filter((n: any) => n.y === y && key(n) === k).length; return o; });
  const f = frame(el, 250, { t: 10, r: 12, b: 26, l: 40 });
  const x = d3.scaleBand(years.map(String), [0, f.iw]).padding(0.25);
  const stack = d3.stack().keys(keys)(rows);
  const yS = d3.scaleLinear([0, 366], [f.ih, 0]);
  const fixed: Record<string, string> = { 'Apple Watch': css('--s1'), 'Garmin Connect': css('--s3'), AutoSleep: css('--s4') };
  const others = [css('--s7'), css('--s5'), css('--s2'), css('--q5'), css('--s8')];
  const pal = (k: string) => fixed[k] ?? others[[...new Set(keys.map(x => x.replace(/ \(.*\)$/, '')))].filter(x => !fixed[x]).indexOf(k) % others.length];
  const col = (k: string) => k.includes('in bed only') ? 'var(--chip)' : pal(k.replace(/ \(.*\)$/, ''));
  yGrid(f.g, yS, f.iw, 4, (v: number) => v);
  xAxis(f.g, x, f.ih, { fmt: (v: string) => years.length > 9 ? `'${v.slice(2)}` : v });
  f.g.selectAll('g.s').data(stack).join('g').attr('class', 's').style('fill', (s: any) => col(s.key)).style('opacity', (s: any) => s.key.includes('estimate') ? 0.5 : 0.9)
    .selectAll('rect').data((s: any) => s.map((p: any) => ({ p, k: s.key }))).join('rect').attr('class', 'a-bar')
    .attr('x', (o: any) => x(String(o.p.data.y))).attr('width', x.bandwidth()).attr('y', (o: any) => yS(o.p[1])).attr('height', (o: any) => Math.max(0, yS(o.p[0]) - yS(o.p[1])))
    .on('pointermove', (ev: any, o: any) => TIP.show(ev, `${o.p.data.y}`, [[o.k, `${o.p.data[o.k]} nights`, col(o.k)]])).on('pointerleave', TIP.hide);
  armArrival(el);
  const multi = N.filter((n: any) => n.nsrc > 1).length, est = N.filter((n: any) => n.est).length, ib = N.filter((n: any) => n.cls === 'inbed').length;
  const rules = (G.health?.rules ?? []) as any[];
  const z4 = rules.find(r => r.id === 'Z4')?.n ?? 0;
  return {
    sub: ['Nights per year by the source kept for it. ', [`${fInt(multi)} nights`], ` had more than one source; each night keeps one (stages, then asleep time, then time in bed; the watch first), never a sum. ${ib ? `${fInt(ib)} nights have time in bed only (a phone's bedtime schedule): shown, but asleep is not measured. ` : ''}${est ? `${fInt(est)} nights are estimates from a source that records almost no time awake. ` : ''}${z4 ? `${fInt(z4)} nights had records written in local time as UTC, moved back by the time-zone offset.` : ''}`],
    legend: { items: keys.map(k => ({ label: k, c: col(k) })) },
  };
}

