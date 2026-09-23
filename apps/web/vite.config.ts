import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: { outDir: 'dist', sourcemap: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 800 },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:4318', '/healthz': 'http://127.0.0.1:4318' } },
});
