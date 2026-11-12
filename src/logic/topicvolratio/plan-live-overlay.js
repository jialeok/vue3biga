// plan-live-overlay.js — 「冻结的买点结论」×「实时到货的事实」的合流规则（Logic 层，纯函数，§15 可单测）
//
// ★★ [SELL-LIVE / TICK-LIVE 2026-11-12] 用户报障（原话）：
//   「我打开昨天的最近多板的股票列表长按股票名称，点击买入（显示虚线的买），再切换到今天
//     题材量比卖点列表中，却没有显示股票名称，之前就可以显示，为什么现在不可以呢？
//     之前还显示分笔成交。现在连卖点的票都没有。」
//
// 🔴 根因（11-12 云端取证，不是推断）：
//   `[TVRB-PLAN-SNAPSHOT]` / `[BUY-PUBLISH]` 把**整份 plan** 冻结，屏幕只读那一份。
//   但 plan 里有两类东西**本来就会在定稿之后继续变，而且必须变**：
//     ① `plan.sell` —— 成员 = 「上一交易日的『买』标签」（decision-collect#_buildSellRows），
//        而标签是用户**随时**补打的。
//        实证：`tvrb_plan_snapshot(2026-11-12)` 定稿于 `01:28:46Z`(=09:28:46 北京)，
//        那一刻 `auction_board_tags(2026-11-11)` 还是 **0 条** ⇒ 存档 `sell = []`；
//        用户之后去 11-11 长按打了 buy（大东方 / 阳光照明，库里确有 2 条）⇒ 实时重算有 2 只，
//        但屏幕读存档 ⇒ **整段卖点消失**，看起来就像「从历史日期打标签不生效」。
//     ② 分笔装饰（`hasTick` / `redText` / `greenText` / `pens` / `strengthText` …，
//        见 tick-minute#decorateTickRow）—— 分笔是异步抓的，定稿那一刻往往还没到。
//        实证：同一条存档里 `plan.buy.heavy.picks[0] = 大东方 | hasTick=false | emptyText=未抓取`
//        ⇒ 后来抓到了也永远显示「分笔明细不可用」（这就是用户说的「之前还显示分笔成交」）。
//
//   ⇒ 结论：**冻结只应冻结「买点侧的选股结论」**（选哪几只 / 哪个块 / 什么标签 / 说明），
//     ⛔ 不该冻结「用户输入驱动的卖点成员」与「客观数据驱动的分笔装饰」。
//
// §6 单一真相：
//   · 本模块是「冻结结论怎么和实时事实合流」的**唯一实现**，⛔ composable 里不另写一份比较；
//   · `eachBuyBlock` 同时是「买点块清单」的唯一遍历（plan.blocks + buy 的 8 个槽位 +
//     candidates + 6 个渲染在灰化容器之外的独立行）⇒ 分笔装饰只经它走一遍。
//     历史上「新槽位忘了加进枚举 ⇒ 那一行点开永远分笔不可用」已经踩过多次。
//
// ⛔ 红线：本模块所有函数**绝不修改传入的 `frozen`** —— 存档解码出来的那份要能反复使用，
//   一律返回新对象 / 新数组（§11 只读不覆盖）。
// §10：实时那一份还没算出来（live 为 null）⇒ 原样返回 frozen，⛔ 绝不拿空值顶替。

/**
 * 买点槽位（与 `decision-collect#_buyBlocksOf` 的键一一对应）。
 * ⚠️ 新增槽位必须**同时**改这里和 `_buyBlocksOf` —— 两处都是「一个买点块」的清单。
 */
const BUY_SLOT_KEYS = ['heavy', 'light', 'noYizi', 'smallTopic', 'bigTopic',
  'ebbSecond', 'newDragon', 'range10Backup'];

/**
 * 渲染在【灰化容器之外】的独立买点行（它们不在 `plan.blocks` 里，但同样是「今天真要买」的行）。
 * ⚠️ 漏掉任何一个 ⇒ 那一行点开就是「分笔明细暂不可用」。
 */
const EXTRA_BLOCK_KEYS = ['ebbBuy', 'divergeBuy', 'newDragon', 'range10Backup', 'weakHuddle', 'catchUp'];

/**
 * 遍历一份 plan 里【所有】会渲染买点行的块（唯一实现，§6）。
 *
 * ⚠️ 按对象身份去重：同一份内存 plan 里 `plan.blocks[i]` 与 `plan.buy.heavy` 常常是**同一个对象**
 *    （tvrb-plan 直接把它们挂进 blocks）。不去重就会对同一行装饰两次，
 *    而 `decorateTickRow` 会读 `row.dragonRefTags` 再算一遍 ⇒ 标签重复。
 *
 * @param {object} plan
 * @param {(block:object)=>void} fn
 */
