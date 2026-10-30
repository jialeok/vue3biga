import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'home', component: () => import('../views/DashboardView.vue') },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// ★★ [CHUNK-FALLBACK 2026-10-25 / 2026-10-31 重写]
//
// 症状（用户实测）：打开应用一片空白，标签页一直转圈；刚部署完那几分钟最容易出现。
// 根因链：`DashboardView` 是 `() => import(...)` 懒加载 —— 部署换了文件名哈希后，
//   浏览器缓存里那份 index.html 仍指向【已被删除】的旧 chunk（GitHub Pages 的 HTML
//   缓存 max-age=600）⇒ 动态 import 失败 ⇒ Vue Router 只在内部报错 ⇒ `<RouterView>` 渲染成空。
//
// 🔴 旧实现在这里是 `app.innerHTML = ''` 再手搓一块提示 —— 有两个问题：
//   ① 它把【已经挂载好的 Vue 应用】整个清空（包括登录浮层 / 各种模态），只为显示一行字；
//   ② 它只在 `app` 容器里写字，而启动蒙层已经把屏幕盖住了 ⇒ 手机上仍然看不到。
// ✅ 现在统一交给 index.html 的启动蒙层（`__bootChunkError`）：
//   · 若属于「旧缓存 → 新 chunk 404」，带 cache-buster 自动重载【一次】（sessionStorage 记旗标，
//     真 404 时不会变成刷新死循环）—— 这一条会把「刚部署完必白屏」变成用户无感的自动恢复；
//   · 否则把失败原因写到蒙层上，给「重新加载 / 清缓存重载」两个按钮。
// ⛔ 正常路径零行为变化（§11）。
router.onError(function (err) {
  try {
    if (typeof console !== 'undefined' && console.error) console.error('[ROUTER] 页面代码块加载失败:', err);
    var msg = (err && (err.message || err.toString())) || '未知原因';
    if (typeof window !== 'undefined' && window.__bootChunkError) {
      window.__bootChunkError(msg);
      return;
    }
    // 极端兜底：蒙层脚本没执行（几乎不可能）⇒ 仍然给人一句话
    var app = document.getElementById('app');
    if (app) {
      app.innerHTML = '';
      var box = document.createElement('div');
      box.style.cssText = 'max-width:520px;margin:18vh auto 0;padding:0 20px;text-align:center;'
        + "font:14px/1.8 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#b91c1c";
      box.textContent = '页面代码块加载失败，请重新加载：' + msg;
      app.appendChild(box);
    }
  } catch (e) {
    /* 兜底的兜底：⛔ 不因为兜底本身再抛错（否则连这句提示都渲染不出来） */
  }
});

export default router;
