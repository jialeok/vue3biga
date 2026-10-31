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
//
// ★★ [CHUNK-WATCHDOG 2026-10-31] 上面这段的前提是 `router.isReady()` 会 resolve。
//   🔴 实测（.tmpdiag/pw/boot-stall.cjs，把 `DashboardView-*.js` 请求挂住不返回）：
//      分包请求**既不报错也不结束**时（被代理/防火墙半开、限速卡死），`isReady()` 永远 pending
//      ⇒ `<RouterView v-if="authReady">` 一直是空的 ⇒ `#app` 连一个元素都没有
//      ⇒ 只能等 index.html 那个看门狗报「还没渲染出任何内容」—— 而现场日志里 PULL 明明已经成功，
//         用户完全看不出是分包没下来。
//
// ★★★ [CHUNK-NO-ABORT 2026-10-31] 这里改过一次关键语义，⛔ 别再改回「10s 自动重载」：
//   旧实现：10s 没就绪 ⇒ `__bootChunkError` ⇒ `autoReloadOnce()` ⇒ **location.replace 整页重载**。
//   它的本意是自愈「半开连接」，但实测（本文档 B 组：把 /assets/** 统一延迟 25s）暴露了副作用：
//     重载会**把正在下载的连接全部作废**，一切从头再来 ⇒ 网络只是「慢」的时候，
//     10s 一到就自杀一次，第二次因为命中了 HTTP 缓存才成功 —— 这正是用户报的
//     「刷新两次才能打开页面」的机制（不是用户手动刷的，是代码自己刷的）。
//   现在：分包只看【真失败】——404 / import 抛错 ⇒ 上面的 error / unhandledrejection 立刻接手，
//     仍然走 `__bootChunkError`（保留「旧 HTML 指向已删除哈希文件」的一次自愈）。
//     纯「慢」则**一律不打断**：10s 只记一条日志（蒙层那边会显示「网络较慢 / 请勿刷新」），
//     90s 仍未就绪才真正报错并给出「重新加载」按钮（把决定权交回用户）。
const CHUNK_WATCHDOG_MS = 10000;   // 仅用于「记一条日志」，不触发任何重载
const CHUNK_GIVEUP_MS = 90000;     // 真正卡死的判定线（实测最坏分包 30s 左右，留足余量）
let _routeReady = false;
setTimeout(function () {
  if (_routeReady) return;
  try {
    console.log('[BOOT] 首屏代码块 ' + (CHUNK_WATCHDOG_MS / 1000)
      + 's 还没就绪 —— 继续等待，不打断下载（90s 仍不就绪才报错）');
  } catch (e) {}
}, CHUNK_WATCHDOG_MS);
setTimeout(function () {
  if (_routeReady) return;
  try {
    if (window.__bootFail) {
      window.__bootFail('首屏代码块 ' + (CHUNK_GIVEUP_MS / 1000)
        + 's 还没下载完（分包请求被拦或限速，不是数据问题）。可点「重新加载」再试。');
    }
  } catch (e) { /* 兜底的兜底 */ }
}, CHUNK_GIVEUP_MS);

router.isReady().then(() => {
  _routeReady = true;
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

// ★★ [BOOT-SW 2026-10-31] 注册首屏静态资源缓存（治「刷新两次才能打开」的根）。
//
// 为什么放在这里、还要等 load + 空闲：
//   首次访问本来就要下 5 个首屏资源（实测最坏 20~56 秒），注册 SW 绝不能再跟首屏抢带宽
//   ⇒ 只在【首屏已经渲染完（load 之后）+ 浏览器空闲】时注册，对首屏耗时零影响。
// 为什么只在生产构建注册：
//   vite dev 的模块路径是源码路径、每次热更都变，缓存它们只会让开发时看到旧代码。
// ⛔ 注册失败不影响任何功能（浏览器不支持 / 隐私模式 / 清过站内数据）—— 只是回到了「没有本地缓存」。
if (import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const register = () => {
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        // ★★ [BOOT-SW-WARM 2026-10-31] 首访预热。
        //   SW 是在 load 之后才注册的，首屏那些资源**早就下完了**，fetch 处理器一条都没看到
        //   ⇒ 不补这一步，缓存会一直是空的（实测确认过）。这里把本次实际用到的同源 /assets/ 资源
        //   连同当前页面地址一起交给 SW 写进缓存 ⇒ 当天就完成预热，第二天早上直接秒开。
        //   `cache.add` 命中 HTTP 缓存时不会重新下载，所以这一步对流量/耗时的影响可以忽略。
        const urls = [];
        try {
          urls.push(location.pathname);           // 页面本身（离线时的兜底 HTML）
          const ents = performance.getEntriesByType('resource') || [];
          const seen = new Set();
          ents.forEach((e) => {
            const u = String(e && e.name || '');
            if (!u.startsWith(location.origin)) return;
            if (u.indexOf('/assets/') < 0) return;
            if (seen.has(u)) return;
            seen.add(u);
            urls.push(u);
          });
        } catch (e) { /* 拿不到 performance 就只预热页面本身 */ }
        const send = () => {
          const sw = navigator.serviceWorker.controller || reg.active;
          if (sw && urls.length) { try { sw.postMessage({ type: 'WARM', urls: urls }); } catch (e) {} }
        };
        if (navigator.serviceWorker.controller) send();
        else navigator.serviceWorker.addEventListener('controllerchange', send, { once: true });
      }).catch((e) => {
        console.warn('[BOOT-SW] 注册失败（不影响使用，只是没有本地缓存）:', (e && e.message) || e);
      });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(register, { timeout: 4000 });
    else setTimeout(register, 2000);
  });
}
