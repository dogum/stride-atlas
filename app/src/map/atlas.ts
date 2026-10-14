// Route atlas on deck.gl: every route as additive light over DEM contours, colour modes, timelapse, click-to-inspect.
// Port of mockup/src/app-map.js; rendering moves from canvas 2D to WebGL so all routes pan and zoom at 60 fps.
import { Deck, FlyToInterpolator, MapView, WebMercatorViewport } from '@deck.gl/core';
import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { DataFilterExtension } from '@deck.gl/extensions';
import * as d3_ from 'd3';
// D3 is used untyped in the ported chart code; everything around it is typed.
const d3: any = d3_;
import { F, G, GPS_TYPES, REG, S } from '../store';
import { MAP_RAMPS, MONTHS, dayDate, f1, fInt } from '../core';
import { loadContours, loadStreets } from '../data';
import { KINDS, msLabel, recentMilestone } from '../milestones';

const BG: [number, number, number, number] = [7, 12, 22, 255];
const ADD = { depthWriteEnabled: false, depthCompare: 'always', blend: true, blendColorOperation: 'add', blendColorSrcFactor: 'src-alpha', blendColorDstFactor: 'one', blendAlphaOperation: 'add', blendAlphaSrcFactor: 'one', blendAlphaDstFactor: 'one-minus-src-alpha' } as any;
const rgb = (s: string) => { const c = d3.color(s)!.rgb(); return [c.r, c.g, c.b]; };

// place -1 is everywhere at once (every cluster on one map)
const inPlace = (w: any) => S.place < 0 || w.place === S.place;

export type AtlasHooks = { onSelect: (w: any | null, px?: [number, number]) => void; onView: (v: any) => void; onPlay: (state: any) => void };

export class Atlas {
  deck: Deck | null = null;
  el: HTMLElement;
  hooks: AtlasHooks;
  routes: any[] = [];          // [{w, path: Float32Array (flat XY)}], one per contiguous part
  contours: any = null;
  streets: any = null;
  view: any = { longitude: 0, latitude: 20, zoom: 1.5, pitch: 0, bearing: 0 }; // replaced by a fit as soon as routes load
  sel: string | null = null;
  playing: any = null;
  filterMax = 1e9;
  trailMin = -1;
  paceRank = new Map<string, number>();
  alpha = 120;
  layerZoom = 0;

  constructor(el: HTMLElement, hooks: AtlasHooks) {
    this.el = el; this.hooks = hooks;
    this.deck = new Deck({
      parent: el, views: new MapView({ repeat: false }), initialViewState: this.view, controller: { doubleClickZoom: true, dragRotate: false, touchRotate: false },
      onViewStateChange: ({ viewState }: any) => {
        this.view = viewState; this.deck!.setProps({ viewState }); this.hooks.onView(viewState);
        if (Math.abs(viewState.zoom - this.layerZoom) > 0.3) this.render(); // line weight follows the zoom
        return viewState;
      },
      onClick: (info: any) => { if (this.playing) return; const w = info.object?.w || null; this.sel = w ? w.id : null; this.render(); this.hooks.onSelect(w, w ? [info.x, info.y] : undefined); },
      getCursor: ({ isHovering, isDragging }: any) => isDragging ? 'grabbing' : isHovering ? 'pointer' : 'crosshair',
      layers: [],
      pickingRadius: 6,
      useDevicePixels: Math.min(2, devicePixelRatio || 1),
    } as any);
    this.deck.setProps({ viewState: this.view });
    const c: HTMLCanvasElement | null = el.querySelector('canvas');
    if (c) c.setAttribute('aria-label', 'Map of every route, drawn as glowing lines');
  }

