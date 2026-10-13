// Port of mockup/src/app-health.js, fed by cleaning_log: rule counts, a real route raw vs cleaned, a real dedupe day.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { G } from '../store';
import { Out, TIP, armArrival, css, emptyState, f1, fClock, fHourShort, fInt, fPct, frame, xAxis } from '../core';

export function drawRules(el: HTMLElement): Out {
  const H = G.health; if (!H) return emptyState(el, 'No cleaning log.');
  const R = H.rules.slice().sort((a: any, b: any) => b.n - a.n);
  const f = frame(el, 34 + R.length * 40, { t: 4, r: 96, b: 6, l: 4 });
  const x = d3.scaleSqrt([0, d3.max(R, (o: any) => o.n)!], [0, f.iw]);
  const y = d3.scaleBand(R.map((o: any) => o.id), [0, f.ih]).padding(0.18);
  const g = f.g.selectAll('g.r').data(R).join('g').attr('class', 'r').attr('transform', (o: any) => `translate(0,${y(o.id)})`);
  g.append('text').attr('class', 'dlabel').attr('x', 0).attr('y', 11).text((o: any) => `${o.id} · ${o.name}`);
  g.append('rect').attr('class', 'a-hbar').attr('x', 0).attr('y', 17).attr('height', 9).attr('rx', 2).attr('width', (o: any) => Math.max(3, x(o.n))).style('fill', 'var(--s1)');
  g.append('text').attr('class', 'dlabel mono').attr('x', (o: any) => Math.max(3, x(o.n)) + 8).attr('y', 26).style('font-size', '11px').text((o: any) => `${fInt(o.n)} ${o.unit}`);
  g.append('rect').attr('x', 0).attr('y', 0).attr('width', f.w).attr('height', y.bandwidth()).style('fill', 'transparent').on('pointermove', (e: any, o: any) => TIP.show(e, `${o.id} · ${o.name}`, [['Count', `${fInt(o.n)} ${o.unit}`], ['Rule', o.why]])).on('pointerleave', TIP.hide);
  armArrival(el);
  return { sub: ['Square-root scale so the rare fixes stay visible. ', [`All ${fInt(H.log_rows)} fixes are logged`], ', so any number on this page can be traced back to raw records. Hover a rule for its definition.'] };
}

export const TRACK = { mode: 'both', which: 0 };
export function drawTrack(cv: HTMLCanvasElement): Out {
  const H = G.health; const T = H?.tracks?.[TRACK.which]; if (!T) return;
  const box = cv.parentElement!.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1);
  const W = box.width, Hh = box.height; cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
  const c = cv.getContext('2d')!; c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = css('--map-bg'); c.fillRect(0, 0, W, Hh);
  const raw = T.raw, clean = T.clean;
  const all = TRACK.mode === 'clean' ? clean : raw.concat(clean);
  const [x0, x1] = d3.extent(all, (q: any) => q[0]) as [number, number], [y0, y1] = d3.extent(all, (q: any) => q[1]) as [number, number];
  const k = Math.min((W - 50) / Math.max(10, x1 - x0), (Hh - 50) / Math.max(10, y1 - y0)); const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const P = (q: number[]) => [W / 2 + (q[0] - mx) * k, Hh / 2 - (q[1] - my) * k];
  c.lineJoin = 'round'; c.lineCap = 'round';
  const stroke = (arr: any[], col: string, lw: number, breakOn3 = false) => { c.beginPath(); arr.forEach((q, i) => { const [X, Y] = P(q); (i && !(breakOn3 && q[2] === 3)) ? c.lineTo(X, Y) : c.moveTo(X, Y); }); c.strokeStyle = col; c.lineWidth = lw; c.stroke(); };
  if (TRACK.mode !== 'clean') { stroke(raw, 'rgba(230,103,103,.85)', 1.6); for (const q of T.dropped) { const [X, Y] = P(q); c.beginPath(); c.arc(X, Y, 5, 0, 7); c.strokeStyle = '#e66767'; c.lineWidth = 2; c.stroke(); } }
  if (TRACK.mode !== 'raw') stroke(clean, '#ff8f4a', 3, true);
  c.font = '600 12px "Overpass Variable", Overpass, sans-serif'; c.fillStyle = 'rgba(238,242,247,.92)';
  if (TRACK.mode !== 'clean' && T.max_mph) { const [tx, ty] = P(raw[raw.length - 1]); c.textAlign = 'right'; c.fillText(`driven at up to ${Math.round(T.max_mph)} mph`, Math.max(160, tx - 4), Math.max(16, ty - 10)); c.textAlign = 'left'; }
  if (TRACK.mode !== 'clean' && T.dropped.length) { const [qx, qy] = P(T.dropped[0]); c.fillText('spike', qx + 8, qy + 4); }
  c.font = '11px "Overpass Mono Variable", monospace'; c.fillStyle = 'rgba(151,165,187,.9)'; c.fillText('the area around home is hidden', 12, Hh - 12);
  const mi = (m: number) => m / 1609.344;
  return { sub: [`${T.type === 'walk' ? 'A walk' : 'A ' + T.type} on ${T.date}: ${T.note}. Raw GPX `, [`${f1(mi(T.raw_m))} mi`], '; cleaned GPS ', [`${f1(mi(T.gps_m))} mi`], `; the watch reported ${f1(mi(T.watch_m ?? 0))} mi and the headline is ${f1(mi(T.headline_m))} mi.`] };
}

