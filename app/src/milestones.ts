// Life milestones (a child born, working from home, an injury), drawn faintly on every chart with a time axis.
// Source of truth: data/milestones.yaml. With `make dev` the editor reads and writes it through the dev server
// (vite.config.ts → python -m stride.milestones); a static build (the public demo) keeps edits in this browser.
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { G, S, emit } from './store';
export const msFile = () => `${G.meta?.data_dir || 'data'}/milestones.yaml`;
import { MONTHS, TIP, dayDate } from './core';
import { DATA_BASE } from './data';

export const KINDS: Record<string, { label: string; c: string }> = {
  family: { label: 'Family', c: '#e47aa8' }, work: { label: 'Work', c: '#6da7ec' }, home: { label: 'Home', c: '#3fbf8f' },
  health: { label: 'Health', c: '#e66767' }, travel: { label: 'Travel', c: '#f0b54a' }, other: { label: 'Other', c: '#a3adbd' },
};
export type Milestone = { id: number; date: string; end?: string; label: string; kind: string; public: boolean; precision: 'day' | 'month'; d: number; d2?: number };
export const MS = { list: [] as Milestone[], writable: false, local: false, loaded: false };
const LS = 'stride-milestones';
const dayOf = (iso: string) => Math.round((Date.parse(iso.slice(0, 10) + 'T00:00:00Z') - G.D0) / G.DAY);

function set(items: any[]) {
  MS.list = (items || []).filter(m => m?.date && m?.label).map((m: any, i: number) => ({
    id: i, date: m.date, end: m.end || undefined, label: m.label, kind: KINDS[m.kind] ? m.kind : 'other', public: !!m.public,
    precision: (m.precision === 'month' ? 'month' : 'day') as 'day' | 'month', d: dayOf(m.date), d2: m.end ? dayOf(m.end) : undefined,
  })).sort((a, b) => a.d - b.d);
  MS.loaded = true;
  emit('milestones', 'filter');
}

export async function loadMilestones() {
  // the dev server can read and write data/milestones.yaml; a static build reads the exported JSON
  try {
    const r = await fetch('/__stride/milestones');
    if (r.ok && (r.headers.get('content-type') || '').includes('json')) { MS.writable = true; set(await r.json()); return; }
  } catch { /* not the dev server */ }
  let items: any[] = [];
  try { items = await fetch(DATA_BASE + 'milestones.json').then(r => (r.ok ? r.json() : [])); } catch { /* none */ }
  try { const ls = localStorage.getItem(LS); if (ls) { items = JSON.parse(ls); MS.local = true; } } catch { /* private mode */ }
  set(items);
}

export async function saveMilestones(items: any[]): Promise<string> {
  const clean = items.map(({ date, end, label, kind, public: pub, precision }) => ({ date: precision === 'month' ? String(date).slice(0, 7) : date, end: end || undefined, label, kind, public: !!pub }));
  if (MS.writable) {
    const r = await fetch('/__stride/milestones', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(clean) });
    if (!r.ok) throw new Error(await r.text());
    set(await r.json());
    return `Saved to ${msFile()}`;
  }
  try { localStorage.setItem(LS, JSON.stringify(clean.map(m => ({ ...m, date: m.date.length === 7 ? m.date + '-01' : m.date, precision: m.date.length === 7 ? 'month' : 'day' })))); } catch { /* private mode */ }
  MS.local = true;
  set(JSON.parse(localStorage.getItem(LS) || '[]'));
  return 'Saved in this browser only';
}

// share mode keeps the marks but hides the words, unless a milestone is marked public
export const msLabel = (m: Milestone) => (S.share && !m.public ? 'Milestone' : m.label);
export const msWhen = (m: Milestone) => {
  const f = (d: number) => { const t = dayDate(d); return m.precision === 'month' ? `${MONTHS[t.getUTCMonth()]} ${t.getUTCFullYear()}` : `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`; };
  return m.d2 != null ? `${f(m.d)} to ${f(m.d2)}` : f(m.d);
};
export const showMs = () => S.showMilestones !== false && MS.list.length > 0;

// Faint lines (a day) and bands (a period) behind a chart whose x maps day numbers, with a small marker in the top
// margin to hover. `labels` writes the label beside the marker where there is room.
export function drawMilestones(g: any, x: any, ih: number, opts: { labels?: boolean; y0?: number; marks?: boolean } = {}) {
  if (!showMs()) return;
  const [r0, r1] = x.range(), clampX = (v: number) => Math.max(r0, Math.min(r1, v));
  const back = g.insert('g', ':first-child').attr('class', 'ms-back').attr('pointer-events', 'none');
  const front = g.append('g').attr('class', 'ms-front');
  const shown = MS.list.filter(m => { const a = x(m.d), b = m.d2 != null ? x(m.d2) : a; return b >= r0 - 1 && a <= r1 + 1; });
  const xs = shown.map(m => clampX(x(m.d)));
  shown.forEach((m, i) => {
    const a = x(m.d), b = m.d2 != null ? x(m.d2) : null;
    const c = KINDS[m.kind].c;
    if (b != null) back.append('rect').attr('x', clampX(a)).attr('width', Math.max(1, clampX(b) - clampX(a))).attr('y', 0).attr('height', ih).style('fill', c).style('opacity', 0.07);
    if (a >= r0 && a <= r1) back.append('line').attr('x1', a).attr('x2', a).attr('y1', 0).attr('y2', ih).style('stroke', c).style('stroke-width', 1).style('stroke-dasharray', '2 3').style('opacity', 0.75);
    if (opts.marks === false) return;
    const mx = clampX(a), my = (opts.y0 ?? 0) - 3;
    const mk = front.append('g').attr('class', 'ms-mark').attr('transform', `translate(${mx},${my})`).style('cursor', 'default');
    mk.append('path').attr('d', 'M0,-4 L4,0 L0,4 L-4,0Z').style('fill', c).style('stroke', 'var(--panel)').style('stroke-width', 1.2);
    mk.append('rect').attr('x', -7).attr('y', -7).attr('width', 14).attr('height', 14).style('fill', 'transparent');
    mk.on('pointermove', (ev: any) => { ev.stopPropagation(); TIP.show(ev, msLabel(m), [[KINDS[m.kind].label, msWhen(m), c]]); }).on('pointerleave', (ev: any) => { ev.stopPropagation(); TIP.hide(); });
    if (opts.labels && !(S.share && !m.public)) {
      // the label runs up to the next marker; shortened to fit, left out when there is no room for a few letters
      const room = (i + 1 < xs.length ? xs[i + 1] : r1 + 30) - mx - 14, cw = 6.3;
      const n = Math.floor(room / cw);
      if (n >= 6) front.append('text').attr('class', 'ms-label').attr('x', mx + 7).attr('y', my + 3.5).text(m.label.length > n ? m.label.slice(0, n - 1).trimEnd() + '…' : m.label).style('fill', c);
    }
  });
}

// the milestone whose date the cursor of a replay has just passed, for the atlas counter
export function recentMilestone(cur: number, window: number): Milestone | null {
  if (!showMs()) return null;
  let best: Milestone | null = null;
  for (const m of MS.list) if (m.d <= cur && cur - m.d <= window) best = m;
  return best;
}

