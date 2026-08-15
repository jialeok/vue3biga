import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';
import { _emit } from '../stores/eventBus.js';
import { useUiStore } from '../stores/uiStore.js';

import {
  MODULE_KEYS,
  _stocksMemCache,
  _rankMemCache,
  _multiMemCache,
  _hotspotMemCache,
  _patternMemCache,
  _tagTitlesMemCache,
  _caches,
  _dirty,
  _lastPushed
} from './board-state.js';
import { _moduleKey, _readLegacyObject, _isDateKey, _warn } from './board-helpers.js';

import {
  loadStocksForDate,
  saveStocksForDate,
  scanStocksDirty,
  _stockToRow
} from './board-stocks.js';
import { loadRankForDate, saveRankForDate } from './board-rank.js';
import { loadMultiForDate, saveMultiForDate } from './board-multi.js';
import { loadHotspotForDate, saveHotspotForDate } from './board-hotspot.js';
import { loadPatternForDate, savePatternForDate } from './board-pattern.js';
import { loadTagTitlesForDate, saveTagTitlesForDate } from './board-tagtitles.js';

let _pushDebounceTimer = null;
let _isPushing = false;
let _lastLoadDate = null;

function preloadLegacyToCaches() {
  for (const key of MODULE_KEYS) {
    const legacy = _readLegacyObject(_moduleKey(key));
    if (!legacy || Object.keys(legacy).length === 0) continue;
    if (key === 'stocks') {
      Object.keys(legacy).forEach(date => {
        if (!_isDateKey(date)) return;
        const list = legacy[date] || [];
        if (Array.isArray(list) && list.length > 0) _stocksMemCache[date] = list;
      });
    } else if (key === 'rank') {
      Object.assign(_rankMemCache, legacy);
    } else if (key === 'multi') {
      Object.assign(_multiMemCache, legacy);
    } else if (key === 'hotspot') {
      Object.assign(_hotspotMemCache, legacy);
    } else if (key === 'pattern') {
      Object.assign(_patternMemCache, legacy);
    } else if (key === 'tagTitles') {
      Object.assign(_tagTitlesMemCache, legacy);
    }
  }
}

async function migrateLegacyBoardsToSupabase() {
  if (localStorage.getItem('stockApp_v42_remaining_migrated') === '1') return; // 合规：一次性迁移标记（§8 允许）

  for (const key of MODULE_KEYS) {
    const legacy = _readLegacyObject(_moduleKey(key));
    if (!legacy || Object.keys(legacy).length === 0) continue;

    try {
      if (key === 'stocks') {
        const rows = [];
        Object.keys(legacy).forEach(date => {
          if (!_isDateKey(date)) return;
          const list = legacy[date] || [];
          list.forEach(stock => {
            if (!stock || !stock.name) return;
            rows.push(_stockToRow(date, stock));
          });
        });
        if (rows.length > 0) {
          const sb = getSupabase();
          await sb.from('stocks_data').upsert(rows, { onConflict: 'date,name' });
        }
      } else if (key === 'rank' || key === 'multi') {
        const sb = getSupabase();
        for (const date of Object.keys(legacy)) {
          if (!_isDateKey(date)) continue;
          const data = legacy[date];
          if (!data || (Array.isArray(data) && data.length === 0)) continue;
          await sb.from(key + '_data').upsert({ date, data }, { onConflict: 'date' });
        }
      } else if (key === 'hotspot') {
        const sb = getSupabase();
        for (const date of Object.keys(legacy)) {
          if (!_isDateKey(date)) continue;
          const content = legacy[date] || '';
          if (!content) continue;
          await sb.from('hotspot_data').upsert({ date, content }, { onConflict: 'date' });
        }
      } else if (key === 'pattern') {
        const sb = getSupabase();
        for (const date of Object.keys(legacy)) {
          if (!_isDateKey(date)) continue;
          const p = legacy[date] || {};
          await sb.from('pattern_data').upsert({
            date,
            content: p.content || '',
            update_flag: !!p.update,
            keep_flag: !!p.keep
          }, { onConflict: 'date' });
        }
      } else if (key === 'tagTitles') {
        const sb = getSupabase();
        for (const date of Object.keys(legacy)) {
          if (!_isDateKey(date)) continue;
          const data = legacy[date];
          if (!data) continue;
          await sb.from('tag_titles_data').upsert({ date, data }, { onConflict: 'date' });
        }
      }
    } catch (e) {
      _warn('迁移 ' + key + ' 失败: ' + (e.message || e));
    }
  }

  localStorage.setItem('stockApp_v42_remaining_migrated', '1'); // 合规：一次性迁移标记（§8 允许）
}

