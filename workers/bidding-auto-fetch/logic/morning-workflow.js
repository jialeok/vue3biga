// morning-workflow.js — 早盘竞价抓取主流程（runMorning 拆分为 7 个子函数）
import { beijingToday, isWeekend, compactToDateStr } from '../../_shared-source/date-utils.js';
import { localIsTradingDay } from '../../_shared-source/holidays.js';
import { CONFIG } from '../config.js';
import { fetchLadderConstituents, fetchHistoricalPctChg } from '../data/fuyao-api.js';
import { numcatDailyAuc, numcatDaily } from '../data/numcat-api.js';
import { upsertAuctionWatchlist, upsertMarketMetrics, readAuctionWatchlistForDate } from '../data/supabase-write.js';
import { getRecentTradingDays } from './holiday-check.js';

// 1. 检查是否交易日
function checkTradingDay(today, logs) {
  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }
  return null;
}

// 2. 获取最近多板成分股 + 写入 auction_watchlist
async function fetchAndWriteWatchlist(env, today, logs) {
  logs.push('步骤1：获取最近多板成分股...');
  let ladderConstituents;
  try {
    ladderConstituents = await fetchLadderConstituents(env);
  } catch (e) {
    logs.push('获取成分股失败: ' + e.message);
    return { error: '获取成分股失败: ' + e.message };
  }
  logs.push('成分股数量: ' + ladderConstituents.length);
  if (ladderConstituents.length === 0) {
    return { error: '883410 成分股为空' };
  }

  // [BUG-FIX] 合并前一日 auction_watchlist 表里的额外股票（打标签/观察组），
  // 确保 worker 也为它们抓取竞价数据，否则观察组股票早上没有数据
  let constituents = ladderConstituents;
  try {
    const recentDays = await getRecentTradingDays(env, today, 2);
    const prevDay = recentDays.length >= 2 ? recentDays[recentDays.length - 2] : null;
    if (prevDay) {
      const prevStocks = await readAuctionWatchlistForDate(env, prevDay);
      const existingCodes = new Set(ladderConstituents.map(c => c.code));
      const extraStocks = prevStocks.filter(s => s.code && !existingCodes.has(s.code));
      if (extraStocks.length > 0) {
        logs.push('前一日额外股票(打标签/观察组): ' + extraStocks.length + ' 只，合并到抓取名单');
        constituents = ladderConstituents.concat(extraStocks);
      }
    }
  } catch (e) { logs.push('读取前一日 watchlist 失败(非致命): ' + e.message); }

  // 【BUG-FIX】不写 volume/yest_volume/change_pct/note/topics 字段：
  // 这些字段的真实值由步骤4写入 market_metrics 表。如果这里把空串写进 watchlist，
  // 后续每个交易日的 morning 都会用空串覆盖用户在前端手动编辑过的值。
  // 只为 883410 成分股写入 auction_watchlist（额外股票已在表里，不覆盖 obs_auto_added 等字段）
  logs.push('步骤2：写入 auction_watchlist...');
  const nowIso = new Date().toISOString();
  const watchlistRows = ladderConstituents.map(c => ({
    date: today,
    stock: c.name,
    code: c.code,
    source: 'worker',
    obs_auto_added: false,
    updated_at: nowIso,
    updated_by: 'auto-fetch-worker'
  }));
  try {
    await upsertAuctionWatchlist(env, watchlistRows);
    logs.push('auction_watchlist 写入 ' + watchlistRows.length + ' 行');
  } catch (e) {
    logs.push('写入 auction_watchlist 失败: ' + e.message);
    return { error: '写入 auction_watchlist 失败: ' + e.message };
  }
  return { constituents, watchlistRows, nowIso };
}

