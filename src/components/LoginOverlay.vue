<template>
  <!-- 密码遮罩：未解锁时覆盖整个应用 -->
  <div v-if="passwordVisible" id="passwordOverlay" class="login-overlay">
    <div class="login-panel">
      <div class="login-title">请输入密码</div>
      <input
        id="pwdInput"
        ref="pwdInputRef"
        v-model="pwd"
        type="password"
        class="login-input"
        placeholder="密码"
        @keyup.enter="checkPassword"
      />
      <div id="pwdError" class="login-error">{{ errorMsg }}</div>
      <div id="syncStatus" class="login-status" :style="{ color: statusColor }">{{ statusText }}</div>
      <button class="login-btn" :disabled="loading" @click="checkPassword">
        {{ loading ? '登录中...' : '登录' }}
      </button>
    </div>
  </div>

  <!-- 被踢下线遮罩 -->
  <div v-if="kickedVisible" id="kickedOverlay" class="login-overlay">
    <div class="login-panel">
      <div class="login-title">⚠ 账号在另一处登录</div>
      <div class="login-desc">本会话已被下线，请重新登录</div>
      <button class="login-btn" @click="reloginFromKicked">重新登录</button>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue';
import { _dbgLog } from '../data/debug-log.js';
import { sha256, PASSWORD_HASH } from '../data/supabase-client.js';
import { generateToken, writeSessionToken, startSessionPoll, stopSessionPoll } from '../data/watchlist-and-metrics.js';
import { pullFromCloud } from '../logic/workflows/auction-sync.js';
import { initApp, renderHotStocks } from '../logic/app-core.js';
import { pullDailyHighlights } from '../data/daily-highlights.js';
import { _emit } from '../stores/eventBus.js';
import {
  pullHotStocksHighlights,
  migrateHotStocksShadowToMetrics,
  loadHotStocksFromCloud,
  migrateHotStocksToTrendsTable,
  migrateHotTrendsToMarketMetrics,
  loadHotTrendsFromCloud,
} from '../data/hot-stocks.js';
import { loadCloudTopics, buildTopicCache, invalidateTopicCache } from '../data/stock-topics.js';
import { loadCloudStockCodeMap } from '../data/stock-code-map.js';
import { clearPushDebounceTimer } from '../logic/session-helpers.js';
import authStore from '../stores/authStore.js';

const passwordVisible = ref(false);
const kickedVisible = ref(false);
const pwd = ref('');
const errorMsg = ref('');
const statusText = ref('');
const statusColor = ref('');
const loading = ref(false);
const pwdInputRef = ref(null);

function showPassword() {
  passwordVisible.value = true;
  errorMsg.value = '';
    statusText.value = '';
  nextTick(() => { pwdInputRef.value && pwdInputRef.value.focus(); });
}
function hidePassword() { passwordVisible.value = false; }
function showKicked() { kickedVisible.value = true; }

function forceLogout() {
  stopSessionPoll();
  clearPushDebounceTimer();
  authStore.sessionToken = null;
  localStorage.removeItem('unlocked');
  localStorage.removeItem('sessionToken');
  kickedVisible.value = true;
}

async function reloginFromKicked() {
  kickedVisible.value = false;
  showPassword();
}

async function checkPassword() {
  if (!pwd.value) { errorMsg.value = '请输入密码'; return; }
  try {
    loading.value = true;
    const hash = await sha256(pwd.value);
    if (hash !== PASSWORD_HASH) {
      errorMsg.value = '❌ 密码错误，请重试';
      pwd.value = '';
      loading.value = false;
      return;
    }
    errorMsg.value = '';
    statusText.value = '🔄 正在登录并同步数据...';
    statusColor.value = '#60a5fa';
    authStore.sessionToken = generateToken();
    localStorage.setItem('unlocked', '1');
    localStorage.setItem('sessionToken', authStore.sessionToken);
    await writeSessionToken(authStore.sessionToken);
    statusText.value = '🔄 等待数据同步完成...';
    statusColor.value = '#60a5fa';
    await new Promise(resolve => setTimeout(resolve, 3500));
    await pullFromCloud();

    hidePassword();
    startSessionPoll();
    initApp();
  } catch (e) {
    console.error('checkPassword 失败:', e);
  statusText.value = '';
  statusColor.value = '';
    errorMsg.value = '❌ 登录失败：' + (e && e.message ? e.message : String(e));
  } finally {
    loading.value = false;
  }

  // 后台预加载（保留原异步链路）
  pullDailyHighlights().then(() => _emit('auction-refresh')).catch((e) => {
    _dbgLog('[AUCTION-ERR] daily_highlights 加载失败 ' + (e && e.message || e));
  });
  pullHotStocksHighlights().catch((e) => console.warn('hot_stocks_highlights 加载失败:', e.message));
  migrateHotStocksShadowToMetrics().then(() => loadHotStocksFromCloud())
    .then(() => { renderHotStocks(); })
    .catch((e) => console.warn('hot_stocks 加载失败:', e.message));
  migrateHotStocksToTrendsTable().then(() => migrateHotTrendsToMarketMetrics())
    .then(() => loadHotTrendsFromCloud())
    .then(() => { renderHotStocks(); })
    .catch((e) => console.warn('hot trends 加载失败:', e.message));
  loadCloudTopics().then(() => {
    invalidateTopicCache(); buildTopicCache(); _emit('auction-refresh');
  }).catch(() => {});
  loadCloudStockCodeMap().then(() => {
    _emit('auction-refresh');
  }).catch(() => {});
}

defineExpose({ showPassword, hidePassword, showKicked, forceLogout, reloginFromKicked, checkPassword });
</script>

<style scoped>
.login-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  z-index: 99998;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-panel {
  background: #1e293b;
  border-radius: 12px;
  padding: 24px;
  min-width: 320px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}
.login-title {
  color: #e2e8f0;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 16px;
  text-align: center;
}
.login-desc {
  color: #94a3b8;
  font-size: 13px;
  margin-bottom: 16px;
  text-align: center;
}
.login-input {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid #334155;
  border-radius: 8px;
  background: #0f172a;
  color: #e2e8f0;
  font-size: 14px;
  box-sizing: border-box;
}
.login-error {
  color: #ef4444;
  font-size: 12px;
  min-height: 18px;
  margin-top: 8px;
}
.login-status {
  font-size: 12px;
  min-height: 18px;
  margin-top: 4px;
}
.login-btn {
  width: 100%;
  padding: 10px;
  margin-top: 12px;
  border: none;
  border-radius: 8px;
  background: #2563eb;
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.login-btn:disabled {
  background: #475569;
  cursor: not-allowed;
}
</style>