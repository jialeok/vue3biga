/**
 * 买点侧「选股结果稳定期」判据（§15 Logic 层，可单测）。
 *
 * ★★ [BUY-SETTLE-2 2026-10-31 用户口径 · 第三版]
 *
 * 用户第三次报障（逐字）：
 *   「刷新后变成了一只，后面又跳转两只，最后又变成一只，还是没有彻底解决。」
 *
 * 🔴【为什么前两版的「枚举输入 + 全齐才放行」还是不够】
 *   买点侧的选股结果由【上游数据链路】共同决定，而这些数据**不是本组合式自己的 ref**：
 *   它还吃 `collectDecisionTopics` 从全局内存里读的一大堆东西 ——
 *     当日正式名单索引 / `stock_topics` 题材库 / `auction_watchlist` 竞价行 /
 *     `market_metrics` 竞价量比（题材排名 = 平均量比！）/ 昨日龙头名册 /
 *     竞昨高光继承集（灰行来源）/ 昨日卖标签继承集 / 竞价一字与停牌名单 /
 *     20 日涨幅前五（决定退潮 ⇒ 退潮替补整段上下）……
 *   这些每一项都是异步到货，每一项都可能改变「选几只 / 选哪只 / 是常规选股还是退潮替补」。
 *   ⇒ **白名单式枚举注定会漏**（前两版各漏一批，用户每次都能看到换票）。
 *
 * ✅ 本版改为**结果侧判据**（不依赖枚举、天然覆盖未来新增的数据源）：
 *   把「买点侧当前选出的票 + 各前置买点块是否出现」压成一个**指纹字符串**；
 *   只有这个指纹**连续 `quietMs` 毫秒保持不变**，才认为「上游已经不再改结论」⇒ 放行。
 *
 *   为什么这样一定收敛：数据链路是有限次请求，最后一条到货之后指纹不再变化 ⇒ 计时器必然到期。
 *   为什么这样是诚实的：屏幕上的那一批票，是**持续 quietMs 未被推翻**的那一批；
 *     若之后真的又被推翻（极端慢的上游），指纹变化会立刻把买点侧重新挂回占位（见 `note`），
 *     ⛔ 绝不让屏幕停在一批「已经被推翻的」票上（用户：「很容易买错票」「很容易误导」）。
 *
 * ⚠️ 三条红线：
 *   ① 指纹只含**用户能看见的选股结果**（票名 + 块标志 + 档位），不含数值/文案/分笔 ——
 *      否则分笔每秒到货、量比箭头一抖，计时器永远不到期（= 永远「结果确认中」）。
 *   ② 读的是**结果**不是**过程**：⛔ 不要在这里再列一遍数据源（那就是第二版的老路）。
 *   ③ `quietMs` 必须是「一段很短但足以覆盖数据到货抖动」的值；⛔ 别用 setTimeout 去「等一个大概时间」
 *      掩盖别的问题（§35）—— 这里的等待有明确物理含义：**结论不再变化**。
 */

import { ref } from 'vue';

/**
 * 稳定期默认时长（毫秒）。
 *
 * 取值依据（实测数据链路）：Supabase 单条 REST 往返本机 0.6~1.8s、慢时 1~13s；
 * 首屏各表是并发起跑的，最后一批到货的间隔通常在 1s 内。
 * ⇒ 1.5s 能吃掉「同一批请求陆续返回」的抖动，又不至于让用户白等（用户已明确：宁可等，不要买错）。
 */
export const BUY_QUIET_MS = 1500;

/**
 * 【纯函数】把一份买点计划压成「用户在屏幕上能看到的选股结果」指纹。
 *
 * 包含（少一项就会出现「票变了但指纹没变 ⇒ 放行后还在变」）：
 *   · 每个买点行的股票名（含退潮替补 / 分歧 / 新龙 / 候补 / 弱势切抱团 / 补涨）
 *   · 六个「独立买点块」是否出现（它们渲染在灰化容器之外，各自是整块出现/消失）
 *   · 档位（pickCount = 今天买几只）
 *   · 被排除的题材名单（灰化段整段增减时票名可能不变，但屏幕明显变了）
 *
 * ⛔ 不含：涨幅 / 量比 / 封单额 / 名次变化 / 分笔 —— 它们高频抖动，且**不改变选股结论**
 *    （§35：拿高频装饰字段当门控会让门控永远不放行）。
 *
 * @param {object|null} plan buildTopicVolRatioPlan 的返回（或 _empty()）
 * @param {function} eachRow 决策行统一遍历（decision-collect#eachDecisionRow，§6 只此一份）
 * @returns {string} 稳定串；'' ⇒ 这份计划还没有任何买点结论（未就绪 / 空态）
 */
