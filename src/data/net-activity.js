/**
 * net-activity.js — 「上游数据还在读吗」的唯一判据（Data 层，§5 / §6）。
 *
 * 【为什么需要它】
 *   题材量比买点侧连续三次报障「先显示 A+B，几秒后变成 A」——根因不是某个 ref 没等，
 *   而是**上游还有请求在途**：`auction_watchlist`（当日正式名单）实测到 +17.9s、
 *   `market_metrics`（竞价量比，题材排名 = 平均量比）到 +23.7s 才落地。
 *   在此期间，任何「按时间等 N 秒」的门控（6s 宽限 / 1.5s 稳定期）都必然会漏 ——
 *   因为到货时刻由网络决定，不由代码决定（§35：禁止用 setTimeout 掩盖根因）。
 *
 * 【判据的物理含义】
 *   `netInflight === 0` ⇒ 此刻没有请求在途 ⇒ 不可能**正在**落地新数据。
 *   但⚠️ 单独用它是错的：数据链路是「分批起跑」的（第一波到齐后、第二波才发出去），
 *   中间会出现**瞬时归零**。只看瞬时值 ⇒ 在波与波之间放行 ⇒ 下一波到货又换票。
 *   ⇒ 本模块给出 `netIdle`：「在途归零**且持续 `NET_IDLE_MS` 没有新请求**」。
 *     一个新请求起跑就会立刻打掉它 ⇒ 门控只会在「整批真的读完了」之后放行。
 *
 * 【为什么是「排除列表」而不是白名单】
 *   白名单（只盯已知的几张表）会漏掉未来新增的数据源 —— 项目里已经踩过两次（第一版 1 项、
 *   第二版 8 项）。这里反过来：**默认全部计入**，只排除「明确与选股结论无关」的其它看板表，
 *   排除项只影响等待时长，绝不会造成漏判。
 *
 * ⛔ 这不是第二真相源：它只描述「网络在途状态」，不存任何业务数据。
 * ⛔ 不要在带真实业务时间的路径上改它（只由 fetch 包装器增减）。
 */
import { ref } from 'vue';

/**
 * 明确【不参与任何选股结论】的表（只影响等待时长）。
 * 判定标准：这些表只服务其它看板 / 纯展示，读数变化不会改变「买几只 / 选哪只 / 退潮与否」。
 * ⚠️ 往这里加表前先自问：这张表的数据变了，买点侧有没有可能换票？有可能 ⇒ ⛔ 不许加。
 */
const IGNORE_TABLES = new Set([
  'tick_minute',        // 分笔（买卖盘明细，纯展示；每秒到货，计进来会永不放行）
  'tick_minute_open',   // 分笔-开盘段
  'early_etf_data',     // ETF 看板
  'jiwang_data',        // 记忘看板
  'pattern_data',       // 模式看板
  'multi_data',         // 多板看板
  'emotion_data',       // 情绪看板
  'rank_data',          // 排名看板
  'hotspot_data',       // 热点看板
  'bidding_data',       // 竞价变化看板（与题材量比选股无关）
  'tag_titles_data',    // 标签文案
  'limit_pool',         // 涨跌停池（本看板不读；买点的竞价一字判定走行内字段）
]);

/** 在途 REST 请求数（响应式：Logic 层的门控直接读它，§19） */
export const netInflight = ref(0);
/** 最近一次请求完成的时间戳（ms）；0 = 本次会话还没完成过请求 */
export const netLastDoneAt = ref(0);

/**
 * 「网络已静默」—— 买点侧门控的**主判据**。
 *
 * true ⇔ 在途请求已归零 **且** 之后 `NET_IDLE_MS` 内没有新请求起跑。
 *
 * 为什么必须「持续」而不是「瞬时」：数据链路分批起跑，波与波之间会出现瞬时归零，
 * 瞬时判据会在中途放行（实测：放行后 1 波到货就换票）。持续一段没有任何请求，
 * 才等价于「这一整批读完了」，也才等价于「屏幕上的结论不会再被上游改写」。
 *
 * 初值 true：首帧还没有任何请求起的这段时间，属于「没有要等的东西」，
 * 真正的等待由选股指纹稳定期（buy-quiesce）与 `plan.buyPending` 承担。
 */
export const netIdle = ref(true);

/**
 * 「装载窗口已超时」旗标 —— ⚠️ 这是**防卡死**的闸门，不是数据判据。
 *
 * 为什么需要它：上游可能真的挂住（弱网 / 某张表超时重试）。若只认 `netIdle`，
 * 买点侧就会永久停在「结果确认中」—— 那正是用户说的「打不开」。
 * 语义：切日期 / 首次装载起一次窗口（`markNetLoadWindow`），超过 `NET_STALL_MS` 仍在途
 * ⇒ 置 true ⇒ 门控放行已到的数据，并由 UI 显示「读取超时，结果可能随后变化」（§10 不确定必须可见）。
 *
 * ⚠️ 它是**粘性**的：一旦置 true 就一直有效，直到下一个装载窗口（换日 / 重新进入）。
 *   ⛔ 不许在「在途归零」时清掉它（踩过：清掉 ⇒ 放行后下一波请求起跑又挂回占位，
 *      实测表现为「24.5s 放出正确结果 → 34.5s 又变回结果确认中」的闪回）。
 */
export const netStalled = ref(false);

/** 静默判定时长：必须 ≥ 选股指纹稳定期（BUY_QUIET_MS），否则两道闸门会互相打架 */
export const NET_IDLE_MS = 1500;

