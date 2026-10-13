// Port of mockup/src/app-bests.js with the real pipeline outputs: best efforts from a sliding window over each
// cleaned GPS track, loops from route clustering, the Banister fitness model, Eddington and new ground.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, S } from '../store';
import { MONTHS, Out, TIP, armArrival, css, dayDate, dayOfISO, emptyState, f1, fDate, fDateShort, fInt, fK, fPace, frame, fTime, typeColor, typeLabel, xAxis, yGrid, yearTicks, daySpan } from '../core';
import { routeSegments } from '../data';
import { openCloseup } from './closeup';

export const BE: Record<string, string[]> = { walk: ['1 mi', '2 mi', '5K', '5 mi', '10K', '10 mi', 'Half'], run: ['1 mi', '5K', '10K', '10 mi', 'Half', 'Marathon'] };
export const BS = { type: 'walk', dist: '1 mi' };

export function streak(flags: boolean[]) { let best = 0, cur = 0, end = -1; flags.forEach((f, i) => { cur = f ? cur + 1 : 0; if (cur > best) { best = cur; end = i; } }); return { len: best, end }; }
export function eddington(vals: number[]) {
  const v = vals.filter(x => x != null && isFinite(x)).sort((a, b) => b - a);
  let E = 0; for (let i = 0; i < v.length; i++) { if (v[i] >= i + 1) E = i + 1; else break; }
  const need = Math.max(0, (E + 1) - v.filter(x => x >= E + 1).length);
  return { E, need };
}

export function efforts(type: string, label: string) {
  return (G.bestEfforts || []).filter((b: any) => b.type === type && b.distance_label === label && b.w.y >= S.y0 && b.w.y <= S.y1).sort((a: any, b: any) => a.w.d - b.w.d || a.t - b.t);
}
export function prSeries(type: string, label: string) {
  const ef = efforts(type, label);
  let best = Infinity; const prs: any[] = [];
  for (const e of ef) if (e.t < best) { best = e.t; prs.push(e); }
  return { efforts: ef, prs };
}
export function availableDists(type: string) { return BE[type].filter(l => (G.bestEfforts || []).some((b: any) => b.type === type && b.distance_label === l)); }

export function drawProg(el: HTMLElement): Out {
  if (!S.types.has(BS.type)) return emptyState(el, 'Turn on walks or runs in the activity filter.');
  const { efforts: ef, prs } = prSeries(BS.type, BS.dist);
  const D = ef[0]?.D ?? 1;
  if (ef.length < 3) return emptyState(el, `Not enough GPS ${BS.type}s of ${BS.dist} or longer in this range (${ef.length}).`);
  const f = frame(el, 330, { t: 26, r: 24, b: 26, l: 54 });
  const x = d3.scaleLinear(daySpan(), [0, f.iw]);
  const ext = d3.extent(ef, (e: any) => e.t) as [number, number];
  const yS = d3.scaleLinear([d3.quantile(ef, 0.98, (e: any) => e.t)!, ext[0] * 0.985], [f.ih, 0]).nice();
  f.g.append('g').attr('class', 'gridl').call(d3.axisLeft(yS).ticks(5).tickSize(-f.iw).tickFormat('' as any));
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(yS).ticks(5).tickSize(0).tickPadding(8).tickFormat(fTime as any));
  xAxis(f.g, x, f.ih, { values: yearTicks(F.years, daySpan()[0]), fmt: (v: number) => dayDate(v).getUTCFullYear() });
  const col = typeColor(BS.type);
  f.g.append('g').attr('class', 'a-reveal').selectAll('circle').data(ef.filter((e: any) => e.t <= yS.domain()[0])).join('circle').attr('cx', (e: any) => x(e.w.d)).attr('cy', (e: any) => yS(e.t)).attr('r', 2.4).style('fill', col).style('opacity', .32);
  const stair = prs.map((e: any) => [x(e.w.d), yS(e.t)]); stair.push([f.iw, stair[stair.length - 1][1]]);
  f.g.append('path').datum(stair).attr('class', 'a-line').attr('d', d3.line().curve(d3.curveStepAfter) as any).style('fill', 'none').style('stroke', 'var(--signal)').style('stroke-width', 2.2);
  f.g.selectAll('circle.pr').data(prs).join('circle').attr('class', 'pr a-dot').attr('data-i', (e: any, i: number) => i * 3).attr('cx', (e: any) => x(e.w.d)).attr('cy', (e: any) => yS(e.t)).attr('r', 5).style('fill', 'var(--signal)').style('stroke', 'var(--panel)').style('stroke-width', 2).style('cursor', 'pointer')
    .on('pointermove', (ev: any, e: any) => TIP.show(ev, `New ${BS.dist} record`, [['Time', fTime(e.t)], ['Pace', fPace(e.t / D) + ' /mi'], ['Date', fDate(e.w.d)], ['Inside a', `${f1(e.w.dist)} mi ${typeLabel(e.w).toLowerCase()}`]])).on('pointerleave', TIP.hide)
    .on('click', (ev: any, e: any) => openCloseup(e.w.id, true));
  const last = prs[prs.length - 1];
  f.g.append('text').attr('class', 'dlabel strong halo').attr('x', Math.min(f.iw - 4, x(last.w.d) + 8)).attr('y', yS(last.t) - 10).attr('text-anchor', x(last.w.d) > f.iw - 120 ? 'end' : 'start').text(`${fTime(last.t)} · ${fDateShort(last.w.d)} ${dayDate(last.w.d).getUTCFullYear()}`);
  f.g.append('text').attr('class', 'alabel').attr('x', -50).attr('y', -14).text('time, faster up');
  armArrival(el);
  return { sub: [`Your ${BS.dist} ${BS.type === 'walk' ? 'walking' : 'running'} record has fallen `, [`${prs.length} time${prs.length === 1 ? '' : 's'}`], `, from ${fTime(prs[0].t)} to ${fTime(last.t)}. Faint dots are the fastest ${BS.dist} inside each of ${fInt(ef.length)} workouts. Click a record to open it.`] };
}

