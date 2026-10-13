#!/usr/bin/env node
// Record the presentation tour (app/?present=1) to an MP4: headless Chrome streams frames over the DevTools
// screencast while the tour plays in real time, and ffmpeg turns them into a constant-frame-rate H.264 file.
// Needs the dev server (make dev) or a preview build running, a local Chrome, and ffmpeg.
//
//   node scripts/record.mjs                 # 1920×1080, share mode on, data/video/stride-atlas-tour.mp4
//   node scripts/record.mjs --vertical      # 1080×1920 for phones
//   options: --url http://localhost:5173  --out data/video  --name stride-atlas-tour  --fps 30  --no-share  --light
// Share mode is on unless --no-share: the privacy zone around home stays hidden in anything you post.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = k => { const i = args.indexOf(`--${k}`); if (i < 0) return false; args.splice(i, 1); return true; };
const vertical = flag('vertical'), noShare = flag('no-share'), light = flag('light');
const url = opt('url', 'http://localhost:5173'), outDir = resolve(opt('out', 'data/video')), fps = +opt('fps', 30);
const name = opt('name', `stride-atlas-tour${vertical ? '-vertical' : ''}${light ? '-light' : ''}`);
// CSS viewport × 1.5 device pixels: 1280×720 → 1920×1080 keeps the desktop layout; 720×1280 → 1080×1920 gets the phone layout
const [cw, ch] = vertical ? [720, 1280] : [1280, 720], scale = 1.5;
const [pw, ph] = [Math.round(cw * scale), Math.round(ch * scale)];

const frames = mkdtempSync(join(tmpdir(), 'stride-rec-'));
const stamps = [];
const b = await launch({ width: cw, height: ch, scale, light, reducedMotion: false });
try {
  await b.open(`${url}/?present=1${noShare ? '' : '&share=1'}`);
  await b.evaluate(`new Promise(ok => { const t = () => window.__present?.ready ? ok(true) : setTimeout(t, 100); t(); })`);
  await sleep(1500); // let the first panels draw
  b.on('Page.screencastFrame', p => {
    const i = stamps.length;
    writeFileSync(join(frames, `f${String(i).padStart(6, '0')}.jpg`), Buffer.from(p.data, 'base64'));
    stamps.push(p.metadata.timestamp);
    b.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  await b.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: pw, maxHeight: ph, everyNthFrame: 1 });
  await b.evaluate(`window.__present.start(), true`);
  const t0 = Date.now();
  while (!(await b.evaluate('window.__present.done'))) {
    if (Date.now() - t0 > 240000) throw new Error('the tour did not finish within four minutes');
    await sleep(250);
  }
  await sleep(400);
  await b.send('Page.stopScreencast');
  await sleep(300);
} finally {
  await b.close();
}

// frames arrive when the page changes, not on a clock: give each one its real on-screen duration
const n = stamps.length;
if (n < 10) throw new Error(`only ${n} frames captured`);
const lines = ["ffconcat version 1.0"];
for (let i = 0; i < n; i++) {
  lines.push(`file f${String(i).padStart(6, '0')}.jpg`);
  lines.push(`duration ${(i + 1 < n ? stamps[i + 1] - stamps[i] : 1 / fps).toFixed(4)}`);
}
lines.push(`file f${String(n - 1).padStart(6, '0')}.jpg`); // the concat demuxer drops the last duration otherwise
writeFileSync(join(frames, 'list.txt'), lines.join('\n'));
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${name}.mp4`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'),
  '-vf', `scale=${pw}:${ph}:flags=lanczos,format=yuv420p`, '-fps_mode', 'cfr', '-r', String(fps),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', out], { stdio: 'inherit' });
const secs = stamps[n - 1] - stamps[0];
rmSync(frames, { recursive: true, force: true });
console.log(`${out}  ${pw}×${ph}, ${secs.toFixed(1)} s, ${n} frames captured (${(n / secs).toFixed(0)} per second)`);
