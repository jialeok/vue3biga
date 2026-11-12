// index.js — bidding-auto-fetch Worker 入口
//
// 触发点（同一条 Cloudflare 部署链路；免费账户 5 条 cron，当前用 4 条）：
//   · 北京 9:25  → morning ：抓竞价数据 + 计算 10 日区间涨幅落库；
//   · 北京 9:26  → ladder26：最近多板 883410 名单二次确认 + 新进票猫抓补竞价量比（P0-2 2026-11-06）
//                              + 20 日涨幅逐日腿补缺（0 上游请求）；
//   · 北京 9:27  → snapshot：竞价期间【最后一个云端兜底时点】(CLOUD-0927-HEAL 2026-11-11)；
//   · 北京 16:00 → close   ：用收盘涨幅覆盖 9:25 竞价涨幅 + 校正区间涨幅 T 腿。
//   · （9:35 保留映射，供手动或用户自建触发器再兜一次；不占用 cron 额度）
//
// ★★ [CLOUD-0927-HEAL 2026-11-11 用户口径] 「我要的全部是在云端运行程序自动获取数据」
//   此前 9:27/9:35 只有映射、toml 里**没有 cron**，云端自愈从未自动跑过；
//   9:25 猫抓 daily 超时 / 9:25 与 9:26 抢跑时，只能等有人打开网页触发前端自愈。
//   现在 9:27 由 Cloudflare 定时直跑，手机-only / 电脑关机都能在开盘前拿到最终答案。
//
// ★ 为什么是 9:27 这一趟（2026-11-04 用户报障「关机就不出票」）：
//   1) 猫抓对【当日】的 auc_vol 在 9:25 偶尔还没结算 → 写成占位 0（趋势图竞价量全 0）；
//   2) 猫抓 daily 一旦超时 → stock_range_pct 当天 0 行 → 区间涨幅只能由浏览器补算
//      （实测 11/04 那 47 行全是 09:46 由前端写的）⇒ 不开电脑当天就出不了票。
//   ★ 时间点由用户拍板（2026-11-04 原话）：「不是 9 点 35 分，最迟 9 点 27 分就可以了，
//   9 点 35 分开盘了，没用了，我一直要求的是竞价期间」。9:30 一开盘，竞价就结束了，
//   这时候再补出来的票对买卖已经没有意义 —— 所以自愈必须压在 9:27。
//   9:27 上游已结算完竞价（9:25 撮合、9:25:xx 出终态），用「同花顺快照（免费）+
//   猫抓 daily（仅失败时才请求）」把两样都补回来。
//
// [FIX 2026-09-10] 收盘覆盖「回归本 worker」。
//   2026-08-17 曾把 close 挪到 Supabase Edge Function（bidding-a?point=auction-close，pg_cron 16:00），
//   但实测该 pg_cron 链路从未成功执行过（bidding_fetch_log 里 auction-close 记录数为 0，
//   手工触发返回 546），导致当天 change_pct 全天停留在竞价涨幅。
//   本 worker 的早盘 cron 一直稳定，因此收盘也交回这里，不再依赖任何外部 cron。
// ★ [PATH-FIX 2026-11-05] 这里原来是 `../../_shared-source/`，是**错的**：
//   本文件在 workers/bidding-auto-fetch/ 下，`../` = workers/，`../../` = 项目根，
//   而 _shared-source 实际在 workers/_shared-source ⇒ 路径指向一个不存在的地方。
//   一直没暴露是因为：① logic/ 与 data/ 下的文件（深度 3，`../../` 正好对）会把 date-utils
//   一起带进 bundle，_bundle.mjs 又对解析不到的路径静默跳过 ⇒ 粘贴版一直是对的；
//   ② 但 wrangler 从源码打包是严格解析模块图的，直接报
//   `Could not resolve "../../_shared-source/date-utils.js"`（2026-11-05 首次尝试 wrangler 部署时踩到）。
import { beijingNow, beijingToday } from '../_shared-source/date-utils.js';
import { runMorning } from './logic/morning-workflow.js';
import { runClose } from './logic/close-workflow.js';
// [EXTRAS-PATCH 2026-09-11] 竞价四要素补漏（可手动 /fetch?point=extras；16:00 close 也会自动跑）
import { runAuctionExtrasPatch, runTodaySnapshotPatch } from './logic/extras-workflow.js';
// [RANGE-HEAL 2026-11-04] 区间涨幅云端自愈：9:25 那次猫抓 daily 失败时，
//   9:27 那一趟把 stock_range_pct 补回来 —— 用户关电脑/用手机也能出票（根因见文件头）。
import { runRangePctHeal } from './logic/range-heal.js';
// [LADDER-FALLBACK 2026-11-06] 只补「最近多板 883410 正式名单」，不碰行情/猫抓/区间涨幅。
import { healLadderWatchlist } from './logic/ladder-heal.js';
// [LADDER26 2026-11-06] 北京 09:26 云端二次确认：真实名单 + 新进票猫抓竞价量比（1 次额度上限）。
// [AUC-RATIO-0927 2026-11-12] 同时把「补竞价量比」那一步暴露出来，供 9:27 兜底复用（同一份实现，§6）。
import { runLadderRecheck, fillAucFromNumcat } from './logic/ladder-recheck.js';
// [R20-CLOUD 2026-11-06] 同一趟 9:26 顺带把 20 日涨幅用逐日腿补缺（0 上游、0 额度）。
import { runRange20Prefill } from './logic/range20-prefill.js';
// [DAILY-LEGS-CLOUD 2026-11-06] 逐日腿云端补齐，彻底替代本机 08:00 定时任务。
import { runDailyLegsHeal } from './logic/daily-legs-heal.js';
// ★★ [LD-CLOUD 2026-11-13 用户口径] 第二十五条「总龙首次/二次分歧」云端预计算：
//   「都是在云端运行，关电脑也能用，不要电脑本地的」⇒ 判定全部在 Worker 里算完落 tvrb_leader_diverge，
//   前端只读一行（src/data/leader-diverge-days.js）。9:27（intraday）+ 16:00（close）各跑一次。
import { runLeaderDivergeDays } from './logic/leader-diverge-days.js';
// [BIDDING-CLOSE-CLOUD 2026-11-07] 竞价变化看板「收盘」列纯云端幂等落库：
//   以前只能靠浏览器自动填表 + 人工点保存，漏点一天 ⇒ 次日「昨多板K线」断链。
import { runBiddingCloseWrite } from './logic/bidding-close-write.js';
// [JIWANG-SHOUGU-CLOUD 2026-11-08] 「昨收盘结果(跌:涨)」纯云端落库 + 10 日窗口历史回补。
//   原来只靠另一个账号/查不到的 worker-b 在 16:00 写下一交易日，且日志带不存在的 worker 列被吞，
//   11-05 16:00 那轮没跑 ⇒ jiwang_data 缺 11-06 整行 ⇒ 昨日跌涨/昨收盘结果/昨日情绪一起空。
import { runJiwangCloseWrite } from './logic/jiwang-close-write.js';
// [RUNLOG 2026-09-30] 把每轮的完整日志（含 ⏱ 埋点）落库到 bidding_fetch_log，
//   否则 CF Worker 的埋点只进 Cloudflare Dashboard，事后无法复盘「9:26 为什么没数据」。
import { writeRunLog, readPreviousAuctionWatchlist, readMarketMetricsForDate } from './data/supabase-write.js';
import { RANGE20_MIN_TARGETS } from '../../src/logic/auction/range-window.js';

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  // 9:25 ~ 9:40 → morning
  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 40) return 'morning';
  // 15:00 ~ 16:30 → close（收盘涨幅覆盖，跨过收盘门槛即可手动补抓）
  if (mins >= 15 * 60 && mins <= 16 * 60 + 30) return 'close';
  return null;
}

