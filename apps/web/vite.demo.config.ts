import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

// Clickable demo: the real app with an in-browser sample backend (src/demo), built as relative files
// so it can be published as a single static page.
export default mergeConfig(
  base,
  defineConfig({
    mode: 'demo',
    base: './',
    build: { outDir: 'dist-demo', sourcemap: false, emptyOutDir: true },
  }),
);
