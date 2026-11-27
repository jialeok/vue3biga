// nextday-buy.js — 第二十八条【次日买】+【次日承接块】（独立模块，⛔ 不并进 tvrb-blocks 的老逻辑）
//
// ★★ [NEXT-DAY-BUY 2026-11-27 用户口径 · 规则手册八修] 用户原话（逐字）：
//   「还有第二十八条选票是对的，但是买点不对，应该是在次日买。也就是说你在买点侧那里打上标签次日买，
//     股票名称打上删除符。这样我就知道是明天买。还有就是次日要继承下第二十八条次日买的票，
//     重要的是注意下灰色行的股票不要继承，这个非常重要，不然会误买，因为灰色行的票的现在是错误的，
//     没有买入的硬逻辑。只继承一天啊，不要无限继承，不要乱继承。继承时也要有说明文字，
//     大概意思是切换题材的新龙延迟一天（今天）买更加准确，刚好第三天，老龙已经彻底杀完，
//     新龙就开始吹响反攻号角。」
//
// ── 一句话口径 ──────────────────────────────────────────────────────────────
//   **选票不变，只把买点推迟一个交易日**：
//     · 切换日 T：新龙照旧被选出来（选几只 = 几只，`pickCount` 不变），但标签写【次日买】、
//       股票名打删除符、⛔ 不进 `buyNames`（今天不买）；
//     · T+1：把 T 存档里的 `nextDayBuy` 名单接进来，以【继承买】的身份成为**今天真正的买点**。
//
// ★★ [NEXT-DAY-BUY-2 2026-11-27 用户口径 · 规则手册九修] 承接块的标签 = 【继承买】：
//   用户原话：「11月20日，华东重机如果是继承11月19日的，题材量比买点侧那里应该再打上标签继承买，
//     不然我不知道是不是继承的票，还是其它规则选出的票，买点侧文字也要说明下。……
//     因为有些规则它次日刚好也选了这只票。不区分的话，不知道来源。」
//   ⇒ 同一只票今天可能「既被今天某条规则选中、又是昨天切换日的新龙」，两行都要显示，
//     但标签必须能区分来源：今天现选的带各自标签，昨天选的这一行 = 【继承买】（⛔ 不再叫【新龙买】）。
//     块内说明也改成简洁版（来源 / 灰行不继承两句话），⛔ 不再堆复盘细节。
//
// ── 三条硬约束（以后改这个文件先读这三条）──────────────────────────────────
//   ① **只继承一天**：来源恒为【上一交易日存档】的 `plan.newDragon.nextDayBuy`；
//      承接块自己 **绝不** 产出 `nextDayBuy` ⇒ 结构上就不可能出现 A→B→C 的链式继承，
//      ⛔ 不要为了「多继承一天」在这里加递归（用户明确：「只继承一天啊，不要无限继承」）。
//   ② **灰色行不继承**：`nextDayBuy.names` 只收「今天真能下单」的票
//      （`_isBuyablePick` 为真 **且** 没挂 `noBuyRowGray`）。灰掉的票（退潮牵连 / 逼近红线 /
//      异动同题材…）一只都不进 —— 用户原话「灰色行的票现在是错误的，没有买入的硬逻辑，
//      不然会误买」。
//   ③ **必须有说明文字**：`NEXT_DAY_BUY_NOTE`（延迟一天更准 / 刚好第三天 / 老龙杀完 /
//      新龙吹响反攻号角），买点侧与承接块都要看得见。
//
// ── 为什么单独一个文件（用户 11-27 要求）────────────────────────────────────
//   `tvrb-blocks.js` 里那十几个 `_buildXxxBlock` 是**当天买**的通道，且都被
//   退潮 / 分歧 / 异动那一串「覆盖式改写」穿透过。本模块是**跨日**语义（昨天选、今天买），
//   混进去以后谁改谁都会互相污染 ⇒ 独立成文件 + 独立视图组件
//   （`components/topicvolratio/TvrbNextDayCarryBlock.vue`）。
//   ⛔ 别把承接块塞给 `TvrbBuyBlock.vue`：那边是「今天买」的通用块。
//
// §2 分层：本文件只做纯数据加工（判定 + 文案拼装），⛔ 不取数、⛔ 不碰 DOM。
// §6 单一真相：`_isBuyablePick`（能不能下单）与 `collectBuyNames`（今天买过谁）都在别处有唯一实现，
//   本文件只【调用】，⛔ 不另抄一份标签表。

