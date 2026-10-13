// Load the pipeline's exports (Parquet via hyparquet, JSON, binary route buffers) and build the
// same object shapes the mockup's chart code expects. SI comes in; imperial display fields are derived here.
import { parquetReadObjects } from 'hyparquet';
import { G, S } from './store';
import { COND, MI, degF, ft, mph } from './core';

const DAY = 864e5;
// the app's own data folder, wherever the build is served from
export const DATA_BASE = import.meta.env.BASE_URL + 'data/';
const base = DATA_BASE;

async function pq(name: string): Promise<any[]> {
  const res = await fetch(base + name);
  if (!res.ok) return [];
  const buf = await res.arrayBuffer();
  return parquetReadObjects({ file: buf }) as Promise<any[]>;
}
async function js(name: string): Promise<any> {
  const res = await fetch(base + name);
  return res.ok ? res.json() : null;
}

const HARDWARE: Record<string, string> = {
  'Watch4,1': 'Apple Watch Series 4', 'Watch4,2': 'Apple Watch Series 4', 'Watch4,3': 'Apple Watch Series 4', 'Watch4,4': 'Apple Watch Series 4',
  'Watch7,5': 'Apple Watch Ultra 2', 'iPhone10,6': 'iPhone X', 'iPhone10,3': 'iPhone X', 'iPhone14,3': 'iPhone 13 Pro Max', 'iPhone18,2': 'iPhone 17 Pro Max',
  fr920xt: 'Garmin Forerunner 920XT',
};
const fin = (x: any) => (x == null || !isFinite(x) ? null : +x);

function dayParts(iso: string) {
  const t = Date.parse(iso + 'T00:00:00Z');
  const dt = new Date(t);
  const y = dt.getUTCFullYear(), m = dt.getUTCMonth(), dom = dt.getUTCDate(), dow = dt.getUTCDay();
  const doy = Math.round((t - Date.UTC(y, 0, 1)) / DAY);
  return { d: Math.round((t - G.D0) / DAY), y, m, dom, dow, doy };
}

