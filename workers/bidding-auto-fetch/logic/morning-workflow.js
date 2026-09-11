// morning-workflow.js — 早盘竞价抓取主流程（runMorning 拆分为若干子函数）
import { beijingNow, beijingToday, isWeekend, compactToDateStr } from '../../_shared-source/date-utils.js';
import { localIsTradingDay } from '../../_shared-source/holidays.js';
import { CONFIG } from '../config.js';
import { fetchLadderConstituents } from '../data/fuyao-api.js';
import { numcatDailyAuc, numcatDaily } from '../data/numcat-api.js';
import { upsertAuctionWatchlist, upsertMarketMetrics, upsertStockRangePct, readAuctionWatchlistForDate, readAuctionTagsForDate, readStockCodeMap, readStockCodeMapByNames } from '../data/supabase-write.js';
import { getRecentTradingDays } from './holiday-check.js';
// [EXTRAS-PATCH 2026-09-11] 竞价四要素补漏。早盘放在【最后】跑一次（不阻塞 P0/P1/P2）：
// 猫抓对当日行通常不给四要素，但若为单日请求/结算较快而给了，就能在 9:26 前顺手落库；
// 没给也零副作用（只补缺失值，写 0 行）。真正的兜底是 16:00 close 与次日窗口重刷。
import { runAuctionExtrasPatch } from './extras-workflow.js';
// [PLAN-A 2026-09-10] 区间涨幅口径复用前端同一份纯函数（单一真相 §6）：
// 窗口天数 / 复利累乘 / T 腿竞价占位判定 全部只此一份，前后端不会算出两个结果。
// ⚠️ 跨目录引用会让 workers/_bundle.mjs 把该文件一并打进单文件产物（Cloudflare 复制粘贴部署），
//    因此 src/logic/auction/range-window.js 必须保持「零 import 的纯函数」，不得引入 Vue / DOM 依赖。
import { RANGE_WINDOW_DAYS, parsePct, buildRangeRows, isAuctionLegActive } from '../../../src/logic/auction/range-window.js';

/** 与 range-window.RANGE_WINDOW_DAYS 同源；显式断言避免有人改动窗口天数后 worker 静默失配 */
const RANGE_DAYS = RANGE_WINDOW_DAYS;

// ============================================================================
// [LATENCY 2026-09-11] 9:25 必须「尽早落库」，不是「最终一致」
// ----------------------------------------------------------------------------
// 用户操作节奏要求：9:26 之前必须能在看板上看到当天的竞价数据，晚一分钟就乱了。
// 但实测 market_metrics 的 created_at（= 当天首批行的落库时刻，北京时间）在持续退化：
//     2026-09-09 → 09:25:19   ✅
//     2026-09-10 → 09:26:18   ⚠️
//     2026-09-11 → 09:29:56   ❌（第二批甚至到 09:30:03）
// 本地逐段实测（.tmpdiag/probe_morning_latency.mjs，只读）显示旧链路是【纯串行】的：
//   步骤1  成分股 2.8s → 代码表 1.2s → 交易日历 1.4s → 前日名单 0.5s → 代码表 1.2s
//          → 今日名单 0.5s → 代码表 1.2s → 交易日历 1.4s → 前日标签 0.8s → 写名单 0.6s ≈ 11.6s
//          （其中交易日历接口实测返回空、每次都要回退本地日历，白耗 1.4s × 4 次）
//   步骤3  交易日历 1.4s → numcat daily_auc 2.0s →【今天缺失时 sleep 20s + 40s = 60s】
//   步骤5  交易日历 1.4s → numcat daily 1.2s
//   步骤6  market_metrics 按「日期 × 字段形状桶」串行 upsert，实测单次 ≈7s，十几批就是 1~2 分钟
// 结论：慢的不是某一个接口，而是「串行 + 重复请求 + 无关步骤挡在 P0 前面」。
//
// 改造原则：**今天的数据（名单 + 竞价指标）是 P0，必须在最早的时间点写下去**；
//           历史日 change_pct、10 日区间涨幅是 P1/P2，允许晚几十秒，绝不能挡在 P0 前面。
// ============================================================================

/** 今天数据缺失时的重试等待（秒）。原 [20, 40] 最坏 60s —— 单这一项就能把落库推到 09:26 之后。
 *  猫抓 daily_auc 当日数据实测 9:25:10 前后就绪，25 秒窗口足够，且保证最后一次请求
 *  不晚于 09:25:30 发出，给写入留出时间。 */
const TODAY_RETRY_DELAYS_SEC = [5, 8, 12];

// ---------------------------------------------------------------------------
// 单次 runMorning 内的轻量 memo：消除「同一份数据被串行请求 3~4 次」
// ---------------------------------------------------------------------------
function createRunCache() {
  return { _tdAll: null, _tdPending: null };
}