// 从 cron 表达式解析触发点
function cronToPoint(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hour = parts[1];
  const key = min + ' ' + hour;
  // 01:25 UTC = 09:25 北京时间 → morning
  // 08:00 UTC = 16:00 北京时间 → close（收盘涨幅覆盖）
  // ★ [HEAL-0927 2026-11-04 用户口径「我不可能在电脑旁盯着，用手机打开就要看到结果」]
  //   01:27 UTC = 09:27 北京时间 → snapshot（自愈补写）。
  //   为什么需要这一趟：猫抓对【当日】的 auc_vol 在 9:25 偶尔还没结算，会返回占位 0
  //   ⇒ 9:25 那次写下去是空的；等到 9:27（竞价已结算、还没开盘）用同花顺快照
  //   （免费、不烧猫抓额度）把当日竞价量/量比/竞价涨幅补回来。
  //   **全程在云端跑，不需要用户开电脑。**
  //   注：9:35 仍然保留映射 —— 用户之前可能已加过这条触发器，且它现在只是「再兜一次」
  //   （内部幂等，覆盖率达标就零请求），对开盘后的复盘仍有用，删掉反而少一层保险。
  // [LADDER26 2026-11-06] 01:26 UTC = 北京 09:26：名单源二次确认。
  //   11-06 的 P0 里上游 9:25 挂、9:4x 就恢复，只靠 9:25 内重试救不回来；
  //   这条 cron 在开盘前 4 分钟再问一次，且「9:25 已成功」时 0 请求直接返回（幂等）。
  const MAP = {
    '25 1': 'morning',
    '26 1': 'ladder26',
    '27 1': 'snapshot',
    '35 1': 'snapshot',
    '0 8': 'close'
  };
  return MAP[key] || null;
}

/**
 * [SNAPSHOT-EXTRAS 2026-09-14] 9:25 早盘 / 16:00 收盘主流程末尾，用同花顺快照补【当天】
 * 的 auc_pct_chg / auc_turnover / volume（免费、0 猫抓额度）。
 * ⛔ [AUC-RATIO-NUMCAT-ONLY 2026-11-04] **不含 auc_vol_ratio（竞价量比）** ——
 *    用户口径：竞价量比只认猫抓、同花顺永远不许补（详见 extras-workflow.js#runTodaySnapshotPatch）。
 * 失败不致命：整段 try/catch，只留日志，绝不影响主流程结果。
 */
async function runSnapshotPatchSafely(env, result, tag) {
  try {
    const snap = await runTodaySnapshotPatch(env, {});
    console.log('[auto-fetch] ' + tag + ' 快照补当日竞价字段: patched=' + snap.patched + ' 日志=' + JSON.stringify(snap.logs || []));
    if (result && typeof result === 'object') result.snapshotPatch = snap;
  } catch (e) {
    console.error('[auto-fetch] ' + tag + ' 快照补当日竞价字段失败:', e && e.message);
  }
}

/**
 * ★★ [LADDER26-TIMING 2026-11-12 用户硬指标] 9:26 这一趟的时序度量。
 *
 * 用户原话：「要在9点26分时，不要超过9点27分，题材量比选股结果计算是否正常，
 *   注意我要求的全部在云端运行，不用打开本地电脑。」
 *
 * 为什么必须补（实测缺口）：
 *   `bidding_fetch_log` 里 11-09 / 11-10 / 11-11 三天的 ladder26 记录中
 *   `elapsedMs` / `finishedAtBj` 全是 **null** —— 9:25 morning 有（11225/9507/9512ms +
 *   09:25:40 完成），唯独 9:26 这一趟没有任何耗时证据 ⇒ 「是否超过 9:27」无从核对。
 *   ⇒ 本文件给 ladder26 补上三个字段（纯记录，⛔ 不改任何业务分支、不改执行顺序）。
 *
 * `persistRunResult` 已按 `r.elapsedMs / r.finishedAtBj / r.p0Overrun` 落库 ⇒ 只要 result26
 * 带上这三个字段就自动进 `bidding_fetch_log.detail`，无需改写入侧（§11 最小改动）。
 */
const LADDER26_DEADLINE_BJ_SEC = 9 * 3600 + 27 * 60;   // 09:27:00（用户硬指标上界）
const LADDER26_DEADLINE_LABEL = '09:27:00';
/** 北京时钟 HH:MM:SS（beijingNow 的 UTC 字段装的就是北京值） */
function bjClockNow() {
  const d = beijingNow();
  return String(d.getUTCHours()).padStart(2, '0') + ':' +
    String(d.getUTCMinutes()).padStart(2, '0') + ':' +
    String(d.getUTCSeconds()).padStart(2, '0');
}
/** 北京当日秒数（0 点起），用于和 09:27:00 比较 */
function bjSecNow() {
  const d = beijingNow();
  return d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
}

/**
 * [RUNLOG 2026-09-30] 把这一轮的运行结果落库到 bidding_fetch_log（含 ⏱ 埋点断点）。
 * 只写日志表，失败静默（见 data/supabase-write.js#writeRunLog），绝不影响主流程。
 */