export async function loadCore(progress: (s: string) => void) {
  progress('Reading your workouts');
  const [meta, wRows, dRows, sunRows] = await Promise.all([js('meta.json'), pq('workouts.parquet'), pq('daily.parquet'), pq('sun_home.parquet')]);
  G.meta = meta;
  const yMin = meta?.year_min ?? 2018;
  G.D0 = Date.UTC(yMin, 0, 1);
  G.DAY = DAY;
  const last = dRows.length ? dRows[dRows.length - 1].date : '2026-12-31';
  G.lastISO = last;
  G.NDAYS = Math.round((Date.parse(last + 'T00:00:00Z') - G.D0) / DAY) + 1;
  const lastY = +last.slice(0, 4);
  G.years = Array.from({ length: lastY - yMin + 1 }, (_, i) => yMin + i);
  G.Y0 = yMin; G.Y1 = lastY;
  S.y0 = yMin; S.y1 = lastY;
  G.lastDay = dayParts(last);

  // ---- sun at home, by date
  G.sunByDate = new Map<string, any>();
  for (const r of sunRows) G.sunByDate.set(r.date, r);
  const refYear = lastY - 1;
  G.sunRef = (doy: number) => {
    const dt = new Date(Date.UTC(refYear, 0, 1) + Math.min(364, doy) * DAY).toISOString().slice(0, 10);
    const r = G.sunByDate.get(dt);
    return r ? { rise: r.sunrise_h, set: r.sunset_h } : { rise: 6, set: 18 };
  };
  G.sunRefYear = refYear;

  // ---- places
  G.places = (meta?.places ?? []).filter((p: any) => p.bbox);
  G.placeName = new Map(G.places.map((p: any) => [p.id, p.name]));

  // ---- workouts
  const W: any[] = [];
  for (const r of wRows) {
    const p = dayParts(r.date);
    if (p.y < yMin) continue;
    const dist = (r.distance_m ?? 0) / MI;
    const dur = (r.moving_s ?? r.duration_s ?? 0) / 60;
    const type = ['walk', 'run', 'hike', 'ride', 'swim', 'strength'].includes(r.type) ? r.type : 'other';
    const condName = r.condition;
    const w: any = {
      id: r.id, type, activity: r.activity_type, setting: r.setting, source: r.source_name, title: r.title || null, ...p,
      hour: fin(r.start_h) ?? 12, dur, elapsed: (r.elapsed_s ?? r.duration_s ?? 0) / 60, dist,
      pace: dist > 0 && r.pace_s_per_mi ? r.pace_s_per_mi / 60 : NaN, speed: dur > 0 ? dist / (dur / 60) : NaN,
      gapPace: r.gap_pace_s_per_mi ? r.gap_pace_s_per_mi / 60 : null, maxSpeed: r.max_speed_ms ? mph(r.max_speed_ms) : null,
      steps: fin(r.steps), cadence: fin(r.cadence_spm), hr: fin(r.avg_hr), hrMax: fin(r.max_hr), hrMaxUsed: fin(r.hr_max_used),
      zones: [r.zone1_s, r.zone2_s, r.zone3_s, r.zone4_s, r.zone5_s].map(v => (v ?? 0) / 60), hasZones: r.zone1_s != null,
      trimp: fin(r.trimp), bpm: fin(r.beats_per_mile), ef: fin(r.ef), decoupling: fin(r.decoupling),
      gain: r.climb_m != null ? ft(r.climb_m) : null, gpm: r.climb_m != null && dist > 0.05 ? ft(r.climb_m) / dist : null,
      climbSrc: r.climb_source, climbWatch: r.climb_watch_m != null ? ft(r.climb_watch_m) : null, climbDem: r.climb_dem_m != null ? ft(r.climb_dem_m) : null,
      climbGps: r.climb_gps_m != null ? ft(r.climb_gps_m) : null, descent: r.descent_m != null ? ft(r.descent_m) : null,
      maxGrade: fin(r.max_grade),
      temp: r.temp_c != null ? degF(r.temp_c) : null, feels: r.feels_c != null ? degF(r.feels_c) : null, hum: fin(r.humidity),
      wind: r.wind_mean_ms != null ? mph(r.wind_mean_ms) : r.wind_ms != null ? mph(r.wind_ms) : null, precip: fin(r.precip_mm),
      cond: condName ? COND.indexOf(condName) : -1, wxSrc: r.weather_source === 'health' ? 'health' : r.weather_source ? 'api' : null, wxProvider: r.weather_source,
      tempHealth: r.temp_health_c != null ? degF(r.temp_health_c) : null, tempApi: r.temp_api_c != null ? degF(r.temp_api_c) : null,
      elSrc: r.climb_source, kcal: fin(r.kcal), place: r.place_id, placeName: r.place, tpl: r.loop_id,
      device: HARDWARE[r.hardware] || r.hardware || r.source_name, hardware: r.hardware,
      dark: !!r.in_dark, darkMin: fin(r.dark_min), rise: fin(r.sunrise_h), set: fin(r.sunset_h),
      outdoor: r.setting === 'outdoor', fragment: !!r.is_fragment, g4: !!r.g4_cut, partial: !!r.partial_track,
      newGround: r.new_ground_m != null ? r.new_ground_m / MI : null, fromHome: r.max_from_home_m != null ? r.max_from_home_m / MI : null,
      splitDelta: fin(r.split_delta_s), tz: r.tz, tzSrc: r.tz_source, distSrc: r.distance_source, eleSrc: r.elevation_profile_source,
      route: r.route_off >= 0 ? { off: r.route_off, n: r.route_n, a: r.share_a, b: r.share_b } : null,
      swimLaps: fin(r.swim_laps), lapLen: fin(r.lap_length_m), swolf: fin(r.swolf), swolfApple: fin(r.swolf_apple), stroke: r.main_stroke, pace100: r.pace_100yd_s ? r.pace_100yd_s / 60 : null,
      yards: type === 'swim' ? (r.distance_m ?? 0) / 0.9144 : 0,
    };
    W.push(w);
  }
  W.sort((a, b) => a.d - b.d || a.hour - b.hour);
  G.workouts = W;
  G.byId = new Map(W.map(w => [w.id, w]));

  // ---- days (local dates, deduplicated quantities; null means not recorded)
  const D: any[] = [];
  for (const r of dRows) {
    const p = dayParts(r.date);
    if (p.y < yMin) continue;
    D.push({
      ...p, iso: r.date, steps: fin(r.steps), mi: r.distance_m != null ? r.distance_m / MI : null, flights: fin(r.flights),
      kcal: fin(r.active_kcal), exMin: fin(r.exercise_min), stand: fin(r.stand_hours), rhr: fin(r.resting_hr), hrv: fin(r.hrv_sdnn),
      vo2: fin(r.vo2max), walkSpeed: r.walk_speed_ms != null ? mph(r.walk_speed_ms) : null, stepLen: r.step_length_m != null ? r.step_length_m / 0.0254 : null,
      dblSupport: r.double_support != null ? r.double_support * 100 : null, asym: r.asymmetry != null ? r.asymmetry * 100 : null,
      daylight: fin(r.daylight_min), spo2: r.spo2 != null ? r.spo2 * 100 : null, resp: fin(r.resp_rate), wristTemp: fin(r.wrist_temp_c),
      footMi: (r.foot_m ?? 0) / MI, nWorkouts: r.n_workouts ?? 0, nFoot: r.n_foot ?? 0, active: !!r.active,
      trimp: fin(r.trimp), ctl: fin(r.ctl), atl: fin(r.atl), tsb: fin(r.tsb), stepsRaw: fin(r.steps_raw_sum),
    });
  }
  G.days = D;
  G.dayByD = new Map(D.map(d => [d.d, d]));
}

