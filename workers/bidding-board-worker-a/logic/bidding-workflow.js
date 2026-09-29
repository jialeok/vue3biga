// logic/bidding-workflow.js — 竞价主流程
import { CONFIG, POINT_TO_COLUMN } from '../config.js';
import { beijingToday } from '../../_shared-source/date-utils.js';
import { isTradingDay, getConstituentThscodes, getStockSnapshotPcts } from '../data/fuyao-api.js';
import { readTodayBiddingRows, upsertBiddingRows, writeLog } from '../data/supabase-write.js';
import { computeBiddingRows, avgOf, fmtPct } from './bidding-calc.js';

export async function runBidding(env, point, source) {
  const date = beijingToday();
  const column = POINT_TO_COLUMN[point];
  const logBase = { run_date: date, time_point: point, source: source || 'cron', job: 'bidding', worker: 'A' };
  if (!column) return { ok: false, error: '未知 time_point: ' + point };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let existingByName = {};
  if (point === 't0925') {
    try { (await readTodayBiddingRows(env, date)).forEach(r => existingByName[(r.name || '').trim()] = r); }
    catch (e) { console.error('读今日行失败:', e.message); }
  }

  function buildUpsertPayload(computed, now) {
    const payload = [];
    const results = {};
    Object.keys(computed).forEach(rowName => {
      const r = computed[rowName];
      results[rowName] = r;
      if (r.value === null || r.value === undefined) return;
      const row = { date: date, name: rowName, updated_at: now };
      row[column] = r.value;
      if (point === 't0925') {
        const prev = existingByName[rowName];
        const v920 = prev ? parseFloat(prev.time920) : NaN;
        const v925 = parseFloat(r.value);
        if (!isNaN(v920) && !isNaN(v925)) row.change = v925 > v920 ? '增' : (v925 < v920 ? '减' : '平');

      }
      payload.push(row);
    });
    return { payload, results };
  }

  const computed = await computeBiddingRows(env, point);

  // 先写入所有非 null 行（不等重试），防止 Worker 超时导致全部丢失
  const now1 = new Date().toISOString();
  const { payload: payload1, results: results1 } = buildUpsertPayload(computed, now1);
  let ok = true, writeError = null;
  if (payload1.length > 0) {
    try { await upsertBiddingRows(env, payload1); }
    catch (e) { ok = false; writeError = e.message; }
  }

  // 重试失败的行（先写入成功行后再等重试，超时也不影响已写入的数据）
  const failedRowNames = Object.keys(computed).filter(k => computed[k].value === null || computed[k].value === undefined);
  if (failedRowNames.length > 0) {
    console.log('本趟有 ' + failedRowNames.length + ' 行未抓到(' + failedRowNames.join(',') + ')，45 秒后重试...');
    await new Promise(r => setTimeout(r, 45000));
    try {
      const retry = await computeBiddingRows(env, point);
      const retryComputed = {};
      failedRowNames.forEach(k => { if (retry[k] && retry[k].value !== null && retry[k].value !== undefined) { computed[k] = retry[k]; retryComputed[k] = retry[k]; } });
      const now2 = new Date().toISOString();
      const { payload: payload2 } = buildUpsertPayload(retryComputed, now2);
      if (payload2.length > 0) {
        try { await upsertBiddingRows(env, payload2); }
        catch (e) { console.warn('重试写入失败:', e.message); }
      }
    } catch (e) { console.warn('45 秒重试失败:', e.message); }
  }

  await writeLog(env, Object.assign(logBase, { ok, detail: { written: payload1, rows: results1, writeError } }));
  return { ok, date, point, column, written: payload1, rows: results1, writeError };
}

export async function runDuobanSecond(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0926', source: source || 'cron', job: 'duoban-second', worker: 'A' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  // 9:26 补写：不仅补"最近多板%"，也补其它4行（板块ETF/昨日资金前十/大盘ETF/大盘（%））
  // 防止 9:25 整趟 runBidding 超时失败时，只有最近多板%有补救
  const computed = await computeBiddingRows(env, 't0926');
  const duobanResult = computed[CONFIG.ROW_LADDER] || { value: null, error: '未计算' };

  let existingByName = {};
  try {
    const rows = await readTodayBiddingRows(env, date);
    rows.forEach(r => existingByName[(r.name || '').trim()] = r);
  } catch (e) { console.error('读今日行失败:', e.message); }

  const now = new Date().toISOString();
  const upsertPayload = [];

  // 最近多板%time26 行：写 9:26 抓取值，change 与"最近多板%"行 time925 比较
  if (duobanResult.value !== null && duobanResult.value !== undefined) {
    const time26Row = { date: date, name: '最近多板%time26', time925: duobanResult.value, updated_at: now };
    const duibanExisting = existingByName[CONFIG.ROW_LADDER];
    if (duibanExisting && duibanExisting.time925 !== undefined && duibanExisting.time925 !== null && String(duibanExisting.time925).trim() !== '') {
      const v925 = parseFloat(duibanExisting.time925);
      const v926 = parseFloat(duobanResult.value);
      if (!isNaN(v925) && !isNaN(v926)) time26Row.change = v926 > v925 ? '增' : (v926 < v925 ? '减' : '平');
    }
    upsertPayload.push(time26Row);
  }

  // 其它4行：只写非 null 值到 time925 列（补写 9:25 缺失的数据）
  const otherRows = [CONFIG.ROW_SECTOR_ETF, CONFIG.ROW_TOP10, CONFIG.ROW_BIG_ETF, CONFIG.ROW_MAIN_INDEX];
  otherRows.forEach(rowName => {
    const r = computed[rowName];
    if (!r || r.value === null || r.value === undefined) return;
    const otherRow = { date: date, name: rowName, time925: r.value, updated_at: now };
    const prev = existingByName[rowName];
    if (prev && prev.time920 !== undefined && prev.time920 !== null && String(prev.time920).trim() !== '') {
      const v926 = parseFloat(r.value);
      const v920 = parseFloat(prev.time920);
      if (!isNaN(v926) && !isNaN(v920)) otherRow.change = v926 > v920 ? '增' : (v926 < v920 ? '减' : '平');
    }
    upsertPayload.push(otherRow);
  });

  let ok = true, writeError = null;
  if (upsertPayload.length > 0) {
    try { await upsertBiddingRows(env, upsertPayload); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(env, Object.assign(logBase, { ok, detail: { written: upsertPayload, row: duobanResult, writeError } }));
  return { ok, date, point: 't0926', written: upsertPayload, row: duobanResult, writeError };
}