async function persistRunResult(env, point, result) {
  const r = result || {};
  await writeRunLog(env, {
    time_point: point,
    run_date: r.today || r.date || '',
    ok: r.ok === true,
    detail: {
      elapsedMs: r.elapsedMs === undefined ? null : r.elapsedMs,
      finishedAtBj: r.finishedAtBj || '',
      p0Overrun: !!r.p0Overrun,
      // ★ [LADDER26-TIMING 2026-11-12] 该趟的硬截止时刻（ladder26 = 09:27:00）；
      //   morning 不传 ⇒ 空串（它的截止 09:25:45 写在 logs 里，见 morning-workflow P0_DEADLINE_LABEL）
      deadlineBj: r.deadlineBj || '',
      ladderDegraded: !!r.ladderDegraded,
      // [LADDER-SRC 2026-11-03 用户口径] 同花顺「最近多板」(883410) 源数据条数。
      //   前端 logic/auction/ladder-source.js 读这个字段显示在第一页（用户拿它对炒股软件）。
      //   ⚠️ null = 本轮没走到那一步（如名单落库失败提前返回）⇒ 前端显示 `--`，⛔ 不补 0。
      ladderCount: r.ladderCount === undefined ? null : r.ladderCount,
      // [LADDER-FALLBACK 2026-11-06] 名单自愈留痕：真名单恢复 / 兜底 / 写入行数
      ladderHealRecovered: !!r.ladderHealRecovered,
      ladderHealFallback: !!r.ladderHealFallback,
      ladderHealWritten: r.ladderHealWritten === undefined ? null : r.ladderHealWritten,
      watchlistRowsWritten: r.watchlistRowsWritten === undefined ? null : r.watchlistRowsWritten,
      // [LADDER26 2026-11-06] 09:26 二次确认留痕：是否跳过 / 名单恢复 / 兜底清理 / 猫抓补抓
      ladderRecheckSkipped: !!r.skipped,
      ladderRecheckRecovered: !!r.recovered,
      ladderRecheckFallbackCleared: r.fallbackCleared === undefined ? null : r.fallbackCleared,
      ladderRecheckAuc: r.auc || null,
      // [R20-CLOUD 2026-11-06] 同一趟 9:26 的 20 日涨幅云端补缺结果
      range20Written: r.range20Written === undefined ? null : r.range20Written,
      // [DAILY-LEGS-CLOUD 2026-11-06] 逐日腿云端补齐（替代本机 08:00 任务）
      dailyLegsWritten: r.dailyLegsWritten === undefined ? null : r.dailyLegsWritten,
      todayDataMissing: !!r.todayDataMissing,
      todayMetricsWritten: r.todayMetricsWritten === undefined ? null : r.todayMetricsWritten,
      metricsWritten: r.metricsWritten === undefined ? null : r.metricsWritten,
      rangeWritten: r.rangeWritten === undefined ? null : r.rangeWritten,
      // [CLOUD-0927-HEAL 2026-11-11] 9:27 自愈的结构化验收字段（⛔ 别用 ok 判断补写是否发生）
      rangeHealCoverage: r.rangeHealCoverage === undefined ? null : r.rangeHealCoverage,
      rangeHealHealthy: r.rangeHealHealthy === true,
      range20Targets: r.range20Targets === undefined ? null : r.range20Targets,
      range20Covered: r.range20Covered === undefined ? null : r.range20Covered,
      range20Skipped: r.range20Skipped || '',
      // ★★ [AUC-RATIO-0927 2026-11-12] 9:27 竞价量比兜底的结构化留痕。
      //   验收：aucRatioWritten>0 = 这一趟真的补回了量比；aucRatioHeal.skipped 含「0 次猫抓请求」
      //   = 9:25/9:26 已补齐（正常日，0 额度）。⛔ 别只看 ok（它会把零补写伪装成成功）。
      aucRatioWritten: r.aucRatioWritten === undefined ? null : r.aucRatioWritten,
      aucRatioHeal: r.aucRatioHeal || null,
      upstreamReady: r.upstreamReady === true,
      upstreamRows: r.upstreamRows === undefined ? null : r.upstreamRows,
      // [AUC-SANE 2026-10-12] 竞价涨幅越界闸门：>0 说明上游 numcat 又给了物理不可能的坏值
      aucPctOutOfRange: r.aucPctOutOfRange === undefined ? null : r.aucPctOutOfRange,
      aucPctRepaired: r.aucPctRepaired === undefined ? null : r.aucPctRepaired,
      completenessSummary: r.completenessSummary || '',
      logs: Array.isArray(r.logs) ? r.logs : []
    }
  });
}

/**
 * ★ [HEAL-0927 2026-11-04] 9:27 这一趟必须在【9:30 开盘前】把数据补齐，所以不能「一看到
 *   非终态就放弃」——上游 data_status 从 pending 跳到 final 往往就差几秒。
 *   策略：非终态时等 3 秒再试，最多 4 次（最坏拖到约 9:27:15，仍远早于开盘）。
 *   · 除「非终态」以外的任何原因（日期不符 / 无行 / 无 timestamp / 读失败）都不重试
 *     —— 那些等多久都不会变，重试只是白等（§32 不做无意义请求）。
 *   · 不烧任何额度：快照接口免费，区间涨幅那一步才有额度成本。
 */
const HEAL_SNAP_RETRY = 4;
const HEAL_SNAP_WAIT_MS = 3000;

async function runSnapshotPatchUntilFinal(env, date) {
  let last = null;
  const allLogs = [];
  for (let i = 0; i < HEAL_SNAP_RETRY; i++) {
    last = await runTodaySnapshotPatch(env, { date: date });
    (last.logs || []).forEach(l => allLogs.push(i === 0 ? l : '(重试' + (i + 1) + ') ' + l));
    if (last.reason !== '非终态') break;
    if (i < HEAL_SNAP_RETRY - 1) {
      allLogs.push('[snapshot] 非终态（上游还没结算完）→ 等 ' + (HEAL_SNAP_WAIT_MS / 1000) + 's 后重试');
      await new Promise(r => setTimeout(r, HEAL_SNAP_WAIT_MS));
    }
  }
  return Object.assign({}, last, { logs: allLogs });
}

// ★★ [CLOUD-0927-HEAL 2026-11-11] 9:27「上游就绪」有界等待
//
// 取证（data/fuyao-api.js:12-16）：9:25 那轮曾因上游吊住跑满 284s，21 个交易日里 5 次顶穿
// 9:26，其中 3 次（09:29:56 / 09:30:24 / 09:29:46）连 9:27 都顶穿。此时 market_metrics
// 还没落库 ⇒ 快照补字段读到 0 行、runRangePctHeal targets=0 跳过、r20-prefill 也被下限闸门拒写，
// 而三段都会返回 ok:true ⇒ bidding_fetch_log 报「成功」但当天竞价口径涨幅全缺。
//
// 修法：只在「上游还没到」这一种情形下等，最多 90s（9:27:00 → 9:28:30，仍早于 9:30 开盘）。
//   · 正常日第一次读就 ≥ RANGE20_MIN_TARGETS 行 ⇒ 仅 1 次 Supabase REST、0 猫抓额度、0 等待；
//   · 读取失败 / 其它异常 ⇒ 立即放手（照搬前端 healTodayRangePct「只对 skipped 等待」的分类口径），
//     ⛔ 不做无意义轮询（§32）；
//   · 等不到就留 loud 日志 + 结构化字段，运维能一眼看出「拖尾日零补写」。
const HEAL_UPSTREAM_WAIT_MAX_MS = 90000;
const HEAL_UPSTREAM_WAIT_STEP_MS = 5000;

