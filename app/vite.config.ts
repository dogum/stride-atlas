import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local only: the dev server binds to localhost and the app makes no requests beyond its own data folder.
// STRIDE_BASE serves the build from a sub-path (the public demo on GitHub Pages uses /stride-atlas/);
// VITE_STRIDE_DEMO=1 marks the build as the demo (a banner, demo wording) and SITE_URL adds link-preview tags.
const site = process.env.SITE_URL;
export default defineConfig({
  base: process.env.STRIDE_BASE || '/',
  plugins: [react(), {
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
