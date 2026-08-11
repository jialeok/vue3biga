// index.js — bidding-board-worker-b 入口
import { beijingNow } from '../../_shared-source/date-utils.js';
import { CRON_TO_POINT } from './config.js';
import { runSeal } from './logic/seal-workflow.js';
import { runEmotion, refreshEmotionPredictVol } from './logic/emotion-workflow.js';
import { runClose } from './logic/jiwang-workflow.js';

function autoPoint() {
  const d = beijingNow();
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (mins >= 9 * 60 + 22 && mins < 9 * 60 + 25) return 't0925-seal';
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
    '25 1': 't0925-seal', '26 1': 't0926', '40 1': 't0926', '0 8': 'close',
  };
  return MIN_HOUR_TO_POINT[key] || null;
}

const REFRESH_RATE_LIMIT = new Map();
function checkRefreshRateLimit(ip) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  const maxRequests = 10;
  const record = REFRESH_RATE_LIMIT.get(ip);
  if (!record || now > record.resetAt) {
    REFRESH_RATE_LIMIT.set(ip, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }
  if (record.count >= maxRequests) {
    return { ok: false, retryAfter: Math.ceil((record.resetAt - now) / 1000) };
  }
  record.count++;
  return { ok: true };
}

export default {
  async scheduled(event, env, ctx) {
    const point = cronToPoint(event.cron);
    if (!point) {
      console.error('[bidding-B] 无法识别 cron 表达式:', event.cron);
      return;
    }
    if (point === 't0925-seal') ctx.waitUntil(runSeal(env, 'cron'));
    else if (point === 't0926') ctx.waitUntil(runEmotion(env, 'cron'));
    else if (point === 'close') ctx.waitUntil(runClose(env, 'cron'));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'bidding-board-worker-b', worker: 'B' }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/fetch') {
      const token = url.searchParams.get('token') || '';
      if (!env.FETCH_TOKEN || token !== env.FETCH_TOKEN) {
        return new Response(JSON.stringify({ ok: false, error: 'token 无效' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      let point = url.searchParams.get('point') || 'auto';
      if (point === 'jiwang') point = 'close';
      if (point === 'auto') {
        point = autoPoint();
        if (!point) return new Response(JSON.stringify({ ok: false, error: '当前北京时间不在任何抓取时段' }), { headers: { 'Content-Type': 'application/json' } });
      }
      const validPoints = ['t0925-seal', 't0926', 'close'];
      if (!validPoints.includes(point)) {
        return new Response(JSON.stringify({ ok: false, error: 'point 必须是 t0925-seal|t0926|close|jiwang|auto' }), { headers: { 'Content-Type': 'application/json' } });
      }
      let result;
      if (point === 't0925-seal') result = await runSeal(env, 'http');
      else if (point === 't0926') result = await runEmotion(env, 'http');
      else if (point === 'close') result = await runClose(env, 'http');
      return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/refresh-emotion') {
      const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      const limit = checkRefreshRateLimit(clientIp);
      if (!limit.ok) {
        return new Response(JSON.stringify({ ok: false, error: '刷新太频繁，请 ' + limit.retryAfter + ' 秒后再试' }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': String(limit.retryAfter) }
        });
      }
      const result = await refreshEmotionPredictVol(env, 'http');
      return new Response(JSON.stringify(result, null, 2), {
        status: result.ok ? 200 : 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('bidding-board-worker-b', { status: 200 });
  },
};