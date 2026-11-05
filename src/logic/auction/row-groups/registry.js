// row-groups/registry.js — 三组「壳行注入」共用的登记器（Logic 层，单一实现 §6）
//
// 【为什么需要它】
//   龙头组 / 观察组 / 20日补位 三组的壳行要进【同一条渲染队列】，且必须严格去重：
//     ① 已在当日正式列表里（existingNames）→ 不注入（它本来就是常规组的一员）；
//     ② 已被别的组注入（injectNames）→ 不注入（一只票只能归属一个组，否则四组相加 ≠ 行数）；
//     ③ 当日云端有同名行（market_metrics 影子行）→ 复用它的行情字段，不留空壳。
//   这三条以前散落在 view-helpers.js 的三个 `_maybeInject*` 里，各写一遍去重判断
//   ⇒ 加一个组就要再写一遍，漏一条就出现「同一只票出现两次 / 组计数和行数对不上」。
//   现在只有这一份实现，各组只负责「我这一组有哪些票」，注入与去重不归它们管。
//
// 【红线】
//   §6  壳行⛔不写 auctionData、⛔不推云端（不产生影子记录）—— 本模块只产出内存数组。
//   §10 影子行判定 `obsAutoAdded !== true` 保留原语义：只有「非观察组身份」的影子行才复用，
//       否则会拿观察组自己的空壳去顶龙头组，行情字段永远是空的。

/**
 * 建一个注入登记器。
 *
 * @param {object} opts
 * @param {Array} opts.list          当日正式列表（auctionList / getTodayGroupList 的结果）
 * @param {Map<string,object>} opts.dayRowMap  当日云端行（股票名 → market_metrics 影子行）
 * @param {Function} [opts.codeOf]   名称 → 6 位代码（默认空实现，壳行没代码也能渲染）
 * @returns {{
 *   existingNames: Set<string>,
 *   injectNames: Set<string>,
 *   rows: Array<object>,
 *   has: (n:string)=>boolean,
 *   claim: (n:string)=>void,
 *   pushShadow: (n:string, shadow:object, flag:string)=>boolean,
 *   pushShell: (n:string, meta:object, flag:string)=>boolean
 * }}
 */
export function createInjectionRegistry(opts) {
  const o = opts || {};
  const list = Array.isArray(o.list) ? o.list : [];
  const dayRowMap = o.dayRowMap instanceof Map ? o.dayRowMap : new Map();
  const codeOf = typeof o.codeOf === 'function' ? o.codeOf : function() { return ''; };

  const existingNames = new Set();
  list.forEach(function(it) {
    const nm = it && it.stock ? String(it.stock).trim() : '';
    if (nm) existingNames.add(nm);
  });
  const injectNames = new Set();
  const rows = [];

  /** 这只票还需不需要注入（已在正式列表 / 已被别的组认领 ⇒ 不需要） */
  function has(name) {
    const n = String(name || '').trim();
    if (!n) return true;
    return existingNames.has(n) || injectNames.has(n);
  }

  /** 认领：标记「这只票已由某个组接管」，后续组不能再注入 */
  function claim(name) {
    const n = String(name || '').trim();
    if (n) injectNames.add(n);
  }

  /**
   * 推一行：优先复用当日云端影子行（带真实行情），否则造空壳。
   * @param {string} name
   * @param {object} meta  组元信息（code 等）
   * @param {string} flag  'obsAutoAdded' | 'dragonAutoAdded' | 'range20AutoAdded'
   *        ⚠️ 三个 flag 互斥、语义不同，⛔ 不许一只票同时带两个（否则「组归属」出现第二个判据）
   * @returns {boolean} 是否真的推了
   */
  function push(name, meta, flag) {
    const n = String(name || '').trim();
    if (!n || has(n)) return false;
    claim(n);
    const dayRow = dayRowMap.get(n);
    // 只有「非观察组身份」的影子行才复用：obsAutoAdded 的行本来就是空壳，拿它顶别的组没有意义
    if (dayRow && dayRow.obsAutoAdded !== true) {
      const row = Object.assign({}, dayRow);
      row[flag] = true;
      rows.push(row);
      return true;
    }
    const shell = { stock: n, code: (meta && meta.code) || codeOf(n) || '', volume: '', yestVolume: '', note: '' };
    shell[flag] = true;
    rows.push(shell);
    return true;
  }

  return {
    existingNames: existingNames,
    injectNames: injectNames,
    rows: rows,
    has: has,
    claim: claim,
    // 语义化两个别名，调用处读起来更直白（内部实现完全相同）
    pushShadow: push,
    pushShell: push,
  };
}
