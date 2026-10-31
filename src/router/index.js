import { createRouter, createWebHashHistory } from 'vue-router';
// ★★★ [BOOT-DEPTH 2026-10-31] DashboardView 从「懒加载」改成【静态引入】，别改回去。
//
// 为什么（实测，不是省事）：
//   本应用**只有一条路由**，而且它就是这个应用的唯一页面 —— 懒加载在这里一点好处都没有，
//   只会把首屏的请求瀑布从 2 层变成 3 层：
//     ① index.html → ② 入口 index-*.js → ③ 等入口执行完才去请求 DashboardView-*.js（687KB）
//   而这台机器的网络特征是「每个请求固定停顿 12~64 秒」（实测 3.7KB 的 sw.js 要 64s），
//   停顿是**按层叠加**的 ⇒ 少一层就少几十秒。实测首屏 93.9s 正好是 3 层的量级。
//   静态引入后 DashboardView 与入口同一个 chunk ⇒ 瀑布回到 2 层。
//
// 代价（可接受）：改 DashboardView 会连带入口 chunk 一起换哈希，首访要重下整块。
//   但我们有 Service Worker 本地缓存兜底，且部署频率远低于打开频率。
// 失败语义不变：入口 chunk 加载失败仍由 window 的 script error 监听 → __bootChunkError → 自愈一次。
import DashboardView from '../views/DashboardView.vue';

const routes = [
  { path: '/', name: 'home', component: DashboardView },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// ★★ [CHUNK-FALLBACK 2026-10-25 / 2026-10-31 重写]
//
// 症状（用户实测）：打开应用一片空白，标签页一直转圈；刚部署完那几分钟最容易出现。
// 根因链：部署换了文件名哈希后，浏览器缓存里那份 index.html 仍指向【已被删除】的旧 chunk
//   （GitHub Pages 的 HTML 缓存 max-age=600）⇒ 脚本加载失败 ⇒ Vue 挂不上 ⇒ 一片空白。
// ⚠️ [BOOT-DEPTH 2026-10-31] DashboardView 现在已改成静态引入（见文件头），所以「默认路由
//   懒加载失败」这条具体路径不存在了；但入口 chunk 本身仍可能命中同一个坑（旧 HTML → 旧哈希），
//   而且以后若再加路由仍是懒加载 ⇒ 下面这套兜底必须保留。
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