async function waitForMorningUpstream(env, date) {
  const logs = [];
  const target = date || beijingToday();
  const deadline = Date.now() + HEAL_UPSTREAM_WAIT_MAX_MS;
  let rows = 0;
  for (;;) {
    try {
      const m = await readMarketMetricsForDate(env, target, 'auction');
      rows = Array.isArray(m) ? m.length : 0;
    } catch (e) {
      // 读失败 ≠ 「还没到」，等多久都不会变 ⇒ 立即放手（§10 / §32）
      logs.push('[CLOUD-0927-HEAL] ⚠️ 上游 market_metrics 读取失败（非「未就绪」，立即放手）: ' +
        ((e && e.message) || String(e)));
      return { ready: false, rows: 0, logs: logs };
    }
    if (rows >= RANGE20_MIN_TARGETS) {
      logs.push('[CLOUD-0927-HEAL] ✅ 上游竞价行 ' + rows + ' 行 ≥ ' + RANGE20_MIN_TARGETS + ' ⇒ 就绪');
      return { ready: true, rows: rows, logs: logs };
    }
    if (Date.now() >= deadline) {
      logs.push('[CLOUD-0927-HEAL] ⚠️ 等待 9:25 上游超时（竞价行仅 ' + rows + ' 行）⇒ ' +
        '本轮补写大概率踩空，请查 9:25 那轮的耗时；⛔ 不基于残缺数据写库');
      return { ready: false, rows: rows, logs: logs };
    }
    logs.push('[CLOUD-0927-HEAL] 上游竞价行 ' + rows + ' 行（<' + RANGE20_MIN_TARGETS +
      '）⇒ 9:25 尚未落库完，' + (HEAL_UPSTREAM_WAIT_STEP_MS / 1000) + 's 后再看');
    await new Promise(r => setTimeout(r, HEAL_UPSTREAM_WAIT_STEP_MS));
  }
}