/** 取截止 today（含）最近 n 个交易日。整轮只发一次交易日历请求（失败抛错时返回 []） */
async function recentTradingDays(cache, env, today, n) {
  if (!cache._tdPending) {
    cache._tdPending = getRecentTradingDays(env, today, RANGE_DAYS)
      .catch(function (e) {
        console.warn('[MORNING] getRecentTradingDays 失败:', e && e.message);
        return [];
      });
  }
  const all = await cache._tdPending;
  if (!all || all.length === 0) return [];
  return n >= all.length ? all.slice() : all.slice(-n);
}

function settled(p) {
  return p.then(function (v) { return { ok: true, v: v }; }, function (e) { return { ok: false, e: e }; });
}

// ---------------------------------------------------------------------------
// [2026-09-11] 「竞价四要素」= 未匹配量 / 抢筹幅度 / 竞价量比 / 真换手率
//   这四个是趋势图右侧展示的核心指标，也是「量比抢筹高光」的判据。
//   ⚠️ 取证结论（.tmpdiag/diag_last_write.mjs）：猫抓 daily_auc 对【当日】这一行
//      **不返回**这四个字段的值，只有 auc_vol / auc_pct_chg / auc_to_pre_vol_pct；
//      四要素要等这一天结算后才出现（实际观测：次日早盘窗口重刷时自动补上）。
//   因此 9:25 早盘**不能**等它们（等也等不到，还会顶穿 9:26 硬指标），
//   改由 runAuctionExtrasPatch 在结算后补写（16:00 close 自动跑 / 手动 /fetch?point=extras）。
// ---------------------------------------------------------------------------
const AUCTION_EXTRA_FIELDS = ['um_vol', 'open_bid_pct', 'auc_vol_ratio', 'auc_turnover'];

/**
 * 判断某批 daily_auc 响应里「今天」的行是否已带竞价四要素。
 * @returns {{ok:boolean, hasFields:boolean, filled:number, total:number}}
 *   ok        = 今天至少有行，且至少 60% 的行带上了四要素（剩余少数可能是停牌/无竞价）
 *   hasFields = numcat 本次响应里是否存在这四个字段（false 说明接口层就没给）
 */
function todayAuctionExtras(rows, flds, today) {
  const list = rows || [];
  const fs = flds || [];
  const dateI = fs.indexOf('tradedate');
  const idxs = AUCTION_EXTRA_FIELDS.map(f => fs.indexOf(f));
  const hasFields = idxs.some(i => i >= 0);
  const out = { ok: false, hasFields: hasFields, filled: 0, total: 0 };
  if (dateI < 0) return out;
  list.forEach(row => {
    if (compactToDateStr(String(row[dateI] || '').trim()) !== today) return;
    out.total++;
    const filled = idxs.some(i => i >= 0 && row[i] !== null && row[i] !== undefined && String(row[i]).trim() !== '');
    if (filled) out.filled++;
  });
  // 门槛 60%：允许少量停牌 / 无竞价成交的票天然为空，但绝不允许「整批为空」被当成正常
  out.ok = out.total > 0 && hasFields && (out.filled / out.total) >= 0.6;
  return out;
}

// 1. 检查是否交易日
function checkTradingDay(today, logs) {
  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }
  return null;
}

