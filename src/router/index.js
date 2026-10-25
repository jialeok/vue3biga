import { createRouter, createWebHashHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'home', component: () => import('../views/DashboardView.vue') },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// ★★ [CHUNK-FALLBACK 2026-10-25] 「懒加载的页面代码块拉不下来」不要再变成一片空白。
//
// 症状（用户实测）：手机上打开应用一片空白，电脑上正常；刚部署完那几分钟最容易出现。
// 根因链：`DashboardView` 是 `() => import(...)` 懒加载 —— 部署换了文件名哈希后，
//   手机缓存里那份 index.html 仍指向【已被删除】的旧 chunk ⇒ 动态 import 失败 ⇒
//   Vue Router 只在内部报错，`<RouterView>` 渲染成【空】⇒ 页面纯白、没有报错、也不会重试。
//   而 `App.vue` 的 `<RouterView v-if="authReady" />` 决定了这一刻页面上不会有任何别的元素。
// ⇒ 兜底成一句人话 + 一个「重新加载」按钮（⛔ 不自动 reload：那会在真的 404 时变成刷新死循环）。
// ⛔ 只影响「加载失败」这条路径，正常路径零行为变化（§11）。
router.onError(function (err) {
  try {
    if (typeof console !== 'undefined' && console.error) console.error('[ROUTER] 页面代码块加载失败:', err);
    const app = document.getElementById('app');
    if (!app) return;
    app.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = 'max-width:520px;margin:18vh auto 0;padding:0 20px;text-align:center;'
      + "font:14px/1.8 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#374151";
    const t1 = document.createElement('div');
    t1.style.cssText = 'font-size:15px;color:#b91c1c;font-weight:600';
    t1.textContent = '页面代码块加载失败';
    const t2 = document.createElement('div');
    t2.style.cssText = 'margin-top:8px;color:#6b7280';
    t2.textContent = '多半是刚更新过、手机里还是旧版本。点下面按钮重新加载就好。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '重新加载';
    btn.style.cssText = 'margin-top:16px;padding:9px 20px;border:1px solid #d1d5db;border-radius:6px;'
      + 'background:#fff;color:#111827;font-size:14px;cursor:pointer';
    btn.addEventListener('click', function () { location.reload(); });
    box.appendChild(t1);
    box.appendChild(t2);
    box.appendChild(btn);
    app.appendChild(box);
  } catch (e) {
    /* 兜底的兜底：⛔ 不因为兜底本身再抛错（否则连这句提示都渲染不出来） */
  }
});

export default router;
