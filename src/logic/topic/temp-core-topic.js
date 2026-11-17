// temp-core-topic.js — 临时核心词「按日期是否生效」的唯一纯函数实现（规则 〇·a · §15）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户口径（2026-11-17 拍板）：
//   · 生效区间 = 设置日 D + 后 2 个交易日（共 3 个交易日），按【交易日】跳周末/假期；
//   · D 之前的历史日、D+3 起的未来日 ⇒ 沿用原主流题材；
//   · 关停日 X（含当日）到区间末 ⇒ 临时题材失效；清空关停日即恢复；
//   · **只归类，不强制禁选**：本模块只换「核心词表」，⛔ 不碰任何买点侧禁选逻辑。
//
// 🔴 为什么是「输入侧换表」而不是「输出侧改名」：
//   题材分组（getTopicGroups / getPrimaryTopicMap）与规则层（tvrb-plan）都吃同一份 coreTopics；
//   在输出侧改名会产生第二份真相，且历史日的分组缓存与选股结论必然对不上。
//
// §5 纯函数：本模块【零 Data 依赖】（⛔ 不 import trading-day-helpers → supabase-client）。
//   假期日历由调用方注入 nextTradingDay（生产传 getNextTradingDay）；
//   不传时退化为「只跳周末」的纯实现 —— 结果可复现，单测零副作用。
//
// §11 零行为变化：任何一种「不生效」场景都【返回 base 原引用】，
//   buildCoreTokenIndex 的输出逐字节一致 ⇒ 现有主流题材功能一行不改。
// ══════════════════════════════════════════════════════════════════════════════════════

/** 生效交易日数（设置日 + 后 2 天，用户拍板） */
export const TEMP_CORE_TRADING_DAYS = 3;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function _date(v) {
  const s = String(v == null ? '' : v).slice(0, 10);
  return DATE_RE.test(s) ? s : '';
}

function _ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 兜底：只跳周末（不注入真实交易日函数时用；生产必须注入以跳过假期） */
function _nextWeekday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  for (let i = 0; i < 10; i++) {
    d.setDate(d.getDate() + 1);
    const w = d.getDay();
    if (w !== 0 && w !== 6) return _ymd(d);
  }
  return null;
}

/**
 * 算生效区间末日。
 * @param {string} startDate 设置日 YYYY-MM-DD（允许是过去的日期 ⇒ 历史补录）
 * @param {number} [days] 交易日数，缺省 3
 * @param {(dateStr:string)=>string|null} [nextTradingDay] 真实交易日推进函数
 * @returns {string} 末日 YYYY-MM-DD；设置日非法 ⇒ ''
 */
export function endDateOf(startDate, days, nextTradingDay) {
  const s = _date(startDate);
  if (!s) return '';
  const raw = Number(days);
  const n = isFinite(raw) && raw > 0 ? Math.min(365, Math.floor(raw)) : TEMP_CORE_TRADING_DAYS;
  const next = typeof nextTradingDay === 'function' ? nextTradingDay : _nextWeekday;
  let end = s;
  for (let i = 1; i < n; i++) {
    const nx = _date(next(end));
    if (!nx) break;
    end = nx;
  }
  return end;
}

/**
 * 某条临时词在指定日期是否生效。
 * @param {object} row {startDate|start_date, synonyms, disabledFrom|disabled_from, [endDate], [days]}
 * @param {string} date YYYY-MM-DD
 * @param {(dateStr:string)=>string|null} [nextTradingDay]
 */
export function isTempCoreActiveOn(row, date, nextTradingDay) {
  const d = _date(date);
  const s = _date(row && (row.startDate !== undefined ? row.startDate : row.start_date));
  if (!d || !s) return false;                    // 日期读不到 ⇒ 判不出 ⇒ 不生效（§10 不猜）
  if (d < s) return false;                       // 设置日之前的历史日期不受影响
  const end = _date(row.endDate) || endDateOf(s, row.days, nextTradingDay);
  if (end && d > end) return false;              // 区间之后的未来日期回原主流题材
  const rawDis = row && (row.disabledFrom !== undefined ? row.disabledFrom : row.disabled_from);
  const dis = _date(rawDis);
  if (dis && d >= dis) return false;             // 关停当日（含）起失效
  return true;
}

/**
 * 取某日期真正生效的核心词表：base ∪ 生效中的临时词。
 *
 * · 临时词与 base【同名】⇒ 临时词整条覆盖（生效期用临时同义词，过期自动换回原来那份）；
 * · 临时词是新名 ⇒ 追加到表尾；
 * · 没有任何生效临时词 ⇒ **返回 base 原引用**（§11 零行为变化，可被 `toBe(base)` 单测锁死）。
 *
 * @param {string} date
 * @param {Array<{name:string,synonyms?:string[]}>} base 主流核心词表（getCoreTopics()）
 * @param {Array<object>} temps 临时词全量表（getTempCoreTopics()）
 * @param {(dateStr:string)=>string|null} [nextTradingDay]
 * @returns {Array<{name:string,synonyms?:string[]}>}
 */
export function effectiveCoreTopicsFor(date, base, temps, nextTradingDay) {
  const baseArr = Array.isArray(base) ? base : [];
  const list = Array.isArray(temps) ? temps : [];
  const active = list.filter(function(r) { return isTempCoreActiveOn(r, date, nextTradingDay); });
  if (active.length === 0) return base;          // ⛔ 不复制、不排序：同一引用 = 逐字节旧行为
  active.sort(function(a, b) {
    const ai = Number(a && a.id) || 0;
    const bi = Number(b && b.id) || 0;
    return ai - bi;
  });
  const names = new Set();
  active.forEach(function(r) {
    const n = String(r && r.name || '').trim();
    if (n) names.add(n);
  });
  const out = baseArr.filter(function(c) {
    const n = String(c && c.name || '').trim();
    return !names.has(n);
  });
  active.forEach(function(r) {
    const n = String(r && r.name || '').trim();
    if (!n) return;
    const syn = Array.isArray(r.synonyms) ? r.synonyms.slice() : [];
    out.push({ name: n, synonyms: syn });
  });
  return out;
}
