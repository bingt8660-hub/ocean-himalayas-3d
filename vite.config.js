import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'],
  },
  build: {
    target: 'esnext',
  },
});
