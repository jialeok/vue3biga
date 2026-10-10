// tick-minute-store.js — 「分笔买卖」看板的取数编排与状态（Logic 层，§15 独立业务模块）
//
// 职责（与 logic/decision/dragon-rank-change-store.js 同一分工）：
//   ① 把 tick_minute_open 读进一份响应式状态（date / map），供看板 computed 追踪；
//   ② 决定【什么时候去抓】（§34）：本文件负责时机，取数本身在 data/tick-minute.js；
//   ③ 单飞 / 冷却 / 次数上限 / 9:31 闸门 —— 保证挂在高频事件上也不会把上游打爆（§32/§36）。
//
// ⛔ 本文件【不实现任何业务判断】：
//   红/绿/平怎么算、第一笔拿什么当基准、快照数怎么展示 —— 全在 logic/tick/tick-minute.js（§6 单一实现）。
//   本文件只搬数据 + 管时机。
//
// §8：分笔是云端业务数据，⛔ 禁止用 localStorage 兜底；这里的状态全是【内存】，
//      刷新页面重新从云端读（本来就该如此：表是唯一的真相源）。
// §10：读取失败必须【可见】—— 错误原文进 tickMinuteError，由看板红字展示，⛔ 不静默成空看板。

import { ref } from 'vue';
import { readTickMinuteForDate, requestTickMinuteFromEdge, TICK_MINUTE_META } from '../../data/tick-minute.js';
import { _dbgLog } from '../../data/debug-log.js';
import { tickWindowState, TICK_WINDOW_READY } from './tick-minute.js';

/**
 * 排障自检地址（Edge Function 的 /probe：从 Edge 机房实测上游专线）。
 * 只暴露 URL，⛔ 不含任何密钥 —— 它本来就是「浏览器直接打开也能看」的只读体检页。
 * 放在 Logic 层转发，是为了让视图层不必 import data/*（§2 UI → Logic → Data）。
 */
export const TICK_PROBE_URL = TICK_MINUTE_META.probeUrl;

// ══════════════════════════════════════════════════════════════════════════════
// 响应式状态（模块级单例：与 dragonRankChangeState / chartJudgeState 同一范式）
// ══════════════════════════════════════════════════════════════════════════════

/** 当前已读进内存的是哪一天（'' = 还没读到） */
export const tickMinuteDate = ref('');
/** 该日的行：Map<股票名, tick 行>（⚠️ 换【引用】而不是原地改，只做 shallow 依赖 §20） */
export const tickMinuteMap = ref(new Map());
/** 本会话「已经抓过」的股票：Map<date, Set<name>>（用来区分「未抓取」和「无数据」，§10） */
export const tickMinuteAttempted = ref(new Map());
/** 本会话「抓不了」的原因：Map<`date|name`, string>（如「缺代码」）—— 让原因是可见的，⛔ 不静默丢 */
export const tickMinuteSkipMap = ref(new Map());
/** 最后失败原文（看板红字；§10 失败必须可见） */
export const tickMinuteError = ref('');
/** 读库 / 抓取进行中（仅用于展示，⛔ 不挡渲染 §17） */
export const tickMinuteLoading = ref(false);
/** 该日数据最近一次落库时间（头部摘要用） */
export const tickMinuteUpdatedAt = ref('');
/** 该日最近一次成功抓取的说明文案（如「已抓 6 只 / 上游无 1 只」） */
export const tickMinuteFetchNote = ref('');

// ══════════════════════════════════════════════════════════════════════════════
// 内部闸门（§32 相同数据不得重复请求 / §36 性能红线）
// ══════════════════════════════════════════════════════════════════════════════

/** 本会话已从云端读过的日期（避免每次 auction-refresh 都去读一遍库） */
const _loadedDates = new Set();
/** 单飞：一次只允许一个抓取在跑（换日期时旧的那个照常跑完，结果写进对应 date） */
let _inflight = null;
/** 同一日内两次抓取的最小间隔（上游 3 次/秒，这里留足；也防事件风暴） */
const MIN_INTERVAL_MS = 20000;
/** 同一日最多抓几次（防「上游一直失败 → 每 20 秒打一次」把额度慢慢烧掉） */
const MAX_ATTEMPTS_PER_DATE = 5;
const _lastAttemptAt = new Map();   // date → ms
const _attemptCount = new Map();    // date → n
/** 9:31 闸门未开时的定时重试 */
let _retryTimer = null;
let _retryDate = '';

