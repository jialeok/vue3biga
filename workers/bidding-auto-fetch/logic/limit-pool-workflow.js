// limit-pool-workflow.js — 「涨跌停」看板数据抓取主流程（runLimitPool）
//
// 触发点：每个交易日【北京 15:40】（Cloudflare cron 07:40 UTC = 15:40 北京）。
//   为什么是 15:40 而不是 15:00：收盘瞬间上游的涨停/跌停池仍在变动（最后一笔成交、
//   跌停打开又被砸回等），等 40 分钟拿到的是终态快照；且 15:40 已完全避开收盘并发高峰。
//
// 职责（单一）：抓 涨停池 + 跌停池 → 整日对齐写入 limit_pool。
//   不做题材分组、不选龙头 —— 那些是【派生视图】（池 + 共享题材库 + 十日涨幅），
//   由前端 logic/limitpool 在渲染时计算。落库只会多出第二个真相源（题材库变更后会陈旧冻结）。
//
// 幂等：主键 (date, board, stock) upsert 覆盖；重跑同一日结果相同 → 不产生无意义变更。
//
// §11 删除安全：只有当某板抓取被判定为【完整】时才清理该板「本次已不在池中」的旧行；
//     抓取不完整（items < 上游 total）时【只 upsert、不删除】—— 宁可多留旧行，也不误删真数据。
// §10 未就绪 ≠ 没有：两池皆空 → 视为上游尚未结算，不写库、不删除，返回 ok:false 交人工/下次重试。

import { beijingToday, isWeekend } from '../../_shared-source/date-utils.js';
import { localIsTradingDay } from '../../_shared-source/holidays.js';
import { fetchLimitPoolSnapshot } from '../data/fuyao-api.js';
import { upsertLimitPoolRows, deleteStaleLimitPool } from '../data/supabase-write.js';

const BOARD_UP = 'up';
const BOARD_DOWN = 'down';

/**
 * @param {object} env
 * @param {{date?:string}} [opts] date='YYYY-MM-DD' 可指定要抓取的交易日（默认=北京今天）。
 *        用途：手动补抓历史某天（上游支持 date_ms）。
 */
export async function runLimitPool(env, opts) {
  const logs = [];
  const today = (opts && opts.date) || beijingToday();
  logs.push('today=' + today + (opts && opts.date ? '（手动指定日期）' : ''));

  if (isWeekend(today) || !localIsTradingDay(today)) {
    logs.push('非交易日，跳过');
    return { ok: true, today, skipped: true, reason: '非交易日', logs };
  }

  // 1. 抓取（两个池要么都成功，要么直接失败）
  logs.push('步骤1：抓取同花顺涨停池 / 跌停池...');
  let snap;
  try {
    snap = await fetchLimitPoolSnapshot(env, today);
  } catch (e) {
    logs.push('抓取失败: ' + (e && e.message || e));
    return { ok: false, today, error: '抓取失败: ' + (e && e.message || e), logs };
  }
  logs.push('涨停 ' + snap.up.length + ' 只，跌停 ' + snap.down.length + ' 只');

  // 2. 两池皆空 → 上游未就绪（或极端行情），不写库（§10：未就绪 ≠ 没有）
  if (snap.up.length === 0 && snap.down.length === 0) {
    logs.push('❌ 两池皆空 → 判定上游未结算/未就绪，本次不写库（避免清空已有快照）');
    return { ok: false, today, error: '上游两池皆空（可能尚未结算）', logs };
  }

  // 3. 整日对齐写入：先 upsert（本次结果全部就位）→ 再删旧行（本次已不在池中的）
  logs.push('步骤2：写入 limit_pool...');
  let written = 0;
  try {
    written = await upsertLimitPoolRows(env, snap.up.concat(snap.down));
  } catch (e) {
    logs.push('写入失败: ' + (e && e.message || e));
    return { ok: false, today, error: '写入 limit_pool 失败: ' + (e && e.message || e), logs };
  }

  logs.push('步骤3：清理该日已退池的旧行...');
  let deletedUp = 0;
  let deletedDown = 0;
  if (snap.upComplete) {
    try {
      deletedUp = await deleteStaleLimitPool(env, today, BOARD_UP, snap.up.map(r => r.stock));
    } catch (e) {
      logs.push('清理涨停旧行失败（非致命）: ' + (e && e.message || e));
    }
  } else {
    logs.push('⚠️ 涨停池抓取不完整（' + snap.up.length + '/' + snap.upTotal + '）→ 跳过旧行清理（不误删）');
  }
  if (snap.downComplete) {
    try {
      deletedDown = await deleteStaleLimitPool(env, today, BOARD_DOWN, snap.down.map(r => r.stock));
    } catch (e) {
      logs.push('清理跌停旧行失败（非致命）: ' + (e && e.message || e));
    }
  } else {
    logs.push('⚠️ 跌停池抓取不完整（' + snap.down.length + '/' + snap.downTotal + '）→ 跳过旧行清理（不误删）');
  }

  const completenessSummary = '✅ 涨跌停池写入 ' + written + ' 行（涨停 ' + snap.up.length +
    ' / 跌停 ' + snap.down.length + '），清理退池旧行 涨停 ' + deletedUp + ' / 跌停 ' + deletedDown;
  logs.push('数据完整性汇总: ' + completenessSummary);
  return {
    ok: true,
    today,
    upCount: snap.up.length,
    downCount: snap.down.length,
    written: written,
    deletedUp: deletedUp,
    deletedDown: deletedDown,
    completenessSummary: completenessSummary,
    logs
  };
}
