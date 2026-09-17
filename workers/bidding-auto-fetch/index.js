// index.js — bidding-auto-fetch Worker 入口
//
// 三个触发点（同一条 Cloudflare 部署链路）：
//   · 北京 9:25  → morning  ：抓竞价数据 + 计算 10 日区间涨幅落库；
//   · 北京 15:40 → limitpool：抓同花顺涨停池 / 跌停池 → limit_pool（「涨跌停」看板数据源）；
//   · 北京 16:00 → close    ：用收盘涨幅覆盖 9:25 竞价涨幅 + 校正区间涨幅 T 腿。
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
// [LIMIT-POOL 2026-09-15] 「涨跌停」看板数据源：北京 15:40 抓同花顺涨停池 / 跌停池 → limit_pool
import { runLimitPool } from './logic/limit-pool-workflow.js';

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
  // 07:40 UTC = 15:40 北京时间 → limitpool（涨跌停池抓取）
  const MAP = {
    '25 1': 'morning',
    '0 8': 'close',
    '40 7': 'limitpool'
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

async function dispatch(point, env, logs, opts) {
  if (point === 'morning') {
    const result = await runMorning(env);
    console.log('[auto-fetch] runMorning 完成 ok=' + result.ok + ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runMorning 完整日志:', JSON.stringify(result.logs || []));
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
    // [SNAPSHOT-EXTRAS 2026-09-14] 收盘后再兜一次（防止 9:25 那次快照未终态 / 漏掉新进名单的票）
    await runSnapshotPatchSafely(env, result, 'close');
    return result;
  }
  if (point === 'snapshot') {
    // [SNAPSHOT-EXTRAS 2026-09-14] 手动补当天竞价字段（排查用）
    const result = await runTodaySnapshotPatch(env, { date: (opts && opts.date) || '' });
    console.log('[auto-fetch] runTodaySnapshotPatch 完成 ok=' + result.ok + ' patched=' + result.patched +
      ' today=' + (result.today || ''));
    console.log('[auto-fetch] runTodaySnapshotPatch 完整日志:', JSON.stringify(result.logs || []));
    return result;
  }
  if (point === 'extras') {
    // [QUOTA 2026-09-11] 默认排除当天（猫抓对当日行不给四要素，算进去只是白烧额度）。
    // 想坚持「含当天」的旧行为用于排查时，手动加 &today=1。
    const result = await runAuctionExtrasPatch(env, { includeToday: !!(opts && opts.includeToday) });
    console.log('[auto-fetch] runAuctionExtrasPatch 完成 ok=' + result.ok + ' patched=' + (result.patched || 0) +
      ' dates=' + JSON.stringify(result.dates || []));
    console.log('[auto-fetch] runAuctionExtrasPatch 完整日志:', JSON.stringify(result.logs || []));
    return result;
  }
  if (point === 'limitpool') {
    // [LIMIT-POOL 2026-09-15] 涨跌停池：北京 15:40 抓涨停池 + 跌停池 → limit_pool。
    // 支持 ?date=YYYY-MM-DD 手动补抓历史某日（上游支持 date_ms）。
    const result = await runLimitPool(env, { date: opts && opts.date });
    console.log('[auto-fetch] runLimitPool 完成 ok=' + result.ok + ' today=' + (result.today || '') +
      ' up=' + (result.upCount || 0) + ' down=' + (result.downCount || 0) +
      ' completenessSummary=' + (result.completenessSummary || ''));
    console.log('[auto-fetch] runLimitPool 完整日志:', JSON.stringify(result.logs || []));
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
    ctx.waitUntil(dispatch(point, env, []).catch(e => console.error('[auto-fetch] ' + point + ' error:', e.message)));
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
      if (!['morning', 'close', 'extras', 'snapshot', 'limitpool'].includes(point)) {
        return jsonResponse({ ok: false, error: 'point 必须是 morning|close|extras|snapshot|limitpool|auto（close 可附 &date=YYYY-MM-DD 指定修复的历史交易日；extras 可附 &today=1 含当天；snapshot 可附 &date=YYYY-MM-DD；limitpool 可附 &date=YYYY-MM-DD）' });
      }
      try {
        const result = await dispatch(point, env, [], {
          date: url.searchParams.get('date') || '',
          includeToday: url.searchParams.get('today') === '1'
        });
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
      }
    }

    return new Response('bidding-auto-fetch', { status: 200 });
  }
};
