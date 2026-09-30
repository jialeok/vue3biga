// numcat-api.js — 猫抓 numcat daily_auc + daily 接口
//
// ============================================================================
// [KEY-FALLBACK 2026-09-28] 主账号额度用尽 → **自动退回小号**，保证 9:25 早盘竞价数据不缺席
// ----------------------------------------------------------------------------
// 用户硬指标：每个交易日 **9:25~9:26 早盘竞价看板数据必须完整**（盘前下单要看它，
// 决策看板也依赖它）。而猫抓免费档**每天只有 10 次调用**，额度一旦被别人（前端抢跑 /
// 其他看板兜底 / 手动按钮）花光，worker 9:25 的 daily_auc 就会拿到
// `code=403 今日调用额度已用完` → 当天的 竞价量 / 昨成交量 / 竞价涨幅 整片为空、事后难补救。
//
// 因此构建【key 候选链】：NUMCAT_API_KEY（主账号）→ NUMCAT_API_KEY_YIZI（小号）。
//   · 只有「额度类错误」才换 key（403 / 429 / 额度用尽 / 限流）——
//     网络 / DNS / 超时这类错误换 key 也一样失败，只会白烧小号额度（§32 禁止无意义请求）。
//   · 小号没配置（Cloudflare Secret 未设）→ 候选链只剩主账号，行为与改造前完全一致（零风险）。
//   · 全部 key 都额度用尽 → 抛出的错误带 `quotaExhausted=true`，
//     调用方据此【立即停止重试】（重试同样拿不到，白等 25s 只会顶穿 9:26 硬指标）。
// ⚠️ 代价（刻意取舍）：退回小号会占用小号当天的额度（小号 = 竞价一字看板那把，10 次/天）。
//    但小号只在「主账号已废」时才被动用，而用户口径是早盘竞价优先级最高。
// ============================================================================
import { CONFIG } from '../config.js';

/** 上游「额度用尽 / 限流」判定（HTTP 或业务码 403、429，或文案里明确说额度/限流） */
export function isQuotaError(msg) {
  const s = String(msg || '');
  if (!s) return false;
  if (/code=403|code=429|HTTP 403|HTTP 429/.test(s)) return true;
  if (s.indexOf('额度') >= 0) return true;
  if (/RATE_LIMIT|rate limit/i.test(s)) return true;
  return false;
}

/** 上游 key 候选链（按优先级）。缺哪个跳哪个；两把都没配 → 空数组 */
export function configuredKeys(env) {
  const list = [];
  const main = String((env && env.NUMCAT_API_KEY) || '').trim();
  if (main) list.push({ name: 'NUMCAT_API_KEY', key: main });
  const small = String((env && env.NUMCAT_API_KEY_YIZI) || '').trim();
  if (small && small !== main) list.push({ name: 'NUMCAT_API_KEY_YIZI', key: small });
  return list;
}

/** 掩码回显（排查用）：只用于确认「到底用的哪把 key」，绝不回显全量 */
export function maskKey(k) {
  const s = String(k || '');
  return s.length <= 8 ? '***' : s.slice(0, 4) + '***' + s.slice(-4);
}

/** 单次上游请求（单把 key）。额度类失败抛出的错误带 quotaExhausted 标记 */
// [TIMEOUT 2026-09-30] 加硬超时：猫抓网络抖动时裸 fetch 会一直挂着，
//   而本调用位于 9:25 P0 关键路径上（P0-②），挂一次就把落库顶穿 9:26。
//   12s 对健康调用（实测 1~2s）绰绰有余；超时错误里带 timeout 关键字，
//   会让 morning-workflow 的「今天数据缺失」重试逻辑正常接管。
const NUMCAT_TIMEOUT_MS = 12000;
async function postOnce(url, key, apiname, fields, params) {
  const body = { apiname: apiname, apikey: key, fields: fields, params: params };
  const opts = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(NUMCAT_TIMEOUT_MS);
  }
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const e = new Error('numcat ' + apiname + ' HTTP ' + resp.status + ': ' + text.slice(0, 200));
    if (resp.status === 403 || resp.status === 429) e.quotaExhausted = true;
    throw e;
  }
  const json = await resp.json();
  if (json.code !== 200) {
    const e = new Error('numcat ' + apiname + ' 错误: ' + (json.message || JSON.stringify(json)) +
      '（上游 code=' + json.code + '）');
    e.upstreamCode = json.code;
    if (json.code === 403 || json.code === 429) e.quotaExhausted = true;
    throw e;
  }
  return json.data;
}

/**
 * 按候选链请求上游：额度类错误自动换下一把 key。
 * @param {object} env worker env（NUMCAT_API_KEY / NUMCAT_API_KEY_YIZI）
 * @param {object} opt { apiname, url, fields, params, logs }
 * @returns {Promise<{data:object, keyName:string}>}
 * @throws 最后一把 key 的错误；若最后一次失败是额度类，错误会带 quotaExhausted=true
 */
export async function postNumcat(env, opt) {
  const o = opt || {};
  const logs = Array.isArray(o.logs) ? o.logs : [];
  const keys = configuredKeys(env);
  if (keys.length === 0) {
    throw new Error('numcat ' + o.apiname + ' 未配置 key（请设置 Secret NUMCAT_API_KEY）');
  }
  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    try {
      const data = await postOnce(o.url, k.key, o.apiname, o.fields, o.params);
      if (i > 0) {
        logs.push('✅ numcat ' + o.apiname + ' 已退回【小号 ' + k.name + '（' + maskKey(k.key) + '）】取数成功');
      }
      return { data: data, keyName: k.name };
    } catch (e) {
      lastErr = e;
      logs.push('⚠️ numcat ' + o.apiname + ' key=' + k.name + '（' + maskKey(k.key) + '）失败: ' + e.message);
      const hasNext = i + 1 < keys.length;
      if (hasNext && e.quotaExhausted) {
        logs.push('→ 主账号额度用尽，退回下一把 key（' + keys[i + 1].name + '）继续取数');
        continue;
      }
      if (hasNext && !e.quotaExhausted) {
        logs.push('→ 非额度类错误，不换 key（换 key 同样失败，只会白烧小号额度 §32）');
      }
      break;
    }
  }
  throw lastErr;
}

/** 竞价数据（含当天）：竞价量 auc_vol / 竞价涨幅 auc_pct_chg / 反推昨成交量用的 auc_to_pre_vol_pct */
export async function numcatDailyAuc(env, symbols, startDateYMD, endDateYMD, logs) {
  // 【FIX 2026-08-03】改用显式 startdate/enddate（YYYYMMDD），不再用 recentdays
  const res = await postNumcat(env, {
    apiname: 'daily_auc',
    url: CONFIG.NUMCAT_DAILY_AUC_URL,
    fields: 'symbol,name,tradedate,auc_vol,auc_pct_chg,auc_to_pre_vol_pct,um_vol,open_bid_pct,auc_vol_ratio,auc_turnover',
    params: { symbols: symbols, startdate: startDateYMD, enddate: endDateYMD },
    logs: logs
  });
  return res.data;
}

/** 日线涨幅 pct_chg（10 日区间涨幅的历史腿） */
export async function numcatDaily(env, symbols, startDateYMD, endDateYMD, logs) {
  const res = await postNumcat(env, {
    apiname: 'daily',
    url: CONFIG.NUMCAT_DAILY_URL,
    fields: 'symbol,tradedate,pct_chg',
    params: { symbols: symbols, startdate: startDateYMD, enddate: endDateYMD },
    logs: logs
  });
  return res.data;
}
