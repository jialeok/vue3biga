// §14 App.vue 瘦身 — 应用引导逻辑组合式
// 将原来堆在 App.vue <script setup> 中的登录 / Migration / Realtime /
// 股票同步 / 竞价同步 / 热点同步 / 数据迁移 / VisibilityChange 等引导逻辑
// 统一收敛到此处，App.vue 仅保留模板与最小脚本。
import { ref, onMounted } from 'vue';
import { useAuthStore } from '../stores/authStore.js';
import { startSessionPoll } from '../data/watchlist-and-metrics.js';
import { pullDailyHighlights } from '../data/daily-highlights.js';
import { pullHotStocksHighlights, loadHotStocksFromCloud } from '../data/hot-stocks.js';
import { loadCoreTopicsFromCloud } from '../logic/topic/rules.js';
import { pullFromCloud } from '../logic/workflows/auction-sync.js';
import { initApp, getCurrentDate } from '../logic/app-core.js';
import { migrateAuctionToTable, migrateAuctionDataToNewTables } from '../data/legacy-migration.js';
import { loadAllData } from '../data/supabase-client.js';
import { hydrateEtfBoardData } from '../data/etf-board-data.js';
import { loadFumianTopics } from '../data/fumian-sync.js';
import { _emit, _on } from '../stores/eventBus.js';
import { _dbgLog } from '../data/debug-log.js';
import { pullBiddingForDate, migrateBiddingToTable } from '../data/bidding-data.js';
import { migrateJiwangToTable, pullJiwangForDate, pullJiwangFromTable } from '../data/jiwang-data.js';
import { showToast, showWarningToast } from './useToast.js';
import { state } from '../logic/app-state.js';
import { useUiStore } from '../stores/uiStore.js';

// loginRef: App.vue 持有的 LoginOverlay 组件 ref，用于 forceLogout / showPassword 调用
export function useAppBootstrap(loginRef) {
  const authReady = ref(false);
  const authStore = useAuthStore();

  function setupGlobalListeners() {
    document.addEventListener('contextmenu', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return true;
      e.preventDefault();
    });
    document.addEventListener('selectstart', function (e) {
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

  // §8/§10 稳健性安全网：确保首屏把 jiwang_data 全量灌入 _jiwangMemCache。
  // 主路径已由 pullFromCloud() 完成；此处作为独立、fail-soft 的兜底，避免：
  //  (1) pullFromCloud 的 jiwang 段被静默吞错（auction-sync.js 的 catch 仅 console.warn），
  //      或 pullFromCloud 在某前置 await 异常后整段未执行，导致 _jiwangMemCache 为空；
  //  (2) 共享统计看板（MonthlyStatsBoard / WeekendStatsBoard）因缓存为空而「一片空白」。
  // pullJiwangFromTable 是幂等全量读取；若缓存已非空则跳过，避免重复请求（§32）。
  function hydrateJiwangAtStartup() {
    if (state._jiwangMemCache && Object.keys(state._jiwangMemCache).length > 0) {
      return Promise.resolve();
    }
    return pullJiwangFromTable().then(function (tableJiwang) {
      if (!state._jiwangMemCache) state._jiwangMemCache = {};
      Object.keys(tableJiwang).forEach(function (d) {
        state._jiwangMemCache[d] = tableJiwang[d];
      });
      if (state.allData) state.allData.jiwang = state._jiwangMemCache;
      _emit('jiwang-refresh');
      _dbgLog('[BOOTSTRAP] jiwang 首屏 hydrate 完成，共 ' + Object.keys(state._jiwangMemCache).length + ' 天');
    }).catch(function (e) {
      // §10/§11：fail-soft —— 出错不破坏其它启动流程，也绝不把读取失败伪装成空去触发删除。
      console.error('[BOOTSTRAP] jiwang 首屏 hydrate 失败（统计看板可能为空，但云端数据未被破坏）:', e && e.message || e);
      _dbgLog('[BOOTSTRAP] jiwang hydrate 失败: ' + (e && e.message));
    });
  }

  function setupEventBus() {
    _on('data:realtime-update', function (data) {
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

    _on('ui:toast', function (data) {
      if (data && data.type === 'warning') showWarningToast(data.msg, data.duration || 3000);
      else if (data && data.type === 'success') showToast(data.msg);
    });

    _on('auth:force-logout', function () {
      loginRef.value && loginRef.value.forceLogout();
    });

    _on('data:cloud-changed', function () {
      pullFromCloud().then(function () {
        state.allData = null; loadAllData();
        _emit('data:realtime-update', { boards: 'all' });
        _dbgLog('Realtime: pullFromCloud 完成并已重新渲染');
      }).catch(function (e) { _dbgLog('Realtime: pullFromCloud 失败: ' + (e && e.message)); });
    });
  }

  function setupVisibilityChange() {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      _dbgLog('visibilitychange: 切回前台, useUiStore().currentDate=' + useUiStore().currentDate);
      state.allData = null;
      loadAllData();
      _emit('stocks-refresh');
      _emit('auction-refresh');
      pullBiddingForDate(useUiStore().currentDate).then(() => _emit('bidding-refresh')).catch(e => console.warn('切回前台 bidding:', e.message));
      state._emotionDataCache = null;
      _emit('emotion-refresh');
      const jiwangPending = (state._jiwangDirtyDates && state._jiwangDirtyDates.has(useUiStore().currentDate)) ||
        (state._jiwangPushTimers && state._jiwangPushTimers[useUiStore().currentDate]);
      if (!jiwangPending) {
        pullJiwangForDate(useUiStore().currentDate).then(() => _emit('jiwang-refresh')).catch(e => console.warn('切回前台 jiwang:', e.message));
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
    hydrateEtfBoardData().then(() => _emit('etf-refresh')).catch(e => _dbgLog('[ETF] 启动 hydrate 失败: ' + (e && e.message || e)));
    loadFumianTopics().then(() => _emit('etf-refresh')).catch(e => _dbgLog('[FUMIAN] 启动 hydrate 失败: ' + (e && e.message || e)));

    // §A 类安全网：独立 hydrate jiwang_data 到 _jiwangMemCache（幂等，已填充则跳过，不重复请求）。
    hydrateJiwangAtStartup();

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

    // Dev auto-login: ?autologin=1 bypasses password for testing
    if (new URLSearchParams(location.search).get('autologin') === '1') {
      localStorage.setItem('unlocked', '1'); // 合规：登录会话标记（§8 允许）
      localStorage.setItem('sessionToken', 'dev-autologin'); // 合规：登录会话标记（§8 允许）
    }

    if (localStorage.getItem('unlocked') !== '1' && sessionStorage.getItem('unlocked') === '1') {
      localStorage.setItem('unlocked', '1'); // 合规：登录会话标记（§8 允许）
      const oldToken = sessionStorage.getItem('sessionToken');
      if (oldToken) localStorage.setItem('sessionToken', oldToken); // 合规：登录会话标记（§8 允许）
    }

    if (localStorage.getItem('unlocked') === '1') {
      const savedToken = localStorage.getItem('sessionToken'); // 合规：登录会话标记（§8 允许）
      if (!savedToken) {
        localStorage.removeItem('unlocked'); // 合规：登录会话标记（§8 允许）
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

  return { authReady };
}
