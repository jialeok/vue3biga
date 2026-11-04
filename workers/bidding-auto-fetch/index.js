// index.js — bidding-auto-fetch Worker 入口
//
// 三个触发点（同一条 Cloudflare 部署链路）：
//   · 北京 9:25  → morning ：抓竞价数据 + 计算 10 日区间涨幅落库；
//   · 北京 9:27  → snapshot：云端自愈（同花顺快照补当日竞价字段 + 猫抓补当日区间涨幅）；
//   · 北京 16:00 → close   ：用收盘涨幅覆盖 9:25 竞价涨幅 + 校正区间涨幅 T 腿。
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
import { beijingNow } from '../../_shared-source/date-utils.js';
import { runMorning } from './logic/morning-workflow.js';
import { runClose } from './logic/close-workflow.js';
// [EXTRAS-PATCH 2026-09-11] 竞价四要素补漏（可手动 /fetch?point=extras；16:00 close 也会自动跑）
import { runAuctionExtrasPatch, runTodaySnapshotPatch } from './logic/extras-workflow.js';
// [RANGE-HEAL 2026-11-04] 区间涨幅云端自愈：9:25 那次猫抓 daily 失败时，
//   9:27 那一趟把 stock_range_pct 补回来 —— 用户关电脑/用手机也能出票（根因见文件头）。
import { runRangePctHeal } from './logic/range-heal.js';
// [RUNLOG 2026-09-30] 把每轮的完整日志（含 ⏱ 埋点）落库到 bidding_fetch_log，
//   否则 CF Worker 的埋点只进 Cloudflare Dashboard，事后无法复盘「9:26 为什么没数据」。
import { writeRunLog } from './data/supabase-write.js';

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
  const MAP = {
    '25 1': 'morning',
    '27 1': 'snapshot',
    '35 1': 'snapshot',
    '0 8': 'close'
  };
  return MAP[key] || null;
}

/**
 * [SNAPSHOT-EXTRAS 2026-09-14] 9:25 早盘 / 16:00 收盘主流程末尾，用同花顺快照补【当天】
 * 的 auc_pct_chg / auc_vol_ratio / auc_turnover / volume（免费、0 猫抓额度）。
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
      ladderDegraded: !!r.ladderDegraded,
      // [LADDER-SRC 2026-11-03 用户口径] 同花顺「最近多板」(883410) 源数据条数。
      //   前端 logic/auction/ladder-source.js 读这个字段显示在第一页（用户拿它对炒股软件）。
      //   ⚠️ null = 本轮没走到那一步（如名单落库失败提前返回）⇒ 前端显示 `--`，⛔ 不补 0。
      ladderCount: r.ladderCount === undefined ? null : r.ladderCount,
      todayDataMissing: !!r.todayDataMissing,
      todayMetricsWritten: r.todayMetricsWritten === undefined ? null : r.todayMetricsWritten,
      metricsWritten: r.metricsWritten === undefined ? null : r.metricsWritten,
      rangeWritten: r.rangeWritten === undefined ? null : r.rangeWritten,
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

async function dispatch(point, env, logs, opts) {
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
    await persistRunResult(env, point, result);
    // [SNAPSHOT-EXTRAS 2026-09-14] 收盘后再兜一次（防止 9:25 那次快照未终态 / 漏掉新进名单的票）
    await runSnapshotPatchSafely(env, result, 'close');
    return result;
  }
  if (point === 'snapshot') {
    // ★ [HEAL-0927 2026-11-04] 9:27 这一趟承担两件事（都在云端跑，不需要用户开电脑）：
    //   ① 用同花顺快照补【当日】竞价字段（竞价量/量比/竞价涨幅/换手）—— 免费、0 猫抓额度；
    //   ② 用猫抓 daily 补【当日】stock_range_pct（区间涨幅）—— 只有 9:25 那次失败时才真正发请求。
    //   为什么 ② 必须在这里：区间涨幅是「题材量比排序 + 十日涨幅列」的唯一依据，
    //   9:25 猫抓一旦超时，云端就没数据，只能等浏览器补算 ⇒ 不开电脑当天永远出不了票。
    const date = (opts && opts.date) || '';
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
    const result = {
      ok: snap.ok || range.ok,
      today: snap.today || (date || ''),
      snapshot: snap,
      rangeHeal: range,
      rangeWritten: range.written === undefined ? null : range.written,
      logs: (snap.logs || []).concat(range.logs || [])
    };
    await persistRunResult(env, point, result);
    return result;
  }
  if (point === 'extras') {
    // [QUOTA 2026-09-11] 默认排除当天（猫抓对当日行不给四要素，算进去只是白烧额度）。
    // 想坚持「含当天」的旧行为用于排查时，手动加 &today=1。
    const result = await runAuctionExtrasPatch(env, { includeToday: !!(opts && opts.includeToday) });
    console.log('[auto-fetch] runAuctionExtrasPatch 完成 ok=' + result.ok + ' patched=' + (result.patched || 0) +
      ' dates=' + JSON.stringify(result.dates || []));
    console.log('[auto-fetch] runAuctionExtrasPatch 完整日志:', JSON.stringify(result.logs || []));
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
      if (!['morning', 'close', 'extras', 'snapshot'].includes(point)) {
        return jsonResponse({ ok: false, error: 'point 必须是 morning|close|extras|snapshot|auto（close 可附 &date=YYYY-MM-DD 指定修复的历史交易日；extras 可附 &today=1 含当天；snapshot 可附 &date=YYYY-MM-DD）' });
      }
      try {
        const result = await dispatch(point, env, [], {
          date: url.searchParams.get('date') || '',
          includeToday: url.searchParams.get('today') === '1'
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
