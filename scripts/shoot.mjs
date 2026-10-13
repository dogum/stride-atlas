#!/usr/bin/env node
// Headless screenshots of the running app over the Chrome DevTools Protocol, with no extra dependencies
// (Node 22+ for the built-in WebSocket, plus a local Chrome). Used for checking panels, README images and video stills.
//
//   node scripts/shoot.mjs streets gait            # panels by id (the part after "p-"), or chapter ids like #atlas
//   node scripts/shoot.mjs --light --share streets  # light theme, share mode
//   options: --url http://localhost:5173  --out reports/shots  --width 1400  --scale 2  --wait 2500  --eval "<js run first>"
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = k => { const i = args.indexOf(`--${k}`); if (i < 0) return false; args.splice(i, 1); return true; };
const url = opt('url', 'http://localhost:5173'), out = resolve(opt('out', 'reports/shots'));
const width = +opt('width', 1400), scale = +opt('scale', 2), wait = +opt('wait', 2500);
const light = flag('light'), share = flag('share');
const pre = opt('eval', ''); // run in the page before shooting, e.g. "__stride.S.basemap='streets'; __stride.emit('basemap')" (dev server only)
const targets = args.length ? args : ['atlas'];

const b = await launch({ width, height: 1000, scale, light });
try {
  await b.open(url + (share ? '?share=1' : ''));
  await sleep(800);
  if (pre) { await b.evaluate(pre); await sleep(1200); }
  mkdirSync(out, { recursive: true });
  for (const t of targets) {
    const sel = t.startsWith('#') ? t : `#p-${t}`;
    const rect = await b.evaluate(`(async () => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
      const top = () => { e.scrollIntoView({ block: 'start' }); scrollBy(0, -((document.querySelector('header')?.offsetHeight ?? 0) + 16)); };
      top(); await new Promise(r => setTimeout(r, ${wait}));
      top(); await new Promise(r => setTimeout(r, 400));
      const b = e.getBoundingClientRect(); return { x: b.left + scrollX, y: b.top + scrollY, w: b.width, h: b.height }; })()`);
    if (!rect) { console.error(`shoot: no element ${sel}`); continue; }
    const m = 12;
    const shot = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: Math.max(0, rect.x - m), y: Math.max(0, rect.y - m), width: rect.w + 2 * m, height: rect.h + 2 * m, scale: 1 } });
    const file = join(out, `${t.replace('#', '')}${light ? '-light' : ''}${share ? '-share' : ''}.png`);
    writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log(`${file}  (${Math.round(rect.w)}×${Math.round(rect.h)})`);
  }
} finally {
  await b.close();
}