export function buildBuySelectionSig(plan, eachRow) {
  if (!plan) return '';
  const names = [];
  if (typeof eachRow === 'function') {
    try {
      eachRow(plan.buy, null, function(row) {
        if (row && row.name) names.push(String(row.name).trim());
      });
    } catch (e) {
      // 遍历失败 ⇒ 退回只看块标志（⛔ 不抛给渲染层，§10：宁可门控保守也不能白屏）
      names.length = 0;
    }
  }
  const blocks = [];
  const FLAGS = ['ebbBuy', 'divergeBuy', 'newDragon', 'range10Backup', 'weakHuddle', 'catchUp'];
  const TAGS = { ebbBuy: 'eb', divergeBuy: 'dv', newDragon: 'nd', range10Backup: 'r10', weakHuddle: 'wh', catchUp: 'cu' };
  for (let i = 0; i < FLAGS.length; i++) {
    const b = plan[FLAGS[i]];
    if (!b) continue;
    blocks.push(TAGS[FLAGS[i]]);
    // ⚠️ 这六个块挂在计划根上，**不在** plan.blocks 里 ⇒ eachDecisionRow（走 buyBlocksFlat）扫不到它们。
    //    只记「块在不在」不够（换了一只票也要算变了）⇒ 把票名一起拼进去。
    (b.picks || []).forEach(function(p) { if (p && p.name) names.push(String(p.name).trim()); });
  }
  const excluded = Array.isArray(plan.excludedTopics)
    ? plan.excludedTopics.map(function(t) { return String(t); }).sort()
    : [];
  const pick = (plan.pickCount === null || plan.pickCount === undefined) ? '-' : String(plan.pickCount);
  return 'n' + names.join(',') + '|b' + blocks.join(',') + '|p' + pick + '|x' + excluded.join(',');
}

/**
 * 稳定期状态机（Vue 响应式单例，每个看板一份）。
 *
 * 用法：
 * ```js
 * const q = createBuyQuiesce();
 * watch(buySelSig, function(sig) { q.note(sig); }, { immediate: true });
 * // 视图/门控：q.isStable(buySelSig.value) === false ⇒ 继续挂占位
 * onUnmounted(function() { q.dispose(); });
 * ```
 *
 * @param {{quietMs?:number}} [opts]
 * @returns {{locked:object, note:function, isStable:function, dispose:function}}
 */
export function createBuyQuiesce(opts) {
  const quietMs = Number((opts && opts.quietMs) || BUY_QUIET_MS);
  /** 已「锁住」的那份指纹（= 已连续 quietMs 未变）。'' ⇒ 还在等 */
  const locked = ref('');
  let timer = null;
  let lastSig = '';

  function _clear() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  /**
   * 通知一份新指纹（`data` 每次重算后调用）。
   * · 与上一次相同 ⇒ 什么都不做（⛔ 不重置计时器，否则高频重算会让它永不到期）
   * · 变了 ⇒ 立刻把 `locked` 清空（= 重新挂占位），并重启计时
   */
  function note(sig) {
    const s = String(sig || '');
    if (!lastSig && !s) return;              // 一直是「还没有结论」⇒ 无事可做
    if (s === lastSig) return;               // 指纹没变 ⇒ 计时器继续跑
    lastSig = s;
    _clear();
    // ⚠️ 先清空再计时：此刻起「屏幕上不该再显示旧票」（旧票已被推翻）
    locked.value = '';
    if (!s) return;                          // 变成空（未就绪 / 切日期）⇒ 不起计时
    timer = setTimeout(function() {
      timer = null;
      locked.value = lastSig;
    }, quietMs);
  }

  /** 当前指纹是否已经稳定到可以显示 */
  function isStable(sig) {
    const s = String(sig || '');
    return !!s && locked.value === s;
  }

  /** 卸载时清定时器（⛔ 别让看板关掉后还在跑） */
  function dispose() {
    _clear();
    lastSig = '';
    locked.value = '';
  }

  return { locked: locked, note: note, isStable: isStable, dispose: dispose };
}
