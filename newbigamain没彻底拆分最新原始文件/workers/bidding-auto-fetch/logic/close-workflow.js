// close-workflow.js — 收盘涨幅覆盖主流程
import { beijingToday, isWeekend } from '../../_shared-source/date-utils.js';
import { localIsTradingDay } from '../../_shared-source/holidays.js';
import { CONFIG } from '../config.js';
import { fetchSnapshotChangePct } from '../data/fuyao-api.js';
import { sbHeaders, upsertMarketMetrics } from '../data/supabase-write.js';

export async function runClose(env) {
  const logs = [];
  const today = beijingToday();
  logs.push('today=' + today);

  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }

  // 1. 读取当日 auction_watchlist 获取股票列表
  logs.push('步骤1：读取当日 auction_watchlist...');
  const readUrl = CONFIG.SUPABASE_URL + '/rest/v1/auction_watchlist?date=eq.' + encodeURIComponent(today) + '&select=stock,code';
  let watchlist;
  try {
    const resp = await fetch(readUrl, { headers: sbHeaders(env) });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 200));
    }
    watchlist = await resp.json();
  } catch (e) {
    logs.push('读取 auction_watchlist 失败: ' + e.message);
    return { ok: false, today, error: '读取 auction_watchlist 失败: ' + e.message, logs };
  }
  logs.push('auction_watchlist 读取 ' + watchlist.length + ' 只');

  // 【FIX 2026-08-03 Bug1】watchlist 为空时明确报警返回 ok:false
  if (watchlist.length === 0) {
    logs.push('❌ 当日 auction_watchlist 为空，说明今早 morning cron 未成功写入 watchlist，close 无法覆盖涨幅');
    logs.push('❌ 请检查今早 9:25 morning cron 是否触发、numcat/fuyao 接口是否正常');
    return {
      ok: false,
      today,
      error: '当日 auction_watchlist 为空（morning cron 可能未成功）',
      skipped: true,
      reason: '当日列表为空',
      logs
    };
  }

  // 2. fuyao snapshot 批量获取收盘涨幅
  // 【FIX 2026-08-03 Bug2】覆盖率 < 50% 时延迟重试（60秒/120秒）
  const codes = watchlist.map(w => w.code).filter(Boolean);
  const COVERAGE_THRESHOLD = 0.5;
  const RETRY_DELAYS_SEC = [60, 120];

  let snapshotResult = await fetchSnapshotChangePct(env, codes);
  let pctMap = snapshotResult.pctMap;
  let stats = snapshotResult.stats;
  let coverage = codes.length > 0 ? stats.success / codes.length : 0;
  logs.push('步骤2：调用 fuyao snapshot 获取收盘涨幅...');
  logs.push('snapshot 第1次: success=' + stats.success + '/' + codes.length + ' (覆盖率 ' + (coverage * 100).toFixed(1) + '%)'
    + ' batchOk=' + stats.batchOk + ' batchFail=' + stats.batchFail
    + ' singleOk=' + stats.singleOk + ' singleFail=' + stats.singleFail
    + ' itemsReturned=' + stats.itemsReturned
    + ' emptyField=' + stats.emptyField + ' notMatched=' + stats.notMatched);

  for (let attempt = 0; attempt < RETRY_DELAYS_SEC.length && coverage < COVERAGE_THRESHOLD; attempt++) {
    const waitSec = RETRY_DELAYS_SEC[attempt];
    logs.push('⏳ snapshot 覆盖率 ' + (coverage * 100).toFixed(1) + '% 低于阈值 ' + (COVERAGE_THRESHOLD * 100) + '%，'
      + waitSec + '秒后重试第' + (attempt + 1) + '次...');
    await new Promise(r => setTimeout(r, waitSec * 1000));
    try {
      const retryResult = await fetchSnapshotChangePct(env, codes);
      const retryCoverage = codes.length > 0 ? retryResult.stats.success / codes.length : 0;
      logs.push('snapshot 第' + (attempt + 2) + '次: success=' + retryResult.stats.success + '/' + codes.length
        + ' (覆盖率 ' + (retryCoverage * 100).toFixed(1) + '%)'
        + ' batchOk=' + retryResult.stats.batchOk + ' batchFail=' + retryResult.stats.batchFail
        + ' singleOk=' + retryResult.stats.singleOk + ' singleFail=' + retryResult.stats.singleFail
        + ' itemsReturned=' + retryResult.stats.itemsReturned
        + ' emptyField=' + retryResult.stats.emptyField + ' notMatched=' + retryResult.stats.notMatched);
      if (retryResult.stats.success > stats.success) {
        pctMap = retryResult.pctMap;
        stats = retryResult.stats;
        coverage = retryCoverage;
        logs.push('✅ 重试第' + (attempt + 1) + '次结果更好，采用重试结果 (success=' + stats.success + ')');
      } else {
        logs.push('第' + (attempt + 1) + '次重试结果未改善 (success=' + retryResult.stats.success + ')');
      }
    } catch (e) {
      logs.push('第' + (attempt + 1) + '次重试请求失败: ' + e.message);
    }
  }

  if (stats.success === 0) {
    logs.push('❌ snapshot 接口未返回任何涨幅（可能接口故障/限流/收盘数据未结算），本次未覆盖任何涨幅');
    return {
      ok: false,
      today,
      error: 'snapshot 接口未返回任何涨幅数据',
      stocksCount: watchlist.length,
      snapshotStats: stats,
      logs
    };
  }

  if (coverage < COVERAGE_THRESHOLD) {
    logs.push('⚠️ snapshot 覆盖率仅 ' + (coverage * 100).toFixed(1) + '%，部分股票涨幅未覆盖（可能停牌/接口部分失败），仍写入已获取的 ' + stats.success + ' 只');
  } else {
    logs.push('snapshot 覆盖率 ' + (coverage * 100).toFixed(1) + '%，正常');
  }

  // 3. 写入 market_metrics（只覆盖 change_pct）
  logs.push('步骤3：写入 market_metrics change_pct...');
  const nowIso = new Date().toISOString();
  const metricsRows = watchlist.filter(w => w.code && pctMap[w.code]).map(w => ({
    date: today,
    stock: w.stock,
    code: w.code,
    change_pct: pctMap[w.code],
    scope: 'auction',
    source: 'worker',
    updated_at: nowIso,
    updated_by: 'auto-fetch-worker-close'
  }));

  try {
    await upsertMarketMetrics(env, metricsRows);
    logs.push('market_metrics 写入 ' + metricsRows.length + ' 行 change_pct');
  } catch (e) {
    logs.push('写入 market_metrics 失败: ' + e.message);
    return { ok: false, today, error: '写入 market_metrics 失败: ' + e.message, logs };
  }

  // 【FIX 2026-08-03】数据完整性汇总
  const summaryParts = [];
  if (coverage < COVERAGE_THRESHOLD) summaryParts.push('⚠️ snapshot 覆盖率低 ' + (coverage * 100).toFixed(1) + '%');
  const uncoveredCount = watchlist.length - metricsRows.length;
  if (uncoveredCount > 0) summaryParts.push('未覆盖 ' + uncoveredCount + ' 只（可能停牌/接口未返回）');
  const completenessSummary = summaryParts.length > 0 ? summaryParts.join('；') : '✅ 涨幅覆盖完整 ' + metricsRows.length + '/' + watchlist.length;
  logs.push('数据完整性汇总: ' + completenessSummary);

  logs.push('完成: 收盘涨幅覆盖 ' + metricsRows.length + ' 只');
  return {
    ok: true,
    today,
    stocksCount: watchlist.length,
    pctUpdated: metricsRows.length,
    coverage: coverage,
    snapshotStats: stats,
    completenessSummary: completenessSummary,
    logs
  };
}