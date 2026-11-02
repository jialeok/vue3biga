// src/logic/auction/row-class-counts.js
// [ROW-CLASS 2026-11-02 用户口径] 早盘竞价第一页「四类行分账」的唯一实现。
//
// 用户原话：
//   「历史的股票数量根本不对，怎么进了很多脏数据在里面，早盘竞价看板的股票列表有很多不知道是不是
//     影子记录还是20日涨幅的股票灰色行，没有分清就放进去了，很严重，现在对不上，每天基本都是
//     90多条股票记录，肯定不对，我都说改那个列表的时候要小心点，怎么每次都改，我要的是正确数据
//     不是脏数据，列表里面有正式成员，龙头组，观察组，20日补的，要分清楚啊」
// AskUserQuestion 拍板：
//   · 「你说的『每天90多条股票记录』是在哪里看到的？」→【看板第一页四个区块合起来】
//   · 「你期望的『正确』是什么样？」→【四类分开显示，各自给数量】
//
// ⇒ 本文件的职责只有一件事：把 Logic 层已经算定的【行数事实】整理成一组可显示、可对账的数字。
//   ⛔ 它不判断「谁属于哪一类」——归属判定的唯一真相是 view-helpers.js 里那四个索引数组
//      （dragonIndices / range20LeaderIndices / obsIndices / regularIndices）。
//   ⛔ 它不读数据库、不读 store、没有任何副作用（§3 纯函数，可单测）。
//
// 为什么需要「对账」这件事（balanced）：
//   用户被"数量对不上"坑过多次。四类在【默认模式】下是互斥且穷尽的（fullOrder 就是四段的拼接），
//   所以「四块之和」必须等于「实际渲染行数」。一旦不等，说明**有行没被分到任何一块**
//   （或某行被重复分进两块）——正是"分不清、混进脏数据"那一类 bug 的早期信号。
//   这里把它算成 balanced 布尔值交给调用方留痕（§10 禁止静默），而不是等用户肉眼发现。

/**
 * @typedef {Object} RowClassCountInput
 * @property {number} [total]    实际渲染行数（屏幕上到底多少行）
 * @property {number} [formal]   今日 9:25 正式成员数（= 强度统计的分母）
 * @property {number} [injected] 自动补进来的行数（今日列表里没有、由龙头组/观察组/20日补位注入的壳行）
 * @property {number} [hidden]   被折叠掉的行数（竞昨高光模式下不命中高光且非正式成员的观察组行）
 * @property {number} [dragon]   龙头组区块行数
 * @property {number} [range20]  20日强势补位区块行数
 * @property {number} [obs]      观察组区块行数
 * @property {number} [regular]  常规组区块行数
 * @property {boolean} [split]   本模式是否分块显示（只有默认模式为 true）
 */

/**
 * 把「四类行数事实」整理成可显示的一组数字。
 *
 * 归一化规则（⛔ 不是可选的"防御性编程"，是显示层红线）：
 *   · 任何非数字 / NaN / 负数 / Infinity → 0。屏幕上绝不出现 `undefined 行` / `NaN 只`；
 *   · 小数向下取整（行数只能是整数）；
 *   · `split` 只做布尔化，不透传原值（模板里 `v-if="counts.split"` 依赖它严格布尔）。
 *
 * @param {RowClassCountInput} [input]
 * @returns {{total:number, formal:number, injected:number, hidden:number, dragon:number,
 *            range20:number, obs:number, regular:number, split:boolean,
 *            blocksSum:number, balanced:boolean}}
 */
export function buildRowClassCounts(input) {
  const src = input || {};
  const num = function(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  };
  const total = num(src.total);
  const formal = num(src.formal);
  const injected = num(src.injected);
  const hidden = num(src.hidden);
  const dragon = num(src.dragon);
  const range20 = num(src.range20);
  const obs = num(src.obs);
  const regular = num(src.regular);
  const split = src.split === true;
  // 四块之和：分块模式下它必须等于 total（互斥且穷尽）；其它模式下三块恒为 0，剩下那块就是全部。
  const blocksSum = dragon + range20 + obs + regular;
  return {
    total, formal, injected, hidden, dragon, range20, obs, regular, split,
    blocksSum,
    // total 为 0（空态）时不判「不齐」——没有行就无所谓分账，⛔ 别在空状态下报假警。
    balanced: total === 0 ? true : blocksSum === total
  };
}

/**
 * 给调用方用的一行诊断文案（§10 留痕用，⛔ 不用于 UI 展示）。
 * @param {ReturnType<typeof buildRowClassCounts>} c
 * @returns {string}
 */
export function describeRowClassMismatch(c) {
  const x = c || buildRowClassCounts();
  return '[ROW-CLASS] 四类行数对不上：区块合计 ' + x.blocksSum + ' 行 ≠ 渲染 ' + x.total +
    ' 行（龙头组 ' + x.dragon + ' / 20日补位 ' + x.range20 + ' / 观察组 ' + x.obs +
    ' / 常规组 ' + x.regular + '；正式成员 ' + x.formal + ' + 自动补 ' + x.injected +
    ' − 折叠 ' + x.hidden + '）。有行没被分到任何区块，或某行被重复分组。';
}
