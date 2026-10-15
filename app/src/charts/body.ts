// Heart and movement: cardio recovery after workouts, weekly walking steadiness and stair speed
// (pipeline/stride/export.py export_body). The chapter's charts share one time axis, from the first of these values
// in the filter to its last day, so a metric that starts later reads as "not recorded yet", never as zero.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, S } from '../store';
import { Out, TIP, armArrival, css, dayDate, emptyState, f1, fDate, fInt, frame, rollingMedian, typeColor, typeLabel, xAxis, yGrid, yearTicks } from '../core';
import { drawMilestones } from '../milestones';
import { openCloseup } from './closeup';
import { bandChart, monthlyBand } from './effort';

const FT = 3.28084;
const rollingMean = (v: number[], win: number) => v.map((_, i) => d3.mean(v.slice(Math.max(0, i - (win >> 1)), i + (win >> 1) + 1)) as number);
const inYears = (r: any) => r.y >= S.y0 && r.y <= S.y1;
const hrrIn = () => (G.body?.hrr ?? []).filter((r: any) => inYears(r) && (!r.type || S.types.has(r.type)));
// the shared axis: from the first heart or movement value in range to the last day in the filter
function bodyDom(): [number, number] | null {
  const B = G.body;
  if (!B || !F.days.length) return null;
  const first = d3.min([B.hrr, B.steady, B.up, B.down].map((a: any[]) => a.find(inYears)?.d).filter((d: any) => d != null));
  return first == null ? null : [first - 20, F.days[F.days.length - 1].d];
}
const ticks = (dom: [number, number], iw: number) => {
  const t = yearTicks(F.years, F.days[0].d).filter((v: number) => v >= dom[0] && v <= dom[1]);
  const narrow = iw / Math.max(1, t.length) < 46;
  return { values: t, fmt: (v: number) => narrow ? `'${String(dayDate(v).getUTCFullYear()).slice(2)}` : dayDate(v).getUTCFullYear() };
};

export function drawHrr(el: HTMLElement): Out {
  const pts = hrrIn(), dom = bodyDom();
  if (pts.length < 10 || !dom) return emptyState(el, 'Cardio recovery comes from an Apple Watch on watchOS 9 or later: one value a minute after each workout. Not recorded in this range.');
  const f = frame(el, 290, { t: 22, r: 56, b: 24, l: 44 });
  const x = d3.scaleLinear(dom, [0, f.iw]);
  const vals = pts.map((r: any) => r.v).sort(d3.ascending);
  const yS = d3.scaleLinear([d3.quantileSorted(vals, 0.005), d3.quantileSorted(vals, 0.995)], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => v);
  xAxis(f.g, x, f.ih, ticks(dom, f.iw));
  if (pts[0].d - dom[0] > 60) {
    f.g.append('rect').attr('x', 0).attr('width', x(pts[0].d - 10)).attr('y', 0).attr('height', f.ih).style('fill', 'var(--raised)').style('opacity', 0.7);
    if (x(pts[0].d - 10) > 110) f.g.append('text').attr('class', 'annot').attr('x', x(pts[0].d - 10) / 2).attr('y', f.ih / 2 + 4).attr('text-anchor', 'middle').text('not recorded yet');
  }
  drawMilestones(f.g, x, f.ih, { y0: -10 });
  // the scale covers the middle 99% of values: the rest stay inside the frame rather than over the labels
  const cid = `hrrclip${Math.random().toString(36).slice(2, 8)}`;
  f.svg.append('defs').append('clipPath').attr('id', cid).append('rect').attr('x', -3).attr('y', -3).attr('width', f.iw + 6).attr('height', f.ih + 6);
  f.g.append('g').attr('clip-path', `url(#${cid})`).selectAll('circle').data(pts).join('circle').attr('class', 'a-dot').attr('cx', (r: any) => x(r.d)).attr('cy', (r: any) => yS(r.v)).attr('r', 2.2)
    .style('fill', (r: any) => typeColor(r.type || 'other')).style('opacity', 0.5);
  // the median of the 61 workouts around each one, smoothed over 15 more so single readings do not step the line
  const rm = rollingMean(rollingMedian(pts.map((r: any) => r.v), 61), 15);
  f.g.append('path').datum(rm).attr('class', 'a-line').attr('d', d3.line().x((_: any, i: number) => x(pts[i].d)).y((v: number) => yS(v)).curve(d3.curveMonotoneX))
    .style('fill', 'none').style('stroke', 'var(--ink-1)').style('stroke-width', 2.2);
  f.g.append('text').attr('class', 'dlabel strong mono').attr('x', x(pts[pts.length - 1].d) + 6).attr('y', yS(rm[rm.length - 1]) + 4).text(Math.round(rm[rm.length - 1]) + ' bpm');
  f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -8).text('Heart-rate drop one minute after the workout, bpm');
  f.svg.on('pointermove', (ev: any) => {
    const [px, py] = d3.pointer(ev, f.g.node());
    const r: any = d3.least(pts, (r: any) => (x(r.d) - px) ** 2 + (yS(r.v) - py) ** 2);
    if (r) TIP.show(ev, fDate(r.d), [[r.type ? typeLabel({ type: r.type }) : 'Workout', `${f1(r.v)} bpm drop`, typeColor(r.type || 'other')], ['Typical then', `${Math.round(rm[pts.indexOf(r)])} bpm`]]);
  }).on('pointerleave', TIP.hide)
    .on('click', (ev: any) => { const [px, py] = d3.pointer(ev, f.g.node()); const r: any = d3.least(pts, (r: any) => (x(r.d) - px) ** 2 + (yS(r.v) - py) ** 2); if (r?.id && G.byId.has(r.id)) openCloseup(r.id, true); });
  armArrival(el);
  const types = d3.rollups(pts, (v: any[]) => v.length, (r: any) => r.type || 'other').sort((a: any, b: any) => b[1] - a[1]);
  const yr = (y: number) => d3.median(pts.filter((r: any) => r.y === y), (r: any) => r.v);
  const y0 = pts[0].y, y1 = pts[pts.length - 1].y;
  return {
    sub: ['How far your heart rate falls in the first minute after a workout ends; a bigger drop usually goes with fitter. Typical drop ',
      y1 > y0 ? [`${Math.round(yr(y0))} bpm in ${y0}, ${Math.round(yr(y1))} in ${y1}`] : [`${Math.round(d3.median(vals))} bpm`], `, from ${fInt(pts.length)} workouts. Click a dot to open the workout.`],
    legend: { items: types.map(([t, n]: any) => ({ label: `${typeLabel({ type: t })} (${fInt(n)})`, c: typeColor(t) })) },
  };
}

