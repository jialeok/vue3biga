// board-seq.js — 早盘竞价列表「序号」的主板口径（Logic 层，§2/§3）
//
// ══════════════════════════════════════════════════════════════════════════════════════
// ★★ 为什么要有它（2026-10-25 用户口径 · 原话）★★
// ══════════════════════════════════════════════════════════════════════════════════════
//   「10月15日，我打开竞价口径和十日涨幅toggle，冰山冷热排在11（序号），因为有两只非主板的
//     也在十日涨幅前十里面，我想把非主板的序号去掉，这样冰山冷热就和下面提示文案口径相同了。
//     也就是非主板的位置可以不变，但是没有序号，因为我是看序号来判断排名的。」
//
// 问题本质：**屏幕序号和规则文案用的是两把尺子**
//   · 屏幕序号（原实现）= 渲染行下标 + 1 ⇒ 非主板照样占号 ⇒ 两只非主板夹在前面，
//     冰山冷热 显示「11」；
//   · 规则文案（topic-vol-ratio-rules.js#buildRange10Ranked）= 只主板占名次，
//     缺涨幅 / 非主板【跳过且不占名次】⇒ 冰山冷热是「第 9 名」。
//   ⇒ 同一个事实两个数字，用户按序号复盘就会觉得「说第 9 名，可它明明在第 11 行」。
//
// 本模块的口径（与规则层同一条红线）：
//   · 非主板（创业板 / 科创板 / 北交所）：**位置不变**（排序、行内容、可点击全照旧），
//     只是【不占序号】⇒ 序号列留空；
//   · 主板：按【屏幕从上到下】的顺序 1,2,3…（只数主板自己）。
//   ⇒ 与 range10-backup.js#buildRange10Ranked / presence-label.js#assignPresenceLabels
//      「主板名次」完全同序、同一条判据（§6），所以屏幕上的「9」就是文案里的「第 9 名」。
//
// ══════════════════════════════════════════════════════════════════════════════════════
// 边界
// ══════════════════════════════════════════════════════════════════════════════════════
//   · ⛔ 只改「序号」这一个展示字段：不动顺序、不动筛选、不动行内容、不发请求。
//   · 只在【区间涨幅模式（十日 / 20日涨幅）】生效 —— 那是唯一「序号 = 涨幅排名」的模式，
//     也就是文案引用名次的场景。其它模式（默认 / 题材 / 竞昨）序号只是行号，
//     保持原样（§11 缺省零行为变化，⛔ 不给它们凭空造出「跳号」）。
//   · 判据用行上已有的 `isHighLimitBoard`（它由 limit-up.js#isHighLimitBoard 单点派生，
//     见 view-helpers#_enrichAuctionItem）—— 那个函数的补集正是
//     limit-up.js#isMainBoardRankEligible，也就是规则层排名的判据。⛔ 不在这里另写一套代码前缀判断。
//   · 字段缺失 / 判不出 ⇒ 当【主板】（占号）。与 isMainBoardRankEligible「代码未知也算有资格」
//     同口径（§40：不猜成非主板，宁可多给一个号，也不让主板票无故丢号）。

/** 区间涨幅模式判定（唯一一处，⛔ 别在调用方各写一份） */
export function isRangeRankMode(sortState) {
  const s = sortState || {};
  return !!(s.byRangePct || s.byRangePct20);
}

/**
 * 【纯函数】按「主板名次」给最终渲染顺序的每一行算出序号。
 *
 * @param {Array<{isHighLimitBoard?: boolean}>} items 最终渲染顺序的行（view-helpers 的 items / fullOrder）
 * @param {{byRangePct?: boolean, byRangePct20?: boolean}} [sortState] 排序状态
 * @returns {Array<{seqNo: number, seqBlank: boolean}>} 与 items 一一对应：
 *          · seqBlank=true ⇒ 该行序号列【留空】（非主板，位置不变）
 *          · seqNo>0      ⇒ 主板名次（1 起）
 *          · seqNo=0 且 seqBlank=false ⇒ 不接管，模板回退到原来的「行号 +1」（非区间涨幅模式）
 */
export function buildMainBoardSeq(items, sortState) {
  const list = items || [];
  const rangeMode = isRangeRankMode(sortState);
  const out = new Array(list.length);
  let rank = 0;
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!rangeMode) {
      // 非区间涨幅模式：完全不接管（保持改动前的行号行为，§11）
      out[i] = { seqNo: 0, seqBlank: false };
      continue;
    }
    // 非主板 ⇒ 位置不动、只是不占号（⚠️ 判据见文件头，与规则层排名同一条）
    if (it && it.isHighLimitBoard === true) {
      out[i] = { seqNo: 0, seqBlank: true };
      continue;
    }
    rank += 1;
    out[i] = { seqNo: rank, seqBlank: false };
  }
  return out;
}
