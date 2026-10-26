// fetch-log.js — 自动抓取执行日志的读取入口（Data 层，唯一入口）
//
// 【为什么需要这个模块】
// 数据源（猫抓 / numcat）挂掉时，云端 `market_metrics` 当天就是 0 行，前端只能显示
// 「数据可能尚未抓取」—— 用户无法区分「我操作错了 / 网慢 / 后台挂了」，于是反复刷新，
// 越刷越慢，还以为是自己把数据刷没了（2026-10-26 真实事故：用户原话
// 「是不是早上我打开，发现没有加载成功然后一直刷新导致，一直刷新，把数据刷新没了？」）。
//
// Cloudflare worker 每次跑完都会往 `bidding_fetch_log` 写一条（含 ok / detail.logs），
// 里面直接写着失败原因（实测 2026-10-26：两把 key 都返回 403「今日调用额度已用完」）。
// ⇒ 读这张表，就能把真实原因如实告诉用户（§10：失败必须可见，且要说清是什么失败）。
//
// 【§6 单一真相】本模块只读 `bidding_fetch_log`，不缓存业务数据、不写任何表。
// 【§32 不重复请求】按日期内存缓存 + 单飞；读失败**不写缓存**（§10：读不到 ≠ 没有失败，
//   下次还能重试，⛔ 绝不把失败记忆成「没有失败」）。
import { getSupabase } from './supabase-client.js';
import { _dbgLog } from './debug-log.js';

/** worker 主任务（早盘竞价）的 job 名与执行时点 —— 与 workers/bidding-auto-fetch 写入值一致 */
export const FETCH_LOG_TABLE = 'bidding_fetch_log';
export const MORNING_JOB = 'bidding-auto-fetch';
export const MORNING_POINT = 'morning';

/** 同一日期多久内不重复查（早盘一天只会有一条 morning 记录；60s 足够，且避免反复刷新时狂查） */
const CACHE_MS = 60 * 1000;

const _cache = new Map();      // date -> { at, rows }
const _inflight = new Map();   // date -> Promise

/**
 * 读某日「早盘竞价」那次抓取的日志（最多 1 条，最新一条）。
 *
 * @param {string} date YYYY-MM-DD
 * @returns {Promise<Array<object>>} 空数组 = 确实没有任何记录（§10：这是"没跑"，不是"读失败"）
 * @throws 读失败时抛错（调用方据此区分「没跑」与「读不到」）
 */
export async function fetchMorningFetchLog(date) {
  if (!date) return [];
  const hit = _cache.get(date);
  if (hit && (Date.now() - hit.at) < CACHE_MS) return hit.rows;
  const fly = _inflight.get(date);
  if (fly) return fly;

  const p = (async function() {
    try {
      const sb = getSupabase();
      if (!sb) throw new Error('Supabase 客户端未就绪');
      const { data, error } = await sb
        .from(FETCH_LOG_TABLE)
        .select('run_date,time_point,job,ok,detail,created_at')
        .eq('run_date', date)
        .eq('job', MORNING_JOB)
        .eq('time_point', MORNING_POINT)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const rows = data || [];
      _cache.set(date, { at: Date.now(), rows });
      return rows;
    } catch (e) {
      // §10：读失败不写缓存、不返回 []，向上抛
      _dbgLog('[FETCH-LOG] 读取 ' + FETCH_LOG_TABLE + ' 失败（date=' + date + '）: ' + (e && e.message || e));
      throw e;
    } finally {
      _inflight.delete(date);
    }
  })();
  _inflight.set(date, p);
  return p;
}

/** 仅供测试 / 诊断：清空缓存（正常业务流程不需要调用） */
export function _resetFetchLogMemo() {
  _cache.clear();
  _inflight.clear();
}