// 3. 调 numcat daily_auc 获取竞价数据（含"今天缺失"延迟重试）
async function fetchNumcatWithRetry(env, constituents, today, logs) {
  // 【FIX 2026-08-03】先算出"预期要拿到数据的 N 个交易日"（含今天），再用显式 startdate/enddate 请求
  const expectedDates = await getRecentTradingDays(env, today, CONFIG.NUMCAT_RECENT_DAYS);
  logs.push('步骤3：预期交易日=' + JSON.stringify(expectedDates));
  if (expectedDates.length === 0 || expectedDates[expectedDates.length - 1] !== today) {
    logs.push('⚠️ 预期交易日列表不包含今天(' + today + ')，交易日历可能有问题，仍继续尝试');
  }
  const startYMD = expectedDates.length > 0 ? expectedDates[0].replace(/-/g, '') : today.replace(/-/g, '');
  const endYMD = today.replace(/-/g, '');
  logs.push('步骤3：调用 numcat daily_auc (startdate=' + startYMD + ' enddate=' + endYMD + ')...');
  const symbols = constituents.map(c => c.code).join(',');
  let numcatData;
  try {
    numcatData = await numcatDailyAuc(env, symbols, startYMD, endYMD);
  } catch (e) {
    logs.push('numcat 调用失败: ' + e.message);
    return { error: 'numcat 调用失败: ' + e.message };
  }

  const fields = numcatData.fields || [];
  let items = numcatData.items || [];
  logs.push('numcat 返回 fields=' + JSON.stringify(fields) + ' items=' + items.length + '行');

  // 【FIX 2026-08-03】按预期交易日统计实际返回的行数，缺口清清楚楚打在日志里
  const dateIdxPre = fields.indexOf('tradedate');
  const computeGotDates = (rows) => new Set(rows.map(row => compactToDateStr(String(row[dateIdxPre] || '').trim())).filter(Boolean));
  let missingDatesAfterNumcat = [];
  if (dateIdxPre >= 0) {
    let gotDates = computeGotDates(items);
    let missingDates = expectedDates.filter(d => !gotDates.has(d));
    if (missingDates.length > 0) {
      logs.push('⚠️ numcat 缺失交易日: ' + JSON.stringify(missingDates) + '（预期 ' + JSON.stringify(expectedDates) + '，实际含 ' + JSON.stringify(Array.from(gotDates).sort()) + '）');
    } else {
      logs.push('numcat 覆盖了全部 ' + expectedDates.length + ' 个预期交易日');
    }

    // 【FIX 2026-08-03】若"今天"缺失，做 2 次延迟重试（20秒/40秒）
    if (missingDates.includes(today)) {
      const retryDelaysSec = [20, 40];
      for (let attempt = 0; attempt < retryDelaysSec.length && missingDates.includes(today); attempt++) {
        const waitSec = retryDelaysSec[attempt];
        logs.push('⏳ 今天(' + today + ')数据缺失，' + waitSec + '秒后重试第' + (attempt + 1) + '次...');
        await new Promise(r => setTimeout(r, waitSec * 1000));
        try {
          const retryData = await numcatDailyAuc(env, symbols, startYMD, endYMD);
          const retryItems = retryData.items || [];
          const retryGotDates = computeGotDates(retryItems);
          if (retryGotDates.has(today)) {
            items = retryItems;
            gotDates = retryGotDates;
            missingDates = expectedDates.filter(d => !gotDates.has(d));
            logs.push('✅ 重试第' + (attempt + 1) + '次成功拿到今天数据，items=' + items.length + '行');
          } else {
            logs.push('第' + (attempt + 1) + '次重试仍未拿到今天数据（items=' + retryItems.length + '行）');
          }
        } catch (e) {
          logs.push('第' + (attempt + 1) + '次重试请求失败: ' + e.message);
        }
      }
      if (missingDates.includes(today)) {
        logs.push('❌ 重试后今天(' + today + ')数据仍缺失，本次不会写入今天的 market_metrics，需要手动补抓');
      }
    }
    missingDatesAfterNumcat = missingDates;
  }

  const symIdx = fields.indexOf('symbol');
  const nameIdx = fields.indexOf('name');
  const dateIdx = fields.indexOf('tradedate');
  const volIdx = fields.indexOf('auc_vol');
  const pctIdx = fields.indexOf('auc_pct_chg');
  const ratioIdx = fields.indexOf('auc_to_pre_vol_pct');

  if (symIdx < 0 || dateIdx < 0 || volIdx < 0) {
    return { error: 'numcat 返回字段不完整: ' + JSON.stringify(fields) };
  }

  return { expectedDates, items, fields, symIdx, nameIdx, dateIdx, volIdx, pctIdx, ratioIdx, missingDatesAfterNumcat };
}

