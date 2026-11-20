// stale-watchlist-row.js — 【全局】识别「历史日期被一次性迁移灌进来的陈旧名单行」
//
// ════════════════════════════════════════════════════════════════════════════════
// [STALE-WATCHLIST 2026-11-20 用户报障]
//   「10月30日之前（包括当天）早盘竞价看板为什么多那么多条脏数据，几乎每天都有300多条，
//     我要求的整个应用都不能这样，你只改了某段时间或者某个时期，历史日期都没有修复好」
//
// 取证（Supabase 生产库全量扫描，⛔ 别再按某个日期窗口查）：
//   · auction_watchlist 共 20487 行，其中 **8517 行（41.6%）** 是陈旧迁移行；
//   · 7-23~8-04：每天 417~458 行，其中 300~400 行是 `2026-10-31T09:49:xxZ` 一次性写入的
//     `source='worker' / updated_by='main'`（真名单当时只有几十只）；
//   · 10-26~10-30：每天 321~389 行，其中 235~292 行是 `2026-11-18T16:42:xxZ` 一次性写入的
//     `source='numcat'`（⛔ 当前代码里**没有任何**路径会写 numcat 到 auction_watchlist）；
//   · 8~9 月还有 `2026-11-18T16:42:xxZ` 批次灌进来的 50~80 行/天。
//
// 为什么必须用【通用判据】而不是「修某几天」：
//   这些脏行横跨 2026-01 ~ 2026-10 共 100+ 天、来自至少 4 个不同批次、source 也各不相同
//   （worker / numcat / manual / sql_migrate / main_migrate）。按日期或按单个 source 修，
//   必然留下另一批 ⇒ 用户复盘时「换个日期就又是一屏脏数据」。
//
// 判据（与日期、source 均无关）：
//   一行 date=D 的记录，若【既没有人工标记】（note/topics/selected/bought/sold/fixed/obs_auto_added）
//   【又远离 D 写入】（created_at 与 updated_at **两者都**距 D 超过 7 个自然日）
//   ⇒ 判定为陈旧迁移行，不进入看板。
//   · 用 created_at **或** updated_at 任一贴近就保留 ⇒ 用户在事后补记/改标记的历史行不会被误杀；
//   · 7 天阈值的实测依据：7-23 的真人工行建于 7-29（6 天）被保留；污染的 10-31 批次距 100 天、
//     11-18 的 numcat 批次距 19~23 天，全部剔除。健康日期（11-10 起）**0 误伤**。
//
// 治理边界：
//   本模块只做【读侧过滤】（§11 不删云端数据、§10 不改变读失败语义）。
//   它放在 Logic 层为纯函数，Data 层两个入口统一调用（§6 单一真相），
//   UI / computed / Realtime / 网络均零变化；只减少无意义的 300+ 行 DOM（§28/§36）。
// ════════════════════════════════════════════════════════════════════════════════

/** 写入时间距目标日的最大自然日；⛔ 别调小：事后补记的历史行会被误杀 */
export const STALE_WATCHLIST_MAX_DAYS = 7;

/**
 * [OBS-CARRY 2026-11-20 用户报障「观察组有点多，感觉是好几天数据，只要求继承上一交易日」]
 * 观察组行的最大存活天数。观察组是【临时继承身份】（前一日竞昨高光 + 打标签），只活一交易日。
 * 取证：批量操作把同一批 obs 行写进未来 6 个交易日（会稽山 10-01/02/05/06/07/08 全部
 * created_at=2026-09-30T18:21~18:22），正常继承行（11-19 obs 建于 11-18）只差一天。
 * 4 天 = 跨周末周五→周一 3 自然日 + 1 天缓冲；⛔ 不能套用 7 天（会放进 10-05 那批跨周复制）。
 */
export const OBS_CARRY_MAX_DAYS = 4;

const DAY_MS = 86400000;

function _hasText(v) {
  return v !== null && v !== undefined && String(v).trim() !== '';
}