/**
 * 装载窗口时长：实测最慢单条 13.8s、整批到齐 23.7s。
 *
 * 取值依据（2026-10-31 真数据 4 轮对照）：20s 是「冷启动最坏情况」与「白等」之间的折中 ——
 *  · 12s 放行在多数轮次已经拿到正确结果，但只要有一个 14s 的慢请求在场就会拿到错票；
 *  · 25s 虽然最稳，但几乎每轮都靠它兜底（20 日涨幅的历史腿会以约 1.5s 的节拍连续起跑 40s+，
 *    「网络静默」很难自然到达）⇒ 用户要盯着占位 25 秒，观感就是「打不开」。
 * ⇒ 20s 兜底 + 放行后仍挂「读取超时」警示（§10 不确定必须可见）是最诚实的组合。
 */
export const NET_STALL_MS = 20000;

let _inflight = 0;
let _idleTimer = null;
let _stallTimer = null;

function _clearIdleTimer() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
}
function _clearStallTimer() {
  if (_stallTimer) { clearTimeout(_stallTimer); _stallTimer = null; }
}

/** 在途归零后开始数静默期（⛔ 只在归零那一刻起表，有请求起跑立刻作废） */
function _armIdleTimer() {
  _clearIdleTimer();
  if (_inflight > 0) { netIdle.value = false; return; }
  _idleTimer = setTimeout(function () {
    _idleTimer = null;
    if (_inflight === 0) netIdle.value = true;
  }, NET_IDLE_MS);
}

/** 从 PostgREST URL 里取表名；不是 REST 请求 / 取不到 ⇒ '' */
export function tableOfUrl(url) {
  const m = String(url || '').match(/\/rest\/v1\/([A-Za-z0-9_]+)/);
  return m ? m[1] : '';
}

/** 该表是否与选股结论无关（只用于「少等一会儿」，⛔ 不是正确性判据） */
export function isUnrelatedTable(table) {
  return !!table && IGNORE_TABLES.has(table);
}

/**
 * 开始一个请求（由 fetch 包装器调用）。
 * 只统计「会参与选股结论」的 REST 请求；其它域（分笔 / ETF / 记忘…）直接不计。
 * @param {string} url
 * @returns {boolean} 是否计入（false ⇒ 调用方不必调用 _netEnd）
 */
export function _netBegin(url) {
  const t = tableOfUrl(url);
  // 非 REST（auth / storage / realtime 握手）一律不计：它们不影响业务数据落地。
  if (!t || isUnrelatedTable(t)) return false;
  _inflight++;
  netInflight.value = _inflight;
  // 新请求起跑 ⇒ 立刻退出静默态（这是「中途放行」的唯一正确时机判定）
  netIdle.value = false;
  _clearIdleTimer();
  return true;
}

/** 结束一个请求（成功 / 失败都要调，⛔ 否则在途数只增不减 ⇒ 门控永久挂起） */
export function _netEnd() {
  if (_inflight > 0) _inflight--;
  netInflight.value = _inflight;
  netLastDoneAt.value = Date.now();
  // ⚠️ 这里【不】清 `netStalled`：它同时是「本轮窗口已经放弃等待」的**粘性**结论，
  //    一旦放行就被永久撤销的话，门控会在下一波请求起跑时重新挂回占位 ——
  //    实测就是「24.5s 放出正确结果 → 34.5s 又变回结果确认中」的闪回。
  //    收旗只发生在 `markNetLoadWindow()`（换日 / 重新进入）。
  if (_inflight === 0) _armIdleTimer();
}

/**
 * 开一个「装载窗口」（业务层在切日期 / 首次进入时调一次）。
 *
 * 作用：`NET_STALL_MS` 之后若仍在途，把 `netStalled` 置 true ⇒ 门控放行已到的数据（防卡死）。
 * ⛔ 不绑在「在途数归零」上：数据分批起跑，绑上去等于闸门永不生效。
 */
export function markNetLoadWindow() {
  netStalled.value = false;
  _clearStallTimer();
  _stallTimer = setTimeout(function () {
    _stallTimer = null;
    if (netInflight.value > 0) {
      netStalled.value = true;
      netIdle.value = false;
      try {
        // eslint-disable-next-line no-console
        console.warn('[NET-STALL] 装载窗口 ' + (NET_STALL_MS / 1000) + 's 已过，仍有 ' +
          netInflight.value + ' 个请求在途 ⇒ 放行已到数据（UI 会显示「读取超时」警示）');
      } catch (e) { /* 诊断日志失败不影响主流程 */ }
    }
  }, NET_STALL_MS);
}

/**
 * 给 supabase-js 用的 fetch 包装器（在 `createClient` 时注入，全局唯一入口，§5）。
 * ⚠️ 必须透传所有参数与返回值，包装层不许改请求语义。
 */
export function netTrackedFetch(input, init) {
  const url = (typeof input === 'string') ? input : (input && input.url) || '';
  const counted = _netBegin(url);
  if (!counted) return fetch(input, init);
  let p;
  try {
    p = fetch(input, init);
  } catch (e) {
    _netEnd();
    throw e;
  }
  return p.then(function (res) {
    _netEnd();
    return res;
  }, function (e) {
    _netEnd();
    throw e;
  });
}

/** 仅供测试 / 诊断：清空在途计数（⛔ 业务代码不许调用） */
export function _resetNetActivity() {
  _inflight = 0;
  netInflight.value = 0;
  netLastDoneAt.value = 0;
  netIdle.value = true;
  netStalled.value = false;
  _clearIdleTimer();
  _clearStallTimer();
}
