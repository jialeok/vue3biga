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
//
// ★★ [JIWANG-MON-2026-11-23] 「每到周一三个字段全空」事故 —— 两个独立缺陷
//
//   【缺陷一 · 时点】16:00 那次 jiwang 排在当日所有猫抓调用【最后】。
//     bidding_fetch_log 逐日取证（time_point=jiwang，全部 ok=false，连 11-16~11-20 五天无一例外）：
//       ❌ 猫抓 emoindic_daily 失败（本次一行不写）: 今日调用额度已用完，请于北京时间次日零点后重试
//     ⇒ 猫抓 10 次/天，9:25 morning、yizi-0925、yizi-trend、close 的 daily 早就用光，
//       16:00 再要 emoindic 必然拿不到 ⇒ 「明天的行」写不进去 ⇒ 周一打开看到的「上周五」
//       永远是空。真正的兜底（supabase-heal 的 08:50 那轮）又被 GitHub Actions 的
//       schedule 延迟 6~8 小时（实测 00:50Z 的 cron 实际跑在 07:22~08:35Z = 北京 15:22~16:35），
//       落到的仍是「额度已用尽」的时段 ⇒ 兜底形同不存在。
//     ✅ 修法：① 接上 `postNumcat` 的主 key → 小号 fallback（本模块原来只读一把 key，
//        主账号用尽就直接放弃，而其它模块早就自动退小号了）；
//        ② 9:25 morning 轮也跑一次（额度刚在北京 0 点重置，是全天最富裕的时点，
//        见 index.js 的 JIWANG-MORNING-SLOT）。9:25 跑时窗口最后一天=昨天 ⇒ 写的正是
//        「今天这一行的昨收盘结果」，也就是周一早上要看的那一格。
//
//   【缺陷二 · 逻辑】盘中跑会把「今天的盘中快照」当成收盘值写进【明天】那一行。
//     实证（2026-11-23 11:29 手动触发）：窗口 11-10~11-23，猫抓对 11-23 已经返回
//     s2/s6=1717/3763（盘中实时家数，不是收盘值），alignWindowTargets 把它当
//     「11-23 的收盘结果」写进了 `jiwang_data[2026-11-24].shouguJieguo=3763:1717`。
//     而本模块「只填空、不覆盖」⇒ 这个错值会被永久固化，明天 16:00 也改不回来。
//     ✅ 修法：`pickWindowRows` —— 同一交易日在 15:05 之前一律视为【未收盘】，
//        整行剔除，既不当值写出去，也不参与「下一交易日」推演。
//        ⇒ 盘中只可能写「今天」那一行（值来自昨天，已收盘，安全）；
//           收盘后才会写「明天」那一行（值来自今天，已收盘）。

import { CONFIG } from '../config.js';
import { beijingNow, beijingToday, normalizeDate } from '../../_shared-source/date-utils.js';
import { isTradingDay } from './holiday-check.js';
import { sbHeaders } from '../data/supabase-write.js';
// ★ [JIWANG-MON-2026-11-23] 走统一客户端：主 key 额度用尽自动退小号 + 瞬态失败同 key 重试。
//   ⛔ 原来自己拼 POST 只读一把 key，主账号一用尽就整轮放弃（缺陷一见文件头）。
import { postNumcat } from '../data/numcat-api.js';

const NUMCAT_EMOINDIC_URL = 'https://numcat.net/api/reference-proxy/market/emoindic-daily';
const NUMCAT_APINAME = 'emoindic_daily';
const JW_RECENT_DAYS = 10;
const JW_SB_TIMEOUT_MS = 12000;
const ROW_COLUMN = 'shouguJieguo';
/**
 * 「当日已收盘」的判定线（北京）。
 * 15:05 早于收盘集合竞价结束 + 数据商给值所需的最短延迟；宁可晚写 5 分钟，
 * 也不能把一个 10:30 的盘中家数当成收盘结果永久固化。
 */
export const JW_CLOSE_HHMM = '15:05';

/** 北京 HH:MM（补零，可直接按字符串比较） */
export function beijingHHMM() {
  const d = beijingNow();
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

function jiwangFetch(url, opts, ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return fetch(url, Object.assign({}, opts || {}, { signal: AbortSignal.timeout(ms) }));
  }
  return fetch(url, opts || {});
}

