// Global data (G), state (S), filtered view (F) and a tiny keyed-version store.
// Charts read these directly, as the mockup's code did; React components subscribe to versions.
import { useSyncExternalStore } from 'react';

export type Workout = any;
export type Day = any;

export const G: any = { workouts: [], days: [], years: [] };

export const GPS_TYPES = ['walk', 'run', 'hike', 'ride'];
export const ON_FOOT = ['walk', 'run', 'hike'];

export const S: any = {
  y0: 2018, y1: 2026, types: new Set(GPS_TYPES), colorBy: 'year', place: 0, effortType: 'walk', calMetric: 'steps', cuId: null, stackMode: 'date',
  // ?share=1 starts in share mode, so a recording or screenshot session never shows the privacy zone by accident
  share: typeof location !== 'undefined' && new URLSearchParams(location.search).get('share') === '1', basemap: 'contours',
};

// the public demo (synthetic data, served from GitHub Pages) says so on screen
export const DEMO = import.meta.env.VITE_STRIDE_DEMO === '1';

// live objects other modules need to drive (the presentation tour steers the atlas)
export const REG: any = {};

export let F: any = null;
export function computeF() {
  const inY = (y: number) => y >= S.y0 && y <= S.y1;
  const all = G.workouts.filter((w: Workout) => inY(w.y));
  F = {
    all,
    W: all.filter((w: Workout) => S.types.has(w.type)),
    // GPS workouts in the filter: outdoor with a route, not fragments (rules W2 and W3)
    gps: all.filter((w: Workout) => GPS_TYPES.includes(w.type) && S.types.has(w.type) && w.outdoor && !w.fragment),
    days: G.days.filter((d: Day) => inY(d.y)),
    years: G.years.filter(inY),
  };
  return F;
}

// keyed versions: 'filter' (years/types), 'theme', 'size', plus panel-local keys
const versions: Record<string, number> = {};
const listeners = new Set<() => void>();
let snapshot = 0;
export function emit(...keys: string[]) {
  for (const k of keys) versions[k] = (versions[k] || 0) + 1;
  snapshot++;
  for (const l of listeners) l();
}
function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }
export function useWatch(keys: string[]): string {
  useSyncExternalStore(subscribe, () => snapshot);
  return keys.map(k => versions[k] || 0).join('.');
}
export function version(k: string) { return versions[k] || 0; }

// QUIET: redraws caused by resize or theme changes skip arrival animations
export const MODE = { quiet: false };