async function loadAllRemainingForDate(date) {
  if (!date) return;
  await Promise.all([
    loadStocksForDate(date),
    loadRankForDate(date),
    loadMultiForDate(date),
    loadHotspotForDate(date),
    loadPatternForDate(date),
    loadTagTitlesForDate(date)
  ]);
}

export function markRemainingDirty(module, date) {
  if (!module || !date || !_dirty[module]) return;
  _dirty[module].add(date);
}

export function markAllRemainingDirty(date) {
  if (!date) return;
  MODULE_KEYS.forEach(key => _dirty[key].add(date));
}

async function pushAllRemainingDirty() {
  if (_isPushing) return;
  _isPushing = true;
  const failures = [];
  try {
    scanStocksDirty();
    const tasks = [];
    MODULE_KEYS.forEach(key => {
      _dirty[key].forEach(date => {
        if (key === 'stocks') tasks.push(saveStocksForDate(date).then(() => _dirty.stocks.delete(date)).catch(e => failures.push({ key, date, e })));
        else if (key === 'rank') tasks.push(saveRankForDate(date).then(() => _dirty.rank.delete(date)).catch(e => failures.push({ key, date, e })));
        else if (key === 'multi') tasks.push(saveMultiForDate(date).then(() => _dirty.multi.delete(date)).catch(e => failures.push({ key, date, e })));
        else if (key === 'hotspot') tasks.push(saveHotspotForDate(date).then(() => _dirty.hotspot.delete(date)).catch(e => failures.push({ key, date, e })));
        else if (key === 'pattern') tasks.push(savePatternForDate(date).then(() => _dirty.pattern.delete(date)).catch(e => failures.push({ key, date, e })));
        else if (key === 'tagTitles') tasks.push(saveTagTitlesForDate(date).then(() => _dirty.tagTitles.delete(date)).catch(e => failures.push({ key, date, e })));
      });
    });
    if (tasks.length > 0) {
      await Promise.all(tasks);
      _dbgLog('[RB] 已推送 ' + tasks.length + ' 个脏日期到 Supabase');
    }
  } finally {
    _isPushing = false;
  }
  // §10：禁止静默失败。只要有任一模块推送失败即整体 reject，供调用方 toast 错误。
  if (failures.length > 0) {
    const summary = failures
      .map(f => f.key + '[' + f.date + ']: ' + (f.e && f.e.message ? f.e.message : f.e))
      .join('; ');
    throw new Error('部分模块推送失败 - ' + summary);
  }
}

// 返回 Promise：防抖到点后执行推送，resolve({ success:true }) / resolve({ success:false, error })
// 永不 reject，避免调用方未捕获导致 unhandled rejection。
export function scheduleRemainingPush() {
  if (_pushDebounceTimer) clearTimeout(_pushDebounceTimer);
  return new Promise((resolve) => {
    _pushDebounceTimer = setTimeout(() => {
      pushAllRemainingDirty()
        .then(() => resolve({ success: true }))
        .catch(e => {
          _warn('scheduleRemainingPush error: ' + (e.message || e));
          resolve({ success: false, error: e });
        });
    }, 1200);
  });
}

// 返回 Promise：立即（清除防抖）推送当前脏数据，
// resolve({ success:true }) 或 resolve({ success:false, error })。
export function pushRemainingNow(date) {
  if (date) markAllRemainingDirty(date);
  if (_pushDebounceTimer) clearTimeout(_pushDebounceTimer);
  return pushAllRemainingDirty()
    .then(() => ({ success: true }))
    .catch(e => {
      _warn('pushRemainingNow error: ' + (e.message || e));
      return { success: false, error: e };
    });
}

function _currentDate() {
  if (useUiStore().currentDate) return useUiStore().currentDate;
  return null;
}

async function _onDateChanged(date) {
  if (!date || date === _lastLoadDate) return;
  _lastLoadDate = date;
  pushRemainingNow();
  await loadAllRemainingForDate(date);
  _emit('stocks-refresh');
  _emit('board-refresh');
}

// [FIX P1-9] 300ms 轮询处置说明：本轮询仅负责监听「UI 当前交易日(_currentDate)」的切换，
// 属于本地 UI 状态变化（用户在界面上切换交易日），Realtime 推送只能推送数据库表行变更，
// 无法感知本地 UI 状态切换，故该功能不可替代，保留轮询。但持有 timer 引用，确保 _watchDate
// 被重复调用时不会创建多个并行轮询循环（§31 防重复创建）。
let _watchDateTimer = null;
function _watchDate() {
  if (_watchDateTimer) { clearInterval(_watchDateTimer); _watchDateTimer = null; }
  let _last = _currentDate();
  if (_last) _onDateChanged(_last);
  _watchDateTimer = setInterval(() => {
    const d = _currentDate();
    if (d && d !== _last) {
      _last = d;
      _onDateChanged(d);
    }
  }, 300);
}