// 4. 解析 numcat 数据 → 按 date 分组 → metricsByDate
function parseNumcatToMetrics(items, fields, constituents, logs) {
  const symIdx = fields.indexOf('symbol');
  const nameIdx = fields.indexOf('name');
  const dateIdx = fields.indexOf('tradedate');
  const volIdx = fields.indexOf('auc_vol');
  const pctIdx = fields.indexOf('auc_pct_chg');
  const ratioIdx = fields.indexOf('auc_to_pre_vol_pct');
  const umIdx = fields.indexOf('um_vol');
  const obpIdx = fields.indexOf('open_bid_pct');
  const avrIdx = fields.indexOf('auc_vol_ratio');
  const atrIdx = fields.indexOf('auc_turnover');

  logs.push('步骤4：解析数据并写入 market_metrics...');
  const codeToName = {};
  constituents.forEach(c => { codeToName[c.code] = c.name; });

  const metricsByDate = {};
  let parsedCount = 0;
  let yestVolDerivedCount = 0;

  items.forEach(row => {
    const code = String(row[symIdx] || '').trim();
    const tradedate = String(row[dateIdx] || '').trim();
    const aucVol = row[volIdx];
    const apiName = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
    if (!code || !tradedate || aucVol === null || aucVol === undefined) return;

    const dateStr = compactToDateStr(tradedate);
    if (!dateStr) return;

    const stockName = codeToName[code] || apiName || '';
    if (!stockName) return;

    // volume(万) = auc_vol(手) / 100
    const volNum = Number(aucVol);
    const volumeStr = isNaN(volNum) ? '' : String(Math.round(volNum / 100));

    // changePct = "+X.XX%"
    let changePctStr = '';
    if (pctIdx >= 0) {
      const pct = row[pctIdx];
      if (pct !== null && pct !== undefined && pct !== '') {
        const n = Number(pct);
        if (!isNaN(n)) {
          changePctStr = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
        }
      }
    }

    // yestVolume(万) = auc_vol(手) / auc_to_pre_vol_pct
    let yestVolumeStr = '';
    if (ratioIdx >= 0) {
      const ratio = row[ratioIdx];
      if (ratio !== null && ratio !== undefined && ratio !== '') {
        const r = Number(ratio);
        if (!isNaN(r) && r > 0 && volNum > 0) {
          yestVolumeStr = String(Math.round(volNum / r));
          yestVolDerivedCount++;
        }
      }
    }

    // auc_pct_chg（竞价涨幅）：与 change_pct 同源（均取自 auc_pct_chg 字段），
    // 但后续 step5 会用 numcat daily 的收盘涨幅覆盖 change_pct，
    // 这里单独保存纯竞价涨幅，供「五日竞价涨幅」趋势图使用（不被覆盖）。
    const aucPctChgStr = changePctStr;

    // um_vol（未匹配量，手）→ 万手（与 volume 同口径 ÷100），展示 "251w"
    let umVolStr = '';
    if (umIdx >= 0) {
      const um = row[umIdx];
      if (um !== null && um !== undefined && um !== '') {
        const n = Number(um);
        if (!isNaN(n)) umVolStr = String(Math.round(n / 100));
      }
    }

    // open_bid_pct（抢筹幅度 %）
    let openBidPctStr = '';
    if (obpIdx >= 0) {
      const v = row[obpIdx];
      if (v !== null && v !== undefined && v !== '') {
        const n = Number(v);
        if (!isNaN(n)) openBidPctStr = n.toFixed(2);
      }
    }

    // auc_vol_ratio（竞价量比）
    let aucVolRatioStr = '';
    if (avrIdx >= 0) {
      const v = row[avrIdx];
      if (v !== null && v !== undefined && v !== '') {
        const n = Number(v);
        if (!isNaN(n)) aucVolRatioStr = n.toFixed(2);
      }
    }

    // auc_turnover（真换手率 %）
    let aucTurnoverStr = '';
    if (atrIdx >= 0) {
      const v = row[atrIdx];
      if (v !== null && v !== undefined && v !== '') {
        const n = Number(v);
        if (!isNaN(n)) aucTurnoverStr = n.toFixed(2);
      }
    }

    if (!metricsByDate[dateStr]) metricsByDate[dateStr] = [];
    metricsByDate[dateStr].push({
      stock: stockName,
      code: code,
      volume: volumeStr,
      change_pct: changePctStr,
      yest_volume: yestVolumeStr,
      auc_pct_chg: aucPctChgStr,
      um_vol: umVolStr,
      open_bid_pct: openBidPctStr,
      auc_vol_ratio: aucVolRatioStr,
      auc_turnover: aucTurnoverStr
    });
    parsedCount++;
  });

  logs.push('解析完成: ' + parsedCount + '条, 涉及 ' + Object.keys(metricsByDate).length + ' 个交易日, 反推昨日成交量 ' + yestVolDerivedCount + ' 条');
  return { metricsByDate, parsedCount, yestVolDerivedCount };
}

