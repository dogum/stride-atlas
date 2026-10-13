// Port of mockup/src/app-closeup.js on a real workout's 10 m stream: route coloured by pace over DEM contours,
// linked elevation / pace / heart-rate / cadence charts, and mile splits.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { G, S, emit } from '../store';
import { COND, DOWS, MAP_RAMPS, MI, Out, REDUCED, TIP, armArrival, css, dayDate, f1, fDate, fDur, fInt, fPace, fPct, frame, typeLabel, xAxis, customTitle, wxName } from '../core';
import { routeSegments } from '../data';

export function openCloseup(id: string, scroll: boolean) {
  if (!G.byId.has(id)) return;
  S.cuId = id;
  emit('closeup');
  if (scroll) document.getElementById('closeup')?.scrollIntoView({ behavior: REDUCED() ? 'auto' : 'smooth', block: 'start' });
}

// derive per-sample series from the 10 m stream
export function samples(st: any, w: any) {
  const n = st.n, out: any[] = [];
  const dist = (i: number) => i === n - 1 ? st.last : i * st.step;
  // pace over a ±50 m window on the moving clock, in min/mi
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 5), b = Math.min(n - 1, i + 5);
    const dd = dist(b) - dist(a), dt = st.t[b] - st.t[a];
    const pace = dd > 0 && dt > 0 ? (dt / 60) / (dd / MI) : NaN;
    out.push({ i, dist: dist(i) / MI, t: st.t[i] / 60, lat: st.lat[i], lon: st.lon[i], el: st.ele[i] != null ? st.ele[i] * 3.28084 : NaN, hr: st.hr[i] ?? NaN, cad: st.cad[i] ?? NaN, pace });
  }
  // clamp absurd paces from stops so the chart stays readable
  const ps = out.map(s => s.pace).filter(isFinite).sort(d3.ascending);
  const hi = d3.quantileSorted(ps, 0.98) ?? 40, lo = d3.quantileSorted(ps, 0.01) ?? 5;
  for (const s of out) if (isFinite(s.pace)) s.pace = Math.max(lo, Math.min(hi, s.pace));
  // share mode: samples inside the privacy zone or the 200 m end trims keep their chart values but leave the map
  if (S.share) for (const [a, b] of st.share_hide || []) for (let i = a; i < b && i < n; i++) out[i].hidden = true;
  return out;
}