export async function loadRest() {
  const [be, loops, laps, recs, ng, swimLaps, wxT, wxY, health, sensors, splits] = await Promise.all([
    pq('best_efforts.parquet'), pq('loops.parquet'), pq('loop_laps.parquet'), pq('records.parquet'), pq('new_ground.parquet'),
    pq('swim_laps.parquet'), pq('wx_model_temp.parquet'), pq('wx_model_year.parquet'), js('health.json'), js('sensors.json'), pq('splits.parquet'),
  ]);
  G.splits = splits;
  G.bestEfforts = be.filter(r => G.byId.has(r.id)).map(r => ({ ...r, w: G.byId.get(r.id), t: r.seconds / 60, D: r.distance_m / MI }));
  G.loops = loops;
  G.loopLaps = laps;
  G.records = recs;
  G.newGround = ng;
  G.swimLaps = swimLaps;
  G.wxTemp = wxT;
  G.wxYear = wxY;
  G.health = health;
  G.sensors = sensors;
}

export async function loadRoutes() {
  const [a, b, c] = await Promise.all(['routes.bin', 'routes_gap.bin', 'routes_share.bin'].map(f => fetch(base + f).then(r => r.arrayBuffer())));
  G.routeXY = new Float32Array(a);
  G.routeGap = new Uint8Array(b);
  G.routeShare = new Uint8Array(c); // 1 = visible in share mode (outside the privacy zone and the 200 m end trims)
}

// Per-point elevation (half metres, -32768 = none) and seconds from the start (2 s steps) for the 3D view, loaded
// only when it comes near. An export from before these files existed leaves both null and the view says so.
let r3P: Promise<void> | null = null;
export function loadRoutes3D(): Promise<void> {
  return r3P ||= (async () => {
    const [e, t] = await Promise.all(['routes_ele.bin', 'routes_time.bin'].map(f => fetch(base + f).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null)));
    const n = G.routeGap?.length ?? -1; // the dev server answers a missing file with index.html, so check the length
    G.routeEle = e && e.byteLength === n * 2 ? new Int16Array(e) : null;
    G.routeTime = t && t.byteLength === n * 2 ? new Uint16Array(t) : null;
  })();
}

// Street network around home from OpenStreetMap (pipeline/stride/osm.py), with per-edge coverage. Optional:
// missing files (no OSM step) leave G.streets null and the panel explains why.
let streetsP: Promise<any> | null = null;
export function loadStreets(): Promise<any> {
  return streetsP ||= (async () => {
    const meta = await js('streets.json');
    if (!meta) return (G.streets = null);
    const [xy, idx, at] = await Promise.all(['streets_xy.bin', 'streets_idx.bin', 'streets_attr.bin'].map(f => fetch(base + f).then(r => r.arrayBuffer())));
    const XY = new Float32Array(xy), IDX = new Uint32Array(idx), A = new Int32Array(at);
    const nc = meta.attr_cols.length, day0 = Math.round((Date.parse(meta.day0 + 'T00:00:00Z') - G.D0) / DAY);
    const edges: any[] = [];
    for (let i = 0; i < IDX.length - 1; i++) {
      const a = A.subarray(i * nc, i * nc + nc);
      edges.push({ path: XY.subarray(IDX[i] * 2, IDX[i + 1] * 2), walked: a[0] === 1, hidden: a[1] === 1, first: a[2] >= 0 ? a[2] + day0 : -1,
        cls: a[3], ring: a[4], len: a[5] / 10, cov: a[6] / 10, name: a[7] >= 0 ? meta.names[a[7]] : null, hw: a[8] >= 0 ? meta.highways[a[8]] : null });
    }
    return (G.streets = { ...meta, edges });
  })();
}

const contourCache = new Map<number, any>();
export async function loadContours(placeId: number) {
  if (contourCache.has(placeId)) return contourCache.get(placeId);
  const c = (G.meta?.contours ?? []).find((x: any) => x.place_id === placeId);
  if (!c) { contourCache.set(placeId, null); return null; }
  const buf = await fetch(base + c.file).then(r => r.arrayBuffer());
  const xy = new Float32Array(buf);
  const lines: any[] = [];
  for (let i = 0; i < c.levels.length; i++) {
    const a = c.offsets[i], b = c.offsets[i + 1];
    const path = new Float32Array(xy.buffer, a * 8, (b - a) * 2);
    lines.push({ path, level: c.levels[i], major: Math.round(c.levels[i] / c.step_m) % 5 === 0 });
  }
  const out = { ...c, lines };
  contourCache.set(placeId, out);
  return out;
}

const streamCache = new Map<string, any>();
export async function loadStream(id: string) {
  if (streamCache.has(id)) return streamCache.get(id);
  const s = await js(`streams/${id}.json`);
  streamCache.set(id, s);
  return s;
}

// one route as drawable segments of [lon, lat]; share mode drops points hidden by the privacy zone
export function routeSegments(w: any, share = false): number[][][] {
  if (!w.route || !G.routeXY) return [];
  const { off, n } = w.route;
  const segs: number[][][] = []; let cur: number[][] = [];
  for (let i = 0; i < n; i++) {
    const hidden = share && !G.routeShare[off + i];
    if (hidden || G.routeGap[off + i] === 3) { if (cur.length > 1) segs.push(cur); cur = []; if (hidden) continue; }
    cur.push([G.routeXY[(off + i) * 2], G.routeXY[(off + i) * 2 + 1]]);
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}
export const routeCoords = (w: any, share = false) => routeSegments(w, share).flat();
