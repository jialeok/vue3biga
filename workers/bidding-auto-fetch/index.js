// index.js — bidding-auto-fetch Worker 入口
// [FIX 2026-08-17] 收盘涨幅覆盖已迁移到 Supabase Edge Function auction-close-fetch
// （pg_cron 16:00 触发），本 worker 不再承担 close 涨幅覆盖，只保留 morning 抓取。
// 原 runClose 导入与调度已移除；close-workflow.js 保留为历史参考，不再被调用。
import { beijingNow } from '../../_shared-source/date-utils.js';
import { runMorning } from './logic/morning-workflow.js';

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
  return null;
}

// 从 cron 表达式解析触发点
function cronToPoint(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hour = parts[1];
  const key = min + ' ' + hour;
  // 01:25 UTC = 09:25 北京时间 → morning
  const MAP = {
    '25 1': 'morning',
  };
  return MAP[key] || null;
}

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[auto-fetch] 无法识别 cron:', event.cron);
      return;
    }
    // 【FIX 2026-08-04】不管成功/失败，都把完整 logs 数组 console.log 出来
    if (point === 'morning') {
      ctx.waitUntil(
        runMorning(env)
          .then(result => {
            console.log('[auto-fetch] runMorning 完成 ok=' + result.ok + ' completenessSummary=' + (result.completenessSummary || ''));
            console.log('[auto-fetch] runMorning 完整日志:', JSON.stringify(result.logs || []));
          })
          .catch(e => console.error('[auto-fetch] morning error:', e.message))
      );
    }
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
          return jsonResponse({ ok: false, error: '当前北京时间不在抓取时段（9:25~9:40=morning）' });
        }
      }
      if (!['morning'].includes(point)) {
        return jsonResponse({ ok: false, error: 'point 必须是 morning|auto（close 已迁移到 Supabase auction-close-fetch）' });
      }
      try {
        const result = await runMorning(env);
        return jsonResponse(result, result.ok ? 200 : 500);
      } catch (e) {
        return jsonResponse({ ok: false, error: e.message, stack: e.stack }, 500);
      }
    }

    return new Response('bidding-auto-fetch', { status: 200 });
  }
};