// 2. 获取最近多板成分股 + 写入 auction_watchlist
// [LATENCY 2026-09-11] 原来这一步是 9 次串行网络调用（≈11.6s），现改为 3 组并行（≈3s）：
//   组A：成分股 ∥ 代码表 ∥ 交易日历       ← 三者互不依赖
//   组B：前日名单 ∥ 今日名单 ∥ 前日标签    ← 只依赖组A的交易日历
//   组C：仅对「仍缺 code 的名字」做一次按名精确补码（通常 0 次或 1 次小请求）
async function fetchAndWriteWatchlist(env, today, cache, logs) {
  logs.push('步骤1：并行获取 成分股 / 代码表 / 交易日历...');
  const [ladderRes, codeMapRes, tdRes] = await Promise.all([
    settled(fetchLadderConstituents(env)),
    settled(readStockCodeMap(env)),
    settled(recentTradingDays(cache, env, today, 2))
  ]);

  if (!ladderRes.ok) {
    logs.push('获取成分股失败: ' + ladderRes.e.message);
    return { error: '获取成分股失败: ' + ladderRes.e.message };
  }
  const ladderConstituents = ladderRes.v || [];
  logs.push('成分股数量: ' + ladderConstituents.length);
  if (ladderConstituents.length === 0) {
    return { error: '883410 成分股为空' };
  }

  const codeMap = (codeMapRes.ok && codeMapRes.v) || {};
  if (!codeMapRes.ok) logs.push('读取 stockcodemap 失败(非致命): ' + codeMapRes.e.message);
  const recentDays = (tdRes.ok && tdRes.v) || [];
  const prevDay = recentDays.length >= 2 ? recentDays[recentDays.length - 2] : null;

  // 组B：三个名单来源并行（原来串行 3 次 + 中间夹着 2 次重复的代码表读取）
  logs.push('步骤1b：并行读取 前日名单 / 今日名单 / 前日标签...');
  const [prevWlRes, todayWlRes, tagRes] = await Promise.all([
    settled(prevDay ? readAuctionWatchlistForDate(env, prevDay) : Promise.resolve([])),
    settled(readAuctionWatchlistForDate(env, today)),
    settled(prevDay ? readAuctionTagsForDate(env, prevDay) : Promise.resolve([]))
  ]);

  let constituents = ladderConstituents;

  // [BUG-FIX] 合并前一日 auction_watchlist 表里的额外股票（打标签/观察组），
  // 确保 worker 也为它们抓取竞价数据，否则观察组股票早上没有数据
  if (prevWlRes.ok && prevWlRes.v && prevWlRes.v.length > 0) {
    const prevStocks = prevWlRes.v;
    const existingCodes = new Set(constituents.map(c => c.code));
    const extraStocks = prevStocks.filter(s => {
      const code = s.code || codeMap[s.name] || '';
      return code && !existingCodes.has(code);
    }).map(s => ({ name: s.name, code: s.code || codeMap[s.name] || '' }));
    if (extraStocks.length > 0) {
      logs.push('前一日额外股票(打标签/观察组): ' + extraStocks.length + ' 只，合并到抓取名单');
      constituents = constituents.concat(extraStocks);
    }
  } else if (prevWlRes.e) {
    logs.push('读取前一日 watchlist 失败(非致命): ' + prevWlRes.e.message);
  }

  // [BUG-FIX] 也读今日 auction_watchlist，合并用户在前端提前打开页面时已加入的股票
  const todayStocks = (todayWlRes.ok && todayWlRes.v) || [];
  if (todayWlRes.e) logs.push('读取今日 watchlist 失败(非致命): ' + todayWlRes.e.message);
  if (todayStocks.length > 0) {
    const existingCodes = new Set(constituents.map(c => c.code));
    const todayExtra = todayStocks.filter(s => {
      const code = s.code || codeMap[s.name] || '';
      return code && !existingCodes.has(code);
    }).map(s => ({ name: s.name, code: s.code || codeMap[s.name] || '' }));
    if (todayExtra.length > 0) {
      logs.push('今日 watchlist 额外股票(前端提前继承): ' + todayExtra.length + ' 只，合并到抓取名单');
      constituents = constituents.concat(todayExtra);
    }
  }

  // [FEAT 2026-09-08] 合并「上一交易日打过标签（买/卖/持有）」的股票到抓取名单。
  // 只并入 constituents（抓取名单），不写 auction_watchlist → 不破坏「当日名单 = 9:25 快照」的锁定口径（§6）。
  if (tagRes.ok && tagRes.v && tagRes.v.length > 0) {
    const existingNames = new Set(constituents.map(c => c.name));
    const existingCodes = new Set(constituents.map(c => c.code));
    const tagExtra = [];
    tagRes.v.forEach(function (t) {
      if (existingNames.has(t.name)) return;
      const code = codeMap[t.name] || '';
      if (!code || existingCodes.has(code)) return;
      existingNames.add(t.name);
      existingCodes.add(code);
      tagExtra.push({ name: t.name, code: code });
    });
    if (tagExtra.length > 0) {
      logs.push('前一日(' + prevDay + ')打标签股票(买/卖/持有): ' + tagExtra.length +
        ' 只，合并到抓取名单（不写 watchlist）');
      constituents = constituents.concat(tagExtra);
    }
  } else if (tagRes.e) {
    logs.push('读取前一日打标签股票失败(非致命): ' + tagRes.e.message);
  }

  // 组C：仍缺 code 的名字，按名精确补一次（全表读被 1000 行上限截断的兜底）
  // 注意：这里只补「名单里已经确定要抓」的名字，不补 watchlist 行本身的 code。
  const nameless = todayStocks.concat(prevWlRes.ok && prevWlRes.v ? prevWlRes.v : [])
    .map(s => s.name)
    .filter(n => n && !codeMap[n]);
  if (nameless.length > 0) {
    const extra = await readStockCodeMapByNames(env, Array.from(new Set(nameless)));
    const added = Object.keys(extra).length;
    if (added > 0) {
      Object.keys(extra).forEach(n => { codeMap[n] = extra[n]; });
      logs.push('按名精确补 code: ' + added + ' 只（全表读被 1000 行上限截断的兜底）');
      // 用补到的 code 再并入一次名单
      const existingCodes = new Set(constituents.map(c => c.code));
      const existingNames = new Set(constituents.map(c => c.name));
      const more = [];
      todayStocks.forEach(s => {
        if (existingNames.has(s.name)) return;
        const code = s.code || codeMap[s.name] || '';
        if (!code || existingCodes.has(code)) return;
        existingNames.add(s.name); existingCodes.add(code);
        more.push({ name: s.name, code: code });
      });
      if (more.length > 0) {
        constituents = constituents.concat(more);
        logs.push('补码后新增抓取标的: ' + more.length + ' 只');
      }
    }
  }

  // 【BUG-FIX】不写 volume/yest_volume/change_pct/note/topics 字段：
  // 这些字段的真实值由步骤4写入 market_metrics 表。
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
  // 【9:25 名单锁定 2026-09-07】当日名单只允许由 9:25 那一轮抓取确定，窗口外绝不新增。
  const nowBj = beijingNow();
  const bjMinutes = nowBj.getUTCHours() * 60 + nowBj.getUTCMinutes();
  const inMorningWindow = bjMinutes >= 9 * 60 + 25 && bjMinutes <= 9 * 60 + 40;
  let rowsToWrite = watchlistRows;
  if (!inMorningWindow) {
    // 今日名单在组B里已经读过，直接复用，不再多打一次请求
    let existingNames = new Set(todayStocks.map(s => s.name));
    if (existingNames.size === 0) {
      logs.push('非 9:25 抓取窗口，但当日名单为空 → 视为 9:25 那轮未成功，允许全量写入 ' +
        rowsToWrite.length + ' 行');
    } else {
      const before = rowsToWrite.length;
      rowsToWrite = rowsToWrite.filter(r => existingNames.has(r.stock));
      logs.push('非 9:25 抓取窗口（当前北京 ' + String(nowBj.getUTCHours()).padStart(2, '0') + ':' +
        String(nowBj.getUTCMinutes()).padStart(2, '0') + '）：当日名单锁定为 9:25 快照，只更新已存在的 ' +
        rowsToWrite.length + ' 行，跳过 ' + (before - rowsToWrite.length) + ' 只新成分股');
    }
  }
  try {
    await upsertAuctionWatchlist(env, rowsToWrite);
    logs.push('auction_watchlist 写入 ' + rowsToWrite.length + ' 行');
  } catch (e) {
    logs.push('写入 auction_watchlist 失败: ' + e.message);
    return { error: '写入 auction_watchlist 失败: ' + e.message };
  }
  return { constituents, watchlistRows, nowIso };
}

