// logic/seal-workflow.js — 封单家数（9:25 竞价一字板）
// [FIX 2026-08-15] 数据源从 NumCat 改为同花顺接口：
//   需求：9:25 用同花顺接口快照抓取「早盘竞价看板的最近多板（883410）」成分股，
//         判断哪些是一字板（竞价/开盘涨幅达到涨停），计算数量填入 bidding_data 封单家数行 time925 列。
//   原实现：NumCat emoindic-daily 的 owfd_0925_count 字段 — 不稳定（8/14 等日期接口计数类字段缺失，
//         且 emoindic 是日级指标，9:25 时往往还没有当天数据 → findTodayItem 找不到 → 空白）。
import { CONFIG, SEAL_COLUMN } from '../config.js';
import { beijingToday } from '../../_shared-source/date-utils.js';
import { isTradingDay, getLadderConstituents, getStockSnapshots, isLimitUpBoard } from '../data/fuyao-api.js';
import { upsertBiddingRows, writeLog } from '../data/supabase-write.js';

export async function runSeal(env, source) {
  const date = beijingToday();
  const logBase = { run_date: date, time_point: 't0925', source: source || 'cron', job: 'seal', worker: 'B' };

  if (!(await isTradingDay(env))) {
    await writeLog(env, Object.assign(logBase, { ok: false, detail: { skipped: '非交易日' } }));
    return { ok: false, error: '非交易日，已跳过' };
  }

  let sealResult;
  try {
    // 1. 取 883410 最近多板成分股
    const constituents = await getLadderConstituents(env);
    if (!constituents || constituents.length === 0) {
      sealResult = { value: null, error: '883410 最近多板成分股为空' };
    } else {
      // 2. 快照抓取涨幅
      const thscodes = constituents.map(c => c.thscode).filter(Boolean);
      const pcts = await getStockSnapshots(env, thscodes);
      // 3. 统计一字板家数（竞价/开盘涨幅 ≥ 涨停阈值）
      let limitUpCount = 0;
      const limitUpNames = [];
      let haveCount = 0;
      constituents.forEach(function (c) {
        const pct = pcts[c.thscode];
        if (typeof pct === 'number' && !isNaN(pct)) {
          haveCount++;
          if (isLimitUpBoard(c.thscode, pct)) {
            limitUpCount++;
            limitUpNames.push((c.name || c.thscode));
          }
        }
      });
      sealResult = {
        value: String(limitUpCount),
        detail: {
          constituents: constituents.length,
          haveSnapshot: haveCount,
          limitUp: limitUpCount,
          names: limitUpNames.slice(0, 50),
          threshold: '主板10%/创业板科创板20%'
        }
      };
    }
  } catch (e) {
    sealResult = { value: null, error: e.message };
  }

  const now = new Date().toISOString();
  const row = { date: date, name: CONFIG.ROW_SEAL, updated_at: now };
  row[SEAL_COLUMN] = sealResult.value;

  let ok = true, writeError = null;
  if (sealResult.value !== null && sealResult.value !== undefined) {
    try { await upsertBiddingRows(env, [row]); }
    catch (e) { ok = false; writeError = e.message; }
  }
  await writeLog(env, Object.assign(logBase, { ok, detail: { written: sealResult.value !== null ? [row] : [], row: sealResult, writeError } }));
  return { ok, date, point: 't0925-seal', column: SEAL_COLUMN, written: sealResult.value !== null ? [row] : [], row: sealResult, writeError };
}