let mapState: any = null;
export function drawCuMap(cv: HTMLCanvasElement, w: any, smp: any[], contours: any) {
  const wrap = cv.parentElement!.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1);
  const W = wrap.width, H = wrap.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d')!; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = css('--map-bg'); ctx.fillRect(0, 0, W, H);
  if (!smp.length) return;
  const lat0 = d3.mean(smp, s => s.lat)!, k0 = Math.cos(lat0 * Math.PI / 180);
  const X = (lon: number) => lon * k0, Y = (lat: number) => lat;
  const vis = smp.filter(s => !s.hidden);
  if (!vis.length) return;
  const xs = vis.map(s => X(s.lon)), ys = vis.map(s => Y(s.lat));
  const [x0, x1] = d3.extent(xs) as [number, number], [y0, y1] = d3.extent(ys) as [number, number];
  const k = Math.min((W - 60) / Math.max(0.002, x1 - x0), (H - 60) / Math.max(0.002, y1 - y0));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const proj = (lon: number, lat: number) => [W / 2 + (X(lon) - mx) * k, H / 2 - (Y(lat) - my) * k];
  // contours from USGS 3DEP (the real terrain under the route)
  if (contours) {
    ctx.lineWidth = 0.7;
    const bx0 = mx - W / 2 / k, bx1 = mx + W / 2 / k, by0 = my - H / 2 / k, by1 = my + H / 2 / k;
    for (const ln of contours.lines) {
      const p = ln.path; let inb = false;
      for (let i = 0; i < p.length; i += 8) { const xx = X(p[i]), yy = Y(p[i + 1]); if (xx > bx0 && xx < bx1 && yy > by0 && yy < by1) { inb = true; break; } }
      if (!inb) continue;
      ctx.beginPath();
      for (let i = 0; i < p.length; i += 2) { const [a, b] = proj(p[i], p[i + 1]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }
      ctx.strokeStyle = css('--map-contour'); ctx.lineWidth = ln.major ? 1.2 : 0.6; ctx.globalAlpha = ln.major ? 1.6 : 1; ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // other laps of the same loop, faint
  let same: any[] = [];
  if (w.tpl) same = G.workouts.filter((o: any) => o.tpl === w.tpl && o.id !== w.id && o.route).slice(-150);
  ctx.globalCompositeOperation = 'lighter';
  for (const o of same) { ctx.beginPath(); for (const seg of routeSegments(o, S.share)) seg.forEach((q, i) => { const [a, b] = proj(q[0], q[1]); i ? ctx.lineTo(a, b) : ctx.moveTo(a, b); }); ctx.strokeStyle = 'rgba(151,165,187,.10)'; ctx.lineWidth = 1; ctx.stroke(); }
  ctx.globalCompositeOperation = 'source-over';
  // this route, coloured by pace (faster is lighter)
  const pr = d3.extent(smp.filter(s => isFinite(s.pace)), s => s.pace) as [number, number]; const ramp = MAP_RAMPS.pace;
  ctx.lineCap = 'round'; ctx.lineWidth = 3.4;
  const gaps = new Set(G.cuStream?.gaps || []);
  for (let i = 1; i < smp.length; i++) {
    if (smp[i].hidden || smp[i - 1].hidden) continue;
    const a = proj(smp[i - 1].lon, smp[i - 1].lat), b = proj(smp[i].lon, smp[i].lat);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    ctx.setLineDash(gaps.has(smp[i].i) ? [4, 5] : []);
    ctx.strokeStyle = isFinite(smp[i].pace) ? ramp(1 - (smp[i].pace - pr[0]) / Math.max(0.01, pr[1] - pr[0])) : '#97a5bb'; ctx.stroke();
  }
  ctx.setLineDash([]);
  if (!smp[0].hidden) { const s0 = proj(smp[0].lon, smp[0].lat); ctx.fillStyle = '#ff8f4a'; ctx.beginPath(); ctx.arc(s0[0], s0[1], 5, 0, 7); ctx.fill(); ctx.strokeStyle = '#070c16'; ctx.lineWidth = 2; ctx.stroke(); }
  ctx.font = '11px "Overpass Mono Variable", "Overpass Mono", monospace'; ctx.fillStyle = 'rgba(195,205,219,.9)';
  ctx.fillText(`pace ${fPace(pr[1])}`, 14, H - 16); const g = ctx.createLinearGradient(96, 0, 196, 0); [0, .25, .5, .75, 1].forEach(t => g.addColorStop(t, ramp(t))); ctx.fillStyle = g; ctx.fillRect(96, H - 24, 100, 8); ctx.fillStyle = 'rgba(195,205,219,.9)'; ctx.fillText(fPace(pr[0]), 202, H - 16);
  if (same.length) ctx.fillText(`${same.length} other laps of this loop shown faint`, 14, 22);
  if (S.share) ctx.fillText('share mode: the area around home is hidden', 14, same.length ? 38 : 22);
  const base = document.createElement('canvas'); base.width = cv.width; base.height = cv.height; base.getContext('2d')!.drawImage(cv, 0, 0);
  mapState = { cv, ctx, base, proj, dpr, smp };
}
export function hoverCuMap(i: number | null) {
  if (!mapState) return;
  const { ctx, base, proj, dpr, smp } = mapState;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(base, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (i != null && smp[i] && !smp[i].hidden) { const [x, y] = proj(smp[i].lon, smp[i].lat); ctx.beginPath(); ctx.arc(x, y, 7, 0, 7); ctx.fillStyle = 'rgba(255,241,230,.95)'; ctx.fill(); ctx.strokeStyle = '#ff8f4a'; ctx.lineWidth = 2.5; ctx.stroke(); }
}

export function cuStats(w: any) {
  const items: [string, string][] = [['Distance', `${f1(w.dist)} mi`], ['Moving time', fDur(w.dur)], [w.type === 'ride' ? 'Speed' : 'Pace', w.type === 'ride' ? `${f1(w.speed)} mph` : `${fPace(w.pace)} /mi`],
    ['Grade-adjusted', w.gapPace ? `${fPace(w.gapPace)} /mi` : '—'], ['Avg heart rate', w.hr ? `${Math.round(w.hr)} bpm` : '—'], ['Climb', w.gain != null ? `${fInt(w.gain)} ft` : '—'],
    ['Steps', w.steps ? fInt(w.steps) : '—'], ['Cadence', w.cadence ? `${Math.round(w.cadence)} spm` : '—'], ['Weather', w.temp != null ? `${Math.round(w.temp)}°F ${(COND[w.cond] || '').toLowerCase()}` : '—'],
    ['Training load', w.trimp ? `${fInt(w.trimp)} TRIMP` : '—']];
  const dt = dayDate(w.d);
  const src = [w.source === 'Strava' ? `${w.device} via Strava` : w.device, `weather ${w.wxSrc === 'api' ? `filled from ${wxName(w)}` : w.wxSrc === 'health' ? 'from Health metadata' : 'n/a'}`,
    `climb ${w.climbSrc === 'watch' ? 'from the barometer' : w.climbSrc === 'dem' ? 'from USGS 3DEP' : w.climbSrc === 'gps' ? 'from smoothed GPS' : 'n/a'}`,
    `profile ${w.eleSrc === 'dem' ? 'USGS 3DEP' : w.eleSrc || 'n/a'}`, `local time ${w.tz}${w.tzSrc ? ' (' + w.tzSrc + ')' : ''}`, `distance ${w.distSrc || 'n/a'}`].join(' · ');
  const title = `${customTitle(w) ? customTitle(w) + ': ' : ''}${DOWS[dt.getUTCDay()]} ${typeLabel(w).toLowerCase()}, ${fDate(w.d)}`;
  return { items, src, title };
}

export function drawCuCharts(el: HTMLElement, w: any, smp: any[]) {
  el.replaceChildren();
  if (!smp.length) return;
  const hm = w.hrMaxUsed ?? G.meta?.hr_max ?? 178, zp = G.meta?.zones_pct ?? [60, 70, 80, 90];
  const isBike = w.type === 'ride';
  const defs: any[] = [];
  if (smp.some(s => isFinite(s.el))) defs.push({ k: 'el', label: 'Elevation, ft', c: css('--s3'), area: true, fmt: (v: number) => fInt(v) + ' ft' });
  defs.push({ k: 'pace', label: isBike ? 'Speed, mph' : 'Pace per mile, faster up', c: css('--s1'), inv: !isBike, map: isBike ? ((v: number) => 60 / v) : null, fmt: (v: number) => isBike ? f1(60 / v) + ' mph' : fPace(v) });
  const hrCov = smp.filter(s => isFinite(s.hr)).length / Math.max(1, smp.length);
  if (hrCov > 0) defs.push({ k: 'hr', label: hrCov < 0.5 ? 'Heart rate, bpm (only a few samples in the export for this workout)' : 'Heart rate, bpm', c: css('--s8'), zones: true, fmt: (v: number) => Math.round(v) + ' bpm' });
  if (smp.some(s => isFinite(s.cad) && s.cad > 20)) defs.push({ k: 'cad', label: 'Cadence, steps/min', c: css('--s7'), fmt: (v: number) => Math.round(v) + ' spm' });
  const x = d3.scaleLinear([0, smp[smp.length - 1].dist], [0, 1]);
  const frames: any[] = [];
  defs.forEach((d, di) => {
    const holder = document.createElement('div'); el.appendChild(holder);
    const last = di === defs.length - 1;
    const f = frame(holder, last ? 104 : 84, { t: 16, r: 14, b: last ? 24 : 6, l: 48 });
    x.range([0, f.iw]);
    const vals = smp.map(s => d.map ? d.map(s[d.k]) : s[d.k]);
    const fv = vals.filter((v: number) => isFinite(v));
    let ext = d3.extent(fv) as [number, number]; const pad = (ext[1] - ext[0]) * 0.12 || 1; ext = [ext[0] - pad, ext[1] + pad];
    const yS = d3.scaleLinear(d.inv ? [ext[1], ext[0]] : ext, [f.ih, 0]);
    if (d.zones) zp.slice(0, 4).forEach((p: number, zi: number) => { const a = hm * p / 100, b = zi < 3 ? hm * zp[zi + 1] / 100 : hm; const y0 = yS(Math.min(ext[1], b)), y1 = yS(Math.max(ext[0], a)); if (y1 > y0) f.g.append('rect').attr('x', 0).attr('width', f.iw).attr('y', y0).attr('height', y1 - y0).style('fill', 'var(--raised-2)').style('opacity', .35 + zi * .15); });
    f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(yS).ticks(3).tickSize(0).tickPadding(6).tickFormat((v: any) => d.k === 'pace' && !isBike ? fPace(v) : isBike && d.k === 'pace' ? f1(v) : fInt(v)));
    f.g.append('g').attr('class', 'gridl').call(d3.axisLeft(yS).ticks(3).tickSize(-f.iw).tickFormat('' as any));
    if (last) xAxis(f.g, x, f.ih, { ticks: Math.min(10, Math.ceil(smp[smp.length - 1].dist)), fmt: (v: number) => v + ' mi' });
    const def = (v: number) => isFinite(v);
    const line = d3.line().defined(def).x((v, i) => x(smp[i].dist)).y(v => yS(v)).curve(d3.curveMonotoneX);
    if (d.area) f.g.append('path').datum(vals).attr('class', 'a-fade').attr('d', d3.area().defined(def).x((v, i) => x(smp[i].dist)).y0(f.ih).y1(v => yS(v)).curve(d3.curveMonotoneX)).style('fill', d.c).style('opacity', .12);
    f.g.append('path').datum(vals).attr('class', 'a-line').attr('d', line).style('fill', 'none').style('stroke', d.c).style('stroke-width', 1.8);
    // samples with no neighbours (sparse heart rate in older exports) are dots, not invisible zero-length lines
    const iso = vals.map((v: number, i: number) => def(v) && !def(vals[i - 1]) && !def(vals[i + 1]) ? i : -1).filter((i: number) => i >= 0);
    f.g.selectAll('circle.iso').data(iso).join('circle').attr('class', 'iso').attr('cx', (i: number) => x(smp[i].dist)).attr('cy', (i: number) => yS(vals[i])).attr('r', 2.6).style('fill', d.c);
    f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -5).text(d.label);
    const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-2)').style('opacity', 0);
    const dot = f.g.append('circle').attr('r', 4).style('fill', d.c).style('stroke', 'var(--panel)').style('stroke-width', 2).style('opacity', 0);
    frames.push({ f, ch, dot, yS, vals, d });
    armArrival(holder);
  });
  const move = (e: any, fr: any) => {
    const [px] = d3.pointer(e, fr.f.g.node()); const dist = x.invert(Math.max(0, Math.min(fr.f.iw, px)));
    const i = Math.max(0, Math.min(smp.length - 1, d3.bisector((s: any) => s.dist).center(smp, dist)));
    for (const o of frames) { o.ch.attr('x1', x(smp[i].dist)).attr('x2', x(smp[i].dist)).style('opacity', .55); o.dot.attr('cx', x(smp[i].dist)).attr('cy', o.yS(isFinite(o.vals[i]) ? o.vals[i] : o.yS.domain()[0])).style('opacity', isFinite(o.vals[i]) ? 1 : 0); }
    TIP.show(e, `${f1(smp[i].dist)} mi · ${fDur(smp[i].t)}`, frames.map(o => [o.d.label.split(',')[0], isFinite(smp[i][o.d.k]) ? o.d.fmt(smp[i][o.d.k]) : '—', o.d.c]));
    hoverCuMap(i);
  };
  const leave = () => { for (const o of frames) { o.ch.style('opacity', 0); o.dot.style('opacity', 0); } TIP.hide(); hoverCuMap(null); };
  frames.forEach(fr => fr.f.svg.on('pointermove', (e: any) => move(e, fr)).on('pointerleave', leave));
}

