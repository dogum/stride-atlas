#!/usr/bin/env node
// Record the presentation tour (app/?present=1) to an MP4: headless Chrome streams frames over the DevTools
// screencast while the tour plays in real time, and ffmpeg turns them into a constant-frame-rate H.264 file.
// Needs the dev server (make dev) or a preview build running, a local Chrome, and ffmpeg.
//
//   node scripts/record.mjs                 # 1920×1080, share mode on, data/video/stride-atlas-tour.mp4 (+ -music.mp4)
//   node scripts/record.mjs --vertical      # 1080×1920 for phones
//   options: --url http://localhost:5173  --out data/video  --name stride-atlas-tour  --fps 30  --no-share  --light  --no-music
// Share mode is on unless --no-share: the privacy zone around home stays hidden in anything you post.
// The tour keeps time at a fixed tempo and reports where its bars fell; the soundtrack (pipeline/stride/soundtrack.py,
// synthesised from scratch, so there is nothing to license) is written to that timeline and laid under a second copy.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { launch, sleep } from './lib/cdp.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = k => { const i = args.indexOf(`--${k}`); if (i < 0) return false; args.splice(i, 1); return true; };
const vertical = flag('vertical'), noShare = flag('no-share'), light = flag('light'), noMusic = flag('no-music');
const url = opt('url', 'http://localhost:5173'), outDir = resolve(opt('out', 'data/video')), fps = +opt('fps', 30);
const name = opt('name', `stride-atlas-tour${vertical ? '-vertical' : ''}${light ? '-light' : ''}`);
// CSS viewport × 1.5 device pixels: 1280×720 → 1920×1080 keeps the desktop layout; 720×1280 → 1080×1920 gets the phone layout
const [cw, ch] = vertical ? [720, 1280] : [1280, 720], scale = 1.5;
const [pw, ph] = [Math.round(cw * scale), Math.round(ch * scale)];

const frames = mkdtempSync(join(tmpdir(), 'stride-rec-'));
const stamps = [];
let timeline = null, stopAt = 0;
const b = await launch({ width: cw, height: ch, scale, light, reducedMotion: false });
try {
  await b.open(`${url}/?present=1${noShare ? '' : '&share=1'}`);
  await b.evaluate(`new Promise(ok => { const t = () => window.__present?.ready ? ok(true) : setTimeout(t, 100); t(); })`);
  await sleep(1500); // let the first panels draw
  await b.evaluate(`window.__present.prep().then(() => true)`); // the empty map, everything loaded
  await sleep(600);
  b.on('Page.screencastFrame', p => {
    const i = stamps.length;
    writeFileSync(join(frames, `f${String(i).padStart(6, '0')}.jpg`), Buffer.from(p.data, 'base64'));
    stamps.push(p.metadata.timestamp);
    b.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });
  await b.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: pw, maxHeight: ph, everyNthFrame: 1 });
  await sleep(500);
  await b.evaluate(`window.__present.start(), true`);
  const t0 = Date.now();
  while (!(await b.evaluate('window.__present.done'))) {
    if (Date.now() - t0 > 240000) throw new Error('the tour did not finish within four minutes');
    await sleep(250);
  }
  timeline = await b.evaluate('window.__present.timeline');
  await sleep(400);
  stopAt = Date.now() / 1000;
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
  // a still screen sends no frames, so the last one lasts until the recording stopped
  lines.push(`duration ${(i + 1 < n ? stamps[i + 1] - stamps[i] : Math.max(1 / fps, stopAt - stamps[i])).toFixed(4)}`);
}
lines.push(`file f${String(n - 1).padStart(6, '0')}.jpg`); // the concat demuxer drops the last duration otherwise
writeFileSync(join(frames, 'list.txt'), lines.join('\n'));
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${name}.mp4`);
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(frames, 'list.txt'),
  '-vf', `scale=${pw}:${ph}:flags=lanczos,format=yuv420p`, '-fps_mode', 'cfr', '-r', String(fps),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', out], { stdio: 'inherit' });
const secs = Math.max(stamps[n - 1], stopAt) - stamps[0];
rmSync(frames, { recursive: true, force: true });
console.log(`${out}  ${pw}×${ph}, ${secs.toFixed(1)} s, ${n} frames captured (${(n / secs).toFixed(0)} per second)`);

// the soundtrack: bar 0 of the music is the tour's first bar, wherever that fell in the video
if (!noMusic && timeline?.bars) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const wav = join(outDir, `${name}-music.wav`), outM = join(outDir, `${name}-music.mp4`);
  const lead = Math.max(0, timeline.t0 / 1000 - stamps[0]);
  const c = timeline.cues || {};
  execFileSync('uv', ['run', '--project', root, 'python', '-m', 'stride.soundtrack', '--bpm', String(timeline.bpm), '--bars', String(timeline.bars),
    '--drop', String(c.drop ?? 2), '--outro', String(c.outro ?? timeline.bars - 3), '--lead', lead.toFixed(3), '--length', secs.toFixed(3),
    // a crash where the 3D view and the close-up arrive
    '--accents', (timeline.sections || []).filter(x => ['stack', 'closeup'].includes(x.name)).map(x => x.bar).join(','), '--out', wav], { stdio: 'inherit', cwd: root });
  // −14 LUFS, the level the social platforms normalise to
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', outM], { stdio: 'inherit' });
  rmSync(wav, { force: true });
  console.log(`${outM}  with the soundtrack (${timeline.bpm} BPM, ${timeline.bars} bars, starting ${lead.toFixed(2)} s in)`);
}
