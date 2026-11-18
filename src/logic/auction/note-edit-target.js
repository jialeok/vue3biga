// note-edit-target.js — 「竞价量双击 → 备注编辑」的目标行解析（Logic 层纯函数，§15）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 用户报障（2026-11-18，逐字）：
//   「今天11月18日早盘竞价看板灰色行：锋龙股份（龙头组），20日强势补位三只也是灰色行，
//     东方海洋，阳光照明，光洋股份，这四只，在对应竞价量列双击打开note编辑时，
//     没有题材和涨幅显示，里面的编辑框是空白，但是对应点击昨日成交量列却显示涨幅和题材toast」
//
// 根因（真实数据实证）：
//   · 这四只在 11-18 **只有 `market_metrics(scope='auction')` 行，没有 `auction_watchlist` 行**
//     ⇒ 它们是「影子行」，被龙头组 / 20日补位以**壳行**注入视图；
//   · 视图行上的 `item.index` 是 **renderList 的下标**（`row-groups/index.js`：
//     `renderList = 正式列表.concat(注入行)`）⇒ 注入行的下标 ≥ 正式列表长度；
//   · 旧实现拿这个下标去 `getTodayGroupList('auction')[index]`（**只含正式成员**）取行 ⇒ `undefined`
//     ⇒ `getDisplayNote(undefined)` 恒为 '' ⇒ 编辑框空白；
//   · 同一个 `undefined` 还让保存变成**静默空转**（`if (!item) return`），用户以为存了，其实一字未写。
//   · 「单击昨日成交量」走 `onYestClick(item)`，直接拿视图行 ⇒ 一直正常，所以两处表现不一致。
//
// 本模块只做一件事：**用股票名**把「显示行」和「可写回的内存行」解析出来。
//   ⛔ 不用下标：下标随排序 / 分组 / 注入数量漂移（`onExpandTrend` 历史上就因此展开错票）。
// ══════════════════════════════════════════════════════════════════════════════════════

function _nameOf(row) {
  return row && row.stock ? String(row.stock).trim() : '';
}

/**
 * 解析备注编辑的目标行。
 *
 * @param {object} o
 *   · target     —— 视图行对象（**推荐**）；传数字是旧契约（只对正式成员有效）
 *   · formalList —— `getTodayGroupList('auction')`：**只含正式成员**
 *   · dayRows    —— `getGroupData('auction')[date]`：正式成员 **+ 影子行**（云端合并后的内存行）
 * @returns {{
 *   name: string,            // 股票名（空串 = 判不出，调用方必须提示，⛔ 不许静默）
 *   display: object|null,    // 用来拼编辑框 / 落本地的那一行（内存行优先，其次视图行）
 *   mem: object|null,        // 内存行（true 时才是「刷新后还在」的那一份）
 *   isFormal: boolean,       // 今日正式成员？决定 note 文本有没有 `auction_watchlist` 这个「家」
 *   reason: string           // 'ok' | 'no-stock' | 'no-row'
 * }}
 */
export function resolveNoteEditTarget(o) {
  const opt = o || {};
  const formalList = Array.isArray(opt.formalList) ? opt.formalList : [];
  const dayRows = Array.isArray(opt.dayRows) ? opt.dayRows : [];
  const target = opt.target;

  let row = null;
  if (target && typeof target === 'object') {
    row = target;
  } else if (typeof target === 'number' && target >= 0) {
    // 旧契约：下标指向「正式列表」；注入行在这里必然取不到 —— 保留只为不把老调用点直接打崩
    row = formalList[target] || null;
  }

  const name = _nameOf(row);
  if (!name) return { name: '', display: null, mem: null, isFormal: false, reason: 'no-stock' };

  const mem = dayRows.find(function(r) { return _nameOf(r) === name; }) || null;
  const isFormal = formalList.some(function(r) { return _nameOf(r) === name; });
  const display = mem || row;
  if (!display) return { name: name, display: null, mem: null, isFormal: isFormal, reason: 'no-row' };
  return { name: name, display: display, mem: mem, isFormal: isFormal, reason: 'ok' };
}
