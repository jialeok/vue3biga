import { getSupabase } from './supabase-client.js';
import { _warn, _isDateKey } from './board-helpers.js';
import { _stocksMemCache, _dirty, _lastPushed } from './board-state.js';

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
  } catch (e) {
    _warn('loadStocksForDate ' + date + ' 失败: ' + (e.message || e));
  }
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
