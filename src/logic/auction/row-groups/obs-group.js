// row-groups/obs-group.js — 【观察组】成员判定 + 壳行注入（唯一实现，§6）
//
// 【观察组到底是什么】
//   观察组 = **前一交易日的「竞昨高光全集」直接继承**，与当天 9:25 名单无关。
//   用户口径（2026-08-15）：「观察组的语义 = 前日竞昨高光完整集合，与"当日是否已抓取"无关」。
//   再并上「前一日打过买标签的继承票」（obsBought）。
//
// 【为什么单独一个模块】
//   这一组的判据被【四处】共用：分栏归属、题材排序豁免、统计条分母、行着色。
//   以前它们各自去读 `getJingYestHighlightSetForDate` + localStorage，一共四份判据；
//   现在只在这里算一次，其余地方拿 `isMember(name)`，⛔ 不许再自己拼。
//
// 【红线】
//   §6  ⛔ 只读不选：竞昨高光的【评选】在 sort-rules.js，本文件不重算。
//   §8  `obsBought_<date>` 是「防重复/调试标记」型本地缓存，属 §8 允许范围，不落业务数据。
//   §10 名册读取失败 ⇒ `set` 为 null（不是空 Set）。null 表示「算不出来」，
//       空 Set 表示「今天确实一个都没有」—— 两者不能混，否则观察组会被静默清空。

import { getJingYestHighlightSetForDate } from '../sort-rules.js';

/**
 * 解析观察组成员。
 *
 * @param {object} opts
 * @param {string} opts.date      展示日
 * @param {string} opts.prevDate  前一交易日
 * @param {string} [opts.dataSource] 'auction' | 'hot'
 * @returns {{
 *   set: Set<string>|null,      // 竞昨高光全集；null = 名册未就绪（§10，⛔ 不当空集）
 *   boughtSet: Set<string>,     // 前一日打「买」标签继承票（localStorage 标记，恒非 null）
 *   isMember: (name:string)=>boolean
 * }}
 */
export function resolveObsGroup(opts) {
  const o = opts || {};
  const date = String(o.date || '').trim();
  const prevDate = String(o.prevDate || '').trim();

  // [OBS-FIX 2026-08-17] 观察组 = 前一日「竞昨高光全集」直接继承。
  //   getJingYestHighlightSetForDate 本身已修（sort-rules.js）：只算当日正式名单内（9:25 拉取的
  //   watchlist 成员），排除 market_metrics 影子行 ⇒ 竞昨数 / 蓝色高光 / 观察组三者一致。
  let set = null;
  if (prevDate) {
    try {
      set = getJingYestHighlightSetForDate(prevDate, o.dataSource) || null;
    } catch (e) {
      set = null;   // §10：算不出来就如实 null，⛔ 不伪装成「今天没有观察组」
    }
  }

  const boughtSet = new Set();
  if (date) {
    try {
      const raw = JSON.parse(localStorage.getItem('obsBought_' + date) || '[]');
      (Array.isArray(raw) ? raw : []).forEach(function(n) {
        const s = String(n || '').trim();
        if (s) boughtSet.add(s);
      });
    } catch (e) {
      // localStorage 脏数据不该让整块看板挂掉；空集合即可（它只是「继承标记」）
    }
  }

  function isMember(name) {
    const n = String(name || '').trim();
    if (!n) return false;
    if (boughtSet.has(n)) return true;
    return !!(set && set.has(n));
  }

  return { set: set, boughtSet: boughtSet, isMember: isMember };
}

/**
 * 把「应属观察组但不在当日列表」的票注入为壳行。
 *
 * 语义（2026-08-15 v3 修复，⛔ 别退回 v2）：
 *   - 无论当天是否已抓到真实行情，都注入 —— 观察组是「前日竞昨高光完整集合」，
 *     与「当日有没有抓到数据」无关。v2 曾「已抓取日不注入」，导致观察组只剩交集
 *     （8/10 观察组 16≠18、8/11 26≠28）。
 *   - 注入行 `obsAutoAdded=true` ⇒ 经 isMember 判定进入观察组分栏，绝不混入常规组。
 *   - ⛔ 不写 auctionData、不推云端（§6：观察组不落库、不产生影子记录）。
 *
 * @param {object} group resolveObsGroup 的返回
 * @param {object} reg   createInjectionRegistry 的返回
 * @returns {number} 实际注入行数
 */
export function injectObsRows(group, reg) {
  if (!group || !reg) return 0;
  const seen = new Set();
  const before = reg.rows.length;
  const doOne = function(n) {
    const s = String(n || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    reg.pushShadow(s, null, 'obsAutoAdded');
  };
  if (group.set) group.set.forEach(doOne);
  group.boughtSet.forEach(doOne);
  return reg.rows.length - before;
}