function _attemptedFor(date) {
  const m = tickMinuteAttempted.value;
  if (!m.has(date)) {
    const next = new Map(m);
    next.set(date, new Set());
    tickMinuteAttempted.value = next;   // 换引用 → 驱动重算
  }
  return tickMinuteAttempted.value.get(date);
}

function _markAttempted(date, names) {
  const m = tickMinuteAttempted.value;
  const cur = m.get(date) || new Set();
  const next = new Set(cur);
  let changed = false;
  (names || []).forEach(function(n) {
    if (n && !next.has(n)) { next.add(n); changed = true; }
  });
  if (!changed) return;
  const nm = new Map(m);
  nm.set(date, next);
  tickMinuteAttempted.value = nm;
}

function _markSkipped(date, name, reason) {
  if (!date || !name) return;
  const m = tickMinuteSkipMap.value;
  const nm = new Map(m);
  nm.set(date + '|' + name, String(reason || '抓不了'));
  tickMinuteSkipMap.value = nm;
}

// ══════════════════════════════════════════════════════════════════════════════
// ① 读库（唯一入口）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 把某日的分笔读进内存。
 * @param {string} date YYYY-MM-DD
 * @param {boolean} [force] true = 无视「本会话已读过」的短路（抓取成功后回读用）
 * @returns {Promise<void>} 永不 reject（失败写进 tickMinuteError，§10 可见但不打断渲染）
 */