/** 猫抓 10 日情绪窗口 → [{ date, up, down }]（升序）。字段缺失绝不折 0。 */
export function parseEmoindicRows(payload) {
  // 兼容两种入参形态：
  //   ① 上游原始 json `{ code, data: { fields, items } }`（旧调用方式 / 测试夹具）
  //   ② `postNumcat` 已剥掉外壳直接返回 `{ fields, items }`
  // ⛔ 不要只认 ①，否则接了统一客户端之后会静默解析出 0 行（契约型故障，零报错）。
  const data = (payload && payload.data) ? payload.data : payload;
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
 * ★ [JIWANG-MON-2026-11-23] 剔除「未收盘的今天」这一行。
 *
 * 为什么必须剔除：猫抓 emoindic_daily 对【当天】返回的是**盘中实时家数**，
 *   而本模块语义是「某交易日的收盘跌涨家数」。盘中拿到它并当成收盘值写进下一交易日，
 *   就会把 11:29 的快照固化成「昨收盘结果」（实测事故，见文件头缺陷二）。
 *
 * 判据只有一条：`date === today && hhmm < 15:05` ⇒ 未收盘。
 *   收盘后（>= 15:05）保留，此时写的是「明天」那一行，值是今天收盘的真值。
 *   窗口里没有今天（比如早上猫抓还没给今天）⇒ 原样返回，最后一天是昨天，依然安全。
 *
 * @param {Array<{date:string,up:number,down:number}>} rows 升序窗口
 * @param {string} today 北京今天 YYYY-MM-DD
 * @param {string} hhmm 北京 HH:MM
 * @returns {Array} 可安全当作「收盘值来源」的行
 */
export function pickWindowRows(rows, today, hhmm) {
  if (!Array.isArray(rows)) return [];
  if (!today || !hhmm || hhmm >= JW_CLOSE_HHMM) return rows;
  return rows.filter(function (r) { return r && r.date !== today; });
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

async function fetchEmoindicWindow(env, logs) {
  // ★ [JIWANG-MON-2026-11-23] 改走 postNumcat：主 key 额度用尽 → 自动退小号；
  //   瞬态超时 → 同 key 重试一次。原来这里只读一把 key，主账号一耗尽就整轮放弃，
  //   这正是 11-16~11-20 连续五天 ok=false 的直接原因。
  const r = await postNumcat(env, {
    apiname: NUMCAT_APINAME,
    url: NUMCAT_EMOINDIC_URL,
    params: { recentdays: JW_RECENT_DAYS },
    logs: logs
  });
  // postNumcat 返回的是已剥壳的 data（{fields,items}），parseEmoindicRows 两种形态都认。
  return { code: 200, data: r.data, keyName: r.keyName };
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

/**
 * @param {object} env worker env
 * @param {object} [opts]
 * @param {boolean} [opts.skipIfTodayFilled] true ⇒ 先花 1 次【Supabase 读】（0 猫抓额度）看
 *   今天这一行是不是已经有 shouguJieguo，有就直接返回、不碰猫抓。
 *   仅供 9:27 兜底轮使用：它唯一目标就是「今天这行」，正常日早被前一天 16:00 写好了
 *   ⇒ 0 次猫抓请求，不白烧额度（§32）。⛔ 16:00 那轮绝不能开这个开关：
 *   它要写的是【明天】那一行，今天有值不代表明天有值。
 */
export async function runJiwangCloseWrite(env, opts) {
  const o = opts || {};
  const logs = [];
  const today = beijingToday();
  const hhmm = beijingHHMM();

  // ★ [JIWANG-MON-SLOT 2026-11-23] 「今天已有值 ⇒ 0 次猫抓」的廉价前置判断。
  //   读失败不能当成「已有值」跳过（§10）：读失败就照常往下走，让猫抓兜底去判断。
  if (o.skipIfTodayFilled) {
    try {
      const pre = await readExistingJiwang(env, [today]);
      const cur = pre.find(function (r) { return r && r.date === today; });
      const v = cur && cur[ROW_COLUMN];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        logs.push('✅ 今天(' + today + ')已有昨收盘结果 ' + String(v) + ' ⇒ 0 次猫抓请求（§32）');
        return { ok: true, written: 0, skipped: 'today-filled', logs, targets: [], today };
      }
      logs.push('今天(' + today + ')还没有昨收盘结果 ⇒ 需要向猫抓取一次（额度刚重置，9:27 最充裕）');
    } catch (e) {
      logs.push('⚠️ 前置查询失败（不当成已有值，继续兜底）: ' + (e && e.message));
    }
  }

  let payload;
  try {
    payload = await fetchEmoindicWindow(env, logs);
  } catch (e) {
    logs.push('❌ 猫抓 emoindic_daily 失败（本次一行不写）: ' + (e && e.message));
    return { ok: false, written: 0, logs, targets: [] };
  }
  const rawRows = parseEmoindicRows(payload);
  logs.push('猫抓窗口 ' + rawRows.length + ' 个交易日: ' + (rawRows.length ? rawRows[0].date + ' ~ ' + rawRows[rawRows.length - 1].date : '空'));
  if (rawRows.length < 2) {
    logs.push('❌ 窗口不足 2 天或 s2/s6 全缺 ⇒ 一行不写（读取失败不造 0）');
    return { ok: false, written: 0, logs, targets: [] };
  }

  // ★ [JIWANG-MON-2026-11-23] 盘中（< 15:05）的「今天」是实时快照，不是收盘值 ⇒ 整行剔除。
  const rows = pickWindowRows(rawRows, today, hhmm);
  if (rows.length !== rawRows.length) {
    logs.push('⏱ 北京 ' + hhmm + ' 未到收盘判定线 ' + JW_CLOSE_HHMM +
      ' ⇒ 剔除今天(' + today + ')的盘中家数，只写已收盘交易日（不把盘中值当收盘结果）');
  }
  if (rows.length < 1) {
    logs.push('❌ 剔除盘中行后无可用交易日 ⇒ 一行不写');
    return { ok: false, written: 0, logs, targets: [] };
  }

  let lastNext = '';
  try {
    lastNext = await nextTradingDayAfter(env, rows[rows.length - 1].date);
    logs.push('窗口最后一天 ' + rows[rows.length - 1].date + ' 的下一交易日 = ' + (lastNext || '未算出') +
      '（北京 ' + hhmm + '，收盘线 ' + JW_CLOSE_HHMM + '）');
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
