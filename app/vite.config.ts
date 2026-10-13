import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local only: the dev server binds to localhost and the app makes no requests beyond /data.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: Number(process.env.PORT) || 5173, strictPort: false },
  preview: { host: '127.0.0.1', port: 5173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
