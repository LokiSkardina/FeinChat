import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: 'renderer',
    modulePreload: { polyfill: false },
  },
});