// 3. 调 numcat daily_auc 获取竞价数据（含"今天缺失"延迟重试）
async function fetchNumcatWithRetry(env, constituents, today, cache, logs) {
  const expectedDates = await recentTradingDays(cache, env, today, CONFIG.NUMCAT_RECENT_DAYS);
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

  // ⚠️ 必须 let：重试可能返回更完整的 fields（四要素后到），要整体替换
  let fields = numcatData.fields || [];
  let items = numcatData.items || [];
  logs.push('numcat 返回 fields=' + JSON.stringify(fields) + ' items=' + items.length + '行');

  const dateIdxPre = fields.indexOf('tradedate');
  const computeGotDates = (rows, flds) => {
    const di = flds ? flds.indexOf('tradedate') : dateIdxPre;
    if (di < 0) return new Set();
    return new Set(rows.map(row => compactToDateStr(String(row[di] || '').trim())).filter(Boolean));
  };
  let missingDatesAfterNumcat = [];
  let curExtras = { ok: false, hasFields: false, filled: 0, total: 0 };
  if (dateIdxPre >= 0) {
    let gotDates = computeGotDates(items, fields);
    let missingDates = expectedDates.filter(d => !gotDates.has(d));
    if (missingDates.length > 0) {
      logs.push('⚠️ numcat 缺失交易日: ' + JSON.stringify(missingDates));
    } else {
      logs.push('numcat 覆盖了全部 ' + expectedDates.length + ' 个预期交易日');
    }

    // 【LATENCY 2026-09-11】重试等待 20s+40s → 5s+8s+12s。9:26 硬指标。
    //
    // ⚠️ 判据【只能】是「今天这个日期出现没」，绝不要把「竞价四要素是否就绪」塞进阻塞条件。
    //    取证（2026-09-11，.tmpdiag/diag_last_write.mjs）：
    //      · 同一轮写入（9/11 01:30:03）里 9/10 = 60/67 有四要素，9/11 = 0/67 全空；
    //      · 全表唯一「最后一个写入时刻 = 当天」的日期就是 9/11，它四要素为 0；
    //      · 8/07 起的每个历史日，四要素都是在【后续几天的窗口重刷】时才出现的。
    //    ⇒ 猫抓 daily_auc 对【当日】这一行不返回 um_vol/open_bid_pct/auc_vol_ratio/auc_turnover，
    //      它们要等这一天结算后才有。拿它当阻塞条件 = 每天白等 25s 且永远等不到，
    //      反而把 P0 落库顶穿 9:26。四要素改由 P3 补漏任务负责（runAuctionExtrasPatch）。
    if (missingDates.includes(today)) {
      for (let attempt = 0; attempt < TODAY_RETRY_DELAYS_SEC.length && missingDates.includes(today); attempt++) {
        const waitSec = TODAY_RETRY_DELAYS_SEC[attempt];
        logs.push('⏳ 今天(' + today + ')数据缺失，' + waitSec + '秒后重试第' + (attempt + 1) + '次...');
        await new Promise(r => setTimeout(r, waitSec * 1000));
        try {
          const retryData = await numcatDailyAuc(env, symbols, startYMD, endYMD);
          const retryItems = retryData.items || [];
          const retryFields = retryData.fields && retryData.fields.length ? retryData.fields : fields;
          const retryGotDates = computeGotDates(retryItems, retryFields);
          if (retryGotDates.has(today)) {
            items = retryItems;
            fields = retryFields;
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
    // 四要素【只统计、不阻塞】。当日为空是猫抓的既定行为，不是故障；
    // 补漏交给 runAuctionExtrasPatch（16:00 close 跑 / 手动 /fetch?point=extras）。
    curExtras = todayAuctionExtras(items, fields, today);
    if (!curExtras.ok) {
      logs.push('ℹ️ 今天(' + today + ')的「竞价四要素」当日不可用（' + curExtras.filled + '/' + curExtras.total +
        ' 只非空' + (curExtras.hasFields ? '' : '，且 numcat 本次未返回这些字段') +
        '）——这是猫抓 daily_auc 对当日行的既定行为，P0 落库不受影响；' +
        '四要素将在当天结算后由补漏任务写回（最迟次日早盘窗口重刷时自动补上）。');
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

  return { expectedDates, items, fields, symIdx, nameIdx, dateIdx, volIdx, pctIdx, ratioIdx, missingDatesAfterNumcat, extras: curExtras };
}

// 3b. [LATENCY 2026-09-11] numcat daily（收盘涨幅）独立成一步，与 daily_auc 并发发出。
//     原来它串在 daily_auc 之后，白白多等 1.2s；而且它只服务 P1/P2（区间涨幅 / 历史日涨幅），
//     绝不能挡在「今天的竞价指标落库」前面。
async function fetchDailyWindow(env, constituents, today, expectedDates, cache, logs) {
  let rangeDates = await recentTradingDays(cache, env, today, RANGE_DAYS);
  if (rangeDates.length === 0 || rangeDates[rangeDates.length - 1] !== today) {
    logs.push('⚠️ 区间涨幅窗口交易日历异常(' + JSON.stringify(rangeDates) + ')，回退为竞价窗口 ' + JSON.stringify(expectedDates));
    rangeDates = expectedDates.slice();
  }
  rangeDates.sort();

  if (rangeDates.length === 0) {
    logs.push('步骤5：无可用交易日，跳过 numcat daily');
    return { ok: false, dailyByCode: {}, pctByDate: {}, rangeDates: [] };
  }

  const startYMD = rangeDates[0].replace(/-/g, '');
  const endYMD = rangeDates[rangeDates.length - 1].replace(/-/g, '');
  const symbols = constituents.map(c => c.code).join(',');
  logs.push('步骤5：numcat daily ' + rangeDates.length + ' 天窗口（与 daily_auc 并发）...');

  try {
    const dailyData = await numcatDaily(env, symbols, startYMD, endYMD);
    const dailyFields = dailyData.fields || [];
    const dailyItems = dailyData.items || [];
    const dSymIdx = dailyFields.indexOf('symbol');
    const dDateIdx = dailyFields.indexOf('tradedate');
    const dPctIdx = dailyFields.indexOf('pct_chg');
    if (dSymIdx < 0 || dDateIdx < 0 || dPctIdx < 0) {
      logs.push('numcat daily 返回字段不完整: ' + JSON.stringify(dailyFields));
      return { ok: false, dailyByCode: {}, pctByDate: {}, rangeDates: rangeDates };
    }
    const pctByDate = {};
    const dailyByCode = {};
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
      if (!dailyByCode[code]) dailyByCode[code] = {};
      dailyByCode[code][dateStr.replace(/-/g, '')] = n;
      totalPctCount++;
    });
    logs.push('numcat daily 返回 ' + totalPctCount + ' 条，涉及 ' + Object.keys(pctByDate).length + ' 个交易日');
    return { ok: true, dailyByCode: dailyByCode, pctByDate: pctByDate, rangeDates: rangeDates };
  } catch (e) {
    logs.push('numcat daily 失败（今天的竞价数据不受影响，仅区间涨幅/历史涨幅本次不更新）: ' + e.message);
    return { ok: false, dailyByCode: {}, pctByDate: {}, rangeDates: rangeDates };
  }
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

  logs.push('步骤4：解析数据...');
  // [2026-09-11] numcat 若未返回竞价四要素字段，这里必须显式报警：
  // 否则界面表现为「趋势图只有涨幅、四项竞价指标全空」，且日志里毫无痕迹，极难定位。
  if (umIdx < 0 || obpIdx < 0 || avrIdx < 0 || atrIdx < 0) {
    logs.push('⚠️ numcat daily_auc 未返回全部竞价四要素字段: ' + JSON.stringify({
      um_vol: umIdx, open_bid_pct: obpIdx, auc_vol_ratio: avrIdx, auc_turnover: atrIdx
    }) + '（idx=-1 表示该字段本次不存在）→ 这些字段本次留空');
  }
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
    // 但后续会用 numcat daily 的收盘涨幅覆盖【历史日】的 change_pct，
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

// 5. 历史日收盘涨幅合并（纯内存）+ 计算区间涨幅行
//    原 fetchAndMergeHistoricalPct 的网络部分已拆到 fetchDailyWindow（与 daily_auc 并发）。
function mergeHistoricalAndBuildRange(constituents, expectedDates, today, metricsByDate, daily, logs) {
  const { dailyByCode, pctByDate, rangeDates, ok } = daily;
  const numcatCoveredDates = new Set(Object.keys(metricsByDate));
  const historicalDates = expectedDates.filter(d => d < today).sort();
  const phantomDates = historicalDates.filter(d => !numcatCoveredDates.has(d));
  if (phantomDates.length > 0) {
    logs.push('⚠️ numcat daily_auc 完全未返回以下历史交易日: ' + JSON.stringify(phantomDates));
  }
  if (!ok) return { phantomDates: phantomDates, rangeRows: [] };

  // ① 历史日 change_pct 合并（口径保持改造前不变：只覆盖历史日，今天不动）
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
  logs.push('历史涨幅合并 ' + mergedCount + ' 条' + (phantomFilledCount > 0 ? '，补齐 daily_auc 完全缺失日期 ' + phantomFilledCount + ' 条' : ''));

  // ② 区间涨幅（T 腿 = 9:25 竞价涨幅；15:00 后手动补抓时为收盘涨幅）
  const rangeRows = buildRangePctRows(constituents, rangeDates, dailyByCode, metricsByDate, today, logs);
  return { phantomDates: phantomDates, rangeRows: rangeRows };
}

/**
 * [PLAN-A] 计算「近 N 个交易日区间涨幅」行（供写入 stock_range_pct）。
 * 口径与前端完全一致（复用 src/logic/auction/range-window.js）。
 */
function buildRangePctRows(constituents, rangeDates, dailyByCode, metricsByDate, today, logs) {
  if (!rangeDates || rangeDates.length === 0) return [];

  const auctionPctByCode = {};
  const changePctByCode = {};
  (metricsByDate[today] || []).forEach(m => {
    if (!m || !m.code) return;
    const a = parsePct(m.auc_pct_chg);
    if (a !== null) auctionPctByCode[m.code] = a;
    const c = parsePct(m.change_pct);
    if (c !== null) changePctByCode[m.code] = c;
  });

  const afterClose = beijingNow().getUTCHours() >= 15;
  const useAuctionLeg = isAuctionLegActive(today, today, afterClose);
  const tYmd = today.replace(/-/g, '');

  // 只做「取 T 腿」这一步（口径由 useAuctionLeg 决定）；窗口/复利/组装全部交给 range-window.buildRangeRows
  const tLegByCode = {};
  constituents.forEach(c => {
    if (!c || !c.code) return;
    let v;
    if (useAuctionLeg) {
      v = auctionPctByCode[c.code];
    } else {
      const dm = dailyByCode[c.code];
      v = dm && Object.prototype.hasOwnProperty.call(dm, tYmd) ? dm[tYmd] : changePctByCode[c.code];
    }
    if (v !== null && v !== undefined && isFinite(v)) tLegByCode[c.code] = Number(v);
  });

  // [RANGE-FULL-LEG 2026-09-11 / 次日继承票「十日涨幅不更新」根因修复]
  //   拿不到【当天 T 腿】的票一律【不写行】，而不是让 buildRangeRows 把它跳过 T 腿继续算。
  //   原因：跳过 T 腿会产出一条 days=窗口-1 的「残缺行」，它看起来有涨幅却系统性偏低；
  //   更糟的是前端 close-pct-cover 的 T 腿代数换腿会假定「已存值含竞价腿」而把它算得更错，
  //   并刷新 updated_at 使 worker 16:00 的降级通道认定「已是收盘口径」→ 错值被永久冻结。
  //   实测（2026-09-11）：国芳集团 只累乘历史 9 天 = 81.17%，换腿后 91.11%，正确应为 96.04%。
  //   不写行是安全的：前端 dragon-rank「云端没有该行」的兜底会重算，worker 16:00 整段重算也会补上。
  const eligibleTargets = [];
  let noTLegCount = 0;
  constituents.forEach(c => {
    if (!c || !c.code) return;
    if (tLegByCode[c.code] === undefined) { noTLegCount++; return; }
    eligibleTargets.push(c);
  });

  const built = buildRangeRows(eligibleTargets, rangeDates, dailyByCode, tLegByCode);
  const nowIso = new Date().toISOString();
  const rows = built.map(r => ({
    date: today,
    stock: r.stock,
    range_pct: Number(r.pct).toFixed(2),
    days: r.days,
    updated_at: nowIso
  }));
  logs.push('步骤5b：区间涨幅计算完成 ' + rows.length + '/' + eligibleTargets.length + ' 只（T 腿口径=' +
    (useAuctionLeg ? '9:25 竞价涨幅' : '当日收盘涨幅') + '）' +
    (noTLegCount > 0 ? '；' + noTLegCount + ' 只无当天 T 腿 → 本次不写行（交由权威整段重算补齐）' : ''));
  return rows;
}

// 6. 写入 market_metrics
// [LATENCY 2026-09-11] 原来是「for 日期 { for 字段形状桶 { await upsert } }」全串行，
//   实测单次 upsert ≈7s、十几批就是 1~2 分钟 —— 这是 9/11 拖到 09:29:56 的主因之一。
//   现在：① 形状桶跨【日期】合并（冲突键是 date,stock,scope，不同日期可以同批），
//        批次数从「日期数 × 桶数」降到「桶数」；② 同一批内并发写出；
//        ③ 调用方按 P0(今天) / P2(历史日) 分两次调用，保证今天先落库。
async function writeMetricsForDates(env, metricsByDate, dateFilter, nowIso, logs) {
  const buckets = {};
  let totalMetricsWritten = 0;
  let metricsWriteFailures = 0;
  const dateKeys = Object.keys(metricsByDate).filter(dateFilter);
  if (dateKeys.length === 0) return { totalMetricsWritten: 0, metricsWriteFailures: 0, dateKeys: [] };

  dateKeys.forEach(dateStr => {
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
      if (!buckets[shapeKey]) buckets[shapeKey] = [];
      buckets[shapeKey].push(row);
    });
  });

  const jobs = Object.keys(buckets).map(shapeKey => {
    const rows = buckets[shapeKey];
    return upsertMarketMetrics(env, rows)
      .then(function () { return { ok: true, n: rows.length }; })
      .catch(function (e) {
        logs.push('  market_metrics 形状桶 ' + shapeKey + ' 写入失败: ' + e.message);
        return { ok: false, n: 0, err: e.message };
      });
  });
  const results = await Promise.all(jobs);
  results.forEach(function (r) {
    if (r.ok) totalMetricsWritten += r.n;
    else metricsWriteFailures++;
  });
  logs.push('  market_metrics 写入 ' + totalMetricsWritten + ' 行（' + dateKeys.length + ' 个日期 / ' +
    Object.keys(buckets).length + ' 个字段形状批，并发）');
  return { totalMetricsWritten, metricsWriteFailures, dateKeys };
}

// 7. 构建数据完整性汇总
function buildCompletenessSummary(today, missingDatesAfterNumcat, phantomDates, metricsWriteFailures, expectedDates, logs) {
  const todayMissing = missingDatesAfterNumcat.includes(today);
  const summaryParts = [];
  if (todayMissing) summaryParts.push('❌ 今天(' + today + ')竞价数据缺失，需手动补抓');
  if (phantomDates.length > 0) summaryParts.push('⚠️ 历史日 volume/yest_volume 缺失: ' + phantomDates.join(', '));
  if (metricsWriteFailures > 0) summaryParts.push('❌ market_metrics 写入失败 ' + metricsWriteFailures + ' 个批次');
  const completenessSummary = summaryParts.length > 0 ? summaryParts.join('；') : '✅ 本次 ' + expectedDates.length + ' 个交易日数据完整';
  logs.push('数据完整性汇总: ' + completenessSummary);
  return { completenessSummary, todayMissing };
}

// 主流程
export async function runMorning(env) {
  const logs = [];
  const _t0 = Date.now();
  const mark = (label) => { logs.push('⏱ ' + label + ' +' + (Date.now() - _t0) + 'ms'); };
  const today = beijingToday();
  const cache = createRunCache();
  logs.push('today=' + today);

  const skipResult = checkTradingDay(today, logs);
  if (skipResult) return skipResult;

  // ---- P0-① 名单（并行取数，写完即可让前端看到当天的票）----
  const watchlistResult = await fetchAndWriteWatchlist(env, today, cache, logs);
  if (watchlistResult.error) {
    return { ok: false, today, error: watchlistResult.error, logs };
  }
  const { constituents, watchlistRows, nowIso } = watchlistResult;
  mark('名单落库');

  // ---- P0-② 竞价 daily_auc 与 收盘 daily【并发】（两者互不依赖）----
  const [numcatResult, dailyResult] = await Promise.all([
    fetchNumcatWithRetry(env, constituents, today, cache, logs),
    // 预期交易日在这里也要用到，先拿一次（memo 后几乎零成本）
    recentTradingDays(cache, env, today, CONFIG.NUMCAT_RECENT_DAYS)
      .then(expected => fetchDailyWindow(env, constituents, today, expected, cache, logs))
  ]);
  mark('numcat 取数完成');

  if (numcatResult.error) {
    return { ok: false, today, error: numcatResult.error, logs };
  }
  const { expectedDates, items, fields, missingDatesAfterNumcat, extras } = numcatResult;

  const { metricsByDate, yestVolDerivedCount } = parseNumcatToMetrics(items, fields, constituents, logs);

  // ---- P0-③ 【今天】的 market_metrics 立刻落库 —— 不等区间涨幅、不等历史日 ----
  // 正确性：历史日合并只改 d < today 的行，今天的行在此刻已是最终值
  // （change_pct = auc_pct_chg 的 9:25 竞价副本，正是早盘口径）。
  const todayWrite = await writeMetricsForDates(env, metricsByDate, d => d === today, nowIso, logs);
  mark('今天 market_metrics 落库 ' + todayWrite.totalMetricsWritten + ' 行');

  // ---- P1 历史日合并 + 10 日区间涨幅（纯内存计算后落库）----
  const { phantomDates, rangeRows } = mergeHistoricalAndBuildRange(constituents, expectedDates, today, metricsByDate, dailyResult, logs);

  let rangeWritten = 0;
  let rangeWriteFailed = false;
  if (rangeRows.length > 0) {
    try {
      await upsertStockRangePct(env, rangeRows);
      rangeWritten = rangeRows.length;
      logs.push('步骤6：stock_range_pct 写入 ' + rangeWritten + ' 行');
    } catch (e) {
      rangeWriteFailed = true;
      logs.push('❌ stock_range_pct 写入失败: ' + e.message);
    }
  } else {
    logs.push('⚠️ 区间涨幅无结果可写（numcat daily 不可用或名单为空），本次 stock_range_pct 未更新');
  }
  mark('区间涨幅落库');

  // ---- P2 历史日 market_metrics（允许晚一点，不阻塞今天的可用性）----
  const histWrite = await writeMetricsForDates(env, metricsByDate, d => d !== today, nowIso, logs);
  mark('历史日 market_metrics 落库 ' + histWrite.totalMetricsWritten + ' 行');

  // ---- P3 竞价四要素补漏（保留为「零请求」安全网，最后跑，绝不挡在 P0 前面）----
  // [QUOTA 2026-09-11] 这一步以前带 dates:[today] 会真发一次猫抓请求，但猫抓对【当日】行
  // 永远不返回四要素（取证结论见 extras-workflow.js 文件头）→ 100% 白烧 1 次额度/天
  // （占日额度 1/10）。现在 runAuctionExtrasPatch 默认 includeToday=false：dates 只剩今天
  // → 立即零请求返回，只留一条日志。今天能拿到的四要素在 P0 写入时就已经落库；
  // 结算后的缺口由 16:00 close（自动排除今天）与次日早盘窗口重刷补齐。
  // 保留这个调用点是刻意的：万一将来猫抓改了当日返回行为，这里会自动恢复补写能力。
  let extrasPatched = 0;
  if (extras && !extras.ok) {
    try {
      const ex = await runAuctionExtrasPatch(env, { logs: logs, dates: [today] });
      extrasPatched = ex.patched || 0;
    } catch (e) {
      logs.push('竞价四要素补漏失败（非致命）: ' + e.message);
    }
    mark('竞价四要素补漏 ' + extrasPatched + ' 行');
  }

  const metricsWriteFailures = todayWrite.metricsWriteFailures + histWrite.metricsWriteFailures;
  const totalMetricsWritten = todayWrite.totalMetricsWritten + histWrite.totalMetricsWritten;
  const dateKeys = todayWrite.dateKeys.concat(histWrite.dateKeys);

  const { completenessSummary, todayMissing } = buildCompletenessSummary(today, missingDatesAfterNumcat, phantomDates, metricsWriteFailures, expectedDates, logs);

  logs.push('完成: auction_watchlist ' + watchlistRows.length + ' 行, market_metrics ' + totalMetricsWritten + ' 行, stock_range_pct ' + rangeWritten + ' 行');
  return {
    ok: metricsWriteFailures === 0 || totalMetricsWritten > 0,
    today,
    constituentsCount: constituents.length,
    numcatItems: items.length,
    metricsDates: dateKeys.length,
    metricsWritten: totalMetricsWritten,
    todayMetricsWritten: todayWrite.totalMetricsWritten,
    elapsedMs: Date.now() - _t0,
    rangeWritten: rangeWritten,
    rangeWriteFailed: rangeWriteFailed,
    yestVolDerived: yestVolDerivedCount,
    metricsWriteFailures: metricsWriteFailures,
    expectedDates: expectedDates,
    todayDataMissing: todayMissing,
    historicalDatesMissingFromNumcat: phantomDates,
    // 竞价四要素在「当日」拿不到是猫抓的既定行为，这里只做可观测性上报，不影响 ok
    auctionExtrasToday: (extras && extras.filled + '/' + extras.total) || '0/0',
    extrasPatched: extrasPatched,
    completenessSummary: completenessSummary,
    logs
  };
}