import {
  SWITCH_RULE_NO,
  NEXT_DAY_BUY_TAG,
  NEXT_DAY_BUY_TONE,
  NEXT_DAY_CARRY_TAG,
  NEXT_DAY_CARRY_TONE
} from './tvrb-constants.js';
import { _num, _findMemberByName, _isBuyablePick } from './tvrb-utils.js';
import { formatRangePct } from '../decision/decision-rules.js';

/**
 * 为什么「延迟一天买更准」—— 用户口径的原文复述（买点侧 / 承接块共用这一份文案，⛔ 别各写一遍）。
 */
export const NEXT_DAY_BUY_NOTE =
  '切换题材的【新龙延迟一天（= 今天）买】更准确：切换日那天老龙刚被二次确认退潮，杀跌还没走完；' +
  '隔一天刚好是第三天，老龙已经彻底杀完，新龙就从这一天开始吹响反攻号角。';

/**
 * 把第二十八条的买点块改成【次日买】（原地改，只动标签 / 旗子 / 文案，⛔ 一个票都不增删）。
 *
 * 做三件事：
 *   ① 每行标签换成【次日买】+ `buyNextDay=true`（`collectBuyNames` 据此不把它算成「今天买过的票」，
 *      否则 T+1 的卖点侧会把一只没买过的票标成【持有】）；
 *   ② 每行 `nameDel=true`（视图打删除符 —— 用户「股票名称打上删除符，这样我就知道是明天买」）；
 *   ③ 行内 + 块内说明补上「今天不买、明天买」的理由。
 *
 * @param {object|null} block `_buildNewDragonBlock` 的产出（`out.newDragon`）
 * @param {{date?:string}} [info] `date` = 选票日（写进文案，便于复盘）
 * @returns {object|null} 同一个 block（原地改，§11 不返回新对象）
 */
export function markNextDayBuy(block, info) {
  if (!block || !Array.isArray(block.picks) || block.picks.length === 0) return block;
  const d = String((info && info.date) || '').trim();
  const dText = d ? ('（' + d + ' 选出）') : '';
  (block.picks || []).forEach(function (p) {
    if (!p || !p.name) return;
    p.buyActionTag = NEXT_DAY_BUY_TAG;
    p.buyActionTone = NEXT_DAY_BUY_TONE;
    // ★ 旗子（唯一用途 = 告诉 `collectBuyNames`「这不是今天买的票」）
    p.buyNextDay = true;
    // ★ 视图旗子：股票名打删除符（模板零判定，§21）
    p.nameDel = true;
    p.actionNote = String(p.actionNote || '') +
      ' ⏰【次日买】本只的选股结论成立，但【今天不下单】（股票名已打删除符）：' +
      '按第二十八条口径把买点顺延到下一交易日。' + NEXT_DAY_BUY_NOTE;
  });
  if (!Array.isArray(block.notes)) block.notes = [];
  block.notes.push('⏰【第二天才买 · 第二十八条】本块的选票结论【一个字都没改】' +
    '（谁被选中、选几只都照原规则），改的只是【买点时间】：' + dText +
    '今天只做观察、⛔ 不下单（股票名已打删除符 = 明天买，不是今天买）；' +
    '下一交易日会自动出现在买点侧顶部的【次日承接 · 新龙】里，标签是【' + NEXT_DAY_CARRY_TAG + '】' +
    '（= 昨天选、今天买；与今天现选的票分开展示，来源一眼可辨）。' +
    NEXT_DAY_BUY_NOTE);
  block.buyNextDay = true;
  block.buyNextDaySrcDate = d;
  return block;
}

