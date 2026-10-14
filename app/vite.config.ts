import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Local only: the dev server binds to localhost and the app makes no requests beyond its own data folder.
// STRIDE_BASE serves the build from a sub-path (the public demo on GitHub Pages uses /stride-atlas/);
// VITE_STRIDE_DEMO=1 marks the build as the demo (a banner, demo wording) and SITE_URL adds link-preview tags.
const site = process.env.SITE_URL;

// make dev only: the Milestones editor reads and writes data/milestones.yaml through the pipeline's own module
// (python -m stride.milestones), so YAML is handled in one place. Bound to localhost like the rest of the dev server.
function milestonesApi(): Plugin {
  const root = resolve(__dirname, '..');
  // the data folder the app's files were exported from (meta.json says, relative to the repo), else STRIDE_DATA
  const dataDir = () => {
    try { const d = JSON.parse(readFileSync(resolve(__dirname, 'public/data/meta.json'), 'utf8')).data_dir; if (d) return resolve(root, d); } catch { /* not exported yet */ }
    return process.env.STRIDE_DATA ? resolve(root, process.env.STRIDE_DATA) : resolve(root, 'data');
  };
  const run = (args: string[], input: string) => new Promise<string>((ok, no) => {
    const p = spawn('uv', ['run', '--project', root, 'python', '-m', 'stride.milestones', ...args], { cwd: root, env: { ...process.env, STRIDE_DATA: dataDir() } });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (err += d));
    p.on('error', no); p.on('close', c => (c === 0 ? ok(out.trim().split('\n').pop() || '[]') : no(new Error(err || `exit ${c}`))));
    p.stdin.end(input);
  });
  return {
    name: 'stride-milestones-api',
    configureServer(server) {
      server.middlewares.use('/__stride/milestones', (req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', async () => {
          try {
            const out = await run(req.method === 'PUT' ? ['--write'] : [], req.method === 'PUT' ? body : '');
            res.setHeader('content-type', 'application/json'); res.end(out);
          } catch (e: any) { res.statusCode = 500; res.end(String(e?.message || e)); }
        });
      });
    },
  };
}
export default defineConfig({
  base: process.env.STRIDE_BASE || '/',
  plugins: [react(), milestonesApi(), {
    name: 'stride-demo-meta',
    transformIndexHtml(html) {
      if (process.env.VITE_STRIDE_DEMO !== '1' || !site) return html;
      const d = 'Every walk, run, hike and ride as a glowing map, a 3D stack in time, records, fitness and weather. A live demo with synthetic data; build yours from your own Apple Health export.';
      return html.replace('</head>', [
        `<meta name="description" content="${d}" />`,
        '<meta property="og:title" content="Stride Atlas: your Apple Health export as a map and a story" />',
        `<meta property="og:description" content="${d}" />`, `<meta property="og:image" content="${site}og.png" />`,
        `<meta property="og:url" content="${site}" />`, '<meta name="twitter:card" content="summary_large_image" />',
      ].map(l => '    ' + l).join('\n') + '\n  </head>');
    },
  }],
  server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5173, strictPort: false },
  preview: { host: '127.0.0.1', port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
