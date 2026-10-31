/**
 * 买点侧「选股输入是否已经齐了」的唯一判据（纯函数，§15 可单测）。
 *
 * ★★ [BUY-SETTLE 2026-10-31 用户口径 · 第二版]
 *
 * 用户报障（逐字，第二次）：
 *   「还是和原来一样，它最终显示正确的，但是要等几秒后，比如刚开始选的是上海九百和文投控股，
 *     几秒钟后，文投控股消失，文投控股应该不在规则中，所以被排除掉，最终显示正常。
 *     这种情况出现在我切换底部导航日期的时候和刚开始打开应用的时候。
 *     ……应该只显示上海九百，文投控股从开始就不要显示，很容易误导，
 *     或者你在标题栏那里提示下，等最终结果，最终结果还没出来之类的提示语。」
 *
 * 🔴【为什么上一版（只挡 9:26 口径）不够】买点侧的选股**不止一项异步输入**。
 *   每一项到货都会让 `data` computed 重算一次，每次重算都可能产出**不同的一批票**：
 *
 *   | 输入 | 谁在变 | 到货后怎么会换票 |
 *   |---|---|---|
 *   | 核心题材【大类】(`core_topics`) | `loadCoreTopicsFromCloud()` | 归一结果变 ⇒ 题材分组合并/拆分 ⇒ 只数 ⇒ 档位(pickCount 1/2/3) ⇒ 选几只 |
 *   | 9:26 竞价口径 | `readAuctionLegRangeMap(d)` | 组内十日涨幅重排 ⇒ 龙位变 ⇒ 选哪只 |
 *   | 当日十日涨幅 | `readRangePctForDate(d)` | 龙二 / 空白期闸门 |
 *   | 昨日十日涨幅 + 昨日退潮判定 + 近 20 日退潮历史 | `readRangePctForDate(pd)` / `readEbbDays` | 退潮首日 / 二次确认 ⇒ **整段换板**（退潮替补 vs 常规选股）|
 *   | 十日涨幅在列次数 (`auction_presence`) | `ensurePresence(d)` | 第二十九条候补 / 小题材收紧 ⇒ 加一只或弃题材 |
 *   | 20 日涨幅前五历史榜 | `readTop5History` | 切换日「首次上榜」收紧（仅切换日） |
 *
 *   ⇒ 只要其中**任何一项**还没「落地」，这次算出来的票就是**暂定值**；过几秒还会变。
 *     用户的原话「刚开始选的是上海九百和文投控股，几秒钟后文投控股消失」就是某几项陆续到货的结果。
 *     （实测证据：切日期那一帧所有带日期的 ref 都还是**旧日期**的值，`ebbHistory` 为空时规则层按
 *      「0 次事件 = 首次退潮」处理 ⇒ 首帧很可能整段走退潮替补，与最终结果完全不是同一批票。）
 *
 * ★★ 第三版（2026-10-31，用户第三次报障「变成一只 → 又跳转两只 → 又变成一只」）又补了两项：
 *   ⑨ 20 日涨幅前五的**结论**（退潮判定的总龙一就是它，能整段换板；带宽限）
 *   ⑩ 题材库 `stock_topics` 就绪（实测 10-30 两只票的 topics 字段都是 null，题材全靠库反查；
 *      库没到 ⇒ 全落「其它」⇒ 分组/只数/档位全错；带宽限）
 *   ⚠️ 但**光靠枚举永远会漏**（买点侧还吃竞价行 / 量比缓存 / 昨日名册 / 灰行来源 ……）——
 *      所以第三版另有【结果侧】兜底：`buy-quiesce.js` 要求选股指纹连续一段稳定期不被推翻。
 *      本文件的职责只是「把已知的、能同步判的那几项快速挡住」，⛔ 别把稳定期那套搬进来。
 *
 * ✅ 判据：上述输入**全部**落地（= 每个都有「成功或失败」的结论）才允许显示选票；
 *    未齐时买点侧只显示占位，并**在标题栏与占位里写清还差哪几项**（用户要的「提示语」）。
 *
 * ⚠️ 三条设计红线（⛔ 别「优化」掉）：
 *   ① **只认「日期对得上」的那份**：切日期那一帧 ref 里还是旧日期 ⇒ 必须继续挂占位（§10 红线）。
 *   ② **「读过」就算落地**：每一项的成功/失败分支都必须写自己的日期，否则一次读失败会把买点侧
 *      **永久锁死**（比闪一下更糟）。`prevRangeTriedDate` 就是为此新增的 —— 原来那条链失败后
 *      连日期都不记（既不会重试也算不出结论）。
 *   ③ **不猜**：缺项 ≠ 结论。占位只说「在等」，⛔ 不说「今天没票」「空仓」（§10）。
 *
 * @param {object} ctx
 *   date                 展示日 YYYY-MM-DD
 *   prevDate             上一交易日（''/null ⇒ 跳过与「昨日」相关的两项：极端配置 / 空日历）
 *   coreTopicsLoaded     核心词表是否已从云端读过（success 或 fail 都算）
 *   buyRangeDate         9:26 竞价口径「读过」的日期
 *   curRangeDate         当日十日涨幅「读过」的日期
 *   prevRangeTriedDate   昨日十日涨幅「读过」的日期（成功或失败）
 *   prevEbbDayDate       昨日退潮判定「读过」的日期
 *   ebbHistoryDate       近 20 日退潮历史「读过」的日期
 *   range10PresenceDate  十日涨幅在列次数「读过」的日期
 *   switchDay            本次计划是否判为「切换日」（仅切换日才要求下面那项）
 *   top5HistDate         20日涨幅历史榜「读过」的日期
 *   range20Settled       ★ [BUY-SETTLE-2] 该日「20 日涨幅前五」的结论到了没有
 *                        （`hasRange20LeadersVerdictForDate(d)`，或调用方的宽限期已过）
 * @returns {{settled:boolean, missing:string[], text:string}} missing = 中文项名（给用户看）
 */