/**
 * 收口：算出「明天该买哪几只」并挂在 `out.newDragon.nextDayBuy` 上（供次日存档继承）。
 *
 * ⚠️ 必须在【所有覆盖式改写之后】调用（退潮牵连 `_applyEbbTopicBan` / 逼近红线
 *    `_applyDeviationNearRule` / 异动同题材 `_applyAbnormalTopicBan` / 数据闸门
 *    `_clearBuySideForDataGate` 都得先跑完）—— 否则会把「今天被灰掉的票」错误地写进明天的名单。
 *
 * 灰行不继承的判据（两条都要过，缺一不可）：
 *   · `!p.noBuyRowGray`        —— 这一行没被灰（退潮牵连 / 逼近红线都是「灰行」）；
 *   · `_isBuyablePick(p)`      —— 今天真能下单（标签不在 `NO_BUY_ACTION_TAGS` 里）。
 *
 * @param {object} out buildTopicVolRatioPlan 正在组装的计划（原地改）
 * @param {string} date 选票日（= 这份 plan 的日期，写进 `nextDayBuy.date` 便于次日核对）
 * @returns {{date:string,names:string[],note:string,ruleNo:string}|null} 明天的承接名单（没有 ⇒ null）
 */
export function finalizeNextDayBuy(out, date) {
  const nd = out && out.newDragon;
  if (!nd || !Array.isArray(nd.picks)) return null;
  const d = String(date || '').trim();
  const picked = [];
  const skipped = [];
  (nd.picks || []).forEach(function (p) {
    if (!p || !String(p.name || '').trim()) return;
    const nm = String(p.name).trim();
    // ★ 硬约束②：灰色行（+ 任何「今天不给买点」的标签）绝不继承
    if (p.noBuyRowGray === true || !_isBuyablePick(p)) {
      skipped.push(nm);
      return;
    }
    picked.push(nm);
  });
  const names = Array.from(new Set(picked));
  if (names.length === 0) {
    nd.nextDayBuy = null;
    if (!Array.isArray(out.notes)) out.notes = [];
    out.notes.push('⚠️【第二十八条 · 次日买】本块今天选出的票全部落在【灰色行】' +
      (skipped.length ? ('（' + skipped.join('、') + '）') : '') +
      '⇒ 明天【没有】可承接的新龙。灰色行 = 没有买入的硬逻辑，⛔ 绝不继承（否则会误买）。');
    return null;
  }
  nd.nextDayBuy = {
    date: d,
    names: names,
    note: NEXT_DAY_BUY_NOTE,
    ruleNo: SWITCH_RULE_NO
  };
  if (skipped.length > 0) {
    if (!Array.isArray(out.notes)) out.notes = [];
    out.notes.push('ℹ️【第二十八条 · 次日买】明天承接 ' + names.join('、') +
      '；' + skipped.join('、') + ' 今天被灰（禁买 / 退潮牵连 / 逼近红线）⇒ ⛔ 不继承、明天也不买。');
  }
  return nd.nextDayBuy;
}

/**
 * 【次日承接 · 新龙】买点块 —— 昨天（切换日）选出的新龙，今天到了真正该买的那一天。
 *
 * ⛔ 与 `_buildXxxBlock` 那一批的本质差别：那些是「今天现选」，本块是「昨天已选、今天兑现」，
 *   所以：**不重新选票**、**不占用今天任何题材名额**、**不再产出 `nextDayBuy`**（只继承一天）。
 *
 * ⚠️ 刻意【不调用】`finishBuyBlock`：那一步会把「今天」的持有 / 占比 / 退潮 / 分歧信号再算一遍，
 *   而本块的买点来自昨天的结论 ⇒ 一旦让它重算，昨天的结论会被今天的中间态改写（跨日语义被污染）。
 *   本块只提供：票名 / 代码 / 昨天那名次口径下的涨幅（有就写，没有就留空，§10 不猜）。
 *
 * @param {{date?:string,names:string[],note?:string}} carry 从上一交易日存档读到的 `nextDayBuy`
 * @param {Array} list 今日题材块（只用于反查代码 / 涨幅，⛔ 不参与选票）
 * @returns {object|null} 决策看板形状的买点块（视图 = `TvrbNextDayCarryBlock.vue`）
 */
