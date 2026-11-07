// jiwang-close-write.js — 记忘看板「昨收盘结果(跌:涨)」纯云端落库 + 历史无损回补
//
// [JIWANG-SHOUGU-CLOUD 2026-11-08] 事故与根因
//   用户报障：2026-11-06 记忘看板「昨日跌涨 / 昨收盘结果 / 昨日情绪」三个一起不显示。
//   生产取证：
//     · JiwangBoard.vue:55「昨收盘结果」= display.shouguJieguo；
//       :16 / :27「昨日跌涨 / 昨日情绪」= deriveFromShougu(d.shouguJieguo)
//       ⇒ 三个字段【同源】于当天 jiwang_data[date].shouguJieguo。
//     · jiwang_data 有 10-28~11-05 和 11-09，**没有 2026-11-06 这一行** ⇒ 三个全空。
//     · 唯一云端写入源是 workers/bidding-board-worker-b/logic/jiwang-workflow.js#runJiwang
//       → updateJiwangShouguJieguo(env, nextTradingDay, stats)。
//       emotion_data['2026-11-05'] 只有 09:40 早盘记录、没有 16:00 收盘记录
//       ⇒ 11-05 16:00 那轮收盘主流程没跑 ⇒ 没写 11-06 行。
//       （11-06 16:00 那轮跑了：emotion_data['11-06'] 与 jiwang_data['11-09'] 同为 08:00:35Z。）
//     · 该 worker 在本 Cloudflare 账号下查不到（账号 workers 只有 bidding-auto-fetch），
//       且它的 writeLog 带 `worker:'B'`，而 bidding_fetch_log 没有 worker 列 ⇒ 日志 400 被吞，
//       「跑没跑」在库里完全不可观测。
//
// 【本模块做什么】挂到 16:00 close 轮（确定在跑 + CI 自动部署 + 线上复核）：
//   ① 调一次猫抓 emoindic_daily（recentdays=10）拿 10 个交易日的 s2(涨家数)/s6(跌家数)；
//   ② 对每个交易日 d，写 jiwang_data[nextTradingDay(d)].shouguJieguo = 跌:涨；
//   ③ 因为拿到的是【窗口】而不是单日，所以同时把过去 10 天所有缺口一次性无损回补
//      （11-05 的 next 就是 11-06 ⇒ 本次事故的那一行会被自动补回来，不需要猜值）。
//
// 【硬红线】
//   ⛔ 只填空：已有非空 shouguJieguo 一律不覆盖（用户手工修正优先，§11）。
//   ⛔ 读取失败 ≠ 空数据：接口失败/字段缺失 ⇒ 一行不写，日志必须可见（§10）。
//   ⛔ 失败不连坐：任何异常只记日志、返回 ok:false，不影响 runClose 主流程。
//   ⛔ 不造数：s2/s6 必须是有效正数；绝不用 market_metrics / 竞价涨幅 / 前一交易日值冒充。
//   ⛔ 交易日映射不靠猜：窗口内相邻两个交易日天然互为 next（0 请求，自动含节假日）；
//      只有窗口最后一天才用 isTradingDay 逐日推下一个交易日。

import { CONFIG } from '../config.js';
import { beijingToday, normalizeDate } from '../../_shared-source/date-utils.js';
import { isTradingDay } from './holiday-check.js';
import { sbHeaders } from '../data/supabase-write.js';

const NUMCAT_EMOINDIC_URL = 'https://numcat.net/api/reference-proxy/market/emoindic-daily';
const NUMCAT_APINAME = 'emoindic_daily';
const JW_RECENT_DAYS = 10;
const JW_HTTP_TIMEOUT_MS = 15000;
const JW_SB_TIMEOUT_MS = 12000;
const ROW_COLUMN = 'shouguJieguo';

function jiwangFetch(url, opts, ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, Object.assign({}, opts || {}, { signal: AbortSignal.timeout(ms) }));
  }
  return fetch(url, opts || {});
}

/** 猫抓 10 日情绪窗口 → [{ date, up, down }]（升序）。字段缺失绝不折 0。 */
export function parseEmoindicRows(payload) {
  const data = payload && payload.data;
  const fields = data && data.fields;
  const items = data && data.items;
  if (!Array.isArray(fields) || !Array.isArray(items)) return [];
  const dateIdx = fields.indexOf('tradedate');
  const upIdx = fields.indexOf('s2');
  const downIdx = fields.indexOf('s6');
  if (dateIdx < 0 || upIdx < 0 || downIdx < 0) return [];
  const out = [];
  items.forEach(function (it) {
    if (!Array.isArray(it)) return;
    const date = normalizeDate(it[dateIdx]);
    const up = Number(it[upIdx]);
    const down = Number(it[downIdx]);
    if (!date || !isFinite(up) || !isFinite(down) || up <= 0 || down <= 0) return;
    out.push({ date: date, up: up, down: down });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
  return out;
}

/**
 * 窗口给出「收盘日 → 下一交易日」的真实映射：
 *   · 相邻两项互为 next（0 请求，天然含周末/节假日）；
 *   · 最后一项的 next 不在窗口内 ⇒ 交给调用方用交易日历补。
 */
export function alignWindowTargets(rows, lastNext) {
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const target = i + 1 < rows.length ? rows[i + 1].date : (lastNext || '');
    if (!target) continue;
    out.push({ from: rows[i].date, date: target, value: rows[i].down + ':' + rows[i].up });
  }
  return out;
}

/** 纯函数：只保留「库里该日期还没有 shouguJieguo」的目标（§11 幂等填空） */
export function buildJiwangShouguWriteRows(targets, existingRows, nowIso) {
  const filled = {};
  (existingRows || []).forEach(function (r) {
    const d = String((r && r.date) || '').trim();
    const v = r && r[ROW_COLUMN];
    if (d && v !== null && v !== undefined && String(v).trim() !== '') filled[d] = true;
  });
  const seen = {};
  const rows = [];
  (targets || []).forEach(function (t) {
    if (!t || !t.date || !t.value || filled[t.date] || seen[t.date]) return;
    seen[t.date] = true;
    const row = { date: t.date, updated_at: nowIso || new Date().toISOString() };
    row[ROW_COLUMN] = t.value;
    rows.push(row);
  });
  return rows;
}

async function fetchEmoindicWindow(env) {
  const key = env.NUMCAT_API_KEY || env.NUMCAT_API_KEY_YIZI || '';
  if (!key) throw new Error('缺少 NUMCAT_API_KEY / NUMCAT_API_KEY_YIZI，无法取收盘跌涨家数');
  const resp = await jiwangFetch(NUMCAT_EMOINDIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiname: NUMCAT_APINAME, apikey: key, params: { recentdays: JW_RECENT_DAYS } })
  }, JW_HTTP_TIMEOUT_MS);
  if (!resp.ok) throw new Error('猫抓 emoindic_daily HTTP ' + resp.status);
  const json = await resp.json();
  if (json && json.code !== 200) throw new Error('猫抓 emoindic_daily 错误: ' + (json.message || 'code=' + json.code));
  return json;
}

