// logic/bidding-calc.js — 竞价变化计算
import { CONFIG } from '../config.js';
import { getConstituentThscodes, getStockSnapshotPcts, getIndexSnapshotPcts } from '../data/fuyao-api.js';
import { getTencentSnapshotPcts } from '../data/tencent-api.js';

export function avgOf(numbers) {
  if (!numbers.length) return null;
  return numbers.reduce(function (a, b) { return a + b; }, 0) / numbers.length;
}

export function fmtPct(n) {
  return (Math.round(n * 100) / 100).toFixed(2);
}

export async function computeBiddingRows(env, point) {
  const rows = {};

  try {
    const codes = await getConstituentThscodes(env, CONFIG.LADDER_INDEX);
    if (codes.length === 0) rows[CONFIG.ROW_LADDER] = { value: null, error: '883410 成分股为空' };
    else {
      const pcts = await getStockSnapshotPcts(env, codes);
      const vals = codes.map(c => pcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
      const avg = avgOf(vals);
      rows[CONFIG.ROW_LADDER] = avg === null
        ? { value: null, error: '成分股快照全部缺失(' + codes.length + '只)' }
        : { value: fmtPct(avg), missing: codes.length - vals.length > 0 ? [String(codes.length - vals.length) + '只无快照'] : undefined };
    }
  } catch (e) { rows[CONFIG.ROW_LADDER] = { value: null, error: e.message }; }

  try {
    const stockCodes = CONFIG.SECTOR_ETFS.filter(e => e.type === 'stock').map(e => e.code);
    const indexCodes = CONFIG.SECTOR_ETFS.filter(e => e.type === 'index').map(e => e.code);
    const stockPcts = await getTencentSnapshotPcts(stockCodes);
    const indexPcts = await getIndexSnapshotPcts(env, indexCodes);
    let red = 0;
    const missing = [];
    CONFIG.SECTOR_ETFS.forEach(e => {
      const pct = e.type === 'stock' ? stockPcts[e.code] : indexPcts[e.code];
      if (typeof pct === 'number' && !isNaN(pct)) { if (pct > 0) red++; }
      else missing.push(e.name);
    });
    rows[CONFIG.ROW_SECTOR_ETF] = { value: String(red), missing: missing.length ? missing : undefined };
  } catch (e) { rows[CONFIG.ROW_SECTOR_ETF] = { value: '0', error: e.message }; }

  try {
    const codes = await getConstituentThscodes(env, CONFIG.TOP10_INDEX);
    if (codes.length === 0) rows[CONFIG.ROW_TOP10] = { value: '0', error: '883901 成分股为空' };
    else {
      const pcts = await getStockSnapshotPcts(env, codes);
      let red = 0, have = 0;
      codes.forEach(c => { const v = pcts[c]; if (typeof v === 'number' && !isNaN(v)) { have++; if (v > 0) red++; } });
      rows[CONFIG.ROW_TOP10] = have === 0
        ? { value: '0', error: '883901 成分股快照全部缺失(' + codes.length + '只)' }
        : { value: String(red), missing: codes.length - have > 0 ? [String(codes.length - have) + '只无快照'] : undefined };
    }
  } catch (e) { rows[CONFIG.ROW_TOP10] = { value: '0', error: e.message }; }

  try {
    const pcts = await getTencentSnapshotPcts(CONFIG.BIG_ETFS);
    const vals = CONFIG.BIG_ETFS.map(c => pcts[c]).filter(v => typeof v === 'number' && !isNaN(v));
    const avg = avgOf(vals);
    rows[CONFIG.ROW_BIG_ETF] = avg === null
      ? { value: '0.00', error: '大盘ETF快照全部缺失' }
      : { value: fmtPct(avg), missing: CONFIG.BIG_ETFS.length - vals.length > 0 ? [String(CONFIG.BIG_ETFS.length - vals.length) + '只无快照'] : undefined };
  } catch (e) { rows[CONFIG.ROW_BIG_ETF] = { value: '0.00', error: e.message }; }

  try {
    const pcts = await getIndexSnapshotPcts(env, [CONFIG.MAIN_INDEX]);
    const v = pcts[CONFIG.MAIN_INDEX];
    rows[CONFIG.ROW_MAIN_INDEX] = (typeof v === 'number' && !isNaN(v)) ? { value: fmtPct(v) } : { value: '0.00', error: '上证指数快照缺失' };
  } catch (e) { rows[CONFIG.ROW_MAIN_INDEX] = { value: '0.00', error: e.message }; }

  return rows;
}