export function drawMove(el: HTMLElement): Out {
  el.replaceChildren();
  const B = G.body, dom = bodyDom();
  const steady = (B?.steady ?? []).filter(inYears), up = (B?.up ?? []).filter(inYears), down = (B?.down ?? []).filter(inYears);
  if (!dom || steady.length + up.length + down.length < 10) return emptyState(el, 'Walking steadiness (iOS 15) and stair speed come from the iPhone and Apple Watch; not recorded in this range.');
  const wrap = document.createElement('div'); wrap.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px'; el.appendChild(wrap);
  const defs: any[] = [
    [steady, (r: any) => r.v * 100, 'Walking steadiness, %', css('--s1'), (v: number) => Math.round(v) + '%'],
    [up, (r: any) => r.v * FT, 'Stair speed up, ft/s', css('--s3'), (v: number) => f1(v) + ' ft/s'],
    [down, (r: any) => r.v * FT, 'Stair speed down, ft/s', css('--s7'), (v: number) => f1(v) + ' ft/s'],
  ];
  // every slot exists before the first chart measures its width
  const holders = defs.map(() => { const d = document.createElement('div'); d.style.minWidth = '0'; wrap.appendChild(d); return d; });
  const bands = defs.map(([rows, get, label, color, fe]: any, i: number) => {
    const mb = monthlyBand(rows, get);
    bandChart(holders[i], mb, { label, color, axis: true, h: 250, fmtEnd: fe, dom, fmt: (v: number) => (i ? d3.format('.1f')(v) : v) });
    return mb.filter((r: any) => r.m != null);
  });
  const parts: any[] = ['Measured in the background whenever you walk with the phone or climb stairs with the watch. Monthly mean with the 10th to 90th percentile band. '];
  if (bands[0].length > 1) parts.push('Steadiness ', [`${Math.round(bands[0][0].m)}% → ${Math.round(bands[0][bands[0].length - 1].m)}%`], ', ');
  if (bands[1].length > 1) parts.push('stairs up ', [`${f1(bands[1][0].m)} → ${f1(bands[1][bands[1].length - 1].m)} ft/s`], '. ');
  return { sub: parts };
}

// the six-minute walk estimate is left out when every value is the same number (on real exports, 500 m): say so
export function sixMinuteNote(): string | null {
  const s = G.body?.six;
  if (!s?.n || s.at_max < s.n) return null;
  return `Six-minute walk estimates are left out: all ${fInt(s.n)} read exactly ${fInt(s.max_m * FT)} ft (${fInt(s.max_m)} m), so they cannot show change.`;
}