export function eachBuyBlock(plan, fn) {
  if (!plan || typeof fn !== 'function') return;
  const seen = new Set();
  const visit = function (b) {
    if (!b || typeof b !== 'object') return;
    if (seen.has(b)) return;
    seen.add(b);
    fn(b);
  };
  (Array.isArray(plan.blocks) ? plan.blocks : []).forEach(visit);
  const buy = plan.buy || {};
  BUY_SLOT_KEYS.forEach(function (k) { visit(buy[k]); });
  (Array.isArray(buy.candidates) ? buy.candidates : []).forEach(visit);
  EXTRA_BLOCK_KEYS.forEach(function (k) { visit(plan[k]); });
}

/**
 * 取一份 plan 里【买点侧】全部股票名（唯一实现，遍历复用 `eachBuyBlock`）。
 *
 * ★★ [SELL-AUTO 2026-11-12 用户口径] 用户原话：
 *   「卖点侧那里，要不你把昨日的买点侧，统一放到次日的卖点侧，这样就不要我手动添加，
 *     因为我早上也是按照买点侧那里买的」。
 *   ⇒ 次日的卖点侧成员 = 「昨日买点侧」（本函数产出）+「昨日手动标签」，不再要求用户逐只打「买入」。
 *
 * ⚠️ 只收「真会买」的行：`picks` 里的票（含退潮首日唯一买点 / 新龙 / 十日候补 / 弱势抱团 / 补涨
 *    这些渲染在灰化容器之外的独立行）。⛔ 不收 `members`（那是题材成员池，不是买点）。
 * ⚠️ 去重后按名字排序输出 ⇒ 结果是确定性的，便于存档比对与单测。
 *
 * @param {object|null} plan 某一天的 plan（可以是解码后的存档，memory plan 亦可）
 * @returns {string[]} 股票名数组（trim 后、去重、升序）
 */
export function collectBuyNames(plan) {
  const names = new Set();
  eachBuyBlock(plan, function (b) {
    (b.picks || []).forEach(function (p) {
      if (!p) return;
      const nm = String(p.name || p.stock || '').trim();
      if (nm) names.add(nm);
    });
  });
  return Array.from(names).sort();
}

/**
 * 实时那一份分笔装饰是否应该覆盖冻结行上的旧值。
 *
 * 规则 = **单调升级**（只允许「从没有到有」，⛔ 绝不把已经抓到的降级）：
 *   · 实时 `hasTick=true` ⇒ 覆盖（这才是修复本次报障的那条）；
 *   · 实时 `hasTick=false` 且冻结行也 `hasTick=false` ⇒ 覆盖（说明文案更准：
 *     「未抓取」→「已经抓过了，但上游这一分钟没有这只票」）；两者都是缺数据，没有信息损失；
 *   · 实时 `hasTick=false` 但冻结行 `hasTick=true` ⇒ **保留冻结值**。
 *     场景：刚切到一个历史日，分笔 store 里还是别的日子那份（`map` 为空）⇒
 *     若不拦，已抓到的行会当场退回「未抓取」，屏幕闪一下再回来（用户最恨的跳变）。
 *
 * @param {object} frozenRow 冻结 plan 里的行（可能带 hasTick）
 * @param {object|null} fresh decorateTickRow 的新结果
 * @returns {boolean}
 */
export function shouldReplaceTick(frozenRow, fresh) {
  if (!fresh) return false;
  if (fresh.hasTick) return true;
  return !(frozenRow && frozenRow.hasTick);
}

/** 一行的合流：需要覆盖就返回新对象（⛔ 不改 frozenRow），否则原样返回冻结那一行 */
export function mergeTickRow(frozenRow, fresh) {
  if (!frozenRow) return frozenRow;
  if (!shouldReplaceTick(frozenRow, fresh)) return frozenRow;
  return Object.assign({}, frozenRow, fresh);
}

/**
 * 浅拷贝一份 plan 的「可写骨架」，共享同一个克隆 memo ⇒ **保持原有的对象同一性**
 * （`blocks[i] === buy.heavy` 这种关系克隆后仍然成立，避免下游按身份去重的地方失效）。
 * 只克隆会被覆盖写的容器（blocks 数组 / 各槽位块 / picks 数组），其余字段共享引用（只读）。
 */
