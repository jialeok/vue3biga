import { createApp, watch } from 'vue';
import { createPinia } from 'pinia';
import router from './router/index.js';
import App from './App.vue';
import './assets/main.css';
import { useUiStore } from './stores/uiStore.js';
import { useAuctionStore } from './stores/auctionStore.js';

const app = createApp(App);

app.config.errorHandler = (err, instance, info) => {
  console.error('[APP ERROR]', err, info);
};

app.use(createPinia());
app.use(router);

// 单向同步：uiStore.currentDate（唯一真相）→ auctionStore.currentDate（显示镜像）。
// 仅从真理同步到镜像，不产生第二个真相源；auctionStore.currentDate 只经此通道更新。
const _uiStore = useUiStore();
const _auctionStore = useAuctionStore();
watch(() => _uiStore.currentDate, (v) => { if (_auctionStore.currentDate !== v) _auctionStore.currentDate = v; });

app.mount('#app');
