#!/usr/bin/env node
// How the app feels on a slow computer: loads it in headless Chrome, optionally with software-only WebGL (what a
// laptop without graphics acceleration, a virtual desktop or a remote session gets) and a throttled CPU, then
// measures frame times while the page sits still and while it scrolls from top to bottom.
//
//   node scripts/perf.mjs                                   # http://localhost:5173, this machine's GPU
//   node scripts/perf.mjs --software --cpu 4                # no GPU, CPU four times slower
//   node scripts/perf.mjs --url https://dogum.github.io/stride-atlas/ --software
//
// A healthy page makes no WebGL draw calls while it sits still, and scrolls with frames under ~50 ms (the frame
// times are measured with requestAnimationFrame, so an idle page still reports ~16 ms frames: look at drawsPerSec).
import { launch, sleep } from './lib/cdp.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = k => args.includes(`--${k}`);
const url = opt('url', 'http://localhost:5173/'), cpu = +opt('cpu', 1), software = flag('software');
const [w, h] = (opt('size', '1440x900')).split('x').map(Number);

const b = await launch({ width: w, height: h, scale: +opt('scale', 2), reducedMotion: false,
  args: software ? ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--disable-gpu-rasterization'] : [] });
try {
  if (cpu > 1) await b.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  // count WebGL draw calls: a page at rest should make none
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__gl = { draws: 0 };
    for (const C of [self.WebGL2RenderingContext, self.WebGLRenderingContext]) if (C) for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
      const f = C.prototype[m]; if (f) C.prototype[m] = function (...a) { window.__gl.draws++; return f.apply(this, a); }; }` });
  const t0 = Date.now();
  await b.open(url, 180000);
  const loadS = (Date.now() - t0) / 1000;
  const gpu = await b.evaluate(`(() => { const c = document.createElement('canvas').getContext('webgl2'); const e = c && c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`);
  // frame intervals and long tasks while `fn` runs
  const measure = (label, body) => b.evaluate(`(async () => {
    const iv = []; let last = performance.now(), on = true, longMs = 0, longN = 0;
    const po = new PerformanceObserver(l => { for (const e of l.getEntries()) { longMs += e.duration; longN++; } }); po.observe({ type: 'longtask', buffered: false });
    const tick = t => { iv.push(t - last); last = t; if (on) requestAnimationFrame(tick); }; requestAnimationFrame(tick);
    const T0 = performance.now(), D0 = window.__gl.draws;
    ${body}
    on = false; po.disconnect();
    const s = iv.slice(1).sort((a, b) => a - b), q = p => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
    const secs = (performance.now() - T0) / 1000;
    return { label: ${JSON.stringify(label)}, secs: +secs.toFixed(1), drawsPerSec: Math.round((window.__gl.draws - D0) / secs), median: Math.round(q(0.5)), p95: Math.round(q(0.95)), worst: Math.round(s[s.length - 1] || 0), longTasks: longN, blockedMs: Math.round(longMs) };
  })()`);
  const rows = [];
  rows.push(await measure('just loaded, 3 s', `await new Promise(r => setTimeout(r, 3000));`));
  rows.push(await measure('idle at the top, 5 s', `scrollTo(0, 0); await new Promise(r => setTimeout(r, 5000));`));
  rows.push(await measure('idle at the 3D chapter, 5 s', `document.getElementById('stack')?.scrollIntoView(); await new Promise(r => setTimeout(r, 5000));`));
  rows.push(await measure('scroll top to bottom', `scrollTo(0, 0); const H = document.documentElement.scrollHeight; for (let y = 0; y < H; y += 500) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }`));
  console.log(`${url}  ${software ? 'software WebGL' : 'GPU'} (${gpu}), CPU ×${cpu}, ${w}×${h}: loaded in ${loadS.toFixed(1)} s`);
  console.table(rows);
  // after the scroll every panel has drawn: how heavy is the page now
  const size = await b.evaluate(`(() => { const svgs = [...document.querySelectorAll('svg')].map(s => [s.closest('.panel')?.id || s.closest('section')?.id || '?', s.getElementsByTagName('*').length]).sort((a, b) => b[1] - a[1]);
    return { domNodes: document.getElementsByTagName('*').length, jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null, largestCharts: svgs.slice(0, 5).map(x => x.join(' ')).join(', ') }; })()`);
  console.log(size);
} finally {
  await b.close();
}
