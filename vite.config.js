import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  root: '.',
  // 资源前缀必须用【相对路径】'./'，不能用绝对路径 '/vue3biga/'：
  //   · 项目页 https://jialeok.github.io/vue3biga/  → index.html 在 /vue3biga/ 下，
  //     './assets/x' 解析为 /vue3biga/assets/x ✅
  //   · 自定义域名 https://stock.cc.cd/            → index.html 在站点根，
  //     './assets/x' 解析为 /assets/x ✅
  // 若写死绝对 '/vue3biga/'，在自定义域名根下会请求 https://stock.cc.cd/vue3biga/assets/x
  // → 404 → CSS/JS 全挂 → 白屏（正是 "failed to load a stylesheet from a URL" 的成因）。
  // 另：router 用的是 createWebHashHistory（URL 恒为 /#/xxx），不会出现深层路径，
  //     相对前缀没有"深层路由下解析错位"的风险。
  base: './',
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