export function drawSplits(el: HTMLElement, w: any): Out {
  const rows = (G.splits || []).filter((s: any) => s.id === w.id).map((s: any) => ({ m: s.split, pace: s.pace_s_per_mi / 60, part: s.partial, len: s.length_m / MI, hr: s.avg_hr, gain: s.climb_m != null ? s.climb_m * 3.28084 : null, loss: s.descent_m != null ? s.descent_m * 3.28084 : null, gap: s.gap_pace_s_per_mi ? s.gap_pace_s_per_mi / 60 : null }));
  if (!rows.length) { el.replaceChildren(); return { sub: ['No splits for this workout.'] }; }
  const f = frame(el, 34 + rows.length * 26, { t: 4, r: 250, b: 20, l: 60 });
  const x = d3.scaleLinear([0, d3.max(rows, (r: any) => r.pace)! * 1.05], [0, f.iw]), y = d3.scaleBand(rows.map((r: any) => r.m), [0, f.ih]).padding(0.25);
  const best: any = d3.least(rows.filter((r: any) => !r.part), (r: any) => r.pace);
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(y).tickSize(0).tickPadding(8).tickFormat((m: any) => { const r: any = rows.find((o: any) => o.m === m); return r.part ? `${f1(r.len)} mi` : `Mile ${m}`; }));
  f.g.selectAll('rect').data(rows).join('rect').attr('class', 'a-hbar').attr('x', 0).attr('y', (r: any) => y(r.m)!).attr('height', y.bandwidth()).attr('width', (r: any) => x(r.pace)).attr('rx', 3).style('fill', (r: any) => r === best ? 'var(--signal)' : 'var(--s1)').style('opacity', (r: any) => r.part ? .55 : 1)
    .on('pointermove', (e: any, r: any) => TIP.show(e, r.part ? 'Final partial mile' : `Mile ${r.m}`, [['Pace', fPace(r.pace) + ' /mi'], ['Grade-adjusted', r.gap ? fPace(r.gap) + ' /mi' : '—'], ['Heart rate', r.hr ? Math.round(r.hr) + ' bpm' : '—'], ['Climb', r.gain != null ? fInt(r.gain) + ' ft' : '—'], ['Descent', r.loss != null ? fInt(r.loss) + ' ft' : '—']])).on('pointerleave', TIP.hide);
  f.g.selectAll('text.v').data(rows).join('text').attr('class', 'dlabel mono a-fade').attr('x', (r: any) => x(r.pace) + 8).attr('y', (r: any) => y(r.m)! + y.bandwidth() / 2 + 4).text((r: any) => `${fPace(r.pace)}  ·  ${r.hr ? Math.round(r.hr) + ' bpm' : '— bpm'}  ·  +${r.gain != null ? fInt(r.gain) : '—'} −${r.loss != null ? fInt(r.loss) : '—'} ft${r.gap ? '  ·  GAP ' + fPace(r.gap) : ''}`);
  armArrival(el);
  const neg = w.splitDelta != null && w.splitDelta < 0;
  return { sub: best ? ['Fastest full mile was ', [`mile ${best.m} at ${fPace(best.pace)}`], `. Bars are minutes per mile, so shorter is faster. GAP is the flat-ground equivalent (Tobler's hiking function for walks and hikes, Minetti for runs).${w.splitDelta != null ? (neg ? ' A negative split: the second half was faster.' : ' The second half was slower.') : ''}`] : [] };
}
export { fPct };
