import { getSupabase } from './supabase-client.js';
import { _warn, _isDateKey } from './board-helpers.js';
import { _stocksMemCache, _dirty, _lastPushed, _cloudRowExists, _loadFailedDates } from './board-state.js';

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
    // ★ [BOARD-LOST-G3 2026-10-28 · §10/§11] 记录「云端这一天有没有行」，保存侧据此拒绝空写。
    if (list.length > 0) _cloudRowExists.stocks.add(date);
    else _cloudRowExists.stocks.delete(date);
    _loadFailedDates.stocks.delete(date);    // 本次读到了 ⇒ 解除禁写
  } catch (e) {
    // ★ [BOARD-LOST-G3 2026-10-28 · §10 读取失败 ≠ 空数据] 记下「这一天没读到」，
    //   保存侧据此拒绝推送 —— 否则网络抖一下，随后的差集删除会把云端这一天的名单整批删掉。
    _loadFailedDates.stocks.add(date);
    _warn('loadStocksForDate ' + date + ' 失败: ' + (e.message || e));
  }
}

async function saveStocksForDate(date) {
  if (!date) return;
  // ★ [BOARD-LOST-G3 2026-10-28 · §10/§11 宁缺勿错]
  //   ① 这一天【读取失败过】⇒ 禁止保存。这条对本模块最要紧：saveStocksForDate 会按
  //      「本地有 / 云端有」的差集【删行】，而本地缓存是从云端读来的 —— 读失败后缓存是空的，
  //      一推就会把云端这一天的名单整批 DELETE 掉（比 board 表被覆盖更狠，是硬删）。
  //   ② 本地空 + 云端本来也没有 ⇒ 不推（否则每次刷新都白跑一次 select('name')）。
  //   ⚠️ 反向必须放行：云端有行 + 用户把股票全删了 ⇒ 照常推到云端删。
  if (_loadFailedDates.stocks.has(date)) {
    _warn('saveStocksForDate ' + date + ' 跳过：该日期云端读取失败过（§10 读取失败 ≠ 空数据）');
    return;
  }
  const list = Array.isArray(_stocksMemCache[date]) ? _stocksMemCache[date] : [];
  if (list.length === 0 && !_cloudRowExists.stocks.has(date)) return;
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
    // 同步「云端这一天是否还有行」的事实（全删空 ⇒ 云端从此没有这一天）
    if (localRows.length > 0) _cloudRowExists.stocks.add(date);
    else _cloudRowExists.stocks.delete(date);
  } catch (e) {
    _warn('saveStocksForDate ' + date + ' 失败: ' + (e.message || e));
    throw e;
  }
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

export { STOCK_FIELD_MAP, _stockToRow, _rowToStock, loadStocksForDate, saveStocksForDate, scanStocksDirty };
