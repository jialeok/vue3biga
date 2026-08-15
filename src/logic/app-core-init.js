// app-core-init.js — 从 app-core.js 抽离的「启动期初始化副作用」（§16 架构拆分：中转站瘦身）
//
// 本文件仅承载 app-core.js 原模块加载即执行（顶层语句）的初始化副作用：
//   - realtime 订阅绑定（_bindApi 注册 API 门面、_initAuctionMemCache 启动各 store 实时订阅）
//   - _bindUiFns({ renderAuction }) 注册（刷新链路 auction-refresh 必需）
//   - 基础 state 初始化（DATA_VERSION、各 dirty-date Set、currentFilter 等）
//   - 陈旧 lastEditedDate 清理、启动诊断日志、invalidateTopicCache 注入
//
// 所有纯函数/业务逻辑仍留在 app-core.js。本文件由 app-core.js 的 initApp()
// （应用初始化入口，密码验证成功后调用）显式调用，外部引用零破坏。
import { state } from './app-state.js';
import { _bindApi } from './app-core-api.js';
import { _dbgLog } from '../data/debug-log.js';
import { _setInvalidateTopicCacheFn } from '../data/auction-data.js';
import { _initAuctionMemCache } from '../data/session-and-shield.js';
import { _bindUiFns } from '../stores/auctionStore.js';
import { renderAuction } from './ui-bridge.js';
import { invalidateTopicCache } from '../data/stock-topics.js';
import { _guardStack, _guardAssertDate, _getAuctionStore } from './shared/core-shared.js';
// 复用 app-core.js 既有局部绑定（含域模块 re-export 名），避免重复 import 与循环依赖风险。
// 这些绑定在 app-core.js 求值完成后才被 initAppCore() 在运行时引用，循环依赖安全。
import {
  getCurrentDate, getAuctionData, getGroupData, scheduleCloudPush, markAuctionDirty,
  saveData, getTodayAuction, getNextTradingDay, getHotAuctionData, saveModule,
  patchAuctionFieldBatch, reconcileAuctionWatchlistFromLocalStorage, mergeAuctionDateRows,
  _openHotAuctionShield, _closeHotAuctionShield, getStockHistoryTopics, getRankData,
  getTagTitlesData, getTodayJiwang, getTodayGroupList, markJiwangDirty,
  replaceHotConceptFromPaste, importAuctionFromPaste, replaceConceptFromPaste, importHotFromPaste,
  _migrateFromV41, _uiDateSafe
} from './app-core.js';

// 幂等保护：initApp 在登录链路可能被多次触发（LoginOverlay 直接调用 + auth:login-success 事件），
// 初始化副作用只运行一次，避免重复注册 API 门面 / UI 函数 / realtime 订阅。
let _coreInitDone = false;

export function initAppCore() {
  if (_coreInitDone) return;
  _coreInitDone = true;

  // 记录"确实发生过增删股票操作"的 auction 日期。
  // 只有被标记过的日期，在 pushToCloud 合并云端数据时才允许用本地名单覆盖云端，
  // 避免仅仅因为翻看某个历史日期（currentDate 指向它）就被误判为"允许增删"。
  if (!state._auctionDirtyDates) state._auctionDirtyDates = new Set();

  // 记录"jiwang 数据确实被改动过"的日期，saveData() 据此判断是否需要
  // 推送该日期到 jiwang_data 表，避免每次 saveData()（可能因为改股票、改题材等
  // 与 jiwang 无关的操作触发）都无谓地 upsert 一次 jiwang_data。
  if (!state._jiwangDirtyDates) state._jiwangDirtyDates = new Set();

  state.DATA_VERSION = 'v42';

  // 一次性清理：早期测试阶段遗留的陈旧 lastEditedDate（如 2025-01-02）会导致
  // 应用一直卡在那个日期。这里清除"去年今日"之前的值，让它退回默认走"今天"。
  // 只做一次判断、直接清除 key，不做动态阈值计算。
  const _staleLastEditedDate = localStorage.getItem('lastEditedDate_' + state.DATA_VERSION);
  const _minValidDate = (new Date().getFullYear() - 1) + '-01-01';
  if (_staleLastEditedDate && _staleLastEditedDate < _minValidDate) {
    localStorage.removeItem('lastEditedDate_' + state.DATA_VERSION);
  }

  if (typeof _dbgLog === 'function') {
    _dbgLog('页面脚本加载: currentDate 初始化为 ' + _uiDateSafe() + ' | 代码版本 v3-0804-RANKCACHE-FIX（找到真正瓶颈：getRankData每题材调用N次→改为每次渲染只调用1次，避免反复触发响应式store写入）');
    _dbgLog('[AUCTION-GUARD] selfCheck active=true refIdentity=' + (state._auctionMemCache === (typeof _getAuctionStore() !== 'undefined' && _getAuctionStore() ? _getAuctionStore().auctionData : null)) + ' dates=' + Object.keys(state._auctionMemCache || {}).length);
  }

  state.isStrengthSortEnabled = false;

  state.currentFilter = 'all';
  state.isStockListCollapsed = true; // 股票列表收起状态（默认收起，与原版 initStockListCollapse 一致）
  state.editingId = null;
  state.topicAutoFilled = false;

  state._migrateFromV41 = _migrateFromV41;
  state._guardStack = _guardStack;
  state._guardAssertDate = _guardAssertDate;

  _bindApi({ getCurrentDate, getAuctionData, getGroupData, scheduleCloudPush, markAuctionDirty, saveData, getTodayAuction, getNextTradingDay, getHotAuctionData, saveModule, patchAuctionFieldBatch, reconcileAuctionWatchlistFromLocalStorage, mergeAuctionDateRows, _openHotAuctionShield, _closeHotAuctionShield, getStockHistoryTopics, getRankData, getTagTitlesData, getTodayJiwang, getTodayGroupList, markJiwangDirty, replaceHotConceptFromPaste, importAuctionFromPaste, replaceConceptFromPaste, importHotFromPaste });

  // [FIX 2026-08-15] _bindUiFns 仅保留真实实现（renderAuction → auction-refresh 事件）；
  // 原绑定的 toggleStrengthSort 等一批空桩对应 store action 已删除（Vue 组件走本地实现，§16）。
  // 刷新链路必需：必须随初始化逻辑一起执行，确保 auction-refresh 事件能触发 renderAuction。
  _bindUiFns({ renderAuction });

  _initAuctionMemCache();

  _setInvalidateTopicCacheFn(invalidateTopicCache);
}
