import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: '.',
  base: '/vue3biga/',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      input: 'index.html'
    },
  },
  server: {
    port: 5173,
    open: true,
    fs: {
      allow: ['.']
    }
  }
});