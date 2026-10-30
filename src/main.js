import { createApp, watch } from 'vue';
import { createPinia } from 'pinia';
import router from './router/index.js';
import App from './App.vue';
import './assets/main.css';
import { useUiStore } from './stores/uiStore.js';
import { useAuctionStore } from './stores/auctionStore.js';
import { initRemainingBoards } from './data/remaining-boards.js';

const app = createApp(App);

app.config.errorHandler = (err, instance, info) => {
  console.error('[APP ERROR]', err, info);
  // ★★ [BOOT-VEIL 2026-10-31] 组件 setup / render 抛错原来只进 console ⇒ 用户那边就是一片空白
  //   （#app 里连注释节点都可能没有，也没有任何提示）。这里顺手把错误写进启动蒙层，
  //   让「白屏」变成「一句能截图给我的原因」。⛔ 不吞错、不改任何业务行为（仍然 console.error）。
  try {
    if (typeof window !== 'undefined' && window.__bootFail) {
      window.__bootFail('界面渲染失败：' + ((err && (err.message || err.toString())) || '未知错误') + (info ? '（' + info + '）' : ''));
    }
  } catch (e) { /* 兜底的兜底：⛔ 不因为兜底本身再抛错 */ }
};

app.use(createPinia());
app.use(router);

// [FIX 2026-08-16] §24/§25 生命周期：initRemainingBoards 原在 remaining-boards.js 模块顶层立即执行，
// 抢在 app.use(createPinia()) 之前调用 useUiStore() → Pinia 未激活 → "_s" 报错（unhandled rejection）。
// 改在 Pinia 安装后显式调用，保证 store 可用、启动流程可预期。
// ★★ [BOOT-VEIL 2026-10-31] 再包一层 try/catch：这句抛错会直接打断下面的 app.mount('#app')，
//   结果就是页面永远停在启动蒙层（⛔ 不是白屏，但同样打不开）。
try {
  initRemainingBoards();
} catch (e) {
  console.error('[BOOT] initRemainingBoards 失败:', e);
  if (typeof window !== 'undefined' && window.__bootFail) window.__bootFail('初始化看板失败：' + ((e && e.message) || e));
}

// 单向同步：uiStore.currentDate（唯一真相）→ auctionStore.currentDate（显示镜像）。
// 仅从真理同步到镜像，不产生第二个真相源；auctionStore.currentDate 只经此通道更新。
const _uiStore = useUiStore();
const _auctionStore = useAuctionStore();
watch(() => _uiStore.currentDate, (v) => { if (_auctionStore.currentDate !== v) _auctionStore.currentDate = v; });

app.mount('#app');

// ★★ [BOOT-VEIL 2026-10-31] 首屏导航（含路由分包的动态 import）确认完成之后，才撤掉启动蒙层。
//   为什么不在 mount 之后立刻撤：`DashboardView` 是懒加载的，mount 那一刻它往往还没下载完，
//   这时候撤掉蒙层 = 拿「白屏」换「白屏」（旧实现就是这样，用户看到的进度条卡在最后一段）。
//   而且「路由就绪」≠「界面渲染出来了」（`authReady` 可能还没翻、组件 setup 可能抛错），
//   所以再加一段「最多等 8 秒，等到 #app 里真的出现元素」的轮询：
//     等到 → 撤蒙层（成功路径，通常 <1 帧）；
//     等不到 → 让蒙层把原因写出来，并把最近几条调试日志一起带上（可直接截图定位）。
router.isReady().then(() => {
  const startedAt = Date.now();
  const tick = () => {
    const el = document.getElementById('app');
    if (el && el.childElementCount > 0) {
      if (window.__bootDone) window.__bootDone();
      return;
    }
    if (Date.now() - startedAt > 8000) {
      if (window.__bootFail) window.__bootFail('启动完成但界面没有任何内容（authReady 可能没被置为 true）。');
      return;
    }
    setTimeout(tick, 200);
  };
  requestAnimationFrame(tick);
}).catch((e) => {
  console.error('[BOOT] 首屏路由未就绪:', e);
  if (typeof window !== 'undefined' && window.__bootChunkError) {
    window.__bootChunkError((e && e.message) || String(e));
  }
});
