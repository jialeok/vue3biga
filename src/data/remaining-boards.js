import { state } from '../logic/app-state.js';
import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';
import { _emit } from '../stores/eventBus.js';
import { showToast } from '../composables/useToast.js';
import { useUiStore } from '../stores/uiStore.js';

const MODULE_KEYS = ['stocks', 'rank', 'multi', 'hotspot', 'pattern', 'tagTitles'];

const _stocksMemCache = state._stocksMemCache = {};
const _rankMemCache = state._rankMemCache = {};
const _multiMemCache = state._multiMemCache = {};
const _hotspotMemCache = state._hotspotMemCache = {};
const _patternMemCache = state._patternMemCache = {};
const _tagTitlesMemCache = state._tagTitlesMemCache = {};

const _caches = {
  stocks: _stocksMemCache,
  rank: _rankMemCache,
  multi: _multiMemCache,
  hotspot: _hotspotMemCache,
  pattern: _patternMemCache,
  tagTitles: _tagTitlesMemCache
};

const _dirty = {
  stocks: new Set(),
  rank: new Set(),
  multi: new Set(),
  hotspot: new Set(),
  pattern: new Set(),
  tagTitles: new Set()
};

const _lastPushed = {
  stocks: {},
  rank: {},
  multi: {},
  hotspot: {},
  pattern: {},
  tagTitles: {}
};

let _pushDebounceTimer = null;
let _isPushing = false;
let _lastLoadDate = null;

function _moduleKey(name) {
  return 'stockApp_v42_' + name;
}

function _readLegacyObject(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}'); // 合规：旧版一次性迁移读取（§8 允许，非持久化）
  } catch (e) {
    return {};
  }
}

function _isDateKey(k) {
  return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k);
}

function _warn(msg) {
  console.warn('[RB]', msg);
}

const STOCK_FIELD_MAP = {
  id: 'local_id',
  name: 'name',
  stage: 'stage',
  adjust: 'adjust',
  open: 'open',
  close: 'close',
  turnover: 'turnover',
  kbiliangkai: 'kbiliangkai',
  sfliangneng: 'sfliangneng',
  xgcaiti: 'xgcaiti',
  nextDay: 'next_day',
  bomb: 'bomb',
  bought: 'bought',
  sold: 'sold',
  sellHigh: 'sell_high',
  sell1120: 'sell_1120',
  sell1450: 'sell_1450',
  hold: 'hold',
  watch: 'watch',
  dragon: 'dragon',
  pattern: 'pattern',
  axis: 'axis',
  comment: 'comment',
  remark: 'remark',
  remarkType: 'remark_type',
  track: 'track',
  soldRecords: 'sold_records',
  isSold: 'is_sold',
  recentMulti: 'recent_multi',
  topicDirection: 'topic_direction',
  sectorEtf: 'sector_etf',
  nishi: 'nishi',
  shunshi: 'shunshi',
  inheritedHold: 'inherited_hold'
};

function _stockToRow(date, stock) {
  const row = { date };
  Object.keys(STOCK_FIELD_MAP).forEach(key => {
    const col = STOCK_FIELD_MAP[key];
    let val = stock[key];
    if (val === undefined) val = null;
    row[col] = val;
  });
  return row;
}

function _rowToStock(row) {
  const stock = {};
  Object.keys(STOCK_FIELD_MAP).forEach(key => {
    const col = STOCK_FIELD_MAP[key];
    let val = row[col];
    if (val === null) val = undefined;
    stock[key] = val;
  });
  return stock;
}

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