export function buildNextDayCarryBlock(carry, list) {
  const names = (carry && Array.isArray(carry.names)) ? carry.names : [];
  if (names.length === 0) return null;
  const srcDate = String((carry && carry.date) || '').trim();
  const srcDateText = srcDate || '上一交易日';

  const picks = names.map(function (nm, i) {
    const member = _findMemberByName(list, nm);
    // §10：反查不到成员行 ⇒ 代码 / 涨幅留空（⛔ 不拿 0 或别的票顶替）
    return {
      seq: i + 1,
      name: String(nm).trim(),
      dragonLabel: '',      // ⛔ 不给龙标：本行不是今天按题材龙位选出来的
      dragonRank: null,
      pct: member ? _num(member.pct) : null,
      pctText: member ? formatRangePct(_num(member.pct)) : '',
      code: String((member && member.code) || '').trim(),
      // ★★ [NEXT-DAY-BUY-2 2026-11-27 用户口径·九修] 标签 = 【继承买】：
      //   用户「不然我不知道是不是继承的票，还是其它规则选出的票」。⛔ 不要写成【新龙买】——
      //   同一只票今天可能也被别的规则选中并显示【新龙买】/ 其它标签，两行标签必须能区分来源。
      buyActionTag: NEXT_DAY_CARRY_TAG,
      buyActionTone: NEXT_DAY_CARRY_TONE,
      actionNote: '【第二十八条 · 继承买】本只是 ' + srcDateText +
        ' 切换日选出的新龙，按口径延后一天 ⇒ 今天才买。' +
        '【继承买】= 来源是【上一交易日的第二十八条】，不是今天现选的票；' +
        '若同一只票今天也被别的规则选中，会另有一行、带着那条规则自己的标签（来源不同，各看各的）。' +
        NEXT_DAY_BUY_NOTE
    };
  });

  return {
    // 决策看板「题材头」形状：本块不是题材排名 ⇒ 不给圆点 / 数量（§10 不拿 0 冒充）
    block: {
      topic: '次日承接 · 新龙（' + srcDateText + ' 选出）',
      rank: null,
      count: null,
      yiziCount: null,
      members: []
    },
    mode: 'nextday-carry',
    ruleNo: SWITCH_RULE_NO,
    // ★ 一句话理由（2026-11-28 用户「简洁美观」）：卡片收起时只看到这一行 + 票行，
    //   完整口径（第三天 / 老龙杀完 / 反攻号角）放在 notes 第 1 条，展开「为什么是今天买？」才看。
    reason: srcDateText + ' 切换日选出的新龙【当天不买】，今天才买 —— 老龙已彻底杀完，新龙从今天开始反攻。',
    picks: picks,
    notes: [
      NEXT_DAY_BUY_NOTE,
      '名单来自 ' + srcDateText + ' 存档里第二十八条的 `nextDayBuy`（' + names.join('、') + '）：' +
      '只继承【一天】，今天兑现完就结束（不会再往明天传）。',
      '那天被灰掉的票（禁买 / 退潮牵连 / 逼近红线）一只都没继承 —— 灰色行没有买入的硬逻辑，继承它就会误买。',
      '若同一只票今天也被别的规则选中，会另有一行、带它自己的标签（来源不同，各看各的）。'
    ],
    isNextDayCarry: true,
    nextDayCarrySrcDate: srcDate,
    pickCount: picks.length
  };
}

/**
 * 从一份 plan（可以是解码后的存档，也可以是内存里刚算出来的那一份）取【次日承接】名单。
 *
 * ⚠️ 只认 `plan.newDragon.nextDayBuy` 这一个来源（§6 单一真相）：⛔ 别在这里顺手
 *   「没有 nextDayBuy 就从 picks 里凑一份」——那会把灰色行又带回来（正是本次要防的误买）。
 *
 * @param {object|null} plan 某一天的 plan
 * @returns {{date:string,names:string[],note:string}|null} null = 那天没有次日承接（不是「读不到」）
 */
export function collectNextDayBuy(plan) {
  const nd = plan && plan.newDragon;
  const nb = nd && nd.nextDayBuy;
  if (!nb || !Array.isArray(nb.names) || nb.names.length === 0) return null;
  return {
    date: String(nb.date || '').trim(),
    names: nb.names.map(function (x) { return String(x || '').trim(); }).filter(function (x) { return !!x; }),
    note: String(nb.note || '')
  };
}
