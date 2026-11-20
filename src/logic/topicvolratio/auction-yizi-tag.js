// auction-yizi-tag.js — 「题材量比」看板买点行【竞价一字涨停】统一标注（Logic 层纯函数）
//
// ★★ [TVRB-AUC-YIZI 2026-11-10 用户口径 · 2026-11-16 统一] ★★
// 用户原话：「竞价涨停也可以选进，但是要标注竞价一字涨停……这样更清晰，提醒样式稍微区分下，
//            我一下子就看明白。」
// 11-16 再确认：「标签是竞价一字涨停，等下杀买」「都是说同个意思」⇒ 两枚合并成一枚（见下方常量）。
//
// ⛔ 三条红线：
//   ① 【不改任何选股过滤】。本模块只负责把一字【标出来】，选谁/不选谁由各通道决定。
//      ★★ [YIZI-NO-SHIFT 2026-11-20 用户口径 · 旧口径废除] 曾经存在的
//      「常规题材块：竞价一字 ⇒ 跳过、顺延下一龙位」（2026-10-15 拍板）**已整体废除** ——
//      用户原话：「现在新规是不跳过竞价一字涨停了吗，不用顺延这个规则了……这些竞价涨停的票
//      很有可能，盘中下杀后回封（涨停），如果跳过可能就错过好票了，所以打上那个标签
//      竞价一字涨停，等下杀买」「再说一次，不用这个规则了」。
//      ⇒ **全部通道统一**：竞价一字【照常选进、占一档】+ 挂本模块的标签
//      （tvrb-blocks.js#_buildBlock 的 isYizi 分支已无任何「跳过」路径）。
//      ⛔ 不许以「某档更特殊」为由复活顺延（big / mid / 小题材收紧 / 第二题材内 / 十日候补全部一致）。
//   ② 判定只走 limit-up.js#getAuctionLimitState 的唯一实现（按代码分板块 10/20/30%、ST 5%），
//      ⛔ 不另写阈值；优先读 finishBuyBlock 已落好的 p.aucLimitUp（同一份客观数据，§6）。
//   ③ 只挂【展示字段】⇒ 不改 picks 的数量 / 顺序 / 名称 / 动作标签 / 说明文字（§11 零行为变化）；
//      视图层只 v-if 渲染（§21 模板零计算）。
//   ④ 数据缺失（aucPct=null / 读不到）⇒ 不标（§10 读取失败 ≠ 涨停 ≠ 不涨停，绝不猜）。
//
// 为什么是【统一后处理】而不是在各个 _build*Block 里各挂一次：
//   买点块有 7 个以上的生产通道，且 out.* 与 out.buy.* 是同一批对象的两份引用。
//   在 buildTopicVolRatioPlan 的 return 前收口一次，才能保证将来新增通道不会漏标
//   （与 _clearBuySideForDataGate 同一套「清单收口」思路）。

import { getAuctionLimitState } from '../auction/limit-up.js';

/** 徽标文案（视图层只读，不在模板里拼字符串，§6 单一真相） */
export const AUCTION_YIZI_WAIT_TAG = '竞价一字涨停 · 等下杀买';

/**
 * ★★ [AUCTION-YIZI-UNIFY 2026-11-16 用户口径] 两枚标签合并为一枚。
 *
 * 用户原话：「标签是竞价一字涨停，等下杀买」「都是说同个意思，竞价一字涨停，等下杀买」。
 *
 * 改前有两枚：
 *   · `AUCTION_YIZI_TAG`      = '竞价一字涨停 · 等开板后进'（2026-11-10 通用档）
 *   · `AUCTION_YIZI_WAIT_TAG` = '竞价一字涨停 · 等下杀买'（2026-11-12 第二十八条新题材那只）
 * ⇒ 同一件事两种说法，用户看两遍、开发改一处必漏一处（手册 104 行与 479 行就曾各写一种）。
 *
 * 现在：**一枚标签 = 一个常量**。保留 `AUCTION_YIZI_TAG` 这个名字只为不打断既有 import，
 * 它的值已与 WAIT 档逐字相同 —— ⛔ 不许再改回两套文案（audit-rules.mjs 第 2 段会报 FAIL）。
 */
export const AUCTION_YIZI_TAG = AUCTION_YIZI_WAIT_TAG;