async function loadStocksForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('stocks_data')
      .select('*')
      .eq('date', date)
      .order('local_id', { ascending: false });
    if (error) throw error;
    const list = (data || []).map(_rowToStock);
    if (list.length > 0 || !_stocksMemCache[date]) {
      _stocksMemCache[date] = list;
      _lastPushed.stocks[date] = JSON.stringify(list);
    }
  } catch (e) {
    _warn('loadStocksForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function loadRankForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('rank_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    const hasData = data && Array.isArray(data.data);
    const val = hasData ? data.data : (_rankMemCache[date] || []);
    _rankMemCache[date] = val;
    _lastPushed.rank[date] = JSON.stringify(val);
  } catch (e) {
    _warn('loadRankForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function loadMultiForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('multi_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    const hasData = data && Array.isArray(data.data);
    const val = hasData ? data.data : (_multiMemCache[date] || []);
    _multiMemCache[date] = val;
    _lastPushed.multi[date] = JSON.stringify(val);
  } catch (e) {
    _warn('loadMultiForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function loadHotspotForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('hotspot_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    const hasData = data && typeof data.content === 'string';
    const val = hasData ? data.content : (_hotspotMemCache[date] || '');
    _hotspotMemCache[date] = val;
    _lastPushed.hotspot[date] = val;
  } catch (e) {
    _warn('loadHotspotForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function loadPatternForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('pattern_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    const defaultVal = { content: '', update: false, keep: false };
    const val = data
      ? { content: data.content || '', update: !!data.update_flag, keep: !!data.keep_flag }
      : (_patternMemCache[date] || defaultVal);
    _patternMemCache[date] = val;
    _lastPushed.pattern[date] = JSON.stringify(val);
  } catch (e) {
    _warn('loadPatternForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function loadTagTitlesForDate(date) {
  if (!date) return;
  try {
    const sb = getSupabase();
    const { data, error } = await sb
      .from('tag_titles_data')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw error;
    const defaultVal = {
      recentMulti: { tags: [], active: {}, score: 0 },
      sectorEtf: { tags: [], active: {}, score: 0 },
      topicDirection: { tags: [], active: {}, score: 0 },
      consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
    };
    const hasData = data && data.data && typeof data.data === 'object';
    const val = hasData ? data.data : (_tagTitlesMemCache[date] || defaultVal);
    _tagTitlesMemCache[date] = val;
    _lastPushed.tagTitles[date] = JSON.stringify(val);
  } catch (e) {
    _warn('loadTagTitlesForDate ' + date + ' 失败: ' + (e.message || e));
  }
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

async function saveStocksForDate(date) {
  if (!date) return;
  const list = Array.isArray(_stocksMemCache[date]) ? _stocksMemCache[date] : [];
  try {
    const sb = getSupabase();
    const localRows = list.filter(s => s && s.name).map(s => _stockToRow(date, s));
    const localNames = new Set(localRows.map(r => r.name));

    // 1. 查询云端现有行（仅取 name），计算需要删除的差集
    const { data: cloudRows, error: qErr } = await sb
      .from('stocks_data')
      .select('name')
      .eq('date', date);
    if (qErr) throw qErr;
    const toDeleteNames = (cloudRows || [])
      .map(r => r.name)
      .filter(n => !localNames.has(n));

    // 2. upsert 本地行（插入+更新）；失败时云端仍保留旧数据，不丢数据
    if (localRows.length > 0) {
      const { error: upErr } = await sb.from('stocks_data')
        .upsert(localRows, { onConflict: 'date,name' });
      if (upErr) throw upErr;
    }

    // 3. 删除云端有但本地已无的行
    if (toDeleteNames.length > 0) {
      const { error: delErr } = await sb.from('stocks_data')
        .delete()
        .eq('date', date)
        .in('name', toDeleteNames);
      if (delErr) throw delErr;
    }

    _lastPushed.stocks[date] = JSON.stringify(list);
  } catch (e) {
    _warn('saveStocksForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

async function saveRankForDate(date) {
  if (!date) return;
  const data = _rankMemCache[date] || [];
  try {
    const sb = getSupabase();
    await sb.from('rank_data').upsert({ date, data }, { onConflict: 'date' });
    _lastPushed.rank[date] = JSON.stringify(data);
  } catch (e) {
    _warn('saveRankForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

async function saveMultiForDate(date) {
  if (!date) return;
  const data = _multiMemCache[date] || [];
  try {
    const sb = getSupabase();
    await sb.from('multi_data').upsert({ date, data }, { onConflict: 'date' });
    _lastPushed.multi[date] = JSON.stringify(data);
  } catch (e) {
    _warn('saveMultiForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

async function saveHotspotForDate(date) {
  if (!date) return;
  const content = _hotspotMemCache[date] || '';
  try {
    const sb = getSupabase();
    await sb.from('hotspot_data').upsert({ date, content }, { onConflict: 'date' });
    _lastPushed.hotspot[date] = content;
  } catch (e) {
    _warn('saveHotspotForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

async function savePatternForDate(date) {
  if (!date) return;
  const p = _patternMemCache[date] || { content: '', update: false, keep: false };
  try {
    const sb = getSupabase();
    await sb.from('pattern_data').upsert({
      date,
      content: p.content || '',
      update_flag: !!p.update,
      keep_flag: !!p.keep
    }, { onConflict: 'date' });
    _lastPushed.pattern[date] = JSON.stringify(p);
  } catch (e) {
    _warn('savePatternForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

async function saveTagTitlesForDate(date) {
  if (!date) return;
  const data = _tagTitlesMemCache[date] || {
    recentMulti: { tags: [], active: {}, score: 0 },
    sectorEtf: { tags: [], active: {}, score: 0 },
    topicDirection: { tags: [], active: {}, score: 0 },
    consecutiveUp: { duoban: 0, bankuai: 0, ticai: 0 }
  };
  try {
    const sb = getSupabase();
    await sb.from('tag_titles_data').upsert({ date, data }, { onConflict: 'date' });
    _lastPushed.tagTitles[date] = JSON.stringify(data);
  } catch (e) {
    _warn('saveTagTitlesForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
}

export function markRemainingDirty(module, date) {
  if (!module || !date || !_dirty[module]) return;
  _dirty[module].add(date);
}

export function markAllRemainingDirty(date) {
  if (!date) return;
  MODULE_KEYS.forEach(key => _dirty[key].add(date));
}

function scanStocksDirty() {
  Object.keys(_stocksMemCache).forEach(date => {
    if (!_isDateKey(date)) return;
    const snap = JSON.stringify(_stocksMemCache[date]);
    if (_lastPushed.stocks[date] !== snap) {
      _dirty.stocks.add(date);
    }
  });
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

function _watchDate() {
  let _last = _currentDate();
  if (_last) _onDateChanged(_last);
  setInterval(() => {
    const d = _currentDate();
    if (d && d !== _last) {
      _last = d;
      _onDateChanged(d);
    }
  }, 300);
}

function _subscribeRealtime() {
  try {
    const sb = getSupabase();
    sb.channel('remaining-boards-changes')
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
  }
}

export function initRemainingBoards() {
  preloadLegacyToCaches();
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
    _watchDate();
    _subscribeRealtime();
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

initRemainingBoards();
