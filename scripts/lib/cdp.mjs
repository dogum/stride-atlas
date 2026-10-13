// A small Chrome DevTools Protocol client for the screenshot and video scripts: launches a headless Chrome,
// talks to its page over the built-in WebSocket (Node 22+), and surfaces page errors on stderr.
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const p of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) if (existsSync(p)) return p;
  for (const n of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { const p = execSync(`command -v ${n}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); if (p) return p; } catch { /* next */ }
  }
  throw new Error('no Chrome or Chromium found: set CHROME=/path/to/chrome');
}

export async function launch({ width = 1400, height = 1000, scale = 2, light = false, reducedMotion = true } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'stride-cdp-'));
  const chrome = spawn(findChrome(), ['--headless=new', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`, '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((ok, no) => {
    let buf = '';
    chrome.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) ok(m[1]); });
    chrome.on('exit', c => no(new Error(`Chrome exited (${c}) before DevTools came up`)));
    setTimeout(() => no(new Error('Chrome did not start within 15 s')), 15000);
  });
  const port = new URL(wsUrl).port;
  const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map(), handlers = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const [ok, no] = pending.get(m.id); pending.delete(m.id); m.error ? no(new Error(m.error.message)) : ok(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') console.error('page exception:', m.params.exceptionDetails?.exception?.description?.split('\n')[0] || m.params.exceptionDetails?.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.error('console.error:', m.params.args.map(a => a.value ?? a.description ?? '').join(' ').split('\n')[0]);
    for (const h of handlers.get(m.method) || []) h(m.params);
  });
  const send = (method, params = {}) => new Promise((ok, no) => { const i = ++id; pending.set(i, [ok, no]); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const on = (method, fn) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(fn); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: light ? 'light' : 'dark' }, { name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }] });
  return {
    send, evaluate, on,
    // navigate and wait until the app has loaded everything, routes included
    async open(url, timeoutMs = 40000) {
      await send('Page.navigate', { url });
      for (let t = 0; t < timeoutMs / 250; t++) { if (await evaluate(`document.documentElement.dataset.loaded === 'all'`).catch(() => false)) return; await sleep(250); }
      throw new Error(`the app at ${url} did not finish loading`);
    },
    async close() { ws.close(); chrome.kill(); await sleep(300); rmSync(profile, { recursive: true, force: true }); },
  };
}
