// src/logic/stocks/stocks-edit.js
//
// 股票「编辑 / 卖出记录 / 追踪记录 / 导入」的缓存更新 + 保存到云端 Logic 层。
// 原逻辑分散在 HomeStocksView.vue 中直接读写 Data 层内部缓存（getStocksData()[date]），
// 违反架构规范 §2（UI 不得越界写 Data 内部对象）。此处集中承担：
//   1) 修改内存缓存（Data 层暴露的 _stocksMemCache）
//   2) 触发 saveData() 标记脏数据
//   3) 通过 remainingBoards.pushRemainingNow() 立即同步到 Supabase
//   4) 返回真实成败（Promise），供 UI 据此 toast（§10 禁止静默失败）
//
// 注：deleteStock 已存在于 stock-operations.js（同属 Logic 层），本文件不重复。

import { getStocksData } from '../../data/supabase-client.js';
import { getCurrentDate, saveData } from '../app-core.js';
import { pushRemainingNow, markAllRemainingDirty } from '../../data/remaining-boards.js';

function _genSoldId() {
  return Date.now().toString() + Math.random().toString(36).substr(2, 5);
}

const BOOL_FIELDS = [
  'bought', 'sold', 'hold', 'watch', 'dragon', 'bomb',
  'sellHigh', 'sell1120', 'sell1450',
  'topicDirection', 'recentMulti', 'sectorEtf', 'nishi', 'shunshi'
];

function _coerceFields(fields) {
  const out = {};
  Object.keys(fields || {}).forEach(k => {
    if (BOOL_FIELDS.includes(k)) {
      out[k] = !!fields[k];
    } else {
      out[k] = fields[k];
    }
  });
  return out;
}

// 编辑股票基础字段。成功 resolve(true)，云端推送失败 reject(Error)。
export async function saveStockFields(id, fields) {
  const date = getCurrentDate();
  const list = getStocksData()[date] || [];
  const stock = list.find(s => s.id === id || s.id == id);
  if (!stock) {
    throw new Error('未找到股票数据');
  }
  Object.assign(stock, _coerceFields(fields));
  saveData();
  const res = await pushRemainingNow(date);
  if (!res.success) throw res.error || new Error('云端保存失败');
  return true;
}

// 保存卖出记录（含历史标记推导与未来日期同名股票的同步复制）。
export async function saveSoldRecords(id, rows) {
  const date = getCurrentDate();
  const list = getStocksData()[date] || [];
  const stockIndex = list.findIndex(s => s.id === id || s.id == id);
  if (stockIndex === -1) {
    throw new Error('未找到股票数据');
  }
  const stock = list[stockIndex];
  const records = (rows || [])
    .filter(r => (r.date || '').trim())
    .map(r => ({
      id: r.id || _genSoldId(),
      date: (r.date || '').trim(),
      profit: (r.profit || '').trim(),
      percent: (r.percent || '').trim(),
      type: r.type || ''
    }));

  const hasFullClear = records.some(r => r.type === '全清仓');
  const hasValidSold = records.some(r => r.type === '全清仓' || r.type === '部分卖');
  const isFirstSold = !stock.soldRecords || stock.soldRecords.length === 0;

  stock.soldRecords = records;
  stock.isSold = records.length > 0;
  if (isFirstSold && records.length > 0 && !stock.bought) { stock.bought = true; }
  if (!isFirstSold && hasValidSold) { stock.bought = false; stock.sold = true; }
  if (hasFullClear) {
    if (stock.hold || stock.bought) { stock.hold = false; stock.bought = false; stock.sold = true; }
  } else if (hasValidSold) {
    if (!stock.sold) stock.sold = true;
  }

  // 同步未来交易日同名股票的卖出记录
  const stockName = stock.name;
  const allData = getStocksData();
  const allDates = Object.keys(allData).sort();
  const curIdx = allDates.indexOf(date);
  if (curIdx !== -1) {
    for (let i = curIdx + 1; i < allDates.length; i++) {
      const futureList = allData[allDates[i]];
      const fi = futureList.findIndex(s => s.name === stockName);
      if (fi !== -1) {
        futureList[fi].soldRecords = JSON.parse(JSON.stringify(records));
        futureList[fi].isSold = records.length > 0;
      }
    }
  }

  saveData();
  const res = await pushRemainingNow(date);
  if (!res.success) throw res.error || new Error('云端保存失败');
  return true;
}

// 保存追踪记录。
export async function saveTrack(id, rows) {
  const date = getCurrentDate();
  const list = getStocksData()[date] || [];
  const stock = list.find(s => s.id === id || s.id == id);
  if (!stock) {
    throw new Error('未找到股票数据');
  }
  stock.track = (rows || [])
    .map(r => ({ date: (r.date || '').trim(), content: (r.content || '').trim() }))
    .filter(r => r.date || r.content);
  saveData();
  const res = await pushRemainingNow(date);
  if (!res.success) throw res.error || new Error('云端保存失败');
  return true;
}

// 批量导入数据（整体替换各日期缓存后推送所有受影响日期）。
export async function importStockData(imported) {
  if (!imported || typeof imported !== 'object') {
    throw new Error('导入数据格式不正确');
  }
  const stocksData = getStocksData();
  const dates = Object.keys(imported);
  if (dates.length === 0) {
    throw new Error('导入文件为空');
  }
  dates.forEach(date => {
    stocksData[date] = imported[date];
    markAllRemainingDirty(date);
  });
  // 立即推送全部受影响日期（clearTimeout 在 pushRemainingNow 内部处理）
  const res = await pushRemainingNow(getCurrentDate());
  if (!res.success) throw res.error || new Error('云端导入保存失败');
  return true;
}
