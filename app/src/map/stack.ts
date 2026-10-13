// Space and time: the routes around one place in 3D. Height is the date (a space-time cube: loops walked for years rise
// as towers, trips are thin slabs, quiet months are gaps), the time of day (each route climbs as the clock runs), or
// the ground's elevation (routes draped over the place's contours, exaggerated so hills read). The GPU interpolates
// between heights, so a switch is one smooth move. Same light, filters and share mode as the atlas.
import { Deck, OrbitView, COORDINATE_SYSTEM } from '@deck.gl/core';
import { PathLayer, TextLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, GPS_TYPES, REG, S } from '../store';
import { MAP_RAMPS, ft, fInt } from '../core';
import { loadContours } from '../data';

export const STACK_MODES = [{ key: 'date', label: 'Date' }, { key: 'hour', label: 'Time of day' }, { key: 'ele', label: 'Elevation' }];
export type StackMode = 'date' | 'hour' | 'ele';

const ADD = { depthWriteEnabled: false, depthCompare: 'always', blend: true, blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one', blendAlphaOperation: 'add', blendAlphaSrcFactor: 'one', blendAlphaDstFactor: 'one-minus-src-alpha' } as any;
const FLAT = { depthWriteEnabled: false, depthCompare: 'always' } as any;
const rgb = (s: string) => { const c = d3.color(s)!.rgb(); return [c.r, c.g, c.b]; };
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const H = 150;      // height of the stack in scene units
const HALF = 125;   // half the floor's side: routes are scaled so most of them fit inside ±100

// which place the 3D view shows: the atlas's place, or home when the atlas shows everywhere
export function stackPlace(): number {
  const has = (p: number) => G.workouts.some((w: any) => w.place === p && w.route && w.outdoor);
  if (S.place >= 0 && has(S.place)) return S.place;
  if (has(0)) return 0;
  return (G.places || []).find((p: any) => has(p.id))?.id ?? 0;
}

type Piece = { w: any; date: Float32Array; hour: Float32Array; ele: Float32Array; flat: Float32Array };
type Guide = { z: Record<StackMode, number>; label: string; mode: StackMode };

export class Stack {
  deck: Deck | null = null;
  el: HTMLElement;
  mode: StackMode = 'date';
  pieces: Piece[] = [];
  contours: { date: Float32Array; hour: Float32Array; ele: Float32Array; flat: Float32Array; major: boolean }[] = [];
  guides: Guide[] = [];
  key = '';
  view: any = { target: [0, 0, H * 0.42], rotationX: 26, rotationOrbit: -32, zoom: 1, minZoom: -2, maxZoom: 6 };
  exag = 1;
  info: any = {};
  spin = 0; idleUntil = 0; visible = false; reduced = false;
  onHover: (w: any | null, x: number, y: number) => void = () => {};
  onClick: (w: any) => void = () => {};

  constructor(el: HTMLElement) {
    this.el = el;
    this.deck = new Deck({
      parent: el, views: new OrbitView({ orbitAxis: 'Z', fovy: 38 } as any), initialViewState: this.view,
      controller: { scrollZoom: false, doubleClickZoom: true, inertia: 300 } as any,
      onViewStateChange: ({ viewState, interactionState }: any) => {
        this.view = { ...viewState, rotationX: Math.max(4, Math.min(80, viewState.rotationX)) };
        if (interactionState?.isDragging || interactionState?.isRotating || interactionState?.isZooming || interactionState?.isPanning) this.idleUntil = performance.now() + 5000;
        this.deck!.setProps({ viewState: this.view });
        return this.view;
      },
      onHover: (info: any) => this.onHover(info.object?.w ?? null, info.x, info.y),
      onClick: (info: any) => { if (info.object?.w) this.onClick(info.object.w); },
      getCursor: ({ isHovering, isDragging }: any) => isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab',
      layers: [], pickingRadius: 5, useDevicePixels: Math.min(2, devicePixelRatio || 1),
    } as any);
    this.deck.setProps({ viewState: this.view });
    el.querySelector('canvas')?.setAttribute('aria-label', 'Routes around one place in 3D, stacked by date, time of day or elevation');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const tick = () => {
      this.spin = requestAnimationFrame(tick);
      // a slow turn while nobody is touching it, so the third axis reads without a drag
      if (!this.visible || this.reduced || REG.stackHold || performance.now() < this.idleUntil || !this.pieces.length) return;
      this.view = { ...this.view, rotationOrbit: this.view.rotationOrbit + (REG.stackSpin ?? 0.07), transitionDuration: 0 };
      this.deck?.setProps({ viewState: this.view });
    };
    this.spin = requestAnimationFrame(tick);
  }

  async build(): Promise<boolean> {
    const place = stackPlace();
    const key = `${place}|${S.share}|${G.routeEle ? 1 : 0}`;
    if (key === this.key) return !!this.pieces.length;
    this.key = key;
    const xy = G.routeXY, gap = G.routeGap, sh = G.routeShare, ele = G.routeEle, tim = G.routeTime;
    const ws = G.workouts.filter((w: any) => w.place === place && w.route && w.outdoor && !w.fragment && GPS_TYPES.includes(w.type));
    if (!xy || !ws.length) { this.pieces = []; this.render(); return false; }
    // local metres around the middle of the routes, scaled so 98% of points sit within ±100 units
    const lon: number[] = [], lat: number[] = [];
    for (const w of ws) for (let i = 0; i < w.route.n; i += 6) { lon.push(xy[(w.route.off + i) * 2]); lat.push(xy[(w.route.off + i) * 2 + 1]); }
    lon.sort((a, b) => a - b); lat.sort((a, b) => a - b);
    const q = (a: number[], p: number) => a[Math.floor(p * (a.length - 1))];
    const lon0 = (q(lon, 0.02) + q(lon, 0.98)) / 2, lat0 = (q(lat, 0.02) + q(lat, 0.98)) / 2;
    const mx = Math.cos(lat0 * Math.PI / 180) * 111320, my = 110574;
    const R = Math.max(150, (q(lon, 0.98) - q(lon, 0.02)) / 2 * mx, (q(lat, 0.98) - q(lat, 0.02)) / 2 * my);
    const k = 100 / R;
    const d0 = d3.min(ws, (w: any) => w.d), d1 = d3.max(ws, (w: any) => w.d) + 1;
    // elevation: the ground under these routes, from the 2nd to the 98th percentile, exaggerated to read as relief
    const es: number[] = [];
    if (ele) for (const w of ws) for (let i = 0; i < w.route.n; i += 4) { const v = ele[w.route.off + i]; if (v !== -32768) es.push(v / 2); }
    es.sort((a, b) => a - b);
    const cont = await loadContours(place);
    // contours clipped to the floor: a map at the bottom, terrain in the elevation view
    const clipped: { xy: number[]; level: number; major: boolean }[] = [];
    for (const l of cont?.lines ?? []) {
      const p = l.path; let run: number[] = [];
      const push = () => { if (run.length >= 6) clipped.push({ xy: run, level: l.level, major: l.major }); run = []; };
      for (let i = 0; i < p.length; i += 2) {
        const x = (p[i] - lon0) * mx * k, y = (p[i + 1] - lat0) * my * k;
        if (Math.abs(x) > HALF || Math.abs(y) > HALF) { push(); continue; }
        run.push(x, y);
      }
      push();
    }
    // the elevation view's floor is the lowest ground on it, routes or contours; its top the highest
    const e0 = es.length ? q(es, 0.02) : 0, e1 = es.length ? q(es, 0.98) : 1;
    const levels = clipped.map(c => c.level);
    const base = Math.min(e0, levels.length ? Math.min(...levels) : e0), top = Math.max(e1, levels.length ? Math.max(...levels) : e1);
    const relief = Math.max(5, top - base);
    this.exag = Math.max(1, Math.min(30, Math.round((H * 0.6) / (relief * k))));
    const zEle = (m: number) => Math.max(0, (m - base) * k * this.exag);
    const zDate = (w: any) => (w.d - d0 + w.hour / 24) / (d1 - d0) * H;
    const pieces: Piece[] = [];
    for (const w of ws) {
      const { off, n } = w.route;
      let start = -1, lastE = NaN;
      const flush = (a: number, b: number) => {
        const m = b - a; if (m < 2) return;
        const P = { w, date: new Float32Array(m * 3), hour: new Float32Array(m * 3), ele: new Float32Array(m * 3), flat: new Float32Array(m * 3) };
        const zd = zDate(w);
        for (let j = 0; j < m; j++) {
          const i = off + a + j, x = (xy[i * 2] - lon0) * mx * k, y = (xy[i * 2 + 1] - lat0) * my * k;
          const e = ele && ele[i] !== -32768 ? ele[i] / 2 : NaN; if (isFinite(e)) lastE = e;
          const hr = w.hour + (tim ? tim[i] * 2 / 3600 : 0);
          P.date.set([x, y, zd], j * 3); P.hour.set([x, y, Math.min(26, hr) / 24 * H], j * 3);
          P.ele.set([x, y, zEle(isFinite(lastE) ? lastE : e0)], j * 3); P.flat.set([x, y, 0], j * 3);
        }
        pieces.push(P);
      };
      // the view is a model of one place: pieces stop at the edge of the floor
      const inside = (i: number) => Math.abs((xy[i * 2] - lon0) * mx * k) <= HALF && Math.abs((xy[i * 2 + 1] - lat0) * my * k) <= HALF;
      for (let i = 0; i <= n; i++) {
        const ok = i < n && (!S.share || (sh ? sh[off + i] === 1 : false)) && inside(off + i);
        const brk = i < n && gap[off + i] === 3;
        if (start >= 0 && (!ok || brk)) { flush(start, i); start = -1; }
        if (ok && start < 0) start = i;
      }
    }
    this.pieces = pieces;
    this.contours = clipped.map(c => {
      const m = c.xy.length / 2, flat = new Float32Array(m * 3), up = new Float32Array(m * 3), z = zEle(c.level);
      for (let j = 0; j < m; j++) { flat.set([c.xy[j * 2], c.xy[j * 2 + 1], 0], j * 3); up.set([c.xy[j * 2], c.xy[j * 2 + 1], z], j * 3); }
      return { date: flat, hour: flat, ele: up, flat, major: c.major };
    });
    // guides: a frame and a label on the vertical axis at each year, each six hours, and round elevations
    const G2: Guide[] = [];
    const zero = { date: 0, hour: 0, ele: 0 };
    for (let y = new Date(G.D0 + d0 * 864e5).getUTCFullYear() + 1; ; y++) {
      const d = Math.round((Date.UTC(y, 0, 1) - G.D0) / 864e5); if (d >= d1) break;
      G2.push({ z: { ...zero, date: (d - d0) / (d1 - d0) * H }, label: String(y), mode: 'date' });
    }
    for (const h of [0, 6, 12, 18, 24]) G2.push({ z: { ...zero, hour: h / 24 * H }, label: h === 0 || h === 24 ? 'midnight' : h === 12 ? 'noon' : h < 12 ? `${h} am` : `${h - 12} pm`, mode: 'hour' });
    const topFt = ft(base + (H * 1.05) / (k * this.exag)), baseFt = ft(base);
    const stepFt = [50, 100, 200, 250, 500, 1000, 2000].find(s => (topFt - baseFt) / s <= 6) ?? 5000;
    for (let f = Math.ceil(baseFt / stepFt) * stepFt; f <= Math.max(ft(top), baseFt + stepFt); f += stepFt) G2.push({ z: { ...zero, ele: zEle(f / 3.28084) }, label: `${fInt(f)} ft`, mode: 'ele' });
    this.guides = G2;
    const pl = (G.places || []).find((p: any) => p.id === place);
    this.info = { place, name: place === 0 ? 'home' : (pl?.name || '').split(',')[0], n: ws.length, d0, d1, exag: this.exag, sideMi: 2 * HALF / k / 1609.344 };
    this.fit();
    this.render();
    return true;
  }

  fit() {
    const r = this.el.getBoundingClientRect();
    // the video tour fills the frame and keeps the stack above its captions
    const pres = !!REG.fitPad;
    const s = Math.min(r.width * (r.height > r.width ? 1.1 : 1), r.height * (pres ? 1.6 : 1.2));
    this.view = { ...this.view, target: [0, 0, H * (pres ? 0.36 : 0.4)], zoom: Math.log2(Math.max(200, s) / (pres ? 400 : 380)), transitionDuration: 0 };
    this.deck?.setProps({ viewState: this.view });
  }

  setMode(m: StackMode) { if (m === this.mode) return; this.mode = m; this.render(); }

  colorFor(w: any): number[] {
    if (this.mode === 'hour') return rgb(MAP_RAMPS.time(Math.max(0, Math.min(1, (w.hour - 5) / 16))));
    const span = Math.max(1, G.Y1 - G.Y0 + 1);
    return rgb(MAP_RAMPS.year(Math.min(1, ((w.y - G.Y0) + w.doy / 365) / span)));
  }

  render() {
    if (!this.deck) return;
    const m = this.mode, n = F?.gps.filter((w: any) => w.place === this.info.place).length || 1;
    const alpha = Math.max(0.025, Math.min(0.7, 1.6 / Math.sqrt(n)));
    const a = Math.round((Date.UTC(S.y0, 0, 1) - G.D0) / 864e5), b = Math.round((Date.UTC(S.y1 + 1, 0, 1) - G.D0) / 864e5) - 1;
    const filt = { extensions: [new DataFilterExtension({ filterSize: 1, categorySize: 1 })], getFilterValue: (d: any) => d.w.d, getFilterCategory: (d: any) => d.w.type,
      filterCategories: [...S.types], filterRange: [a, b], updateTriggers: { getFilterValue: this.key, getFilterCategory: this.key } };
    const move = { getPath: { duration: 1500, easing: easeInOut } };
    const base = { coordinateSystem: COORDINATE_SYSTEM.CARTESIAN, positionFormat: 'XYZ', widthUnits: 'pixels', jointRounded: true, capRounded: true };
    const frame = (z: number) => [[-HALF, -HALF, z], [HALF, -HALF, z], [HALF, HALF, z], [-HALF, HALF, z], [-HALF, -HALF, z]];
    const guides = this.guides.filter(g => g.mode === m);
    const L: any[] = [
      new PathLayer({ id: 'floor', ...base, data: [{ p: frame(0) }], getPath: (d: any) => d.p, getWidth: 1, getColor: [151, 165, 187, 90], parameters: FLAT } as any),
      new PathLayer({ id: 'contours', ...base, data: this.contours, getPath: (d: any) => d[m], getWidth: (d: any) => d.major ? 1 : 0.6,
        getColor: (d: any) => [151, 165, 187, m === 'ele' ? (d.major ? 110 : 60) : (d.major ? 40 : 20)], parameters: FLAT,
        transitions: { ...move, getColor: 900 }, updateTriggers: { getPath: m, getColor: m } } as any),
      new PathLayer({ id: 'guides', ...base, data: guides, getPath: (d: any) => frame(d.z[m]), getWidth: 0.8, getColor: [151, 165, 187, 34], parameters: FLAT, updateTriggers: { getPath: m } } as any),
      new PathLayer({ id: 'axis', ...base, data: [{ p: [[-HALF, -HALF, 0], [-HALF, -HALF, m === 'ele' ? Math.max(...guides.map(g => g.z.ele), 10) : H]] }], getPath: (d: any) => d.p, getWidth: 1, getColor: [151, 165, 187, 110], parameters: FLAT, updateTriggers: { getPath: m } } as any),
      // the shadow on the floor: where, without when
      new PathLayer({ id: 'shadow', ...base, ...filt, data: this.pieces, getPath: (d: any) => d.flat, getWidth: 1, widthMinPixels: 0.6, opacity: alpha * 0.07,
        getColor: [151, 165, 187], parameters: ADD } as any),
      new PathLayer({ id: 'pick', ...base, ...filt, data: this.pieces, getPath: (d: any) => d[m], getWidth: 6, getColor: [0, 0, 0, 1], pickable: true,
        transitions: move, updateTriggers: { ...filt.updateTriggers, getPath: m } } as any),
      new PathLayer({ id: 'routes', ...base, ...filt, data: this.pieces, getPath: (d: any) => d[m], getWidth: 1.2, widthMinPixels: 0.8, opacity: alpha,
        getColor: (d: any) => this.colorFor(d.w), parameters: ADD, transitions: { ...move, getColor: 900 },
        updateTriggers: { ...filt.updateTriggers, getPath: m, getColor: [m, this.key] } } as any),
      new TextLayer({ id: 'labels', ...base, positionFormat: undefined, data: guides, getPosition: (d: any) => [-HALF - 6, -HALF - 6, d.z[m]], getText: (d: any) => d.label,
        getSize: 12, getColor: [195, 205, 219, 210], fontFamily: '"Overpass Mono Variable", ui-monospace, monospace', fontWeight: 500,
        getTextAnchor: 'end', getAlignmentBaseline: 'center', characterSet: 'auto', parameters: FLAT, updateTriggers: { getPosition: m } } as any),
    ];
    this.deck.setProps({ layers: L });
  }
  resize() { this.deck?.redraw('resize'); }
  destroy() { cancelAnimationFrame(this.spin); this.deck?.finalize(); this.deck = null; }
}