/** 'YYYY-MM-DD' / ISO 时间戳 → 当日零点 UTC 毫秒；坏值返回 null（⛔ 不当 0） */
function _dayMs(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(s + 'T00:00:00Z');
  return isFinite(t) ? t : null;
}

/**
 * 【纯函数】一行 auction_watchlist 是否为「陈旧迁移行」。
 *
 * @param {object} row 名单行（至少含 created_at / updated_at；可含 note/topics/各标记）
 * @param {string} date 该行所属交易日 YYYY-MM-DD
 * @returns {boolean} true = 陈旧迁移行，不应上屏
 */
export function isStaleWatchlistRow(row, date) {
  if (!row) return false;
  // 人工标记一律保留（含观察组身份）
  if (row.obs_auto_added === true || row.selected === true || row.bought === true ||
      row.sold === true || row.fixed === true) return false;
  if (_hasText(row.note) || _hasText(row.topics)) return false;

  const target = _dayMs(date === undefined || date === null ? row.date : date);
  if (target === null) return false;    // 目标日未知 ⇒ 不猜，保留（§10）
  const created = _dayMs(row.created_at);
  const updated = _dayMs(row.updated_at);
  if (created === null && updated === null) return false;  // 无时间信息 ⇒ 保留
  const within = (t) => t !== null && Math.abs(t - target) <= STALE_WATCHLIST_MAX_DAYS * DAY_MS;
  // 任一侧贴近就留；两者都远才是迁移脏行
  return !(within(created) || within(updated));
}

/**
 * 【纯函数】一行 obs 观察组行是否为「跨天复制残留」。
 *
 * 观察组只继承【上一交易日】：正常 obs 行的 created_at 就在目标日或前一交易日（跨周末最多 3 天）。
 * 若创建时间距目标日 > OBS_CARRY_MAX_DAYS，说明是一次性批量写进未来多天的历史残留，
 * 复盘时会把好几天的观察组堆在同一屏 —— 必须在读侧剔除。
 *
 * 保护（§10/§11）：
 *   · 有 note / topics ⇒ 人工确认过的观察行，保留；
 *   · 目标日未知 / 无时间信息 ⇒ 不猜，保留；
 *   · 非 obs 行 ⇒ 本判据不插手。
 *   ⛔ updated_at 贴近目标日也【不】豁免：批量复制后当天有人改过一行（10-08 的 180/6.17%）
 *      仍是同一批残留，不能因为一次编辑就把整批放回来。
 *
 * @param {object} row
 * @param {string} date 目标日 YYYY-MM-DD
 * @returns {boolean} true = 跨天复制残留，不应上屏
 */
export function isObsoleteObsRow(row, date) {
  if (!row || row.obs_auto_added !== true) return false;
  if (_hasText(row.note) || _hasText(row.topics)) return false;
  const target = _dayMs(date === undefined || date === null ? row.date : date);
  if (target === null) return false;
  const created = _dayMs(row.created_at);
  const updated = _dayMs(row.updated_at);
  if (created === null && updated === null) return false;
  // 只看创建时间：它决定「这一行是何时被继承进这一天」；updated 只可能是后来的编辑。
  const born = created === null ? updated : created;
  return Math.abs(born - target) > OBS_CARRY_MAX_DAYS * DAY_MS;
}

/**
 * 【纯函数】批量过滤；getDate 缺省读 row.date（按日查询时可传 () => date）。
 * 两道闸共用：① 陈旧迁移行 ② 跨天复制的 obs 继承行。
 * 输入数组不被修改（§11 纯读）。
 *
 * @param {Array} rows
 * @param {(row:object)=>string} [getDate]
 * @returns {Array} 保留的行（原引用）
 */
export function filterStaleWatchlistRows(rows, getDate) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return list;
  const dateOf = typeof getDate === 'function' ? getDate : function (r) { return r && r.date; };
  return list.filter(function (r) {
    const d = dateOf(r);
    return !isStaleWatchlistRow(r, d) && !isObsoleteObsRow(r, d);
  });
}