// [FIX P1-9 §31] 模块级持有 channel 引用，支持统一退订，避免重复订阅/泄漏
let _remainingRealtimeChannel = null;

function _subscribeRealtime() {
  // 自保护：若 channel 已存在，先退订再重建，防止重复订阅（§31 防重复订阅）
  if (_remainingRealtimeChannel) {
    try { getSupabase().removeChannel(_remainingRealtimeChannel); } catch (e) {}
    _remainingRealtimeChannel = null;
  }
  try {
    const sb = getSupabase();
    _remainingRealtimeChannel = sb
      .channel('remaining-boards-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stocks_data' }, (payload) => {
        const date = payload.new && payload.new.date;
        if (date && date !== _currentDate()) {
          loadStocksForDate(date);
        } else if (date) {
          loadStocksForDate(date).then(() => _emit('stocks-refresh'));
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rank_data' }, (payload) => {
        const date = payload.new && payload.new.date;
        if (date === _currentDate()) loadRankForDate(date);
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'multi_data' }, (payload) => {
        const date = payload.new && payload.new.date;
        if (date === _currentDate()) loadMultiForDate(date).then(() => _emit('board-refresh'));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'hotspot_data' }, (payload) => {
        const date = payload.new && payload.new.date;
        if (date === _currentDate()) loadHotspotForDate(date).then(() => _emit('board-refresh'));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'pattern_data' }, (payload) => {
        const date = payload.new && payload.new.date;
        if (date === _currentDate()) loadPatternForDate(date).then(() => _emit('board-refresh'));
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tag_titles_data' }, (payload) => {
        const date = payload.new && payload.new.date;
        if (date === _currentDate()) loadTagTitlesForDate(date).then(() => _emit('board-refresh'));
      })
      .subscribe();
  } catch (e) {
    _warn('Realtime 订阅失败: ' + (e.message || e));
    _remainingRealtimeChannel = null;
  }
}

// [FIX P1-9 §31] 配对退订：同时移除 remaining-boards 的 Realtime channel 与日期监听轮询，
// 避免会话/页面离开后 channel 与 setInterval 双重泄漏（§31 防重复订阅 + 清理定时器 + 无泄漏轮询）
export function stopRemainingRealtime() {
  if (_remainingRealtimeChannel) {
    try { getSupabase().removeChannel(_remainingRealtimeChannel); } catch (e) {}
    _remainingRealtimeChannel = null;
  }
  if (_watchDateTimer) {
    clearInterval(_watchDateTimer);
    _watchDateTimer = null;
  }
}

export function initRemainingBoards() {
  preloadLegacyToCaches();
  // [FIX 2026-08-16] §24/§25 生命周期：本函数原来在模块顶层立即执行（文件末尾 initRemainingBoards();），
  // 而本模块被 app-core.js 等静态 import → 顶层代码在 main.js 执行 app.use(createPinia()) 之前就运行，
  // 内部 _currentDate() → useUiStore() 在 Pinia 未激活时调用，抛 "Cannot read properties of undefined (reading '_s')"
  // （_s 是 Pinia 内部字段，未激活实例为 undefined），且 async 链无 catch 变成 unhandled rejection。
  // 现改为由 main.js 在 Pinia 安装后显式调用；此处异步链补 catch（§10 不静默失败，失败打日志不中断其它启动）。
  (async () => {
    const d = _currentDate();
    if (d) {
      await loadAllRemainingForDate(d);
    }
    try {
      await migrateLegacyBoardsToSupabase();
    } catch (e) {
      _warn('迁移失败: ' + (e.message || e));
    }
    if (d) await loadAllRemainingForDate(d);
  })().then(() => {
    _lastLoadDate = _currentDate(); // 标记已加载日期，避免 _watchDate 立即重复加载（§33 首载/刷新分离）
    _watchDate();
    _subscribeRealtime();
  }).catch((e) => {
    _warn('initRemainingBoards 初始化失败: ' + (e && e.message ? e.message : e));
  });
}

export const remainingBoards = {
  markDirty: markRemainingDirty,
  markAllDirty: markAllRemainingDirty,
  schedulePush: scheduleRemainingPush,
  pushNow: pushRemainingNow,
  loadForDate: loadAllRemainingForDate,
  loadStocks: loadStocksForDate,
  saveStocks: saveStocksForDate,
  caches: _caches
};

// [FIX 2026-08-16] 不再在模块顶层立即执行 initRemainingBoards()（会抢在 Pinia 安装前调用 useUiStore
// 导致 _s 报错）；改由 main.js 在 app.use(createPinia()) 之后显式调用（§24/§25 生命周期）。