// 5. numcat daily 获取收盘涨幅（pct_chg），覆盖/补齐 daily_auc 的竞价涨幅
async function fetchAndMergeHistoricalPct(env, constituents, expectedDates, today, metricsByDate, logs) {
  // 【改为 numcat daily API】替代 fuyao historical，更稳定快速，与前端 fetchFiveDaysAuctionFromNumcat 一致
  const numcatCoveredDates = new Set(Object.keys(metricsByDate));
  const historicalDates = expectedDates.filter(d => d < today).sort();
  const phantomDates = historicalDates.filter(d => !numcatCoveredDates.has(d));
  if (phantomDates.length > 0) {
    logs.push('⚠️ numcat daily_auc 完全未返回以下历史交易日（volume/yest_volume 本次无法补齐，change_pct 会尝试用 numcat daily 兜底）: ' + JSON.stringify(phantomDates));
  }
  if (historicalDates.length === 0) {
    logs.push('步骤5：无历史交易日，跳过 numcat daily 涨幅获取');
    return { phantomDates };
  }

  logs.push('步骤5：numcat daily 获取 ' + historicalDates.length + ' 个历史交易日收盘涨幅...');
  const startYMD = historicalDates[0].replace(/-/g, '');
  const endYMD = historicalDates[historicalDates.length - 1].replace(/-/g, '');
  const symbols = constituents.map(c => c.code).join(',');

  try {
    const dailyData = await numcatDaily(env, symbols, startYMD, endYMD);
    const dailyFields = dailyData.fields || [];
    const dailyItems = dailyData.items || [];
    const dSymIdx = dailyFields.indexOf('symbol');
    const dDateIdx = dailyFields.indexOf('tradedate');
    const dPctIdx = dailyFields.indexOf('pct_chg');

    if (dSymIdx < 0 || dDateIdx < 0 || dPctIdx < 0) {
      logs.push('numcat daily 返回字段不完整: ' + JSON.stringify(dailyFields) + '，保留 daily_auc 竞价涨幅');
      return { phantomDates };
    }

    const pctByDate = {};
    let totalPctCount = 0;
    dailyItems.forEach(row => {
      const code = String(row[dSymIdx] || '').trim();
      const tradedate = String(row[dDateIdx] || '').trim();
      const rawPct = row[dPctIdx];
      if (!code || !tradedate || rawPct === null || rawPct === undefined || rawPct === '') return;
      const dateStr = compactToDateStr(tradedate);
      if (!dateStr) return;
      const n = Number(rawPct);
      if (isNaN(n)) return;
      if (!pctByDate[dateStr]) pctByDate[dateStr] = {};
      pctByDate[dateStr][code] = (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
      totalPctCount++;
    });

    logs.push('numcat daily 返回 ' + totalPctCount + ' 条涨幅数据，涉及 ' + Object.keys(pctByDate).length + ' 个交易日');

    let mergedCount = 0;
    let phantomFilledCount = 0;
    historicalDates.forEach(d => {
      const pctMap = pctByDate[d] || {};
      if (metricsByDate[d]) {
        metricsByDate[d].forEach(m => {
          if (pctMap[m.code]) {
            m.change_pct = pctMap[m.code];
            mergedCount++;
          }
        });
      } else if (Object.keys(pctMap).length > 0) {
        metricsByDate[d] = constituents
          .filter(c => pctMap[c.code])
          .map(c => ({ stock: c.name, code: c.code, volume: '', yest_volume: '', change_pct: pctMap[c.code] }));
        phantomFilledCount += metricsByDate[d].length;
      }
    });
    logs.push('历史涨幅合并 ' + mergedCount + ' 条' + (phantomFilledCount > 0 ? '，另外用 numcat daily 补齐了 daily_auc 完全缺失日期的涨幅 ' + phantomFilledCount + ' 条（这些行没有 volume/yest_volume）' : ''));
  } catch (e) {
    logs.push('numcat daily 失败(保留 daily_auc 竞价涨幅): ' + e.message);
  }

  return { phantomDates };
}

// 6. 分桶写入 market_metrics（按字段形状分桶，配合 missing=default 保留云端原值）
async function writeMarketMetricsBatched(env, metricsByDate, nowIso, logs) {
  // 【FIX 2026-08-03】字段算不出来就不放进 payload，配合 missing=default 让 Supabase 保留原值
  let totalMetricsWritten = 0;
  let metricsWriteFailures = 0;
  const dateKeys = Object.keys(metricsByDate);
  for (const dateStr of dateKeys) {
    const shapeBuckets = {};
    metricsByDate[dateStr].forEach(m => {
      const hasVolume = m.volume !== '';
      const hasYestVolume = m.yest_volume !== '';
      const hasChangePct = m.change_pct !== '';
      const hasAucPctChg = m.auc_pct_chg !== '';
      const hasUmVol = m.um_vol !== '';
      const hasOpenBidPct = m.open_bid_pct !== '';
      const hasAucVolRatio = m.auc_vol_ratio !== '';
      const hasAucTurnover = m.auc_turnover !== '';
      const shapeKey = (hasVolume ? 'v' : '') + (hasYestVolume ? 'y' : '') + (hasChangePct ? 'p' : '')
        + (hasAucPctChg ? 'a' : '') + (hasUmVol ? 'u' : '') + (hasOpenBidPct ? 'o' : '')
        + (hasAucVolRatio ? 'r' : '') + (hasAucTurnover ? 't' : '');
      const row = {
        date: dateStr,
        stock: m.stock,
        code: m.code,
        scope: 'auction',
        source: 'worker',
        updated_at: nowIso,
        updated_by: 'auto-fetch-worker'
      };
      if (hasVolume) row.volume = m.volume;
      if (hasYestVolume) row.yest_volume = m.yest_volume;
      if (hasChangePct) row.change_pct = m.change_pct;
      if (hasAucPctChg) row.auc_pct_chg = m.auc_pct_chg;
      if (hasUmVol) row.um_vol = m.um_vol;
      if (hasOpenBidPct) row.open_bid_pct = m.open_bid_pct;
      if (hasAucVolRatio) row.auc_vol_ratio = m.auc_vol_ratio;
      if (hasAucTurnover) row.auc_turnover = m.auc_turnover;
      if (!shapeBuckets[shapeKey]) shapeBuckets[shapeKey] = [];
      shapeBuckets[shapeKey].push(row);
    });
    try {
      let dateWritten = 0;
      for (const shapeKey of Object.keys(shapeBuckets)) {
        await upsertMarketMetrics(env, shapeBuckets[shapeKey]);
        dateWritten += shapeBuckets[shapeKey].length;
      }
      totalMetricsWritten += dateWritten;
      logs.push('  market_metrics ' + dateStr + ': ' + dateWritten + ' 行 (' + Object.keys(shapeBuckets).length + ' 个字段组合批次)');
    } catch (e) {
      metricsWriteFailures++;
      logs.push('  market_metrics ' + dateStr + ' 写入失败: ' + e.message);
    }
  }
  return { totalMetricsWritten, metricsWriteFailures, dateKeys };
}

// 7. 构建数据完整性汇总
function buildCompletenessSummary(today, missingDatesAfterNumcat, phantomDates, metricsWriteFailures, expectedDates, logs) {
  const todayMissing = missingDatesAfterNumcat.includes(today);
  const summaryParts = [];
  if (todayMissing) summaryParts.push('❌ 今天(' + today + ')竞价数据缺失，需手动补抓');
  if (phantomDates.length > 0) summaryParts.push('⚠️ 历史日 volume/yest_volume 缺失: ' + phantomDates.join(', '));
  if (metricsWriteFailures > 0) summaryParts.push('❌ market_metrics 写入失败 ' + metricsWriteFailures + ' 个日期批次(可能表未就绪/RLS 阻止/字段不符),数据未落库');
  const completenessSummary = summaryParts.length > 0 ? summaryParts.join('；') : '✅ 本次 ' + expectedDates.length + ' 个交易日数据完整';
  logs.push('数据完整性汇总: ' + completenessSummary);
  return { completenessSummary, todayMissing };
}

// 主流程
export async function runMorning(env) {
  const logs = [];
  const today = beijingToday();
  logs.push('today=' + today);

  const skipResult = checkTradingDay(today, logs);
  if (skipResult) return skipResult;

  const watchlistResult = await fetchAndWriteWatchlist(env, today, logs);
  if (watchlistResult.error) {
    return { ok: false, today, error: watchlistResult.error, logs };
  }
  const { constituents, watchlistRows, nowIso } = watchlistResult;

  const numcatResult = await fetchNumcatWithRetry(env, constituents, today, logs);
  if (numcatResult.error) {
    return { ok: false, today, error: numcatResult.error, logs };
  }
  const { expectedDates, items, fields, missingDatesAfterNumcat } = numcatResult;

  const { metricsByDate, yestVolDerivedCount } = parseNumcatToMetrics(items, fields, constituents, logs);

  const { phantomDates } = await fetchAndMergeHistoricalPct(env, constituents, expectedDates, today, metricsByDate, logs);

  const { totalMetricsWritten, metricsWriteFailures, dateKeys } = await writeMarketMetricsBatched(env, metricsByDate, nowIso, logs);

  const { completenessSummary, todayMissing } = buildCompletenessSummary(today, missingDatesAfterNumcat, phantomDates, metricsWriteFailures, expectedDates, logs);

  logs.push('完成: auction_watchlist ' + watchlistRows.length + ' 行, market_metrics ' + totalMetricsWritten + ' 行');
  return {
    ok: metricsWriteFailures === 0 || totalMetricsWritten > 0,
    today,
    constituentsCount: constituents.length,
    numcatItems: items.length,
    metricsDates: dateKeys.length,
    metricsWritten: totalMetricsWritten,
    yestVolDerived: yestVolDerivedCount,
    metricsWriteFailures: metricsWriteFailures,
    expectedDates: expectedDates,
    todayDataMissing: todayMissing,
    historicalDatesMissingFromNumcat: phantomDates,
    completenessSummary: completenessSummary,
    logs
  };
}