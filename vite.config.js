import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: '.',
  base: '/vue3biga/',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      input: 'index.html',
      output: {
        manualChunks: {
          vue: ['vue', 'vue-router', 'pinia'],
          supabase: ['@supabase/supabase-js'],
          util: ['mitt']
        }
      }
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