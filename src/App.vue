<template>
  <LoginOverlay ref="loginRef" />
  <DebugLogModal ref="debugRef" />
  <NumcatChoiceModal />
  <RouterView v-if="authReady" />
</template>

<script setup>
import { ref, onMounted } from 'vue';
import LoginOverlay from './components/LoginOverlay.vue';
import DebugLogModal from './components/DebugLogModal.vue';
import NumcatChoiceModal from './components/NumcatChoiceModal.vue';
import { useAuthStore } from './stores/authStore.js';
import { startSessionPoll } from './data/watchlist-and-metrics.js';
import { pullDailyHighlights } from './data/daily-highlights.js';
import { pullHotStocksHighlights, loadHotStocksFromCloud } from './data/hot-stocks.js';
import { loadCoreTopicsFromCloud } from './logic/topic-rules.js';
import { pullFromCloud } from './logic/workflows/auction-sync.js';
import { initApp, getCurrentDate, migrateAuctionToTable, migrateAuctionDataToNewTables } from './logic/app-core.js';
import { loadAllData } from './data/supabase-client.js';
import { _emit, _on } from './stores/eventBus.js';
import { _dbgLog } from './data/debug-log.js';
import { pullBiddingForDate, migrateBiddingToTable } from './data/bidding-data.js';
import { migrateJiwangToTable, pullJiwangForDate } from './data/jiwang-data.js';
import { showToast, showWarningToast } from './composables/useToast.js';
import { state } from './logic/app-state.js';

const loginRef = ref(null);
const debugRef = ref(null);
const authReady = ref(false);
const authStore = useAuthStore();

function setupGlobalListeners() {
  document.addEventListener('contextmenu', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return true;
    e.preventDefault();
  });
  document.addEventListener('selectstart', function(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return true;
    e.preventDefault();
  });
}

function runMigrations() {
  try { migrateAuctionToTable(); } catch (e) { _dbgLog('[MIGRATE] auctionToTable: ' + e); }
  try { migrateAuctionDataToNewTables(); } catch (e) { _dbgLog('[MIGRATE] auctionDataToNewTables: ' + e); }
  try { migrateBiddingToTable(); } catch (e) { _dbgLog('[MIGRATE] biddingToTable: ' + e); }
  try { migrateJiwangToTable(); } catch (e) { _dbgLog('[MIGRATE] jiwangToTable: ' + e); }
}

function setupEventBus() {
  _on('data:realtime-update', function(data) {
    if (!data || !data.boards || data.boards === 'all') {
      _emit('stocks-refresh');
      _emit('jiwang-refresh');
      _emit('auction-refresh');
      _emit('board-refresh');
      _emit('bidding-refresh');
      _emit('duiban-refresh');
      _emit('emotion-refresh');
      _emit('etf-refresh');
      return;
    }
    var b = data.boards;
    if (b === 'auction') _emit('auction-refresh');
    else if (b === 'jiwang') _emit('jiwang-refresh');
    else if (b === 'bidding') _emit('bidding-refresh');
    else if (b === 'hot') _emit('stocks-refresh');
    else if (b === 'marketStage') _emit('bidding-refresh');
  });

  _on('ui:toast', function(data) {
    if (data && data.type === 'warning') showWarningToast(data.msg, data.duration || 3000);
    else if (data && data.type === 'success') showToast(data.msg);
  });

  _on('auth:force-logout', function() {
    loginRef.value && loginRef.value.forceLogout();
  });

  _on('data:cloud-changed', function() {
    pullFromCloud().then(function() {
      state.allData = null; loadAllData();
      _emit('data:realtime-update', { boards: 'all' });
      _dbgLog('Realtime: pullFromCloud 完成并已重新渲染');
    }).catch(function(e) { _dbgLog('Realtime: pullFromCloud 失败: ' + (e && e.message)); });
  });
}

function setupVisibilityChange() {
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible') return;
    _dbgLog('visibilitychange: 切回前台, state.currentDate=' + state.currentDate);
    state.allData = null;
    loadAllData();
    _emit('stocks-refresh');
    _emit('auction-refresh');
    pullBiddingForDate(state.currentDate).then(() => _emit('bidding-refresh')).catch(e => console.warn('切回前台 bidding:', e.message));
    state._emotionDataCache = null;
    _emit('emotion-refresh');
    const jiwangPending = (state._jiwangDirtyDates && state._jiwangDirtyDates.has(state.currentDate)) ||
      (state._jiwangPushTimers && state._jiwangPushTimers[state.currentDate]);
    if (!jiwangPending) {
      pullJiwangForDate(state.currentDate).then(() => _emit('jiwang-refresh')).catch(e => console.warn('切回前台 jiwang:', e.message));
    }
  });
}

function onLoginSuccess() {
  authReady.value = true;
  try { initApp(); } catch (e) { console.error('initApp failed:', e); }
  runMigrations();
  setupEventBus();
  setupVisibilityChange();

  pullDailyHighlights().then(() => _emit('auction-refresh')).catch(e => _dbgLog('[AUCTION-ERR] daily_highlights ' + (e && e.message || e)));
  pullHotStocksHighlights().catch(e => console.warn('hot_stocks_highlights:', e.message));
  loadHotStocksFromCloud().then(() => _emit('auction-refresh')).catch(e => console.warn('hot_stocks:', e.message));
  pullBiddingForDate(getCurrentDate()).then(() => _emit('bidding-refresh')).catch(e => _dbgLog('[BIDDING] 首屏快速加载失败 ' + (e && e.message || e)));
  loadCoreTopicsFromCloud().then(() => _emit('auction-refresh')).catch(e => console.warn('core_topics:', e && e.message || e));

  pullFromCloud().then(() => {
    state.allData = null; loadAllData();
    _emit('auction-refresh');
    _emit('stocks-refresh');
    _emit('bidding-refresh');
    _emit('board-refresh');
    _emit('jiwang-refresh');
  }).catch(e => _dbgLog('[AUCTION-ERR] background pullFromCloud ' + (e && e.message || e)));
}

onMounted(async () => {
  setupGlobalListeners();
  _on('auth:login-success', onLoginSuccess);

  if (localStorage.getItem('unlocked') !== '1' && sessionStorage.getItem('unlocked') === '1') {
    localStorage.setItem('unlocked', '1');
    const oldToken = sessionStorage.getItem('sessionToken');
    if (oldToken) localStorage.setItem('sessionToken', oldToken);
  }

  if (localStorage.getItem('unlocked') === '1') {
    const savedToken = localStorage.getItem('sessionToken');
    if (!savedToken) {
      localStorage.removeItem('unlocked');
      loginRef.value && loginRef.value.showPassword();
      return;
    }

    authStore.sessionToken = savedToken;
    startSessionPoll();
    onLoginSuccess();
  } else {
    loginRef.value && loginRef.value.showPassword();
  }
});
</script>