  // Geometry is built once per place (and share mode); year and activity filters run on the GPU through
  // DataFilterExtension, so a filter change is a uniform update instead of re-tessellating every route.
  geomKey = '';
  inFilter: any[] = [];
  ext = [new DataFilterExtension({ filterSize: 1, categorySize: 1 })];
  filterKey = '';
  setData() {
    const key = `${S.place}|${S.share}|${G.routeXY ? 1 : 0}`;
    if (key !== this.geomKey) {
      this.geomKey = key;
      const all = G.workouts.filter((w: any) => inPlace(w) && w.route && w.outdoor && !w.fragment && GPS_TYPES.includes(w.type));
      const xy = G.routeXY, gap = G.routeGap, sh = G.routeShare;
      const out: any[] = [];
      // split each route at excised drives (gap 3) and, in share mode, around points hidden by the privacy zone
      if (xy) for (const w of all) {
        const { off, n } = w.route;
        let start = -1;
        for (let i = 0; i <= n; i++) {
          const ok = i < n && (!S.share || (sh ? sh[off + i] === 1 : false)); // share mode without flags hides everything
          const brk = i < n && gap[off + i] === 3;
          if (start >= 0 && (!ok || brk)) { if (i - start >= 2) out.push({ w, path: xy.subarray((off + start) * 2, (off + i) * 2) }); start = -1; }
          if (ok && start < 0) start = i;
        }
      }
      this.routes = out;
    }
    const list = F.gps.filter((w: any) => inPlace(w) && w.route);
    this.inFilter = list;
    this.filterKey = `${S.y0}|${S.y1}|${[...S.types].sort().join(',')}`;
    this.paceRank = new Map();
    for (const t of GPS_TYPES) { const ws = list.filter((w: any) => w.type === t && isFinite(w.pace)).sort((p: any, q: any) => q.pace - p.pace); ws.forEach((w: any, i: number) => this.paceRank.set(w.id, ws.length > 1 ? i / (ws.length - 1) : 0.5)); }
    // same response as the mockup, with a lower floor: real routes repeat the same streets far more than synthetic ones
    this.alpha = Math.round(255 * Math.max(0.03, Math.min(0.55, 2.6 / Math.sqrt(Math.max(1, list.length)))));
    if (this.sel && !list.some((w: any) => w.id === this.sel)) this.sel = null;
    return list;
  }
  dayRange(): [number, number] {
    const a = Math.round((Date.UTC(S.y0, 0, 1) - G.D0) / G.DAY), b = Math.round((Date.UTC(S.y1 + 1, 0, 1) - G.D0) / G.DAY) - 1;
    return [a, Math.min(b, this.filterMax)];
  }
  colorFor(w: any): number[] {
    const m = S.colorBy;
    const span = Math.max(1, G.Y1 - G.Y0 + 1);
    let c: string;
    if (m === 'year') c = MAP_RAMPS.year(Math.min(1, ((w.y - G.Y0) + w.doy / 365) / span));
    else if (m === 'pace') c = MAP_RAMPS.pace(this.paceRank.get(w.id) ?? 0.5);
    else if (m === 'hr') c = w.hr ? MAP_RAMPS.hr(Math.max(0, Math.min(1, (w.hr - 88) / 75))) : '#55606f';
    else if (m === 'temp') c = w.temp != null ? MAP_RAMPS.temp(Math.max(0, Math.min(1, (w.temp - 20) / 75))) : '#55606f';
    else c = MAP_RAMPS.time(Math.max(0, Math.min(1, (w.hour - 5) / 16)));
    return rgb(c);
  }
  async setPlace(refit: boolean) {
    this.contours = S.basemap === 'contours' && S.place >= 0 ? await loadContours(S.place) : null;
    // the OSM network only covers the few miles around home
    this.streets = S.basemap === 'streets' && S.place === 0 ? await loadStreets() : null;
    const list = this.setData();
    if (refit) this.fit(list);
    this.render();
  }
  fit(list: any[]) {
    const r = this.el.getBoundingClientRect();
    const xs: number[] = [], ys: number[] = [];
    const ids = new Set(this.inFilter.map((w: any) => w.id));
    // everywhere: frame where routes start, so a few long trips far away do not shrink every cluster to a dot
    const starts = S.place < 0;
    const seen = new Set<string>();
    for (const o of this.routes) {
      if (!ids.has(o.w.id)) continue;
      const p = o.path;
      if (starts) { if (!seen.has(o.w.id)) { seen.add(o.w.id); xs.push(p[0]); ys.push(p[1]); } continue; }
      for (let i = 0; i < p.length; i += 8) { xs.push(p[i]); ys.push(p[i + 1]); }
    }
    let bb: number[];
    if (xs.length) { xs.sort((a, b) => a - b); ys.sort((a, b) => a - b); const q = (a: number[], p: number) => a[Math.floor(p * (a.length - 1))]; const lo = S.place < 0 ? 0.04 : S.place === 0 ? 0.015 : 0; bb = [q(xs, lo), q(ys, lo), q(xs, 1 - lo), q(ys, 1 - lo)]; }
    else { const p = G.places.find((p: any) => p.id === S.place); if (!p?.bbox) return; bb = p.bbox; }
    try {
      const vp = new WebMercatorViewport({ width: Math.max(300, r.width), height: Math.max(300, r.height) });
      // the presentation tour keeps the bottom clear for its captions
      const f = vp.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: REG.fitPad || { top: 70, bottom: 70, left: 40, right: 40 } } as any);
      // the presentation tour asks for one animated flight instead of a jump
      const fly = REG.flyNext; REG.flyNext = 0;
      this.view = { longitude: f.longitude, latitude: f.latitude, zoom: Math.min(16, f.zoom), pitch: 0, bearing: 0,
        ...(fly ? { transitionDuration: fly, transitionInterpolator: new FlyToInterpolator({ speed: 1.1 }), transitionEasing: (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2 } : { transitionDuration: 0 }) };
      this.deck!.setProps({ viewState: this.view });
      this.hooks.onView(this.view);
    } catch { /* zero-size during boot */ }
  }
  layers() {
    const L: any[] = [new SolidPolygonLayer({ id: 'bg', data: [{ p: [[-180, -85], [180, -85], [180, 85], [-180, 85]] }], getPolygon: (d: any) => d.p, getFillColor: BG })];
    if (this.contours && S.basemap === 'contours') {
      L.push(new PathLayer({ id: 'contours', data: this.contours.lines, getPath: (d: any) => d.path, positionFormat: 'XY', widthUnits: 'pixels',
        getWidth: (d: any) => d.major ? 1.1 : 0.6, getColor: (d: any) => [151, 165, 187, d.major ? 44 : 22], parameters: { depthWriteEnabled: false } } as any));
    }
    if (this.streets && S.basemap === 'streets') {
      L.push(new PathLayer({ id: 'streets', data: this.streets.edges, getPath: (d: any) => d.path, positionFormat: 'XY', widthUnits: 'pixels', widthMinPixels: 0.5,
        getWidth: (d: any) => d.cls === 0 ? 1.1 : 0.8, getColor: (d: any) => d.cls === 0 ? [151, 165, 187, 70] : d.cls === 1 ? [25, 158, 112, 60] : [151, 165, 187, 26],
        parameters: { depthWriteEnabled: false } } as any));
    }
    const types = [...S.types];
    const filt = { extensions: this.ext, getFilterValue: (d: any) => d.w.d, getFilterCategory: (d: any) => d.w.type, filterCategories: types,
      updateTriggers: { getFilterValue: this.geomKey, getFilterCategory: this.geomKey } };
    const base = { data: this.routes, getPath: (d: any) => d.path, positionFormat: 'XY', widthUnits: 'pixels', jointRounded: true, capRounded: true };
    // additive blending would scramble the colour-coded ids in deck's picking pass, so clicks go to an invisible,
    // wider copy of the routes drawn with normal blending, under the glow so it cannot dim it
    if (!this.playing) L.push(new PathLayer({ id: 'routes-pick', ...base, ...filt, filterRange: this.dayRange(), getWidth: 7, getColor: [0, 0, 0, 1], pickable: true } as any));
    // zoomed out, a route is a few pixels long: draw it heavier and brighter so a region still reads as light
    const z = this.view.zoom ?? 12, boost = Math.max(1, Math.min(3.5, 1 + (11.5 - z) * 0.55));
    // the video tour opens on a whole region, where one route is a speck: heavier and brighter still
    const pres = !!REG.fitPad && z < 11;
    this.layerZoom = z;
    L.push(new PathLayer({
      id: 'routes', ...base, ...filt, filterRange: this.dayRange(), getWidth: 1.4 * Math.min(pres ? 2.6 : 1.6, boost), widthMinPixels: 0.9, opacity: Math.min(0.9, this.alpha / 255 * boost * (pres ? 2.2 : 1)),
      getColor: (d: any) => this.colorFor(d.w), parameters: ADD, pickable: false,
      updateTriggers: { ...filt.updateTriggers, getColor: [S.colorBy, this.geomKey, S.colorBy === 'pace' ? this.filterKey : ''] },
    } as any));
    if (this.playing && this.trailMin >= 0) {
      L.push(new PathLayer({ id: 'trail', ...base, ...filt, filterRange: [this.trailMin, this.filterMax], getWidth: pres ? 3 : 1.6, getColor: [255, 241, 230, pres ? 170 : 120], parameters: ADD } as any));
    }
    if (this.sel && !this.playing) {
      const sel = this.routes.filter(o => o.w.id === this.sel);
      L.push(new PathLayer({ id: 'sel-glow', ...base, data: sel, getWidth: 9, getColor: [255, 171, 120, 70] } as any));
      L.push(new PathLayer({ id: 'sel', ...base, data: sel, getWidth: 2.4, getColor: [255, 241, 230, 255] } as any));
    }
    return L;
  }
  render() { this.deck?.setProps({ layers: this.layers() }); }
  resize() { this.deck?.redraw('resize'); }

  // timelapse: routes appear in date order over about 13 seconds (the video tour asks for less), recent ones glowing white
  play(reduced: boolean, secs = 13) {
    if (this.playing) { this.stop(); return; }
    this.sel = null; this.hooks.onSelect(null);
    const list = this.inFilter.slice().sort((a: any, b: any) => a.d - b.d || a.hour - b.hour);
    if (!list.length) return;
    const d0 = list[0].d - 1, d1 = list[list.length - 1].d;
    this.trailMin = d0;
    const t0 = performance.now();
    this.playing = { raf: 0 };
    const cum = d3.cumsum(list, (w: any) => w.dist);
    const step = () => {
      const k = reduced ? 1 : Math.min(1, (performance.now() - t0) / (secs * 1000));
      const cur = d0 + (d1 - d0) * k;
      this.filterMax = cur; this.trailMin = cur - Math.max(10, (d1 - d0) / 60);
      this.render();
      const i = d3.bisector((w: any) => w.d).right(list, cur);
      const dt = dayDate(Math.max(0, Math.floor(cur)));
      // a milestone the replay has just passed stays under the date for a moment
      const ms = recentMilestone(cur, Math.max(20, (d1 - d0) / 12));
      this.hooks.onPlay({ on: true, date: `${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`, sub: `${fInt(i)} routes · ${fInt(i ? cum[i - 1] : 0)} mi`,
        note: ms && !(S.share && !ms.public) ? msLabel(ms) : null, noteC: ms ? KINDS[ms.kind].c : null });
      if (k < 1) this.playing.raf = requestAnimationFrame(step);
      else { this.playing = null; this.trailMin = -1; setTimeout(() => { this.filterMax = 1e9; this.render(); this.hooks.onPlay({ on: false }); }, 1200); }
    };
    this.playing.raf = requestAnimationFrame(step);
  }
  // an empty map, for the frame before a replay starts
  blank() { this.stop(); this.sel = null; this.filterMax = -1e9; this.render(); }
  stop() {
    if (!this.playing) { if (this.filterMax < 0) { this.filterMax = 1e9; this.render(); } return; }
    cancelAnimationFrame(this.playing.raf); this.playing = null; this.trailMin = -1; this.filterMax = 1e9; this.render(); this.hooks.onPlay({ on: false });
  }
  destroy() { this.stop(); this.deck?.finalize(); this.deck = null; }
}

export const MODES = [{ key: 'year', label: 'Year' }, { key: 'pace', label: 'Pace' }, { key: 'hr', label: 'Heart rate' }, { key: 'temp', label: 'Temperature' }, { key: 'time', label: 'Time of day' }];
export function legendFor(mode: string) {
  return ({ year: ['Year', String(G.Y0), String(G.Y1)], pace: ['Pace, within each activity', 'slower', 'faster'], hr: ['Average heart rate', '88 bpm', '163 bpm'], temp: ['Temperature at start', '20°F', '95°F'], time: ['Start time', '5 am', '9 pm'] } as any)[mode];
}
export function scaleFor(view: any) {
  const mPerPx = 156543.03392 * Math.cos(view.latitude * Math.PI / 180) / Math.pow(2, view.zoom);
  const pxPerMi = 1609.344 / mPerPx;
  const opts = [0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100]; let mi = opts[0]; for (const o of opts) if (o * pxPerMi <= 120) mi = o;
  return { mi, px: Math.round(mi * pxPerMi) };
}
export { f1 };