function cloneShape(plan) {
  const memo = new Map();
  const cb = function (b) {
    if (!b || typeof b !== 'object') return b;
    let c = memo.get(b);
    if (c) return c;
    c = Object.assign({}, b);
    if (Array.isArray(b.picks)) c.picks = b.picks.slice();
    memo.set(b, c);
    return c;
  };
  const out = Object.assign({}, plan);
  if (Array.isArray(plan.blocks)) out.blocks = plan.blocks.map(cb);
  if (plan.buy && typeof plan.buy === 'object') {
    const nb = Object.assign({}, plan.buy);
    BUY_SLOT_KEYS.forEach(function (k) { if (nb[k]) nb[k] = cb(nb[k]); });
    if (Array.isArray(nb.candidates)) nb.candidates = nb.candidates.map(cb);
    out.buy = nb;
  }
  EXTRA_BLOCK_KEYS.forEach(function (k) { if (plan[k]) out[k] = cb(plan[k]); });
  return out;
}

/**
 * 把「实时到货的事实」叠到「冻结的买点结论」上。
 *
 * 冻结保留：选哪几只票 / 哪个块 / 什么买点标签 / 说明 notes / pickCount / 闸门结论 …（结论）
 * 实时覆盖：
 *   ① `sell` —— 卖点段恒取实时（成员 = 用户昨天打的「买」标签，随时可能补打 / 取消）；
 *   ② 买点每一行的分笔装饰 —— 单调升级（见 `shouldReplaceTick`）。
 *
 * ⚠️ 卖点段取实时后，「行尾是否标【持有】」用的是**实时**买点名册（`buildSellPlan` 的
 *   `todayBuyNames`）。与冻结买点侧理论上可能不一致（一只票在实时买点、不在冻结买点 ⇒
 *   卖点行标了【持有】）。这是刻意的：卖点侧服务的是「我手上的票怎么处理」，
 *   必须与用户此刻的标签/当前事实一致；买点侧的定稿不变是另一条口径（用户明确要求）。
 *
 * @param {object} frozen 冻结的 plan（存档 / 发布快照）
 * @param {object|null} live 实时计算的 plan（`data.value.plan`）
 * @param {(row:object)=>object|null} decorateBuy 买点行的分笔装饰器（返回 decorateTickRow 结果）
 * @returns {object} 合流后的 plan（frozen 本身不被修改）
 */
export function overlayLiveOnFrozen(frozen, live, decorateBuy) {
  if (!frozen) return frozen;
  if (!live) return frozen;
  const out = cloneShape(frozen);
  // ① 卖点段：恒取实时（含「用户取消了标签 ⇒ 该行应当消失」）
  //
  // 🔴 [SELL-EMPTY-GUARD 2026-11-12] §10 例外：**实时那份明确「没算出来」时不许拿空抹掉冻结段**。
  //   报障（用户原话）：「长按买入 → 切到今天卖点列表，连卖点的票都没有」。
  //   事故链：`_empty()`（未就绪）返回的 plan 里 `sell: []`，它是**形状占位**、不是「今天没有卖点」；
  //   若原样覆盖，冻结段里本来有票也会被抹成空 —— 这正是「读失败被当成空」的第 11 条红线。
  //   ⇒ 判据：`live.ready === false` 且 realtime sell 为空 ⇒ 保留 frozen.sell（有票时才有意义；
  //     frozen 也空就无所谓，照常取实时，保持「取消标签 ⇒ 该行消失」的既有语义）。
  const liveSell = Array.isArray(live.sell) ? live.sell : null;
  const liveNotReady = live.ready === false;
  const frozenHasSell = Array.isArray(out.sell) && out.sell.length > 0;
  if (liveSell && !(liveNotReady && liveSell.length === 0 && frozenHasSell)) {
    out.sell = liveSell;
  }
  // ①-b 卖点成员来源统计：跟着实时那份走（空态文案要据此区分「没有票」/「标签库没读回」）
  if (live.sellMemberStats) out.sellMemberStats = live.sellMemberStats;
  // ② 买点行分笔：单调升级
  if (typeof decorateBuy === 'function') {
    eachBuyBlock(out, function (b) {
      if (!Array.isArray(b.picks)) return;
      b.picks = b.picks.map(function (p) {
        if (!p || typeof p !== 'object') return p;
        return mergeTickRow(p, decorateBuy(p));
      });
    });
  }
  return out;
}