export function resolveBuySettle(ctx) {
  const o = ctx || {};
  const d = String(o.date || '').trim();
  // 没有展示日 ⇒ 这张看板本来就没在算（空态由「未就绪」那一路负责）⇒ 本门控不管
  if (!d) return { settled: true, missing: [], text: '' };

  const pd = String(o.prevDate || '').trim();
  const at = function(v) { return String(v || '').trim(); };
  const missing = [];

  // ① 题材【大类】归一（全局一次，不分日期 —— 到货前分组是「按细分原文」，到货后按大类，票会变）
  if (!o.coreTopicsLoaded) missing.push('核心题材大类');
  // ②③ 当日两份（买点侧选股的直接输入）
  if (at(o.buyRangeDate) !== d) missing.push('9:26 竞价口径');
  if (at(o.curRangeDate) !== d) missing.push('当日十日涨幅');
  // ④⑤ 昨日两份（决定「今天是不是退潮 / 二次确认」—— 判错会整段换板）
  if (pd && at(o.prevRangeTriedDate) !== pd) missing.push('昨日十日涨幅');
  if (pd && at(o.prevEbbDayDate) !== pd) missing.push('昨日退潮判定');
  // ⑥ 近 20 日退潮历史（首次 / 二次确认 / 无第三次）
  if (at(o.ebbHistoryDate) !== d) missing.push('近 20 日退潮历史');
  // ⑦ 十日涨幅在列次数（第二十九条候补 / 小题材收紧）
  if (at(o.range10PresenceDate) !== d) missing.push('十日涨幅在列次数');
  // ⑧ 仅切换日才要：20 日涨幅历史榜（判「首次上榜」）
  if (o.switchDay && at(o.top5HistDate) !== d) missing.push('20 日涨幅历史榜');
  // ⑨ ★ [BUY-SETTLE-2 2026-10-31] 20 日涨幅前五的【结论】。
  //    为什么它必须算「选股输入」：`ebbCtx` 的总龙一就是它 → 前五没到 ⇒ 退潮规则不生效 ⇒ 按常规选股；
  //    到货后若判出退潮 ⇒ 整段换成退潮替补（用户看到的「变成一只 → 又跳转两只 → 又变成一只」）。
  //    ⚠️ 调用方传 `true` 可以覆盖它（宽限期到了 / 判不出也要放行，⛔ 别把买点侧永久锁死）。
  if (o.range20Settled === false) missing.push('20 日涨幅结论');
  // ⑩ ★★ [BUY-SETTLE-2 2026-10-31] 题材库（`stock_topics`）就绪。
  //    实测 10-30：正式名单 42 行里「上海九百 / 文投控股」的 topics 字段**都是 null**
  //    ⇒ 题材完全靠题材库反查；库没到之前它们全落「其它」⇒ 分组 / 只数 / 档位全错 ⇒ 选另一批票。
  //    ⚠️ 同样带宽限覆盖（库拉不到时不能让买点侧永远空着）。
  if (o.topicLibraryReady === false) missing.push('题材库');
  // ⑪ ★★ [BUY-SETTLE-3 2026-10-31 · 第五版] **十日涨幅池「与屏幕同一批行」**
  //    （采集层 `range10PoolComplete`：20 日涨幅补位行有没有并进池子）。
  //
  //    🔴 为什么必须单列这一项（实测抓到它就是「第二只票」的直接开关）：
  //      `range10PoolComplete === false` 时规则层对三条判据一律「判不出」⇒ 按老规则照常列出：
  //        · 排名第二题材的入选条件（本次【未校验】）
  //        · 小题材收紧（4~6 只且前十无本题材票 ⇒ 弃题材）
  //        · 第二十九条十日涨幅候补
  //      ⇒ 于是「AI应用」这个题材先被列出来（多出文投控股一只），
  //        补位行到货后同一段说明改写成「本次【不入选】」⇒ 那只票被收回。
  //      ⚠️ 上一版（BUY-SETTLE-2）只挡了「20 日涨幅前五结论」，但那**不等于**补位行就绪：
  //        前五的结论可以已经发布，而池子里的补位行仍缺（更别提 `getRange20Leaders` 曾经
  //        因为读单一 `_state` 而给出 null —— 那一条已在 range20-leaders.js 按日期修掉）。
  //    ⚠️ 缺省（`undefined`）⇒ 视为就绪 ⇒ §11 零行为变化（老调用方 / 单测不受影响）。
  if (o.range10PoolReady === false) missing.push('十日涨幅补位行');

  if (missing.length === 0) return { settled: true, missing: [], text: '' };
  return {
    settled: false,
    missing: missing,
    text: '还差：' + missing.join(' · ')
  };
}