export function drawBestTable(el: HTMLElement): Out {
  el.replaceChildren();
  if (!S.types.has(BS.type)) return emptyState(el, 'No activity selected');
  const t = document.createElement('table'); t.className = 'rec';
  const head = document.createElement('tr'); for (const [h, n] of [['Distance', 0], ['Time', 1], ['Pace', 1], ['Date', 1]] as any) { const th = document.createElement('th'); th.textContent = h; if (n) th.className = 'n'; head.appendChild(th); }
  const thead = document.createElement('thead'); thead.appendChild(head); t.appendChild(thead);
  const tb = document.createElement('tbody'); let n = 0;
  for (const label of BE[BS.type]) {
    const { prs } = prSeries(BS.type, label); const e = prs[prs.length - 1];
    const tr = document.createElement('tr'); tr.className = 'a-fade';
    const cells = [label, e ? fTime(e.t) : '—', e ? fPace(e.t / e.D) : '—', e ? `${MONTHS[dayDate(e.w.d).getUTCMonth()]} ${dayDate(e.w.d).getUTCFullYear()}` : '—'];
    cells.forEach((c, i) => { const td = document.createElement('td'); td.textContent = c; if (i) td.className = 'n'; tr.appendChild(td); });
    if (e) { tr.style.cursor = 'pointer'; tr.tabIndex = 0; tr.addEventListener('click', () => openCloseup(e.w.id, true)); tr.addEventListener('keydown', (k) => { if (k.key === 'Enter') openCloseup(e.w.id, true); }); n++; }
    tb.appendChild(tr);
  }
  t.appendChild(tb); el.appendChild(t);
  armArrival(el);
  return { sub: [`${BS.type === 'walk' ? 'Walking' : 'Running'} records within the filter. `, [`${n} distances`], ' have a record. Pick a row to open that workout.'] };
}

