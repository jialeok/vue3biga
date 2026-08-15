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
};

app.use(createPinia());
app.use(router);

// [FIX 2026-08-16] §24/§25 生命周期：initRemainingBoards 原在 remaining-boards.js 模块顶层立即执行，
// 抢在 app.use(createPinia()) 之前调用 useUiStore() → Pinia 未激活 → "_s" 报错（unhandled rejection）。
// 改在 Pinia 安装后显式调用，保证 store 可用、启动流程可预期。
initRemainingBoards();

// 单向同步：uiStore.currentDate（唯一真相）→ auctionStore.currentDate（显示镜像）。
// 仅从真理同步到镜像，不产生第二个真相源；auctionStore.currentDate 只经此通道更新。
const _uiStore = useUiStore();
const _auctionStore = useAuctionStore();
watch(() => _uiStore.currentDate, (v) => { if (_auctionStore.currentDate !== v) _auctionStore.currentDate = v; });

app.mount('#app');