export function drawDedupe(el: HTMLElement): Out {
  const D = G.health?.dedupe; if (!D) return emptyState(el, 'No example day.');
  const f = frame(el, 200, { t: 22, r: 150, b: 26, l: 90 });
  const all = [...D.watch, ...D.phone].map((p: any) => p[0]);
  const lo = Math.max(0, Math.floor((d3.min(all) ?? 6) - 0.5)), hi = Math.min(24, Math.ceil((d3.max(all) ?? 22) + 0.5));
  const x = d3.scaleLinear([lo, hi], [0, f.iw]);
  const rows = ['Apple Watch', 'iPhone', 'Merged'];
  const y = d3.scaleBand(rows, [0, f.ih]).padding(0.28);
  const cW = css('--s1'), cP = css('--s3'), cM = css('--signal');
  f.g.append('g').attr('class', 'gridl').attr('transform', `translate(0,${f.ih})`).call(d3.axisBottom(x).tickValues(d3.range(Math.ceil(lo / 2) * 2, hi + 1, 2)).tickSize(-f.ih).tickFormat('' as any));
  xAxis(f.g, x, f.ih, { values: d3.range(Math.ceil(lo / 2) * 2, hi + 1, 2), fmt: fHourShort }).select('.domain').remove();
  const wpm = 1 / 60 * f.iw / (hi - lo);
  const draw = (arr: any[], row: string, col: string) => f.g.append('g').selectAll('rect').data(arr).join('rect').attr('class', 'a-hbar').attr('x', (d: any) => x(d[0])).attr('width', Math.max(0.8, wpm)).attr('y', y(row)!).attr('height', y.bandwidth()).style('fill', col).style('opacity', (d: any) => .35 + .65 * Math.min(1, d[1] / 110))
    .on('pointermove', (e: any, d: any) => TIP.show(e, row, [['Minute', fClock(d[0])], ['Steps', f1(d[1])]])).on('pointerleave', TIP.hide);
  draw(D.watch, 'Apple Watch', cW); draw(D.phone, 'iPhone', cP); draw(D.chosen, 'Merged', cM);
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(y).tickSize(0).tickPadding(10));
  const tw = d3.sum(D.watch, (d: any) => d[1]), tp = d3.sum(D.phone, (d: any) => d[1]), tm = d3.sum(D.chosen, (d: any) => d[1]);
  [['Apple Watch', tw], ['iPhone', tp], ['Merged', tm]].forEach(([r, v]: any) => f.g.append('text').attr('class', 'dlabel mono' + (r === 'Merged' ? ' strong' : '')).attr('x', f.iw + 12).attr('y', y(r)! + y.bandwidth() / 2 + 4).text(`${fInt(v)} steps`));
  armArrival(el);
  const dt = new Date(D.date + 'T12:00:00Z');
  return { sub: [`${dt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}, a real day. Adding both devices gives `, [`${fInt(tw + tp)} steps`], '; the deduplicated total is ', [fInt(tm)], `. Across ${fInt(G.health.days_both)} days with both devices, the naive sum runs ${fPct(G.health.overstate)} high. Each sliver is one minute.`] };
}
