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
 * 该临时词「在窗口内真正算数的交易日」列表（含设置日；已关停则截到关停前一日）。
 *
 * 🔴 2026-11-17 用户实测 bug（本函数的来由）：
 *   设置日 11-12 建的临时词「东方」，区间 11-12 ~ 11-16（3 个交易日），
 *   结果【只有 11-12 生效】，11-13 / 11-16 的分类里根本没有「东方」。
 *   根因不在日期判定（isTempCoreActiveOn 三天都判 true），而在【标签供给】：
 *     11-12 那天用户的 note 里有「东方」段 ⇒ 分得出组；
 *     11-13 / 11-16 的 note 是空的 ⇒ 走共享题材库（东方创业 = 物流,外贸），库里没有「东方」
 *     ⇒ 东方组 0 只（<2 只不建组）⇒ 看着像「没生效」。
 *   ⇒ 临时题材的语义是「打一次标，3 天有效」，所以窗口内要能取到【区间内出现过的标签】。
 *
 * @param {object} row 临时词行
 * @param {(dateStr:string)=>string|null} [nextTradingDay]
 * @returns {string[]} 升序交易日，如 ['2026-11-12','2026-11-13','2026-11-16']
 */
export function tempCoreWindowDates(row, nextTradingDay) {
  const s = _date(row && (row.startDate !== undefined ? row.startDate : row.start_date));
  if (!s) return [];
  const raw = Number(row && row.days);
  const n = isFinite(raw) && raw > 0 ? Math.min(365, Math.floor(raw)) : TEMP_CORE_TRADING_DAYS;
  const next = typeof nextTradingDay === 'function' ? nextTradingDay : _nextWeekday;
  const dis = _date(row && (row.disabledFrom !== undefined ? row.disabledFrom : row.disabled_from));
  const out = [];
  let d = s;
  for (let i = 0; i < n; i++) {
    if (dis && d >= dis) break;      // 关停当日（含）起不再算数
    out.push(d);
    const nx = _date(next(d));
    if (!nx) break;
    d = nx;
  }
  return out;
}

/**
 * 窗口内「命中临时词」的股票集合（供分组层在窗口的每一天都补回该题材段）。
 *
 * 纯函数（§5 零 Data 依赖）：调用方把「日期 → 股票 → 题材段数组」喂进来即可，便于单测。
 * 命中口径与 matchTopicToCore 同向（段里包含词即命中），⛔ 不做模糊/单字匹配，
 * 避免「东方」把「东方通信」以外的无关题材一起吞进来。
 *
 * @param {Array<{name:string, synonyms?:string[], dates:string[]}>} windows
 * @param {Object<string, Object<string, string[]>>} topicsByDate 日期 → 股票名 → 题材段
 * @returns {Map<string, Set<string>>} 核心词名 → 命中股票名集合
 */
export function collectTempCoreHits(windows, topicsByDate) {
  const out = new Map();
  const list = Array.isArray(windows) ? windows : [];
  if (list.length === 0) return out;
  const byDate = topicsByDate && typeof topicsByDate === 'object' ? topicsByDate : {};
  list.forEach(function(w) {
    const name = String(w && w.name || '').trim();
    if (!name) return;
    const toks = [name].concat(Array.isArray(w && w.synonyms) ? w.synonyms : [])
      .map(function(t) { return String(t == null ? '' : t).trim().toLowerCase(); })
      .filter(Boolean);
    if (toks.length === 0) return;
    const hit = new Set();
    (Array.isArray(w && w.dates) ? w.dates : []).forEach(function(d) {
      const byStock = byDate[d];
      if (!byStock) return;
      Object.keys(byStock).forEach(function(stock) {
        const segs = byStock[stock] || [];
        for (let i = 0; i < segs.length; i++) {
          const seg = String(segs[i] == null ? '' : segs[i]).trim().toLowerCase();
          if (!seg) continue;
          if (toks.some(function(t) { return seg.indexOf(t) >= 0; })) { hit.add(stock); break; }
        }
      });
    });
    if (hit.size > 0) out.set(name, hit);
  });
  return out;
}

const TOPIC_SEG_RE = /[,，、;；/+|]/;

/**
 * 该日期要【隐藏】的题材段 token（关停后用户的可见效果：股票名后那枚标签一起消失）。
 *
 * 用户口径（2026-11-17）：「关停临时题材后，我希望那个原先标在股票名称后的同义词也一起消失」。
 * ⚠️ 只在【显示 / 分组层】过滤，⛔ 绝不改 auction_watchlist.note / stock_topics ——
 *    那些是持久化的业务真相，按 §11 删除红线不能为了显示效果去删；恢复后标签自然回来。
 *
 * 隐藏区间严格限定：start_date ≤ date ≤ end_date 且 date ≥ disabled_from。
 *   · 设置日之前（历史日）⇒ 临时词从未生效过 ⇒ 用户原有标签照常显示；
 *   · 区间末之后（未来日）⇒ 已换回主流题材 ⇒ 原有标签照常显示；
 *   · 只有【关停当日及之后、区间内】才隐藏，正好对应「提前结束」这段人为干预。
 *
 * @param {string} date
 * @param {Array<object>} temps
 * @param {(dateStr:string)=>string|null} [nextTradingDay]
 * @returns {Set<string>} 小写 token 集合（核心词名 + 全部同义词）
 */
export function hiddenTempCoreTokensOn(date, temps, nextTradingDay) {
  const list = Array.isArray(temps) ? temps : [];
  const nextFn = nextTradingDay;
  const d = _date(date);
  const out = new Set();
  if (!d) return out;
  list.forEach(function(row) {
    const s = _date(row && (row.startDate !== undefined ? row.startDate : row.start_date));
    if (!s || d < s) return;
    const dis = _date(row && (row.disabledFrom !== undefined ? row.disabledFrom : row.disabled_from));
    if (!dis || d < dis) return;       // 没关停 / 关停日还没到 ⇒ 标签照常显示
    const end = endDateOf(s, row.days, nextFn);
    if (end && d > end) return;        // 已过期 ⇒ 换回主流题材，标签照常显示
    const toks = [row.name].concat(Array.isArray(row.synonyms) ? row.synonyms : []);
    toks.forEach(function(t) {
      const k = String(t == null ? '' : t).trim().toLowerCase();
      if (k) out.add(k);
    });
  });
  return out;
}

/**
 * 按【精确等于】把隐藏 token 从题材串里摘掉（与 core-word-purge 的删除口径一致）。
 * ⛔ 不用子串：关停「东方」不能把「东方通信」这种题材一起干掉。
 * @param {string} text 题材串
 * @param {Set<string>|string[]|null} tokens hiddenTempCoreTokensOn 的返回
 * @returns {string} 过滤后的题材串（段以 ',' 连接）
 */
export function filterHiddenTopicText(text, tokens) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return '';
  const ban = tokens instanceof Set ? tokens : new Set((Array.isArray(tokens) ? tokens : []).map(function(t) {
    return String(t == null ? '' : t).trim().toLowerCase();
  }));
  if (ban.size === 0) return raw;
  const out = [];
  raw.split(TOPIC_SEG_RE).forEach(function(seg) {
    const v = String(seg || '').trim();
    if (!v) return;
    if (ban.has(v.toLowerCase())) return;
    if (out.indexOf(v) < 0) out.push(v);
  });
  return out.join(',');
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