async function readExistingJiwang(env, dates) {
  if (!dates.length) return [];
  const url = CONFIG.SUPABASE_URL + '/rest/v1/jiwang_data?select=date,' + ROW_COLUMN +
    '&date=in.(' + dates.map(encodeURIComponent).join(',') + ')';
  const resp = await jiwangFetch(url, { headers: sbHeaders(env) }, JW_SB_TIMEOUT_MS);
  if (!resp.ok) throw new Error('读取 jiwang_data 失败: HTTP ' + resp.status);
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

/** 窗口最后一天的下一交易日（只用真实交易日历，不猜） */
async function nextTradingDayAfter(env, dateStr, maxDays) {
  let ms = Date.parse(dateStr + 'T00:00:00Z');
  if (!isFinite(ms)) return '';
  for (let i = 1; i <= (maxDays || 10); i++) {
    ms += 24 * 3600 * 1000;
    const d = new Date(ms).toISOString().slice(0, 10);
    if (await isTradingDay(env, d)) return d;
  }
  return '';
}

export async function runJiwangCloseWrite(env) {
  const logs = [];
  const today = beijingToday();

  let payload;
  try {
    payload = await fetchEmoindicWindow(env);
  } catch (e) {
    logs.push('❌ 猫抓 emoindic_daily 失败（本次一行不写）: ' + (e && e.message));
    return { ok: false, written: 0, logs, targets: [] };
  }
  const rows = parseEmoindicRows(payload);
  logs.push('猫抓窗口 ' + rows.length + ' 个交易日: ' + (rows.length ? rows[0].date + ' ~ ' + rows[rows.length - 1].date : '空'));
  if (rows.length < 2) {
    logs.push('❌ 窗口不足 2 天或 s2/s6 全缺 ⇒ 一行不写（读取失败不造 0）');
    return { ok: false, written: 0, logs, targets: [] };
  }

  let lastNext = '';
  try {
    lastNext = await nextTradingDayAfter(env, rows[rows.length - 1].date);
    logs.push('窗口最后一天 ' + rows[rows.length - 1].date + ' 的下一交易日 = ' + (lastNext || '未算出'));
  } catch (e) {
    logs.push('⚠️ 下一交易日推算失败（最后一天不写，其余照常回补）: ' + (e && e.message));
  }

  const targets = alignWindowTargets(rows, lastNext);
  logs.push('候选目标 ' + targets.length + ' 个: ' + targets.map(t => t.date + '=' + t.value).join(' / '));

  let existing;
  try {
    existing = await readExistingJiwang(env, targets.map(t => t.date));
  } catch (e) {
    logs.push('❌ 读取 jiwang_data 失败（本次一行不写）: ' + (e && e.message));
    return { ok: false, written: 0, logs, targets };
  }

  const writeRows = buildJiwangShouguWriteRows(targets, existing, new Date().toISOString());
  if (!writeRows.length) {
    logs.push('✅ 目标日期均已有昨收盘结果 ⇒ 幂等跳过，不覆盖');
    return { ok: true, written: 0, logs, targets, today };
  }
  logs.push('待写 ' + writeRows.length + ' 行: ' + writeRows.map(r => r.date + '=' + r[ROW_COLUMN]).join(' / '));

  try {
    const url = CONFIG.SUPABASE_URL + '/rest/v1/jiwang_data?on_conflict=date';
    const resp = await jiwangFetch(url, {
      method: 'POST',
      headers: Object.assign(sbHeaders(env), { 'Prefer': 'resolution=merge-duplicates' }),
      body: JSON.stringify(writeRows)
    }, JW_SB_TIMEOUT_MS);
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' ' + text.slice(0, 240));
    }
    logs.push('✅ 云端已写 jiwang_data.shouguJieguo ' + writeRows.length + ' 行（含历史缺口回补）');
    return { ok: true, written: writeRows.length, logs, targets, rows: writeRows, today };
  } catch (e) {
    logs.push('❌ 写 jiwang_data 失败: ' + (e && e.message));
    return { ok: false, written: 0, logs, targets, rows: writeRows };
  }
}
