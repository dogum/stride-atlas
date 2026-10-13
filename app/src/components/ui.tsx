import { ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { useWatch } from '../store';
import type { Legend as LegendT, Out, Rich, TableSpec } from '../core';

// presentation mode draws every panel up front, so a scripted tour scrolls over a layout that no longer moves
export const EAGER = typeof location !== 'undefined' && new URLSearchParams(location.search).has('present');

export function RichText({ parts }: { parts?: Rich }) {
  if (!parts) return null;
  return <>{parts.map((p, i) => Array.isArray(p) ? <b key={i}>{p[0]}</b> : <span key={i}>{p}</span>)}</>;
}

export function Seg({ options, value, onPick, label }: { options: { key: any; label: string; disabled?: boolean }[]; value: any; onPick: (k: any) => void; label?: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(o => (
        <button key={String(o.key)} type="button" aria-pressed={o.key === value} disabled={o.disabled} onClick={() => onPick(o.key)}>{o.label}</button>
      ))}
    </div>
  );
}

export function LegendRow({ legend }: { legend?: LegendT }) {
  if (!legend || !legend.items.length) return null;
  return (
    <div className="legend">
      {legend.items.map(it => <span key={it.label}><i className={legend.kind === 'ln' ? 'ln' : legend.kind === 'dt' ? 'dt' : ''} style={{ ['--c' as any]: it.c }} />{it.label}</span>)}
    </div>
  );
}

function TableView({ spec }: { spec: TableSpec }) {
  return (
    <div className="tview">
      <table>
        <thead><tr>{spec.cols.map(c => <th key={c.k} className={c.num ? 'n' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>{spec.rows.map((r, i) => <tr key={i}>{spec.cols.map(c => <td key={c.k} className={c.num ? 'n' : ''}>{r[c.k]}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

type PanelProps = {
  id: string; cls: string; title: string; draw: (el: HTMLElement) => Out; watch?: string[]; tools?: ReactNode; foot?: ReactNode;
  legendFirst?: boolean; chartClass?: string; extraHead?: ReactNode;
};
export function Panel(p: PanelProps) {
  const v = useWatch(['filter', 'theme', 'size', 'data', ...(p.watch || [])]);
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [out, setOut] = useState<any>({});
  const [tab, setTab] = useState(false);
  // Panels redraw only when on screen (or about to be). Off-screen panels are marked dirty and redraw as they
  // scroll in, so a filter change costs the visible panels, not all forty.
  const vis = useRef(false), dirty = useRef(true), drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    if (!ref.current) return;
    dirty.current = false;
    let o: any = {};
    const t0 = performance.now();
    try { o = p.draw(ref.current) || {}; } catch (e) { console.error(p.id, e); }
    if (import.meta.env.DEV) ((window as any).__timings ||= {})[p.id] = Math.round(performance.now() - t0);
    setOut(o);
  };
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => { vis.current = e.isIntersecting; if (e.isIntersecting && dirty.current) drawRef.current(); }, { rootMargin: EAGER ? '100000px 0px' : '400px 0px' });
    io.observe(box.current!);
    return () => io.disconnect();
  }, []);
  useLayoutEffect(() => { if (vis.current) drawRef.current(); else dirty.current = true; }, [v]);
  return (
    <div className={`panel ${p.cls}`} id={`p-${p.id}`} ref={box}>
      <div className="p-head">
        <div className="tt"><h3>{p.title}</h3><p className="sub"><RichText parts={out.sub} /></p></div>
        <div className="p-tools">{p.tools}{p.extraHead}{out.table && <button className="tbtn" type="button" aria-pressed={tab} onClick={() => setTab(!tab)}>Table</button>}</div>
      </div>
      <LegendRow legend={out.legend} />
      <div className={'chart ' + (p.chartClass || '')} id={p.id} ref={ref} hidden={tab} />
      {tab && out.table && <TableView spec={out.table()} />}
      {p.foot && <div className="p-foot">{p.foot}</div>}
    </div>
  );
}

// chapter headers sit on contour lines, as in the mockup (a smooth synthetic field; decorative, no location)
function terrain(x: number, y: number) {
  return 128 + 15 * Math.sin(x / 720 + 1.3) * Math.cos(y / 880 - 0.4) + 7.5 * Math.sin((x + y) / 360 + 0.7) + 3.4 * Math.sin(x / 170) * Math.sin(y / 230 + 1.1)
    + 9 * Math.exp(-(((x + 4300) ** 2 + (y - 3700) ** 2) / (2 * 3300 ** 2))) * Math.sin(x / 140) * Math.sin(y / 190);
}
export function Topo({ idx }: { idx: number }) {
  const paths = useMemo(() => {
    const w = 900, ht = 150, gw = 90, gh = 15;
    const ox = -6000 + idx * 1700, oy = 3800 - idx * 900, sc = 9;
    const vals = new Float64Array(gw * gh); let mn = Infinity, mx = -Infinity;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const e = terrain(ox + i * sc * 10, oy - j * sc * 10) * 3.28084; vals[j * gw + i] = e; mn = Math.min(mn, e); mx = Math.max(mx, e); }
    const step = Math.max(2, (mx - mn) / 14);
    const cs = d3.contours().size([gw, gh]).thresholds(d3.range(mn + step / 2, mx, step))(vals as any);
    const path = d3.geoPath(d3.geoTransform({ point(x, y) { (this as any).stream.point(x / (gw - 1) * w, y / (gh - 1) * ht); } }));
    return cs.map((c, i) => ({ d: path(c as any) || '', major: i % 5 === 2 }));
  }, [idx]);
  return (
    <svg className="topo" viewBox="0 0 900 150" preserveAspectRatio="none" aria-hidden="true">
      {paths.map((p, i) => <path key={i} d={p.d} style={{ fill: 'none', stroke: p.major ? 'var(--edge-strong)' : 'var(--edge)', strokeWidth: p.major ? 1.2 : 0.8 }} vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}
export function ChHead({ idx, eyebrow, title, children, tools }: { idx: number; eyebrow: string; title: ReactNode; children?: ReactNode; tools?: ReactNode }) {
  return (
    <div className="ch-head">
      <Topo idx={idx} />
      <div><div className="eyebrow">{eyebrow}</div><h2>{title}</h2></div>
      {tools}
      <p>{children}</p>
    </div>
  );
}

export function useRaf(fn: () => void, deps: any[]) {
  useEffect(() => { const id = requestAnimationFrame(fn); return () => cancelAnimationFrame(id); }, deps);
}