async function dispatch(point, env, logs, opts) {
  // [JIWANG-SHOUGU-CLOUD 2026-11-08] 手动入口：立即回补昨收盘结果（含历史缺口），
  //   不改变任何已有非空值；16:00 close 轮也会自动跑一次。
  if (point === 'jiwang') {
    const r = await runJiwangCloseWrite(env);
    console.log('[auto-fetch] jiwang 昨收盘结果云端落库: ok=' + r.ok + ' written=' + r.written +
      ' 日志=' + JSON.stringify(r.logs || []));
    return r;
  }
  if (point === 'morning') {
    const result = await runMorning(env);
    console.log('[auto-fetch] runMorning 完成 ok=' + result.ok + ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runMorning 完整日志:', JSON.stringify(result.logs || []));
    // [RUNLOG 2026-09-30] 先落库再跑快照补漏：P0 时延证据要第一时间写下去
    await persistRunResult(env, point, result);
    // [SNAPSHOT-EXTRAS 2026-09-14] 9:25 竞价刚结束 → 立刻补当天三个竞价字段（趋势图/龙徽章/一字红线依赖它们）
    await runSnapshotPatchSafely(env, result, 'morning');
    return result;
  }
  if (point === 'close') {
    // [REPAIR-DATE 2026-09-11] 支持 ?date=YYYY-MM-DD 指定要覆盖/修复的交易日（默认北京今天）。
    const result = await runClose(env, { date: opts && opts.date });
    console.log('[auto-fetch] runClose 完成 ok=' + result.ok + ' today=' + (result.today || '') +
      ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runClose 完整日志:', JSON.stringify(result.logs || []));
    // [DAILY-LEGS-CLOUD 2026-11-06] 运行日志改在本轮全部补写动作之后落库，
    //   这样 dailyLegsWritten 也会进 bidding_fetch_log，事后可核验「云端是否真的接管」。
    // [SNAPSHOT-EXTRAS 2026-09-14] 收盘后再兜一次（防止 9:25 那次快照未终态 / 漏掉新进名单的票）
    await runSnapshotPatchSafely(env, result, 'close');
    // [DAILY-LEGS-CLOUD 2026-11-06] 收盘覆盖完成后，把「今天这根收盘腿」写进 stock_daily_pct。
    //   这是明天 9:26 的 20 日涨幅快路径能否 0 上游请求算出真值的前提；
    //   以前靠本机 08:00 定时任务补，现在随 worker 自动跑（⛔ 关电脑不影响）。
    try {
      const legs = await runDailyLegsHeal(env, {});
      result.dailyLegs = legs;
      result.dailyLegsWritten = legs.written;
      console.log('[auto-fetch] close 逐日腿云端补齐: ok=' + legs.ok + ' written=' + legs.written +
        ' 日志=' + JSON.stringify(legs.logs || []));
    } catch (e) {
      console.error('[auto-fetch] close 逐日腿云端补齐异常（不影响收盘）:', e && e.message);
    }
    // [BIDDING-CLOSE-CLOUD 2026-11-07] 收盘列云端落库（幂等填空、只允许当天、失败不连坐）。
    //   放在所有行情/涨幅写入之后：这一轮已经把当天收盘涨幅算完，快照此时是终态。
    try {
      const bcw = await runBiddingCloseWrite(env, { date: (opts && opts.date) || '' });
      result.biddingCloseWritten = bcw.written;
      if (Array.isArray(result.logs)) result.logs.push.apply(result.logs, (bcw.logs || []).map(l => '[bidding-close] ' + l));
      console.log('[auto-fetch] close 竞价看板收盘列云端落库: ok=' + bcw.ok +
        ' written=' + bcw.written + ' skipped=' + !!bcw.skipped + ' 日志=' + JSON.stringify(bcw.logs || []));
    } catch (e) {
      // 失败必须可见（§10），但绝不拖垮已经成功的 runClose
      const msg = '[bidding-close] ❌ 云端落库异常（不影响收盘主流程）: ' + (e && e.message);
      if (Array.isArray(result.logs)) result.logs.push(msg);
      console.error('[auto-fetch] ' + msg);
    }
    // [JIWANG-SHOUGU-CLOUD 2026-11-08] 昨收盘结果（跌:涨）云端落库 + 10 日窗口回补历史缺口。
    //   放在最后：与上面的竞价看板收盘列互不依赖，任一失败都不连坐。
    try {
      const jw = await runJiwangCloseWrite(env);
      result.jiwangShouguWritten = jw.written;
      if (Array.isArray(result.logs)) result.logs.push.apply(result.logs, (jw.logs || []).map(l => '[jiwang-shougu] ' + l));
      console.log('[auto-fetch] close 昨收盘结果云端落库: ok=' + jw.ok + ' written=' + jw.written +
        ' 日志=' + JSON.stringify(jw.logs || []));
    } catch (e) {
      const msg = '[jiwang-shougu] ❌ 云端落库异常（不影响收盘主流程）: ' + (e && e.message);
      if (Array.isArray(result.logs)) result.logs.push(msg);
      console.error('[auto-fetch] ' + msg);
    }
    // ★★ [LD-CLOUD 2026-11-13 用户口径] 第二十五条「总龙分歧」第二阶段：收盘腿齐全后重算一次。
    //
    //   为什么必须有两趟（而不是只在 9:27 跑）：
    //     用户给第二十五条定的三种分歧形态里，D2 =「竞价高开、收盘是负数绿的」**只能收盘后判**。
    //     9:27 那一趟 leg_phase='intraday'，今天还没有收盘腿 ⇒ 今天这种日子判不出来；
    //     16:00 这一趟（runClose + runDailyLegsHeal 之后 stock_daily_pct 已有今天那根腿）再算一次，
    //     leg_phase='close' 覆盖同一行 —— 这是【信息更全】的覆盖，不是改口径。
    //   ⚠️ 必须放在 runDailyLegsHeal 之后（上面那个 try 块）⇒ 收盘涨幅真值已在库里。
    //   ⛔ 失败不连坐：只记日志 + result 字段。
    try {
      const ldLogs = [];
      const ldClose = await runLeaderDivergeDays(env, {
        today: (opts && opts.date) || beijingToday(),
        phase: 'close',
        logs: ldLogs
      });
      result.leaderDivergeClose = ldClose;
      result.leaderDivergeCloseWritten = ldClose.written || 0;
      if (Array.isArray(result.logs)) result.logs.push.apply(result.logs, ldLogs.map(l => l));
      console.log('[auto-fetch] [LD-CLOUD] 16:00 总龙分歧云端预计算（收盘腿）: ok=' + ldClose.ok +
        ' written=' + ldClose.written + ' phase=' + ldClose.phase + ' error=' + (ldClose.error || '') +
        ' 日志=' + JSON.stringify(ldLogs));
    } catch (e) {
      const msg = '[LD-CLOUD] ❌ 16:00 总龙分歧预计算异常（不影响收盘主流程）: ' + (e && e.message);
      if (Array.isArray(result.logs)) result.logs.push(msg);
      console.error('[auto-fetch] ' + msg);
    }
    await persistRunResult(env, point, result);
    return result;
  }
  if (point === 'snapshot') {
    // ★ [HEAL-0927 2026-11-04] 9:27 这一趟承担两件事（都在云端跑，不需要用户开电脑）：
    //   ① 用同花顺快照补【当日】竞价量 / 竞价涨幅 / 换手 —— 免费、0 猫抓额度；
    //      ⛔⛔ **不含竞价量比**（旧注释写「量比」是错的，2026-11-06 更正）：
    //      auc_vol_ratio 只认猫抓 daily_auc 的 9:25 竞价时间段数据，同花顺永远不许兜底。
    //      SNAPSHOT_FIELDS 实际只有 ['auc_pct_chg','auc_turnover','volume']（有单测锁）。
    //   ② 用猫抓 daily 补【当日】stock_range_pct（区间涨幅）—— 只有 9:25 那次失败时才真正发请求。
    //   为什么 ② 必须在这里：区间涨幅是「题材量比排序 + 十日涨幅列」的唯一依据，
    //   9:25 猫抓一旦超时，云端就没数据，只能等浏览器补算 ⇒ 不开电脑当天永远出不了票。
    //   ③ [CLOUD-0927-HEAL 2026-11-11] 再补一次 20 日涨幅（0 上游、0 猫抓额度）：
    //      9:25 与 9:26 是两条独立 cron，9:26 偶发抢在 9:25 尾巴前 → r20-prefill 因「T 腿
    //      还没落库」一只不写且没有重试；9:27 是开盘前最后一个云端时点，这里幂等重跑一次
    //      （只补当天缺行、已有值永不覆盖）即可把残缺榜补齐，不需要任何人打开网页。
    const date = (opts && opts.date) || '';
    // 只对【今天】等上游；手动回补历史日时数据是固化的，等也没有意义（§32）。
    const upstream = (!date || date === beijingToday())
      ? await waitForMorningUpstream(env, date)
      : { ready: true, rows: null, logs: [] };
    upstream.logs.forEach(function(l) { console.log('[auto-fetch] ' + l); });
    const snap = await runSnapshotPatchUntilFinal(env, date);
    console.log('[auto-fetch] runTodaySnapshotPatch 完成 ok=' + snap.ok + ' patched=' + snap.patched +
      ' today=' + (snap.today || ''));
    console.log('[auto-fetch] runTodaySnapshotPatch 完整日志:', JSON.stringify(snap.logs || []));
    // 区间涨幅自愈：失败不致命（内部已 try/catch 到日志），绝不影响上面的竞价字段补漏
    let range = { ok: false, written: 0, logs: ['[range-heal] 未执行'] };
    try {
      range = await runRangePctHeal(env, { date: date });
      console.log('[auto-fetch] runRangePctHeal 完成 ok=' + range.ok + ' written=' + range.written +
        ' coverage=' + (range.coverage === undefined ? '-' : (range.coverage * 100).toFixed(0) + '%'));
      console.log('[auto-fetch] runRangePctHeal 完整日志:', JSON.stringify(range.logs || []));
    } catch (e) {
      console.error('[auto-fetch] runRangePctHeal 异常:', e && e.message);
      range = { ok: false, written: 0, logs: ['[range-heal] 异常: ' + ((e && e.message) || e)] };
    }
    // ③ 20 日涨幅再补一次（0 上游请求、0 猫抓额度、只填空；失败不连坐）
    let r20 = { ok: false, written: 0, skipped: '未执行', logs: ['[r20-0927] 未执行'] };
    try {
      r20 = await runRange20Prefill(env, { today: date });
      console.log('[auto-fetch] [CLOUD-0927-HEAL] 9:27 20 日涨幅二次补缺: ok=' + r20.ok +
        ' written=' + r20.written + ' 目标=' + r20.targets + ' 已有=' + r20.covered +
        ' skipped=' + (r20.skipped || ''));
      console.log('[auto-fetch] [CLOUD-0927-HEAL] r20 日志=' + JSON.stringify(r20.logs || []));
    } catch (e) {
      const msg = '[CLOUD-0927-HEAL] ❌ 9:27 20 日涨幅二次补缺异常（不影响本轮其它补写）: ' + ((e && e.message) || e);
      r20 = { ok: false, written: 0, skipped: '', logs: [msg] };
      console.error('[auto-fetch] ' + msg);
    }
    // ★★ [AUC-RATIO-0927 2026-11-12] 9:27 是开盘前【最后一个】云端时点，竞价量比也必须在这里兜一次。
    //
    //   用户 11-11 报障取证：「青岛食品」当天 market_metrics 有行、其它三要素齐全，
    //   但 `auc_vol_ratio` 为 null；同为 20 日补位票的「海洋王」却有 1.94。
    //     ① 该票近 15 个交易日里 14 天都有量比（11-10=6.01 / 11-09=6.58 / 11-04=13.63），
    //        唯独 11-11 那天是空 ⇒ 上游返回空值时，`hasValue` 判假 ⇒ 该列被省略 ⇒ 全天 null；
    //     ② 9:26 的补抓（[RANGE20-RATIO-HEAL]）给了第二次机会，但它自己也可能超时 / 403 额度用尽；
    //     ③ 一旦 9:26 也失手，下一个能补量比的时点是 16:30 收盘 —— 竞价期间用户看到的就是空缺。
    //   ⇒ 此处做【有缺口才发】的第三次补抓：量比齐全 ⇒ 0 请求 0 额度（§32）。
    //   ⛔ 不覆盖已有值：pickNumcatTargets 遇到已有量比直接跳过；写库只带 auc_vol_ratio 一列（§11）。
    //   ⛔ 不重建行：没有 market_metrics 行的票不在本函数的覆盖范围（它只补「已有行缺列」）。
    const aucLogs = [];
    let auc27 = { attempted: false, symbols: 0, written: 0, names: [], skipped: '未执行', error: '' };
    try {
      auc27 = await fillAucFromNumcat(env, date || beijingToday(), null, aucLogs);
      console.log('[auto-fetch] [AUC-RATIO-0927] 9:27 竞价量比兜底: attempted=' + auc27.attempted +
        ' symbols=' + auc27.symbols + ' written=' + auc27.written +
        ' skipped=' + (auc27.skipped || '') + ' error=' + (auc27.error || '') +
        (auc27.names && auc27.names.length ? ' 补写=' + auc27.names.join(',') : ''));
      console.log('[auto-fetch] [AUC-RATIO-0927] 日志=' + JSON.stringify(aucLogs));
    } catch (e) {
      const msg = '[AUC-RATIO-0927] ❌ 9:27 竞价量比兜底异常（不影响本轮其它补写）: ' + ((e && e.message) || e);
      auc27 = { attempted: false, symbols: 0, written: 0, names: [], skipped: '', error: String((e && e.message) || e) };
      aucLogs.push(msg);
      console.error('[auto-fetch] ' + msg);
    }
    // ★★ [LD-CLOUD 2026-11-13 用户口径] 第二十五条「总龙分歧」云端预计算（9:27 这一趟）。
    //
    //   用户原话：「你帮我完成啊，不要留着，记住都是在云端运行，关电脑也能用，不要电脑本地的」。
    //   为什么挂在 9:27 而不是新开 cron：免费账户 cron 上限 5 条、本 Worker 已用 4 条；而 9:27
    //   本身就是「开盘前最后一个云端时点」，此时 20 日涨幅 /竞价涨幅 / 名单都已落库 ⇒ 数据齐。
    //   ⚠️ 这一趟 leg_phase='intraday'：今天的收盘腿还不存在 ⇒ D2（高开低走收绿）对今天不可能成立，
    //      D1（竞价低开）/ D3（占比塌陷）照常成立；16:00 close 那一趟会写 leg_phase='close' 的覆盖行。
    //   ⛔ 失败不连坐：只记日志 + result 字段，不影响上面的量比兜底 / 区间自愈。
    const ldLogs = [];
    let ld27 = { ok: false, written: 0, skipped: '未执行', logs: ldLogs };
    try {
      ld27 = await runLeaderDivergeDays(env, {
        today: date || beijingToday(),
        phase: 'intraday',
        logs: ldLogs
      });
      console.log('[auto-fetch] [LD-CLOUD] 9:27 总龙分歧云端预计算: ok=' + ld27.ok +
        ' written=' + ld27.written + ' phase=' + ld27.phase + ' error=' + (ld27.error || ''));
      console.log('[auto-fetch] [LD-CLOUD] 日志=' + JSON.stringify(ldLogs));
    } catch (e) {
      const msg = '[LD-CLOUD] ❌ 9:27 总龙分歧预计算异常（不影响本轮其它补写）: ' + ((e && e.message) || e);
      ld27 = { ok: false, written: 0, skipped: '', error: String((e && e.message) || e), logs: ldLogs };
      ldLogs.push(msg);
      console.error('[auto-fetch] ' + msg);
    }
    const result = {
      ok: snap.ok || range.ok || r20.ok,
      today: snap.today || (date || ''),
      snapshot: snap,
      rangeHeal: range,
      rangeWritten: range.written === undefined ? null : range.written,
      // [CLOUD-0927-HEAL 2026-11-11] 结构化留痕：9:25 严重拖尾时三段都会「ok:true + 0 写入」，
      //   `result.ok = snap.ok || range.ok || r20.ok` 会把零补写伪装成成功。
      //   ⇒ 验收与告警必须看这些字段，⛔ 不能只看 ok / 「✅ 数据完整性汇总」。
      rangeHealCoverage: range.coverage === undefined ? null : range.coverage,
      rangeHealHealthy: range.healthy === true,
      range20Heal: r20,
      range20Written: r20.written || 0,
      range20Targets: r20.targets === undefined ? null : r20.targets,
      range20Covered: r20.covered === undefined ? null : r20.covered,
      range20Skipped: r20.skipped || '',
      // ★★ [AUC-RATIO-0927 2026-11-12] 9:27 竞价量比兜底的结构化验收字段。
      //   验收口径：aucRatioWritten>0 表示这一趟真的补回了量比；
      //   aucRatioHeal.skipped 含「0 次猫抓请求」表示 9:25/9:26 已补齐（正常日）。
      aucRatioHeal: auc27,
      aucRatioWritten: auc27.written || 0,
      // ★★ [LD-CLOUD 2026-11-13] 第二十五条总龙分歧云端预计算的结构化验收字段：
      //   leaderDivergeWritten>0 = 真的落了一行判定；leaderDiverge.ok=false 时看 logs 里的
      //   'board-not-ready' / 'write-failed' / 'no-trade-dates' 定位（⛔ 不要只看 ok）。
      leaderDiverge: ld27,
      leaderDivergeWritten: ld27.written || 0,
      upstreamReady: upstream.ready === true,
      upstreamRows: upstream.rows === null || upstream.rows === undefined ? null : upstream.rows,
      logs: (upstream.logs || []).concat(snap.logs || [], range.logs || [], r20.logs || [], aucLogs, ldLogs)
    };
    await persistRunResult(env, point, result);
    return result;
  }
  if (point === 'extras') {
    // [QUOTA 2026-09-11] 默认排除当天 —— 理由不是「拿不到」，而是**分工**：
    //   当天的字段由同花顺快照腿负责（`runTodaySnapshotPatch`，免费、0 猫抓额度、
    //   ⛔ 不含量比）；本函数只负责【历史日】的猫抓回填。
    //   ⇒ 把今天塞进来只会让两条腿抢同一批字段，还白烧额度。
    // ⚠️ [EXTRAS-TRUTH 2026-11-05] 旧文案写的是「猫抓对当日行不给四要素」——**已被推翻**
    //   （11-05 实测 9:25 写入的 58 只 58/58 全带 auc_vol_ratio）。结论不变，理由换成上面这条。
    // 想坚持「含当天」的旧行为用于排查时，手动加 &today=1。
    const result = await runAuctionExtrasPatch(env, { includeToday: !!(opts && opts.includeToday) });
    console.log('[auto-fetch] runAuctionExtrasPatch 完成 ok=' + result.ok + ' patched=' + (result.patched || 0) +
      ' dates=' + JSON.stringify(result.dates || []));
    console.log('[auto-fetch] runAuctionExtrasPatch 完整日志:', JSON.stringify(result.logs || []));
    await persistRunResult(env, point, result);
    return result;
  }
  if (point === 'ladder26') {
    // [LADDER26 2026-11-06] 北京 09:26 云端 cron。与 `ladder` 的区别：
    //   · ladder    = 人工恢复入口，只写名单、⛔ 不烧猫抓额度、⛔ 不删兜底行；
    //   · ladder26  = 开盘前自动二次确认，名单 + 新进票猫抓补竞价量比 + 清理兜底行，
    //                 且「9:25 已成功」时 0 请求直接返回（幂等，不重复烧额度）。
    const logs26 = [];
    const _t26 = Date.now();   // ★ [LADDER26-TIMING] 见 bjClockNow 的说明
    const d26 = (opts && opts.date) || beijingToday();
    // [CLOUD-0927-HEAL 2026-11-11] 修两处历史缺陷：
    //   ① 原来传 `{ date }`，而 runLadderRecheck 读的是 `o.today` ⇒ 手动 /fetch?point=ladder26&date=
    //      的日期覆盖一直被无视（静默按「今天」跑）。
    //   ② 原来从不传 `prevRows` ⇒ 9:25 整轮挂 + 883410 仍不可用时，前一日正式成员兜底永远写不出。
    //      这里用 0 上游请求的库内查询补上；读失败只记日志，不阻断本轮。
    let prevRows = [];
    try {
      const prev = await readPreviousAuctionWatchlist(env, d26);
      prevRows = prev.rows;
      logs26.push('[ladder26] 前一日兜底名单来源 ' + (prev.date || '无') + '：' + prevRows.length + ' 行');
    } catch (e) {
      logs26.push('[ladder26] ⚠️ 读取前一日兜底名单失败（不阻断本轮，深度降级将无兜底）: ' +
        ((e && e.message) || String(e)));
    }
    const r26 = await runLadderRecheck(env, { today: d26, prevRows: prevRows, logs: logs26 });
    // [DAILY-LEGS-CLOUD] 先补【今天之前】漏掉的逐日腿，再算 20 日涨幅：
    //   顺序不能反 —— 昨天那根腿缺了，下面的快路径会用更早的 19 根凑数，窗口整体错位一天。
    let legs26 = { ok: false, written: 0, logs: ['[daily-legs] 未执行'] };
    try {
      legs26 = await runDailyLegsHeal(env, { allowToday: false, logs: logs26 });
    } catch (e) {
      legs26 = { ok: false, written: 0, logs: ['[daily-legs] 异常: ' + ((e && e.message) || e)] };
      logs26.push(legs26.logs[0]);
    }
    // [R20-CLOUD] 名单/行情落库之后才是补 20 日涨幅的正确时点（T 腿此刻一定有）。
    // 失败不致命：这是补缺层，正确性不依赖它，⛔ 绝不影响已写好的名单与竞价量比。
    let r20 = { ok: false, written: 0, logs: ['[r20-prefill] 未执行'] };
    try {
      r20 = await runRange20Prefill(env, { today: (opts && opts.date) || '', logs: logs26 });
    } catch (e) {
      r20 = { ok: false, written: 0, logs: ['[r20-prefill] 异常: ' + ((e && e.message) || e)] };
      logs26.push(r20.logs[0]);
    }
    const result26 = {
      ok: r26.ok || r20.ok,
      today: r26.today,
      skipped: r26.skipped,
      recovered: r26.recovered,
      written: r26.written,
      fallbackCleared: r26.fallbackCleared,
      ladderCount: r26.ladderCount,
      auc: r26.auc,
      dailyLegs: legs26,
      dailyLegsWritten: legs26.written || 0,
      range20: r20,
      range20Written: r20.written || 0,
      // ★★ [LADDER26-TIMING 2026-11-12] 用户硬指标「9:26 完成、不超过 9:27」的度量。
      //   纯记录：⛔ 未在此加任何截止/跳过分支，执行顺序与业务分支一字未改。
      //   明天 9:26 跑完直接查 bidding_fetch_log（time_point=ladder26）即可核对：
      //     elapsedMs / finishedAtBj / p0Overrun（true = 晚于 09:27:00）
      elapsedMs: Date.now() - _t26,
      finishedAtBj: bjClockNow(),
      p0Overrun: bjSecNow() > LADDER26_DEADLINE_BJ_SEC,
      deadlineBj: LADDER26_DEADLINE_LABEL,
      logs: logs26
    };
    console.log('[auto-fetch] ladder26: ok=' + result26.ok + ' skipped=' + result26.skipped +
      ' recovered=' + result26.recovered + ' written=' + result26.written +
      ' 猫抓补写=' + (r26.auc && r26.auc.written) + ' 20日补缺=' + result26.range20Written +
      ' 日志=' + JSON.stringify(logs26));
    // ★ [LADDER26-TIMING] 单行时序摘要：Cloudflare 控制台一眼可读，配合 bidding_fetch_log 双留存
    console.log('[auto-fetch] ladder26 时序: 耗时=' + result26.elapsedMs + 'ms 完成@' + result26.finishedAtBj +
      ' 截止=' + LADDER26_DEADLINE_LABEL + ' overrun=' + result26.p0Overrun +
      ' | 猫抓补量比=' + ((r26.auc && r26.auc.written) || 0) + ' 只' +
      (r26.auc && r26.auc.names && r26.auc.names.length ? '（' + r26.auc.names.slice(0, 12).join(',') + '）' : '') +
      ' | 20日补缺=' + result26.range20Written + ' 行 | 逐日腿=' + result26.dailyLegsWritten + ' 行');
    await persistRunResult(env, point, result26);
    return result26;
  }
  if (point === 'range20') {
    // [R20-CLOUD 2026-11-06] 手动补 20 日涨幅（0 上游请求），用于验收云端链路是否已接管。
    const logs20 = [];
    const r20 = await runRange20Prefill(env, { today: (opts && opts.date) || '', logs: logs20 });
    const result20 = Object.assign({}, r20, { logs: logs20 });
    console.log('[auto-fetch] range20 云端补缺: ok=' + r20.ok + ' written=' + r20.written +
      ' 日志=' + JSON.stringify(logs20));
    await persistRunResult(env, point, result20);
    return result20;
  }
  if (point === 'divergedays') {
    // ★★ [LD-CLOUD 2026-11-13] 手动入口：立即（重）算「总龙分歧」判定并落库。
    //   参数：&date=YYYY-MM-DD 指定截止日（缺省北京今天）；&days=N 补最近 N 个展示日（默认 1，上限 20）；
    //         &phase=close|intraday 指定口径阶段（缺省按时钟判：15:00 后 = close）。
    //   ⛔ 不读上游、不烧猫抓额度：全部输入来自库内（watchlist / market_metrics / range20 / daily_pct）。
    const ldLogs = [];
    const r = await runLeaderDivergeDays(env, {
      today: (opts && opts.date) || '',
      days: (opts && opts.days) || 1,
      phase: (opts && opts.phase) || '',
      logs: ldLogs
    });
    const out = Object.assign({}, r, { logs: ldLogs });
    console.log('[auto-fetch] divergedays 云端预计算: ok=' + r.ok + ' written=' + r.written +
      ' phase=' + r.phase + ' dates=' + JSON.stringify(r.dates) + ' 日志=' + JSON.stringify(ldLogs));
    await persistRunResult(env, point, out);
    return out;
  }
  if (point === 'ladder') {
    // [LADDER-FALLBACK 2026-11-06] 上游名单源 9:25 临时挂了之后，【只补正式名单】的恢复入口。
    // ⛔ 绝不重跑 runMorning：那样会在开盘后重算行情、再烧 1 次猫抓额度（用户硬口径：额度最贵）。
    // ⛔ 不写兜底名单：手动补名单必须用「今天真实 883410」，拿不到就如实返回 ok=false。
    const logs = [];
    const heal = await healLadderWatchlist(env, {
      today: (opts && opts.date) || '',
      logs: logs,
      allowFallback: false
    });
    const result = {
      ok: heal.ok,
      today: heal.today,
      recovered: heal.recovered,
      written: heal.written,
      ladderCount: heal.ladderCount,
      ladderDegraded: !heal.recovered,
      logs: logs
    };
    console.log('[auto-fetch] ladder 名单补写: ok=' + result.ok + ' written=' + result.written +
      ' count=' + result.ladderCount + ' 日志=' + JSON.stringify(logs));
    await persistRunResult(env, point, result);
    return result;
  }
  console.error('[auto-fetch] 未知触发点:', point);
  return { ok: false, error: '未知触发点: ' + point };
}

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[auto-fetch] 无法识别 cron:', event.cron);
      return;
    }
    // 【FIX 2026-08-04】不管成功/失败，都把完整 logs 数组 console.log 出来
    // [RUNLOG 2026-09-30] 失败也要落库：整轮抛错（如 P0-① 直接 return error）是最该留证据的情况，
    //   以前只在 Cloudflare 控制台留一行 error，事后完全查不到。
    ctx.waitUntil(dispatch(point, env, []).catch(async e => {
      console.error('[auto-fetch] ' + point + ' error:', e.message);
      await writeRunLog(env, {
        time_point: point,
        run_date: '',
        ok: false,
        detail: { error: (e && e.message) || String(e), stack: (e && e.stack) || '' }
      });
    }));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return jsonResponse({ ok: true, service: 'bidding-auto-fetch' });
    }

    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return jsonResponse({ ok: false, error: 'token 无效' }, 403);
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) {
          return jsonResponse({ ok: false, error: '当前北京时间不在抓取时段（9:25~9:40=morning，15:00~16:30=close）' });
        }
      }
      if (!['morning', 'close', 'extras', 'snapshot', 'ladder', 'ladder26', 'range20', 'divergedays', 'jiwang'].includes(point)) {
        return jsonResponse({ ok: false, error: 'point 必须是 morning|close|extras|snapshot|ladder|ladder26|range20|divergedays|jiwang|auto（close 可附 &date=YYYY-MM-DD 指定修复的历史交易日；extras 可附 &today=1 含当天；snapshot / ladder / ladder26 / range20 / divergedays 可附 &date=YYYY-MM-DD；divergedays 另可附 &days=N（补最近 N 个展示日，上限 20）与 &phase=close|intraday；jiwang 立即回补昨收盘结果）' });
      }
      // [JIWANG-SHOUGU-CLOUD 2026-11-08] 回补不受「当前时间必须在 9:25~16:30」限制，
      //   否则周末/夜间出事故时无法立即修复历史缺口。
      if (point === 'jiwang') {
        try {
          const r = await dispatch('jiwang', env, [], {});
          return jsonResponse(r, r.ok ? 200 : 500);
        } catch (e) {
          return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
        }
      }
      try {
        const result = await dispatch(point, env, [], {
          date: url.searchParams.get('date') || '',
          includeToday: url.searchParams.get('today') === '1',
          // ★ [LD-CLOUD 2026-11-13] divergedays 专用：补几个展示日 / 指定口径阶段
          days: Number(url.searchParams.get('days') || '0') || 0,
          phase: url.searchParams.get('phase') || ''
        });
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (e) {
        // [RUNLOG 2026-09-30] 手动触发失败同样落库
        await writeRunLog(env, {
          time_point: point,
          run_date: url.searchParams.get('date') || '',
          ok: false,
          detail: { error: e.message, stack: e.stack, trigger: 'manual-fetch' }
        });
        return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
      }
    }

    return new Response('bidding-auto-fetch', { status: 200 });
  }
};