// ---------- loops ----------
// Weather-adjusted lap times (METRICS.md stretch goal): subtract the weather model's temperature effect,
// relative to 60°F, times the lap distance, so a July lap and a January lap compare fairly.
export const LOOPS = { mode: 'raw' };
function tempEffect(): ((tF: number) => number) | null {
  const rows = G.wxTemp || []; if (!rows.length) return null;
  const xs = rows.map((r: any) => r.temp_f), ys = rows.map((r: any) => r.effect_min);
  return (t: number) => { const c = Math.max(xs[0], Math.min(xs[xs.length - 1], t)); const i = Math.max(1, d3.bisectLeft(xs, c)); const k = (c - xs[i - 1]) / ((xs[i] - xs[i - 1]) || 1); return ys[i - 1] + k * (ys[i] - ys[i - 1]); };
}
function miniMap(cv: HTMLCanvasElement, w: any) {
  const segs = routeSegments(w, S.share);
  const pts = segs.flat();
  const c = cv.getContext('2d')!; c.clearRect(0, 0, cv.width, cv.height);
  if (pts.length < 2) return;
  const k0 = Math.cos(pts[0][1] * Math.PI / 180);
  const [x0, x1] = d3.extent(pts, (p: number[]) => p[0] * k0) as [number, number], [y0, y1] = d3.extent(pts, (p: number[]) => p[1]) as [number, number];
  const k = Math.min(150 / Math.max(1e-5, x1 - x0), 110 / Math.max(1e-5, y1 - y0)); const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const P = (p: number[]) => [90 + (p[0] * k0 - mx) * k, 70 - (p[1] - my) * k];
  c.beginPath(); for (const s of segs) s.forEach((p, j) => { const [X, Y] = P(p); j ? c.lineTo(X, Y) : c.moveTo(X, Y); });
  c.strokeStyle = '#ff8f4a'; c.lineWidth = 3; c.lineJoin = 'round'; c.stroke();
  if (!S.share) { const [sx, sy] = P(pts[0]); c.fillStyle = '#eef2f7'; c.beginPath(); c.arc(sx, sy, 5, 0, 7); c.fill(); }
}
export function drawLoops(el: HTMLElement): Out {
  el.replaceChildren();
  if (!S.types.has('walk')) return emptyState(el, 'Walks are switched off in the activity filter.');
  const eff = LOOPS.mode === 'adjusted' ? tempEffect() : null;
  const adj = (l: any) => eff && l.w.temp != null ? l.elapsed_s - eff(l.w.temp) * 60 * l.w.dist : l.elapsed_s;
  const laps = (G.loopLaps || []).filter((l: any) => l.type === 'walk').map((l: any) => ({ ...l, w: G.byId.get(l.id) })).filter((l: any) => l.w && l.w.y >= S.y0 && l.w.y <= S.y1)
    .map((l: any) => ({ ...l, raw_s: l.elapsed_s, elapsed_s: adj({ ...l, w: G.byId.get(l.id) }) }));
  const byL = d3.groups(laps, (l: any) => l.loop_id).filter(([, a]) => a.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 6);
  if (!byL.length) return emptyState(el, 'No walking loop repeated three times in this range.');
  const meta = new Map((G.loops || []).map((l: any) => [l.loop_id, l]));
  const grid = document.createElement('div'); grid.style.display = 'grid'; grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(320px, 1fr))'; grid.style.gap = '12px'; el.appendChild(grid);
  const cards = byL.map(([lid, arr]: any) => {
    const L: any = meta.get(lid);
    arr.sort((a: any, b: any) => a.w.d - b.w.d);
    const card = document.createElement('div'); card.className = 'rec-card a-fade'; card.style.cursor = 'default'; card.style.gap = '8px';
    const top = document.createElement('div'); top.style.display = 'flex'; top.style.gap = '12px'; top.style.alignItems = 'center';
    const cv = document.createElement('canvas'); cv.width = 180; cv.height = 140; cv.className = 'loop-mini';
    const rep = G.byId.get(L?.representative_workout_id) || arr[0].w;
    miniMap(cv, rep);
    const best = d3.least(arr, (l: any) => l.elapsed_s), med = d3.median(arr, (l: any) => l.elapsed_s)!, lastL = arr[arr.length - 1];
    const txt = document.createElement('div'); txt.style.minWidth = '0';
    txt.innerHTML = '<span class="lbl"></span><div class="v" style="font-size:19px"></div><div class="d"></div>';
    const where = rep.placeName ? rep.placeName.split(',')[0] : '';
    txt.querySelector('.lbl')!.textContent = `${L?.name || L?.label || lid}${where ? ' · ' + where : ''}`;
    txt.querySelector('.v')!.textContent = `${f1((L?.median_distance_m ?? 0) / 1609.344)} mi · ${fInt(arr.length)} times`;
    txt.querySelector('.d')!.textContent = `Best ${fTime(best.elapsed_s / 60)} · typical ${fTime(med / 60)} · last ${fTime(lastL.elapsed_s / 60)}`;
    top.append(cv, txt); card.appendChild(top);
    const sv = document.createElement('div'); card.appendChild(sv);
    const go = document.createElement('button'); go.type = 'button'; go.className = 'ghost'; go.style.alignSelf = 'flex-start'; go.textContent = `Open the record, ${fDate(best.w.d)}`; go.addEventListener('click', () => openCloseup(best.w.id, true)); card.appendChild(go);
    grid.appendChild(card);
    return { sv, arr, best };
  });
  for (const { sv, arr, best } of cards) {
    const f = frame(sv, 74, { t: 6, r: 6, b: 14, l: 38 });
    const x = d3.scaleLinear(daySpan(), [0, f.iw]);
    const ex = d3.extent(arr, (l: any) => l.elapsed_s / 60) as [number, number];
    const yS = d3.scaleLinear([d3.quantile(arr, 0.95, (l: any) => l.elapsed_s / 60)! * 1.02, ex[0] * 0.98], [f.ih, 0]).clamp(true);
    f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(yS).ticks(2).tickSize(0).tickPadding(4).tickFormat((v: any) => fTime(v)));
    f.g.append('line').attr('x1', 0).attr('x2', f.iw).attr('y1', f.ih).attr('y2', f.ih).style('stroke', 'var(--axis)');
    F.years.forEach((y: number) => { const d = Math.round((Date.UTC(y, 0, 1) - G.D0) / G.DAY); if (d < F.days[0].d) return; f.g.append('text').attr('x', x(d)).attr('y', f.ih + 12).style('fill', 'var(--ink-4)').style('font-family', 'var(--font-mono)').style('font-size', '9px').text(`'${String(y).slice(2)}`); });
    let pb = Infinity; const stair: number[][] = []; for (const l of arr) if (l.elapsed_s < pb) { pb = l.elapsed_s; stair.push([x(l.w.d), yS(l.elapsed_s / 60)]); }
    stair.push([f.iw, stair[stair.length - 1][1]]);
    f.g.selectAll('circle').data(arr).join('circle').attr('class', 'a-dot').attr('data-i', (l: any, i: number) => i % 30).attr('cx', (l: any) => x(l.w.d)).attr('cy', (l: any) => yS(l.elapsed_s / 60)).attr('r', (l: any) => l === best ? 4 : 2.2).style('fill', (l: any) => l === best ? 'var(--signal)' : 'var(--s1)').style('opacity', (l: any) => l === best ? 1 : .55)
      .on('pointermove', (e: any, l: any) => TIP.show(e, fDate(l.w.d), [[eff ? 'Adjusted to 60°F' : 'Elapsed', fTime(l.elapsed_s / 60)], ...(eff ? [['Actual elapsed', fTime(l.raw_s / 60)]] : []), ['Pace', fPace(l.w.pace) + ' /mi'], ['Temperature', l.w.temp != null ? Math.round(l.w.temp) + '°F' : '—'], ['Direction', l.direction === 'cw' ? 'clockwise' : 'counterclockwise']])).on('pointerleave', TIP.hide).on('click', (e: any, l: any) => openCloseup(l.w.id, true));
    f.g.append('path').datum(stair).attr('d', d3.line().curve(d3.curveStepAfter) as any).style('fill', 'none').style('stroke', 'var(--signal)').style('stroke-width', 1.5).style('opacity', .8);
    armArrival(sv);
  }
  armArrival(el);
  const tot = d3.sum(byL, ([, a]: any) => a.length);
  const nAll = new Set(laps.map((l: any) => l.loop_id)).size;
  return { sub: [`${fInt(nAll)} loops have three or more walking laps in this range. The six most walked account for `, [`${fInt(tot)} walks`], `. Dots are laps (${eff ? 'elapsed time adjusted to 60°F with the weather model' : 'elapsed time'}), the orange step line is the loop record, and faster is up.`] };
}