export async function loadTickMinute(date, force) {
  const d = String(date || '').trim();
  if (!d) {
    tickMinuteDate.value = '';
    tickMinuteMap.value = new Map();
    return;
  }
  if (!force && _loadedDates.has(d) && tickMinuteDate.value === d) return;

  tickMinuteLoading.value = true;
  try {
    const rows = await readTickMinuteForDate(d);
    const m = new Map();
    rows.forEach(function(r) { if (r && r.name) m.set(r.name, r); });
    tickMinuteDate.value = d;
    tickMinuteMap.value = m;              // 换引用 → 看板 computed 自动重算（§17 不阻塞渲染）
    tickMinuteUpdatedAt.value = rows.length > 0 ? (rows[0].updatedAt || '') : '';
    tickMinuteError.value = '';
    _loadedDates.add(d);
    _dbgLog('[TICK-MINUTE] 读回 ' + d + '：' + m.size + ' 只');
  } catch (e) {
    tickMinuteDate.value = d;
    tickMinuteMap.value = new Map();
    tickMinuteUpdatedAt.value = '';
    // §10：读取失败必须可见（例如表还没建 —— 报错原文里已经带了「去执行 db/create_tick_minute_open.sql」）
    tickMinuteError.value = (e && e.message) ? e.message : String(e);
    console.error('[TICK-MINUTE] 读取失败', e);
  } finally {
    tickMinuteLoading.value = false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ② 抓取（决定时机 + 闸门；取数在 Data 层）
// ══════════════════════════════════════════════════════════════════════════════

/** 9:31 闸门未开时，安排一次到点重试（today 才可能；历史日 tickWindowState 直接放行） */
function _scheduleRetry(date, targets, retryAtHms) {
  if (!retryAtHms || _retryTimer) return;
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(retryAtHms);
  if (!m) return;
  const now = new Date();
  const target = new Date(now.getTime());
  target.setHours(Number(m[1]), Number(m[2]), Number(m[3]) + 5, 0);   // +5 秒余量（给上游一点时间）
  let wait = target.getTime() - now.getTime();
  if (!isFinite(wait) || wait < 0) wait = 0;
  wait = Math.min(wait, 10 * 60 * 1000);                              // 最多等 10 分钟（防挂死）
  _retryDate = date;
  _retryTimer = setTimeout(function() {
    _retryTimer = null;
    const d = _retryDate;
    _retryDate = '';
    loadTickMinute(d, true).then(function() { ensureTickMinute(d, targets); });
  }, wait);
  _dbgLog('[TICK-MINUTE] 9:31 闸门未开，' + Math.round(wait / 1000) + 's 后自动重试 ' + date);
}

/** 清理定时重试（看板卸载 / 换日期时调用，§31 成对清理） */
export function stopTickMinuteRetry() {
  if (_retryTimer) {
    clearTimeout(_retryTimer);
    _retryTimer = null;
  }
  _retryDate = '';
}

/**
 * Edge 返回结果 → 落到状态里（唯一实现，两条调用路径共用）。
 * §10：上游「确实没有」与「我们没抓到」必须分开 —— 前者标 attempted（显示「无数据」），
 *      后者【不标】（还能再试，且把原因写进红字）。
 */
function _handleResult(date, res, requested) {
  if (!res || typeof res !== 'object') return;
  const names = (requested || []).map(function(t) { return t.name; });

  // 拿不到代码的：如实标出来（⛔ 不混进「无数据」）
  (res.missing || []).forEach(function(m) {
    if (!m || !m.name) return;
    _markSkipped(date, m.name, m.reason || '缺代码');
  });
  const missingNames = (res.missing || []).map(function(m) { return m && m.name; }).filter(Boolean);

  if (res.ok === true) {
    // 抓取成功：请求过的（含上游没给的、缺代码的）都算「已抓过」
    // ⚠️ 例外：因【后端上游预算用完】而没取到的（res.uncovered）【不算已抓过】——
    //    否则它们会躺成「无数据」，而事实是「我们没抓到」（§10 未就绪 ≠ 没有）。
    const uncovered = (res.uncovered || []).map(function(n) { return String(n); });
    const doneNames = names.filter(function(n) { return uncovered.indexOf(n) < 0; });
    _markAttempted(date, doneNames.concat(missingNames));
    const withData = (res.results || []).filter(function(r) { return r && r.hasData; }).length;
    const noData = (res.results || []).length - withData;
    tickMinuteFetchNote.value = '已抓 ' + withData + ' 只' + (noData > 0 ? '，上游无 ' + noData + ' 只' : '')
      + (missingNames.length > 0 ? '，缺代码 ' + missingNames.length + ' 只' : '');
    if (uncovered.length > 0) {
      // 拿不到就说拿不到（§10）：写进红字并提示可重试，⛔ 不静默
      tickMinuteError.value = '上游超时：有 ' + uncovered.length + ' 只（' + uncovered.slice(0, 8).join('、')
        + (uncovered.length > 8 ? ' 等' : '') + '）在预算内没取到，已按【未抓取】显示。'
        + '隔 1~2 分钟点【重试】即可；连续失败请看 /probe。';
    } else {
      tickMinuteError.value = '';
    }
    return;
  }

  if (res.skipped === 'no-rows' || res.skipped === 'no-targets') {
    // 上游【确实】没有这批票这一分钟的数据 ⇒ 标已抓过（⛔ 不再反复重试），逐行显示「无数据」
    _markAttempted(date, names.concat(missingNames));
    tickMinuteFetchNote.value = (res.hint || '上游这一分钟没有这批股票的数据');
    tickMinuteError.value = '';
    return;
  }

  if (res.skipped === 'too-early') {
    // 还没到 9:31 —— 不算「抓过」，到点由 _scheduleRetry 重试（§10 未就绪 ≠ 没有）
    tickMinuteFetchNote.value = '等 ' + TICK_WINDOW_READY + ' 之后自动抓取';
    return;
  }

  if (res.skipped === 'upstream-empty') {
    // 上游一个端点都没通 ⇒ 这是链路问题（key / 端口 / 权限 / 限流），⛔ 不标已抓过，允许重试
    tickMinuteError.value = (res.hint || res.error || '上游这一分钟没有返回任何数据')
      + '　自检：' + TICK_PROBE_URL;
    return;
  }

  // 其它失败（未配 key / 上游业务码错误 …）：红字如实展示，⛔ 不标已抓过
  tickMinuteError.value = (res.hint || res.error || ('抓取失败：' + JSON.stringify(res).slice(0, 200)))
    + '　自检：' + TICK_PROBE_URL;
}

/**
 * 「需要就去抓一只不落」——本看板唯一的自动抓取入口。
 *
 * 什么时候真的会发上游请求（全部满足才发）：
 *   ① date 的库已经读进内存（tickMinuteDate === date）—— 否则等 loadTickMinute 完再来；
 *   ② 点名的票里，还有「库里没有 + 本次会话没抓过」的；
 *   ③ tickWindowState(date).can（今天必须过了北京 09:31；历史日随时可以）；
 *   ④ 距上次抓取 ≥ 20s，且该日抓取次数 < 5。
 *
 * @param {string} date YYYY-MM-DD
 * @param {Array<{name:string,code:string}>} targets 本日要抓的股票（= 决策看板选中的买点 + 卖点）
 * @returns {Promise<void>} 永不 reject
 */
export function ensureTickMinute(date, targets) {
  const d = String(date || '').trim();
  const list = (targets || []).filter(function(t) { return t && t.name; });
  if (!d || list.length === 0) return Promise.resolve();
  if (_inflight) return _inflight;                     // 单飞
  if (tickMinuteDate.value !== d) return Promise.resolve();  // 库还没切到这一天

  const have = tickMinuteMap.value;
  const attempted = _attemptedFor(d);
  const missing = list.filter(function(t) { return !have.has(t.name) && !attempted.has(t.name); });
  if (missing.length === 0) return Promise.resolve();

  const win = tickWindowState(d);
  if (!win.can) {
    _scheduleRetry(d, list, win.retryAtHms);
    return Promise.resolve();
  }

  const now = Date.now();
  if (now - (_lastAttemptAt.get(d) || 0) < MIN_INTERVAL_MS) return Promise.resolve();
  if ((_attemptCount.get(d) || 0) >= MAX_ATTEMPTS_PER_DATE) return Promise.resolve();

  _lastAttemptAt.set(d, now);
  _attemptCount.set(d, (_attemptCount.get(d) || 0) + 1);

  _inflight = (async function() {
    tickMinuteLoading.value = true;
    try {
      const res = await requestTickMinuteFromEdge({
        date: d,
        items: missing.map(function(t) { return { name: t.name, code: t.code || '' }; })
      });
      _handleResult(d, res, missing);
      // 抓完（不管是 ok:true 还是 ok:false）都回读一次：库才是真相源（§6）
      await loadTickMinute(d, true);
    } catch (e) {
      // §10：网络 / 部署 / CORS 失败必须可见（原文里已含三种可能）
      tickMinuteError.value = (e && e.message) ? e.message : String(e);
      console.error('[TICK-MINUTE] 抓取失败', e);
    } finally {
      tickMinuteLoading.value = false;
      _inflight = null;
    }
  })();
  return _inflight;
}

/** 只读：当前是否有一个抓取在跑（供状态文案） */
export function tickMinuteBusy() {
  return !!_inflight;
}

/**
 * 只读：某日的库【成功读过】没有。
 *
 * ⚠️ 为什么要这个：读库失败时（典型现场 = 表还没建）tickMinuteDate 也已经被设成该日
 *    （那是为了让看板 computed 不去用另一天的 Map）。若只按 tickMinuteDate 判断，
 *    抓取就会被放行 → 打一次必然失败的上游 + 写一张不存在的表。
 *    本函数把「读成功过」单独暴露出来，让调用方（composable）能拦住这一路。
 */
export function isTickMinuteReadable(date) {
  return _loadedDates.has(String(date || '').trim());
}

/**
 * 用户主动刷新（看板 defineExpose({ refresh })）：
 * 清掉该日的「已读过 / 已抓过 / 冷却 / 次数」四个闸门，然后重读 + 重新尝试抓取。
 * ⚠️ 只有【用户主动点】才走这条 —— 它会把失败重试次数重置，所以不能挂在自动路径上。
 */
export function refreshTickMinute(date, targets) {
  const d = String(date || '').trim();
  if (!d) return Promise.resolve();
  _loadedDates.delete(d);
  _attemptCount.delete(d);
  _lastAttemptAt.delete(d);
  const m = tickMinuteAttempted.value;
  if (m.has(d)) {
    const nm = new Map(m);
    nm.set(d, new Set());
    tickMinuteAttempted.value = nm;
  }
  const s = tickMinuteSkipMap.value;
  let changed = false;
  const ns = new Map();
  s.forEach(function(v, k) {
    if (k.indexOf(d + '|') === 0) { changed = true; return; }
    ns.set(k, v);
  });
  if (changed) tickMinuteSkipMap.value = ns;
  stopTickMinuteRetry();
  return loadTickMinute(d, true).then(function() { return ensureTickMinute(d, targets); });
}

/** 换日期 / 卸载时清错误与定时器（避免把上一天的错留在新的一天屏上） */
export function resetTickMinuteTransient() {
  tickMinuteError.value = '';
  tickMinuteFetchNote.value = '';
  stopTickMinuteRetry();
}
