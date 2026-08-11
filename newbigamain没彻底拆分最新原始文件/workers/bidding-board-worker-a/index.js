// index.js — bidding-board-worker-a 入口
import { beijingNow } from '../../_shared-source/date-utils.js';
import { CRON_TO_POINT, POINT_TO_COLUMN } from './config.js';
import { runBidding, runDuobanSecond } from './logic/bidding-workflow.js';

function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 9 * 60 + 10 && mins < 9 * 60 + 17) return 't0915';
  if (mins >= 9 * 60 + 17 && mins < 9 * 60 + 22) return 't0920';
  if (mins >= 9 * 60 + 22 && mins < 9 * 60 + 25) return 't0925';
  if (mins >= 9 * 60 + 25 && mins < 9 * 60 + 40) return 't0926';
  if (mins >= 15 * 60) return 'close';
  return null;
}

function cronToPoint(cronExpr) {
  if (CRON_TO_POINT[cronExpr]) return CRON_TO_POINT[cronExpr];
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const min = parts[0], hour = parts[1];
  const key = min + ' ' + hour;
  const MIN_HOUR_TO_POINT = {
    '15 1': 't0915', '20 1': 't0920', '25 1': 't0925', '26 1': 't0926', '0 8': 'close',
  };
  return MIN_HOUR_TO_POINT[key] || null;
}

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[bidding-A] 无法识别 cron 表达式:', event.cron);
      return;
    }
    if (point === 't0926') ctx.waitUntil(runDuobanSecond(env, 'cron'));
    else ctx.waitUntil(runBidding(env, point, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'bidding-board-worker-a', worker: 'A' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'token 无效' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) return new Response(JSON.stringify({ ok: false, error: '当前北京时间不在任何抓取时段' }), { headers: { 'Content-Type': 'application/json' } });
      }
      if (!POINT_TO_COLUMN[point]) {
        return new Response(JSON.stringify({ ok: false, error: 'point 必须是 t0915|t0920|t0925|t0926|close|auto' }), { headers: { 'Content-Type': 'application/json' } });
      }
      let result;
      if (point === 't0926') result = await runDuobanSecond(env, 'http');
      else result = await runBidding(env, point, 'http');
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('bidding-board-worker-a', { status: 200 });
  },
};