// ---------- fitness & fatigue (Banister) ----------
export function drawFF(el: HTMLElement): Out {
  const rows = F.days.filter((d: any) => d.ctl != null);
  if (rows.length < 30) return emptyState(el, 'Pick a wider range (the model needs heart-rate workouts and a 60-day warm-up).');
  const cF = css('--s1'), cA = css('--s2');
  el.replaceChildren();
  const a = document.createElement('div'), b = document.createElement('div'); el.append(a, b);
  const step = Math.max(1, Math.floor(rows.length / 900)); const rs = rows.filter((r: any, i: number) => i % step === 0 || i === rows.length - 1);
  const f = frame(a, 210, { t: 10, r: 48, b: 6, l: 44 });
  const x = d3.scaleLinear(d3.extent(F.days, (r: any) => r.d) as any, [0, f.iw]);
  const yS = d3.scaleLinear([0, d3.max(rs, (r: any) => Math.max(r.ctl, r.atl))! * 1.05], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => v);
  f.g.append('path').datum(rs).attr('class', 'a-line').attr('d', d3.line().x(r => x(r.d)).y(r => yS(r.atl)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', cA).style('stroke-width', 1.4).style('opacity', .75);
  f.g.append('path').datum(rs).attr('class', 'a-fade').attr('d', d3.area().x(r => x(r.d)).y0(f.ih).y1(r => yS(r.ctl)).curve(d3.curveMonotoneX)).style('fill', cF).style('opacity', .12);
  f.g.append('path').datum(rs).attr('class', 'a-line').attr('d', d3.line().x(r => x(r.d)).y(r => yS(r.ctl)).curve(d3.curveMonotoneX)).style('fill', 'none').style('stroke', cF).style('stroke-width', 2.4);
  const e = rs[rs.length - 1];
  f.g.append('text').attr('class', 'dlabel strong mono').attr('x', f.iw + 6).attr('y', yS(e.ctl) + 4).text(Math.round(e.ctl));
  f.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', 4).text('training load, TRIMP per day');
  const f2 = frame(b, 120, { t: 14, r: 48, b: 24, l: 44 });
  const y2 = d3.scaleLinear(d3.extent(rs, (r: any) => r.tsb) as any, [f2.ih, 0]).nice();
  yGrid(f2.g, y2, f2.iw, 3, (v: number) => (v > 0 ? '+' : '') + v);
  xAxis(f2.g, x, f2.ih, { values: yearTicks(F.years, F.days[0].d), fmt: (v: number) => dayDate(v).getUTCFullYear() });
  const cid = 'ffclip' + Math.round(Math.random() * 1e6);
  const defs = f2.svg.append('defs');
  defs.append('clipPath').attr('id', cid + 'a').append('rect').attr('x', 0).attr('y', 0).attr('width', f2.iw).attr('height', y2(0));
  defs.append('clipPath').attr('id', cid + 'b').append('rect').attr('x', 0).attr('y', y2(0)).attr('width', f2.iw).attr('height', Math.max(0, f2.ih - y2(0)));
  const ar = d3.area().x(r => x(r.d)).y0(y2(0)).y1(r => y2(r.tsb)).curve(d3.curveMonotoneX);
  f2.g.append('path').datum(rs).attr('class', 'a-fade').attr('d', ar).attr('clip-path', `url(#${cid}a)`).style('fill', 'var(--cold)').style('opacity', .55);
  f2.g.append('path').datum(rs).attr('class', 'a-fade').attr('d', ar).attr('clip-path', `url(#${cid}b)`).style('fill', 'var(--hot)').style('opacity', .55);
  f2.g.append('line').attr('x1', 0).attr('x2', f2.iw).attr('y1', y2(0)).attr('y2', y2(0)).style('stroke', 'var(--ink-3)');
  f2.g.append('text').attr('class', 'alabel').attr('x', 0).attr('y', -4).text('form: fresh above the line, tired below');
  for (const fr of [f, f2]) {
    const ch = fr.g.append('line').attr('y1', 0).attr('y2', fr.ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
    fr.svg.on('pointermove', (ev: any) => { const [px] = d3.pointer(ev, fr.g.node()); const d = Math.round(x.invert(px)); const r: any = G.dayByD.get(Math.max(rows[0].d, Math.min(rows[rows.length - 1].d, d))); if (!r || r.ctl == null) return; ch.attr('x1', x(r.d)).attr('x2', x(r.d)).style('opacity', .6); TIP.show(ev, fDate(r.d), [['Fitness', f1(r.ctl), cF], ['Fatigue', f1(r.atl), cA], ['Form', (r.tsb > 0 ? '+' : '') + f1(r.tsb)], ['Load that day', fInt(r.trimp ?? 0)]]); })
      .on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
    armArrival(fr.el);
  }
  const pk: any = d3.greatest(rows, (r: any) => r.ctl);
  return {
    sub: ['Fitness peaked at ', [`${Math.round(pk.ctl)} in ${MONTHS[dayDate(pk.d).getUTCMonth()]} ${dayDate(pk.d).getUTCFullYear()}`], ` and sits at ${Math.round(e.ctl)} now, with form ${e.tsb > 0 ? '+' : ''}${f1(e.tsb)}. TRIMP uses each day's resting heart rate and a ${Math.round(G.meta?.hr_max ?? 178)} bpm max.`],
    legend: { items: [{ label: 'Fitness (42-day)', c: cF }, { label: 'Fatigue (7-day)', c: cA }], kind: 'ln' },
  };
}

// ---------- Eddington ----------
export function drawEdd(el: HTMLElement): Out {
  const vals = F.days.map((d: any) => d.footMi).filter((v: number) => v > 0);
  if (!vals.length) return emptyState(el, 'No walks, runs or hikes in range.');
  const counts = d3.range(1, 31).map(n => ({ n, c: vals.filter((v: number) => v >= n).length }));
  const { E, need } = eddington(vals);
  const show = counts.filter(o => o.n <= Math.max(E + 5, 8) && (o.c > 0 || o.n <= E + 2));
  const f = frame(el, 290, { t: 16, r: 10, b: 30, l: 40 });
  const x = d3.scaleBand(show.map(o => o.n), [0, f.iw]).padding(0.22);
  const yS = d3.scaleLog([1, d3.max(show, o => o.c)! * 1.3], [f.ih, 0]).clamp(true);
  const tv = [1, 3, 10, 30, 100, 300, 1000, 3000].filter(v => v < yS.domain()[1]);
  f.g.append('g').attr('class', 'gridl').call(d3.axisLeft(yS).tickValues(tv).tickSize(-f.iw).tickFormat('' as any));
  f.g.append('g').attr('class', 'ax noline').call(d3.axisLeft(yS).tickValues(tv).tickSize(0).tickPadding(6).tickFormat(fK as any));
  xAxis(f.g, x, f.ih, { fmt: (n: number) => n });
  f.g.append('text').attr('class', 'alabel').attr('x', f.iw).attr('y', f.ih + 28).attr('text-anchor', 'end').text('miles on foot in one day, at least');
  f.g.selectAll('rect').data(show).join('rect').attr('class', 'a-bar').attr('x', (o: any) => x(o.n)! + Math.max(0, (x.bandwidth() - 24) / 2)).attr('width', Math.min(24, x.bandwidth())).attr('y', (o: any) => yS(Math.max(1, o.c))).attr('height', (o: any) => o.c ? f.ih - yS(Math.max(1, o.c)) : 0).attr('rx', 3)
    .style('fill', (o: any) => o.n === E ? 'var(--signal)' : o.c >= o.n ? 'var(--s1)' : 'var(--chip)')
    .on('pointermove', (e: any, o: any) => TIP.show(e, `${o.n}+ mile days`, [['Days', fInt(o.c)], ['Needed for E = ' + o.n, fInt(o.n)]])).on('pointerleave', TIP.hide);
  f.g.append('path').datum(show).attr('d', d3.line().x(o => x(o.n)! + x.bandwidth() / 2).y(o => yS(o.n))).style('fill', 'none').style('stroke', 'var(--ink-2)').style('stroke-width', 1.4);
  f.g.append('text').attr('class', 'annot halo').attr('x', x(show[show.length - 1].n)).attr('y', yS(show[show.length - 1].n) - 8).attr('text-anchor', 'end').text('days = miles');
  armArrival(el);
  return { sub: ['Your on-foot Eddington number is ', [String(E)], `: ${E} days of at least ${E} miles. ${fInt(need)} more day${need === 1 ? '' : 's'} of ${E + 1}+ miles reaches ${E + 1}. Orange marks it; the line is days = miles.`] };
}

// ---------- new ground ----------
export function drawGround(el: HTMLElement): Out {
  const ok = (w: any) => w && w.y >= S.y0 && w.y <= S.y1 && S.types.has(w.type);
  const out = (G.newGround || []).map((r: any) => ({ ...r, w: G.byId.get(r.id) })).filter((r: any) => ok(r.w)).map((r: any) => ({ ...r, d: r.w.d, cum: r.cum_new_ground_m / 1609.344, nw: r.new_ground_m / 1609.344 }));
  if (!out.length) return emptyState(el, 'No routes in range.');
  const f = frame(el, 260, { t: 14, r: 64, b: 26, l: 50 });
  const x = d3.scaleLinear(daySpan(), [0, f.iw]);
  const c0 = out[0].cum - out[0].nw, c1 = out[out.length - 1].cum;
  const yS = d3.scaleLinear([Math.max(0, c0 * 0.96), c1 * 1.04], [f.ih, 0]).nice();
  yGrid(f.g, yS, f.iw, 4, (v: number) => fInt(v) + ' mi');
  xAxis(f.g, x, f.ih, { values: yearTicks(F.years, daySpan()[0]), fmt: (v: number) => dayDate(v).getUTCFullYear() });
  f.g.append('path').datum(out).attr('class', 'a-fade').attr('d', d3.area().x(o => x(o.d)).y0(f.ih).y1(o => yS(o.cum)).curve(d3.curveStepAfter)).style('fill', 'var(--s3)').style('opacity', .14);
  f.g.append('path').datum(out).attr('class', 'a-line').attr('d', d3.line().x(o => x(o.d)).y(o => yS(o.cum)).curve(d3.curveStepAfter)).style('fill', 'none').style('stroke', 'var(--s3)').style('stroke-width', 2.2);
  const byY = d3.rollups(out, v => ({ nw: d3.sum(v, (o: any) => o.nw), mi: d3.sum(v, (o: any) => o.w.dist), end: v[v.length - 1] }), (o: any) => o.w.y);
  byY.forEach(([y, o]: any) => { f.g.append('circle').attr('cx', x(o.end.d)).attr('cy', yS(o.end.cum)).attr('r', 3.5).style('fill', 'var(--s3)').style('stroke', 'var(--panel)').style('stroke-width', 2); f.g.append('text').attr('class', 'dlabel mono halo a-fade').attr('x', x(o.end.d) - 4).attr('y', yS(o.end.cum) - 9).attr('text-anchor', 'end').style('font-size', '10.5px').text(`+${fInt(o.nw)}`); });
  const e = out[out.length - 1];
  f.g.append('text').attr('class', 'dlabel strong mono').attr('x', f.iw + 6).attr('y', yS(e.cum) + 4).text(`${fInt(e.cum)} mi`);
  const ch = f.g.append('line').attr('y1', 0).attr('y2', f.ih).style('stroke', 'var(--ink-3)').style('opacity', 0);
  f.svg.on('pointermove', (ev: any) => { const [px] = d3.pointer(ev, f.g.node()); const dd = x.invert(px); const o: any = out[Math.max(0, d3.bisector((o: any) => o.d).left(out, dd) - 1)] || out[0]; ch.attr('x1', x(o.d)).attr('x2', x(o.d)).style('opacity', .6); TIP.show(ev, fDate(o.d), [['Distinct ground so far', `${f1(o.cum)} mi`], ['New on this route', `${f1(o.nw)} mi of ${f1(o.w.dist)}`], ['Where', o.w.placeName || '—']]); })
    .on('pointerleave', () => { ch.style('opacity', 0); TIP.hide(); });
  armArrival(el);
  const lastY = byY[byY.length - 1][1];
  return {
    sub: [[`${fInt(e.cum)} miles of distinct ground`], ` on foot, everywhere you have walked. Labels show what each year added. In ${byY[byY.length - 1][0]}, ${d3.format('.1%')(lastY.nw / Math.max(1, lastY.mi))} of your miles were on ground you had never walked.`],
    table: () => ({ cols: [{ k: 'y', label: 'Year' }, { k: 'mi', label: 'Miles walked', num: true }, { k: 'nw', label: 'New ground', num: true }, { k: 's', label: 'Share new', num: true }], rows: byY.map(([y, o]: any) => ({ y, mi: fInt(o.mi), nw: f1(o.nw), s: d3.format('.1%')(o.nw / Math.max(1, o.mi)) })) }),
  };
}