/** 悬停说明：把「为什么还选它」和「怎么买」一次说清（用户要「我一下子就看明白」） */
export const AUCTION_YIZI_TITLE =
  '9:25 竞价涨幅已达涨停幅度（按代码分板块 10% / 20% / 30%、ST 5%）⇒ 竞价阶段封在板上、买不进；' +
  '这一只【照常选进】，但要【等下杀再接】—— ⛔ 别在封板上硬追，盘中它会开板。';

/**
 * 计划对象里【所有带 picks 的买点槽位】。
 * ⚠️ 与 tvrb-plan.js#_clearBuySideForDataGate 的 out.* 清单一一对应：
 *    新增任何买点槽位（out.xxx / out.buy.xxx）**必须同步加进这里**，
 *    否则那一通道的一字票会漏标。`auction-yizi-tag.test.js` 有清单一致性用例会红。
 */
export const TVRB_BUY_BLOCK_KEYS = [
  'blocks', 'ebbBuy', 'divergeBuy', 'newDragon',
  'range10Backup', 'weakHuddle', 'catchUp',
  // ★★ [RULE-35-RENDER 2026-11-19] 第三十五条槽位（`out.top30Huddle`，见 tvrb-plan.js）
  //   漏了它 ⇒ 那一行的一字票不会挂「竞价一字涨停」标签（同一类静默漏标）。
  'top30Huddle'
];

/**
 * 单只买点行是不是【竞价一字涨停】（纯函数，可单测）。
 *
 * @param {object} p 买点行（须已跑过 finishBuyBlock，带 aucLimitUp / aucPct / code）
 * @returns {boolean}
 */
export function isAuctionYiziPick(p) {
  if (!p || !p.name) return false;
  // finishBuyBlock 已按同一份 limit-up 判据落好客观字段 ⇒ 直接读，⛔ 不重算（§6）。
  if (p.aucLimitUp === true) return true;
  if (p.aucLimitUp === false) return false;
  // 极少数没跑过 finishBuyBlock 的块（自定义通道 / 单测桩）：用同一份判据现判一次。
  // §10：aucPct 为 null ⇒ getAuctionLimitState 返回 null ⇒ 不标，绝不猜。
  return getAuctionLimitState(p.aucPct, p.code || '', p.name) === 'up';
}

/**
 * 收集计划里【所有】买点块。
 * out.* 与 out.buy.* 是同一批对象的两份引用（见 _clearBuySideForDataGate 的长注释）
 * ⇒ 按对象引用去重，保证每行只被标注一次。
 *
 * @param {object} out buildTopicVolRatioPlan 正在组装的计划对象
 * @returns {Array<object>} 带 picks 的买点块
 */
export function collectBuyBlocks(out) {
  if (!out) return [];
  const seen = new Set();
  const blocks = [];
  const push = function(v) {
    if (!v) return;
    if (Array.isArray(v)) { v.forEach(push); return; }
    if (typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v.picks)) blocks.push(v);
  };
  TVRB_BUY_BLOCK_KEYS.forEach(function(k) { push(out[k]); });
  // out.buy.* 的别名槽位（heavy / light / candidates / noYizi / smallTopic / bigTopic /
  // ebbSecond / newDragon / range10Backup / weakHuddle / catchUp）—— 大多与上面同引用。
  // 再走一遍是为了防将来出现「只挂在 buy 上、out 上没有」的新通道（Set 去重，零副作用）。
  if (out.buy && typeof out.buy === 'object') {
    Object.keys(out.buy).forEach(function(k) { push(out.buy[k]); });
  }
  return blocks;
}

/**
 * 【统一后处理】给所有买点行挂竞价一字涨停的展示字段（原地修改，§11 不返回新对象）。
 *
 * 注入点：tvrb-plan.js#buildTopicVolRatioPlan 在 `_clearBuySideForDataGate` 之后、return 之前。
 *
 * @param {object} out 计划对象
 * @returns {object} 同一个 out
 */
export function annotateAuctionYizi(out) {
  if (!out) return out;
  collectBuyBlocks(out).forEach(function(blk) {
    (blk.picks || []).forEach(function(p) {
      if (!p) return;
      // ★ [AUCTION-YIZI-WAIT] 行上显式点名「等下杀买」⇒ 用那一份文案（只有第二十八条新题材那只走这条）
      const waitTag = String(p.waitBuyTag || '').trim();
      p.auctionYiziTag = isAuctionYiziPick(p) ? (waitTag || AUCTION_YIZI_TAG) : '';
      // ⚠️ 非一字也要【显式清空】：计划对象可能被复用 / 重算，⛔ 不留上一帧的脏标记（§6）。
    });
  });
  return out;
}
