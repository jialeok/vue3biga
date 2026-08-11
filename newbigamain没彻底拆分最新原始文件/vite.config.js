import { defineConfig } from 'vite';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname } from 'path';

// Vite 插件：将 src/**/*.js 作为非模块脚本直接返回（绕过 ES module 处理）
// 这样 dev server 可以服务现有的全局作用域代码，无需改成 import/export
function serveGlobalScripts() {
  return {
    name: 'serve-global-scripts',
    configureServer(server) {
      // 拦截 src/**/*.js 请求，直接返回原始内容（不作为 ES module 处理）
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.endsWith('.js')) return next();
        // 去掉 query string
        const url = req.url.split('?')[0];
        // 只处理 src/ 下的文件
        if (!url.includes('/src/')) return next();
        const filePath = resolve(process.cwd(), url.slice(1));
        if (!existsSync(filePath)) return next();
        try {
          const content = readFileSync(filePath, 'utf8');
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(content);
        } catch (e) {
          next();
        }
      });
    },
    // 生产构建时也处理这些文件
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.endsWith('.js')) return next();
        const url = req.url.split('?')[0];
        if (!url.includes('/src/')) return next();
        const filePath = resolve(process.cwd(), url.slice(1));
        if (!existsSync(filePath)) return next();
        try {
          const content = readFileSync(filePath, 'utf8');
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
          res.end(content);
        } catch (e) {
          next();
        }
      });
    }
  };
}

export default defineConfig({
  root: '.',
  base: './',
  plugins: [serveGlobalScripts()],
  // 确保外部 CDN 脚本不被处理
  optimizeDeps: {
    exclude: ['@supabase/supabase-js', 'vue']
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // 生产构建：直接复制 src/ 和 index.html（不通过 Rollup 打包）
    rollupOptions: {
      input: 'index.html'
    },
    // 禁用 minify 以避免修改全局脚本
    minify: false
  },
  server: {
    port: 5173,
    open: true,
    // 确保所有 src/ 路径都能正确解析
    fs: {
      allow: ['.']
    }
  }
});
